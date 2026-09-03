'use strict';
// Workflow runner — executes a JSON workflow definition step by step.
//
// Step types:
//   script     — bash script, run synchronously via spawnSync (no tmux)
//   claude-tui — Claude session in a tmux window; waits for done/failed event
//   loop       — repeats inner steps until exitCondition or maxIterations
//
// State passing: steps declare stateReads and stateWrites. The runner injects
// declared read values as STATE_<KEY> env vars before each step runs.
//
// Notify: any job can emit a notify event on the bus. The runner calls
// flushNotify() after every step — this is synchronous so it works correctly
// for both blocking script steps and async claude-tui steps.
//
// claude-tui step option — awaitsReview: true — marks a step as blocked on a
// human (not just slow). Sets the coarse per-worker status to AWAITING_REVIEW
// (read by bin/attend.sh, spawn-worker.sh's notifier, MuaddibApp) and fires a
// notify event, then reverts to RUNNING once the step settles. Generic — any
// project-declared step can opt in; the runner doesn't know or care which one.

const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { eventsFile, emit } = require('./events');
const { startJob, nudgeIdleStep } = require('./job');
const state = require('./state');
const { noteStatus, AGENT_STATUS_DIR } = require('./status');
const { recordStep } = require('./token-tracker');
const { resolveMuaddibRoot } = require('./muaddib-root');
const notifyFormat = require('./notify-format');

// Slack is optional — never let a missing/broken module take the runner down.
let slackNotify = null;
try { slackNotify = require('../services/notify').notify; } catch (_) { slackNotify = null; }

const REPO = process.env.REPO_DIR || '/home/worker/repo';
const MUADDIB_ROOT = resolveMuaddibRoot(REPO);
const MOCK_JOBS = process.env.MOCK_JOBS === '1';
const STATE_CLI = path.join(MUADDIB_ROOT, 'orchestrator/state-cli.js');

// ─── helpers ─────────────────────────────────────────────────────────────────

function permFlag() {
  const p = process.env.CLAUDE_PERMISSION_MODE || 'bypassPermissions';
  return p === 'bypassPermissions' ? '--dangerously-skip-permissions' : `--permission-mode ${p}`;
}

// Safely evaluate a JS expression against the current state object.
// Returns false on any error so a bad expression skips rather than crashes.
function evaluateCondition(expr, stateObj) {
  try {
    // eslint-disable-next-line no-new-func
    return Boolean(new Function('state', `return (${expr})`)(stateObj));
  } catch (_) {
    return false;
  }
}

// Build STATE_<KEY>=value env vars for a step's stateReads list.
function buildExtraEnv(worker, stateReads) {
  if (!stateReads || stateReads.length === 0) return {};
  const s = state.read(worker);
  const env = {};
  for (const key of stateReads) {
    const val = s[key];
    env[`STATE_${key.toUpperCase()}`] = val !== undefined ? String(val) : '';
  }
  return env;
}

