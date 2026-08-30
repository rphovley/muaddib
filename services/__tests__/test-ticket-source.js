#!/usr/bin/env node
'use strict';
// TicketSource interface test suite — no network calls.
//
// Every interface method is exercised against an injected fake `graphql` so we
// assert on the exact query/variables each method builds, plus the factory's
// backend selection and the linear-webhook.js compatibility shim.

const assert = require('assert');
const { getTicketSource, createLinearSource, createGithubSource } = require('../ticket-source');

// A fake graphql client: records each call and returns a scripted response.
// `respond` maps a substring of the query to the data it should resolve with.
function fakeGraphql(respond) {
  const calls = [];
  const gql = async (query, variables) => {
    calls.push({ query, variables });
    for (const [needle, data] of Object.entries(respond)) {
      if (query.includes(needle)) {
        return typeof data === 'function' ? data(variables) : data;
      }
    }
    throw new Error(`fakeGraphql: no scripted response for query:\n${query}`);
  };
  gql.calls = calls;
  return gql;
}

// ─── factory ───────────────────────────────────────────────────────────────────

async function testDefaultIsLinear() {
  // Verifies the true default (no env var set) — must not inherit whatever
  // TICKET_SOURCE happens to be ambient in the process (e.g. a self-hosted
  // worker dispatched via muaddib-task.sh sets TICKET_SOURCE=raw for itself,
  // which every process it spawns — including this check suite — inherits).
  const prev = process.env.TICKET_SOURCE;
  delete process.env.TICKET_SOURCE;
  try {
    const src = getTicketSource();
    assert.strictEqual(src.name, 'linear');
  } finally {
    if (prev === undefined) delete process.env.TICKET_SOURCE;
    else process.env.TICKET_SOURCE = prev;
  }
}

async function testExplicitLinear() {
  assert.strictEqual(getTicketSource('linear').name, 'linear');
  assert.strictEqual(getTicketSource('LINEAR').name, 'linear');
}

async function testEnvSelectsSource() {
  const prev = process.env.TICKET_SOURCE;
  process.env.TICKET_SOURCE = 'linear';
  try {
    assert.strictEqual(getTicketSource().name, 'linear');
  } finally {
    if (prev === undefined) delete process.env.TICKET_SOURCE;
    else process.env.TICKET_SOURCE = prev;
  }
}

async function testUnknownSourceThrows() {
  assert.throws(() => getTicketSource('jira'), /unknown ticket source/i);
}

async function testExplicitGithub() {
  assert.strictEqual(getTicketSource('github').name, 'github');
  assert.strictEqual(getTicketSource('GITHUB').name, 'github');
}

// ─── GitHub backend (read path) ──────────────────────────────────────────────────

// A fake REST client: records each requested path (plus method/body for the
// write path) and returns a scripted response. `respond` maps a substring of the
// path to the payload (or a function of the { path, opts } call). A scripted
// value that is an `Error` (or a function returning one) is thrown, so tests can
// exercise the reject branches.
function fakeApi(respond) {
  const calls = [];
  const api = async (path, opts = {}) => {
    const call = { path, method: opts.method || 'GET', body: opts.body };
    calls.push(call);
    for (const [needle, data] of Object.entries(respond)) {
      if (path.includes(needle)) {
        const value = typeof data === 'function' ? data(call) : data;
        if (value instanceof Error) throw value;
        return value;
      }
    }
    throw new Error(`fakeApi: no scripted response for path: ${path}`);
  };
  api.calls = calls;
  return api;
}

// A representative GitHub issue payload (only the fields fetchTicket reads).
function githubIssueFixture() {
  return {
    node_id: 'I_kwDO_abc123',
    number: 34,
    title: 'Implement GitHub Issues ticket source',
    body: 'The read path for a GitHub backend.',
    html_url: 'https://github.com/rphovley/muaddib/issues/34',
    state: 'open',
    labels: [{ name: 'enhancement' }, { name: 'muaddib' }],
    assignee: { login: 'rphovley' },
    user: { login: 'octocat' },
  };
}

