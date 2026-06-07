#!/usr/bin/env node
'use strict';
// Token tracker test suite. No container or tmux needed.
//
// testParseSessionUsage_realFormat     — real Claude JSONL format with all extra
//                                        fields (server_tool_use, service_tier,
//                                        cache_creation, iterations, speed) — verifies
//                                        the parser only picks up the four token fields
//                                        and ignores the rest
// testParseSessionUsage_multiMessages  — multiple assistant messages summed correctly
// testParseSessionUsage_malformedLines — malformed JSON lines skipped, valid ones counted
// testParseSessionUsage_noUsageFields  — non-assistant messages produce zero counts
// testFindRecentSessions_timing        — files with mtime >= sinceMs included; older excluded
// testFindRecentSessions_emptyDir      — missing/empty projects dir returns []
// testRecordStep_writes               — recordStep writes step totals to the token file
// testRecordStep_accumulates          — second recordStep call for a new step accumulates
// testSumTotals                       — arithmetic across multiple steps
// testEstimateCost                    — cost formula against known token counts
// testFormatSummary                   — output contains ticket id, step names, total row
// testPostRunRecord                   — real HTTP server verifies body and Authorization header

const fs   = require('fs');
const http = require('http');
const os   = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'token-tracker-test-'));
const PROJECTS_DIR = path.join(TMP, 'claude-projects');
const STATUS_DIR   = path.join(TMP, 'agent-status');
fs.mkdirSync(PROJECTS_DIR);
fs.mkdirSync(STATUS_DIR);

process.env.CLAUDE_PROJECTS_DIR = PROJECTS_DIR;
process.env.AGENT_STATUS_DIR    = STATUS_DIR;

const tracker = require('../token-tracker');

// ─── fixtures ────────────────────────────────────────────────────────────────

// Real-world Claude session JSONL line format (captured from
// ~/.claude/projects/*/  on this machine). Includes extra fields that the
// parser must silently ignore: server_tool_use, service_tier, cache_creation,
// inference_geo, iterations, speed.
function realAssistantLine(input, output, cacheCreate, cacheRead) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: cacheCreate,
        cache_read_input_tokens: cacheRead,
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
        service_tier: 'standard',
        cache_creation: {
          ephemeral_1h_input_tokens: cacheCreate,
          ephemeral_5m_input_tokens: 0,
        },
        inference_geo: 'not_available',
        iterations: [{
          input_tokens: input,
          output_tokens: output,
          cache_read_input_tokens: cacheRead,
          cache_creation_input_tokens: cacheCreate,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: cacheCreate },
          type: 'message',
        }],
        speed: 'standard',
      },
    },
  });
}

function userLine(text) {
  return JSON.stringify({ type: 'user', message: { content: text } });
}

function writeSession(subdir, filename, lines) {
  const dir = path.join(PROJECTS_DIR, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, filename);
  fs.writeFileSync(fp, lines.join('\n') + '\n');
  return fp;
}

// ─── tests ───────────────────────────────────────────────────────────────────

async function testParseSessionUsage_realFormat() {
  const fp = writeSession('proj-real', 'session-real.jsonl', [
    realAssistantLine(3, 265, 9929, 17981),
  ]);

  const result = tracker.parseSessionUsage(fp);

  if (result.input    !== 3)     throw new Error(`input:      got ${result.input},    want 3`);
  if (result.output   !== 265)   throw new Error(`output:     got ${result.output},   want 265`);
  if (result.cacheCreate !== 9929)  throw new Error(`cacheCreate: got ${result.cacheCreate}, want 9929`);
  if (result.cacheRead   !== 17981) throw new Error(`cacheRead:  got ${result.cacheRead},  want 17981`);
}

async function testParseSessionUsage_multiMessages() {
  const fp = writeSession('proj-multi', 'session-multi.jsonl', [
    userLine('hello'),
    realAssistantLine(10, 50, 100, 200),
    userLine('follow up'),
    realAssistantLine(5, 25, 0, 500),
  ]);

  const result = tracker.parseSessionUsage(fp);

  if (result.input      !== 15)  throw new Error(`input:      got ${result.input},   want 15`);
  if (result.output     !== 75)  throw new Error(`output:     got ${result.output},  want 75`);
  if (result.cacheCreate !== 100) throw new Error(`cacheCreate: got ${result.cacheCreate}, want 100`);
  if (result.cacheRead  !== 700) throw new Error(`cacheRead:  got ${result.cacheRead}, want 700`);
}

