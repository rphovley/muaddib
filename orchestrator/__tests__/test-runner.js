#!/usr/bin/env node
'use strict';
// Runner test suite.
//
// Tests use workflow definitions that mirror the real feature/bug shapes so the
// runner is exercised against realistic definition structure, not minimal stubs.
//
// No-tmux tests (pure script steps):
//   testEvaluateCondition       — expression evaluation edge cases
//   testRunIfSkips              — step with runIf=false is skipped, workflow continues
//   testLoopExitsOnCond         — loop exits when exitCondition becomes true
//   testLoopMaxIterations       — loop throws after maxIterations with no exit cond
//   testNotifyNonBlock          — notify event fires notify.sh without blocking
//   testSketchReviewWorkflow    — plan.json's sketch/sketch-review-loop/sketch-finalize
//                                 shape: poll (feedback then ended) → feedback applied
//                                 once → finalize runs once. Same loop/runIf primitives
//                                 as quality-loop — sketch has no bespoke orchestrator
//                                 state machine to test separately.
//   testSketchSkippedWhenNotNeeded — needs_sketch=false skips sketch/loop/finalize
//                                    entirely (analyze-ticket sets it unconditionally
//                                    across feature/bug/plan)
//   testSketchLoopExhaustionNeverFinalizes — loop that never reaches
//                                    sketch_status=ended must fail the workflow,
//                                    never silently run sketch-finalize
//   testSketchLoopStaleStateStillPolls — a stale sketch_status='ended' present
//                                    before the loop starts must not skip the
//                                    first real poll (minIterations:1)
//
// Requires tmux:
//   testFeatureWorkflow   — full gather-context→implement→quality-loop→wrapup
//                           shape using MOCK_JOBS=1 with mockStateWrites
//   testBugWorkflow       — shorter gather-context-bug→implement-bug→wrapup
//                           shape; no preview env steps
//   testAwaitsReviewSetsStatus — claude-tui step with awaitsReview:true sets
//                                the coarse status to AWAITING_REVIEW while it
//                                runs, reverts to RUNNING once it settles
//   testNudgeRecoversIdleStep  — GH #87: an idle claude-tui step that never
//                                touches its sentinel gets the "run the touch"
//                                recovery typed into its pane (and recovers);
//                                a self-completing step is never nudged

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-'));
process.env.STATE_DIR        = TMP_DIR;
process.env.AGENT_STATUS_DIR = TMP_DIR;
process.env.MOCK_JOBS        = '1';

// __tests__ -> orchestrator -> muaddib's own root: always exactly 2 levels
// up regardless of whether muaddib is nested under a consuming project or
// is itself the repo (self-hosting). Feeding this straight into REPO_DIR
// works either way, since runner.js's own resolveMuaddibRoot() is a no-op
// when it's already given the muaddib root directly (muaddib never nests
// itself) — no need to re-derive "3 levels up to escape the nesting" here,
// which only worked for the nested case and silently broke self-hosting
// (hung the whole suite: notify.sh got written to a path under a directory
// that was never created, and later mkScript()'s path.relative() assumed
// the same wrong root).
const MUADDIB_DIR = path.join(__dirname, '../..');
process.env.REPO_DIR = MUADDIB_DIR;

