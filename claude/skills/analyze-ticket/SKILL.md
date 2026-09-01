---
name: analyze-ticket
description: Fleet planning step. Reads a Linear ticket and the codebase, generates a draft plan written to .muaddib/plan.md, decides whether clarifying questions or a UI/UX sketch loop are needed, and writes needs_questions / needs_sketch to worker state. Posts the final plan to Linear if no questions are needed.
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
MUADDIB_ROOT="${REPO_DIR:-/home/worker/repo}"
if [ -d "$MUADDIB_ROOT/muaddib" ]; then MUADDIB_ROOT="$MUADDIB_ROOT/muaddib"; fi
STATE_CLI="$MUADDIB_ROOT/orchestrator/state-cli.js"
WORKER="${WORKER_INDEX:-0}"
node "$STATE_CLI" "$WORKER" set needs_questions "true"   # or "false"
```

## Step 4b — Decide if a sketch loop is needed

Needed whenever the ticket explicitly asks to visualize, mock up, or iterate
on something visual before building the real thing — this is **not** limited
to Portal/Homeowner app screens. A ticket asking to prototype a dashboard,
chart, funnel, diagram, or any other visual artifact "in HTML first" before
building it for real (in this repo or a third-party tool) needs a sketch pass
just as much as a new app screen would. Also needed when the plan's solution
meaningfully adds or changes a Portal or Homeowner screen/component where a
quick visual mock-and-feedback pass would reduce rework.

Not needed for backend-only work, copy tweaks, or changes with an obvious
existing pattern to follow and no visual deliverable at all. Default to
`false` only when the ticket has no visual/exploratory component whatsoever —
read the ticket's own words for an explicit ask before excluding it on the
basis of the *category* of work (e.g. "this is a dashboard/config ticket") —
the category doesn't override an explicit request to visualize it first.

Write `needs_sketch` to state:

```bash
MUADDIB_ROOT="${REPO_DIR:-/home/worker/repo}"
if [ -d "$MUADDIB_ROOT/muaddib" ]; then MUADDIB_ROOT="$MUADDIB_ROOT/muaddib"; fi
STATE_CLI="$MUADDIB_ROOT/orchestrator/state-cli.js"
WORKER="${WORKER_INDEX:-0}"
node "$STATE_CLI" "$WORKER" set needs_sketch "true"   # or "false"
```

## Step 5a — No questions needed: post plan (unless sketch is pending) and finish

If `needs_questions=false` and `needs_sketch=false`: if `$STATE_TICKET_URL` is non-empty, post `.muaddib/plan.md` as a `## Plan` comment on the ticket via the source-neutral ticket CLI (works for whatever `TICKET_SOURCE` the project uses — Linear, GitHub, or a no-op for raw):

```bash
MUADDIB_ROOT="${REPO_DIR:-/home/worker/repo}"
if [ -d "$MUADDIB_ROOT/muaddib" ]; then MUADDIB_ROOT="$MUADDIB_ROOT/muaddib"; fi
TICKET_CLI="$MUADDIB_ROOT/orchestrator/ticket-cli.js"
# .muaddib/plan.md already starts with its own "## Plan" heading (Step 3
# template). Bodies are large multi-line markdown, so pipe via stdin, not argv.
node "$TICKET_CLI" post-comment "$ARGUMENTS" < "${REPO_DIR:-/home/worker/repo}/.muaddib/plan.md"
```

If `$STATE_TICKET_URL` is empty (no real ticket — e.g. a free-form task), skip the comment entirely; the plan already lives in `.muaddib/plan.md`. Either way, then signal done.

If `needs_questions=false` but `needs_sketch=true`, **do not post `## Plan` yet** — the plan isn't final until the operator has reviewed and approved the prototype. The `sketch` step posts the (possibly revised) `## Plan` itself once that happens. Just signal done here so the workflow moves on to `sketch`:

```bash
touch "$STEP_DONE_FILE"
```

> ⚠️ **This `touch` must be your literal last tool call — actually run it, don't just state that the step is done.** The orchestrator detects completion only when this file appears on disk; a closing summary sentence does not create it. Narrating completion without running the command leaves the step hanging until it is force-nudged.

## Step 5b — Questions needed: notify and stop

If `needs_questions=true`:

**Post questions to the ticket** via the source-neutral ticket CLI — only if `$STATE_TICKET_URL` is non-empty. Mention the operator in the comment body so they receive a backend notification. Build the `@mention` markup with the CLI's `mention` subcommand (source-correct for Linear or GitHub) from a source-neutral handle, falling back to `LINEAR_USER_HANDLE`:

```bash
MUADDIB_ROOT="${REPO_DIR:-/home/worker/repo}"
if [ -d "$MUADDIB_ROOT/muaddib" ]; then MUADDIB_ROOT="$MUADDIB_ROOT/muaddib"; fi
TICKET_CLI="$MUADDIB_ROOT/orchestrator/ticket-cli.js"
HANDLE="${TICKET_USER_HANDLE:-${LINEAR_USER_HANDLE:-}}"
# Empty handle → empty MENTION; omit the "@<handle> —" prefix, don't crash.
MENTION="$(node "$TICKET_CLI" mention "$HANDLE")"
{
  if [ -n "$MENTION" ]; then echo "Questions before implementing — ${MENTION}:"; else echo "Questions before implementing:"; fi
  echo
  echo "1. <question>"
  echo "2. <question>"
  echo
  echo "(Reply in this TUI session — the worker is waiting.)"
} | node "$TICKET_CLI" post-comment "$ARGUMENTS"
```

Skip this call entirely if `$STATE_TICKET_URL` is empty (no real ticket, e.g. a free-form task) — there's no one to notify. Still fire the notify below and signal done either way.

**Fire macOS notify** via the event bus:

```bash
MUADDIB_ROOT="${REPO_DIR:-/home/worker/repo}"
if [ -d "$MUADDIB_ROOT/muaddib" ]; then MUADDIB_ROOT="$MUADDIB_ROOT/muaddib"; fi
node "$MUADDIB_ROOT/orchestrator/emit-cli.js" \
    "${WORKER_INDEX:-0}" claude notify \
    "{\"msg\":\"${STATE_TICKET_IDENTIFIER} needs your input before implementing\"}"
```

Then signal done — the `ask-questions` step will handle the response:

```bash
touch "$STEP_DONE_FILE"
```

> ⚠️ **This `touch` must be your literal last tool call — actually run it, don't just state that the step is done.** The orchestrator detects completion only when this file appears on disk; a closing summary sentence does not create it. Narrating completion without running the command leaves the step hanging until it is force-nudged.
