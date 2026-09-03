'use strict';
// processDocs context source (see ./index.js) — surfaces a project's Goal
// Context (.muaddib/goals.md, via services/goals.js#readGoals) as durable
// process documentation the fleet can weigh before planning. A single builtin
// only, like decisionLog.
//
// "Not configured" is a FIRST-CLASS non-error state: smaller teams often keep
// nothing formal here, and a planner asking for process docs should get a clean
// "nothing configured" answer, not a thrown error. It's signalled through the
// same uniform { summary, items } shape every context source returns — a
// distinct summary and empty items — rather than an extra field the other
// sources lack. So the read is strictly read-only — { bootstrap: false } — and
// never writes the default template: an absent/empty goals.md yields empty
// items, a present one a single Goal Context item.

const goals = require('../goals');

// Same repoDir default as decisionLog / goals.js / sizing-signal.js.
const DEFAULT_REPO_DIR = '/home/worker/repo';

// opts.repoDir     override the checkout read (tests point this at a fixture).
// opts.readGoals   injectable reader (defaults to goals.js#readGoals).
function createProcessDocsSource(opts = {}) {
  const readGoals = opts.readGoals || goals.readGoals;
  return {
    name: 'processDocs',

    async gatherContext() {
      const repoDir = opts.repoDir || process.env.REPO_DIR || DEFAULT_REPO_DIR;

      // Strictly read-only: never bootstrap the default template here — surfacing
      // process docs must not create them. A missing file yields empty content.
      const { content } = readGoals(repoDir, { bootstrap: false });
      const text = (content || '').trim();

      if (!text) {
        return {
          summary: 'Process docs: no Goal Context configured',
          items: [],
        };
      }

      return {
        summary: 'Process docs: Goal Context',
        items: [{ title: 'Goal Context', body: content }],
      };
    },
  };
}

const processDocsSource = createProcessDocsSource();

module.exports = { processDocsSource, createProcessDocsSource };
