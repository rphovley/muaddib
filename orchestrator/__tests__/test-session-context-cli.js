#!/usr/bin/env node
'use strict';
// session-context-cli.js test suite. No container or network.
//
// Drives run() in-process against a temp session store (MUADDIB_ACCOUNT_DIR
// pointed at a temp dir), asserting each subcommand prints the right thing and
// exits with the right code. A final subprocess case exercises the real module
// entry point end-to-end via REPO_DIR.
//
// testSetGet         — `set` then `get` round-trips a value
// testGetMissing     — `get <unset>` prints nothing, exit 0
// testGetNoArgUsage  — `get` with no key prints usage, exit 1
// testGetAll         — `get-all` prints the whole bag as JSON
// testUnset          — `unset` removes one key, leaves others
// testBeginWipes     — `begin` clears a stale file
// testClearRemoves   — `clear` empties the store
// testUnknownCmd     — an unknown subcommand prints usage, exit 1
// testEntryPoint     — the real CLI resolves REPO_DIR and runs set/get end-to-end

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ACCOUNT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cli-'));
process.env.MUADDIB_ACCOUNT_DIR = ACCOUNT_DIR;

const { run } = require('../session-context-cli');
const CLI = path.join(__dirname, '../session-context-cli.js');
const SESSION_FILE = path.join(ACCOUNT_DIR, 'session', 'session.json');
const REPO = ACCOUNT_DIR; // irrelevant once MUADDIB_ACCOUNT_DIR wins

let pass = 0;
let fail = 0;

async function runTest(name, fn) {
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

// Captures writes so we can assert on what a subcommand printed.
function capture() {
  let buf = '';
  return { write: (s) => { buf += s; }, get text() { return buf; } };
}

function cli(argv, streams = {}) {
  const stdout = streams.stdout || capture();
  const stderr = streams.stderr || capture();
  const code = run({ argv, repoDir: REPO, stdout, stderr });
  return { code, stdout, stderr };
}

async function testSetGet() {
  assert.strictEqual(cli(['set', 'mykey', 'myvalue']).code, 0);
  const { code, stdout } = cli(['get', 'mykey']);
  assert.strictEqual(code, 0);
  assert.strictEqual(stdout.text, 'myvalue');
}

async function testGetMissing() {
  const { code, stdout } = cli(['get', 'nope']);
  assert.strictEqual(code, 0, 'a missing key is not an error');
  assert.strictEqual(stdout.text, '', 'a missing key must print nothing');
}

async function testGetNoArgUsage() {
  const { code, stderr } = cli(['get']);
  assert.strictEqual(code, 1);
  assert.ok(stderr.text.includes('usage:'), 'missing key must print usage');
}

async function testGetAll() {
  cli(['set', 'a', '1']);
  cli(['set', 'b', '2']);
  const { code, stdout } = cli(['get-all']);
  assert.strictEqual(code, 0);
  const obj = JSON.parse(stdout.text);
  assert.strictEqual(obj.a, '1');
  assert.strictEqual(obj.b, '2');
}

async function testUnset() {
  cli(['set', 'keep', 'yes']);
  cli(['set', 'drop', 'no']);
  assert.strictEqual(cli(['unset', 'drop']).code, 0);
  assert.strictEqual(cli(['get', 'drop']).stdout.text, '', 'unset should remove the key');
  assert.strictEqual(cli(['get', 'keep']).stdout.text, 'yes', 'unset touched another key');
}

async function testBeginWipes() {
  cli(['set', 'stale', 'x']);
  assert.strictEqual(cli(['begin']).code, 0);
  assert.strictEqual(cli(['get', 'stale']).stdout.text, '', 'begin should wipe stale state');
}

async function testClearRemoves() {
  cli(['set', 'x', 'y']);
  assert.ok(fs.existsSync(SESSION_FILE));
  assert.strictEqual(cli(['clear']).code, 0);
  assert.ok(!fs.existsSync(SESSION_FILE), 'clear should remove the file');
}

async function testUnknownCmd() {
  const { code, stderr } = cli(['frobnicate']);
  assert.strictEqual(code, 1);
  assert.ok(stderr.text.includes('usage:'), 'unknown subcommand must print usage');
}

async function testEntryPoint() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cli-e2e-'));
  const acct = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cli-e2e-acct-'));
  const env = { ...process.env, REPO_DIR: repo, MUADDIB_ACCOUNT_DIR: acct };
  try {
    const setRes = spawnSync(process.execPath, [CLI, 'set', 'e2e', 'ok'], { env, encoding: 'utf8' });
    assert.strictEqual(setRes.status, 0, `set exit: ${setRes.status} ${setRes.stderr}`);
    const getRes = spawnSync(process.execPath, [CLI, 'get', 'e2e'], { env, encoding: 'utf8' });
    assert.strictEqual(getRes.status, 0, `get exit: ${getRes.status} ${getRes.stderr}`);
    assert.strictEqual(getRes.stdout, 'ok');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(acct, { recursive: true, force: true });
  }
}

(async () => {
  await runTest('set then get round-trips a value', testSetGet);
  await runTest('get on an unset key prints nothing, exit 0', testGetMissing);
  await runTest('get with no key prints usage, exit 1', testGetNoArgUsage);
  await runTest('get-all prints the whole bag as JSON', testGetAll);
  await runTest('unset removes one key, leaves others', testUnset);
  await runTest('begin wipes a stale file', testBeginWipes);
  await runTest('clear empties the store', testClearRemoves);
  await runTest('an unknown subcommand prints usage, exit 1', testUnknownCmd);
  await runTest('the real CLI entry point resolves REPO_DIR end-to-end', testEntryPoint);

  fs.rmSync(ACCOUNT_DIR, { recursive: true, force: true });
  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exit(1);
})();
