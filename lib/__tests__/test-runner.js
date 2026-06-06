#!/usr/bin/env node
'use strict';
// Runner test suite.
//
// Tests use workflow definitions that mirror the real feature/bug shapes so the
// runner is exercised against realistic definition structure, not minimal stubs.
//
// No-tmux tests (pure script steps):
//   testEvaluateCondition — expression evaluation edge cases
//   testRunIfSkips        — step with runIf=false is skipped, workflow continues
//   testLoopExitsOnCond   — loop exits when exitCondition becomes true
//   testLoopMaxIterations — loop throws after maxIterations with no exit cond
//   testNotifyNonBlock    — notify event fires notify.sh without blocking
//
// Requires tmux:
//   testFeatureWorkflow   — full gather-context→implement→quality-loop→wrapup
//                           shape using MOCK_JOBS=1 with mockStateWrites
//   testBugWorkflow       — shorter gather-context-bug→implement-bug→wrapup
//                           shape; no preview env steps

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-'));
process.env.STATE_DIR        = TMP_DIR;
process.env.AGENT_STATUS_DIR = TMP_DIR;
process.env.MOCK_JOBS        = '1';
process.env.REPO_DIR         = path.join(__dirname, '../../..');

const { run, evaluateCondition } = require('../runner');
const stateModule = require('../state');

const MUADDIB_DIR = path.join(process.env.REPO_DIR, 'muaddib');
const STATE_CLI   = path.join(__dirname, '../state-cli.js');
const EMIT_CLI    = path.join(__dirname, '../emit-cli.js');

const BASE = 970;

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

function hasTmux() {
  return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
}

// Write a bash script under TMP_DIR and return its path relative to MUADDIB_DIR
// (because runner does path.join(REPO, 'muaddib', step.script)).
function mkScript(name, body) {
  const abs = path.join(TMP_DIR, `${name}.sh`);
  fs.writeFileSync(abs, `#!/usr/bin/env bash\nset -e\n${body}\n`);
  fs.chmodSync(abs, 0o755);
  return path.relative(MUADDIB_DIR, abs);
}

function mkWorkflow(name, workflow) {
  const p = path.join(TMP_DIR, `${name}.json`);
  fs.writeFileSync(p, JSON.stringify({ name, services: [], workflow }, null, 2));
  return p;
}

function stateSet(worker, key, val) { stateModule.set(worker, key, val); }
function stateGet(worker, key)      { return stateModule.get(worker, key); }
function stateRead(worker)          { return stateModule.read(worker); }

// Ensure a fresh tmux session for tests that need it.
function ensureTmuxSession(worker) {
  const sess = `w${worker}`;
  spawnSync('tmux', ['kill-session', '-t', sess], { stdio: 'ignore' });
  const r = spawnSync('tmux', ['new-session', '-d', '-s', sess], { stdio: 'ignore' });
  if (r.status !== 0) throw new Error(`could not create tmux session ${sess}`);
}

function killTmuxSession(worker) {
  spawnSync('tmux', ['kill-session', '-t', `w${worker}`], { stdio: 'ignore' });
}

// ─── testEvaluateCondition ────────────────────────────────────────────────────

async function testEvaluateCondition() {
  const cases = [
    ["state.x === 'ok'",       { x: 'ok' },   true],
    ["state.x === 'ok'",       { x: 'no' },   false],
    ['state.n > 2',            { n: 3 },       true],
    ['state.n > 2',            { n: 1 },       false],
    ["state.missing === true", {},              false],
    ['bad syntax ===',         {},              false], // parse error → false
    ['true',                   {},              true],
    ['false',                  {},              false],
  ];
  for (const [expr, s, expected] of cases) {
    const got = evaluateCondition(expr, s);
    if (got !== expected) {
      throw new Error(
        `evaluateCondition(${JSON.stringify(expr)}) with state ${JSON.stringify(s)}: got ${got}, want ${expected}`,
      );
    }
  }
}

// ─── testRunIfSkips ───────────────────────────────────────────────────────────
// Workflow: gather-context → implement (skipped, runIf unmet) → wrapup
// Verifies that the skipped step does not execute and the workflow continues.

