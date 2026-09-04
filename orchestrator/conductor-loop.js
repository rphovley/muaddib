'use strict';
// Conductor reasoning loop — the Conductor's first real detect → decide → act →
// audit cycle (muaddib#124), replacing the bare self-health heartbeat as the
// thing that actually watches the fleet.
//
// This is pure logic behind injected collaborators (the fleet-state.js /
// worker-input.js testability convention): every seam that touches tmux, docker,
// the event files, the manifest, or the Decision Log is a dependency with a real
// default, so the unit tests drive the whole cycle with fakes and no I/O.
//
//   detect  — subscribe() to each worker's `.events` stream (NOT a new fs.watch:
//             a real FS watcher over the Docker bind-mounted status dir drops and
//             duplicates events on macOS virtiofs). subscribe() is only the
//             wake-up; on each event we recompute fleet-state.js#workerStatus so
//             the loop reports the exact same coarse states inspect-cli does, and
//             edge-detect a transition INTO a trigger state with a per-worker
//             latch so one block is triaged once, not on every following event.
//   decide  — read the project's autonomyLevel; at L0 (report-only) skip the
//             model entirely and escalate, behaving exactly like today. At L1+
//             invoke the /triage skill in the Conductor's own session — a genuine
//             model judgment weighted by autonomyLevel, not a hard gate — and
//             parse its Decision/Rationale/Payload. Any ambiguity → escalate.
//   act     — answer-directly → worker-input.js#sendInput types the answer into
//             the worker's claude session; escalate → notify.sh alerts the human.
//   audit   — either branch appends a Handoff Record to the Decision Log, the
//             log's first real content.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const events = require('./events');
const fleetState = require('./fleet-state');
const decisionLog = require('./decision-log');
const state = require('./state');
const { buildNotification } = require('./notify-format');
const workerInput = require('./worker-input');
const muaddibConfig = require('../services/muaddib-config');
const { resolveMuaddibRoot } = require('./muaddib-root');
const { getTicketSource } = require('../services/ticket-source');
const gatherDispatchContext = require('../scripts/gather-dispatch-context');

// Fleet root, for resolving the spawn command's fleet-control-cli.js path in
// buildDispatchDecisionPrompt() — same resolution fleet-control.js already uses
// (self-hosting vs. a consuming project's REPO/muaddib nesting).
const FLEET_DIR = resolveMuaddibRoot(process.env.REPO_ROOT || path.join(__dirname, '..'));

// The coarse states a worker enters when it has stopped and needs a decision —
// the same vocabulary status.js writes and inspect-cli reports. Overridable via
// opts.triggerStates.
const DEFAULT_TRIGGER_STATES = Object.freeze([
  'BLOCKED',
  'AWAITING_REVIEW',
  'WAITING_FOR_INPUT',
]);

// Matches the repoDir default the other host/worker services resolve to
// (sizing-signal.js, goals.js): REPO_DIR in a worker, the fleet checkout on the
// host. The manifest (autonomyLevel) and the Decision Log both live under it.
const DEFAULT_REPO_DIR = process.env.REPO_DIR || '/home/worker/repo';

// ─── triage output parsing ──────────────────────────────────────────────────

// The /triage skill emits three labeled sections, in order: Decision, Rationale,
// Payload. Labels may be bold/numbered/heading-decorated ("**Decision:**",
// "3. Payload:"), so labelOf() tolerates a leading run of markdown/list chrome.
const SECTION_LABELS = ['Decision', 'Rationale', 'Payload'];
const LABEL_PREFIX = '[\\s\\d.)#>*_-]*';
const LABEL_RE = new RegExp(
  `^${LABEL_PREFIX}(${SECTION_LABELS.join('|')})\\b`,
  'i',
);
// Strips the "<chrome>Label:<chrome>" lead-in so the inline remainder of a label
// line (e.g. the "escalate" in "Decision: escalate") is captured as content.
const LABEL_LEAD_RE = new RegExp(
  `^${LABEL_PREFIX}(?:${SECTION_LABELS.join('|')})\\b[\\s:*_-]*`,
  'i',
);

