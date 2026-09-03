#!/usr/bin/env node
'use strict';
// muaddib's ACTIVE sizing hook (`.muaddib/hooks/sizing.js`) — a live
// implementation of the well-known `.muaddib/hooks/sizing(.js|.sh)` hook that
// orchestrator/sizing-signal.js#findSizingHook discovers and runs as
// `node <hook> <ticketId>` (ticket id at process.argv[2], also env
// MUADDIB_TICKET_ID). A hook prints, as its sole stdout, the Sizing Signal JSON
// object computeSizingSignal parses:
//   { size, confidence, recommendSplit, blockingQuestions? }
// See orchestrator/sizing-signal.js#validateSignal for the exact contract.
//
// SELF-HOSTING — muaddib now sizes its OWN tickets for real (muaddib#118): this
// ships at the exact `sizing.js` name findSizingHook matches, so muaddib self-
// hosting flips from `{ configured: false }` to a real signal and the
// scripts/size-and-schedule.js split path (muaddib#106) finally runs against a
// genuine sizing decision — the whole point of the #106/#107 dogfooding effort.
// The ~90s-per-ticket ConductorSession cost is deliberately accepted: sizing runs
// once per ticket (not per request), so it is not a hot path. muaddib's own
// tickets no longer resolve `{ configured: false }`; that non-error state still
// covers any project that ships no sizing hook (see sizing-signal.js).
//
// DOUBLES AS THE REFERENCE: this file is also the copyable reference other
// projects adapt — a consuming project drops its own `.muaddib/hooks/sizing.js`
// (this exact contract) and owns it entirely. A project that prefers a cheap
// heuristic over an LLM call swaps out the run() body; sizing-signal.js is
// agnostic about how the hook forms its answer.
//
// WHY THIS EXISTS (muaddib#117, superseding #116): the split path in
// scripts/size-and-schedule.js (muaddib#106) had never run against a real sizing
// signal because no reference hook existed. #116 proposed a word-count heuristic;
// but sizing/splitting is a judgment call a model reading the ticket + gathered
// context does meaningfully better than counting words. So this hook gets
// its judgment from an LLM — reusing the repo's verified-interactive
// ConductorSession driver rather than a headless `claude -p` call (the repo
// deliberately keeps all LLM work on the subscription-billed interactive session;
// see orchestrator/conductor-session.js's header). A real consuming project may
// prefer a cheap heuristic instead — sizing-signal.js is agnostic about how the
// hook forms its answer.
//
// STRUCTURE mirrors scripts/size-and-schedule.js / scripts/gather-context.js: a
// testable async run(opts) core with injectable deps, and a thin
// require.main === module CLI wrapper. Tests drive run() with a fake session and
// never spin up real tmux/`claude` (see scripts/test-sizing-hook.js).

const fs = require('fs');
const path = require('path');

// ─── timeout budgeting ─────────────────────────────────────────────────────────
// sizing-signal.js#runHook SIGKILLs this hook at DEFAULT_HOOK_TIMEOUT_MS (120000ms).
// SIGKILL is uncatchable — a `finally` cleanup would never run and would leak an
// orphan tmux/`claude` process — so keep the session's own bounded loops well under
// that outer kill, with real margin. ConductorSession's start()/ask() deadlines are
// Date.now()-based: 30000 (ready) + 60000 (ask) ≈ 90000 worst case, ~30s of slack.
const READY_TIMEOUT_MS = 30000;
const ASK_TIMEOUT_MS = 60000;

// ─── helpers ─────────────────────────────────────────────────────────────────

// Read the ticket object fetch-ticket.js already wrote for this worker, so we do
// not re-fetch during the normal fleet flow. Returns null when absent/unreadable.
function readTicketJson(worker) {
  try {
    return JSON.parse(fs.readFileSync(`/tmp/ticket-${worker}.json`, 'utf8'));
  } catch (_) {
    return null;
  }
}

// Read a `.muaddib/<name>` file under repo, or null when absent/unreadable.
function readMuaddibFile(repo, name) {
  try {
    return fs.readFileSync(path.join(repo, '.muaddib', name), 'utf8');
  } catch (_) {
    return null;
  }
}

// Read the prompt template shipped beside this hook. Kept file-relative (not
// repo-relative) so the hook finds its own template regardless of cwd.
function readPromptTemplate() {
  return fs.readFileSync(path.join(__dirname, 'sizing-prompt.md'), 'utf8');
}

