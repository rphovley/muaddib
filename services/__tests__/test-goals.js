#!/usr/bin/env node
'use strict';
// goals.js test suite.
//
// testBootstrapsWhenMissing       — no .muaddib/goals.md → default template written to disk and returned
// testReturnsExistingVerbatim     — existing .muaddib/goals.md → returned as-is, not overwritten
// testPropagatesNonMissingErrors  — an existing but unreadable (EACCES) file throws, not bootstrapped over
// testCreatesMuaddibDirIfMissing  — bootstrap creates .muaddib/ itself if it doesn't exist yet
// testIdempotentAcrossCalls       — bootstrapping once, then reading again, returns the same content
//                                   without a second write clobbering it
// testConcurrentBootstrapDoesNotClobber — a racing writer that creates the real file between
//                                   readGoals()'s ENOENT check and its bootstrap write must win;
//                                   readGoals must read that content back, not overwrite it
// testParseThresholdsSeparateHeadings — the DEFAULT-shaped separate ## Budget / ## Concurrency /
//                                   ## Retry headings each yield their number
// testParseThresholdsCombinedHeading — a combined "## Budget & retry thresholds" heading feeds both
//                                   budget and retry from the one section
// testParseThresholdsCommentHints  — the default template's <!-- --> placeholder hints yield no
//                                   false numbers; every cap is null
// testParseThresholdsMissingNumbers — a threshold heading with prose but no number → null (never throws)
// testReadGoalThresholdsBootstraps — readGoalThresholds on a missing file bootstraps the default,
//                                   budget/concurrency parse to null, retry defaults (manifest-sourced)
// testReadRetryThresholdFromManifest — reads retryThreshold verbatim from .muaddib/manifest.json
// testReadRetryThresholdDefaultsWhenMissingFile — no manifest.json -> DEFAULT_RETRY_THRESHOLD
// testReadRetryThresholdDefaultsWhenFieldMissingOrInvalid — missing field / negative / non-integer /
//                                   unparseable JSON all default, never throw
// testReadRetryThresholdAllowsZero — retryThreshold: 0 is a valid explicit value, not a falsy trigger

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  readGoals,
  parseThresholds,
  readGoalThresholds,
  readRetryThreshold,
  DEFAULT_GOALS_MD,
  DEFAULT_RETRY_THRESHOLD,
} = require('../goals');

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

