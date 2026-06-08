#!/usr/bin/env node
'use strict';
// start-servers.js config loading test suite.
//
// testFallbackWhenNoFile       — missing .muaddib.json → quotethat defaults
// testFallbackHasApiProject    — fallback config has exactly one API project (with seedScript)
// testFallbackFrontends        — fallback config has two frontend projects (no seedScript, has devScript)
// testCustomConfig             — custom .muaddib.json → config values used verbatim
// testCustomApiProjectPicked   — custom config → correct API project selected
// testCustomFrontendsFiltered  — custom config → correct frontends filtered

const fs = require('fs');
const os = require('os');
const path = require('path');

const { _loadConfig: loadConfig } = require('../start-servers');

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

async function testFallbackWhenNoFile() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-cfg-'));
  try {
    const cfg = loadConfig(tmp);
    assert(cfg.projects && cfg.projects.length > 0, 'fallback should have projects');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testFallbackHasApiProject() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-cfg-'));
  try {
    const cfg = loadConfig(tmp);
    const api = cfg.projects.find((p) => p.seedScript);
    assert(api, 'fallback should have one API project with seedScript');
    assert(api.path === 'projects/api', `expected path=projects/api, got ${api.path}`);
    assert(api.devScript === 'api:dev', `expected devScript=api:dev, got ${api.devScript}`);
    assert(api.port === 8081, `expected port=8081, got ${api.port}`);
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testFallbackFrontends() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-cfg-'));
  try {
    const cfg = loadConfig(tmp);
    const frontends = cfg.projects.filter((p) => !p.seedScript && p.devScript);
    assert(frontends.length === 2, `expected 2 frontends in fallback, got ${frontends.length}`);
    const names = frontends.map((p) => p.name).sort();
    assert(names[0] === 'homeowner' && names[1] === 'portal', `expected portal+homeowner, got ${names}`);
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
    fs.writeFileSync(path.join(tmp, '.muaddib.json'), JSON.stringify(custom));
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
    fs.writeFileSync(path.join(tmp, '.muaddib.json'), JSON.stringify(custom));
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
    fs.writeFileSync(path.join(tmp, '.muaddib.json'), JSON.stringify(custom));
    const cfg = loadConfig(tmp);
    const frontends = cfg.projects.filter((p) => !p.seedScript && p.devScript);
    assert(frontends.length === 1, `expected 1 frontend, got ${frontends.length}`);
    assert(frontends[0].name === 'web', `expected web, got ${frontends[0].name}`);
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

// ── run ───────────────────────────────────────────────────────────────────────

(async () => {
  await run('fallback when no .muaddib.json', testFallbackWhenNoFile);
  await run('fallback has API project with seedScript', testFallbackHasApiProject);
  await run('fallback has portal + homeowner frontends', testFallbackFrontends);
  await run('custom config loaded verbatim', testCustomConfig);
  await run('custom API project identified by seedScript', testCustomApiProjectPicked);
  await run('custom frontends filtered by devScript/no-seedScript', testCustomFrontendsFiltered);

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exit(1);
})();
