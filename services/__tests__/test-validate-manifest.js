#!/usr/bin/env node
'use strict';
// validate-manifest.js test suite — covers the consolidated required-field /
// port / ticketSource checks the onboarding wizard runs at the end. The pure
// validateManifest() core is exercised with plain objects; validateManifestFile()
// gets one round-trip through the filesystem to prove the read/convert path.

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  validateManifest,
  validateManifestFile,
  detectPortCollisions,
} = require('../validate-manifest');
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

// A minimal manifest that validates clean — tests mutate a clone of this.
function validManifest() {
  return {
    projectName: 'demo',
    ticketSource: 'github',
    githubOwner: 'octocat',
    githubRepo: 'demo',
    dispatchPort: 4999,
    model: 'claude-opus-4-8',
    retryThreshold: 3,
    workerPorts: { api: 9089, db: 6442, sketch: 5386 },
    projects: [{ name: 'demo', path: '.', checkCommand: './run_tests.sh' }],
  };
}

function hasErr(res, substr) {
  return res.errors.some((e) => e.includes(substr));
}
function hasWarn(res, substr) {
  return res.warnings.some((w) => w.includes(substr));
}

async function testValidPasses() {
  const res = validateManifest(validManifest());
  assert(res.ok, `expected ok, got errors: ${res.errors.join('; ')}`);
  assert(res.errors.length === 0, 'clean manifest should have no errors');
}

async function testMissingProjectName() {
  const m = validManifest();
  delete m.projectName;
  const res = validateManifest(m);
  assert(!res.ok, 'missing projectName should fail');
  assert(hasErr(res, 'projectName'), `error should name projectName, got: ${res.errors.join('; ')}`);
}

async function testTicketSourceDefaultsLinear() {
  const m = validManifest();
  delete m.ticketSource;
  delete m.githubOwner;
  delete m.githubRepo;
  const res = validateManifest(m);
  // Absent ticketSource => linear, which needs no owner/repo, so this is clean.
  assert(res.ok, `absent ticketSource should default to linear and pass, got: ${res.errors.join('; ')}`);
}

async function testRawTicketSourceRejected() {
  const m = validManifest();
  m.ticketSource = 'raw';
  const res = validateManifest(m);
  assert(!res.ok, '"raw" ticketSource should be rejected in a manifest');
  assert(hasErr(res, 'ticketSource'), `error should name ticketSource, got: ${res.errors.join('; ')}`);
}

async function testGithubRequiresOwnerRepo() {
  const m = validManifest();
  delete m.githubOwner;
  delete m.githubRepo;
  const res = validateManifest(m);
  assert(!res.ok, 'github without owner/repo should fail');
  assert(hasErr(res, 'githubOwner'), 'should flag missing githubOwner');
  assert(hasErr(res, 'githubRepo'), 'should flag missing githubRepo');
}

async function testAutonomyLevelValidPasses() {
  for (const level of ['L0', 'L1', 'L2', 'L3']) {
    const m = validManifest();
    m.autonomyLevel = level;
    const res = validateManifest(m);
    assert(res.ok, `autonomyLevel ${level} should pass, got: ${res.errors.join('; ')}`);
  }
}

async function testAutonomyLevelDefaultsL0() {
  const m = validManifest();
  delete m.autonomyLevel; // absent → L0, which is valid
  const res = validateManifest(m);
  assert(res.ok, `absent autonomyLevel should default to L0 and pass, got: ${res.errors.join('; ')}`);
}

async function testAutonomyLevelBogusRejected() {
  const m = validManifest();
  m.autonomyLevel = 'L9';
  const res = validateManifest(m);
  assert(!res.ok, 'a bogus autonomyLevel should be rejected');
  assert(hasErr(res, 'autonomyLevel'), `error should name autonomyLevel, got: ${res.errors.join('; ')}`);
}

