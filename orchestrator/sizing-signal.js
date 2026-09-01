'use strict';
// Sizing Signal — the Conductor's discovery-and-contract boundary for asking a
// consuming project "how big is this backlog ticket?" (muaddib#30).
//
// SCOPE: this module only *obtains* the signal and surfaces it as information.
// Deciding what to DO with it (split a ticket, escalate autonomy, gate a
// dispatch) is explicitly a later Raise-Autonomy milestone and is NOT here.
//
// DESIGN PRINCIPLE — generic core, project hooks do the work (Tier 3): muaddib
// never contains sizing logic of its own. A consuming project that wants sizing
// implements the well-known hook `.muaddib/hooks/sizing(.js|.sh)` and owns it
// entirely — same convention as `.muaddib/hooks/on-servers-start` discovered by
// services/start-servers.js#findServersHook. "No hook configured" is a
// first-class, non-error state: muaddib's OWN self-hosting has no such hook and
// must keep working, so computeSizingSignal resolves { configured: false }
// there rather than throwing. A *misbehaving* configured hook (non-zero exit,
// unparseable stdout, or a payload that violates the contract) is a genuine
// error and rejects — distinct from "not configured".
//
// The hook receives the ticket ID as its sole positional argument — a .sh hook
// reads it at $1, a .js hook at process.argv[2] (spawned as `node hookPath
// ticketId`) — plus, portably regardless of runtime, env MUADDIB_TICKET_ID. It
// is expected to print, on stdout, a JSON object:
//   { size, confidence, recommendSplit, blockingQuestions? }
// See validateSignal below for the exact contract.

const fs = require('fs');
const path = require('path');
const { spawn: spawnChild } = require('child_process');

// repoDir default mirrors services/start-servers.js: REPO_DIR env, else the
// canonical worker checkout. The hook lives under the *consuming project's*
// .muaddib/ (REPO/.muaddib/hooks), exactly like on-servers-start — so this
// resolves against repoDir directly, not the (possibly nested) muaddib root.
const DEFAULT_REPO_DIR = process.env.REPO_DIR || '/home/worker/repo';

const VALID_SIZES = ['XS', 'S', 'M', 'L', 'XL'];
const VALID_CONFIDENCE = ['low', 'medium', 'high'];

// A configured hook may shell out to an LLM, so allow real time — but bound it.
// Without a ceiling, a hung hook (a stalled model call, or a backgrounded
// subshell that keeps our stdout fd open so 'close' never fires) leaves the
// promise pending forever and wedges the Conductor heartbeat this whole async
// design exists to protect. Callers can override via opts.timeoutMs.
const DEFAULT_HOOK_TIMEOUT_MS = 120000;

// Well-known hook discovery — mirrors findServersHook exactly: check .js first,
// then .sh, return the path or null when neither is present.
function findSizingHook(repoDir) {
  for (const ext of ['.js', '.sh']) {
    const p = path.join(repoDir, '.muaddib', 'hooks', `sizing${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Run the sizing hook as an async child process, collecting stdout/stderr.
// Exit-code contract copied from fleet-control.js#runScript: resolve
// { stdout, stderr } on exit 0; reject (stderr surfaced) on a non-zero exit or
// a spawn error. Async because a real hook may shell out to an LLM and take a
// while — a synchronous wrapper would wedge the Conductor's heartbeat.
function runHook(hookPath, ticketId, env, cwd, timeoutMs) {
  // Runtime by extension, same rule as start-servers.js: node for .js, bash
  // for everything else (.sh and any other executable script form).
  const runtime = hookPath.endsWith('.js') ? 'node' : 'bash';
  return new Promise((resolve, reject) => {
    const child = spawnChild(runtime, [hookPath, ticketId], {
      env: { ...env, MUADDIB_TICKET_ID: ticketId },
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;

    // Single settle point so the timeout and the child's own close/error can
    // never double-resolve, and the timer is always cleared.
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(arg);
    };

    // Bound the wait: kill the child and reject if it overruns. This also caps
    // the 'close'-never-fires case where a backgrounded grandchild keeps our
    // stdout fd open — we reject regardless, freeing the Conductor heartbeat.
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        settle(
          reject,
          new Error(`${path.basename(hookPath)} timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);
      if (timer.unref) timer.unref();
    }

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.once('error', (err) => {
      settle(
        reject,
        new Error(`${path.basename(hookPath)} failed to spawn: ${err.message}`),
      );
    });

    // 'close' (not fleet-control's 'exit'): a sizing hook is a plain compute-
    // and-print process with no disowned background subshell leaking our fds,
    // so 'close' fires promptly AND guarantees stdout is fully drained before
    // we JSON.parse it — 'exit' can fire before the last stdout chunk arrives.
    child.once('close', (code) => {
      if (code === 0) {
        settle(resolve, { stdout, stderr });
        return;
      }
      const detail = stderr.trim() || stdout.trim() || '(no output)';
      settle(
        reject,
        new Error(
          `${path.basename(hookPath)} exited with code ${code}: ${detail}`,
        ),
      );
    });
  });
}

