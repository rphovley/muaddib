#!/usr/bin/env node
'use strict';
// Orchestrator — runs at container boot.
// 1. Detects work type from Linear labels (feature / bug).
// 2. Reads the matching workflow definition from muaddib/workflows/.
// 3. Starts background services declared in the definition.
// 4. Delegates the implementation workflow to runner.js.
// 5. Enters WATCHING state — responds to PR feedback and merge events.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { subscribe, emit } = require('./events');
const { startJob } = require('./job');
const { run } = require('./runner');
const { getRunData, sumTotals, estimateCost, formatSummary, postRunRecord } = require('./token-tracker');

const WORKER         = parseInt(process.env.WORKER_INDEX || '1', 10);
const REPO           = process.env.REPO_DIR || '/home/worker/repo';
const EMIT_CLI       = path.join(REPO, 'muaddib/orchestrator/emit-cli.js');
const AGENT_STATUS_DIR = process.env.AGENT_STATUS_DIR || '/var/run/agent-status';
const STATUS_FILE    = path.join(AGENT_STATUS_DIR, `worker-${WORKER}.state`);
const WORK_TYPE_FILE = `/tmp/work-type-${WORKER}`;
const MOCK_JOBS      = process.env.MOCK_JOBS === '1';
const LINEAR_ISSUE   = process.env.LINEAR_ISSUE_IDENTIFIER || parseTicketId();
const LINEAR_API_KEY = process.env.LINEAR_API_KEY || '';

let currentState = '';

function parseTicketId() {
  const m = (process.env.TASK || '').match(/[A-Z]+-\d+/);
  return m ? m[0] : '';
}

function permFlag() {
  const p = process.env.CLAUDE_PERMISSION_MODE || 'bypassPermissions';
  return p === 'bypassPermissions' ? '--dangerously-skip-permissions' : `--permission-mode ${p}`;
}

function note(s) {
  currentState = s;
  fs.mkdirSync(AGENT_STATUS_DIR, { recursive: true });
  try { fs.writeFileSync(STATUS_FILE, `${s} ${new Date().toISOString()}\n`); } catch (_) {}
  emit(WORKER, 'orchestrator', 'state_changed', { state: s });
  console.log(`[orchestrator w${WORKER}] → ${s}`);
}

// ─── Linear work-type detection ──────────────────────────────────────────────

function getWorkType() {
  return new Promise((resolve) => {
    if (!LINEAR_ISSUE || !LINEAR_API_KEY) return resolve('feature');
    const body = JSON.stringify({
      query: `query { issue(id:"${LINEAR_ISSUE}") { labels { nodes { name } } } }`,
    });
    const req = https.request({
      hostname: 'api.linear.app', path: '/graphql', method: 'POST',
      headers: { Authorization: LINEAR_API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const labels = (JSON.parse(data)?.data?.issue?.labels?.nodes || [])
            .map((l) => l.name.toLowerCase());
          resolve(['bug', 'fix', 'defect'].some((t) => labels.includes(t)) ? 'bug' : 'feature');
        } catch (_) { resolve('feature'); }
      });
    });
    req.on('error', () => resolve('feature'));
    req.write(body);
    req.end();
  });
}

// ─── service startup ─────────────────────────────────────────────────────────

function serviceCmd(svc) {
  if (MOCK_JOBS) {
    const stubs = {
      servers: `sleep 0.5 && node '${EMIT_CLI}' ${WORKER} servers tunnel_ready '{}' && sleep 999999`,
      webhook: `node '${EMIT_CLI}' ${WORKER} webhook ready '{}' && sleep 999999`,
    };
    return stubs[svc.name] || `echo "unknown mock service: ${svc.name}"; exit 1`;
  }
  const scriptPath = path.join(REPO, 'muaddib', svc.script);
  const runtime = scriptPath.endsWith('.js') ? 'node' : 'bash';
  return `${runtime} '${scriptPath}'`;
}

