---
name: implement-bug
description: Fleet implementation step for bug fixes. Writes code and tests. No preview seed script. Used for the initial fix pass and subsequent fix passes after review. Never commits.
---

# Implement (Bug)

Fleet implementation step for bug fixes. Never commits. Does not write a preview seed script.

**If a blocking question arises mid-implementation** and cannot be resolved by reading the codebase: post to Linear as a `@mention` comment, fire a macOS notify via the event bus, then call `AskUserQuestion`. Do not block silently.

`$ARGUMENTS` is the Linear ticket identifier. `STATE_BRANCH` is already checked out.

There are three modes — check which applies before doing anything else:

- **Check fix pass**: `STATE_CHECK_STATUS === 'fail'` and `STATE_CHECK_OUTPUT` is non-empty → fix failing tests/checks only. Skip Step 1 entirely.
- **Review fix pass**: `STATE_REVIEW_FINDINGS` is non-empty → fix review findings only. Skip Step 1 entirely.
- **Initial pass**: neither of the above → implement from scratch.

## Step 1 — Load plan context (initial pass only)

Skip this step on a check fix pass or review fix pass.

Read `.muaddib/plan.md` in the repo root — this is the authoritative plan written by `analyze-ticket` / `ask-questions`. If that file does not exist, fall back to finding the `## Plan` comment via `mcp__linear__get_issue` on `$ARGUMENTS` (or its parent).

Read `CLAUDE.md` (root and per-project for the affected area). Read the files referenced in the plan.

## Step 2 — Implement

**Check fix pass** (`STATE_CHECK_STATUS === 'fail'`, `STATE_CHECK_OUTPUT` is set):

The bug fix is already implemented — do not re-read the plan or re-verify that the bug is resolved. Read `$STATE_CHECK_OUTPUT` directly. It contains labeled sections of raw compiler/test output (`=== api:check ===`, etc.). Fix only the specific errors shown. Keep changes minimal — do not touch code unrelated to the failures.

**Review fix pass** (`STATE_REVIEW_FINDINGS` is set):

Read `$STATE_REVIEW_FINDINGS`. For each finding: make the targeted fix. Keep changes minimal.

**Initial pass** (neither of the above):

Work through the plan's work streams in dependency order. Make changes and write tests inline. Do not expand scope beyond the plan. If the plan turns out to be wrong or incomplete, post a Linear `@mention` comment explaining the blocker, fire a macOS notify, then call `AskUserQuestion` to get direction. Do not write BLOCKED state silently.

In all modes: do not commit.

## Step 3 — Write tests

For every new or changed code path, write a dedicated test. Follow project conventions:
- API service edits → unit tests (`npm run test:unit`)
- API database edits → integration tests (`npm run test:integration`)
- Portal / homeowner logic → component or hook tests

## Step 4 — Signal done

```bash
touch "$STEP_DONE_FILE"
```
