#!/usr/bin/env node
"use strict";
// Dispatch daemon — watches the configured ticket source and auto-routes new
// issues to worker containers based on their labels.
//
// The trigger depends on the source's watchMode (see services/ticket-source):
//   - Linear ('webhook'): registers a Linear webhook behind a cloudflared tunnel
//     and routes inbound POSTs. Requires LINEAR_API_KEY + LINEAR_TEAM_ID.
//   - GitHub ('poll'): polls the repo's open issues on an interval — no HTTP
//     server, tunnel, or webhook registration. Requires GITHUB_OWNER + GITHUB_REPO
//     (backfilled from .muaddib/manifest.json when unset).
//
// Always required: CLAUDE_CODE_OAUTH_TOKEN, GITHUB_TOKEN (passed to spawn-worker.sh).
// Optional env: DISPATCH_WEBHOOK_SECRET (auto-generated if unset), DISPATCH_PORT
//   (default 3999), MAX_DISPATCH_WORKERS (default 8), DISPATCH_POLL_INTERVAL (poll
//   mode, default 20000ms).
//
// Start:  ./dispatch.sh          (foreground)
//         ./dispatch.sh --bg     (background, PID in .muaddib-dispatch.pid)
// Stop:   ./dispatch.sh --stop

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execFile } = require("child_process");

const { getTicketSource } = require("./ticket-source");
const {
  isDispatched,
  markDispatched,
  unmarkDispatched,
  enqueue,
  flush,
} = require("./dispatch-queue");
const { readMuaddibConfig } = require("./muaddib-config");
const { resolveMuaddibRoot } = require("../orchestrator/muaddib-root");

const REPO_ROOT = process.env.REPO_ROOT || path.join(__dirname, "../..");
const FLEET_DIR = resolveMuaddibRoot(REPO_ROOT);
const SPAWN_WORKER = path.join(FLEET_DIR, "bin/spawn-worker.sh");

// Lazy — config is only read (and validated) the first time something
// actually needs it, not merely on require(). Keeps this module importable
// in isolation (e.g. by tests exercising resolveRoute/handleEvent, which
// never touch config) without needing a real .muaddib/manifest.json to
// exist at REPO_ROOT.
let _config = null;
function getConfig() {
  if (_config === null) {
    const config = readMuaddibConfig(REPO_ROOT);
    if (!config.projectName) {
      // Deliberately NOT cached — an invalid config must keep throwing on
      // every call, not just the first (a caller that doesn't exit the
      // process on failure would otherwise silently see this as "valid"
      // from the second call onward).
      throw new Error(`${path.join(REPO_ROOT, ".muaddib", "manifest.json")} is missing "projectName" — dispatch-daemon.js needs it to find this project's worker containers`);
    }
    _config = config;
  }
  return _config;
}
function getProjectName() {
  return getConfig().projectName;
}

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

// The ticket backend (Linear today) — webhook register/deregister and inbound
// signature verification all go through this interface rather than raw calls.
// Resolved lazily (like getConfig() above) so a misconfigured TICKET_SOURCE
// surfaces as a clean startup/handler error, never an uncaught throw at
// require() time.
let _ticketSource = null;
function ticketSource() {
  if (_ticketSource === null) {
    const config = getConfig();
    // Build from the manifest's ticketSource so the manifest — not an ambient
    // TICKET_SOURCE env var — is the source of truth (getTicketSource still
    // falls back to the env var / 'linear' when the manifest omits the key).
    _ticketSource = getTicketSource(config.ticketSource);
    // Backfill GITHUB_OWNER/GITHUB_REPO from the manifest when unset, so the
    // github source (fetchTicket/pollIssues) can resolve the repo with no extra
    // compose env plumbing. Only fill gaps — an explicit env var still wins.
    if (config.githubOwner && !process.env.GITHUB_OWNER) {
      process.env.GITHUB_OWNER = config.githubOwner;
    }
    if (config.githubRepo && !process.env.GITHUB_REPO) {
      process.env.GITHUB_REPO = config.githubRepo;
    }
  }
  return _ticketSource;
}

let webhookId = null;
let tunnelProc = null;
let flushInterval = null;
let pollInterval = null;
let server = null;