async function testParseSessionUsage_malformedLines() {
  const fp = writeSession('proj-malformed', 'session-malformed.jsonl', [
    'not valid json at all {{{',
    '',
    realAssistantLine(10, 20, 0, 0),
    '{"type":"assistant","message":{}}',   // missing usage — should skip
    'also bad',
    realAssistantLine(5, 10, 0, 0),
  ]);

  const result = tracker.parseSessionUsage(fp);

  if (result.input  !== 15) throw new Error(`input:  got ${result.input},  want 15`);
  if (result.output !== 30) throw new Error(`output: got ${result.output}, want 30`);
}

async function testParseSessionUsage_noUsageFields() {
  const fp = writeSession('proj-nousage', 'session-nousage.jsonl', [
    userLine('a message'),
    JSON.stringify({ type: 'system', content: 'system prompt' }),
    JSON.stringify({ type: 'tool_result', content: 'some output' }),
  ]);

  const result = tracker.parseSessionUsage(fp);

  if (result.input !== 0 || result.output !== 0) {
    throw new Error(`expected all zeros, got ${JSON.stringify(result)}`);
  }
}

async function testFindRecentSessions_timing() {
  const sinceMs = Date.now();

  // Write a "before" file and back-date its mtime to 1 second before sinceMs.
  const oldFp = writeSession('proj-timing', 'old.jsonl', [realAssistantLine(1, 1, 0, 0)]);
  fs.utimesSync(oldFp, new Date(sinceMs - 1000), new Date(sinceMs - 1000));

  // Write a "after" file — its mtime will be now, which is >= sinceMs.
  const newFp = writeSession('proj-timing', 'new.jsonl', [realAssistantLine(2, 2, 0, 0)]);

  const found = tracker.findRecentSessions(sinceMs);

  if (found.includes(oldFp)) throw new Error('old file should not be included');
  if (!found.includes(newFp)) throw new Error('new file should be included');
}

async function testFindRecentSessions_emptyDir() {
  // Point to a directory that doesn't exist — should return [] without throwing.
  process.env.CLAUDE_PROJECTS_DIR = path.join(TMP, 'does-not-exist');
  const found = tracker.findRecentSessions(Date.now());
  process.env.CLAUDE_PROJECTS_DIR = PROJECTS_DIR;

  if (!Array.isArray(found)) throw new Error('expected array');
  if (found.length !== 0)    throw new Error(`expected [], got ${found.length} entries`);
}

async function testRecordStep_writes() {
  // Write a session file that will be "found" (mtime >= sinceMs).
  const sinceMs = Date.now();
  writeSession('proj-record', 'step1.jsonl', [realAssistantLine(100, 50, 200, 400)]);

  tracker.recordStep(99, 'implement', sinceMs);

  const data = JSON.parse(fs.readFileSync(path.join(STATUS_DIR, 'worker-99-tokens.json'), 'utf8'));
  const s = data.steps['implement'];
  if (!s)            throw new Error('implement step missing from token file');
  if (s.input  < 100) throw new Error(`input:  got ${s.input}, want >= 100`);
  if (s.output < 50)  throw new Error(`output: got ${s.output}, want >= 50`);
}

async function testRecordStep_accumulates() {
  const sinceMs = Date.now();
  writeSession('proj-accum', 'step2.jsonl', [realAssistantLine(10, 5, 0, 0)]);

  tracker.recordStep(98, 'analyze-ticket', sinceMs);

  const sinceMs2 = Date.now();
  writeSession('proj-accum', 'step3.jsonl', [realAssistantLine(20, 10, 0, 0)]);

  tracker.recordStep(98, 'implement', sinceMs2);

  const data = JSON.parse(fs.readFileSync(path.join(STATUS_DIR, 'worker-98-tokens.json'), 'utf8'));
  if (!data.steps['analyze-ticket']) throw new Error('analyze-ticket step missing');
  if (!data.steps['implement'])      throw new Error('implement step missing');
}

async function testSumTotals() {
  const steps = {
    'analyze-ticket': { input: 1000, output: 200, cacheRead: 5000, cacheCreate: 100 },
    'implement':      { input: 3000, output: 800, cacheRead: 20000, cacheCreate: 500 },
    'review':         { input: 500,  output: 100, cacheRead: 8000,  cacheCreate: 0   },
  };
  const totals = tracker.sumTotals(steps);

  if (totals.input      !== 4500)  throw new Error(`input:      ${totals.input}`);
  if (totals.output     !== 1100)  throw new Error(`output:     ${totals.output}`);
  if (totals.cacheRead  !== 33000) throw new Error(`cacheRead:  ${totals.cacheRead}`);
  if (totals.cacheCreate !== 600)  throw new Error(`cacheCreate: ${totals.cacheCreate}`);
}