async function testMissingWorkerPort() {
  const m = validManifest();
  delete m.workerPorts.db;
  const res = validateManifest(m);
  assert(!res.ok, 'missing a workerPort should fail');
  assert(hasErr(res, 'workerPorts.db'), `should flag workerPorts.db, got: ${res.errors.join('; ')}`);
}

async function testDuplicateLocalPorts() {
  const m = validManifest();
  m.workerPorts.db = m.workerPorts.api; // collide two roles
  const res = validateManifest(m);
  assert(!res.ok, 'duplicate ports within a manifest should fail');
  assert(hasErr(res, 'duplicates'), `should flag the duplicate, got: ${res.errors.join('; ')}`);
}

async function testMissingProjects() {
  const m = validManifest();
  m.projects = [];
  const res = validateManifest(m);
  assert(!res.ok, 'empty projects should fail');
  assert(hasErr(res, 'projects'), 'should flag projects');
}

async function testProjectMissingPath() {
  const m = validManifest();
  m.projects = [{ name: 'x', checkCommand: 'true' }];
  const res = validateManifest(m);
  assert(!res.ok, 'project without path should fail');
  assert(hasErr(res, 'path'), 'should flag missing path');
}

async function testCheckCommandWarns() {
  const m = validManifest();
  m.projects = [{ name: 'x', path: '.' }];
  const res = validateManifest(m);
  assert(res.ok, 'a project without checkCommand is a warning, not an error');
  assert(hasWarn(res, 'checkCommand'), 'should warn about missing checkCommand');
}

async function testDispatchPortMissingWarns() {
  const m = validManifest();
  delete m.dispatchPort;
  const res = validateManifest(m);
  assert(res.ok, 'missing dispatchPort is a warning, not an error');
  assert(hasWarn(res, 'dispatchPort'), 'should warn about missing dispatchPort');
}

async function testRetryThresholdWarns() {
  const m = validManifest();
  m.retryThreshold = 'three';
  const res = validateManifest(m);
  assert(res.ok, 'a bad retryThreshold is a warning (goals.js falls back to 3)');
  assert(hasWarn(res, 'retryThreshold'), 'should warn about bad retryThreshold');
}

async function testPortCollisionAcrossProjects() {
  const m = validManifest();
  const others = [
    { projectName: 'other', dispatchPort: 4000, workerPorts: { api: 9089, db: 1, sketch: 2 } },
  ];
  const res = validateManifest(m, { otherProjects: others });
  assert(res.ok, 'a cross-project port overlap is a warning, not an error');
  assert(hasWarn(res, 'collides'), `should warn about the collision, got: ${res.warnings.join('; ')}`);
}

async function testCollisionIgnoresSelf() {
  const m = validManifest();
  const others = [{ projectName: m.projectName, dispatchPort: m.dispatchPort, workerPorts: m.workerPorts }];
  const warnings = detectPortCollisions(m, others);
  assert(warnings.length === 0, 'a manifest must not collide with its own account entry');
}

async function testContextSourcesValid() {
  const m = validManifest();
  m.contextSources = [
    { type: 'taskManager', source: 'linear' },
    { type: 'decisionLog', source: 'builtin' },
    { type: 'processDocs', source: 'builtin' },
  ];
  const res = validateManifest(m);
  assert(res.ok, `valid contextSources should pass, got: ${res.errors.join('; ')}`);
}

async function testContextSourcesAbsentOk() {
  const m = validManifest(); // no contextSources at all
  const res = validateManifest(m);
  assert(res.ok, 'absent contextSources is fine (optional)');
}

async function testContextSourcesSourceDefaultsBuiltin() {
  const m = validManifest();
  m.contextSources = [{ type: 'decisionLog' }]; // omitted source → builtin
  const res = validateManifest(m);
  assert(res.ok, `omitted source should default to builtin, got: ${res.errors.join('; ')}`);
}

