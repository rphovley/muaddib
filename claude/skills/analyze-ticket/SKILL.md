---
name: analyze-ticket
description: Fleet planning step. Reads a Linear ticket and the codebase, generates a draft plan written to .muaddib/plan.md, decides whether clarifying questions are needed, and writes needs_questions to worker state. Posts the final plan to Linear if no questions are needed.
---

# Analyze Ticket

Planning step in the feature workflow. Runs only when no `## Plan` comment exists on the ticket.

`$ARGUMENTS` is the Linear ticket identifier (e.g. `QUO-325`).
`STATE_TICKET_URL` is the full Linear URL.
`STATE_TICKET_TITLE` is the ticket title.

The full ticket JSON (description + comments) is at `/tmp/ticket-${WORKER_INDEX:-0}.json`.

**If questions are needed and `AskUserQuestion` is called:** first post the questions as a Linear comment (`@mention` the assignee) and fire a macOS notify so the user is pulled back to the TUI before blocking.

## Step 1 — Read the ticket

Read `/tmp/ticket-${WORKER_INDEX:-0}.json`. Extract the `title`, `description`, and any existing comments for context.

## Step 2 — Read codebase context

Read `CLAUDE.md` (root). Identify which project(s) the ticket touches, then read the relevant project-level `CLAUDE.md`. Explore files most likely to be affected — use `find` and `grep` to locate controllers, services, database files, and frontend components. Read enough to understand existing patterns.

## Step 3 — Write a draft plan to `.muaddib/plan.md`

Always write a plan, even if questions remain. Mark uncertain areas explicitly.

```markdown
## Plan

### Diagnosis
<What the ticket asks for and why. One paragraph.>

### Solution
<How you will implement it. Name specific files, functions, table columns, API endpoints.>

### Work Streams
<Dependency-ordered streams of concrete steps.>

**Stream 1 — <name>**
- Step A
- Step B

**Stream 2 — <name>**  
- Step C

### Open Questions
<Leave this section empty if the plan is clear. List only questions that would change the implementation approach — not implementation details you can decide yourself.>
```

Write to:
```bash
mkdir -p "${REPO_DIR:-/home/worker/repo}/.muaddib"
# write the plan body above to .muaddib/plan.md
```

## Step 4 — Decide if clarifying questions are needed

Questions are needed only if the "Open Questions" section is non-empty — i.e., there are unknowns that would change the implementation approach. Questions are **not** needed for implementation details you can decide yourself.

Write `needs_questions` to state:
```bash
STATE_CLI="${REPO_DIR:-/home/worker/repo}/muaddib/orchestrator/state-cli.js"
WORKER="${WORKER_INDEX:-0}"
node "$STATE_CLI" "$WORKER" set needs_questions "true"   # or "false"
```

## Step 5a — No questions needed: post plan and finish

If `needs_questions=false`, post `.muaddib/plan.md` as a `## Plan` comment on the Linear ticket using `mcp__linear__save_comment`.

Then signal done:
```bash
touch "$STEP_DONE_FILE"
```

## Step 5b — Questions needed: notify and stop

If `needs_questions=true`:

**Post questions to Linear** using `mcp__linear__save_comment`. Mention the ticket assignee in the comment body so they receive a Linear notification. Format:

```
Questions before implementing — @<assignee>:

1. <question>
2. <question>

(Reply in this TUI session — the worker is waiting.)
```

**Fire macOS notify** via the event bus:
```bash
node "${REPO_DIR:-/home/worker/repo}/muaddib/orchestrator/emit-cli.js" \
    "${WORKER_INDEX:-0}" claude notify \
    "{\"msg\":\"${STATE_TICKET_IDENTIFIER} needs your input before implementing\"}"
```

Then signal done — the `ask-questions` step will handle the response:
```bash
touch "$STEP_DONE_FILE"
```
