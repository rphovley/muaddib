---
name: review-fleet
description: Fleet review step. Runs /review on the current branch, evaluates findings, then writes review_status=approved|needs_fix and a compact findings summary to worker state so the quality loop can decide whether to exit or run a fix pass.
---

# Review Fleet

Fleet-safe review step. **Never calls `AskUserQuestion`.**

## Step 1 — Run /review

Call `Skill(review)` with no args. Capture all output from the review agents.

## Step 2 — Evaluate findings

Triage the review output against this decision table:

| Finding                                              | Effect on verdict                 |
| ---------------------------------------------------- | --------------------------------- |
| Blocker                                              | → `needs_fix`                     |
| Major                                                | → `needs_fix`                     |
| Open question that requires a code change to resolve | → `needs_fix`                     |
| Minor / Nit                                          | Note for PR body — does not block |

If there are no blockers, no majors, and no unresolved code-change questions: verdict is `approved`.

## Step 3 — Write state

```bash
MUADDIB_ROOT="${REPO_DIR:-/home/worker/repo}"
if [ -d "$MUADDIB_ROOT/muaddib" ]; then MUADDIB_ROOT="$MUADDIB_ROOT/muaddib"; fi
STATE_CLI="$MUADDIB_ROOT/orchestrator/state-cli.js"
WORKER="${WORKER_INDEX:-0}"

node "$STATE_CLI" "$WORKER" set review_status <approved|needs_fix>
```

If the verdict is `needs_fix`, also write a compact findings summary (one line per item, ≤500 chars total — the fix step reads this as `STATE_REVIEW_FINDINGS`):

```bash
node "$STATE_CLI" "$WORKER" set review_findings "<one-line-per-finding>"
```

If the verdict is `approved`, clear any prior findings:

```bash
node "$STATE_CLI" "$WORKER" set review_findings ""
```

## Step 5 — Signal done

```bash
touch "$STEP_DONE_FILE"
```

> ⚠️ **This `touch` must be your literal last tool call — actually run it, don't just state that the step is done.** The orchestrator detects completion only when this file appears on disk; a closing summary sentence does not create it. Narrating completion without running the command leaves the step hanging until it is force-nudged.
