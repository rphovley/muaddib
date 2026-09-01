#!/usr/bin/env node
'use strict';
// Fleet State test suite (muaddib#24). No container or tmux needed — points
// AGENT_STATUS_DIR at a temp dir and emit()s scripted event sequences, then
// asserts the read-only derivation.
//
// testDerivesLiveStatus  — a full run (state transitions, an open step, a
//                          completed step, a workflow_done) folds into the
//                          expected coarse state, currentStep, and flags.
// testInFlightStep       — a step_start with no matching step_done surfaces as
//                          the in-flight currentStep (running: true).
// testFailedFlag         — a `failed` event and a non-zero exitCode both set
//                          failed=true.
// testNoEventsFile       — a worker that never emitted reads as empty (no file).
// testRecomputeNoCache   — appending an event and calling again reflects it,
//                          proving Fleet State is recomputed, never cached.
// testMalformedSkipped   — a garbage line in the stream is skipped, not fatal.
// testFleetStateLists    — fleetState() enumerates exactly the workers that
//                          have an events file, sorted, each folded.
// testInspectCli         — spawning inspect-cli.js prints parseable JSON for
//                          both the whole-fleet and single-worker forms.

const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-test-'));
process.env.AGENT_STATUS_DIR = TMP_DIR;

const { emit, eventsFile } = require('../events');
const { workerStatus, fleetState } = require('../fleet-state');
const inspectCli = path.join(__dirname, '../inspect-cli.js');

// Each test uses a distinct worker index so their event files don't overlap.
const BASE = 970;