const { run, evaluateCondition, waitForJobCompletion } = require('../runner');
const { startJob, nudgeIdleStep } = require('../job');
const stateModule = require('../state');
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
      steps: [
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
    steps: [
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

// ─── testSketchReviewWorkflow ─────────────────────────────────────────────────
// Mirrors plan.json's sketch / sketch-review-loop / sketch-finalize shape:
// sketch writes sketch_file; the loop polls (feedback first round, ended
// second) and applies feedback exactly once; finalize runs once after the
// loop exits. GH issue #5: sketch's review loop used to be a bespoke
// imperative state machine in orchestrator.js with no test coverage — it's
// now just another declarative loop/runIf shape, exercised the same way
// testLoopExitsOnCond exercises quality-loop.

async function testSketchReviewWorkflow() {
  const W = BASE + 8;

  const sketchScript = mkScript(`w${W}-sketch`,
    `node '${STATE_CLI}' ${W} set sketch_file /tmp/w${W}-sketch.html`,
  );
  // poll: feedback on the first round, ended on the second
  const pollScript = mkScript(`w${W}-poll`, `
count=$(node '${STATE_CLI}' ${W} get poll_iter || echo 0)
count=$((count + 1))
node '${STATE_CLI}' ${W} set poll_iter "$count"
if [ "$count" -ge 2 ]; then
  node '${STATE_CLI}' ${W} set sketch_status ended
else
  node '${STATE_CLI}' ${W} set sketch_status feedback
fi
`);
  const feedbackScript = mkScript(`w${W}-feedback`,
    `node '${STATE_CLI}' ${W} set feedback_ran true`,
  );
  const finalizeScript = mkScript(`w${W}-finalize`,
    `node '${STATE_CLI}' ${W} set finalize_ran true`,
  );

  const wf = mkWorkflow(`w${W}-plan`, [
    { id: 'sketch', type: 'script', script: sketchScript, runIf: "state.needs_sketch === 'true'", stateWrites: ['sketch_file'] },
    {
      id:            'sketch-review-loop',
      type:          'loop',
      runIf:         "state.needs_sketch === 'true'",
      maxIterations: 50,
      exitCondition: "state.sketch_status === 'ended'",
      steps: [
        { id: 'sketch-poll',     type: 'script', script: pollScript,     stateWrites: ['sketch_status'] },
        { id: 'sketch-feedback', type: 'script', script: feedbackScript, runIf: "state.sketch_status === 'feedback'" },
      ],
    },
    { id: 'sketch-finalize', type: 'script', script: finalizeScript, runIf: "state.needs_sketch === 'true' && state.sketch_status === 'ended'" },
  ]);

  stateSet(W, 'needs_sketch', 'true');
  await run(W, wf, 'QUO-999');

  const s = stateRead(W);
  if (s.sketch_file !== `/tmp/w${W}-sketch.html`) throw new Error(`sketch_file = ${s.sketch_file}`);
  if (Number(s.poll_iter) !== 2)   throw new Error(`poll_iter = ${s.poll_iter}, want 2`);
  if (s.feedback_ran !== 'true')   throw new Error('sketch-feedback should have run on the first poll round');
  if (s.sketch_status !== 'ended') throw new Error(`sketch_status = ${s.sketch_status}`);
  if (s.finalize_ran !== 'true')   throw new Error('sketch-finalize should have run after the loop exited');
}

// ─── testSketchSkippedWhenNotNeeded ───────────────────────────────────────────
// needs_sketch !== 'true' must skip sketch / sketch-review-loop / sketch-finalize
// entirely — analyze-ticket sets needs_sketch unconditionally across
// feature/bug/plan, so a workflow that doesn't declare these steps (or a plan
// run where the ticket didn't need one) must never touch them.

async function testSketchSkippedWhenNotNeeded() {
  const W = BASE + 9;

  const sketchScript = mkScript(`w${W}-sketch`,
    `node '${STATE_CLI}' ${W} set sketch_file /tmp/w${W}-sketch.html`,
  );
  const pollScript = mkScript(`w${W}-poll`,
    `node '${STATE_CLI}' ${W} set sketch_status ended`,
  );
  const finalizeScript = mkScript(`w${W}-finalize`,
    `node '${STATE_CLI}' ${W} set finalize_ran true`,
  );

  const wf = mkWorkflow(`w${W}-plan-noskatch`, [
    { id: 'sketch', type: 'script', script: sketchScript, runIf: "state.needs_sketch === 'true'" },
    {
      id:            'sketch-review-loop',
      type:          'loop',
      runIf:         "state.needs_sketch === 'true'",
      maxIterations: 50,
      exitCondition: "state.sketch_status === 'ended'",
      steps: [{ id: 'sketch-poll', type: 'script', script: pollScript }],
    },
    { id: 'sketch-finalize', type: 'script', script: finalizeScript, runIf: "state.needs_sketch === 'true' && state.sketch_status === 'ended'" },
  ]);

  stateSet(W, 'needs_sketch', 'false');
  await run(W, wf, 'QUO-999');

  const s = stateRead(W);
  if (s.sketch_file !== undefined)   throw new Error('sketch step ran but needs_sketch was false');
  if (s.sketch_status !== undefined) throw new Error('sketch-review-loop ran but needs_sketch was false');
  if (s.finalize_ran !== undefined)  throw new Error('sketch-finalize ran but needs_sketch was false');
}

// ─── testSketchLoopExhaustionNeverFinalizes ────────────────────────────────────
// Regression test for a bug caught in review: if sketch_status never reaches
// 'ended' within maxIterations, the workflow must fail (not silently move on
// to sketch-finalize and post an unapproved sketch to Linear as if the
// operator had signed off). sketch-poll here always reports 'feedback', so
// the loop can never exit cleanly.

async function testSketchLoopExhaustionNeverFinalizes() {
  const W = BASE + 14;

  const pollScript = mkScript(`w${W}-poll`,
    `node '${STATE_CLI}' ${W} set sketch_status feedback`,
  );
  const feedbackScript = mkScript(`w${W}-feedback`,
    `node '${STATE_CLI}' ${W} set feedback_ran true`,
  );
  const finalizeScript = mkScript(`w${W}-finalize`,
    `node '${STATE_CLI}' ${W} set finalize_ran true`,
  );

  const wf = mkWorkflow(`w${W}-plan-neverends`, [
    {
      id:            'sketch-review-loop',
      type:          'loop',
      maxIterations: 3,
      exitCondition: "state.sketch_status === 'ended'",
      steps: [
        { id: 'sketch-poll',     type: 'script', script: pollScript,     stateWrites: ['sketch_status'] },
        { id: 'sketch-feedback', type: 'script', script: feedbackScript, runIf: "state.sketch_status === 'feedback'" },
      ],
    },
    { id: 'sketch-finalize', type: 'script', script: finalizeScript, runIf: "state.sketch_status === 'ended'" },
  ]);

  let threw = false;
  try {
    await run(W, wf, 'QUO-999');
  } catch (err) {
    if (!err.message.includes('exhausted')) throw new Error(`wrong error: ${err.message}`);
    threw = true;
  }
  if (!threw) throw new Error('expected run() to throw when the review loop never reaches ended');

  const s = stateRead(W);
  if (s.finalize_ran !== undefined) {
    throw new Error('sketch-finalize ran despite the loop never reaching sketch_status=ended — would have posted an unapproved sketch to Linear');
  }
}

// ─── testSketchLoopStaleStateStillPolls ────────────────────────────────────────
// Regression test for a review-caught bug: sketch-review-loop had no
// minIterations, so a stale sketch_status='ended' already present in state
// before the loop starts (e.g. a container/worker reused across runs) would
// satisfy exitCondition at iteration 0 and exit WITHOUT ever running
// sketch-poll — letting sketch-finalize post a never-actually-reviewed
// prototype as if approved. minIterations:1 (matching quality-loop's existing
// convention in feature.json/bug.json) forces at least one real poll first.

async function testSketchLoopStaleStateStillPolls() {
  const W = BASE + 15;

  const pollScript = mkScript(`w${W}-poll`,
    `node '${STATE_CLI}' ${W} set poll_ran true`,
  );

  const wf = mkWorkflow(`w${W}-stale`, [{
    id:            'sketch-review-loop',
    type:          'loop',
    minIterations: 1,
    maxIterations: 5,
    exitCondition: "state.sketch_status === 'ended'",
    steps: [{ id: 'sketch-poll', type: 'script', script: pollScript }],
  }]);

  // Simulate a stale 'ended' value already present before the loop runs.
  stateSet(W, 'sketch_status', 'ended');
  await run(W, wf, 'QUO-999');

  const s = stateRead(W);
  if (s.poll_ran !== 'true') throw new Error('sketch-poll never ran despite minIterations:1 — stale state let the loop skip it entirely');
}

// ─── testScriptArgsPassed ──────────────────────────────────────────────────────
// A script step's `args` array is forwarded to the script as CLI argv — the
// mechanism plan.json uses to run size-and-schedule.js with --propose / --commit
// off the one script.

async function testScriptArgsPassed() {
  const W = BASE + 17;

  const argScript = mkScript(`w${W}-argstep`, `
node '${STATE_CLI}' ${W} set arg1 "$1"
node '${STATE_CLI}' ${W} set arg2 "$2"
`);

  const wf = mkWorkflow(`w${W}-args`, [
    { id: 'argstep', type: 'script', script: argScript, args: ['--propose', 'extra'] },
  ]);

  await run(W, wf, 'QUO-999');

  const s = stateRead(W);
  if (s.arg1 !== '--propose') throw new Error(`arg1 = ${s.arg1}, want --propose`);
  if (s.arg2 !== 'extra')     throw new Error(`arg2 = ${s.arg2}, want extra`);
}

// ─── testSizingReviewWorkflow ──────────────────────────────────────────────────
// Mirrors plan.json's size-and-schedule-propose → sizing-review-loop
// (confirm-sizing + adjust-sizing) → size-and-schedule-commit shape:
// propose recommends a split; the loop confirms (round 1 → adjust, round 2 →
// dispatch); adjust applies exactly once; commit runs after the loop exits and
// sees the confirmed choice. Same loop/runIf primitives as sketch-review-loop.

async function testSizingReviewWorkflow() {
  const W = BASE + 18;

  const proposeScript = mkScript(`w${W}-propose`,
    `node '${STATE_CLI}' ${W} set recommend_split true`,
  );
  // confirm: clears stale choice each round (like the real skill), then adjust on
  // the first round, dispatch on the second.
  const confirmScript = mkScript(`w${W}-confirm`, `
node '${STATE_CLI}' ${W} unset sizing_confirm
count=$(node '${STATE_CLI}' ${W} get confirm_iter || echo 0)
count=$((count + 1))
node '${STATE_CLI}' ${W} set confirm_iter "$count"
if [ "$count" -ge 2 ]; then
  node '${STATE_CLI}' ${W} set sizing_confirm dispatch
else
  node '${STATE_CLI}' ${W} set sizing_confirm adjust
fi
`);
  const adjustScript = mkScript(`w${W}-adjust`,
    `node '${STATE_CLI}' ${W} set adjust_ran true`,
  );
  const commitScript = mkScript(`w${W}-commit`, `
node '${STATE_CLI}' ${W} set commit_ran true
node '${STATE_CLI}' ${W} set committed_choice "$(node '${STATE_CLI}' ${W} get sizing_confirm)"
`);

  const wf = mkWorkflow(`w${W}-sizing`, [
    { id: 'size-and-schedule-propose', type: 'script', script: proposeScript, args: ['--propose'], stateWrites: ['recommend_split'] },
    {
      id:            'sizing-review-loop',
      type:          'loop',
      runIf:         "state.recommend_split === 'true'",
      minIterations: 1,
      maxIterations: 200,
      exitCondition: "state.sizing_confirm === 'dispatch' || state.sizing_confirm === 'tickets_only'",
      steps: [
        { id: 'confirm-sizing', type: 'script', script: confirmScript, stateWrites: ['sizing_confirm'] },
        { id: 'adjust-sizing',  type: 'script', script: adjustScript,  runIf: "state.sizing_confirm === 'adjust'" },
      ],
    },
    { id: 'size-and-schedule-commit', type: 'script', script: commitScript, args: ['--commit'], runIf: "state.recommend_split === 'true'" },
  ]);

  await run(W, wf, 'QUO-999');

  const s = stateRead(W);
  if (Number(s.confirm_iter) !== 2)      throw new Error(`confirm_iter = ${s.confirm_iter}, want 2`);
  if (s.adjust_ran !== 'true')           throw new Error('adjust-sizing should have run on the first confirm round');
  if (s.sizing_confirm !== 'dispatch')   throw new Error(`sizing_confirm = ${s.sizing_confirm}`);
  if (s.commit_ran !== 'true')           throw new Error('commit should have run after the loop exited');
  if (s.committed_choice !== 'dispatch') throw new Error(`commit read choice = ${s.committed_choice}, want dispatch`);
}

// ─── testSizingSkippedWhenNoSplit ──────────────────────────────────────────────
// recommend_split !== 'true' (no split recommended, or sizing not configured)
// must skip the whole confirm/adjust loop and the commit step — plan.json's flow
// degrades to "nothing to confirm" with no children created.

async function testSizingSkippedWhenNoSplit() {
  const W = BASE + 19;

  const proposeScript = mkScript(`w${W}-propose`,
    `node '${STATE_CLI}' ${W} set recommend_split false`,
  );
  const confirmScript = mkScript(`w${W}-confirm`,
    `node '${STATE_CLI}' ${W} set sizing_confirm dispatch`,
  );
  const commitScript = mkScript(`w${W}-commit`,
    `node '${STATE_CLI}' ${W} set commit_ran true`,
  );

  const wf = mkWorkflow(`w${W}-sizing-nosplit`, [
    { id: 'size-and-schedule-propose', type: 'script', script: proposeScript, args: ['--propose'], stateWrites: ['recommend_split'] },
    {
      id:            'sizing-review-loop',
      type:          'loop',
      runIf:         "state.recommend_split === 'true'",
      minIterations: 1,
      maxIterations: 200,
      exitCondition: "state.sizing_confirm === 'dispatch' || state.sizing_confirm === 'tickets_only'",
      steps: [{ id: 'confirm-sizing', type: 'script', script: confirmScript }],
    },
    { id: 'size-and-schedule-commit', type: 'script', script: commitScript, runIf: "state.recommend_split === 'true'" },
  ]);

  await run(W, wf, 'QUO-999');

  const s = stateRead(W);
  if (s.sizing_confirm !== undefined) throw new Error('confirm-sizing ran but recommend_split was false');
  if (s.commit_ran !== undefined)     throw new Error('commit ran but recommend_split was false');
}

// ─── testNotifyNonBlock ───────────────────────────────────────────────────────
// Workflow: step-a emits a notify event, step-b runs after.
// Both must complete, and notify.sh must have been called.

async function testNotifyNonBlock() {
  const W = BASE + 4;

  // Stub notify.sh — writes a flag file we can check.
  const notifyFlag   = path.join(TMP_DIR, `notify-fired-${W}`);
  const notifyScript = path.join(MUADDIB_DIR, 'services/notify.sh');
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

// ─── testWarnFiresNotFails ────────────────────────────────────────────────────
// claude-tui step with STEP_WARN_MS=100. The mock job takes ~300 ms (sleep 0.3)
// plus up to 1 s in the wrapper's poll loop — longer than 100 ms — so the warn
// timer fires while the step is still running. Verifies:
//   1. notify.sh is called (warn fired)
//   2. the workflow still completes successfully (runner did NOT fail the step)

async function testWarnFiresNotFails() {
  if (!hasTmux()) { console.log('    (skipped — tmux not available)'); return; }

  const W = BASE + 7;
  ensureTmuxSession(W);

  const notifyFlag   = path.join(TMP_DIR, `warn-notify-fired-${W}`);
  const notifyScript = path.join(MUADDIB_DIR, 'services/notify.sh');
  const hadNotify    = fs.existsSync(notifyScript);
  const savedNotify  = hadNotify ? fs.readFileSync(notifyScript) : null;
  fs.writeFileSync(notifyScript, `#!/usr/bin/env bash\ntouch '${notifyFlag}'\n`);
  fs.chmodSync(notifyScript, 0o755);

  const prevWarnMs = process.env.STEP_WARN_MS;
  process.env.STEP_WARN_MS = '100'; // fire warn after 100 ms; mock job takes ~300 ms+

  try {
    const wf = mkWorkflow(`w${W}-warn`, [{
      id:              'slow-step',
      type:            'claude-tui',
      skill:           'slow-step',
      mockStateWrites: [['warn_step_done', 'true']],
      stateWrites:     ['warn_step_done'],
    }]);

    await run(W, wf, 'QUO-warn');

    const s = stateRead(W);
    if (s.warn_step_done !== 'true') throw new Error('step did not complete — workflow failed');

    // notify.sh is spawned detached; give it a moment to execute.
    await wait(400);
    if (!fs.existsSync(notifyFlag)) throw new Error('notify.sh was not called — onWarn did not fire');
  } finally {
    if (prevWarnMs !== undefined) process.env.STEP_WARN_MS = prevWarnMs;
    else delete process.env.STEP_WARN_MS;
    if (savedNotify) fs.writeFileSync(notifyScript, savedNotify);
    else try { fs.unlinkSync(notifyScript); } catch (_) {}
    killTmuxSession(W);
  }
}

// ─── testNudgeRecoversIdleStep ─────────────────────────────────────────────────
// GH #87: a claude-tui step that stalls at its prompt without touching the
// sentinel used to hang forever. waitForJobCompletion now takes nudgeMs/onNudge:
// after nudgeMs it repeatedly runs onNudge, which (via job.nudgeIdleStep) types
// the "run the touch" recovery into an idle, stable, marker-free pane — exactly
// the manual recovery, automated.
//
// This drives the real pieces directly (startJob + waitForJobCompletion + the
// same onNudge closure runClaudeTuiStep builds), because MOCK_JOBS steps always
// self-complete and so can't model an idle-without-sentinel stall.
//
// Idle case:   a job that prints a stable line then blocks (`echo; sleep`) and
//              never touches its sentinel — a bare `sleep` leaves the pane blank,
//              which nudgeIdleStep's blank-pane guard deliberately never nudges,
//              so it must render a real idle prompt to model the stall. Once
//              the threshold elapses, waitForJobCompletion runs onNudge, which
//              (via job.nudgeIdleStep against the real tmux pane) detects a
//              stable, idle, marker-free pane and reports it nudged. The test
//              plays the model's role — writing the sentinel in response, which
//              is exactly what the typed recovery is meant to induce — so the
//              wrapper emits done and waitForJobCompletion resolves. Without the
//              nudge the job would run to the hard-timeout instead.
// Control:     a job that completes on its own well before its (large) nudgeMs
//              must never be nudged.

async function testNudgeRecoversIdleStep() {
  if (!hasTmux()) { console.log('    (skipped — tmux not available)'); return; }

  const W = BASE + 16;
  ensureTmuxSession(W);
  try {
    // ── idle case: blocks forever, recovers only once nudged ──────────────────
    {
      const jobName = 'idle-step';
      const doneFile = `/tmp/step-done-${W}-${jobName}`;
      let nudgeCount = 0;
      let prevSnapshot;
      const onNudge = () => {
        const res = nudgeIdleStep(W, jobName, prevSnapshot);
        prevSnapshot = res.snapshot;
        if (res.nudged) {
          nudgeCount++;
          // Simulate the model reacting to the typed recovery by finally
          // touching the sentinel — the behavior the nudge exists to induce.
          fs.writeFileSync(doneFile, '');
        }
      };

      // Capture offset BEFORE startJob so the done event is never missed.
      const waitP = waitForJobCompletion(W, jobName, {
        nudgeMs: 500,
        onNudge,
        hardTimeoutMs: 20_000, // safety net so a failure rejects instead of hanging
      });
      // Render a stable non-blank line before blocking so the pane models a real
      // idle claude-tui prompt (a bare `sleep` leaves the pane blank, which
      // nudgeIdleStep deliberately never nudges — see its blank-pane guard).
      startJob(W, jobName, 'echo "waiting at prompt"; sleep 30');
      await waitP;

      if (nudgeCount < 1) throw new Error('idle step completed but was never nudged');
    }

    // ── control: a self-completing job is never nudged ────────────────────────
    {
      const jobName = 'quick-step';
      let nudgeCount = 0;
      let prevSnapshot;
      const onNudge = () => {
        const res = nudgeIdleStep(W, jobName, prevSnapshot);
        prevSnapshot = res.snapshot;
        if (res.nudged) nudgeCount++;
      };

      const waitP = waitForJobCompletion(W, jobName, {
        nudgeMs: 10_000, // far beyond how long this job takes to finish
        onNudge,
        hardTimeoutMs: 20_000,
      });
      startJob(W, jobName, 'touch "$STEP_DONE_FILE"');
      await waitP;

      if (nudgeCount !== 0) throw new Error(`self-completing step was nudged ${nudgeCount}x — should be 0`);
    }
  } finally {
    killTmuxSession(W);
  }
}

// ─── testAwaitsReviewSetsStatus ────────────────────────────────────────────────
// A claude-tui step with awaitsReview:true must write AWAITING_REVIEW to the
// coarse per-worker status file (read by bin/attend.sh, spawn-worker.sh's
// notifier, MuaddibApp) while it runs, then revert to RUNNING once it settles.
// GH issue #5: this is the generic replacement for the deleted SKETCH_REVIEW
// state — any project-declared step can opt in, not just sketch's.
//
// Also a regression test for a review-caught bug: fireNotify() used to both
// emit a bus 'notify' event AND spawn notify.sh directly — flushNotify()
// (called after every step) then re-read that same event and spawned
// notify.sh a second time. Asserts exactly one call, not two.

async function testAwaitsReviewSetsStatus() {
  if (!hasTmux()) { console.log('    (skipped — tmux not available)'); return; }

  const W = BASE + 13;
  ensureTmuxSession(W);

  const notifyScript = path.join(MUADDIB_DIR, 'services/notify.sh');
  const hadNotify     = fs.existsSync(notifyScript);
  const savedNotify   = hadNotify ? fs.readFileSync(notifyScript) : null;
  const callLog       = path.join(TMP_DIR, `notify-calls-${W}.log`);
  fs.writeFileSync(notifyScript, `#!/usr/bin/env bash\necho called >> '${callLog}'\n`);
  fs.chmodSync(notifyScript, 0o755);

  try {
    const statusFile = path.join(TMP_DIR, `worker-${W}.state`);
    const readWord = () => {
      try { return fs.readFileSync(statusFile, 'utf8').trim().split(' ')[0]; }
      catch (_) { return ''; }
    };

    const wf = mkWorkflow(`w${W}-await`, [{
      id:           'review-step',
      type:         'claude-tui',
      skill:        'review-step',
      awaitsReview: true,
    }]);

    // Poll the status file while the mock step runs (~0.3s) to catch the
    // transient AWAITING_REVIEW write.
    let sawAwaiting = false;
    const poll = setInterval(() => {
      if (readWord() === 'AWAITING_REVIEW') sawAwaiting = true;
    }, 20);

    await run(W, wf, 'QUO-await');
    clearInterval(poll);

    if (!sawAwaiting) throw new Error('AWAITING_REVIEW status was never observed during the step');
    if (readWord() !== 'RUNNING') throw new Error(`status not reverted to RUNNING after step — got "${readWord()}"`);

    // notify.sh is spawned detached; give it a moment to execute.
    await wait(400);
    const calls = fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean).length : 0;
    if (calls !== 1) throw new Error(`expected notify.sh called exactly once, got ${calls}`);
  } finally {
    if (savedNotify) fs.writeFileSync(notifyScript, savedNotify);
    else try { fs.unlinkSync(notifyScript); } catch (_) {}
    killTmuxSession(W);
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
        steps: [
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
        steps: [
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
    ['sketch review workflow — plan/loop/finalize shape', testSketchReviewWorkflow],
    ['sketch skipped when needs_sketch is not true',      testSketchSkippedWhenNotNeeded],
    ['sketch loop exhaustion never runs finalize',        testSketchLoopExhaustionNeverFinalizes],
    ['sketch loop with stale state still polls first',    testSketchLoopStaleStateStillPolls],
    ['script step forwards args as CLI argv',              testScriptArgsPassed],
    ['sizing review workflow — propose/loop(confirm+adjust)/commit', testSizingReviewWorkflow],
    ['sizing loop + commit skipped when no split',        testSizingSkippedWhenNoSplit],
    ['notify fires without blocking workflow',           testNotifyNonBlock],
    ['warn fires notify without failing step (tmux)',                testWarnFiresNotFails],
    ['idle claude-tui step is nudged; completing one is not (tmux)', testNudgeRecoversIdleStep],
    ['awaitsReview sets AWAITING_REVIEW then reverts (tmux)',        testAwaitsReviewSetsStatus],
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
