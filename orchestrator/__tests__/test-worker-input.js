#!/usr/bin/env node
'use strict';
// worker-input.js + worker-input-cli.js test suite. No docker, no tmux, no live
// worker, no Conductor — every child process goes through an injected fake `run`
// seam that records the argv it was asked to spawn and returns canned results.
// This directly satisfies the ticket's "independently testable" criterion.
//
// testResolvesContainerFilter  — container resolution uses attach.sh's exact filter
// testSingleLineSend           — a single-line send emits `-l <text>` then `Enter`
// testMultiLineSend            — a multi-line send interleaves `M-Enter` between lines
// testNotRunningThrows         — an empty `docker ps` result throws "not running"
// testExecFailureThrows        — a failed `docker exec` surfaces as an error
// testMissingProjectNameThrows — no MUADDIB_PROJECT_NAME → a clear error
// testInvalidWorkerThrows      — a non-integer worker is rejected
// testCliArgvText              — CLI takes text from argv and prints a confirmation
// testCliStdinText             — CLI reads the body from stdin when no argv text
// testCliMissingWorkerUsage    — CLI with no worker prints usage, exit 1

const assert = require('assert');
const { createWorkerInput, sendInput } = require('../worker-input');
const cli = require('../worker-input-cli');

let pass = 0;
let fail = 0;

async function runTest(name, fn) {
  try {
    await fn();
    process.stdout.write(`  ${name}... PASS\n`);
    pass++;
  } catch (err) {
    process.stdout.write(`  ${name}... FAIL: ${err.message}\n`);
    fail++;
  }
}

// A fake `run` seam: records every call and returns canned results. `docker ps`
// returns the (configurable) container id; `docker exec` returns the exec status.
function fakeRun({ psStdout = 'cid123\n', psStatus = 0, execStatus = 0, execStderr = '' } = {}) {
  const calls = [];
  const run = (file, args, opts = {}) => {
    calls.push({ file, args, opts });
    if (args[0] === 'ps') {
      return { status: psStatus, stdout: psStdout, stderr: '' };
    }
    return { status: execStatus, stdout: '', stderr: execStderr };
  };
  return { run, calls };
}

// The key args of the i-th `docker exec ... tmux send-keys -t w<N> <keys...>`
// call: everything after the fixed `exec <cid> tmux send-keys -t <session>` head.
function sendKeyCalls(calls) {
  return calls.filter((c) => c.args[0] === 'exec').map((c) => c.args.slice(6));
}

async function testResolvesContainerFilter() {
  const { run, calls } = fakeRun();
  const wi = createWorkerInput({ run, projectName: 'quotethat' });
  wi.sendInput(2, 'hello');
  const ps = calls.find((c) => c.args[0] === 'ps');
  assert.ok(ps, 'expected a docker ps call');
  assert.ok(ps.args.includes('-q'), 'docker ps must use -q');
  assert.ok(
    ps.args.includes('label=com.docker.compose.project=quotethat-w2'),
    `expected the compose-project label filter, got: ${JSON.stringify(ps.args)}`,
  );
  assert.ok(ps.args.includes('name=worker'), 'expected the name=worker filter');
}

async function testSingleLineSend() {
  const { run, calls } = fakeRun();
  const wi = createWorkerInput({ run, projectName: 'proj' });
  const result = wi.sendInput(1, 'hello');
  assert.deepStrictEqual(result, { worker: '1', container: 'cid123', ok: true });

  // The exec calls target the resolved container and the w1 tmux session.
  const exec = calls.find((c) => c.args[0] === 'exec');
  assert.deepStrictEqual(exec.args.slice(0, 6), ['exec', 'cid123', 'tmux', 'send-keys', '-t', 'w1']);

  // A single line → `-l -- hello` (`--` ends option parsing so dash-leading text
  // is literal), then a bare `Enter` to submit.
  assert.deepStrictEqual(sendKeyCalls(calls), [['-l', '--', 'hello'], ['Enter']]);
}

