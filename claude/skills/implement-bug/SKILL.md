---
name: implement-bug
description: Fleet implementation step for bug fixes. Writes code and tests. No preview seed script. Initial implementation only — never commits.
---

# Implement (Bug)

Fleet implementation step for bug fixes. Never commits. Does not write a preview seed script.

**If a blocking question arises mid-implementation** and cannot be resolved by reading the codebase: post to Linear as a `@mention` comment, fire a macOS notify via the event bus, then call `AskUserQuestion`. Do not block silently.

`$ARGUMENTS` is the Linear ticket identifier. `STATE_BRANCH` is already checked out.

## Step 1 — Load plan context

Read `.muaddib/plan.md` in the repo root — this is the authoritative plan written by `analyze-ticket` / `ask-questions`. If that file does not exist, fall back to finding the `## Plan` comment via `mcp__linear__get_issue` on `$ARGUMENTS` (or its parent).

Read `CLAUDE.md` (root and per-project for the affected area). Read the files referenced in the plan.

## Step 2 — Implement

Work through the plan's work streams in dependency order. Make changes and write tests inline. Do not expand scope beyond the plan. If the plan turns out to be wrong or incomplete, post a Linear `@mention` comment explaining the blocker, fire a macOS notify, then call `AskUserQuestion` to get direction. Do not write BLOCKED state silently.

Do not commit.

## Step 3 — Write tests

For every new or changed code path, write a dedicated test. Follow project conventions:
- API service edits → unit tests (`npm run test:unit`)
- API database edits → integration tests (`npm run test:integration`)
- Portal / homeowner logic → component or hook tests

## Step 4 — Signal done

```bash
touch "$STEP_DONE_FILE"
```
