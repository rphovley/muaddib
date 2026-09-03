#!/usr/bin/env node
"use strict";
// conductor-daemon.js test suite — process-lifecycle logic, no tmux/network.
// The session is mocked via the _setSession test seam, so nothing here launches
// a real `claude`.
//
// testValidateEnvPassesWithToken     — validateEnv() succeeds with the OAuth token set
// testValidateEnvThrowsWithoutToken  — validateEnv() throws, naming CLAUDE_CODE_OAUTH_TOKEN
// testRequireAloneDoesNotStart       — require() alone starts nothing (no main, no hang)
// testHealthCheckShapeTokenPresent   — healthCheck() reports tokenPresent/sessionAlive from a live mock
// testHealthCheckSessionDead         — sessionAlive false when the mock session is down
// testHealthCheckTokenAbsent         — tokenPresent false when the token is unset
// testHealthCheckNoSession           — sessionAlive false when no session is set at all
// testReportFleetStateReadOnly       — reportFleetState() returns a human-readable
//                                       string and takes no action (Autonomy L0):
//                                       the session is never driven, no events written
// testResolveInitialPromptSingleToken — a single-token ticket arg is returned as-is
// testResolveInitialPromptMultiWord   — multi-word task argv is joined with spaces
// testResolveInitialPromptEnvFallback — CONDUCTOR_INITIAL_PROMPT used when argv empty
// testResolveInitialPromptArgvWins    — argv takes precedence over the env fallback
// testResolveInitialPromptEmpty       — no argv, no env → ""
// testSetGetLoopSeam                  — _setLoop/_getLoop inject and read the loop
// testShutdownStopsLoop               — shutdown() stops the reasoning loop and
//                                       clears it, alongside the session

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const daemon = require("../conductor-daemon");

const DAEMON_PATH = path.join(__dirname, "../conductor-daemon.js");

// A mock session standing in for orchestrator/conductor-session.js — only
// isAlive() is exercised by healthCheck().
function mockSession(alive) {
  return { name: "conductor-test", isAlive: () => alive };
}

async function testValidateEnvPassesWithToken() {
  const prev = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-oauth";
  try {
    daemon.validateEnv(); // must not throw
  } finally {
    restore("CLAUDE_CODE_OAUTH_TOKEN", prev);
  }
}

async function testValidateEnvThrowsWithoutToken() {
  const prev = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    let threw = false;
    try {
      daemon.validateEnv();
    } catch (err) {
      threw = true;
      if (!/CLAUDE_CODE_OAUTH_TOKEN/.test(err.message)) {
        throw new Error(
          `error should name the missing token, got: ${err.message}`,
        );
      }
    }
    if (!threw) throw new Error("expected validateEnv() to throw with no token");
  } finally {
    restore("CLAUDE_CODE_OAUTH_TOKEN", prev);
  }
}

async function testRequireAloneDoesNotStart() {
  // require.main === module guards main(), so importing the module must return
  // immediately (no session started, no heartbeat interval keeping it alive).
  // A subprocess that only requires it and prints "ok" must exit promptly.
  const r = spawnSync(
    process.execPath,
    ["-e", `require(${JSON.stringify(DAEMON_PATH)}); console.log("ok")`],
    { encoding: "utf8", timeout: 8000, env: { ...process.env } },
  );
  if (r.signal) {
    throw new Error(
      `require() alone hung (killed by ${r.signal}) — main() must not run on import`,
    );
  }
  if (r.status !== 0) {
    throw new Error(`expected exit 0 on bare require(), got ${r.status}: ${r.stderr}`);
  }
  if (!r.stdout.includes("ok")) {
    throw new Error(`expected "ok" on stdout, got: ${r.stdout}`);
  }
}

async function testHealthCheckShapeTokenPresent() {
  const prev = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-oauth";
  daemon._setSession(mockSession(true));
  try {
    const h = await daemon.healthCheck();
    for (const k of ["alive", "eventLoopResponsive", "tokenPresent", "sessionAlive"]) {
      if (!(k in h)) throw new Error(`healthCheck() missing "${k}": ${JSON.stringify(h)}`);
    }
    if (h.alive !== true) throw new Error(`expected alive=true, got ${h.alive}`);
    if (h.eventLoopResponsive !== true)
      throw new Error(`expected eventLoopResponsive=true, got ${h.eventLoopResponsive}`);
    if (h.tokenPresent !== true)
      throw new Error(`expected tokenPresent=true, got ${h.tokenPresent}`);
    if (h.sessionAlive !== true)
      throw new Error(`expected sessionAlive=true for a live session, got ${h.sessionAlive}`);
  } finally {
    daemon._setSession(null);
    restore("CLAUDE_CODE_OAUTH_TOKEN", prev);
  }
}

