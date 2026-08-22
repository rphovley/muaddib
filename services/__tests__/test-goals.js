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

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readGoals, DEFAULT_GOALS_MD } = require('../goals');

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

(async () => {
  await run('missing .muaddib/goals.md is bootstrapped with the default template', testBootstrapsWhenMissing);
  await run('existing .muaddib/goals.md is returned verbatim, not overwritten', testReturnsExistingVerbatim);
  await run('an unreadable existing file throws instead of being silently replaced', testPropagatesNonMissingErrors);
  await run('bootstrap creates .muaddib/ dir if it does not exist yet', testCreatesMuaddibDirIfMissing);
  await run('bootstrapping is idempotent and never clobbers a later edit', testIdempotentAcrossCalls);
  await run('a concurrent bootstrap race never clobbers the winning writer', testConcurrentBootstrapDoesNotClobber);

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exit(1);
})();
