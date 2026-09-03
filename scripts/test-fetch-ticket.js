#!/usr/bin/env node
'use strict';
// Tests fetch-ticket.js core logic with mocked Linear responses.
// Usage: node muaddib/scripts/test-fetch-ticket.js
// No network calls, no Docker required.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Point state at a temp dir so tests don't pollute real worker state.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-ticket-test-'));
process.env.STATE_DIR = TMP;

const { run, extractIdentifier, findPlanComment, extractPlanSection } = require('./fetch-ticket');

// ─── test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
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
    console.error(`  ✗ threw unexpectedly: ${err.message}`);
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

function mockGql(issue) {
  return async (_query, _variables) => ({ issue });
}

// ─── fixtures ─────────────────────────────────────────────────────────────────

const BASE_ISSUE = {
  id: 'abc123',
  identifier: 'QUO-99',
  title: 'Fix the thing',
  description: 'Some description',
  url: 'https://linear.app/quotethat/issue/QUO-99/fix-the-thing',
  state: { name: 'In Progress' },
  parent: null,
  comments: { nodes: [] },
};

const PLAN_BODY = `
Some preamble text before the plan.

## Plan

### Work stream 1 — Backend
- Add the endpoint

### Work stream 2 — Frontend
- Wire up the UI
`.trim();