async function testRunIfSkips() {
  const W = BASE + 1;

  const gatherScript = mkScript(`w${W}-gather`, `
node '${STATE_CLI}' ${W} set branch quo-999-feature
node '${STATE_CLI}' ${W} set ticket_url https://linear.app/test
`);
  // implement has runIf that evaluates to false (no skip_impl set)
  const implementScript = mkScript(`w${W}-implement`,
    `node '${STATE_CLI}' ${W} set implement_ran true`,
  );
  const wrapupScript = mkScript(`w${W}-wrapup`, `
node '${STATE_CLI}' ${W} set pr_number 42
`);

  const wf = mkWorkflow(`w${W}-runif`, [
    { id: 'gather-context', type: 'script', script: gatherScript, stateWrites: ['branch', 'ticket_url'] },
    { id: 'implement',      type: 'script', script: implementScript, runIf: "state.skip_impl === 'true'" },
    { id: 'wrapup',         type: 'script', script: wrapupScript, stateWrites: ['pr_number'] },
  ]);

  await run(W, wf, 'QUO-999');

  const s = stateRead(W);
  if (s.branch !== 'quo-999-feature') throw new Error(`branch = ${s.branch}`);
  if (s.ticket_url !== 'https://linear.app/test') throw new Error('ticket_url missing');
  if (s.implement_ran !== undefined) throw new Error('implement ran but should have been skipped');
  if (s.pr_number !== '42') throw new Error(`pr_number = ${s.pr_number}`);
}

// ─── testLoopExitsOnCond ──────────────────────────────────────────────────────
// Workflow: gather-context → quality-loop (checks+review) → wrapup
// The review step approves after the second iteration; loop must exit then.

async function testLoopExitsOnCond() {
  const W = BASE + 2;

  const gatherScript = mkScript(`w${W}-gather`,
    `node '${STATE_CLI}' ${W} set branch quo-999-feature`,
  );
  // run-checks: always passes
  const checksScript = mkScript(`w${W}-checks`,
    `node '${STATE_CLI}' ${W} set check_status pass`,
  );
  // review: fails first time, passes second
  const reviewScript = mkScript(`w${W}-review`, `
count=$(node '${STATE_CLI}' ${W} get review_iter || echo 0)
count=$((count + 1))
node '${STATE_CLI}' ${W} set review_iter "$count"
if [ "$count" -ge 2 ]; then
  node '${STATE_CLI}' ${W} set review_status approved
else
  node '${STATE_CLI}' ${W} set review_status needs_fix
fi
`);
  const fixScript = mkScript(`w${W}-fix`,
    `node '${STATE_CLI}' ${W} set fix_ran true`,
  );
  const wrapupScript = mkScript(`w${W}-wrapup`,
    `node '${STATE_CLI}' ${W} set pr_number 55`,
  );

  const wf = mkWorkflow(`w${W}-loop`, [
    { id: 'gather-context', type: 'script', script: gatherScript },
    {
      id:            'quality-loop',
      type:          'loop',
      maxIterations: 5,
      exitCondition: "state.review_status === 'approved'",
      jobs: [
        { id: 'checks', type: 'script', script: checksScript, stateWrites: ['check_status'] },
        { id: 'review', type: 'script', script: reviewScript, runIf: "state.check_status === 'pass'", stateWrites: ['review_status'] },
        { id: 'fix',    type: 'script', script: fixScript,    runIf: "state.review_status === 'needs_fix'" },
      ],
    },
    { id: 'wrapup', type: 'script', script: wrapupScript, stateWrites: ['pr_number'] },
  ]);

  await run(W, wf, 'QUO-999');

  const s = stateRead(W);
  if (s.review_status !== 'approved') throw new Error(`review_status = ${s.review_status}`);
  if (Number(s.review_iter) !== 2)    throw new Error(`review_iter = ${s.review_iter}, want 2`);
  if (s.fix_ran !== 'true')           throw new Error('fix should have run on first iteration');
  if (s.pr_number !== '55')           throw new Error(`pr_number = ${s.pr_number}`);
}

// ─── testLoopMaxIterations ────────────────────────────────────────────────────
// Workflow: quality-loop with exitCondition that never becomes true.
// run() must reject after maxIterations.