async function testGithubFetchTicketMapsFields() {
  const api = fakeApi({ '/issues/34': githubIssueFixture() });
  const src = createGithubSource({ api, owner: 'rphovley', repo: 'muaddib' });
  const result = await src.fetchTicket('34');
  assert.deepStrictEqual(api.calls[0], {
    path: '/repos/rphovley/muaddib/issues/34',
    method: 'GET',
    body: undefined,
  });
  assert.deepStrictEqual(result, {
    id: 'I_kwDO_abc123',
    identifier: 'muaddib#34',
    title: 'Implement GitHub Issues ticket source',
    description: 'The read path for a GitHub backend.',
    url: 'https://github.com/rphovley/muaddib/issues/34',
    labels: { nodes: [{ name: 'enhancement' }, { name: 'muaddib' }] },
    state: { name: 'open' },
    assignee: 'rphovley',
    createdBy: 'octocat',
  });
}

async function testGithubFetchTicketStripsLeadingHash() {
  const api = fakeApi({ '/issues/34': githubIssueFixture() });
  const src = createGithubSource({ api, owner: 'rphovley', repo: 'muaddib' });
  await src.fetchTicket('#34');
  assert.deepStrictEqual(api.calls[0], {
    path: '/repos/rphovley/muaddib/issues/34',
    method: 'GET',
    body: undefined,
  });
}

async function testGithubFetchTicketNullWhenMissing() {
  // The real client resolves null on a 404; the fake mirrors that here.
  const api = fakeApi({ '/issues/404': null });
  const src = createGithubSource({ api, owner: 'rphovley', repo: 'muaddib' });
  assert.strictEqual(await src.fetchTicket('404'), null);
}

async function testGithubFetchTicketNormalizesEmptyBodyAndLabels() {
  const issue = { ...githubIssueFixture(), body: null, labels: [], assignee: null, state: 'closed' };
  const api = fakeApi({ '/issues/34': issue });
  const src = createGithubSource({ api, owner: 'rphovley', repo: 'muaddib' });
  const result = await src.fetchTicket('34');
  assert.strictEqual(result.description, '');
  assert.deepStrictEqual(result.labels, { nodes: [] });
  assert.deepStrictEqual(result.state, { name: 'closed' });
  assert.strictEqual(result.assignee, null);
}

async function testGithubRequiresOwnerRepo() {
  const prevOwner = process.env.GITHUB_OWNER;
  const prevRepo = process.env.GITHUB_REPO;
  delete process.env.GITHUB_OWNER;
  delete process.env.GITHUB_REPO;
  try {
    const src = createGithubSource({ api: fakeApi({}) });
    await assert.rejects(() => src.fetchTicket('1'), /GITHUB_OWNER and GITHUB_REPO/);
  } finally {
    if (prevOwner === undefined) delete process.env.GITHUB_OWNER;
    else process.env.GITHUB_OWNER = prevOwner;
    if (prevRepo === undefined) delete process.env.GITHUB_REPO;
    else process.env.GITHUB_REPO = prevRepo;
  }
}

async function testGithubWatchMethodsNotImplemented() {
  const src = createGithubSource({ api: fakeApi({}), owner: 'o', repo: 'r' });
  assert.throws(() => src.graphql(), /later-milestone stub in the GitHub backend/);
  // verifySignature stays a non-throwing false (like raw.js) so a stray webhook
  // POST is cleanly rejected at the gate instead of crashing the handler.
  assert.strictEqual(src.verifySignature(), false);
  await assert.rejects(() => src.registerWatch(), /later-milestone stub in the GitHub backend/);
  await assert.rejects(() => src.deregisterWatch(), /later-milestone stub in the GitHub backend/);
}

// ─── GitHub backend (write path) ─────────────────────────────────────────────────

async function testGithubPostCommentBuildsPost() {
  const api = fakeApi({ '/issues/34/comments': { id: 987 } });
  const src = createGithubSource({ api, owner: 'rphovley', repo: 'muaddib' });
  const res = await src.postComment('34', 'hello world');
  assert.deepStrictEqual(res, { commentId: 987 });
  assert.deepStrictEqual(api.calls[0], {
    path: '/repos/rphovley/muaddib/issues/34/comments',
    method: 'POST',
    body: { body: 'hello world' },
  });
}

async function testGithubPostCommentToleratesRepoHashPrefix() {
  const api = fakeApi({ '/issues/34/comments': { id: 1 } });
  const src = createGithubSource({ api, owner: 'rphovley', repo: 'muaddib' });
  await src.postComment('muaddib#34', 'x');
  assert.strictEqual(api.calls[0].path, '/repos/rphovley/muaddib/issues/34/comments');
}

