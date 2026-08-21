---
name: sketch-poll
description: Fleet sketch-review step. Runs exactly one lavish-axi poll cycle against the prototype from the `sketch` step and reports the outcome (feedback vs. ended) to the orchestrator via worker state. Fixes error-severity layout_warnings internally without involving the operator. Never calls AskUserQuestion.
---

# Sketch Poll

Called in a loop by `plan.json`'s `sketch-review-loop` step (see
`muaddib/workflows/plan.json` — a declarative `loop` step, same primitive
`quality-loop` uses in `feature.json`/`bug.json`). Runs exactly one round —
poll, interpret, report, done. The loop, not this skill, owns the "wait, then
decide what happens next" looping.

`$ARGUMENTS` is the Linear ticket identifier.

## Step 0 — Print the review URL before blocking

This step's window is the one the operator lands on — and the poll below
blocks *silently*, so if we don't print the URL here it appears nowhere on
screen (it only lives in the earlier `sketch` step's now-closed window, the
Linear @mention, the macOS notify, and worker state). Echo the recorded
`sketch_url` as a banner so it's always visible no matter when the operator
attaches. This reprints every round since the orchestrator loops this skill.

```bash
STATE_CLI="${REPO_DIR:-/home/worker/repo}/muaddib/orchestrator/state-cli.js"
WORKER="${WORKER_INDEX:-0}"
SKETCH_URL="$(node "$STATE_CLI" "$WORKER" get sketch_url)"
echo "──────────────────────────────────────────────────────────"
echo " Prototype ready for review — open in your browser:"
echo "   ${SKETCH_URL:-<sketch_url not recorded; check the sketch step>}"
echo " Submit feedback or end the session to continue."
echo "──────────────────────────────────────────────────────────"
```

## Step 1 — Poll

Clear the previous round's `sketch_status` first — if this round's session
exits without ever reaching Step 4 (crash, interrupted, etc.), a stale
`feedback` value left over from last time would make `sketch-feedback`
re-apply the same feedback a second time on the next loop iteration.
Clearing it means an incomplete round just polls again instead.

```bash
node "$STATE_CLI" "$WORKER" unset sketch_status

SKETCH_FILE="$(node "$STATE_CLI" "$WORKER" get sketch_file)"

REPLY_FILE="/tmp/sketch-reply-${WORKER}.txt"
REPLY_ARGS=()
if [ -s "$REPLY_FILE" ]; then
  REPLY_ARGS=(--agent-reply "$(cat "$REPLY_FILE")")
fi
npx -y lavish-axi poll "$SKETCH_FILE" "${REPLY_ARGS[@]}"
rm -f "$REPLY_FILE"
```

This blocks (no timeout) until the operator submits feedback, ends the
session, or the browser reports a layout warning. That's expected — the
orchestrator isn't waiting on anything else in the meantime.

If your harness caps how long a foreground command may run, the poll may be
killed before the operator acts. That's harmless — just re-run it (as a
background task if you can). Queued feedback is never lost, so re-print the
Step 0 banner and poll again.

## Step 2 — Handle layout_warnings without involving the operator

If the result carries `layout_warnings`: fix fresh error-severity findings in
`$SKETCH_FILE` and go back to Step 1. If every current warning is persistent
or low-severity, ignore them and continue with whatever else the poll
returned. If it returned nothing else new yet, poll again.

## Step 3 — Interpret the outcome

Treat as **ended** (approval) if any of:
- The operator ended the session from the browser.
- The submitted feedback is the "Submit Review" control from `sketch` Step 2
  with an empty/approval comment (e.g. "Approved — no changes").

Treat as **feedback** if the operator submitted an actual comment/annotation
requesting a change.

## Step 4 — Report the outcome

Write the outcome to worker state — the loop's `exitCondition` reads
`sketch_status` to decide whether to poll again or exit:

- Ended/approved: `node "$STATE_CLI" "$WORKER" set sketch_status ended`
- Feedback: `node "$STATE_CLI" "$WORKER" set sketch_status feedback`, and write
  the feedback content (submitted comment, annotation text, selected-text
  ranges) to `/tmp/sketch-feedback-${WORKER}.txt` for the `sketch-feedback`
  step.

## Step 5 — Signal done

```bash
touch "$STEP_DONE_FILE"
```
