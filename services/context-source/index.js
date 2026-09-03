'use strict';
// ContextSource — the manifest-driven registry for the *other* sources of truth
// a project wants the fleet to pull from before planning/implementing, mirroring
// services/ticket-source/index.js exactly. Callers ask for a source via
// getContextSource(type, source) and never import a concrete builtin directly.
//
// Where ticket-source generalizes ticket-backend selection, context-source
// generalizes context-backend selection: a project declares which sources it
// wants in .muaddib/manifest.json's "contextSources" array, each entry a
// { type, source } pair, and validate-manifest.js validates it against this
// registry's known type/source pairs.
//
// The interface every source satisfies (deliberately narrow — one method — so
// callers treat all sources uniformly):
//
//   name                              string identifier of the source
//   gatherContext(ticketId, ticket)   -> { summary, items: [{ title, url?, body }] }
//
// The three builtins this issue delivers:
//
//   taskManager   — the ticket backend itself (Linear / GitHub), swappable via
//                   `source`. See ./taskManager.js.
//   decisionLog   — muaddib's own Decision Log; single builtin. See ./decisionLog.js.
//   processDocs   — the project's Goal Context (goals.md); single builtin, with
//                   "not configured" a first-class state. See ./processDocs.js.
//
// (`requirementsAndIntent`/`linkFollow` is a separate issue; "Existing Behavior"
// — CLAUDE.md + Explore — deliberately stays out, it's not a swappable system.)

const { taskManagerSource, createTaskManagerSource } = require('./taskManager');
const { decisionLogSource, createDecisionLogSource } = require('./decisionLog');
const { processDocsSource, createProcessDocsSource } = require('./processDocs');

// The known type/source pairs live in ./sources.js — a dependency-free module
// so validate-manifest.js can validate manifests without pulling in this whole
// registry. Both import from there, so validation and resolution never drift.
const { CONTEXT_SOURCE_SOURCES, VALID_CONTEXT_SOURCE_TYPES } = require('./sources');

// Resolve a { type, source } pair to its implementation. `source` defaults to
// 'builtin' when omitted (a bare `type` means "the default source for it").
// Throws a clear error on an unknown type or an unknown type/source pair,
// mirroring ticket-source/index.js's `unknown ticket source: "<x>" (supported: …)`.
function getContextSource(type, source) {
  const validSources = CONTEXT_SOURCE_SOURCES[type];
  if (!validSources) {
    throw new Error(
      `unknown context source type: "${type}" (supported: ${VALID_CONTEXT_SOURCE_TYPES.join(', ')})`
    );
  }
  const which = source == null ? 'builtin' : source;
  if (!validSources.includes(which)) {
    throw new Error(
      `unknown context source: "${which}" for type "${type}" (supported: ${validSources.join(', ')})`
    );
  }

  switch (type) {
    case 'taskManager':
      // Bind the chosen ticket backend; 'builtin' → the default ticketSource.
      return createTaskManagerSource({ source: which });
    case 'decisionLog':
      return decisionLogSource;
    case 'processDocs':
      return processDocsSource;
    default:
      // Unreachable — CONTEXT_SOURCE_SOURCES above already gated `type`.
      throw new Error(`unhandled context source type: "${type}"`);
  }
}

module.exports = {
  getContextSource,
  CONTEXT_SOURCE_SOURCES,
  VALID_CONTEXT_SOURCE_TYPES,
  // Re-export the builtins (and their factories) as ticket-source re-exports its
  // createLinearSource/createGithubSource, so callers/tests can reach them directly.
  taskManagerSource,
  decisionLogSource,
  processDocsSource,
  createTaskManagerSource,
  createDecisionLogSource,
  createProcessDocsSource,
};
