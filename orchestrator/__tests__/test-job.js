#!/usr/bin/env node
'use strict';
// Job lifecycle test suite. Requires tmux (run inside the worker container).
//
// testJobExitSuccess — job exits 0 → started then done events emitted
// testJobExitFailure — job exits 1 → started then failed with exitCode in payload
// testStopJobMidRun  — stopJob kills window → stopped event, window no longer listed

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'job-test-'));
process.env.AGENT_STATUS_DIR = TMP_DIR;

const { subscribe, eventsFile } = require('../events');
const { startJob, stopJob } = require('../job');

const WORKER = 98;

const hasSess = spawnSync('tmux', ['has-session', '-t', `w${WORKER}`], { stdio: 'ignore' });
if (hasSess.status !== 0) {
  const r = spawnSync('tmux', ['new-session', '-d', '-s', `w${WORKER}`], { stdio: 'ignore' });
  if (r.status !== 0) {
    console.error('FAIL — could not create tmux session (is tmux installed?)');
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
    process.exit(1);
  }
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

function collectMatching(predicate, count, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const collected = [];
    const sub = subscribe(WORKER, (ev) => {
      if (!predicate(ev)) return;
      collected.push(ev);
      if (collected.length === count) { sub.kill(); resolve(collected); }
    });
    setTimeout(() => { sub.kill(); reject(new Error(`only collected ${collected.length}/${count} matching events`)); }, timeoutMs);
  });
}

async function testJobExitSuccess() {
  const jobName = 'ok-job';
  const p = collectMatching((e) => e.job === jobName, 2);
  startJob(WORKER, jobName, 'sleep 0.2');
  const [startedEv, doneEv] = await p;
  if (startedEv.event !== 'started') throw new Error(`expected started, got ${startedEv.event}`);
  if (doneEv.event !== 'done')       throw new Error(`expected done, got ${doneEv.event}`);
}

async function testJobExitFailure() {
  const jobName = 'fail-job';
  const p = collectMatching((e) => e.job === jobName, 2);
  startJob(WORKER, jobName, 'exit 1');
  const [startedEv, failedEv] = await p;
  if (startedEv.event !== 'started')   throw new Error(`expected started, got ${startedEv.event}`);
  if (failedEv.event !== 'failed')     throw new Error(`expected failed, got ${failedEv.event}`);
  if (failedEv.payload.exitCode !== 1) throw new Error(`expected exitCode=1, got ${failedEv.payload.exitCode}`);
}

// The new sentinel-file path: job sleeps forever but the skill touches
// $STEP_DONE_FILE — wrapper must kill the process and emit done.
async function testJobDoneByFile() {
  const jobName = 'done-by-file';
  const doneFile = `/tmp/step-done-${WORKER}-${jobName}`;

  // Command: sleep indefinitely; a background subshell touches the done file after 0.3 s.
  const cmd = `( sleep 0.3 && touch '${doneFile}' ) & sleep 30`;

  const p = collectMatching((e) => e.job === jobName, 2, 8000);
  startJob(WORKER, jobName, cmd);
  const [startedEv, doneEv] = await p;
  if (startedEv.event !== 'started') throw new Error(`expected started, got ${startedEv.event}`);
  if (doneEv.event !== 'done')       throw new Error(`expected done, got ${doneEv.event}`);
}

async function testStopJobMidRun() {
  const jobName = 'stop-job';
  const p = collectMatching((e) => e.job === jobName && e.event === 'stopped', 1);
  startJob(WORKER, jobName, 'sleep 30');
  await wait(300);
  stopJob(WORKER, jobName);
  await p;
  const windows = spawnSync('tmux', ['list-windows', '-t', `w${WORKER}`], { encoding: 'utf8' });
  if (windows.stdout && windows.stdout.includes(jobName))
    throw new Error(`${jobName} window still exists after stopJob`);
}

async function main() {
  const tests = [
    ['job exits 0 → started + done',                      testJobExitSuccess],
    ['job exits 1 → started + failed with exitCode',      testJobExitFailure],
    ['done sentinel file → process killed + done emitted', testJobDoneByFile],
    ['stopJob mid-run → stopped event + window removed',  testStopJobMidRun],
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

  spawnSync('tmux', ['kill-session', '-t', `w${WORKER}`], { stdio: 'ignore' });
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log(`\n${passed}/${tests.length} passed`);
  if (passed < tests.length) process.exit(1);
}

main().catch((err) => {
  spawnSync('tmux', ['kill-session', '-t', `w${WORKER}`], { stdio: 'ignore' });
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.error('FAIL —', err.message);
  process.exit(1);
});
