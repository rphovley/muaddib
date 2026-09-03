---
name: adjust-sizing
description: Fleet sizing-review step. Applies one round of operator feedback (from confirm-sizing) to the plan's Work Streams in .muaddib/plan.md, then re-runs size-and-schedule --propose so a revised "## Sizing & Scheduling" preview is posted, and loops back to confirm-sizing. Never calls AskUserQuestion.
---

# Adjust Sizing

Called by `plan.json`'s `sizing-review-loop` step (see
`muaddib/workflows/plan.json`) after `confirm-sizing` set `sizing_confirm` to
`adjust`. Applies exactly one round, then hands back to `confirm-sizing`. Same
shape as `sketch-feedback`.

`$ARGUMENTS` is the ticket identifier.

## Step 1 — Read the requested changes and the plan

```bash
MUADDIB_ROOT="${REPO_DIR:-/home/worker/repo}"
if [ -d "$MUADDIB_ROOT/muaddib" ]; then MUADDIB_ROOT="$MUADDIB_ROOT/muaddib"; fi
STATE_CLI="$MUADDIB_ROOT/orchestrator/state-cli.js"
WORKER_INDEX="${WORKER_INDEX:-$(cat /tmp/worker-index 2>/dev/null)}"
: "${WORKER_INDEX:?WORKER_INDEX not set (env and /tmp/worker-index both empty)}"
WORKER="$WORKER_INDEX"
cat "/tmp/sizing-adjust-${WORKER}.txt"
```

Read `.muaddib/plan.md` — the `### Work Streams` section is what the sizing
scheduler parses into sub-issues.

## Step 2 — Apply the change to the plan's Work Streams

Revise `.muaddib/plan.md`'s `### Work Streams` (and the `### Solution` section if
the change alters the approach, not just the split) to address the operator's
request. Keep the strict template the parser depends on:

- Each stream is a `**Stream N — name**` header line (dependency-ordered, so
  Stream 1 has no dependency), followed by `-`/`*` bullets.
- An explicit cross-stream dependency is written as `depends on Stream X` in a
  stream's body (X must be an earlier stream).

Only touch the streams the operator asked about — do not re-plan the rest.

## Step 3 — Re-run the propose phase (re-post the revised preview)

Re-run `size-and-schedule --propose` so a fresh `## Sizing & Scheduling` preview
reflecting the revised streams is posted to the ticket. It reads the plan you
just edited; still no sub-issues are created.

```bash
node "$MUADDIB_ROOT/scripts/size-and-schedule.js" --propose
```

The loop then returns to `confirm-sizing`, which shows the revised preview and
asks again.

## Step 4 — Signal done

```bash
touch "$STEP_DONE_FILE"
```

> ⚠️ **This `touch` must be your literal last tool call — actually run it, don't just state that the step is done.** The orchestrator detects completion only when this file appears on disk; a closing summary sentence does not create it. Narrating completion without running the command leaves the step hanging until it is force-nudged.
