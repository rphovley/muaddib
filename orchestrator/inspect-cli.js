#!/usr/bin/env node
'use strict';
// The first Fleet Control Surface tool: a read-only bridge the Conductor's
// `claude` session shells into (the same way it runs every other orchestrator
// CLI) to inspect live fleet health. It never emit()s and never writes — it
// only reads the per-worker `.events` streams and prints the derived status.
//
// Usage:
//   node inspect-cli.js                 -> whole-fleet snapshot as pretty JSON
//   node inspect-cli.js <worker>        -> a single worker's status as pretty JSON
//   node inspect-cli.js --report        -> whole-fleet human-readable report
//   node inspect-cli.js --report <n>    -> a single worker's human-readable report
//
// Fleet State is recomputed from the files on every invocation — there is no
// cache, so the output always reflects the events on disk right now. The
// --report / -r form renders the same live fold as a human-readable report
// (orchestrator/fleet-report.js); it is just as read-only — no emit(), no writes.

const { fleetState, workerStatus } = require('./fleet-state');
const { renderLiveFleetReport, renderLiveWorkerReport } = require('./fleet-report');

const USAGE = 'usage: inspect-cli.js [--report|-r] [worker]\n';

function run({ argv = [], stdout = process.stdout, stderr = process.stderr } = {}) {
  const args = argv.slice();

  // Optional leading --report / -r flag toggles human-readable output; the rest
  // of the parsing (an optional numeric worker arg) is unchanged.
  let report = false;
  if (args[0] === '--report' || args[0] === '-r') {
    report = true;
    args.shift();
  }

  const [workerArg] = args;

  if (workerArg === undefined) {
    if (report) {
      stdout.write(`${renderLiveFleetReport()}\n`);
      return 0;
    }
    stdout.write(`${JSON.stringify(fleetState(), null, 2)}\n`);
    return 0;
  }

  const worker = parseInt(workerArg, 10);
  if (isNaN(worker) || String(worker) !== workerArg.trim()) {
    stderr.write(USAGE);
    return 1;
  }

  if (report) {
    stdout.write(`${renderLiveWorkerReport(worker)}\n`);
    return 0;
  }

  stdout.write(`${JSON.stringify(workerStatus(worker), null, 2)}\n`);
  return 0;
}

module.exports = { run, USAGE };

if (require.main === module) {
  process.exit(run({ argv: process.argv.slice(2) }));
}
