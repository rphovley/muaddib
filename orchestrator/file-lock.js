'use strict';
// O_EXCL spinlock — atomic across processes on the same filesystem. Shared by
// state.js (locked by worker) and decision-log.js (locked by the log file's
// own path) so the two can't silently diverge on retry/timeout/crash-recovery
// behavior for the same underlying primitive.
//
// Uses Atomics.wait for a synchronous sleep between retries (Node.js main
// thread allows this; no browser restriction applies here).

const fs = require('fs');
const path = require('path');

const LOCK_TIMEOUT_MS = 5000;
const _sleepBuf = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  Atomics.wait(_sleepBuf, 0, 0, ms);
}

// lockPath is the full path to the lock file itself (caller decides the
// naming scheme, e.g. `${dataPath}.lock`); timeoutMessage is thrown verbatim
// on timeout, so each caller keeps its own error wording.
function withLock(lockPath, timeoutMessage, fn) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx'); // O_WRONLY|O_CREAT|O_EXCL — atomic
      fs.closeSync(fd);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() >= deadline) throw new Error(timeoutMessage);
      sleepSync(5);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lockPath); } catch (_) {}
  }
}

module.exports = { withLock, LOCK_TIMEOUT_MS };