async function testHealthCheckSessionDead() {
  daemon._setSession(mockSession(false));
  try {
    const h = await daemon.healthCheck();
    if (h.sessionAlive !== false)
      throw new Error(`expected sessionAlive=false for a dead session, got ${h.sessionAlive}`);
  } finally {
    daemon._setSession(null);
  }
}

async function testHealthCheckTokenAbsent() {
  const prev = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  daemon._setSession(mockSession(true));
  try {
    const h = await daemon.healthCheck();
    if (h.tokenPresent !== false)
      throw new Error(`expected tokenPresent=false with no token, got ${h.tokenPresent}`);
  } finally {
    daemon._setSession(null);
    restore("CLAUDE_CODE_OAUTH_TOKEN", prev);
  }
}

async function testHealthCheckNoSession() {
  daemon._setSession(null);
  const h = await daemon.healthCheck();
  if (h.sessionAlive !== false)
    throw new Error(`expected sessionAlive=false when no session set, got ${h.sessionAlive}`);
}

async function testReportFleetStateReadOnly() {
  // Autonomy L0: reportFleetState() reports and decides nothing. Point Fleet
  // State at an isolated temp dir so we can prove nothing was written, and use a
  // spy session to prove the daemon never drove it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-report-"));
  const prevDir = process.env.AGENT_STATUS_DIR;
  process.env.AGENT_STATUS_DIR = dir;

  const calls = [];
  const spy = new Proxy(
    { name: "conductor-test", isAlive: () => true },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        // Any other method call (start/stop/send/…) is recorded as an action.
        return (...args) => { calls.push({ method: String(prop), args }); };
      },
    },
  );
  daemon._setSession(spy);

  try {
    const before = fs.readdirSync(dir);
    const report = daemon.reportFleetState();

    if (typeof report !== "string" || !report.length) {
      throw new Error(`expected a non-empty string report, got: ${JSON.stringify(report)}`);
    }
    if (!/Fleet State/.test(report)) {
      throw new Error(`report should read as a Fleet State report, got: ${report}`);
    }
    if (calls.length !== 0) {
      throw new Error(`reportFleetState() must take no session action, drove: ${JSON.stringify(calls)}`);
    }
    const after = fs.readdirSync(dir);
    if (after.length !== before.length) {
      throw new Error(`reportFleetState() must not write events; dir changed ${before} -> ${after}`);
    }
  } finally {
    daemon._setSession(null);
    if (prevDir === undefined) delete process.env.AGENT_STATUS_DIR;
    else process.env.AGENT_STATUS_DIR = prevDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ─── resolveInitialPrompt ──────────────────────────────────────────────────────
// The prompt-resolution seam: joined argv > CONDUCTOR_INITIAL_PROMPT > "". Pure
// (aside from the env fallback), so these are plain input/output assertions.

async function testResolveInitialPromptSingleToken() {
  const prev = process.env.CONDUCTOR_INITIAL_PROMPT;
  delete process.env.CONDUCTOR_INITIAL_PROMPT;
  try {
    const got = daemon.resolveInitialPrompt(["QUO-507"]);
    if (got !== "QUO-507")
      throw new Error(`expected "QUO-507", got ${JSON.stringify(got)}`);
  } finally {
    restore("CONDUCTOR_INITIAL_PROMPT", prev);
  }
}

async function testResolveInitialPromptMultiWord() {
  const prev = process.env.CONDUCTOR_INITIAL_PROMPT;
  delete process.env.CONDUCTOR_INITIAL_PROMPT;
  try {
    const got = daemon.resolveInitialPrompt(["look", "into", "the", "flaky", "preview"]);
    if (got !== "look into the flaky preview")
      throw new Error(`expected joined task text, got ${JSON.stringify(got)}`);
  } finally {
    restore("CONDUCTOR_INITIAL_PROMPT", prev);
  }
}

async function testResolveInitialPromptEnvFallback() {
  const prev = process.env.CONDUCTOR_INITIAL_PROMPT;
  process.env.CONDUCTOR_INITIAL_PROMPT = "QUO-900";
  try {
    const got = daemon.resolveInitialPrompt([]);
    if (got !== "QUO-900")
      throw new Error(`expected env fallback "QUO-900", got ${JSON.stringify(got)}`);
  } finally {
    restore("CONDUCTOR_INITIAL_PROMPT", prev);
  }
}

async function testResolveInitialPromptArgvWins() {
  const prev = process.env.CONDUCTOR_INITIAL_PROMPT;
  process.env.CONDUCTOR_INITIAL_PROMPT = "QUO-900";
  try {
    const got = daemon.resolveInitialPrompt(["QUO-507"]);
    if (got !== "QUO-507")
      throw new Error(`argv must win over env fallback, got ${JSON.stringify(got)}`);
  } finally {
    restore("CONDUCTOR_INITIAL_PROMPT", prev);
  }
}

async function testResolveInitialPromptEmpty() {
  const prev = process.env.CONDUCTOR_INITIAL_PROMPT;
  delete process.env.CONDUCTOR_INITIAL_PROMPT;
  try {
    const got = daemon.resolveInitialPrompt([]);
    if (got !== "")
      throw new Error(`expected "" with no argv and no env, got ${JSON.stringify(got)}`);
  } finally {
    restore("CONDUCTOR_INITIAL_PROMPT", prev);
  }
}

// ─── reasoning-loop wiring ──────────────────────────────────────────────────
// The loop itself is covered end-to-end in orchestrator/test-conductor-loop.js;
// here we only prove the daemon's seam and shutdown path drive it.

async function testSetGetLoopSeam() {
  const fake = { start() {}, stop() {}, rescan() {} };
  daemon._setLoop(fake);
  try {
    if (daemon._getLoop() !== fake) throw new Error("_getLoop should return the injected loop");
  } finally {
    daemon._setLoop(null);
  }
}

async function testShutdownStopsLoop() {
  // shutdown() ends with process.exit(0); stub it so the test survives and can
  // assert the loop (and session) were torn down first.
  const stopped = { loop: false, session: false };
  daemon._setLoop({
    start() {},
    rescan() {},
    stop() { stopped.loop = true; },
  });
  daemon._setSession({ name: "conductor-test", isAlive: () => true, stop() { stopped.session = true; } });

  const realExit = process.exit;
  let exitCode = null;
  process.exit = (code) => { exitCode = code; };
  try {
    daemon.shutdown();
  } finally {
    process.exit = realExit;
  }

  if (!stopped.loop) throw new Error("shutdown() must stop the reasoning loop");
  if (!stopped.session) throw new Error("shutdown() must stop the session");
  if (daemon._getLoop() !== null) throw new Error("shutdown() must clear the loop reference");
  if (exitCode !== 0) throw new Error(`shutdown() should exit 0, got ${exitCode}`);

  daemon._setLoop(null);
  daemon._setSession(null);
}

function restore(key, prev) {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}

async function main() {
  const tests = [
    ["validateEnv: passes with CLAUDE_CODE_OAUTH_TOKEN set", testValidateEnvPassesWithToken],
    ["validateEnv: throws naming CLAUDE_CODE_OAUTH_TOKEN when absent", testValidateEnvThrowsWithoutToken],
    ["require() alone starts nothing (no main, no hang)", testRequireAloneDoesNotStart],
    ["healthCheck: shape + live session (token present)", testHealthCheckShapeTokenPresent],
    ["healthCheck: sessionAlive=false when session is down", testHealthCheckSessionDead],
    ["healthCheck: tokenPresent=false when token unset", testHealthCheckTokenAbsent],
    ["healthCheck: sessionAlive=false when no session set", testHealthCheckNoSession],
    ["reportFleetState: human-readable string, takes no action", testReportFleetStateReadOnly],
    ["resolveInitialPrompt: single-token ticket returned as-is", testResolveInitialPromptSingleToken],
    ["resolveInitialPrompt: multi-word argv joined with spaces", testResolveInitialPromptMultiWord],
    ["resolveInitialPrompt: CONDUCTOR_INITIAL_PROMPT fallback", testResolveInitialPromptEnvFallback],
    ["resolveInitialPrompt: argv wins over env fallback", testResolveInitialPromptArgvWins],
    ["resolveInitialPrompt: empty argv + no env → \"\"", testResolveInitialPromptEmpty],
    ["_setLoop/_getLoop seam injects and reads the loop", testSetGetLoopSeam],
    ["shutdown() stops and clears the reasoning loop", testShutdownStopsLoop],
  ];

  let passed = 0;
  for (const [name, fn] of tests) {
    process.stdout.write(`  ${name}... `);
    try {
      await fn();
      process.stdout.write("PASS\n");
      passed++;
    } catch (err) {
      process.stdout.write(`FAIL\n    ${err.message}\n`);
    }
  }

  console.log(`\n${passed}/${tests.length} passed`);
  if (passed < tests.length) process.exit(1);
}

main().catch((err) => {
  console.error("FAIL —", err.message);
  process.exit(1);
});
