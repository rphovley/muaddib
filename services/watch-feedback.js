#!/usr/bin/env node
'use strict';

// Webhook job — started by the orchestrator at container boot.
//
// 1. Starts webhook-receiver.js + cloudflared tunnel immediately.
// 2. Polls /tmp/pr-number-${WORKER_INDEX} until the Claude job writes the PR.
// 3. Restarts receiver with PR_NUMBER and registers a GitHub repo webhook.
// 4. Main loop:
//    /feedback PR comment → emits webhook:feedback on the event bus
//    PR merged/closed     → emits webhook:merged, exits
// 5. Deletes the GitHub webhook on EXIT.
//
// Required env: WORKER_INDEX, REPO_URL, GITHUB_TOKEN

const fs = require('fs');
const path = require('path');
const net = require('net');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');

const WORKER = process.env.WORKER_INDEX || '0';
const REPO_URL = (process.env.REPO_URL || '').trim();
const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || '').trim();
const REPO_DIR = process.env.REPO_DIR || '/home/worker/repo';
const WEBHOOK_PORT = 9090;
const MERGE_POLL_INTERVAL_MS = 30_000;

// Normalize: "https://github.com/org/repo" or "github.com/org/repo" → "org/repo"
const REPO = REPO_URL
  .replace(/^https?:\/\//, '')
  .replace(/^github\.com\//, '')
  .replace(/\.git$/, '');

const EMIT_CLI = path.join(REPO_DIR, 'muaddib/orchestrator/emit-cli.js');
const RECEIVER_SCRIPT = path.join(REPO_DIR, 'muaddib/services/webhook-receiver.js');
const COMMENT_FLAG = `/tmp/wf-comment-${WORKER}`;
const RECEIVER_LOG = `/tmp/webhook-receiver.log`;
const TUNNEL_LOG = `/tmp/cf-webhook.log`;
const PR_NUMBER_FILE = `/tmp/pr-number-${WORKER}`;
const WEBHOOK_SECRET = crypto.randomBytes(32).toString('hex');

let hookId = null;
let receiverProc = null;
let cloudflaredProc = null;

function log(msg) {
  process.stdout.write(`[watch-feedback w${WORKER}] ${msg}\n`);
}

function cleanup() {
  log('cleaning up');
  if (hookId) {
    log(`deleting GitHub webhook ${hookId}`);
    try {
      require('child_process').execSync(
        `gh api repos/${REPO}/hooks/${hookId} -X DELETE 2>/dev/null || true`,
        { env: { ...process.env, GITHUB_TOKEN }, stdio: 'ignore', timeout: 10_000 }
      );
    } catch (_) {}
  }
  if (receiverProc) { try { receiverProc.kill(); } catch (_) {} }
  if (cloudflaredProc) { try { cloudflaredProc.kill(); } catch (_) {} }
  try { fs.unlinkSync(COMMENT_FLAG); } catch (_) {}
}

process.on('exit', cleanup);
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

// ── GitHub REST API helper ────────────────────────────────────────────────────

function githubApi(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: `/repos/${REPO}${endpoint}`,
        method,
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'muaddib-fleet',
          ...(bodyStr
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) }
            : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          if (res.statusCode >= 400) {
            reject(new Error(`GitHub ${method} ${endpoint} → ${res.statusCode}: ${text.slice(0, 300)}`));
            return;
          }
          try { resolve(JSON.parse(text)); } catch (_) { resolve(text); }
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Event emit ───────────────────────────────────────────────────────────────

function emitEvent(jobName, eventName, payload = {}) {
  spawn('node', [EMIT_CLI, WORKER, jobName, eventName, JSON.stringify(payload)], {
    stdio: 'ignore',
    detached: true,
  }).unref();
}

// ── Receiver process ─────────────────────────────────────────────────────────

function startReceiver(prNumber) {
  if (receiverProc) {
    try { receiverProc.kill(); } catch (_) {}
    receiverProc = null;
  }

  const env = {
    ...process.env,
    PORT: String(WEBHOOK_PORT),
    COMMENT_FLAG,
    WEBHOOK_SECRET,
  };
  if (prNumber) env.PR_NUMBER = String(prNumber);

  const logFd = fs.openSync(RECEIVER_LOG, 'w');
  receiverProc = spawn('node', [RECEIVER_SCRIPT], {
    env,
    stdio: ['ignore', logFd, logFd],
  });
  fs.closeSync(logFd);

  receiverProc.on('exit', (code) => log(`receiver exited (code=${code})`));
  log(`receiver PID=${receiverProc.pid} on :${WEBHOOK_PORT}${prNumber ? ` PR_NUMBER=${prNumber}` : ''}`);
}

// ── Port readiness ────────────────────────────────────────────────────────────

async function waitForPort(port, maxAttempts = 15) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const ready = await new Promise((r) => {
      const s = net.createConnection(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); r(true); });
      s.on('error', () => r(false));
    });
    if (ready) return;
  }
  throw new Error(`port ${port} not ready after ${maxAttempts}s`);
}

