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

// Reads existing entries, skipping any unparseable lines defensively — a
// half-merged log from two branches shouldn't crash ID generation or a
// lookup over one bad line.
function readEntriesAtPath(logPath) {
  let raw;
  try {
    raw = fs.readFileSync(logPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return [];
  }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (_) {
      // skip malformed line
    }
  }
  return entries;
}

function readEntries(repoDir) {
  return readEntriesAtPath(decisionLogPath(repoDir));
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

module.exports = { appendDecision, nextId, readEntries, decisionLogPath, FLEET_SCOPE };
