#!/usr/bin/env node
'use strict';
// Regression test for a real bug caught dogfooding QUO-507: feature.json/bug.json
// let a worker fall through into implement/review/wrapup even after its own
// sizing step just split the ticket into sub-issues — so the same worker both
// splits the work AND still barrels ahead implementing the (now-superseded)
// original ticket. The fix is a `runIf: "state.recommend_split !== 'true'"`
// gate on every step downstream of size-and-schedule-commit; this test loads
// the REAL workflow JSON files (not a synthetic fixture) so a future edit that
// re-introduces an ungated step is caught here, not by a live worker doing
// double the work.
//
// plan.json is a planning-only workflow with no implement/review/wrapup steps
// at all, so it isn't part of this bug and isn't checked here.

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function assert(label, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? `: ${detail}` : ''}`);
    failed++;
  }
}

function loadWorkflow(name) {
  const p = path.join(__dirname, '..', '..', 'workflows', name);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Steps that must not run once a ticket has been split — one worker's job past
// that point is done; the sub-tickets are the fleet's next dispatch decision,
// not this worker's to keep implementing.
const GATED_STEP_IDS = ['implement', 'implement-bug', 'implement-check-loop', 'review', 'wrapup'];
const SPLIT_GATE = "state.recommend_split !== 'true'";

function checkWorkflowGating(name) {
  const wf = loadWorkflow(name);
  const byId = new Map(wf.workflow.map((s) => [s.id, s]));

  for (const id of GATED_STEP_IDS) {
    const step = byId.get(id);
    if (!step) continue; // not every workflow has every id (implement vs implement-bug)
    assert(
      `${name}: "${id}" is gated on recommend_split`,
      step.runIf === SPLIT_GATE,
      `got runIf=${JSON.stringify(step.runIf)}`,
    );
  }

  // At least one implement-shaped step must actually exist and be checked —
  // guards against a future rename silently dropping out of GATED_STEP_IDS
  // (and this test) without anyone noticing.
  const hasImplementStep = byId.has('implement') || byId.has('implement-bug');
  assert(`${name}: has an implement step to gate`, hasImplementStep);
}

function main() {
  console.log('feature.json');
  checkWorkflowGating('feature.json');

  console.log('\nbug.json');
  checkWorkflowGating('bug.json');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