// Start a background service. If svc.readyEvent is set, resolves only once
// that event fires on the bus (e.g. servers waits for tunnel_ready).
function startService(svc) {
  const cmd = serviceCmd(svc);
  const logFile = path.join(AGENT_STATUS_DIR, `worker-${WORKER}-${svc.name}.log`);
  const opts = { logFile };
  if (!svc.readyEvent) { startJob(WORKER, svc.name, cmd, {}, opts); return Promise.resolve(); }
  return new Promise((resolve) => {
    const sub = subscribe(WORKER, (ev) => {
      if (ev.job === svc.name && ev.event === svc.readyEvent) { sub.kill(); resolve(); }
    });
    startJob(WORKER, svc.name, cmd, {}, opts);
  });
}

// ─── main ────────────────────────────────────────────────────────────────────

async function recordAndPrintTokens(workType, runStartTime) {
  const { steps } = getRunData(WORKER);
  const totals = sumTotals(steps);
  const costUsd = estimateCost(totals);
  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - runStartTime;

  console.log(formatSummary(LINEAR_ISSUE, steps, totals, costUsd, durationMs));

  const apiUrl = process.env.MUADDIB_API_URL;
  const apiToken = process.env.MUADDIB_API_TOKEN;
  if (apiUrl && apiToken) {
    const ticketTitle = (() => {
      try {
        const s = require('./state');
        return s.get(WORKER, 'ticket_title') || '';
      } catch (_) { return ''; }
    })();
    await postRunRecord(
      {
        ticket_id: LINEAR_ISSUE || '',
        ticket_title: ticketTitle,
        work_type: workType,
        worker_index: WORKER,
        started_at: new Date(runStartTime).toISOString(),
        finished_at: finishedAt.toISOString(),
        steps,
        input_tokens: totals.input,
        output_tokens: totals.output,
        cache_read_tokens: totals.cacheRead,
        cache_create_tokens: totals.cacheCreate,
        approx_cost_usd: costUsd,
      },
      apiUrl,
      apiToken
    );
  } else {
    console.log('[orchestrator] MUADDIB_API_URL / MUADDIB_API_TOKEN not set — skipping token record POST');
  }
}

async function main() {
  note('BOOTING');

  const workType = await getWorkType();
  try { fs.writeFileSync(WORK_TYPE_FILE, workType); } catch (_) {}
  console.log(`[orchestrator w${WORKER}] work type: ${workType}`);

  const workflowFile = process.env.WORKFLOW_FILE
    || path.join(REPO, `muaddib/workflows/${workType}.json`);
  const definition = JSON.parse(fs.readFileSync(workflowFile, 'utf8'));

  note('STARTING_SERVICES');
  for (const svc of (definition.services || [])) {
    // eslint-disable-next-line no-await-in-loop
    await startService(svc);
  }

  const runStartTime = Date.now();
  note('RUNNING');
  await run(WORKER, workflowFile, LINEAR_ISSUE);

  if (definition.skipWatching) {
    await recordAndPrintTokens(workType, runStartTime);
    note('DONE_FINAL');
    process.exit(0);
  }

  note('WATCHING');
  await new Promise((resolve) => {
    const sub = subscribe(WORKER, (ev) => {
      if (ev.job === 'webhook' && ev.event === 'feedback' && currentState === 'WATCHING') {
        note('WATCHING_FEEDBACK');
        const feedbackCmd = MOCK_JOBS
          ? 'sleep 0.3'
          : `claude ${permFlag()} "/muaddib-feedback ${LINEAR_ISSUE}"`;
        startJob(WORKER, 'claude-feedback', feedbackCmd);
      }
      if (ev.job === 'claude-feedback' && ev.event === 'done' && currentState === 'WATCHING_FEEDBACK') {
        note('WATCHING');
      }
      if (ev.job === 'webhook' && ev.event === 'merged') { sub.kill(); resolve(); }
    }, { fromEnd: true });
  });

  await recordAndPrintTokens(workType, runStartTime);
  note('DONE_FINAL');
  process.exit(0);
}

process.on('SIGTERM', () => { note('DONE'); process.exit(0); });

main().catch((err) => {
  console.error(`[orchestrator w${WORKER}] fatal:`, err);
  note('FAILED');
  process.exit(1);
});