// Identifiers already logged as "no route matched", so the poll path (which
// re-examines every open issue on every tick) logs each non-participating
// issue once instead of on every interval. An identifier is cleared from this
// set if it ever does route, so a later relapse to no-route logs afresh.
const loggedNoRoute = new Set();

function log(msg) {
  process.stdout.write(`[dispatch-daemon] ${msg}\n`);
}

// ─── env validation ───────────────────────────────────────────────────────────

function validateEnv() {
  const missing = [];
  // Account-level tokens: the daemon passes these straight through to
  // spawn-worker.sh (which hard-requires both), so a daemon started without
  // them — e.g. non-interactively at reboot/launchd, where ~/.zshrc never runs
  // — would break silently at worker-spawn time. Fail fast at startup instead.
  // (dispatch.sh sources ~/.muaddib/conductor-secrets.env to supply them.)
  // Always required, regardless of ticket source.
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) missing.push("CLAUDE_CODE_OAUTH_TOKEN");
  if (!process.env.GITHUB_TOKEN) missing.push("GITHUB_TOKEN");

  // The rest are source-specific. ticketSource() reads the manifest and (for
  // github) backfills GITHUB_OWNER/GITHUB_REPO from it, so the checks below see
  // the effective, post-backfill values.
  const source = ticketSource();
  if (source.watchMode === "webhook") {
    // Only the webhook (Linear) flow registers a webhook / talks to Linear.
    if (!process.env.LINEAR_API_KEY) missing.push("LINEAR_API_KEY");
    if (!LINEAR_TEAM_ID) missing.push("LINEAR_TEAM_ID");
  }
  if (source.name === "github") {
    // fetchTicket/pollIssues resolve the repo from these; a value still missing
    // here means neither the env nor the manifest supplied owner/repo.
    if (!process.env.GITHUB_OWNER) missing.push("GITHUB_OWNER");
    if (!process.env.GITHUB_REPO) missing.push("GITHUB_REPO");
  }
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
      const workerRe = new RegExp(`com\\.docker\\.compose\\.project=(${getProjectName()}-w\\d+)`);
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
  const indexRe = new RegExp(`${getProjectName()}-w(\\d+)`);
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
  const indexRe = new RegExp(`${getProjectName()}-w(\\d+)`);
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
  if (labels.includes("muaddib:plan") || labels.includes("plan") || labels.includes("plan-only")) {
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
  // Pin the model from .muaddib/manifest.json. The dispatch image has no jq, so
  // read-config.sh inside spawn-worker.sh can't derive MUADDIB_MODEL itself —
  // inject it here (parsed in JS) so spawn-worker.sh writes ANTHROPIC_MODEL.
  if (getConfig().model) env.MUADDIB_MODEL = getConfig().model;
  // Same reason: the dispatch image has no jq, so read-config.sh can't derive the
  // manifest's ticket-source settings inside spawn-worker.sh — inject them here so
  // spawn-worker.sh forwards TICKET_SOURCE/GITHUB_OWNER/GITHUB_REPO into the worker.
  if (getConfig().ticketSource) env.MUADDIB_TICKET_SOURCE = getConfig().ticketSource;
  if (getConfig().githubOwner) env.MUADDIB_GITHUB_OWNER = getConfig().githubOwner;
  if (getConfig().githubRepo) env.MUADDIB_GITHUB_REPO = getConfig().githubRepo;

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

// ─── dispatch core ────────────────────────────────────────────────────────────
// The shared routing decision, source-neutral: given an issue's identifier, its
// lowercased labels, and its assignee id, apply the assignee guard → route
// resolution → dedup → slot-count and either enqueue or spawn. Both the Linear
// webhook path (handleEvent) and the GitHub poll path (pollAndDispatch) normalize
// their backend-specific payload down to this shape and call in here.

async function dispatchIssue({ identifier, labels, assigneeId }) {
  // Assignee guard: if DISPATCH_ASSIGNEE_ID is set, only dispatch tickets
  // assigned to that user. Prevents every machine from picking up the same
  // ticket when multiple dispatchers are running. (assigneeId is the Linear
  // user id on the webhook path, the GitHub login on the poll path — compared
  // against whatever DISPATCH_ASSIGNEE_ID holds for that backend.)
  const dispatchAssigneeId = process.env.DISPATCH_ASSIGNEE_ID || "";
  if (dispatchAssigneeId && assigneeId !== dispatchAssigneeId) {
    log(
      `${identifier}: assignee ${assigneeId || "unset"} ≠ DISPATCH_ASSIGNEE_ID — skipped`,
    );
    return;
  }

  const route = resolveRoute(labels);
  if (!route) {
    // Log once per identifier: the poll path hits this branch for every
    // non-participating issue on every tick, so logging unconditionally floods
    // the daemon log. The first observation is enough.
    if (!loggedNoRoute.has(identifier)) {
      loggedNoRoute.add(identifier);
      log(
        `${identifier}: no route matched (labels: ${labels.join(", ") || "none"}) — skipped`,
      );
    }
    return;
  }
  // Routed now — drop any earlier no-route suppression so a future relapse logs.
  loggedNoRoute.delete(identifier);

  if (isDispatched(identifier)) {
    log(`${identifier}: already dispatched — skipped`);
    return;
  }

  // Reserve the ticket synchronously, before any await below, so overlapping
  // polls or a concurrent flush can't both clear the isDispatched guard and
  // spawn duplicate workers (the check→spawn window spans the awaits that
  // follow). This also marks the enqueue-at-capacity path — without it every
  // subsequent poll tick would re-enqueue the same ticket unboundedly and
  // flush would spawn duplicate workers. trySpawn unmarks on a failed spawn,
  // so a genuine failure still retries.
  markDispatched(identifier);

  const count = await countActiveWorkers();
  if (count >= MAX_WORKERS) {
    log(`${identifier}: ${count}/${MAX_WORKERS} slots occupied — queued`);
    enqueue(identifier, route.entryPoint, route.workflowFile);
    return;
  }

  const ok = await trySpawn({
    ticketId: identifier,
    entryPoint: route.entryPoint,
    workflowFile: route.workflowFile,
  });
  // Slots can fill between the count check above and trySpawn's own check;
  // when that happens keep the (already-reserved) ticket by queuing it rather
  // than dropping it — flush will spawn it once a slot frees.
  if (!ok) {
    log(`${identifier}: no free slot at spawn — queued`);
    enqueue(identifier, route.entryPoint, route.workflowFile);
  }
}

// ─── event handler (webhook path) ─────────────────────────────────────────────

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

  const labelNodes = Array.isArray(data.labels)
    ? data.labels
    : (data.labels && data.labels.nodes) || [];
  const labels = labelNodes.map((l) => l.name.toLowerCase());

  await dispatchIssue({
    identifier,
    labels,
    assigneeId: data.assignee && data.assignee.id,
  });
}