const PARENT_PLAN_COMMENT = {
  id: 'c-parent-1',
  body: PLAN_BODY,
  user: { name: 'Paul' },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

// ─── unit tests for pure helpers ──────────────────────────────────────────────

console.log('\n── extractIdentifier ──────────────────────────────────────────');

assert(
  'extracts from full URL',
  extractIdentifier('https://linear.app/quotethat/issue/QUO-123/fix-the-thing') === 'QUO-123'
);
assert(
  'extracts from URL with no title slug',
  extractIdentifier('https://linear.app/quotethat/issue/QUO-42') === 'QUO-42'
);
assert(
  'extracts bare identifier',
  extractIdentifier('QUO-7') === 'QUO-7'
);
assert(
  'uppercases the result',
  extractIdentifier('quo-7') === 'QUO-7'
);
assert(
  'returns null for empty string',
  extractIdentifier('') === null
);
assert(
  'returns null for non-matching string',
  extractIdentifier('https://github.com/org/repo') === null
);
assert(
  // muaddib.sh passes TASK as "/<skill-name> <ticket>"; the known slash-command
  // wrapper is stripped before matching.
  'finds a bare identifier after a /muaddib prefix',
  extractIdentifier('/muaddib QUO-7') === 'QUO-7'
);
assert(
  // A ticket reference is the tool's single argument, never free-form text — an
  // identifier-shaped token embedded in a sentence must NOT be misread as a
  // ticket reference (the GPT-4 / utf-8 false-positive class).
  'rejects an identifier embedded in a free-form sentence',
  extractIdentifier('Ticket QUO-7 needs fixing') === null
);

// github source kind — bare issue numbers, not Linear-shaped ids.
assert(
  "github: extracts number from an issue URL",
  extractIdentifier('https://github.com/rphovley/muaddib/issues/36', 'github') === '36'
);
assert(
  'github: accepts a bare number',
  extractIdentifier('36', 'github') === '36'
);
assert(
  "github: strips a leading '#'",
  extractIdentifier('#36', 'github') === '36'
);
assert(
  'github: returns null for a Linear-shaped id',
  extractIdentifier('QUO-7', 'github') === null
);
assert(
  // muaddib.sh (and muaddib-fast.sh/muaddib-plan.sh) pass TASK as
  // "/<skill-name> <ticket>", not the bare ticket — the known slash-command
  // wrapper is stripped before matching.
  'github: finds a bare number after a /muaddib prefix',
  extractIdentifier('/muaddib 36', 'github') === '36'
);
assert(
  "github: finds a '#'-prefixed number after a /muaddib prefix",
  extractIdentifier('/muaddib #36', 'github') === '36'
);
assert(
  // The whole point of stripping the prefix instead of scanning past it: a
  // free-form sentence with an embedded number must NOT be misread as a
  // ticket reference, even with a slash-command prefix in front of it.
  "github: rejects a free-form sentence with an embedded number",
  extractIdentifier("/muaddib-task Investigate why there's only 32 items left", 'github') === null
);
assert(
  'github: rejects a free-form sentence with an embedded number, no prefix at all',
  extractIdentifier("Help me figure out why there's only 32 items", 'github') === null
);
assert(
  "explicit 'linear' kind matches the default behavior",
  extractIdentifier('QUO-7', 'linear') === 'QUO-7'
);

console.log('\n── findPlanComment ────────────────────────────────────────────');

assert(
  'returns null when no comments',
  findPlanComment([]) === null
);
assert(
  'returns null when no plan comment',
  findPlanComment([{ body: 'just a review comment' }, { body: 'another comment' }]) === null
);
assert(
  'finds the plan comment body',
  findPlanComment([{ body: 'no plan here' }, { body: PLAN_BODY }]) === PLAN_BODY
);
assert(
  'returns first plan comment when multiple exist',
  findPlanComment([
    { body: '## Plan\nversion 1' },
    { body: '## Plan\nversion 2' },
  ]) === '## Plan\nversion 1'
);

console.log('\n── extractPlanSection ─────────────────────────────────────────');

assert(
  'extracts from start of ## Plan marker',
  extractPlanSection(PLAN_BODY).startsWith('## Plan')
);
assert(
  'strips preamble before ## Plan',
  !extractPlanSection(PLAN_BODY).includes('Some preamble')
);
assert(
  'returns null when no ## Plan marker',
  extractPlanSection('just some comment') === null
);

// ─── integration tests via run() ──────────────────────────────────────────────

async function runIntegrationTests() {

await test('run(): no plan comment → plan_status=not_found', async () => {
  const repo = makeRepo();
  const worker = 10;
  const result = await run(mockGql(BASE_ISSUE), {
    worker,
    task: 'https://linear.app/quotethat/issue/QUO-99/fix-the-thing',
    repo,
    ticketSource: 'linear',
  });

  assert('returns plan_status not_found', result.planStatus === 'not_found');
  assert('state has ticket_identifier', readState(worker).ticket_identifier === 'QUO-99');
  assert('state has ticket_title', readState(worker).ticket_title === 'Fix the thing');
  assert('state has ticket_url', readState(worker).ticket_url.includes('QUO-99'));
  assert('state has plan_status not_found', readState(worker).plan_status === 'not_found');
  assert('no plan.md written', !fs.existsSync(path.join(repo, '.muaddib', 'plan.md')));
  assert('/tmp/ticket-N.json written', fs.existsSync(`/tmp/ticket-${worker}.json`));
});

await test('run(): plan comment on issue → plan_status=found, plan.md written', async () => {
  const repo = makeRepo();
  const worker = 11;
  const issue = {
    ...BASE_ISSUE,
    comments: {
      nodes: [
        { id: 'c1', body: 'Review looks good', user: { name: 'Alice' }, createdAt: '', updatedAt: '' },
        { id: 'c2', body: PLAN_BODY, user: { name: 'Bob' }, createdAt: '', updatedAt: '' },
      ],
    },
  };

  const result = await run(mockGql(issue), { worker, task: 'QUO-99', repo, ticketSource: 'linear' });

  assert('returns plan_status found', result.planStatus === 'found');
  assert('state plan_status is found', readState(worker).plan_status === 'found');

  const planPath = path.join(repo, '.muaddib', 'plan.md');
  assert('plan.md exists', fs.existsSync(planPath));

  const planContent = fs.readFileSync(planPath, 'utf8');
  assert('plan.md starts with ## Plan', planContent.startsWith('## Plan'));
  assert('plan.md does not contain preamble', !planContent.includes('Some preamble'));
  assert('plan.md contains work stream content', planContent.includes('Work stream 1'));
});

await test('run(): plan comment on parent → plan_status=found', async () => {
  const repo = makeRepo();
  const worker = 12;
  const issue = {
    ...BASE_ISSUE,
    comments: { nodes: [] },
    parent: {
      id: 'parent-id',
      identifier: 'QUO-50',
      title: 'Parent epic',
      url: 'https://linear.app/quotethat/issue/QUO-50/parent-epic',
      comments: { nodes: [PARENT_PLAN_COMMENT] },
    },
  };

  const result = await run(mockGql(issue), { worker, task: 'QUO-99', repo, ticketSource: 'linear' });

  assert('returns plan_status found', result.planStatus === 'found');
  assert('plan.md written from parent comment', fs.existsSync(path.join(repo, '.muaddib', 'plan.md')));
});

await test('run(): own comment takes precedence over parent comment', async () => {
  const repo = makeRepo();
  const worker = 13;
  const ownPlan = '## Plan\n\nown plan content';
  const issue = {
    ...BASE_ISSUE,
    comments: {
      nodes: [{ id: 'c1', body: ownPlan, user: { name: 'Paul' }, createdAt: '', updatedAt: '' }],
    },
    parent: {
      id: 'parent-id',
      identifier: 'QUO-50',
      title: 'Parent',
      url: 'https://linear.app/quotethat/issue/QUO-50',
      comments: { nodes: [PARENT_PLAN_COMMENT] },
    },
  };

  await run(mockGql(issue), { worker, task: 'QUO-99', repo, ticketSource: 'linear' });

  const planContent = fs.readFileSync(path.join(repo, '.muaddib', 'plan.md'), 'utf8');
  assert('own plan wins over parent', planContent.includes('own plan content'));
  assert('parent plan not used', !planContent.includes('Work stream 1'));
});

await test('run(): ## Context comment on issue → context.md hydrated', async () => {
  const repo = makeRepo();
  const worker = 40;
  const issue = {
    ...BASE_ISSUE,
    comments: {
      nodes: [
        { id: 'c1', body: 'Review looks good', user: { name: 'Alice' }, createdAt: '', updatedAt: '' },
        { id: 'c2', body: '## Context\n\n### taskManager\ngathered context here', user: { name: 'Bot' }, createdAt: '', updatedAt: '' },
      ],
    },
  };

  await run(mockGql(issue), { worker, task: 'QUO-99', repo, ticketSource: 'linear' });

  const contextPath = path.join(repo, '.muaddib', 'context.md');
  assert('context.md exists', fs.existsSync(contextPath));
  const content = fs.readFileSync(contextPath, 'utf8');
  assert('context.md starts with ## Context', content.startsWith('## Context'));
  assert('context.md has the gathered body', content.includes('gathered context here'));
});

await test('run(): ## Context on parent only → context.md hydrated from parent', async () => {
  const repo = makeRepo();
  const worker = 41;
  const issue = {
    ...BASE_ISSUE,
    comments: { nodes: [] },
    parent: {
      id: 'parent-id',
      identifier: 'QUO-50',
      title: 'Parent',
      url: 'https://linear.app/quotethat/issue/QUO-50',
      comments: { nodes: [{ id: 'p1', body: '## Context\n\n### x\nparent context', user: { name: 'Bot' }, createdAt: '', updatedAt: '' }] },
    },
  };

  await run(mockGql(issue), { worker, task: 'QUO-99', repo, ticketSource: 'linear' });

  const content = fs.readFileSync(path.join(repo, '.muaddib', 'context.md'), 'utf8');
  assert('context.md hydrated from parent', content.includes('parent context'));
});

await test('run(): no ## Context comment → no context.md', async () => {
  const repo = makeRepo();
  const worker = 42;
  await run(mockGql(BASE_ISSUE), { worker, task: 'QUO-99', repo, ticketSource: 'linear' });
  assert('no context.md written', !fs.existsSync(path.join(repo, '.muaddib', 'context.md')));
});

await test('run(): missing identifier throws', async () => {
  let threw = false;
  try {
    await run(mockGql(BASE_ISSUE), { worker: 14, task: 'not-a-ticket-url', repo: makeRepo(), ticketSource: 'linear' });
  } catch (err) {
    threw = err.message.includes('Could not extract');
  }
  assert('throws on bad TASK', threw);
});

await test('run(): issue not found throws', async () => {
  let threw = false;
  try {
    await run(async () => ({ issue: null }), { worker: 15, task: 'QUO-99', repo: makeRepo(), ticketSource: 'linear' });
  } catch (err) {
    threw = err.message.includes('not found');
  }
  assert('throws when issue is null', threw);
});

await test('run(): graphql error propagates', async () => {
  let threw = false;
  try {
    await run(async () => { throw new Error('network failure'); }, { worker: 16, task: 'QUO-99', repo: makeRepo(), ticketSource: 'linear' });
  } catch (err) {
    threw = err.message === 'network failure';
  }
  assert('graphql error propagates', threw);
});

await test('run(): TICKET_SOURCE=raw uses TASK text directly, no gql call', async () => {
  const failIfCalled = async () => { throw new Error('gql should not be called for a raw ticket'); };
  const result = await run(failIfCalled, {
    worker: 17, repo: makeRepo(), ticketSource: 'raw',
    task: 'Fix the flaky retry test in payments',
  });
  assert('planStatus is not_found (no comment thread on a raw ticket)', result.planStatus === 'not_found');
  assert('title is the task text', result.issue.title === 'Fix the flaky retry test in payments');
  assert('identifier is a slug, not a Linear ID', /^fix-the-flaky/.test(result.issue.identifier));
  assert('url is null (no external ticket)', result.issue.url === null);
});

await test('run(): TICKET_SOURCE=raw throws on empty TASK', async () => {
  let threw = false;
  try {
    await run(null, { worker: 18, repo: makeRepo(), ticketSource: 'raw', task: '' });
  } catch (err) {
    threw = err.message.includes('TASK is empty');
  }
  assert('throws a clear error', threw);
});

await test('run(): TICKET_SOURCE=github routes through the generic backend', async () => {
  const repo = makeRepo();
  const worker = 19;
  const githubIssue = {
    id: 'MDU6SXNzdWU=',
    identifier: 'muaddib#36',
    title: 'Route the github source in fetch-ticket',
    description: 'Some description',
    url: 'https://github.com/rphovley/muaddib/issues/36',
    labels: { nodes: [] },
    state: { name: 'open' },
  };
  let fetchedWith = null;
  const fakeSource = {
    fetchTicket: async (id) => { fetchedWith = id; return githubIssue; },
  };
  const failIfCalled = async () => { throw new Error('gql should not be called for a github ticket'); };

  const result = await run(failIfCalled, {
    worker, repo, ticketSource: 'github', source: fakeSource,
    task: 'https://github.com/rphovley/muaddib/issues/36',
  });

  assert('fetchTicket called with the bare issue number', fetchedWith === '36');
  assert('planStatus is not_found (plan-comment scan is Linear-only)', result.planStatus === 'not_found');
  assert('returns the normalized issue', result.issue.title === githubIssue.title);
  assert('state has ticket_identifier', readState(worker).ticket_identifier === 'muaddib#36');
  assert('state has ticket_url', readState(worker).ticket_url === githubIssue.url);
  assert('state plan_status is not_found', readState(worker).plan_status === 'not_found');
  assert('no plan.md written on the github path', !fs.existsSync(path.join(repo, '.muaddib', 'plan.md')));
  assert('/tmp/ticket-N.json written', fs.existsSync(`/tmp/ticket-${worker}.json`));
});

await test('run(): TICKET_SOURCE=github with a not-found issue throws', async () => {
  let threw = false;
  const fakeSource = { fetchTicket: async () => null };
  try {
    await run(null, {
      worker: 20, repo: makeRepo(), ticketSource: 'github', source: fakeSource, task: '36',
    });
  } catch (err) {
    threw = err.message.includes('not found');
  }
  assert('throws when fetchTicket returns null', threw);
});

// ─── results ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);

if (failed > 0) process.exit(1);

} // end runIntegrationTests

runIntegrationTests().catch((err) => { console.error(err); process.exit(1); });
