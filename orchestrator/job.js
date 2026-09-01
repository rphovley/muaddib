'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { emit } = require('./events');
const { resolveMuaddibRoot } = require('./muaddib-root');

const REPO = process.env.REPO_DIR || '/home/worker/repo';
const MUADDIB_ROOT = resolveMuaddibRoot(REPO);
const EMIT_CLI = path.join(MUADDIB_ROOT, 'orchestrator/emit-cli.js');

// Spawn a named tmux window running `cmd`. Wraps the command so it emits a
// done (exit 0) or failed (exit N) event when the process finishes.
// Also emits started immediately.
// extraEnv: optional {KEY: value} pairs exported into the wrapper before cmd runs.
// opts.logFile: redirect the command's stdout+stderr to this path (for services).
//   Leave unset for claude-tui steps — the TUI renders to the terminal directly.
function startJob(worker, name, cmd, extraEnv = {}, opts = {}) {
  const session = `w${worker}`;
  const wrapperPath = `/tmp/job-${worker}-${name}.sh`;
  const agentStatusDir = process.env.AGENT_STATUS_DIR || '/var/run/agent-status';

  const extraExports = Object.entries(extraEnv)
    .map(([k, v]) => `export ${k}=${JSON.stringify(String(v))}`)
    .join('\n');

  // Export AGENT_STATUS_DIR so emit-cli.js inside the wrapper uses the same dir.
  // Run the command in a subshell so that `exit N` inside the command does not
  // kill the wrapper before the emit-cli call can record the exit code.
  const doneFile = `/tmp/step-done-${worker}-${name}`;
  const failedFile = `/tmp/step-failed-${worker}-${name}`;
  const { logFile } = opts;

  fs.writeFileSync(wrapperPath, [
    '#!/usr/bin/env bash',
    `export AGENT_STATUS_DIR="${agentStatusDir}"`,
    // Expose sentinel paths so skills can signal completion without the process exiting.
    `export STEP_DONE_FILE="${doneFile}"`,
    `export STEP_FAILED_FILE="${failedFile}"`,
    `rm -f "${doneFile}" "${failedFile}"`,
    extraExports,
    'set +e',
    // Run the command in the background so we can poll for the done sentinel.
    // Services pass logFile to capture output and tail it so the tmux window
    // is not empty. claude-tui steps render to the terminal directly (no logFile).
    ...(logFile ? [`mkdir -p '${path.dirname(logFile)}'`] : []),
    '(',
    cmd,
    logFile ? `) > '${logFile}' 2>&1 &` : ') &',
    '_claude_pid=$!',
    // Mirror the log to the tmux window so the window isn't blank for services.
    ...(logFile ? [`tail -n 0 -f '${logFile}' &`, '_tail_pid=$!'] : []),
    // Poll until the skill writes a sentinel file or the process exits on its own.
    `while kill -0 $_claude_pid 2>/dev/null; do`,
    `  if [ -f "${doneFile}" ] || [ -f "${failedFile}" ]; then`,
    `    kill $_claude_pid 2>/dev/null`,
    `    _done_by_file=1`,
    `    break`,
    `  fi`,
    `  sleep 1`,
    `done`,
    ...(logFile ? [`kill $_tail_pid 2>/dev/null || true`] : []),
    `wait $_claude_pid 2>/dev/null`,
    `_raw_exit=$?`,
    // Sentinel file presence overrides the process exit code.
    `if [ "\${_done_by_file:-0}" -eq 1 ] && [ -f "${doneFile}" ]; then`,
    `  _exit=0`,
    `elif [ "\${_done_by_file:-0}" -eq 1 ]; then`,
    `  _exit=1`,
    `else`,
    `  _exit=$_raw_exit`,
    `fi`,
    `if [ "$_exit" -eq 0 ]; then`,
    `  node '${EMIT_CLI}' ${worker} ${name} 0`,
    `else`,
    `  node '${EMIT_CLI}' ${worker} ${name} "$_exit"`,
    `fi`,
    'exit $_exit',
  ].join('\n') + '\n');
  fs.chmodSync(wrapperPath, 0o755);

  // Kill any existing window with this name (idempotent restart).
  spawnSync('tmux', ['kill-window', '-t', `${session}:${name}`], { stdio: 'ignore' });
  const r = spawnSync('tmux', ['new-window', '-d', '-t', session, '-n', name, wrapperPath], { stdio: 'pipe' });
  if (r.status !== 0) {
    const err = r.stderr ? r.stderr.toString().trim() : 'unknown';
    throw new Error(`startJob(${name}): tmux new-window failed: ${err}`);
  }

  // Switch attached clients to the new window so the user automatically follows the active step.
  spawnSync('tmux', ['select-window', '-t', `${session}:${name}`], { stdio: 'ignore' });

  // Auto-accept Claude's --dangerously-skip-permissions disclaimer if it appears.
  // This is a no-op for jobs that don't show the prompt.
  spawnSync('bash', ['-c', `(
    for _ in $(seq 1 120); do
      sleep 1
      tmux capture-pane -t '${session}:${name}' -p 2>/dev/null | grep -q 'Yes, I accept' && {
        tmux send-keys -t '${session}:${name}' Down
        sleep 0.3
        tmux send-keys -t '${session}:${name}' Enter
        break
      }
    done
  ) &`], { stdio: 'ignore' });

  emit(worker, name, 'started', {});
}