// ── tunnel (cloudflared → localhost.run fallback) ─────────────────────────────

const CF_URL_RE  = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;
const LR_URL_RE  = /https:\/\/[a-zA-Z0-9-]+\.lhr\.[a-z]+/;
const CF_FAIL_RE = /429|error code: 1015|failed to unmarshal|failed to request/i;
const LR_LOG     = '/tmp/cf-webhook-lr.log';

function tryCloudflared() {
  return new Promise((resolve) => {
    log('trying cloudflared...');
    fs.writeFileSync(TUNNEL_LOG, '');
    const logFd = fs.openSync(TUNNEL_LOG, 'w');
    cloudflaredProc = spawn('cloudflared', [
      'tunnel', '--url', `http://localhost:${WEBHOOK_PORT}`,
      '--no-autoupdate', '--protocol', 'http2',
    ], { stdio: ['ignore', logFd, logFd] });
    fs.closeSync(logFd);

    let settled = false;
    const settle = (url) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      resolve(url);
    };

    cloudflaredProc.on('exit', (code) => { log(`cloudflared exited (code=${code})`); settle(null); });

    const poll = setInterval(() => {
      try {
        const content = fs.readFileSync(TUNNEL_LOG, 'utf8');
        const urlMatch = content.match(CF_URL_RE);
        if (urlMatch) { settle(urlMatch[0]); return; }
        if (CF_FAIL_RE.test(content)) {
          try { cloudflaredProc.kill(); } catch (_) {}
          settle(null);
        }
      } catch (_) {}
    }, 500);
  });
}

function tryLocalhostRun() {
  return new Promise((resolve) => {
    log('falling back to localhost.run...');
    fs.writeFileSync(LR_LOG, '');
    const outFd = fs.openSync(LR_LOG, 'a');
    const errFd = fs.openSync(LR_LOG, 'a');
    const lrProc = spawn('ssh', [
      '-R', `80:localhost:${WEBHOOK_PORT}`,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'BatchMode=yes',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ConnectTimeout=30',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      'nokey@localhost.run',
    ], { stdio: ['ignore', outFd, errFd] });
    fs.closeSync(outFd);
    fs.closeSync(errFd);

    let settled = false;
    const settle = (url) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      if (!url) log('WARNING: no localhost.run URL for webhook — proceeding without tunnel');
      resolve(url || '');
    };

    lrProc.on('error', (err) => { log(`localhost.run spawn error: ${err.message}`); settle(null); });
    lrProc.on('exit', (code) => { log(`localhost.run exited (code=${code})`); settle(null); });

    const poll = setInterval(() => {
      try {
        const content = fs.readFileSync(LR_LOG, 'utf8');
        const m = content.match(LR_URL_RE);
        if (m) settle(m[0]);
      } catch (_) {}
    }, 500);

    setTimeout(() => settle(null), 60_000);
  });
}

async function openTunnel() {
  const url = await tryCloudflared();
  if (url) { log(`webhook tunnel: ${url} (cloudflared)`); return url; }
  const fallback = await tryLocalhostRun();
  if (fallback) log(`webhook tunnel: ${fallback} (localhost.run)`);
  return fallback;
}

// ── PR number wait ────────────────────────────────────────────────────────────

function waitForPrNumber() {
  return new Promise((resolve) => {
    const poll = setInterval(() => {
      try {
        const val = fs.readFileSync(PR_NUMBER_FILE, 'utf8').trim();
        if (val) { clearInterval(poll); resolve(val); }
      } catch (_) {}
    }, 2000);
  });
}

// ── Stale webhook sweep ───────────────────────────────────────────────────────

