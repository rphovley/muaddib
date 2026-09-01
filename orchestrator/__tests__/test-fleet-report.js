#!/usr/bin/env node
'use strict';
// Fleet Report test suite (muaddib#25). Two layers, mirroring the split in
// fleet-report.js: the pure format* functions are exercised over fixture
// objects (no I/O — like test-notify-format), and the renderLive* / CLI path is
// exercised with the temp-AGENT_STATUS_DIR + emit() fixture style from
// test-fleet-state.
//
// testEmptyFleet          — a fleet with no workers renders the clear no-workers
//                           note under the header, not a bare header.
// testMixedFleet          — a mixed fleet (a running step, a workflow-done
//                           worker, a failed worker) folds into a header + the
//                           expected per-worker lines and flags.
// testSingleWorkerForm    — formatWorkerReport() renders one worker's line with
//                           its state, step, and event count.
// testStepAndFlagLabels   — stepLabel()/flagLabel() edge cases: no step, running
//                           vs last, workflow-complete and FAILED together.
// testRenderLiveNoCache   — renderLive* recomputes: appending an event and
//                           rendering again reflects the change (no cache).
// testInspectCliReport    — spawning inspect-cli.js --report prints the human
//                           report (parse-free) for the whole fleet and one
//                           worker, and JSON output is unchanged without the flag.

const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-report-test-'));
process.env.AGENT_STATUS_DIR = TMP_DIR;

const { emit, eventsFile } = require('../events');
const {
  stepLabel,
  flagLabel,
  formatWorkerReport,
  formatFleetReport,
  renderLiveFleetReport,
  renderLiveWorkerReport,
} = require('../fleet-report');
const inspectCli = path.join(__dirname, '../inspect-cli.js');

const BASE = 940;

