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
const { readGoalThresholds } = require('../services/goals');

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

// The Goal Context thresholds line (muaddib#28) — a compact rendering of the
// budget / concurrency / retry caps parsed from `.muaddib/goals.md`, sat under
// the header. `running` is the live count of workers holding a concurrency slot,
// shown beside the concurrency cap so a reader sees usage against the limit at a
// glance. Any cap the Goal Context doesn't state renders as `not set`. This is a
// surfacing line only — the report neither enforces nor decides against these
// values (muaddib#28 scope boundary).
function formatThresholdsLine(thresholds, opts = {}) {
  const t = thresholds || {};
  const running = Number.isFinite(opts.running) ? opts.running : 0;
  const budget = t.budget == null ? 'not set' : `$${t.budget}`;
  const concurrencyCap = t.concurrency == null ? 'not set' : String(t.concurrency);
  const retry = t.retry == null ? 'not set' : String(t.retry);
  return `Thresholds — budget cap: ${budget} · concurrency cap: ${concurrencyCap} (running: ${running}) · retry limit: ${retry}`;
}

// The whole-fleet report: a header line naming when it was generated and how
// many workers it covers, an optional Goal Context thresholds line, then one
// aligned line per worker. An empty fleet — no worker has emitted anything yet —
// gets a clear single-line note instead of a bare header with nothing under it.
// `opts.thresholds` (with `opts.running`) adds the thresholds line; omitting it
// leaves the output byte-for-byte as before (the plain CLI/single-worker path).
function formatFleetReport(state, opts = {}) {
  const s = state || {};
  const workers = Array.isArray(s.workers) ? s.workers : [];
  const generatedAt = s.generatedAt != null ? s.generatedAt : 'unknown time';
  const header = `Fleet State — ${generatedAt} · ${workers.length} worker${workers.length === 1 ? '' : 's'}`;

  const headerLines = [header];
  if (opts.thresholds) {
    headerLines.push(formatThresholdsLine(opts.thresholds, { running: opts.running }));
  }

  if (!workers.length) {
    return `${headerLines.join('\n')}\nNo workers have emitted events yet.`;
  }

  // Pad the three leading columns to the widest cell in each so the report reads
  // as a table rather than a ragged list. Counts/timestamp/flags trail after the
  // aligned block and need no padding.
  const labelWidth = Math.max(...workers.map((w) => `worker ${w.worker}`.length));
  const stateWidth = Math.max(...workers.map((w) => (w.state == null ? '—' : String(w.state)).length));
  const stepWidth = Math.max(...workers.map((w) => stepLabel(w.currentStep).length));

  const lines = workers.map((w) => formatWorkerReport(w, { labelWidth, stateWidth, stepWidth }));
  return [...headerLines, ...lines].join('\n');
}

// Live entry points — the uncached, read-only surface. Each recomputes Fleet
// State from the files on disk on every call (no cache to go stale) and formats
// it, so a report always reflects the events written right now.
// Compute the live fleet state once, read the Goal Context thresholds for the
// active repo, and count workers holding a concurrency slot (an in-flight step),
// then format all three together. The threshold read is strictly read-only
// (`bootstrap: false`) — a missing goals.md yields no thresholds rather than
// writing the default template into the repo — so the report keeps its no-cache
// / no-side-effects contract. A threshold-read failure never breaks the report —
// the line is simply omitted.
function renderLiveFleetReport(opts = {}) {
  const state = fleetState();
  const repoDir = opts.repoDir || process.env.REPO_DIR || process.cwd();
  let thresholds = null;
  try {
    thresholds = readGoalThresholds(repoDir, { bootstrap: false });
  } catch (_) {
    thresholds = null;
  }
  const workers = Array.isArray(state.workers) ? state.workers : [];
  const running = workers.filter((w) => w.currentStep && w.currentStep.running).length;
  return formatFleetReport(state, { thresholds, running });
}

function renderLiveWorkerReport(worker) {
  return formatWorkerReport(workerStatus(worker));
}

module.exports = {
  stepLabel,
  flagLabel,
  formatWorkerReport,
  formatThresholdsLine,
  formatFleetReport,
  renderLiveFleetReport,
  renderLiveWorkerReport,
};
