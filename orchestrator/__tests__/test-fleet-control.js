#!/usr/bin/env node
'use strict';
// Fleet Control Surface (spawn / teardown) test suite. Exercises the thin Node
// wrappers over bin/spawn-worker.sh / bin/teardown-worker.sh WITHOUT docker,
// tmux, or tokens: each function accepts an injectable scriptPath + env, so the
// tests point it at a deterministic FAKE script that records its argv and
// selected env to a file and exits with a controllable code. This is what makes
// the tools independently testable with no Conductor decision-making involved.
//
// testSpawnInvokesScript      — spawn() runs the script with the worker number,
//                               resolves { code:0, stdout }, forwards
//                               MUADIB_NO_ATTACH=1, and passes a task through.
// testTeardownInvokesScript   — teardown() runs the script with the worker
//                               number and resolves on exit 0.
// testNonZeroExitRejects      — a non-zero exit rejects with stderr surfaced.
// testInvalidWorkerRejects    — a non-integer / negative worker rejects WITHOUT
//                               ever spawning the script.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { spawn, teardown, createFleetControl } = require('../fleet-control');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-control-test-'));

// A fake fleet script: append its argv and the env vars we care about to
// $FAKE_RECORD, emit a line on stdout and one on stderr, then exit with
// $FAKE_EXIT (default 0). Stands in for spawn-worker.sh / teardown-worker.sh.
const FAKE_SCRIPT = path.join(TMP, 'fake-script.sh');
fs.writeFileSync(
  FAKE_SCRIPT,
  [
    '#!/usr/bin/env bash',
    '{',
    '  echo "ARGS:$*"',
    '  echo "MUADIB_NO_ATTACH:${MUADIB_NO_ATTACH:-}"',
    '  echo "CUSTOM:${FAKE_CUSTOM:-}"',
    '} >> "$FAKE_RECORD"',
    'echo "hello-from-fake-stdout"',
    'echo "boom-from-fake-stderr" >&2',
    'exit "${FAKE_EXIT:-0}"',
    '',
  ].join('\n'),
  { mode: 0o755 },
);

function readRecord(recordPath) {
  return fs.existsSync(recordPath) ? fs.readFileSync(recordPath, 'utf8') : '';
}

async function testSpawnInvokesScript() {
  const record = path.join(TMP, 'spawn.record');
  const res = await spawn(3, {
    task: '/muaddib ABC-123',
    scriptPath: FAKE_SCRIPT,
    env: { FAKE_RECORD: record, FAKE_CUSTOM: 'xyz' },
  });
  assert.strictEqual(res.code, 0, 'expected exit code 0');
  assert.ok(
    /hello-from-fake-stdout/.test(res.stdout),
    `expected fake stdout captured, got: ${JSON.stringify(res.stdout)}`,
  );
  const rec = readRecord(record);
  // Worker number first, task passed straight through as the next arg.
  assert.ok(
    /ARGS:3 \/muaddib ABC-123/.test(rec),
    `expected argv "3 /muaddib ABC-123", got: ${JSON.stringify(rec)}`,
  );
  // Non-interactive by default — the wrapper forces MUADIB_NO_ATTACH=1.
  assert.ok(
    /MUADIB_NO_ATTACH:1/.test(rec),
    `expected MUADIB_NO_ATTACH=1 forwarded, got: ${JSON.stringify(rec)}`,
  );
  // Caller-supplied env is forwarded too.
  assert.ok(
    /CUSTOM:xyz/.test(rec),
    `expected caller env forwarded, got: ${JSON.stringify(rec)}`,
  );
}

async function testSpawnWithoutTask() {
  const record = path.join(TMP, 'spawn-notask.record');
  await spawn('5', { scriptPath: FAKE_SCRIPT, env: { FAKE_RECORD: record } });
  const rec = readRecord(record);
  // Just the worker number — no trailing task arg.
  assert.ok(
    /ARGS:5\s*$/m.test(rec),
    `expected bare worker argv "5", got: ${JSON.stringify(rec)}`,
  );
}

