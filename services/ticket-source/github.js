#!/usr/bin/env node
'use strict';
// GitHub Issues implementation of the TicketSource interface (see ./index.js).
//
// Implements the read path — fetchTicket(number) → a normalized ticket object,
// shaped exactly like the Linear backend returns so existing callers
// (orchestrator label-detection reads `labels.nodes[].name`, dispatch-daemon
// reads `state`/`labels`, general callers read identifier/title/description/url)
// work against GitHub with no changes — plus the comment/mention/sub-issue write
// path (postComment, mentionUser, createSubIssue) so the github backend can drive
// the same escalation flows Linear does (e.g. grill-me-async posting a @mention
// comment).
//
// The watch side of the interface (registerWatch, deregisterWatch,
// verifySignature) plus the graphql escape hatch remain a later-milestone
// concern; those methods are explicit "not implemented" stubs here (mirroring how
// ./raw.js handles ops with no backing), so the module still satisfies the
// interface surface without pretending to do more than it does.

const https = require('https');

// ─── raw REST client ────────────────────────────────────────────────────────────
// Same style as linear.js's linearGraphQL: reads the token from the environment,
// rejects on HTTP >= 400 (except a 404 on a GET, which resolves null so a missing
// issue maps to Linear's null-on-missing fetchTicket contract), parses JSON
// otherwise.
// `opts.method` defaults to GET; when `opts.body` is present it's JSON-encoded and
// the Content-Type/Content-Length headers are set, so the same client serves both
// the read and write paths.

function githubRequest(path, { method = 'GET', body } = {}) {
  const token = process.env.GITHUB_TOKEN || '';
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'muaddib',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request(
      {
        hostname: 'api.github.com',
        path,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          // A missing issue is `null`, not an error — matches Linear's
          // fetchTicket. Scope this to the read (GET) path: on a write (POST) a
          // 404 is a real failure (wrong repo, unavailable sub_issues relation),
          // so let it reject/surface rather than masquerade as an empty response.
          if (res.statusCode === 404 && method === 'GET') {
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
    if (payload !== undefined) req.write(payload);
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

// Normalize an issue reference to its bare number. Tolerates a leading '#'
// (`#34`) or a `repo#` prefix (`muaddib#34`) — the identifier shapes callers pass
// around — so the write methods accept the same ids fetchTicket does.
function issueNumber(id) {
  return String(id == null ? '' : id).trim().replace(/^[^#]*#/, '');
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
    throw new Error(`${method}() is a later-milestone stub in the GitHub backend`);
  };

  return {
    name: 'github',

    // No raw-client escape hatch yet; a later-milestone (graphql) concern.
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
    // `id` is the issue number; a leading '#' or a `repo#` prefix is tolerated
    // and stripped (the identifier shapes normalizeIssue emits).
    async fetchTicket(id) {
      const number = issueNumber(id);
      // An empty id would build the `/issues/` list endpoint, whose array
      // response normalizeIssue() would mangle into a garbage ticket — treat a
      // missing id as "not found", matching the null-on-missing contract.
      if (!number) return null;
      const { owner, repo } = resolveRepo();
      const issue = await api(`/repos/${owner}/${repo}/issues/${number}`);
      return normalizeIssue(issue, { repo });
    },

    // postComment(id, body) → { commentId }. POSTs to the issue's comments
    // endpoint; tolerates a '#'/'repo#' prefix on `id` like fetchTicket does.
    // Mirrors Linear's { commentId } return shape.
    async postComment(id, body) {
      const number = issueNumber(id);
      const text = typeof body === 'string' ? body : '';
      if (!text.trim()) {
        throw new Error('postComment requires a non-empty string body');
      }
      const { owner, repo } = resolveRepo();
      const created = await api(`/repos/${owner}/${repo}/issues/${number}/comments`, {
        method: 'POST',
        body: { body: text },
      });
      if (!created || created.id == null) {
        throw new Error(`postComment failed — response: ${JSON.stringify(created)}`);
      }
      return { commentId: created.id };
    },

    // mentionUser(handle) → the markup that notifies `handle` inside a comment
    // body. Pure string helper; normalizes a leading '@'.
    //
    // Verified: a plain `@handle` in a GitHub issue/PR comment body does reliably
    // trigger a notification to that user — this is standard, documented GitHub
    // behavior — so no special markup or API call is needed. Caveat: the user
    // must be able to see the repo (a member/collaborator, or any user on a public
    // repo). The escalation operator is the repo owner/collaborator, so this
    // always holds for muaddib's use.
    mentionUser(handle) {
      const h = String(handle == null ? '' : handle).trim().replace(/^@+/, '');
      return h ? `@${h}` : '';
    },

    // createSubIssue(parentId, title, description) → the created child, normalized
    // through normalizeIssue so callers get fetchTicket's shape.
    //
    // GitHub's native sub-issues REST relation is comparatively new and not
    // uniformly available, so we do NOT make success depend on it:
    //   - Reliable primary path: create the child issue with a `Part of #<parent>`
    //     back-reference at the top of the body. GitHub renders that as a
    //     cross-reference in both issues' timelines, so the relationship is always
    //     visible regardless of the native feature — this is the documented fallback.
    //   - Best-effort enhancement: attempt the native sub_issues link; swallow any
    //     failure with a console.warn, since the cross-reference already covers us.
    async createSubIssue(parentId, title, description) {
      const parentNumber = issueNumber(parentId);
      const { owner, repo } = resolveRepo();
      const backRef = `Part of #${parentNumber}`;
      const body = description ? `${backRef}\n\n${description}` : backRef;
      const child = await api(`/repos/${owner}/${repo}/issues`, {
        method: 'POST',
        body: { title, body },
      });
      if (!child || child.id == null) {
        throw new Error(`createSubIssue failed — response: ${JSON.stringify(child)}`);
      }
      // Best-effort: establish the native relation. The cross-reference above is
      // authoritative, so a failure here (feature unavailable, older API) is warned
      // and ignored rather than failing the whole call.
      try {
        await api(`/repos/${owner}/${repo}/issues/${parentNumber}/sub_issues`, {
          method: 'POST',
          body: { sub_issue_id: child.id },
        });
      } catch (err) {
        console.warn(
          `[github] createSubIssue: native sub-issue link failed (cross-reference stands): ${err.message}`
        );
      }
      return normalizeIssue(child, { repo });
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