async function testLoopMaxIterations() {
  const W = BASE + 3;

  const checksScript = mkScript(`w${W}-checks`,
    `node '${STATE_CLI}' ${W} set check_status fail`,
  );
  const reviewScript = mkScript(`w${W}-review`,
    `node '${STATE_CLI}' ${W} set review_status needs_fix`,
  );

  const wf = mkWorkflow(`w${W}-maxiter`, [{
    id:            'quality-loop',
    type:          'loop',
    maxIterations: 3,
    exitCondition: "state.review_status === 'approved'",
    jobs: [
      { id: 'checks', type: 'script', script: checksScript },
      { id: 'review', type: 'script', script: reviewScript, runIf: "state.check_status === 'pass'" },
    ],
  }]);

  let threw = false;
  try {
    await run(W, wf, '');
  } catch (err) {
    if (!err.message.includes('exhausted')) throw new Error(`wrong error: ${err.message}`);
    threw = true;
  }
  if (!threw) throw new Error('expected run() to throw after maxIterations');

  // review never ran (check_status=fail → runIf false), but loop still exhausted
  const s = stateRead(W);
  if (s.check_status !== 'fail') throw new Error(`check_status = ${s.check_status}`);
}

// ─── testNotifyNonBlock ───────────────────────────────────────────────────────
// Workflow: step-a emits a notify event, step-b runs after.
// Both must complete, and notify.sh must have been called.

async function testNotifyNonBlock() {
  const W = BASE + 4;

  // Stub notify.sh — writes a flag file we can check.
  const notifyFlag   = path.join(TMP_DIR, `notify-fired-${W}`);
  const notifyScript = path.join(MUADDIB_DIR, 'notify.sh');
  const hadNotify    = fs.existsSync(notifyScript);
  const savedNotify  = hadNotify ? fs.readFileSync(notifyScript) : null;
  fs.writeFileSync(notifyScript, `#!/usr/bin/env bash\ntouch '${notifyFlag}'\n`);
  fs.chmodSync(notifyScript, 0o755);

  try {
    const stepA = mkScript(`w${W}-step-a`, `
node '${EMIT_CLI}' ${W} step-a notify '{"msg":"preview ready"}'
node '${STATE_CLI}' ${W} set step_a done
`);
    const stepB = mkScript(`w${W}-step-b`,
      `node '${STATE_CLI}' ${W} set step_b done`,
    );

    const wf = mkWorkflow(`w${W}-notify`, [
      { id: 'step-a', type: 'script', script: stepA },
      { id: 'step-b', type: 'script', script: stepB },
    ]);

    await run(W, wf, '');

    const s = stateRead(W);
    if (s.step_a !== 'done') throw new Error('step-a did not run');
    if (s.step_b !== 'done') throw new Error('workflow blocked — step-b did not run');

    // notify.sh spawned detached; give it a moment to execute.
    await wait(400);
    if (!fs.existsSync(notifyFlag)) throw new Error('notify.sh was not called');
  } finally {
    if (savedNotify) fs.writeFileSync(notifyScript, savedNotify);
    else try { fs.unlinkSync(notifyScript); } catch (_) {}
  }
}

// ─── testFeatureWorkflow ──────────────────────────────────────────────────────
// Full feature workflow shape: gather-context → implement → quality-loop
// (checks+review+fix) → wrapup. Uses MOCK_JOBS=1 with mockStateWrites to
// simulate what each Claude skill would write to state.

async function testFeatureWorkflow() {
  if (!hasTmux()) { console.log('    (skipped — tmux not available)'); return; }

  const W = BASE + 5;
  ensureTmuxSession(W);
  try {
    const checksScript = mkScript(`w${W}-checks`, `
node '${STATE_CLI}' ${W} set check_status pass
`);

    const wf = mkWorkflow(`w${W}-feature`, [
      {
        id:              'gather-context',
        type:            'claude-tui',
        skill:           'gather-context',
        mockStateWrites: [['branch', 'quo-999-feature'], ['ticket_url', 'https://linear.app/test']],
        stateWrites:     ['branch', 'ticket_url'],
      },
      {
        id:              'implement',
        type:            'claude-tui',
        skill:           'implement',
        stateReads:      ['branch'],
        mockStateWrites: [], // just exits 0 — code changes live in git
      },
      {
        id:            'quality-loop',
        type:          'loop',
        maxIterations: 5,
        exitCondition: "state.review_status === 'approved'",
        jobs: [
          {
            id:     'checks',
            type:   'script',
            script: checksScript,
            stateWrites: ['check_status'],
          },
          {
            id:              'review',
            type:            'claude-tui',
            skill:           'review-fleet',
            runIf:           "state.check_status === 'pass'",
            mockStateWrites: [['review_status', 'approved']],
            stateWrites:     ['review_status'],
          },
          {
            id:              'fix',
            type:            'claude-tui',
            skill:           'implement',
            runIf:           "state.review_status === 'needs_fix'",
            mockStateWrites: [],
          },
        ],
      },
      {
        id:              'wrapup',
        type:            'claude-tui',
        skill:           'commit-and-pr',
        stateReads:      ['branch', 'ticket_url'],
        mockStateWrites: [['pr_number', '101']],
        stateWrites:     ['pr_number'],
      },
    ]);

    await run(W, wf, 'QUO-999');

    const s = stateRead(W);
    if (s.branch      !== 'quo-999-feature')      throw new Error(`branch = ${s.branch}`);
    if (s.ticket_url  !== 'https://linear.app/test') throw new Error('ticket_url wrong');
    if (s.check_status !== 'pass')                throw new Error(`check_status = ${s.check_status}`);
    if (s.review_status !== 'approved')           throw new Error(`review_status = ${s.review_status}`);
    if (s.pr_number   !== '101')                  throw new Error(`pr_number = ${s.pr_number}`);
  } finally {
    killTmuxSession(W);
  }
}

