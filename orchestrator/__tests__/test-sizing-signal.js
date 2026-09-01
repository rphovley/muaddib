#!/usr/bin/env node
'use strict';
// Sizing Signal test suite (muaddib#30). Exercises the discovery-and-contract
// boundary WITHOUT any real project sizing mechanism: every case either points
// at an empty repoDir (no hook → not-configured) or injects a deterministic
// FAKE hook (a tiny .sh / .js that echoes controllable JSON and exits with a
// controllable code). This is what makes the signal independently testable with
// no Conductor decision-making and no L3 mechanism present.
//
// testNotConfigured        — no hook present → resolves { configured:false },
//                            no error/crash (muaddib's own self-hosting case).
// testConfiguredShHook     — .sh hook echoes valid JSON → { configured:true,
//                            signal }; hook received the ticket ID (argv +
//                            MUADDIB_TICKET_ID); confidence returned verbatim.
// testConfiguredJsHook     — .js hook variant → discovery + runtime selection.
// testNonZeroExitRejects   — hook exits non-zero → rejects, stderr surfaced.
// testMalformedStdout      — non-JSON stdout → rejects (unparseable).
// testBadSize              — size outside {XS..XL} → rejects (contract).
// testNonBooleanSplit      — recommendSplit not boolean → rejects (contract).
// testBadBlockingQuestions — blockingQuestions not string[] → rejects.
// testExtraKeysStripped    — extra hook-internal keys dropped from signal.
// testFactory              — createSizingSignal applies baked-in defaults.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  findSizingHook,
  computeSizingSignal,
  createSizingSignal,
} = require('../sizing-signal');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sizing-signal-test-'));

// Write a fake sizing hook. `body` is the shell/js source; `ext` picks the
// runtime (.sh → bash, .js → node). Returns the hook path.
function writeHook(name, ext, body) {
  const p = path.join(TMP, `${name}${ext}`);
  fs.writeFileSync(p, body, { mode: 0o755 });
  return p;
}

// A .sh hook that records how it was invoked (argv + MUADDIB_TICKET_ID) to
// $HOOK_RECORD, prints $HOOK_STDOUT verbatim, and exits $HOOK_EXIT (default 0).
const SH_HOOK = writeHook(
  'sizing',
  '.sh',
  [
    '#!/usr/bin/env bash',
    '{',
    '  echo "ARGV1:${1:-}"',
    '  echo "ENVID:${MUADDIB_TICKET_ID:-}"',
    '} >> "$HOOK_RECORD"',
    'printf "%s" "$HOOK_STDOUT"',
    '[ -n "${HOOK_STDERR:-}" ] && printf "%s" "$HOOK_STDERR" >&2',
    'exit "${HOOK_EXIT:-0}"',
    '',
  ].join('\n'),
);

// A .js hook variant — proves runtime selection by extension. Echoes a fixed
// valid signal so the test only needs to assert discovery + node execution.
const JS_HOOK = writeHook(
  'sizing',
  '.js',
  [
    "'use strict';",
    'process.stdout.write(JSON.stringify({',
    '  size: process.argv[2] === "BIG-1" ? "XL" : "M",',
    '  confidence: "high",',
    '  recommendSplit: true,',
    '}));',
    '',
  ].join('\n'),
);

function readRecord(recordPath) {
  return fs.existsSync(recordPath) ? fs.readFileSync(recordPath, 'utf8') : '';
}

async function testNotConfigured() {
  // An empty dir has no .muaddib/hooks/sizing.* — the muaddib self-hosting case.
  const emptyRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'sizing-empty-'));
  assert.strictEqual(findSizingHook(emptyRepo), null, 'expected no hook found');
  const res = await computeSizingSignal('QT-1', { repoDir: emptyRepo });
  assert.deepStrictEqual(
    res,
    { configured: false },
    `expected { configured:false }, got: ${JSON.stringify(res)}`,
  );
}

async function testConfiguredShHook() {
  const record = path.join(TMP, 'sh.record');
  const res = await computeSizingSignal('MUAD-30', {
    hookPath: SH_HOOK,
    env: {
      ...process.env,
      HOOK_RECORD: record,
      HOOK_STDOUT: JSON.stringify({
        size: 'L',
        confidence: 'low',
        recommendSplit: false,
        blockingQuestions: ['which auth flow?'],
      }),
    },
  });
  assert.deepStrictEqual(res, {
    configured: true,
    signal: {
      size: 'L',
      confidence: 'low',
      recommendSplit: false,
      blockingQuestions: ['which auth flow?'],
    },
  });
  const rec = readRecord(record);
  // The hook received the ticket ID both ways.
  assert.ok(/ARGV1:MUAD-30/.test(rec), `expected ticket id as argv, got: ${JSON.stringify(rec)}`);
  assert.ok(/ENVID:MUAD-30/.test(rec), `expected MUADDIB_TICKET_ID, got: ${JSON.stringify(rec)}`);
  // confidence is passed straight through, not normalized.
  assert.strictEqual(res.signal.confidence, 'low', 'confidence must be verbatim');
}