async function testGithubPostCommentThrowsOnFailure() {
  const api = fakeApi({ '/issues/34/comments': {} }); // no id in the response
  const src = createGithubSource({ api, owner: 'rphovley', repo: 'muaddib' });
  await assert.rejects(() => src.postComment('34', 'x'), /postComment failed/);
}

async function testGithubMentionUser() {
  const src = createGithubSource({ api: fakeApi({}), owner: 'o', repo: 'r' });
  assert.strictEqual(src.mentionUser('paul'), '@paul');
  assert.strictEqual(src.mentionUser('@paul'), '@paul'); // normalizes existing @
  assert.strictEqual(src.mentionUser('  paul  '), '@paul');
  assert.strictEqual(src.mentionUser(''), '');
  assert.strictEqual(src.mentionUser(null), '');
}

// The created-child payload the comments/issues endpoints return.
function githubChildFixture() {
  return {
    id: 555, // numeric db id — the existence check and native-link id
    node_id: 'I_kwDO_child',
    number: 51,
    title: 'Child issue',
    body: 'Part of #34\n\nchild body',
    html_url: 'https://github.com/rphovley/muaddib/issues/51',
    state: 'open',
    labels: [],
    assignee: null,
    user: { login: 'octocat' },
  };
}

async function testGithubCreateSubIssueCreatesChildAndLinks() {
  const api = fakeApi({
    // includes() matching is by insertion order: the sub_issues path also
    // contains '/issues', so its more-specific needle must come first.
    '/issues/34/sub_issues': { id: 1 }, // native link succeeds
    '/repos/rphovley/muaddib/issues': githubChildFixture(),
  });
  const src = createGithubSource({ api, owner: 'rphovley', repo: 'muaddib' });
  const child = await src.createSubIssue('34', 'Child issue', 'child body');

  // Returns the normalized child (fetchTicket's shape).
  assert.deepStrictEqual(child, {
    id: 'I_kwDO_child',
    identifier: 'muaddib#51',
    title: 'Child issue',
    description: 'Part of #34\n\nchild body',
    url: 'https://github.com/rphovley/muaddib/issues/51',
    labels: { nodes: [] },
    state: { name: 'open' },
    assignee: null,
    createdBy: 'octocat',
  });

  // 1st call creates the child with the `Part of #34` back-reference.
  assert.deepStrictEqual(api.calls[0], {
    path: '/repos/rphovley/muaddib/issues',
    method: 'POST',
    body: { title: 'Child issue', body: 'Part of #34\n\nchild body' },
  });
  // 2nd call attempts the native sub-issue link with the child's numeric id.
  assert.deepStrictEqual(api.calls[1], {
    path: '/repos/rphovley/muaddib/issues/34/sub_issues',
    method: 'POST',
    body: { sub_issue_id: 555 },
  });
}

async function testGithubCreateSubIssueOmitsDescriptionWhenBlank() {
  const api = fakeApi({
    '/issues/34/sub_issues': { id: 1 },
    '/repos/rphovley/muaddib/issues': githubChildFixture(),
  });
  const src = createGithubSource({ api, owner: 'rphovley', repo: 'muaddib' });
  await src.createSubIssue('34', 'Child issue', '');
  assert.deepStrictEqual(api.calls[0].body, { title: 'Child issue', body: 'Part of #34' });
}

async function testGithubCreateSubIssueSucceedsWhenNativeLinkFails() {
  const api = fakeApi({
    '/issues/34/sub_issues': new Error('sub-issues feature unavailable'),
    '/repos/rphovley/muaddib/issues': githubChildFixture(),
  });
  const src = createGithubSource({ api, owner: 'rphovley', repo: 'muaddib' });
  // The native-link rejection is swallowed; the call still returns the child.
  const child = await src.createSubIssue('34', 'Child issue', 'child body');
  assert.strictEqual(child.identifier, 'muaddib#51');
  assert.strictEqual(api.calls[1].path, '/repos/rphovley/muaddib/issues/34/sub_issues');
}

async function testGithubCreateSubIssueThrowsWhenChildNotCreated() {
  const api = fakeApi({ '/repos/rphovley/muaddib/issues': {} }); // no id
  const src = createGithubSource({ api, owner: 'rphovley', repo: 'muaddib' });
  await assert.rejects(() => src.createSubIssue('34', 't', 'd'), /createSubIssue failed/);
}

// ─── fetchTicket ────────────────────────────────────────────────────────────────

