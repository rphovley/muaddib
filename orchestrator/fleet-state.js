'use strict';
// Fleet State — the read-only computation behind the first Fleet Control Surface
// tool (muaddib#24). It derives a worker's live status the same way a human
// reading its `.events` JSONL stream would: fold the state_changed / step_start /
// step_done / workflow_done / failed events into a coarse state, an in-flight (or
// last-completed) step, and terminal flags.
//
// Deliberately a pure fold over events.readEvents() with no I/O of its own and
// no state kept between calls: every call recomputes from the files on disk, so
// the tool has no cache to go stale and observes newly appended events on the
// very next invocation. It never emit()s or writes — reads only.

const { readEvents, listWorkers } = require('./events');
const stateStore = require('./state');

// Derive one worker's live status from its event stream, plus which ticket (if
// any) it's holding — read from the worker's state file (fetch-ticket.sh/.js
// write `ticket_identifier` there at run start; conductor-loop.js already reads
// it the same way). Folding this in here means a single `inspect-cli.js` call
// answers "what is every worker doing, and on which ticket" in one shot, rather
// than a second per-worker lookup via state-cli.js for each slot.
//
// `stateGet` is injectable (defaults to state.js's real reader) so tests can
// stub it without touching a real state file, matching the convention
// conductor-loop.js already established for the same read.
function workerStatus(worker, opts = {}) {
  const stateGet = opts.stateGet || stateStore.get;
  const events = readEvents(worker);

  let state = null;              // latest state_changed.payload.state
  let workflowDone = false;      // saw a workflow_done event
  let workflowName = null;       // its workflow name, if present
  let failed = false;            // latest outcome failed (a `failed` event / non-zero exitCode, uncleared)

  const startsById = new Map();  // step id -> { id, type, job, ts } from step_start
  const openIds = [];            // step ids started but not yet done, in order
  let lastCompleted = null;      // { id, type, job, ts } of the most recent step_done

  for (const ev of events) {
    const payload = ev.payload || {};

    // Scope the fold to the current run. A reused worker's events file is never
    // truncated, so once a run completes its workflow_done/failed/state would
    // otherwise latch and mask the run now in progress. The first run-starting
    // event after a completed run (a fresh state_changed or step_start) opens a
    // new segment — discard everything the previous run derived.
    if (workflowDone && (ev.event === 'state_changed' || ev.event === 'step_start')) {
      state = null;
      workflowDone = false;
      workflowName = null;
      failed = false;
      startsById.clear();
      openIds.length = 0;
      lastCompleted = null;
    }

    switch (ev.event) {
      case 'state_changed':
        if (payload.state != null) state = payload.state;
        break;
      case 'step_start': {
        const info = {
          id: payload.id,
          type: payload.type != null ? payload.type : null,
          job: ev.job != null ? ev.job : null,
          ts: ev.ts != null ? ev.ts : null,
        };
        startsById.set(payload.id, info);
        openIds.push(payload.id);
        break;
      }
      case 'step_done': {
        const idx = openIds.lastIndexOf(payload.id);
        if (idx !== -1) openIds.splice(idx, 1);
        const start = startsById.get(payload.id);
        lastCompleted = {
          id: payload.id,
          type: start ? start.type : null,
          job: ev.job != null ? ev.job : null,
          ts: ev.ts != null ? ev.ts : null,
        };
        break;
      }
      case 'workflow_done':
        workflowDone = true;
        if (payload.name != null) workflowName = payload.name;
        break;
      case 'failed':
        failed = true;
        break;
      default:
        break;
    }
    // Track the latest pass/fail outcome rather than latching: a non-zero
    // exitCode marks failure, and a later exitCode 0 (e.g. a check passing on
    // retry) clears it, so a recovered run no longer reports failed=true.
    if (payload.exitCode != null) failed = payload.exitCode !== 0;
  }

  // In-flight step wins; else fall back to the last completed step. `running`
  // distinguishes the two so a caller can tell "doing X" from "last did X".
  let currentStep = null;
  if (openIds.length) {
    const info = startsById.get(openIds[openIds.length - 1]);
    currentStep = { ...info, running: true };
  } else if (lastCompleted) {
    currentStep = { ...lastCompleted, running: false };
  }

  const lastEventTs = events.length ? (events[events.length - 1].ts || null) : null;

  let ticketIdentifier = null;
  try {
    ticketIdentifier = stateGet(worker, 'ticket_identifier') || null;
  } catch (_) {
    // No state file / unreadable — a worker with no ticket assigned yet, or one
    // whose state predates this field. Report null rather than throwing; the
    // events-derived fields above are still meaningful on their own.
  }

  return {
    worker: Number(worker),
    state,
    currentStep,
    workflowDone,
    workflowName,
    failed,
    eventCount: events.length,
    lastEventTs,
    ticketIdentifier,
  };
}

// Whole-fleet snapshot: every worker with an events file, each folded through
// workerStatus(). Recomputed on every call — generatedAt is fresh each time.
function fleetState(opts = {}) {
  const workers = listWorkers().map((w) => workerStatus(w, opts));
  return { generatedAt: new Date().toISOString(), workers };
}

module.exports = { workerStatus, fleetState };
