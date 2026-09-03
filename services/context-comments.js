'use strict';
// Context-comment formatting + read-back helpers — the pure, dependency-light
// side of the "gather context before planning" flow (see scripts/gather-context.js).
//
// Split out from the gather step for the same reason fetch-ticket.js keeps its
// findPlanComment/extractPlanSection helpers pure: three callers need the
// read-back side without pulling in the whole gather machinery —
//   - scripts/gather-context.js   (idempotency: has this ticket already got a
//                                  "## Context" comment? and posting new parts)
//   - scripts/fetch-ticket.js     (hydrate .muaddib/context.md from an existing
//                                  "## Context" comment, own→parent, alongside
//                                  the "## Plan" hydration it already does)
//   - any downstream consumer that wants the aggregated context back
//
// The comment convention mirrors "## Plan"/"## Sketch": a searchable "## Context"
// header, split into "## Context (n/m)" parts when one aggregate exceeds a
// backend's comment size limit, reassembled on read by part index and falling
// back to the parent ticket's "## Context" when the current ticket carries none.

// Backend comment size ceiling used when chunking. GitHub caps an issue comment
// at 65536 chars and Linear's limit is comparable; 60000 leaves generous headroom
// for the "## Context (n/m)" header and any backend-side markup. Overridable per
// call so tests can force multi-part chunking without 60k-char fixtures.
const MAX_COMMENT_CHARS = 60000;

// ─── formatting (gather → markdown) ────────────────────────────────────────────

// formatContext(results) → one markdown body under a single "## Context" header.
// `results` is the aggregated { name, summary, items:[{title,url?,body}] }[] the
// gather step collects, one entry per configured context source (in manifest
// order). Each source becomes a "### <name>" section: its summary line, then one
// "#### <title>" block per item. A source with neither a summary nor any items
// is skipped entirely; a source with a summary but no items (e.g. processDocs's
// "not configured" state) keeps its summary line so that state stays legible.
function formatContext(results) {
  const blocks = [];
  for (const r of results || []) {
    if (!r) continue;
    const name = (r.name || 'source').trim();
    const summary = (r.summary || '').trim();
    const items = Array.isArray(r.items) ? r.items.filter(Boolean) : [];
    // Skip a wholly empty source; keep a summary-only one (legible "not configured").
    if (!summary && items.length === 0) continue;

    const lines = [`### ${name}`];
    if (summary) lines.push(summary);
    for (const it of items) {
      const title = (it.title || '').trim() || '(untitled)';
      const body = (it.body || '').trim();
      lines.push('');
      lines.push(it.url ? `#### ${title}\n${it.url}` : `#### ${title}`);
      if (body) {
        lines.push('');
        lines.push(body);
      }
    }
    blocks.push(lines.join('\n').replace(/\s+$/, ''));
  }

  const inner = blocks.join('\n\n');
  return `${`## Context\n\n${inner}`.replace(/\s+$/, '')}\n`;
}

// ─── chunking (markdown → comment parts) ────────────────────────────────────────

// splitIntoParts(body, max) → the comment bodies to post, each ≤ ~max chars.
// A body that fits in one comment stays a single bare "## Context" part; a larger
// one is split on "### " source-section boundaries (never inside a rendered item
// header) into "## Context (1/m)…", "## Context (2/m)…" parts, packed greedily in
// order so a reader sees the sections in the same sequence formatContext emitted.
// A single section that alone exceeds `budget` is hard-split (on line
// boundaries, falling back to a raw character slice for one over-long line) so
// that no emitted part can ever exceed the comment size cap — an oversized part
// would be rejected by the backend and crash the post.
function splitOversizedSection(sec, budget) {
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push(buf); buf = ''; } };
  for (const line of sec.split('\n')) {
    if (line.length > budget) {
      // A single line longer than budget can't be packed — hard-slice it.
      flush();
      for (let i = 0; i < line.length; i += budget) out.push(line.slice(i, i + budget));
      continue;
    }
    const candidate = buf ? `${buf}\n${line}` : line;
    if (candidate.length > budget) {
      flush();
      buf = line;
    } else {
      buf = candidate;
    }
  }
  flush();
  return out;
}

