#!/usr/bin/env node
'use strict';
// conductor-loop.js test suite — the Conductor's detect → decide → act → audit
// cycle, driven entirely through injected fakes. No tmux, no docker, no event
// files, no manifest, no Decision Log on disk: every collaborator is a seam.
//
// testBlockedDetectedViaSubscribe   — a BLOCKED entry arriving on the subscribe
//                                     handler is detected via workerStatus (the
//                                     shared fold), not by polling inspect-cli
// testL0NeverSendsInput             — L0 skips the model entirely: no ask, no
//                                     sendInput; escalates + audits as report-only
// testL1AnswerDirectly              — L1 answer-directly → sendInput with the
//                                     payload + a matching "answered" Decision Log
// testConsequentialEscalates        — a triage `escalate` → notify + "escalated"
//                                     record, never sendInput
// testAmbiguousParseEscalates       — unparseable triage output falls back to
//                                     escalate (safe default)
// testEdgeTriggerDedupe             — a block is handled once while it persists;
//                                     leaving + re-entering the trigger set re-fires
// testQuestionHintCaptured          — a notify event's msg becomes the triage
//                                     prompt hint and the record's question
// testFleetScopeFallback            — no ticket id → the record is scoped FLEET
// testStopKillsSubscriptions        — stop() kills every subscription
// testRescanIdempotentAndNewWorkers — rescan subscribes once per worker and picks
//                                     up workers that appear later
// testParseTriageDecision*          — the pure parser across shapes
// testBuildTriagePrompt             — the pure prompt builder carries the context

const {
  createConductorLoop,
  parseTriageDecision,
  buildTriagePrompt,
  DEFAULT_TRIGGER_STATES,
} = require('../conductor-loop');

const { FLEET_SCOPE } = require('../decision-log');

// ─── harness ──────────────────────────────────────────────────────────────────

// Build a loop wired to controllable fakes. `states` maps worker -> coarse state
// (default RUNNING); `autonomy` is the level readAutonomyLevel returns;
// `reply` is what session.ask returns. Returns { loop, spies, states, set }.
function makeLoop(overrides = {}) {
  const states = overrides.states || {};
  const stateData = overrides.stateData || {};
  const cfg = { autonomy: overrides.autonomy || 'L0', reply: overrides.reply || '' };

  const spies = {
    asks: [],
    sends: [],
    notifies: [],
    decisions: [],
    subscribes: [],
    kills: 0,
  };
  const handlers = new Map(); // worker -> the handler subscribe() was given

  const loop = createConductorLoop({
    session: {
      ask: (prompt) => {
        spies.asks.push(prompt);
        return cfg.reply;
      },
    },
    repoDir: '/fake/repo',
    listWorkers: () => overrides.workers || Object.keys(states).map(Number),
    subscribe: (worker, handler, opts) => {
      spies.subscribes.push({ worker, opts });
      handlers.set(worker, handler);
      return { kill: () => { spies.kills += 1; } };
    },
    workerStatus: (worker) => ({ worker, state: states[worker] || 'RUNNING' }),
    readAutonomyLevel: () => {
      if (cfg.autonomy instanceof Error) throw cfg.autonomy;
      return cfg.autonomy;
    },
    sendInput: (worker, text) => { spies.sends.push({ worker, text }); },
    notify: (worker, message) => { spies.notifies.push({ worker, message }); },
    appendDecision: (repoDir, scope, fields) => {
      const record = { repoDir, scope, fields };
      spies.decisions.push(record);
      return record;
    },
    stateGet: (worker, key) => (stateData[worker] || {})[key],
    log: () => {},
  });

  return {
    loop,
    spies,
    states,
    cfg,
    // Deliver an event to a worker through the handler subscribe() captured —
    // the real detection path, not a direct handleEvent() call.
    deliver: (worker, ev) => {
      const h = handlers.get(worker);
      if (!h) throw new Error(`no subscription for worker ${worker}`);
      h(ev);
    },
  };
}

