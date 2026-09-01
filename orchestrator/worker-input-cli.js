#!/usr/bin/env node
'use strict';
// CLI bridge for the send-input Fleet Control Surface tool, so the Conductor and
// the markdown skills can drive it without being able to require() the module —
// exactly like state-cli.js, ticket-cli.js and decision-log-cli.js. It's a thin
// argv/stdin front-end over worker-input.js's sendInput().
//
// Usage:
//   node worker-input-cli.js <worker> <text...>     -> text comes from argv
//   node worker-input-cli.js <worker>   < body.md   -> text comes from STDIN
//
// Short, single-line input is easiest on argv (any trailing words are joined
// with a space). Large or multi-line input goes on STDIN — same rationale and
// TTY/timeout guard as ticket-cli.js — so arg-quoting and embedded newlines are
// never a problem. Prints a one-line confirmation; non-zero exit on failure.

const { sendInput } = require('./worker-input');
const { readStdin } = require('./ticket-cli');

const USAGE = 'usage: worker-input-cli.js <worker> [text]   (text on argv, else on stdin)\n';

// run() is the injectable core so it's unit-testable without spawning anything:
// pass a fake `sendFn` and capture stdout/stderr. Returns the process exit code.
async function run({
  argv = [],
  sendFn = sendInput,
  readBody = readStdin,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const [worker, ...rest] = argv;
  if (worker == null || worker === '') {
    stderr.write(USAGE);
    return 1;
  }

  // Argv text when present; otherwise the body from stdin. Note: rejoining argv
  // with a single space collapses any runs of whitespace between words — send
  // input whose exact spacing matters (aligned text, indentation) on stdin.
  const text = rest.length > 0 ? rest.join(' ') : await readBody();

  const result = sendFn(worker, text);
  stdout.write(`sent input to worker ${result.worker} (${result.container})\n`);
  return 0;
}

module.exports = { run, USAGE };

if (require.main === module) {
  run({ argv: process.argv.slice(2) })
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`worker-input-cli: ${err.message}\n`);
      process.exit(1);
    });
}
