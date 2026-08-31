#!/usr/bin/env node
'use strict';
// decision-log.js test suite. No container or tmux needed.
//
// testFirstDecisionSeqOne       — first decision for a scope → id "ADR-1-<scope>"
// testSeqIncrementsPerScope     — second decision, same scope → seq=2
// testScopesIndependent         — different ticket scopes have independent seq counters
// testFleetFallback             — omitted scope defaults to FLEET, independently scoped
// testFalsyScopeNotFolded       — scope '' or 0 is kept as its own scope, not folded into FLEET
// testTimestampPresent          — every record carries an explicit ISO timestamp
// testOneJsonLinePerCall        — N appends produce N independently-parseable JSON lines
// testAppendPreservesExisting   — a new append never clobbers prior lines
// testMissingFileBootstraps     — first append with no .muaddib/ dir yet just works
// testMalformedLineSkipped      — a corrupt existing line doesn't break seq computation or reads
// testFieldsCannotOverrideComputedKeys — caller-supplied id/scope/timestamp are ignored
// testReadEntriesReturnsAll     — readEntries returns every appended record, in order
// testConcurrentAppendsNoCollision — two processes appending to the same scope at once
//                                    still produce unique, sequential seq numbers
// testGetByIdReturnsRecord      — getById returns the full record for a known id
// testGetByIdMissingReturnsNull — getById returns null for an id that isn't logged
// testGetByIdMissingFile        — getById on a never-written log returns null (no throw)
// testGetByIdReturnsFirstMatch  — with duplicate ids, getById returns the first one logged
// testGetByIdSkipsMalformed     — a corrupt line doesn't hide a later valid match
// testSearchCaseInsensitive     — search matches regardless of query/record casing
// testSearchMatchesContentField — search matches on a record's content fields
// testSearchSnippetNotFullRecord— a hit carries a bounded snippet + field, never the whole record
// testSearchScopeFilter         — opts.scope restricts hits to that one scope
// testSearchLimit               — opts.limit caps the number of hits returned
// testSearchNoMatch             — a query that matches nothing returns []
// testSearchMissingFile         — search on a never-written log returns [] (no throw)
// testSearchIgnoresComputedKeys — free text never matches on id/scope/timestamp values

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { appendDecision, nextId, readEntries, getById, search, decisionLogPath, FLEET_SCOPE } = require('../decision-log');

let pass = 0;
let fail = 0;

async function run(name, fn) {
  try {
    await fn();
    process.stdout.write(`  ${name}... PASS\n`);
    pass++;
  } catch (err) {
    process.stdout.write(`  ${name}... FAIL: ${err.message}\n`);
    fail++;
  }
}

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'decision-log-'));
}

