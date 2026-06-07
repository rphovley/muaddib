#!/usr/bin/env node
'use strict';
// Dispatch daemon — watches a Linear webhook and auto-routes new issues
// to worker containers based on their labels.
//
// Required env: LINEAR_API_KEY, LINEAR_TEAM_ID, DISPATCH_WEBHOOK_SECRET
// Optional env: DISPATCH_PORT (default 3999), MAX_DISPATCH_WORKERS (default 8)
//
// Start:  ./dispatch.sh          (foreground)
//         ./dispatch.sh --bg     (background, PID in .muaddib-dispatch.pid)
// Stop:   ./dispatch.sh --stop

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFile } = require('child_process');

const { registerWebhook, deregisterWebhook, verifySignature } = require('./linear-webhook');
const { isDispatched, markDispatched, enqueue, flush } = require('./dispatch-queue');

const REPO_ROOT = process.env.REPO_ROOT || path.join(__dirname, '../..');
const FLEET_DIR = path.join(REPO_ROOT, 'muaddib');
const SPAWN_WORKER = path.join(FLEET_DIR, 'bin/spawn-worker.sh');
const TUNNEL_LOG = '/tmp/cf-dispatch.log';

const PORT = parseInt(process.env.DISPATCH_PORT || '3999', 10);
const SECRET = process.env.DISPATCH_WEBHOOK_SECRET || '';
const LINEAR_TEAM_ID = process.env.LINEAR_TEAM_ID || '';
const MAX_WORKERS = parseInt(process.env.MAX_DISPATCH_WORKERS || '8', 10);

let webhookId = null;
let cloudflaredProc = null;
let flushInterval = null;
let server = null;

function log(msg) {
  process.stdout.write(`[dispatch-daemon] ${msg}\n`);
}

// ─── env validation ───────────────────────────────────────────────────────────

function validateEnv() {
  const missing = [];
  if (!process.env.LINEAR_API_KEY) missing.push('LINEAR_API_KEY');
  if (!LINEAR_TEAM_ID) missing.push('LINEAR_TEAM_ID');
  if (!SECRET) missing.push('DISPATCH_WEBHOOK_SECRET');
  if (missing.length > 0) throw new Error(`Missing required env: ${missing.join(', ')}`);
}

// ─── cloudflared ──────────────────────────────────────────────────────────────

function startCloudflared() {
  return new Promise((resolve, reject) => {
    try { fs.unlinkSync(TUNNEL_LOG); } catch (_) {}
    const logFd = fs.openSync(TUNNEL_LOG, 'w');
    cloudflaredProc = spawn('cloudflared', [
      'tunnel', '--url', `http://localhost:${PORT}`,
      '--no-autoupdate', '--protocol', 'http2',
    ], { stdio: ['ignore', logFd, logFd] });
    fs.closeSync(logFd);

    cloudflaredProc.on('exit', (code) => log(`cloudflared exited (code=${code})`));

    const start = Date.now();
    const poll = setInterval(() => {
      if (Date.now() - start > 60_000) {
        clearInterval(poll);
        reject(new Error('cloudflared tunnel URL not found after 60s'));
        return;
      }
      try {
        const content = fs.readFileSync(TUNNEL_LOG, 'utf8');
        const m = content.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (m) { clearInterval(poll); resolve(m[0]); }
      } catch (_) {}
    }, 1000);
  });
}

// ─── worker slot counting ─────────────────────────────────────────────────────

function getActiveWorkerProjects() {
  return new Promise((resolve) => {
    execFile('docker', ['ps', '--format', '{{.Labels}}'], (err, stdout) => {
      if (err) { resolve(new Set()); return; }
      const projects = new Set();
      for (const line of stdout.split('\n')) {
        const m = line.match(/com\.docker\.compose\.project=(quotethat-w\d+)/);
        if (m) projects.add(m[1]);
      }
      resolve(projects);
    });
  });
}

async function countActiveWorkers() {
  return (await getActiveWorkerProjects()).size;
}