function splitIntoParts(body, max = MAX_COMMENT_CHARS) {
  const trimmed = String(body || '').trim();
  if (!trimmed) return [];

  // Reserve room for the largest realistic "## Context (nn/nn)\n\n" header so a
  // packed part plus its header stays under `max`.
  const HEADER_ALLOWANCE = 24;
  const budget = Math.max(1, max - HEADER_ALLOWANCE);

  // pieces[0] is the "## Context" header block; the rest are "### …" sections.
  // Any section that alone exceeds the budget is broken down so no single part
  // can blow the size cap.
  const pieces = trimmed.split(/\n(?=### )/);
  const sections = pieces
    .slice(1)
    .map((s) => s.replace(/\s+$/, ''))
    .flatMap((s) => (s.length > budget ? splitOversizedSection(s, budget) : [s]));
  if (sections.length === 0) {
    // No section structure to split on — one part, header untouched.
    return [trimmed];
  }

  const groups = [];
  let cur = [];
  let curLen = 0;
  for (const sec of sections) {
    const secLen = sec.length + 2; // the "\n\n" that will join it
    if (cur.length > 0 && curLen + secLen > budget) {
      groups.push(cur);
      cur = [];
      curLen = 0;
    }
    cur.push(sec);
    curLen += secLen;
  }
  if (cur.length) groups.push(cur);

  const m = groups.length;
  if (m === 1) {
    // Fits in one comment → bare "## Context", no "(1/1)".
    return [`## Context\n\n${groups[0].join('\n\n')}`];
  }
  return groups.map((g, i) => `## Context (${i + 1}/${m})\n\n${g.join('\n\n')}`);
}

// ─── read-back (comments → aggregated context) ──────────────────────────────────

// Extract the "## Context" section from a comment body (from the header line to
// the end), or null if the body carries no such header. Anchored to the start of
// a line so a bare "## Context" mention in prose isn't mistaken for the header —
// the same tolerance findPlanComment/extractPlanSection use for "## Plan".
function extractContextSection(body) {
  if (!body) return null;
  const m = /^## Context\b/m.exec(String(body));
  if (!m) return null;
  return String(body).slice(m.index).replace(/\s+$/, '');
}

// Parse the part index/total from a section header: "## Context (2/3)" → {2,3};
// a bare "## Context" is treated as the sole part {1,1}.
function parsePartIndex(section) {
  const m = /^## Context\s*\((\d+)\/(\d+)\)/.exec(section);
  if (m) return { index: Number(m[1]), total: Number(m[2]) };
  return { index: 1, total: 1 };
}

// collectContextSections(comments) → every comment's "## Context" section body,
// ordered by part index. Tolerant of out-of-order comments and missing parts
// (it orders by whatever indices it finds and never assumes a contiguous run) —
// mirroring how fetch-ticket.js scans comments for "## Plan".
function collectContextSections(comments) {
  const found = [];
  for (const c of comments || []) {
    const section = extractContextSection(c && c.body);
    if (section) found.push({ ...parsePartIndex(section), body: section });
  }
  found.sort((a, b) => a.index - b.index);
  return found.map((f) => f.body);
}

// Reassemble ordered section bodies into one clean "## Context" document: strip
// each part's own "## Context"/"## Context (n/m)" header line and stitch the
// remainders back under a single bare "## Context" header.
function reassemble(sections) {
  if (!sections || sections.length === 0) return null;
  const inner = sections
    .map((s) => s.replace(/^## Context\b[^\n]*\n+/, '').replace(/\s+$/, ''))
    .filter(Boolean)
    .join('\n\n');
  return `${`## Context\n\n${inner}`.replace(/\s+$/, '')}\n`;
}

// resolveContext(ownComments, parentComments) → { markdown, source }.
// The current ticket's own "## Context" comments win; when it has none, fall back
// to the parent ticket's — exactly the own→parent precedence fetch-ticket.js uses
// for "## Plan". `source` is 'own' | 'parent' | null, and `markdown` is the
// reassembled single-"## Context" document (or null when neither has any).
function resolveContext(ownComments, parentComments) {
  const own = collectContextSections(ownComments);
  if (own.length > 0) return { markdown: reassemble(own), source: 'own' };
  const parent = collectContextSections(parentComments);
  if (parent.length > 0) return { markdown: reassemble(parent), source: 'parent' };
  return { markdown: null, source: null };
}

module.exports = {
  MAX_COMMENT_CHARS,
  formatContext,
  splitIntoParts,
  extractContextSection,
  parsePartIndex,
  collectContextSections,
  resolveContext,
};