// Poll the events file for a done/failed event on `jobName`, starting from
// the file offset at call time (so old events from prior jobs are ignored).
// Must be called BEFORE startJob() to capture the current offset.
//
// opts.warnMs   — ms before firing onWarn (default 300 000 = 5 min); keeps waiting after.
// opts.onWarn   — callback fired once at warnMs if the step hasn't finished yet.
// opts.hardTimeoutMs — ms before giving up entirely (default: none).
// opts.nudgeMs  — ms before the first automatic nudge; after it, onNudge fires on
//                 a repeating interval (~30 s) until the job settles. Unset (the
//                 default) means no nudging — behavior identical to before.
// opts.onNudge  — callback fired on each nudge tick (e.g. type a "run the touch"
//                 message into an idle-stalled session). Keeps waiting either way.
function waitForJobCompletion(worker, jobName, opts = {}) {
  const warnMs = opts.warnMs ?? 300_000;
  const hardTimeoutMs = opts.hardTimeoutMs ?? null;
  const onWarn = opts.onWarn ?? null;
  const nudgeMs = opts.nudgeMs ?? null;
  const onNudge = opts.onNudge ?? null;

  const file = eventsFile(worker);
  let offset = 0;
  try { offset = fs.statSync(file).size; } catch (_) {}
  let remainder = '';

  return new Promise((resolve, reject) => {
    let fd;

    // Single teardown for every exit path (done / failed / hard timeout) so no
    // timer or interval — including the nudge machinery below — is ever leaked.
    function cleanup() {
      clearInterval(poll);
      clearTimeout(warnTimer);
      if (hardTimer) clearTimeout(hardTimer);
      if (nudgeStart) clearTimeout(nudgeStart);
      if (nudgeInterval) clearInterval(nudgeInterval);
    }

    const poll = setInterval(() => {
      try {
        const { size } = fs.statSync(file);
        if (size <= offset) return;
        fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(size - offset);
        const n = fs.readSync(fd, buf, 0, buf.length, offset);
        fs.closeSync(fd);
        fd = undefined;
        offset += n;
        remainder += buf.slice(0, n).toString();
        const lines = remainder.split('\n');
        remainder = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let ev;
          try { ev = JSON.parse(trimmed); } catch (_) { continue; }
          if (ev.job !== jobName) continue;
          if (ev.event === 'done') {
            cleanup();
            resolve();
            return;
          }
          if (ev.event === 'failed') {
            cleanup();
            reject(new Error(`job ${jobName} failed (exit ${ev.payload && ev.payload.exitCode})`));
            return;
          }
        }
      } catch (_) {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch (__) {} fd = undefined; }
      }
    }, 50);

    // Warn at warnMs but keep waiting — the step may need user input.
    const warnTimer = setTimeout(() => {
      if (onWarn) onWarn();
    }, warnMs);
    warnTimer.unref();

    // Optional automatic nudge — once nudgeMs elapses, invoke onNudge right away
    // and then repeatedly (~30 s cadence, but never slower than the threshold so
    // low test values stay snappy) until the job settles. cleanup() clears both
    // the initial delay and the repeat interval. Never fails the step; it only
    // prods a stalled session back into signaling done.
    let nudgeInterval = null;
    const nudgeStart = nudgeMs != null && nudgeMs > 0 && onNudge
      ? setTimeout(() => {
          const tick = () => { try { onNudge(); } catch (_) {} };
          tick();
          nudgeInterval = setInterval(tick, Math.min(30_000, nudgeMs));
          nudgeInterval.unref();
        }, nudgeMs)
      : null;
    if (nudgeStart) nudgeStart.unref();

    // Optional hard ceiling — fail only if explicitly configured.
    const hardTimer = hardTimeoutMs
      ? setTimeout(() => {
          cleanup();
          reject(new Error(`hard timeout (${hardTimeoutMs}ms) waiting for ${jobName}`));
        }, hardTimeoutMs)
      : null;
    if (hardTimer) hardTimer.unref();
  });
}

// ─── notification fan-out ──────────────────────────────────────────────────────

// Read the project + ticket context that enriches a notification's title.
// MUADDIB_PROJECT_NAME is forwarded into the worker by spawn-worker.sh;
// ticket_title is written to state by the fetch-ticket step.
function notifyContext(worker) {
  let ticketTitle = '';
  try { ticketTitle = state.get(worker, 'ticket_title') || ''; } catch (_) {}
  return {
    worker,
    projectName: process.env.MUADDIB_PROJECT_NAME || '',
    ticketTitle,
  };
}

