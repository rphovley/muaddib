#!/usr/bin/env node
'use strict';
// Orchestrator integration test suite. Requires tmux.
//
// testBootSequence    — BOOTING → STARTING_SERVICES → RUNNING → FEEDBACK
// testFeedbackCycle   — webhook:feedback → FEEDBACK_WORKING → FEEDBACK
// testMergedExitsDone — webhook:merged → DONE_FINAL + orchestrator exits 0

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const TMP_DIR     = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-'));
const WORKER      = 97;
const STATUS_FILE = path.join(TMP_DIR, `worker-${WORKER}.state`);
const EMIT_CLI    = path.join(__dirname, '../emit-cli.js');

process.env.AGENT_STATUS_DIR = TMP_DIR;
process.env.STATE_DIR        = TMP_DIR;

// ─── mock workflow — two claude-tui steps, no script steps ──────────────────
// Using only claude-tui keeps the test self-contained: no run-checks.sh needed,
// and MOCK_JOBS=1 makes each step sleep 0.3s then exit cleanly.

const MOCK_WF_PATH = path.join(TMP_DIR, 'mock.json');
fs.writeFileSync(MOCK_WF_PATH, JSON.stringify({
  name: 'mock',
  services: [
    { name: 'servers', readyEvent: 'tunnel_ready' },
    { name: 'webhook' },
  ],
  workflow: [
    { id: 'gather-context', type: 'claude-tui', skill: 'gather-context' },
    { id: 'wrapup', type: 'claude-tui', skill: 'commit-and-pr',
      mockStateWrites: [['pr_number', '1']] },
  ],
}, null, 2));

// ─── shared tmux session ─────────────────────────────────────────────────────

const hasSess = spawnSync('tmux', ['has-session', '-t', `w${WORKER}`], { stdio: 'ignore' });
if (hasSess.status !== 0) {
  const r = spawnSync('tmux', ['new-session', '-d', '-s', `w${WORKER}`], { stdio: 'ignore' });
  if (r.status !== 0) {
    console.error('FAIL — could not create tmux session (is tmux installed?)');
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
    process.exit(1);
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function readState() {
  try { return fs.readFileSync(STATUS_FILE, 'utf8').trim().split(' ')[0]; } catch (_) { return ''; }
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForState(target, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readState() === target) return;
    await wait(150);
  }
  throw new Error(`timeout waiting for "${target}" (current: "${readState()}")`);
}

function emitEvent(job, event, payload = {}) {
  spawnSync(process.execPath, [EMIT_CLI, String(WORKER), job, event, JSON.stringify(payload)], {
    stdio: 'inherit', env: process.env,
  });
}

const ORCH_ENV = {
  WORKER_INDEX:           String(WORKER),
  MOCK_JOBS:              '1',
  LINEAR_ISSUE_IDENTIFIER: '',
  LINEAR_API_KEY:          '',
  AGENT_STATUS_DIR:        TMP_DIR,
  STATE_DIR:               TMP_DIR,
  REPO_DIR:                path.join(__dirname, '../../..'),
  WORKFLOW_FILE:           MOCK_WF_PATH,
};

let orch; // shared orchestrator process used across the first three tests

// ─── tests ───────────────────────────────────────────────────────────────────

// Subscribe BEFORE starting the orchestrator to capture all state transitions
// including fast early ones (BOOTING, STARTING_SERVICES).
async function testBootSequence() {
  const { subscribe } = require('../events');
  const visited = [];
  const EXPECTED = ['BOOTING', 'STARTING_SERVICES', 'RUNNING', 'FEEDBACK'];

  await new Promise((resolve, reject) => {
    const sub = subscribe(WORKER, (ev) => {
      if (ev.job !== 'orchestrator' || ev.event !== 'state_changed') return;
      visited.push(ev.payload.state);
      if (ev.payload.state === 'FEEDBACK') { sub.kill(); resolve(); }
    });
    const timer = setTimeout(() => {
      sub.kill();
      reject(new Error(`timed out at 30s — visited: [${visited.join(', ')}]`));
    }, 30000);
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
    if (i > 0 && visited.indexOf(EXPECTED[i - 1]) > idx) {
      throw new Error(`${s} appeared before ${EXPECTED[i - 1]}`);
    }
  }
}

async function testFeedbackCycle() {
  if (readState() !== 'FEEDBACK') throw new Error('precondition: must be in FEEDBACK');
  emitEvent('webhook', 'feedback', { prNumber: 42 });
  await waitForState('FEEDBACK_WORKING');
  // Mock claude-feedback exits 0 after 0.3s → done event → back to FEEDBACK.
  await waitForState('FEEDBACK', 10000);
}

// webhook:merged in FEEDBACK → DONE_FINAL + orchestrator exits 0.
// Runs against the shared orchestrator (must follow testFeedbackCycle).
async function testMergedExitsDone() {
  if (readState() !== 'FEEDBACK') throw new Error('precondition: must be in FEEDBACK');

  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('orchestrator did not exit within 5s after webhook:merged')), 5000,
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

// ─── runner ──────────────────────────────────────────────────────────────────

async function main() {
  const tests = [
    ['boot sequence: BOOTING → STARTING_SERVICES → RUNNING → FEEDBACK', testBootSequence],
    ['feedback cycle: webhook:feedback → FEEDBACK_WORKING → FEEDBACK',  testFeedbackCycle],
    ['webhook:merged → DONE_FINAL + orchestrator exits 0',               testMergedExitsDone],
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
