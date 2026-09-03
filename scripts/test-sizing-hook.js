#!/usr/bin/env node
'use strict';
// sizing hook core-logic tests — an INJECTED fake session ({ start, ask, stop }
// stubs returning scripted text), so no real tmux/`claude` ever runs and there is
// no network. Usage: node muaddib/scripts/test-sizing-hook.js
//
// Covers: happy path (valid JSON reply → parsed object), stray prose around the
// JSON (still extracts), start()/ask() throwing (→ run rejects, no hang, stop()
// still called), and that the name handed to the createSession factory is unique
// per call and never the shared 'conductor' default.

const { run } = require('../.muaddib/hooks/sizing.example');

// ─── harness ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? `: ${detail}` : ''}`);
    failed++;
  }
}

async function test(name, fn) {
  console.log(`\n${name}`);
  try {
    await fn();
  } catch (err) {
    console.error(`  ✗ threw unexpectedly: ${err.message}\n${err.stack}`);
    failed++;
  }
}

// A fake ConductorSession factory. `behavior` scripts what ask() returns (a
// string) or throws (an Error); `startThrows` makes start() throw. Records the
// lifecycle calls and the opts each factory call received.
function fakeSessionFactory(behavior = {}) {
  const calls = { created: [], started: 0, asked: [], stopped: 0 };
  const factory = (opts = {}) => {
    calls.created.push(opts);
    return {
      start() {
        calls.started++;
        if (behavior.startThrows) throw behavior.startThrows;
        return this;
      },
      ask(prompt, askOpts) {
        calls.asked.push({ prompt, askOpts });
        if (behavior.askThrows) throw behavior.askThrows;
        return typeof behavior.reply === 'function'
          ? behavior.reply(prompt, askOpts)
          : behavior.reply;
      },
      stop() {
        calls.stopped++;
        return this;
      },
    };
  };
  return { factory, calls };
}

const TICKET = { title: 'A ticket', description: 'do the thing' };
const baseOpts = (extra) => ({
  ticketId: 'muaddib#117',
  ticket: TICKET,
  context: 'some gathered context',
  promptTemplate: 'T={{TICKET_TITLE}} B={{TICKET_BODY}} C={{CONTEXT}}',
  ...extra,
});

// ─── tests ──────────────────────────────────────────────────────────────────

async function main() {
  await test('happy path: valid JSON reply → parsed object returned', async () => {
    const { factory, calls } = fakeSessionFactory({
      reply: '{"size":"S","confidence":"high","recommendSplit":false}',
    });
    const sig = await run(baseOpts({ createSession: factory }));
    assert('size parsed', sig.size === 'S', JSON.stringify(sig));
    assert('confidence parsed', sig.confidence === 'high');
    assert('recommendSplit parsed', sig.recommendSplit === false);
    assert('session was started', calls.started === 1);
    assert('session was asked once', calls.asked.length === 1);
    assert('session was stopped', calls.stopped === 1);
    assert('ask got a bounded timeout', calls.asked[0].askOpts && typeof calls.asked[0].askOpts.timeoutMs === 'number');
    assert('prompt interpolated title/body/context',
      calls.asked[0].prompt === 'T=A ticket B=do the thing C=some gathered context',
      calls.asked[0].prompt);
  });

  await test('stray prose around the JSON → still extracts the object', async () => {
    const { factory } = fakeSessionFactory({
      reply: 'Sure! Here is my assessment:\n```\n{"size":"L","confidence":"medium","recommendSplit":true,"blockingQuestions":["which API?"]}\n```\nHope that helps.',
    });
    const sig = await run(baseOpts({ createSession: factory }));
    assert('size extracted from surrounding prose', sig.size === 'L', JSON.stringify(sig));
    assert('recommendSplit extracted', sig.recommendSplit === true);
    assert('blockingQuestions extracted', Array.isArray(sig.blockingQuestions) && sig.blockingQuestions[0] === 'which API?');
  });

  await test('no JSON object in the reply → run rejects', async () => {
    const { factory, calls } = fakeSessionFactory({ reply: 'I could not size this ticket.' });
    let threw = false;
    try {
      await run(baseOpts({ createSession: factory }));
    } catch (err) {
      threw = true;
      assert('error mentions no JSON object', /no JSON object/.test(err.message), err.message);
    }
    assert('run rejected', threw);
    assert('session still stopped after a parse failure', calls.stopped === 1);
  });

  await test('ask() throws (timeout/error) → run rejects, no hang, stop() still called', async () => {
    const { factory, calls } = fakeSessionFactory({ askThrows: new Error('readResponse: no settled response within 60000ms') });
    let threw = false;
    try {
      await run(baseOpts({ createSession: factory }));
    } catch (err) {
      threw = true;
      assert('surfaces the ask error', /no settled response/.test(err.message), err.message);
    }
    assert('run rejected', threw);
    assert('session was started', calls.started === 1);
    assert('session was stopped despite the ask failure', calls.stopped === 1);
  });

  await test('start() throws → run rejects and stop() still called', async () => {
    const { factory, calls } = fakeSessionFactory({ startThrows: new Error('input box not ready within 30000ms') });
    let threw = false;
    try {
      await run(baseOpts({ createSession: factory }));
    } catch (err) {
      threw = true;
      assert('surfaces the start error', /not ready/.test(err.message), err.message);
    }
    assert('run rejected', threw);
    assert('ask was never reached', calls.asked.length === 0);
    assert('session was stopped despite the start failure', calls.stopped === 1);
  });

  await test('session name is unique per call and never the shared "conductor" default', async () => {
    const { factory, calls } = fakeSessionFactory({ reply: '{"size":"XS","confidence":"high","recommendSplit":false}' });
    await run(baseOpts({ createSession: factory }));
    await run(baseOpts({ createSession: factory }));
    const [a, b] = calls.created;
    assert('first call got a name', typeof a.name === 'string' && a.name.length > 0, a.name);
    assert('name is not the shared "conductor" default', a.name !== 'conductor', a.name);
    assert('name is a sizing-scoped name', /^sizing-/.test(a.name), a.name);
    assert('two calls got distinct names', a.name !== b.name, `${a.name} vs ${b.name}`);
    assert('a bounded readyTimeout was passed to the constructor', typeof a.readyTimeoutMs === 'number', String(a.readyTimeoutMs));
  });

  await test('missing ticket id → run rejects before creating a session', async () => {
    const { factory, calls } = fakeSessionFactory({ reply: '{}' });
    let threw = false;
    try {
      await run(baseOpts({ ticketId: '', createSession: factory }));
    } catch (err) {
      threw = true;
      assert('error mentions the ticket id', /ticket id/i.test(err.message), err.message);
    }
    assert('run rejected', threw);
    assert('no session was created', calls.created.length === 0);
  });

  // ─── results ────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
