#!/usr/bin/env node
'use strict';
// gather-dispatch-context.js test suite — a fake ticket source, a fake
// fleetState reader, and a fake execFn (no real gh/git, no network). Usage:
//   node muaddib/scripts/test-gather-dispatch-context.js
//
// Covers: the happy path (ticket + comments + fleet + related PRs all present),
// a not-found ticket short-circuiting cleanly, an already-in-flight ticket being
// flagged in the Fleet section, gh/git both failing degrading to a note instead
// of throwing, and the format* helpers in isolation.

const {
  run,
  findRelatedWork,
  formatFleetSection,
  formatCommentsSection,
  formatRelatedWorkSection,
  statusOf,
  assigneeOf,
} = require('./gather-dispatch-context');

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
    console.error(`  ✗ threw: ${err.stack || err.message}`);
    failed++;
  }
}

function fakeSource(overrides = {}) {
  return {
    async fetchTicket(id) {
      return { identifier: id, title: 'A ticket', state: { name: 'In Progress' }, url: `https://example/${id}` };
    },
    async fetchComments() {
      return { own: [{ id: 'c1', body: 'looks good' }], parent: [] };
    },
    ...overrides,
  };
}

function fakeExecFn(responses) {
  // responses: { [file]: (args) => string | throw }
  return (file, args) => {
    const handler = responses[file];
    if (!handler) throw new Error(`no fake handler for ${file}`);
    return handler(args);
  };
}

async function main() {
  await test('run() — happy path assembles all sections', async () => {
    const source = fakeSource();
    const getFleetState = () => ({
      generatedAt: 'now',
      workers: [{ worker: 0, state: 'RUNNING', ticketIdentifier: null, currentStep: { id: 'plan', running: true } }],
    });
    const execFn = fakeExecFn({
      gh: () => JSON.stringify([
        { number: 246, title: 'Support multiple project types', state: 'CLOSED', url: 'https://x/246', headRefName: 'quo-507-feature', mergedAt: null },
      ]),
      git: () => '  origin/main\n  origin/quo-507-feature\n',
    });

    const md = await run('QUO-507', { source, getFleetState, execFn });
    assert('includes ticket header', md.includes('## Pre-Dispatch Context: QUO-507'));
    assert('includes status/assignee line', md.includes('status: In Progress · assignee: unassigned'));
    assert('includes comment', md.includes('looks good'));
    assert('includes fleet no-holder note', md.includes('No worker currently holds QUO-507'));
    assert('includes related PR, closed unmerged', md.includes('PR #246') && md.includes('closed (unmerged)'));
    assert('branch already covered by PR is not double-listed', !md.includes('branch `quo-507-feature` (no PR)'));
  });

  await test('run() — ticket not found short-circuits', async () => {
    const source = fakeSource({ fetchTicket: async () => null });
    const md = await run('NOPE-1', { source, getFleetState: () => ({ workers: [] }), execFn: () => '' });
    assert('reports no ticket found', md.includes('No ticket found for NOPE-1'));
    assert('does not include a Fleet section', !md.includes('### Fleet'));
  });

  await test('run() — flags a worker already holding the ticket', async () => {
    const source = fakeSource();
    const getFleetState = () => ({
      workers: [{ worker: 1, state: 'RUNNING', ticketIdentifier: 'QUO-507', currentStep: null }],
    });
    const md = await run('QUO-507', { source, getFleetState, execFn: () => { throw new Error('no gh/git'); } });
    assert('flags the holder', md.includes('**Worker 1 already holds QUO-507.**'));
  });

  await test('run() — gh and git both failing degrades to a note, never throws', async () => {
    const source = fakeSource();
    const md = await run('QUO-507', {
      source,
      getFleetState: () => ({ workers: [] }),
      execFn: () => { throw new Error('gh: command not found'); },
    });
    assert('degrades to no related PRs/branches', md.includes('No related PRs or branches found.'));
  });

  await test('findRelatedWork() — dedupes a branch already covered by a PR', () => {
    const execFn = fakeExecFn({
      gh: () => JSON.stringify([{ number: 1, title: 't', state: 'MERGED', url: 'u', headRefName: 'quo-1-x', mergedAt: '2026-01-01' }]),
      git: () => 'origin/quo-1-x\norigin/quo-1-orphan\n',
    });
    const { prs, orphanBranches } = findRelatedWork('QUO-1', { execFn });
    assert('finds the PR', prs.length === 1 && prs[0].number === 1);
    assert('lists only the orphan branch', orphanBranches.length === 1 && orphanBranches[0] === 'quo-1-orphan');
  });

  await test('findRelatedWork() — malformed gh JSON degrades to empty, not a throw', () => {
    const execFn = fakeExecFn({ gh: () => 'not json', git: () => '' });
    const { prs, orphanBranches } = findRelatedWork('QUO-1', { execFn });
    assert('no PRs', prs.length === 0);
    assert('no branches', orphanBranches.length === 0);
  });

  await test('statusOf() / assigneeOf() — tolerate both backend shapes and absence', () => {
    assert('status from state.name', statusOf({ state: { name: 'Done' } }) === 'Done');
    assert('status unknown when absent', statusOf({}) === 'unknown');
    assert('assignee flat string (github)', assigneeOf({ assignee: 'octocat' }) === 'octocat');
    assert('assignee {name} object (linear)', assigneeOf({ assignee: { name: 'Paul' } }) === 'Paul');
    assert('assignee unassigned when null', assigneeOf({ assignee: null }) === 'unassigned');
  });

  await test('formatCommentsSection() — empty and populated', () => {
    assert('empty note', formatCommentsSection({ own: [] }) === 'No comments on the ticket.');
    assert('degrades on missing own', formatCommentsSection({}) === 'No comments on the ticket.');
    const out = formatCommentsSection({ own: [{ body: 'a\nb' }] });
    assert('collapses newlines in a comment body', out === '- a b');
  });

  await test('formatFleetSection() — empty fleet note', () => {
    assert('empty fleet note', formatFleetSection({ workers: [] }, 'QUO-1') === 'No fleet workers have run yet.');
  });

  await test('formatRelatedWorkSection() — empty note', () => {
    assert('empty note', formatRelatedWorkSection({ prs: [], orphanBranches: [] }) === 'No related PRs or branches found.');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
