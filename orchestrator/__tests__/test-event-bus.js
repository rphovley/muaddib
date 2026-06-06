#!/usr/bin/env node
'use strict';
// Event bus test suite. No container or tmux needed.
//
// testConcurrentWrites    — two background processes emit 5 events each;
//                           subscriber receives all 10 with correct fields.
// testReplayOnSubscribe   — events written BEFORE subscribe() is called are
//                           still delivered (polling reads from file offset 0).
// testWriteOrderPreserved — a single emitter writes events with sequential
//                           sequence numbers; subscriber receives them in order.
// testEmitCli             — exit-code form maps 0→done / N→failed; custom-event
//                           form passes the event name and JSON payload through.

const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evt-test-'));
process.env.AGENT_STATUS_DIR = TMP_DIR;

const { emit, subscribe, eventsFile } = require('../events');
const eventsLib = path.join(__dirname, '../events.js');
const emitCli   = path.join(__dirname, '../emit-cli.js');

// Each test uses a distinct worker index so their event files don't overlap.
const BASE = 990;

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

function collect(worker, count, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const events = [];
    const sub = subscribe(worker, (ev) => {
      events.push(ev);
      if (events.length === count) { sub.kill(); resolve(events); }
    });
    setTimeout(() => { sub.kill(); reject(new Error(`collected ${events.length}/${count} events within ${timeoutMs}ms`)); }, timeoutMs);
  });
}

function spawnEmitter(worker, job, count) {
  return spawn(process.execPath, ['-e', `
    const { emit } = require(${JSON.stringify(eventsLib)});
    for (let i = 0; i < ${count}; i++) emit(${worker}, ${JSON.stringify(job)}, 'test', { i });
  `], { stdio: 'inherit', env: process.env });
}

async function testConcurrentWrites() {
  const WORKER = BASE + 1;
  try { fs.unlinkSync(eventsFile(WORKER)); } catch (_) {}

  const resultP = collect(WORKER, 10);
  const p1 = spawnEmitter(WORKER, 'emitter-a', 5);
  const p2 = spawnEmitter(WORKER, 'emitter-b', 5);
  const events = await resultP;

  await Promise.all([
    new Promise((r) => p1.on('exit', r)),
    new Promise((r) => p2.on('exit', r)),
  ]);

  const errs = [];
  for (const [i, ev] of events.entries()) {
    if (typeof ev.ts !== 'string')    errs.push(`[${i}] missing ts`);
    if (ev.worker !== WORKER)         errs.push(`[${i}] worker mismatch (${ev.worker})`);
    if (typeof ev.job !== 'string')   errs.push(`[${i}] missing job`);
    if (typeof ev.event !== 'string') errs.push(`[${i}] missing event`);
  }
  if (errs.length) throw new Error(errs.join('; '));
}

async function testReplayOnSubscribe() {
  const WORKER = BASE + 2;
  try { fs.unlinkSync(eventsFile(WORKER)); } catch (_) {}

  emit(WORKER, 'pre', 'a', { n: 0 });
  emit(WORKER, 'pre', 'b', { n: 1 });
  emit(WORKER, 'pre', 'c', { n: 2 });
  await wait(50);

  const events = await collect(WORKER, 3);
  const names = events.map((e) => e.event);
  if (names.join(',') !== 'a,b,c') throw new Error(`expected a,b,c but got ${names.join(',')}`);
}

async function testWriteOrderPreserved() {
  const WORKER = BASE + 3;
  try { fs.unlinkSync(eventsFile(WORKER)); } catch (_) {}

  const resultP = collect(WORKER, 5);
  const p = spawn(process.execPath, ['-e', `
    const { emit } = require(${JSON.stringify(eventsLib)});
    for (let i = 0; i < 5; i++) emit(${WORKER}, 'seq', 'item', { i });
  `], { stdio: 'inherit', env: process.env });

  const events = await resultP;
  await new Promise((r) => p.on('exit', r));

  for (let i = 0; i < 5; i++) {
    if (events[i].payload.i !== i)
      throw new Error(`out of order at position ${i}: got payload.i=${events[i].payload.i}`);
  }
}

async function testEmitCli() {
  const WORKER = BASE + 4;
  try { fs.unlinkSync(eventsFile(WORKER)); } catch (_) {}

  const resultP = collect(WORKER, 3);

  function cli(...args) {
    return new Promise((resolve) => {
      const p = spawn(process.execPath, [emitCli, String(WORKER), 'job', ...args], {
        stdio: 'inherit', env: process.env,
      });
      p.on('exit', resolve);
    });
  }

  await cli('0');
  await cli('2');
  await cli('custom', '{"foo":"bar"}');

  const [ev0, ev1, ev2] = await resultP;

  if (ev0.event !== 'done' || ev0.payload.exitCode !== 0)
    throw new Error(`expected done{exitCode:0}, got ${JSON.stringify(ev0)}`);
  if (ev1.event !== 'failed' || ev1.payload.exitCode !== 2)
    throw new Error(`expected failed{exitCode:2}, got ${JSON.stringify(ev1)}`);
  if (ev2.event !== 'custom' || ev2.payload.foo !== 'bar')
    throw new Error(`expected custom{foo:"bar"}, got ${JSON.stringify(ev2)}`);
}

async function main() {
  const tests = [
    ['concurrent writes — 10 events, correct fields', testConcurrentWrites],
    ['replay on subscribe — pre-existing events delivered', testReplayOnSubscribe],
    ['write order preserved — sequential payload.i', testWriteOrderPreserved],
    ['emit-cli.js — exit codes and custom events', testEmitCli],
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
