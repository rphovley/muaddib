#!/usr/bin/env node
'use strict';
// start-servers.js config loading test suite.
//
// testThrowsWhenNoFile         — missing .muaddib/manifest.json → clear error, no fallback guess
// testThrowsOnInvalidJson      — malformed .muaddib/manifest.json → clear error naming the file
// testThrowsOnEmptyProjects    — .muaddib/manifest.json with no "projects" array → clear error
// testCustomConfig             — custom .muaddib/manifest.json → config values used verbatim
// testCustomApiProjectPicked   — custom config → correct API project selected
// testCustomFrontendsFiltered  — custom config → correct frontends filtered

const fs = require('fs');
const os = require('os');
const path = require('path');

const { _loadConfig: loadConfig, _findServersHook: findServersHook } = require('../start-servers');
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

// ── tests ─────────────────────────────────────────────────────────────────────

async function testThrowsWhenNoFile() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-cfg-'));
  try {
    let threw = false;
    try {
      loadConfig(tmp);
    } catch (err) {
      threw = true;
      assert(err.message.includes('manifest.json'), `error should name the missing file, got: ${err.message}`);
    }
    assert(threw, 'missing .muaddib/manifest.json should throw, not silently fall back to a guessed project list');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testThrowsOnInvalidJson() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-cfg-'));
  try {
    writeManifest(tmp, '{ not valid json');
    let threw = false;
    try {
      loadConfig(tmp);
    } catch (err) {
      threw = true;
      assert(err.message.includes('manifest.json'), `error should name the file, got: ${err.message}`);
    }
    assert(threw, 'malformed .muaddib/manifest.json should throw a clear error');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testThrowsOnEmptyProjects() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-cfg-'));
  try {
    writeManifest(tmp, JSON.stringify({ projectName: 'x' }));
    let threw = false;
    try {
      loadConfig(tmp);
    } catch (err) {
      threw = true;
      assert(err.message.includes('projects'), `error should mention the missing "projects" array, got: ${err.message}`);
    }
    assert(threw, '.muaddib/manifest.json with no projects array should throw');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testCustomConfig() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-cfg-'));
  try {
    const custom = {
      projectName: 'myproject',
      projects: [
        { name: 'backend', path: 'backend', devScript: 'backend:dev', port: 9000, seedScript: 'backend/seed.ts' },
        { name: 'web', path: 'web', devScript: 'web:dev', port: 3000 },
      ],
    };
    writeManifest(tmp, JSON.stringify(custom));
    const cfg = loadConfig(tmp);
    assert(cfg.projectName === 'myproject', `expected projectName=myproject, got ${cfg.projectName}`);
    assert(cfg.projects.length === 2, `expected 2 projects, got ${cfg.projects.length}`);
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testCustomApiProjectPicked() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-cfg-'));
  try {
    const custom = {
      projectName: 'myproject',
      projects: [
        { name: 'backend', path: 'backend', devScript: 'backend:dev', port: 9000, seedScript: 'backend/seed.ts' },
        { name: 'web', path: 'web', devScript: 'web:dev', port: 3000 },
      ],
    };
    writeManifest(tmp, JSON.stringify(custom));
    const cfg = loadConfig(tmp);
    const api = cfg.projects.find((p) => p.seedScript);
    assert(api && api.name === 'backend', `expected api.name=backend, got ${api && api.name}`);
    assert(api.port === 9000, `expected port=9000, got ${api.port}`);
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testCustomFrontendsFiltered() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-cfg-'));
  try {
    const custom = {
      projectName: 'myproject',
      projects: [
        { name: 'backend', path: 'backend', devScript: 'backend:dev', port: 9000, seedScript: 'backend/seed.ts' },
        { name: 'web', path: 'web', devScript: 'web:dev', port: 3000 },
        { name: 'static', path: 'static' },
      ],
    };
    writeManifest(tmp, JSON.stringify(custom));
    const cfg = loadConfig(tmp);
    const frontends = cfg.projects.filter((p) => !p.seedScript && p.devScript);
    assert(frontends.length === 1, `expected 1 frontend, got ${frontends.length}`);
    assert(frontends[0].name === 'web', `expected web, got ${frontends[0].name}`);
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testNoHookFound() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-hook-'));
  try {
    assert(findServersHook(tmp) === null, 'a repo with no .muaddib/hooks/on-servers-start should have no hook');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testJsHookFound() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-hook-'));
  try {
    const hooksDir = path.join(tmp, '.muaddib', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, 'on-servers-start.js');
    fs.writeFileSync(hookPath, '// noop');
    assert(findServersHook(tmp) === hookPath, `expected ${hookPath}, got ${findServersHook(tmp)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testShHookFound() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-hook-'));
  try {
    const hooksDir = path.join(tmp, '.muaddib', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, 'on-servers-start.sh');
    fs.writeFileSync(hookPath, '#!/usr/bin/env bash\n');
    assert(findServersHook(tmp) === hookPath, `expected ${hookPath}, got ${findServersHook(tmp)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

// ── run ───────────────────────────────────────────────────────────────────────

(async () => {
  await run('missing .muaddib/manifest.json throws a clear error (no fallback guess)', testThrowsWhenNoFile);
  await run('malformed .muaddib/manifest.json throws a clear error', testThrowsOnInvalidJson);
  await run('.muaddib/manifest.json with no projects array throws', testThrowsOnEmptyProjects);
  await run('custom config loaded verbatim', testCustomConfig);
  await run('custom API project identified by seedScript', testCustomApiProjectPicked);
  await run('custom frontends filtered by devScript/no-seedScript', testCustomFrontendsFiltered);
  await run('no on-servers-start hook found when absent', testNoHookFound);
  await run('on-servers-start.js hook found when present', testJsHookFound);
  await run('on-servers-start.sh hook found when present', testShHookFound);

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exit(1);
})();
