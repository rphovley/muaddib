---
name: wash-hands-async
description: Fleet-safe variant of /wash-hands. Diagnoses a problem and produces a structured implementation plan. When no approach is clearly best, posts the options to Linear as a @mention comment and picks the strongest available approach rather than blocking. Returns a full plan regardless.
---

# Wash Hands Async

Fleet-safe variant of `/wash-hands`. **Never stops to wait for user input.** When an approach decision cannot be made with confidence, posts options to Linear and picks the strongest available approach to continue.

## Step 1 — Diagnose

Read the ticket context in `$ARGUMENTS`. State the *underlying problem* — not just the reported symptom — in one paragraph. Cover: what is broken/missing/needed, and why this is a problem now.

Use the codebase as evidence. Read `CLAUDE.md`. For broad searches, spawn the `Explore` agent — do not grep the world inline.

## Step 2 — Propose solution(s)

List each viable approach with:
- **Approach** — one sentence
- **Files / areas affected** — concrete paths
- **Trade-offs** — one or two lines (perf, complexity, blast radius)

**If one approach is clearly best:** mark it `**(chosen)**` and proceed to Step 3.

**If no approach is clearly best:** do not stop. Instead:

1. Read worker identity from env via Bash tool (source-neutral handle, falling back to `LINEAR_USER_HANDLE` so existing Linear deployments keep working):
   ```bash
   echo "WORKER_INDEX=${WORKER_INDEX:-} BRANCH=${BRANCH:-} HANDLE=${TICKET_USER_HANDLE:-${LINEAR_USER_HANDLE:-}}"
   ```
2. Extract the ticket identifier from `$ARGUMENTS` (e.g. `QUO-274`).
3. Post a comment via the source-neutral ticket CLI (correct for whatever `TICKET_SOURCE` the project uses — Linear, GitHub, or a no-op for raw). Build the `@mention` with the CLI, write the body to a temp file, then pipe it in on stdin:
   ```bash
   MUADDIB_ROOT="${REPO_DIR:-/home/worker/repo}"
   if [ -d "$MUADDIB_ROOT/muaddib" ]; then MUADDIB_ROOT="$MUADDIB_ROOT/muaddib"; fi
   TICKET_CLI="$MUADDIB_ROOT/orchestrator/ticket-cli.js"
   MENTION="$(node "$TICKET_CLI" mention "${TICKET_USER_HANDLE:-${LINEAR_USER_HANDLE:-}}")"
   # Compose the body below into this file, using "$MENTION —" as the first-line
   # prefix when non-empty (omit it entirely when empty — do not crash).
   node "$TICKET_CLI" post-comment "$ARGUMENTS" < "/tmp/washhands-comment-${WORKER_INDEX:-0}.md"
   ```
   Body format:
   ```
   <MENTION> — a fleet worker picked an approach but could not determine a clear winner:

   **Options considered:**
   - **Option A:** <approach> — <trade-offs>
   - **Option B:** <approach> — <trade-offs>
   ...

   **Proceeding with:** <chosen approach> (strongest available)

   To re-run with a different approach, update the ticket description to specify your preference and run `/muaddib <ticket-id>`.

   Worker: w<WORKER_INDEX> | Branch: <BRANCH>
   ```
   - If the handle is unset, `MENTION` is empty — omit the `<MENTION> —` prefix, don't crash.
   - Use `unknown` for `WORKER_INDEX` / `BRANCH` if either env var is empty.
4. Write `WAITING_FOR_INPUT` state via Bash tool:
   ```bash
   printf 'WAITING_FOR_INPUT %s\n' "$(date -u +%FT%TZ)" > "/var/run/agent-status/worker-${WORKER_INDEX}.state" 2>/dev/null || true
   ```
5. Mark the strongest approach `**(chosen)**` and proceed to Step 3.

## Step 3 — Break the chosen approach into work streams

A **work stream** is a unit of work that:
- Touches a coherent set of files
- Can be tested in isolation
- Has clear acceptance criteria
- Has well-defined dependencies (or none) on other streams

For each work stream:
- **Name** — short kebab-case-ish label
- **Files** — list of paths or globs
- **Test strategy** — unit / integration / regression / manual; what specifically is verified
- **Dependencies** — `none` or `stream-N`
- **Acceptance criteria** — bulleted list

## Step 4 — Set the split recommendation

Set `RECOMMEND_SPLIT: true` if **any** of:
- ≥ 3 work streams with no ordering dependencies between them
- ≥ 2 projects under `projects/*` are touched, each independently deliverable
- ≥ 5 total phases

Otherwise `RECOMMEND_SPLIT: false`.

This flag is read programmatically by `/prepare-feast` — keep it on its own line, exactly as shown.

## Step 5 — Return the plan

Return:

```
**Diagnosis:** <paragraph>

**Proposed solution:**
- <bullets, with **(chosen)** if multiple>

**Work streams:**
1. <name>
   - Files: <list>
   - Tests: <strategy>
   - Deps: <none|stream-N>
   - Acceptance:
     - ...
2. ...

RECOMMEND_SPLIT: <true|false>
```