async function testContextSourcesNotArray() {
  const m = validManifest();
  m.contextSources = { type: 'taskManager' };
  const res = validateManifest(m);
  assert(!res.ok, 'non-array contextSources should fail');
  assert(hasErr(res, 'contextSources'), 'should flag contextSources');
}

async function testContextSourcesBadType() {
  const m = validManifest();
  m.contextSources = [{ type: 'slack', source: 'builtin' }];
  const res = validateManifest(m);
  assert(!res.ok, 'unknown context source type should fail');
  assert(hasErr(res, 'invalid "type"'), `should flag the bad type, got: ${res.errors.join('; ')}`);
}

async function testContextSourcesBadSourceForType() {
  const m = validManifest();
  m.contextSources = [{ type: 'decisionLog', source: 'linear' }];
  const res = validateManifest(m);
  assert(!res.ok, 'source not resolvable for the type should fail');
  assert(hasErr(res, 'invalid "source"'), `should flag the bad source, got: ${res.errors.join('; ')}`);
}

async function testContextSourcesEntryNotObject() {
  const m = validManifest();
  m.contextSources = ['taskManager'];
  const res = validateManifest(m);
  assert(!res.ok, 'a non-object entry should fail');
  assert(hasErr(res, 'is not an object'), `should flag the non-object entry, got: ${res.errors.join('; ')}`);
}

async function testNonObject() {
  const res = validateManifest(null);
  assert(!res.ok, 'null manifest should fail');
  assert(hasErr(res, 'JSON object'), 'should say it is not a JSON object');
}

async function testFileRoundTrip() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-'));
  try {
    writeManifest(tmp, JSON.stringify(validManifest()));
    const res = validateManifestFile(tmp);
    assert(res.ok, `valid manifest file should pass, got: ${res.errors.join('; ')}`);
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

async function testFileMissing() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-'));
  try {
    const res = validateManifestFile(tmp);
    assert(!res.ok, 'missing file should fail');
    assert(hasErr(res, 'manifest.json'), 'error should name the missing file');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
}

(async () => {
  await run('valid manifest passes', testValidPasses);
  await run('missing projectName fails', testMissingProjectName);
  await run('absent ticketSource defaults to linear', testTicketSourceDefaultsLinear);
  await run('raw ticketSource rejected in manifest', testRawTicketSourceRejected);
  await run('github requires owner + repo', testGithubRequiresOwnerRepo);
  await run('valid autonomyLevel passes', testAutonomyLevelValidPasses);
  await run('absent autonomyLevel defaults to L0', testAutonomyLevelDefaultsL0);
  await run('bogus autonomyLevel rejected', testAutonomyLevelBogusRejected);
  await run('missing workerPort fails', testMissingWorkerPort);
  await run('duplicate local ports fail', testDuplicateLocalPorts);
  await run('empty projects fails', testMissingProjects);
  await run('project without path fails', testProjectMissingPath);
  await run('missing checkCommand warns', testCheckCommandWarns);
  await run('missing dispatchPort warns', testDispatchPortMissingWarns);
  await run('bad retryThreshold warns', testRetryThresholdWarns);
  await run('cross-project port collision warns', testPortCollisionAcrossProjects);
  await run('collision check ignores self', testCollisionIgnoresSelf);
  await run('valid contextSources passes', testContextSourcesValid);
  await run('absent contextSources is fine', testContextSourcesAbsentOk);
  await run('contextSources source defaults to builtin', testContextSourcesSourceDefaultsBuiltin);
  await run('non-array contextSources fails', testContextSourcesNotArray);
  await run('bad contextSources type fails', testContextSourcesBadType);
  await run('bad contextSources source-for-type fails', testContextSourcesBadSourceForType);
  await run('non-object contextSources entry fails', testContextSourcesEntryNotObject);
  await run('non-object manifest fails', testNonObject);
  await run('valid manifest file round-trips', testFileRoundTrip);
  await run('missing manifest file fails', testFileMissing);

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exit(1);
})();
