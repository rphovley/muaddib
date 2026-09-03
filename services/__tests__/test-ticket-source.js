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

// ─── watchMode (how the dispatch daemon learns about issues) ────────────────────

async function testWatchModes() {
  // Linear is webhook-driven and advertises the inbound signature header so the
  // daemon reads it from the source instead of hardcoding a Linear-specific name.
  const linear = getTicketSource('linear');
  assert.strictEqual(linear.watchMode, 'webhook');
  assert.strictEqual(linear.signatureHeader, 'linear-signature');
  // GitHub is polled — no webhook, no signature header.
  assert.strictEqual(getTicketSource('github').watchMode, 'poll');
  // Raw has no external system to watch.
  assert.strictEqual(getTicketSource('raw').watchMode, 'none');
}

// ─── GitHub backend (poll path) ──────────────────────────────────────────────────

async function testGithubPollIssuesMapsAndFiltersPRs() {
  // The list-issues endpoint returns PRs too (they carry a `pull_request` key) —
  // those must be dropped; real issues are normalized like fetchTicket.
  const issues = [
    githubIssueFixture(),
    { ...githubIssueFixture(), number: 40, pull_request: { url: 'x' } }, // a PR — dropped
  ];
  const api = fakeApi({ '/issues?state=open': issues });
  const src = createGithubSource({ api, owner: 'rphovley', repo: 'muaddib' });
  const result = await src.pollIssues();
  assert.strictEqual(api.calls[0].path, '/repos/rphovley/muaddib/issues?state=open&per_page=100&page=1');
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].identifier, 'muaddib#34');
  assert.deepStrictEqual(result[0].labels, { nodes: [{ name: 'enhancement' }, { name: 'muaddib' }] });
}

async function testGithubPollIssuesEmptyWhenNotArray() {
  // A defensive/degenerate response (not a list) yields [] rather than a throw.
  const api = fakeApi({ '/issues?state=open': null });
  const src = createGithubSource({ api, owner: 'rphovley', repo: 'muaddib' });
  assert.deepStrictEqual(await src.pollIssues(), []);
}

