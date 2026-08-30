#!/usr/bin/env node
'use strict';
// TicketSource interface test suite — no network calls.
//
// Every interface method is exercised against an injected fake `graphql` so we
// assert on the exact query/variables each method builds, plus the factory's
// backend selection and the linear-webhook.js compatibility shim.

const assert = require('assert');
const { getTicketSource, createLinearSource } = require('../ticket-source');

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
  const src = getTicketSource();
  assert.strictEqual(src.name, 'linear');
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
  const src = getTicketSource();
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
