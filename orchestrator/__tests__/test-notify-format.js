#!/usr/bin/env node
'use strict';
// notify-format.js test suite — pure formatting, no I/O.
//
// Covers: word-boundary-aware truncation, title composition + degradation,
// per-kind subtitles (+ url), and tier/sound selection through buildNotification.

const assert = require('assert');
const {
  KINDS,
  normalizeKind,
  truncate,
  buildTitle,
  subtitleForKind,
  buildNotification,
} = require('../notify-format');

// ─── truncate ──────────────────────────────────────────────────────────────────

async function testTruncateShortIsUnchanged() {
  assert.strictEqual(truncate('hello world', 60), 'hello world');
  // Collapses internal whitespace like titleize().
  assert.strictEqual(truncate('  hello   world  ', 60), 'hello world');
}

async function testTruncateResultNeverExceedsMax() {
  const long = 'the quick brown fox jumps over the lazy dog again and again';
  const out = truncate(long, 20);
  assert.ok(out.length <= 20, `"${out}" is ${out.length} chars, want <= 20`);
  assert.ok(out.endsWith('...'), `expected an ellipsis suffix, got "${out}"`);
}

async function testTruncateDoesNotCutMidWord() {
  // At max=20 the raw cut (room=17) lands inside "brown"; it should back up to
  // the previous word boundary rather than emit a half word.
  const out = truncate('the quick brown fox jumps', 20);
  assert.strictEqual(out, 'the quick brown...');
  assert.ok(!/\bbrow\.\.\.$/.test(out), `cut mid-word: "${out}"`);
}

async function testTruncateLongSingleWordStillCaps() {
  // No usable space near the limit — must still cap (no infinite word kept).
  const out = truncate('supercalifragilisticexpialidocious', 12);
  assert.ok(out.length <= 12, `"${out}" is ${out.length} chars, want <= 12`);
  assert.ok(out.endsWith('...'));
}

async function testTruncateEmptyAndZero() {
  assert.strictEqual(truncate('', 60), '');
  assert.strictEqual(truncate(null, 60), '');
  assert.strictEqual(truncate('anything', 0), '');
}

// ─── buildTitle ────────────────────────────────────────────────────────────────

async function testBuildTitleProjectAndTicket() {
  assert.strictEqual(
    buildTitle({ projectName: 'quotethat', ticketTitle: 'Add richer notifications' }),
    'quotethat: Add richer notifications'
  );
}

async function testBuildTitleDegradations() {
  // Project only.
  assert.strictEqual(buildTitle({ projectName: 'quotethat' }), 'quotethat');
  // Ticket only.
  assert.strictEqual(buildTitle({ ticketTitle: 'Just the ticket' }), 'Just the ticket');
  // Neither — worker-N last resort.
  assert.strictEqual(buildTitle({ worker: 3 }), 'worker-3');
  // Nothing at all — a stable fallback, never empty.
  assert.strictEqual(buildTitle({}), 'muaddib');
}

async function testBuildTitleTruncatesToMax() {
  const title = buildTitle(
    { projectName: 'quotethat', ticketTitle: 'A very very very very very long ticket title indeed' },
    { max: 30 }
  );
  assert.ok(title.length <= 30, `"${title}" is ${title.length} chars, want <= 30`);
  assert.ok(title.startsWith('quotethat: '));
}

// ─── subtitleForKind ─────────────────────────────────────────────────────────────

async function testSubtitlesAreDistinctPerKind() {
  const q = subtitleForKind(KINDS.QUESTION);
  const r = subtitleForKind(KINDS.REVIEW);
  const b = subtitleForKind(KINDS.BLOCKED);
  const i = subtitleForKind(KINDS.INFO, { message: 'PR #12 opened' });
  const all = [q, r, b, i];
  assert.strictEqual(new Set(all).size, all.length, `subtitles must differ per kind: ${JSON.stringify(all)}`);
  assert.match(q, /answer/i);
  assert.match(r, /review/i);
  assert.match(b, /decision/i);
  assert.strictEqual(i, 'PR #12 opened');
}

