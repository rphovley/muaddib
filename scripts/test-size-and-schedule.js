#!/usr/bin/env node
'use strict';
// size-and-schedule.js tests — injected fake TicketSource + fake sizing resolver
// and injected plan/context text, so no manifest read, no network, no real hook.
// Usage: node muaddib/scripts/test-size-and-schedule.js
//
// Covers: the no-op gates (raw source, not-configured, recommendSplit=false,
// hook error, streamless plan), the happy split path (children + linear blocking
// chain + per-child context + parent review comment + state), the explicit
// "depends on Stream X" edge override, and the pure parse/edge helpers.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Point state at a temp dir so tests don't pollute real worker state.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'size-and-schedule-test-'));
process.env.STATE_DIR = TMP;

const {
  run,
  extractWorkStreamsSection,
  parseWorkStreams,
  computeEdges,
  alreadyScheduled,
} = require('./size-and-schedule');

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

function readState(worker) {
  try {
    return JSON.parse(fs.readFileSync(path.join(TMP, `worker-${worker}.state.json`), 'utf8'));
  } catch (_) {
    return {};
  }
}

// A fake ticket source recording sub-issue creates, blocking relations, and
// comment posts. createSubIssue mints a deterministic child identifier per call.
// `existingComments` seeds fetchComments so the idempotency path is testable.
function fakeTicketSource({ name = 'github', prefix = 'muaddib', existingComments = { own: [], parent: [] } } = {}) {
  const created = [];
  const relations = [];
  const posts = [];
  let n = 100;
  return {
    name,
    created,
    relations,
    posts,
    async fetchComments() {
      return existingComments;
    },
    async createSubIssue(parentId, title, description) {
      n += 1;
      const identifier = `${prefix}#${n}`;
      created.push({ parentId, title, description, identifier });
      return { identifier, title, description };
    },
    async addBlockingRelation(blockerId, blockedId) {
      relations.push({ blockerId, blockedId });
    },
    async postComment(id, body) {
      posts.push({ id, body });
      return { commentId: `c${posts.length}` };
    },
  };
}

// A fake sizing resolver returning a scripted result (or throwing).
function fakeSizing(result) {
  return async () => {
    if (typeof result === 'function') return result();
    return result;
  };
}

const SPLIT = { configured: true, signal: { size: 'L', confidence: 'high', recommendSplit: true } };

const PLAN = `## Plan

### Diagnosis

Big ticket.

### Solution

Do it in stages.

### Work Streams

Dependency-ordered.

**Stream 1 — Schema migration**

- Add the column
- Backfill

**Stream 2 — API endpoint**

- Wire the route
- Validate input

**Stream 3 — Frontend**

- Render the form

### Open Questions
`;

// ─── tests ──────────────────────────────────────────────────────────────────