const BLOCKED_EV = { event: 'state_changed', payload: { state: 'BLOCKED' } };
const RUNNING_EV = { event: 'state_changed', payload: { state: 'RUNNING' } };

// ─── detection ──────────────────────────────────────────────────────────────

async function testBlockedDetectedViaSubscribe() {
  const h = makeLoop({ states: { 3: 'RUNNING' }, autonomy: 'L0' });
  h.loop.start();

  // subscribe() must have been called fromEnd for the listed worker.
  if (h.spies.subscribes.length !== 1 || h.spies.subscribes[0].worker !== 3) {
    throw new Error(`expected one fromEnd subscribe for worker 3, got ${JSON.stringify(h.spies.subscribes)}`);
  }
  if (!h.spies.subscribes[0].opts || h.spies.subscribes[0].opts.fromEnd !== true) {
    throw new Error('subscribe must be fromEnd:true');
  }
  if (h.loop.isHandled(3)) throw new Error('worker 3 handled before any event');

  // The worker transitions to BLOCKED and an event arrives on its stream.
  h.states[3] = 'BLOCKED';
  h.deliver(3, BLOCKED_EV);

  if (!h.loop.isHandled(3)) throw new Error('BLOCKED entry via subscribe was not detected');
  if (h.spies.decisions.length !== 1) throw new Error('a Decision Log entry should have been written');
}

// ─── L0 short-circuit ─────────────────────────────────────────────────────────

async function testL0NeverSendsInput() {
  const h = makeLoop({ states: { 0: 'RUNNING' }, autonomy: 'L0' });
  h.loop.start();
  h.states[0] = 'BLOCKED';
  h.deliver(0, BLOCKED_EV);

  if (h.spies.asks.length !== 0) throw new Error('L0 must not call the triage model');
  if (h.spies.sends.length !== 0) throw new Error('L0 must never sendInput');
  if (h.spies.notifies.length !== 1) throw new Error(`L0 should escalate via notify once, got ${h.spies.notifies.length}`);
  if (h.spies.decisions.length !== 1) throw new Error('L0 should audit exactly one decision');
  const rec = h.spies.decisions[0].fields;
  if (rec.decision !== 'escalated') throw new Error(`expected escalated, got ${rec.decision}`);
  if (rec.autonomyLevel !== 'L0') throw new Error(`expected autonomyLevel L0, got ${rec.autonomyLevel}`);
  if (!/report-only/i.test(rec.rationale || '')) throw new Error(`expected report-only rationale, got ${rec.rationale}`);
}

// ─── L1+ answer-directly ────────────────────────────────────────────────────

async function testL1AnswerDirectly() {
  const reply = [
    'Decision: answer-directly',
    'Rationale: The fix is well-supported by the ticket and cheap to reverse.',
    'Payload: Use the existing helper in utils.js and re-run the tests.',
  ].join('\n');
  const h = makeLoop({
    states: { 1: 'RUNNING' },
    autonomy: 'L1',
    reply,
    stateData: { 1: { ticket_identifier: 'QUO-9', ticket_url: 'https://l/QUO-9' } },
  });
  h.loop.start();
  h.states[1] = 'BLOCKED';
  h.deliver(1, BLOCKED_EV);

  if (h.spies.asks.length !== 1) throw new Error('L1 must consult the triage model once');
  if (h.spies.sends.length !== 1) throw new Error(`answer-directly must sendInput once, got ${h.spies.sends.length}`);
  const sent = h.spies.sends[0];
  if (sent.worker !== 1) throw new Error(`sendInput to wrong worker: ${sent.worker}`);
  if (!/existing helper in utils\.js/.test(sent.text)) throw new Error(`sendInput text should be the payload, got: ${sent.text}`);
  if (h.spies.notifies.length !== 0) throw new Error('answer-directly must not notify the human');

  const rec = h.spies.decisions[0].fields;
  if (rec.decision !== 'answered') throw new Error(`expected answered, got ${rec.decision}`);
  if (rec.sent !== sent.text) throw new Error('the record must log the delivered text as `sent`');
  if (rec.ticket !== 'QUO-9') throw new Error(`expected ticket QUO-9, got ${rec.ticket}`);
  if (h.spies.decisions[0].scope !== 'QUO-9') throw new Error(`expected scope QUO-9, got ${h.spies.decisions[0].scope}`);
}