async function sweepStaleWebhooks() {
  try {
    const hooks = await githubApi('GET', '/hooks');
    if (!Array.isArray(hooks)) return;
    const cloudflareHooks = hooks.filter((h) => h.config?.url?.includes('trycloudflare.com') || h.config?.url?.includes('.lhr.'));
    if (cloudflareHooks.length === 0) return;
    log(`checking ${cloudflareHooks.length} trycloudflare webhook(s) for staleness...`);

    await Promise.all(
      cloudflareHooks.map(async (h) => {
        const url = h.config?.url || '';
        const prMatch = url.match(/[?&]pr=(\d+)/);
        if (prMatch) {
          const pr = prMatch[1];
          // getPrState is defined below — hoisted as a function declaration.
          const state = await getPrState(pr);
          if (state === 'OPEN' || state === 'UNKNOWN') {
            log(`skipping webhook ${h.id} — PR #${pr} is ${state}`);
            return;
          }
          log(`deleting webhook ${h.id} — PR #${pr} is ${state}`);
        } else {
          log(`deleting webhook ${h.id} — no PR tag (legacy or pre-PR)`);
        }
        await githubApi('DELETE', `/hooks/${h.id}`)
          .then(() => log(`deleted stale webhook ${h.id} (${url})`))
          .catch((err) => log(`failed to delete stale webhook ${h.id}: ${err.message}`));
      })
    );
  } catch (err) {
    log(`stale webhook sweep error: ${err.message}`);
  }
}

// ── Webhook registration with retries ────────────────────────────────────────

async function registerWebhook(tunnelUrl, prNumber) {
  const taggedUrl = prNumber ? `${tunnelUrl}?pr=${prNumber}` : tunnelUrl;
  await sweepStaleWebhooks();
  for (let attempt = 1; attempt <= 5; attempt++) {
    const delay = (attempt - 1) * 5000;
    if (delay > 0) {
      log(`webhook registration attempt ${attempt} — waiting ${delay / 1000}s for tunnel to stabilise...`);
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      const hook = await githubApi('POST', '/hooks', {
        name: 'web',
        active: true,
        events: ['issue_comment'],
        config: {
          url: taggedUrl,
          content_type: 'json',
          secret: WEBHOOK_SECRET,
        },
      });
      if (hook && hook.id) {
        log(`registered GitHub webhook ${hook.id} → ${taggedUrl}`);
        return hook.id;
      }
      log(`attempt ${attempt}: response has no id: ${JSON.stringify(hook).slice(0, 200)}`);
    } catch (err) {
      log(`attempt ${attempt}: ${err.message}`);
    }
  }
  return null;
}

// ── PR state polling ──────────────────────────────────────────────────────────

async function getPrState(prNumber) {
  try {
    const pr = await githubApi('GET', `/pulls/${prNumber}`);
    if (pr.merged) return 'MERGED';
    if (pr.state === 'closed') return 'CLOSED';
    return 'OPEN';
  } catch (err) {
    log(`PR state poll error: ${err.message}`);
    return 'UNKNOWN';
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN not set');
  if (!REPO_URL) throw new Error('REPO_URL not set');

  // 1. Start receiver (without PR number yet)
  try { fs.unlinkSync(COMMENT_FLAG); } catch (_) {}
  startReceiver(null);
  await waitForPort(WEBHOOK_PORT);

  // 2. Open tunnel (cloudflared → localhost.run fallback)
  const webhookUrl = await openTunnel();

  // 3. Wait for PR number
  log(`waiting for PR number at ${PR_NUMBER_FILE}...`);
  const prNumber = await waitForPrNumber();
  log(`PR #${prNumber} — restarting receiver with PR_NUMBER`);

  // 4. Restart receiver with PR number
  startReceiver(prNumber);
  await waitForPort(WEBHOOK_PORT);

  // 5. Register webhook (skip if no tunnel URL)
  if (webhookUrl) {
    hookId = await registerWebhook(webhookUrl, prNumber);
    if (!hookId) {
      log('WARNING: webhook registration failed after 5 attempts — polling-only mode');
      log('/feedback comments will NOT be detected; merge/close polling still active');
    }
  } else {
    log('WARNING: no tunnel URL — skipping webhook registration, polling-only mode');
  }

  // 6. Main loop
  let lastMergeCheck = 0;

  const tick = async () => {
    // Check for /feedback comment flag
    try {
      fs.unlinkSync(COMMENT_FLAG);
      log('new feedback comment — emitting feedback event');
      emitEvent('webhook', 'feedback', {});
    } catch (_) {} // normal when flag absent

    // Poll PR state every MERGE_POLL_INTERVAL_MS
    const now = Date.now();
    if (now - lastMergeCheck >= MERGE_POLL_INTERVAL_MS) {
      lastMergeCheck = now;
      const state = await getPrState(prNumber);
      if (state === 'MERGED' || state === 'CLOSED') {
        log(`PR #${prNumber} is ${state} — emitting merged`);
        emitEvent('webhook', 'merged', { state });
        clearInterval(loopHandle);
        // Give the emit a moment to write before exiting.
        setTimeout(() => process.exit(0), 500);
      }
    }
  };

  const loopHandle = setInterval(tick, 1000);
}

main().catch((err) => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
