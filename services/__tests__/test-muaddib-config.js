#!/usr/bin/env node
'use strict';
// muaddib-config.js test suite — shared by start-servers.js and
// dispatch-daemon.js's own config tests, which cover their field-specific
// validation on top of this.
//
// testReturnsParsedConfig  — valid .muaddib/manifest.json → parsed object returned verbatim
// testThrowsWhenMissing    — no .muaddib/manifest.json → clear error naming the file
// testThrowsOnInvalidJson  — malformed .muaddib/manifest.json → clear error naming the file

const fs = require('fs');
const os = require('os');
const path = require('path');

const { readMuaddibConfig, readAutonomyLevel } = require('../muaddib-config');
const { writeManifest } = require('./test-utils');

let pass = 0;
let fail = 0;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

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

async function testReturnsParsedConfig() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cfg-'));
  try {
    writeManifest(tmp, JSON.stringify({ projectName: 'x', foo: 'bar' }));
    const cfg = readMuaddibConfig(tmp);
    assert(cfg.projectName === 'x', `expected projectName=x, got ${cfg.projectName}`);
    assert(cfg.foo === 'bar', `expected foo=bar, got ${cfg.foo}`);
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testThrowsWhenMissing() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cfg-'));
  try {
    let threw = false;
    try {
      readMuaddibConfig(tmp);
    } catch (err) {
      threw = true;
      assert(err.message.includes('manifest.json'), `error should name the missing file, got: ${err.message}`);
    }
    assert(threw, 'missing .muaddib/manifest.json should throw');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testThrowsOnInvalidJson() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cfg-'));
  try {
    writeManifest(tmp, '{ not valid json');
    let threw = false;
    try {
      readMuaddibConfig(tmp);
    } catch (err) {
      threw = true;
      assert(err.message.includes('manifest.json'), `error should name the file, got: ${err.message}`);
    }
    assert(threw, 'malformed .muaddib/manifest.json should throw');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testAutonomyLevelDefaultsL0() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cfg-'));
  try {
    writeManifest(tmp, JSON.stringify({ projectName: 'x' })); // no autonomyLevel
    assert(readAutonomyLevel(tmp) === 'L0', 'absent autonomyLevel should default to L0');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testAutonomyLevelValidReturned() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cfg-'));
  try {
    for (const level of ['L0', 'L1', 'L2', 'L3']) {
      writeManifest(tmp, JSON.stringify({ projectName: 'x', autonomyLevel: level }));
      assert(readAutonomyLevel(tmp) === level, `expected ${level}, got ${readAutonomyLevel(tmp)}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testAutonomyLevelBogusThrows() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cfg-'));
  try {
    writeManifest(tmp, JSON.stringify({ projectName: 'x', autonomyLevel: 'L9' }));
    let threw = false;
    try {
      readAutonomyLevel(tmp);
    } catch (err) {
      threw = true;
      assert(err.message.includes('autonomyLevel'), `error should name autonomyLevel, got: ${err.message}`);
    }
    assert(threw, 'a bogus autonomyLevel should throw');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

(async () => {
  await run('valid config parsed and returned verbatim', testReturnsParsedConfig);
  await run('missing .muaddib/manifest.json throws a clear error', testThrowsWhenMissing);
  await run('malformed .muaddib/manifest.json throws a clear error', testThrowsOnInvalidJson);
  await run('absent autonomyLevel defaults to L0', testAutonomyLevelDefaultsL0);
  await run('valid autonomyLevel returned', testAutonomyLevelValidReturned);
  await run('bogus autonomyLevel throws', testAutonomyLevelBogusThrows);

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exit(1);
})();
