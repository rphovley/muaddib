---
name: muaddib-feedback
description: Apply PR review feedback. Reads new comments on the GitHub PR since the last feedback run, makes code changes to address them, commits and pushes to the existing branch, re-runs /check, and posts a reply on the PR summarizing what was addressed. Never calls AskUserQuestion.
---

# Muaddib Feedback

Addresses reviewer feedback posted as comments on the GitHub PR. Called by the orchestrator when a new `/feedback` comment arrives. **Never calls `AskUserQuestion`.** When feedback is ambiguous, make the most reasonable interpretation and document it in the reply.

`$ARGUMENTS` is the Linear ticket identifier (e.g. `QUO-281`), used only for posting the reply.

## Step 1 — Read new PR comments

Read the PR number:
```bash
cat /tmp/pr-number-${WORKER_INDEX:-1}
```

Fetch all comments on the PR using the GitHub CLI:
```bash
gh pr view <pr_number> --comments --json comments
```

Read `/tmp/last-feedback-ts` to find the cutoff:
```bash
cat /tmp/last-feedback-ts 2>/dev/null || echo "0"
```

The file contains a Unix timestamp (seconds). Focus on comments whose `createdAt` is newer than that timestamp. If the file is absent, treat all comments as new.

Identify **actionable** comments: those describing bugs, incorrect behavior, missing functionality, or UI problems — from human reviewers. Ignore automated bot comments, CI status comments, and comments that already have a subsequent agent reply.

## Step 2 — Confirm branch state

```bash
git status
git branch --show-current
```

You are already on the feature branch. If `git status` shows unexpected uncommitted changes, stash them before proceeding.

## Step 3 — Make changes

For each piece of actionable feedback:
1. Read the relevant files to understand the current state.
2. Make the targeted change.
3. Write or update tests if the change touches service or database code (follow the same test conventions as `/implementation-fleet`).

Keep changes minimal and targeted. Do not refactor unrelated code.

If a feedback item is genuinely out of scope or architecturally impossible, note it in the reply rather than silently skipping it.

## Step 4 — Run /check

Call `Skill(check)` with no args. Fix all blockers. Loop until clean or until 3 passes have run. If still failing after 3 passes, commit what you have and document the remaining issue in the reply comment.

## Step 5 — Commit and push

```bash
git add <specific files>
git commit -m "address review feedback: <brief summary>

Co-Authored-By: Claude <noreply@anthropic.com>"
git push origin HEAD
```

Never force-push. Stage files by name.

## Step 6 — Post reply on the PR

```bash
gh pr comment <pr_number> --body "$(cat <<'EOF'
## Feedback addressed

- <one bullet per actionable comment, describing what changed>

<if anything was deferred or noted as out of scope, say so>

🤖 Auto-addressed via muaddib feedback loop
EOF
)"
```

## Step 7 — Update last-feedback timestamp

```bash
date -u +%s > /tmp/last-feedback-ts
```
