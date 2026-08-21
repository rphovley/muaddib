#!/usr/bin/env node
'use strict';
// muaddib-config.js test suite — shared by start-servers.js and
// dispatch-daemon.js's own config tests, which cover their field-specific
// validation on top of this.
//
// testReturnsParsedConfig  — valid .muaddib.json → parsed object returned verbatim
// testThrowsWhenMissing    — no .muaddib.json → clear error naming the file
// testThrowsOnInvalidJson  — malformed .muaddib.json → clear error naming the file

const fs = require('fs');
const os = require('os');
const path = require('path');

const { readMuaddibConfig } = require('../muaddib-config');

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
    fs.writeFileSync(path.join(tmp, '.muaddib.json'), JSON.stringify({ projectName: 'x', foo: 'bar' }));
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
      assert(err.message.includes('.muaddib.json'), `error should name the missing file, got: ${err.message}`);
    }
    assert(threw, 'missing .muaddib.json should throw');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testThrowsOnInvalidJson() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cfg-'));
  try {
    fs.writeFileSync(path.join(tmp, '.muaddib.json'), '{ not valid json');
    let threw = false;
    try {
      readMuaddibConfig(tmp);
    } catch (err) {
      threw = true;
      assert(err.message.includes('.muaddib.json'), `error should name the file, got: ${err.message}`);
    }
    assert(threw, 'malformed .muaddib.json should throw');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

(async () => {
  await run('valid config parsed and returned verbatim', testReturnsParsedConfig);
  await run('missing .muaddib.json throws a clear error', testThrowsWhenMissing);
  await run('malformed .muaddib.json throws a clear error', testThrowsOnInvalidJson);

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exit(1);
})();
