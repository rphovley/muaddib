'use strict';
// Raw-text implementation of the TicketSource interface (see ./index.js).
//
// For a "raw" ticket there's no external system at all — the free-form task
// text itself IS the ticket. fetchTicket() synthesizes a ticket-shaped object
// directly from that text, no network call. Every other interface method is a
// no-op or a clear "not supported" — there's nothing external to comment on,
// mention into, spawn a sub-issue in, or watch. PR-comment feedback for a raw
// ticket goes through services/watch-feedback.js instead, which is already
// GitHub-native and doesn't touch TicketSource at all.

function slugify(text) {
  const words = String(text || '').trim().split(/\s+/).slice(0, 6).join('-');
  const slug = words.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
  return slug || 'task';
}

function titleize(text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  return t.length > 72 ? `${t.slice(0, 69)}...` : t;
}

const rawSource = {
  name: 'raw',

  // No external system to watch — a raw ticket is the task text itself, so the
  // dispatch daemon has nothing to poll or subscribe to for this backend.
  watchMode: 'none',

  // No backend API to escape-hatch into.
  graphql() {
    throw new Error('raw ticket source has no backend — graphql() is not supported');
  },

  // No inbound webhooks originate from a raw ticket.
  verifySignature() {
    return false;
  },

  // fetchTicket(text) → a ticket-shaped object synthesized from the text
  // itself, no network call. `id` here is the raw task text, not a lookup key.
  async fetchTicket(text) {
    const description = String(text || '');
    return {
      id: null,
      identifier: slugify(description),
      title: titleize(description),
      description,
      url: null,
      state: null,
      labels: { nodes: [] },
    };
  },

  // Nothing external to comment on — a raw ticket has no home to post back to.
  async postComment() {
    return { commentId: null };
  },

  // Pure string helper — same shape regardless of backend, no reason to differ.
  mentionUser(handle) {
    const h = String(handle == null ? '' : handle).trim().replace(/^@+/, '');
    return h ? `@${h}` : '';
  },

  async createSubIssue() {
    throw new Error('raw ticket source has no backend — createSubIssue() is not supported');
  },

  async registerWatch() {
    throw new Error('raw ticket source has no backend — registerWatch() is not supported');
  },

  async deregisterWatch() {
    // No-op: nothing was ever registered.
  },
};

module.exports = { rawSource };
