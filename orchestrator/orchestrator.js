#!/usr/bin/env node
'use strict';
// Orchestrator — runs at container boot.
// 1. Detects work type from Linear labels (feature / bug).
// 2. Reads the matching workflow definition from muaddib/workflows/.
// 3. Starts background services declared in the definition.
// 4. Delegates the implementation workflow to runner.js.
// 5. Enters FEEDBACK state — responds to PR feedback and merge events.

const fs = require('fs');
const path = require('path');
const { subscribe, readEvents } = require('./events');
const { getTicketSource } = require('../services/ticket-source');
const { startJob } = require('./job');
const { run, notifyHuman } = require('./runner');
const { noteStatus, AGENT_STATUS_DIR } = require('./status');
const { getRunData, sumTotals, estimateCost, formatSummary, postRunRecord } = require('./token-tracker');
const { resolveMuaddibRoot } = require('./muaddib-root');

const WORKER         = parseInt(process.env.WORKER_INDEX || '1', 10);
const REPO           = process.env.REPO_DIR || '/home/worker/repo';
const MUADDIB_ROOT   = resolveMuaddibRoot(REPO);
const EMIT_CLI       = path.join(MUADDIB_ROOT, 'orchestrator/emit-cli.js');
const WORK_TYPE_FILE = `/tmp/work-type-${WORKER}`;
const MOCK_JOBS      = process.env.MOCK_JOBS === '1';
const TICKET_SOURCE_KIND = (process.env.TICKET_SOURCE || 'linear').toLowerCase();
const LINEAR_ISSUE   = process.env.TICKET_IDENTIFIER || process.env.LINEAR_ISSUE_IDENTIFIER || parseTicketId();
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
  noteStatus(WORKER, s);
  console.log(`[orchestrator w${WORKER}] → ${s}`);
}

// ─── Linear work-type detection ──────────────────────────────────────────────

function getWorkType() {
  // A raw ticket has no labels to inspect at all — always 'feature', no fetch.
  if (TICKET_SOURCE_KIND === 'raw') return Promise.resolve('feature');
  if (!LINEAR_ISSUE) return Promise.resolve('feature');
  // The credential requirement is source-specific: Linear needs LINEAR_API_KEY,
  // but the GitHub source authenticates with GITHUB_TOKEN. Gating on
  // LINEAR_API_KEY alone would skip the fetch for github and never let labels
  // drive bug detection — so only require it for the Linear source.
  if (TICKET_SOURCE_KIND === 'linear' && !LINEAR_API_KEY) return Promise.resolve('feature');
  // getTicketSource() runs inside the chain so a misconfigured TICKET_SOURCE
  // (a synchronous throw) degrades to 'feature' via .catch, exactly like a
  // network/GraphQL error — never crashing orchestrator startup.
  return Promise.resolve()
    .then(() => getTicketSource().fetchTicket(LINEAR_ISSUE))
    .then((ticket) => {
      const labels = ((ticket && ticket.labels && ticket.labels.nodes) || [])
        .map((l) => l.name.toLowerCase());
      return ['bug', 'fix', 'defect'].some((t) => labels.includes(t)) ? 'bug' : 'feature';
    })
    .catch(() => 'feature');
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
  const scriptPath = path.join(MUADDIB_ROOT, svc.script);
  const runtime = scriptPath.endsWith('.js') ? 'node' : 'bash';
  return `${runtime} '${scriptPath}'`;
}

// Command for the post-feedback reconcile (restart-servers.sh). The script emits
// `servers restart_ready` / `servers restart_failed` itself; under MOCK_JOBS we
// stub just the success signal, mirroring serviceCmd()'s `servers` stub so
// test-orchestrator.js stays hermetic (no ports, migrations, or npm).
function restartServersCmd() {
  if (MOCK_JOBS) {
    return `sleep 0.3 && node '${EMIT_CLI}' ${WORKER} servers restart_ready '{}'`;
  }
  return `bash '${path.join(MUADDIB_ROOT, 'services/restart-servers.sh')}'`;
}

// Quiet, informational tier (no alert sound) — proves the info path end-to-end
// through the same shared formatter/Slack sender the attention-needed alerts
// use. Awaited so the fire-and-forget Slack send actually flushes before the
// DONE_FINAL process.exit(0) that follows tears the process down. Shared by
// both merge paths: the live `webhook merged` event, and the pre-armed merge
// detected from the event history.
async function notifyMerged() {
  try {
    await notifyHuman(WORKER, {
      kind: 'info',
      message: `PR merged for ${LINEAR_ISSUE || 'this ticket'} — preview torn down`,
    });
  } catch (_) {}
}

