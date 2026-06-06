#!/usr/bin/env node
// Tiny Linear webhook receiver. Validates Linear-Signature HMAC-SHA256, then
// drops a flag file when a Comment is created on the watched issue.
//
// Env vars:
//   WEBHOOK_SECRET         — HMAC secret used when registering the Linear webhook
//   LINEAR_ISSUE_ID        — UUID of the Linear issue to watch (preferred)
//   LINEAR_ISSUE_IDENTIFIER — identifier e.g. "QUO-311" (fallback if UUID not set)
//   COMMENT_FLAG           — path to touch when a new comment arrives on the issue
//   PORT                   — port to listen on (default: 9090)
//
// Matching logic: a comment event fires the flag if EITHER
//   data.issueId       === LINEAR_ISSUE_ID         (UUID match), OR
//   data.issue.identifier === LINEAR_ISSUE_IDENTIFIER (identifier match fallback)
// This makes the receiver robust to agents passing the identifier instead of the UUID.
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');

const SECRET = process.env.WEBHOOK_SECRET;
const ISSUE_ID = process.env.LINEAR_ISSUE_ID || '';
const ISSUE_IDENTIFIER = process.env.LINEAR_ISSUE_IDENTIFIER || '';
const COMMENT_FLAG = process.env.COMMENT_FLAG;
const PORT = parseInt(process.env.PORT || '9090', 10);
const DEBUG = process.env.WEBHOOK_DEBUG === '1';

if (!SECRET || !COMMENT_FLAG) {
    console.error('webhook-receiver: missing required env vars (WEBHOOK_SECRET, COMMENT_FLAG)');
    process.exit(1);
}
if (!ISSUE_ID && !ISSUE_IDENTIFIER) {
    console.error('webhook-receiver: set LINEAR_ISSUE_ID (UUID) and/or LINEAR_ISSUE_IDENTIFIER');
    process.exit(1);
}

function verify(secret, rawBody, sig) {
    // Linear-Signature is a plain hex HMAC-SHA256 digest (no "sha256=" prefix)
    if (!sig || sig.length === 0) {
        if (DEBUG) console.log('[webhook-receiver:debug] no signature header');
        return false;
    }
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const lengthOk = sig.length === expected.length;
    if (DEBUG) {
        console.log(`[webhook-receiver:debug] received sig : ${sig}`);
        console.log(`[webhook-receiver:debug] computed  sig : ${expected}`);
        console.log(`[webhook-receiver:debug] length check  : ${lengthOk ? 'pass' : `FAIL (received=${sig.length} expected=${expected.length})`}`);
    }
    if (!lengthOk) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch (_) {
        return false;
    }
}

http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
        const rawBody = Buffer.concat(chunks);
        const sig = req.headers['linear-signature'] || '';

        if (!verify(SECRET, rawBody, sig)) {
            console.warn('[webhook-receiver] invalid Linear-Signature — rejected');
            res.writeHead(401);
            res.end('unauthorized');
            return;
        }

        // Respond immediately so Linear does not retry
        res.writeHead(200);
        res.end('ok');

        let payload;
        try { payload = JSON.parse(rawBody.toString()); } catch (_) { return; }

        console.log(`[webhook-receiver] valid delivery: type=${payload.type} action=${payload.action}`);

        if (payload.type === 'Comment' && payload.action === 'create') {
            const issueId = (payload.data && payload.data.issueId) || '';
            const issueIdentifier = (payload.data && payload.data.issue && payload.data.issue.identifier) || '';

            const uuidMatch = ISSUE_ID && issueId === ISSUE_ID;
            const identifierMatch = ISSUE_IDENTIFIER && issueIdentifier === ISSUE_IDENTIFIER;

            if (uuidMatch || identifierMatch) {
                console.log(`[webhook-receiver] new comment on ${issueIdentifier || issueId} — writing flag`);
                fs.writeFileSync(COMMENT_FLAG, String(Date.now()));
            } else {
                console.log(`[webhook-receiver] comment on ${issueIdentifier || issueId} (watching id="${ISSUE_ID}" identifier="${ISSUE_IDENTIFIER}") — ignored`);
            }
        }
    });
}).listen(PORT, () => {
    console.log(`[webhook-receiver] listening on :${PORT} — watching id="${ISSUE_ID}" identifier="${ISSUE_IDENTIFIER}"`);
});