function reset(worker) {
  try { fs.unlinkSync(eventsFile(worker)); } catch (_) {}
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function testDerivesLiveStatus() {
  const W = BASE + 1;
  reset(W);

  emit(W, 'orchestrator', 'state_changed', { state: 'BOOTING' });
  emit(W, 'orchestrator', 'state_changed', { state: 'RUNNING' });
  emit(W, 'runner', 'step_start', { id: 'plan', type: 'claude-tui' });
  emit(W, 'runner', 'step_done', { id: 'plan' });
  emit(W, 'runner', 'workflow_done', { name: 'muaddib' });

  const s = workerStatus(W);
  assert(s.worker === W, `worker mismatch: ${s.worker}`);
  assert(s.state === 'RUNNING', `expected state RUNNING, got ${s.state}`);
  assert(s.currentStep && s.currentStep.id === 'plan', `expected currentStep plan, got ${JSON.stringify(s.currentStep)}`);
  assert(s.currentStep.running === false, `completed step should be running:false, got ${s.currentStep.running}`);
  assert(s.currentStep.type === 'claude-tui', `expected type carried from step_start, got ${s.currentStep.type}`);
  assert(s.workflowDone === true, 'expected workflowDone true');
  assert(s.workflowName === 'muaddib', `expected workflowName muaddib, got ${s.workflowName}`);
  assert(s.failed === false, 'expected failed false');
  assert(s.eventCount === 5, `expected eventCount 5, got ${s.eventCount}`);
  assert(typeof s.lastEventTs === 'string', 'expected lastEventTs string');
}

async function testInFlightStep() {
  const W = BASE + 2;
  reset(W);

  emit(W, 'orchestrator', 'state_changed', { state: 'RUNNING' });
  emit(W, 'runner', 'step_start', { id: 'implement', type: 'claude-tui' });
  emit(W, 'runner', 'step_done', { id: 'implement' });
  emit(W, 'runner', 'step_start', { id: 'check', type: 'script' });
  // no step_done for 'check' — it's in flight

  const s = workerStatus(W);
  assert(s.currentStep && s.currentStep.id === 'check', `expected in-flight check, got ${JSON.stringify(s.currentStep)}`);
  assert(s.currentStep.running === true, 'in-flight step should be running:true');
  assert(s.currentStep.type === 'script', `expected type script, got ${s.currentStep.type}`);
  assert(s.workflowDone === false, 'expected workflowDone false');
}

async function testFailedFlag() {
  const Wa = BASE + 3;
  const Wb = BASE + 4;
  reset(Wa); reset(Wb);

  emit(Wa, 'check', 'failed', { exitCode: 1 });
  assert(workerStatus(Wa).failed === true, 'explicit failed event should set failed');

  emit(Wb, 'check', 'done', { exitCode: 3 });
  assert(workerStatus(Wb).failed === true, 'non-zero exitCode should set failed');

  const Wc = BASE + 5;
  reset(Wc);
  emit(Wc, 'check', 'done', { exitCode: 0 });
  assert(workerStatus(Wc).failed === false, 'exitCode 0 should not set failed');
}

async function testNoEventsFile() {
  const W = BASE + 6; // never emitted — no file on disk
  reset(W);

  const s = workerStatus(W);
  assert(s.eventCount === 0, `expected eventCount 0, got ${s.eventCount}`);
  assert(s.state === null, `expected null state, got ${s.state}`);
  assert(s.currentStep === null, 'expected null currentStep');
  assert(s.workflowDone === false && s.failed === false, 'expected clean flags');
  assert(s.lastEventTs === null, 'expected null lastEventTs');
}

async function testRecomputeNoCache() {
  const W = BASE + 7;
  reset(W);

  emit(W, 'orchestrator', 'state_changed', { state: 'RUNNING' });
  const before = workerStatus(W);
  assert(before.state === 'RUNNING' && before.eventCount === 1, 'first read wrong');

  emit(W, 'orchestrator', 'state_changed', { state: 'AWAITING_REVIEW' });
  const after = workerStatus(W);
  assert(after.state === 'AWAITING_REVIEW', `recompute should see new state, got ${after.state}`);
  assert(after.eventCount === 2, `recompute should see 2 events, got ${after.eventCount}`);
}

async function testMalformedSkipped() {
  const W = BASE + 8;
  reset(W);

  emit(W, 'orchestrator', 'state_changed', { state: 'RUNNING' });
  fs.appendFileSync(eventsFile(W), 'this is not json\n');
  emit(W, 'runner', 'step_start', { id: 'plan', type: 'claude-tui' });

  const s = workerStatus(W);
  assert(s.eventCount === 2, `malformed line should be skipped, got eventCount ${s.eventCount}`);
  assert(s.currentStep && s.currentStep.id === 'plan', 'valid events after garbage still parse');
}

async function testRunScoping() {
  // A reused worker index accumulates multiple runs in one never-truncated
  // events file. A prior run's terminal workflow_done must not latch over the
  // run now in progress.
  const W = BASE + 10;
  reset(W);

  // Run A — completes.
  emit(W, 'orchestrator', 'state_changed', { state: 'RUNNING' });
  emit(W, 'runner', 'step_start', { id: 'plan', type: 'claude-tui' });
  emit(W, 'runner', 'step_done', { id: 'plan' });
  emit(W, 'runner', 'workflow_done', { name: 'muaddib' });

  // Run B — same worker, new ticket, still in flight.
  emit(W, 'orchestrator', 'state_changed', { state: 'BOOTING' });
  emit(W, 'runner', 'step_start', { id: 'implement', type: 'claude-tui' });

  const s = workerStatus(W);
  assert(s.workflowDone === false, `run B in flight must not report prior workflow_done, got ${s.workflowDone}`);
  assert(s.state === 'BOOTING', `expected run B state BOOTING, got ${s.state}`);
  assert(s.currentStep && s.currentStep.id === 'implement' && s.currentStep.running === true,
    `expected in-flight run B step, got ${JSON.stringify(s.currentStep)}`);
}

async function testFailedResetOnRetry() {
  // A check fails then passes on retry within one run: the derived status must
  // reflect the latest outcome, not latch the earlier failure.
  const W = BASE + 11;
  reset(W);

  emit(W, 'check', 'failed', { exitCode: 1 });
  assert(workerStatus(W).failed === true, 'failing check should set failed');
  emit(W, 'check', 'done', { exitCode: 0 });
  assert(workerStatus(W).failed === false, 'passing check on retry should clear failed');
}

async function testCrashedStepFailed() {
  // A step that throws emits a `failed` event (runner.js) instead of step_done;
  // the worker must report failed rather than a clean, never-ending in-flight
  // step.
  const W = BASE + 12;
  reset(W);

  emit(W, 'orchestrator', 'state_changed', { state: 'RUNNING' });
  emit(W, 'runner', 'step_start', { id: 'implement', type: 'claude-tui' });
  emit(W, 'runner', 'failed', { id: 'implement', error: 'boom' });

  const s = workerStatus(W);
  assert(s.failed === true, 'a crashed step should surface failed=true');
}

async function testFleetStateLists() {
  // Fresh dir so listing is deterministic and not polluted by other tests.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-list-'));
  const prev = process.env.AGENT_STATUS_DIR;
  process.env.AGENT_STATUS_DIR = dir;
  try {
    emit(2, 'orchestrator', 'state_changed', { state: 'RUNNING' });
    emit(0, 'orchestrator', 'state_changed', { state: 'BOOTING' });
    // a non-matching file must be ignored by the enumerator
    fs.writeFileSync(path.join(dir, 'worker-0.state'), 'RUNNING\n');

    const snap = fleetState();
    assert(typeof snap.generatedAt === 'string', 'expected generatedAt');
    const workers = snap.workers.map((w) => w.worker);
    assert(workers.join(',') === '0,2', `expected sorted [0,2], got ${workers.join(',')}`);
  } finally {
    process.env.AGENT_STATUS_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testInspectCli() {
  const W = BASE + 9;
  reset(W);
  emit(W, 'orchestrator', 'state_changed', { state: 'RUNNING' });

  function cli(...args) {
    return new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [inspectCli, ...args], { env: process.env });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      p.on('exit', (code) => resolve({ code, out, err }));
      p.on('error', reject);
    });
  }

  const single = await cli(String(W));
  assert(single.code === 0, `single-worker exit ${single.code}: ${single.err}`);
  const parsedSingle = JSON.parse(single.out);
  assert(parsedSingle.worker === W && parsedSingle.state === 'RUNNING', `bad single output: ${single.out}`);

  const fleet = await cli();
  assert(fleet.code === 0, `fleet exit ${fleet.code}: ${fleet.err}`);
  const parsedFleet = JSON.parse(fleet.out);
  assert(Array.isArray(parsedFleet.workers), 'fleet output should have workers array');
  assert(parsedFleet.workers.some((w) => w.worker === W), 'fleet output should include our worker');

  const bad = await cli('not-a-number');
  assert(bad.code === 1, `bad arg should exit 1, got ${bad.code}`);
}

async function main() {
  const tests = [
    ['derives live status — state, completed step, flags', testDerivesLiveStatus],
    ['in-flight step — open step_start surfaces as running', testInFlightStep],
    ['failed flag — explicit failed and non-zero exitCode', testFailedFlag],
    ['no events file — empty status, no throw', testNoEventsFile],
    ['recompute — no caching across calls', testRecomputeNoCache],
    ['malformed lines skipped', testMalformedSkipped],
    ['run scoping — reused worker ignores prior run terminal state', testRunScoping],
    ['failed clears on a passing retry, not latched', testFailedResetOnRetry],
    ['crashed step surfaces failed via runner failed event', testCrashedStepFailed],
    ['fleetState — enumerates worker files, sorted', testFleetStateLists],
    ['inspect-cli.js — JSON out for fleet and single worker', testInspectCli],
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

  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log(`\n${passed}/${tests.length} passed`);
  if (passed < tests.length) process.exit(1);
}

main().catch((err) => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.error('FAIL —', err.message);
  process.exit(1);
});
