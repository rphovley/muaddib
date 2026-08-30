#!/usr/bin/env node
'use strict';
// GitHub Issues implementation of the TicketSource interface (see ./index.js).
//
// Read-only backend: it implements only the *read path* — fetchTicket(number) →
// a normalized ticket object, shaped exactly like the Linear backend returns so
// existing callers (orchestrator label-detection reads `labels.nodes[].name`,
// dispatch-daemon reads `state`/`labels`, general callers read
// identifier/title/description/url) work against GitHub with no changes.
//
// The write/watch side of the interface (postComment, mentionUser sentinel,
// createSubIssue, registerWatch, deregisterWatch, verifySignature, graphql) is a
// later-milestone concern; those methods are explicit "not implemented in the
// read-only GitHub backend" stubs here (mirroring how ./raw.js handles ops with
// no backing), so the module still satisfies the interface surface without
// pretending to do more than the read path.

const https = require('https');

// ─── raw REST client ────────────────────────────────────────────────────────────
// Same style as linear.js's linearGraphQL: reads the token from the environment,
// rejects on HTTP >= 400 (except 404, which resolves null so a missing issue maps
// to Linear's null-on-missing fetchTicket contract), parses JSON otherwise.

function githubRequest(path) {
  const token = process.env.GITHUB_TOKEN || '';
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.github.com',
        path,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'muaddib',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          // A missing issue is `null`, not an error — matches Linear's fetchTicket.
          if (res.statusCode === 404) {
            resolve(null);
            return;
          }
          if (res.statusCode >= 400) {
            reject(new Error(`GitHub REST ${res.statusCode} ${path}: ${text.slice(0, 300)}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (_) {
            resolve(text);
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// ─── normalization ──────────────────────────────────────────────────────────────
// Map a GitHub issue payload onto the ticket shape the rest of muaddib expects
// from the Linear backend. Crucially, `labels` and `state` are reshaped into
// Linear's `{ nodes: [{ name }] }` / `{ name }` forms so label-detection and
// state-reading callers need no backend-specific branches.

function normalizeIssue(issue, { repo } = {}) {
  if (!issue) return null;
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  return {
    id: issue.node_id, // stable global id
    identifier: repo ? `${repo}#${issue.number}` : `#${issue.number}`,
    title: issue.title,
    description: issue.body || '',
    url: issue.html_url,
    // Linear-shaped so orchestrator.js / dispatch-daemon.js read labels uniformly.
    labels: {
      nodes: labels.map((l) => ({ name: typeof l === 'string' ? l : l && l.name })),
    },
    // Linear-shaped: GitHub's flat "open"/"closed" → { name }.
    state: issue.state == null ? null : { name: issue.state },
    assignee: (issue.assignee && issue.assignee.login) || null,
    createdBy: (issue.user && issue.user.login) || null,
  };
}

// ─── source factory ────────────────────────────────────────────────────────────
// `api` is the injectable REST client (so the interface can be unit-tested with a
// fake, no network); defaults to the real githubRequest above. `owner`/`repo`
// default to the env vars spawn-worker.sh forwards from the manifest.

function createGithubSource(opts = {}) {
  const api = opts.api || githubRequest;

  function resolveRepo() {
    const owner = opts.owner || process.env.GITHUB_OWNER;
    const repo = opts.repo || process.env.GITHUB_REPO;
    if (!owner || !repo) {
      throw new Error(
        'GitHub ticket source requires GITHUB_OWNER and GITHUB_REPO (forwarded from the manifest by spawn-worker.sh)'
      );
    }
    return { owner, repo };
  }

  const notImplemented = (method) => {
    throw new Error(`${method}() is not implemented in the read-only GitHub backend`);
  };

  return {
    name: 'github',

    // No escape-hatch client in the read-only backend.
    graphql() {
      notImplemented('graphql');
    },

    // Webhook verification is a later-milestone (watch) concern. Until then,
    // return false (like raw.js) rather than throwing, so a webhook POST that
    // reaches dispatch-daemon.js's verifySignature() gate is cleanly rejected
    // instead of crashing the handler.
    verifySignature() {
      return false;
    },

    // fetchTicket(id) → the normalized issue object (or null if not found).
    // `id` is the issue number; a leading '#' is tolerated and stripped.
    async fetchTicket(id) {
      const number = String(id == null ? '' : id).trim().replace(/^#/, '');
      // An empty id would build the `/issues/` list endpoint, whose array
      // response normalizeIssue() would mangle into a garbage ticket — treat a
      // missing id as "not found", matching the null-on-missing contract.
      if (!number) return null;
      const { owner, repo } = resolveRepo();
      const issue = await api(`/repos/${owner}/${repo}/issues/${number}`);
      return normalizeIssue(issue, { repo });
    },

    async postComment() {
      notImplemented('postComment');
    },

    // Pure string helper — identical across backends, cheap to keep working.
    mentionUser(handle) {
      const h = String(handle == null ? '' : handle).trim().replace(/^@+/, '');
      return h ? `@${h}` : '';
    },

    async createSubIssue() {
      notImplemented('createSubIssue');
    },

    async registerWatch() {
      notImplemented('registerWatch');
    },

    async deregisterWatch() {
      notImplemented('deregisterWatch');
    },
  };
}

const githubSource = createGithubSource();

// ─── CLI entry point ──────────────────────────────────────────────────────────
// `node services/ticket-source/github.js 34` fetches issue 34 against the real
// API (GITHUB_OWNER/GITHUB_REPO/GITHUB_TOKEN from the env) and prints the
// normalized JSON — a standalone smoke test of the read path.

if (require.main === module) {
  const id = process.argv[2];
  if (!id) {
    process.stderr.write('usage: node services/ticket-source/github.js <issue-number>\n');
    process.exit(1);
  }
  githubSource
    .fetchTicket(id)
    .then((ticket) => {
      process.stdout.write(`${JSON.stringify(ticket, null, 2)}\n`);
    })
    .catch((err) => {
      process.stderr.write(`[github] FATAL: ${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { createGithubSource, githubSource, githubRequest, normalizeIssue };
