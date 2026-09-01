#!/usr/bin/env node
'use strict';
// Fleet Control Surface tool: a read-only bridge the Conductor's `claude`
// session shells into (the same way it runs inspect-cli.js and every other
// orchestrator CLI) to obtain a backlog ticket's Sizing Signal. It never
// emit()s and never writes — it only discovers the project's sizing hook,
// invokes it with the ticket ID, and prints the resolved result.
//
// Usage:
//   node sizing-signal-cli.js <ticketId>   -> resolved result as pretty JSON:
//     { "configured": false }                          (no hook configured)
//     { "configured": true, "signal": { ... } }        (hook ran + validated)
//
// A missing ticketId is a usage error (exit 1). A misbehaving configured hook
// (non-zero exit / unparseable stdout / contract violation) surfaces its error
// on stderr and exits 1 — distinct from the not-configured case, which is a
// clean exit 0. Wiring this into the Conductor's reasoning loop is explicitly
// NOT part of this issue (a later Raise-Autonomy milestone).

const { computeSizingSignal } = require('./sizing-signal');

const USAGE = 'usage: sizing-signal-cli.js <ticketId>\n';

async function run({ argv = [], stdout = process.stdout, stderr = process.stderr } = {}) {
  const [ticketId] = argv;

  if (ticketId === undefined || ticketId.trim() === '') {
    stderr.write(USAGE);
    return 1;
  }

  try {
    const result = await computeSizingSignal(ticketId);
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (err) {
    stderr.write(`${err.message}\n`);
    return 1;
  }
}

module.exports = { run, USAGE };

if (require.main === module) {
  run({ argv: process.argv.slice(2) }).then((code) => process.exit(code));
}
