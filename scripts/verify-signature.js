#!/usr/bin/env node
// CLI utility to validate a captured Linear webhook signature offline.
//
// Usage:
//   node muaddib/scripts/verify-signature.js --secret <hex> --sig <hex> --body '<json>'
//   echo '{"foo":1}' | node muaddib/scripts/verify-signature.js --secret <hex> --sig <hex>
//
// Exits 0 on MATCH, 1 on MISMATCH or error.
'use strict';

const crypto = require('crypto');

const argv = process.argv.slice(2);
function arg(name) {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : null;
}

const secret = arg('--secret');
const sig = arg('--sig');
const bodyArg = arg('--body');

if (!secret || !sig) {
    process.stderr.write('Usage: verify-signature.js --secret <hex> --sig <hex> [--body <json>]\n');
    process.stderr.write('       echo <json> | verify-signature.js --secret <hex> --sig <hex>\n');
    process.exit(2);
}

function run(body) {
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
    const lengthOk = sig.length === expected.length;
    let match = false;
    if (lengthOk) {
        try {
            match = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
        } catch (_) {
            match = false;
        }
    }
    process.stdout.write(`received : ${sig}\n`);
    process.stdout.write(`computed : ${expected}\n`);
    process.stdout.write(`length   : ${lengthOk ? 'ok' : `MISMATCH (received=${sig.length} expected=${expected.length})`}\n`);
    process.stdout.write(`result   : ${match ? 'MATCH' : 'MISMATCH'}\n`);
    process.exit(match ? 0 : 1);
}

if (bodyArg !== null) {
    run(bodyArg);
} else if (!process.stdin.isTTY) {
    const chunks = [];
    process.stdin.on('data', c => chunks.push(c));
    process.stdin.on('end', () => run(Buffer.concat(chunks).toString()));
} else {
    process.stderr.write('error: provide --body or pipe body via stdin\n');
    process.exit(2);
}
