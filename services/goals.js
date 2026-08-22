'use strict';
// Reads a project's .muaddib/goals.md — the Goal Context: durable,
// cross-ticket fleet policy (budget/retry/concurrency thresholds, durable
// priorities) that the Conductor should weigh, as distinct from
// CLAUDE.md/AGENTS.md, which describe the product rather than how the fleet
// is managed. See README "Goal Context".
//
// This is just the file convention and a minimal reader/bootstrapper — no
// Conductor consumes it yet (that's a separate milestone), so the content is
// treated as opaque markdown text, not parsed into fields.

const fs = require('fs');
const path = require('path');

const DEFAULT_GOALS_MD = `# Goal Context

Durable, cross-ticket fleet policy — how the Conductor should manage workers
over time, not what the product does (that's CLAUDE.md/AGENTS.md). Edit this
file directly; it's read fresh each time.

## Budget

<!-- e.g. per-ticket cost ceiling, when to stop and escalate to a human -->

## Retry

<!-- e.g. how many times to retry a failed step before escalating -->

## Concurrency

<!-- e.g. max simultaneous workers, priority lanes -->

## Priorities

<!-- e.g. "prefer correctness over speed", "ship small PRs" -->
`;

// Returns { content, bootstrapped }. If .muaddib/goals.md doesn't exist yet,
// writes DEFAULT_GOALS_MD to that path and returns it (bootstrapped: true)
// instead of erroring — callers always get a sane Goal Context to work with.
// An existing file (even an empty one) is returned verbatim and never
// overwritten.
function readGoals(repoDir) {
  const goalsPath = path.join(repoDir, '.muaddib', 'goals.md');
  try {
    const content = fs.readFileSync(goalsPath, 'utf8');
    return { content, bootstrapped: false };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return bootstrap(goalsPath);
  }
}

// Publishes DEFAULT_GOALS_MD to goalsPath without ever exposing a
// partially-written file to a concurrent reader, and without ever clobbering
// content another process (or a human) created in the meantime: write the
// full content to a temp file first, then fs.linkSync it into place — link()
// is atomic and fails with EEXIST if goalsPath already exists, unlike
// renameSync, which would silently overwrite it. Closes both halves of the
// bootstrap race that a plain writeFileSync/renameSync leaves open.
function bootstrap(goalsPath) {
  fs.mkdirSync(path.dirname(goalsPath), { recursive: true });
  const tmp = `${goalsPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, DEFAULT_GOALS_MD);
  try {
    fs.linkSync(tmp, goalsPath);
    return { content: DEFAULT_GOALS_MD, bootstrapped: true };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return { content: fs.readFileSync(goalsPath, 'utf8'), bootstrapped: false };
  } finally {
    // Best-effort cleanup — must never mask a successful return above with a
    // cleanup-only failure (e.g. tmp already gone, EACCES on an overlay fs).
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

module.exports = { readGoals, DEFAULT_GOALS_MD };
