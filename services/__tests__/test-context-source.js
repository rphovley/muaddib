#!/usr/bin/env node
'use strict';
// ContextSource registry + builtins test suite — no network calls.
//
// The registry's type/source resolution (and its unknown-pair errors) is
// exercised directly; each builtin is exercised against an injected backend
// (taskManager) or a temp REPO_DIR fixture (decisionLog / processDocs), matching
// test-ticket-source.js conventions — plain node:assert, no external I/O.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  getContextSource,
  createTaskManagerSource,
  createDecisionLogSource,
  createProcessDocsSource,
  taskManagerSource,
  decisionLogSource,
  processDocsSource,
  VALID_CONTEXT_SOURCE_TYPES,
  CONTEXT_SOURCE_SOURCES,
} = require('../context-source');

// A temp checkout with a .muaddib/ dir; caller writes fixtures into it.
function withTempRepo(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-'));
  fs.mkdirSync(path.join(dir, '.muaddib'), { recursive: true });
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ─── registry ────────────────────────────────────────────────────────────────

async function testResolvesEachType() {
  assert.strictEqual(getContextSource('taskManager', 'builtin').name, 'taskManager');
  // An explicit non-builtin source is reflected in the name so two taskManager
  // entries can't collide on one shared name.
  assert.strictEqual(getContextSource('taskManager', 'linear').name, 'taskManager:linear');
  assert.strictEqual(getContextSource('taskManager', 'github').name, 'taskManager:github');
  assert.strictEqual(getContextSource('decisionLog', 'builtin').name, 'decisionLog');
  assert.strictEqual(getContextSource('processDocs', 'builtin').name, 'processDocs');
}

async function testSourceDefaultsToBuiltin() {
  // A bare `type` (no source) resolves to that type's builtin default.
  assert.strictEqual(getContextSource('taskManager').name, 'taskManager');
  assert.strictEqual(getContextSource('decisionLog').name, 'decisionLog');
  assert.strictEqual(getContextSource('processDocs').name, 'processDocs');
}

async function testUnknownTypeThrows() {
  assert.throws(() => getContextSource('slack'), /unknown context source type: "slack"/);
  // The error lists the supported types.
  assert.throws(() => getContextSource('slack'), /taskManager, decisionLog, processDocs/);
}

async function testUnknownSourceForTypeThrows() {
  // A known type with a source it doesn't accept — mirrors the ticket-source
  // "unknown ... (supported: …)" shape, scoped to the type.
  assert.throws(
    () => getContextSource('decisionLog', 'linear'),
    /unknown context source: "linear" for type "decisionLog" \(supported: builtin\)/
  );
  assert.throws(
    () => getContextSource('taskManager', 'jira'),
    /unknown context source: "jira" for type "taskManager" \(supported: linear, raw, github, builtin\)/
  );
}

async function testValidTypesExport() {
  assert.deepStrictEqual(VALID_CONTEXT_SOURCE_TYPES, ['taskManager', 'decisionLog', 'processDocs']);
  assert.deepStrictEqual(CONTEXT_SOURCE_SOURCES.taskManager, ['linear', 'raw', 'github', 'builtin']);
  assert.deepStrictEqual(CONTEXT_SOURCE_SOURCES.decisionLog, ['builtin']);
  assert.deepStrictEqual(CONTEXT_SOURCE_SOURCES.processDocs, ['builtin']);
}

// ─── taskManager builtin ─────────────────────────────────────────────────────

async function testTaskManagerUsesPassedTicket() {
  // When the caller already has the ticket, no backend fetch happens.
  const src = createTaskManagerSource({
    getTicketSource: () => {
      throw new Error('must not resolve a backend when a ticket is passed');
    },
  });
  const ticket = {
    identifier: 'muaddib#101',
    title: 'Add contextSources registry',
    description: 'the body',
    url: 'https://github.com/rphovley/muaddib/issues/101',
  };
  const ctx = await src.gatherContext('101', ticket);
  assert.strictEqual(ctx.summary, 'Task muaddib#101: Add contextSources registry');
  assert.deepStrictEqual(ctx.items, [
    {
      title: 'Add contextSources registry',
      url: 'https://github.com/rphovley/muaddib/issues/101',
      body: 'the body',
    },
  ]);
}

async function testTaskManagerFetchesWhenNoTicket() {
  // No ticket in hand → resolve the backend and fetch by id. 'builtin' must
  // resolve the backend with NO arg (the default ticketSource), not the literal
  // string 'builtin'.
  const calls = [];
  const fakeBackend = {
    async fetchTicket(id) {
      calls.push(id);
      return { identifier: 'muaddib#7', title: 'Fetched', description: 'desc', url: 'u' };
    },
  };
  const src = createTaskManagerSource({
    source: 'builtin',
    getTicketSource: (kind) => {
      calls.push(`resolve:${kind}`);
      return fakeBackend;
    },
  });
  const ctx = await src.gatherContext('7');
  assert.deepStrictEqual(calls, ['resolve:undefined', '7']);
  assert.strictEqual(ctx.summary, 'Task muaddib#7: Fetched');
  assert.deepStrictEqual(ctx.items, [{ title: 'Fetched', url: 'u', body: 'desc' }]);
}

async function testTaskManagerBindsExplicitBackend() {
  // source: 'github' must resolve the backend WITH 'github'.
  const resolved = [];
  const src = createTaskManagerSource({
    source: 'github',
    getTicketSource: (kind) => {
      resolved.push(kind);
      return { async fetchTicket() { return { identifier: 'x', title: 't', description: '', url: null }; } };
    },
  });
  await src.gatherContext('34');
  assert.deepStrictEqual(resolved, ['github']);
}

async function testTaskManagerNoTicketNoId() {
  // Nothing to gather — no id and no ticket → empty, no fetch.
  const src = createTaskManagerSource({
    getTicketSource: () => ({ async fetchTicket() { throw new Error('should not fetch'); } }),
  });
  const ctx = await src.gatherContext(null, null);
  assert.deepStrictEqual(ctx.items, []);
  assert.ok(/No task found/.test(ctx.summary));
}

async function testTaskManagerMissingTicket() {
  // Backend returns null (missing) → empty items, no throw.
  const src = createTaskManagerSource({
    getTicketSource: () => ({ async fetchTicket() { return null; } }),
  });
  const ctx = await src.gatherContext('404');
  assert.deepStrictEqual(ctx.items, []);
  assert.ok(/No task found/.test(ctx.summary));
}

async function testTaskManagerOmitsUrlWhenAbsent() {
  const src = createTaskManagerSource({});
  const ctx = await src.gatherContext('1', { identifier: 'X-1', title: 'T', description: 'b', url: null });
  assert.strictEqual(ctx.items[0].url, undefined);
}

// ─── decisionLog builtin ─────────────────────────────────────────────────────

async function testDecisionLogSearchesFixture() {
  await withTempRepo(async (dir) => {
    // Two entries: one references the ticket in its content, one doesn't.
    const jsonl =
      JSON.stringify({ id: 'ADR-1-muaddib#101', scope: 'muaddib#101', timestamp: 't1', summary: 'Chose registry pattern for muaddib#101' }) +
      '\n' +
      JSON.stringify({ id: 'ADR-1-muaddib#999', scope: 'muaddib#999', timestamp: 't2', summary: 'Unrelated decision' }) +
      '\n';
    fs.writeFileSync(path.join(dir, '.muaddib', 'decisions.jsonl'), jsonl);

    const src = createDecisionLogSource({ repoDir: dir });
    const ctx = await src.gatherContext('muaddib#101');
    assert.strictEqual(ctx.items.length, 1);
    assert.strictEqual(ctx.items[0].title, 'ADR-1-muaddib#101');
    assert.ok(/muaddib#101/.test(ctx.items[0].body));
    assert.strictEqual(ctx.summary, 'Decision Log: 1 decision(s) referencing muaddib#101');
  });
}

async function testDecisionLogEmptyWhenNoLog() {
  await withTempRepo(async (dir) => {
    // No decisions.jsonl at all → empty, no throw (search treats missing as empty).
    const src = createDecisionLogSource({ repoDir: dir });
    const ctx = await src.gatherContext('muaddib#101');
    assert.deepStrictEqual(ctx.items, []);
    assert.strictEqual(ctx.summary, 'Decision Log: 0 decision(s) referencing muaddib#101');
  });
}

async function testDecisionLogNoTicketId() {
  const src = createDecisionLogSource({ search: () => { throw new Error('should not search'); } });
  const ctx = await src.gatherContext('');
  assert.deepStrictEqual(ctx.items, []);
  assert.ok(/no ticket id/.test(ctx.summary));
}

// ─── processDocs builtin ─────────────────────────────────────────────────────

async function testProcessDocsConfigured() {
  await withTempRepo(async (dir) => {
    fs.writeFileSync(path.join(dir, '.muaddib', 'goals.md'), '# Goal Context\n\nShip small PRs.\n');
    const src = createProcessDocsSource({ repoDir: dir });
    const ctx = await src.gatherContext();
    assert.strictEqual(ctx.summary, 'Process docs: Goal Context');
    assert.strictEqual(ctx.items.length, 1);
    assert.strictEqual(ctx.items[0].title, 'Goal Context');
    assert.ok(/Ship small PRs/.test(ctx.items[0].body));
  });
}

async function testProcessDocsNotConfiguredIsFirstClass() {
  await withTempRepo(async (dir) => {
    // No goals.md → configured:false, NOT an error, and — critically — the read
    // must NOT bootstrap the default template (strictly read-only surfacing).
    const src = createProcessDocsSource({ repoDir: dir });
    const ctx = await src.gatherContext();
    assert.deepStrictEqual(ctx.items, []);
    assert.ok(/no Goal Context configured/.test(ctx.summary));
    assert.strictEqual(
      fs.existsSync(path.join(dir, '.muaddib', 'goals.md')),
      false,
      'processDocs must not bootstrap goals.md'
    );
  });
}

async function testProcessDocsEmptyFileNotConfigured() {
  await withTempRepo(async (dir) => {
    // A present-but-blank goals.md is still "not configured".
    fs.writeFileSync(path.join(dir, '.muaddib', 'goals.md'), '   \n\n');
    const src = createProcessDocsSource({ repoDir: dir });
    const ctx = await src.gatherContext();
    assert.deepStrictEqual(ctx.items, []);
    assert.ok(/no Goal Context configured/.test(ctx.summary));
  });
}

// ─── singletons exist ────────────────────────────────────────────────────────

async function testSingletonsExported() {
  assert.strictEqual(taskManagerSource.name, 'taskManager');
  assert.strictEqual(decisionLogSource.name, 'decisionLog');
  assert.strictEqual(processDocsSource.name, 'processDocs');
}

// ─── runner ──────────────────────────────────────────────────────────────────

async function main() {
  const tests = [
    ['registry: resolves each type/source pair', testResolvesEachType],
    ['registry: source defaults to builtin', testSourceDefaultsToBuiltin],
    ['registry: unknown type throws (lists supported)', testUnknownTypeThrows],
    ['registry: unknown source for a type throws', testUnknownSourceForTypeThrows],
    ['registry: VALID_CONTEXT_SOURCE_TYPES / sources map exported', testValidTypesExport],
    ['taskManager: uses passed ticket without fetching', testTaskManagerUsesPassedTicket],
    ['taskManager: fetches by id; builtin resolves default backend', testTaskManagerFetchesWhenNoTicket],
    ['taskManager: explicit source binds that backend', testTaskManagerBindsExplicitBackend],
    ['taskManager: empty when no id and no ticket', testTaskManagerNoTicketNoId],
    ['taskManager: empty when backend returns null', testTaskManagerMissingTicket],
    ['taskManager: omits url when absent', testTaskManagerOmitsUrlWhenAbsent],
    ['decisionLog: searches the log fixture for the ticket id', testDecisionLogSearchesFixture],
    ['decisionLog: empty (no throw) when log missing', testDecisionLogEmptyWhenNoLog],
    ['decisionLog: empty when no ticket id', testDecisionLogNoTicketId],
    ['processDocs: configured when goals.md present', testProcessDocsConfigured],
    ['processDocs: not-configured is first-class + no bootstrap', testProcessDocsNotConfiguredIsFirstClass],
    ['processDocs: blank goals.md is not configured', testProcessDocsEmptyFileNotConfigured],
    ['exports: builtin singletons present', testSingletonsExported],
  ];

  let passed = 0;
  for (const [name, fn] of tests) {
    process.stdout.write(`  ${name}... `);
    try {
      await fn();
      process.stdout.write('PASS\n');
      passed++;
    } catch (err) {
      process.stdout.write(`FAIL\n    ${err.message}\n`);
    }
  }

  console.log(`\n${passed}/${tests.length} passed`);
  if (passed < tests.length) process.exit(1);
}

main().catch((err) => {
  console.error('FAIL —', err.message);
  process.exit(1);
});
