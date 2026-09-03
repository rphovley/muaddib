#!/usr/bin/env node
'use strict';
// context-comments.js test suite — pure functions, no I/O, no network.
//
// Covers the four helpers the gather step and its read-back consumers share:
// formatContext (aggregate → markdown), splitIntoParts (single vs multi-part
// chunking on section boundaries), collectContextSections (part ordering,
// out-of-order/missing tolerance), and resolveContext (own-vs-parent fallback).

const assert = require('assert');
const {
  MAX_COMMENT_CHARS,
  formatContext,
  splitIntoParts,
  collectContextSections,
  resolveContext,
} = require('../context-comments');

// ─── formatContext ──────────────────────────────────────────────────────────

function testFormatBasic() {
  const md = formatContext([
    {
      name: 'taskManager',
      summary: 'Task muaddib#105: Context gathering',
      items: [{ title: 'Context gathering', url: 'https://x/105', body: 'the body' }],
    },
    {
      name: 'decisionLog',
      summary: 'Decision Log: 1 decision(s) referencing muaddib#105',
      items: [{ title: 'ADR-1-muaddib#105', body: 'chose a script step' }],
    },
  ]);
  assert.ok(md.startsWith('## Context\n\n'), 'starts with the bare header');
  assert.ok(md.includes('### taskManager'), 'renders each source as a ### section');
  assert.ok(md.includes('### decisionLog'));
  assert.ok(md.includes('#### Context gathering\nhttps://x/105'), 'item title + url');
  assert.ok(md.includes('the body'));
  assert.ok(md.includes('#### ADR-1-muaddib#105'));
  assert.ok(md.endsWith('\n'), 'ends with a trailing newline');
}

function testFormatOmitsUrlWhenAbsent() {
  const md = formatContext([{ name: 'decisionLog', summary: 's', items: [{ title: 'ADR-1', body: 'b' }] }]);
  assert.ok(md.includes('#### ADR-1\n\nb'), 'no url line when url absent');
  assert.ok(!md.includes('undefined'));
}

function testFormatKeepsSummaryOnlySourceButSkipsWhollyEmpty() {
  // processDocs "not configured" (summary, no items) stays legible; a truly
  // empty source (no summary, no items) is dropped entirely.
  const md = formatContext([
    { name: 'processDocs', summary: 'Process docs: no Goal Context configured', items: [] },
    { name: 'ghost', summary: '', items: [] },
  ]);
  assert.ok(md.includes('### processDocs'), 'summary-only source kept');
  assert.ok(md.includes('no Goal Context configured'));
  assert.ok(!md.includes('### ghost'), 'wholly-empty source skipped');
}

// ─── splitIntoParts ─────────────────────────────────────────────────────────

