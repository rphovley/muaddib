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
const fs = require('fs');
const path = require('path');
const {
  ConductorSession,
  createConductorSession,
  permFlag,
  conductorPluginDir,
} = require('../conductor-session');

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
    // busyGraceMs now defaults to a standalone 10s (real tool-call latency
    // headroom), independent of settleMs — explicit small override here so
    // the fake CLI's instant, spinner-less echo still settles fast.
    busyGraceMs: 400,
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

// The Conductor loads its own skill set via `--plugin-dir <repo>/conductor`
// (conductor/.claude-plugin/plugin.json + conductor/skills/*), separate from the
// worker-baked claude/skills/*. Assert the default launch command wires the flag
// at the resolved plugin dir, and that the seed skills are actually on disk there
// — no tmux, no claude, no token needed.
function testPluginDirWiredIntoClaudeCmd() {
  const s = createConductorSession({ name: `conductor-plugindir-${process.pid}` });
  const dir = conductorPluginDir();
  if (!s.claudeCmd.includes('--plugin-dir')) {
    throw new Error(`expected default claudeCmd to include --plugin-dir, got: ${s.claudeCmd}`);
  }
  if (!s.claudeCmd.includes(dir)) {
    throw new Error(`expected claudeCmd to reference the conductor plugin dir ${dir}, got: ${s.claudeCmd}`);
  }
  if (!path.isAbsolute(dir)) {
    throw new Error(`expected conductorPluginDir() to be absolute, got: ${dir}`);
  }
  // An explicit claudeCmd override (the test/fake-CLI path) must NOT get the flag.
  const overridden = createConductorSession({ claudeCmd: 'fake-cli' });
  if (overridden.claudeCmd.includes('--plugin-dir')) {
    throw new Error('an explicit claudeCmd override must not have --plugin-dir appended');
  }
}

function testConductorSkillsPresent() {
  const dir = conductorPluginDir();
  const manifest = path.join(dir, '.claude-plugin', 'plugin.json');
  if (!fs.existsSync(manifest)) {
    throw new Error(`missing conductor plugin manifest at ${manifest}`);
  }
  for (const skill of ['triage']) {
    const md = path.join(dir, 'skills', skill, 'SKILL.md');
    if (!fs.existsSync(md)) {
      throw new Error(`missing conductor skill at ${md}`);
    }
    const body = fs.readFileSync(md, 'utf8');
    if (!/^---[\s\S]*\nname:\s*/.test(body)) {
      throw new Error(`conductor skill ${skill} is missing name: frontmatter`);
    }
  }
}

// The Conductor runs on the bare host, not inside a worker's container sandbox —
// it must never default to --dangerously-skip-permissions (a prompt-injected or
// hallucinated Bash call would execute for real on the operator's machine).
// permFlag() is decoupled from CLAUDE_PERMISSION_MODE (the Worker-facing var,
// default bypassPermissions there — justified by the container sandbox) via its
// own CONDUCTOR_PERMISSION_MODE, defaulting to '' (no flag — Claude Code's normal
// interactive gating) rather than any bypass.
function testPermFlagDefaultsSafe() {
  const savedConductor = process.env.CONDUCTOR_PERMISSION_MODE;
  const savedClaude = process.env.CLAUDE_PERMISSION_MODE;
  delete process.env.CONDUCTOR_PERMISSION_MODE;
  try {
    // Decoupling: even with the Worker var set to bypass, the Conductor's own
    // flag must stay unset — the two must never cross-contaminate.
    process.env.CLAUDE_PERMISSION_MODE = 'bypassPermissions';
    const flag = permFlag();
    if (flag !== '') {
      throw new Error(`expected permFlag() to default to '' (no bypass), got: ${JSON.stringify(flag)}`);
    }
    const s = createConductorSession({ name: `conductor-permflag-${process.pid}` });
    if (s.claudeCmd.includes('--dangerously-skip-permissions')) {
      throw new Error(`default claudeCmd must not bypass permissions, got: ${s.claudeCmd}`);
    }
    if (/claude\s{2,}/.test(s.claudeCmd)) {
      throw new Error(`empty permFlag() must not leave a stray double space, got: ${JSON.stringify(s.claudeCmd)}`);
    }
  } finally {
    if (savedConductor === undefined) delete process.env.CONDUCTOR_PERMISSION_MODE;
    else process.env.CONDUCTOR_PERMISSION_MODE = savedConductor;
    if (savedClaude === undefined) delete process.env.CLAUDE_PERMISSION_MODE;
    else process.env.CLAUDE_PERMISSION_MODE = savedClaude;
  }
}

