#!/usr/bin/env node
'use strict';
// Aggregates a project's declared sources of truth for this worker's ticket and
// posts them to the ticket as one or more "## Context" comments — the planning
// step that runs after fetch-ticket and before analyze-ticket (muaddib#105).
//
// The whole step is deterministic: read the manifest's contextSources, resolve
// each { type, source } through the services/context-source registry (#101), call
// gatherContext(ticketId, ticket) reusing the ticket object fetch-ticket already
// wrote to /tmp/ticket-${WORKER_INDEX}.json, format + chunk the aggregate
// (services/context-comments), and post each part via the active ticket source's
// postComment (source-neutral, honoring TICKET_SOURCE). It also writes the
// aggregated markdown to .muaddib/context.md for same-run downstream steps and a
// context_status (posted | empty | skipped) to worker state.
//
// Idempotent: a re-run / resumed worker whose ticket already carries a
// "## Context" comment does NOT re-post — it just hydrates .muaddib/context.md
// from the existing comment(s) (own→parent) and records context_status=skipped.

const fs = require('fs');
const path = require('path');

const state = require('../orchestrator/state');
const { readMuaddibConfig } = require('../services/muaddib-config');
const { getTicketSource } = require('../services/ticket-source');
const { getContextSource } = require('../services/context-source');
const {
  MAX_COMMENT_CHARS,
  formatContext,
  splitIntoParts,
  resolveContext,
  collectContextSections,
  parsePartIndex,
} = require('../services/context-comments');

// ─── helpers ─────────────────────────────────────────────────────────────────

// Read the ticket object fetch-ticket.js wrote, so taskManager (and any source
// that wants the ticket) needs no refetch. Returns null when absent/unreadable.
function readTicketJson(worker) {
  try {
    return JSON.parse(fs.readFileSync(`/tmp/ticket-${worker}.json`, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeContextFile(repo, markdown) {
  const p = path.join(repo, '.muaddib', 'context.md');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, markdown.endsWith('\n') ? markdown : markdown + '\n');
  process.stderr.write(`[gather-context] wrote ${p} (${markdown.length} chars)\n`);
}

// ─── core logic (injectable deps for testing) ──────────────────────────────────

// opts (all optional; env/defaults otherwise):
//   worker, repo, ticketSource (kind string), ticketId, ticket (object)
//   config              injected manifest object (skips the file read)
//   source              injected TicketSource backend (post/fetchComments seam)
//   getContextSource    injected registry resolver (tests stub context sources)
//   maxCommentChars     chunking ceiling override
async function run(opts = {}) {
  const worker = opts.worker ?? Number(process.env.WORKER_INDEX ?? '0');
  const repo = (opts.repo ?? process.env.REPO_DIR ?? process.cwd()).trim();
  const ticketSourceKind = (opts.ticketSource ?? process.env.TICKET_SOURCE ?? 'linear').toLowerCase();
  const maxCommentChars = opts.maxCommentChars ?? MAX_COMMENT_CHARS;
  const resolveSource = opts.getContextSource ?? getContextSource;

  const config = opts.config ?? readMuaddibConfig(repo);
  const contextSources = Array.isArray(config.contextSources) ? config.contextSources : [];

  const ticketId = opts.ticketId ?? state.get(worker, 'ticket_identifier') ?? null;
  const ticket = opts.ticket ?? readTicketJson(worker);
  const ticketSource = opts.source ?? getTicketSource(ticketSourceKind);

  const finish = (status) => {
    state.merge(worker, { context_status: status });
    process.stderr.write(`[gather-context] done — context_status=${status}\n`);
    return { status };
  };

  // No declared sources → nothing to gather (opt-in per manifest).
  if (contextSources.length === 0) {
    process.stderr.write('[gather-context] no contextSources declared — skipping\n');
    return finish('skipped');
  }

  // Idempotency: if the ticket already carries a "## Context" comment (re-run or
  // resumed worker), don't re-post — hydrate .muaddib/context.md from it and skip.
  let existing = { own: [], parent: [] };
  try {
    existing = await ticketSource.fetchComments(ticketId);
  } catch (err) {
    // A read failure just means we can't confirm idempotency — fall through to
    // gathering rather than aborting the step.
    process.stderr.write(`[gather-context] fetchComments failed (continuing): ${err.message}\n`);
  }
  // Only the ticket's OWN "## Context" comments prove this step already ran.
  // Falling back to a parent's context here (resolveContext's own→parent
  // precedence) would wrongly skip a child that carries none of its own. And a
  // partial multi-part post ("1/3" then a crash) must be re-posted, not mistaken
  // for a finished set — so require a complete run of parts (found === total).
  const ownSections = collectContextSections(existing.own);
  const total = ownSections.length ? parsePartIndex(ownSections[0]).total : 0;
  if (ownSections.length > 0 && ownSections.length === total) {
    const already = resolveContext(existing.own, []);
    process.stderr.write(`[gather-context] existing ## Context found (${already.source}) — not re-posting\n`);
    writeContextFile(repo, already.markdown);
    return finish('skipped');
  }

  // Gather each source, degrading gracefully so one broken source can't abort
  // the whole aggregate — matching the non-throwing shape the sources use.
  const results = [];
  for (const entry of contextSources) {
    const label = entry && entry.source && entry.source !== 'builtin'
      ? `${entry && entry.type}:${entry.source}`
      : `${entry && entry.type}`;
    let src;
    try {
      src = resolveSource(entry.type, entry.source);
    } catch (err) {
      process.stderr.write(`[gather-context] ${label}: unresolved — ${err.message}\n`);
      results.push({ name: label, summary: `(unavailable: ${err.message})`, items: [] });
      continue;
    }
    try {
      const r = await src.gatherContext(ticketId, ticket);
      results.push({ name: src.name || label, summary: r && r.summary, items: (r && r.items) || [] });
    } catch (err) {
      process.stderr.write(`[gather-context] ${src.name || label}: gather failed — ${err.message}\n`);
      results.push({ name: src.name || label, summary: `(failed: ${err.message})`, items: [] });
    }
  }

  const body = formatContext(results);

  // "Empty" — no source produced any items (only summaries like "not
  // configured"). Not worth a ticket comment; downstream reads the ticket
  // directly. Record the state and stop without posting.
  const hasContent = results.some((r) => Array.isArray(r.items) && r.items.length > 0);
  if (!hasContent) {
    process.stderr.write('[gather-context] no items gathered — nothing to post\n');
    return finish('empty');
  }

  writeContextFile(repo, body);

  const parts = splitIntoParts(body, maxCommentChars);
  process.stderr.write(`[gather-context] posting ${parts.length} ## Context comment(s)\n`);
  for (const part of parts) {
    // eslint-disable-next-line no-await-in-loop
    await ticketSource.postComment(ticketId, part);
  }

  return finish('posted');
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (require.main === module) {
  run().catch((err) => {
    process.stderr.write(`[gather-context] FATAL: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { run, readTicketJson };
