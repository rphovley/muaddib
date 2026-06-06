#!/usr/bin/env node
'use strict';
// Orchestrator state machine test suite. MOCK_JOBS=1 — no cloudflared needed.
// Requires tmux (run inside the worker container).
//
// testBootSequence  — orchestrator transitions through all boot states to WATCHING
// testFeedbackCycle — injecting webhook:feedback triggers WATCHING_FEEDBACK,
//                     then returns to WATCHING when the feedback job finishes

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const WORKER = 97;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-'));
const STATUS_FILE = path.join(TMP_DIR, `worker-${WORKER}.state`);
const EMIT_CLI = path.join(__dirname, '../emit-cli.js');

process.env.AGENT_STATUS_DIR = TMP_DIR;

const hasSess = spawnSync('tmux', ['has-session', '-t', `w${WORKER}`], { stdio: 'ignore' });
if (hasSess.status !== 0) {
  const r = spawnSync('tmux', ['new-session', '-d', '-s', `w${WORKER}`], { stdio: 'ignore' });
  if (r.status !== 0) {
    console.error('FAIL — could not create tmux session (is tmux installed?)');
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
    process.exit(1);
  }
}

function readState() {
  try { return fs.readFileSync(STATUS_FILE, 'utf8').trim().split(' ')[0]; } catch (_) { return ''; }
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForState(target, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readState() === target) return;
    await wait(150);
  }
  throw new Error(`timeout waiting for state "${target}" (current: "${readState()}")`);
}

function emitEvent(job, event, payload = {}) {
  spawnSync(process.execPath, [EMIT_CLI, String(WORKER), job, event, JSON.stringify(payload)], {
    stdio: 'inherit', env: process.env,
  });
}

// ─── shared orchestrator process ─────────────────────────────────────────────

let orch;
const ORCH_ENV = {
  WORKER_INDEX: String(WORKER),
  MOCK_JOBS: '1',
  LINEAR_ISSUE_IDENTIFIER: '',
  LINEAR_API_KEY: '',
  AGENT_STATUS_DIR: TMP_DIR,
  REPO_DIR: path.join(__dirname, '../../..'),
};

// ─── helpers for isolated orchestrator instances ──────────────────────────────

function spawnOrch(worker, tmpDir) {
  return spawn(process.execPath, [path.join(__dirname, '../orchestrator.js')], {
    env: {
      ...process.env,
      WORKER_INDEX: String(worker),
      MOCK_JOBS: '1',
      LINEAR_ISSUE_IDENTIFIER: '',
      LINEAR_API_KEY: '',
      AGENT_STATUS_DIR: tmpDir,
      REPO_DIR: path.join(__dirname, '../../..'),
    },
    stdio: 'inherit',
  });
}

async function waitForFileState(statusFile, target, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  const read = () => {
    try { return fs.readFileSync(statusFile, 'utf8').trim().split(' ')[0]; } catch (_) { return ''; }
  };
  while (Date.now() < deadline) {
    if (read() === target) return;
    await wait(150);
  }
  throw new Error(`timeout waiting for "${target}" (current: "${read()}")`);
}

function emitTo(tmpDir, worker, job, event, payload = {}) {
  spawnSync(process.execPath, [EMIT_CLI, String(worker), job, event, JSON.stringify(payload)], {
    stdio: 'inherit',
    env: { ...process.env, AGENT_STATUS_DIR: tmpDir },
  });
}

// ─── tests ───────────────────────────────────────────────────────────────────

// Subscribe BEFORE starting the orchestrator so no fast-transitioning states
// (BOOTING, STARTING_JOBS) are missed. Verify all expected states are visited
// in the correct order via orchestrator:state_changed events on the bus.
async function testBootSequence() {
  const { subscribe } = require('../events');
  const visited = [];
  const EXPECTED = ['BOOTING', 'STARTING_JOBS', 'WAITING_FOR_SERVERS', 'CLAUDE_RUNNING', 'WATCHING'];

  await new Promise((resolve, reject) => {
    const sub = subscribe(WORKER, (ev) => {
      if (ev.job !== 'orchestrator' || ev.event !== 'state_changed') return;
      visited.push(ev.payload.state);
      if (ev.payload.state === 'WATCHING') { sub.kill(); resolve(); }
    });
    const timer = setTimeout(() => {
      sub.kill();
      reject(new Error(`timed out at 15s — visited: [${visited.join(', ')}]`));
    }, 15000);
    timer.unref();

    orch = spawn(process.execPath, [path.join(__dirname, '../orchestrator.js')], {
      env: { ...process.env, ...ORCH_ENV },
      stdio: 'inherit',
    });
  });

  for (let i = 0; i < EXPECTED.length; i++) {
    const s = EXPECTED[i];
    const idx = visited.indexOf(s);
    if (idx === -1) throw new Error(`state ${s} never visited (visited: [${visited.join(', ')}])`);
    if (i > 0) {
      const prev = EXPECTED[i - 1];
      if (visited.indexOf(prev) > idx) throw new Error(`${s} appeared before ${prev}`);
    }
  }
}

async function testFeedbackCycle() {
  if (readState() !== 'WATCHING') throw new Error('precondition: must be in WATCHING state');

  emitEvent('webhook', 'feedback', { prNumber: 42 });
  await waitForState('WATCHING_FEEDBACK');
  // Mock claude-feedback exits 0 after 1 s → done event → back to WATCHING.
  await waitForState('WATCHING', 10000);
}

