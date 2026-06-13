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
const https = require('https');
const { spawn, spawnSync } = require('child_process');

const WORKER = process.env.WORKER_INDEX || '1';
const REPO = process.env.REPO_DIR || '/home/worker/repo';
const EMIT_CLI = path.join(REPO, 'muaddib/orchestrator/emit-cli.js');
const STATE_CLI = path.join(REPO, 'muaddib/orchestrator/state-cli.js');

function log(msg) { process.stdout.write(`[start-servers w${WORKER}] ${msg}\n`); }

// ── config loading ────────────────────────────────────────────────────────────

function loadConfig(repoDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoDir, '.muaddib.json'), 'utf8'));
  } catch (_) {
    return {
      projects: [
        { name: 'api',       path: 'projects/api',       devScript: 'npm run api:dev',       port: 8081, seedScript: 'projects/api/scripts/seed-preview.ts' },
        { name: 'portal',    path: 'projects/portal',    devScript: 'npm run portal:dev',    port: 5173 },
        { name: 'homeowner', path: 'projects/homeowner', devScript: 'npm run homeowner:dev', port: 5174 },
      ],
    };
  }
}

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
const LR_URL_RE  = /https:\/\/[a-zA-Z0-9-]+\.lhr\.[a-z]+/;
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

// Probe a tunnel URL via HTTPS (retries up to maxMs). Returns true if reachable.
function probeTunnel(url, maxMs = 30_000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const attempt = () => {
      const req = https.request(url, { method: 'GET', timeout: 5000 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => {
        if (Date.now() - start >= maxMs) return resolve(false);
        setTimeout(attempt, 1000);
      });
      req.on('timeout', () => { req.destroy(); });
      req.end();
    };
    attempt();
  });
}

function spawnLocalhostRunSsh(port, logFile) {
  // If LOCALHOST_RUN_SSH_KEY_FILE is set (path to a private key registered at
  // https://admin.localhost.run/), localhost.run will assign a *stable* custom
  // subdomain so URL stays the same across SSH reconnects.
  // Without a key, each connection gets a new random lhr.life subdomain.
  const keyFile = process.env.LOCALHOST_RUN_SSH_KEY_FILE || '';
  const sshArgs = [
    '-R', `80:localhost:${port}`,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ConnectTimeout=30',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
  ];
  if (keyFile) sshArgs.push('-i', keyFile);
  sshArgs.push('nokey@localhost.run');
  const outFd = fs.openSync(logFile, 'a');
  const proc = spawn('ssh', sshArgs, { stdio: ['ignore', outFd, outFd] });
  fs.closeSync(outFd);
  return proc;
}

