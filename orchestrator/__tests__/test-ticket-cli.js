#!/usr/bin/env node
'use strict';
// ticket-cli.js test suite — no network calls.
//
// Drives run() in-process with a fake injected source to assert each subcommand
// dispatches to the right TicketSource method (fetch / post-comment / mention /
// create-sub-issue), that raw writes are silent no-op exit-0s, and that an
// unknown subcommand prints usage and exits non-zero. A final subprocess case
// exercises the real module entry point end-to-end against TICKET_SOURCE=raw.

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const { run, readStdin } = require('../ticket-cli');

const CLI = path.join(__dirname, '../ticket-cli.js');

// Captures writes so we can assert on what a subcommand printed.
function capture() {
  let buf = '';
  return { write: (s) => { buf += s; }, get text() { return buf; } };
}

// A fake source recording each interface call and returning scripted values.
function fakeSource(name = 'linear', overrides = {}) {
  const calls = [];
  return {
    name,
    calls,
    async fetchTicket(id) {
      calls.push(['fetchTicket', id]);
      return { identifier: id, title: 'A ticket' };
    },
    async fetchComments(id) {
      calls.push(['fetchComments', id]);
      return { own: [{ id: 'c1', body: 'hello' }], parent: [] };
    },
    async postComment(id, body) {
      calls.push(['postComment', id, body]);
      return { commentId: 'cmt_123' };
    },
    mentionUser(handle) {
      calls.push(['mentionUser', handle]);
      const h = String(handle == null ? '' : handle).trim().replace(/^@+/, '');
      return h ? `@${h}` : '';
    },
    async createSubIssue(parentId, title, description) {
      calls.push(['createSubIssue', parentId, title, description]);
      return { identifier: 'CHILD-1', url: 'https://example/CHILD-1' };
    },
    async addBlockingRelation(blockerId, blockedId) {
      calls.push(['addBlockingRelation', blockerId, blockedId]);
    },
    ...overrides,
  };
}

// ─── fetch ───────────────────────────────────────────────────────────────────

async function testFetch() {
  const source = fakeSource();
  const stdout = capture();
  const code = await run({ argv: ['fetch', 'QUO-274'], source, stdout });
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(source.calls[0], ['fetchTicket', 'QUO-274']);
  const printed = JSON.parse(stdout.text);
  assert.strictEqual(printed.identifier, 'QUO-274');
}

async function testFetchNotFound() {
  // A not-found / unparseable id resolves to null: the CLI must error non-zero
  // rather than print "null" and exit 0, so a worker never proceeds contextless.
  const source = fakeSource('linear', { fetchTicket: async () => null });
  const stdout = capture();
  const stderr = capture();
  const code = await run({ argv: ['fetch', 'NOPE-999'], source, stdout, stderr });
  assert.strictEqual(code, 1);
  assert.strictEqual(stdout.text, '');
  assert.ok(stderr.text.includes('no ticket found'), 'expected not-found message on stderr');
}

// ─── comments ────────────────────────────────────────────────────────────────

async function testComments() {
  const source = fakeSource();
  const stdout = capture();
  const code = await run({ argv: ['comments', 'QUO-507'], source, stdout });
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(source.calls[0], ['fetchComments', 'QUO-507']);
  const printed = JSON.parse(stdout.text);
  assert.deepStrictEqual(printed, { own: [{ id: 'c1', body: 'hello' }], parent: [] });
}

// ─── mention ─────────────────────────────────────────────────────────────────

async function testMention() {
  const source = fakeSource();
  const stdout = capture();
  const code = await run({ argv: ['mention', '@dev'], source, stdout });
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(source.calls[0], ['mentionUser', '@dev']);
  assert.strictEqual(stdout.text, '@dev'); // leading @ normalized, no trailing newline
}

async function testMentionEmptyHandle() {
  const source = fakeSource();
  const stdout = capture();
  const code = await run({ argv: ['mention', ''], source, stdout });
  assert.strictEqual(code, 0);
  assert.strictEqual(stdout.text, ''); // empty handle → empty prefix, still exit 0
}

// ─── post-comment (body from stdin) ──────────────────────────────────────────