async function testBootstrapsWhenMissing() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'goals-'));
  try {
    const { content, bootstrapped } = readGoals(tmp);
    assert.strictEqual(bootstrapped, true, 'missing goals.md should report bootstrapped=true');
    assert.strictEqual(content, DEFAULT_GOALS_MD, 'should return the default template');
    const onDisk = fs.readFileSync(path.join(tmp, '.muaddib', 'goals.md'), 'utf8');
    assert.strictEqual(onDisk, DEFAULT_GOALS_MD, 'default template should be written to disk');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testReturnsExistingVerbatim() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'goals-'));
  try {
    fs.mkdirSync(path.join(tmp, '.muaddib'), { recursive: true });
    const custom = '# Goal Context\n\nCustom project policy.\n';
    fs.writeFileSync(path.join(tmp, '.muaddib', 'goals.md'), custom);

    const { content, bootstrapped } = readGoals(tmp);
    assert.strictEqual(bootstrapped, false, 'existing goals.md should report bootstrapped=false');
    assert.strictEqual(content, custom, 'existing content should be returned verbatim');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testPropagatesNonMissingErrors() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'goals-'));
  try {
    const goalsDir = path.join(tmp, '.muaddib');
    fs.mkdirSync(goalsDir, { recursive: true });
    const goalsPath = path.join(goalsDir, 'goals.md');
    fs.writeFileSync(goalsPath, 'team policy — not the default');
    fs.chmodSync(goalsPath, 0o000);
    try {
      assert.throws(
        () => readGoals(tmp),
        /EACCES|permission/i,
        'an unreadable existing file must throw, not silently get replaced by the default template',
      );
    } finally {
      fs.chmodSync(goalsPath, 0o644);
    }
    const stillThere = fs.readFileSync(goalsPath, 'utf8');
    assert.strictEqual(stillThere, 'team policy — not the default', 'the real file must survive untouched');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testCreatesMuaddibDirIfMissing() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'goals-'));
  try {
    assert.strictEqual(fs.existsSync(path.join(tmp, '.muaddib')), false, 'precondition: no .muaddib/ dir yet');
    readGoals(tmp);
    assert.strictEqual(fs.existsSync(path.join(tmp, '.muaddib', 'goals.md')), true, '.muaddib/ dir + goals.md should be created');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testIdempotentAcrossCalls() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'goals-'));
  try {
    const first = readGoals(tmp);
    assert.strictEqual(first.bootstrapped, true);

    // Simulate a user editing the bootstrapped file before the next read.
    const edited = DEFAULT_GOALS_MD + '\n<!-- user note -->\n';
    fs.writeFileSync(path.join(tmp, '.muaddib', 'goals.md'), edited);

    const second = readGoals(tmp);
    assert.strictEqual(second.bootstrapped, false, 'second call should find the now-existing file');
    assert.strictEqual(second.content, edited, 'second call must not clobber the user edit');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testConcurrentBootstrapDoesNotClobber() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'goals-'));
  try {
    const goalsDir = path.join(tmp, '.muaddib');
    fs.mkdirSync(goalsDir, { recursive: true });
    const goalsPath = path.join(goalsDir, 'goals.md');
    const raceWinner = 'team policy written by a racing process';

    // Simulate readGoals()'s initial existence check racing with another
    // process: the file doesn't exist yet from readGoals()'s point of view
    // (readFileSync throws ENOENT once), but by the time it tries to publish
    // the default template, the other process has already created the real
    // file — so fs.linkSync must hit EEXIST and readGoals must read that
    // content back instead of clobbering it.
    const originalReadFileSync = fs.readFileSync;
    let intercepted = false;
    fs.readFileSync = function (p, ...rest) {
      if (!intercepted && p === goalsPath) {
        intercepted = true;
        fs.writeFileSync(goalsPath, raceWinner);
        const err = new Error('ENOENT (simulated)');
        err.code = 'ENOENT';
        throw err;
      }
      return originalReadFileSync.call(fs, p, ...rest);
    };

    let result;
    try {
      result = readGoals(tmp);
    } finally {
      fs.readFileSync = originalReadFileSync;
    }

    assert.strictEqual(result.bootstrapped, false, 'the racing writer got there first, so this call did not bootstrap');
    assert.strictEqual(result.content, raceWinner, 'must return the racing writer\'s content, not the default template');
    assert.strictEqual(fs.readFileSync(goalsPath, 'utf8'), raceWinner, 'the racing writer\'s file must survive on disk untouched');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testParseThresholdsSeparateHeadings() {
  const md = [
    '# Goal Context',
    '',
    '## Budget',
    '',
    'Per-ticket cost ceiling: $25 before escalating to a human.',
    '',
    '## Concurrency',
    '',
    'Run at most 4 workers at once.',
    '',
    '## Retry',
    '',
    'Retry a failed step up to 3 times before escalating.',
    '',
    '## Priorities',
    '',
    'Prefer correctness over speed.',
  ].join('\n');
  const t = parseThresholds(md);
  assert.deepStrictEqual(t, { budget: 25, concurrency: 4, retry: 3 }, `separate headings: ${JSON.stringify(t)}`);
}

async function testParseThresholdsCombinedHeading() {
  // The self-hosted file's shape: a combined heading feeds both budget and
  // retry, and the budget number here has a $ sign so it is a real cap.
  const md = [
    '# Goal Context',
    '',
    '## Concurrency',
    '',
    'Start conservative: 1 concurrent Worker.',
    '',
    '## Budget & retry thresholds',
    '',
    'Cap spend at $50 per ticket; retry 3 consecutive failed check passes before FAILED.',
  ].join('\n');
  const t = parseThresholds(md);
  assert.deepStrictEqual(t, { budget: 50, concurrency: 1, retry: 3 }, `combined heading: ${JSON.stringify(t)}`);

  // The real self-hosted body states no dollar figure — only a retry count in a
  // combined "Budget & retry" section. Budget must stay null (the bare retry
  // number must not be mistaken for a dollar cap), concurrency 1, retry 3.
  const selfHosted = readGoals(path.join(__dirname, '..', '..')).content;
  const st = parseThresholds(selfHosted);
  assert.deepStrictEqual(
    st,
    { budget: null, concurrency: 1, retry: 3 },
    `self-hosted goals.md: ${JSON.stringify(st)}`,
  );
}

async function testParseThresholdsCommentHints() {
  // The default template is entirely <!-- e.g. ... --> placeholder hints under
  // each heading. Those comments must be stripped before parsing so their
  // example words ("cost ceiling") never leak, and every cap comes back null.
  const t = parseThresholds(DEFAULT_GOALS_MD);
  assert.deepStrictEqual(t, { budget: null, concurrency: null, retry: null }, `default template: ${JSON.stringify(t)}`);
}

async function testParseThresholdsMissingNumbers() {
  const md = [
    '## Budget',
    'No cap set yet.',
    '## Concurrency',
    'To be decided.',
    '## Retry',
    'Inherit the usual policy.',
  ].join('\n');
  const t = parseThresholds(md);
  assert.deepStrictEqual(t, { budget: null, concurrency: null, retry: null }, `prose-only: ${JSON.stringify(t)}`);
  // Never throws on garbage / empty input.
  assert.deepStrictEqual(parseThresholds(''), { budget: null, concurrency: null, retry: null });
  assert.deepStrictEqual(parseThresholds(null), { budget: null, concurrency: null, retry: null });
}

async function testReadGoalThresholdsBootstraps() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'goals-'));
  try {
    assert.strictEqual(fs.existsSync(path.join(tmp, '.muaddib', 'goals.md')), false, 'precondition: no goals.md');
    const t = readGoalThresholds(tmp);
    assert.strictEqual(fs.existsSync(path.join(tmp, '.muaddib', 'goals.md')), true, 'should have bootstrapped the file');
    // budget/concurrency still come from the (freshly bootstrapped) markdown
    // template, which states no numbers -> null. retry is manifest-sourced and
    // always has a deterministic value (no manifest.json here -> the default).
    assert.deepStrictEqual(
      t,
      { budget: null, concurrency: null, retry: DEFAULT_RETRY_THRESHOLD },
      `default parses budget/concurrency null, retry defaults: ${JSON.stringify(t)}`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testReadRetryThresholdFromManifest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'goals-'));
  try {
    fs.mkdirSync(path.join(tmp, '.muaddib'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.muaddib', 'manifest.json'), JSON.stringify({ retryThreshold: 7 }));
    assert.strictEqual(readRetryThreshold(tmp), 7, 'should read retryThreshold verbatim from manifest.json');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testReadRetryThresholdDefaultsWhenMissingFile() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'goals-'));
  try {
    assert.strictEqual(fs.existsSync(path.join(tmp, '.muaddib', 'manifest.json')), false, 'precondition: no manifest.json');
    assert.strictEqual(readRetryThreshold(tmp), DEFAULT_RETRY_THRESHOLD, 'should default when manifest.json is absent');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testReadRetryThresholdDefaultsWhenFieldMissingOrInvalid() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'goals-'));
  try {
    fs.mkdirSync(path.join(tmp, '.muaddib'), { recursive: true });
    const manifestPath = path.join(tmp, '.muaddib', 'manifest.json');

    fs.writeFileSync(manifestPath, JSON.stringify({ projectName: 'x' }));
    assert.strictEqual(readRetryThreshold(tmp), DEFAULT_RETRY_THRESHOLD, 'should default when retryThreshold is absent');

    fs.writeFileSync(manifestPath, JSON.stringify({ retryThreshold: -1 }));
    assert.strictEqual(readRetryThreshold(tmp), DEFAULT_RETRY_THRESHOLD, 'should default for a negative value');

    fs.writeFileSync(manifestPath, JSON.stringify({ retryThreshold: 'three' }));
    assert.strictEqual(readRetryThreshold(tmp), DEFAULT_RETRY_THRESHOLD, 'should default for a non-integer value');

    fs.writeFileSync(manifestPath, 'not json at all');
    assert.strictEqual(readRetryThreshold(tmp), DEFAULT_RETRY_THRESHOLD, 'should default for unparseable JSON, never throw');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testReadRetryThresholdAllowsZero() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'goals-'));
  try {
    fs.mkdirSync(path.join(tmp, '.muaddib'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.muaddib', 'manifest.json'), JSON.stringify({ retryThreshold: 0 }));
    assert.strictEqual(readRetryThreshold(tmp), 0, '0 is a valid explicit threshold, not a falsy default trigger');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

(async () => {
  await run('missing .muaddib/goals.md is bootstrapped with the default template', testBootstrapsWhenMissing);
  await run('existing .muaddib/goals.md is returned verbatim, not overwritten', testReturnsExistingVerbatim);
  await run('an unreadable existing file throws instead of being silently replaced', testPropagatesNonMissingErrors);
  await run('bootstrap creates .muaddib/ dir if it does not exist yet', testCreatesMuaddibDirIfMissing);
  await run('bootstrapping is idempotent and never clobbers a later edit', testIdempotentAcrossCalls);
  await run('a concurrent bootstrap race never clobbers the winning writer', testConcurrentBootstrapDoesNotClobber);
  await run('parseThresholds — separate ## Budget / ## Concurrency / ## Retry headings', testParseThresholdsSeparateHeadings);
  await run('parseThresholds — combined "## Budget & retry thresholds" heading feeds both', testParseThresholdsCombinedHeading);
  await run('parseThresholds — default template comment hints yield no false numbers', testParseThresholdsCommentHints);
  await run('parseThresholds — headings without numbers are null, never throws', testParseThresholdsMissingNumbers);
  await run('readGoalThresholds — bootstraps a missing file, retry from manifest default', testReadGoalThresholdsBootstraps);
  await run('readRetryThreshold — reads retryThreshold verbatim from manifest.json', testReadRetryThresholdFromManifest);
  await run('readRetryThreshold — defaults when manifest.json is missing', testReadRetryThresholdDefaultsWhenMissingFile);
  await run('readRetryThreshold — defaults when the field is missing or invalid, never throws', testReadRetryThresholdDefaultsWhenFieldMissingOrInvalid);
  await run('readRetryThreshold — 0 is a valid explicit value, not treated as falsy', testReadRetryThresholdAllowsZero);

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exit(1);
})();
