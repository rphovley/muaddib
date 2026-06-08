#!/usr/bin/env node
"use strict";
// Dispatch daemon — watches a Linear webhook and auto-routes new issues
// to worker containers based on their labels.
//
// Required env: LINEAR_API_KEY, LINEAR_TEAM_ID
// Optional env: DISPATCH_WEBHOOK_SECRET (auto-generated if unset), DISPATCH_PORT (default 3999), MAX_DISPATCH_WORKERS (default 8)
//
// Start:  ./dispatch.sh          (foreground)
//         ./dispatch.sh --bg     (background, PID in .muaddib-dispatch.pid)
// Stop:   ./dispatch.sh --stop

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execFile } = require("child_process");

const {
  registerWebhook,
  deregisterWebhook,
  verifySignature,
} = require("./linear-webhook");
const {
  isDispatched,
  markDispatched,
  unmarkDispatched,
  enqueue,
  flush,
} = require("./dispatch-queue");

const REPO_ROOT = process.env.REPO_ROOT || path.join(__dirname, "../..");
const FLEET_DIR = path.join(REPO_ROOT, "muaddib");
const SPAWN_WORKER = path.join(FLEET_DIR, "bin/spawn-worker.sh");

const MUADDIB_CONFIG = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ".muaddib.json"), "utf8"));
  } catch (_) {
    return { projectName: "quotethat" };
  }
})();
const PROJECT_NAME = MUADDIB_CONFIG.projectName || "quotethat";
const TUNNEL_LOG = "/tmp/cf-dispatch.log";
const LR_LOG = "/tmp/lr-dispatch.log";

const CF_URL_RE = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;
const LR_URL_RE = /https:\/\/[a-zA-Z0-9-]+\.lhr\.[a-z]+/;
const CF_FAIL_RE = /429|error code: 1015|failed to unmarshal|failed to request/i;

const PORT = parseInt(process.env.DISPATCH_PORT || "3999", 10);
const SECRET =
  process.env.DISPATCH_WEBHOOK_SECRET ||
  require("crypto").randomBytes(32).toString("hex");
const LINEAR_TEAM_ID = process.env.LINEAR_TEAM_ID || "";
const MAX_WORKERS = parseInt(process.env.MAX_DISPATCH_WORKERS || "8", 10);

let webhookId = null;
let tunnelProc = null;
let flushInterval = null;
let server = null;

function log(msg) {
  process.stdout.write(`[dispatch-daemon] ${msg}\n`);
}

// ─── env validation ───────────────────────────────────────────────────────────

function validateEnv() {
  const missing = [];
  if (!process.env.LINEAR_API_KEY) missing.push("LINEAR_API_KEY");
  if (!LINEAR_TEAM_ID) missing.push("LINEAR_TEAM_ID");
  if (missing.length > 0)
    throw new Error(`Missing required env: ${missing.join(", ")}`);
}

// ─── tunnel (cloudflared with localhost.run fallback) ─────────────────────────

