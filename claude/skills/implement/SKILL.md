---
name: implement
description: Fleet implementation step. Writes code, tests, and a preview seed script for a Linear ticket. Initial implementation only — never commits.
---

# Implement

Fleet implementation step. Never commits.

**If a blocking question arises mid-implementation** and cannot be resolved by reading the codebase: post to Linear as a `@mention` comment, fire a macOS notify via the event bus, then call `AskUserQuestion`. Do not block silently.

`$ARGUMENTS` is the Linear ticket identifier. `STATE_BRANCH` is already checked out.

## Step 1 — Load plan context

Read `.muaddib/plan.md` in the repo root — this is the authoritative plan written by `analyze-ticket` / `ask-questions`; in the fleet flow it is written before this step, so it is normally present. If that file does not exist, re-hydrate it from the ticket's `## Plan` comment (own or parent) via the comment-aware fetch script, then read it:

```bash
MUADDIB_ROOT="${REPO_DIR:-/home/worker/repo}"
if [ -d "$MUADDIB_ROOT/muaddib" ]; then MUADDIB_ROOT="$MUADDIB_ROOT/muaddib"; fi
node "$MUADDIB_ROOT/scripts/fetch-ticket.js"   # re-writes .muaddib/plan.md from the ## Plan comment; source-neutral, no-op on raw
```

If `.muaddib/plan.md` is still absent (no `## Plan` comment exists, or a raw ticket with no comment thread), fall back to the ticket itself and work from its description as context:

```bash
MUADDIB_ROOT="${REPO_DIR:-/home/worker/repo}"
if [ -d "$MUADDIB_ROOT/muaddib" ]; then MUADDIB_ROOT="$MUADDIB_ROOT/muaddib"; fi
TICKET_CLI="$MUADDIB_ROOT/orchestrator/ticket-cli.js"
node "$TICKET_CLI" fetch "$ARGUMENTS"   # prints the ticket JSON (title, description, url, labels)
```

If `.muaddib/sketch/` contains an HTML prototype, a `sketch` step already ran in this container and the operator gave feedback on it — treat that prototype as the authoritative visual/structural reference for the UI, alongside the plan.

More commonly, `sketch` ran during an earlier **planning** run (`plan.json`, a different worker/container), so nothing is on disk here. A `## Sketch` prototype from that run lives in a ticket comment, which `fetch` does not return; if no prototype is on disk under `.muaddib/sketch/`, proceed from the plan and ticket description without it.

If `.muaddib/context.md` exists, read it too — the `gather-context` step aggregates the project's declared sources of truth (task manager, decision log, process docs) into it during planning, so it carries prior decisions and constraints the plan assumes. It may be absent (no `contextSources` configured, or nothing gathered); proceed without it when so.

Read `CLAUDE.md` (root and per-project for the affected area). Read neighboring files in the plan's touched directories to match existing patterns.

## Step 2 — Implement

Work through the plan's work streams in dependency order. For each stream: read the relevant files, make changes, write tests inline. Do not expand scope beyond the plan. If the plan turns out to be wrong or incomplete, write BLOCKED state and stop rather than improvising:

```bash
printf 'BLOCKED %s\n' "$(date -u +%FT%TZ)" > "/var/run/agent-status/worker-${WORKER_INDEX:-0}.state" 2>/dev/null || true
```

Do not commit.

## Step 3 — Write tests

For every new or changed code path, write a dedicated test. Follow project conventions (from CLAUDE.md):
- API service edits → unit tests (`npm run test:unit`)
- API database edits → integration tests (`npm run test:integration`)
- Portal / homeowner logic → component or hook tests

Fold tests into the same step as the code they cover — not a separate phase.

## Step 4 — Write preview seed script

First resolve the worker suffix — do not guess or default to 0:

```bash
echo "WORKER_SUFFIX=${WORKER_INDEX:-0}"
```

Write the seed file at exactly `projects/api/scripts/seed-preview-w<resolved-suffix>.ts` (e.g. `seed-preview-w1.ts` when WORKER_INDEX=1). Must be idempotent — safe to run on every preview startup.

The script must:

1. Initialize firebase-admin using the dev service account. Check `projects/api/src/config/` for how the dev SA key file is loaded — match that pattern exactly.

2. Create or update a preview contractor user in Firebase:
   - Email: `preview-w${process.env.WORKER_INDEX || '0'}@quotethat.local`
   - Password: generate once at the top with `require('crypto').randomBytes(6).toString('hex')` and reuse.
   - On `auth/email-already-exists`: look up by email, then call `updateUser(uid, { password })`.

3. Upsert a matching contractor record in the DB (use the `db` instance; match existing contractor upsert patterns).

4. Seed minimal fixture data to exercise the feature's acceptance criteria. Derive from the plan — seed only what a reviewer needs to observe the feature working.

5. If the feature involves the homeowner app: seed a homeowner project and generate its magic-link token.

6. Print to stdout as the **last line**:
   ```json
   {"email":"...","password":"...","homeowner_magic_link":"<url-or-null>"}
   ```
   Write errors to stderr and exit 1 on failure.

## Step 5 — Signal done

```bash
touch "$STEP_DONE_FILE"
```

> ⚠️ **This `touch` must be your literal last tool call — actually run it, don't just state that the step is done.** The orchestrator detects completion only when this file appears on disk; a closing summary sentence does not create it. Narrating completion without running the command leaves the step hanging until it is force-nudged.
