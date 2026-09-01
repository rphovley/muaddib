#!/usr/bin/env node
'use strict';
// The first Fleet Control Surface tool: a read-only bridge the Conductor's
// `claude` session shells into (the same way it runs every other orchestrator
// CLI) to inspect live fleet health. It never emit()s and never writes — it
// only reads the per-worker `.events` streams and prints the derived status.
//
// Usage:
//   node inspect-cli.js            -> whole-fleet snapshot as pretty JSON
//   node inspect-cli.js <worker>   -> a single worker's status as pretty JSON
//
// Fleet State is recomputed from the files on every invocation — there is no
// cache, so the output always reflects the events on disk right now.

const { fleetState, workerStatus } = require('./fleet-state');

const USAGE = 'usage: inspect-cli.js [worker]\n';

function run({ argv = [], stdout = process.stdout, stderr = process.stderr } = {}) {
  const [workerArg] = argv;

  if (workerArg === undefined) {
    stdout.write(`${JSON.stringify(fleetState(), null, 2)}\n`);
    return 0;
  }

  const worker = parseInt(workerArg, 10);
  if (isNaN(worker) || String(worker) !== workerArg.trim()) {
    stderr.write(USAGE);
    return 1;
  }

  stdout.write(`${JSON.stringify(workerStatus(worker), null, 2)}\n`);
  return 0;
}

module.exports = { run, USAGE };

if (require.main === module) {
  process.exit(run({ argv: process.argv.slice(2) }));
}
