#!/usr/bin/env node
'use strict';
// CLI bridge so bash scripts can emit events to the orchestrator bus.
//
// Usage (job exit — exit code determines done vs failed):
//   node emit-cli.js <worker> <job> <exit-code>
//
// Usage (custom event — e.g. tunnel_ready from servers job):
//   node emit-cli.js <worker> <job> <event> [json-payload]

const { emit } = require('./events');

const [,, workerStr, job, thirdArg, payloadStr] = process.argv;
const worker = parseInt(workerStr, 10);

// If the third arg is a bare integer it's an exit code from the job wrapper.
const asNum = parseInt(thirdArg, 10);
if (!isNaN(asNum) && String(asNum) === thirdArg) {
  emit(worker, job, asNum === 0 ? 'done' : 'failed', { exitCode: asNum });
} else {
  const payload = payloadStr ? JSON.parse(payloadStr) : {};
  emit(worker, job, thirdArg, payload);
}
