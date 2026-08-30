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
//   graphql(query, variables)                   raw client escape hatch (backend-specific)
//   verifySignature(rawBody, header, secret)    validate an inbound webhook signature
//   fetchTicket(id)                          -> the ticket object (or null)
//   postComment(id, body)                    -> { commentId }
//   mentionUser(handle)                      -> comment-body markup that notifies handle
//   createSubIssue(parentId, title, desc)    -> the created child ticket
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
