#!/usr/bin/env node
'use strict';
// CLI bridge so bash scripts can read/write the per-worker state file.
//
// Usage:
//   node state-cli.js <worker> get <key>
//   node state-cli.js <worker> set <key> <value>
//   node state-cli.js <worker> get-all

const { get, set, read } = require('./state');

const [,, workerStr, cmd, key, value] = process.argv;
const worker = parseInt(workerStr, 10);

if (cmd === 'get') {
  const v = get(worker, key);
  if (v !== undefined) process.stdout.write(String(v));
} else if (cmd === 'set') {
  set(worker, key, value);
} else if (cmd === 'get-all') {
  process.stdout.write(JSON.stringify(read(worker), null, 2) + '\n');
} else {
  process.stderr.write(
    'usage: state-cli.js <worker> get <key> | set <key> <value> | get-all\n',
  );
  process.exit(1);
}
