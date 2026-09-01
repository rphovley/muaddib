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