async function testConfiguredJsHook() {
  const res = await computeSizingSignal('BIG-1', { hookPath: JS_HOOK });
  assert.deepStrictEqual(res, {
    configured: true,
    signal: { size: 'XL', confidence: 'high', recommendSplit: true },
  });
}

async function testNonZeroExitRejects() {
  const record = path.join(TMP, 'fail.record');
  await assert.rejects(
    () =>
      computeSizingSignal('MUAD-30', {
        hookPath: SH_HOOK,
        env: {
          ...process.env,
          HOOK_RECORD: record,
          HOOK_STDOUT: '',
          HOOK_STDERR: 'sizing model unavailable',
          HOOK_EXIT: '2',
        },
      }),
    (err) => {
      assert.ok(/exited with code 2/.test(err.message), err.message);
      assert.ok(/sizing model unavailable/.test(err.message), err.message);
      return true;
    },
    'expected a non-zero hook exit to reject with stderr surfaced',
  );
}

async function testMalformedStdout() {
  await assert.rejects(
    () =>
      computeSizingSignal('MUAD-30', {
        hookPath: SH_HOOK,
        env: { ...process.env, HOOK_RECORD: path.join(TMP, 'x'), HOOK_STDOUT: 'not json{' },
      }),
    /unparseable stdout/,
    'expected malformed stdout to reject',
  );
}

async function testBadSize() {
  await assert.rejects(
    () =>
      computeSizingSignal('MUAD-30', {
        hookPath: SH_HOOK,
        env: {
          ...process.env,
          HOOK_RECORD: path.join(TMP, 'x'),
          HOOK_STDOUT: JSON.stringify({ size: 'HUGE', confidence: 'high', recommendSplit: false }),
        },
      }),
    /"size" must be one of/,
    'expected a bad size to reject on contract validation',
  );
}

async function testNonBooleanSplit() {
  await assert.rejects(
    () =>
      computeSizingSignal('MUAD-30', {
        hookPath: SH_HOOK,
        env: {
          ...process.env,
          HOOK_RECORD: path.join(TMP, 'x'),
          HOOK_STDOUT: JSON.stringify({ size: 'M', confidence: 'high', recommendSplit: 'yes' }),
        },
      }),
    /"recommendSplit" must be a boolean/,
    'expected a non-boolean recommendSplit to reject',
  );
}

async function testBadBlockingQuestions() {
  await assert.rejects(
    () =>
      computeSizingSignal('MUAD-30', {
        hookPath: SH_HOOK,
        env: {
          ...process.env,
          HOOK_RECORD: path.join(TMP, 'x'),
          HOOK_STDOUT: JSON.stringify({
            size: 'M',
            confidence: 'high',
            recommendSplit: false,
            blockingQuestions: [1, 2, 3],
          }),
        },
      }),
    /"blockingQuestions" must be an array of strings/,
    'expected non-string blockingQuestions to reject',
  );
}

async function testExtraKeysStripped() {
  const res = await computeSizingSignal('MUAD-30', {
    hookPath: SH_HOOK,
    env: {
      ...process.env,
      HOOK_RECORD: path.join(TMP, 'x'),
      HOOK_STDOUT: JSON.stringify({
        size: 'S',
        confidence: 'medium',
        recommendSplit: false,
        // hook-internal fields the Conductor must never see:
        rationale: 'looks small',
        tokensUsed: 4210,
      }),
    },
  });
  assert.deepStrictEqual(
    res.signal,
    { size: 'S', confidence: 'medium', recommendSplit: false },
    'expected extra keys stripped from the returned signal',
  );
}

async function testFactory() {
  const record = path.join(TMP, 'factory.record');
  const svc = createSizingSignal({
    hookPath: SH_HOOK,
    env: {
      ...process.env,
      HOOK_RECORD: record,
      HOOK_STDOUT: JSON.stringify({ size: 'XS', confidence: 'high', recommendSplit: false }),
    },
  });
  const res = await svc.computeSizingSignal('FAC-1');
  assert.deepStrictEqual(res, {
    configured: true,
    signal: { size: 'XS', confidence: 'high', recommendSplit: false },
  });
  assert.ok(/ARGV1:FAC-1/.test(readRecord(record)), 'expected baked-in hook invoked with ticket id');
}

async function main() {
  const tests = [
    ['no hook configured resolves { configured:false } (self-hosting case)', testNotConfigured],
    ['configured .sh hook resolves a validated signal; ticket id passed + confidence verbatim', testConfiguredShHook],
    ['configured .js hook variant (discovery + runtime selection)', testConfiguredJsHook],
    ['non-zero hook exit rejects with stderr surfaced', testNonZeroExitRejects],
    ['malformed stdout rejects (unparseable)', testMalformedStdout],
    ['bad size rejects (contract validation)', testBadSize],
    ['non-boolean recommendSplit rejects (contract validation)', testNonBooleanSplit],
    ['non-string blockingQuestions rejects (contract validation)', testBadBlockingQuestions],
    ['extra keys stripped from the returned signal', testExtraKeysStripped],
    ['createSizingSignal() applies baked-in defaults', testFactory],
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
