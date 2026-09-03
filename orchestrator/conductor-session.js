'use strict';
// Persistent, programmatically-driven interactive `claude` session driver.
//
// The Conductor is a long-running reasoning agent that must stay on the Claude
// *subscription* (authenticated via CLAUDE_CODE_OAUTH_TOKEN), not the separately
// metered full-rate API. The Agent SDK can't use that token, so — exactly like
// the Workers already do (see worker-entrypoint.sh interactive mode + job.js) —
// we drive a real interactive `claude` CLI inside a tmux session: send a prompt
// with `send-keys`, read the answer back with `capture-pane`. Same auth, same
// billing, no model round-trip needed to know when it's done (idle-settle on the
// captured pane).
//
// This is the SKELETON: process lifecycle + a driveable session. No Fleet
// Control Surface tools are wired up here — those are later milestone issues.
//
// Public surface (all synchronous — every step is a spawnSync tmux call):
//   start()                       — launch `claude <permFlag>`, auto-accept the
//                                    --dangerously-skip-permissions disclaimer,
//                                    wait until the input box is ready.
//   sendPrompt(text)              — type text, then Enter.
//   readResponse({settleMs,...})  — poll capture-pane until the pane is stable
//                                    and idle, return the newly-rendered text.
//   ask(text, opts)               — sendPrompt + readResponse.
//   isAlive()                     — tmux has-session (claude still running).
//   stop()                        — tmux kill-session.

const { spawnSync } = require('child_process');
const path = require('path');

// Mirror runner.js/worker-entrypoint.sh: bypassPermissions → the skip flag,
// anything else → an explicit --permission-mode. Kept identical so the Conductor
// launches claude the same way Workers do.
function permFlag() {
  const p = process.env.CLAUDE_PERMISSION_MODE || 'bypassPermissions';
  return p === 'bypassPermissions'
    ? '--dangerously-skip-permissions'
    : `--permission-mode ${p}`;
}

// The Conductor-owned skill set lives at <repo>/conductor as a minimal Claude
// Code plugin (conductor/.claude-plugin/plugin.json + conductor/skills/*). It is
// deliberately SEPARATE from the worker-baked claude/skills/* — those are COPYed
// into the worker image and only exist inside worker containers, whereas the
// Conductor runs on the host. We load it with `--plugin-dir` (not a project-local
// .claude/skills/ at cwd) so the skills scope to the Conductor's own session
// only: a human running plain `claude` in the repo root does NOT pick them up,
// and no copy/symlink staging step is needed. Absolute + cwd-independent so it
// resolves however the daemon is launched. Verified against claude 2.1.x:
// `claude plugin validate` recognizes the manifest and both skills.
function conductorPluginDir() {
  return path.resolve(__dirname, '..', 'conductor');
}

// Synchronous sleep — the whole driver is spawnSync-based, so blocking the
// event loop here is intentional (and lets ask() stay a plain synchronous call).
function msleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

// Working-state markers claude's TUI renders while a turn is in flight. Their
// absence (plus a stable pane) is how we know the response has finished without
// asking the model anything.
const WORKING_MARKERS = [/esc to interrupt/i];

function paneIsIdle(pane) {
  return !WORKING_MARKERS.some((re) => re.test(pane));
}

class ConductorSession {
  constructor(opts = {}) {
    this.name =
      opts.name || process.env.CONDUCTOR_SESSION_NAME || 'conductor';
    // How long the pane must be unchanged before we call the turn settled.
    this.settleMs = intOpt(opts.settleMs, process.env.CONDUCTOR_SETTLE_MS, 1500);
    // Hard cap on a single readResponse.
    this.timeoutMs = intOpt(
      opts.timeoutMs,
      process.env.CONDUCTOR_TIMEOUT_MS,
      120000,
    );
    // Capture-pane poll cadence.
    this.pollMs = intOpt(opts.pollMs, process.env.CONDUCTOR_POLL_MS, 500);
    // How long readResponse will wait for claude's working spinner to appear
    // before treating an idle+stable pane as a finished (instantaneous) turn.
    // Guards against settling on the bare echoed prompt before the turn starts.
    this.busyGraceMs = intOpt(
      opts.busyGraceMs,
      process.env.CONDUCTOR_BUSY_GRACE_MS,
      this.settleMs,
    );
    // How long start() waits for the input box to come up.
    this.readyTimeoutMs = intOpt(
      opts.readyTimeoutMs,
      process.env.CONDUCTOR_READY_TIMEOUT_MS,
      60000,
    );
    // The `claude` invocation — overridable for tests (e.g. a fake CLI). The
    // default loads the Conductor's own skill set via --plugin-dir (see
    // conductorPluginDir); the path is single-quoted because claudeCmd is handed
    // to `tmux new-session` as one string and re-parsed by the shell.
    this.claudeCmd =
      opts.claudeCmd ||
      `claude ${permFlag()} --plugin-dir '${conductorPluginDir()}'`;
    // Pane snapshot taken just before the last sendPrompt, so readResponse can
    // diff it out and return only the newly-rendered text.
    this._preSnapshot = '';
  }

