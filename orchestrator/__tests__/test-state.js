#!/usr/bin/env node
'use strict';
// State module test suite. No container or tmux needed.
//
// testGetSetMerge       — basic read/write/merge operations
// testMissingKey        — get on unset key returns undefined
// testAtomicConcurrent  — two processes writing different keys simultaneously
//                         both values present after writes complete
// testStateCli          — CLI: set, get, get-all

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'state-test-'));
process.env.STATE_DIR = TMP_DIR;
process.env.AGENT_STATUS_DIR = TMP_DIR;

const { get, set, merge, read, statePath } = require('../state');
const STATE_CLI = path.join(__dirname, '../state-cli.js');

const BASE = 980;

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function testGetSetMerge() {
  const W = BASE + 1;
  try { fs.unlinkSync(statePath(W)); } catch (_) {}

  set(W, 'foo', 'bar');
  if (get(W, 'foo') !== 'bar') throw new Error(`expected bar, got ${get(W, 'foo')}`);

  set(W, 'num', 42);
  if (get(W, 'num') !== 42) throw new Error(`expected 42, got ${get(W, 'num')}`);

  merge(W, { a: '1', b: '2' });
  const s = read(W);
  if (s.foo !== 'bar') throw new Error('merge stomped foo');
  if (s.a !== '1')     throw new Error('merge missing a');
  if (s.b !== '2')     throw new Error('merge missing b');

  // Overwrite existing key
  set(W, 'foo', 'baz');
  if (get(W, 'foo') !== 'baz') throw new Error(`expected baz after overwrite, got ${get(W, 'foo')}`);
}

async function testMissingKey() {
  const W = BASE + 2;
  try { fs.unlinkSync(statePath(W)); } catch (_) {}

  const v = get(W, 'nonexistent');
  if (v !== undefined) throw new Error(`expected undefined, got ${v}`);

  // read on missing file returns empty object
  const s = read(W);
  if (typeof s !== 'object' || s === null) throw new Error('read should return {}');
  if (Object.keys(s).length !== 0) throw new Error('expected empty object');
}

async function testAtomicConcurrent() {
  const W = BASE + 3;
  try { fs.unlinkSync(statePath(W)); } catch (_) {}

  // Two parallel processes each set a different key 10 times.
  // Both values must survive with no partial-write corruption.
  const stateLib = path.join(__dirname, '../state.js');
  function spawnWriter(key, val) {
    return spawn(process.execPath, ['-e', `
      const { set } = require(${JSON.stringify(stateLib)});
      for (let i = 0; i < 10; i++) set(${W}, ${JSON.stringify(key)}, ${JSON.stringify(val)});
    `], { stdio: 'inherit', env: process.env });
  }

  const p1 = spawnWriter('alpha', 'AAA');
  const p2 = spawnWriter('beta',  'BBB');
  await Promise.all([
    new Promise((r) => p1.on('exit', r)),
    new Promise((r) => p2.on('exit', r)),
  ]);

  const s = read(W);
  if (s.alpha !== 'AAA') throw new Error(`alpha corrupted: ${s.alpha}`);
  if (s.beta  !== 'BBB') throw new Error(`beta corrupted:  ${s.beta}`);
}

async function testStateCli() {
  const W = BASE + 4;
  try { fs.unlinkSync(statePath(W)); } catch (_) {}

  function cli(...args) {
    return spawnSync(process.execPath, [STATE_CLI, String(W), ...args], {
      encoding: 'utf8', env: process.env,
    });
  }

  // set + get
  cli('set', 'mykey', 'myvalue');
  const r = cli('get', 'mykey');
  if (r.stdout !== 'myvalue') throw new Error(`expected myvalue, got ${JSON.stringify(r.stdout)}`);

  // get missing key → empty stdout, exit 0
  const r2 = cli('get', 'no_such_key');
  if (r2.status !== 0) throw new Error(`expected exit 0, got ${r2.status}`);
  if (r2.stdout !== '') throw new Error(`expected empty stdout for missing key, got ${JSON.stringify(r2.stdout)}`);

  // get-all returns valid JSON
  cli('set', 'other', '123');
  const r3 = cli('get-all');
  const obj = JSON.parse(r3.stdout);
  if (obj.mykey !== 'myvalue') throw new Error('get-all missing mykey');
  if (obj.other !== '123')     throw new Error('get-all missing other');

  // unknown command → exit 1
  const r4 = cli('unknown');
  if (r4.status !== 1) throw new Error(`expected exit 1, got ${r4.status}`);
}

// ─── runner ──────────────────────────────────────────────────────────────────

async function main() {
  const tests = [
    ['get/set/merge basic operations', testGetSetMerge],
    ['missing key returns undefined', testMissingKey],
    ['atomic concurrent writes — two processes, both values survive', testAtomicConcurrent],
    ['state-cli.js — set, get, get-all, unknown command', testStateCli],
  ];

  let passed = 0;
  for (const [name, fn] of tests) {
    process.stdout.write(`  ${name}... `);
    try {
      await fn();
      process.stdout.write('PASS\n');
      passed++;
    } catch (err) {
      process.stdout.write(`FAIL\n    ${err.message}\n`);
    }
  }

  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log(`\n${passed}/${tests.length} passed`);
  if (passed < tests.length) process.exit(1);
}

main().catch((err) => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.error('FAIL —', err.message);
  process.exit(1);
});
