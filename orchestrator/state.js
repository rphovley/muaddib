'use strict';
const fs = require('fs');
const path = require('path');

function stateDir() {
  return process.env.STATE_DIR || '/tmp';
}

function statePath(worker) {
  return path.join(stateDir(), `worker-${worker}.state.json`);
}

function lockPath(worker) {
  return `${statePath(worker)}.lock`;
}

// O_EXCL spinlock — atomic across processes on the same filesystem.
// Uses Atomics.wait for a synchronous sleep between retries (Node.js main
// thread allows this; no browser restriction applies here).
const LOCK_TIMEOUT_MS = 5000;
const _sleepBuf = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  Atomics.wait(_sleepBuf, 0, 0, ms);
}

function withLock(worker, fn) {
  const lock = lockPath(worker);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const fd = fs.openSync(lock, 'wx'); // O_WRONLY|O_CREAT|O_EXCL — atomic
      fs.closeSync(fd);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() >= deadline) throw new Error(`state lock timeout (worker ${worker})`);
      sleepSync(5);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lock); } catch (_) {}
  }
}

function read(worker) {
  try {
    return JSON.parse(fs.readFileSync(statePath(worker), 'utf8'));
  } catch (_) {
    return {};
  }
}

// Atomic write via temp-file rename so readers never see partial JSON.
function write(worker, data) {
  const dest = statePath(worker);
  const tmp = `${dest}.tmp.${process.pid}`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, dest);
}

function get(worker, key) {
  return read(worker)[key];
}

function set(worker, key, value) {
  withLock(worker, () => {
    const data = read(worker);
    data[key] = value;
    write(worker, data);
  });
}

function merge(worker, obj) {
  withLock(worker, () => {
    const data = read(worker);
    Object.assign(data, obj);
    write(worker, data);
  });
}

module.exports = { get, set, merge, read, write, statePath };
