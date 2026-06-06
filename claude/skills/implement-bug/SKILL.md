---
name: implement-bug
description: Fleet implementation step for bug fixes. Writes code and tests. No preview seed script. Used for the initial fix pass and subsequent fix passes after review. Never commits.
---

# Implement (Bug)

Fleet-safe implementation step for bug fixes. **Never calls `AskUserQuestion`.** Never commits. Does not write a preview seed script.

`$ARGUMENTS` is the Linear ticket identifier. `STATE_BRANCH` is already checked out by gather-context-bug. If `STATE_REVIEW_FINDINGS` is non-empty this is a **fix pass** — address those findings instead of implementing from scratch.

## Step 1 — Load plan context

Call `mcp__linear__get_issue` with the identifier from `$ARGUMENTS`. Find the `## Plan` comment on this ticket or its parent.

Read `CLAUDE.md` (root and per-project for the affected area). Read the files referenced in the plan.

## Step 2 — Implement

**Initial pass** (`STATE_REVIEW_FINDINGS` is empty or unset):

Work through the plan's work streams in dependency order. Make changes and write tests inline. Do not expand scope beyond the plan. If the plan turns out to be wrong or incomplete, write BLOCKED state and stop:

```bash
printf 'BLOCKED %s\n' "$(date -u +%FT%TZ)" > "/var/run/agent-status/worker-${WORKER_INDEX:-0}.state" 2>/dev/null || true
```

**Fix pass** (`STATE_REVIEW_FINDINGS` is set):

Read `$STATE_REVIEW_FINDINGS`. For each finding: make the targeted fix. Keep changes minimal.

In both modes: do not commit.

## Step 3 — Write tests

For every new or changed code path, write a dedicated test. Follow project conventions:
- API service edits → unit tests (`npm run test:unit`)
- API database edits → integration tests (`npm run test:integration`)
- Portal / homeowner logic → component or hook tests
