#!/usr/bin/env node
"use strict";
// Conductor daemon — the fleet-level reasoning agent muaddib's README already
// anticipates (Decision Log, Session Context, conductor-secrets.env) but which
// nothing has instantiated until now. Built on the Claude Agent SDK, it runs as
// a long-lived, *harness-independent* process: unlike Workers (which stay on the
// Claude Code CLI), the Conductor must run with no Claude Code session at all.
//
// This is the process-lifecycle *skeleton* only — start, stay running,
// self-health-check, shut down cleanly. No Fleet Control Surface tools are wired
// up yet; those land in later milestone issues. The heartbeat deliberately does
// a *cheap process-level liveness* check and burns no tokens; a `deepHealthCheck`
// seam is left for a later issue to drop in a real SDK round-trip.
//
// Start:  ./conductor.sh          (foreground)
//         ./conductor.sh --bg     (background)
// Stop:   ./conductor.sh --stop
//
// Env:
//   CLAUDE_CODE_OAUTH_TOKEN     (required) account-level subscription token; the
//                               SDK authenticates with it. Same secret the
//                               dispatch daemon needs — lives in
//                               ~/.muaddib/conductor-secrets.env.
//   CONDUCTOR_HEALTH_INTERVAL   (optional) heartbeat interval in ms (default 30000).
//   CONDUCTOR_MAX_LOOP_LAG      (optional) max tolerated event-loop lag in ms
//                               before a heartbeat is reported unhealthy
//                               (default 5000).

// ─── config ───────────────────────────────────────────────────────────────────

const TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
const DEFAULT_HEALTH_INTERVAL_MS = 30_000;
const DEFAULT_MAX_LOOP_LAG_MS = 5_000;

