#!/usr/bin/env node
'use strict';
// CLI bridge for the spawn / teardown Fleet Control Surface tools, so the
// Conductor and the markdown skills can drive them without being able to
// require() the module — exactly like ticket-cli.js and worker-input-cli.js.
// It's a thin argv front-end over fleet-control.js's createFleetControl().
//
// Usage:
//   node fleet-control-cli.js spawn <worker> [task]   -> spawn a worker, optional initial task
//   node fleet-control-cli.js teardown <worker>       -> tear a worker down
//
// A session inside the Conductor's TUI can only shell out via a Bash tool
// call, it cannot require() the module — so without this bridge nothing running
// in an interactive session can invoke spawn or teardown. No new logic lives
// here: it's a faithful passthrough, matching fleet-control.js's "generic core,
// project hooks do the work" principle. Prints a one-line confirmation; non-
// zero exit on failure (spawn-worker.sh / teardown-worker.sh surface their own
// errors through the rejection the entry point catches below).

const { createFleetControl } = require('./fleet-control');

const USAGE =
  'usage: fleet-control-cli.js spawn <worker> [task]\n' +
  '       fleet-control-cli.js teardown <worker>\n';

// run() is the injectable core so it's unit-testable without spawning docker:
// pass a fake `control` (createFleetControl's shape) and capture stdout/stderr.
// Returns the process exit code. A worker arg that fleet-control rejects (not a
// non-negative integer) surfaces as a rejection here, handled by the entry
// point below — the CLI leans on fleet-control's normalizeWorker rather than
// re-validating.
async function run({
  argv = [],
  control = createFleetControl(),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const [subcommand, worker, ...rest] = argv;

  if (subcommand === 'spawn') {
    if (worker == null || worker === '') {
      stderr.write(USAGE);
      return 1;
    }
    // Any trailing words are the optional initial task, joined with a space —
    // same argv-collapsing caveat as worker-input-cli.js. undefined (not '')
    // when absent, so fleet-control's `if (task)` guard drops it cleanly.
    const task = rest.length > 0 ? rest.join(' ') : undefined;
    await control.spawn(worker, { task });
    stdout.write(`spawned worker ${worker}\n`);
    return 0;
  }

  if (subcommand === 'teardown') {
    if (worker == null || worker === '') {
      stderr.write(USAGE);
      return 1;
    }
    await control.teardown(worker);
    stdout.write(`tore down worker ${worker}\n`);
    return 0;
  }

  stderr.write(USAGE);
  return 1;
}

module.exports = { run, USAGE };

if (require.main === module) {
  run({ argv: process.argv.slice(2) })
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`fleet-control-cli: ${err.message}\n`);
      process.exit(1);
    });
}
