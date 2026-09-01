'use strict';
// Fleet Control Surface tool: send-input.
//
// A thin, independently-testable wrapper the long-running Conductor
// (orchestrator/conductor-session.js, services/conductor-daemon.js) calls to
// type a line of input into a specified running Worker's interactive `claude`
// session. It reuses the *existing* interaction mechanism — no new transport:
//
//   - Container resolution is the SAME `docker ps` compose-label filter
//     bin/attach.sh uses to find a worker's container.
//   - Input is delivered with the SAME `docker exec <cid> tmux send-keys`
//     primitive orchestrator/job.js (auto-accept) and conductor-session.js
//     (sendPrompt) already use — including conductor-session's line-splitting:
//     `-l <line>` per line, a soft newline (`M-Enter`) between lines so a
//     multi-line message isn't submitted early, and a final bare `Enter` to
//     submit.
//
// Deliberately send-only and Conductor-agnostic (per the skeleton comments in
// conductor-session.js): deciding *when/what* to send, auto-restart, and
// reading the worker's response back are separate, later tools.
//
// Every child process goes through an injectable `run` seam (default
// child_process.spawnSync), so the tool is unit-testable with no docker, no
// live worker, and no tmux — the test asserts the exact argv sequence.

const { spawnSync } = require('child_process');

// Synchronous sleep — the whole tool is spawnSync-based, so blocking here is
// intentional (mirrors conductor-session.js's msleep). Used to let the literal
// `-l` text be ingested by the TUI before the final submitting Enter.
function msleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

// Default process runner. capture:true pipes stdout so container resolution can
// read the id; otherwise stdout is discarded and only stderr is captured for
// error messages. No shell — args are passed as an array, so worker/text values
// can never be interpreted as shell syntax.
function defaultRun(file, args, { capture = false } = {}) {
  return spawnSync(file, args, {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'pipe'],
  });
}

// A worker index is a non-negative integer — it becomes both the compose
// project suffix (`-w${N}`) and the tmux session name (`w${N}`). Reject anything
// else with a clear error rather than letting a bogus value produce a confusing
// "not running" down the line.
function normalizeWorker(worker) {
  const s = String(worker);
  if (!/^\d+$/.test(s)) {
    throw new Error(`WorkerInput: invalid worker ${JSON.stringify(worker)} — expected a non-negative integer`);
  }
  return s;
}

class WorkerInput {
  constructor(opts = {}) {
    // Injectable process runner (default: real spawnSync) — the test seam.
    this.run = opts.run || defaultRun;
    // The compose project name attach.sh filters on; present in the
    // fleet/conductor env. Explicit opt wins for tests.
    this.projectName =
      opts.projectName !== undefined
        ? opts.projectName
        : process.env.MUADDIB_PROJECT_NAME;
  }

  // Resolve a worker's running container id with the exact filter attach.sh
  // uses. Throws a clear "worker N is not running" when nothing matches —
  // mirroring attach.sh's message.
  _resolveContainer(worker) {
    if (!this.projectName) {
      throw new Error(
        'WorkerInput: MUADDIB_PROJECT_NAME is not set — cannot resolve the worker container',
      );
    }
    const r = this.run(
      'docker',
      [
        'ps',
        '-q',
        '--filter',
        `label=com.docker.compose.project=${this.projectName}-w${worker}`,
        '--filter',
        'name=worker',
      ],
      { capture: true },
    );
    if (r.error) {
      throw new Error(`WorkerInput: docker ps failed while resolving worker ${worker}: ${r.error.message}`);
    }
    if (r.status !== 0) {
      const err = r.stderr ? String(r.stderr).trim() : 'unknown';
      throw new Error(`WorkerInput: docker ps failed while resolving worker ${worker}: ${err}`);
    }
    const cid = String(r.stdout || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)[0];
    if (!cid) {
      throw new Error(`worker ${worker} is not running`);
    }
    return cid;
  }

  // Type `text` into worker N's interactive claude session and submit it.
  // Returns { worker, container, ok }; throws on resolution or exec failure.
  sendInput(worker, text) {
    const n = normalizeWorker(worker);
    const container = this._resolveContainer(n);
    const session = `w${n}`;

    // One `docker exec <cid> tmux send-keys -t w${N} <keyArgs...>` round-trip.
    const sendKeys = (...keyArgs) => {
      const r = this.run('docker', ['exec', container, 'tmux', 'send-keys', '-t', session, ...keyArgs], {});
      if (r.error) {
        throw new Error(`WorkerInput: tmux send-keys failed for worker ${n}: ${r.error.message}`);
      }
      if (r.status !== 0) {
        const err = r.stderr ? String(r.stderr).trim() : 'unknown';
        throw new Error(`WorkerInput: tmux send-keys failed for worker ${n}: ${err}`);
      }
    };

    // Mirror conductor-session.js.sendPrompt: `-l` sends the text literally (no
    // key-name interpretation); split on newlines (tolerating CRLF bodies so no
    // trailing '\r' rides along per line) and insert a soft newline (M-Enter)
    // between lines so an embedded '\n' doesn't reach the TUI as Enter and submit
    // the prompt early. `--` ends option parsing so a line that starts with '-'
    // is treated as literal text, not a send-keys flag. A single Enter at the
    // end submits the whole thing.
    const lines = String(text).split(/\r?\n/);
    let sentAny = false;
    lines.forEach((line, i) => {
      if (i > 0) sendKeys('M-Enter');
      if (line) {
        sendKeys('-l', '--', line);
        sentAny = true;
      }
    });
    // Guard: never send a bare submitting Enter for empty input. Settle briefly
    // so the -l text is ingested before Enter submits it.
    if (sentAny) {
      msleep(100);
      sendKeys('Enter');
    }

    return { worker: n, container, ok: true };
  }
}

// Factory mirror of the class, matching conductor-session.js's "class +
// factory" convention.
function createWorkerInput(opts) {
  return new WorkerInput(opts);
}

// One-shot convenience: construct and send in a single call.
function sendInput(worker, text, opts = {}) {
  return new WorkerInput(opts).sendInput(worker, text);
}

module.exports = { WorkerInput, createWorkerInput, sendInput, normalizeWorker };