function labelOf(line) {
  const m = LABEL_RE.exec(line);
  return m ? m[1].toLowerCase() : null;
}

// Return the body of one labeled section — the inline remainder of the label
// line plus every following line up to the next label — trimmed, or null when
// the label is absent. One parser for all three sections so Decision, Rationale,
// and Payload can't drift on how a section's bounds are found.
function extractSection(text, label) {
  const want = label.toLowerCase();
  const out = [];
  let capturing = false;
  for (const line of String(text == null ? '' : text).split('\n')) {
    const lab = labelOf(line);
    if (lab) {
      if (lab === want) {
        capturing = true;
        const inline = line.replace(LABEL_LEAD_RE, '');
        if (inline.trim()) out.push(inline);
        continue;
      }
      if (capturing) break; // the next section starts here
      continue;
    }
    if (capturing) out.push(line);
  }
  const body = out.join('\n').trim();
  return body || null;
}

// Read the Decision section and reduce it to one of the two skill verbs.
// Deliberately escalate-biased: "escalate", both verbs together, or neither is
// resolved to escalate — a consequential decision reached by a garbled parse
// still lands with the human, never silently sent to the worker.
function classifyDecision(decisionText) {
  const hay = (decisionText || '').toLowerCase();
  const wantsAnswer = /answer[\s_-]?directly/.test(hay) || /\banswer\b/.test(hay);
  const wantsEscalate = /escalate/.test(hay);
  if (wantsAnswer && !wantsEscalate) return 'answer-directly';
  return 'escalate';
}

// Parse the /triage skill's reply into { decision, rationale, payload }.
// decision is 'answer-directly' only when the skill clearly said so AND supplied
// a Payload to deliver; a missing payload on an answer is treated as a parse
// failure and downgraded to escalate (there is nothing to send). Everything else
// escalates. Exported as a pure seam.
function parseTriageDecision(text) {
  const decisionText = extractSection(text, 'Decision');
  const rationale = extractSection(text, 'Rationale');
  const payload = extractSection(text, 'Payload');
  const verb = classifyDecision(decisionText);

  if (verb === 'answer-directly' && payload) {
    return { decision: 'answer-directly', rationale, payload };
  }
  return { decision: 'escalate', rationale, payload: payload || null };
}

// ─── triage prompt ──────────────────────────────────────────────────────────

// Build the prompt fed into the Conductor's session to run /triage. The leading
// `/triage` line invokes the skill (the same "a leading `/` runs a skill"
// convention the daemon's initial-prompt path relies on); the rest is explicit
// context — worker, ticket, coarse state, captured question hint, and the
// autonomy level as a supplied lever, not a hard gate. Exported as a pure seam.
function buildTriagePrompt(ctx = {}) {
  const { worker, ticketId, ticketUrl, state: coarseState, question, autonomyLevel } = ctx;
  const lines = [
    '/triage',
    '',
    'A worker in the fleet has stopped and is waiting on a decision. Triage it.',
    '',
    `- Worker: ${worker}`,
    `- Ticket: ${ticketId || ticketUrl || '(unknown)'}`,
  ];
  if (ticketUrl && ticketId) lines.push(`- Ticket URL: ${ticketUrl}`);
  lines.push(`- Worker state: ${coarseState}`);
  lines.push(`- Autonomy level: ${autonomyLevel}`);
  lines.push(
    `- Question / context: ${
      question || '(none captured — inspect the worker to understand why it stopped)'
    }`,
  );
  lines.push('');
  lines.push(
    'Follow the triage skill: weigh the autonomy level, then output ' +
      'Decision / Rationale / Payload exactly as the skill specifies.',
  );
  return lines.join('\n');
}

// ─── dispatch-decision prompt (split sub-tickets) ───────────────────────────