async function testTeardownInvokesScript() {
  const record = path.join(TMP, 'teardown.record');
  const res = await teardown(7, {
    scriptPath: FAKE_SCRIPT,
    env: { FAKE_RECORD: record },
  });
  assert.strictEqual(res.code, 0, 'expected exit code 0');
  const rec = readRecord(record);
  assert.ok(
    /ARGS:7\s*$/m.test(rec),
    `expected teardown argv "7", got: ${JSON.stringify(rec)}`,
  );
}

async function testNonZeroExitRejects() {
  const record = path.join(TMP, 'fail.record');
  await assert.rejects(
    () =>
      spawn(2, {
        scriptPath: FAKE_SCRIPT,
        env: { FAKE_RECORD: record, FAKE_EXIT: '1' },
      }),
    (err) => {
      assert.ok(/exited with code 1/.test(err.message), err.message);
      // stderr is surfaced in the rejection so the Conductor can see why.
      assert.ok(/boom-from-fake-stderr/.test(err.message), err.message);
      return true;
    },
    'expected a non-zero exit to reject',
  );
}

async function testInvalidWorkerRejects() {
  const record = path.join(TMP, 'invalid.record');
  // Non-integer, negative, and the numeric-with-suffix case the scripts' own
  // `^[0-9]+$` assertion would reject — all must fail in JS, before spawning.
  for (const bad of ['abc', -1, 1.5, '2x', '', null]) {
    await assert.rejects(
      () => spawn(bad, { scriptPath: FAKE_SCRIPT, env: { FAKE_RECORD: record } }),
      /non-negative integer/,
      `expected spawn(${JSON.stringify(bad)}) to reject`,
    );
    await assert.rejects(
      () =>
        teardown(bad, { scriptPath: FAKE_SCRIPT, env: { FAKE_RECORD: record } }),
      /non-negative integer/,
      `expected teardown(${JSON.stringify(bad)}) to reject`,
    );
  }
  // The fake script must never have run — no record file created.
  assert.ok(
    !fs.existsSync(record),
    'expected no script invocation for an invalid worker',
  );
}

async function testSpawnErrorRejects() {
  // A scriptPath that doesn't exist → child_process 'error' event → reject.
  await assert.rejects(
    () => spawn(1, { scriptPath: path.join(TMP, 'does-not-exist.sh') }),
    /failed to spawn/,
    'expected a missing script to reject with a spawn error',
  );
}

async function testFactory() {
  const record = path.join(TMP, 'factory.record');
  // Defaults baked into the factory are applied to each call.
  const fc = createFleetControl({
    scriptPath: FAKE_SCRIPT,
    env: { FAKE_RECORD: record },
  });
  const res = await fc.spawn(9);
  assert.strictEqual(res.code, 0);
  const rec = readRecord(record);
  assert.ok(
    /ARGS:9\s*$/m.test(rec) && /MUADIB_NO_ATTACH:1/.test(rec),
    `expected factory spawn to use baked-in defaults, got: ${JSON.stringify(rec)}`,
  );
}

async function main() {
  const tests = [
    ['spawn() invokes the script (argv, stdout, MUADIB_NO_ATTACH, env)', testSpawnInvokesScript],
    ['spawn() without a task passes only the worker number', testSpawnWithoutTask],
    ['teardown() invokes the script with the worker number', testTeardownInvokesScript],
    ['non-zero exit rejects with stderr surfaced', testNonZeroExitRejects],
    ['invalid worker rejects without spawning', testInvalidWorkerRejects],
    ['a missing script rejects with a spawn error', testSpawnErrorRejects],
    ['createFleetControl() applies baked-in defaults', testFactory],
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

  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {}

  console.log(`\n${passed}/${tests.length} passed`);
  if (passed < tests.length) process.exit(1);
}

main().catch((err) => {
  console.error('FAIL —', err.message);
  process.exit(1);
});