async function testFirstDecisionSeqOne() {
  const tmp = tmpRepo();
  try {
    const record = appendDecision(tmp, 'QUO-281', { decision: 'use JSONL' });
    assert.strictEqual(record.id, 'ADR-1-QUO-281');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testSeqIncrementsPerScope() {
  const tmp = tmpRepo();
  try {
    appendDecision(tmp, 'QUO-281', { decision: 'first' });
    const second = appendDecision(tmp, 'QUO-281', { decision: 'second' });
    assert.strictEqual(second.id, 'ADR-2-QUO-281');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testScopesIndependent() {
  const tmp = tmpRepo();
  try {
    appendDecision(tmp, 'QUO-281', { decision: 'a' });
    appendDecision(tmp, 'QUO-281', { decision: 'b' });
    const other = appendDecision(tmp, 'QUO-999', { decision: 'c' });
    assert.strictEqual(other.id, 'ADR-1-QUO-999', 'a different ticket scope must start its own seq at 1');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testFleetFallback() {
  const tmp = tmpRepo();
  try {
    const noScope = appendDecision(tmp, undefined, { decision: 'fleet-wide' });
    assert.strictEqual(noScope.id, `ADR-1-${FLEET_SCOPE}`);
    assert.strictEqual(noScope.scope, FLEET_SCOPE);

    appendDecision(tmp, 'QUO-281', { decision: 'ticket-scoped' });
    const secondFleet = appendDecision(tmp, null, { decision: 'fleet-wide again' });
    assert.strictEqual(secondFleet.id, `ADR-2-${FLEET_SCOPE}`, 'FLEET scope must not share a counter with ticket scopes');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testFalsyScopeNotFolded() {
  const tmp = tmpRepo();
  try {
    const zeroScope = appendDecision(tmp, 0, { decision: 'numeric scope' });
    assert.strictEqual(zeroScope.scope, 0, 'scope 0 must be kept as-is, not folded into FLEET');
    assert.strictEqual(zeroScope.id, 'ADR-1-0');

    const emptyStringScope = appendDecision(tmp, '', { decision: 'empty string scope' });
    assert.strictEqual(emptyStringScope.scope, '', 'scope \'\' must be kept as-is, not folded into FLEET');
    assert.strictEqual(emptyStringScope.id, 'ADR-1-');

    const fleetScope = appendDecision(tmp, undefined, { decision: 'actually fleet' });
    assert.strictEqual(fleetScope.id, `ADR-1-${FLEET_SCOPE}`, 'FLEET must still get its own independent counter');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testTimestampPresent() {
  const tmp = tmpRepo();
  try {
    const before = Date.now();
    const record = appendDecision(tmp, 'QUO-281', { decision: 'x' });
    const after = Date.now();
    assert.strictEqual(typeof record.timestamp, 'string');
    const ts = Date.parse(record.timestamp);
    assert.ok(!Number.isNaN(ts), `timestamp must be parseable, got ${record.timestamp}`);
    assert.ok(ts >= before && ts <= after, 'timestamp must reflect the actual append time');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testOneJsonLinePerCall() {
  const tmp = tmpRepo();
  try {
    for (let i = 0; i < 5; i++) appendDecision(tmp, 'QUO-281', { decision: `d${i}` });
    const raw = fs.readFileSync(decisionLogPath(tmp), 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim());
    assert.strictEqual(lines.length, 5);
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testAppendPreservesExisting() {
  const tmp = tmpRepo();
  try {
    const first = appendDecision(tmp, 'QUO-281', { decision: 'first' });
    appendDecision(tmp, 'QUO-281', { decision: 'second' });
    const entries = readEntries(tmp);
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].id, first.id, 'the first entry must survive a later append untouched');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testMissingFileBootstraps() {
  const tmp = tmpRepo();
  try {
    assert.strictEqual(fs.existsSync(path.join(tmp, '.muaddib')), false, 'precondition: no .muaddib/ dir yet');
    const record = appendDecision(tmp, 'QUO-281', { decision: 'first ever' });
    assert.strictEqual(record.id, 'ADR-1-QUO-281');
    assert.strictEqual(fs.existsSync(decisionLogPath(tmp)), true);
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testMalformedLineSkipped() {
  const tmp = tmpRepo();
  try {
    fs.mkdirSync(path.join(tmp, '.muaddib'), { recursive: true });
    fs.writeFileSync(
      decisionLogPath(tmp),
      '{"id":"ADR-1-QUO-281","scope":"QUO-281"}\n{ not valid json\n',
    );
    const id = nextId(tmp, 'QUO-281');
    assert.strictEqual(id, 'ADR-2-QUO-281', 'a malformed line must not break seq computation');
    const entries = readEntries(tmp);
    assert.strictEqual(entries.length, 1, 'a malformed line must be skipped, not returned');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testFieldsCannotOverrideComputedKeys() {
  const tmp = tmpRepo();
  try {
    const record = appendDecision(tmp, 'QUO-281', {
      decision: 'x',
      id: 'FORGED-ID',
      scope: 'FORGED-SCOPE',
      timestamp: 'FORGED-TIME',
    });
    assert.strictEqual(record.id, 'ADR-1-QUO-281');
    assert.strictEqual(record.scope, 'QUO-281');
    assert.notStrictEqual(record.timestamp, 'FORGED-TIME');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testReadEntriesReturnsAll() {
  const tmp = tmpRepo();
  try {
    appendDecision(tmp, 'QUO-281', { decision: 'a' });
    appendDecision(tmp, 'QUO-999', { decision: 'b' });
    appendDecision(tmp, undefined, { decision: 'c' });
    const entries = readEntries(tmp);
    assert.strictEqual(entries.length, 3);
    assert.deepStrictEqual(entries.map((e) => e.decision), ['a', 'b', 'c']);
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testConcurrentAppendsNoCollision() {
  const tmp = tmpRepo();
  const decisionLogLib = path.join(__dirname, '../decision-log');
  function spawnAppender(label, count) {
    return spawn(process.execPath, ['-e', `
      const { appendDecision } = require(${JSON.stringify(decisionLogLib)});
      for (let i = 0; i < ${count}; i++) appendDecision(${JSON.stringify(tmp)}, 'QUO-281', { decision: ${JSON.stringify(label)} + i });
    `], { stdio: 'inherit' });
  }
  try {
    const p1 = spawnAppender('p1-', 10);
    const p2 = spawnAppender('p2-', 10);
    await Promise.all([
      new Promise((r) => p1.on('exit', r)),
      new Promise((r) => p2.on('exit', r)),
    ]);

    const entries = readEntries(tmp);
    assert.strictEqual(entries.length, 20, 'no lines dropped or corrupted under concurrent appends');
    const seqs = entries.map((e) => Number(e.id.match(/^ADR-(\d+)-QUO-281$/)[1]));
    const unique = new Set(seqs);
    assert.strictEqual(unique.size, 20, `seq numbers must be unique, got duplicates: ${seqs.sort((a, b) => a - b).join(',')}`);
    assert.strictEqual(Math.max(...seqs), 20, 'seq numbers must be sequential 1..20 with no gaps');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testGetByIdReturnsRecord() {
  const tmp = tmpRepo();
  try {
    appendDecision(tmp, 'QUO-281', { decision: 'first' });
    const second = appendDecision(tmp, 'QUO-281', { decision: 'use JSONL' });
    const found = getById(tmp, second.id);
    assert.ok(found, 'a known id must resolve to a record');
    assert.strictEqual(found.id, second.id);
    assert.strictEqual(found.decision, 'use JSONL', 'the full record content must come back, not just the id');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testGetByIdMissingReturnsNull() {
  const tmp = tmpRepo();
  try {
    appendDecision(tmp, 'QUO-281', { decision: 'x' });
    assert.strictEqual(getById(tmp, 'ADR-999-NOPE'), null, 'an unknown id must resolve to null');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testGetByIdMissingFile() {
  const tmp = tmpRepo();
  try {
    assert.strictEqual(fs.existsSync(decisionLogPath(tmp)), false, 'precondition: no log file yet');
    assert.strictEqual(getById(tmp, 'ADR-1-QUO-281'), null, 'getById on a never-written log must return null, not throw');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testGetByIdReturnsFirstMatch() {
  const tmp = tmpRepo();
  try {
    // Two branches can merge entries that happen to share a computed id; a
    // by-id lookup should short-circuit on the first, not scan to the last.
    fs.mkdirSync(path.join(tmp, '.muaddib'), { recursive: true });
    fs.writeFileSync(
      decisionLogPath(tmp),
      '{"id":"ADR-1-QUO-281","scope":"QUO-281","decision":"earlier"}\n' +
        '{"id":"ADR-1-QUO-281","scope":"QUO-281","decision":"later"}\n',
    );
    assert.strictEqual(getById(tmp, 'ADR-1-QUO-281').decision, 'earlier', 'getById must return the first match, not the last');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testGetByIdSkipsMalformed() {
  const tmp = tmpRepo();
  try {
    fs.mkdirSync(path.join(tmp, '.muaddib'), { recursive: true });
    fs.writeFileSync(
      decisionLogPath(tmp),
      '{ not valid json\n{"id":"ADR-2-QUO-281","scope":"QUO-281","decision":"good"}\n',
    );
    const found = getById(tmp, 'ADR-2-QUO-281');
    assert.ok(found, 'a malformed earlier line must not hide a later valid match');
    assert.strictEqual(found.decision, 'good');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testSearchCaseInsensitive() {
  const tmp = tmpRepo();
  try {
    appendDecision(tmp, 'QUO-281', { decision: 'We chose JSONL for the log' });
    const hits = search(tmp, 'jsonl');
    assert.strictEqual(hits.length, 1, 'a differently-cased query must still match');
    assert.strictEqual(hits[0].id, 'ADR-1-QUO-281');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testSearchMatchesContentField() {
  const tmp = tmpRepo();
  try {
    appendDecision(tmp, 'QUO-281', { decision: 'a', rationale: 'because the log must stay citable' });
    const hits = search(tmp, 'citable');
    assert.strictEqual(hits.length, 1, 'search must match on any content field, not just one');
    assert.ok(hits[0].snippet.startsWith('rationale:'), 'the snippet must name the field that matched');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testSearchSnippetNotFullRecord() {
  const tmp = tmpRepo();
  try {
    const bigTail = 'z'.repeat(500);
    appendDecision(tmp, 'QUO-281', { decision: `needle appears here then ${bigTail}`, other: 'secret-other-field' });
    const hits = search(tmp, 'needle');
    assert.strictEqual(hits.length, 1);
    const hit = hits[0];
    assert.deepStrictEqual(
      Object.keys(hit).sort(),
      ['id', 'scope', 'snippet', 'timestamp'],
      'a hit must be lightweight — only id/scope/timestamp/snippet, never the full record',
    );
    assert.ok(hit.snippet.includes('needle'), 'the snippet must include the match');
    assert.ok(hit.snippet.length < 200, `the snippet must be bounded, got ${hit.snippet.length} chars`);
    assert.ok(!hit.snippet.includes('secret-other-field'), 'the snippet must not leak other fields');
    assert.ok(hit.snippet.endsWith('…'), 'a truncated tail must be ellipsized');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testSearchScopeFilter() {
  const tmp = tmpRepo();
  try {
    appendDecision(tmp, 'QUO-281', { decision: 'shared word appears' });
    appendDecision(tmp, 'QUO-999', { decision: 'shared word appears' });
    const all = search(tmp, 'shared');
    assert.strictEqual(all.length, 2, 'without a scope filter, both scopes match');
    const scoped = search(tmp, 'shared', { scope: 'QUO-999' });
    assert.strictEqual(scoped.length, 1, 'opts.scope must restrict to that scope');
    assert.strictEqual(scoped[0].scope, 'QUO-999');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testSearchLimit() {
  const tmp = tmpRepo();
  try {
    for (let i = 0; i < 5; i++) appendDecision(tmp, 'QUO-281', { decision: 'common term here' });
    const capped = search(tmp, 'common', { limit: 2 });
    assert.strictEqual(capped.length, 2, 'opts.limit must cap the number of hits');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testSearchNoMatch() {
  const tmp = tmpRepo();
  try {
    appendDecision(tmp, 'QUO-281', { decision: 'nothing relevant here' });
    assert.deepStrictEqual(search(tmp, 'absent-term'), [], 'a query matching nothing must return []');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testSearchMissingFile() {
  const tmp = tmpRepo();
  try {
    assert.strictEqual(fs.existsSync(decisionLogPath(tmp)), false, 'precondition: no log file yet');
    assert.deepStrictEqual(search(tmp, 'anything'), [], 'search on a never-written log must return [], not throw');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testSearchIgnoresComputedKeys() {
  const tmp = tmpRepo();
  try {
    const rec = appendDecision(tmp, 'QUO-281', { decision: 'plain content' });
    // The id/scope/timestamp are real substrings of the record, but they're
    // filtered on explicitly, not via free text — a query for them must miss.
    assert.deepStrictEqual(search(tmp, rec.id), [], 'free text must not match the computed id');
    assert.deepStrictEqual(search(tmp, 'QUO-281'), [], 'free text must not match the computed scope');
    assert.deepStrictEqual(search(tmp, rec.timestamp), [], 'free text must not match the computed timestamp');
    // ...but real content still matches, proving the record itself is searchable.
    assert.strictEqual(search(tmp, 'plain content').length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

(async () => {
  await run('first decision for a scope gets seq=1', testFirstDecisionSeqOne);
  await run('seq increments per scope', testSeqIncrementsPerScope);
  await run('different ticket scopes have independent seq counters', testScopesIndependent);
  await run('omitted scope falls back to FLEET, independently scoped', testFleetFallback);
  await run('falsy-but-meaningful scope (0, \'\') is kept as-is, not folded into FLEET', testFalsyScopeNotFolded);
  await run('every record carries an explicit, accurate timestamp', testTimestampPresent);
  await run('each append writes exactly one valid JSON line', testOneJsonLinePerCall);
  await run('appending preserves prior entries untouched', testAppendPreservesExisting);
  await run('first append bootstraps .muaddib/ and the log file', testMissingFileBootstraps);
  await run('a malformed existing line does not break seq computation or reads', testMalformedLineSkipped);
  await run('caller-supplied id/scope/timestamp cannot override the computed ones', testFieldsCannotOverrideComputedKeys);
  await run('readEntries returns every appended record, in order', testReadEntriesReturnsAll);
  await run('concurrent appends to the same scope never collide or corrupt', testConcurrentAppendsNoCollision);
  await run('getById returns the full record for a known id', testGetByIdReturnsRecord);
  await run('getById returns null for an unknown id', testGetByIdMissingReturnsNull);
  await run('getById on a never-written log returns null, not throws', testGetByIdMissingFile);
  await run('getById returns the first match for a duplicated id', testGetByIdReturnsFirstMatch);
  await run('getById skips a malformed line to find a later valid match', testGetByIdSkipsMalformed);
  await run('search matches case-insensitively', testSearchCaseInsensitive);
  await run('search matches on any content field, naming it in the snippet', testSearchMatchesContentField);
  await run('a search hit is a bounded snippet, never the full record', testSearchSnippetNotFullRecord);
  await run('search opts.scope restricts hits to one scope', testSearchScopeFilter);
  await run('search opts.limit caps the number of hits', testSearchLimit);
  await run('search returns [] when nothing matches', testSearchNoMatch);
  await run('search on a never-written log returns [], not throws', testSearchMissingFile);
  await run('search free text never matches computed id/scope/timestamp', testSearchIgnoresComputedKeys);

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exit(1);
})();
