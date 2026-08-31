#!/usr/bin/env node
'use strict';
// Linear implementation of the TicketSource interface (see ./index.js).
//
// This module is the single home for muaddib's Linear-specific logic: the raw
// GraphQL client, webhook signature verification, and every ticket operation
// (fetch / comment / mention / sub-issue / watch). It used to be spread across
// services/linear-webhook.js, orchestrator/orchestrator.js's inline
// label-detection call, and services/dispatch-daemon.js. Those callers now go
// through the TicketSource interface instead, so swapping Linear for another
// backend (e.g. GitHub Issues) is a matter of adding a sibling implementation.

const crypto = require('crypto');
const https = require('https');

// ─── raw GraphQL client ────────────────────────────────────────────────────────
// Moved verbatim from services/linear-webhook.js — same behavior (reads
// LINEAR_API_KEY from the environment, rejects on HTTP >= 400 or GraphQL errors).

function linearGraphQL(query, variables = {}) {
  const apiKey = process.env.LINEAR_API_KEY || '';
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });
    const req = https.request(
      {
        hostname: 'api.linear.app',
        path: '/graphql',
        method: 'POST',
        headers: {
          Authorization: apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          if (res.statusCode >= 400) {
            reject(new Error(`Linear GraphQL ${res.statusCode}: ${text.slice(0, 300)}`));
            return;
          }
          try {
            const parsed = JSON.parse(text);
            if (parsed.errors && parsed.errors.length > 0) {
              reject(new Error(`Linear GraphQL error: ${JSON.stringify(parsed.errors[0])}`));
              return;
            }
            resolve(parsed.data);
          } catch (_) {
            resolve(text);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── webhook signature verification ────────────────────────────────────────────
// Linear sends the `linear-signature` header as raw hex (no sha256= prefix).
// Moved verbatim from services/linear-webhook.js.

function verifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    const sigBuf = Buffer.from(signatureHeader, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch (_) {
    return false;
  }
}

// ─── GraphQL documents ─────────────────────────────────────────────────────────

// fetchTicket returns enough of the issue to cover every current JS caller:
// orchestrator label-detection reads `labels.nodes`, and general callers read
// identifier/title/state/url. (scripts/fetch-ticket.js keeps its own richer,
// comment-aware query — it hydrates .muaddib/plan.md from ticket comments.)
const FETCH_TICKET_QUERY = `
  query FetchTicket($id: String!) {
    issue(id: $id) {
      id
      identifier
      title
      description
      url
      state { name }
      labels { nodes { name } }
    }
  }
`;

const ISSUE_TEAM_QUERY = `
  query IssueTeam($id: String!) {
    issue(id: $id) { team { id } }
  }
`;

const COMMENT_CREATE = `
  mutation CommentCreate($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) {
      success
      comment { id }
    }
  }
`;

const ISSUE_CREATE = `
  mutation IssueCreate($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue { id identifier url }
    }
  }
`;

const WEBHOOK_CREATE = `
  mutation WebhookCreate($input: WebhookCreateInput!) {
    webhookCreate(input: $input) {
      success
      webhook { id }
    }
  }
`;

const WEBHOOK_DELETE = `
  mutation WebhookDelete($id: String!) {
    webhookDelete(id: $id) { success }
  }
`;

// ─── source factory ────────────────────────────────────────────────────────────
// `graphql` is injectable so the interface methods can be unit-tested without
// touching the network. Defaults to the real Linear client above.

function createLinearSource(opts = {}) {
  const graphql = opts.graphql || linearGraphQL;

  return {
    name: 'linear',

    // How the dispatch daemon learns about new/relabeled issues for this
    // backend: 'webhook' — Linear POSTs to a registered webhook (registerWatch
    // below), and the daemon verifies each inbound request's signature.
    watchMode: 'webhook',

    // The inbound header carrying the webhook signature, so the daemon reads it
    // from the source instead of hardcoding a Linear-specific header name.
    signatureHeader: 'linear-signature',

    // Escape hatch — the raw client, for callers that still need bespoke queries.
    graphql,

    verifySignature,

    // fetchTicket(id) → the issue object (or null if not found).
    async fetchTicket(id) {
      const data = await graphql(FETCH_TICKET_QUERY, { id });
      return (data && data.issue) || null;
    },

    // postComment(id, body) → the created comment's id.
    async postComment(id, body) {
      const data = await graphql(COMMENT_CREATE, { issueId: id, body });
      const created = data && data.commentCreate;
      if (!created || !created.success) {
        throw new Error(`commentCreate failed — response: ${JSON.stringify(data)}`);
      }
      return { commentId: created.comment && created.comment.id };
    },

    // mentionUser(handle) → the markup that notifies `handle` inside a comment
    // body. Pure string helper; normalizes a leading '@'.
    mentionUser(handle) {
      const h = String(handle == null ? '' : handle).trim().replace(/^@+/, '');
      return h ? `@${h}` : '';
    },

    // createSubIssue(parentId, title, description) → the created issue.
    // Linear's issueCreate needs a teamId; inherit it from the parent so the
    // interface signature stays backend-neutral.
    async createSubIssue(parentId, title, description) {
      const parent = await graphql(ISSUE_TEAM_QUERY, { id: parentId });
      const teamId = parent && parent.issue && parent.issue.team && parent.issue.team.id;
      if (!teamId) {
        throw new Error(`createSubIssue: could not resolve team for parent ${parentId}`);
      }
      const data = await graphql(ISSUE_CREATE, {
        input: { teamId, parentId, title, description },
      });
      const created = data && data.issueCreate;
      if (!created || !created.success || !created.issue) {
        throw new Error(`issueCreate failed — response: ${JSON.stringify(data)}`);
      }
      return created.issue;
    },

    // registerWatch({ teamId, url, secret }) → { watchId }. Subscribes to issue
    // events (a Linear webhook) so the dispatch daemon can auto-route tickets.
    async registerWatch({ teamId, url, secret } = {}) {
      const data = await graphql(WEBHOOK_CREATE, {
        input: {
          teamId,
          url,
          secret,
          resourceTypes: ['Issue'],
          allPublicTeams: false,
        },
      });
      const watchId =
        data && data.webhookCreate && data.webhookCreate.webhook && data.webhookCreate.webhook.id;
      if (!watchId) {
        throw new Error(`registerWatch returned no id — response: ${JSON.stringify(data)}`);
      }
      return { watchId };
    },

    // deregisterWatch(watchId) — tears down a watch created by registerWatch.
    async deregisterWatch(watchId) {
      await graphql(WEBHOOK_DELETE, { id: watchId });
    },
  };
}

const linearSource = createLinearSource();

module.exports = { createLinearSource, linearSource, linearGraphQL, verifySignature };
