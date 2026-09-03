#!/usr/bin/env node
'use strict';
// Sizes this worker's ticket and, ONLY when the project's sizing hook recommends
// a split, decomposes the ticket into dependent sub-issues wired with native
// task-manager blocking relations, gives each child the parent's aggregated
// "## Context", and posts a "## Sizing & Scheduling" plan on the parent for human
// review (muaddib#106). Runs after gather-context/analyze-ticket, before
// implementation.
//
// This step STOPS at posting the review comment — the human confirmation loop
// (review → confirm → spawn children) is a separate milestone. It never
// implements and never commits.
//
// Mirrors scripts/gather-context.js: a deterministic, unit-tested JS `script`
// step (pure functions + a thin CLI wrapper), reserving claude-tui skills for
// genuine LLM judgment. Everything here is mechanical —
//   - Step 1 obtains the Sizing Signal by calling orchestrator/sizing-signal.js's
//     computeSizingSignal directly (a plain module, no CLI/JSON-parse hop). A
//     raw ticket, `configured: false`, `recommendSplit: false`, a misbehaving
//     hook, or a missing/streamless plan.md are all deterministic no-op
//     conditions: write recommend_split=false and stop, silently.
//   - Step 2 parses `### Work Streams` out of .muaddib/plan.md — analyze-ticket
//     enforces the exact `**Stream N — name**` + bullets template, so this is
//     parsing, not interpretation.
//   - Steps 3–4 call createSubIssue / addBlockingRelation directly on the
//     resolved TicketSource. Dependency edges are the deterministic rule: a
//     linear chain (Stream N blocks N+1) unless a stream's body explicitly says
//     "depends on Stream X".
//   - Step 5 gives each child a `## Context` SCOPED to its work stream: every
//     context item (formatContext's per-source { title, url?, body } units,
//     parsed back out of .muaddib/context.md) is scored by simple keyword overlap
//     against the stream's own text, and only the items that clear the floor are
//     posted. The scoring is inclusion-biased (dropping context a child needed is
//     worse than a little extra noise) and any child that matches nothing falls
//     back to the whole parent context rather than being left under-scoped. Still
//     fully deterministic — no model call (conductor-session.js keeps all LLM work
//     on the subscription-billed interactive session, so a script must not reach
//     the model directly).
//   - Step 6 posts the review comment — pure templating.

const fs = require('fs');
const path = require('path');

const state = require('../orchestrator/state');
const { getTicketSource } = require('../services/ticket-source');
const { computeSizingSignal } = require('../orchestrator/sizing-signal');
const { MAX_COMMENT_CHARS, splitIntoParts, formatContext } = require('../services/context-comments');

// ─── helpers ─────────────────────────────────────────────────────────────────

// Read the ticket object fetch-ticket.js wrote (for the parent title), so no
// refetch is needed. Returns null when absent/unreadable.
function readTicketJson(worker) {
  try {
    return JSON.parse(fs.readFileSync(`/tmp/ticket-${worker}.json`, 'utf8'));
  } catch (_) {
    return null;
  }
}

// Read a `.muaddib/<name>` file under repo, or null when absent/unreadable.
function readMuaddibFile(repo, name) {
  try {
    return fs.readFileSync(path.join(repo, '.muaddib', name), 'utf8');
  } catch (_) {
    return null;
  }
}

// ─── pure parsing (plan.md → work streams → dependency edges) ──────────────────

