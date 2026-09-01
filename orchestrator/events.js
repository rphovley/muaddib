'use strict';
const fs = require('fs');
const path = require('path');

function eventsDir() {
  return process.env.AGENT_STATUS_DIR || '/var/run/agent-status';
}

function eventsFile(worker) {
  return path.join(eventsDir(), `worker-${worker}.events`);
}

// Parse a block of newline-delimited JSON into event objects, skipping blank
// and malformed lines. The single source of the JSONL line grammar, shared by
// subscribe()'s poller and readEvents() so a reader can never drift from the
// stream reader on how a line is interpreted.
function parseEventLines(text) {
  const events = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { events.push(JSON.parse(trimmed)); } catch (_) {}
  }
  return events;
}

// Append one JSONL event line to the worker's events file.
function emit(worker, job, event, payload) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    worker: Number(worker),
    job,
    event,
    payload: payload || {},
  }) + '\n';
  const file = eventsFile(worker);
  fs.mkdirSync(eventsDir(), { recursive: true });
  fs.appendFileSync(file, line);
}

// Poll the worker's events file for new JSONL lines every 50 ms.
// By default replays all lines already in the file; pass { fromEnd: true }
// to start from the current end and only see events emitted after subscribe().
// Returns an object with a kill() method to stop polling.
function subscribe(worker, handler, opts = {}) {
  const file = eventsFile(worker);
  fs.mkdirSync(eventsDir(), { recursive: true });
  fs.closeSync(fs.openSync(file, 'a')); // ensure file exists

  let offset = 0;
  if (opts.fromEnd) {
    try { offset = fs.statSync(file).size; } catch (_) {}
  }
  let remainder = '';
  let killed = false;

  function readNew() {
    if (killed) return;
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const { size } = fs.fstatSync(fd);
      if (size <= offset) return;
      const buf = Buffer.alloc(size - offset);
      const n = fs.readSync(fd, buf, 0, buf.length, offset);
      offset += n;
      remainder += buf.slice(0, n).toString();
      const cut = remainder.lastIndexOf('\n');
      if (cut === -1) return; // no complete line yet
      const complete = remainder.slice(0, cut);
      remainder = remainder.slice(cut + 1); // last (possibly incomplete) line
      for (const ev of parseEventLines(complete)) handler(ev);
    } catch (_) {
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
    }
  }

  readNew(); // replay existing content immediately
  const timer = setInterval(readNew, 50);

  return { kill: () => { killed = true; clearInterval(timer); } };
}

// One-shot synchronous read of a worker's events file into an array of event
// objects, using the same JSONL grammar as subscribe(). Returns [] when the
// file is missing — a worker that has never emitted looks like an empty stream,
// not an error. Read-only: opens nothing for writing, creates no file.
function readEvents(worker) {
  let text;
  try {
    text = fs.readFileSync(eventsFile(worker), 'utf8');
  } catch (_) {
    return [];
  }
  return parseEventLines(text);
}

// Enumerate the worker indices that have an events file in eventsDir(), sorted
// numerically ascending. Returns [] when the directory doesn't exist yet.
function listWorkers() {
  let names;
  try {
    names = fs.readdirSync(eventsDir());
  } catch (_) {
    return [];
  }
  const workers = [];
  for (const name of names) {
    const m = /^worker-(\d+)\.events$/.exec(name);
    if (m) workers.push(Number(m[1]));
  }
  return workers.sort((a, b) => a - b);
}

module.exports = { emit, subscribe, eventsFile, readEvents, listWorkers };
