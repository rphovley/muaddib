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
      assignee { name }
      labels { nodes { name } }
    }
  }
`;

const ISSUE_TEAM_QUERY = `
  query IssueTeam($id: String!) {
    issue(id: $id) { team { id } }
  }
`;

// getBlockingStatus reads the issue's native `blocks` relations. Linear models a
// relation as a directed edge: `relations` are edges where this issue is the
// SOURCE (relatedIssue is the target), `inverseRelations` where it is the TARGET
// (issue is the source). So a `blocks` relation in `inverseRelations` means some
// other issue blocks this one (a blocker); a `blocks` relation in `relations`
// means this issue blocks that other one. `state.type` (completed/canceled →
// terminal) lets us tell an active blocker from a historical/closed one.
const BLOCKING_STATUS_QUERY = `
  query BlockingStatus($id: String!) {
    issue(id: $id) {
      relations(first: 100) {
        nodes { type relatedIssue { identifier title state { name type } } }
        pageInfo { hasNextPage endCursor }
      }
      inverseRelations(first: 100) {
        nodes { type issue { identifier title state { name type } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

// Continuation queries: relations/inverseRelations are GraphQL connections, so a
// ticket with more than one page of blocks-relations would otherwise be
// truncated — dropping an active blocker makes `blocked` wrong. Each pages a
// single connection forward from a cursor.
const RELATIONS_PAGE_QUERY = `
  query RelationsPage($id: String!, $after: String) {
    issue(id: $id) {
      relations(first: 100, after: $after) {
        nodes { type relatedIssue { identifier title state { name type } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const INVERSE_RELATIONS_PAGE_QUERY = `
  query InverseRelationsPage($id: String!, $after: String) {
    issue(id: $id) {
      inverseRelations(first: 100, after: $after) {
        nodes { type issue { identifier title state { name type } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

// fetchComments reads a ticket's comment thread (and its parent's) for the
// generic read-back seam — separate from fetch-ticket.js's own richer,
// comment-aware query. Kept minimal: only { id, body }, the fields the "## Plan"
// / "## Context" scanners actually read.
const COMMENTS_QUERY = `
  query FetchComments($id: String!) {
    issue(id: $id) {
      comments(first: 100) { nodes { id body } }
      parent { comments(first: 100) { nodes { id body } } }
    }
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

// addBlockingRelation creates a native `blocks` relation. The relation is
// directed: `issueId` is the SOURCE and `relatedIssueId` the TARGET, so a
// `blocks` edge from blocker→blocked is exactly the edge getBlockingStatus reads
// (blocker's `relations`→blocking includes blocked; blocked's
// `inverseRelations`→blockedBy includes blocker).
const ISSUE_RELATION_CREATE = `
  mutation IssueRelationCreate($issueId: String!, $relatedIssueId: String!, $type: IssueRelationType!) {
    issueRelationCreate(input: { issueId: $issueId, relatedIssueId: $relatedIssueId, type: $type }) {
      success
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

// markReadyForDispatch resolves the dispatch label (see DISPATCH_LABEL) within
// the issue's own team, then attaches it. Labels are team-scoped, so we look
// them up on the resolved team rather than assuming a workspace-global one.
// first: 250 comfortably covers a team's label set; the dispatch label is one a
// human already used to route the parent, so it's expected to exist.
const TEAM_LABELS_QUERY = `
  query TeamLabels($id: String!) {
    team(id: $id) { labels(first: 250) { nodes { id name } } }
  }
`;

const ISSUE_ADD_LABEL = `
  mutation IssueAddLabel($id: String!, $labelId: String!) {
    issueAddLabel(id: $id, labelId: $labelId) { success }
  }
`;

// The label services/dispatch-daemon.js's resolveRoute() requires before it will
// auto-route an issue to a worker. markReadyForDispatch adds it so the sizing
// scheduler can hand a freshly-created sub-issue to the existing dispatch
// automation. Lowercased — resolveRoute lowercases labels before matching, and
// the team-label lookup below compares case-insensitively.
const DISPATCH_LABEL = (process.env.MUADDIB_DISPATCH_LABEL || 'auto').toLowerCase();

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

    // fetchComments(id) → { own, parent }, each a normalized { id, body }[].
    // The generic read-back path callers use when they don't have fetch-ticket's
    // richer query in hand (idempotency checks, .muaddib/context.md hydration).
    // `parent` is [] when the issue has no parent. A missing issue → both empty.
    async fetchComments(id) {
      const data = await graphql(COMMENTS_QUERY, { id });
      const issue = (data && data.issue) || null;
      if (!issue) return { own: [], parent: [] };
      const norm = (nodes) => (nodes || []).map((c) => ({ id: c.id, body: c.body }));
      return {
        own: norm(issue.comments && issue.comments.nodes),
        parent: norm(issue.parent && issue.parent.comments && issue.parent.comments.nodes),
      };
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

    // getBlockingStatus(id) → the ticket's Coordination status: whether it is
    // currently blocked and by which tickets, plus what it blocks. Built from
    // Linear's native `blocks` relations (see BLOCKING_STATUS_QUERY). A missing
    // issue resolves to the empty-but-supported shape rather than throwing, so a
    // caller distinguishes "no blockers" from "backend can't answer" (raw).
    async getBlockingStatus(id) {
      const data = await graphql(BLOCKING_STATUS_QUERY, { id });
      const issue = data && data.issue;
      if (!issue) {
        return { supported: true, blocked: false, blockedBy: [], blocking: [] };
      }
      // Reshape a related Linear issue to the backend-neutral entry, deriving
      // `active` from the state type (completed/canceled are terminal).
      const toEntry = (related) => {
        const type = related && related.state && related.state.type;
        return {
          identifier: related && related.identifier,
          title: related && related.title,
          state: { name: related && related.state && related.state.name },
          active: type !== 'completed' && type !== 'canceled',
        };
      };
      const relationNodes = (issue.relations && issue.relations.nodes) || [];
      const inverseNodes = (issue.inverseRelations && issue.inverseRelations.nodes) || [];
      // Follow the connection cursors so a ticket with more than 100 relations
      // isn't truncated (an omitted active blocker would make `blocked` wrong).
      let relPage = issue.relations && issue.relations.pageInfo;
      while (relPage && relPage.hasNextPage) {
        // eslint-disable-next-line no-await-in-loop
        const page = await graphql(RELATIONS_PAGE_QUERY, { id, after: relPage.endCursor });
        const conn = page && page.issue && page.issue.relations;
        if (!conn) break;
        relationNodes.push(...(conn.nodes || []));
        relPage = conn.pageInfo;
      }
      let invPage = issue.inverseRelations && issue.inverseRelations.pageInfo;
      while (invPage && invPage.hasNextPage) {
        // eslint-disable-next-line no-await-in-loop
        const page = await graphql(INVERSE_RELATIONS_PAGE_QUERY, { id, after: invPage.endCursor });
        const conn = page && page.issue && page.issue.inverseRelations;
        if (!conn) break;
        inverseNodes.push(...(conn.nodes || []));
        invPage = conn.pageInfo;
      }
      // inverseRelations of type `blocks` → issues that block this one.
      const blockedBy = inverseNodes
        .filter((r) => r && r.type === 'blocks' && r.issue)
        .map((r) => toEntry(r.issue));
      // relations of type `blocks` → issues this one blocks.
      const blocking = relationNodes
        .filter((r) => r && r.type === 'blocks' && r.relatedIssue)
        .map((r) => toEntry(r.relatedIssue));
      return {
        supported: true,
        blocked: blockedBy.some((b) => b.active),
        blockedBy,
        blocking,
      };
    },

    // addBlockingRelation(blockerId, blockedId) — create a native `blocks`
    // relation meaning "blockerId blocks blockedId". blockerId is the relation
    // source and blockedId the target, so this is the exact edge getBlockingStatus
    // reads back (blockedId's blockedBy gains blockerId; blockerId's blocking
    // gains blockedId). Returns void; throws on !success, mirroring postComment /
    // createSubIssue. Idempotent: a duplicate `blocks` relation (the edge already
    // exists) is the state we wanted, so it's swallowed as a no-op rather than
    // thrown — Linear rejects the duplicate with an "already exists" GraphQL
    // error.
    async addBlockingRelation(blockerId, blockedId) {
      let data;
      try {
        data = await graphql(ISSUE_RELATION_CREATE, {
          issueId: blockerId,
          relatedIssueId: blockedId,
          type: 'blocks',
        });
      } catch (err) {
        if (/already/i.test(err && err.message)) return;
        throw err;
      }
      const created = data && data.issueRelationCreate;
      if (!created || !created.success) {
        throw new Error(`issueRelationCreate failed — response: ${JSON.stringify(data)}`);
      }
    },

    // markReadyForDispatch(id) — mark a sub-issue ready for the dispatch daemon
    // to auto-route, by attaching the DISPATCH_LABEL the daemon keys off. The
    // sizing scheduler calls this (commit phase, "create tickets and dispatch"
    // option) after creating and wiring a child so services/dispatch-daemon.js
    // picks it up; the native blocking relations already gate a still-blocked
    // child at dispatch time. Resolves the label id within the issue's team,
    // then issueAddLabel — idempotent in effect (re-adding an already-present
    // label is a no-op on Linear's side). Throws on a missing team/label or a
    // !success mutation, mirroring the other write methods; the caller treats a
    // dispatch-marking failure as best-effort (children are already created).
    async markReadyForDispatch(id) {
      const teamData = await graphql(ISSUE_TEAM_QUERY, { id });
      const teamId = teamData && teamData.issue && teamData.issue.team && teamData.issue.team.id;
      if (!teamId) {
        throw new Error(`markReadyForDispatch: could not resolve team for ${id}`);
      }
      const labelsData = await graphql(TEAM_LABELS_QUERY, { id: teamId });
      const nodes = (labelsData && labelsData.team && labelsData.team.labels && labelsData.team.labels.nodes) || [];
      const label = nodes.find((l) => l && String(l.name).toLowerCase() === DISPATCH_LABEL);
      if (!label || !label.id) {
        throw new Error(`markReadyForDispatch: no "${DISPATCH_LABEL}" label in team ${teamId}`);
      }
      const data = await graphql(ISSUE_ADD_LABEL, { id, labelId: label.id });
      const res = data && data.issueAddLabel;
      if (!res || !res.success) {
        throw new Error(`issueAddLabel failed — response: ${JSON.stringify(data)}`);
      }
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