async function testFetchTicketReturnsIssue() {
  const issue = { id: 'x', identifier: 'QUO-1', labels: { nodes: [{ name: 'bug' }] } };
  const gql = fakeGraphql({ 'issue(id: $id)': { issue } });
  const src = createLinearSource({ graphql: gql });
  const result = await src.fetchTicket('QUO-1');
  assert.deepStrictEqual(result, issue);
  assert.deepStrictEqual(gql.calls[0].variables, { id: 'QUO-1' });
}

async function testFetchTicketNullWhenMissing() {
  const gql = fakeGraphql({ 'issue(id: $id)': { issue: null } });
  const src = createLinearSource({ graphql: gql });
  assert.strictEqual(await src.fetchTicket('QUO-404'), null);
}

// ─── postComment ────────────────────────────────────────────────────────────────

async function testPostCommentBuildsMutation() {
  const gql = fakeGraphql({
    commentCreate: { commentCreate: { success: true, comment: { id: 'c1' } } },
  });
  const src = createLinearSource({ graphql: gql });
  const res = await src.postComment('QUO-1', 'hello');
  assert.deepStrictEqual(res, { commentId: 'c1' });
  assert.deepStrictEqual(gql.calls[0].variables, { issueId: 'QUO-1', body: 'hello' });
}

async function testPostCommentThrowsOnFailure() {
  const gql = fakeGraphql({ commentCreate: { commentCreate: { success: false } } });
  const src = createLinearSource({ graphql: gql });
  await assert.rejects(() => src.postComment('QUO-1', 'x'), /commentCreate failed/);
}

// ─── mentionUser ────────────────────────────────────────────────────────────────

async function testMentionUser() {
  const src = createLinearSource({ graphql: fakeGraphql({}) });
  assert.strictEqual(src.mentionUser('paul'), '@paul');
  assert.strictEqual(src.mentionUser('@paul'), '@paul'); // normalizes existing @
  assert.strictEqual(src.mentionUser('  paul  '), '@paul');
  assert.strictEqual(src.mentionUser(''), '');
  assert.strictEqual(src.mentionUser(null), '');
}

// ─── createSubIssue ─────────────────────────────────────────────────────────────

async function testCreateSubIssueResolvesTeamThenCreates() {
  const gql = fakeGraphql({
    'team { id }': { issue: { team: { id: 'team-9' } } },
    issueCreate: { issueCreate: { success: true, issue: { id: 'i2', identifier: 'QUO-2', url: 'u' } } },
  });
  const src = createLinearSource({ graphql: gql });
  const child = await src.createSubIssue('QUO-1', 'Child', 'desc');
  assert.deepStrictEqual(child, { id: 'i2', identifier: 'QUO-2', url: 'u' });
  // First call resolves the parent team, second creates the sub-issue with it.
  assert.deepStrictEqual(gql.calls[0].variables, { id: 'QUO-1' });
  assert.deepStrictEqual(gql.calls[1].variables, {
    input: { teamId: 'team-9', parentId: 'QUO-1', title: 'Child', description: 'desc' },
  });
}

async function testCreateSubIssueThrowsWithoutTeam() {
  const gql = fakeGraphql({ 'team { id }': { issue: { team: null } } });
  const src = createLinearSource({ graphql: gql });
  await assert.rejects(() => src.createSubIssue('QUO-1', 't', 'd'), /could not resolve team/);
}

// ─── registerWatch / deregisterWatch ────────────────────────────────────────────

async function testRegisterWatch() {
  const gql = fakeGraphql({
    webhookCreate: { webhookCreate: { success: true, webhook: { id: 'wh-1' } } },
  });
  const src = createLinearSource({ graphql: gql });
  const res = await src.registerWatch({ teamId: 't', url: 'https://x', secret: 's' });
  assert.deepStrictEqual(res, { watchId: 'wh-1' });
  assert.deepStrictEqual(gql.calls[0].variables, {
    input: { teamId: 't', url: 'https://x', secret: 's', resourceTypes: ['Issue'], allPublicTeams: false },
  });
}

async function testRegisterWatchThrowsWithoutId() {
  const gql = fakeGraphql({ webhookCreate: { webhookCreate: { success: true, webhook: null } } });
  const src = createLinearSource({ graphql: gql });
  await assert.rejects(() => src.registerWatch({ teamId: 't', url: 'u', secret: 's' }), /returned no id/);
}

async function testDeregisterWatch() {
  const gql = fakeGraphql({ webhookDelete: { webhookDelete: { success: true } } });
  const src = createLinearSource({ graphql: gql });
  await src.deregisterWatch('wh-1');
  assert.deepStrictEqual(gql.calls[0].variables, { id: 'wh-1' });
}