async function findNextFreeWorker() {
  const projects = await getActiveWorkerProjects();
  const used = new Set();
  for (const p of projects) {
    const m = p.match(/quotethat-w(\d+)/);
    if (m) used.add(parseInt(m[1], 10));
  }
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

// ─── routing table ────────────────────────────────────────────────────────────

function resolveRoute(labels) {
  if (labels.includes('muaddib:skip')) return null;
  if (!labels.includes('auto')) return null;
  if (['bug', 'fix', 'defect'].some((t) => labels.includes(t))) {
    return { entryPoint: 'muaddib.sh', workflowFile: path.join(FLEET_DIR, 'workflows/bug.json') };
  }
  if (labels.includes('muaddib:fast') || labels.includes('fast')) {
    return { entryPoint: 'muaddib-fast.sh', workflowFile: path.join(FLEET_DIR, 'workflows/feature-fast.json') };
  }
  if (labels.includes('muaddib:plan') || labels.includes('plan-only')) {
    return { entryPoint: 'muaddib-plan.sh', workflowFile: path.join(FLEET_DIR, 'workflows/plan.json') };
  }
  return { entryPoint: 'muaddib.sh', workflowFile: path.join(FLEET_DIR, 'workflows/feature.json') };
}

// ─── spawn ────────────────────────────────────────────────────────────────────

async function trySpawn(entry) {
  const count = await countActiveWorkers();
  if (count >= MAX_WORKERS) return false;
  const n = await findNextFreeWorker();

  // Mark dispatched immediately — prevents duplicate dispatch while provisioning.
  markDispatched(entry.ticketId);

  const env = { ...process.env, MUADIB_NO_ATTACH: '1' };
  if (entry.workflowFile) env.WORKFLOW_FILE = entry.workflowFile;

  // spawn-worker.sh blocks until the container reaches READY/RUNNING (up to 5 min).
  // Run it detached so the daemon stays responsive to incoming events.
  const proc = spawn(SPAWN_WORKER, [String(n), `/muaddib ${entry.ticketId}`], {
    env,
    stdio: 'ignore',
    detached: true,
  });
  proc.unref();

  log(`dispatched ${entry.ticketId} → worker ${n} (${entry.entryPoint})`);
  return true;
}

// ─── event handler ────────────────────────────────────────────────────────────

async function handleEvent(rawBody) {
  let payload;
  try {
    payload = JSON.parse(rawBody.toString());
  } catch (_) {
    return;
  }

  const { action, type, data } = payload;
  if (type !== 'Issue') return;

  const identifier = data && data.identifier;
  if (!identifier) return;

  // For updates, skip if this was not a label change.
  if (action === 'update') {
    const prevLabelIds = data.updatedFrom && data.updatedFrom.labelIds;
    if (!prevLabelIds) {
      log(`${identifier}: update without label change — skipped`);
      return;
    }
    const curLabelIds = data.labelIds || [];
    if ([...prevLabelIds].sort().join(',') === [...curLabelIds].sort().join(',')) {
      log(`${identifier}: labels unchanged — skipped`);
      return;
    }
  }

  const labelNodes = (data.labels && data.labels.nodes) || [];
  const labels = labelNodes.map((l) => l.name.toLowerCase());

  const route = resolveRoute(labels);
  if (!route) {
    log(`${identifier}: no route matched (labels: ${labels.join(', ') || 'none'}) — skipped`);
    return;
  }

  if (isDispatched(identifier)) {
    log(`${identifier}: already dispatched — skipped`);
    return;
  }

  const count = await countActiveWorkers();
  if (count >= MAX_WORKERS) {
    log(`${identifier}: ${count}/${MAX_WORKERS} slots occupied — queued`);
    enqueue(identifier, route.entryPoint, route.workflowFile);
    return;
  }

  await trySpawn({ ticketId: identifier, entryPoint: route.entryPoint, workflowFile: route.workflowFile });
}

// ─── graceful shutdown ────────────────────────────────────────────────────────

async function shutdown() {
  log('shutting down...');
  if (flushInterval) clearInterval(flushInterval);
  if (server) { try { server.close(); } catch (_) {} }
  if (webhookId) {
    log(`deregistering Linear webhook ${webhookId}...`);
    try { await deregisterWebhook(webhookId); } catch (err) {
      log(`deregisterWebhook error: ${err.message}`);
    }
  }
  if (cloudflaredProc) { try { cloudflaredProc.kill(); } catch (_) {} }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  validateEnv();

  // 1. Start HTTP server (before cloudflared, so the port is ready to tunnel)
  server = http.createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(200); res.end('ok'); return; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks);

      // ACK immediately — Linear requires a fast 200.
      res.writeHead(200);
      res.end('ok');

      const sig = req.headers['linear-signature'] || '';
      if (!verifySignature(rawBody, sig, SECRET)) {
        log('invalid linear-signature — rejected');
        return;
      }

      handleEvent(rawBody).catch((err) => log(`handleEvent error: ${err.message}`));
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, () => { log(`listening on :${PORT}`); resolve(); });
  });

  // 2. Start cloudflared tunnel
  log('starting cloudflared tunnel...');
  const tunnelUrl = await startCloudflared();
  log(`tunnel: ${tunnelUrl}`);

  // 3. Register Linear webhook
  log(`registering Linear webhook for team ${LINEAR_TEAM_ID}...`);
  const result = await registerWebhook(LINEAR_TEAM_ID, tunnelUrl, SECRET);
  webhookId = result.webhookId;
  log(`webhook registered: ${webhookId}`);

  // 4. Start overflow-queue flush interval (every 30 s)
  flushInterval = setInterval(() => {
    flush(trySpawn).catch((err) => log(`flush error: ${err.message}`));
  }, 30_000);

  log(`ready — port ${PORT}, max workers ${MAX_WORKERS}`);
}

main().catch((err) => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
