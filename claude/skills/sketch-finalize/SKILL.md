---
name: sketch-finalize
description: Fleet sketch-review step. Runs once the operator approves the sketch (ends the session or submits with no changes). Exports the prototype and posts the finalized ## Plan and ## Sketch comments to Linear. Never calls AskUserQuestion.
---

# Sketch Finalize

Called by `plan.json`'s `sketch-finalize` step (see
`muaddib/workflows/plan.json`) once `sketch-review-loop` exits with
`sketch_status=ended`. This is the approval gate: `analyze-ticket`
deliberately did not post `## Plan` when `needs_sketch=true` — this step
posts it now, reflecting whatever the review loop changed.

`$ARGUMENTS` is the Linear ticket identifier.

## Step 1 — Export the prototype and gather the review history

```bash
MUADDIB_ROOT="${REPO_DIR:-/home/worker/repo}"
if [ -d "$MUADDIB_ROOT/muaddib" ]; then MUADDIB_ROOT="$MUADDIB_ROOT/muaddib"; fi
STATE_CLI="$MUADDIB_ROOT/orchestrator/state-cli.js"
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
comment via the source-neutral ticket CLI — same format `analyze-ticket`
would have used had it posted directly (works for whatever `TICKET_SOURCE`
the project uses — Linear, GitHub, or a no-op for raw):

```bash
MUADDIB_ROOT="${REPO_DIR:-/home/worker/repo}"
if [ -d "$MUADDIB_ROOT/muaddib" ]; then MUADDIB_ROOT="$MUADDIB_ROOT/muaddib"; fi
TICKET_CLI="$MUADDIB_ROOT/orchestrator/ticket-cli.js"
# .muaddib/plan.md already starts with its own "## Plan" heading; pipe via stdin.
node "$TICKET_CLI" post-comment "$ARGUMENTS" < "${REPO_DIR:-/home/worker/repo}/.muaddib/plan.md"
```

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

Post it as a second comment via the same source-neutral ticket CLI — write
the `## Sketch` body above to a temp file, then pipe it in on stdin:

```bash
MUADDIB_ROOT="${REPO_DIR:-/home/worker/repo}"
if [ -d "$MUADDIB_ROOT/muaddib" ]; then MUADDIB_ROOT="$MUADDIB_ROOT/muaddib"; fi
TICKET_CLI="$MUADDIB_ROOT/orchestrator/ticket-cli.js"
node "$TICKET_CLI" post-comment "$ARGUMENTS" < "/tmp/sketch-comment-${WORKER_INDEX:-0}.md"
```

Keep the exported artifact lean (avoid large embedded base64 images) — it
needs to fit in the comment body. If it's unexpectedly huge, say so in the
comment rather than silently truncating it.

## Step 4 — Signal done

```bash
touch "$STEP_DONE_FILE"
```

> ⚠️ **This `touch` must be your literal last tool call — actually run it, don't just state that the step is done.** The orchestrator detects completion only when this file appears on disk; a closing summary sentence does not create it. Narrating completion without running the command leaves the step hanging until it is force-nudged.