function tryCloudflared(port, logFile) {
  return new Promise((resolve) => {
    log("trying cloudflared...");
    fs.writeFileSync(logFile, "");
    const logFd = fs.openSync(logFile, "w");
    const proc = spawn(
      "cloudflared",
      ["tunnel", "--url", `http://localhost:${port}`, "--no-autoupdate", "--protocol", "http2"],
      { stdio: ["ignore", logFd, logFd] },
    );
    fs.closeSync(logFd);
    tunnelProc = proc;

    let settled = false;
    const settle = (url) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      resolve(url);
    };

    proc.on("exit", (code) => {
      log(`cloudflared exited (code=${code})`);
      settle(null);
    });

    const poll = setInterval(() => {
      try {
        const content = fs.readFileSync(logFile, "utf8");
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
    log("falling back to localhost.run...");
    fs.writeFileSync(logFile, "");
    const outFd = fs.openSync(logFile, "a");
    const errFd = fs.openSync(logFile, "a");
    const proc = spawn("ssh", [
      "-R", `80:localhost:${port}`,
      "-o", "StrictHostKeyChecking=no",
      "-o", "BatchMode=yes",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ConnectTimeout=30",
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=3",
      "nokey@localhost.run",
    ], { stdio: ["ignore", outFd, errFd] });
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    tunnelProc = proc;

    let settled = false;
    const settle = (url) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      if (!url) log("WARNING: no localhost.run URL — proceeding empty");
      resolve(url || "");
    };

    proc.on("error", (err) => { log(`localhost.run spawn error: ${err.message}`); settle(null); });
    proc.on("exit", (code) => { log(`localhost.run exited (code=${code})`); settle(null); });

    const poll = setInterval(() => {
      try {
        const content = fs.readFileSync(logFile, "utf8");
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
    log(`tunnel: ${url} (cloudflared)`);
    return url;
  }
  const fallback = await tryLocalhostRun(port, lrLog);
  if (fallback) log(`tunnel: ${fallback} (localhost.run)`);
  if (!fallback) log("WARNING: all tunnel methods failed — URL will be empty");
  return fallback;
}

// ─── worker slot counting ─────────────────────────────────────────────────────

function getActiveWorkerProjects() {
  return new Promise((resolve) => {
    execFile("docker", ["ps", "--format", "{{.Labels}}"], (err, stdout) => {
      if (err) {
        resolve(new Set());
        return;
      }
      const projects = new Set();
      const workerRe = new RegExp(`com\\.docker\\.compose\\.project=(${PROJECT_NAME}-w\\d+)`);
      for (const line of stdout.split("\n")) {
        const m = line.match(workerRe);
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
  const indexRe = new RegExp(`${PROJECT_NAME}-w(\\d+)`);
  for (const p of projects) {
    const m = p.match(indexRe);
    if (m) used.add(parseInt(m[1], 10));
  }
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

// ─── status-file cleanup ─────────────────────────────────────────────────────

function _getWorkerIndicesInDir(statusDir) {
  const indices = new Set();
  let entries;
  try {
    entries = fs.readdirSync(statusDir);
  } catch (_) {
    return indices;
  }
  const re = /^(?:worker-(\d+)[-.]|\.skills-(\d+)$)/;
  for (const entry of entries) {
    const m = entry.match(re);
    if (!m) continue;
    const n = parseInt(m[1] !== undefined ? m[1] : m[2], 10);
    indices.add(n);
  }
  return indices;
}

function _getWorkerFiles(statusDir, n) {
  let entries;
  try {
    entries = fs.readdirSync(statusDir);
  } catch (_) {
    return [];
  }
  const re = new RegExp(`^(?:worker-${n}[-.]|\\.skills-${n}$)`);
  return entries
    .filter((e) => re.test(e))
    .map((e) => path.join(statusDir, e));
}

function cleanupWorkerFiles(statusDir, activeIndices) {
  const allIndices = _getWorkerIndicesInDir(statusDir);
  for (const n of allIndices) {
    if (activeIndices.has(n)) continue;
    const stateFile = path.join(statusDir, `worker-${n}.state`);
    let state = "";
    try {
      state = (fs.readFileSync(stateFile, "utf8").trim().split(/\s+/)[0] || "");
    } catch (_) {}
    const workerFiles = _getWorkerFiles(statusDir, n);
    if (state === "FAILED") {
      const d = new Date();
      const pad = (x) => String(x).padStart(2, "0");
      const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      const dest = path.join(statusDir, "failed", `worker-${n}-${ts}`);
      fs.mkdirSync(dest, { recursive: true });
      for (const f of workerFiles) {
        try {
          fs.renameSync(f, path.join(dest, path.basename(f)));
        } catch (_) {}
      }
    } else {
      for (const f of workerFiles) {
        try {
          const stat = fs.statSync(f);
          if (stat.isDirectory()) {
            fs.rmSync(f, { recursive: true, force: true });
          } else {
            fs.unlinkSync(f);
          }
        } catch (_) {}
      }
    }
  }
}

async function cleanupOrphanedStatusFiles() {
  const statusDir = path.join(FLEET_DIR, "status");
  const activeProjects = await getActiveWorkerProjects();
  const indexRe = new RegExp(`${PROJECT_NAME}-w(\\d+)`);
  const activeIndices = new Set();
  for (const p of activeProjects) {
    const m = p.match(indexRe);
    if (m) activeIndices.add(parseInt(m[1], 10));
  }
  cleanupWorkerFiles(statusDir, activeIndices);
}

// ─── routing table ────────────────────────────────────────────────────────────

function resolveRoute(labels) {
  if (labels.includes("muaddib:skip")) return null;
  if (!labels.includes("auto")) return null;
  if (["bug", "fix", "defect"].some((t) => labels.includes(t))) {
    return {
      entryPoint: "muaddib.sh",
      workflowFile: path.join(FLEET_DIR, "workflows/bug.json"),
    };
  }
  if (labels.includes("muaddib:fast") || labels.includes("fast")) {
    return {
      entryPoint: "muaddib-fast.sh",
      workflowFile: path.join(FLEET_DIR, "workflows/feature-fast.json"),
    };
  }
  if (labels.includes("muaddib:plan") || labels.includes("plan")) {
    return {
      entryPoint: "muaddib-plan.sh",
      workflowFile: path.join(FLEET_DIR, "workflows/plan.json"),
    };
  }
  return {
    entryPoint: "muaddib.sh",
    workflowFile: path.join(FLEET_DIR, "workflows/feature.json"),
  };
}

// ─── spawn ────────────────────────────────────────────────────────────────────

async function trySpawn(entry) {
  const count = await countActiveWorkers();
  if (count >= MAX_WORKERS) return false;
  const n = await findNextFreeWorker();

  // Mark dispatched immediately — prevents duplicate dispatch while provisioning.
  markDispatched(entry.ticketId);

  const env = { ...process.env, MUADIB_NO_ATTACH: "1" };
  if (entry.workflowFile) env.WORKFLOW_FILE = entry.workflowFile;

  // spawn-worker.sh blocks until the container reaches READY/RUNNING (up to 5 min).
  // Run it detached so the daemon stays responsive to incoming events.
  const proc = spawn(SPAWN_WORKER, [String(n), `/muaddib ${entry.ticketId}`], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });

  // Collect stderr so failures are visible in the daemon log.
  let stderr = "";
  proc.stderr.on("data", (d) => {
    stderr += d.toString();
  });

  // If spawn-worker.sh exits non-zero at any point, the container never started
  // successfully — unmark so the next webhook event can retry.
  proc.once("exit", (code) => {
    if (code !== 0 && code !== null) {
      unmarkDispatched(entry.ticketId);
      log(
        `${entry.ticketId}: spawn-worker.sh failed (exit ${code}) — unmarked, will retry on next event` +
          (stderr.trim() ? `\n${stderr.trim()}` : ""),
      );
    }
  });

  proc.unref();

  log(`dispatched ${entry.ticketId} → worker ${n} (${entry.entryPoint})`);
  log(`attach: npm run muaddib:attach ${n}`);
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

  const { action, type, data, updatedFrom } = payload;
  if (type !== "Issue") return;

  const identifier = data && data.identifier;
  if (!identifier) return;

  // For updates, skip if this was not a label change.
  if (action === "update") {
    const prevLabelIds = updatedFrom && updatedFrom.labelIds;
    if (!prevLabelIds) {
      log(`${identifier}: update without label change — skipped`);
      return;
    }
    const curLabelIds = data.labelIds || [];
    if (
      [...prevLabelIds].sort().join(",") === [...curLabelIds].sort().join(",")
    ) {
      log(`${identifier}: labels unchanged — skipped`);
      return;
    }
  }

  // Assignee guard: if DISPATCH_ASSIGNEE_ID is set, only dispatch tickets
  // assigned to that Linear user. Prevents every machine from picking up the
  // same ticket when multiple dispatchers are running.
  const dispatchAssigneeId = process.env.DISPATCH_ASSIGNEE_ID || "";
  if (dispatchAssigneeId) {
    const assigneeId = data.assignee && data.assignee.id;
    if (assigneeId !== dispatchAssigneeId) {
      log(
        `${identifier}: assignee ${assigneeId || "unset"} ≠ DISPATCH_ASSIGNEE_ID — skipped`,
      );
      return;
    }
  }

  const labelNodes = Array.isArray(data.labels)
    ? data.labels
    : (data.labels && data.labels.nodes) || [];
  const labels = labelNodes.map((l) => l.name.toLowerCase());

  const route = resolveRoute(labels);
  if (!route) {
    log(
      `${identifier}: no route matched (labels: ${labels.join(", ") || "none"}) — skipped`,
    );
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

  await trySpawn({
    ticketId: identifier,
    entryPoint: route.entryPoint,
    workflowFile: route.workflowFile,
  });
}

// ─── graceful shutdown ────────────────────────────────────────────────────────

async function shutdown() {
  log("shutting down...");
  if (flushInterval) clearInterval(flushInterval);
  if (server) {
    try {
      server.close();
    } catch (_) {}
  }
  if (webhookId) {
    log(`deregistering Linear webhook ${webhookId}...`);
    try {
      await deregisterWebhook(webhookId);
    } catch (err) {
      log(`deregisterWebhook error: ${err.message}`);
    }
  }
  if (tunnelProc) {
    try {
      tunnelProc.kill();
    } catch (_) {}
  }
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  validateEnv();

  // 1. Start HTTP server (before cloudflared, so the port is ready to tunnel)
  server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(200);
      res.end("ok");
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks);

      // ACK immediately — Linear requires a fast 200.
      res.writeHead(200);
      res.end("ok");

      const sig = req.headers["linear-signature"] || "";
      if (!verifySignature(rawBody, sig, SECRET)) {
        log("invalid linear-signature — rejected");
        return;
      }

      handleEvent(rawBody).catch((err) =>
        log(`handleEvent error: ${err.message}`),
      );
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, () => {
      log(`listening on :${PORT}`);
      resolve();
    });
  });

  // 2. Start tunnel (cloudflared with localhost.run fallback)
  log("starting tunnel...");
  const tunnelUrl = await openTunnel(PORT, TUNNEL_LOG, LR_LOG);

  // 3. Register Linear webhook
  log(`registering Linear webhook for team ${LINEAR_TEAM_ID}...`);
  const result = await registerWebhook(LINEAR_TEAM_ID, tunnelUrl, SECRET);
  webhookId = result.webhookId;
  log(`webhook registered: ${webhookId}`);

  // 4. Start overflow-queue flush interval (every 30 s)
  flushInterval = setInterval(() => {
    flush(trySpawn).catch((err) => log(`flush error: ${err.message}`));
    cleanupOrphanedStatusFiles().catch((err) =>
      log(`cleanup error: ${err.message}`),
    );
  }, 30_000);

  log(`ready — port ${PORT}, max workers ${MAX_WORKERS}`);
}

module.exports = { resolveRoute, handleEvent, cleanupWorkerFiles, cleanupOrphanedStatusFiles };

if (require.main === module) {
  main().catch((err) => {
    log(`FATAL: ${err.message}`);
    process.exit(1);
  });
}