async function testSubtitleAppendsUrl() {
  const s = subtitleForKind(KINDS.REVIEW, { url: 'https://x/pr/1' });
  assert.ok(s.includes('https://x/pr/1'), `url not appended: "${s}"`);
}

async function testSubtitleGenericFallback() {
  // Unrecognized/absent kind with no message → historical generic wording.
  assert.strictEqual(subtitleForKind(undefined), 'A workflow step needs your input');
  // With a message, the message is the line.
  assert.strictEqual(subtitleForKind('bogus', { message: 'hi there' }), 'hi there');
}

// ─── normalizeKind ───────────────────────────────────────────────────────────────

async function testNormalizeKind() {
  assert.strictEqual(normalizeKind('review'), 'review');
  assert.strictEqual(normalizeKind('REVIEW'), 'review');
  assert.strictEqual(normalizeKind('  info '), 'info');
  assert.strictEqual(normalizeKind('nope'), null);
  assert.strictEqual(normalizeKind(undefined), null);
  assert.strictEqual(normalizeKind(true), null);
}

// ─── buildNotification ───────────────────────────────────────────────────────────

async function testBuildNotificationAlert() {
  const n = buildNotification({
    worker: 1,
    projectName: 'quotethat',
    ticketTitle: 'Add notifications',
    kind: 'question',
  });
  assert.strictEqual(n.title, 'quotethat: Add notifications');
  assert.strictEqual(n.tier, 'alert');
  assert.strictEqual(n.sound, 'Glass');
  assert.strictEqual(n.kind, 'question');
  assert.match(n.subtitle, /answer/i);
}

async function testBuildNotificationInfoIsQuiet() {
  const n = buildNotification({
    worker: 2,
    projectName: 'quotethat',
    ticketTitle: 'Add notifications',
    kind: 'info',
    message: 'PR merged — preview torn down',
  });
  assert.strictEqual(n.tier, 'info');
  assert.strictEqual(n.sound, '', 'info tier must have no sound');
  assert.strictEqual(n.subtitle, 'PR merged — preview torn down');
}

async function testBuildNotificationGenericBareMessage() {
  // The bus-flush path: only a message, no kind.
  const n = buildNotification({ worker: 5, message: 'preview ready' });
  assert.strictEqual(n.tier, 'alert');
  assert.strictEqual(n.sound, 'Glass');
  assert.strictEqual(n.kind, null);
  assert.strictEqual(n.subtitle, 'preview ready');
  assert.strictEqual(n.title, 'worker-5'); // no project/ticket available
}

// ─── runner ──────────────────────────────────────────────────────────────────

async function main() {
  const tests = [
    ['truncate: short text is unchanged (+ whitespace collapse)', testTruncateShortIsUnchanged],
    ['truncate: result never exceeds max, ends with ellipsis', testTruncateResultNeverExceedsMax],
    ['truncate: backs up to a word boundary', testTruncateDoesNotCutMidWord],
    ['truncate: a long single word still caps to max', testTruncateLongSingleWordStillCaps],
    ['truncate: empty/null/zero-max', testTruncateEmptyAndZero],
    ['buildTitle: project + ticket', testBuildTitleProjectAndTicket],
    ['buildTitle: degrades to project / ticket / worker / fallback', testBuildTitleDegradations],
    ['buildTitle: truncates to max', testBuildTitleTruncatesToMax],
    ['subtitleForKind: distinct per kind', testSubtitlesAreDistinctPerKind],
    ['subtitleForKind: appends url', testSubtitleAppendsUrl],
    ['subtitleForKind: generic fallback', testSubtitleGenericFallback],
    ['normalizeKind: case-insensitive, null on unknown', testNormalizeKind],
    ['buildNotification: alert tier gets Glass + kind subtitle', testBuildNotificationAlert],
    ['buildNotification: info tier is quiet (no sound)', testBuildNotificationInfoIsQuiet],
    ['buildNotification: bare message → generic alert', testBuildNotificationGenericBareMessage],
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
