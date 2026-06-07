#!/usr/bin/env node
'use strict';
// linear-webhook.js test suite — no network calls.
//
// testVerifySignatureValid      — correct secret → true
// testVerifySignatureWrongSec   — wrong secret → false
// testVerifySignatureWrongBody  — tampered body → false
// testVerifySignatureMissing    — no header → false
// testVerifySignatureOddHex     — malformed hex → false (no throw)

const crypto = require('crypto');
const { verifySignature } = require('../linear-webhook');

function makeSignature(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function testVerifySignatureValid() {
  const secret = 'test-secret-abc';
  const body = Buffer.from('{"action":"create"}');
  const sig = makeSignature(body, secret);
  if (!verifySignature(body, sig, secret)) throw new Error('expected true for valid signature');
}

async function testVerifySignatureWrongSecret() {
  const body = Buffer.from('{"action":"create"}');
  const sig = makeSignature(body, 'correct-secret');
  if (verifySignature(body, sig, 'wrong-secret')) throw new Error('expected false for wrong secret');
}

async function testVerifySignatureWrongBody() {
  const secret = 'test-secret';
  const sig = makeSignature(Buffer.from('original body'), secret);
  const tampered = Buffer.from('tampered body');
  if (verifySignature(tampered, sig, secret)) throw new Error('expected false for tampered body');
}

async function testVerifySignatureMissing() {
  const body = Buffer.from('{}');
  if (verifySignature(body, '', 'secret')) throw new Error('expected false for empty header');
  if (verifySignature(body, null, 'secret')) throw new Error('expected false for null header');
}

async function testVerifySignatureOddHex() {
  const body = Buffer.from('{}');
  // Malformed hex (odd length / non-hex chars) must not throw
  const result = verifySignature(body, 'not-valid-hex!!!', 'secret');
  if (result) throw new Error('expected false for malformed hex');
}

// ─── runner ──────────────────────────────────────────────────────────────────

async function main() {
  const tests = [
    ['verifySignature: valid secret → true', testVerifySignatureValid],
    ['verifySignature: wrong secret → false', testVerifySignatureWrongSecret],
    ['verifySignature: tampered body → false', testVerifySignatureWrongBody],
    ['verifySignature: missing/empty header → false', testVerifySignatureMissing],
    ['verifySignature: malformed hex → false, no throw', testVerifySignatureOddHex],
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

  console.log(`\n${passed}/${tests.length} passed`);
  if (passed < tests.length) process.exit(1);
}

main().catch((err) => {
  console.error('FAIL —', err.message);
  process.exit(1);
});