// ─── testBugWorkflow ──────────────────────────────────────────────────────────
// Bug workflow shape: gather-context-bug → implement-bug → quality-loop
// (checks+review+fix) → wrapup. No preview env, no servers step.

async function testBugWorkflow() {
  if (!hasTmux()) { console.log('    (skipped — tmux not available)'); return; }

  const W = BASE + 6;
  ensureTmuxSession(W);
  try {
    const checksScript = mkScript(`w${W}-checks`,
      `node '${STATE_CLI}' ${W} set check_status pass`,
    );

    const wf = mkWorkflow(`w${W}-bug`, [
      {
        id:              'gather-context-bug',
        type:            'claude-tui',
        skill:           'gather-context-bug',
        mockStateWrites: [['branch', 'quo-999-bugfix'], ['ticket_url', 'https://linear.app/bug']],
        stateWrites:     ['branch', 'ticket_url'],
      },
      {
        id:              'implement-bug',
        type:            'claude-tui',
        skill:           'implement-bug',
        stateReads:      ['branch'],
        mockStateWrites: [],
      },
      {
        id:            'quality-loop',
        type:          'loop',
        maxIterations: 5,
        exitCondition: "state.review_status === 'approved'",
        jobs: [
          {
            id:          'checks',
            type:        'script',
            script:      checksScript,
            stateWrites: ['check_status'],
          },
          {
            id:              'review',
            type:            'claude-tui',
            skill:           'review-fleet',
            runIf:           "state.check_status === 'pass'",
            mockStateWrites: [['review_status', 'approved']],
            stateWrites:     ['review_status'],
          },
          {
            id:              'fix',
            type:            'claude-tui',
            skill:           'implement-bug',
            runIf:           "state.review_status === 'needs_fix'",
            mockStateWrites: [],
          },
        ],
      },
      {
        id:              'wrapup',
        type:            'claude-tui',
        skill:           'commit-and-pr',
        stateReads:      ['branch', 'ticket_url'],
        mockStateWrites: [['pr_number', '202']],
        stateWrites:     ['pr_number'],
      },
    ]);

    await run(W, wf, 'QUO-999');

    const s = stateRead(W);
    if (s.branch        !== 'quo-999-bugfix')        throw new Error(`branch = ${s.branch}`);
    if (s.review_status !== 'approved')              throw new Error(`review_status = ${s.review_status}`);
    if (s.pr_number     !== '202')                   throw new Error(`pr_number = ${s.pr_number}`);
  } finally {
    killTmuxSession(W);
  }
}

// ─── runner ──────────────────────────────────────────────────────────────────

async function main() {
  const tests = [
    ['evaluateCondition — expression variants',          testEvaluateCondition],
    ['runIf=false skips step, workflow continues',       testRunIfSkips],
    ['loop exits when exitCondition met',                testLoopExitsOnCond],
    ['loop throws after maxIterations',                  testLoopMaxIterations],
    ['notify fires without blocking workflow',           testNotifyNonBlock],
    ['feature workflow — full gather→implement→loop→wrapup (tmux)', testFeatureWorkflow],
    ['bug workflow — gather-bug→implement-bug→loop→wrapup (tmux)',  testBugWorkflow],
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