  // ─── tmux primitives ─────────────────────────────────────────────────────

  _tmux(args, { capture = false } = {}) {
    return spawnSync('tmux', args, {
      encoding: 'utf8',
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'ignore',
    });
  }

  _capture() {
    const r = this._tmux(['capture-pane', '-t', this.name, '-p'], {
      capture: true,
    });
    return r.status === 0 && r.stdout ? r.stdout : '';
  }

  // ─── lifecycle ───────────────────────────────────────────────────────────

  isAlive() {
    return this._tmux(['has-session', '-t', this.name]).status === 0;
  }

  // Launch claude in a detached tmux session, accept the disclaimer if shown,
  // and block until the input box is ready. Idempotent: a no-op if already up.
  start() {
    if (this.isAlive()) return this;

    const r = this._tmux(['new-session', '-d', '-s', this.name, this.claudeCmd]);
    if (r.status !== 0) {
      const err = r.stderr ? String(r.stderr).trim() : 'unknown';
      throw new Error(`ConductorSession.start: tmux new-session failed: ${err}`);
    }

    this._waitForReady();
    // Snapshot the idle box so the first readResponse has a baseline to diff.
    this._preSnapshot = this._capture();
    return this;
  }

  // Single-shot: if claude's --dangerously-skip-permissions disclaimer is on
  // screen, accept it (Down → Enter) and return true; otherwise return false.
  // Kept single-shot (not a blocking loop) so a session that never shows the
  // disclaimer doesn't stall start() — _waitForReady drives the polling and
  // calls this each tick, mirroring job.js's background auto-accept.
  _maybeAcceptDisclaimer(pane) {
    if (!/Yes, I accept/i.test(pane)) return false;
    this._tmux(['send-keys', '-t', this.name, 'Down']);
    msleep(300);
    this._tmux(['send-keys', '-t', this.name, 'Enter']);
    return true;
  }

