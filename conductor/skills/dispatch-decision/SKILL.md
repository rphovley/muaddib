---
name: dispatch-decision
description: Decide whether and how to dispatch a worker for a given ticket — spawn now, defer, or skip — weighing the ticket's readiness, the project's goals and concurrency limits, and what work is already in flight. Produces a decision plus the parameters a spawn would use, and a rationale.
---

# Dispatch Decision

You are handed a ticket and must decide what the fleet does with it: **dispatch a
worker now, defer it, or skip it.** This is the decision only — the actual spawn
is the caller's step.

## Inputs

The prompt you're given already carries a **Pre-Dispatch Context** block
(`scripts/gather-dispatch-context.js`, run deterministically before you were
invoked): the ticket, its comment trail, whole-fleet worker state — including
which ticket, if any, each worker already holds — and any related PRs/branches
already on the remote for this ticket id. Read that first. **Do not re-fetch
any of it** (no raw MCP ticket/comment lookups, no re-deriving fleet state by
reading worker state files one at a time) unless something in it is genuinely
missing, stale, or contradictory for the decision at hand — then go get exactly
that one missing fact, not the whole picture again.

- **The ticket.** Its identifier, title, description, and current state. Read it
  to judge readiness — is the problem stated clearly enough for a worker to act,
  or is it still a stub, a duplicate, or blocked on something unlanded?
- **The project's goals and constraints.** The durable direction and limits the
  fleet operates under — concurrency ceiling, priorities, anything the project
  has declared off-limits or not-yet. A dispatch that would exceed the
  concurrency limit or push work the project has deprioritized is a defer, not a
  spawn. (Not part of the pre-gathered block — read `.muaddib/goals.md`
  directly if it matters to this decision.)
- **What is already in flight.** The workers currently running and the tickets
  they hold, and any existing PR/branch/comment history showing the ticket is
  already being worked — interactively, by another worker, or via an unmerged
  PR. Do not dispatch a ticket that duplicates in-flight work, that a running
  ticket will subsume, or that's already mid-flight under an interactive
  session (see the Fleet and Related PRs/branches sections of the pre-gathered
  context).

## What to decide

Choose exactly one:

- **Dispatch** — the ticket is ready, in scope, not already being worked, and
  there is capacity within the concurrency limit. State how it should be
  dispatched: the ticket reference to hand the worker, and any routing that
  matters (e.g. it is a bug fix vs. a feature, it should be split first, it has a
  dependency that must land first).
- **Defer** — the ticket is worth doing but not now: capacity is full, a
  dependency is unlanded, or a higher-priority ticket should go first. Say what
  it is waiting on so the caller knows when to reconsider.
- **Skip** — the ticket should not be dispatched at all: it is a duplicate,
  out of scope, already resolved, too underspecified to act on, or contradicts a
  stated goal. Say which.

## Output

Produce, in this order:

1. **Decision:** `dispatch`, `defer`, or `skip`.
2. **Rationale:** one short paragraph — the readiness, capacity, and goal-fit
   facts that drove it.
3. **Payload:**
   - For `dispatch`: the ticket reference and any routing parameters a spawn
     needs.
   - For `defer`: what it is waiting on.
   - For `skip`: why, in one line.

Decide only. Performing the spawn, updating the queue, or notifying anyone is the
caller's step — not this skill's.
