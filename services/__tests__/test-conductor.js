#!/usr/bin/env node
"use strict";
// conductor.js test suite — exercises the process-lifecycle skeleton without
// spawning a live model session (the SDK session is a mock injected via main()'s
// sessionFactory, so no @anthropic-ai/claude-agent-sdk round-trip happens).
//
// validateEnv:
//   testValidateEnvThrowsWhenTokenMissing — no CLAUDE_CODE_OAUTH_TOKEN → throws
//   testValidateEnvPassesWhenTokenPresent — token set → returns cleanly
// healthCheck (cheap liveness path):
//   testHealthCheckHealthyWhenAllGood     — session + token + low lag → healthy
//   testHealthCheckUnhealthyNoSession     — null session → unhealthy (session=false)
//   testHealthCheckUnhealthyNoToken       — token unset → unhealthy (token=false)
//   testHealthCheckUnhealthyLoopLag       — lag over the max → unhealthy (eventLoop=false)
// shutdown:
//   testShutdownClearsIntervalAndExits    — clears the heartbeat, tears down session, exits(0)
//   testShutdownIsIdempotent              — second call is a no-op (exit fires once only)
// main:
//   testMainInitsSessionAndHeartbeat      — injected factory used, heartbeat scheduled

const assert = require("assert");

const conductor = require("../conductor");
const {
  validateEnv,
  healthCheck,
  shutdown,
  main,
  startHeartbeat,
} = conductor;

const TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

let pass = 0;
let fail = 0;

async function run(name, fn) {
  const savedToken = process.env[TOKEN_ENV];
  try {
    await fn();
    process.stdout.write(`  ${name}... PASS\n`);
    pass++;
  } catch (err) {
    process.stdout.write(`  ${name}... FAIL: ${err.message}\n`);
    fail++;
  } finally {
    // Restore the token env each test controlled it, so tests don't leak into
    // each other regardless of the order they run in.
    if (savedToken === undefined) delete process.env[TOKEN_ENV];
    else process.env[TOKEN_ENV] = savedToken;
  }
}

// ─── validateEnv ────────────────────────────────────────────────────────────────

function testValidateEnvThrowsWhenTokenMissing() {
  delete process.env[TOKEN_ENV];
  assert.throws(
    () => validateEnv(),
    /CLAUDE_CODE_OAUTH_TOKEN/,
    "validateEnv must throw naming the missing token",
  );
}

function testValidateEnvPassesWhenTokenPresent() {
  process.env[TOKEN_ENV] = "test-token";
  assert.doesNotThrow(() => validateEnv(), "validateEnv must pass with the token set");
}

// ─── healthCheck ────────────────────────────────────────────────────────────────

function testHealthCheckHealthyWhenAllGood() {
  process.env[TOKEN_ENV] = "test-token";
  const { healthy, checks } = healthCheck({ session: { id: 1 }, loopLagMs: 0, maxLoopLagMs: 5000 });
  assert.strictEqual(healthy, true, "all checks good → healthy");
  assert.deepStrictEqual(
    checks,
    { process: true, eventLoop: true, token: true, session: true },
    "every check should pass",
  );
}

function testHealthCheckUnhealthyNoSession() {
  process.env[TOKEN_ENV] = "test-token";
  const { healthy, checks } = healthCheck({ session: null, loopLagMs: 0, maxLoopLagMs: 5000 });
  assert.strictEqual(healthy, false, "no session → unhealthy");
  assert.strictEqual(checks.session, false, "session check should fail");
  assert.strictEqual(checks.token, true, "token check should still pass");
}

function testHealthCheckUnhealthyNoToken() {
  delete process.env[TOKEN_ENV];
  const { healthy, checks } = healthCheck({ session: { id: 1 }, loopLagMs: 0, maxLoopLagMs: 5000 });
  assert.strictEqual(healthy, false, "no token → unhealthy");
  assert.strictEqual(checks.token, false, "token check should fail");
  assert.strictEqual(checks.session, true, "session check should still pass");
}

