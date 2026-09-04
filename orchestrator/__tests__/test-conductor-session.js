#!/usr/bin/env node
'use strict';
// ConductorSession lifecycle test suite. Requires tmux (run inside the worker
// container). Exercises the real tmux driver — new-session / send-keys /
// capture-pane / has-session / kill-session, the disclaimer no-op, idle-settle
// and pane diffing — against a deterministic FAKE interactive CLI, so it needs
// no live `claude` and no CLAUDE_CODE_OAUTH_TOKEN.
//
// The fake CLI is a bash read-loop that echoes each submitted line back as
// "ECHO:<line>", giving readResponse settled, non-empty output to diff — the
// same shape ask() must return against real claude, without the cost/auth of a
// model round-trip.
//
// An opt-in live check (CONDUCTOR_LIVE_TEST=1, needs a real claude + token)
// runs ask('what is 2+2') against actual claude; skipped by default so the
// suite stays deterministic and token-free.
//
// testStartIsAliveStop  — start() → isAlive() true; stop() → isAlive() false
// testAskEchoes         — ask() returns the fake CLI's non-empty settled echo
// testSendPromptDeadSession — sendPrompt() on a stopped session throws
// testLiveClaudeAsk     — (opt-in) ask('what is 2+2') vs real claude → non-empty

const { spawnSync } = require('child_process');
const { ConductorSession, createConductorSession, permFlag } = require('../conductor-session');

// A fake interactive "CLI": echo each submitted line back. Fast settle/poll so
// the test doesn't drag. Unique session name to avoid colliding with a real
// conductor or a parallel run.
const FAKE_CLI = "bash -c 'while IFS= read -r line; do printf \"ECHO:%s\\n\" \"$line\"; done'";

function newFakeSession(suffix) {
  return createConductorSession({
    name: `conductor-test-${process.pid}-${suffix}`,
    claudeCmd: FAKE_CLI,
    settleMs: 400,
    pollMs: 100,
    timeoutMs: 8000,
    readyTimeoutMs: 8000,
  });
}

function ensureTmux() {
  const r = spawnSync('tmux', ['-V'], { stdio: 'ignore' });
  if (r.status !== 0 || r.error) {
    console.error('FAIL — tmux is not available (run inside the worker container)');
    process.exit(1);
  }
}

async function testStartIsAliveStop() {
  const s = newFakeSession('lifecycle');
  try {
    s.start();
    if (!s.isAlive()) throw new Error('expected isAlive() true after start()');
  } finally {
    s.stop();
  }
  if (s.isAlive()) throw new Error('expected isAlive() false after stop()');
}

async function testAskEchoes() {
  const s = newFakeSession('ask');
  try {
    s.start();
    const out = s.ask('hello-conductor');
    if (!out || !out.trim()) throw new Error('expected non-empty settled output from ask()');
    if (!out.includes('hello-conductor')) {
      throw new Error(`expected the echoed prompt in the output, got: ${JSON.stringify(out)}`);
    }
  } finally {
    s.stop();
  }
}

async function testSendPromptDeadSession() {
  const s = newFakeSession('dead');
  // Never started (no session) → sendPrompt must refuse rather than send-keys
  // into a nonexistent tmux target.
  let threw = false;
  try {
    s.sendPrompt('nope');
  } catch (err) {
    threw = true;
    if (!/not alive/i.test(err.message)) {
      throw new Error(`expected a "not alive" error, got: ${err.message}`);
    }
  }
  if (!threw) throw new Error('expected sendPrompt() to throw on a dead session');
}

// Opt-in only (CONDUCTOR_LIVE_TEST=1): drives a REAL claude. Needs a live claude
// binary + CLAUDE_CODE_OAUTH_TOKEN, and costs a model turn — so it's off by
// default to keep the suite deterministic and free.
async function testLiveClaudeAsk() {
  if (process.env.CONDUCTOR_LIVE_TEST !== '1') {
    process.stdout.write('(skipped — set CONDUCTOR_LIVE_TEST=1 to run) ');
    return;
  }
  const s = new ConductorSession({
    name: `conductor-live-${process.pid}`,
    settleMs: 2500,
    timeoutMs: 120000,
    readyTimeoutMs: 90000,
  });
  try {
    s.start();
    if (!s.isAlive()) throw new Error('expected a live claude session to be alive');
    const out = s.ask('what is 2+2? Reply with just the number.');
    if (!out || !out.trim()) throw new Error('expected non-empty settled output from live claude');
  } finally {
    s.stop();
  }
}

async function main() {
  ensureTmux();
  // Sanity: permFlag must resolve to the interactive skip flag under the default
  // bypassPermissions mode (how the daemon launches claude).
  if (!permFlag().includes('--dangerously-skip-permissions') && (process.env.CLAUDE_PERMISSION_MODE || 'bypassPermissions') === 'bypassPermissions') {
    console.error('FAIL — permFlag() should be --dangerously-skip-permissions under bypassPermissions');
    process.exit(1);
  }

  const tests = [
    ['start() → isAlive() true; stop() → isAlive() false', testStartIsAliveStop],
    ['ask() returns non-empty settled echo output', testAskEchoes],
    ['sendPrompt() on a dead session throws', testSendPromptDeadSession],
    ['(opt-in) live claude ask(2+2) → non-empty', testLiveClaudeAsk],
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

  // Best-effort cleanup of any stray sessions this run created.
  for (const suffix of ['lifecycle', 'ask', 'dead']) {
    spawnSync('tmux', ['kill-session', '-t', `conductor-test-${process.pid}-${suffix}`], { stdio: 'ignore' });
  }
  spawnSync('tmux', ['kill-session', '-t', `conductor-live-${process.pid}`], { stdio: 'ignore' });

  console.log(`\n${passed}/${tests.length} passed`);
  if (passed < tests.length) process.exit(1);
}

main().catch((err) => {
  console.error('FAIL —', err.message);
  process.exit(1);
});
