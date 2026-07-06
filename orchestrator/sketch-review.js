'use strict';
// Post-planning sketch review — mirrors orchestrator.js's FEEDBACK/FEEDBACK_WORKING
// state machine, but driven by lavish-axi's own poll/end signals instead of a
// GitHub webhook. No tunnel or webhook receiver needed: the reviewer is local,
// so a bounded claude-tui step can just call `lavish-axi poll` directly and
// report the outcome back through a status file.
//
// Each iteration is one bounded job (sketch-poll); the looping itself lives
// here in code, not in a skill that waits forever in prose.

const fs = require('fs');
const { startJob } = require('./job');
const { waitForJobCompletion } = require('./runner');

const MOCK_JOBS = process.env.MOCK_JOBS === '1';

function permFlag() {
  const p = process.env.CLAUDE_PERMISSION_MODE || 'bypassPermissions';
  return p === 'bypassPermissions' ? '--dangerously-skip-permissions' : `--permission-mode ${p}`;
}

function statusFile(worker) {
  return `/tmp/sketch-status-${worker}`;
}

// Capture the events-file offset (via waitForJobCompletion) BEFORE starting
// the job — same ordering runner.js uses for claude-tui steps.
function runJobAndWait(worker, name, skill, ticketId, mockCmd) {
  const cmd = MOCK_JOBS ? mockCmd : `claude ${permFlag()} "/${skill} ${ticketId}"`;
  const waitP = waitForJobCompletion(worker, name);
  startJob(worker, name, cmd);
  return waitP;
}

// note: orchestrator.js's own note() closure, reused so status-file writes
// and state_changed events stay in one place instead of duplicated here.
async function runSketchReview(worker, ticketId, note) {
  for (;;) {
    note('SKETCH_REVIEW');
    try { fs.unlinkSync(statusFile(worker)); } catch (_) {}

    await runJobAndWait(
      worker, 'sketch-poll', 'sketch-poll', ticketId,
      `echo ended > '${statusFile(worker)}'`
    );

    let status = 'ended';
    try { status = fs.readFileSync(statusFile(worker), 'utf8').trim(); } catch (_) {}

    if (status !== 'feedback') {
      note('SKETCH_FINALIZING');
      await runJobAndWait(worker, 'sketch-finalize', 'sketch-finalize', ticketId, 'sleep 0.3');
      return;
    }

    note('SKETCH_REVIEW_WORKING');
    await runJobAndWait(worker, 'sketch-feedback', 'sketch-feedback', ticketId, 'sleep 0.3');
    // loop back around to SKETCH_REVIEW / poll again
  }
}

module.exports = { runSketchReview };