function healthIntervalMs() {
  const n = parseInt(process.env.CONDUCTOR_HEALTH_INTERVAL || "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_HEALTH_INTERVAL_MS;
}

function maxLoopLagMs() {
  const n = parseInt(process.env.CONDUCTOR_MAX_LOOP_LAG || "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_LOOP_LAG_MS;
}

// ─── module state ───────────────────────────────────────────────────────────────
// Kept at module scope (like dispatch-daemon.js) so the signal handlers and the
// heartbeat can reach the live session + interval without threading them through.

let currentSession = null;
let heartbeatInterval = null;
// Event-loop lag observed at the last heartbeat tick — how much later than
// scheduled the timer actually fired. A responsive loop keeps this near zero; a
// starved/blocked one lets it grow, which healthCheck() flags.
let lastLoopLagMs = 0;
let shuttingDown = false;

function log(msg) {
  process.stdout.write(`[conductor] ${msg}\n`);
}

// ─── env validation ───────────────────────────────────────────────────────────

function validateEnv() {
  const missing = [];
  // The SDK authenticates against the account subscription with this token. A
  // Conductor started non-interactively (reboot / launchd / cron) inherits no
  // ~/.zshrc exports, so fail fast at startup rather than deep inside the first
  // SDK call. conductor.sh sources ~/.muaddib/conductor-secrets.env to supply it.
  if (!process.env[TOKEN_ENV]) missing.push(TOKEN_ENV);
  if (missing.length > 0)
    throw new Error(`Missing required env: ${missing.join(", ")}`);
}

// ─── SDK session ────────────────────────────────────────────────────────────────
// The default factory pulls in the Claude Agent SDK. It's require()'d lazily
// (inside the factory, not at module load) so this module stays importable in
// tests — which inject a mock factory — without the SDK installed, and so a
// missing dependency surfaces as a clean startup error, not a require-time throw.

function createSdkSession() {
  const sdk = require("@anthropic-ai/claude-agent-sdk");
  return { sdk, createdAt: Date.now() };
}

function initSession(sessionFactory) {
  const factory = sessionFactory || createSdkSession;
  currentSession = factory();
  return currentSession;
}

// ─── health check ───────────────────────────────────────────────────────────────
// Cheap, synchronous, process-level liveness only — burns no tokens, so it's safe
// to run on every heartbeat and stays offline-testable. All inputs default to the
// live module state but are overridable so tests can exercise each failure mode.

function healthCheck(opts = {}) {
  const session = "session" in opts ? opts.session : currentSession;
  const loopLagMs = "loopLagMs" in opts ? opts.loopLagMs : lastLoopLagMs;
  const maxLagMs = "maxLoopLagMs" in opts ? opts.maxLoopLagMs : maxLoopLagMs();

  const checks = {
    process: process.pid > 0, // we are a live OS process
    eventLoop: loopLagMs <= maxLagMs, // the timer loop isn't starved
    token: Boolean(process.env[TOKEN_ENV]), // the SDK can still authenticate
    session: Boolean(session), // an SDK session object exists
  };
  const healthy = Object.values(checks).every(Boolean);
  return { healthy, checks };
}

// SEAM — deliberately a no-op stub in the skeleton. A later milestone issue drops
// a real SDK round-trip in here (a cheap ping / model call) to confirm end-to-end
// reachability, and wires it into the heartbeat behind an opt-in env flag so the
// default loop keeps burning zero tokens. Kept async so that future body needs no
// signature change and no rework of the heartbeat loop that may await it.
async function deepHealthCheck(session = currentSession) {
  return { performed: false, reason: "deep health check not implemented (skeleton)", session: Boolean(session) };
}

// ─── heartbeat ──────────────────────────────────────────────────────────────────

function heartbeat() {
  const { healthy, checks } = healthCheck();
  if (healthy) {
    log(`heartbeat ok (loop lag ${lastLoopLagMs}ms)`);
  } else {
    const failed = Object.entries(checks)
      .filter(([, ok]) => !ok)
      .map(([name]) => name)
      .join(", ");
    log(`heartbeat UNHEALTHY — failing checks: ${failed}`);
  }
  return healthy;
}

function startHeartbeat(intervalMs) {
  const interval = intervalMs || healthIntervalMs();
  // Track the scheduled fire time so each tick can measure how late it actually
  // ran — that lateness is our event-loop-lag signal.
  let expected = Date.now() + interval;
  heartbeatInterval = setInterval(() => {
    const now = Date.now();
    lastLoopLagMs = Math.max(0, now - expected);
    expected = now + interval;
    heartbeat();
  }, interval);
  // Do NOT unref — the heartbeat is what keeps this daemon alive.
  return heartbeatInterval;
}

// ─── graceful shutdown ────────────────────────────────────────────────────────
// Idempotent + re-entrancy-guarded like dispatch-daemon.shutdown(): clears the
// heartbeat, tears down the SDK session, then exits. `exit` is injectable so
// tests can assert teardown without killing the test process.

async function shutdown({ exit = process.exit } = {}) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutting down...");
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  if (currentSession) {
    // The skeleton session has nothing to close, but a later SDK session may —
    // call close() best-effort if it exists so this needs no rework then.
    try {
      if (typeof currentSession.close === "function") await currentSession.close();
    } catch (err) {
      log(`session teardown error: ${err.message}`);
    }
    currentSession = null;
  }
  exit(0);
}

process.on("SIGTERM", () => shutdown());
process.on("SIGINT", () => shutdown());

// ─── main ─────────────────────────────────────────────────────────────────────

async function main({ sessionFactory } = {}) {
  validateEnv();
  initSession(sessionFactory);
  log("SDK session initialized");
  startHeartbeat();
  log(`ready — heartbeat every ${healthIntervalMs()}ms`);
}

// ─── test seams ─────────────────────────────────────────────────────────────
// Exposed only for the unit suite (services/__tests__/test-conductor.js), which
// drives shutdown/heartbeat teardown with a mock session and no live SDK. Not
// part of the daemon's runtime surface — nothing in production calls these.

function _resetForTest() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  currentSession = null;
  lastLoopLagMs = 0;
  shuttingDown = false;
}
function _setSessionForTest(s) {
  currentSession = s;
}
function _getSessionForTest() {
  return currentSession;
}
function _getHeartbeatIntervalForTest() {
  return heartbeatInterval;
}

module.exports = {
  validateEnv,
  createSdkSession,
  initSession,
  healthCheck,
  deepHealthCheck,
  heartbeat,
  startHeartbeat,
  shutdown,
  main,
  _resetForTest,
  _setSessionForTest,
  _getSessionForTest,
  _getHeartbeatIntervalForTest,
};

if (require.main === module) {
  main().catch((err) => {
    log(`FATAL: ${err.message}`);
    process.exit(1);
  });
}