// webhook:merged in WATCHING → DONE_FINAL + orchestrator exits 0.
// Runs against the shared orchestrator (must follow testFeedbackCycle).
async function testMergedExitsDone() {
  if (readState() !== 'WATCHING') throw new Error('precondition: must be in WATCHING state');

  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('orchestrator did not exit within 5s after webhook:merged')),
      5000,
    );
    orch.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`expected exit 0, got ${code}`));
      else resolve();
    });
    emitEvent('webhook', 'merged', {});
  });

  if (readState() !== 'DONE_FINAL') throw new Error(`expected DONE_FINAL, got ${readState()}`);
}

// Three consecutive claude:failed events exhaust MAX_CLAUDE_FAILURES → FAILED + exit 1.
async function testClaudeRetryAndFail() {
  const W = 95;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-retry-'));
  const statusFile = path.join(tmpDir, `worker-${W}.state`);
  spawnSync('tmux', ['kill-session', '-t', `w${W}`], { stdio: 'ignore' });
  spawnSync('tmux', ['new-session', '-d', '-s', `w${W}`], { stdio: 'ignore' });

  let orch2;
  try {
    orch2 = spawnOrch(W, tmpDir);
    await waitForFileState(statusFile, 'CLAUDE_RUNNING');

    for (let i = 0; i < 3; i++) {
      emitTo(tmpDir, W, 'claude', 'failed', { exitCode: 1 });
      await wait(100);
    }

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('orchestrator did not exit within 5s')), 5000);
      orch2.once('exit', (code) => {
        clearTimeout(timer);
        if (code !== 1) reject(new Error(`expected exit 1, got ${code}`));
        else resolve();
      });
    });

    const finalState = fs.readFileSync(statusFile, 'utf8').trim().split(' ')[0];
    if (finalState !== 'FAILED') throw new Error(`expected FAILED, got ${finalState}`);
  } finally {
    if (orch2) try { orch2.kill(); } catch (_) {}
    spawnSync('tmux', ['kill-session', '-t', `w${W}`], { stdio: 'ignore' });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// A webhook:feedback event while in CLAUDE_RUNNING must be a no-op — the guard
// `if (state === 'WATCHING')` should prevent a spurious claude-feedback job.
async function testStaleEventIgnored() {
  const W = 96;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-stale-'));
  const statusFile = path.join(tmpDir, `worker-${W}.state`);
  spawnSync('tmux', ['kill-session', '-t', `w${W}`], { stdio: 'ignore' });
  spawnSync('tmux', ['new-session', '-d', '-s', `w${W}`], { stdio: 'ignore' });

  let orch3;
  let watcher;
  const statesSeen = [];
  const origDir = process.env.AGENT_STATUS_DIR;

  try {
    // Subscribe before starting the orchestrator so we capture every transition.
    // Temporarily redirect AGENT_STATUS_DIR so subscribe() reads the right events file.
    process.env.AGENT_STATUS_DIR = tmpDir;
    const { subscribe: sub3 } = require('../events');
    watcher = sub3(W, (ev) => {
      if (ev.job === 'orchestrator' && ev.event === 'state_changed') {
        statesSeen.push(ev.payload.state);
      }
    });
    process.env.AGENT_STATUS_DIR = origDir;

    orch3 = spawnOrch(W, tmpDir);
    await waitForFileState(statusFile, 'CLAUDE_RUNNING');

    emitTo(tmpDir, W, 'webhook', 'feedback', { prNumber: 99 });

    // Let the mock claude job (sleep 2) finish so the orchestrator naturally
    // advances to WATCHING — if the stale event were acted on, WATCHING_FEEDBACK
    // would appear before WATCHING.
    await waitForFileState(statusFile, 'WATCHING', 6000);

    if (statesSeen.includes('WATCHING_FEEDBACK')) {
      throw new Error(
        `WATCHING_FEEDBACK entered; stale event was not ignored (transitions: ${statesSeen.join(' → ')})`,
      );
    }
  } finally {
    if (watcher) watcher.kill();
    process.env.AGENT_STATUS_DIR = origDir;
    if (orch3) try { orch3.kill(); } catch (_) {}
    spawnSync('tmux', ['kill-session', '-t', `w${W}`], { stdio: 'ignore' });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ─── runner ──────────────────────────────────────────────────────────────────

async function main() {
  const tests = [
    ['boot sequence: BOOTING → STARTING_JOBS → WAITING_FOR_SERVERS → CLAUDE_RUNNING → WATCHING', testBootSequence],
    ['feedback cycle: webhook:feedback → WATCHING_FEEDBACK → WATCHING', testFeedbackCycle],
    // testMergedExitsDone must follow testFeedbackCycle — it consumes the shared orch.
    ['webhook:merged → DONE_FINAL + orchestrator exits 0', testMergedExitsDone],
    // Isolated orchestrators — order independent.
    ['3× claude:failed → FAILED state + exit 1', testClaudeRetryAndFail],
    ['webhook:feedback in CLAUDE_RUNNING is a no-op (state guard)', testStaleEventIgnored],
  ];

  let passed = 0;
  for (const [name, fn] of tests) {
    process.stdout.write(`  ${name}... `);
    try {
      await fn();
      process.stdout.write('PASS\n');
      passed++;
    } catch (err) {
      process.stdout.write(`FAIL\n    ${err.message}\n`);
    }
  }

  // orch may have already exited naturally via testMergedExitsDone.
  if (orch) try { orch.kill(); } catch (_) {}
  spawnSync('tmux', ['kill-session', '-t', `w${WORKER}`], { stdio: 'ignore' });
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log(`\n${passed}/${tests.length} passed`);
  if (passed < tests.length) process.exit(1);
}

main().catch((err) => {
  if (orch) try { orch.kill(); } catch (_) {}
  spawnSync('tmux', ['kill-session', '-t', `w${WORKER}`], { stdio: 'ignore' });
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.error('FAIL —', err.message);
  process.exit(1);
});