// An operator who explicitly wants more autonomy can still opt in.
function testPermFlagExplicitOptIn() {
  const saved = process.env.CONDUCTOR_PERMISSION_MODE;
  try {
    process.env.CONDUCTOR_PERMISSION_MODE = 'bypassPermissions';
    if (permFlag() !== '--dangerously-skip-permissions') {
      throw new Error(`explicit opt-in should resolve to the skip flag, got: ${JSON.stringify(permFlag())}`);
    }
    process.env.CONDUCTOR_PERMISSION_MODE = 'acceptEdits';
    if (permFlag() !== '--permission-mode acceptEdits') {
      throw new Error(`explicit non-bypass mode should resolve to --permission-mode, got: ${JSON.stringify(permFlag())}`);
    }
  } finally {
    if (saved === undefined) delete process.env.CONDUCTOR_PERMISSION_MODE;
    else process.env.CONDUCTOR_PERMISSION_MODE = saved;
  }
}

// A pending permission-approval prompt has no "esc to interrupt" spinner, so
// without treating it as busy it reads as a genuinely finished, idle turn —
// confirmed live: a sizing hook's unattended session hit a Linear MCP approval
// prompt and readResponse() handed back the prompt's own UI text as if it were
// the model's answer. This fake CLI never resolves the "prompt" it prints (no
// further output after it), so a correct readResponse() must never settle on
// it — it should time out instead of returning bogus "settled" text.
async function testPendingApprovalPromptNeverSettles() {
  const s = createConductorSession({
    name: `conductor-test-${process.pid}-stuck-approval`,
    claudeCmd: "bash -c 'while IFS= read -r line; do printf \"Do you want to proceed?\\n\"; done'",
    settleMs: 200,
    pollMs: 100,
    timeoutMs: 1000,
    readyTimeoutMs: 8000,
    busyGraceMs: 200,
  });
  try {
    s.start();
    let threw = false;
    try {
      s.ask('run something risky');
    } catch (err) {
      threw = true;
      if (!/no settled response/i.test(err.message)) {
        throw new Error(`expected a settle-timeout error, got: ${err.message}`);
      }
    }
    if (!threw) {
      throw new Error('expected ask() to time out rather than return the pending-approval text as an answer');
    }
  } finally {
    s.stop();
  }
}

// busyGraceMs must have its own standalone default — NOT derived from
// settleMs — since callers (like tests) often tune settleMs much smaller than
// what real tool-call startup latency needs. Pure construction check, no tmux.
function testBusyGraceMsDefaultIsStandalone() {
  const s = createConductorSession({
    name: `conductor-test-${process.pid}-busygrace`,
    settleMs: 50,
  });
  if (s.busyGraceMs === 50) {
    throw new Error('busyGraceMs must not silently inherit a small settleMs override');
  }
  if (s.busyGraceMs < 5000) {
    throw new Error(`expected a generous standalone default (>=5000ms), got: ${s.busyGraceMs}`);
  }
}

async function main() {
  ensureTmux();

  const tests = [
    ['start() → isAlive() true; stop() → isAlive() false', testStartIsAliveStop],
    ['ask() returns non-empty settled echo output', testAskEchoes],
    ['sendPrompt() on a dead session throws', testSendPromptDeadSession],
    ['default claudeCmd wires --plugin-dir at the conductor plugin dir', testPluginDirWiredIntoClaudeCmd],
    ['conductor plugin manifest + seed skills are present on disk', testConductorSkillsPresent],
    ['permFlag() defaults to no bypass, decoupled from CLAUDE_PERMISSION_MODE', testPermFlagDefaultsSafe],
    ['permFlag() honors an explicit CONDUCTOR_PERMISSION_MODE opt-in', testPermFlagExplicitOptIn],
    ['a pending approval prompt never settles as a fake "answer"', testPendingApprovalPromptNeverSettles],
    ['busyGraceMs defaults standalone, not tied to settleMs', testBusyGraceMsDefaultIsStandalone],
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
  for (const suffix of ['lifecycle', 'ask', 'dead', 'stuck-approval']) {
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
