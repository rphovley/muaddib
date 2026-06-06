#!/usr/bin/env node
'use strict';
// Fetches a Linear ticket (identifier + title + comments) from $TASK URL,
// detects an existing "## Plan" comment, and writes worker state.
// Outputs the full issue JSON to /tmp/ticket-${WORKER_INDEX}.json.

const https = require('https');
const fs = require('fs');
const path = require('path');
const state = require('../orchestrator/state');

// ─── helpers ─────────────────────────────────────────────────────────────────

function extractIdentifier(task) {
  if (!task) return null;
  const urlMatch = task.match(/\/issue\/([A-Z]+-\d+)/i);
  if (urlMatch) return urlMatch[1].toUpperCase();
  const bareMatch = task.match(/^([A-Z]+-\d+)$/i);
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

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (require.main === module) {
  run(httpGraphql).catch((err) => {
    process.stderr.write(`[fetch-ticket] FATAL: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { run, extractIdentifier, findPlanComment, extractPlanSection };
