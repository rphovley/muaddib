---
name: confirm-plan
description: Fleet planning gate. Runs only when fetch-ticket found an existing "## Plan" comment. Stops to ask the operator whether to replace it; on replace, resets plan_status so analyze-ticket regenerates the plan from scratch.
---

# Confirm Plan

Runs only when `fetch-ticket` found an existing `## Plan` comment on the ticket (or its parent) and hydrated `.muaddib/plan.md` from it.

`STATE_TICKET_IDENTIFIER` is the ticket ID (e.g. `QUO-325`).
`STATE_TICKET_URL` is the full Linear URL.

## Step 1 — Read the existing plan

Read `.muaddib/plan.md` in the repo root — this is the plan already hydrated from the ticket's `## Plan` comment.

## Step 2 — Ask the operator

Call `AskUserQuestion`:

> `${STATE_TICKET_IDENTIFIER}` already has a plan posted. Replace it with a fresh plan?

Options:
- **Replace** — discard the existing plan; `analyze-ticket` will diagnose and plan from scratch.
- **Keep it** — leave the existing plan untouched; nothing else runs this pass.

## Step 3 — Write `plan_status` to state

```bash
MUADDIB_ROOT="${REPO_DIR:-/home/worker/repo}"
if [ -d "$MUADDIB_ROOT/muaddib" ]; then MUADDIB_ROOT="$MUADDIB_ROOT/muaddib"; fi
STATE_CLI="$MUADDIB_ROOT/orchestrator/state-cli.js"
WORKER="${WORKER_INDEX:-0}"
# Replace  -> reset to not_found so analyze-ticket's runIf picks it up.
# Keep it  -> leave plan_status as "found"; analyze-ticket stays skipped.
node "$STATE_CLI" "$WORKER" set plan_status "not_found"   # only if the operator chose Replace
```

## Step 4 — Signal done

```bash
touch "$STEP_DONE_FILE"
```

> ⚠️ **This `touch` must be your literal last tool call — actually run it, don't just state that the step is done.** The orchestrator detects completion only when this file appears on disk; a closing summary sentence does not create it. Narrating completion without running the command leaves the step hanging until it is force-nudged.
