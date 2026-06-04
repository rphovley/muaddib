---
name: prepare-feast
description: Fleet-safe variant of /prepare-meal. Reads the ticket, optionally invokes /grill-me-async to post clarifying questions (non-blocking), invokes /wash-hands to produce a plan, optionally creates sub-tickets, then posts findings to Linear. All heuristic gates proceed with best available info — never blocks waiting for user input. Returns a list of ticket IDs to implement.
---

# Prepare Feast

Fleet-safe variant of `/prepare-meal`. Programmatic — step order is fixed. The only judgment calls are the two heuristic gates (Step 2, Step 5). Unlike `/prepare-meal`, **never blocks on user input** — if ambiguity is detected, questions are posted to Linear and the pipeline continues with best available info.

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

## Step 3 — Invoke `/wash-hands`

Call `Skill(wash-hands)` with the full ticket context as `args`:
- Original description
- Grilled Q&A (always empty from grill-me-async)
- Title, labels

It returns a structured plan containing: `Diagnosis`, `Proposed solution`, `Work streams`, and a `RECOMMEND_SPLIT: true|false` flag.

**Proceed regardless of ambiguity** — if clarifications were posted to Linear in Step 2, wash-hands works with what the ticket already describes. Do not wait or block.

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

Return the list of ticket IDs from Step 5. The caller (typically `/muaddib`) consumes this list.
