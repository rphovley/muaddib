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

| Finding | Effect on verdict |
|---|---|
| Blocker | → `needs_fix` |
| Major | → `needs_fix` |
| Open question that requires a code change to resolve | → `needs_fix` |
| Minor / Nit | Note for PR body — does not block |

If there are no blockers, no majors, and no unresolved code-change questions: verdict is `approved`.

## Step 3 — Write state

```bash
STATE_CLI="${REPO_DIR:-/home/worker/repo}/muaddib/lib/state-cli.js"
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
