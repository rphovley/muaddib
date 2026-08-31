'use strict';

const fs = require('fs');
const path = require('path');
const { resolveAccountDir } = require('../orchestrator/account-dir');

// MUADDIB_DISPATCH_DIR is the explicit override — production dispatch sets it to
// the mounted host dir (docker-compose.dispatch.yml), and tests point it at a
// temp dir. With no override, default to the account-level per-project dir
// ~/.muaddib/<project>/ so nothing generated lands in the repo tree (matching
// where per-worker env files now live). The resolution (MUADDIB_ACCOUNT_DIR →
// manifest projectName → degrade to the ~/.muaddib account root, still outside
// the repo tree) lives in the shared resolveAccountDir helper so this and other
// callers can't diverge on it.
function defaultBaseDir() {
  return resolveAccountDir(process.env.REPO_ROOT || path.join(__dirname, '../..'));
}

const BASE_DIR = process.env.MUADDIB_DISPATCH_DIR || defaultBaseDir();
const QUEUE_FILE = path.join(BASE_DIR, 'dispatch-queue.json');
const DEDUP_FILE = path.join(BASE_DIR, 'dispatch.json');

// Old (pre-relocation) ledger location: repo-tree basenames written to the repo
// root. Read from here only as a one-time migration fallback so tickets already
// dispatched before the upgrade aren't re-dispatched when the ledger moves.
const OLD_BASE_DIR = path.join(__dirname, '../..');
const OLD_QUEUE_FILE = path.join(OLD_BASE_DIR, '.muaddib-dispatch-queue.json');
const OLD_DEDUP_FILE = path.join(OLD_BASE_DIR, '.muaddib-dispatch.json');

let queue = [];
let dispatched = new Set();

function readJsonArray(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(parsed)) return parsed;
  } catch (_) {}
  return null;
}

function loadFiles() {
  // Prefer the current location; fall back to the pre-relocation ledger so an
  // upgrade doesn't re-dispatch already-dispatched tickets. If the new file is
  // absent (never written since the move) but the old one exists, adopt the old
  // contents — the first markDispatched/flush then persists them to the new path.
  const q = readJsonArray(QUEUE_FILE);
  if (q) queue = q;
  else if (BASE_DIR !== OLD_BASE_DIR) {
    const oldQ = readJsonArray(OLD_QUEUE_FILE);
    if (oldQ) queue = oldQ;
  }
  const d = readJsonArray(DEDUP_FILE);
  if (d) dispatched = new Set(d);
  else if (BASE_DIR !== OLD_BASE_DIR) {
    const oldD = readJsonArray(OLD_DEDUP_FILE);
    if (oldD) dispatched = new Set(oldD);
  }
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

function unmarkDispatched(ticketId) {
  dispatched.delete(ticketId);
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

module.exports = { isDispatched, markDispatched, unmarkDispatched, enqueue, flush };