async function testPostComment() {
  const source = fakeSource();
  const stdout = capture();
  const code = await run({
    argv: ['post-comment', 'QUO-274'],
    source,
    readBody: async () => '## Plan\n\nbody',
    stdout,
  });
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(source.calls[0], ['postComment', 'QUO-274', '## Plan\n\nbody']);
  assert.strictEqual(stdout.text, 'cmt_123');
}

// ─── create-sub-issue (description from stdin) ───────────────────────────────

async function testCreateSubIssue() {
  const source = fakeSource();
  const stdout = capture();
  const code = await run({
    argv: ['create-sub-issue', 'QUO-274', 'Child title'],
    source,
    readBody: async () => 'child description',
    stdout,
  });
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(source.calls[0], [
    'createSubIssue', 'QUO-274', 'Child title', 'child description',
  ]);
  const printed = JSON.parse(stdout.text);
  assert.strictEqual(printed.identifier, 'CHILD-1');
}

// ─── add-blocking-relation (both ids on argv, no stdout) ─────────────────────

async function testAddBlockingRelation() {
  const source = fakeSource();
  const stdout = capture();
  const code = await run({
    argv: ['add-blocking-relation', 'CHILD-1', 'CHILD-2'],
    source,
    // A stray stdin read would be a bug — this subcommand takes only argv.
    readBody: async () => { throw new Error('add-blocking-relation must not read stdin'); },
    stdout,
  });
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(source.calls[0], ['addBlockingRelation', 'CHILD-1', 'CHILD-2']);
  assert.strictEqual(stdout.text, ''); // void → no stdout
}

// ─── raw: writes are silent no-op exit-0 ─────────────────────────────────────

async function testRawWritesAreNoOps() {
  // raw.createSubIssue() throws by design; the CLI must short-circuit before
  // ever calling it (or reading stdin), so the write is a clean no-op.
  const source = fakeSource('raw', {
    postComment: async () => { throw new Error('raw postComment should not be called'); },
    createSubIssue: async () => { throw new Error('raw createSubIssue should not be called'); },
    addBlockingRelation: async () => { throw new Error('raw addBlockingRelation should not be called'); },
  });
  const bodyRead = () => { throw new Error('raw write should not read stdin'); };

  const out1 = capture();
  const c1 = await run({ argv: ['post-comment', 'anything'], source, readBody: bodyRead, stdout: out1 });
  assert.strictEqual(c1, 0);
  assert.strictEqual(out1.text, '');

  const out2 = capture();
  const c2 = await run({ argv: ['create-sub-issue', 'p', 't'], source, readBody: bodyRead, stdout: out2 });
  assert.strictEqual(c2, 0);
  assert.strictEqual(out2.text, '');

  const out3 = capture();
  const c3 = await run({ argv: ['add-blocking-relation', 'b1', 'b2'], source, readBody: bodyRead, stdout: out3 });
  assert.strictEqual(c3, 0);
  assert.strictEqual(out3.text, '');

  // fetch and mention still work on raw as-is.
  assert.strictEqual(source.calls.length, 0);
}

// ─── unknown subcommand → usage + non-zero ───────────────────────────────────

async function testUnknownSubcommand() {
  const source = fakeSource();
  const stderr = capture();
  const code = await run({ argv: ['bogus'], source, stderr });
  assert.strictEqual(code, 1);
  assert.ok(stderr.text.includes('usage:'), 'expected usage on stderr');
}

// ─── readStdin guards (no hang on a missing stdin redirect) ──────────────────

async function testReadStdinRejectsTTY() {
  // Interactive stdin (no redirect) never emits 'end'; readStdin must reject
  // immediately instead of hanging forever.
  const tty = new EventEmitter();
  tty.isTTY = true;
  await assert.rejects(() => readStdin(tty), /no stdin/);
}

async function testReadStdinTimesOut() {
  // A non-TTY stream that never closes must be capped by the timeout, not hang.
  const stuck = new EventEmitter(); // never emits 'end'
  await assert.rejects(() => readStdin(stuck, { timeoutMs: 20 }), /timed out/);
}

