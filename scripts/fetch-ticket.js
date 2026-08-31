#!/usr/bin/env node
'use strict';
// Fetches the ticket for this worker's task and writes worker state.
// Outputs the ticket JSON to /tmp/ticket-${WORKER_INDEX}.json.
//
// Three routes, keyed on TICKET_SOURCE:
//
// - raw: the whole TASK text IS the ticket — no identifier to extract, no
//   network call, no comments to scan for a plan (there's no comment thread on
//   a raw ticket at all). Routes through services/ticket-source's raw backend.
//
// - linear (the default): keeps its own richer, comment-aware GraphQL query
//   rather than going through TicketSource's fetchTicket() — that interface
//   method doesn't return comments, and this script hydrates .muaddib/plan.md
//   from an existing "## Plan" comment (on the issue or its parent), which
//   needs them.
//
// - github (and any future non-linear, non-raw backend): routes through the
//   generic getTicketSource(kind).fetchTicket() interface, the same way
//   orchestrator.js fetches. TicketSource.fetchTicket() exposes no comments, so
//   plan-comment hydration is skipped here (plan_status='not_found', like raw);
//   analyze-ticket simply (re)generates the plan when none is hydrated. See the
//   generic branch in run() for the full rationale.

const https = require('https');
const fs = require('fs');
const path = require('path');
const state = require('../orchestrator/state');
const { getTicketSource } = require('../services/ticket-source');

// ─── helpers ─────────────────────────────────────────────────────────────────

