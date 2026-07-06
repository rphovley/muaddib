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

## Step 3 — Write and open the artifact

Write it under `.muaddib/sketch/<name>.html` in the repo checkout, then open
it — always pass `--no-open` (the container has no display):

```bash
npx -y lavish-axi <html-file> --no-open
```

## Step 4 — Record the file path for the orchestrator

```bash
STATE_CLI="${REPO_DIR:-/home/worker/repo}/muaddib/orchestrator/state-cli.js"
WORKER="${WORKER_INDEX:-0}"
node "$STATE_CLI" "$WORKER" set sketch_file "<absolute path to html-file>"
```

## Step 5 — Notify the operator

Post to Linear (`@mention` the assignee) and fire a macOS notify, same
pattern as `analyze-ticket` Step 5b — the operator may not be attached yet:

```
@<assignee> — a prototype is ready for your review on <ticket>:

Attach to the worker to view and annotate it, or watch for the URL in its
tmux session. Leave feedback and keep iterating, or submit with no changes
to approve it — the plan finalizes once you do.
```

```bash
node "${REPO_DIR:-/home/worker/repo}/muaddib/orchestrator/emit-cli.js" \
    "${WORKER_INDEX:-0}" claude notify \
    "{\"msg\":\"${STATE_TICKET_IDENTIFIER:-$ARGUMENTS} prototype ready for your review\"}"
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