function reset(worker) {
  try { fs.unlinkSync(eventsFile(worker)); } catch (_) {}
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function testEmptyFleet() {
  const out = formatFleetReport({ generatedAt: '2026-09-01T00:00:00.000Z', workers: [] });
  assert(/Fleet State — 2026-09-01T00:00:00\.000Z · 0 workers/.test(out), `bad header: ${out}`);
  assert(/No workers have emitted events yet\./.test(out), `expected empty note: ${out}`);
  // A missing/garbage state object must not throw — a formatter degrades.
  const bare = formatFleetReport(undefined);
  assert(/0 workers/.test(bare) && /No workers/.test(bare), `bare input should degrade: ${bare}`);
}

async function testMixedFleet() {
  const state = {
    generatedAt: '2026-09-01T12:00:00.000Z',
    workers: [
      {
        worker: 0, state: 'RUNNING',
        currentStep: { id: 'implement', type: 'claude-tui', running: true },
        workflowDone: false, workflowName: null, failed: false,
        eventCount: 4, lastEventTs: '2026-09-01T11:59:00.000Z',
      },
      {
        worker: 1, state: 'DONE',
        currentStep: { id: 'commit', type: 'script', running: false },
        workflowDone: true, workflowName: 'muaddib', failed: false,
        eventCount: 9, lastEventTs: '2026-09-01T11:58:00.000Z',
      },
      {
        worker: 2, state: 'RUNNING',
        currentStep: { id: 'check', type: 'script', running: false },
        workflowDone: false, workflowName: null, failed: true,
        eventCount: 6, lastEventTs: '2026-09-01T11:57:00.000Z',
      },
    ],
  };

  const out = formatFleetReport(state);
  const lines = out.split('\n');
  assert(/Fleet State — 2026-09-01T12:00:00\.000Z · 3 workers/.test(lines[0]), `bad header: ${lines[0]}`);
  assert(lines.length === 4, `expected header + 3 worker lines, got ${lines.length}`);

  const w0 = lines.find((l) => l.startsWith('worker 0'));
  assert(/RUNNING/.test(w0) && /implement \(running\)/.test(w0) && /4 events/.test(w0), `w0 line wrong: ${w0}`);

  const w1 = lines.find((l) => l.startsWith('worker 1'));
  assert(/commit \(last\)/.test(w1), `w1 should show last step: ${w1}`);
  assert(/workflow "muaddib" complete/.test(w1), `w1 should flag workflow complete: ${w1}`);
  assert(!/FAILED/.test(w1), `w1 should not be FAILED: ${w1}`);

  const w2 = lines.find((l) => l.startsWith('worker 2'));
  assert(/FAILED/.test(w2), `w2 should be FAILED: ${w2}`);

  // The three leading columns are padded to align — every worker line shares the
  // column offset at which its state begins.
  const stateCols = [w0, w1, w2].map((l) => l.indexOf('RUNNING') === -1 ? l.indexOf('DONE') : l.indexOf('RUNNING'));
  assert(new Set(stateCols).size === 1, `state column should align across lines, got ${stateCols}`);
}

async function testSingleWorkerForm() {
  const line = formatWorkerReport({
    worker: 7, state: 'BOOTING',
    currentStep: { id: 'plan', type: 'claude-tui', running: true },
    workflowDone: false, workflowName: null, failed: false,
    eventCount: 1, lastEventTs: '2026-09-01T10:00:00.000Z',
  });
  assert(/^worker 7/.test(line), `should start with worker 7: ${line}`);
  assert(/BOOTING/.test(line) && /plan \(running\)/.test(line), `single line wrong: ${line}`);
  assert(/1 event\b/.test(line) && !/1 events/.test(line), `event count should be singular: ${line}`);
}

async function testStepAndFlagLabels() {
  assert(stepLabel(null) === 'no step', 'null step should be "no step"');
  assert(stepLabel({ type: 'x', running: true }) === 'x (running)', 'running label wrong');
  assert(stepLabel({ type: 'x', running: false }) === 'x (last)', 'last label wrong');
  assert(stepLabel({ id: 'only-id', type: null, running: true }) === 'only-id (running)', 'type should fall back to id');

  assert(flagLabel({ workflowDone: false, failed: false }) === '', 'no flags → empty');
  assert(flagLabel({ workflowDone: true, workflowName: 'muaddib', failed: false }) === 'workflow "muaddib" complete',
    'workflow-complete flag wrong');
  const both = flagLabel({ workflowDone: true, workflowName: 'wf', failed: true });
  assert(/workflow "wf" complete/.test(both) && /FAILED/.test(both), `both flags should show: ${both}`);
}

async function testRenderLiveNoCache() {
  const W = BASE + 1;
  reset(W);
  emit(W, 'orchestrator', 'state_changed', { state: 'RUNNING' });

  const before = renderLiveWorkerReport(W);
  assert(/RUNNING/.test(before) && /1 event\b/.test(before), `first render wrong: ${before}`);

  emit(W, 'orchestrator', 'state_changed', { state: 'AWAITING_REVIEW' });
  const after = renderLiveWorkerReport(W);
  assert(/AWAITING_REVIEW/.test(after), `recompute should see new state: ${after}`);
  assert(/2 events/.test(after), `recompute should see 2 events: ${after}`);

  // The fleet render is live too and includes this worker.
  const fleet = renderLiveFleetReport();
  assert(new RegExp(`worker ${W}`).test(fleet), `fleet report should include worker ${W}: ${fleet}`);
}

async function testInspectCliReport() {
  const W = BASE + 2;
  reset(W);
  emit(W, 'orchestrator', 'state_changed', { state: 'RUNNING' });
  emit(W, 'runner', 'step_start', { id: 'implement', type: 'claude-tui' });

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

  // Single-worker report — human-readable, not JSON.
  const single = await cli('--report', String(W));
  assert(single.code === 0, `--report single exit ${single.code}: ${single.err}`);
  assert(/^worker /.test(single.out), `--report should be human-readable, got: ${single.out}`);
  assert(/RUNNING/.test(single.out) && /implement \(running\)/.test(single.out), `bad report body: ${single.out}`);
  let jsonParsed = false;
  try { JSON.parse(single.out); jsonParsed = true; } catch (_) {}
  assert(!jsonParsed, `--report output should not be JSON: ${single.out}`);

  // Whole-fleet report via the short flag.
  const fleet = await cli('-r');
  assert(fleet.code === 0, `-r fleet exit ${fleet.code}: ${fleet.err}`);
  assert(/Fleet State — /.test(fleet.out), `-r should print the fleet header: ${fleet.out}`);
  assert(new RegExp(`worker ${W}`).test(fleet.out), `-r should include worker ${W}: ${fleet.out}`);

  // Without the flag, output is unchanged (still JSON) — backward compatible.
  const json = await cli(String(W));
  assert(json.code === 0, `json single exit ${json.code}: ${json.err}`);
  const parsed = JSON.parse(json.out);
  assert(parsed.worker === W && parsed.state === 'RUNNING', `default form should stay JSON: ${json.out}`);
}

async function main() {
  const tests = [
    ['empty fleet — clear no-workers note', testEmptyFleet],
    ['mixed fleet — header, per-worker lines, aligned columns, flags', testMixedFleet],
    ['single-worker form — one line with state/step/count', testSingleWorkerForm],
    ['stepLabel / flagLabel edge cases', testStepAndFlagLabels],
    ['renderLive* — recompute, no cache', testRenderLiveNoCache],
    ['inspect-cli.js --report — human output; JSON unchanged without flag', testInspectCliReport],
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
