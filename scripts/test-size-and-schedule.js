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
  runPropose,
  runCommit,
  extractWorkStreamsSection,
  parseWorkStreams,
  computeEdges,
  parseContextItems,
  selectRelevantItems,
  scopeContextForStream,
  alreadyScheduled,
} = require('./size-and-schedule');
const { formatContext } = require('../services/context-comments');

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

// Seed a worker-state key (the commit phase reads sizing_confirm from here).
// Goes through the real state module so STATE_DIR=TMP is honored.
const stateModule = require('../orchestrator/state');
function stateModuleSet(worker, key, value) {
  stateModule.set(worker, key, value);
}

// A fake ticket source recording sub-issue creates, blocking relations, and
// comment posts. createSubIssue mints a deterministic child identifier per call.
// `existingComments` seeds fetchComments so the idempotency path is testable.
function fakeTicketSource({
  name = 'github',
  prefix = 'muaddib',
  existingComments = { own: [], parent: [] },
  markThrows = false,
} = {}) {
  const created = [];
  const relations = [];
  const posts = [];
  const dispatched = [];
  let n = 100;
  return {
    name,
    created,
    relations,
    posts,
    dispatched,
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
    async markReadyForDispatch(id) {
      if (markThrows) throw new Error('label add failed');
      dispatched.push(id);
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

// A realistic parent "## Context" built through the real formatContext, so the
// per-child scoping tests exercise the actual round-trip parseContextItems has to
// invert. Item bodies are worded to overlap PLAN's three streams one-to-one; the
// "Deployment runbook" item overlaps none of them (it must never leak into a
// scoped child), and processDocs is a summary-only source (no items).
const CONTEXT_RESULTS = [
  {
    name: 'taskManager',
    summary: '',
    items: [
      { title: 'Database schema notes', body: 'The users table needs a new column and a backfill migration.' },
      { title: 'API routing conventions', body: 'All endpoints validate input before hitting the route handler.' },
      { title: 'Frontend form guidelines', url: 'https://wiki.example/forms', body: 'Render the form with the shared component.' },
      { title: 'Deployment runbook', body: 'The CI pipeline deploys nightly to production.' },
    ],
  },
  { name: 'processDocs', summary: 'No linked docs configured.', items: [] },
];
const CONTEXT_WITH_ITEMS = formatContext(CONTEXT_RESULTS);

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

  await test('parseContextItems inverts formatContext (sources, summary, items, url)', () => {
    const sources = parseContextItems(CONTEXT_WITH_ITEMS);
    assert('two sources', sources.length === 2, `${sources.length}`);
    assert('names in order', sources[0].name === 'taskManager' && sources[1].name === 'processDocs');
    assert('taskManager has four items', sources[0].items.length === 4, `${sources[0].items.length}`);
    assert('item titles parsed', sources[0].items[0].title === 'Database schema notes');
    assert('item body parsed', /backfill migration/.test(sources[0].items[0].body));
    const frontend = sources[0].items.find((it) => it.title === 'Frontend form guidelines');
    assert('item url parsed', frontend.url === 'https://wiki.example/forms');
    assert('url is not swallowed into the body', !/wiki\.example/.test(frontend.body) && /Render the form/.test(frontend.body));
    assert('summary-only source kept, no items', sources[1].items.length === 0 && /No linked docs/.test(sources[1].summary));
  });

  await test('parseContextItems: no ### sections → []', () => {
    assert('empty', parseContextItems('').length === 0);
    assert('header only', parseContextItems('## Context\n\nsome prose, no sources').length === 0);
    assert('null', parseContextItems(null).length === 0);
  });

  await test('selectRelevantItems keeps overlapping items, drops the rest', () => {
    const streams = parseWorkStreams(PLAN);
    const items = parseContextItems(CONTEXT_WITH_ITEMS)[0].items;
    const s1 = selectRelevantItems(items, streams[0]); // Schema migration
    assert('stream 1 → only the schema item', s1.length === 1 && s1[0].title === 'Database schema notes', JSON.stringify(s1.map((i) => i.title)));
    const s2 = selectRelevantItems(items, streams[1]); // API endpoint
    assert('stream 2 → only the API item', s2.length === 1 && s2[0].title === 'API routing conventions', JSON.stringify(s2.map((i) => i.title)));
    const s3 = selectRelevantItems(items, streams[2]); // Frontend
    assert('stream 3 → only the frontend item', s3.length === 1 && s3[0].title === 'Frontend form guidelines', JSON.stringify(s3.map((i) => i.title)));
    assert('the unrelated deployment item is never selected', ![s1, s2, s3].some((sel) => sel.some((it) => it.title === 'Deployment runbook')));
  });

  await test('selectRelevantItems: a termless stream selects nothing (→ caller falls back)', () => {
    const items = parseContextItems(CONTEXT_WITH_ITEMS)[0].items;
    assert('empty stream → []', selectRelevantItems(items, { name: '', steps: [], body: '' }).length === 0);
    assert('stopwords-only stream → []', selectRelevantItems(items, { name: 'the and for', steps: [], body: '' }).length === 0);
  });

  await test('scopeContextForStream: scoped markdown on a match, null on none', () => {
    const streams = parseWorkStreams(PLAN);
    const sources = parseContextItems(CONTEXT_WITH_ITEMS);
    const scoped = scopeContextForStream(sources, streams[0]); // Schema migration
    assert('returns a ## Context doc', typeof scoped === 'string' && scoped.startsWith('## Context'));
    assert('keeps the relevant item', /Database schema notes/.test(scoped));
    assert('drops the API item', !/API routing conventions/.test(scoped));
    assert('drops the unrelated deployment item', !/Deployment runbook/.test(scoped));
    const none = scopeContextForStream(sources, { number: 9, name: 'Documentation polish', steps: ['Proofread wording'], body: 'Proofread wording' });
    assert('no match anywhere → null (fallback signal)', none === null);
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
    assert('review is a ## Sub-issues created comment', review.startsWith('## Sub-issues created'));
    assert('review shows the size + confidence', /\*\*Size:\*\* L \(confidence: high\)/.test(review));
    assert('review lists sub-issues in order', new RegExp(`1\\. ${ids[0]} — Big feature — Schema migration`).test(review));
    assert('review lists the blocking relations', new RegExp(`- ${ids[0]} blocks ${ids[1]}`).test(review));

    const st = readState(worker);
    assert('recommend_split=true', st.recommend_split === 'true');
    assert('sub_issues persisted as JSON array', st.sub_issues === JSON.stringify(ids));
  });

  await test('split: each child gets a "## Context" scoped to its own work stream', async () => {
    const worker = 69;
    const source = fakeTicketSource();
    const res = await run({
      worker, repo: TMP, ticketId: 'muaddib#55', ticketTitle: 'Big feature',
      source, computeSizingSignal: fakeSizing(SPLIT), plan: PLAN, context: CONTEXT_WITH_ITEMS,
    });
    assert('status scheduled', res.status === 'scheduled', res.status);
    const ids = source.created.map((c) => c.identifier); // [c1=Schema, c2=API, c3=Frontend]
    const ctx = (id) => source.posts.filter((p) => p.id === id).map((p) => p.body).join('\n');

    assert('schema child sees the schema item', /Database schema notes/.test(ctx(ids[0])));
    assert('schema child does NOT see the API item', !/API routing conventions/.test(ctx(ids[0])));
    assert('API child sees the API item', /API routing conventions/.test(ctx(ids[1])));
    assert('API child does NOT see the schema item', !/Database schema notes/.test(ctx(ids[1])));
    assert('frontend child sees the frontend item', /Frontend form guidelines/.test(ctx(ids[2])));
    assert('frontend child does NOT see the API item', !/API routing conventions/.test(ctx(ids[2])));
    // The unrelated item scopes into no child.
    assert('no child sees the unrelated deployment item', ![ids[0], ids[1], ids[2]].some((id) => /Deployment runbook/.test(ctx(id))));
    // One scoped comment per child (each fits under the cap).
    assert('one context comment per child', source.posts.filter((p) => ids.includes(p.id)).length === 3);
  });

  await test('split: a child whose stream matches nothing falls back to the FULL parent context', async () => {
    const worker = 70;
    const source = fakeTicketSource();
    // Stream 1 overlaps the schema item; Stream 2 ("Documentation polish") overlaps
    // no context item, so it must receive the whole parent context, not zero.
    const plan =
      '### Work Streams\n\n**Stream 1 — Schema migration**\n\n- Add the column\n- Backfill\n\n' +
      '**Stream 2 — Documentation polish**\n\n- Proofread the wording\n';
    const res = await run({
      worker, repo: TMP, ticketId: 'muaddib#56', ticketTitle: 'Mixed',
      source, computeSizingSignal: fakeSizing(SPLIT), plan, context: CONTEXT_WITH_ITEMS,
    });
    assert('status scheduled', res.status === 'scheduled', res.status);
    const ids = source.created.map((c) => c.identifier); // [c1=Schema, c2=Docs]
    const ctx = (id) => source.posts.filter((p) => p.id === id).map((p) => p.body).join('\n');

    assert('schema child is scoped (no deployment item)', /Database schema notes/.test(ctx(ids[0])) && !/Deployment runbook/.test(ctx(ids[0])));
    // The non-matching child gets everything, including the otherwise-dropped item.
    assert('docs child falls back to full context', /Deployment runbook/.test(ctx(ids[1])) && /Database schema notes/.test(ctx(ids[1])) && /API routing conventions/.test(ctx(ids[1])));
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

  await test('idempotency: an existing "## Sub-issues created" comment → skip, no duplicates', async () => {
    const worker = 68;
    const source = fakeTicketSource({
      existingComments: { own: [{ id: 'c1', body: '## Sub-issues created\n\n**Size:** L (confidence: high)' }], parent: [] },
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

  await test('idempotency: eager and commit dedup against each other (shared marker)', async () => {
    // A ticket already decomposed by --commit ("## Sub-issues created") must not
    // be re-decomposed by a later eager run (and vice versa).
    const worker = 681;
    const source = fakeTicketSource({
      existingComments: { own: [{ id: 'c1', body: '## Sub-issues created\n\n**Size:** L' }], parent: [] },
    });
    const res = await run({
      worker, repo: TMP, ticketId: 'muaddib#91', ticketTitle: 'Feature',
      source, computeSizingSignal: fakeSizing(SPLIT), plan: PLAN,
    });
    assert('eager skips on the commit marker', res.status === 'skipped', res.status);
    assert('no children re-created', source.created.length === 0);
  });

  await test('idempotency: a bare "## Sizing & Scheduling" preview does NOT block the eager path', async () => {
    // The propose preview shares that header but creates no children, so eager
    // must still decompose (mirrors the commit-side preview test).
    const worker = 682;
    const source = fakeTicketSource({
      existingComments: { own: [{ id: 'c1', body: '## Sizing & Scheduling\n\n**Proposed sub-issues**' }], parent: [] },
    });
    const res = await run({
      worker, repo: TMP, ticketId: 'muaddib#92', ticketTitle: 'Feature',
      source, computeSizingSignal: fakeSizing(SPLIT), plan: PLAN,
    });
    assert('status scheduled (preview did not block)', res.status === 'scheduled', res.status);
    assert('three children created', source.created.length === 3, `${source.created.length}`);
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

  // ── propose phase (preview only, no children) ────────────────────────────────

  await test('propose: posts the preview, creates NO children, writes recommend_split + plan', async () => {
    const worker = 71;
    const source = fakeTicketSource();
    const res = await runPropose({
      worker, repo: TMP, ticketId: 'muaddib#100', ticketTitle: 'Big feature',
      source, computeSizingSignal: fakeSizing(SPLIT), plan: PLAN, context: CONTEXT_WITH_ITEMS,
    });
    assert('status proposed', res.status === 'proposed', res.status);
    assert('no children created', source.created.length === 0);
    assert('no relations wired', source.relations.length === 0);

    const previews = source.posts.filter((p) => p.id === 'muaddib#100');
    assert('one preview posted on the parent', previews.length === 1, `${previews.length}`);
    const preview = previews[0].body;
    assert('preview is a ## Sizing & Scheduling comment', preview.startsWith('## Sizing & Scheduling'));
    assert('preview lists streams by name (no identifiers)', /Stream 1 — Schema migration/.test(preview));
    assert('preview lists the planned edges by stream number', /Stream 1 blocks Stream 2/.test(preview));
    assert('preview spells out the three choices', /needs adjustment/.test(preview));
    assert('preview carries no child identifier', !/muaddib#10\d/.test(preview));

    const st = readState(worker);
    assert('recommend_split=true', st.recommend_split === 'true');
    assert('sub_issues_plan persisted', /Schema migration/.test(st.sub_issues_plan || ''));
    assert('sub_issues NOT written (nothing created)', st.sub_issues === undefined);
  });

  await test('propose: re-runs post a fresh preview (not idempotent — the adjust loop)', async () => {
    const worker = 72;
    const source = fakeTicketSource();
    const args = {
      worker, repo: TMP, ticketId: 'muaddib#101', ticketTitle: 'Big feature',
      source, computeSizingSignal: fakeSizing(SPLIT), plan: PLAN,
    };
    await runPropose(args);
    await runPropose(args);
    assert('two previews posted across two rounds', source.posts.filter((p) => p.id === 'muaddib#101').length === 2);
  });

  await test('propose: recommendSplit=false → no-op, no preview', async () => {
    const worker = 73;
    const source = fakeTicketSource();
    const res = await runPropose({
      worker, repo: TMP, ticketId: 'muaddib#1', ticketTitle: 'T', source,
      computeSizingSignal: fakeSizing({ configured: true, signal: { size: 'S', confidence: 'high', recommendSplit: false } }),
      plan: PLAN,
    });
    assert('status skipped', res.status === 'skipped', res.status);
    assert('no preview posted', source.posts.length === 0);
    assert('recommend_split=false', readState(worker).recommend_split === 'false');
  });

  // ── commit phase (create children; dispatch only on the dispatch option) ─────

  await test('commit (tickets_only): creates children + relations + created comment, no dispatch', async () => {
    const worker = 74;
    const source = fakeTicketSource();
    stateModuleSet(worker, 'sizing_confirm', 'tickets_only');
    const res = await runCommit({
      worker, repo: TMP, ticketId: 'muaddib#110', ticketTitle: 'Big feature',
      source, computeSizingSignal: fakeSizing(SPLIT), plan: PLAN, context: CONTEXT_WITH_ITEMS,
    });
    assert('status committed', res.status === 'committed', res.status);
    assert('dispatched=false', res.dispatched === false);
    assert('three children created', source.created.length === 3, `${source.created.length}`);
    assert('two relations wired', source.relations.length === 2, `${source.relations.length}`);
    assert('nothing marked ready-for-dispatch', source.dispatched.length === 0);

    const parentPosts = source.posts.filter((p) => p.id === 'muaddib#110');
    assert('one created comment on the parent', parentPosts.length === 1, `${parentPosts.length}`);
    assert('created comment uses the ## Sub-issues created header', parentPosts[0].body.startsWith('## Sub-issues created'));
    const ids = source.created.map((c) => c.identifier);
    assert('created comment lists the child identifiers', new RegExp(`1\\. ${ids[0]} —`).test(parentPosts[0].body));

    const st = readState(worker);
    assert('recommend_split=true', st.recommend_split === 'true');
    assert('sub_issues persisted as JSON array', st.sub_issues === JSON.stringify(ids));
  });

  await test('commit (dispatch): marks each created child ready-for-dispatch', async () => {
    const worker = 75;
    const source = fakeTicketSource();
    stateModuleSet(worker, 'sizing_confirm', 'dispatch');
    const res = await runCommit({
      worker, repo: TMP, ticketId: 'muaddib#120', ticketTitle: 'Big feature',
      source, computeSizingSignal: fakeSizing(SPLIT), plan: PLAN,
    });
    assert('status committed', res.status === 'committed', res.status);
    assert('dispatched=true', res.dispatched === true);
    const ids = source.created.map((c) => c.identifier);
    assert('all three children marked ready-for-dispatch', source.dispatched.length === 3, `${source.dispatched.length}`);
    assert('marked the created identifiers', JSON.stringify(source.dispatched) === JSON.stringify(ids));
  });

  await test('commit (dispatch): emits tickets_ready_for_dispatch for the Conductor', async () => {
    const worker = 78;
    const source = fakeTicketSource();
    const emitted = [];
    stateModuleSet(worker, 'sizing_confirm', 'dispatch');
    const res = await runCommit({
      worker, repo: TMP, ticketId: 'muaddib#140', ticketTitle: 'Big feature',
      source, computeSizingSignal: fakeSizing(SPLIT), plan: PLAN,
      emit: (...args) => emitted.push(args),
    });
    assert('status committed', res.status === 'committed', res.status);
    assert('exactly one event emitted', emitted.length === 1, `${emitted.length}`);
    const [w, job, event, payload] = emitted[0];
    assert('emitted on this worker', w === worker);
    assert('job is size-and-schedule', job === 'size-and-schedule');
    assert('event is tickets_ready_for_dispatch', event === 'tickets_ready_for_dispatch');
    assert('payload names the parent ticket', payload.parentTicket === 'muaddib#140');
    const ids = source.created.map((c) => c.identifier);
    assert('payload lists the created children', JSON.stringify(payload.children) === JSON.stringify(ids));
  });

  await test('commit (tickets_only): no tickets_ready_for_dispatch event — nothing to dispatch yet', async () => {
    const worker = 79;
    const source = fakeTicketSource();
    const emitted = [];
    stateModuleSet(worker, 'sizing_confirm', 'tickets_only');
    await runCommit({
      worker, repo: TMP, ticketId: 'muaddib#145', ticketTitle: 'Big feature',
      source, computeSizingSignal: fakeSizing(SPLIT), plan: PLAN,
      emit: (...args) => emitted.push(args),
    });
    assert('no event emitted', emitted.length === 0, `${emitted.length}`);
  });

  await test('commit (dispatch): a throwing emit is best-effort, does not fail the commit', async () => {
    const worker = 80;
    const source = fakeTicketSource();
    stateModuleSet(worker, 'sizing_confirm', 'dispatch');
    const res = await runCommit({
      worker, repo: TMP, ticketId: 'muaddib#150', ticketTitle: 'Big feature',
      source, computeSizingSignal: fakeSizing(SPLIT), plan: PLAN,
      emit: () => { throw new Error('events dir unwritable'); },
    });
    assert('status still committed', res.status === 'committed', res.status);
    assert('children still marked ready-for-dispatch', source.dispatched.length === 3);
  });

  await test('commit: opts.dispatch overrides state (explicit dispatch)', async () => {
    const worker = 76;
    const source = fakeTicketSource();
    stateModuleSet(worker, 'sizing_confirm', 'tickets_only'); // state says no, opt says yes
    const res = await runCommit({
      worker, repo: TMP, ticketId: 'muaddib#125', ticketTitle: 'Big feature',
      source, computeSizingSignal: fakeSizing(SPLIT), plan: PLAN, dispatch: true,
    });
    assert('dispatched=true from opts', res.dispatched === true);
    assert('children were marked', source.dispatched.length === 3);
  });

  await test('commit (dispatch): a markReadyForDispatch failure is best-effort (children still created)', async () => {
    const worker = 77;
    const source = fakeTicketSource({ markThrows: true });
    const res = await runCommit({
      worker, repo: TMP, ticketId: 'muaddib#130', ticketTitle: 'Big feature',
      source, computeSizingSignal: fakeSizing(SPLIT), plan: PLAN, dispatch: true,
    });
    assert('status committed (not thrown)', res.status === 'committed', res.status);
    assert('three children still created', source.created.length === 3);
    assert('none recorded dispatched (all throws)', source.dispatched.length === 0);
    const ids = source.created.map((c) => c.identifier);
    assert('sub_issues still persisted', readState(worker).sub_issues === JSON.stringify(ids));
  });

  await test('commit: idempotent on an existing "## Sub-issues created" comment', async () => {
    const worker = 78;
    const source = fakeTicketSource({
      existingComments: { own: [{ id: 'c1', body: '## Sub-issues created\n\n**Size:** L' }], parent: [] },
    });
    const res = await runCommit({
      worker, repo: TMP, ticketId: 'muaddib#140', ticketTitle: 'Feature',
      source, computeSizingSignal: fakeSizing(SPLIT), plan: PLAN, dispatch: true,
    });
    assert('status skipped', res.status === 'skipped', res.status);
    assert('reason already committed', /already committed/.test(res.reason));
    assert('no children re-created', source.created.length === 0);
    assert('nothing re-dispatched', source.dispatched.length === 0);
    assert('recommend_split stays true', readState(worker).recommend_split === 'true');
  });

  await test('commit: a preview-only "## Sizing & Scheduling" comment does NOT block commit', async () => {
    // The propose preview shares the "## Sizing & Scheduling" header; commit keys
    // off "## Sub-issues created", so a preview alone must not read as committed.
    const worker = 79;
    const source = fakeTicketSource({
      existingComments: { own: [{ id: 'c1', body: '## Sizing & Scheduling\n\n**Proposed sub-issues**' }], parent: [] },
    });
    const res = await runCommit({
      worker, repo: TMP, ticketId: 'muaddib#150', ticketTitle: 'Feature',
      source, computeSizingSignal: fakeSizing(SPLIT), plan: PLAN,
    });
    assert('status committed (preview did not block)', res.status === 'committed', res.status);
    assert('three children created', source.created.length === 3);
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