// ─── escalation ───────────────────────────────────────────────────────────────

async function testConsequentialEscalates() {
  const reply = [
    'Decision: escalate',
    'Rationale: This is an irreversible schema migration — above the granted autonomy.',
    'Payload: Worker wants to drop the legacy column. Options: keep / drop. Recommend keep.',
  ].join('\n');
  const h = makeLoop({
    states: { 2: 'RUNNING' },
    autonomy: 'L2',
    reply,
    stateData: { 2: { ticket_identifier: 'QUO-2' } },
  });
  h.loop.start();
  h.states[2] = 'BLOCKED';
  h.deliver(2, BLOCKED_EV);

  if (h.spies.asks.length !== 1) throw new Error('L2 must consult the triage model');
  if (h.spies.sends.length !== 0) throw new Error('escalate must never sendInput');
  if (h.spies.notifies.length !== 1) throw new Error('escalate must notify the human once');
  const rec = h.spies.decisions[0].fields;
  if (rec.decision !== 'escalated') throw new Error(`expected escalated, got ${rec.decision}`);
  if (!/schema migration/.test(rec.rationale || '')) throw new Error('rationale should carry the triage reasoning');
}

async function testAmbiguousParseEscalates() {
  // No recognizable Decision section at all — the model rambled.
  const h = makeLoop({
    states: { 4: 'RUNNING' },
    autonomy: 'L3',
    reply: 'I looked at the worker and it seems fine, maybe? Not sure what to do here.',
  });
  h.loop.start();
  h.states[4] = 'BLOCKED';
  h.deliver(4, BLOCKED_EV);

  if (h.spies.sends.length !== 0) throw new Error('an unparseable decision must not sendInput');
  if (h.spies.notifies.length !== 1) throw new Error('an unparseable decision must escalate');
  if (h.spies.decisions[0].fields.decision !== 'escalated') throw new Error('audit must record escalated on parse failure');
}

// ─── edge-trigger dedupe ──────────────────────────────────────────────────────

async function testEdgeTriggerDedupe() {
  const reply = 'Decision: answer-directly\nPayload: do the thing';
  const h = makeLoop({ states: { 5: 'RUNNING' }, autonomy: 'L1', reply });
  h.loop.start();

  // Enter BLOCKED and stay there across several events — handled exactly once.
  h.states[5] = 'BLOCKED';
  h.deliver(5, BLOCKED_EV);
  h.deliver(5, { event: 'notify', payload: { msg: 'still stuck' } });
  h.deliver(5, BLOCKED_EV);
  if (h.spies.sends.length !== 1) throw new Error(`a persistent block must be handled once, got ${h.spies.sends.length}`);

  // Leave the trigger set — the latch clears.
  h.states[5] = 'RUNNING';
  h.deliver(5, RUNNING_EV);
  if (h.loop.isHandled(5)) throw new Error('leaving the trigger set must clear the handled latch');

  // A fresh block re-fires.
  h.states[5] = 'BLOCKED';
  h.deliver(5, BLOCKED_EV);
  if (h.spies.sends.length !== 2) throw new Error(`a re-entered block must re-fire, got ${h.spies.sends.length} total`);
}

// ─── question hint ──────────────────────────────────────────────────────────

async function testQuestionHintCaptured() {
  const h = makeLoop({ states: { 6: 'RUNNING' }, autonomy: 'L0' });
  h.loop.start();

  // A notify event lands first (still RUNNING), then the block.
  h.deliver(6, { event: 'notify', payload: { msg: 'Which auth flow should I use?' } });
  h.states[6] = 'BLOCKED';
  h.deliver(6, BLOCKED_EV);

  const rec = h.spies.decisions[0].fields;
  if (rec.question !== 'Which auth flow should I use?') {
    throw new Error(`the captured notify msg should be the record's question, got: ${rec.question}`);
  }
  // And it reaches the human in the escalation notification.
  if (!/Which auth flow/.test(h.spies.notifies[0].message)) {
    throw new Error(`escalation message should carry the question hint, got: ${h.spies.notifies[0].message}`);
  }
}

