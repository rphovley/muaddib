#!/usr/bin/env node
'use strict';
// Sizes this worker's ticket and, ONLY when the project's sizing hook recommends
// a split, decomposes the ticket into dependent sub-issues wired with native
// task-manager blocking relations, gives each child the parent's aggregated
// "## Context", and posts a "## Sizing & Scheduling" plan on the parent for human
// review (muaddib#106). Runs after gather-context/analyze-ticket, before
// implementation.
//
// This script runs in three modes (muaddib#107 split the eager one-shot into a
// human-confirmation checkpoint for the plan-only flow):
//   - eager  (no flag, the default): size → create sub-issues → wire relations →
//            scoped context → post a "## Sub-issues created" comment (the same
//            children-created marker --commit posts, so the two dedup against each
//            other). The pre-#107 behavior, still used by feature.json / bug.json
//            where an autonomous worker decomposes and keeps going with no human
//            gate.
//   - --propose: size → post a "## Sizing & Scheduling" PREVIEW (planned streams
//            + planned edges, NO sub-issues created) for the operator to confirm.
//   - --commit:  size → create sub-issues → wire relations → scoped context →
//            post a "## Sub-issues created" comment. When the operator confirmed
//            "create tickets and dispatch" (worker state sizing_confirm=dispatch),
//            also mark each child ready-for-dispatch so the dispatch daemon
//            picks it up. Idempotent on its "## Sub-issues created" marker.
// plan.json wires --propose → a confirm/adjust loop → --commit around this script.
// No mode implements or commits git.
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
//   - Step 6 posts the summary comment — pure templating.

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

// Idempotency is anchored on a comment header — the same role "## Context" plays
// for gather-context. Both children-creating routes (eager `run` and `--commit`)
// post and dedup against the SAME "## Sub-issues created" marker, so whichever
// route decomposed the ticket first, the other one skips instead of minting a
// duplicate set of children. The propose preview reuses the "## Sizing &
// Scheduling" header (it IS the sizing/scheduling review the operator confirms)
// and is deliberately NOT a children-created marker: it is posted with no
// children yet, so a bare preview must never block `--commit` from creating them.
const SIZING_HEADER_RE = /^##\s+Sizing\s*&\s*Scheduling\b/m;
const CREATED_HEADER_RE = /^##\s+Sub-issues\s+created\b/m;

// commentMatches(ownComments, re) → true iff the ticket's OWN comment thread
// already carries a comment whose body matches `re`. Only the ticket's own
// comments count (never a parent's) — mirroring gather-context's own→parent
// precedence for the idempotency decision.
function commentMatches(ownComments, re) {
  return (ownComments || []).some((c) => re.test(String((c && c.body) || '')));
}

// alreadyScheduled(ownComments) → true iff the ticket's OWN comment thread
// already carries a "## Sizing & Scheduling" comment, i.e. the eager step ran
// before.
function alreadyScheduled(ownComments) {
  return commentMatches(ownComments, SIZING_HEADER_RE);
}

// ─── templating (sizing/scheduling review comment) ─────────────────────────────

// formatProposalComment({ signal, streams, edges }) → the "## Sizing & Scheduling"
// PREVIEW posted by the propose phase, BEFORE any sub-issue exists. Lists the
// planned streams and planned blocking edges by stream number (no identifiers
// yet) and spells out the operator's three confirmation choices. `streams` is the
// parsed work streams; `edges` is [{ blocker, blocked }] as stream numbers.
function formatProposalComment({ signal, streams, edges }) {
  const streamLines = streams.map((s) => `${s.number}. Stream ${s.number} — ${s.name}`);
  const edgeLines = edges.length
    ? edges.map((e) => `- Stream ${e.blocker} blocks Stream ${e.blocked}`)
    : ['- (none)'];
  return [
    '## Sizing & Scheduling',
    '',
    `**Size:** ${signal.size} (confidence: ${signal.confidence})`,
    '',
    '**Proposed sub-issues** (dependency order):',
    ...streamLines,
    '',
    '**Blocking relations:**',
    ...edgeLines,
    '',
    '_Proposed — no tickets created yet. Confirm in the worker session:_',
    '_1) create tickets and dispatch · 2) create tickets only · 3) needs adjustment._',
  ].join('\n');
}

// formatCreatedComment({ signal, children, edges }) → the "## Sub-issues created"
// comment the commit phase posts after actually creating the children. Same
// shape as formatReviewComment but with a distinct header (the commit
// idempotency marker) and no "confirmation is a separate step" footer — by this
// point confirmation already happened.
function formatCreatedComment({ signal, children, edges }) {
  const subLines = children.map((c, i) => `${i + 1}. ${c.identifier} — ${c.title}`);
  const edgeLines = edges.length
    ? edges.map((e) => `- ${e.blockerId} blocks ${e.blockedId}`)
    : ['- (none)'];
  return [
    '## Sub-issues created',
    '',
    `**Size:** ${signal.size} (confidence: ${signal.confidence})`,
    '',
    '**Sub-issues** (dependency order):',
    ...subLines,
    '',
    '**Blocking relations:**',
    ...edgeLines,
  ].join('\n');
}

