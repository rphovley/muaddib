#!/usr/bin/env node
'use strict';
// CLI bridge so bash scripts and markdown skills can read/write the Session
// Context (<accountDir>/session/session.json) without being able to require()
// the module — exactly like state-cli.js and decision-log-cli.js.
//
// Usage:
//   node session-context-cli.js get <key>        -> prints the value (nothing if unset)
//   node session-context-cli.js set <key> <value>
//   node session-context-cli.js unset <key>
//   node session-context-cli.js get-all           -> prints the whole bag as JSON
//   node session-context-cli.js begin             -> wipes any stale session file
//   node session-context-cli.js clear             -> removes the session file
//
// repoDir comes from REPO_DIR (the same env var the other CLIs read), so a
// caller in the container needs no path argument.

const { get, set, unset, read, begin, clear } = require('./session-context');

const REPO = process.env.REPO_DIR || '/home/worker/repo';

const USAGE =
  'usage: session-context-cli.js get <key> | set <key> <value> | ' +
  'unset <key> | get-all | begin | clear\n';

function run({ argv = [], repoDir = REPO, stdout = process.stdout, stderr = process.stderr } = {}) {
  const [cmd, key, value] = argv;

  switch (cmd) {
    case 'get': {
      if (key === undefined) { stderr.write(USAGE); return 1; }
      const v = get(repoDir, key);
      if (v !== undefined) stdout.write(String(v));
      return 0;
    }
    case 'set': {
      if (key === undefined || value === undefined) { stderr.write(USAGE); return 1; }
      set(repoDir, key, value);
      return 0;
    }
    case 'unset': {
      if (key === undefined) { stderr.write(USAGE); return 1; }
      unset(repoDir, key);
      return 0;
    }
    case 'get-all':
      stdout.write(JSON.stringify(read(repoDir), null, 2) + '\n');
      return 0;
    case 'begin':
      begin(repoDir);
      return 0;
    case 'clear':
      clear(repoDir);
      return 0;
    default:
      stderr.write(USAGE);
      return 1;
  }
}

module.exports = { run, USAGE };

if (require.main === module) {
  process.exit(run({ argv: process.argv.slice(2) }));
}
