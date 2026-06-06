---
name: muaddib
description: Fleet end-to-end automation for a Linear ticket — discovery, plan, implementation, and PR. Autonomous pipeline; never calls AskUserQuestion; never pauses between steps. Runs in headless Docker workers launched by muaddib.sh. Control flow lives in ~/.claude/skills/muaddib/orchestrate.sh (fleet-specific). Sub-skills (/prepare-feast, /implementation-fleet) do the LLM work.
---

# Muaddib (Fleet)

**Autonomous pipeline**: run all steps in a single continuous pass. Do not pause between steps, narrate progress, or produce any intermediate output. Call the next tool immediately after the previous one completes without ending the turn. Only produce user-facing output when the entire flow finishes (Step 5 summary) or when a `FAILED`/`BLOCKED` condition is reached.

**Never calls `AskUserQuestion`.** Designed for headless Docker workers where no user is at the terminal.

Control flow is owned by `~/.claude/skills/muaddib/orchestrate.sh` (fleet-specific — emits `implementation-fleet`, not `implementation`; includes `NO_PAUSE` directives). Read each directive the script emits (`PARSED_TICKET:`, `NO_PAUSE:`, `INVOKE_SKILL:`, `TRACK:`, `THEN_RUN:`) and execute them immediately. Do not improvise the flow.

If the script exits non-zero at any step, write `FAILED` to the worker state file and stop:

```bash
printf 'FAILED %s\n' "$(date -u +%FT%TZ)" > "/var/run/agent-status/worker-${WORKER_INDEX}.state" 2>/dev/null || true
```

## Step 1 — Parse the Linear reference

```
bash ~/.claude/skills/muaddib/orchestrate.sh parse "$ARGUMENTS"
```

Read the `PARSED_TICKET:` line for the ticket ID. → Proceed immediately to Step 2 — do not end the turn.

## Step 2 — Run /prepare-feast

Per the `INVOKE_SKILL:` directive from Step 1, call `Skill(prepare-feast)` with the parsed ticket ID as `args`.

It returns **only a bare JSON array** of ticket IDs (e.g. `["QUO-281"]`). Capture this array verbatim. → Proceed immediately to Step 3 — do not end the turn.

## Step 3 — Queue

```
bash ~/.claude/skills/muaddib/orchestrate.sh queue '<json-array-from-step-2>'
```

The script validates each ID then emits:
- `TRACK:` — create one tracking task per ticket using your task-tracking tool.
- `NO_PAUSE:` — do not end the turn; run all INVOKE_SKILL lines in sequence immediately.
- One `INVOKE_SKILL: implementation-fleet <id>` line per ticket, in order.

→ Proceed immediately to Step 4.

## Step 4 — Run /implementation-fleet per ticket

Execute the `INVOKE_SKILL: implementation-fleet <id>` lines **sequentially**. For each:
1. Call `Skill(implementation-fleet)` with the ID as `args`.
2. Mark the matching tracking task complete.
3. Collect: `{"ticket": "<id>", "pr": "<url-or-null>", "status": "opened|failed|skipped"}`.
4. → Proceed to the next ticket immediately without ending the turn.

If an implementation writes `FAILED` to the state file, record `status: "failed"` and stop the loop. Do not continue to remaining tickets.

## Step 5 — Summary

```
bash ~/.claude/skills/muaddib/orchestrate.sh summary '<json-array-of-results>'
```

Print the script's output verbatim as your final message.
