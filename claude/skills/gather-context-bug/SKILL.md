---
name: gather-context-bug
description: Fleet context-gathering phase for bug fixes. Loads a Linear ticket and its plan comment, branches from main, then writes branch and ticket_url to worker state. Called before implement-bug in the bug workflow.
---

# Gather Context (Bug)

Fleet-safe first step of the bug workflow. Identical behaviour to gather-context except this variant is used for bug/fix tickets and no preview seed script is expected later.

**Never calls `AskUserQuestion`.**

`$ARGUMENTS` is the Linear ticket identifier (e.g. `QUO-318`).

## Step 1 — Load the ticket and plan

Call `mcp__linear__get_issue` with the identifier from `$ARGUMENTS`. Capture: `identifier`, `title`, `description`, `url`, and `parentId` if present.

Call `mcp__linear__list_comments` for the same ticket. Find the most recent comment whose body starts with `## Plan`.

If no plan comment is found on this ticket and `parentId` is set, check the parent ticket.

If no plan is found anywhere, write BLOCKED state and stop:

```bash
printf 'BLOCKED %s\n' "$(date -u +%FT%TZ)" > "/var/run/agent-status/worker-${WORKER_INDEX:-0}.state" 2>/dev/null || true
```

## Step 2 — Branch from main

```bash
cd "${REPO_DIR:-/home/worker/repo}"
git checkout main
git pull --rebase origin main
git checkout -b <identifier-lowercased>-<short-slug>
```

`<short-slug>` is 2–4 kebab-case words from the ticket title.

If the working tree has uncommitted changes, write BLOCKED state and stop — do not stash or discard.

## Step 3 — Write state

```bash
STATE_CLI="${REPO_DIR:-/home/worker/repo}/muaddib/orchestrator/state-cli.js"
WORKER="${WORKER_INDEX:-0}"

node "$STATE_CLI" "$WORKER" set branch "<branch-name>"
node "$STATE_CLI" "$WORKER" set ticket_url "<url>"
```
