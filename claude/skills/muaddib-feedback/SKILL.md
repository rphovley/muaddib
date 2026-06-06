---
name: muaddib-feedback
description: Apply Linear ticket review feedback. Reads new comments on the specified Linear ticket since the last feedback run, makes code changes to address them, commits and pushes to the existing branch, re-runs /check, and posts a reply comment on the ticket summarizing what was addressed. Never calls AskUserQuestion.
---

# Muaddib Feedback

Addresses reviewer feedback posted as comments on the Linear ticket. Called by `watch-feedback.sh` when a new comment arrives. **Never calls `AskUserQuestion`.** When feedback is ambiguous, make the most reasonable interpretation and document it in the reply.

`$ARGUMENTS` is the Linear ticket identifier (e.g. `QUO-281`).

## Step 1 — Read the ticket and new comments

Call `mcp__linear__get_issue` with the identifier from `$ARGUMENTS`.

Call `mcp__linear__list_comments` for the same issue. Read `/tmp/last-feedback-ts` to find the cutoff:
```bash
cat /tmp/last-feedback-ts 2>/dev/null || echo "0"
```

The file contains a Unix timestamp (seconds). Focus on comments whose `createdAt` is newer than that timestamp. If the file is absent, treat all comments as new.

Identify **actionable** comments: those describing bugs, incorrect behavior, missing functionality, or UI problems. Ignore automated bot comments, CI status comments, and comments that already have a subsequent agent reply.

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

## Step 6 — Post reply on the Linear ticket

Call `mcp__linear__save_comment` on the issue with a body like:

```
## Feedback addressed

- <one bullet per actionable comment, describing what changed>

<if anything was deferred or noted as out of scope, say so>

PR: <read /tmp/pr-number and link: https://github.com/<repo>/pull/<n>>

🤖 Auto-addressed via muaddib feedback loop
```

## Step 7 — Update last-feedback timestamp

```bash
date -u +%s > /tmp/last-feedback-ts
```
