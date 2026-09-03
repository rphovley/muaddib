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

// Companion to issueNumber: extract the repo portion of a `repo#number`
// reference (`muaddib#34` → `muaddib`), or null when the id carries no repo
// prefix (a bare `34` or `#34`). Lets the write path honor a cross-repo
// reference the same way the read path (getBlockingStatus) surfaces one, instead
// of silently resolving every id against the current repo.
function issueRepo(id) {
  const m = String(id == null ? '' : id).trim().match(/^([^#]+)#/);
  return m ? m[1] : null;
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

    // How the dispatch daemon learns about new/relabeled issues for this
    // backend: 'poll'. Unlike Linear's inbound webhook, GitHub issues are
    // discovered by the daemon periodically calling pollIssues() below — no
    // public endpoint, tunnel, or webhook registration required (the daemon
    // already hard-requires GITHUB_TOKEN, and authenticated REST is cheap).
    watchMode: 'poll',

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

    // pollIssues() → the repo's open issues, each normalized through
    // normalizeIssue (fetchTicket's shape). This is the 'poll' watch path the
    // dispatch daemon drives on an interval in place of a webhook.
    //
    // GitHub's list-issues endpoint returns pull requests too (a PR is an issue
    // with a `pull_request` key), so those are dropped — muaddib only dispatches
    // on real issues. Requires GITHUB_OWNER/GITHUB_REPO like every other method.
    async pollIssues() {
      const { owner, repo } = resolveRepo();
      // Paginate: GitHub caps a page at per_page=100, so a repo with more than
      // 100 open issues would otherwise silently drop every auto-labeled issue
      // past the first page. Walk pages until one comes back short (or empty).
      const perPage = 100;
      const all = [];
      for (let page = 1; ; page++) {
        // eslint-disable-next-line no-await-in-loop
        const pageIssues = await api(
          `/repos/${owner}/${repo}/issues?state=open&per_page=${perPage}&page=${page}`
        );
        if (!Array.isArray(pageIssues) || pageIssues.length === 0) break;
        all.push(...pageIssues);
        if (pageIssues.length < perPage) break;
      }
      return all
        .filter((issue) => issue && !issue.pull_request)
        .map((issue) => normalizeIssue(issue, { repo }));
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

    // getBlockingStatus(id) → the ticket's Coordination status, built from
    // GitHub's native issue-dependencies API (GA 2025-08-21):
    //   GET .../issues/{n}/dependencies/blocked_by → issues that block this one
    //   GET .../issues/{n}/dependencies/blocking   → issues this one blocks
    // Each returns an array of full Issue objects, which we map onto the same
    // backend-neutral entry shape Linear returns (identifier `repo#number`,
    // state reshaped to { name }, `active` = not closed). These GET the standard
    // application/vnd.github+json surface githubRequest already sends — the
    // dependencies endpoints need no special media type.
    async getBlockingStatus(id) {
      const number = issueNumber(id);
      // An empty id can't address a specific issue; answer with the
      // supported-but-empty shape (matching fetchTicket's missing-id handling)
      // rather than building a bogus request path.
      if (!number) return { supported: true, blocked: false, blockedBy: [], blocking: [] };
      const { owner, repo } = resolveRepo();
      // A dependency can live in another repo, so derive each entry's repo from
      // the issue itself (nested `repository`, or its `repository_url`) rather
      // than hardcoding the current repo — otherwise a cross-repo dep is
      // mislabeled as `${repo}#…`. Fall back to the current repo when neither is
      // present (the same-repo case).
      const entryRepo = (issue) => {
        if (issue.repository && issue.repository.name) return issue.repository.name;
        if (typeof issue.repository_url === 'string') {
          const m = issue.repository_url.match(/\/repos\/[^/]+\/([^/]+)\/?$/);
          if (m) return m[1];
        }
        return repo;
      };
      const toEntry = (issue) => ({
        identifier: `${entryRepo(issue)}#${issue.number}`,
        title: issue.title,
        // Contract is state: { name } — keep the object even when GitHub omits
        // state so consumers can always read entry.state.name without crashing.
        state: { name: issue.state == null ? null : issue.state },
        active: issue.state !== 'closed',
      });
      // Paginate each dependency endpoint (GitHub caps a page at per_page=100):
      // a ticket with more than 100 blockers/blocked would otherwise be silently
      // truncated, and a dropped active blocker would make `blocked` wrong.
      const fetchAllDeps = async (rel) => {
        const perPage = 100;
        const out = [];
        for (let page = 1; ; page++) {
          // eslint-disable-next-line no-await-in-loop
          const pageItems = await api(
            `/repos/${owner}/${repo}/issues/${number}/dependencies/${rel}?per_page=${perPage}&page=${page}`
          );
          if (!Array.isArray(pageItems) || pageItems.length === 0) break;
          out.push(...pageItems.filter(Boolean));
          if (pageItems.length < perPage) break;
        }
        return out;
      };
      const [blockedByRaw, blockingRaw] = await Promise.all([
        fetchAllDeps('blocked_by'),
        fetchAllDeps('blocking'),
      ]);
      const blockedBy = blockedByRaw.map(toEntry);
      const blocking = blockingRaw.map(toEntry);
      return {
        supported: true,
        blocked: blockedBy.some((b) => b.active),
        blockedBy,
        blocking,
      };
    },

    // addBlockingRelation(blockerId, blockedId) — create a "blockerId blocks
    // blockedId" dependency, the write side of the same issue-dependencies API
    // getBlockingStatus reads. The relation is declared on the BLOCKED issue's
    // `blocked_by` collection, and the write API keys on the blocker's numeric
    // database `id` (not its issue number), so we first GET the blocker to read
    // that raw integer id. Note normalizeIssue maps `id: node_id`, so we read the
    // raw GET payload's `.id` here, not the normalized shape. Tolerates a
    // '#'/'repo#' prefix on either id like the sibling methods, and — mirroring
    // getBlockingStatus's cross-repo read — resolves each id against the repo its
    // own prefix names (falling back to the current repo when unprefixed) rather
    // than assuming both live in the current repo. Idempotent: re-adding an
    // existing dependency is a no-op (see the tolerant catch below), like
    // createSubIssue treats an already-established link. Returns void.
    async addBlockingRelation(blockerId, blockedId) {
      const blockerNumber = issueNumber(blockerId);
      const blockedNumber = issueNumber(blockedId);
      // An empty id can't address a specific issue — guard before building a
      // bogus `/issues/` (list) path, which would GET an array and surface as a
      // misleading "could not resolve blocker" (matching getBlockingStatus /
      // fetchTicket's empty-id handling, but as a write it's a caller error).
      if (!blockerNumber || !blockedNumber) {
        throw new Error(
          `addBlockingRelation requires both a blocker and a blocked issue id (got blocker=${JSON.stringify(blockerId)}, blocked=${JSON.stringify(blockedId)})`
        );
      }
      const { owner, repo } = resolveRepo();
      const blockerRepo = issueRepo(blockerId) || repo;
      const blockedRepo = issueRepo(blockedId) || repo;
      // Resolve the blocker's numeric database id — the dependencies write API
      // keys on it, not the issue number.
      const blocker = await api(`/repos/${owner}/${blockerRepo}/issues/${blockerNumber}`);
      if (!blocker || blocker.id == null) {
        throw new Error(`addBlockingRelation: could not resolve blocker ${blockerRepo}#${blockerNumber}`);
      }
      try {
        await api(`/repos/${owner}/${blockedRepo}/issues/${blockedNumber}/dependencies/blocked_by`, {
          method: 'POST',
          body: { issue_id: blocker.id },
        });
      } catch (err) {
        // Re-adding a dependency that already exists is the state we wanted, not
        // a failure — GitHub rejects the duplicate (422) with an "already"
        // message. Swallow that one case so the call is idempotent; re-throw
        // anything else (bad repo, missing issue, auth).
        if (/already/i.test(err && err.message)) return;
        throw err;
      }
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
