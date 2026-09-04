#!/usr/bin/env node
'use strict';
// Deterministic pre-dispatch context gatherer for the Conductor's
// `/dispatch-decision` skill. Watching a live QUO-507 triage showed the model
// spending ~10 approval-gated round trips re-deriving the same handful of facts
// every single invocation: raw Linear MCP calls + hand-rolled `python3 -c
// "import json..."` to parse the ticket and its comments, guessing at a
// nonexistent `fleet-control-cli.js status`, then falling back to looping
// `state-cli.js get-all` across worker slots one at a time to find out which
// ticket (if any) each already holds. Every one of those facts is already
// reachable through code muaddib has — this script calls it once,
// deterministically, and hands the skill one pre-built markdown block instead
// of a blank slate to rediscover from scratch on every wake-up.
//
// Deterministic script, not a skill: no judgment happens here, only lookups —
// the same script-fetches-facts/skill-reasons-over-them split already
// established by gather-context.js and size-and-schedule.js.
//
// Gathers:
//   - the ticket itself                    (services/ticket-source fetchTicket)
//   - its comment trail                    (fetchComments)
//   - whole-fleet worker state, including which ticket (if any) each worker
//     already holds                        (orchestrator/fleet-state fleetState)
//   - related PRs/branches already on the remote for this ticket id (gh + git) —
//     best-effort: a missing/unauthenticated `gh`, or no network, degrades to a
//     note rather than a failure, since this is enrichment, not a hard
//     dependency.

const { execFileSync } = require('child_process');
const { getTicketSource } = require('../services/ticket-source');
const { fleetState } = require('../orchestrator/fleet-state');

// Run a command, returning trimmed stdout, or `fallback` on ANY failure (binary
// missing, not authenticated, no network, non-zero exit, malformed output).
// This is best-effort enrichment, never a hard dependency for the caller.
function tryExec(execFn, file, args, opts, fallback) {
  try {
    return execFn(file, args, opts).toString('utf8').trim();
  } catch (_) {
    return fallback;
  }
}

