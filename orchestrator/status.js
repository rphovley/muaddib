'use strict';
// Coarse per-worker status: the tiny state file bin/attend.sh, spawn-worker.sh's
// notifier, and MuaddibApp all poll, plus the matching state_changed bus event.
// One writer of this format, shared by orchestrator.js's own note() (BOOTING,
// RUNNING, FEEDBACK, ...) and runner.js's per-step status writes (e.g. a
// claude-tui step declaring awaitsReview: true) — so the two can't drift apart
// on the file format or event shape.

const fs = require('fs');
const path = require('path');
const { emit } = require('./events');

const AGENT_STATUS_DIR = process.env.AGENT_STATUS_DIR || '/var/run/agent-status';

// Best-effort — must never throw. runner.js calls this from a `finally`
// block (reverting AWAITING_REVIEW back to RUNNING); a throw here would
// shadow whatever real error the try block was already propagating.
function noteStatus(worker, s) {
  try {
    fs.mkdirSync(AGENT_STATUS_DIR, { recursive: true });
    fs.writeFileSync(path.join(AGENT_STATUS_DIR, `worker-${worker}.state`), `${s} ${new Date().toISOString()}\n`);
    emit(worker, 'orchestrator', 'state_changed', { state: s });
  } catch (_) {}
}

module.exports = { noteStatus, AGENT_STATUS_DIR };