async function testReadStdinReadsBody() {
  // Normal path: data chunks then 'end' resolve to the concatenated UTF-8 body.
  const stream = new EventEmitter();
  const p = readStdin(stream, { timeoutMs: 1000 });
  stream.emit('data', Buffer.from('## Plan\n'));
  stream.emit('data', Buffer.from('body'));
  stream.emit('end');
  assert.strictEqual(await p, '## Plan\nbody');
}

// ─── real entry point end-to-end (subprocess) against TICKET_SOURCE=raw ───────

async function testSubprocessRawEndToEnd() {
  // post-comment on raw: silent, exit 0.
  const r1 = spawnSync(process.execPath, [CLI, 'post-comment', 'ignored'], {
    encoding: 'utf8',
    input: 'a body',
    env: { ...process.env, TICKET_SOURCE: 'raw' },
  });
  assert.strictEqual(r1.status, 0, `post-comment raw exit: ${r1.status} / ${r1.stderr}`);
  assert.strictEqual(r1.stdout, '');

  // add-blocking-relation on raw: silent, exit 0 (no stdin needed).
  const rBlock = spawnSync(process.execPath, [CLI, 'add-blocking-relation', 'b1', 'b2'], {
    encoding: 'utf8',
    env: { ...process.env, TICKET_SOURCE: 'raw' },
  });
  assert.strictEqual(rBlock.status, 0, `add-blocking-relation raw exit: ${rBlock.status} / ${rBlock.stderr}`);
  assert.strictEqual(rBlock.stdout, '');

  // mention on raw: prints normalized handle.
  const r2 = spawnSync(process.execPath, [CLI, 'mention', 'operator'], {
    encoding: 'utf8',
    env: { ...process.env, TICKET_SOURCE: 'raw' },
  });
  assert.strictEqual(r2.status, 0);
  assert.strictEqual(r2.stdout, '@operator');

  // unknown subcommand: usage + non-zero.
  const r3 = spawnSync(process.execPath, [CLI, 'nope'], {
    encoding: 'utf8',
    env: { ...process.env, TICKET_SOURCE: 'raw' },
  });
  assert.strictEqual(r3.status, 1);
  assert.ok(r3.stderr.includes('usage:'), 'expected usage on stderr');
}

// ─── runner ──────────────────────────────────────────────────────────────────

async function main() {
  const tests = [
    ['fetch → source.fetchTicket, prints JSON', testFetch],
    ['fetch not-found → stderr + exit 1 (no contextless proceed)', testFetchNotFound],
    ['comments → source.fetchComments, prints JSON', testComments],
    ['mention → source.mentionUser, normalized, no newline', testMention],
    ['mention empty handle → empty output, exit 0', testMentionEmptyHandle],
    ['post-comment → source.postComment with stdin body, prints commentId', testPostComment],
    ['create-sub-issue → source.createSubIssue with stdin desc, prints JSON', testCreateSubIssue],
    ['add-blocking-relation → source.addBlockingRelation(blocker, blocked), no stdout', testAddBlockingRelation],
    ['raw writes are silent no-op exit-0 (no method call, no stdin read)', testRawWritesAreNoOps],
    ['unknown subcommand → usage + exit 1', testUnknownSubcommand],
    ['readStdin rejects on a TTY (no redirect)', testReadStdinRejectsTTY],
    ['readStdin times out on a never-closing stream', testReadStdinTimesOut],
    ['readStdin reads data chunks then end', testReadStdinReadsBody],
    ['subprocess: real entry point against TICKET_SOURCE=raw', testSubprocessRawEndToEnd],
  ];

  let passed = 0;
  for (const [name, fn] of tests) {
    process.stdout.write(`  ${name}... `);
    try {
      await fn();
      process.stdout.write('PASS\n');
      passed++;
    } catch (err) {
      process.stdout.write(`FAIL\n    ${err.stack || err.message}\n`);
    }
  }

  console.log(`\n${passed}/${tests.length} passed`);
  if (passed < tests.length) process.exit(1);
}

main().catch((err) => {
  console.error('FAIL —', err.message);
  process.exit(1);
});