function tryLocalhostRun(port, logFile) {
  return new Promise((resolve) => {
    log(`:${port} falling back to localhost.run...`);
    fs.writeFileSync(logFile, '');

    const proc = spawnLocalhostRunSsh(port, logFile);

    let settled = false;
    const settle = (url) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      if (!url) log(`WARNING: no localhost.run URL for :${port} — proceeding empty`);
      resolve(url || '');
    };

    // If SSH exits before we find a URL, give up immediately.
    proc.on('error', (err) => { log(`:${port} localhost.run spawn error: ${err.message}`); settle(null); });
    proc.on('exit', (code) => {
      if (!settled) {
        log(`localhost.run exited (code=${code}) for :${port} before URL was found`);
        settle(null);
      } else {
        // URL already resolved — SSH died after handoff. Restart to keep the
        // pipe alive. NOTE: localhost.run with nokey assigns a new random URL
        // each time, so the URL already in the PR/env will be stale after this
        // restart. A registered SSH key would give a stable subdomain instead.
        log(`:${port} localhost.run SSH exited (code=${code}) after URL was found — restarting (new URL will differ)`);
        fs.appendFileSync(logFile, `\n[restart after exit code=${code}]\n`);
        const next = spawnLocalhostRunSsh(port, logFile);
        next.on('exit', (c) => {
          log(`:${port} localhost.run SSH restart exited (code=${c})`);
        });
      }
    });

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
  if (!fallback) {
    log(`WARNING: :${port} — all tunnel methods failed, URL will be empty`);
    return fallback;
  }

  // Verify the HTTPS URL actually works before declaring it ready.
  log(`:${port} probing localhost.run HTTPS URL (up to 30s)...`);
  const ok = await probeTunnel(fallback, 30_000);
  if (ok) {
    log(`:${port} → ${fallback} (localhost.run, HTTPS verified)`);
  } else {
    log(`WARNING: :${port} → ${fallback} (localhost.run, HTTPS probe FAILED — SSL or routing issue)`);
  }
  return fallback;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const config = loadConfig(REPO);
  const apiProject = config.projects.find((p) => p.seedScript);
  if (!apiProject) throw new Error('No API project (with seedScript) found in .muaddib.json');
  const frontendProjects = config.projects.filter((p) => !p.seedScript && p.devScript);

  // 1. Migrations
  log('running migrations...');
  runSync('npm', ['run', '--prefix', apiProject.path, 'migrate:up']);

  // 2. Preview seed
  log('running preview seed...');
  const seedResult = spawnSync(
    'npx', ['--prefix', apiProject.path, 'tsx', apiProject.seedScript],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
  );

  let previewEmail = '(seed failed — see /tmp/seed-preview.log)';
  let previewPassword = '';
  let hoMagicLink = '';
  try {
    if (seedResult.stderr) fs.writeFileSync('/tmp/seed-preview.log', seedResult.stderr);
    const lines = (seedResult.stdout || '').toString().trim().split('\n');
    const json = JSON.parse(lines[lines.length - 1]);
    previewEmail    = json.email               || previewEmail;
    previewPassword = json.password            || '';
    hoMagicLink     = json.homeowner_magic_link || '';
  } catch (_) {}

  // 3. API dev server
  log('starting API dev server...');
  startWithRestart('sh', ['-c', apiProject.devScript], '/tmp/preview-api.log');
  await waitForPort(apiProject.port);
  log(`API server ready on :${apiProject.port}`);

  // 4. API tunnel (needed before frontends so VITE_API_URL is known)
  const apiTunnelUrl = await openTunnel(apiProject.port, '/tmp/cf-api.log', '/tmp/lr-api.log');

  // 5. Frontend dev servers
  if (frontendProjects.length > 0) {
    log('starting frontend dev servers...');
    for (const p of frontendProjects) {
      startWithRestart('sh', ['-c', p.devScript], `/tmp/preview-${p.name}.log`, { env: { VITE_API_URL: apiTunnelUrl } });
    }
    const frontendPorts = frontendProjects.filter((p) => p.port).map((p) => p.port);
    if (frontendPorts.length > 0) {
      log(`waiting for frontend servers on :${frontendPorts.join(' and :')} (up to 60 s)...`);
      await Promise.all(frontendPorts.map((port) => waitForPort(port)));
      log(`frontend servers ready on :${frontendPorts.join(' and :')}`);
    }
  }

  // 6. Frontend tunnels (parallel — independent ports)
  const frontendUrlMap = new Map();
  await Promise.all(
    frontendProjects.filter((p) => p.port).map(async (p) => {
      const url = await openTunnel(p.port, `/tmp/cf-${p.name}.log`, `/tmp/lr-${p.name}.log`);
      frontendUrlMap.set(p.name, url);
    }),
  );

  // Backwards-compat aliases for skills that reference portal_url / ho_url
  const portalUrl = frontendUrlMap.get('portal') || '';
  const hoUrl     = frontendUrlMap.get('homeowner') || '';

  // 7. Write shared env file and worker state
  const URLS_FILE = `/tmp/preview-urls-${WORKER}.env`;
  const envLines = [`API_TUNNEL_URL=${apiTunnelUrl}`];
  for (const p of frontendProjects.filter((fp) => fp.port)) {
    envLines.push(`${p.name.toUpperCase()}_URL=${frontendUrlMap.get(p.name) || ''}`);
  }
  envLines.push(`HO_URL=${hoUrl}`);
  envLines.push(`PREVIEW_EMAIL=${previewEmail}`);
  envLines.push(`PREVIEW_PASSWORD=${previewPassword}`);
  envLines.push(`HO_MAGIC_LINK=${hoMagicLink}`);
  fs.writeFileSync(URLS_FILE, envLines.join('\n') + '\n');
  log(`wrote ${URLS_FILE}`);

  spawnSync('node', [STATE_CLI, WORKER, 'set', 'api_tunnel_url', apiTunnelUrl], { stdio: 'inherit' });
  for (const p of frontendProjects.filter((fp) => fp.port)) {
    spawnSync('node', [STATE_CLI, WORKER, 'set', `${p.name}_url`, frontendUrlMap.get(p.name) || ''], { stdio: 'inherit' });
  }
  // ho_url aliases homeowner_url for existing skills
  spawnSync('node', [STATE_CLI, WORKER, 'set', 'ho_url', hoUrl], { stdio: 'inherit' });

  // 8. Signal orchestrator
  log('emitting tunnel_ready');
  spawnSync('node', [EMIT_CLI, WORKER, 'servers', 'tunnel_ready',
    JSON.stringify({ api: apiTunnelUrl, portal: portalUrl, homeowner: hoUrl }),
  ], { stdio: 'inherit' });

  log('servers running');
  // Keep this process alive so spawned dev servers stay running.
  setInterval(() => {}, 30_000);
}

module.exports = { _loadConfig: loadConfig };

if (require.main === module) {
  main().catch((err) => {
    log(`FATAL: ${err.message}`);
    process.exit(1);
  });
}