// Fire BOTH delivery channels — desktop (notify.sh) and Slack (services/
// notify.js) — for one notification, from a single shared object built by
// notify-format.js so the two channels always say the same thing. Fire-and-
// forget: desktop is spawned detached; Slack's promise rejection is swallowed so
// a webhook hiccup never breaks the workflow. Emits NO bus event, so a later
// flushNotify() won't re-fire the same notification.
function fireNotification(worker, notifyScript, { kind, message, url } = {}) {
  const ctx = notifyContext(worker);
  const note = notifyFormat.buildNotification({ ...ctx, kind, message, url });

  if (fs.existsSync(notifyScript)) {
    spawn(
      'bash',
      [notifyScript, String(worker), note.title, note.subtitle, note.tier, note.sound],
      { stdio: 'ignore', detached: true }
    ).unref();
  } else {
    console.log(`[runner w${worker}] NOTIFY: ${note.title} — ${note.subtitle}`);
  }

  if (slackNotify) {
    return Promise.resolve()
      .then(() => slackNotify({ ...ctx, kind, message, url }))
      .catch(() => {});
  }
  return Promise.resolve();
}

// ─── notify flush ────────────────────────────────────────────────────────────

// Read any new notify events from the bus since the last flush and fire
// notify.sh fire-and-forget for each one. Called synchronously after each step
// so it works for both blocking script steps and async claude-tui steps.
function makeNotifyFlusher(worker, notifyScript) {
  let offset = 0;
  try { offset = fs.statSync(eventsFile(worker)).size; } catch (_) {}
  let remainder = '';

  return function flushNotify() {
    const file = eventsFile(worker);
    try {
      const { size } = fs.statSync(file);
      if (size <= offset) return;
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(size - offset);
      const n = fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      offset += n;
      remainder += buf.slice(0, n).toString();
      const lines = remainder.split('\n');
      remainder = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let ev;
        try { ev = JSON.parse(trimmed); } catch (_) { continue; }
        if (ev.event !== 'notify') continue;
        // A script-emitted notify event carries a free-form msg; it may also
        // carry an optional kind/url (skills that want the richer tiers). The
        // msg becomes the subtitle and the title is enriched from env + state.
        const payload = ev.payload || {};
        fireNotification(worker, notifyScript, {
          kind: payload.kind,
          message: payload.msg || '',
          url: payload.url,
        });
      }
    } catch (_) {}
  };
}

// ─── step executors ──────────────────────────────────────────────────────────

async function runScriptStep(worker, step) {
  const extraEnv = buildExtraEnv(worker, step.stateReads);
  const scriptPath = path.join(MUADDIB_ROOT, step.script);
  const env = { ...process.env, ...extraEnv, WORKER_INDEX: String(worker) };
  const runtime = scriptPath.endsWith('.js') ? 'node' : 'bash';

  // Optional fixed CLI args from the workflow definition (e.g. size-and-schedule's
  // --propose / --commit phase flag). Args are passed as an array (no shell), so
  // they can never be reinterpreted as shell syntax.
  const args = Array.isArray(step.args) ? step.args.map(String) : [];

  // Capture output to the host-mounted status dir (/var/run/agent-status).
  const logPath = path.join(AGENT_STATUS_DIR, `worker-${worker}-${step.id}.log`);
  const logFd = fs.openSync(logPath, 'w');

  const r = spawnSync(runtime, [scriptPath, ...args], { stdio: ['ignore', logFd, logFd], env });
  fs.closeSync(logFd);

  // Echo to orchestrator stdout so it also appears in docker logs.
  const output = fs.readFileSync(logPath, 'utf8');
  if (output) process.stdout.write(output);

  if (r.status !== 0) {
    throw new Error(`script ${step.id} exited ${r.status} — see status/worker-${worker}-${step.id}.log`);
  }
}

// worker is passed explicitly so mock commands embed the correct worker number
// rather than relying on $WORKER_INDEX in the wrapper environment.
function claudeTuiCmd(worker, step, ticketId) {
  if (MOCK_JOBS) {
    // Write declared mock state values then exit 0.
    // job.js wrapper emits done on exit 0.
    const writes = (step.mockStateWrites || [])
      .map(([k, v]) => `node '${STATE_CLI}' ${worker} set ${k} '${v}'`)
      .join(' && ');
    return `sleep 0.3${writes ? ` && ${writes}` : ''}`;
  }
  const skill = step.skill || step.id;
  return `claude ${permFlag()} "/${skill}${ticketId ? ` ${ticketId}` : ''}"`;
}

