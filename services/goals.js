'use strict';
// Reads a project's .muaddib/goals.md — the Goal Context: durable,
// cross-ticket fleet policy (budget/retry/concurrency thresholds, durable
// priorities) that the Conductor should weigh, as distinct from
// CLAUDE.md/AGENTS.md, which describe the product rather than how the fleet
// is managed. See README "Goal Context".
//
// readGoals() is the file convention and bootstrapper, returning the content
// as opaque markdown. parseThresholds()/readGoalThresholds() layer a lightweight
// reader on top that pulls the budget / concurrency / retry caps out of that
// markdown so the Fleet State report can *surface* them (muaddib#28). This is a
// surfacing read only — nothing here spawns, tears down, or enforces against
// the parsed values.

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
// overwritten. Pass `{ bootstrap: false }` to keep the read strictly side-
// effect-free: a missing file then yields empty content (bootstrapped: false)
// with nothing written — for read-only callers like the Fleet State report.
function readGoals(repoDir, opts = {}) {
  const goalsPath = path.join(repoDir, '.muaddib', 'goals.md');
  try {
    const content = fs.readFileSync(goalsPath, 'utf8');
    return { content, bootstrapped: false };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    if (opts.bootstrap === false) return { content: '', bootstrapped: false };
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

// --- Threshold parsing (muaddib#28) ------------------------------------------
//
// Pull the three numeric fleet caps out of goals.md's free-form markdown. Robust
// to the two heading shapes seen in the wild: the DEFAULT template's separate
// `## Budget` / `## Concurrency` / `## Retry` headings, and a self-hosted file's
// combined `## Budget & retry thresholds` heading (which must feed both budget
// and retry). Never throws — anything unparseable for a given cap is `null`
// ("not set"), so the reader degrades to "surface what's stated" and no more.

// Split markdown into level-2 sections. HTML comments are stripped first so the
// template's placeholder hints (`<!-- e.g. per-ticket cost ceiling -->`) can't
// leak a false number into a section body. Only `## ` (level 2) opens a section:
// the `# Goal Context` title and any `###` sub-headings stay part of a body.
function sections(content) {
  const stripped = String(content == null ? '' : content).replace(/<!--[\s\S]*?-->/g, '');
  const secs = [];
  let cur = null;
  for (const line of stripped.split('\n')) {
    const m = /^##\s+(.*)$/.exec(line);
    if (m) {
      cur = { heading: m[1].trim(), body: [] };
      secs.push(cur);
    } else if (cur) {
      cur.body.push(line);
    }
  }
  return secs.map((s) => ({ heading: s.heading, body: s.body.join('\n') }));
}

// The three cap keywords, so bodyFor can tell a heading dedicated to one cap
// from a combined heading that names several (e.g. "Budget & retry thresholds").
const CAP_KEYWORDS = ['budget', 'concurrency', 'retry'];

// The body text for `keyword`, drawn from the most specific matching section so
// caps sharing a combined heading never bleed into one another. A section whose
// heading names *only* this cap (no other cap keyword) takes precedence over a
// combined one — so a dedicated "## Retry" section is read in preference to the
// retry count mentioned inside a combined "Budget & retry" section, and the
// first-number-wins scan can't pick a neighbouring cap's number. When no
// dedicated section exists, the combined sections feed it (that's how a combined
// "Budget & retry thresholds" heading still supplies both budget and retry). '',
// when nothing matches. Bodies within the chosen tier are joined in document
// order so a cap split across its own sub-sections is still found.
function bodyFor(secs, keyword) {
  const matches = secs.filter((s) => s.heading.toLowerCase().includes(keyword));
  const others = CAP_KEYWORDS.filter((k) => k !== keyword);
  const dedicated = matches.filter((s) => {
    const h = s.heading.toLowerCase();
    return !others.some((k) => h.includes(k));
  });
  const chosen = dedicated.length ? dedicated : matches;
  return chosen.map((s) => s.body).join('\n');
}

// First `$`-prefixed amount as a number (commas/decimals allowed: `$1,000`,
// `$2.50`). A budget cap is recognized only from an explicit `$` sign: without
// one, a bare number that shares a combined heading with another cap (e.g. the
// retry count in "Budget & retry thresholds") can't be told apart from that
// other cap, so we decline to guess rather than misread it as a dollar amount.
// `null` when no `$` amount is present.
function parseBudget(body) {
  const dollar = /\$\s*(\d[\d,]*(?:\.\d+)?)/.exec(body);
  if (dollar) return Number(dollar[1].replace(/,/g, ''));
  return null;
}

// First non-negative integer that is a plain count — `$`-prefixed amounts are
// dropped first, so a dollar budget sharing a combined "Budget & retry" section
// is never read back as the concurrency/retry count. `null` if none remain.
function parseInteger(body) {
  const counts = String(body).replace(/\$\s*\d[\d,]*(?:\.\d+)?/g, ' ');
  const m = /\b(\d+)\b/.exec(counts);
  return m ? Number(m[1]) : null;
}

// Parse the numeric caps out of goals.md markdown. Pure and total: returns
// { budget, concurrency, retry }, each a number or `null` ("not set").
function parseThresholds(content) {
  const secs = sections(content);
  return {
    budget: parseBudget(bodyFor(secs, 'budget')),
    concurrency: parseInteger(bodyFor(secs, 'concurrency')),
    retry: parseInteger(bodyFor(secs, 'retry')),
  };
}

// Read the Goal Context for `repoDir` (bootstrapping the default template if the
// file is missing, via readGoals) and return its parsed thresholds. Inherits
// readGoals()'s read-only-or-one-time-bootstrap contract; a freshly bootstrapped
// default parses to all-`null` (the template states no numbers). Pass
// `{ bootstrap: false }` for a strictly side-effect-free read (a missing file
// then parses to all-`null` without writing anything).
function readGoalThresholds(repoDir, opts = {}) {
  const { content } = readGoals(repoDir, opts);
  return parseThresholds(content);
}

module.exports = { readGoals, parseThresholds, readGoalThresholds, DEFAULT_GOALS_MD };
