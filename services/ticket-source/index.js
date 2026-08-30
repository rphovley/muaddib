'use strict';
// TicketSource — the one internal seam every ticket-backend touch point in
// muaddib goes through. Today the only implementation is Linear; the milestone
// this lands under adds GitHub Issues as a sibling. Callers ask for a source
// via getTicketSource() and never import a backend directly.
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
// Select a backend with the TICKET_SOURCE env var (default: "linear").

const { linearSource, createLinearSource } = require('./linear');

function getTicketSource(kind) {
  const which = (kind || process.env.TICKET_SOURCE || 'linear').toLowerCase();
  switch (which) {
    case 'linear':
      return linearSource;
    default:
      throw new Error(`unknown ticket source: "${which}" (supported: linear)`);
  }
}

module.exports = { getTicketSource, createLinearSource };
