#!/usr/bin/env node
'use strict';
// Session Context module test suite. No container or tmux needed.
//
// Isolation: MUADDIB_ACCOUNT_DIR points at a temp dir, so resolveAccountDir
// returns it directly and the session file lands under <tmp>/session/ — never
// touching a real ~/.muaddib/<project>/ or the repo tree.
//
// testGetSetMerge   — set/get/merge/unset round trips over the opaque bag
// testMissingReads  — get/read on an absent file return undefined / {}
// testPathLocation  — the file lands at <accountDir>/session/session.json
// testBeginWipes    — begin() clears a stale file from a prior run
// testClearRemoves  — clear()/discard() delete the file; missing file is a no-op
// testAccountOverride— MUADDIB_ACCOUNT_DIR is honored over the manifest

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ACCOUNT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'session-ctx-'));
process.env.MUADDIB_ACCOUNT_DIR = ACCOUNT_DIR;

const sc = require('../session-context');

// repoDir is irrelevant once MUADDIB_ACCOUNT_DIR is set (it wins in
// resolveAccountDir), but pass a real-ish path so nothing reads the repo tree.
const REPO = ACCOUNT_DIR;
const SESSION_FILE = path.join(ACCOUNT_DIR, 'session', 'session.json');

let pass = 0;
let fail = 0;

async function runTest(name, fn) {
  // Start each test from a clean slate.
  try { fs.rmSync(SESSION_FILE, { force: true }); } catch (_) {}
  try {
    await fn();
    process.stdout.write(`  ${name}... PASS\n`);
    pass++;
  } catch (err) {
    process.stdout.write(`  ${name}... FAIL: ${err.message}\n`);
    fail++;
  }
}

async function testGetSetMerge() {
  sc.set(REPO, 'foo', 'bar');
  assert.strictEqual(sc.get(REPO, 'foo'), 'bar');

  sc.set(REPO, 'num', 42);
  assert.strictEqual(sc.get(REPO, 'num'), 42);

  sc.merge(REPO, { a: '1', b: '2' });
  const s = sc.read(REPO);
  assert.strictEqual(s.foo, 'bar', 'merge stomped foo');
  assert.strictEqual(s.a, '1');
  assert.strictEqual(s.b, '2');

  sc.set(REPO, 'foo', 'baz');
  assert.strictEqual(sc.get(REPO, 'foo'), 'baz', 'overwrite failed');

  sc.unset(REPO, 'foo');
  assert.strictEqual(sc.get(REPO, 'foo'), undefined, 'unset left the key');
  assert.strictEqual(sc.get(REPO, 'a'), '1', 'unset touched another key');
}

async function testMissingReads() {
  assert.strictEqual(sc.get(REPO, 'nope'), undefined);
  const s = sc.read(REPO);
  assert.ok(s && typeof s === 'object', 'read should return an object');
  assert.strictEqual(Object.keys(s).length, 0, 'missing file should read as {}');
}

async function testPathLocation() {
  assert.strictEqual(sc.sessionPath(REPO), SESSION_FILE);
  sc.set(REPO, 'k', 'v');
  assert.ok(fs.existsSync(SESSION_FILE), 'file did not land under <accountDir>/session/');
  assert.ok(
    sc.sessionPath(REPO).startsWith(path.join(ACCOUNT_DIR, 'session') + path.sep),
    'session file must live under the session/ subdir',
  );
}

async function testBeginWipes() {
  sc.set(REPO, 'stale', 'from a crashed run');
  assert.strictEqual(sc.get(REPO, 'stale'), 'from a crashed run');
  sc.begin(REPO);
  assert.strictEqual(sc.get(REPO, 'stale'), undefined, 'begin() did not wipe stale state');
  assert.ok(!fs.existsSync(SESSION_FILE), 'begin() should remove the session file');
  // begin() on an already-clean session is a no-op, not an error.
  sc.begin(REPO);
}

async function testClearRemoves() {
  sc.set(REPO, 'x', 'y');
  assert.ok(fs.existsSync(SESSION_FILE));
  sc.clear(REPO);
  assert.ok(!fs.existsSync(SESSION_FILE), 'clear() should remove the file');
  // discard is an alias for clear; on a missing file it must be a no-op.
  sc.discard(REPO);
  assert.strictEqual(sc.discard, sc.clear, 'discard must alias clear');
}

async function testAccountOverride() {
  // With MUADDIB_ACCOUNT_DIR set, the path resolves under it regardless of the
  // repoDir argument — proving the env override wins.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'session-ctx-repo-'));
  try {
    assert.strictEqual(
      sc.sessionPath(other),
      SESSION_FILE,
      'MUADDIB_ACCOUNT_DIR should override the repoDir-derived path',
    );
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
  }
}

(async () => {
  await runTest('set/get/merge/unset round trips over the opaque bag', testGetSetMerge);
  await runTest('get/read on a missing file return undefined / {}', testMissingReads);
  await runTest('the file lands at <accountDir>/session/session.json', testPathLocation);
  await runTest('begin() wipes a stale file from a crashed prior run', testBeginWipes);
  await runTest('clear()/discard() remove the file; missing is a no-op', testClearRemoves);
  await runTest('MUADDIB_ACCOUNT_DIR is honored over the repoDir path', testAccountOverride);

  fs.rmSync(ACCOUNT_DIR, { recursive: true, force: true });
  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exit(1);
})();
