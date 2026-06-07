#!/usr/bin/env node
'use strict';
// Servers job — started by the orchestrator at container boot.
// Runs DB migrations, preview seed, starts API + frontend dev servers, and
// opens tunnels. Tries cloudflared first; on 429 or any immediate failure
// falls back to localhost.run (SSH, no binary required).
// Emits tunnel_ready when all URLs are confirmed, then keeps background
// processes alive until the container exits.
//
// Required env: WORKER_INDEX

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const WORKER = process.env.WORKER_INDEX || '1';
const REPO = process.env.REPO_DIR || '/home/worker/repo';
const EMIT_CLI = path.join(REPO, 'muaddib/orchestrator/emit-cli.js');
const STATE_CLI = path.join(REPO, 'muaddib/orchestrator/state-cli.js');

function log(msg) { process.stdout.write(`[start-servers w${WORKER}] ${msg}\n`); }

// ── subprocess helpers ────────────────────────────────────────────────────────

// Run a command synchronously; inherits stdio so output appears in the job log.
function runSync(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: REPO, env: { ...process.env, ...opts.env } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}`);
}

// Spawn a background process writing stdout+stderr to logFile.
function startBg(cmd, args, logFile, opts = {}) {
  const fd = fs.openSync(logFile, 'w');
  const proc = spawn(cmd, args, {
    stdio: ['ignore', fd, fd],
    cwd: REPO,
    env: { ...process.env, ...opts.env },
  });
  fs.closeSync(fd);
  return proc;
}

// Like startBg but restarts the process 2 s after each exit.
function startWithRestart(cmd, args, logFile, opts = {}) {
  const go = () => {
    const proc = startBg(cmd, args, logFile, opts);
    proc.on('exit', (code) => {
      log(`${path.basename(logFile)} exited (code=${code}), restarting in 2 s...`);
      setTimeout(go, 2000);
    });
  };
  go();
}

// ── port readiness ────────────────────────────────────────────────────────────

function waitForPort(port, maxMs = 60_000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const s = net.createConnection(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(); });
      s.on('error', () => {
        if (Date.now() - start >= maxMs) {
          log(`WARNING: port ${port} not ready after ${maxMs}ms — continuing`);
          return resolve();
        }
        setTimeout(check, 1000);
      });
    };
    check();
  });
}

// ── tunnel helpers ────────────────────────────────────────────────────────────

const CF_URL_RE  = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;
const LR_URL_RE  = /https:\/\/[a-zA-Z0-9-]+\.lhr\.rocks/;
const CF_FAIL_RE = /429|error code: 1015|failed to unmarshal|failed to request/i;

function tryCloudflared(port, logFile) {
  return new Promise((resolve) => {
    log(`:${port} trying cloudflared...`);
    fs.writeFileSync(logFile, '');
    const proc = startBg('cloudflared', [
      'tunnel', '--url', `http://localhost:${port}`,
      '--no-autoupdate', '--protocol', 'http2',
    ], logFile);

    let settled = false;
    const settle = (url) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      resolve(url);
    };

    proc.on('exit', () => settle(null));

    const poll = setInterval(() => {
      try {
        const content = fs.readFileSync(logFile, 'utf8');
        const urlMatch = content.match(CF_URL_RE);
        if (urlMatch) { settle(urlMatch[0]); return; }
        if (CF_FAIL_RE.test(content)) {
          try { proc.kill(); } catch (_) {}
          settle(null);
        }
      } catch (_) {}
    }, 500);
  });
}

function tryLocalhostRun(port, logFile) {
  return new Promise((resolve) => {
    log(`:${port} falling back to localhost.run...`);
    fs.writeFileSync(logFile, '');

    const outFd = fs.openSync(logFile, 'a');
    const errFd = fs.openSync(logFile, 'a');
    const proc = spawn('ssh', [
      '-R', `80:localhost:${port}`,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'BatchMode=yes',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ConnectTimeout=30',
      'nokey@localhost.run',
    ], { stdio: ['ignore', outFd, errFd] });
    fs.closeSync(outFd);
    fs.closeSync(errFd);

    let settled = false;
    const settle = (url) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      if (!url) log(`WARNING: no localhost.run URL for :${port} — proceeding empty`);
      resolve(url || '');
    };

    proc.on('error', (err) => { log(`:${port} localhost.run spawn error: ${err.message}`); settle(null); });
    proc.on('exit', (code) => { log(`localhost.run exited (code=${code}) for :${port}`); settle(null); });

    const poll = setInterval(() => {
      try {
        const content = fs.readFileSync(logFile, 'utf8');
        const m = content.match(LR_URL_RE);
        if (m) settle(m[0]);
      } catch (_) {}
    }, 500);

    setTimeout(() => settle(null), 60_000);
  });
}

