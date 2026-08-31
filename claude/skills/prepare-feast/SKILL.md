---
name: prepare-feast
description: Fleet-safe variant of /prepare-meal. Reads the ticket, optionally invokes /grill-me-async to post clarifying questions (non-blocking), invokes /wash-hands-async to produce a plan, optionally creates sub-tickets, then posts findings to Linear. All heuristic gates proceed with best available info — never blocks waiting for user input. Returns a bare JSON array of ticket IDs to implement.
---

# Prepare Feast

Fleet-safe variant of `/prepare-meal`. Programmatic — step order is fixed. The only judgment calls are the two heuristic gates (Step 2, Step 4). Unlike `/prepare-meal`, **never blocks on user input** — if ambiguity is detected, questions are posted to Linear and the pipeline continues with best available info.

**Autonomous execution**: run all steps in a single continuous pass. Do not pause, narrate, or produce intermediate output between steps. After each step completes, call the next tool immediately. The only output from this skill is the bare JSON array returned in Step 6.

## Step 1 — Load the ticket

Fetch the ticket via the source-neutral ticket CLI (works for whatever `TICKET_SOURCE` the project uses — Linear or GitHub):

```bash
MUADDIB_ROOT="${REPO_DIR:-/home/worker/repo}"
if [ -d "$MUADDIB_ROOT/muaddib" ]; then MUADDIB_ROOT="$MUADDIB_ROOT/muaddib"; fi
TICKET_CLI="$MUADDIB_ROOT/orchestrator/ticket-cli.js"
node "$TICKET_CLI" fetch "$ARGUMENTS"   # prints the ticket JSON
```

Parse the printed JSON and capture:
- `identifier`, `title`, `description`
- `state`, `labels`, `url`

If the CLI exits non-zero or prints `null` (ticket doesn't exist / no access), stop with a clear error.

Sub-ticket creation (Step 4) no longer needs a `teamId` — `create-sub-issue` resolves the parent's team itself — and grill-me-async no longer needs `createdBy` (it @mentions the operator via `TICKET_USER_HANDLE`), so neither is captured here.

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
- For each work stream, create a sub-ticket via the source-neutral ticket CLI. The parent id is the original ticket identifier; the title is an argument; the description (the relevant portion of the plan — work-stream details + acceptance criteria) is piped in on stdin:
  ```bash
  MUADDIB_ROOT="${REPO_DIR:-/home/worker/repo}"
  if [ -d "$MUADDIB_ROOT/muaddib" ]; then MUADDIB_ROOT="$MUADDIB_ROOT/muaddib"; fi
  TICKET_CLI="$MUADDIB_ROOT/orchestrator/ticket-cli.js"
  # Write the work-stream description to /tmp/substream-<n>.md first, then:
  node "$TICKET_CLI" create-sub-issue "<parent-identifier>" "<original title> — <work stream name>" \
      < "/tmp/substream-<n>.md"   # prints the child ticket JSON (identifier, url)
  ```
- Parse each printed child JSON for its `identifier`. Tickets to return = list of newly created sub-ticket identifiers.

**If not triggered:**
- Tickets to return = `[<original ticket ID>]`.

→ Proceed immediately to Step 5.

## Step 5 — Post plan as comment on parent

Post a single comment on the *original* (parent) ticket via the source-neutral ticket CLI — write the body below to a temp file, then pipe it in on stdin:

```bash
MUADDIB_ROOT="${REPO_DIR:-/home/worker/repo}"
if [ -d "$MUADDIB_ROOT/muaddib" ]; then MUADDIB_ROOT="$MUADDIB_ROOT/muaddib"; fi
TICKET_CLI="$MUADDIB_ROOT/orchestrator/ticket-cli.js"
node "$TICKET_CLI" post-comment "<parent-identifier>" < "/tmp/feast-plan-${WORKER_INDEX:-0}.md"
```

Body:

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