async function testGithubPollIssuesRequiresOwnerRepo() {
  const prevOwner = process.env.GITHUB_OWNER;
  const prevRepo = process.env.GITHUB_REPO;
  delete process.env.GITHUB_OWNER;
  delete process.env.GITHUB_REPO;
  try {
    const src = createGithubSource({ api: fakeApi({}) });
    await assert.rejects(() => src.pollIssues(), /GITHUB_OWNER and GITHUB_REPO/);
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

// ─── GitHub backend (getBlockingStatus) ─────────────────────────────────────────

async function testGithubGetBlockingStatusMapsBothEndpoints() {
  // blocked_by → a still-open blocker plus a closed (historical) one; blocking →
  // one issue this ticket blocks. Both dependency endpoints are hit, fields are
  // mapped onto the backend-neutral entry shape, and `blocked` is true because a
  // blocker is still active (open).
  const api = fakeApi({
    '/dependencies/blocked_by': [
      { number: 10, title: 'Open blocker', state: 'open' },
      { number: 11, title: 'Done blocker', state: 'closed' },
    ],
    '/dependencies/blocking': [{ number: 20, title: 'Downstream', state: 'open' }],
  });
  const src = createGithubSource({ api, owner: 'rphovley', repo: 'muaddib' });
  const status = await src.getBlockingStatus('34');
  assert.deepStrictEqual(status, {
    supported: true,
    blocked: true,
    blockedBy: [
      { identifier: 'muaddib#10', title: 'Open blocker', state: { name: 'open' }, active: true },
      { identifier: 'muaddib#11', title: 'Done blocker', state: { name: 'closed' }, active: false },
    ],
    blocking: [{ identifier: 'muaddib#20', title: 'Downstream', state: { name: 'open' }, active: true }],
  });
  assert.deepStrictEqual(
    api.calls.map((c) => c.path).sort(),
    [
      '/repos/rphovley/muaddib/issues/34/dependencies/blocked_by?per_page=100&page=1',
      '/repos/rphovley/muaddib/issues/34/dependencies/blocking?per_page=100&page=1',
    ]
  );
}

async function testGithubGetBlockingStatusBlockedFalseWhenAllBlockersClosed() {
  // A ticket blocked only by an already-closed issue is NOT currently blocked,
  // but the blocker stays visible in blockedBy (history), and blocking [] when
  // the endpoint returns an empty array.
  const api = fakeApi({
    '/dependencies/blocked_by': [{ number: 11, title: 'Done blocker', state: 'closed' }],
    '/dependencies/blocking': [],
  });
  const src = createGithubSource({ api, owner: 'rphovley', repo: 'muaddib' });
  const status = await src.getBlockingStatus('34');
  assert.strictEqual(status.blocked, false);
  assert.strictEqual(status.blockedBy.length, 1);
  assert.strictEqual(status.blockedBy[0].active, false);
  assert.deepStrictEqual(status.blocking, []);
}

async function testGithubGetBlockingStatusToleratesRepoHashPrefix() {
  const api = fakeApi({ '/dependencies/blocked_by': [], '/dependencies/blocking': [] });
  const src = createGithubSource({ api, owner: 'rphovley', repo: 'muaddib' });
  await src.getBlockingStatus('muaddib#34');
  for (const call of api.calls) {
    assert.ok(call.path.startsWith('/repos/rphovley/muaddib/issues/34/dependencies/'), call.path);
  }
}

async function testGithubGetBlockingStatusEmptyIdShortCircuits() {
  // An empty id can't address an issue — return the supported-but-empty shape
  // without issuing a request (matching fetchTicket's missing-id handling).
  const api = fakeApi({});
  const src = createGithubSource({ api, owner: 'rphovley', repo: 'muaddib' });
  assert.deepStrictEqual(await src.getBlockingStatus(''), {
    supported: true,
    blocked: false,
    blockedBy: [],
    blocking: [],
  });
  assert.strictEqual(api.calls.length, 0);
}

async function testGithubGetBlockingStatusRequiresOwnerRepo() {
  const prevOwner = process.env.GITHUB_OWNER;
  const prevRepo = process.env.GITHUB_REPO;
  delete process.env.GITHUB_OWNER;
  delete process.env.GITHUB_REPO;
  try {
    const src = createGithubSource({ api: fakeApi({}) });
    await assert.rejects(() => src.getBlockingStatus('1'), /GITHUB_OWNER and GITHUB_REPO/);
  } finally {
    if (prevOwner === undefined) delete process.env.GITHUB_OWNER;
    else process.env.GITHUB_OWNER = prevOwner;
    if (prevRepo === undefined) delete process.env.GITHUB_REPO;
    else process.env.GITHUB_REPO = prevRepo;
  }
}

// ─── GitHub backend (addBlockingRelation) ───────────────────────────────────────

async function testGithubAddBlockingRelationResolvesAndPosts() {
  // "10 blocks 20": first GET resolves the blocker's numeric database id, then a
  // POST declares it on the BLOCKED issue's blocked_by dependencies collection,
  // keyed on that raw id (not the issue number). Returns void.
  const api = fakeApi({
    '/issues/20/dependencies/blocked_by': {}, // POST response (ignored)
    '/repos/rphovley/muaddib/issues/10': { id: 12345, number: 10 }, // raw blocker payload
  });
  const src = createGithubSource({ api, owner: 'rphovley', repo: 'muaddib' });
  const res = await src.addBlockingRelation('10', '20');
  assert.strictEqual(res, undefined);
  assert.deepStrictEqual(api.calls[0], {
    path: '/repos/rphovley/muaddib/issues/10',
    method: 'GET',
    body: undefined,
  });
  assert.deepStrictEqual(api.calls[1], {
    path: '/repos/rphovley/muaddib/issues/20/dependencies/blocked_by',
    method: 'POST',
    body: { issue_id: 12345 },
  });
}

async function testGithubAddBlockingRelationToleratesRepoHashPrefix() {
  const api = fakeApi({
    '/issues/20/dependencies/blocked_by': {},
    '/repos/rphovley/muaddib/issues/10': { id: 12345 },
  });
  const src = createGithubSource({ api, owner: 'rphovley', repo: 'muaddib' });
  await src.addBlockingRelation('muaddib#10', 'muaddib#20');
  assert.strictEqual(api.calls[0].path, '/repos/rphovley/muaddib/issues/10');
  assert.strictEqual(api.calls[1].path, '/repos/rphovley/muaddib/issues/20/dependencies/blocked_by');
}

async function testGithubAddBlockingRelationThrowsWhenBlockerMissing() {
  // The blocker GET resolves null (404) — there's no numeric id to key the
  // dependency on, so throw before issuing the POST.
  const api = fakeApi({ '/repos/rphovley/muaddib/issues/404': null });
  const src = createGithubSource({ api, owner: 'rphovley', repo: 'muaddib' });
  await assert.rejects(() => src.addBlockingRelation('404', '20'), /could not resolve blocker/);
  assert.strictEqual(api.calls.length, 1); // only the failed resolution GET, no POST
}

async function testGithubAddBlockingRelationRoundTrip() {
  // A stateful double: addBlockingRelation records the edge on the blocked
  // issue's blocked_by collection; getBlockingStatus reads it back through the
  // same dependency endpoints — proving the relation is reflected end-to-end for
  // both the blocked issue (gains a blocker) and the blocker (gains what it
  // blocks). Blocker raw db ids are synthesized as 100000 + <number>.
  const edges = []; // { blocker, blocked } issue numbers
  const api = async (path, opts = {}) => {
    const method = opts.method || 'GET';
    let m = path.match(/\/issues\/(\d+)\/dependencies\/blocked_by/);
    if (m && method === 'POST') {
      edges.push({ blocker: Number(opts.body.issue_id) - 100000, blocked: Number(m[1]) });
      return {};
    }
    if (m && method === 'GET') {
      const n = Number(m[1]);
      return edges
        .filter((e) => e.blocked === n)
        .map((e) => ({ number: e.blocker, title: `#${e.blocker}`, state: 'open' }));
    }
    m = path.match(/\/issues\/(\d+)\/dependencies\/blocking/);
    if (m && method === 'GET') {
      const n = Number(m[1]);
      return edges
        .filter((e) => e.blocker === n)
        .map((e) => ({ number: e.blocked, title: `#${e.blocked}`, state: 'open' }));
    }
    m = path.match(/\/issues\/(\d+)$/); // blocker id resolution
    if (m && method === 'GET') {
      const n = Number(m[1]);
      return { id: 100000 + n, number: n };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  const src = createGithubSource({ api, owner: 'rphovley', repo: 'muaddib' });
  await src.addBlockingRelation('10', '20');
  const blockedStatus = await src.getBlockingStatus('20');
  assert.strictEqual(blockedStatus.blocked, true);
  assert.deepStrictEqual(blockedStatus.blockedBy.map((b) => b.identifier), ['muaddib#10']);
  const blockerStatus = await src.getBlockingStatus('10');
  assert.deepStrictEqual(blockerStatus.blocking.map((b) => b.identifier), ['muaddib#20']);
}

async function testGithubAddBlockingRelationRejectsEmptyId() {
  // An empty id on either side can't address an issue — throw before any request
  // rather than building a bogus `/issues/` (list) path.
  const api = fakeApi({});
  const src = createGithubSource({ api, owner: 'rphovley', repo: 'muaddib' });
  await assert.rejects(() => src.addBlockingRelation('', '20'), /requires both a blocker and a blocked/);
  await assert.rejects(() => src.addBlockingRelation('10', ''), /requires both a blocker and a blocked/);
  assert.strictEqual(api.calls.length, 0); // nothing issued
}

async function testGithubAddBlockingRelationResolvesEachIdsRepo() {
  // A cross-repo reference: the blocker lives in `other`, the blocked in the
  // current repo. Each id is resolved against the repo its own prefix names —
  // symmetric with getBlockingStatus's cross-repo read — not both against the
  // current repo.
  const api = fakeApi({
    '/repos/rphovley/other/issues/10': { id: 999 },
    '/issues/20/dependencies/blocked_by': {},
  });
  const src = createGithubSource({ api, owner: 'rphovley', repo: 'muaddib' });
  await src.addBlockingRelation('other#10', '20');
  assert.strictEqual(api.calls[0].path, '/repos/rphovley/other/issues/10');
  assert.strictEqual(api.calls[1].path, '/repos/rphovley/muaddib/issues/20/dependencies/blocked_by');
  assert.deepStrictEqual(api.calls[1].body, { issue_id: 999 });
}

async function testGithubAddBlockingRelationIdempotentOnDuplicate() {
  // Re-adding an existing dependency: GitHub rejects the duplicate POST with an
  // "already exists" 422. That's the state we wanted, so it's swallowed as a
  // no-op (void) rather than surfaced as a failure.
  const api = fakeApi({
    '/repos/rphovley/muaddib/issues/10': { id: 12345 },
    '/issues/20/dependencies/blocked_by': new Error(
      'GitHub REST 422 /…: dependency already exists'
    ),
  });
  const src = createGithubSource({ api, owner: 'rphovley', repo: 'muaddib' });
  assert.strictEqual(await src.addBlockingRelation('10', '20'), undefined);
  // A non-duplicate write error still surfaces.
  const api2 = fakeApi({
    '/repos/rphovley/muaddib/issues/10': { id: 12345 },
    '/issues/20/dependencies/blocked_by': new Error('GitHub REST 404 /…: Not Found'),
  });
  const src2 = createGithubSource({ api: api2, owner: 'rphovley', repo: 'muaddib' });
  await assert.rejects(() => src2.addBlockingRelation('10', '20'), /404/);
}

// ─── Linear backend (getBlockingStatus) ─────────────────────────────────────────

async function testLinearGetBlockingStatusMapsRelations() {
  // inverseRelations(blocks) → blockedBy; relations(blocks) → blocking. A
  // non-`blocks` relation (e.g. `related`) is ignored. `blocked` is true because
  // an active blocker exists.
  const gql = fakeGraphql({
    BlockingStatus: {
      issue: {
        relations: {
          nodes: [
            { type: 'blocks', relatedIssue: { identifier: 'QUO-20', title: 'Downstream', state: { name: 'Todo', type: 'unstarted' } } },
            { type: 'related', relatedIssue: { identifier: 'QUO-99', title: 'Related', state: { name: 'Todo', type: 'unstarted' } } },
          ],
        },
        inverseRelations: {
          nodes: [
            { type: 'blocks', issue: { identifier: 'QUO-10', title: 'Blocker', state: { name: 'In Progress', type: 'started' } } },
            { type: 'related', issue: { identifier: 'QUO-98', title: 'Related back', state: { name: 'Todo', type: 'unstarted' } } },
          ],
        },
      },
    },
  });
  const src = createLinearSource({ graphql: gql });
  const status = await src.getBlockingStatus('QUO-1');
  assert.deepStrictEqual(gql.calls[0].variables, { id: 'QUO-1' });
  assert.deepStrictEqual(status, {
    supported: true,
    blocked: true,
    blockedBy: [{ identifier: 'QUO-10', title: 'Blocker', state: { name: 'In Progress' }, active: true }],
    blocking: [{ identifier: 'QUO-20', title: 'Downstream', state: { name: 'Todo' }, active: true }],
  });
}

async function testLinearGetBlockingStatusBlockedFalseWhenBlockerTerminal() {
  // The only blocker is completed/canceled → not currently blocked, but it stays
  // visible in blockedBy with active:false.
  const gql = fakeGraphql({
    BlockingStatus: {
      issue: {
        relations: { nodes: [] },
        inverseRelations: {
          nodes: [
            { type: 'blocks', issue: { identifier: 'QUO-10', title: 'Done blocker', state: { name: 'Done', type: 'completed' } } },
            { type: 'blocks', issue: { identifier: 'QUO-11', title: 'Dropped blocker', state: { name: 'Canceled', type: 'canceled' } } },
          ],
        },
      },
    },
  });
  const src = createLinearSource({ graphql: gql });
  const status = await src.getBlockingStatus('QUO-1');
  assert.strictEqual(status.blocked, false);
  assert.strictEqual(status.blockedBy.length, 2);
  assert.ok(status.blockedBy.every((b) => b.active === false));
  assert.deepStrictEqual(status.blocking, []);
}

async function testLinearGetBlockingStatusMissingIssue() {
  const gql = fakeGraphql({ BlockingStatus: { issue: null } });
  const src = createLinearSource({ graphql: gql });
  assert.deepStrictEqual(await src.getBlockingStatus('QUO-404'), {
    supported: true,
    blocked: false,
    blockedBy: [],
    blocking: [],
  });
}

// ─── Linear backend (addBlockingRelation) ───────────────────────────────────────

async function testLinearAddBlockingRelationBuildsMutation() {
  // "QUO-1 blocks QUO-2": blockerId is the relation source (issueId), blockedId
  // the target (relatedIssueId), type 'blocks'. Returns void.
  const gql = fakeGraphql({ IssueRelationCreate: { issueRelationCreate: { success: true } } });
  const src = createLinearSource({ graphql: gql });
  const res = await src.addBlockingRelation('QUO-1', 'QUO-2');
  assert.strictEqual(res, undefined);
  assert.deepStrictEqual(gql.calls[0].variables, {
    issueId: 'QUO-1',
    relatedIssueId: 'QUO-2',
    type: 'blocks',
  });
}

async function testLinearAddBlockingRelationThrowsOnFailure() {
  const gql = fakeGraphql({ IssueRelationCreate: { issueRelationCreate: { success: false } } });
  const src = createLinearSource({ graphql: gql });
  await assert.rejects(() => src.addBlockingRelation('QUO-1', 'QUO-2'), /issueRelationCreate failed/);
}

async function testLinearAddBlockingRelationIdempotentOnDuplicate() {
  // A duplicate `blocks` relation: Linear rejects it with an "already exists"
  // GraphQL error. The edge we wanted already exists, so the call is a no-op
  // (void) rather than a throw.
  const gql = fakeGraphql({
    IssueRelationCreate: () => {
      throw new Error('Linear GraphQL error: {"message":"Relation already exists"}');
    },
  });
  const src = createLinearSource({ graphql: gql });
  assert.strictEqual(await src.addBlockingRelation('QUO-1', 'QUO-2'), undefined);
  // An unrelated GraphQL error still surfaces.
  const gql2 = fakeGraphql({
    IssueRelationCreate: () => {
      throw new Error('Linear GraphQL 500: internal error');
    },
  });
  const src2 = createLinearSource({ graphql: gql2 });
  await assert.rejects(() => src2.addBlockingRelation('QUO-1', 'QUO-2'), /internal error/);
}

async function testLinearAddBlockingRelationRoundTrip() {
  // A stateful double: addBlockingRelation records the directed edge;
  // getBlockingStatus reads it back through relations/inverseRelations — proving
  // the created relation is reflected end-to-end for both the blocked issue
  // (gains a blocker) and the blocker (gains what it blocks).
  const edges = []; // { blocker, blocked }
  const meta = {
    'QUO-1': { title: 'Blocker', state: { name: 'Todo', type: 'unstarted' } },
    'QUO-2': { title: 'Blocked', state: { name: 'Todo', type: 'unstarted' } },
  };
  const gql = async (query, variables) => {
    if (query.includes('IssueRelationCreate')) {
      edges.push({ blocker: variables.issueId, blocked: variables.relatedIssueId, type: variables.type });
      return { issueRelationCreate: { success: true } };
    }
    if (query.includes('BlockingStatus')) {
      const id = variables.id;
      // relations = edges where id is the source (blocker) → what id blocks.
      const relations = edges
        .filter((e) => e.blocker === id)
        .map((e) => ({ type: e.type, relatedIssue: { identifier: e.blocked, ...meta[e.blocked] } }));
      // inverseRelations = edges where id is the target (blocked) → id's blockers.
      const inverse = edges
        .filter((e) => e.blocked === id)
        .map((e) => ({ type: e.type, issue: { identifier: e.blocker, ...meta[e.blocker] } }));
      return { issue: { relations: { nodes: relations }, inverseRelations: { nodes: inverse } } };
    }
    throw new Error(`unexpected query:\n${query}`);
  };
  const src = createLinearSource({ graphql: gql });
  await src.addBlockingRelation('QUO-1', 'QUO-2');
  const blockedStatus = await src.getBlockingStatus('QUO-2');
  assert.strictEqual(blockedStatus.blocked, true);
  assert.deepStrictEqual(blockedStatus.blockedBy.map((b) => b.identifier), ['QUO-1']);
  const blockerStatus = await src.getBlockingStatus('QUO-1');
  assert.deepStrictEqual(blockerStatus.blocking.map((b) => b.identifier), ['QUO-2']);
}

// ─── markReadyForDispatch ─────────────────────────────────────────────────────────

async function testGithubMarkReadyForDispatchAddsLabel() {
  const api = fakeApi({ '/issues/34/labels': [{ name: 'auto' }] });
  const src = createGithubSource({ api, owner: 'rphovley', repo: 'muaddib' });
  await src.markReadyForDispatch('34');
  assert.strictEqual(api.calls.length, 1);
  assert.strictEqual(api.calls[0].path, '/repos/rphovley/muaddib/issues/34/labels');
  assert.strictEqual(api.calls[0].method, 'POST');
  assert.deepStrictEqual(api.calls[0].body, { labels: ['auto'] });
}

async function testGithubMarkReadyForDispatchToleratesRepoHashPrefix() {
  // A cross-repo id resolves against its own repo, like the sibling write methods.
  const api = fakeApi({ '/labels': [{ name: 'auto' }] });
  const src = createGithubSource({ api, owner: 'rphovley', repo: 'muaddib' });
  await src.markReadyForDispatch('other#7');
  assert.strictEqual(api.calls[0].path, '/repos/rphovley/other/issues/7/labels');
}

async function testGithubMarkReadyForDispatchRejectsEmptyId() {
  const src = createGithubSource({ api: fakeApi({}), owner: 'o', repo: 'r' });
  await assert.rejects(() => src.markReadyForDispatch(''), /requires an issue id/);
}

async function testLinearMarkReadyForDispatchResolvesLabelThenAdds() {
  const gql = fakeGraphql({
    'team { id }': { issue: { team: { id: 'team-9' } } },
    TeamLabels: { team: { labels: { nodes: [{ id: 'lbl-auto', name: 'auto' }, { id: 'lbl-bug', name: 'bug' }] } } },
    IssueAddLabel: { issueAddLabel: { success: true } },
  });
  const src = createLinearSource({ graphql: gql });
  await src.markReadyForDispatch('QUO-2');
  // 1) resolve the issue's team, 2) list the team labels, 3) attach 'auto'.
  assert.deepStrictEqual(gql.calls[0].variables, { id: 'QUO-2' });
  assert.deepStrictEqual(gql.calls[1].variables, { id: 'team-9' });
  assert.deepStrictEqual(gql.calls[2].variables, { id: 'QUO-2', labelId: 'lbl-auto' });
}

async function testLinearMarkReadyForDispatchThrowsWhenLabelMissing() {
  const gql = fakeGraphql({
    'team { id }': { issue: { team: { id: 'team-9' } } },
    TeamLabels: { team: { labels: { nodes: [{ id: 'lbl-bug', name: 'bug' }] } } },
  });
  const src = createLinearSource({ graphql: gql });
  await assert.rejects(() => src.markReadyForDispatch('QUO-2'), /no "auto" label/);
}

async function testLinearMarkReadyForDispatchThrowsWhenTeamUnresolved() {
  const gql = fakeGraphql({ 'team { id }': { issue: { team: null } } });
  const src = createLinearSource({ graphql: gql });
  await assert.rejects(() => src.markReadyForDispatch('QUO-2'), /could not resolve team/);
}

async function testRawMarkReadyForDispatchNoop() {
  const src = getTicketSource('raw');
  assert.strictEqual(await src.markReadyForDispatch('a'), undefined);
}

// ─── fetchComments (read-back seam) ──────────────────────────────────────────────

async function testGithubFetchCommentsOwnOnly() {
  // No "Part of #" back-reference in the body → own comments only, parent [].
  const api = fakeApi({
    '/issues/34/comments': [{ id: 1, body: '## Context\n\nx' }, { id: 2, body: 'review' }],
    '/repos/rphovley/muaddib/issues/34': { number: 34, body: 'a standalone issue, no parent' },
  });
  const src = createGithubSource({ api, owner: 'rphovley', repo: 'muaddib' });
  const res = await src.fetchComments('34');
  assert.deepStrictEqual(res.own, [{ id: 1, body: '## Context\n\nx' }, { id: 2, body: 'review' }]);
  assert.deepStrictEqual(res.parent, []);
}

async function testGithubFetchCommentsFollowsParentBackReference() {
  // A child carrying "Part of #7" → the parent's comments are read back too.
  const api = fakeApi({
    '/issues/34/comments': [{ id: 1, body: 'child comment' }],
    '/repos/rphovley/muaddib/issues/34': { number: 34, body: 'Part of #7\n\nchild body' },
    '/issues/7/comments': [{ id: 9, body: '## Context\n\nparent ctx' }],
  });
  const src = createGithubSource({ api, owner: 'rphovley', repo: 'muaddib' });
  const res = await src.fetchComments('34');
  assert.deepStrictEqual(res.own, [{ id: 1, body: 'child comment' }]);
  assert.deepStrictEqual(res.parent, [{ id: 9, body: '## Context\n\nparent ctx' }]);
}

async function testGithubFetchCommentsParentDetectionDegrades() {
  // The issue-body GET (for parent detection) fails → own comments still stand.
  const api = fakeApi({
    '/issues/34/comments': [{ id: 1, body: 'child comment' }],
    '/repos/rphovley/muaddib/issues/34': new Error('GitHub REST 500'),
  });
  const src = createGithubSource({ api, owner: 'rphovley', repo: 'muaddib' });
  const res = await src.fetchComments('34');
  assert.deepStrictEqual(res.own, [{ id: 1, body: 'child comment' }]);
  assert.deepStrictEqual(res.parent, []);
}

async function testGithubFetchCommentsEmptyId() {
  const src = createGithubSource({ api: fakeApi({}), owner: 'o', repo: 'r' });
  assert.deepStrictEqual(await src.fetchComments(''), { own: [], parent: [] });
}

async function testLinearFetchCommentsOwnAndParent() {
  const gql = fakeGraphql({
    FetchComments: {
      issue: {
        comments: { nodes: [{ id: 'c1', body: '## Context\n\nown' }, { id: 'c2', body: 'review' }] },
        parent: { comments: { nodes: [{ id: 'p1', body: '## Context\n\nparent' }] } },
      },
    },
  });
  const src = createLinearSource({ graphql: gql });
  const res = await src.fetchComments('QUO-1');
  assert.deepStrictEqual(gql.calls[0].variables, { id: 'QUO-1' });
  assert.deepStrictEqual(res.own, [{ id: 'c1', body: '## Context\n\nown' }, { id: 'c2', body: 'review' }]);
  assert.deepStrictEqual(res.parent, [{ id: 'p1', body: '## Context\n\nparent' }]);
}

async function testLinearFetchCommentsNoParent() {
  const gql = fakeGraphql({
    FetchComments: { issue: { comments: { nodes: [{ id: 'c1', body: 'hi' }] }, parent: null } },
  });
  const src = createLinearSource({ graphql: gql });
  const res = await src.fetchComments('QUO-1');
  assert.deepStrictEqual(res.own, [{ id: 'c1', body: 'hi' }]);
  assert.deepStrictEqual(res.parent, []);
}

async function testLinearFetchCommentsMissingIssue() {
  const gql = fakeGraphql({ FetchComments: { issue: null } });
  const src = createLinearSource({ graphql: gql });
  assert.deepStrictEqual(await src.fetchComments('QUO-404'), { own: [], parent: [] });
}

async function testRawFetchCommentsEmpty() {
  const src = getTicketSource('raw');
  assert.deepStrictEqual(await src.fetchComments('anything'), { own: [], parent: [] });
}

// ─── raw backend (getBlockingStatus) ────────────────────────────────────────────

async function testRawGetBlockingStatusUnsupported() {
  const src = getTicketSource('raw');
  assert.deepStrictEqual(await src.getBlockingStatus('anything'), {
    supported: false,
    blocked: false,
    blockedBy: [],
    blocking: [],
  });
}

// ─── raw backend (addBlockingRelation) ──────────────────────────────────────────

async function testRawAddBlockingRelationNoop() {
  // No external backend, so nothing to create — resolves to void, and the
  // backend still can't speak to blocking afterward (getBlockingStatus stays
  // unsupported/empty). A stateful double would be meaningless; assert the no-op.
  const src = getTicketSource('raw');
  assert.strictEqual(await src.addBlockingRelation('a', 'b'), undefined);
  assert.deepStrictEqual(await src.getBlockingStatus('a'), {
    supported: false,
    blocked: false,
    blockedBy: [],
    blocking: [],
  });
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
    ['watchMode: linear=webhook (+header), github=poll, raw=none', testWatchModes],
    ['github: pollIssues maps issues and filters out PRs', testGithubPollIssuesMapsAndFiltersPRs],
    ['github: pollIssues returns [] on a non-array response', testGithubPollIssuesEmptyWhenNotArray],
    ['github: pollIssues requires GITHUB_OWNER/GITHUB_REPO', testGithubPollIssuesRequiresOwnerRepo],
    ['github: watch methods are not implemented', testGithubWatchMethodsNotImplemented],
    ['github: postComment builds the POST comment request', testGithubPostCommentBuildsPost],
    ['github: postComment tolerates a repo# prefix', testGithubPostCommentToleratesRepoHashPrefix],
    ['github: postComment throws when response has no id', testGithubPostCommentThrowsOnFailure],
    ['github: mentionUser normalizes handle to @handle', testGithubMentionUser],
    ['github: createSubIssue creates child + native link', testGithubCreateSubIssueCreatesChildAndLinks],
    ['github: createSubIssue omits blank description', testGithubCreateSubIssueOmitsDescriptionWhenBlank],
    ['github: createSubIssue tolerates native-link failure', testGithubCreateSubIssueSucceedsWhenNativeLinkFails],
    ['github: createSubIssue throws when child not created', testGithubCreateSubIssueThrowsWhenChildNotCreated],
    ['github: getBlockingStatus maps both dependency endpoints', testGithubGetBlockingStatusMapsBothEndpoints],
    ['github: getBlockingStatus blocked=false when all blockers closed', testGithubGetBlockingStatusBlockedFalseWhenAllBlockersClosed],
    ['github: getBlockingStatus tolerates a repo# prefix', testGithubGetBlockingStatusToleratesRepoHashPrefix],
    ['github: getBlockingStatus short-circuits an empty id', testGithubGetBlockingStatusEmptyIdShortCircuits],
    ['github: getBlockingStatus requires GITHUB_OWNER/GITHUB_REPO', testGithubGetBlockingStatusRequiresOwnerRepo],
    ['github: addBlockingRelation resolves blocker id then POSTs blocked_by', testGithubAddBlockingRelationResolvesAndPosts],
    ['github: addBlockingRelation tolerates a repo# prefix', testGithubAddBlockingRelationToleratesRepoHashPrefix],
    ['github: addBlockingRelation throws when blocker unresolved', testGithubAddBlockingRelationThrowsWhenBlockerMissing],
    ['github: addBlockingRelation rejects an empty id', testGithubAddBlockingRelationRejectsEmptyId],
    ['github: addBlockingRelation resolves each id against its own repo', testGithubAddBlockingRelationResolvesEachIdsRepo],
    ['github: addBlockingRelation is idempotent on a duplicate', testGithubAddBlockingRelationIdempotentOnDuplicate],
    ['github: addBlockingRelation round-trips through getBlockingStatus', testGithubAddBlockingRelationRoundTrip],
    ['linear: getBlockingStatus maps blocks relations (ignores others)', testLinearGetBlockingStatusMapsRelations],
    ['linear: getBlockingStatus blocked=false when blocker terminal', testLinearGetBlockingStatusBlockedFalseWhenBlockerTerminal],
    ['linear: getBlockingStatus empty-supported on missing issue', testLinearGetBlockingStatusMissingIssue],
    ['linear: addBlockingRelation builds issueRelationCreate mutation', testLinearAddBlockingRelationBuildsMutation],
    ['linear: addBlockingRelation throws on !success', testLinearAddBlockingRelationThrowsOnFailure],
    ['linear: addBlockingRelation is idempotent on a duplicate', testLinearAddBlockingRelationIdempotentOnDuplicate],
    ['linear: addBlockingRelation round-trips through getBlockingStatus', testLinearAddBlockingRelationRoundTrip],
    ['github: markReadyForDispatch adds the auto label', testGithubMarkReadyForDispatchAddsLabel],
    ['github: markReadyForDispatch tolerates a repo# prefix', testGithubMarkReadyForDispatchToleratesRepoHashPrefix],
    ['github: markReadyForDispatch rejects an empty id', testGithubMarkReadyForDispatchRejectsEmptyId],
    ['linear: markReadyForDispatch resolves the label then issueAddLabel', testLinearMarkReadyForDispatchResolvesLabelThenAdds],
    ['linear: markReadyForDispatch throws when the label is missing', testLinearMarkReadyForDispatchThrowsWhenLabelMissing],
    ['linear: markReadyForDispatch throws when the team is unresolved', testLinearMarkReadyForDispatchThrowsWhenTeamUnresolved],
    ['raw: markReadyForDispatch is a void no-op', testRawMarkReadyForDispatchNoop],
    ['github: fetchComments returns own comments, parent [] when no back-ref', testGithubFetchCommentsOwnOnly],
    ['github: fetchComments follows a "Part of #" parent back-reference', testGithubFetchCommentsFollowsParentBackReference],
    ['github: fetchComments degrades to own-only if parent detection fails', testGithubFetchCommentsParentDetectionDegrades],
    ['github: fetchComments short-circuits an empty id', testGithubFetchCommentsEmptyId],
    ['linear: fetchComments returns own + parent comments', testLinearFetchCommentsOwnAndParent],
    ['linear: fetchComments parent [] when issue has no parent', testLinearFetchCommentsNoParent],
    ['linear: fetchComments empty on a missing issue', testLinearFetchCommentsMissingIssue],
    ['raw: fetchComments is empty (no thread)', testRawFetchCommentsEmpty],
    ['raw: getBlockingStatus is unsupported', testRawGetBlockingStatusUnsupported],
    ['raw: addBlockingRelation is a void no-op', testRawAddBlockingRelationNoop],
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