// ─── core logic (injectable deps for testing) ──────────────────────────────────

// opts (all optional; env/defaults otherwise), shared by every phase:
//   worker, repo, ticketSource (kind string), ticketId, ticketTitle
//   source              injected TicketSource backend (createSubIssue/addBlockingRelation/postComment/markReadyForDispatch seam)
//   computeSizingSignal injected sizing resolver (tests stub the hook result)
//   plan                injected plan.md text (skips the file read)
//   context             injected context.md text (null = absent; skips the file read)
//   maxCommentChars     child-context chunking ceiling override
//   dispatch            (commit only) override the sizing_confirm=dispatch state read

// prepare(opts, { idempotencyHeaderRe, alreadyReason }) → { skip:true, result }
// for a no-op / already-done finish, or { skip:false, ctx } carrying everything
// the phases need (resolved source/ticket/parent + signal + parsed streams +
// edges + context). Owns the whole no-op gate (raw source, no ticket, sizing
// signal, recommendSplit) and, when idempotencyHeaderRe is given, the
// "this phase already ran" skip. Shared by eager/propose/commit so the gating is
// identical across modes.
async function prepare(opts = {}, { idempotencyHeaderRe = null, alreadyReason = 'already scheduled' } = {}) {
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
    return { skip: true, result: { status: 'skipped', reason } };
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

  // Idempotency: a re-dispatched / resumed worker whose parent already carries
  // this phase's marker comment must NOT redo the phase (the eager/commit phases
  // create sub-issues, and a re-run would mint a duplicate set of children).
  // Mirror gather-context's own-comment check: if the read fails we can't
  // confirm, so fall through and proceed rather than abort. propose passes a null
  // marker (it re-posts a fresh preview every round of the adjust loop).
  if (idempotencyHeaderRe) {
    try {
      const existing = await source.fetchComments(ticketId);
      if (commentMatches(existing && existing.own, idempotencyHeaderRe)) {
        state.merge(worker, { recommend_split: 'true' });
        process.stderr.write(`[size-and-schedule] existing marker comment — ${alreadyReason}\n`);
        return { skip: true, result: { status: 'skipped', reason: alreadyReason } };
      }
    } catch (err) {
      process.stderr.write(`[size-and-schedule] fetchComments failed (continuing): ${err.message}\n`);
    }
  }

  // ── Step 2: draft children from plan.md ──────────────────────────────────────

  const plan = opts.plan ?? readMuaddibFile(repo, 'plan.md');
  const streams = parseWorkStreams(plan);
  if (streams.length === 0) return noop('no work streams in plan.md');

  const edges = computeEdges(streams);
  const context = opts.context ?? readMuaddibFile(repo, 'context.md');

  return {
    skip: false,
    ctx: { worker, repo, source, ticketId, parentTitle, signal, streams, edges, context, maxCommentChars },
  };
}

// createChildren(ctx) → { children, resolvedEdges }. The shared, non-idempotent
// write half of the eager/commit phases: create a sub-issue per stream (in
// dependency order), wire the native blocking relations, and post each child a
// "## Context" SCOPED to its own work stream (inclusion-biased; a child matching
// nothing gets the whole parent context rather than being under-scoped).
async function createChildren(ctx) {
  const { source, ticketId, parentTitle, streams, edges, context, maxCommentChars } = ctx;

  // ── create sub-issues (dependency order) ────────────────────────────────────
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

  // ── wire native blocking relations ──────────────────────────────────────────
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

  // ── scoped "## Context" per child ───────────────────────────────────────────
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

  return { children, resolvedEdges };
}

// run(opts) — EAGER phase (default, no flag). Size → create children → wire
// relations → scoped context → post the "## Sub-issues created" comment. The
// pre-#107 one-shot, still used by feature.json / bug.json. Idempotent on the
// "## Sub-issues created" marker — the SAME marker runCommit posts, so eager and
// commit dedup against each other: a ticket already decomposed by either route is
// never re-decomposed into a duplicate set of children by the other. (The propose
// preview's "## Sizing & Scheduling" header is deliberately NOT a children-created
// marker — it is posted with no children yet — so neither creating route keys off
// it.)
async function run(opts = {}) {
  const prep = await prepare(opts, {
    idempotencyHeaderRe: CREATED_HEADER_RE,
    alreadyReason: 'already scheduled',
  });
  if (prep.skip) return prep.result;
  const { ctx } = prep;

  const { children, resolvedEdges } = await createChildren(ctx);

  const createdBody = formatCreatedComment({ signal: ctx.signal, children, edges: resolvedEdges });
  await ctx.source.postComment(ctx.ticketId, createdBody);

  const identifiers = children.map((c) => c.identifier);
  state.merge(ctx.worker, { recommend_split: 'true', sub_issues: JSON.stringify(identifiers) });
  process.stderr.write(
    `[size-and-schedule] scheduled ${children.length} sub-issue(s), ${resolvedEdges.length} relation(s) — recommend_split=true\n`,
  );
  return { status: 'scheduled', subIssues: identifiers, edges: resolvedEdges };
}