// Build the prompt that runs /dispatch-decision on one ticket, in the exact
// shape muaddib.sh's conductor-routing branch builds for a human-triggered
// dispatch: the pre-gathered context block first, then the same triage/spawn
// instructions. Reused here so a worker's own sizing step splitting a ticket
// gets its children triaged and dispatched by the fleet manager itself — the
// same judgment (readiness, capacity, what's already in flight) a human
// running `npm run muaddib <ticket>` would get — instead of the children just
// sitting on the "auto" label waiting for whatever else might pick it up.
// `fleetDir` (default FLEET_DIR) is where the spawn command's fleet-control-cli.js
// path is resolved from; overridable for tests.
function buildDispatchDecisionPrompt(ticketId, contextMarkdown, opts = {}) {
  const fleetDir = opts.fleetDir || FLEET_DIR;
  const cliPath = path.join(fleetDir, 'orchestrator', 'fleet-control-cli.js');
  return [
    '/dispatch-decision',
    `ticket: ${ticketId}`,
    '',
    contextMarkdown || '(no pre-dispatch context available — gather what you need yourself.)',
    '',
    "Triage this ticket using the context above — it already covers the ticket, its",
    "comments, current fleet state, and related PRs/branches, so don't re-fetch any",
    "of that unless something above looks stale or incomplete. If — and only if —",
    'the decision is to dispatch, provision the worker now by running exactly:',
    `  node "${cliPath}" spawn 1 "/muaddib ${ticketId}"`,
    'On defer or skip, do not spawn — just record the decision and its rationale.',
  ].join('\n');
}

// Reduce a /dispatch-decision reply to a compact { decision, rationale } pair
// for the Decision Log — the actual act (spawning, or not) already happened
// inside the model's own turn via its own tool calls; this is audit-trail only,
// not something the caller branches on. Reuses the same Decision/Rationale
// section parser /triage's replies already go through.
function summarizeDispatchDecisionReply(text) {
  return {
    decision: extractSection(text, 'Decision') || '(no Decision section found)',
    rationale: extractSection(text, 'Rationale') || null,
  };
}

// One-line human-facing summary for the escalation notification. The Decision
// Log carries the full record; this is the alert body a human reads first.
function escalationMessage(ctx) {
  const who = ctx.ticketId || ctx.ticketUrl || `worker ${ctx.worker}`;
  const detail = ctx.detail || ctx.question;
  const tail = detail ? ` — ${String(detail).split('\n')[0]}` : '';
  return `Worker ${ctx.worker} (${who}) is ${ctx.state} and needs a human decision${tail}`;
}

// ─── loop ───────────────────────────────────────────────────────────────────