// Kill the named tmux window and emit stopped.
function stopJob(worker, name) {
  const session = `w${worker}`;
  spawnSync('tmux', ['kill-window', '-t', `${session}:${name}`], { stdio: 'ignore' });
  emit(worker, name, 'stopped', {});
}

// A claude-tui window renders "esc to interrupt" (in various framings) while the
// model is actively working. Its ABSENCE means the model has stopped at its
// prompt — either genuinely finished (and about to touch the sentinel) or
// stalled having narrated completion instead of running the touch.
const WORKING_MARKER = /esc to interrupt/i;

// The nudge typed into an idle-stalled session: exactly the manual recovery a
// human would send — remind the model to touch the sentinel if it is genuinely
// done, and otherwise to keep going with the next step.
const NUDGE_MESSAGE =
  'You appear to have finished but the step has not been signaled complete. ' +
  'Run `touch "$STEP_DONE_FILE"` right now as your final tool call if you are ' +
  'actually complete. Otherwise continue on the next step.';

// Automatically nudge a claude-tui step that has gone idle without writing its
// done/failed sentinel. Mirrors the documented manual recovery (a human typing
// a "run the touch" message into the session) so a stalled step recovers on its
// own instead of hanging forever.
//
// Gated on REAL idleness so a legitimately long-running step is never disturbed:
//   - sentinel already present            → nothing to do (the touch just landed)
//   - working marker on the pane          → model is still working, leave it
//   - pane changed since prevSnapshot     → still active/settling, wait one tick
//   - pane STABLE (== prevSnapshot) + no marker → genuinely stopped → nudge
//
// prevSnapshot is the pane capture from the previous call (undefined on the
// first). Returns { nudged, snapshot } — the caller threads snapshot back in as
// prevSnapshot on the next tick. snapshot is omitted only when a sentinel is
// already present (there is nothing left to watch).
function nudgeIdleStep(worker, name, prevSnapshot) {
  const session = `w${worker}`;
  const target = `${session}:${name}`;
  const doneFile = `/tmp/step-done-${worker}-${name}`;
  const failedFile = `/tmp/step-failed-${worker}-${name}`;

  // The sentinel landed between ticks — the wrapper will emit done/failed; stop.
  if (fs.existsSync(doneFile) || fs.existsSync(failedFile)) {
    return { nudged: false };
  }

  const cap = spawnSync('tmux', ['capture-pane', '-t', target, '-p'], { stdio: 'pipe' });
  // Window gone (already killed) or capture failed — nothing to nudge.
  if (cap.status !== 0) return { nudged: false };
  const snapshot = cap.stdout ? cap.stdout.toString() : '';

  // Blank/new pane — nothing rendered yet. Treating '' as a stable snapshot would
  // let two empty ticks look "stopped" and fire a spurious nudge; wait instead.
  if (snapshot.trim() === '') return { nudged: false, snapshot };

  // Model is actively working — do not interrupt.
  if (WORKING_MARKER.test(snapshot)) return { nudged: false, snapshot };

  // Idle AND stable across two ticks with no working marker: genuinely stopped.
  // Send the message, then a separate Enter (Claude's TUI submits on Enter).
  if (prevSnapshot !== undefined && snapshot === prevSnapshot) {
    spawnSync('tmux', ['send-keys', '-t', target, '-l', NUDGE_MESSAGE], { stdio: 'ignore' });
    spawnSync('tmux', ['send-keys', '-t', target, 'Enter'], { stdio: 'ignore' });
    return { nudged: true, snapshot };
  }

  // Idle but not yet confirmed stable (first tick, or pane still changing) —
  // wait one more tick before deciding.
  return { nudged: false, snapshot };
}

module.exports = { startJob, stopJob, nudgeIdleStep, WORKING_MARKER, NUDGE_MESSAGE };
