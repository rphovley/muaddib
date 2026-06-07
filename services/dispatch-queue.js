'use strict';

const fs = require('fs');
const path = require('path');

// MUADDIB_DISPATCH_DIR is overridden in tests to a temp directory.
const BASE_DIR = process.env.MUADDIB_DISPATCH_DIR || path.join(__dirname, '../..');
const QUEUE_FILE = path.join(BASE_DIR, '.muaddib-dispatch-queue.json');
const DEDUP_FILE = path.join(BASE_DIR, '.muaddib-dispatch.json');

let queue = [];
let dispatched = new Set();

function loadFiles() {
  try {
    const q = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    if (Array.isArray(q)) queue = q;
  } catch (_) {}
  try {
    const d = JSON.parse(fs.readFileSync(DEDUP_FILE, 'utf8'));
    if (Array.isArray(d)) dispatched = new Set(d);
  } catch (_) {}
}

function saveQueue() {
  try { fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2)); } catch (_) {}
}

function saveDedup() {
  try { fs.writeFileSync(DEDUP_FILE, JSON.stringify([...dispatched], null, 2)); } catch (_) {}
}

loadFiles();

function isDispatched(ticketId) {
  return dispatched.has(ticketId);
}

function markDispatched(ticketId) {
  dispatched.add(ticketId);
  saveDedup();
}

function enqueue(ticketId, entryPoint, workflowFile) {
  queue.push({ ticketId, entryPoint, workflowFile, enqueuedAt: new Date().toISOString() });
  saveQueue();
}

// Calls trySpawn(entry) for each queued entry. Keeps entries for which
// trySpawn returns false (no slots available), removes successfully dispatched ones.
async function flush(trySpawn) {
  if (queue.length === 0) return;
  const remaining = [];
  for (const entry of queue) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await trySpawn(entry);
    if (!ok) remaining.push(entry);
  }
  queue = remaining;
  saveQueue();
}

module.exports = { isDispatched, markDispatched, enqueue, flush };