// Validate + normalize the hook's payload into the exact contract shape.
// Throws on any contract violation (the caller turns that into a rejection).
// Extra keys are dropped so the returned signal is exactly the contract — the
// Conductor never sees hook-internal fields. `confidence` is captured VERBATIM
// (validated against the allowed set as-is, never lower-cased or remapped)
// because it will later feed L3's escalation threshold directly.
function validateSignal(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('sizing signal must be a JSON object');
  }

  const { size, confidence, recommendSplit, blockingQuestions } = raw;

  if (!VALID_SIZES.includes(size)) {
    throw new Error(
      `sizing signal "size" must be one of ${VALID_SIZES.join(', ')}, got: ${JSON.stringify(size)}`,
    );
  }
  if (!VALID_CONFIDENCE.includes(confidence)) {
    throw new Error(
      `sizing signal "confidence" must be one of ${VALID_CONFIDENCE.join(', ')}, got: ${JSON.stringify(confidence)}`,
    );
  }
  if (typeof recommendSplit !== 'boolean') {
    throw new Error(
      `sizing signal "recommendSplit" must be a boolean, got: ${JSON.stringify(recommendSplit)}`,
    );
  }

  const signal = { size, confidence, recommendSplit };

  if (blockingQuestions !== undefined) {
    if (
      !Array.isArray(blockingQuestions) ||
      !blockingQuestions.every((q) => typeof q === 'string')
    ) {
      throw new Error(
        `sizing signal "blockingQuestions" must be an array of strings, got: ${JSON.stringify(blockingQuestions)}`,
      );
    }
    signal.blockingQuestions = blockingQuestions;
  }

  return signal;
}

// computeSizingSignal(ticketId, { hookPath, env, cwd, repoDir })
// Discover the project's sizing hook and, if present, call it with just the
// ticket ID.
//   - Resolves { configured: false } when no hook exists — NOT an error; this
//     is muaddib self-hosting's steady state.
//   - Resolves { configured: true, signal: {...} } when the hook exits 0 and
//     its stdout JSON validates against the contract.
//   - Rejects on genuine failure only: a non-zero hook exit (stderr surfaced),
//     unparseable stdout, or a contract-validation failure. A misbehaving
//     configured hook is a real error, distinct from "not configured".
// opts.hookPath lets a caller (tests) point at a deterministic fake hook with
// no real project mechanism present; opts.env/cwd/repoDir are injectable too.
function computeSizingSignal(ticketId, opts = {}) {
  if (typeof ticketId !== 'string' || ticketId.trim() === '') {
    return Promise.reject(
      new Error(`ticketId must be a non-empty string, got: ${JSON.stringify(ticketId)}`),
    );
  }

  const repoDir = opts.repoDir || DEFAULT_REPO_DIR;
  const hookPath = opts.hookPath || findSizingHook(repoDir);

  if (!hookPath) {
    return Promise.resolve({ configured: false });
  }

  const env = opts.env || process.env;
  const cwd = opts.cwd || repoDir;
  const timeoutMs =
    opts.timeoutMs === undefined ? DEFAULT_HOOK_TIMEOUT_MS : opts.timeoutMs;

  return runHook(hookPath, ticketId, env, cwd, timeoutMs).then(({ stdout }) => {
    let raw;
    try {
      raw = JSON.parse(stdout);
    } catch (err) {
      throw new Error(
        `sizing hook ${path.basename(hookPath)} produced unparseable stdout: ${err.message}`,
      );
    }
    return { configured: true, signal: validateSignal(raw) };
  });
}

// Factory mirror of createFleetControl: baked-in defaults (hookPath/env/cwd/
// repoDir) merged under each call's own opts, so the Conductor can construct
// one configured surface. env is a map, so merge it rather than letting a
// per-call env var replace the whole baked-in env (same reasoning as
// createFleetControl#merge).
function createSizingSignal(defaults = {}) {
  const merge = (opts) => {
    const merged = { ...defaults, ...opts };
    if (defaults.env || opts.env) {
      merged.env = { ...defaults.env, ...opts.env };
    }
    return merged;
  };
  return {
    computeSizingSignal: (ticketId, opts = {}) =>
      computeSizingSignal(ticketId, merge(opts)),
  };
}

module.exports = {
  findSizingHook,
  computeSizingSignal,
  createSizingSignal,
  validateSignal,
  VALID_SIZES,
  VALID_CONFIDENCE,
};
