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

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { appendDecision, nextId, readEntries, decisionLogPath, FLEET_SCOPE } = require('../decision-log');

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

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exit(1);
})();
