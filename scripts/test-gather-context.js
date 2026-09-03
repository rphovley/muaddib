#!/usr/bin/env node
'use strict';
// gather-context.js core-logic tests — injected fake context sources + a fake
// ticket source, so no manifest read, no network, no real registry resolution.
// Usage: node muaddib/scripts/test-gather-context.js
//
// Covers: aggregation + posting, multi-part chunking, empty contextSources no-op,
// absent-manifest-key no-op, a degraded (throwing) source, and the idempotency
// skip when the ticket already carries a "## Context" comment.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Point state at a temp dir so tests don't pollute real worker state.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gather-context-test-'));
process.env.STATE_DIR = TMP;

const { run } = require('./gather-context');

// ─── harness ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? `: ${detail}` : ''}`);
    failed++;
  }
}

async function test(name, fn) {
  console.log(`\n${name}`);
  try {
    await fn();
  } catch (err) {
    console.error(`  ✗ threw unexpectedly: ${err.message}\n${err.stack}`);
    failed++;
  }
}

function makeRepo() {
  return fs.mkdtempSync(path.join(TMP, 'repo-'));
}

function readState(worker) {
  try {
    return JSON.parse(fs.readFileSync(path.join(TMP, `worker-${worker}.state.json`), 'utf8'));
  } catch (_) {
    return {};
  }
}

