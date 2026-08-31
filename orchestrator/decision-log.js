'use strict';
// Decision Log: an append-only, ticket-scoped audit trail of Conductor
// Handoff Records — what was decided/escalated, and the context that
// justified it. Distinct from any system of record (Linear/GitHub): a
// durable, citable log that lives with the code, at .muaddib/decisions.jsonl.
//
// One JSON object per line, so a lookup by ID never has to parse more than
// the matching line — no giant document to read for one reference. Ordering
// is deliberately NOT encoded in the ID: entries from different tickets (and
// different branches, since each worker appends to its own checkout) don't
// need to interleave numerically to stay meaningful — a separate `timestamp`
// field carries chronology instead. See README "Decision Log".
//
// This is just the storage mechanism and ID generator — nothing writes real
// Handoff Records yet; that's the Conductor's job, in a later milestone.

const fs = require('fs');
const path = require('path');
const fileLock = require('./file-lock');

const FLEET_SCOPE = 'FLEET';

function decisionLogPath(repoDir) {
  return path.join(repoDir, '.muaddib', 'decisions.jsonl');
}

function withLock(logPath, fn) {
  return fileLock.withLock(`${logPath}.lock`, `decision log lock timeout (${logPath})`, fn);
}

// null/undefined means "no ticket" → FLEET_SCOPE. Any other value (including
// falsy-but-meaningful ones like '' or 0) is used as-is — a caller passing
// those made a choice, and silently folding them into FLEET would merge
// their seq counter with unrelated fleet-wide entries.
function resolveScope(scope) {
  return scope == null ? FLEET_SCOPE : scope;
}

// The one parser for the log. Yields each parsed entry lazily, skipping any
// unparseable line defensively — a half-merged log from two branches shouldn't
// crash ID generation, a full read, or a single-record lookup over one bad
// line. Lazy on purpose: a caller doing a lookup (getById/search) can stop on
// the first match without parsing — or materializing an array of — the rest of
// the log, which is the whole point of the JSONL layout at 1000+ entries. A
// missing file is an empty log, not an error.
function* forEachEntryAtPath(logPath) {
  let raw;
  try {
    raw = fs.readFileSync(logPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (_) {
      continue; // skip malformed line
    }
    yield entry;
  }
}

function readEntriesAtPath(logPath) {
  return [...forEachEntryAtPath(logPath)];
}

function readEntries(repoDir) {
  return readEntriesAtPath(decisionLogPath(repoDir));
}

// The record keys the module computes on write (never taken from `fields`).
// Callers filter on these explicitly (scope/timestamp), so free-text search
// deliberately skips them — a query shouldn't match on an ADR id fragment or
// an ISO timestamp digit that a human never wrote as content.
const COMPUTED_KEYS = new Set(['id', 'scope', 'timestamp']);
const DEFAULT_SEARCH_LIMIT = 20;
const SNIPPET_CONTEXT = 60; // chars of context on each side of a match

// Returns the first record whose `id` matches, or null. Short-circuits on the
// first hit via the lazy iterator — it never parses past the match, so a
// lookup near the top of a large log stays cheap. Malformed lines are skipped,
// same as any other read.
function getByIdAtPath(logPath, id) {
  for (const entry of forEachEntryAtPath(logPath)) {
    if (entry.id === id) return entry;
  }
  return null;
}

function getById(repoDir, id) {
  return getByIdAtPath(decisionLogPath(repoDir), id);
}

// Builds a bounded, ellipsized snippet around a match: "<field>: …<window>…".
// Returns only the matched field's neighborhood, never the whole value — the
// point of search is to return enough to judge relevance and cite an id, then
// let the caller getById() the full record if it decides the hit is relevant.
function makeSnippet(field, value, matchIndex, matchLen) {
  const start = Math.max(0, matchIndex - SNIPPET_CONTEXT);
  const end = Math.min(value.length, matchIndex + matchLen + SNIPPET_CONTEXT);
  let text = value.slice(start, end);
  if (start > 0) text = `…${text}`;
  if (end < value.length) text = `${text}…`;
  return `${field}: ${text}`;
}

// Case-insensitive free-text search over each record's *content* fields (every
// key except the computed id/scope/timestamp). Returns lightweight hits —
// `{ id, scope, timestamp, snippet }` — never the full record, so a broad
// query can't dump whole documents into a caller's context. `opts.scope`
// restricts to one ticket/FLEET scope (compared exactly, so a falsy-but-real
// scope like '' or 0 filters correctly); `opts.limit` (default 20) caps the
// number of hits so a common word can't return the entire log. The first
// matching content field of a record wins its one hit.
function searchAtPath(logPath, query, opts = {}) {
  const { scope, limit = DEFAULT_SEARCH_LIMIT } = opts;
  const hits = [];
  const needle = query == null ? '' : String(query).toLowerCase();
  if (!needle) return hits;

  for (const entry of forEachEntryAtPath(logPath)) {
    if (scope !== undefined && entry.scope !== scope) continue;

    for (const [key, rawVal] of Object.entries(entry)) {
      if (COMPUTED_KEYS.has(key)) continue;
      // Stringify non-string values so a match can be found in numbers/objects
      // too; undefined stringifies to undefined and is skipped.
      const val = typeof rawVal === 'string' ? rawVal : JSON.stringify(rawVal);
      if (val == null) continue;
      const idx = val.toLowerCase().indexOf(needle);
      if (idx === -1) continue;
      hits.push({
        id: entry.id,
        scope: entry.scope,
        timestamp: entry.timestamp,
        snippet: makeSnippet(key, val, idx, needle.length),
      });
      break; // one hit per record — the first matching field
    }

    if (hits.length >= limit) break;
  }
  return hits;
}

function search(repoDir, query, opts) {
  return searchAtPath(decisionLogPath(repoDir), query, opts);
}

// ADR-{seq}-{scope} — scope is a Linear ticket id, or FLEET_SCOPE when a
// decision isn't scoped to one ticket. seq is monotonic per scope: the
// highest existing seq already logged for that scope, plus one.
function nextIdAtPath(logPath, scope) {
  const s = resolveScope(scope);
  const prefix = 'ADR-';
  const suffix = `-${s}`;
  let maxSeq = 0;
  for (const entry of readEntriesAtPath(logPath)) {
    if (typeof entry.id !== 'string') continue;
    if (!entry.id.startsWith(prefix) || !entry.id.endsWith(suffix)) continue;
    const seqStr = entry.id.slice(prefix.length, entry.id.length - suffix.length);
    const seq = Number(seqStr);
    if (Number.isInteger(seq) && seq > maxSeq) maxSeq = seq;
  }
  return `ADR-${maxSeq + 1}-${s}`;
}

function nextId(repoDir, scope) {
  return nextIdAtPath(decisionLogPath(repoDir), scope);
}

// Appends one Handoff Record as a single JSON line. `fields` carries the
// record's own content (whatever a caller wants to log); `id`, `scope`, and
// `timestamp` are always computed here, never taken from `fields`, so they
// can't drift from the log's actual state. Locked so concurrent appends to
// the same file can't interleave writes or race on the same seq number.
function appendDecision(repoDir, scope, fields) {
  const logPath = decisionLogPath(repoDir);
  return withLock(logPath, () => {
    // withLock already created path.dirname(logPath) — it's the same
    // directory as the lock file's own parent.
    const record = {
      ...fields,
      id: nextIdAtPath(logPath, scope),
      scope: resolveScope(scope),
      timestamp: new Date().toISOString(),
    };
    fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
    return record;
  });
}

module.exports = { appendDecision, nextId, readEntries, getById, search, decisionLogPath, FLEET_SCOPE };