function testSplitSinglePartWhenSmall() {
  const body = formatContext([{ name: 'taskManager', summary: 'Task X', items: [{ title: 'T', body: 'b' }] }]);
  const parts = splitIntoParts(body, MAX_COMMENT_CHARS);
  assert.strictEqual(parts.length, 1, 'small body → one part');
  assert.ok(parts[0].startsWith('## Context\n\n'), 'single part stays a bare ## Context');
  assert.ok(!/## Context \(/.test(parts[0]), 'no (n/m) marker on a single part');
}

function testSplitMultiPartOnSectionBoundary() {
  // Three sections, a tiny max → each section lands in its own numbered part,
  // split only on the "### " boundary (never inside a section).
  const body = formatContext([
    { name: 'taskManager', summary: 'Task muaddib#105', items: [{ title: 'T', body: 'aaaa' }] },
    { name: 'decisionLog', summary: 'Decision Log', items: [{ title: 'ADR-1', body: 'bbbb' }] },
    { name: 'processDocs', summary: 'Process docs', items: [{ title: 'Goal Context', body: 'cccc' }] },
  ]);
  // max=90 → budget 66: each section (≤53 chars) fits intact in its own part,
  // so splitting happens only on the "### " boundary, never mid-section.
  const parts = splitIntoParts(body, 90);
  assert.strictEqual(parts.length, 3, 'three sections over a tiny budget → three parts');
  parts.forEach((p, i) => {
    assert.ok(p.startsWith(`## Context (${i + 1}/3)`), `part ${i + 1} carries the (n/m) header`);
  });
  assert.ok(parts[0].includes('### taskManager') && !parts[0].includes('### decisionLog'), 'no mid-section split');
  assert.ok(parts[1].includes('### decisionLog'));
  assert.ok(parts[2].includes('### processDocs'));
}

function testSplitPacksSectionsUnderBudget() {
  // A budget big enough for two of the three sections packs them together, so
  // packing is greedy, not one-section-per-part.
  const body = formatContext([
    { name: 'a', summary: 'x', items: [{ title: 'T', body: '12345' }] },
    { name: 'b', summary: 'x', items: [{ title: 'T', body: '12345' }] },
    { name: 'c', summary: 'x', items: [{ title: 'T', body: '12345' }] },
  ]);
  // Sections are ~23 chars each (secLen ~25); budget = 80 - 24 = 56 fits two
  // sections (50) but not three (75) → exactly two parts, the first packing two.
  const parts = splitIntoParts(body, 80);
  assert.strictEqual(parts.length, 2, `packed into ${parts.length} part(s)`);
  const firstSectionCount = (parts[0].match(/^### /gm) || []).length;
  assert.strictEqual(firstSectionCount, 2, 'first part packs two sections, not one');
}

function testSplitOversizedSectionNeverExceedsCap() {
  // A single section far larger than the cap must be hard-split so that NO part
  // exceeds `max` — an oversized comment would be rejected by the backend.
  const max = 200;
  const body = formatContext([
    { name: 'huge', summary: 'x', items: [{ title: 'T', body: 'z'.repeat(1000) }] },
  ]);
  const parts = splitIntoParts(body, max);
  assert.ok(parts.length > 1, 'oversized section split into several parts');
  parts.forEach((p, i) => {
    assert.ok(p.length <= max, `part ${i + 1} (${p.length} chars) stays within the ${max}-char cap`);
  });
}

function testSplitEmptyBody() {
  assert.deepStrictEqual(splitIntoParts('', 100), []);
  assert.deepStrictEqual(splitIntoParts('   \n  ', 100), []);
}

// ─── collectContextSections ─────────────────────────────────────────────────

function testCollectOrdersByPartIndex() {
  // Comments arrive out of order; sections come back ordered by (n/m) index.
  const comments = [
    { id: 'c2', body: '## Context (2/3)\n\n### decisionLog\nlog' },
    { id: 'c1', body: '## Context (1/3)\n\n### taskManager\ntask' },
    { id: 'noise', body: 'just a review comment' },
    { id: 'c3', body: '## Context (3/3)\n\n### processDocs\ndocs' },
  ];
  const sections = collectContextSections(comments);
  assert.strictEqual(sections.length, 3, 'ignores non-context comments');
  assert.ok(sections[0].includes('### taskManager'));
  assert.ok(sections[1].includes('### decisionLog'));
  assert.ok(sections[2].includes('### processDocs'));
}

function testCollectToleratesMissingPart() {
  // A gap in the numbering (2/3 missing) still returns the present parts in order.
  const sections = collectContextSections([
    { body: '## Context (3/3)\n\nthird' },
    { body: '## Context (1/3)\n\nfirst' },
  ]);
  assert.strictEqual(sections.length, 2);
  assert.ok(sections[0].includes('first'));
  assert.ok(sections[1].includes('third'));
}

function testCollectBareContextIsPartOne() {
  const sections = collectContextSections([{ body: 'preamble\n\n## Context\n\nbody here' }]);
  assert.strictEqual(sections.length, 1);
  assert.ok(sections[0].startsWith('## Context'), 'strips preamble before the header');
  assert.ok(!sections[0].includes('preamble'));
}

function testCollectNoContext() {
  assert.deepStrictEqual(collectContextSections([{ body: 'nothing here' }, {}]), []);
  assert.deepStrictEqual(collectContextSections([]), []);
}

// ─── resolveContext ─────────────────────────────────────────────────────────

function testResolveOwnWins() {
  const own = [{ body: '## Context\n\n### taskManager\nown context' }];
  const parent = [{ body: '## Context\n\n### taskManager\nparent context' }];
  const res = resolveContext(own, parent);
  assert.strictEqual(res.source, 'own');
  assert.ok(res.markdown.includes('own context'));
  assert.ok(!res.markdown.includes('parent context'));
  assert.ok(res.markdown.startsWith('## Context\n\n'), 'reassembled under a single header');
}

function testResolveFallsBackToParent() {
  const res = resolveContext([{ body: 'no context here' }], [{ body: '## Context\n\n### x\nparent context' }]);
  assert.strictEqual(res.source, 'parent');
  assert.ok(res.markdown.includes('parent context'));
}

function testResolveMultiPartReassembly() {
  // Own has a two-part context; reassembly drops the per-part (n/m) headers and
  // stitches the bodies under one bare "## Context".
  const own = [
    { body: '## Context (1/2)\n\n### taskManager\ntask body' },
    { body: '## Context (2/2)\n\n### decisionLog\nlog body' },
  ];
  const res = resolveContext(own, []);
  assert.strictEqual(res.source, 'own');
  assert.ok(res.markdown.startsWith('## Context\n\n'));
  assert.ok(!/## Context \(/.test(res.markdown), 'per-part headers stripped on reassembly');
  assert.ok(res.markdown.includes('task body') && res.markdown.includes('log body'));
}

function testResolveNone() {
  const res = resolveContext([{ body: 'x' }], [{ body: 'y' }]);
  assert.deepStrictEqual(res, { markdown: null, source: null });
}

// A round-trip: format → split → collect → resolve returns content equivalent to
// the original aggregate (proving the post/read-back convention is closed).
function testRoundTrip() {
  const body = formatContext([
    { name: 'taskManager', summary: 'Task muaddib#105', items: [{ title: 'T', body: 'task body' }] },
    { name: 'decisionLog', summary: 'Decision Log', items: [{ title: 'ADR-1', body: 'log body' }] },
  ]);
  const parts = splitIntoParts(body, 60); // force multi-part
  assert.ok(parts.length >= 2);
  const comments = parts.map((p, i) => ({ id: `c${i}`, body: p }));
  const res = resolveContext(comments, []);
  assert.ok(res.markdown.includes('task body'));
  assert.ok(res.markdown.includes('log body'));
  assert.ok(res.markdown.includes('### taskManager') && res.markdown.includes('### decisionLog'));
}

// ─── runner ──────────────────────────────────────────────────────────────────

async function main() {
  const tests = [
    ['format: aggregate → ## Context with ### sections and #### items', testFormatBasic],
    ['format: omits url line when absent', testFormatOmitsUrlWhenAbsent],
    ['format: keeps summary-only source, skips wholly-empty', testFormatKeepsSummaryOnlySourceButSkipsWhollyEmpty],
    ['split: single bare ## Context part when under budget', testSplitSinglePartWhenSmall],
    ['split: multi-part on ### boundaries with (n/m) headers', testSplitMultiPartOnSectionBoundary],
    ['split: packs multiple sections under one budget', testSplitPacksSectionsUnderBudget],
    ['split: oversized single section never exceeds the cap', testSplitOversizedSectionNeverExceedsCap],
    ['split: empty body → []', testSplitEmptyBody],
    ['collect: orders sections by part index, ignores non-context', testCollectOrdersByPartIndex],
    ['collect: tolerates a missing part in the numbering', testCollectToleratesMissingPart],
    ['collect: a bare ## Context is part one (strips preamble)', testCollectBareContextIsPartOne],
    ['collect: no context comments → []', testCollectNoContext],
    ['resolve: own context wins over parent', testResolveOwnWins],
    ['resolve: falls back to parent when own has none', testResolveFallsBackToParent],
    ['resolve: reassembles a multi-part own context', testResolveMultiPartReassembly],
    ['resolve: neither own nor parent → null', testResolveNone],
    ['round-trip: format → split → collect → resolve', testRoundTrip],
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