// Isolate the `### Work Streams` section body — from just after its header line
// to the next `##`/`###` header (or EOF). Returns '' when there is no such
// section. Anchored to line starts so a mention in prose isn't mistaken for it.
function extractWorkStreamsSection(planMarkdown) {
  const text = String(planMarkdown || '');
  const header = /^###\s+Work\s+Streams\s*$/m.exec(text);
  if (!header) return '';
  const rest = text.slice(header.index + header[0].length);
  // Stop at the next section header (## or ###) so "### Open Questions" and any
  // following section are excluded.
  const next = /^#{2,3}\s+\S/m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

// A `**Stream N — name**` header line. The dash between number and name may be an
// em-dash (the template's form), en-dash, or hyphen — accept all three. The name
// itself may contain dashes; the trailing `**` closes it.
const STREAM_HEADER = /^\*\*\s*Stream\s+(\d+)\s*[—–-]\s*(.+?)\s*\*\*\s*$/;

// parseWorkStreams(planMarkdown) → [{ number, name, steps:[], body, dependsOn }]
// in document order. `steps` are the stream's bullet lines (text only); `body` is
// the raw markdown between this header and the next (the child's description);
// `dependsOn` is a stream number parsed from an explicit "depends on Stream X" in
// the body, else null. A plan with no `### Work Streams` or no `**Stream N**`
// headers yields [] — the caller treats that as a no-op.
function parseWorkStreams(planMarkdown) {
  const section = extractWorkStreamsSection(planMarkdown);
  if (!section) return [];

  const lines = section.split('\n');
  const streams = [];
  let cur = null;
  for (const line of lines) {
    const m = STREAM_HEADER.exec(line);
    if (m) {
      cur = { number: Number(m[1]), name: m[2].trim(), bodyLines: [] };
      streams.push(cur);
      continue;
    }
    if (cur) cur.bodyLines.push(line);
  }

  return streams.map((s) => {
    const body = s.bodyLines.join('\n').trim();
    const steps = s.bodyLines
      .map((l) => /^\s*[-*]\s+(.+)$/.exec(l))
      .filter(Boolean)
      .map((mm) => mm[1].trim());
    const dep = /depends\s+on\s+Stream\s+(\d+)/i.exec(body);
    return {
      number: s.number,
      name: s.name,
      steps,
      body,
      dependsOn: dep ? Number(dep[1]) : null,
    };
  });
}

// computeEdges(streams) → [{ blocker, blocked }] as STREAM NUMBERS. The default
// is a linear chain: each stream (after the first, in document order) is blocked
// by the one before it. An explicit "depends on Stream X" in a stream's body
// overrides its default blocker with X — but ONLY when X names an EARLIER stream
// (a backward edge). A forward reference ("Stream 2 depends on Stream 3") would
// contradict Stream 3's own linear default and wire a 2↔3 cycle that leaves both
// children permanently blocked; a self- or unknown reference can't be wired at
// all. All three fall back to the linear default (the immediately preceding
// stream) rather than emitting a cyclic/bogus edge. A dependency declared on the
// first stream is likewise a non-backward reference and is dropped for the same
// reason — the template's streams are dependency-ordered, so Stream 1 has none.
function computeEdges(streams) {
  const indexByNumber = new Map(streams.map((s, i) => [s.number, i]));
  const edges = [];
  for (let i = 1; i < streams.length; i += 1) {
    const s = streams[i];
    const depIdx = s.dependsOn != null ? indexByNumber.get(s.dependsOn) : undefined;
    const override = depIdx !== undefined && depIdx < i ? s.dependsOn : null;
    edges.push({ blocker: override != null ? override : streams[i - 1].number, blocked: s.number });
  }
  return edges;
}

// ─── per-child context scoping (context.md → items → relevant slice) ───────────

// parseContextItems(markdown) → the per-source addressable units, inverting
// context-comments.js#formatContext: [{ name, summary, items:[{title,url?,body}] }]
// in document order. Splits on `### <name>` source sections and, within each, on
// `#### <title>` item blocks (the text before the first item is that source's
// summary; a bare url line right under the title is the item's url, the rest its
// body). A body that itself contains a literal "#### " line is an inherent
// round-trip ambiguity we accept — the template formatContext emits doesn't, and
// mis-parsing only ever changes which slice a child sees, never correctness.
function parseContextItems(markdown) {
  const text = String(markdown || '');
  // pieces[0] is the "## Context" header block; keep only real "### " sections.
  const sections = text.split(/\n(?=### )/).filter((p) => /^### /.test(p));
  return sections.map((sec) => {
    const nl = sec.indexOf('\n');
    const name = sec.slice(3, nl === -1 ? undefined : nl).trim();
    const rest = nl === -1 ? '' : sec.slice(nl + 1);
    // Text before the first "#### " item header is the source summary.
    const parts = rest.split(/\n(?=#### )/);
    let summary = '';
    const items = [];
    for (const part of parts) {
      if (/^#### /.test(part)) {
        items.push(parseContextItem(part));
      } else if (items.length === 0) {
        summary = part.trim();
      }
    }
    return { name, summary, items };
  });
}

// parseContextItem("#### title\n[url]\n\nbody") → { title, url?, body }.
function parseContextItem(block) {
  const lines = block.split('\n');
  const title = lines[0].replace(/^####\s+/, '').trim();
  let idx = 1;
  let url;
  // A non-blank line immediately under the title (before any blank) is the url —
  // exactly how formatContext lays "#### <title>\n<url>" out.
  if (lines[idx] !== undefined && lines[idx].trim() !== '') {
    url = lines[idx].trim();
    idx += 1;
  }
  const body = lines.slice(idx).join('\n').trim();
  return url ? { title, url, body } : { title, body };
}

// Words too common to signal relevance — dropped before overlap scoring so a
// shared "the"/"and" can't pull an unrelated item into a child's context.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'are', 'was',
  'will', 'has', 'have', 'not', 'but', 'its', 'our', 'out', 'use', 'used',
  'add', 'adds', 'new', 'via', 'per', 'all', 'any', 'can', 'get', 'set',
  'when', 'then', 'than', 'each', 'also', 'must', 'should', 'stream',
]);

// termSet(text) → the set of lowercased alphanumeric terms (≥ 3 chars, minus
// stopwords) used as the overlap alphabet for relevance scoring.
function termSet(text) {
  const out = new Set();
  for (const raw of String(text || '').toLowerCase().match(/[a-z0-9_]+/g) || []) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

const streamText = (stream) =>
  [stream && stream.name, ...((stream && stream.steps) || []), stream && stream.body]
    .filter(Boolean)
    .join('\n');

const itemText = (item) => [item && item.title, item && item.body].filter(Boolean).join('\n');

// selectRelevantItems(items, stream) → the subset of `items` whose text shares at
// least one meaningful term with the stream (name + steps + body). The floor is
// deliberately low (one shared term): a false positive is just a little extra
// noise in a child's context, while a false negative drops context the child
// needed and risks it re-litigating a settled decision — so we bias to include.
// A stream with no scorable terms of its own yields [] (the caller then falls
// back to the whole parent context rather than under-scoping the child).
function selectRelevantItems(items, stream) {
  const streamTerms = termSet(streamText(stream));
  if (streamTerms.size === 0) return [];
  const shares = (item) => {
    for (const t of termSet(itemText(item))) if (streamTerms.has(t)) return true;
    return false;
  };
  return (items || []).filter(shares);
}

// scopeContextForStream(sources, stream) → the "## Context" markdown scoped to one
// work stream, or null when nothing scored above the floor (caller falls back to
// the full parent context). Each source keeps its summary line (short, legible)
// and only its stream-relevant items; formatContext drops any source left wholly
// empty. Returns null only when NO item across all sources matched — never an
// empty/summary-only document that would silently under-scope the child.
function scopeContextForStream(sources, stream) {
  let selectedCount = 0;
  const scoped = (sources || []).map((src) => {
    const items = selectRelevantItems(src.items, stream);
    selectedCount += items.length;
    return { name: src.name, summary: src.summary, items };
  });
  if (selectedCount === 0) return null;
  return formatContext(scoped);
}

// ─── idempotency ───────────────────────────────────────────────────────────────

// The parent's review comment is anchored on this header — the same role
// "## Context" plays for gather-context's idempotency check.
const SIZING_HEADER_RE = /^##\s+Sizing\s*&\s*Scheduling\b/m;

// alreadyScheduled(ownComments) → true iff the ticket's OWN comment thread
// already carries a "## Sizing & Scheduling" comment, i.e. this step ran before.
// Only the ticket's own comments count (never a parent's) — mirroring
// gather-context's own→parent precedence for the idempotency decision.
function alreadyScheduled(ownComments) {
  return (ownComments || []).some((c) => SIZING_HEADER_RE.test(String((c && c.body) || '')));
}

// ─── templating (sizing/scheduling review comment) ─────────────────────────────

// formatReviewComment({ signal, children, edges }) → the "## Sizing & Scheduling"
// markdown posted on the parent. `children` is [{ identifier, title }] in
// dependency order; `edges` is [{ blockerId, blockedId }].
function formatReviewComment({ signal, children, edges }) {
  const subLines = children.map((c, i) => `${i + 1}. ${c.identifier} — ${c.title}`);
  const edgeLines = edges.length
    ? edges.map((e) => `- ${e.blockerId} blocks ${e.blockedId}`)
    : ['- (none)'];
  return [
    '## Sizing & Scheduling',
    '',
    `**Size:** ${signal.size} (confidence: ${signal.confidence})`,
    '',
    '**Sub-issues** (dependency order):',
    ...subLines,
    '',
    '**Blocking relations:**',
    ...edgeLines,
    '',
    '_Review these before spawning. Confirmation is a separate step._',
  ].join('\n');
}

// ─── core logic (injectable deps for testing) ──────────────────────────────────

// opts (all optional; env/defaults otherwise):
//   worker, repo, ticketSource (kind string), ticketId, ticketTitle
//   source              injected TicketSource backend (createSubIssue/addBlockingRelation/postComment seam)
//   computeSizingSignal injected sizing resolver (tests stub the hook result)
//   plan                injected plan.md text (skips the file read)
//   context             injected context.md text (null = absent; skips the file read)
//   maxCommentChars     child-context chunking ceiling override
async function run(opts = {}) {
  const worker = opts.worker ?? Number(process.env.WORKER_INDEX ?? '0');
  const repo = (opts.repo ?? process.env.REPO_DIR ?? process.cwd()).trim();
  const ticketSourceKind = (opts.ticketSource ?? process.env.TICKET_SOURCE ?? 'linear').toLowerCase();
  const maxCommentChars = opts.maxCommentChars ?? MAX_COMMENT_CHARS;
  const sizing = opts.computeSizingSignal ?? computeSizingSignal;

  const ticketId = opts.ticketId ?? state.get(worker, 'ticket_identifier') ?? null;
  const ticket = readTicketJson(worker);
  const parentTitle =
    opts.ticketTitle ??
    (ticket && ticket.title) ??
    state.get(worker, 'ticket_title') ??
    ticketId ??
    '';
  const source = opts.source ?? getTicketSource(ticketSourceKind);

  // No-op finish: record recommend_split=false and stop. This is the common case
  // and stays silent (no comment, no children).
  const noop = (reason) => {
    state.merge(worker, { recommend_split: 'false' });
    process.stderr.write(`[size-and-schedule] no-op (${reason}) — recommend_split=false\n`);
    return { status: 'skipped', reason };
  };

  // ── Step 1: sizing signal + no-op gating ────────────────────────────────────

  // A raw ticket (free-form task) has no backend to create sub-issues or
  // relations in — nothing to schedule against.
  if (source && source.name === 'raw') return noop('raw ticket source');
  if (!ticketId) return noop('no ticket identifier');

  let signalResult;
  try {
    signalResult = await sizing(ticketId, { repoDir: repo });
  } catch (err) {
    // A misbehaving configured hook (non-zero exit, unparseable/invalid payload)
    // is a genuine error — but the scheduler treats it as a no-op rather than
    // failing the whole worker, matching the "don't split on doubt" posture.
    process.stderr.write(`[size-and-schedule] sizing hook error (continuing as no-op): ${err.message}\n`);
    return noop('sizing hook error');
  }

  // No hook configured (muaddib's own self-hosting steady state) → nothing to do.
  if (!signalResult || signalResult.configured !== true) return noop('sizing not configured');
  const signal = signalResult.signal || {};
  if (signal.recommendSplit !== true) return noop('recommendSplit=false');

  // Idempotency: a re-dispatched / resumed worker whose parent already carries a
  // "## Sizing & Scheduling" comment must NOT re-create the sub-issues, blocking
  // relations, and comments — that would mint a duplicate set of children on
  // every retry. Mirror gather-context's own-comment idempotency check: if the
  // read fails we can't confirm, so fall through and schedule rather than abort.
  try {
    const existing = await source.fetchComments(ticketId);
    if (alreadyScheduled(existing && existing.own)) {
      state.merge(worker, { recommend_split: 'true' });
      process.stderr.write('[size-and-schedule] existing ## Sizing & Scheduling comment — not re-scheduling\n');
      return { status: 'skipped', reason: 'already scheduled' };
    }
  } catch (err) {
    process.stderr.write(`[size-and-schedule] fetchComments failed (continuing): ${err.message}\n`);
  }

  // ── Step 2: draft children from plan.md ──────────────────────────────────────

  const plan = opts.plan ?? readMuaddibFile(repo, 'plan.md');
  const streams = parseWorkStreams(plan);
  if (streams.length === 0) return noop('no work streams in plan.md');

  const edges = computeEdges(streams);

  // ── Step 3: create sub-issues (dependency order) ─────────────────────────────

  const children = [];
  const numberToId = new Map();
  for (const s of streams) {
    const title = `${parentTitle} — ${s.name}`;
    // eslint-disable-next-line no-await-in-loop
    const child = await source.createSubIssue(ticketId, title, s.body);
    const identifier = child && child.identifier;
    children.push({ identifier, title, number: s.number });
    numberToId.set(s.number, identifier);
    process.stderr.write(`[size-and-schedule] created ${identifier} — ${title}\n`);
  }

  // ── Step 4: wire native blocking relations ───────────────────────────────────

  const resolvedEdges = [];
  for (const e of edges) {
    const blockerId = numberToId.get(e.blocker);
    const blockedId = numberToId.get(e.blocked);
    if (!blockerId || !blockedId) continue; // defensive: a stream we failed to create
    // eslint-disable-next-line no-await-in-loop
    await source.addBlockingRelation(blockerId, blockedId);
    resolvedEdges.push({ blockerId, blockedId });
    process.stderr.write(`[size-and-schedule] ${blockerId} blocks ${blockedId}\n`);
  }

  // ── Step 5: scoped "## Context" per child ────────────────────────────────────

  // Give each child a "## Context" scoped to ITS work stream: parse the parent
  // context (own→parent already resolved by gather-context) back into its
  // per-source items and keep, per child, only the items that share a term with
  // that stream. Inclusion-biased — a child that matches nothing gets the whole
  // parent context rather than being under-scoped. Deterministic, no model call.
  const context = opts.context ?? readMuaddibFile(repo, 'context.md');
  if (context && context.trim()) {
    const sources = parseContextItems(context);
    const fullParts = splitIntoParts(context, maxCommentChars);
    let scopedCount = 0;
    for (const c of children) {
      if (!c.identifier) continue;
      const stream = streams.find((s) => s.number === c.number);
      const scoped = scopeContextForStream(sources, stream);
      if (scoped) scopedCount += 1;
      const parts = scoped ? splitIntoParts(scoped, maxCommentChars) : fullParts;
      for (const part of parts) {
        // eslint-disable-next-line no-await-in-loop
        await source.postComment(c.identifier, part);
      }
    }
    process.stderr.write(
      `[size-and-schedule] posted ## Context to ${children.length} child(ren) (${scopedCount} scoped, ${children.length - scopedCount} full fallback)\n`,
    );
  }

  // ── Step 6: post the sizing/scheduling plan on the parent ────────────────────

  const reviewBody = formatReviewComment({ signal, children, edges: resolvedEdges });
  await source.postComment(ticketId, reviewBody);

  const identifiers = children.map((c) => c.identifier);
  state.merge(worker, { recommend_split: 'true', sub_issues: JSON.stringify(identifiers) });
  process.stderr.write(
    `[size-and-schedule] scheduled ${children.length} sub-issue(s), ${resolvedEdges.length} relation(s) — recommend_split=true\n`,
  );
  return { status: 'scheduled', subIssues: identifiers, edges: resolvedEdges };
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (require.main === module) {
  run().catch((err) => {
    process.stderr.write(`[size-and-schedule] FATAL: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  run,
  readTicketJson,
  extractWorkStreamsSection,
  parseWorkStreams,
  computeEdges,
  parseContextItems,
  selectRelevantItems,
  scopeContextForStream,
  alreadyScheduled,
  formatReviewComment,
};
