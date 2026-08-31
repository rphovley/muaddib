#!/usr/bin/env node
'use strict';
// services/notify.js (Slack) test suite — no real network.
//
// notify() is exercised against an INJECTED HTTP client so we assert on the
// exact payload it POSTs for each kind, and assert a clean no-op (no call, no
// throw) when SLACK_WEBHOOK_URL is unset.

const assert = require('assert');
const { notify, buildSlackBody } = require('../notify');
const { buildNotification } = require('../../orchestrator/notify-format');

// A fake HTTP client: records each (webhookUrl, body) call and resolves. Set
// `throwErr` to make it reject, exercising the swallow-and-report branch.
function fakePost(throwErr) {
  const calls = [];
  const post = async (webhookUrl, body) => {
    calls.push({ webhookUrl, body });
    if (throwErr) throw throwErr;
    return 'ok';
  };
  post.calls = calls;
  return post;
}

const WEBHOOK = 'https://hooks.slack.com/services/T/B/xxxx';

// ─── delivery ────────────────────────────────────────────────────────────────

async function testDeliversAndBuildsPayloadForAlert() {
  const post = fakePost();
  const res = await notify(
    { worker: 1, projectName: 'quotethat', ticketTitle: 'Add notifications', kind: 'question' },
    { webhookUrl: WEBHOOK, post }
  );
  assert.strictEqual(res.delivered, true);
  assert.strictEqual(post.calls.length, 1);
  assert.strictEqual(post.calls[0].webhookUrl, WEBHOOK);

  const text = post.calls[0].body.text;
  // Title (bold), action line, and a context line naming worker + kind.
  assert.ok(text.includes('*quotethat: Add notifications*'), `title missing: ${text}`);
  assert.ok(/answer/i.test(text), `question subtitle missing: ${text}`);
  assert.ok(text.includes('worker 1'), `worker context missing: ${text}`);
  assert.ok(text.includes('question'), `kind context missing: ${text}`);
  assert.ok(text.includes(':bell:'), `alert emoji missing: ${text}`);
}

async function testInfoTierUsesQuietEmoji() {
  const post = fakePost();
  await notify(
    { worker: 2, projectName: 'quotethat', ticketTitle: 'X', kind: 'info', message: 'PR merged' },
    { webhookUrl: WEBHOOK, post }
  );
  const text = post.calls[0].body.text;
  assert.ok(text.includes(':information_source:'), `info emoji missing: ${text}`);
  assert.ok(text.includes('PR merged'), `info message missing: ${text}`);
  assert.ok(!text.includes(':bell:'), `info tier must not use the alert bell: ${text}`);
}

async function testReviewPayloadIncludesUrl() {
  const post = fakePost();
  await notify(
    { worker: 1, projectName: 'p', ticketTitle: 't', kind: 'review', url: 'https://x/pr/9' },
    { webhookUrl: WEBHOOK, post }
  );
  assert.ok(post.calls[0].body.text.includes('https://x/pr/9'));
}

// ─── no-op when unset ──────────────────────────────────────────────────────────

async function testNoOpWhenUrlUnset() {
  const prev = process.env.SLACK_WEBHOOK_URL;
  delete process.env.SLACK_WEBHOOK_URL;
  try {
    const post = fakePost();
    // No webhookUrl in opts and none in env → must not call post, must not throw.
    const res = await notify({ worker: 1, kind: 'question' }, { post });
    assert.strictEqual(res.delivered, false);
    assert.strictEqual(res.reason, 'no-webhook-url');
    assert.strictEqual(post.calls.length, 0, 'post must not be called when the webhook URL is unset');
  } finally {
    if (prev === undefined) delete process.env.SLACK_WEBHOOK_URL;
    else process.env.SLACK_WEBHOOK_URL = prev;
  }
}

async function testEnvUrlIsUsedWhenOptOmitted() {
  const prev = process.env.SLACK_WEBHOOK_URL;
  process.env.SLACK_WEBHOOK_URL = WEBHOOK;
  try {
    const post = fakePost();
    const res = await notify({ worker: 1, kind: 'question' }, { post });
    assert.strictEqual(res.delivered, true);
    assert.strictEqual(post.calls[0].webhookUrl, WEBHOOK);
  } finally {
    if (prev === undefined) delete process.env.SLACK_WEBHOOK_URL;
    else process.env.SLACK_WEBHOOK_URL = prev;
  }
}

// ─── delivery failure is swallowed ──────────────────────────────────────────────

async function testDeliveryFailureIsReportedNotThrown() {
  const post = fakePost(new Error('boom'));
  const res = await notify(
    { worker: 1, kind: 'question' },
    { webhookUrl: WEBHOOK, post }
  );
  assert.strictEqual(res.delivered, false);
  assert.strictEqual(res.reason, 'boom');
}

// ─── buildSlackBody unit ────────────────────────────────────────────────────────

async function testBuildSlackBodyOmitsMetaWhenNoWorker() {
  const note = buildNotification({ projectName: 'p', ticketTitle: 't', kind: 'info', message: 'm' });
  const body = buildSlackBody(note, {}); // no worker in the payload
  // The kind still yields a context line, but no "worker N" token appears when
  // the payload carries no worker.
  assert.ok(body.text.includes('info'), 'kind context still present');
  assert.ok(!body.text.includes('worker'), 'no worker context when worker absent');
}

// ─── runner ──────────────────────────────────────────────────────────────────

async function main() {
  const tests = [
    ['delivers + builds alert payload against injected client', testDeliversAndBuildsPayloadForAlert],
    ['info tier uses the quiet emoji + message', testInfoTierUsesQuietEmoji],
    ['review payload includes the url', testReviewPayloadIncludesUrl],
    ['no-op (no call, no throw) when SLACK_WEBHOOK_URL is unset', testNoOpWhenUrlUnset],
    ['uses SLACK_WEBHOOK_URL from env when opts omit it', testEnvUrlIsUsedWhenOptOmitted],
    ['delivery failure is reported, not thrown', testDeliveryFailureIsReportedNotThrown],
    ['buildSlackBody omits worker context when absent', testBuildSlackBodyOmitsMetaWhenNoWorker],
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
