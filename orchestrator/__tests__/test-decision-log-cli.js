#!/usr/bin/env node
'use strict';
// decision-log-cli.js test suite. No container or network.
//
// Drives run() in-process against a real temp log (seeded via appendDecision),
// asserting each subcommand prints the right thing and exits with the right
// code, plus parseSearchArgs flag handling. A final subprocess case exercises
// the real module entry point end-to-end via REPO_DIR.
//
// testGetPrintsRecord       — `get <id>` prints the JSON record, exit 0
// testGetMissingExitsNonZero— `get <unknown>` prints nothing, errors non-zero
// testGetNoArgUsage         — `get` with no id prints usage, exit 1
// testSearchPrintsHits      — `search <q>` prints the hits array as JSON, exit 0
// testSearchNoMatchEmptyArr — `search <q>` with no match prints [], exit 0
// testSearchScopeFlag       — `search <q> --scope S` restricts to that scope
// testSearchLimitFlag       — `search <q> --limit N` caps the hits
// testSearchBadLimit        — a non-integer --limit errors non-zero
// testUnknownCmdUsage       — an unknown subcommand prints usage, exit 1
// testEntryPointSubprocess  — the real CLI resolves REPO_DIR and runs get end-to-end

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { appendDecision } = require('../decision-log');
const { run, parseSearchArgs } = require('../decision-log-cli');

const CLI = path.join(__dirname, '../decision-log-cli.js');

let pass = 0;
let fail = 0;

async function runTest(name, fn) {
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'decision-log-cli-'));
}

// Captures writes so we can assert on what a subcommand printed.
function capture() {
  let buf = '';
  return { write: (s) => { buf += s; }, get text() { return buf; } };
}

async function testGetPrintsRecord() {
  const tmp = tmpRepo();
  try {
    const rec = appendDecision(tmp, 'QUO-281', { decision: 'use JSONL' });
    const stdout = capture();
    const code = run({ argv: ['get', rec.id], repoDir: tmp, stdout });
    assert.strictEqual(code, 0);
    const printed = JSON.parse(stdout.text);
    assert.strictEqual(printed.id, rec.id);
    assert.strictEqual(printed.decision, 'use JSONL');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testGetMissingExitsNonZero() {
  const tmp = tmpRepo();
  try {
    appendDecision(tmp, 'QUO-281', { decision: 'x' });
    const stdout = capture();
    const stderr = capture();
    const code = run({ argv: ['get', 'ADR-999-NOPE'], repoDir: tmp, stdout, stderr });
    assert.strictEqual(code, 1);
    assert.strictEqual(stdout.text, '', 'a missing id must print nothing to stdout');
    assert.ok(stderr.text.includes('no record found'), 'expected not-found message on stderr');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testGetNoArgUsage() {
  const tmp = tmpRepo();
  try {
    const stderr = capture();
    const code = run({ argv: ['get'], repoDir: tmp, stderr });
    assert.strictEqual(code, 1);
    assert.ok(stderr.text.includes('usage:'), 'missing id must print usage');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testSearchPrintsHits() {
  const tmp = tmpRepo();
  try {
    appendDecision(tmp, 'QUO-281', { decision: 'we chose JSONL' });
    const stdout = capture();
    const code = run({ argv: ['search', 'jsonl'], repoDir: tmp, stdout });
    assert.strictEqual(code, 0);
    const hits = JSON.parse(stdout.text);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].id, 'ADR-1-QUO-281');
    assert.ok(hits[0].snippet.startsWith('decision:'));
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testSearchNoMatchEmptyArr() {
  const tmp = tmpRepo();
  try {
    appendDecision(tmp, 'QUO-281', { decision: 'irrelevant' });
    const stdout = capture();
    const code = run({ argv: ['search', 'absent-term'], repoDir: tmp, stdout });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(JSON.parse(stdout.text), []);
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testSearchScopeFlag() {
  const tmp = tmpRepo();
  try {
    appendDecision(tmp, 'QUO-281', { decision: 'shared word' });
    appendDecision(tmp, 'QUO-999', { decision: 'shared word' });
    const stdout = capture();
    const code = run({ argv: ['search', 'shared', '--scope', 'QUO-999'], repoDir: tmp, stdout });
    assert.strictEqual(code, 0);
    const hits = JSON.parse(stdout.text);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].scope, 'QUO-999');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testSearchLimitFlag() {
  const tmp = tmpRepo();
  try {
    for (let i = 0; i < 5; i++) appendDecision(tmp, 'QUO-281', { decision: 'common term' });
    const stdout = capture();
    const code = run({ argv: ['search', 'common', '--limit', '2'], repoDir: tmp, stdout });
    assert.strictEqual(code, 0);
    assert.strictEqual(JSON.parse(stdout.text).length, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testSearchBadLimit() {
  // parseSearchArgs throws on a bad --limit; run() lets it propagate (the entry
  // point turns it into a non-zero exit + stderr).
  assert.throws(() => run({ argv: ['search', 'q', '--limit', 'abc'], repoDir: '/nonexistent' }), /--limit must be a positive integer/);
}

async function testUnknownCmdUsage() {
  const stderr = capture();
  const code = run({ argv: ['frobnicate'], repoDir: '/nonexistent', stderr });
  assert.strictEqual(code, 1);
  assert.ok(stderr.text.includes('usage:'), 'unknown subcommand must print usage');
}

async function testParseSearchArgs() {
  const { positionals, opts } = parseSearchArgs(['my query', '--scope', 'QUO-1', '--limit', '3']);
  assert.deepStrictEqual(positionals, ['my query']);
  assert.deepStrictEqual(opts, { scope: 'QUO-1', limit: 3 });
}

async function testEntryPointSubprocess() {
  const tmp = tmpRepo();
  try {
    const rec = appendDecision(tmp, 'QUO-281', { decision: 'end to end' });
    const res = spawnSync(process.execPath, [CLI, 'get', rec.id], {
      env: { ...process.env, REPO_DIR: tmp },
      encoding: 'utf8',
    });
    assert.strictEqual(res.status, 0, `expected exit 0, got ${res.status}: ${res.stderr}`);
    assert.strictEqual(JSON.parse(res.stdout).decision, 'end to end');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

(async () => {
  await runTest('get prints the JSON record for a known id', testGetPrintsRecord);
  await runTest('get errors non-zero for an unknown id', testGetMissingExitsNonZero);
  await runTest('get with no id prints usage and exits 1', testGetNoArgUsage);
  await runTest('search prints the hits array as JSON', testSearchPrintsHits);
  await runTest('search with no match prints an empty array', testSearchNoMatchEmptyArr);
  await runTest('search --scope restricts to that scope', testSearchScopeFlag);
  await runTest('search --limit caps the number of hits', testSearchLimitFlag);
  await runTest('search --limit rejects a non-integer', testSearchBadLimit);
  await runTest('an unknown subcommand prints usage and exits 1', testUnknownCmdUsage);
  await runTest('parseSearchArgs splits positionals from --scope/--limit', testParseSearchArgs);
  await runTest('the real CLI entry point resolves REPO_DIR end-to-end', testEntryPointSubprocess);

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exit(1);
})();