// runPropose(opts) — PROPOSE phase (--propose). Size → post a
// "## Sizing & Scheduling" PREVIEW (planned streams + edges, NO children). Writes
// recommend_split=true + sub_issues_plan. Not idempotent by design: the adjust
// loop re-runs it each round to re-post a revised preview.
async function runPropose(opts = {}) {
  const prep = await prepare(opts, { idempotencyHeaderRe: null });
  if (prep.skip) return prep.result;
  const { ctx } = prep;

  const previewBody = formatProposalComment({ signal: ctx.signal, streams: ctx.streams, edges: ctx.edges });
  await ctx.source.postComment(ctx.ticketId, previewBody);

  const planned = ctx.streams.map((s) => ({ number: s.number, name: s.name }));
  state.merge(ctx.worker, { recommend_split: 'true', sub_issues_plan: JSON.stringify(planned) });
  process.stderr.write(
    `[size-and-schedule] proposed ${ctx.streams.length} stream(s), ${ctx.edges.length} edge(s) — recommend_split=true\n`,
  );
  return { status: 'proposed', streams: planned, edges: ctx.edges };
}

// runCommit(opts) — COMMIT phase (--commit). Size → create children → wire
// relations → scoped context → post the "## Sub-issues created" comment. When the
// operator confirmed "create tickets and dispatch" (worker state
// sizing_confirm=dispatch, or opts.dispatch), also mark each child ready for the
// dispatch daemon to auto-route. Marking is best-effort — the children are
// already created (the expensive, non-idempotent work), so a labeling miss is
// logged, not fatal. Idempotent on the "## Sub-issues created" marker.
async function runCommit(opts = {}) {
  const prep = await prepare(opts, {
    idempotencyHeaderRe: CREATED_HEADER_RE,
    alreadyReason: 'already committed',
  });
  if (prep.skip) return prep.result;
  const { ctx } = prep;

  const { children, resolvedEdges } = await createChildren(ctx);

  // Dispatch decision: an explicit opts.dispatch wins; otherwise read the
  // operator's confirmed choice from worker state. Only 'dispatch' marks
  // ready-for-dispatch; 'tickets_only' finishes at creation.
  const dispatch = opts.dispatch !== undefined
    ? Boolean(opts.dispatch)
    : state.get(ctx.worker, 'sizing_confirm') === 'dispatch';

  let dispatched = 0;
  if (dispatch) {
    for (const c of children) {
      if (!c.identifier) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        await ctx.source.markReadyForDispatch(c.identifier);
        dispatched += 1;
        process.stderr.write(`[size-and-schedule] marked ${c.identifier} ready-for-dispatch\n`);
      } catch (err) {
        process.stderr.write(
          `[size-and-schedule] markReadyForDispatch(${c.identifier}) failed (continuing): ${err.message}\n`,
        );
      }
    }
  }

  // Post the "## Sub-issues created" idempotency marker only AFTER the
  // dispatch-marking loop. It is the skip signal a resumed worker keys off, so a
  // crash mid-marking must leave NO marker — otherwise the retry would skip and
  // the operator's dispatch choice would be silently dropped (the children never
  // get marked ready-for-dispatch).
  const createdBody = formatCreatedComment({ signal: ctx.signal, children, edges: resolvedEdges });
  await ctx.source.postComment(ctx.ticketId, createdBody);

  const identifiers = children.map((c) => c.identifier);
  state.merge(ctx.worker, { recommend_split: 'true', sub_issues: JSON.stringify(identifiers) });
  process.stderr.write(
    `[size-and-schedule] committed ${children.length} sub-issue(s), ${resolvedEdges.length} relation(s), ${dispatched} dispatched — recommend_split=true\n`,
  );
  return { status: 'committed', subIssues: identifiers, edges: resolvedEdges, dispatched: dispatch };
}

// ─── CLI entry point ──────────────────────────────────────────────────────────
// `--propose` / `--commit` select the split phases; no flag runs the eager
// one-shot (feature.json / bug.json). The runner passes the flag via step.args.

if (require.main === module) {
  const arg = process.argv[2];
  const entry = arg === '--commit' ? runCommit : arg === '--propose' ? runPropose : run;
  entry().catch((err) => {
    process.stderr.write(`[size-and-schedule] FATAL: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  run,
  runPropose,
  runCommit,
  prepare,
  createChildren,
  readTicketJson,
  extractWorkStreamsSection,
  parseWorkStreams,
  computeEdges,
  parseContextItems,
  selectRelevantItems,
  scopeContextForStream,
  commentMatches,
  alreadyScheduled,
  formatProposalComment,
  formatCreatedComment,
};
