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

const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { eventsFile, emit } = require('./events');
const { startJob } = require('./job');
const state = require('./state');

const REPO = process.env.REPO_DIR || '/home/worker/repo';
const MOCK_JOBS = process.env.MOCK_JOBS === '1';
const STATE_CLI = path.join(REPO, 'muaddib/orchestrator/state-cli.js');

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
function waitForJobCompletion(worker, jobName, opts = {}) {
  const warnMs = opts.warnMs ?? 300_000;
  const hardTimeoutMs = opts.hardTimeoutMs ?? null;
  const onWarn = opts.onWarn ?? null;

  const file = eventsFile(worker);
  let offset = 0;
  try { offset = fs.statSync(file).size; } catch (_) {}
  let remainder = '';

  return new Promise((resolve, reject) => {
    let fd;

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
            clearInterval(poll);
            clearTimeout(warnTimer);
            if (hardTimer) clearTimeout(hardTimer);
            resolve();
            return;
          }
          if (ev.event === 'failed') {
            clearInterval(poll);
            clearTimeout(warnTimer);
            if (hardTimer) clearTimeout(hardTimer);
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

    // Optional hard ceiling — fail only if explicitly configured.
    const hardTimer = hardTimeoutMs
      ? setTimeout(() => {
          clearInterval(poll);
          clearTimeout(warnTimer);
          reject(new Error(`hard timeout (${hardTimeoutMs}ms) waiting for ${jobName}`));
        }, hardTimeoutMs)
      : null;
    if (hardTimer) hardTimer.unref();
  });
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
        const msg = (ev.payload && ev.payload.msg) || '';
        if (fs.existsSync(notifyScript)) {
          spawn('bash', [notifyScript, String(worker), msg], { stdio: 'ignore', detached: true }).unref();
        } else {
          console.log(`[runner w${worker}] NOTIFY: ${msg}`);
        }
      }
    } catch (_) {}
  };
}

// ─── step executors ──────────────────────────────────────────────────────────

async function runScriptStep(worker, step) {
  const extraEnv = buildExtraEnv(worker, step.stateReads);
  const scriptPath = path.join(REPO, 'muaddib', step.script);
  const env = { ...process.env, ...extraEnv, WORKER_INDEX: String(worker) };
  const runtime = scriptPath.endsWith('.js') ? 'node' : 'bash';

  // Capture output to a host-visible log file so it survives container teardown.
  // The status dir is volume-mounted; log path mirrors the state file convention.
  const statusDir = path.join(REPO, 'muaddib/status');
  const logPath = path.join(statusDir, `worker-${worker}-${step.id}.log`);
  try { fs.mkdirSync(statusDir, { recursive: true }); } catch (_) {}
  const logFd = fs.openSync(logPath, 'w');

  const r = spawnSync(runtime, [scriptPath], { stdio: ['ignore', logFd, logFd], env });
  fs.closeSync(logFd);

  // Echo to orchestrator stdout so it also appears in docker logs.
  const output = fs.readFileSync(logPath, 'utf8');
  if (output) process.stdout.write(output);

  if (r.status !== 0) {
    throw new Error(`script ${step.id} exited ${r.status} — see muaddib/status/worker-${worker}-${step.id}.log`);
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
  const notifyScript = path.join(REPO, 'muaddib/services/notify.sh');

  const onWarn = () => {
    const msg = `${step.id} is taking longer than expected — worker ${worker} may need input`;
    console.log(`[runner w${worker}] WARN: ${msg}`);
    emit(worker, 'orchestrator', 'notify', { msg });
    if (fs.existsSync(notifyScript)) {
      spawn('bash', [notifyScript, String(worker), msg], { stdio: 'ignore', detached: true }).unref();
    }
  };

  // STEP_WARN_MS overrides the default (300 000 ms) — used in tests to trigger
  // the warn callback quickly without waiting 5 minutes.
  const warnMs = process.env.STEP_WARN_MS ? Number(process.env.STEP_WARN_MS) : 300_000;

  // Capture offset BEFORE startJob so the done event is never missed.
  const waitP = waitForJobCompletion(worker, step.id, { onWarn, warnMs });
  startJob(worker, step.id, cmd, extraEnv);
  await waitP;
}

// ─── loop ────────────────────────────────────────────────────────────────────

async function runLoop(worker, loopStep, ticketId, flushNotify) {
  const max = loopStep.maxIterations || 10;

  for (let i = 0; i < max; i++) {
    if (loopStep.exitCondition) {
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

  if (step.type === 'script') {
    await runScriptStep(worker, step);
  } else if (step.type === 'claude-tui') {
    await runClaudeTuiStep(worker, step, ticketId);
  } else if (step.type === 'loop') {
    await runLoop(worker, step, ticketId, flushNotify);
  } else {
    throw new Error(`unknown step type: ${step.type}`);
  }

  flushNotify();
  emit(worker, 'runner', 'step_done', { id: step.id });
  console.log(`[runner w${worker}] done  ${step.id}`);
}

// ─── main entry ──────────────────────────────────────────────────────────────

async function run(worker, workflowPath, ticketId) {
  const definition = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
  console.log(`[runner w${worker}] workflow: ${definition.name}`);

  const notifyScript = path.join(REPO, 'muaddib/services/notify.sh');
  const flushNotify = makeNotifyFlusher(worker, notifyScript);

  for (const step of definition.workflow) {
    // eslint-disable-next-line no-await-in-loop
    await runSingleStep(worker, step, ticketId, flushNotify);
  }

  flushNotify();
  emit(worker, 'runner', 'workflow_done', { name: definition.name });
  console.log(`[runner w${worker}] workflow complete`);
}

module.exports = { run, evaluateCondition, waitForJobCompletion };
