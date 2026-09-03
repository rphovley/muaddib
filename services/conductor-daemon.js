#!/usr/bin/env node
"use strict";
// Conductor daemon — the process-lifecycle layer around a persistent, driveable
// `claude` session (orchestrator/conductor-session.js).
//
// The Conductor is a long-running, proactive reasoning agent independent of any
// Worker's fixed workflow lifecycle. It must stay on the Claude *subscription*
// (CLAUDE_CODE_OAUTH_TOKEN), not the separately-metered full-rate API — so it
// drives a real interactive `claude` CLI over tmux, exactly like Workers do,
// rather than the Agent SDK (which can't use that token). See muaddib#23 and the
// closed PR #82 for why the SDK approach was rejected.
//
// This is the SKELETON: start → stay-up → clean shutdown → cheap self-health
// check, plus the persistent session it manages. NO Fleet Control Surface tools
// are wired up (later milestone issues). The main loop is an indefinite idle
// heartbeat, not a fixed workflow.
//
// Start:  ./conductor.sh                 (foreground, bare idle daemon)
//         ./conductor.sh --bg            (background, bare idle daemon)
//         ./conductor.sh QUO-507         (start + feed QUO-507 as the initial prompt)
//         ./conductor.sh --bg QUO-507    (same, backgrounded)
// Send to a daemon that's already up (reuse the session, don't spawn a second):
//         node conductor-daemon.js --send QUO-507
// Stop:   ./conductor.sh --stop
//
// Required env: CLAUDE_CODE_OAUTH_TOKEN (subscription auth — hard requirement).
// Optional env: CONDUCTOR_SESSION_NAME (default 'conductor'),
//   CONDUCTOR_HEARTBEAT_MS (default 30000), CONDUCTOR_INITIAL_PROMPT (fallback
//   initial prompt when no argv is given), plus the CONDUCTOR_* session tunables
//   in orchestrator/conductor-session.js.

const { createConductorSession } = require("../orchestrator/conductor-session");
const { renderLiveFleetReport } = require("../orchestrator/fleet-report");

const HEARTBEAT_MS = parseInt(
  process.env.CONDUCTOR_HEARTBEAT_MS || "30000",
  10,
);

// The single session this daemon owns. Populated by main(); left null so the
// module is importable by tests (require() alone must not start anything).
let session = null;
let heartbeat = null;

function log(msg) {
  process.stdout.write(`[conductor-daemon] ${msg}\n`);
}

// ─── initial prompt resolution ──────────────────────────────────────────────────

// Resolve the daemon's initial prompt: the joined argv words if any, else the
// CONDUCTOR_INITIAL_PROMPT env fallback, else "" (bare idle daemon — no prompt).
// argv wins over the env fallback. A leading "/" is deliberately NOT special-cased
// here: sendPrompt() types the text verbatim into claude's TUI, which interprets a
// leading slash as a skill/slash command and plain text as a prompt — exactly the
// spawn-worker "the task arg becomes the initial prompt; a leading `/` runs a skill"
// convention. Exported as a test seam.
function resolveInitialPrompt(argv) {
  const joined = Array.isArray(argv) ? argv.join(" ").trim() : "";
  if (joined) return joined;
  return (process.env.CONDUCTOR_INITIAL_PROMPT || "").trim();
}

// ─── env validation ───────────────────────────────────────────────────────────

// The subscription token is the whole point of the CLI-driven design: without
// it the interactive `claude` either can't authenticate or silently lands on
// full-rate API billing. Fail fast at startup — a daemon launched
// non-interactively (reboot/launchd, no ~/.zshrc) inherits nothing, so this is
// a real failure mode. conductor.sh sources ~/.muaddib/conductor-secrets.env to
// supply it.
function validateEnv() {
  const missing = [];
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    missing.push("CLAUDE_CODE_OAUTH_TOKEN");
  }
  if (missing.length > 0) {
    throw new Error(`Missing required env: ${missing.join(", ")}`);
  }
}

// ─── health check ─────────────────────────────────────────────────────────────

// Cheap, process-level liveness only — deliberately NO model round-trip:
//   alive               — the daemon process is running (always true when called)
//   eventLoopResponsive — a setImmediate resolved, i.e. the loop isn't wedged
//   tokenPresent        — the subscription token is still in the environment
//   sessionAlive        — the tmux session (claude) is still up
// A caller can await it; the eventLoop probe is the only async part.
async function healthCheck() {
  const eventLoopResponsive = await new Promise((resolve) => {
    setImmediate(() => resolve(true));
  });
  return {
    alive: true,
    eventLoopResponsive,
    tokenPresent: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN),
    sessionAlive: Boolean(session && session.isAlive()),
  };
}