// Start a background service. If svc.readyEvent is set, resolves only once
// that event fires on the bus (e.g. servers waits for tunnel_ready).
function startService(svc) {
  const cmd = serviceCmd(svc);
  const logFile = path.join(AGENT_STATUS_DIR, `worker-${WORKER}-${svc.name}.log`);
  const opts = { logFile };
  if (!svc.readyEvent) { startJob(WORKER, svc.name, cmd, {}, opts); return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const sub = subscribe(WORKER, (ev) => {
      if (ev.job !== svc.name) return;
      if (ev.event === svc.readyEvent) { sub.kill(); resolve(); }
      else if (ev.event === 'failed') {
        sub.kill();
        reject(new Error(`service "${svc.name}" failed before emitting ${svc.readyEvent} (exitCode=${ev.payload && ev.payload.exitCode})`));
      }
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
    || path.join(MUADDIB_ROOT, 'workflows', `${workType}.json`);
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

  // The PR can be merged while the workflow is still running: the webhook job
  // emits `merged` and exits the moment it sees a merged PR, which may be
  // minutes before `wrapup` finishes and we arm the subscription below. That
  // subscription starts `fromEnd`, so an already-emitted `merged` is invisible
  // to it — and the webhook job is gone, so nothing can ever re-emit it. The
  // orchestrator is PID 1, so waiting forever leaves the container (and its DB
  // pair and ports) up on a merged ticket. Check the history once first.
  //
  // Scoped to this run: the events file is append-only and never cleared, so a
  // `merged` from a previous ticket on this worker slot is still sitting in it.
  // Matching that would exit a fresh run the instant it reached FEEDBACK.
  const thisRun = readEvents(WORKER).filter((ev) => Date.parse(ev.ts) >= runStartTime);
  const mergedAlready = thisRun.some((ev) => ev.job === 'webhook' && ev.event === 'merged');

  note('FEEDBACK');
  if (mergedAlready) {
    console.error(`[orchestrator w${WORKER}] PR already merged before FEEDBACK armed — finishing`);
    await notifyMerged();
    await recordAndPrintTokens(workType, runStartTime);
    note('DONE_FINAL');
    process.exit(0);
  }

  // FEEDBACK is only meaningful while the webhook job is alive: it is the sole
  // source of both `webhook feedback` and `webhook merged`. If it already
  // exited this run without a merge — a failed tunnel, a dead receiver, a
  // missing /tmp/pr-number-<N> — then nothing can ever wake the subscription
  // below, and the worker would look like it was patiently waiting for review
  // when in fact it can no longer hear anything. Keep FEEDBACK armed so the
  // preview stays usable, but say so loudly instead of presenting as a hang.
  if (thisRun.some((ev) => ev.job === 'webhook' && (ev.event === 'done' || ev.event === 'failed'))) {
    console.error(`[orchestrator w${WORKER}] webhook job is gone but no merge was seen — /feedback and merge-teardown are both dead for this worker; tear it down manually when done reviewing`);
    try {
      await notifyHuman(WORKER, {
        message: `Feedback watcher died for ${LINEAR_ISSUE || 'this ticket'} — /feedback and auto-teardown won't work; tear the worker down manually`,
      });
    } catch (_) {}
  }

  await new Promise((resolve) => {
    const sub = subscribe(WORKER, async (ev) => {
      if (ev.job === 'webhook' && ev.event === 'feedback' && currentState === 'FEEDBACK') {
        note('FEEDBACK_WORKING');
        const feedbackCmd = MOCK_JOBS
          ? 'sleep 0.3'
          : `claude ${permFlag()} "/muaddib-feedback ${LINEAR_ISSUE}"`;
        startJob(WORKER, 'claude-feedback', feedbackCmd);
      }
      if (ev.job === 'claude-feedback' && ev.event === 'done' && currentState === 'FEEDBACK_WORKING') {
        // The feedback pass edited/committed/pushed code but never reconciled the
        // live `servers` job — new migrations, dependency changes, and non-watched
        // config go stale in the preview. Reconcile it deterministically (bounce
        // the backend, rerun migrate:up/npm install, reuse the open tunnels) and
        // wait for the backend to actually come back before re-arming FEEDBACK, so
        // a reviewer never looks at a preview that silently doesn't reflect the fix.
        note('RECONCILING');
        startJob(WORKER, 'restart-servers', restartServersCmd());
      }
      if (ev.job === 'claude-feedback' && ev.event === 'failed' && currentState === 'FEEDBACK_WORKING') {
        // The feedback pass itself crashed (non-zero exit). Without a transition
        // the worker would wedge permanently in FEEDBACK_WORKING and ignore every
        // further feedback event. Alert the human and re-arm FEEDBACK so a
        // follow-up /feedback can retry the pass.
        const exitCode = ev.payload && ev.payload.exitCode;
        console.error(`[orchestrator w${WORKER}] claude-feedback failed (exitCode=${exitCode}) — re-arming FEEDBACK for retry`);
        try {
          await notifyHuman(WORKER, {
            message: `Feedback pass failed for ${LINEAR_ISSUE || 'this ticket'} — send /feedback again to retry`,
          });
        } catch (_) {}
        note('FEEDBACK');
      }
      if (ev.job === 'servers' && (ev.event === 'restart_ready' || ev.event === 'restart_failed')
          && currentState === 'RECONCILING') {
        if (ev.event === 'restart_failed') {
          const ports = (ev.payload && ev.payload.ports) || [];
          console.error(`[orchestrator w${WORKER}] preview reconcile failed (ports: ${JSON.stringify(ports)}) — preview may be stale`);
          // restart-servers.sh already fired services/notify.sh; this is the
          // orchestrator-side alert so the failure surfaces even if the script's
          // own notify path was unavailable. Don't wedge the worker — still re-arm
          // FEEDBACK so a follow-up /feedback can retry the reconcile.
          try {
            await notifyHuman(WORKER, {
              message: `Preview reconcile failed for ${LINEAR_ISSUE || 'this ticket'} — backend may not reflect the latest fix`,
            });
          } catch (_) {}
        }
        note('FEEDBACK');
      }
      if (ev.job === 'webhook' && ev.event === 'merged') {
        await notifyMerged();
        sub.kill();
        resolve();
      }
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
