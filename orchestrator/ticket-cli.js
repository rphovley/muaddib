#!/usr/bin/env node
'use strict';
// CLI bridge so the markdown skills can drive the TicketSource interface
// (services/ticket-source) without being able to require() it. Skills are
// prompt files, not JS, so — exactly like state-cli.js and emit-cli.js — they
// `node`-shell into this wrapper. It resolves the active backend via
// getTicketSource() (which honors TICKET_SOURCE, default "linear"), so a
// TICKET_SOURCE=github (or raw) run gets the source-correct behavior with no
// skill-side branching.
//
// Usage:
//   node ticket-cli.js fetch <id>                       -> prints the ticket JSON
//   node ticket-cli.js post-comment <id>                <  body.md   -> prints commentId
//   node ticket-cli.js mention <handle>                 -> prints the @mention markup
//   node ticket-cli.js create-sub-issue <parentId> <title>  <  desc.md  -> prints child JSON
//   node ticket-cli.js add-blocking-relation <blockerId> <blockedId>     -> exit 0 (no stdout)
//
// `id` / `parentId` is the source-neutral identifier the worker stores in state
// (ticket_identifier, e.g. "QUO-274" for Linear or "muaddib#37" for GitHub) —
// every backend's methods accept that identifier directly.
//
// Comment/description bodies are read from STDIN, not argv: they're large,
// multi-line markdown, so stdin sidesteps arg-quoting and escaping bugs.
//
// raw source: the write subcommands (post-comment, create-sub-issue,
// add-blocking-relation) are a clean no-op — print nothing, exit 0 — since a raw
// ticket has no backend to write to (raw.createSubIssue() throws by design;
// short-circuiting keeps that from surfacing as an error the skills must
// special-case; raw.addBlockingRelation() is itself a no-op, but skipping early
// matches the other writes and needs no id resolution). fetch and mention work
// on raw as-is.

const USAGE =
  'usage: ticket-cli.js fetch <id> | post-comment <id> (body on stdin) | ' +
  'mention <handle> | create-sub-issue <parentId> <title> (description on stdin) | ' +
  'add-blocking-relation <blockerId> <blockedId>\n';

// Read all of stdin as a UTF-8 string. Resolves '' if stdin is empty/closed.
//
// Guards against the common footgun where a caller invokes a write subcommand
// but forgets the stdin redirect (e.g. `post-comment QUO-1` with no `< body.md`):
// an interactive TTY never emits 'end', so without a guard the process hangs
// forever. Reject immediately on a TTY, and cap the wait with a timeout for the
// non-TTY-but-never-closing case (e.g. an inherited pipe left open upstream).
function readStdin(stream = process.stdin, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    if (stream.isTTY) {
      reject(new Error('no stdin: this subcommand reads its body from stdin — pass it via a redirect (e.g. `< body.md`)'));
      return;
    }
    const chunks = [];
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const timer = setTimeout(
      () => finish(reject, new Error(`timed out after ${timeoutMs}ms waiting for stdin — did the caller omit a stdin redirect?`)),
      timeoutMs
    );
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8')));
    stream.on('error', (err) => finish(reject, err));
  });
}

// run() is the injectable core so it's unit-testable without a network or a
// real subprocess: pass a fake `source` and capture `stdout`/`stderr`. Returns
// the process exit code. Throws only propagate a genuine backend failure — the
// module entry point below turns that into a non-zero exit + stderr message.
async function run({ argv = [], source, readBody = readStdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  const [cmd, ...args] = argv;
  const isRaw = source && source.name === 'raw';

  switch (cmd) {
    case 'fetch': {
      const [id] = args;
      const ticket = await source.fetchTicket(id);
      // A not-found / unparseable id resolves to null. Printing "null" and
      // exiting 0 would let a worker proceed contextless; error non-zero instead
      // so the caller notices rather than implementing against an empty ticket.
      if (ticket == null) {
        stderr.write(`ticket-cli: no ticket found for id ${JSON.stringify(id)}\n`);
        return 1;
      }
      stdout.write(`${JSON.stringify(ticket)}\n`);
      return 0;
    }

    case 'mention': {
      const [handle] = args;
      // Pure string helper; empty handle → empty string (callers omit the prefix).
      stdout.write(source.mentionUser(handle));
      return 0;
    }

    case 'post-comment': {
      const [id] = args;
      // raw: clean no-op, before touching stdin.
      if (isRaw) return 0;
      const body = await readBody();
      const { commentId } = await source.postComment(id, body);
      if (commentId != null) stdout.write(String(commentId));
      return 0;
    }

    case 'create-sub-issue': {
      const [parentId, title] = args;
      // raw: clean no-op, before touching stdin.
      if (isRaw) return 0;
      const description = await readBody();
      const child = await source.createSubIssue(parentId, title, description);
      stdout.write(`${JSON.stringify(child)}\n`);
      return 0;
    }

    case 'add-blocking-relation': {
      // Both ids are on argv (no stdin), so — unlike post-comment /
      // create-sub-issue — there's nothing to read; still short-circuit raw
      // early to match the other write subcommands (raw.addBlockingRelation is
      // itself a no-op, but skipping keeps the raw path uniform). "blockerId
      // blocks blockedId": blockerId is the relation source, blockedId the
      // target — the exact edge getBlockingStatus reads back.
      const [blockerId, blockedId] = args;
      if (isRaw) return 0;
      await source.addBlockingRelation(blockerId, blockedId);
      return 0;
    }

    default:
      stderr.write(USAGE);
      return 1;
  }
}

module.exports = { run, readStdin, USAGE };

if (require.main === module) {
  const { getTicketSource } = require('../services/ticket-source');
  run({ argv: process.argv.slice(2), source: getTicketSource() })
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`ticket-cli: ${err.message}\n`);
      process.exit(1);
    });
}
