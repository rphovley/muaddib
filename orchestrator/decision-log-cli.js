#!/usr/bin/env node
'use strict';
// CLI bridge so bash scripts and markdown skills can read the Decision Log
// (.muaddib/decisions.jsonl) without being able to require() the module —
// exactly like state-cli.js and ticket-cli.js. A future `search-before-ask`
// step shells into this to check whether a question was already answered
// before the Conductor escalates it, so it stays cheap to call repeatedly.
//
// This is the read side only: `get` fetches one record by id, `search` returns
// lightweight snippet hits. Writing a record is appendDecision()'s job (the
// Conductor's, in a later milestone), deliberately not exposed here.
//
// Usage:
//   node decision-log-cli.js get <id>
//     -> prints the matching record as JSON, or exits 1 if no such id exists
//   node decision-log-cli.js search <query> [--scope <scope>] [--limit <n>]
//     -> prints an array of { id, scope, timestamp, snippet } hits as JSON
//
// repoDir comes from REPO_DIR (the same env var job.js/orchestrator.js read),
// defaulting to the worker checkout — so a caller in the container needs no
// path argument.

const { getById, search } = require('./decision-log');

const REPO = process.env.REPO_DIR || '/home/worker/repo';

const USAGE =
  'usage: decision-log-cli.js get <id> | ' +
  'search <query> [--scope <scope>] [--limit <n>]\n';

// Pulls --scope <v> / --limit <n> out of the arg list, returning the leftover
// positionals and a parsed opts object. --limit must be a positive integer;
// anything else is a usage error rather than a silently-ignored flag.
function parseSearchArgs(args) {
  const positionals = [];
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--scope') {
      opts.scope = args[++i];
    } else if (arg === '--limit') {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`--limit must be a positive integer, got ${JSON.stringify(args[i])}`);
      }
      opts.limit = n;
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, opts };
}

function run({ argv = [], repoDir = REPO, stdout = process.stdout, stderr = process.stderr } = {}) {
  const [cmd, ...args] = argv;

  switch (cmd) {
    case 'get': {
      const [id] = args;
      if (id == null) {
        stderr.write(USAGE);
        return 1;
      }
      const record = getById(repoDir, id);
      if (record == null) {
        stderr.write(`decision-log-cli: no record found for id ${JSON.stringify(id)}\n`);
        return 1;
      }
      stdout.write(`${JSON.stringify(record)}\n`);
      return 0;
    }

    case 'search': {
      const { positionals, opts } = parseSearchArgs(args);
      const [query] = positionals;
      if (query == null) {
        stderr.write(USAGE);
        return 1;
      }
      const hits = search(repoDir, query, opts);
      stdout.write(`${JSON.stringify(hits)}\n`);
      return 0;
    }

    default:
      stderr.write(USAGE);
      return 1;
  }
}

module.exports = { run, parseSearchArgs, USAGE };

if (require.main === module) {
  try {
    process.exit(run({ argv: process.argv.slice(2) }));
  } catch (err) {
    process.stderr.write(`decision-log-cli: ${err.message}\n`);
    process.exit(1);
  }
}
