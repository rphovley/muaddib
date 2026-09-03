'use strict';
// taskManager context source (see ./index.js) — the "task manager" source of
// truth is the ticket backend itself (Linear / GitHub Issues), so this is a
// thin wrapper over services/ticket-source rather than a new integration.
//
// gatherContext(ticketId, ticket) resolves the ticket via the already-passed
// `ticket` object when the caller has one (no redundant fetch), else looks it
// up through the ticket backend. Which backend is chosen by the registry's
// `source`: 'builtin' (the default) uses whatever `ticketSource` already
// resolves to — getTicketSource() with no arg, honoring the manifest default /
// TICKET_SOURCE — while 'linear'/'github' bind that specific backend.

const { getTicketSource } = require('../ticket-source');

// opts.source            'linear' | 'github' | 'builtin' | undefined — which
//                        ticket backend to resolve ('builtin'/undefined → the
//                        default ticketSource, i.e. getTicketSource() no-arg).
// opts.getTicketSource   injectable resolver (tests stub the ticket backend).
function createTaskManagerSource(opts = {}) {
  const resolve = opts.getTicketSource || getTicketSource;
  const source = opts.source;
  return {
    // Distinguish entries by backend so two contextSources rows (e.g. a linear
    // and a github taskManager) don't collide on one shared name; the default /
    // 'builtin' source keeps the bare 'taskManager'.
    name: source && source !== 'builtin' ? `taskManager:${source}` : 'taskManager',

    async gatherContext(ticketId, ticket) {
      // Reuse the caller's ticket when present; only fetch when we have an id and
      // no ticket in hand. A null/empty id with no ticket means nothing to gather.
      // The backend is resolved lazily — never when the caller already supplied a
      // ticket — so a passed ticket needs no ticketSource configured at all.
      let t = ticket || null;
      if (!t && ticketId != null && ticketId !== '') {
        // 'builtin' means "the default ticketSource" — pass no arg so the resolver
        // applies its own default (manifest / TICKET_SOURCE), rather than passing
        // the literal string 'builtin' (which getTicketSource wouldn't understand).
        const backend = resolve(source == null || source === 'builtin' ? undefined : source);
        try {
          t = await backend.fetchTicket(ticketId);
        } catch (err) {
          // Degrade gracefully rather than aborting the caller's gather loop: an
          // unreachable or erroring ticket backend yields an empty result with the
          // reason in the summary, mirroring the other sources' non-throwing shape.
          return {
            summary: `No task found for ${JSON.stringify(ticketId)} (fetch failed: ${err.message})`,
            items: [],
          };
        }
      }

      if (!t) {
        return { summary: `No task found for ${JSON.stringify(ticketId)}`, items: [] };
      }

      const identifier = t.identifier || (ticketId != null ? String(ticketId) : '');
      const title = t.title || '';
      const url = t.url || undefined;
      const body = t.description || '';

      return {
        summary: `Task ${identifier}${title ? `: ${title}` : ''}`.trim(),
        items: [{ title: title || identifier || 'Task', url, body }],
      };
    },
  };
}

const taskManagerSource = createTaskManagerSource();

module.exports = { taskManagerSource, createTaskManagerSource };