async function testEstimateCost() {
  // 1M input tokens @ $3/M = $3
  // 1M output tokens @ $15/M = $15
  // 1M cache-write  @ $3.75/M = $3.75
  // 1M cache-read   @ $0.30/M = $0.30
  const cost = tracker.estimateCost({
    input: 1_000_000,
    output: 1_000_000,
    cacheCreate: 1_000_000,
    cacheRead: 1_000_000,
  });

  const expected = 3.00 + 15.00 + 3.75 + 0.30;
  if (Math.abs(cost - expected) > 0.001) {
    throw new Error(`cost: got ${cost}, want ${expected}`);
  }
}

async function testFormatSummary() {
  const steps = {
    'implement':      { input: 25000, output: 5000, cacheRead: 100000, cacheCreate: 500 },
    'analyze-ticket': { input: 10000, output: 2000, cacheRead: 40000,  cacheCreate: 0   },
  };
  const totals = tracker.sumTotals(steps);
  const out = tracker.formatSummary('QUO-123', steps, totals, 1.23, 47 * 60 * 1000);

  if (!out.includes('QUO-123'))        throw new Error('missing ticket id');
  if (!out.includes('implement'))      throw new Error('missing step name');
  if (!out.includes('analyze-ticket')) throw new Error('missing step name');
  if (!out.includes('TOTAL'))          throw new Error('missing TOTAL row');
  if (!out.includes('$1.23'))          throw new Error('missing cost');
  if (!out.includes('47m'))            throw new Error('missing duration');
}

async function testPostRunRecord() {
  let received = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received = {
        method: req.method,
        path: req.url,
        auth: req.headers['authorization'],
        body: JSON.parse(body),
      };
      res.writeHead(201);
      res.end();
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  await tracker.postRunRecord(
    { ticket_id: 'QUO-456', input_tokens: 1000, output_tokens: 200 },
    `http://127.0.0.1:${port}`,
    'my-secret-token'
  );

  await new Promise((resolve) => server.close(resolve));

  if (!received)                                  throw new Error('server received no request');
  if (received.method !== 'POST')                 throw new Error(`method: ${received.method}`);
  if (received.path !== '/internal/muaddib-runs') throw new Error(`path: ${received.path}`);
  if (received.auth !== 'Bearer my-secret-token') throw new Error(`auth: ${received.auth}`);
  if (received.body.ticket_id !== 'QUO-456')      throw new Error(`body.ticket_id: ${received.body.ticket_id}`);
  if (received.body.input_tokens !== 1000)        throw new Error(`body.input_tokens: ${received.body.input_tokens}`);
}

// ─── runner ──────────────────────────────────────────────────────────────────

async function main() {
  const tests = [
    ['parseSessionUsage — real Claude format with extra fields ignored',    testParseSessionUsage_realFormat],
    ['parseSessionUsage — multiple messages summed correctly',               testParseSessionUsage_multiMessages],
    ['parseSessionUsage — malformed lines skipped gracefully',              testParseSessionUsage_malformedLines],
    ['parseSessionUsage — messages without usage field produce zeros',      testParseSessionUsage_noUsageFields],
    ['findRecentSessions — files at/after sinceMs included; older excluded', testFindRecentSessions_timing],
    ['findRecentSessions — missing projects dir returns []',                testFindRecentSessions_emptyDir],
    ['recordStep — writes step totals to worker token file',                testRecordStep_writes],
    ['recordStep — second call for new step accumulates alongside first',   testRecordStep_accumulates],
    ['sumTotals — correct arithmetic across multiple steps',                testSumTotals],
    ['estimateCost — matches Sonnet 4 pricing formula',                     testEstimateCost],
    ['formatSummary — output contains ticket, step names, total, cost',     testFormatSummary],
    ['postRunRecord — POSTs correct body and Authorization header',         testPostRunRecord],
  ];

  let passed = 0;
  for (const [name, fn] of tests) {
    process.stdout.write(`  ${name}... `);
    try {
      await fn();
      process.stdout.write('PASS\n');
      passed++;
    } catch (err) {
      process.stdout.write(`FAIL\n    ${err.message}\n`);
    }
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed}/${tests.length} passed`);
  if (passed < tests.length) process.exit(1);
}

main().catch((err) => {
  fs.rmSync(TMP, { recursive: true, force: true });
  console.error('FAIL —', err.message);
  process.exit(1);
});