// ─── fleet report (Autonomy L0) ────────────────────────────────────────────────

// Produce the live, human-readable Fleet State report on request — the daemon's
// on-request read surface alongside healthCheck(). Autonomy L0 "reports, decides
// nothing": this is pure computation over the on-disk `.events` streams
// (orchestrator/fleet-report.js → fleet-state.js). It does NOT drive the tmux
// session, emit(), spawn, or tear anything down — deciding *when* the Conductor
// invokes it (a runtime-loop trigger) is a later milestone. Recomputed on every
// call, so it has no cache to go stale.
function reportFleetState() {
  return renderLiveFleetReport();
}

// ─── graceful shutdown ────────────────────────────────────────────────────────

function shutdown() {
  log("shutting down...");
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  if (session) {
    try {
      session.stop();
    } catch (err) {
      log(`session.stop error: ${err.message}`);
    }
  }
  process.exit(0);
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  validateEnv();

  session = createConductorSession();
  log(`starting conductor session '${session.name}'...`);
  session.start();
  log("conductor session ready");

  // Feed the initial prompt (a ticket ref, a task, or a `/skill` invocation)
  // into the freshly-ready session, if one was given. Fire-and-forget: we
  // sendPrompt() but deliberately do NOT ask()/readResponse() — the flow runs
  // autonomously inside the session, and the daemon must not block its heartbeat
  // reading a whole response back.
  const initialPrompt = resolveInitialPrompt(process.argv.slice(2));
  if (initialPrompt) {
    log(`sending initial prompt (${initialPrompt.length} chars)`);
    session.sendPrompt(initialPrompt);
  }

  // Install graceful signal handlers only now that startup is done. session.start()
  // blocks the event loop on synchronous tmux polls (Atomics.wait), so a JS
  // SIGTERM/SIGINT listener registered earlier could not run until start()
  // returned — deferring --stop by up to the ready timeout (~60s). Leaving the
  // default disposition in place during startup means a --stop then terminates
  // the process promptly instead.
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Indefinite idle loop — NOT a fixed workflow. The heartbeat both keeps the
  // event loop alive and periodically self-checks liveness. Fleet Control
  // Surface behavior (proactive reasoning, tool invocation) is a later issue;
  // the skeleton just stays up and observable.
  heartbeat = setInterval(() => {
    healthCheck()
      .then((h) => {
        if (!h.sessionAlive) {
          // Skeleton behavior: log and mark unhealthy. Auto-restart policy is
          // deferred to a later issue (a crashed session shouldn't be silently
          // resurrected before we've decided the restart semantics).
          log(
            "WARNING: conductor session is no longer alive (auto-restart is a TODO)",
          );
        }
      })
      .catch((err) => log(`heartbeat error: ${err.message}`));
  }, HEARTBEAT_MS);

  log(`ready — heartbeat every ${HEARTBEAT_MS}ms`);
}

module.exports = {
  validateEnv,
  healthCheck,
  reportFleetState,
  resolveInitialPrompt,
  shutdown,
  main,
  // Test seam: lets a test inject a mock session (or read the current one)
  // without starting the daemon.
  _setSession: (s) => {
    session = s;
  },
  _getSession: () => session,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === "--send") {
    // Reuse path: a daemon is already up, so instead of spawning a second one we
    // attach to the existing session (keyed on the same CONDUCTOR_SESSION_NAME,
    // per ConductorSession's idempotency) and type the prompt into it, then exit.
    // No heartbeat, no session ownership — this is a one-shot send.
    const prompt = resolveInitialPrompt(argv.slice(1));
    const existing = createConductorSession();
    try {
      // conductor.sh routes here on PID-file liveness (the daemon *process* is
      // up), but the prompt actually needs a live tmux *session*. A daemon whose
      // session crashed (auto-restart is still a TODO) has a live PID yet a dead
      // session — bailing here would silently drop the ticket. start() is
      // idempotent: a no-op when the session is already up, else a fresh launch
      // under the same session name (which the running daemon's heartbeat then
      // re-sees as alive), so the ticket lands either way.
      existing.start();
      // Wait out any in-flight turn before typing — a prompt injected mid-turn
      // is dropped or garbled by the TUI.
      existing.waitUntilIdle();
      existing.sendPrompt(prompt);
    } catch (err) {
      log(`FATAL: --send could not deliver to '${existing.name}': ${err.message}`);
      process.exit(1);
    }
    log(`sent prompt to '${existing.name}' (${prompt.length} chars)`);
    process.exit(0);
  }
  main().catch((err) => {
    log(`FATAL: ${err.message}`);
    process.exit(1);
  });
}
