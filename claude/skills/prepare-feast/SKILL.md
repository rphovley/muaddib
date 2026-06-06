---
name: prepare-feast
description: Fleet-safe variant of /prepare-meal. Reads the ticket, optionally invokes /grill-me-async to post clarifying questions (non-blocking), invokes /wash-hands-async to produce a plan, optionally creates sub-tickets, then posts findings to Linear. All heuristic gates proceed with best available info — never blocks waiting for user input. Returns a bare JSON array of ticket IDs to implement.
---

# Prepare Feast

Fleet-safe variant of `/prepare-meal`. Programmatic — step order is fixed. The only judgment calls are the two heuristic gates (Step 2, Step 4). Unlike `/prepare-meal`, **never blocks on user input** — if ambiguity is detected, questions are posted to Linear and the pipeline continues with best available info.

**Autonomous execution**: run all steps in a single continuous pass. Do not pause, narrate, or produce intermediate output between steps. After each step completes, call the next tool immediately. The only output from this skill is the bare JSON array returned in Step 6.

## Step 1 — Load the ticket

Call `mcp__linear__get_issue` with the ID from `$ARGUMENTS`. Capture:
- `id`, `identifier`, `title`, `description`
- `teamId` (needed for sub-ticket creation)
- `state`, `labels`, `assignee`, `url`
- `createdBy`, `createdById` (needed for @mention in grill-me-async)

If the ticket doesn't exist or you lack access, stop with a clear error.

## Step 2 — Ambiguity heuristic → maybe `/grill-me-async`

Trigger `/grill-me-async` if **any** of these are true about `description`:

1. Length < 200 characters.
2. No explicit acceptance criteria, "Definition of Done", or numbered/bulleted success criteria.
3. Contains vague verbs without concrete deliverables: `look into`, `explore`, `consider`, `investigate`, `improve`, `clean up`, `refactor` (without naming what).
4. Contains open questions (sentences ending in `?`).
5. No mention of specific files, components, endpoints, or features.

If triggered: call `Skill(grill-me-async)` with the ticket context as `args`:
```
Ticket ID: <identifier>
Title: <title>
Description: <full description>
URL: <url>
Created by: <createdBy> (id: <createdById>)
```

`/grill-me-async` always returns an empty transcript (questions are posted to Linear, not collected interactively). Do not modify the ticket description based on its output.

If not triggered: continue with an empty transcript.

→ Proceed immediately to Step 3.

## Step 3 — Invoke `/wash-hands-async`

Call `Skill(wash-hands-async)` with the full ticket context as `args`:
- Original description
- Grilled Q&A (always empty from grill-me-async)
- Title, labels

It returns a structured plan containing: `Diagnosis`, `Proposed solution`, `Work streams`, and a `RECOMMEND_SPLIT: true|false` flag. If no approach is clearly best, it posts options to Linear and picks the strongest — it never blocks.

**Proceed regardless of ambiguity** — if clarifications were posted to Linear in Step 2, wash-hands-async works with what the ticket already describes. Do not wait or block.

→ Proceed immediately to Step 4.

## Step 4 — Sub-ticket heuristic → maybe split

Trigger sub-ticket creation if **any** of these are true:

1. `RECOMMEND_SPLIT: true` in the plan.
2. Plan lists ≥ 3 independent work streams (no shared files, no ordering dependency).
3. Plan spans ≥ 2 projects under `projects/*` AND each project's work is independently deliverable.
4. Total phases ≥ 5.

**If triggered:**
- For each work stream, call `mcp__linear__save_issue` with:
  - `teamId`: from Step 1
  - `parentId`: original ticket ID
  - `title`: `<original title> — <work stream name>`
  - `description`: the relevant portion of the plan (work-stream details + acceptance criteria)
- Tickets to return = list of newly created sub-ticket IDs.

**If not triggered:**
- Tickets to return = `[<original ticket ID>]`.

→ Proceed immediately to Step 5.

## Step 5 — Post plan as comment on parent

Post a single comment on the *original* (parent) ticket via `mcp__linear__save_comment`:

```
## Plan

**Diagnosis:** <one paragraph>

**Proposed solution:**
- ...

**Work streams:**
1. <name> — files: <list> — tests: <strategy>
2. ...

**Sub-tickets:** <list of `[IDENTIFIER](url)` if created, or `None — handling inline`>
```

## Step 6 — Return

Return **only** the bare JSON array of ticket IDs — no surrounding text, no summary, no status message. The caller (`/muaddib`) reads this value programmatically and proceeds immediately to the next step without user input.

Examples: `["QUO-281"]` or `["QUO-282","QUO-283"]`
