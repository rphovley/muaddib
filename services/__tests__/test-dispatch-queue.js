#!/usr/bin/env node
'use strict';
// dispatch-queue.js test suite. No network or Docker needed.
//
// testIsDispatchedFalseInitially — unknown ticket → false
// testMarkDispatched             — mark then check → true; file persisted
// testEnqueue                    — enqueue adds to queue file
// testFlushSuccess               — trySpawn returns true → entry removed
// testFlushFailure               — trySpawn returns false → entry kept
// testFlushMixed                 — partial success → only failed entries kept
// testPersistenceReload          — state persists across module reloads

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-queue-test-'));

function freshModule() {
  process.env.MUADDIB_DISPATCH_DIR = TMP_DIR;
  const modPath = require.resolve('../dispatch-queue');
  delete require.cache[modPath];
  return require('../dispatch-queue');
}

function readQueueFile() {
  try { return JSON.parse(fs.readFileSync(path.join(TMP_DIR, '.muaddib-dispatch-queue.json'), 'utf8')); } catch (_) { return []; }
}

function readDedupFile() {
  try { return JSON.parse(fs.readFileSync(path.join(TMP_DIR, '.muaddib-dispatch.json'), 'utf8')); } catch (_) { return []; }
}

function clearFiles() {
  try { fs.unlinkSync(path.join(TMP_DIR, '.muaddib-dispatch-queue.json')); } catch (_) {}
  try { fs.unlinkSync(path.join(TMP_DIR, '.muaddib-dispatch.json')); } catch (_) {}
}

async function testIsDispatchedFalseInitially() {
  clearFiles();
  const { isDispatched } = freshModule();
  if (isDispatched('QUO-999')) throw new Error('expected false for unknown ticket');
}

async function testMarkDispatched() {
  clearFiles();
  const { isDispatched, markDispatched } = freshModule();
  if (isDispatched('QUO-1')) throw new Error('precondition: should be false before mark');
  markDispatched('QUO-1');
  if (!isDispatched('QUO-1')) throw new Error('expected true after markDispatched');

  // Verify file persistence
  const persisted = readDedupFile();
  if (!persisted.includes('QUO-1')) throw new Error('QUO-1 not found in dedup file');
}

async function testEnqueue() {
  clearFiles();
  const { enqueue } = freshModule();
  enqueue('QUO-2', 'muaddib.sh', '/path/to/feature.json');
  enqueue('QUO-3', 'muaddib-fast.sh', '/path/to/feature-fast.json');

  const q = readQueueFile();
  if (q.length !== 2) throw new Error(`expected 2 entries, got ${q.length}`);
  if (q[0].ticketId !== 'QUO-2') throw new Error(`expected QUO-2, got ${q[0].ticketId}`);
  if (q[1].ticketId !== 'QUO-3') throw new Error(`expected QUO-3, got ${q[1].ticketId}`);
  if (!q[0].enqueuedAt) throw new Error('missing enqueuedAt on entry');
}

async function testFlushSuccess() {
  clearFiles();
  const { enqueue, flush } = freshModule();
  enqueue('QUO-10', 'muaddib.sh', '/wf.json');

  let spawnCalled = false;
  await flush(async (entry) => {
    spawnCalled = true;
    if (entry.ticketId !== 'QUO-10') throw new Error(`unexpected ticketId: ${entry.ticketId}`);
    return true;
  });

  if (!spawnCalled) throw new Error('trySpawn was not called');
  const q = readQueueFile();
  if (q.length !== 0) throw new Error(`expected empty queue after flush, got ${q.length} entries`);
}

async function testFlushFailure() {
  clearFiles();
  const { enqueue, flush } = freshModule();
  enqueue('QUO-20', 'muaddib.sh', '/wf.json');

  await flush(async () => false);

  const q = readQueueFile();
  if (q.length !== 1) throw new Error(`expected 1 entry kept in queue, got ${q.length}`);
  if (q[0].ticketId !== 'QUO-20') throw new Error(`wrong entry kept: ${q[0].ticketId}`);
}

async function testFlushMixed() {
  clearFiles();
  const { enqueue, flush } = freshModule();
  enqueue('QUO-30', 'muaddib.sh', '/wf.json');
  enqueue('QUO-31', 'muaddib.sh', '/wf.json');
  enqueue('QUO-32', 'muaddib.sh', '/wf.json');

  // First and third succeed; second fails.
  const results = { 'QUO-30': true, 'QUO-31': false, 'QUO-32': true };
  await flush(async (entry) => results[entry.ticketId]);

  const q = readQueueFile();
  if (q.length !== 1) throw new Error(`expected 1 remaining entry, got ${q.length}`);
  if (q[0].ticketId !== 'QUO-31') throw new Error(`expected QUO-31 remaining, got ${q[0].ticketId}`);
}

async function testPersistenceReload() {
  clearFiles();
  // Write state in first module instance
  const m1 = freshModule();
  m1.markDispatched('QUO-50');
  m1.enqueue('QUO-51', 'muaddib.sh', '/wf.json');

  // Load fresh module — should read persisted state from files
  const m2 = freshModule();
  if (!m2.isDispatched('QUO-50')) throw new Error('dedup state not persisted across reload');

  let found = false;
  await m2.flush(async (entry) => {
    if (entry.ticketId === 'QUO-51') found = true;
    return true;
  });
  if (!found) throw new Error('queue state not persisted across reload');
}

// ─── runner ──────────────────────────────────────────────────────────────────

async function main() {
  const tests = [
    ['isDispatched: unknown ticket → false', testIsDispatchedFalseInitially],
    ['markDispatched: check true after mark; file persisted', testMarkDispatched],
    ['enqueue: adds entries to queue file', testEnqueue],
    ['flush: trySpawn true → entry removed', testFlushSuccess],
    ['flush: trySpawn false → entry kept', testFlushFailure],
    ['flush: partial success — only failed entries kept', testFlushMixed],
    ['persistence: state reloaded across module instances', testPersistenceReload],
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
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
  console.error('FAIL —', err.message);
  process.exit(1);
});
