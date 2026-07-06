---
name: sketch-finalize
description: Fleet sketch-review step. Runs once the operator approves the sketch (ends the session or submits with no changes). Exports the prototype and posts the finalized ## Plan and ## Sketch comments to Linear. Never calls AskUserQuestion.
---

# Sketch Finalize

Called by the orchestrator's sketch-review state machine
(`SKETCH_FINALIZING`) once `sketch-poll` reports `ended`. This is the
approval gate: `analyze-ticket` deliberately did not post `## Plan` when
`needs_sketch=true` — this step posts it now, reflecting whatever the review
loop changed.

`$ARGUMENTS` is the Linear ticket identifier.

## Step 1 — Export the prototype and gather the review history

```bash
STATE_CLI="${REPO_DIR:-/home/worker/repo}/muaddib/orchestrator/state-cli.js"
WORKER="${WORKER_INDEX:-0}"
SKETCH_FILE="$(node "$STATE_CLI" "$WORKER" get sketch_file)"
NOTES="${REPO_DIR:-/home/worker/repo}/.muaddib/sketch/notes.md"
npx -y lavish-axi export "$SKETCH_FILE"
cat "$NOTES" 2>/dev/null
```

Read the resulting `<name>.export.html`. `$NOTES` may not exist — that means
the operator approved on the first look with no feedback rounds at all;
that's fine, just say so in Step 3.

## Step 2 — Post `## Plan`

Post the current (possibly revised) `.muaddib/plan.md` as a `## Plan`
comment via `mcp__linear__save_comment` — same format `analyze-ticket` would
have used had it posted directly.

## Step 3 — Post `## Sketch`

```markdown
## Sketch

<2-3 sentence summary of what the review loop changed overall and why — not
just "prototyped the screen">

<details>
<summary>Review history (<N> round(s) of feedback, or "approved on first look" if $NOTES doesn't exist)</summary>

<full contents of $NOTES, verbatim — or "No feedback — approved as first shown." if it doesn't exist>

</details>

<details>
<summary>Prototype (exported HTML)</summary>

\`\`\`html
<full contents of the exported HTML file>
\`\`\`

</details>
```

Keep the exported artifact lean (avoid large embedded base64 images) — it
needs to fit in the comment body. If it's unexpectedly huge, say so in the
comment rather than silently truncating it.

## Step 4 — Signal done

```bash
touch "$STEP_DONE_FILE"
```
