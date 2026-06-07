'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');

const CLAUDE_PROJECTS = process.env.CLAUDE_PROJECTS_DIR
  || path.join(os.homedir(), '.claude', 'projects');
const AGENT_STATUS_DIR = process.env.AGENT_STATUS_DIR || '/var/run/agent-status';

function tokenFile(worker) {
  return path.join(AGENT_STATUS_DIR, `worker-${worker}-tokens.json`);
}

// Find JSONL session files modified at or after sinceMs across all project dirs.
function findRecentSessions(sinceMs) {
  const result = [];
  try {
    for (const proj of fs.readdirSync(CLAUDE_PROJECTS)) {
      const dir = path.join(CLAUDE_PROJECTS, proj);
      let entries;
      try { entries = fs.readdirSync(dir); } catch (_) { continue; }
      for (const f of entries) {
        if (!f.endsWith('.jsonl')) continue;
        const fp = path.join(dir, f);
        try {
          if (fs.statSync(fp).mtimeMs >= sinceMs) result.push(fp);
        } catch (_) {}
      }
    }
  } catch (_) {}
  return result;
}

// Sum token usage across all assistant messages in a JSONL session file.
function parseSessionUsage(filePath) {
  const t = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (_) { continue; }
      const u = obj?.message?.usage;
      if (!u) continue;
      t.input += u.input_tokens || 0;
      t.output += u.output_tokens || 0;
      t.cacheRead += u.cache_read_input_tokens || 0;
      t.cacheCreate += u.cache_creation_input_tokens || 0;
    }
  } catch (_) {}
  return t;
}

// Record tokens for a completed claude-tui step. Writes to the worker token file.
function recordStep(worker, stepId, sinceMs) {
  const sessions = findRecentSessions(sinceMs);
  const step = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  for (const f of sessions) {
    const u = parseSessionUsage(f);
    step.input += u.input;
    step.output += u.output;
    step.cacheRead += u.cacheRead;
    step.cacheCreate += u.cacheCreate;
  }

  const file = tokenFile(worker);
  let data = { steps: {} };
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  data.steps[stepId] = step;

  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
  return step;
}

// Get the accumulated per-step data for a worker run.
function getRunData(worker) {
  try {
    return JSON.parse(fs.readFileSync(tokenFile(worker), 'utf8'));
  } catch (_) {
    return { steps: {} };
  }
}

// Sum all step totals into one object.
function sumTotals(steps) {
  const t = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  for (const s of Object.values(steps)) {
    t.input += s.input || 0;
    t.output += s.output || 0;
    t.cacheRead += s.cacheRead || 0;
    t.cacheCreate += s.cacheCreate || 0;
  }
  return t;
}

// Rough cost estimate (USD) based on Claude Sonnet 4 pricing.
// Input $3/M, Output $15/M, Cache-write $3.75/M, Cache-read $0.30/M.
function estimateCost(totals) {
  const M = 1_000_000;
  return +(
    (totals.input / M) * 3.00 +
    (totals.output / M) * 15.00 +
    (totals.cacheCreate / M) * 3.75 +
    (totals.cacheRead / M) * 0.30
  ).toFixed(4);
}

// Format a summary block for terminal output.
function formatSummary(ticket, steps, totals, costUsd, durationMs) {
  const fmt = (n) => n.toLocaleString('en-US');
  const pad = (s, n) => String(s).padStart(n);
  const lines = [
    '',
    '┌─────────────────────────────────────────────────────────────┐',
    `│  Token usage — ${(ticket || 'run').padEnd(44)}│`,
    '├──────────────────────────┬──────────┬──────────┬────────────┤',
    '│  step                    │   input  │  output  │  cache-rd  │',
    '├──────────────────────────┼──────────┼──────────┼────────────┤',
  ];
  for (const [id, s] of Object.entries(steps)) {
    lines.push(
      `│  ${id.slice(0, 24).padEnd(24)}│${pad(fmt(s.input), 9)} │${pad(fmt(s.output), 9)} │${pad(fmt(s.cacheRead), 11)} │`
    );
  }
  lines.push('├──────────────────────────┼──────────┼──────────┼────────────┤');
  lines.push(
    `│  ${'TOTAL'.padEnd(24)}│${pad(fmt(totals.input), 9)} │${pad(fmt(totals.output), 9)} │${pad(fmt(totals.cacheRead), 11)} │`
  );
  lines.push('├──────────────────────────┴──────────┴──────────┴────────────┤');
  const dur = durationMs != null ? `  duration ${Math.round(durationMs / 60000)}m` : '';
  const costStr = `est. cost ~$${costUsd.toFixed(2)}`;
  lines.push(`│  ${(costStr + dur).padEnd(59)}│`);
  lines.push('└─────────────────────────────────────────────────────────────┘');
  return lines.join('\n');
}

// POST the run record to the API. Fire-and-forget — logs on failure but never throws.
function postRunRecord(record, apiUrl, apiToken) {
  return new Promise((resolve) => {
    const body = JSON.stringify(record);
    let url;
    try { url = new URL('/internal/muaddib-runs', apiUrl); } catch (_) {
      console.warn('[token-tracker] invalid MUADDIB_API_URL:', apiUrl);
      return resolve(null);
    }
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${apiToken}`,
        },
      },
      (res) => {
        res.resume();
        if (res.statusCode !== 201) {
          console.warn(`[token-tracker] API returned ${res.statusCode}`);
        }
        resolve(res.statusCode);
      }
    );
    req.on('error', (err) => {
      console.warn('[token-tracker] failed to POST run record:', err.message);
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

module.exports = {
  recordStep,
  getRunData,
  sumTotals,
  estimateCost,
  formatSummary,
  postRunRecord,
  // exported for testing
  parseSessionUsage,
  findRecentSessions,
};