async function testFleetScopeFallback() {
  // No ticket identifier in state → the Handoff Record is scoped FLEET.
  const h = makeLoop({ states: { 7: 'RUNNING' }, autonomy: 'L0' });
  h.loop.start();
  h.states[7] = 'BLOCKED';
  h.deliver(7, BLOCKED_EV);
  if (h.spies.decisions[0].scope !== FLEET_SCOPE) {
    throw new Error(`expected FLEET scope with no ticket, got ${h.spies.decisions[0].scope}`);
  }
}

// ─── subscription lifecycle ─────────────────────────────────────────────────

async function testStopKillsSubscriptions() {
  const h = makeLoop({ states: { 0: 'RUNNING', 1: 'RUNNING' }, autonomy: 'L0' });
  h.loop.start();
  if (h.loop.watchedWorkers().length !== 2) throw new Error('expected 2 subscriptions after start');
  h.loop.stop();
  if (h.spies.kills !== 2) throw new Error(`stop() should kill every subscription, killed ${h.spies.kills}`);
  if (h.loop.watchedWorkers().length !== 0) throw new Error('stop() should clear the subscription set');
}

async function testRescanIdempotentAndNewWorkers() {
  const workers = [0];
  const h = makeLoop({ states: { 0: 'RUNNING' }, autonomy: 'L0', workers });
  h.loop.start();
  h.loop.rescan(); // idempotent — no new subscription for the already-watched worker
  if (h.spies.subscribes.length !== 1) throw new Error(`rescan must not re-subscribe, got ${h.spies.subscribes.length}`);

  // A new worker appears — the next rescan (the daemon heartbeat) picks it up.
  workers.push(2);
  h.states[2] = 'RUNNING';
  h.loop.rescan();
  if (h.spies.subscribes.length !== 2) throw new Error('rescan should subscribe to a newly-appeared worker');
  if (!h.loop.watchedWorkers().includes(2)) throw new Error('the new worker should now be watched');
}

// ─── pure parser ──────────────────────────────────────────────────────────────

async function testParseTriageDecisionAnswer() {
  const r = parseTriageDecision('Decision: answer-directly\nRationale: cheap.\nPayload: rebase onto main.');
  if (r.decision !== 'answer-directly') throw new Error(`expected answer-directly, got ${r.decision}`);
  if (r.payload !== 'rebase onto main.') throw new Error(`payload not extracted: ${JSON.stringify(r.payload)}`);
  if (r.rationale !== 'cheap.') throw new Error(`rationale not extracted: ${JSON.stringify(r.rationale)}`);
}

async function testParseTriageDecisionDecorated() {
  // Bold + numbered labels, multi-line payload — the shapes the skill's own
  // "produce in this order" output can take.
  const text = [
    '1. **Decision:** `answer-directly`',
    '2. **Rationale:** well-supported by the ticket',
    '3. **Payload:**',
    'Run the migration, then',
    'restart the preview.',
  ].join('\n');
  const r = parseTriageDecision(text);
  if (r.decision !== 'answer-directly') throw new Error(`decorated answer not parsed: ${r.decision}`);
  if (!/Run the migration/.test(r.payload) || !/restart the preview/.test(r.payload)) {
    throw new Error(`multi-line payload lost: ${JSON.stringify(r.payload)}`);
  }
}

async function testParseTriageDecisionEscalate() {
  const r = parseTriageDecision('Decision: escalate\nRationale: irreversible.\nPayload: restate for human.');
  if (r.decision !== 'escalate') throw new Error(`expected escalate, got ${r.decision}`);
  if (r.payload !== 'restate for human.') throw new Error('escalate payload should still be captured');
}

