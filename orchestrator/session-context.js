'use strict';
// Session Context: live, ephemeral working state for a single Conductor run.
// It's the counterpart to the durable stores — Goal Context (goals.md) and the
// Decision Log (decisions.jsonl) are committed in the repo tree and persist
// across runs; this is thrown away at run end and never accumulates. It lives
// at <accountDir>/session/session.json — deliberately OUTSIDE the repo tree
// (like the per-worker env files and the dispatch ledger), so ephemeral run
// state can never be committed. No gitignore entry is needed for the same
// reason.
//
// Storage is an opaque key/value bag, exactly like orchestrator/state.js — no
// concrete fields are defined here. The shape is minimal for now and not meant
// to anticipate Conductor internals; a caller stores whatever a run needs.
//
// Ephemerality ships as two guarantees that hold today even though no Conductor
// drives a run lifecycle yet:
//   - clear()/discard() removes the session file — the explicit hook a run-end
//     caller will use later.
//   - begin() wipes any stale file up front, so a run that crashed before
//     clearing can't leak its state into the next run.
// Together, "no accumulation across runs" holds now, mechanism-only, with
// nothing orchestrating it — that's the Conductor's job, in a later milestone.

const fs = require('fs');
const path = require('path');
const fileLock = require('./file-lock');
const { resolveAccountDir } = require('./account-dir');

function sessionPath(repoDir) {
  return path.join(resolveAccountDir(repoDir), 'session', 'session.json');
}

// Locked by the session file's own path, using the same O_EXCL primitive
// state.js and decision-log.js share, so concurrent writers can't interleave.
function withLock(repoDir, fn) {
  const p = sessionPath(repoDir);
  return fileLock.withLock(`${p}.lock`, `session context lock timeout (${p})`, fn);
}

function read(repoDir) {
  try {
    return JSON.parse(fs.readFileSync(sessionPath(repoDir), 'utf8'));
  } catch (_) {
    return {};
  }
}

// Atomic write via temp-file rename so readers never see partial JSON.
function write(repoDir, data) {
  const dest = sessionPath(repoDir);
  const tmp = `${dest}.tmp.${process.pid}`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, dest);
}

function get(repoDir, key) {
  return read(repoDir)[key];
}

function set(repoDir, key, value) {
  withLock(repoDir, () => {
    const data = read(repoDir);
    data[key] = value;
    write(repoDir, data);
  });
}

function merge(repoDir, obj) {
  withLock(repoDir, () => {
    const data = read(repoDir);
    Object.assign(data, obj);
    write(repoDir, data);
  });
}

function unset(repoDir, key) {
  withLock(repoDir, () => {
    const data = read(repoDir);
    delete data[key];
    write(repoDir, data);
  });
}

// Removes the session file entirely. A missing file is a no-op — the run
// simply had no session state to discard.
function clear(repoDir) {
  withLock(repoDir, () => {
    try {
      fs.unlinkSync(sessionPath(repoDir));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  });
}

// Starts a fresh session by clearing any stale file a crashed prior run left
// behind, so state can't leak across runs.
function begin(repoDir) {
  clear(repoDir);
}

module.exports = {
  get, set, merge, unset, read, write, begin, clear, discard: clear, sessionPath,
};