// Related PRs (any state) whose title/body mentions the ticket id, plus any
// remote branch whose name contains it (case-insensitive — branch names are
// conventionally lowercased, e.g. "quo-507-..." for "QUO-507"). Deduped: a
// branch already covered by one of the PRs found isn't listed twice.
function findRelatedWork(ticketId, { execFn = execFileSync, cwd } = {}) {
  const prJson = tryExec(
    execFn,
    'gh',
    [
      'pr', 'list', '--search', ticketId, '--state', 'all',
      '--json', 'number,title,state,url,headRefName,mergedAt',
    ],
    { cwd },
    null,
  );
  let prs = [];
  if (prJson) {
    try {
      const parsed = JSON.parse(prJson);
      if (Array.isArray(parsed)) prs = parsed;
    } catch (_) {
      prs = [];
    }
  }

  const branchOut = tryExec(execFn, 'git', ['branch', '-r'], { cwd }, '');
  const needle = ticketId.toLowerCase();
  const orphanBranches = branchOut
    .split('\n')
    .map((l) => l.trim().replace(/^origin\//, ''))
    .filter((b) => b && b.toLowerCase().includes(needle))
    .filter((b) => !prs.some((pr) => pr.headRefName === b));

  return { prs, orphanBranches };
}

// Both backends' fetchTicket agree on `state.name` for status. `assignee` is a
// flat string on github, `{ name }` on linear (when present); either shape (or
// its absence) is tolerated rather than assumed.
function statusOf(ticket) {
  return (ticket.state && ticket.state.name) || 'unknown';
}

function assigneeOf(ticket) {
  if (ticket.assignee == null) return 'unassigned';
  return typeof ticket.assignee === 'string' ? ticket.assignee : ticket.assignee.name || 'unassigned';
}

function formatFleetSection(state, ticketId) {
  const workers = Array.isArray(state.workers) ? state.workers : [];
  if (!workers.length) return 'No fleet workers have run yet.';

  const holder = workers.find((w) => w.ticketIdentifier === ticketId);
  const summary = holder
    ? `**Worker ${holder.worker} already holds ${ticketId}.**`
    : `No worker currently holds ${ticketId}.`;

  const lines = workers.map((w) => {
    const ticket = w.ticketIdentifier ? w.ticketIdentifier : 'no ticket';
    const step = w.currentStep
      ? `${w.currentStep.id || w.currentStep.type || 'step'} (${w.currentStep.running ? 'running' : 'last'})`
      : 'no step';
    return `- worker ${w.worker}: ${ticket} — ${w.state || '—'} · ${step}`;
  });

  return [summary, ...lines].join('\n');
}

function formatCommentsSection(comments) {
  const own = Array.isArray(comments && comments.own) ? comments.own : [];
  if (!own.length) return 'No comments on the ticket.';
  return own.map((c) => `- ${String(c.body || '').replace(/\s+/g, ' ').trim()}`).join('\n');
}

function formatRelatedWorkSection(related) {
  const { prs, orphanBranches } = related;
  const lines = [];
  for (const pr of prs) {
    const status = pr.mergedAt ? 'merged' : pr.state === 'CLOSED' ? 'closed (unmerged)' : pr.state;
    lines.push(`- PR #${pr.number} "${pr.title}" (${status}, branch \`${pr.headRefName}\`): ${pr.url}`);
  }
  for (const b of orphanBranches) {
    lines.push(`- branch \`${b}\` (no PR)`);
  }
  return lines.length ? lines.join('\n') : 'No related PRs or branches found.';
}

// run(ticketId, opts) -> markdown string.
// opts (all optional, injectable for tests):
//   source          TicketSource backend (default getTicketSource())
//   getFleetState   fleet-state reader (default fleet-state's fleetState)
//   execFn          child_process-shaped exec (default execFileSync)
//   cwd             working dir for gh/git (default process.cwd())
async function run(ticketId, opts = {}) {
  const source = opts.source ?? getTicketSource();
  const getFleet = opts.getFleetState ?? fleetState;
  const cwd = opts.cwd ?? process.cwd();

  const ticket = await source.fetchTicket(ticketId);
  if (ticket == null) {
    return `## Pre-Dispatch Context: ${ticketId}\n\nNo ticket found for ${ticketId} — nothing to gather.\n`;
  }

  const comments = await source.fetchComments(ticketId);
  const fleet = getFleet();
  const related = findRelatedWork(ticketId, { execFn: opts.execFn, cwd });
  const identifier = ticket.identifier || ticketId;

  const lines = [
    `## Pre-Dispatch Context: ${identifier}`,
    '',
    '### Ticket',
    `- **${identifier}**: ${ticket.title || '(no title)'}`,
    `- status: ${statusOf(ticket)} · assignee: ${assigneeOf(ticket)}`,
  ];
  if (ticket.url) lines.push(`- ${ticket.url}`);
  if (ticket.description) lines.push('', ticket.description.trim());

  lines.push(
    '',
    '### Comments',
    formatCommentsSection(comments),
    '',
    '### Fleet',
    formatFleetSection(fleet, identifier),
    '',
    '### Related PRs / branches',
    formatRelatedWorkSection(related),
  );

  return lines.join('\n') + '\n';
}

module.exports = {
  run,
  findRelatedWork,
  formatFleetSection,
  formatCommentsSection,
  formatRelatedWorkSection,
  statusOf,
  assigneeOf,
};

if (require.main === module) {
  const [ticketId] = process.argv.slice(2);
  if (!ticketId) {
    process.stderr.write('usage: gather-dispatch-context.js <ticketId>\n');
    process.exit(1);
  }
  run(ticketId)
    .then((md) => process.stdout.write(md))
    .catch((err) => {
      process.stderr.write(`gather-dispatch-context: ${err.message}\n`);
      process.exit(1);
    });
}