function createConductorLoop(opts = {}) {
  if (!opts.session) {
    throw new Error('createConductorLoop: a session is required');
  }
  const session = opts.session;
  const repoDir = opts.repoDir || DEFAULT_REPO_DIR;
  const triggerStates = opts.triggerStates || DEFAULT_TRIGGER_STATES;

  // Injected collaborators, each with its real default. Every one is a seam the
  // unit tests replace with a fake so the cycle runs with no tmux/docker/fs.
  const listWorkers = opts.listWorkers || events.listWorkers;
  const subscribe = opts.subscribe || events.subscribe;
  const workerStatus = opts.workerStatus || fleetState.workerStatus;
  const readAutonomyLevel = opts.readAutonomyLevel || muaddibConfig.readAutonomyLevel;
  const sendInput = opts.sendInput || ((worker, text) => workerInput.sendInput(worker, text));
  const appendDecision = opts.appendDecision || decisionLog.appendDecision;
  const stateGet = opts.stateGet || state.get;
  const notify = opts.notify || defaultNotify;
  const log = opts.log || ((msg) => process.stdout.write(`[conductor-loop] ${msg}\n`));
  const readMuaddibConfig = opts.readMuaddibConfig || muaddibConfig.readMuaddibConfig;
  const resolveTicketSource = opts.getTicketSource || getTicketSource;
  const gatherContext = opts.gatherDispatchContext || gatherDispatchContext.run;

  // worker index -> subscription handle ({ kill }). One per watched worker.
  const subs = new Map();
  // worker index -> the trigger state we last acted on. Set when we triage a
  // trigger-state entry, cleared when the worker leaves the trigger set. This is
  // the edge-trigger: a worker that stays BLOCKED across many following events is
  // triaged once, a later block (after it went RUNNING again) re-fires, AND a
  // move BETWEEN trigger states (e.g. BLOCKED -> AWAITING_REVIEW, which never
  // leaves the set) re-fires too rather than being latched away.
  const handled = new Map();
  // worker index -> most recent notify event msg, the question hint for triage.
  const questionHints = new Map();

  function safe(fn, fallback = null) {
    try {
      const v = fn();
      return v == null ? fallback : v;
    } catch (_) {
      return fallback;
    }
  }

  // Default human alert: fire services/notify.sh (the same desktop channel
  // runner.js#fireNotification uses) detached and fire-and-forget. Falls back to
  // a log line when the script isn't on disk. Composed via notify-format so it
  // reads like every other muaddib alert. `message` is passed with no kind so it
  // becomes the subtitle (the BLOCKED kind has a fixed subtitle that would drop
  // it); the null kind still resolves to the alert tier.
  function defaultNotify(worker, message) {
    const note = buildNotification({
      worker,
      projectName: process.env.MUADDIB_PROJECT_NAME || '',
      ticketTitle: safe(() => stateGet(worker, 'ticket_title'), ''),
      message,
    });
    const script = path.resolve(__dirname, '..', 'services', 'notify.sh');
    if (fs.existsSync(script)) {
      spawn(
        'bash',
        [script, String(worker), note.title, note.subtitle, note.tier, note.sound],
        { stdio: 'ignore', detached: true },
      ).unref();
    } else {
      log(`NOTIFY w${worker}: ${note.title} — ${note.subtitle}`);
    }
  }

  // Append one Handoff Record. `id`, `scope`, and `timestamp` are computed by
  // decision-log.js; we supply the content. Best-effort — a log write failure
  // must not crash the loop mid-cycle.
  function audit(ctx, extra) {
    const fields = {
      worker: ctx.worker,
      ticket: ctx.ticketId || ctx.ticketUrl || null,
      question: ctx.question || null,
      autonomyLevel: ctx.autonomyLevel,
      decision: extra.decision, // 'answered' | 'escalated'
    };
    if (extra.sent != null) fields.sent = extra.sent;
    if (ctx.rationale) fields.rationale = ctx.rationale;
    try {
      appendDecision(repoDir, ctx.scope, fields);
    } catch (err) {
      log(`appendDecision failed for worker ${ctx.worker}: ${err.message}`);
    }
  }

  function escalate(ctx) {
    try {
      notify(ctx.worker, escalationMessage(ctx));
    } catch (err) {
      log(`notify failed for worker ${ctx.worker}: ${err.message}`);
    }
    audit(ctx, { decision: 'escalated' });
    log(`escalated worker ${ctx.worker} (${ctx.state}, autonomy ${ctx.autonomyLevel})`);
  }

  function answer(ctx, answerText) {
    try {
      sendInput(ctx.worker, answerText);
    } catch (err) {
      // Delivery failed — the worker is still stuck. Fall back to escalate so a
      // human still sees it rather than dropping the block on the floor.
      log(`sendInput failed for worker ${ctx.worker}: ${err.message} — escalating`);
      escalate({ ...ctx, detail: `answer delivery failed: ${err.message}` });
      return;
    }
    audit(ctx, { decision: 'answered', sent: answerText });
    log(`answered worker ${ctx.worker} (${ctx.state}, autonomy ${ctx.autonomyLevel})`);
  }

  // Decide + act for a worker that just entered a trigger state.
  function handleBlocked(worker, status) {
    const ticketUrl = safe(() => stateGet(worker, 'ticket_url'));
    const ticketId = safe(() => stateGet(worker, 'ticket_identifier'));
    const question = questionHints.get(worker) || null;
    // Scope the Handoff Record to the ticket, falling back to FLEET.
    const scope = ticketId || decisionLog.FLEET_SCOPE;

    let autonomyLevel;
    try {
      autonomyLevel = readAutonomyLevel(repoDir);
    } catch (err) {
      // A missing/invalid manifest is a config fault, not a reason to guess
      // authority — treat it as report-only and escalate.
      log(`readAutonomyLevel failed: ${err.message} — treating as L0`);
      autonomyLevel = 'L0';
    }

    const ctx = { worker, state: status.state, question, ticketUrl, ticketId, scope, autonomyLevel };

    // L0 short-circuit: report-only. Never call the model, never sendInput — go
    // straight to escalate so the loop is behavior-identical to the old bare
    // heartbeat at the default autonomy level.
    if (autonomyLevel === 'L0') {
      escalate({ ...ctx, rationale: 'L0 report-only' });
      return;
    }

    // L1+: a genuine model judgment via /triage.
    let reply;
    try {
      reply = session.ask(buildTriagePrompt(ctx));
    } catch (err) {
      log(`triage ask failed for worker ${worker}: ${err.message} — escalating`);
      escalate({ ...ctx, rationale: `triage failed: ${err.message}` });
      return;
    }

    const triage = parseTriageDecision(reply);
    if (triage.decision === 'answer-directly') {
      answer({ ...ctx, rationale: triage.rationale }, triage.payload);
    } else {
      escalate({ ...ctx, rationale: triage.rationale, detail: triage.payload });
    }
  }

  // Fan out /dispatch-decision to each ticket a worker's own sizing step just
  // split off (scripts/size-and-schedule.js's runCommit, when the operator
  // chose "create tickets and dispatch") — the same judgment and pre-gathered
  // context a human-triggered `npm run muaddib <ticket>` gets, run here instead
  // because the trigger was an event, not a human command. One child's
  // context-gather/ask failure is logged and skipped, not fatal to the rest.
  async function handleTicketsReadyForDispatch(worker, payload) {
    const children = Array.isArray(payload && payload.children) ? payload.children.filter(Boolean) : [];
    if (!children.length) return;

    let config = {};
    try {
      config = readMuaddibConfig(repoDir) || {};
    } catch (err) {
      log(`readMuaddibConfig failed (worker ${worker} split): ${err.message} — using the default ticket source`);
    }
    const source = resolveTicketSource(config.ticketSource);
    const parentTicket = (payload && payload.parentTicket) || null;

    for (const childId of children) {
      // eslint-disable-next-line no-await-in-loop
      await dispatchOneChild(worker, childId, parentTicket, source);
    }
  }

  async function dispatchOneChild(worker, childId, parentTicket, source) {
    let contextMarkdown;
    try {
      contextMarkdown = await gatherContext(childId, { source });
    } catch (err) {
      contextMarkdown = `## Pre-Dispatch Context: ${childId}\n\n(context gathering failed: ${err.message} — gather what you need yourself.)\n`;
    }

    const prompt = buildDispatchDecisionPrompt(childId, contextMarkdown);
    let reply;
    try {
      reply = session.ask(prompt);
    } catch (err) {
      log(`dispatch-decision ask failed for ${childId} (split from worker ${worker}): ${err.message}`);
      try {
        appendDecision(repoDir, childId, {
          worker,
          ticket: childId,
          parentTicket,
          decision: 'error',
          rationale: `dispatch-decision ask failed: ${err.message}`,
        });
      } catch (_) {}
      return;
    }

    const summary = summarizeDispatchDecisionReply(reply);
    try {
      appendDecision(repoDir, childId, {
        worker,
        ticket: childId,
        parentTicket,
        decision: summary.decision,
        rationale: summary.rationale || `split from ${parentTicket || 'unknown parent'} on worker ${worker}`,
      });
    } catch (err) {
      log(`appendDecision failed for ${childId}: ${err.message}`);
    }
    log(
      `dispatch-decision ran for ${childId} (split from worker ${worker}` +
        `${parentTicket ? `, parent ${parentTicket}` : ''}): ${summary.decision}`,
    );
  }

  // Per-worker event handler: capture question hints, recompute the coarse state
  // via the shared fold, and edge-detect entry into a trigger state.
  function handleEvent(worker, ev) {
    // A one-shot fan-out event, not a persistent worker state — handled
    // independently of the trigger-state latch below (it doesn't touch
    // `handled`/`questionHints`, and never re-fires for the same event since
    // it isn't re-read from a recomputed coarse state).
    if (ev && ev.event === 'tickets_ready_for_dispatch') {
      handleTicketsReadyForDispatch(worker, ev.payload).catch((err) => {
        log(`handleTicketsReadyForDispatch failed for worker ${worker}: ${err.message}`);
      });
      return;
    }

    const payload = (ev && ev.payload) || {};
    const capturedHint = !!(ev && ev.event === 'notify' && payload.msg);
    if (capturedHint) {
      questionHints.set(worker, payload.msg);
    }

    const status = workerStatus(worker);
    const inTrigger = triggerStates.includes(status.state);
    if (!inTrigger) {
      handled.delete(worker); // left the trigger set — re-arm for a later block
      // Drop the stale hint so a later, unrelated block doesn't reuse this
      // block's question — but never the hint this very event just captured.
      if (!capturedHint) questionHints.delete(worker);
      return;
    }
    // Latch on the specific trigger state: a persistent block is triaged once,
    // but a transition to a DIFFERENT trigger state (BLOCKED -> AWAITING_REVIEW)
    // is a new decision and must re-fire.
    if (handled.get(worker) === status.state) return;
    handled.set(worker, status.state);
    handleBlocked(worker, status);
  }

  // Subscribe to every worker we aren't already watching. fromEnd:true so we
  // react only to blocks that happen after we start, and idempotent (keyed on
  // the subs set) so it doubles as the new-worker pickup called on the heartbeat.
  function rescan() {
    const live = new Set(listWorkers());
    // Reap workers that have gone away: kill the poller and drop their per-worker
    // maps, or subs/handled/questionHints grow unbounded over the daemon's life.
    for (const worker of [...subs.keys()]) {
      if (live.has(worker)) continue;
      const sub = subs.get(worker);
      try {
        if (sub && typeof sub.kill === 'function') sub.kill();
      } catch (_) {}
      subs.delete(worker);
      handled.delete(worker);
      questionHints.delete(worker);
    }
    for (const worker of live) {
      if (subs.has(worker)) continue;
      const sub = subscribe(worker, (ev) => handleEvent(worker, ev), { fromEnd: true });
      subs.set(worker, sub);
    }
  }

  function start() {
    rescan();
    log(`watching ${subs.size} worker(s) for trigger states: ${triggerStates.join(', ')}`);
    return api;
  }

  function stop() {
    for (const sub of subs.values()) {
      try {
        if (sub && typeof sub.kill === 'function') sub.kill();
      } catch (_) {}
    }
    subs.clear();
  }

  const api = {
    start,
    stop,
    rescan,
    handleEvent, // used internally by subscribe; also the test drive-point
    handleTicketsReadyForDispatch, // test drive-point for the split-fan-out path directly
    // Introspection seams for tests.
    isHandled: (worker) => handled.has(worker),
    watchedWorkers: () => [...subs.keys()],
  };
  return api;
}

module.exports = {
  createConductorLoop,
  parseTriageDecision,
  buildTriagePrompt,
  buildDispatchDecisionPrompt,
  summarizeDispatchDecisionReply,
  DEFAULT_TRIGGER_STATES,
};