// Extract the backend-native identifier from a TASK string. `sourceKind`
// defaults to 'linear' so the existing single-arg callers/tests are unchanged.
function extractIdentifier(task, sourceKind = 'linear') {
  if (!task) return null;

  if (sourceKind === 'github') {
    // GitHub issue URL: https://github.com/owner/repo/issues/36
    const urlMatch = task.match(/\/issues\/(\d+)/);
    if (urlMatch) return urlMatch[1];
    // Else a bare "36" or "#36" — github.js's issueNumber() tolerates '#'/'repo#',
    // so a bare number token is all the generic backend needs. No Linear-shaped
    // regex on the github path.
    const bareMatch = task.match(/^#?(\d+)\b/);
    if (bareMatch) return bareMatch[1];
    return null;
  }

  // Linear (default).
  // Full Linear URL: https://linear.app/team/issue/QUO-123/...
  const urlMatch = task.match(/\/issue\/([A-Z]+-\d+)/i);
  if (urlMatch) return urlMatch[1].toUpperCase();
  // Identifier anywhere in the string: bare "QUO-123" or "QUO-123 some description"
  const bareMatch = task.match(/\b([A-Z]+-\d+)\b/i);
  if (bareMatch) return bareMatch[1].toUpperCase();
  return null;
}

function findPlanComment(comments) {
  for (const c of comments) {
    if (c.body && c.body.includes('## Plan')) return c.body;
  }
  return null;
}

function extractPlanSection(commentBody) {
  const idx = commentBody.indexOf('## Plan');
  if (idx === -1) return null;
  return commentBody.slice(idx).trim();
}

// ─── real HTTP graphql call ───────────────────────────────────────────────────

const ISSUE_QUERY = `
  query FetchIssue($identifier: String!) {
    issue(id: $identifier) {
      id
      identifier
      title
      description
      url
      state { name }
      parent {
        id
        identifier
        title
        url
        comments(first: 50) {
          nodes { id body user { name } createdAt updatedAt }
        }
      }
      comments(first: 50) {
        nodes { id body user { name } createdAt updatedAt }
      }
    }
  }
`;

function httpGraphql(query, variables) {
  const apiKey = (process.env.LINEAR_API_KEY ?? '').trim();
  if (!apiKey) throw new Error('LINEAR_API_KEY is not set');

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });
    const req = https.request(
      {
        hostname: 'api.linear.app',
        path: '/graphql',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: apiKey,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            return reject(new Error(`Linear API ${res.statusCode}: ${raw.slice(0, 200)}`));
          }
          try {
            const parsed = JSON.parse(raw);
            if (parsed.errors?.length) {
              return reject(new Error(`Linear GraphQL errors: ${JSON.stringify(parsed.errors)}`));
            }
            resolve(parsed.data);
          } catch (e) {
            reject(new Error(`JSON parse error: ${e.message}\nBody: ${raw.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── core logic (injectable gql for testing) ─────────────────────────────────

async function run(gql, opts = {}) {
  const worker = opts.worker ?? Number(process.env.WORKER_INDEX ?? '0');
  const task = (opts.task ?? process.env.TASK ?? '').trim();
  const repo = (opts.repo ?? process.env.REPO ?? process.cwd()).trim();
  const ticketSourceKind = (opts.ticketSource ?? process.env.TICKET_SOURCE ?? 'linear').toLowerCase();

  if (ticketSourceKind === 'raw') {
    if (!task) throw new Error('TICKET_SOURCE=raw but TASK is empty — nothing to use as the ticket');

    process.stderr.write('[fetch-ticket] raw source — using TASK text directly, no fetch\n');

    const source = opts.rawSource ?? getTicketSource('raw');
    const issue = await source.fetchTicket(task);

    const outPath = `/tmp/ticket-${worker}.json`;
    fs.writeFileSync(outPath, JSON.stringify(issue, null, 2) + '\n');
    process.stderr.write(`[fetch-ticket] wrote ${outPath}\n`);

    // No comment thread on a raw ticket — nothing to hydrate .muaddib/plan.md from.
    const planStatus = 'not_found';

    state.merge(worker, {
      ticket_identifier: issue.identifier,
      ticket_url: issue.url,
      ticket_title: issue.title,
      plan_status: planStatus,
    });

    process.stderr.write(`[fetch-ticket] done — plan_status=${planStatus}\n`);

    return { issue, planStatus };
  }

  if (ticketSourceKind === 'linear') {
    const identifier = extractIdentifier(task);
    if (!identifier) throw new Error(`Could not extract a Linear identifier from TASK: "${task}"`);

    process.stderr.write(`[fetch-ticket] fetching ${identifier}...\n`);

    const data = await gql(ISSUE_QUERY, { identifier });
    const issue = data?.issue;
    if (!issue) throw new Error(`Issue ${identifier} not found`);

    process.stderr.write(`[fetch-ticket] fetched: ${issue.title}\n`);

    const outPath = `/tmp/ticket-${worker}.json`;
    fs.writeFileSync(outPath, JSON.stringify(issue, null, 2) + '\n');
    process.stderr.write(`[fetch-ticket] wrote ${outPath}\n`);

    const ownComments = issue.comments?.nodes ?? [];
    const parentComments = issue.parent?.comments?.nodes ?? [];
    const planComment = findPlanComment([...ownComments, ...parentComments]);

    let planStatus = 'not_found';
    if (planComment) {
      const planSection = extractPlanSection(planComment);
      if (planSection) {
        const planPath = path.join(repo, '.muaddib', 'plan.md');
        fs.mkdirSync(path.dirname(planPath), { recursive: true });
        fs.writeFileSync(planPath, planSection + '\n');
        process.stderr.write(`[fetch-ticket] wrote .muaddib/plan.md (${planSection.length} chars)\n`);
        planStatus = 'found';
      }
    }

    state.merge(worker, {
      ticket_identifier: issue.identifier,
      ticket_url: issue.url,
      ticket_title: issue.title,
      plan_status: planStatus,
    });

    process.stderr.write(`[fetch-ticket] done — plan_status=${planStatus}\n`);

    return { issue, planStatus };
  }

  // ─── generic backend branch (github, and any future non-linear/non-raw) ──────
  // Route through the TicketSource interface the same way orchestrator.js does,
  // rather than the Linear-only ISSUE_QUERY above. `opts.source` is the
  // test-injection seam (mirrors the raw branch's `opts.rawSource`).
  const identifier = extractIdentifier(task, ticketSourceKind);
  if (!identifier) {
    throw new Error(`Could not extract a ${ticketSourceKind} identifier from TASK: "${task}"`);
  }

  process.stderr.write(`[fetch-ticket] fetching ${identifier} via ${ticketSourceKind}...\n`);

  const source = opts.source ?? getTicketSource(ticketSourceKind);
  const issue = await source.fetchTicket(identifier);
  if (!issue) throw new Error(`Issue ${identifier} not found`);

  process.stderr.write(`[fetch-ticket] fetched: ${issue.title}\n`);

  const outPath = `/tmp/ticket-${worker}.json`;
  fs.writeFileSync(outPath, JSON.stringify(issue, null, 2) + '\n');
  process.stderr.write(`[fetch-ticket] wrote ${outPath}\n`);

  // Plan-comment scanning is Linear-only. TicketSource.fetchTicket() returns no
  // comments, and GitHub REST has no parent-issue-with-nested-comments concept,
  // so there is nothing to hydrate .muaddib/plan.md from here — plan_status is
  // 'not_found', identical to the raw path. This is safe: analyze-ticket simply
  // (re)generates the plan when none is hydrated. A GitHub-shaped plan lookup
  // (an extra Issues-comments API call) is a deliberate follow-up, not this fix.
  const planStatus = 'not_found';

  state.merge(worker, {
    ticket_identifier: issue.identifier,
    ticket_url: issue.url,
    ticket_title: issue.title,
    plan_status: planStatus,
  });

  process.stderr.write(`[fetch-ticket] done — plan_status=${planStatus}\n`);

  return { issue, planStatus };
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (require.main === module) {
  run(httpGraphql).catch((err) => {
    process.stderr.write(`[fetch-ticket] FATAL: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { run, extractIdentifier, findPlanComment, extractPlanSection };
