'use strict';
// Fleet Control Surface — the callable tools the long-running Conductor
// (services/conductor-daemon.js + orchestrator/conductor-session.js, landed in
// muaddib#23) will eventually invoke to manage the fleet. This module adds two
// of them — `spawn` and `teardown` — as thin Node wrappers over the already-
// working bash scripts bin/spawn-worker.sh / bin/teardown-worker.sh, the same
// way the sibling `inspect` tool is built.
//
// SCOPE: these tools must exist and be independently callable/testable now.
// Wiring them into the Conductor's reasoning loop is explicitly NOT done here —
// that's the later Raise-Autonomy milestone.
//
// DESIGN PRINCIPLE — generic core, project hooks do the work: the wrappers are
// faithful passthroughs and reimplement nothing. All project-specific behavior
// (service startup, DB seeding, cleanup) stays in the underlying scripts, which
// remain the single source of truth via read-config.sh + compose overlays
// (MUADDIB_COMPOSE_OVERLAY). The wrapper never embeds project logic of its own.

const path = require('path');
const { spawn: spawnChild } = require('child_process');

const { resolveMuaddibRoot } = require('./muaddib-root');

// Fleet root = where bin/ lives. orchestrator/ sits directly at the fleet root
// in both nestings (consuming project's REPO/muaddib and muaddib self-hosting's
// REPO), so its parent is the fleet root; resolveMuaddibRoot keeps this correct
// even when REPO_ROOT points at a consuming project's outer repo.
const REPO_ROOT = process.env.REPO_ROOT || path.join(__dirname, '..');
const FLEET_DIR = resolveMuaddibRoot(REPO_ROOT);

const DEFAULT_SPAWN_SCRIPT = path.join(FLEET_DIR, 'bin', 'spawn-worker.sh');
const DEFAULT_TEARDOWN_SCRIPT = path.join(FLEET_DIR, 'bin', 'teardown-worker.sh');

// Match the scripts' own contract: WORKER must be a non-negative integer (they
// assert `^[0-9]+$`). Reject early with a clear error so a bad call fails in JS
// rather than deep in bash. Returns the canonical string form for argv.
function normalizeWorker(worker) {
  if (typeof worker === 'number') {
    if (!Number.isInteger(worker) || worker < 0) {
      throw new Error(
        `worker must be a non-negative integer, got: ${JSON.stringify(worker)}`,
      );
    }
    return String(worker);
  }
  if (typeof worker === 'string' && /^[0-9]+$/.test(worker)) {
    return worker;
  }
  throw new Error(
    `worker must be a non-negative integer, got: ${JSON.stringify(worker)}`,
  );
}

// Run a fleet script as an async child process, collecting stdout/stderr.
// Resolves { code, stdout, stderr } on a clean (exit 0) run; rejects with
// stderr surfaced in the message on a non-zero exit, and rejects on a spawn
// error (e.g. the script isn't executable / doesn't exist). Async — spawn-
// worker.sh blocks up to ~5 min waiting for READY, and a synchronous wrapper
// would wedge the Conductor's heartbeat.
function runScript(scriptPath, args, env, cwd) {
  return new Promise((resolve, reject) => {
    // stdio piped (not inherited): a programmatic caller must never attach to
    // the worker's tmux session — see MUADIB_NO_ATTACH below.
    const child = spawnChild(scriptPath, args, {
      env,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.once('error', (err) => {
      reject(
        new Error(
          `${path.basename(scriptPath)} failed to spawn: ${err.message}`,
        ),
      );
    });

    // 'exit' (not 'close'): spawn-worker.sh disowns a background watcher subshell
    // that inherits our piped stdout/stderr fds and keeps them open until the
    // worker reaches DONE/FAILED (potentially many minutes later). 'close' waits
    // for those fds to hit EOF, so it would never fire on a real run and this
    // promise would hang. 'exit' fires when the script process itself exits,
    // regardless of the leaked fds — the same contract dispatch-daemon.js uses.
    child.once('exit', (code) => {
      if (code === 0) {
        resolve({ code, stdout, stderr });
        return;
      }
      const detail = stderr.trim() || stdout.trim() || '(no output)';
      reject(
        new Error(
          `${path.basename(scriptPath)} exited with code ${code}: ${detail}`,
        ),
      );
    });
  });
}

// spawn(worker, { task, scriptPath, env, cwd })
// Provision and launch worker <worker>, optionally with an initial task prompt.
// Faithful wrapper over bin/spawn-worker.sh <worker> [task].
//   - CONTRACT: a code-0 resolution means the worker was provisioned and reached
//     READY, NOT that the task succeeded. The task then runs asynchronously
//     inside the container; its eventual DONE/FAILED outcome is surfaced on the
//     status/events bus, never through this promise. (spawn-worker.sh returns as
//     soon as the container is READY — blocking here until task completion would
//     wedge the Conductor's heartbeat, see runScript above.)
//   - MUADIB_NO_ATTACH=1 (the script's actual spelling) is forced so the wrapper
//     never attaches to the worker's tmux session, exactly as dispatch-daemon.js
//     does. Callers can still override via opts.env.
function spawn(worker, opts = {}) {
  let workerArg;
  try {
    workerArg = normalizeWorker(worker);
  } catch (err) {
    return Promise.reject(err);
  }
  const { task, scriptPath, env, cwd } = opts;
  const args = [workerArg];
  if (task) args.push(task);
  const childEnv = { ...process.env, MUADIB_NO_ATTACH: '1', ...env };
  return runScript(
    scriptPath || DEFAULT_SPAWN_SCRIPT,
    args,
    childEnv,
    cwd || FLEET_DIR,
  );
}

// teardown(worker, { scriptPath, env, cwd })
// Stop worker <worker> and remove its containers, volumes, env file, and status
// entry. Faithful wrapper over bin/teardown-worker.sh <worker>. No
// MUADIB_NO_ATTACH needed — teardown never attaches.
function teardown(worker, opts = {}) {
  let workerArg;
  try {
    workerArg = normalizeWorker(worker);
  } catch (err) {
    return Promise.reject(err);
  }
  const { scriptPath, env, cwd } = opts;
  const childEnv = { ...process.env, ...env };
  return runScript(
    scriptPath || DEFAULT_TEARDOWN_SCRIPT,
    [workerArg],
    childEnv,
    cwd || FLEET_DIR,
  );
}

// Factory mirror of the bare functions, matching the "class/factory" convention
// conductor-session.js established. Baked-in defaults (scriptPath/env/cwd) are
// merged under each call's own opts, so the Conductor can construct one control
// surface configured once and call spawn/teardown on it.
function createFleetControl(defaults = {}) {
  // Scalar opts (scriptPath/cwd/task) let a per-call value override the default,
  // but env is a map: a shallow {...defaults, ...opts} would make a single per-
  // call env var REPLACE the entire baked-in env. Merge the two env maps so
  // per-call vars layer on top of the defaults rather than erasing them.
  const merge = (opts) => {
    const merged = { ...defaults, ...opts };
    if (defaults.env || opts.env) {
      merged.env = { ...defaults.env, ...opts.env };
    }
    return merged;
  };
  return {
    spawn: (worker, opts = {}) => spawn(worker, merge(opts)),
    teardown: (worker, opts = {}) => teardown(worker, merge(opts)),
  };
}

module.exports = {
  spawn,
  teardown,
  createFleetControl,
  FLEET_DIR,
  DEFAULT_SPAWN_SCRIPT,
  DEFAULT_TEARDOWN_SCRIPT,
};
