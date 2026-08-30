'use strict';
const fs = require('fs');
const path = require('path');
const fileLock = require('./file-lock');

function stateDir() {
  return process.env.STATE_DIR || '/tmp';
}

function statePath(worker) {
  return path.join(stateDir(), `worker-${worker}.state.json`);
}

function lockPath(worker) {
  return `${statePath(worker)}.lock`;
}

function withLock(worker, fn) {
  return fileLock.withLock(lockPath(worker), `state lock timeout (worker ${worker})`, fn);
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

function unset(worker, key) {
  withLock(worker, () => {
    const data = read(worker);
    delete data[key];
    write(worker, data);
  });
}

module.exports = { get, set, merge, unset, read, write, statePath };
