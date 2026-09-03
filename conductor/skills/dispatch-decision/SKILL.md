---
name: dispatch-decision
description: Decide whether and how to dispatch a worker for a given ticket — spawn now, defer, or skip — weighing the ticket's readiness, the project's goals and concurrency limits, and what work is already in flight. Produces a decision plus the parameters a spawn would use, and a rationale.
---

# Dispatch Decision

You are handed a ticket and must decide what the fleet does with it: **dispatch a
worker now, defer it, or skip it.** This is the decision only — the actual spawn
is the caller's step.

## Inputs

- **The ticket.** Its identifier, title, description, and current state. Read it
  to judge readiness — is the problem stated clearly enough for a worker to act,
  or is it still a stub, a duplicate, or blocked on something unlanded?
- **The project's goals and constraints.** The durable direction and limits the
  fleet operates under — concurrency ceiling, priorities, anything the project
  has declared off-limits or not-yet. A dispatch that would exceed the
  concurrency limit or push work the project has deprioritized is a defer, not a
  spawn.
- **What is already in flight.** The workers currently running and the tickets
  they hold. Do not dispatch a ticket that duplicates in-flight work or that a
  running ticket will subsume.

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
