#!/usr/bin/env node
'use strict';
// fleet-control-cli.js test suite — no docker.
//
// Drives run() in-process with a fake injected control surface to assert each
// subcommand dispatches to the right createFleetControl() method (spawn /
// teardown) with the right args, that a missing worker prints usage and exits
// non-zero without touching the control, that an unknown/absent subcommand
// prints usage and exits non-zero, and that a rejecting control propagates so
// the real entry point's catch turns it into a non-zero exit.

const assert = require('assert');
const { run, USAGE } = require('../fleet-control-cli');

// Captures writes so we can assert on what a subcommand printed.
function capture() {
  let buf = '';
  return { write: (s) => { buf += s; }, get text() { return buf; } };
}

// A fake control surface recording each call and returning fleet-control's
// { code, stdout, stderr } resolution shape (or rejecting when scripted to).
function fakeControl(overrides = {}) {
  const calls = [];
  return {
    calls,
    async spawn(worker, opts) {
      calls.push(['spawn', worker, opts]);
      return { code: 0, stdout: '', stderr: '' };
    },
    async teardown(worker, opts) {
      calls.push(['teardown', worker, opts]);
      return { code: 0, stdout: '', stderr: '' };
    },
    ...overrides,
  };
}

// ─── spawn ───────────────────────────────────────────────────────────────────

async function testSpawn() {
  const control = fakeControl();
  const stdout = capture();
  const code = await run({ argv: ['spawn', '3'], control, stdout });
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(control.calls[0], ['spawn', '3', { task: undefined }]);
  assert.strictEqual(stdout.text, 'spawned worker 3\n');
}

async function testSpawnWithTask() {
  // Trailing words after the worker are joined into the optional task.
  const control = fakeControl();
  const stdout = capture();
  const code = await run({
    argv: ['spawn', '1', 'implement', 'QUO-274', 'now'],
    control,
    stdout,
  });
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(control.calls[0], [
    'spawn', '1', { task: 'implement QUO-274 now' },
  ]);
  assert.strictEqual(stdout.text, 'spawned worker 1\n');
}

async function testSpawnMissingWorker() {
  // No worker arg → usage on stderr, exit 1, control never called.
  const control = fakeControl();
  const stderr = capture();
  const code = await run({ argv: ['spawn'], control, stderr });
  assert.strictEqual(code, 1);
  assert.strictEqual(stderr.text, USAGE);
  assert.strictEqual(control.calls.length, 0);
}

// ─── teardown ─────────────────────────────────────────────────────────────────

async function testTeardown() {
  const control = fakeControl();
  const stdout = capture();
  const code = await run({ argv: ['teardown', '2'], control, stdout });
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(control.calls[0], ['teardown', '2', undefined]);
  assert.strictEqual(stdout.text, 'tore down worker 2\n');
}

async function testTeardownMissingWorker() {
  const control = fakeControl();
  const stderr = capture();
  const code = await run({ argv: ['teardown'], control, stderr });
  assert.strictEqual(code, 1);
  assert.strictEqual(stderr.text, USAGE);
  assert.strictEqual(control.calls.length, 0);
}

// ─── unknown / absent subcommand → usage + non-zero ───────────────────────────

async function testUnknownSubcommand() {
  const control = fakeControl();
  const stderr = capture();
  const code = await run({ argv: ['bogus', '1'], control, stderr });
  assert.strictEqual(code, 1);
  assert.ok(stderr.text.includes('usage:'), 'expected usage on stderr');
  assert.strictEqual(control.calls.length, 0);
}

async function testNoSubcommand() {
  const control = fakeControl();
  const stderr = capture();
  const code = await run({ argv: [], control, stderr });
  assert.strictEqual(code, 1);
  assert.ok(stderr.text.includes('usage:'), 'expected usage on stderr');
  assert.strictEqual(control.calls.length, 0);
}

// ─── rejecting control propagates (entry-point catch → exit 1) ────────────────

async function testSpawnRejectionPropagates() {
  // fleet-control rejects a bad worker (not a non-negative integer) and a failed
  // spawn-worker.sh. run() must not swallow that — it propagates so the
  // require.main catch surfaces stderr + exit 1. Assert the rejection reaches
  // the caller and no confirmation was printed.
  const control = fakeControl({
    spawn: async () => { throw new Error('spawn-worker.sh exited with code 1: boom'); },
  });
  const stdout = capture();
  await assert.rejects(
    () => run({ argv: ['spawn', '9'], control, stdout }),
    /spawn-worker\.sh exited with code 1/,
  );
  assert.strictEqual(stdout.text, '');
}

// ─── runner ──────────────────────────────────────────────────────────────────

async function main() {
  const tests = [
    ['spawn <worker> → control.spawn(worker, {task: undefined}), exit 0, confirmation', testSpawn],
    ['spawn <worker> <task words…> → task is the joined trailing words', testSpawnWithTask],
    ['spawn without worker → usage + exit 1, no control call', testSpawnMissingWorker],
    ['teardown <worker> → control.teardown(worker), exit 0, confirmation', testTeardown],
    ['teardown without worker → usage + exit 1, no control call', testTeardownMissingWorker],
    ['unknown subcommand → usage + exit 1, no control call', testUnknownSubcommand],
    ['no subcommand → usage + exit 1, no control call', testNoSubcommand],
    ['spawn whose control rejects → run() rejects (entry point → exit 1), no stdout', testSpawnRejectionPropagates],
  ];

  let passed = 0;
  for (const [name, fn] of tests) {
    process.stdout.write(`  ${name}... `);
    try {
      await fn();
      process.stdout.write('PASS\n');
      passed++;
    } catch (err) {
      process.stdout.write(`FAIL\n    ${err.stack || err.message}\n`);
    }
  }

  console.log(`\n${passed}/${tests.length} passed`);
  if (passed < tests.length) process.exit(1);
}

main().catch((err) => {
  console.error('FAIL —', err.message);
  process.exit(1);
});
