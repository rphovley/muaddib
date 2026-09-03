#!/usr/bin/env node
'use strict';
// Example/dogfooding sizing hook for muaddib's own self-hosting (muaddib#106).
//
// This is a NAIVE placeholder heuristic, not a serious sizing algorithm — it
// exists purely so scripts/size-and-schedule.js has a configured hook to gate
// on when we dogfood the split path against muaddib's own issues. A real
// consuming project should replace this with whatever reflects its own notion
// of ticket size (story points already in the task manager, an LLM call, a
// team-specific rubric — sizing-signal.js deliberately doesn't care).
//
// Contract (orchestrator/sizing-signal.js#validateSignal): print JSON on
// stdout — { size, confidence, recommendSplit, blockingQuestions? } — and
// exit 0. Invoked as `node sizing.js <ticketId>`, with MUADDIB_TICKET_ID also
// set in the environment.

const fs = require('fs');
const path = require('path');

const ticketId = process.argv[2] || process.env.MUADDIB_TICKET_ID;

// Prefer the ticket JSON a real worker run already fetched (no re-fetch, no
// extra credentials needed) — the same file gather-context.js and
// size-and-schedule.js read. Falls back to a live fetch via the project's
// configured ticket source for standalone/manual invocation.
async function loadTicketText(id) {
  const workerIndex = process.env.WORKER_INDEX || '0';
  try {
    const raw = JSON.parse(fs.readFileSync(`/tmp/ticket-${workerIndex}.json`, 'utf8'));
    return `${raw.title || ''}\n\n${raw.description || raw.body || ''}`;
  } catch (_) {
    // No cached ticket — fall through to a live fetch.
  }

  try {
    const { getTicketSource } = require(path.join(__dirname, '..', '..', 'services', 'ticket-source'));
    const source = getTicketSource(process.env.TICKET_SOURCE);
    const ticket = await source.fetchTicket(id);
    if (!ticket) return '';
    return `${ticket.title || ''}\n\n${ticket.description || ticket.body || ''}`;
  } catch (_) {
    return '';
  }
}

// Crude proxy for scope: word count, weighted up by explicit work-stream
// headers and checklist items — a long single-ask description isn't "big",
// but a plan with several dependency-ordered streams is.
function sizeFor(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  const streamHeaders = (text.match(/\*\*\s*Stream\s+\d+/gi) || []).length;
  const checklistItems = (text.match(/^\s*-\s*\[[ x]\]/gim) || []).length;
  const signal = words + streamHeaders * 100 + checklistItems * 40;

  if (signal < 150) return 'XS';
  if (signal < 400) return 'S';
  if (signal < 800) return 'M';
  if (signal < 1500) return 'L';
  return 'XL';
}

async function main() {
  if (!ticketId) {
    process.stderr.write('sizing.js: no ticket id (argv[2] or MUADDIB_TICKET_ID)\n');
    process.exit(1);
  }

  const text = await loadTicketText(ticketId);
  const size = sizeFor(text);
  const recommendSplit = size === 'L' || size === 'XL';

  process.stdout.write(
    JSON.stringify({
      size,
      confidence: 'low', // naive word-count heuristic — never claim more than "low"
      recommendSplit,
    }),
  );
}

main();
