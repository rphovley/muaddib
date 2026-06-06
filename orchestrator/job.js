'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { emit } = require('./events');

const REPO = process.env.REPO_DIR || '/home/worker/repo';
const EMIT_CLI = path.join(REPO, 'muaddib/orchestrator/emit-cli.js');

// Spawn a named tmux window running `cmd`. Wraps the command so it emits a
// done (exit 0) or failed (exit N) event when the process finishes.
// Also emits started immediately.
// extraEnv: optional {KEY: value} pairs exported into the wrapper before cmd runs.
function startJob(worker, name, cmd, extraEnv = {}) {
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
    // This is needed because claude interactive TUI never exits after a skill runs.
    '(',
    cmd,
    ') &',
    '_claude_pid=$!',
    // Poll until the skill writes a sentinel file or the process exits on its own.
    `while kill -0 $_claude_pid 2>/dev/null; do`,
    `  if [ -f "${doneFile}" ] || [ -f "${failedFile}" ]; then`,
    `    kill $_claude_pid 2>/dev/null`,
    `    _done_by_file=1`,
    `    break`,
    `  fi`,
    `  sleep 1`,
    `done`,
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

module.exports = { startJob, stopJob };