  // Block until the input box is up and idle (the disclaimer is gone and the
  // pane has stopped churning), or throw on timeout.
  _waitForReady() {
    const deadline = Date.now() + this.readyTimeoutMs;
    let last = null;
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      if (!this.isAlive()) {
        throw new Error(
          'ConductorSession.start: claude session exited before it became ready',
        );
      }
      const pane = this._capture();
      if (this._maybeAcceptDisclaimer(pane)) {
        // Disclaimer was showing and we just accepted it — reset the stability
        // window so the post-accept redraw has to settle before we call ready.
        last = null;
        stableSince = Date.now();
      } else if (pane === last) {
        if (paneIsIdle(pane) && Date.now() - stableSince >= this.settleMs) {
          return;
        }
      } else {
        last = pane;
        stableSince = Date.now();
      }
      msleep(this.pollMs);
    }
    throw new Error(
      `ConductorSession.start: input box not ready within ${this.readyTimeoutMs}ms`,
    );
  }

  stop() {
    this._tmux(['kill-session', '-t', this.name]);
    return this;
  }

  // ─── prompt / response ───────────────────────────────────────────────────

  // Block until claude has finished any in-flight turn: the pane shows no
  // working marker and has stayed unchanged for settleMs. A prompt typed into a
  // session that's still mid-turn is dropped or garbled by the TUI, so a caller
  // reusing a session that may already be busy (e.g. the daemon's --send reuse
  // path) waits this out first. Returns this once idle; throws on a dead session
  // or timeout.
  waitUntilIdle(opts = {}) {
    const settleMs = intOpt(opts.settleMs, null, this.settleMs);
    const timeoutMs = intOpt(opts.timeoutMs, null, this.timeoutMs);
    const pollMs = intOpt(opts.pollMs, null, this.pollMs);

    const deadline = Date.now() + timeoutMs;
    let last = null;
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      if (!this.isAlive()) {
        throw new Error('ConductorSession.waitUntilIdle: session is not alive');
      }
      const pane = this._capture();
      if (pane === last) {
        if (paneIsIdle(pane) && Date.now() - stableSince >= settleMs) {
          return this;
        }
      } else {
        last = pane;
        stableSince = Date.now();
      }
      msleep(pollMs);
    }
    throw new Error(
      `ConductorSession.waitUntilIdle: pane still busy after ${timeoutMs}ms`,
    );
  }

  // Type text literally, then submit with Enter. Records a pre-prompt snapshot
  // so readResponse can diff against it.
  sendPrompt(text) {
    if (!this.isAlive()) {
      throw new Error('ConductorSession.sendPrompt: session is not alive');
    }
    this._preSnapshot = this._capture();
    // -l sends the text literally (no key-name interpretation). Split on
    // newlines and send each line separately, inserting a soft newline
    // (M-Enter) between lines — an embedded '\n' passed straight to send-keys
    // reaches the TUI as Enter and would submit the prompt early, truncating a
    // multi-line message. A single Enter at the end submits the whole thing.
    const lines = String(text).split('\n');
    lines.forEach((line, i) => {
      if (i > 0) this._tmux(['send-keys', '-t', this.name, 'M-Enter']);
      if (line) this._tmux(['send-keys', '-t', this.name, '-l', line]);
    });
    msleep(100);
    this._tmux(['send-keys', '-t', this.name, 'Enter']);
    return this;
  }

  // Poll capture-pane until the pane content is stable for settleMs AND the box
  // is idle again (claude finished), then return the newly-rendered text
  // (diffed against the pre-prompt snapshot). No model round-trip.
  readResponse(opts = {}) {
    const settleMs = intOpt(opts.settleMs, null, this.settleMs);
    const timeoutMs = intOpt(opts.timeoutMs, null, this.timeoutMs);
    const pollMs = intOpt(opts.pollMs, null, this.pollMs);
    const busyGraceMs = intOpt(opts.busyGraceMs, null, this.busyGraceMs);

    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let last = null;
    let stableSince = Date.now();
    let settled = null;
    // Only accept an idle-settle once we've actually seen the pane go busy
    // (claude's spinner rendered), or the busy-grace window has elapsed (a turn
    // that finished before the spinner ever appeared). Without this the very
    // first poll can catch the just-echoed prompt — stable and not yet busy —
    // and return it as if it were the answer.
    let sawBusy = false;

    while (Date.now() < deadline) {
      if (!this.isAlive()) {
        throw new Error(
          'ConductorSession.readResponse: session died while awaiting a response',
        );
      }
      const pane = this._capture();
      if (!paneIsIdle(pane)) sawBusy = true;
      if (pane === last) {
        if (
          paneIsIdle(pane) &&
          Date.now() - stableSince >= settleMs &&
          (sawBusy || Date.now() - startedAt >= busyGraceMs)
        ) {
          settled = pane;
          break;
        }
      } else {
        last = pane;
        stableSince = Date.now();
      }
      msleep(pollMs);
    }

    if (settled === null) {
      throw new Error(
        `ConductorSession.readResponse: no settled response within ${timeoutMs}ms`,
      );
    }
    return diffPane(this._preSnapshot, settled);
  }

  ask(text, opts = {}) {
    this.sendPrompt(text);
    return this.readResponse(opts);
  }
}

// The newly-rendered region of the pane (echoed prompt + claude's answer), with
// blank lines dropped. Line-based rather than character-based because the TUI
// redraws whole lines. Strips the unchanged top (chrome/scrollback) and the
// unchanged bottom (the persistent input box) common to both snapshots and
// returns what's left in between — a prefix/suffix diff rather than global
// set-membership, so a short answer line that happens to equal some unrelated
// chrome line elsewhere on screen isn't silently dropped.
function diffPane(before, after) {
  const b = String(before).split('\n');
  const a = String(after).split('\n');
  const eq = (x, y) => (x || '').trim() === (y || '').trim();

  let start = 0;
  while (start < a.length && start < b.length && eq(a[start], b[start])) {
    start += 1;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && eq(a[endA - 1], b[endB - 1])) {
    endA -= 1;
    endB -= 1;
  }
  return a
    .slice(start, endA)
    .filter((l) => l.trim())
    .join('\n')
    .trim();
}

// opt (explicit arg) > envVal > fallback, all coerced to a base-10 int.
function intOpt(opt, envVal, fallback) {
  if (opt !== undefined && opt !== null && opt !== '') {
    const n = parseInt(opt, 10);
    if (!Number.isNaN(n)) return n;
  }
  if (envVal !== undefined && envVal !== null && envVal !== '') {
    const n = parseInt(envVal, 10);
    if (!Number.isNaN(n)) return n;
  }
  return fallback;
}

// Factory mirror of the class, matching the "class + factory" convention the
// plan calls for (and how services/*.js tend to construct their collaborators).
function createConductorSession(opts) {
  return new ConductorSession(opts);
}

module.exports = {
  ConductorSession,
  createConductorSession,
  permFlag,
  conductorPluginDir,
};
