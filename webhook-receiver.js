#!/usr/bin/env node
// Tiny Linear webhook receiver. Validates Linear-Signature HMAC-SHA256, then
// drops a flag file when a Comment is created on the watched issue.
//
// Env vars (all required):
//   WEBHOOK_SECRET    — HMAC secret used when registering the Linear webhook
//   LINEAR_ISSUE_ID   — UUID of the Linear issue to watch
//   COMMENT_FLAG      — path to touch when a new comment arrives on the issue
//   PORT              — port to listen on (default: 9090)
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');

const SECRET = process.env.WEBHOOK_SECRET;
const ISSUE_ID = process.env.LINEAR_ISSUE_ID;
const COMMENT_FLAG = process.env.COMMENT_FLAG;
const PORT = parseInt(process.env.PORT || '9090', 10);

if (!SECRET || !ISSUE_ID || !COMMENT_FLAG) {
    console.error('webhook-receiver: missing required env vars (WEBHOOK_SECRET, LINEAR_ISSUE_ID, COMMENT_FLAG)');
    process.exit(1);
}

function verify(secret, rawBody, sig) {
    // Linear-Signature is a plain hex HMAC-SHA256 digest (no "sha256=" prefix)
    if (!sig || sig.length === 0) return false;
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    if (sig.length !== expected.length) return false;
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

        // Respond immediately so Linear doesn't retry
        res.writeHead(200);
        res.end('ok');

        let payload;
        try { payload = JSON.parse(rawBody.toString()); } catch (_) { return; }

        // Filter: Comment created on our watched issue
        if (payload.type === 'Comment' && payload.action === 'create') {
            const issueId = payload.data && payload.data.issueId;
            if (issueId === ISSUE_ID) {
                console.log(`[webhook-receiver] new comment on issue ${ISSUE_ID}`);
                fs.writeFileSync(COMMENT_FLAG, String(Date.now()));
            }
        }
    });
}).listen(PORT, () => {
    console.log(`[webhook-receiver] listening on :${PORT} for issue ${ISSUE_ID}`);
});
