---
name: muaddib
description: Fleet-safe variant of /muadib. End-to-end automation for a Linear ticket — discovery, plan, implementation, and PR. Never calls AskUserQuestion. Use when running headless in a fleet worker (Docker container launched by muadib.sh). Control flow lives in ~/.claude/skills/muadib/orchestrate.sh; this skill follows the directives that script emits. Sub-skills (/prepare-feast, /implementation-fleet) do the LLM work.
---

# Muaddib (Fleet)

Fleet-safe variant of `/muadib`. **Never calls `AskUserQuestion`.** Designed for headless Docker workers where no user is at the terminal.

Control flow is owned by `~/.claude/skills/muadib/orchestrate.sh` (shared with the interactive `/muadib`). The script emits directives prefixed `PARSED_TICKET:`, `INVOKE_SKILL:`, `TRACK:`, `THEN_RUN:`. Read each subcommand's output and execute its directives literally. Do not improvise the flow.

If the script exits non-zero at any step, write `FAILED` to the worker state file and stop:

```bash
printf 'FAILED %s\n' "$(date -u +%FT%TZ)" > "/var/run/agent-status/worker-${WORKER_INDEX}.state" 2>/dev/null || true
```

## Step 1 — Parse the Linear reference

```
bash ~/.claude/skills/muadib/orchestrate.sh parse "$ARGUMENTS"
```

Read the `PARSED_TICKET:` line for the ticket ID. The `INVOKE_SKILL:` line is your next action.

## Step 2 — Run /prepare-feast

Per the directive from Step 1, call `Skill(prepare-feast)` with the parsed ticket ID as `args`.

It returns a JSON array of ticket IDs to implement (parent on its own, or sub-ticket IDs if planning chose to split). Capture this array verbatim.

`/prepare-feast` never blocks — if questions were detected, they were posted to Linear and the pipeline continues. Do not wait for answers.

## Step 3 — Queue

```
bash ~/.claude/skills/muadib/orchestrate.sh queue '<json-array-from-step-2>'
```

The script validates each ID, then emits:
- `TRACK:` — create one tracking task per ticket using your task-tracking tool.
- One `INVOKE_SKILL: implementation-fleet <id>` line per ticket, in order.

## Step 4 — Run /implementation-fleet per ticket

Execute the `INVOKE_SKILL: implementation-fleet <id>` lines **sequentially**, in the order emitted. For each, call `Skill(implementation-fleet)` with the ID as `args`. Mark the matching tracking task complete after each one finishes.

Collect a result object per ticket: `{"ticket": "<id>", "pr": "<url-or-null>", "status": "opened|failed|skipped"}`.

If an implementation writes `FAILED` to the state file and exits, record `status: "failed"` and stop the loop. Do not continue to remaining tickets.

## Step 5 — Summary

```
bash ~/.claude/skills/muadib/orchestrate.sh summary '<json-array-of-results>'
```

Print the script's output verbatim as your final message.
