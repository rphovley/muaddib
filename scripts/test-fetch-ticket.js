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

  const result = await run(mockGql(issue), { worker, task: 'QUO-99', repo });

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

  const result = await run(mockGql(issue), { worker, task: 'QUO-99', repo });

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

  await run(mockGql(issue), { worker, task: 'QUO-99', repo });

  const planContent = fs.readFileSync(path.join(repo, '.muaddib', 'plan.md'), 'utf8');
  assert('own plan wins over parent', planContent.includes('own plan content'));
  assert('parent plan not used', !planContent.includes('Work stream 1'));
});

await test('run(): missing identifier throws', async () => {
  let threw = false;
  try {
    await run(mockGql(BASE_ISSUE), { worker: 14, task: 'not-a-ticket-url', repo: makeRepo() });
  } catch (err) {
    threw = err.message.includes('Could not extract');
  }
  assert('throws on bad TASK', threw);
});

await test('run(): issue not found throws', async () => {
  let threw = false;
  try {
    await run(async () => ({ issue: null }), { worker: 15, task: 'QUO-99', repo: makeRepo() });
  } catch (err) {
    threw = err.message.includes('not found');
  }
  assert('throws when issue is null', threw);
});

await test('run(): graphql error propagates', async () => {
  let threw = false;
  try {
    await run(async () => { throw new Error('network failure'); }, { worker: 16, task: 'QUO-99', repo: makeRepo() });
  } catch (err) {
    threw = err.message === 'network failure';
  }
  assert('graphql error propagates', threw);
});

// ─── results ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);

if (failed > 0) process.exit(1);

} // end runIntegrationTests

runIntegrationTests().catch((err) => { console.error(err); process.exit(1); });
