'use strict';
// The single source of truth for which `source` values each context-source
// `type` accepts — shared by the registry (./index.js) and manifest validation
// (../validate-manifest.js) so the two can never drift.
//
// Kept deliberately dependency-free: validate-manifest.js needs only these
// constants, and requiring ./index.js just for them would pull in the whole
// registry (ticket-source clients, goals, decision-log) at validation time.
//
// taskManager delegates to the ticket backends (linear/raw/github) plus
// 'builtin' (the default ticketSource); decisionLog and processDocs are single
// non-swappable builtins.
const CONTEXT_SOURCE_SOURCES = {
  taskManager: ['linear', 'raw', 'github', 'builtin'],
  decisionLog: ['builtin'],
  processDocs: ['builtin'],
};

const VALID_CONTEXT_SOURCE_TYPES = Object.keys(CONTEXT_SOURCE_SOURCES);

module.exports = { CONTEXT_SOURCE_SOURCES, VALID_CONTEXT_SOURCE_TYPES };
