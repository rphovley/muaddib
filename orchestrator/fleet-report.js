'use strict';
// Fleet Report — the human-readable rendering layer over Fleet State
// (muaddib#25, Autonomy L0). Where fleet-state.js folds the `.events` streams
// into machine-shaped status objects, this turns one of those objects into a
// coherent, at-a-glance report a human (or the Conductor's `claude` session)
// reads: a header plus one aligned summary line per worker.
//
// Mirrors the notify-format.js pattern — a pure, dependency-free *formatter*
// sitting beside the data it renders. The format* functions take a
// fleetState()/workerStatus()-shaped object and return a string with no I/O, so
// they're unit-testable over fixture objects. The renderLive* conveniences are
// the only part that touches fleet-state.js: they recompute the live status
// (uncached, like everything built on the fold) and then format it, so the
// report inherits Fleet State's liveness and read-only guarantees for free.

const { fleetState, workerStatus } = require('./fleet-state');

// The currentStep column: the step's human-meaningful name — its id (`implement`,
// `check`, `plan`), falling back to the executor `type` (`claude-tui`, `script`)
// only when no id is present — plus whether it's in flight `(running)` or the
// last completed step `(last)`. A worker with no step yet reads as "no step"
// rather than a blank.
function stepLabel(currentStep) {
  if (!currentStep) return 'no step';
  const kind =
    currentStep.id != null ? currentStep.id :
    currentStep.type != null ? currentStep.type : 'step';
  return `${kind} ${currentStep.running ? '(running)' : '(last)'}`;
}

// Terminal flags, in order: a completed workflow names itself; a failed outcome
// shouts FAILED. Both, one, or neither may apply; joined with a middle dot.
// Returns '' when the worker is mid-run with nothing terminal to report.
function flagLabel(status) {
  const flags = [];
  if (status.workflowDone) {
    flags.push(`workflow "${status.workflowName != null ? status.workflowName : '?'}" complete`);
  }
  if (status.failed) flags.push('FAILED');
  return flags.join(' · ');
}

// One worker's summary line. `opts` carries the column widths the fleet renderer
// computes so lines align into columns; called with no opts (the single-worker
// CLI form) each field is its own natural width — a valid, if unpadded, line.
function formatWorkerReport(status, opts = {}) {
  const s = status || {};
  const label = `worker ${s.worker}`;
  const state = s.state == null ? '—' : String(s.state);
  const step = stepLabel(s.currentStep);
  const count = Number.isFinite(s.eventCount) ? s.eventCount : 0;
  const last = s.lastEventTs == null ? '—' : String(s.lastEventTs);

  const cols = [
    label.padEnd(opts.labelWidth || label.length),
    state.padEnd(opts.stateWidth || state.length),
    step.padEnd(opts.stepWidth || step.length),
    `${count} event${count === 1 ? '' : 's'}`,
    `last ${last}`,
  ];
  const flags = flagLabel(s);
  if (flags) cols.push(flags);
  return cols.join('   ');
}

// The whole-fleet report: a header line naming when it was generated and how
// many workers it covers, then one aligned line per worker. An empty fleet — no
// worker has emitted anything yet — gets a clear single-line note instead of a
// bare header with nothing under it.
function formatFleetReport(state) {
  const s = state || {};
  const workers = Array.isArray(s.workers) ? s.workers : [];
  const generatedAt = s.generatedAt != null ? s.generatedAt : 'unknown time';
  const header = `Fleet State — ${generatedAt} · ${workers.length} worker${workers.length === 1 ? '' : 's'}`;

  if (!workers.length) {
    return `${header}\nNo workers have emitted events yet.`;
  }

  // Pad the three leading columns to the widest cell in each so the report reads
  // as a table rather than a ragged list. Counts/timestamp/flags trail after the
  // aligned block and need no padding.
  const labelWidth = Math.max(...workers.map((w) => `worker ${w.worker}`.length));
  const stateWidth = Math.max(...workers.map((w) => (w.state == null ? '—' : String(w.state)).length));
  const stepWidth = Math.max(...workers.map((w) => stepLabel(w.currentStep).length));

  const lines = workers.map((w) => formatWorkerReport(w, { labelWidth, stateWidth, stepWidth }));
  return [header, ...lines].join('\n');
}

// Live entry points — the uncached, read-only surface. Each recomputes Fleet
// State from the files on disk on every call (no cache to go stale) and formats
// it, so a report always reflects the events written right now.
function renderLiveFleetReport() {
  return formatFleetReport(fleetState());
}

function renderLiveWorkerReport(worker) {
  return formatWorkerReport(workerStatus(worker));
}

module.exports = {
  stepLabel,
  flagLabel,
  formatWorkerReport,
  formatFleetReport,
  renderLiveFleetReport,
  renderLiveWorkerReport,
};