// ─── verifySignature (parity with the raw HMAC check) ───────────────────────────

async function testVerifySignature() {
  const crypto = require('crypto');
  // Explicit — this test exercises Linear's real HMAC check specifically,
  // not factory-default resolution, so it shouldn't depend on (or be broken
  // by) whatever TICKET_SOURCE happens to be ambient in the process.
  const src = getTicketSource('linear');
  const secret = 'sekret';
  const body = Buffer.from('{"a":1}');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert.strictEqual(src.verifySignature(body, sig, secret), true);
  assert.strictEqual(src.verifySignature(body, sig, 'wrong'), false);
  assert.strictEqual(src.verifySignature(body, '', secret), false);
}

// ─── linear-webhook.js compatibility shim ───────────────────────────────────────

async function testLinearWebhookShimSurface() {
  const shim = require('../linear-webhook');
  for (const fn of ['linearGraphQL', 'registerWebhook', 'deregisterWebhook', 'verifySignature']) {
    assert.strictEqual(typeof shim[fn], 'function', `shim must still export ${fn}`);
  }
  // verifySignature routes to the same implementation.
  const crypto = require('crypto');
  const body = Buffer.from('x');
  const sig = crypto.createHmac('sha256', 's').update(body).digest('hex');
  assert.strictEqual(shim.verifySignature(body, sig, 's'), true);
}

// ─── runner ──────────────────────────────────────────────────────────────────

async function main() {
  const tests = [
    ['factory: default source is linear', testDefaultIsLinear],
    ['factory: explicit + case-insensitive linear', testExplicitLinear],
    ['factory: TICKET_SOURCE env selects backend', testEnvSelectsSource],
    ['factory: unknown source throws', testUnknownSourceThrows],
    ['factory: explicit + case-insensitive github', testExplicitGithub],
    ['github: fetchTicket maps every field to normalized shape', testGithubFetchTicketMapsFields],
    ['github: fetchTicket strips a leading # from the id', testGithubFetchTicketStripsLeadingHash],
    ['github: fetchTicket null when issue missing (404)', testGithubFetchTicketNullWhenMissing],
    ['github: fetchTicket normalizes empty body/labels/state', testGithubFetchTicketNormalizesEmptyBodyAndLabels],
    ['github: fetchTicket requires GITHUB_OWNER/GITHUB_REPO', testGithubRequiresOwnerRepo],
    ['github: watch methods are not implemented', testGithubWatchMethodsNotImplemented],
    ['github: postComment builds the POST comment request', testGithubPostCommentBuildsPost],
    ['github: postComment tolerates a repo# prefix', testGithubPostCommentToleratesRepoHashPrefix],
    ['github: postComment throws when response has no id', testGithubPostCommentThrowsOnFailure],
    ['github: mentionUser normalizes handle to @handle', testGithubMentionUser],
    ['github: createSubIssue creates child + native link', testGithubCreateSubIssueCreatesChildAndLinks],
    ['github: createSubIssue omits blank description', testGithubCreateSubIssueOmitsDescriptionWhenBlank],
    ['github: createSubIssue tolerates native-link failure', testGithubCreateSubIssueSucceedsWhenNativeLinkFails],
    ['github: createSubIssue throws when child not created', testGithubCreateSubIssueThrowsWhenChildNotCreated],
    ['fetchTicket: returns the issue with id var', testFetchTicketReturnsIssue],
    ['fetchTicket: null when issue missing', testFetchTicketNullWhenMissing],
    ['postComment: builds commentCreate mutation', testPostCommentBuildsMutation],
    ['postComment: throws on failure', testPostCommentThrowsOnFailure],
    ['mentionUser: normalizes handle to @handle', testMentionUser],
    ['createSubIssue: resolves parent team then creates', testCreateSubIssueResolvesTeamThenCreates],
    ['createSubIssue: throws when team unresolved', testCreateSubIssueThrowsWithoutTeam],
    ['registerWatch: builds webhookCreate + returns watchId', testRegisterWatch],
    ['registerWatch: throws without an id', testRegisterWatchThrowsWithoutId],
    ['deregisterWatch: builds webhookDelete', testDeregisterWatch],
    ['verifySignature: valid/invalid/missing', testVerifySignature],
    ['shim: linear-webhook.js keeps its export surface', testLinearWebhookShimSurface],
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