async function main() {
  // ── pure helpers ────────────────────────────────────────────────────────────

  await test('extractWorkStreamsSection isolates the section (excludes Open Questions)', () => {
    const sec = extractWorkStreamsSection(PLAN);
    assert('has Stream 1', /Stream 1 — Schema migration/.test(sec));
    assert('has Stream 3', /Stream 3 — Frontend/.test(sec));
    assert('excludes Open Questions', !/Open Questions/.test(sec));
    assert('excludes Diagnosis', !/Diagnosis/.test(sec));
  });

  await test('parseWorkStreams parses number, name, steps in order', () => {
    const streams = parseWorkStreams(PLAN);
    assert('three streams', streams.length === 3, `${streams.length}`);
    assert('numbers 1,2,3', streams.map((s) => s.number).join(',') === '1,2,3');
    assert('names parsed', streams[0].name === 'Schema migration' && streams[1].name === 'API endpoint');
    assert('steps captured', streams[0].steps.length === 2 && streams[0].steps[0] === 'Add the column');
    assert('body carries the bullets', /Backfill/.test(streams[0].body));
    assert('no explicit deps', streams.every((s) => s.dependsOn === null));
  });

  await test('parseWorkStreams: missing/streamless plan → []', () => {
    assert('null plan', parseWorkStreams(null).length === 0);
    assert('no work-streams header', parseWorkStreams('## Plan\n\n### Solution\n\ndo stuff').length === 0);
    assert('header but no streams', parseWorkStreams('### Work Streams\n\nnone yet\n').length === 0);
  });

  await test('parseWorkStreams detects "depends on Stream X"', () => {
    const streams = parseWorkStreams(
      '### Work Streams\n\n**Stream 1 — A**\n\n- x\n\n**Stream 2 — B**\n\n- y\n\n**Stream 3 — C**\n\n- z (depends on Stream 1)\n',
    );
    assert('stream 3 depends on 1', streams[2].dependsOn === 1, `${streams[2].dependsOn}`);
    assert('stream 2 has no dep', streams[1].dependsOn === null);
  });

  await test('computeEdges: linear chain by default', () => {
    const edges = computeEdges(parseWorkStreams(PLAN));
    assert('two edges', edges.length === 2, `${edges.length}`);
    assert('1→2', edges[0].blocker === 1 && edges[0].blocked === 2);
    assert('2→3', edges[1].blocker === 2 && edges[1].blocked === 3);
  });

  await test('computeEdges: explicit dep overrides the linear default', () => {
    const streams = parseWorkStreams(
      '### Work Streams\n\n**Stream 1 — A**\n\n- x\n\n**Stream 2 — B**\n\n- y\n\n**Stream 3 — C**\n\n- z (depends on Stream 1)\n',
    );
    const edges = computeEdges(streams);
    assert('1→2 default', edges[0].blocker === 1 && edges[0].blocked === 2);
    assert('1→3 (override, not 2→3)', edges[1].blocker === 1 && edges[1].blocked === 3);
  });

  await test('computeEdges: a self/unknown dep falls back to linear', () => {
    const streams = parseWorkStreams(
      '### Work Streams\n\n**Stream 1 — A**\n\n- x\n\n**Stream 2 — B**\n\n- y (depends on Stream 9)\n',
    );
    const edges = computeEdges(streams);
    assert('falls back to 1→2', edges[0].blocker === 1 && edges[0].blocked === 2);
  });

  await test('computeEdges: a FORWARD dep falls back to linear (no cycle)', () => {
    // Stream 2 declaring a dependency on the later Stream 3 must NOT wire 3→2
    // (which, with 3's own linear default 2→3, would be a 2↔3 deadlock).
    const streams = parseWorkStreams(
      '### Work Streams\n\n**Stream 1 — A**\n\n- x\n\n**Stream 2 — B**\n\n- y (depends on Stream 3)\n\n**Stream 3 — C**\n\n- z\n',
    );
    const edges = computeEdges(streams);
    assert('two edges', edges.length === 2, `${edges.length}`);
    assert('pure linear 1→2', edges[0].blocker === 1 && edges[0].blocked === 2);
    assert('pure linear 2→3', edges[1].blocker === 2 && edges[1].blocked === 3);
    const cyclic = edges.some((a) => edges.some((b) => a.blocker === b.blocked && a.blocked === b.blocker));
    assert('no reciprocal (cyclic) pair', !cyclic);
  });

  await test('computeEdges: a dep declared on Stream 1 is dropped (no earlier stream)', () => {
    const streams = parseWorkStreams(
      '### Work Streams\n\n**Stream 1 — A**\n\n- x (depends on Stream 2)\n\n**Stream 2 — B**\n\n- y\n',
    );
    const edges = computeEdges(streams);
    assert('one edge', edges.length === 1, `${edges.length}`);
    assert('linear 1→2 only', edges[0].blocker === 1 && edges[0].blocked === 2);
  });

  await test('alreadyScheduled detects a "## Sizing & Scheduling" own comment', () => {
    assert('none when empty', alreadyScheduled([]) === false);
    assert('none for unrelated', alreadyScheduled([{ body: 'a plain review' }]) === false);
    assert('found', alreadyScheduled([{ body: '## Sizing & Scheduling\n\n**Size:** L' }]) === true);
    assert('not matched mid-prose', alreadyScheduled([{ body: 'see the ## Sizing & Scheduling below' }]) === false);
  });

  // ── no-op gates ─────────────────────────────────────────────────────────────

  await test('raw ticket source → no-op, recommend_split=false', async () => {
    const worker = 60;
    const source = fakeTicketSource({ name: 'raw' });
    const res = await run({
      worker, repo: TMP, ticketId: 'anything', ticketTitle: 'T',
      source, computeSizingSignal: fakeSizing(SPLIT), plan: PLAN,
    });
    assert('status skipped', res.status === 'skipped', res.status);
    assert('no children', source.created.length === 0);
    assert('recommend_split=false', readState(worker).recommend_split === 'false');
  });

  await test('not configured → no-op', async () => {
    const worker = 61;
    const source = fakeTicketSource();
    const res = await run({
      worker, repo: TMP, ticketId: 'muaddib#1', ticketTitle: 'T',
      source, computeSizingSignal: fakeSizing({ configured: false }), plan: PLAN,
    });
    assert('status skipped', res.status === 'skipped');
    assert('reason not configured', /not configured/.test(res.reason));
    assert('no children', source.created.length === 0);
  });

  await test('recommendSplit=false → no-op', async () => {
    const worker = 62;
    const source = fakeTicketSource();
    const res = await run({
      worker, repo: TMP, ticketId: 'muaddib#1', ticketTitle: 'T', source,
      computeSizingSignal: fakeSizing({ configured: true, signal: { size: 'S', confidence: 'high', recommendSplit: false } }),
      plan: PLAN,
    });
    assert('status skipped', res.status === 'skipped');
    assert('no children', source.created.length === 0);
    assert('recommend_split=false', readState(worker).recommend_split === 'false');
  });

  await test('a misbehaving sizing hook (rejects) → no-op, not a throw', async () => {
    const worker = 63;
    const source = fakeTicketSource();
    const res = await run({
      worker, repo: TMP, ticketId: 'muaddib#1', ticketTitle: 'T', source,
      computeSizingSignal: fakeSizing(() => { throw new Error('hook exploded'); }),
      plan: PLAN,
    });
    assert('status skipped', res.status === 'skipped', res.status);
    assert('reason is the hook error', /hook error/.test(res.reason));
    assert('no children', source.created.length === 0);
  });

  await test('recommend split but streamless plan → no-op', async () => {
    const worker = 64;
    const source = fakeTicketSource();
    const res = await run({
      worker, repo: TMP, ticketId: 'muaddib#1', ticketTitle: 'T', source,
      computeSizingSignal: fakeSizing(SPLIT),
      plan: '## Plan\n\n### Solution\n\njust do it\n',
    });
    assert('status skipped', res.status === 'skipped');
    assert('reason no work streams', /no work streams/.test(res.reason));
    assert('no children', source.created.length === 0);
  });

  // ── happy split path ─────────────────────────────────────────────────────────

  await test('split: creates children, wires the chain, posts context + review, writes state', async () => {
    const worker = 65;
    const source = fakeTicketSource();
    const context = '## Context\n\n### taskManager\nthe whole parent context';
    const res = await run({
      worker, repo: TMP, ticketId: 'muaddib#50', ticketTitle: 'Big feature',
      source, computeSizingSignal: fakeSizing(SPLIT), plan: PLAN, context,
    });

    assert('status scheduled', res.status === 'scheduled', res.status);
    assert('three children created', source.created.length === 3, `${source.created.length}`);
    assert('child title = parent — stream', source.created[0].title === 'Big feature — Schema migration');
    assert('child parentId is the ticket', source.created.every((c) => c.parentId === 'muaddib#50'));
    assert('child description carries the stream body', /Add the column/.test(source.created[0].description));

    assert('two blocking relations', source.relations.length === 2, `${source.relations.length}`);
    const ids = source.created.map((c) => c.identifier);
    assert('linear chain c1→c2', source.relations[0].blockerId === ids[0] && source.relations[0].blockedId === ids[1]);
    assert('linear chain c2→c3', source.relations[1].blockerId === ids[1] && source.relations[1].blockedId === ids[2]);

    // Context posted to each child (one comment each — under the cap), then the
    // review comment on the parent.
    const childContextPosts = source.posts.filter((p) => ids.includes(p.id));
    assert('context posted to all three children', childContextPosts.length === 3, `${childContextPosts.length}`);
    assert('child context is the whole parent context', childContextPosts.every((p) => /the whole parent context/.test(p.body)));

    const parentPosts = source.posts.filter((p) => p.id === 'muaddib#50');
    assert('one review comment on the parent', parentPosts.length === 1, `${parentPosts.length}`);
    const review = parentPosts[0].body;
    assert('review is a ## Sizing & Scheduling comment', review.startsWith('## Sizing & Scheduling'));
    assert('review shows the size + confidence', /\*\*Size:\*\* L \(confidence: high\)/.test(review));
    assert('review lists sub-issues in order', new RegExp(`1\\. ${ids[0]} — Big feature — Schema migration`).test(review));
    assert('review lists the blocking relations', new RegExp(`- ${ids[0]} blocks ${ids[1]}`).test(review));

    const st = readState(worker);
    assert('recommend_split=true', st.recommend_split === 'true');
    assert('sub_issues persisted as JSON array', st.sub_issues === JSON.stringify(ids));
  });

  await test('split with no context.md → children + relations + review, but no context comments', async () => {
    const worker = 66;
    const source = fakeTicketSource();
    const res = await run({
      worker, repo: TMP, ticketId: 'muaddib#70', ticketTitle: 'Feature',
      source, computeSizingSignal: fakeSizing(SPLIT), plan: PLAN, context: null,
    });
    assert('status scheduled', res.status === 'scheduled');
    const ids = source.created.map((c) => c.identifier);
    const childPosts = source.posts.filter((p) => ids.includes(p.id));
    assert('no child context comments', childPosts.length === 0, `${childPosts.length}`);
    assert('still one review on the parent', source.posts.filter((p) => p.id === 'muaddib#70').length === 1);
  });

  await test('idempotency: an existing "## Sizing & Scheduling" comment → skip, no duplicates', async () => {
    const worker = 68;
    const source = fakeTicketSource({
      existingComments: { own: [{ id: 'c1', body: '## Sizing & Scheduling\n\n**Size:** L (confidence: high)' }], parent: [] },
    });
    const res = await run({
      worker, repo: TMP, ticketId: 'muaddib#90', ticketTitle: 'Feature',
      source, computeSizingSignal: fakeSizing(SPLIT), plan: PLAN, context: '## Context\n\nx',
    });
    assert('status skipped', res.status === 'skipped', res.status);
    assert('reason already scheduled', /already scheduled/.test(res.reason));
    assert('no children re-created', source.created.length === 0);
    assert('no relations re-wired', source.relations.length === 0);
    assert('no comments re-posted', source.posts.length === 0);
    assert('recommend_split stays true', readState(worker).recommend_split === 'true');
  });

  await test('split with an explicit dep → the override edge is wired (not the linear one)', async () => {
    const worker = 67;
    const source = fakeTicketSource();
    const plan =
      '### Work Streams\n\n**Stream 1 — A**\n\n- x\n\n**Stream 2 — B**\n\n- y\n\n**Stream 3 — C**\n\n- z (depends on Stream 1)\n';
    await run({
      worker, repo: TMP, ticketId: 'muaddib#80', ticketTitle: 'Dep',
      source, computeSizingSignal: fakeSizing(SPLIT), plan,
    });
    const ids = source.created.map((c) => c.identifier); // [c1, c2, c3]
    assert('two relations', source.relations.length === 2, `${source.relations.length}`);
    assert('c1→c2 default', source.relations[0].blockerId === ids[0] && source.relations[0].blockedId === ids[1]);
    assert('c1→c3 override (not c2→c3)', source.relations[1].blockerId === ids[0] && source.relations[1].blockedId === ids[2]);
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