async function runClaudeTuiStep(worker, step, ticketId) {
  const extraEnv = {
    ...buildExtraEnv(worker, step.stateReads),
    // Always inject these so skills can read/write state and the mock command works.
    STATE_DIR: process.env.STATE_DIR || '/tmp',
    WORKER_INDEX: String(worker),
  };
  const cmd = claudeTuiCmd(worker, step, ticketId);
  const notifyScript = path.join(MUADDIB_ROOT, 'services/notify.sh');

  // Fires the desktop + Slack channels directly (no bus `emit`). runClaudeTuiStep
  // already runs inside this process, so it doesn't need the notify event's other
  // purpose: letting a script-run job (a separate process with no direct access
  // to this function) request a notification via the bus, which flushNotify()
  // picks up after the step. Emitting AND firing directly here would double-fire:
  // flushNotify() re-reads the same event once the step settles and fires a
  // second time for the identical notification.
  const fireNotify = (opts) => fireNotification(worker, notifyScript, opts);

  const onWarn = () => {
    const msg = `${step.id} is taking longer than expected — worker ${worker} may need input`;
    console.log(`[runner w${worker}] WARN: ${msg}`);
    fireNotify({ kind: notifyFormat.KINDS.BLOCKED, message: msg });
  };

  // STEP_WARN_MS overrides the default (300 000 ms) — used in tests to trigger
  // the warn callback quickly without waiting 5 minutes.
  const warnMs = process.env.STEP_WARN_MS ? Number(process.env.STEP_WARN_MS) : 300_000;

  // Automatic idle-nudge: after nudgeMs with no sentinel, type the "run the
  // touch" recovery into the session (see job.nudgeIdleStep). Default ~10 min,
  // comfortably past warnMs; STEP_NUDGE_MS overrides for tests. Skipped entirely
  // for awaitsReview steps — those are correctly blocked on a human, not stalled.
  const nudgeMs = step.awaitsReview
    ? null
    : (process.env.STEP_NUDGE_MS ? Number(process.env.STEP_NUDGE_MS) : 600_000);

  // Thread the previous pane snapshot between ticks so nudgeIdleStep can tell a
  // genuinely stable (stopped) pane from one that's still changing.
  let prevSnapshot;
  const onNudge = () => {
    const res = nudgeIdleStep(worker, step.id, prevSnapshot);
    prevSnapshot = res.snapshot;
    if (res.nudged) {
      console.log(`[runner w${worker}] NUDGE: ${step.id} idle without sentinel — sent recovery message`);
    }
  };

  const stepStartMs = Date.now();

  // A step can declare awaitsReview so the coarse status board (attend.sh,
  // spawn-worker.sh's notifier, MuaddibApp) shows it's blocked on a human —
  // and pings once via the same generic notify path onWarn uses — without the
  // orchestrator core hardcoding which step that is. Reverted to RUNNING
  // (in a finally) once the step settles, success or failure.
  if (step.awaitsReview) {
    noteStatus(worker, 'AWAITING_REVIEW');
    // awaitsReview may be `true` (legacy) or an interaction-kind string
    // ("review" / "question" / "blocked"). The truthy check above still gates
    // the coarse status; the string now selects the subtitle. A bare `true`
    // falls through to the generic "needs your input" wording (kind=undefined),
    // preserving the historical message and matching bin/attend.sh /
    // spawn-worker.sh's notifier for this state.
    const kind = typeof step.awaitsReview === 'string' ? step.awaitsReview : undefined;
    let url;
    try { url = state.get(worker, 'ticket_url') || undefined; } catch (_) {}
    fireNotify({ kind, url });
  }

  try {
    // Capture offset BEFORE startJob so the done event is never missed.
    const waitP = waitForJobCompletion(worker, step.id, { onWarn, warnMs, nudgeMs, onNudge });
    startJob(worker, step.id, cmd, extraEnv);
    await waitP;
  } finally {
    if (step.awaitsReview) noteStatus(worker, 'RUNNING');
  }

  if (!MOCK_JOBS) {
    try {
      recordStep(worker, step.id, stepStartMs);
    } catch (_) {}
  }
}

