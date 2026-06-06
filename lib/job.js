'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { emit } = require('./events');

const REPO = process.env.REPO_DIR || '/home/worker/repo';
const EMIT_CLI = path.join(REPO, 'muaddib/lib/emit-cli.js');

// Spawn a named tmux window running `cmd`. Wraps the command so it emits a
// done (exit 0) or failed (exit N) event when the process finishes.
// Also emits started immediately.
function startJob(worker, name, cmd) {
  const session = `w${worker}`;
  const wrapperPath = `/tmp/job-${worker}-${name}.sh`;
  const agentStatusDir = process.env.AGENT_STATUS_DIR || '/var/run/agent-status';

  // Export AGENT_STATUS_DIR so emit-cli.js inside the wrapper uses the same dir.
  // Run the command in a subshell so that `exit N` inside the command does not
  // kill the wrapper before the emit-cli call can record the exit code.
  fs.writeFileSync(wrapperPath, [
    '#!/usr/bin/env bash',
    `export AGENT_STATUS_DIR="${agentStatusDir}"`,
    'set +e',
    '(',
    cmd,
    ')',
    '_exit=$?',
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