async function testMultiLineSend() {
  const { run, calls } = fakeRun();
  const wi = createWorkerInput({ run, projectName: 'proj' });
  wi.sendInput(0, 'line-a\nline-b');
  // Soft newline (M-Enter) between lines so it isn't submitted early; one final Enter.
  assert.deepStrictEqual(sendKeyCalls(calls), [
    ['-l', '--', 'line-a'],
    ['M-Enter'],
    ['-l', '--', 'line-b'],
    ['Enter'],
  ]);
}

async function testNotRunningThrows() {
  const { run } = fakeRun({ psStdout: '' });
  const wi = createWorkerInput({ run, projectName: 'proj' });
  assert.throws(() => wi.sendInput(3, 'x'), /worker 3 is not running/);
}

async function testExecFailureThrows() {
  const { run } = fakeRun({ execStatus: 1, execStderr: 'no server running' });
  const wi = createWorkerInput({ run, projectName: 'proj' });
  assert.throws(() => wi.sendInput(1, 'x'), /send-keys failed for worker 1: no server running/);
}

async function testMissingProjectNameThrows() {
  const { run } = fakeRun();
  const saved = process.env.MUADDIB_PROJECT_NAME;
  delete process.env.MUADDIB_PROJECT_NAME;
  try {
    // Explicit empty projectName + unset env → the constructor resolves to
    // undefined and sendInput must refuse before touching docker.
    assert.throws(() => createWorkerInput({ run, projectName: '' }).sendInput(1, 'x'), /MUADDIB_PROJECT_NAME is not set/);
  } finally {
    if (saved !== undefined) process.env.MUADDIB_PROJECT_NAME = saved;
  }
}

async function testInvalidWorkerThrows() {
  const { run } = fakeRun();
  const wi = createWorkerInput({ run, projectName: 'proj' });
  assert.throws(() => wi.sendInput('2; rm -rf /', 'x'), /invalid worker/);
}

// ─── CLI ───────────────────────────────────────────────────────────────────

function capture() {
  let buf = '';
  return { write: (s) => { buf += s; }, get text() { return buf; } };
}

async function testCliArgvText() {
  const stdout = capture();
  const seen = [];
  const sendFn = (worker, text) => {
    seen.push({ worker, text });
    return { worker, container: 'cidX', ok: true };
  };
  const code = await cli.run({ argv: ['4', 'hello', 'there'], sendFn, stdout });
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(seen, [{ worker: '4', text: 'hello there' }]);
  assert.ok(stdout.text.includes('sent input to worker 4 (cidX)'), `got: ${JSON.stringify(stdout.text)}`);
}

async function testCliStdinText() {
  const stdout = capture();
  const seen = [];
  const sendFn = (worker, text) => {
    seen.push({ worker, text });
    return { worker, container: 'cidY', ok: true };
  };
  const readBody = async () => 'from-stdin body';
  const code = await cli.run({ argv: ['1'], sendFn, readBody, stdout });
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(seen, [{ worker: '1', text: 'from-stdin body' }]);
}

async function testCliMissingWorkerUsage() {
  const stderr = capture();
  const code = await cli.run({ argv: [], stderr });
  assert.strictEqual(code, 1);
  assert.ok(stderr.text.includes('usage:'), 'missing worker must print usage');
}

(async () => {
  await runTest('container resolution uses attach.sh\'s compose-label filter', testResolvesContainerFilter);
  await runTest('a single-line send emits -l <text> then Enter', testSingleLineSend);
  await runTest('a multi-line send interleaves M-Enter between lines', testMultiLineSend);
  await runTest('an empty docker ps result throws "not running"', testNotRunningThrows);
  await runTest('a failed docker exec surfaces as an error', testExecFailureThrows);
  await runTest('a missing MUADDIB_PROJECT_NAME throws a clear error', testMissingProjectNameThrows);
  await runTest('a non-integer worker is rejected', testInvalidWorkerThrows);
  await runTest('CLI takes text from argv and prints a confirmation', testCliArgvText);
  await runTest('CLI reads the body from stdin when no argv text', testCliStdinText);
  await runTest('CLI with no worker prints usage and exits 1', testCliMissingWorkerUsage);

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exit(1);
})();
