'use strict';
const fs = require('fs');
const path = require('path');

function eventsDir() {
  return process.env.AGENT_STATUS_DIR || '/var/run/agent-status';
}

function eventsFile(worker) {
  return path.join(eventsDir(), `worker-${worker}.events`);
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
// Replays all lines already in the file before watching for new ones.
// Returns an object with a kill() method to stop polling.
function subscribe(worker, handler) {
  const file = eventsFile(worker);
  fs.mkdirSync(eventsDir(), { recursive: true });
  fs.closeSync(fs.openSync(file, 'a')); // ensure file exists

  let offset = 0;
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
      const lines = remainder.split('\n');
      remainder = lines.pop(); // last (possibly incomplete) line
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { handler(JSON.parse(trimmed)); } catch (_) {}
      }
    } catch (_) {
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
    }
  }

  readNew(); // replay existing content immediately
  const timer = setInterval(readNew, 50);

  return { kill: () => { killed = true; clearInterval(timer); } };
}

module.exports = { emit, subscribe, eventsFile };
