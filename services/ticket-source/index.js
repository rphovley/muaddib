'use strict';
// TicketSource — the one internal seam every ticket-backend touch point in
// muaddib goes through. Implementations: Linear, and "raw" (free-form task
// text — no external backend, see ./raw.js). The milestone this lands under
// adds GitHub Issues as a further sibling. Callers ask for a source via
// getTicketSource() and never import a backend directly.
//
// The interface (see services/ticket-source/linear.js for the Linear impl):
//
//   name                                        string identifier of the backend
//   watchMode                                   how the dispatch daemon learns about issues:
//                                                 'webhook' (Linear — registerWatch + verifySignature),
//                                                 'poll'    (GitHub — pollIssues on an interval),
//                                                 'none'    (raw — no external system to watch)
//   signatureHeader                             (webhook mode) inbound header carrying the signature
//   graphql(query, variables)                   raw client escape hatch (backend-specific)
//   verifySignature(rawBody, header, secret)    validate an inbound webhook signature
//   fetchTicket(id)                          -> the ticket object (or null)
//   fetchComments(id)                        -> { own, parent }, each a { id, body }[]
//                                               the issue's own comment thread plus its
//                                               parent's (parent [] when none). The generic
//                                               read-back seam — fetchTicket() returns no
//                                               comments, so consumers that scan for a
//                                               "## Plan"/"## Context" comment (idempotency,
//                                               .muaddib/context.md hydration) go through here.
//                                               raw has no thread (both []).
//   pollIssues()                             -> (poll mode) the open issues, normalized like fetchTicket
//   postComment(id, body)                    -> { commentId }
//   mentionUser(handle)                      -> comment-body markup that notifies handle
//   createSubIssue(parentId, title, desc)    -> the created child ticket
//   getBlockingStatus(id)                    -> { supported, blocked, blockedBy, blocking }
//                                               the ticket's "Coordination status" (the Conductor's
//                                               framing): whether `id` is currently blocked and by
//                                               which other tickets, plus what it blocks. Reporting
//                                               only — deciding NOT to spawn a blocked ticket is L1+
//                                               (Raise Autonomy) behavior and out of scope here.
//                                               `supported` is false for backends with no ticket
//                                               relationships (raw); `blocked` is true iff some
//                                               blockedBy entry is still active (a blocker in a
//                                               terminal/closed state stays visible but no longer
//                                               blocks). Each blockedBy/blocking entry is
//                                               { identifier, title, state: { name }, active }.
//   addBlockingRelation(blockerId, blockedId) -> void
//                                               create a "blockerId blocks blockedId" relation — the
//                                               exact edge getBlockingStatus reads back (blockerId ends
//                                               up in blockedId's blockedBy; blockedId in blockerId's
//                                               blocking). The scheduler calls this when it splits a
//                                               ticket into dependent sub-issues. Backends with no
//                                               ticket relationships (raw) no-op it.
//   registerWatch({ teamId, url, secret })   -> { watchId }
//   deregisterWatch(watchId)                 -> tears the watch down
//
// Select a backend with the TICKET_SOURCE env var (default: "linear"). A project
// declares its backend in .muaddib/manifest.json's "ticketSource" key; spawn-worker.sh
// forwards that (plus githubOwner/githubRepo) into the worker as TICKET_SOURCE, so
// the manifest is the source of truth and an explicit env var only overrides it.

const { linearSource, createLinearSource } = require('./linear');
const { rawSource } = require('./raw');
const { githubSource, createGithubSource } = require('./github');

function getTicketSource(kind) {
  const which = (kind || process.env.TICKET_SOURCE || 'linear').toLowerCase();
  switch (which) {
    case 'linear':
      return linearSource;
    case 'raw':
      return rawSource;
    case 'github':
      // GitHub Issues backend (see ./github.js). Implements the read path —
      // fetchTicket(number) → a Linear-shaped ticket — plus the comment/mention/
      // sub-issue write path; watch methods (register/deregister/verifySignature)
      // are explicit "not implemented" stubs pending a later milestone.
      return githubSource;
    default:
      throw new Error(`unknown ticket source: "${which}" (supported: linear, raw, github)`);
  }
}

module.exports = { getTicketSource, createLinearSource, createGithubSource };
