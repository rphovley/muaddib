'use strict';
// Shared, dependency-free formatting for muaddib's human-facing notifications.
//
// Both delivery channels — the macOS desktop notification (services/notify.sh,
// driven from runner.js) and Slack (services/notify.js) — render the SAME object
// this module builds via buildNotification(). "What does an alert say" is written
// once here rather than duplicated per channel, so the two never drift apart.
//
// Pure and dependency-free on purpose: it's required from both the orchestrator
// side and the services side, and exercised directly in a unit test with no I/O.

// Interaction kinds — the vocabulary a caller uses to say WHY a human is being
// pinged. Everything except INFO is an attention-needed alert; INFO is the
// quieter progress tier (PR opened, review passed, merge detected) that fires
// with no sound.
const KINDS = Object.freeze({
  QUESTION: 'question', // a step is asking the operator something
  REVIEW: 'review',     // a PR / prototype is ready to look at
  BLOCKED: 'blocked',   // a worker stopped mid-workflow needing a decision
  INFO: 'info',         // informational progress — quiet tier, no sound
});

// Normalize a caller-supplied kind to one of KINDS, or null when it's absent or
// unrecognized (the generic "needs your input" path — e.g. a bare bus notify
// event that carries only a message).
function normalizeKind(kind) {
  const k = String(kind == null ? '' : kind).trim().toLowerCase();
  return Object.values(KINDS).includes(k) ? k : null;
}

// truncate(text, max) — word-boundary-aware character cap. Mirrors
// services/ticket-source/raw.js's titleize() (collapse whitespace, append a
// literal "..." past the limit, keep the result <= max) but with a configurable
// max and without slicing a word in half when a space sits reasonably near the
// cut point.
function truncate(text, max = 72) {
  const t = String(text == null ? '' : text).trim().replace(/\s+/g, ' ');
  if (max <= 0) return '';
  if (t.length <= max) return t;
  // Reserve 3 chars for the ellipsis so the whole thing stays within max.
  const room = Math.max(1, max - 3);
  let cut = t.slice(0, room);
  // Back up to the last space so we don't end mid-word — but only if that space
  // isn't so early it throws away most of the budget (a single very long word).
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace >= Math.floor(room * 0.6)) cut = cut.slice(0, lastSpace);
  return `${cut.replace(/\s+$/, '')}...`;
}

// buildTitle({ projectName, ticketTitle, worker }, { max }) →
// "{Project}: {Ticket Title}", truncated to ~60 chars for the tight desktop
// notification title. Degrades cleanly through project-only, ticket-only, and a
// bare "worker-N" last resort so a title is always produced.
function buildTitle({ projectName, ticketTitle, worker } = {}, { max = 60 } = {}) {
  const project = String(projectName == null ? '' : projectName).trim();
  const ticket = String(ticketTitle == null ? '' : ticketTitle).trim();
  let base;
  if (project && ticket) base = `${project}: ${ticket}`;
  else if (project) base = project;
  else if (ticket) base = ticket;
  else if (worker != null && String(worker).trim() !== '') base = `worker-${worker}`;
  else base = 'muaddib';
  return truncate(base, max);
}

// subtitleForKind(kind, ctx) → the distinct human-readable body line for each
// interaction kind. ctx.url appends an actionable link; ctx.message supplies the
// text for the INFO tier and the generic (unrecognized-kind) fallback.
function subtitleForKind(kind, ctx = {}) {
  const k = normalizeKind(kind);
  const url = ctx.url ? ` — ${ctx.url}` : '';
  switch (k) {
    case KINDS.QUESTION:
      return `A step is waiting on your answer${url}`;
    case KINDS.REVIEW:
      return `Ready for your review${url}`;
    case KINDS.BLOCKED:
      return `Worker stopped mid-workflow — needs a decision${url}`;
    case KINDS.INFO:
      return `${(ctx.message && String(ctx.message).trim()) || 'Progress update'}${url}`;
    default:
      // No recognized kind: a bare notification carrying only a message (e.g. a
      // script-emitted bus event). Preserve the historical generic wording when
      // even the message is empty.
      return `${(ctx.message && String(ctx.message).trim()) || 'A workflow step needs your input'}${url}`;
  }
}

// buildNotification({ worker, projectName, ticketTitle, kind, message, url }) →
// { title, subtitle, tier, sound, kind } — the single object both channels
// render. `tier` is 'info' (quiet progress) vs 'alert'; `sound` is the desktop
// chime, empty for the info tier so quiet progress makes no noise.
function buildNotification(payload = {}) {
  const { worker, projectName, ticketTitle, kind, message, url } = payload;
  const k = normalizeKind(kind);
  const title = buildTitle({ projectName, ticketTitle, worker });
  const subtitle = subtitleForKind(k, { url, message });
  const tier = k === KINDS.INFO ? 'info' : 'alert';
  const sound = tier === 'info' ? '' : 'Glass';
  return { title, subtitle, tier, sound, kind: k };
}

module.exports = { KINDS, normalizeKind, truncate, buildTitle, subtitleForKind, buildNotification };
