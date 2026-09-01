---
name: ask-questions
description: Fleet Q&A step. Runs only when analyze-ticket flagged needs_questions=true. Reads the draft plan, calls AskUserQuestion (after Linear @mention + macOS notify have already been sent by analyze-ticket), incorporates answers into .muaddib/plan.md, and posts the final ## Plan comment to Linear.
---

# Ask Questions

Runs only when `analyze-ticket` set `needs_questions=true`. By the time this step starts, the user has already been notified via Linear @mention and macOS notify.

`STATE_TICKET_IDENTIFIER` is the ticket ID (e.g. `QUO-325`).
`STATE_TICKET_URL` is the full Linear URL.

## Step 1 — Read the draft plan

Read `.muaddib/plan.md` in the repo root. The "Open Questions" section contains the questions `analyze-ticket` identified.

## Step 2 — Call AskUserQuestion

Call `AskUserQuestion` with the open questions. The user has been notified and will return to this TUI window to answer.

Present the questions clearly. Use `multiSelect: false` for each distinct question, or group related questions. Keep it to what is genuinely needed — do not expand the question list.

## Step 3 — Incorporate answers into `.muaddib/plan.md`

Rewrite the plan with the answers folded in:
- Update the "Solution" and "Work Streams" sections to reflect what was learned
- Remove the "Open Questions" section (it is now resolved)

## Step 4 — Post final plan to the ticket

Post the updated `.muaddib/plan.md` as a `## Plan` comment via the source-neutral ticket CLI (works for whatever `TICKET_SOURCE` the project uses — Linear, GitHub, or a no-op for raw). Skip if `$STATE_TICKET_URL` is empty (no real ticket).

```bash
MUADDIB_ROOT="${REPO_DIR:-/home/worker/repo}"
if [ -d "$MUADDIB_ROOT/muaddib" ]; then MUADDIB_ROOT="$MUADDIB_ROOT/muaddib"; fi
TICKET_CLI="$MUADDIB_ROOT/orchestrator/ticket-cli.js"
# .muaddib/plan.md already starts with its own "## Plan" heading; bodies are
# large multi-line markdown, so pipe via stdin, not argv. $STATE_TICKET_IDENTIFIER
# is the source-neutral id the CLI accepts.
node "$TICKET_CLI" post-comment "$STATE_TICKET_IDENTIFIER" < "${REPO_DIR:-/home/worker/repo}/.muaddib/plan.md"
```

## Step 5 — Signal done

```bash
touch "$STEP_DONE_FILE"
```

> ⚠️ **This `touch` must be your literal last tool call — actually run it, don't just state that the step is done.** The orchestrator detects completion only when this file appears on disk; a closing summary sentence does not create it. Narrating completion without running the command leaves the step hanging until it is force-nudged.
