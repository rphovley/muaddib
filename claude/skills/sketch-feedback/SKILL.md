---
name: sketch-feedback
description: Fleet sketch-review step. Applies one round of operator feedback (from sketch-poll) to the prototype and, if it changes the underlying approach, to .muaddib/plan.md. Never calls AskUserQuestion.
---

# Sketch Feedback

Called by `plan.json`'s `sketch-review-loop` step (see
`muaddib/workflows/plan.json`) after `sketch-poll` sets `sketch_status` to
`feedback`. Applies exactly one round, then hands back to `sketch-poll`.

`$ARGUMENTS` is the Linear ticket identifier.

## Step 1 — Read the feedback and the current artifacts

```bash
STATE_CLI="${REPO_DIR:-/home/worker/repo}/muaddib/orchestrator/state-cli.js"
WORKER="${WORKER_INDEX:-0}"
SKETCH_FILE="$(node "$STATE_CLI" "$WORKER" get sketch_file)"
NOTES="${REPO_DIR:-/home/worker/repo}/.muaddib/sketch/notes.md"
cat "/tmp/sketch-feedback-${WORKER}.txt"
```

Read `$SKETCH_FILE` and `.muaddib/plan.md`.

Also read `$NOTES` if it exists — it's the running log of every prior
feedback round (what was asked for, what was changed). You are a fresh
process with no memory of earlier rounds; this file is the only place that
context survives. Use it so you don't re-litigate or contradict a decision
already made a few rounds back, and so relative feedback ("go back to what
you had before", "like the last version") is interpretable.

## Step 2 — Apply the feedback

Revise `$SKETCH_FILE` to address it, consistent with the history in `$NOTES`.
Lavish live-reloads the file automatically — do not re-run `lavish-axi
<file>` to "push" the change.

If the feedback changes the underlying approach (not just visual polish),
update `.muaddib/plan.md`'s Solution/Work Streams to match — same as how
`ask-questions` Step 3 folds Q&A answers into the plan.

## Step 3 — Append this round to the notes log

```bash
mkdir -p "$(dirname "$NOTES")"
ROUND=$(( $(grep -c '^## Feedback round' "$NOTES" 2>/dev/null || echo 0) + 1 ))
cat >> "$NOTES" <<EOF

## Feedback round ${ROUND}
**Feedback:** <the operator's feedback from Step 1, verbatim or lightly trimmed>
**Change:** <1-2 sentences on what you changed in response, and why>
EOF
```

## Step 4 — Queue a reply for the next poll

Write a short (1–2 sentence) summary of what changed, for `sketch-poll` to
pass as `--agent-reply` on its next call:

```bash
echo "<summary of what changed>" > "/tmp/sketch-reply-${WORKER}.txt"
```

## Step 5 — Signal done

```bash
touch "$STEP_DONE_FILE"
```