function testHealthCheckUnhealthyLoopLag() {
  process.env[TOKEN_ENV] = "test-token";
  const { healthy, checks } = healthCheck({ session: { id: 1 }, loopLagMs: 9000, maxLoopLagMs: 5000 });
  assert.strictEqual(healthy, false, "lag over the max → unhealthy");
  assert.strictEqual(checks.eventLoop, false, "eventLoop check should fail when lag exceeds max");
}

// ─── shutdown ───────────────────────────────────────────────────────────────────

async function testShutdownClearsIntervalAndExits() {
  process.env[TOKEN_ENV] = "test-token";
  // Reset re-entrancy guard from any earlier test.
  conductor._resetForTest();

  let closed = 0;
  conductor._setSessionForTest({ close: () => { closed++; } });
  const interval = startHeartbeat(60_000); // a real timer we expect shutdown to clear
  assert.notStrictEqual(interval._destroyed, true, "precondition: interval is live");

  const exits = [];
  await shutdown({ exit: (code) => exits.push(code) });

  assert.deepStrictEqual(exits, [0], "shutdown should exit(0) exactly once");
  assert.strictEqual(closed, 1, "the session's close() should be awaited once");
  assert.strictEqual(conductor._getHeartbeatIntervalForTest(), null, "the heartbeat interval should be cleared to null");
}

async function testShutdownIsIdempotent() {
  process.env[TOKEN_ENV] = "test-token";
  conductor._resetForTest();
  conductor._setSessionForTest(null);
  startHeartbeat(60_000);

  const exits = [];
  const exit = (code) => exits.push(code);
  await shutdown({ exit });
  await shutdown({ exit }); // second call must be a guarded no-op

  assert.deepStrictEqual(exits, [0], "a re-entrant shutdown must exit only once");
}

// ─── main ───────────────────────────────────────────────────────────────────────

async function testMainInitsSessionAndHeartbeat() {
  process.env[TOKEN_ENV] = "test-token";
  process.env.CONDUCTOR_HEALTH_INTERVAL = "60000"; // slow tick so nothing fires mid-test
  conductor._resetForTest();

  let factoryCalls = 0;
  const fakeSession = { id: "mock" };
  await main({ sessionFactory: () => { factoryCalls++; return fakeSession; } });

  assert.strictEqual(factoryCalls, 1, "main must init the session via the injected factory");
  assert.strictEqual(conductor._getSessionForTest(), fakeSession, "the injected session should become the live session");
  assert.notStrictEqual(conductor._getHeartbeatIntervalForTest(), null, "main must schedule the heartbeat");

  // Clean up the timer main() started so the test process can exit.
  await shutdown({ exit: () => {} });
  delete process.env.CONDUCTOR_HEALTH_INTERVAL;
}

(async () => {
  await run("validateEnv throws when the OAuth token is missing", testValidateEnvThrowsWhenTokenMissing);
  await run("validateEnv passes when the OAuth token is present", testValidateEnvPassesWhenTokenPresent);
  await run("healthCheck reports healthy when session + token present and loop lag is low", testHealthCheckHealthyWhenAllGood);
  await run("healthCheck reports unhealthy when the SDK session is missing", testHealthCheckUnhealthyNoSession);
  await run("healthCheck reports unhealthy when the OAuth token is missing", testHealthCheckUnhealthyNoToken);
  await run("healthCheck reports unhealthy when event-loop lag exceeds the max", testHealthCheckUnhealthyLoopLag);
  await run("shutdown clears the heartbeat interval, tears down the session, and exits(0)", testShutdownClearsIntervalAndExits);
  await run("shutdown is idempotent — a second call exits only once", testShutdownIsIdempotent);
  await run("main initializes the session via the injected factory and schedules the heartbeat", testMainInitsSessionAndHeartbeat);

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exit(1);
})();