function contextFile(repo) {
  const p = path.join(repo, '.muaddib', 'context.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

// A fake ticket source recording posts, with a scripted fetchComments response.
function fakeTicketSource({ existing = { own: [], parent: [] } } = {}) {
  const posts = [];
  return {
    posts,
    async fetchComments() {
      return existing;
    },
    async postComment(id, body) {
      posts.push({ id, body });
      return { commentId: `c${posts.length}` };
    },
  };
}

// A fake context-source resolver mapping type→a source with a scripted result
// (or a function that throws, to exercise the degrade path).
function fakeResolver(byType) {
  return (type, source) => {
    const entry = byType[type];
    if (!entry) throw new Error(`no fake for type "${type}"`);
    const name = source && source !== 'builtin' ? `${type}:${source}` : type;
    return {
      name,
      async gatherContext(ticketId, ticket) {
        if (typeof entry === 'function') return entry(ticketId, ticket);
        return entry;
      },
    };
  };
}

// ─── tests ──────────────────────────────────────────────────────────────────

async function main() {
  await test('aggregates sources → posts one ## Context, writes context.md + status', async () => {
    const repo = makeRepo();
    const worker = 30;
    const source = fakeTicketSource();
    const res = await run({
      worker,
      repo,
      ticketId: 'muaddib#105',
      ticket: { identifier: 'muaddib#105', title: 'Context gathering', description: 'body', url: 'u' },
      config: {
        contextSources: [
          { type: 'taskManager', source: 'github' },
          { type: 'decisionLog', source: 'builtin' },
        ],
      },
      source,
      getContextSource: fakeResolver({
        taskManager: { summary: 'Task muaddib#105: Context gathering', items: [{ title: 'Context gathering', url: 'u', body: 'body' }] },
        decisionLog: { summary: 'Decision Log: 1 decision(s)', items: [{ title: 'ADR-1', body: 'chose a script step' }] },
      }),
    });

    assert('status is posted', res.status === 'posted', res.status);
    assert('one comment posted', source.posts.length === 1, `${source.posts.length}`);
    assert('comment is a bare ## Context', source.posts[0].body.startsWith('## Context\n\n'));
    assert('comment carries both sections', /### taskManager:github/.test(source.posts[0].body) && /### decisionLog/.test(source.posts[0].body));
    assert('posted to the ticket id', source.posts[0].id === 'muaddib#105');
    assert('context_status persisted', readState(worker).context_status === 'posted');
    const cf = contextFile(repo);
    assert('context.md written', cf && cf.startsWith('## Context'));
    assert('context.md has the gathered body', cf.includes('chose a script step'));
  });

  await test('chunks a large aggregate into multiple ## Context (n/m) parts', async () => {
    const repo = makeRepo();
    const worker = 31;
    const source = fakeTicketSource();
    const big = 'x'.repeat(400);
    const res = await run({
      worker,
      repo,
      ticketId: 'muaddib#105',
      config: { contextSources: [{ type: 'a' }, { type: 'b' }, { type: 'c' }] },
      source,
      maxCommentChars: 500,
      getContextSource: fakeResolver({
        a: { summary: 'A', items: [{ title: 'A', body: big }] },
        b: { summary: 'B', items: [{ title: 'B', body: big }] },
        c: { summary: 'C', items: [{ title: 'C', body: big }] },
      }),
    });
    assert('status is posted', res.status === 'posted');
    assert('multiple parts posted', source.posts.length > 1, `${source.posts.length}`);
    assert('every part is numbered', source.posts.every((p) => /^## Context \(\d+\/\d+\)/.test(p.body)));
  });

  await test('empty contextSources array → skipped, no post, no file', async () => {
    const repo = makeRepo();
    const worker = 32;
    const source = fakeTicketSource();
    const res = await run({ worker, repo, ticketId: 'x', config: { contextSources: [] }, source });
    assert('status skipped', res.status === 'skipped');
    assert('nothing posted', source.posts.length === 0);
    assert('no context.md', contextFile(repo) === null);
    assert('context_status persisted', readState(worker).context_status === 'skipped');
  });

  await test('manifest with no contextSources key → skipped', async () => {
    const repo = makeRepo();
    const worker = 33;
    const source = fakeTicketSource();
    const res = await run({ worker, repo, ticketId: 'x', config: { projectName: 'muaddib' }, source });
    assert('status skipped', res.status === 'skipped');
    assert('nothing posted', source.posts.length === 0);
  });

  await test('a degraded (throwing) source does not abort the aggregate', async () => {
    const repo = makeRepo();
    const worker = 34;
    const source = fakeTicketSource();
    const res = await run({
      worker,
      repo,
      ticketId: 'muaddib#105',
      config: { contextSources: [{ type: 'taskManager' }, { type: 'decisionLog' }] },
      source,
      getContextSource: fakeResolver({
        taskManager: () => { throw new Error('backend unreachable'); },
        decisionLog: { summary: 'Decision Log: 1', items: [{ title: 'ADR-1', body: 'ok' }] },
      }),
    });
    assert('status posted (the good source carried it)', res.status === 'posted');
    assert('one comment posted', source.posts.length === 1);
    assert('the working section is present', /### decisionLog/.test(source.posts[0].body));
    assert('the failure is noted, not thrown', /failed: backend unreachable/.test(source.posts[0].body));
  });

  await test('all sources empty (summaries only) → status empty, no post', async () => {
    const repo = makeRepo();
    const worker = 35;
    const source = fakeTicketSource();
    const res = await run({
      worker,
      repo,
      ticketId: 'x',
      config: { contextSources: [{ type: 'processDocs' }] },
      source,
      getContextSource: fakeResolver({
        processDocs: { summary: 'Process docs: no Goal Context configured', items: [] },
      }),
    });
    assert('status empty', res.status === 'empty', res.status);
    assert('nothing posted', source.posts.length === 0);
    assert('context_status persisted', readState(worker).context_status === 'empty');
  });

  await test('idempotency: existing ## Context comment → skip re-post, hydrate context.md', async () => {
    const repo = makeRepo();
    const worker = 36;
    const source = fakeTicketSource({
      existing: { own: [{ id: 'c1', body: '## Context\n\n### taskManager\nalready posted' }], parent: [] },
    });
    let gathered = false;
    const res = await run({
      worker,
      repo,
      ticketId: 'muaddib#105',
      config: { contextSources: [{ type: 'taskManager' }] },
      source,
      getContextSource: fakeResolver({
        taskManager: () => { gathered = true; return { summary: 's', items: [{ title: 'T', body: 'b' }] }; },
      }),
    });
    assert('status skipped', res.status === 'skipped');
    assert('did NOT re-post', source.posts.length === 0);
    assert('did NOT re-gather', gathered === false);
    const cf = contextFile(repo);
    assert('context.md hydrated from the existing comment', cf && cf.includes('already posted'));
  });

  await test('idempotency: a parent ## Context does NOT skip a child that has none of its own', async () => {
    const repo = makeRepo();
    const worker = 37;
    const source = fakeTicketSource({
      existing: { own: [{ id: 'c1', body: 'a plain review' }], parent: [{ id: 'p1', body: '## Context\n\n### x\nfrom parent' }] },
    });
    const res = await run({
      worker,
      repo,
      ticketId: 'muaddib#105',
      config: { contextSources: [{ type: 'taskManager' }] },
      source,
      getContextSource: fakeResolver({ taskManager: { summary: 's', items: [{ title: 'T', body: 'b' }] } }),
    });
    assert('status posted (child gathers its own, ignoring parent)', res.status === 'posted', res.status);
    assert('posted the child context', source.posts.length > 0);
    assert('context.md holds gathered content, not the parent', !contextFile(repo).includes('from parent'));
  });

  await test('idempotency: an incomplete multi-part ## Context is re-posted, not treated as done', async () => {
    const repo = makeRepo();
    const worker = 38;
    // Only part 1 of 2 landed (a prior run crashed mid-post) → must re-post.
    const source = fakeTicketSource({
      existing: { own: [{ id: 'c1', body: '## Context (1/2)\n\n### x\npartial' }], parent: [] },
    });
    const res = await run({
      worker,
      repo,
      ticketId: 'muaddib#105',
      config: { contextSources: [{ type: 'taskManager' }] },
      source,
      getContextSource: fakeResolver({ taskManager: { summary: 's', items: [{ title: 'T', body: 'b' }] } }),
    });
    assert('status posted (incomplete set re-posted)', res.status === 'posted', res.status);
    assert('re-posted', source.posts.length > 0);
  });

  // ─── results ────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