// ─── loop ────────────────────────────────────────────────────────────────────

async function runLoop(worker, loopStep, ticketId, flushNotify) {
  const max = loopStep.maxIterations || 10;
  const min = loopStep.minIterations || 0;

  for (let i = 0; i < max; i++) {
    if (i >= min && loopStep.exitCondition) {
      if (evaluateCondition(loopStep.exitCondition, state.read(worker))) {
        console.log(`[runner w${worker}] loop ${loopStep.id} exited at iteration ${i}`);
        return;
      }
    }
    for (const job of loopStep.steps) {
      // eslint-disable-next-line no-await-in-loop
      await runSingleStep(worker, job, ticketId, flushNotify);
    }
  }

  // Final check after the last iteration completes.
  if (loopStep.exitCondition && evaluateCondition(loopStep.exitCondition, state.read(worker))) {
    return;
  }
  throw new Error(`loop ${loopStep.id} exhausted ${max} iterations without exit condition`);
}

// ─── step dispatcher ─────────────────────────────────────────────────────────

async function runSingleStep(worker, step, ticketId, flushNotify) {
  if (step.runIf !== undefined) {
    if (!evaluateCondition(step.runIf, state.read(worker))) {
      console.log(`[runner w${worker}] skip  ${step.id} (runIf=false)`);
      return;
    }
  }

  console.log(`[runner w${worker}] start ${step.id} [${step.type}]`);
  emit(worker, 'runner', 'step_start', { id: step.id, type: step.type });

  try {
    if (step.type === 'script') {
      await runScriptStep(worker, step);
    } else if (step.type === 'claude-tui') {
      await runClaudeTuiStep(worker, step, ticketId);
    } else if (step.type === 'loop') {
      await runLoop(worker, step, ticketId, flushNotify);
    } else {
      throw new Error(`unknown step type: ${step.type}`);
    }
  } catch (err) {
    // A throwing step never reaches the step_done below, so without a terminal
    // signal here Fleet State would show the worker running this step with
    // failed=false forever. Emit a failed event (naming the step) before
    // propagating so the derived status reflects the failure.
    emit(worker, 'runner', 'failed', { id: step.id, error: String((err && err.message) || err) });
    throw err;
  }

  flushNotify();
  emit(worker, 'runner', 'step_done', { id: step.id });
  console.log(`[runner w${worker}] done  ${step.id}`);
}

// ─── main entry ──────────────────────────────────────────────────────────────

async function run(worker, workflowPath, ticketId) {
  const definition = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
  console.log(`[runner w${worker}] workflow: ${definition.name}`);

  const notifyScript = path.join(MUADDIB_ROOT, 'services/notify.sh');
  const flushNotify = makeNotifyFlusher(worker, notifyScript);

  for (const step of definition.workflow) {
    // eslint-disable-next-line no-await-in-loop
    await runSingleStep(worker, step, ticketId, flushNotify);
  }

  flushNotify();
  emit(worker, 'runner', 'workflow_done', { name: definition.name });
  console.log(`[runner w${worker}] workflow complete`);
}

// Fire a notification for a worker from outside the step loop (e.g.
// orchestrator.js's FEEDBACK loop firing an info-tier "PR merged"). Resolves the
// desktop hook path itself so callers just pass the notification opts.
function notifyHuman(worker, opts = {}) {
  return fireNotification(worker, path.join(MUADDIB_ROOT, 'services/notify.sh'), opts);
}

module.exports = { run, evaluateCondition, waitForJobCompletion, notifyHuman };
