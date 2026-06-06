#!/usr/bin/env node
'use strict';
// Orchestrator: starts at container boot, coordinates all worker jobs via the
// JSONL event bus.
//
// State machine:
//   BOOTING → STARTING_JOBS → WAITING_FOR_SERVERS → CLAUDE_RUNNING
//   → WATCHING → (WATCHING_FEEDBACK ↔ WATCHING) → DONE_FINAL
//
// Real jobs are bash scripts; set MOCK_JOBS=1 to use inline stubs that emit the
// right events after short delays (for testing without a running container).

const fs = require('fs');
const path = require('path');
const https = require('https');
const { subscribe, emit } = require('./events');
const { startJob } = require('./job');

const WORKER = parseInt(process.env.WORKER_INDEX || '1', 10);
const AGENT_STATUS_DIR = process.env.AGENT_STATUS_DIR || '/var/run/agent-status';
const STATUS_FILE = path.join(AGENT_STATUS_DIR, `worker-${WORKER}.state`);
const WORK_TYPE_FILE = `/tmp/work-type-${WORKER}`;
const MOCK_JOBS = process.env.MOCK_JOBS === '1';
const REPO = process.env.REPO_DIR || '/home/worker/repo';
const EMIT_CLI = path.join(REPO, 'muaddib/lib/emit-cli.js');

const LINEAR_ISSUE_IDENTIFIER = process.env.LINEAR_ISSUE_IDENTIFIER || parseTicketId();
const LINEAR_API_KEY = process.env.LINEAR_API_KEY || '';

const MAX_CLAUDE_FAILURES = 3;
let claudeFailures = 0;
let state = 'BOOTING';

// ─── helpers ─────────────────────────────────────────────────────────────────

function parseTicketId() {
  const m = (process.env.TASK || '').match(/[A-Z]+-\d+/);
  return m ? m[0] : '';
}

function note(s) {
  state = s;
  fs.mkdirSync(AGENT_STATUS_DIR, { recursive: true });
  try { fs.writeFileSync(STATUS_FILE, `${s} ${new Date().toISOString()}\n`); } catch (_) {}
  emit(WORKER, 'orchestrator', 'state_changed', { state: s });
  console.log(`[orchestrator w${WORKER}] → ${s}`);
}

function permFlag() {
  const p = process.env.CLAUDE_PERMISSION_MODE || 'bypassPermissions';
  return p === 'bypassPermissions' ? '--dangerously-skip-permissions' : `--permission-mode ${p}`;
}

// ─── Linear work-type detection ──────────────────────────────────────────────

function getWorkType() {
  return new Promise((resolve) => {
    if (!LINEAR_ISSUE_IDENTIFIER || !LINEAR_API_KEY) return resolve('feature');
    const body = JSON.stringify({
      query: `query { issue(id: "${LINEAR_ISSUE_IDENTIFIER}") { labels { nodes { name } } } }`,
    });
    const req = https.request({
      hostname: 'api.linear.app',
      path: '/graphql',
      method: 'POST',
      headers: {
        Authorization: LINEAR_API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
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

// ─── Job command factory ──────────────────────────────────────────────────────

function jobCmd(name, workType) {
  if (MOCK_JOBS) {
    const stubs = {
      // Servers: emit tunnel_ready after 1 s, then stay running
      servers: [
        `sleep 1`,
        `node '${EMIT_CLI}' ${WORKER} servers tunnel_ready '{"url":"http://mock.api.example.com","portal":"http://mock.portal.example.com","homeowner":"http://mock.ho.example.com"}'`,
        `sleep 999999`,
      ].join(' && '),
      // Webhook: emit ready immediately, then stay running (feedback injected externally by test)
      webhook: `node '${EMIT_CLI}' ${WORKER} webhook ready '{}' && sleep 999999`,
      // Claude: sleep then exit 0 (triggers done via wrapper)
      claude: `sleep 2`,
      'claude-feedback': `sleep 1`,
    };
    return stubs[name] || `echo "unknown mock job: ${name}"; exit 1`;
  }

  const skill = workType === 'bug' ? '/muaddib-bug' : '/muaddib';
  const ticketArg = LINEAR_ISSUE_IDENTIFIER ? ` ${LINEAR_ISSUE_IDENTIFIER}` : '';
  const real = {
    servers:          `bash '${REPO}/muaddib/start-servers.sh'`,
    webhook:          `bash '${REPO}/muaddib/watch-feedback.sh'`,
    claude:           `claude ${permFlag()} "${skill}${ticketArg}"`,
    'claude-feedback': `claude ${permFlag()} "/muaddib-feedback ${LINEAR_ISSUE_IDENTIFIER}"`,
  };
  return real[name] || `echo "unknown job: ${name}"; exit 1`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  note('BOOTING');

  const workType = await getWorkType();
  try { fs.writeFileSync(WORK_TYPE_FILE, workType); } catch (_) {}
  console.log(`[orchestrator w${WORKER}] work type: ${workType}`);

  note('STARTING_JOBS');

  // Subscribe before starting jobs so no events are missed.
  subscribe(WORKER, (ev) => {
    console.log(`[orchestrator w${WORKER}] event ${ev.job}:${ev.event}`);

    if (ev.job === 'servers' && ev.event === 'tunnel_ready') {
      if (state === 'WAITING_FOR_SERVERS') {
        note('CLAUDE_RUNNING');
        startJob(WORKER, 'claude', jobCmd('claude', workType));
      }
      return;
    }

    if (ev.job === 'claude' && ev.event === 'done') {
      if (state === 'CLAUDE_RUNNING') note('WATCHING');
      return;
    }

    if (ev.job === 'claude' && ev.event === 'failed') {
      claudeFailures++;
      console.log(`[orchestrator w${WORKER}] claude failed (${claudeFailures}/${MAX_CLAUDE_FAILURES})`);
      if (claudeFailures >= MAX_CLAUDE_FAILURES) { note('FAILED'); process.exit(1); }
      console.log(`[orchestrator w${WORKER}] retrying claude...`);
      startJob(WORKER, 'claude', jobCmd('claude', workType));
      return;
    }

    // feedback job only starts when a webhook PR comment triggers it
    if (ev.job === 'webhook' && ev.event === 'feedback') {
      if (state === 'WATCHING') {
        note('WATCHING_FEEDBACK');
        startJob(WORKER, 'claude-feedback', jobCmd('claude-feedback', workType));
      }
      return;
    }

    if (ev.job === 'claude-feedback' && ev.event === 'done') {
      if (state === 'WATCHING_FEEDBACK') note('WATCHING');
      return;
    }

    if (ev.job === 'webhook' && ev.event === 'merged') {
      note('DONE_FINAL');
      process.exit(0);
    }
  });

  startJob(WORKER, 'webhook', jobCmd('webhook', workType));
  startJob(WORKER, 'servers', jobCmd('servers', workType));

  note('WAITING_FOR_SERVERS');
}

process.on('SIGTERM', () => {
  console.log(`[orchestrator w${WORKER}] SIGTERM — shutting down`);
  note('DONE');
  process.exit(0);
});

main().catch((err) => {
  console.error(`[orchestrator w${WORKER}] fatal:`, err);
  note('FAILED');
  process.exit(1);
});
