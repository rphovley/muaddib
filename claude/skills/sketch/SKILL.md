---
name: sketch
description: UI/UX prototyping setup step for muaddib planning (plan.json), run when analyze-ticket sets needs_sketch=true. Builds an HTML mock matching the target project's real design system, opens it (lavish-axi under the hood), records its path for the orchestrator, and notifies the operator. Never calls AskUserQuestion.
---

# Sketch

Sets up a review session — it does **not** wait for feedback itself. The
orchestrator drives the actual review loop afterward (`SKETCH_REVIEW` state,
`sketch-poll` / `sketch-feedback` / `sketch-finalize`), the same way `wrapup`
just opens a PR and the orchestrator's `FEEDBACK` state drives the PR review
loop afterward — the looping is real control flow in
`orchestrator/sketch-review.js`, not prose in a skill.

`$ARGUMENTS` is the Linear ticket identifier. Read `.muaddib/plan.md` in the
repo root first — that's the plan you're prototyping, not the ticket title
alone.

## Step 1 — Match the real design system before writing any HTML

Inspect the target project (the app the prototype is *for* — may differ from
your current working directory):
- Portal (`projects/portal`) and Homeowner (`projects/homeowner`) both use
  Mantine v8 — check `src/theme.tsx` for the theme, and reuse existing
  components/colors/spacing rather than hand-rolled markup.
- For any other project, or a non-app artifact (e.g. a dashboard/chart mockup
  for a third-party tool like PostHog), look for its own visual conventions
  the same way — this is a discovery step, not a hardcoded assumption.
- Only fall back to `npx -y lavish-axi design` (generic Tailwind + DaisyUI) if
  there's truly nothing existing to match.

## Step 2 — Build in an explicit submission control

The review needs a clear, discoverable way for the operator to submit
feedback — don't rely solely on the browser chrome's overflow-menu actions.
Include, in the prototype itself:

- A comment/feedback textarea.
- A primary **"Submit Review"** button that queues it as one prompt:
  `window.lavish.queuePrompt("<comment text, or 'Approved — no changes' if empty>")`.

This mirrors lavish's own guidance for reversible-choice review: queue
exactly one final answer from a per-question submit or queue-answer button,
rather than annotating piecemeal with no clear "I'm done" action. The
operator can still use freeform element/text annotation on top of this if
they prefer — the submit button is the guaranteed, obvious path.

## Step 3 — Write and open the artifact, and capture the real URL

Write it under `.muaddib/sketch/<name>.html` in the repo checkout, then open
it — always pass `--no-open` (the container has no display):

```bash
OPEN_OUTPUT="$(npx -y lavish-axi <html-file> --no-open)"
echo "$OPEN_OUTPUT"
```

**The URL is per-session, not derivable from the port alone.** Lavish serves
each session at its own path (e.g. `http://127.0.0.1:4387/session/<key>`),
printed in `$OPEN_OUTPUT` — it is not just `http://localhost:<port>/`
(that 404s). Extract the path and rebuild it with the *host*-reachable port:
the container always listens on lavish's own default (4387) regardless of
worker number, but the port published to the operator's Mac varies per
worker — `docker-compose.worker.yml` injects it as `WORKER_SKETCH_PORT`.
Concretely:

```bash
WORKER="${WORKER_INDEX:-0}"
SESSION_PATH="$(echo "$OPEN_OUTPUT" | grep -oE '/session/[A-Za-z0-9]+' | head -1)"
SKETCH_URL="http://localhost:${WORKER_SKETCH_PORT:?set WORKER_SKETCH_PORT}${SESSION_PATH}"
echo "Operator URL: $SKETCH_URL"
```

If `$SESSION_PATH` comes back empty, read `~/.lavish-axi/state.json` instead
— its `sessions.<key>.url` field has the same path, keyed by the most
recently opened session for this file.

## Step 4 — Record the file path and URL for the orchestrator and operator

```bash
STATE_CLI="${REPO_DIR:-/home/worker/repo}/muaddib/orchestrator/state-cli.js"
node "$STATE_CLI" "$WORKER" set sketch_file "<absolute path to html-file>"
node "$STATE_CLI" "$WORKER" set sketch_url "$SKETCH_URL"
```

## Step 5 — Notify the operator with the actual URL

Post to Linear (`@mention` the assignee) and fire a macOS notify, same
pattern as `analyze-ticket` Step 5b — the operator may not be attached yet.
**Include `$SKETCH_URL` directly in the comment** — don't defer to "check
tmux": by the time anyone reads this, the orchestrator has already moved the
tmux window on to `sketch-poll`, and the `sketch` step's own window (where
this URL was printed) closes automatically once this step finishes.

```
@<assignee> — a prototype is ready for your review on <ticket>:

<$SKETCH_URL>

Leave feedback and keep iterating, or submit with no changes to approve it —
the plan finalizes once you do.
```

```bash
node "${REPO_DIR:-/home/worker/repo}/muaddib/orchestrator/emit-cli.js" \
    "${WORKER_INDEX:-0}" claude notify \
    "{\"msg\":\"${STATE_TICKET_IDENTIFIER:-$ARGUMENTS} prototype ready: ${SKETCH_URL}\"}"
```

## Step 6 — Signal done

```bash
touch "$STEP_DONE_FILE"
```

## Notes

- Playbooks (`npx -y lavish-axi playbook <id>` — `diagram`, `table`,
  `comparison`, `plan`, `code`, `input`, `slides`) apply here too; open
  whichever match the content before writing HTML. The `input` playbook is
  specifically about collecting structured feedback like this — read it.