async function testParseTriageDecisionAnswerNoPayloadDowngrades() {
  // Says answer-directly but supplies nothing to send — nothing to deliver, so
  // it must downgrade to escalate rather than send an empty line.
  const r = parseTriageDecision('Decision: answer-directly\nRationale: seems fine.');
  if (r.decision !== 'escalate') throw new Error(`answer with no payload must downgrade to escalate, got ${r.decision}`);
}

async function testParseTriageDecisionGarbageEscalates() {
  const r = parseTriageDecision('nothing structured here at all');
  if (r.decision !== 'escalate') throw new Error(`garbage must default to escalate, got ${r.decision}`);
}

async function testParseTriageDecisionBothVerbsEscalates() {
  // A Decision line that mentions both verbs is ambiguous → escalate.
  const r = parseTriageDecision('Decision: I could answer-directly but should escalate\nPayload: x');
  if (r.decision !== 'escalate') throw new Error(`ambiguous decision must escalate, got ${r.decision}`);
}

async function testBuildTriagePrompt() {
  const p = buildTriagePrompt({
    worker: 3,
    ticketId: 'QUO-42',
    ticketUrl: 'https://l/QUO-42',
    state: 'BLOCKED',
    question: 'Which DB?',
    autonomyLevel: 'L2',
  });
  if (!/^\/triage/.test(p)) throw new Error('prompt must invoke the /triage skill on its first line');
  for (const needle of ['3', 'QUO-42', 'BLOCKED', 'Which DB?', 'L2']) {
    if (!p.includes(needle)) throw new Error(`prompt missing "${needle}": ${p}`);
  }
}

async function testDefaultTriggerStatesShape() {
  for (const s of ['BLOCKED', 'AWAITING_REVIEW', 'WAITING_FOR_INPUT']) {
    if (!DEFAULT_TRIGGER_STATES.includes(s)) throw new Error(`DEFAULT_TRIGGER_STATES missing ${s}`);
  }
}

async function testSessionRequired() {
  let threw = false;
  try {
    createConductorLoop({});
  } catch (_) {
    threw = true;
  }
  if (!threw) throw new Error('createConductorLoop must require a session');
}

async function main() {
  const tests = [
    ['detect: BLOCKED via subscribe (no inspect-cli poll)', testBlockedDetectedViaSubscribe],
    ['L0: no model call, never sendInput, escalates report-only', testL0NeverSendsInput],
    ['L1: answer-directly → sendInput + answered record', testL1AnswerDirectly],
    ['L2: consequential escalate → notify + escalated record', testConsequentialEscalates],
    ['parse failure → escalate (safe default)', testAmbiguousParseEscalates],
    ['edge-trigger: handled once; re-entry re-fires', testEdgeTriggerDedupe],
    ['question hint: notify msg → record question + alert', testQuestionHintCaptured],
    ['audit: FLEET scope when no ticket id', testFleetScopeFallback],
    ['stop() kills every subscription', testStopKillsSubscriptions],
    ['rescan idempotent + picks up new workers', testRescanIdempotentAndNewWorkers],
    ['parseTriageDecision: answer-directly + payload', testParseTriageDecisionAnswer],
    ['parseTriageDecision: decorated/numbered/multi-line', testParseTriageDecisionDecorated],
    ['parseTriageDecision: escalate', testParseTriageDecisionEscalate],
    ['parseTriageDecision: answer w/o payload downgrades', testParseTriageDecisionAnswerNoPayloadDowngrades],
    ['parseTriageDecision: garbage → escalate', testParseTriageDecisionGarbageEscalates],
    ['parseTriageDecision: both verbs → escalate', testParseTriageDecisionBothVerbsEscalates],
    ['buildTriagePrompt carries the context', testBuildTriagePrompt],
    ['DEFAULT_TRIGGER_STATES shape', testDefaultTriggerStatesShape],
    ['createConductorLoop requires a session', testSessionRequired],
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

  console.log(`\n${passed}/${tests.length} passed`);
  if (passed < tests.length) process.exit(1);
}

main().catch((err) => {
  console.error('FAIL —', err.message);
  process.exit(1);
});
