'use strict';
// decisionLog context source (see ./index.js) — surfaces muaddib's own Decision
// Log (.muaddib/decisions.jsonl) for a ticket. A single builtin only: the
// Decision Log is muaddib's internal store, not a swappable external system, so
// there's no factory-of-backends here the way taskManager wraps ticket-source.
//
// gatherContext(ticketId) scopes to the ticket via decision-log's exact `scope`
// filter (the Decision Log's `scope` field IS the ticket id) rather than a
// free-text content match — so it neither picks up decisions from other scopes
// that merely mention this id, nor depends on the id appearing in a record's
// body. It maps each lightweight hit { id, scope, timestamp, snippet } into an
// item, never reading full records — search returns bounded snippets, so a broad
// ticket can't dump whole Handoff Records into a planner's context.

const decisionLog = require('../../orchestrator/decision-log');

// Matches the repoDir default the other services resolve to (goals.js,
// sizing-signal.js) — REPO_DIR in a worker, the fleet checkout on the host.
const DEFAULT_REPO_DIR = '/home/worker/repo';

// opts.repoDir   override the checkout searched (tests point this at a fixture).
// opts.search    injectable search fn (defaults to decision-log.js#search).
function createDecisionLogSource(opts = {}) {
  const search = opts.search || decisionLog.search;
  return {
    name: 'decisionLog',

    async gatherContext(ticketId) {
      const repoDir = opts.repoDir || process.env.REPO_DIR || DEFAULT_REPO_DIR;

      // No id → nothing to scope to. search() with an empty needle already
      // returns [], but short-circuit for a clearer summary.
      if (ticketId == null || ticketId === '') {
        return { summary: 'Decision Log: no ticket id to scope to', items: [] };
      }

      const hits = search(repoDir, ticketId, { scope: ticketId });
      const items = hits.map((h) => ({ title: h.id, body: h.snippet }));

      return {
        summary: `Decision Log: ${items.length} decision(s) referencing ${ticketId}`,
        items,
      };
    },
  };
}

const decisionLogSource = createDecisionLogSource();

module.exports = { decisionLogSource, createDecisionLogSource };