// ─── poll handler (poll path) ─────────────────────────────────────────────────
// Poll the source's open issues and run each through the shared dispatch core.
// `source` is injectable for testing; defaults to the configured ticketSource().
// Never throws — a poll failure is logged and the next tick retries.

async function pollAndDispatch(source) {
  const src = source || ticketSource();
  let issues;
  try {
    issues = await src.pollIssues();
  } catch (err) {
    log(`poll error: ${err.message}`);
    return;
  }
  for (const issue of issues || []) {
    if (!issue || !issue.identifier) continue;
    const labelNodes = (issue.labels && issue.labels.nodes) || [];
    const labels = labelNodes
      .map((l) => (l && l.name ? l.name.toLowerCase() : ""))
      .filter(Boolean);
    try {
      await dispatchIssue({
        identifier: issue.identifier,
        labels,
        assigneeId: issue.assignee || null,
      });
    } catch (err) {
      log(`${issue.identifier}: dispatch error: ${err.message}`);
    }
  }
}

// ─── graceful shutdown ────────────────────────────────────────────────────────

async function shutdown() {
  log("shutting down...");
  if (flushInterval) clearInterval(flushInterval);
  if (pollInterval) clearInterval(pollInterval);
  if (server) {
    try {
      server.close();
    } catch (_) {}
  }
  if (webhookId) {
    log(`deregistering Linear webhook ${webhookId}...`);
    try {
      await ticketSource().deregisterWatch(webhookId);
    } catch (err) {
      log(`deregisterWatch error: ${err.message}`);
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

// Webhook trigger (Linear): HTTP server + tunnel + webhook registration.
async function startWebhookWatch() {
  const source = ticketSource();
  // The inbound header carrying the signature is source-declared, not hardcoded.
  const sigHeader = source.signatureHeader || "linear-signature";

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

      const sig = req.headers[sigHeader] || "";
      if (!source.verifySignature(rawBody, sig, SECRET)) {
        log(`invalid ${sigHeader} — rejected`);
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

  // 3. Register ticket-source watch (Linear webhook)
  log(`registering Linear webhook for team ${LINEAR_TEAM_ID}...`);
  const { watchId } = await source.registerWatch({
    teamId: LINEAR_TEAM_ID,
    url: tunnelUrl,
    secret: SECRET,
  });
  webhookId = watchId;
  log(`webhook registered: ${webhookId}`);
}

// Poll trigger (GitHub): no HTTP server, tunnel, or webhook registration —
// just periodically list the repo's open issues and route them.
function startPollWatch(source) {
  if (typeof source.pollIssues !== "function") {
    throw new Error(
      `ticket source "${source.name}" declares watchMode 'poll' but implements no pollIssues()`,
    );
  }
  const intervalMs = parseInt(process.env.DISPATCH_POLL_INTERVAL || "20000", 10);
  log(
    `poll mode — polling ${source.name} every ${intervalMs}ms (no HTTP server / tunnel / webhook registration)`,
  );
  // Serialize ticks: a poll that runs longer than intervalMs (many issues, slow
  // docker/network) must not overlap the next tick — overlapping polls race on
  // the isDispatched check and can spawn duplicate workers. A tick that fires
  // while one is still in flight is skipped.
  let polling = false;
  const tick = () => {
    if (polling) {
      log("poll still in progress — skipping this tick");
      return;
    }
    polling = true;
    pollAndDispatch(source)
      .catch((err) => log(`poll error: ${err.message}`))
      .finally(() => {
        polling = false;
      });
  };
  // Poll once immediately so a labeled issue that already exists at startup
  // dispatches without waiting a full interval, then on the interval.
  tick();
  pollInterval = setInterval(tick, intervalMs);
}

async function main() {
  validateEnv();
  // Force config validation now, synchronously, before anything async starts
  // (HTTP server, execFile calls, etc). getConfig()/getProjectName() cache
  // their result, so every later call — including the ones inside async
  // callbacks like getActiveWorkerProjects()'s execFile — just returns the
  // already-validated value instead of risking a throw from inside a
  // callback (uncaught there, since it isn't inside a Promise executor).
  // (validateEnv() already forced this via ticketSource(); kept explicit.)
  getConfig();

  // Branch on how this source is watched.
  const source = ticketSource();
  log(`ticket source: ${source.name} (watchMode: ${source.watchMode})`);
  if (source.watchMode === "webhook") {
    await startWebhookWatch();
  } else if (source.watchMode === "poll") {
    startPollWatch(source);
  } else {
    throw new Error(
      `ticket source "${source.name}" (watchMode "${source.watchMode}") has no dispatch trigger — the daemon supports 'webhook' (Linear) and 'poll' (GitHub) only`,
    );
  }

  // Overflow-queue flush + orphaned-status cleanup interval (every 30 s), in both modes.
  flushInterval = setInterval(() => {
    flush(trySpawn).catch((err) => log(`flush error: ${err.message}`));
    cleanupOrphanedStatusFiles().catch((err) =>
      log(`cleanup error: ${err.message}`),
    );
  }, 30_000);

  log(`ready — max workers ${MAX_WORKERS}`);
}

module.exports = { validateEnv, resolveRoute, dispatchIssue, handleEvent, pollAndDispatch, cleanupWorkerFiles, cleanupOrphanedStatusFiles, getProjectName };

if (require.main === module) {
  main().catch((err) => {
    log(`FATAL: ${err.message}`);
    process.exit(1);
  });
}
