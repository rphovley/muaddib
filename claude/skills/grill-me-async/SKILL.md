---
name: grill-me-async
description: Fleet-safe variant of /grill-me. Posts clarifying questions to the Linear ticket as a @mention comment (notifying the operator via Linear's email/in-app notification), writes WAITING_FOR_INPUT state, then returns an empty transcript so the pipeline continues non-blocked. Invoked by /prepare-feast when ambiguity is detected.
---

# Grill Me Async

Non-blocking variant of `/grill-me` for fleet workers. Posts questions to Linear so the operator is notified via Linear's own notification system, then yields — the pipeline continues with best available info.

**Install:** fleet workers load this from the merged skills directory built by `spawn-worker.sh` — no manual copy needed if using the standard fleet setup.

## Step 1 — Identify the highest-value gaps

Given the ticket context in `$ARGUMENTS`, identify the top 1–4 clarification questions that would **change the implementation**. Apply the same judgment as `/grill-me` step 1 — only ask questions whose answers would alter the approach. Skip anything answerable by reading the codebase.

If you cannot identify any clarification worth asking (the ticket is already concrete), write nothing to Linear, skip directly to Step 5, and return an empty transcript.

## Step 2 — Read worker identity from env

Run via Bash tool:

```bash
echo "WORKER_INDEX=${WORKER_INDEX:-} BRANCH=${BRANCH:-} LINEAR_USER_HANDLE=${LINEAR_USER_HANDLE:-}"
```

Capture `WORKER_INDEX`, `BRANCH`, and `LINEAR_USER_HANDLE`. Extract the ticket identifier from `$ARGUMENTS` (e.g. `QUO-274`).

## Step 3 — Build the comment

Compose the comment body using this exact format:

```
@<LINEAR_USER_HANDLE> — a fleet worker needs clarification before planning:

**Q:** <question 1>
**Options:** <option A> / <option B> / ...

**Q:** <question 2>
**Options:** <option A> / <option B> / ...

Worker will continue with best available info. To re-run with your answers incorporated, update the ticket description and run `/muaddib <ticket-id>`.

Worker: w<WORKER_INDEX> | Branch: <BRANCH>
```

Rules:
- If `LINEAR_USER_HANDLE` is set: include the `@<handle> —` prefix on the first line. Do **not** crash if it is unset — omit the prefix and start directly with `a fleet worker needs clarification before planning:`.
- List 2–4 distinct options per question on the **Options** line, separated by ` / `.
- `<ticket-id>` is the Linear identifier from `$ARGUMENTS` (e.g. `QUO-274`).
- `<WORKER_INDEX>` and `<BRANCH>` come from env (Step 2). Use `unknown` if either is empty.

## Step 4 — Post the comment and write state

Run both actions:

**Post to Linear** via `mcp__linear__save_comment`:
- `issueId`: the ticket identifier from `$ARGUMENTS`
- `body`: the comment composed in Step 3

**Write WAITING_FOR_INPUT state** via Bash tool:

```bash
printf 'WAITING_FOR_INPUT %s\n' "$(date -u +%FT%TZ)" > /var/run/agent-status/worker-${WORKER_INDEX}.state
```

If the state file write fails (e.g. path does not exist — running outside a worker container), continue without error.

## Step 5 — Return empty transcript

Return an empty string. The caller (`/prepare-feast`) sees an empty transcript and continues the pipeline without blocking — `/wash-hands` proceeds with the ticket as-is.