// Single-pass placeholder fill. Every placeholder is replaced in ONE left-to-
// right scan, so a value inserted for one placeholder can never be re-scanned and
// matched as another — e.g. a ticket title that literally contains the text
// `{{TICKET_BODY}}` must survive verbatim, not get overwritten by the body pass.
// A function replacer inserts each value literally, so a `$` or `{` in the ticket
// body or context is never misread as a replacement pattern.
function fillTemplate(template, values) {
  const keys = Object.keys(values);
  if (keys.length === 0) return template;
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(keys.map(escape).join('|'), 'g');
  return template.replace(re, (m) => values[m]);
}

// Pull the model's JSON object out of the settled response text. The model is
// instructed to emit ONLY the object, but don't assume perfect compliance. A
// greedy first-`{`..last-`}` span breaks whenever the surrounding prose carries a
// stray brace (e.g. "Here's my take {see rubric}: {...}" or a trailing "{note}"),
// swallowing that prose into an unparseable span. Instead, scan each candidate
// object starting at a `{`, tracking brace depth while skipping over string
// literals (so braces inside a JSON string, or in prose, never throw off the
// match).
//
// Return the LAST balanced span that JSON.parses, not the first: ConductorSession
// hands back the newly-rendered pane region, which includes the echoed prompt
// (the interpolated {{TICKET_BODY}}/{{CONTEXT}} and the response-format section)
// BEFORE the model's answer. Since context and ticket bodies frequently carry
// their own JSON, a first-match would return that echoed blob instead of the
// sizing signal; the model's actual object is the final one, so last-match is the
// robust choice. Validation against the enums is sizing-signal.js#validateSignal's
// job; this hook just emits what it parsed.
function extractJsonObject(text) {
  const s = String(text == null ? '' : text);
  let parsed;
  let found = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            parsed = JSON.parse(s.slice(i, j + 1));
            found = true;
            i = j; // keep the LAST match: resume scanning past this object
          } catch (_) {
            // this `{` didn't start valid JSON — try the next one
          }
          break;
        }
      }
    }
  }
  if (found) return parsed;
  throw new Error(
    `sizing hook: no JSON object found in model response: ${JSON.stringify(s.slice(0, 300))}`,
  );
}

// Reap orphaned sizing tmux sessions left behind by a PRIOR run that the outer
// sizing-signal SIGKILL (uncatchable — our `finally` never ran) killed mid-flight
// before stop() could tear the session down. Each session is named
// `sizing-<pid>-…`; a session whose owning pid is no longer alive is a definite
// orphan, so kill it by name. A session whose pid IS still alive belongs to a
// concurrent worker's in-flight run — never touch it. Best-effort throughout: no
// tmux server, no matching sessions, or tmux absent entirely all mean "nothing to
// reap", never an error that should fail sizing.
function reapOrphanSizingSessions(deps = {}) {
  const spawn = deps.spawnSync ?? require('child_process').spawnSync;
  const pidAlive =
    deps.pidAlive ??
    ((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        // ESRCH => gone (reap); EPERM => exists but not ours (leave it).
        return e.code === 'EPERM';
      }
    });
  let names;
  try {
    const r = spawn('tmux', ['list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf8',
    });
    if (!r || r.status !== 0 || !r.stdout) return;
    names = r.stdout.split('\n');
  } catch (_) {
    return;
  }
  for (const raw of names) {
    const name = raw.trim();
    const m = /^sizing-(\d+)-/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!pid || pidAlive(pid)) continue;
    try {
      spawn('tmux', ['kill-session', '-t', name]);
    } catch (_) {
      // best-effort — a session that vanished between listing and killing is fine
    }
  }
}

// ─── core logic (injectable deps for testing) ──────────────────────────────────