async function openTunnel(port, cfLog, lrLog) {
  const url = await tryCloudflared(port, cfLog);
  if (url) {
    log(`:${port} → ${url} (cloudflared)`);
    return url;
  }
  const fallback = await tryLocalhostRun(port, lrLog);
  if (fallback) log(`:${port} → ${fallback} (localhost.run)`);
  return fallback;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Migrations
  log('running migrations...');
  runSync('npm', ['run', '--prefix', 'projects/api', 'migrate:up']);

  // 2. Preview seed
  log('running preview seed...');
  const seedResult = spawnSync(
    'npx', ['--prefix', 'projects/api', 'tsx', 'projects/api/scripts/seed-preview.ts'],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
  );

  let previewEmail = '(seed failed — see /tmp/seed-preview.log)';
  let previewPassword = '';
  let hoMagicLink = '';
  try {
    if (seedResult.stderr) fs.writeFileSync('/tmp/seed-preview.log', seedResult.stderr);
    const lines = (seedResult.stdout || '').toString().trim().split('\n');
    const json = JSON.parse(lines[lines.length - 1]);
    previewEmail   = json.email              || previewEmail;
    previewPassword = json.password          || '';
    hoMagicLink    = json.homeowner_magic_link || '';
  } catch (_) {}

  // 3. API dev server
  log('starting API dev server...');
  startWithRestart('npm', ['run', 'api:dev'], '/tmp/preview-api.log');
  await waitForPort(8081);
  log('API server ready on :8081');

  // 4. API tunnel (needed before frontends so VITE_API_URL is known)
  const apiTunnelUrl = await openTunnel(8081, '/tmp/cf-api.log', '/tmp/lr-api.log');

  // 5. Frontend dev servers
  log('starting frontend dev servers...');
  startWithRestart('npm', ['run', 'portal:dev'],    '/tmp/preview-portal.log',    { env: { VITE_API_URL: apiTunnelUrl } });
  startWithRestart('npm', ['run', 'homeowner:dev'], '/tmp/preview-homeowner.log', { env: { VITE_API_URL: apiTunnelUrl } });
  log('waiting for frontend servers on :5173 and :5174 (up to 60 s)...');
  await Promise.all([waitForPort(5173), waitForPort(5174)]);
  log('frontend servers ready on :5173 and :5174');

  // 6. Frontend tunnels (parallel — independent ports)
  const [portalUrl, hoUrl] = await Promise.all([
    openTunnel(5173, '/tmp/cf-portal.log',    '/tmp/lr-portal.log'),
    openTunnel(5174, '/tmp/cf-homeowner.log', '/tmp/lr-homeowner.log'),
  ]);

  // 7. Write shared env file and worker state
  const URLS_FILE = `/tmp/preview-urls-${WORKER}.env`;
  fs.writeFileSync(URLS_FILE, [
    `API_TUNNEL_URL=${apiTunnelUrl}`,
    `PORTAL_URL=${portalUrl}`,
    `HO_URL=${hoUrl}`,
    `PREVIEW_EMAIL=${previewEmail}`,
    `PREVIEW_PASSWORD=${previewPassword}`,
    `HO_MAGIC_LINK=${hoMagicLink}`,
  ].join('\n') + '\n');
  log(`wrote ${URLS_FILE}`);

  for (const [key, val] of [['api_tunnel_url', apiTunnelUrl], ['portal_url', portalUrl], ['ho_url', hoUrl]]) {
    spawnSync('node', [STATE_CLI, WORKER, 'set', key, val], { stdio: 'inherit' });
  }

  // 8. Signal orchestrator
  log('emitting tunnel_ready');
  spawnSync('node', [EMIT_CLI, WORKER, 'servers', 'tunnel_ready',
    JSON.stringify({ api: apiTunnelUrl, portal: portalUrl, homeowner: hoUrl }),
  ], { stdio: 'inherit' });

  log('servers running');
  // Keep this process alive so spawned dev servers stay running.
  setInterval(() => {}, 30_000);
}

main().catch((err) => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
