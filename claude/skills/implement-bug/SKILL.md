---
name: implement-bug
description: Fleet implementation step for bug fixes. Writes code and tests. No preview seed script. Used for the initial fix pass and subsequent fix passes after review. Never commits.
---

# Implement (Bug)

Fleet implementation step for bug fixes. Never commits. Does not write a preview seed script.

**If a blocking question arises mid-implementation** and cannot be resolved by reading the codebase: post to Linear as a `@mention` comment, fire a macOS notify via the event bus, then call `AskUserQuestion`. Do not block silently.

`$ARGUMENTS` is the Linear ticket identifier. `STATE_BRANCH` is already checked out. If `STATE_REVIEW_FINDINGS` is non-empty this is a **fix pass** — address those findings instead of implementing from scratch.

## Step 1 — Load plan context

Read `.muaddib/plan.md` in the repo root — this is the authoritative plan written by `analyze-ticket` / `ask-questions`. If that file does not exist, fall back to finding the `## Plan` comment via `mcp__linear__get_issue` on `$ARGUMENTS` (or its parent).

Read `CLAUDE.md` (root and per-project for the affected area). Read the files referenced in the plan.

## Step 2 — Implement

**Initial pass** (`STATE_REVIEW_FINDINGS` is empty or unset):

Work through the plan's work streams in dependency order. Make changes and write tests inline. Do not expand scope beyond the plan. If the plan turns out to be wrong or incomplete, post a Linear `@mention` comment explaining the blocker, fire a macOS notify, then call `AskUserQuestion` to get direction. Do not write BLOCKED state silently.

**Fix pass** (`STATE_REVIEW_FINDINGS` is set):

Read `$STATE_REVIEW_FINDINGS`. For each finding: make the targeted fix. Keep changes minimal.

In both modes: do not commit.

## Step 3 — Write tests

For every new or changed code path, write a dedicated test. Follow project conventions:
- API service edits → unit tests (`npm run test:unit`)
- API database edits → integration tests (`npm run test:integration`)
- Portal / homeowner logic → component or hook tests