// opts (all optional; env/defaults otherwise):
//   ticketId         the ticket to size (else env MUADDIB_TICKET_ID)
//   worker           worker index (else env WORKER_INDEX, default '0')
//   repo             repo dir (else env REPO_DIR, default process.cwd())
//   ticket           injected ticket object { title, description } (skips the read)
//   context          injected context string (skips reading .muaddib/context.md)
//   promptTemplate   injected template string (skips reading sizing-prompt.md)
//   createSession    session factory (defaults to createConductorSession) — a fake
//                    { start, ask, stop } in tests, so no real tmux/`claude` runs
//   ticketSource     injected TicketSource (the live-fetch fallback seam)
// Returns the parsed sizing object (NOT validated here); rejects on any failure.
async function run(opts = {}) {
  const worker = opts.worker ?? process.env.WORKER_INDEX ?? '0';
  const repo = (opts.repo ?? process.env.REPO_DIR ?? process.cwd()).trim();
  const ticketId = (opts.ticketId ?? process.env.MUADDIB_TICKET_ID ?? '').trim();
  if (!ticketId) {
    throw new Error('sizing hook: no ticket id (argv[2] / MUADDIB_TICKET_ID / opts.ticketId)');
  }

  // Ticket: prefer the already-fetched /tmp/ticket-${worker}.json (no re-fetch in
  // the fleet flow); fall back to a live fetch for standalone/manual invocation.
  let ticket = opts.ticket ?? readTicketJson(worker);
  // Guard against sizing the WRONG ticket. The cache file is keyed by worker, not
  // by ticket id, so a stale or cross-worker cache (e.g. WORKER_INDEX unset →
  // worker '0' reading another run's /tmp/ticket-0.json) can hold a DIFFERENT
  // ticket than the one we were asked to size — and size-and-schedule.js would
  // then split the wrong parent. When the cached ticket carries an identifier that
  // disagrees with the requested ticketId, distrust the cache and live-fetch the
  // ticket we actually mean. (An injected/identifier-less ticket skips the check.)
  if (ticket && ticket.identifier && ticket.identifier !== ticketId) {
    ticket = null;
  }
  if (!ticket) {
    // Lazy require so the module (and its tests, which always inject a ticket)
    // never pull the ticket-source registry unless a live fetch is actually needed.
    const source = opts.ticketSource ?? require('../../services/ticket-source').getTicketSource();
    ticket = await source.fetchTicket(ticketId);
  }
  if (!ticket) {
    throw new Error(`sizing hook: could not resolve ticket ${ticketId}`);
  }

  // Context: gather-context's aggregated .muaddib/context.md when present, else an
  // explicit "(none gathered)" so the prompt section is never a bare blank.
  const contextText =
    opts.context ?? readMuaddibFile(repo, 'context.md') ?? '';
  const contextSection = contextText.trim() || '(none gathered)';

  const template = opts.promptTemplate ?? readPromptTemplate();
  const prompt = fillTemplate(template, {
    '{{TICKET_TITLE}}': ticket.title || '',
    '{{TICKET_BODY}}': ticket.description || '',
    '{{CONTEXT}}': contextSection,
  });

  // A unique, short-lived session name per call — NEVER the shared 'conductor'
  // default — so concurrent sizing calls across workers don't collide on one tmux
  // session's I/O. pid separates workers (distinct processes); the random suffix
  // separates two calls within one process that land in the same millisecond, so
  // Date.now() alone can't collide. readyTimeoutMs goes on the constructor
  // (start() takes no args).
  const createSession =
    opts.createSession ?? require('../../orchestrator/conductor-session').createConductorSession;
  // Only for a real tmux-backed session (default factory): sweep up any orphan
  // sizing sessions a previously SIGKILL'd run leaked. Injected-fake tests pass
  // their own factory and create no tmux state, so skip the sweep there.
  if (!opts.createSession) reapOrphanSizingSessions();
  const rand = require('crypto').randomBytes(3).toString('hex');
  const sessionName = `sizing-${process.pid}-${Date.now()}-${rand}`;
  const session = createSession({ name: sessionName, readyTimeoutMs: READY_TIMEOUT_MS });

  // try/finally so start-failure, ask-timeout, and success all tear the session
  // down — the outer SIGKILL can't run our cleanup, so we must finish in-band.
  try {
    session.start();
    const response = session.ask(prompt, { timeoutMs: ASK_TIMEOUT_MS });
    return extractJsonObject(response);
  } finally {
    try {
      session.stop();
    } catch (_) {
      // Best-effort teardown — a stop() failure must not mask the real result/error.
    }
  }
}

// ─── CLI entry point ──────────────────────────────────────────────────────────
// run() writes nothing to stdout, so the sole stdout output is this final JSON —
// the contract channel computeSizingSignal parses. Any failure exits non-zero with
// the reason on stderr (a genuine error to computeSizingSignal, distinct from the
// "not configured" no-op).
if (require.main === module) {
  run({ ticketId: process.argv[2] })
    .then((signal) => {
      process.stdout.write(JSON.stringify(signal));
    })
    .catch((err) => {
      process.stderr.write(`[sizing] ${err && err.message ? err.message : err}\n`);
      process.exit(1);
    });
}

module.exports = { run, extractJsonObject, readTicketJson, reapOrphanSizingSessions };
