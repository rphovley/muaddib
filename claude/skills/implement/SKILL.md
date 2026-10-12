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

> **Augment the baseline — never fork a parallel account.** The worker-specific seed runs *on top of* the baseline (`seed-preview.ts`), which already seeds the standard preview contractor `preview@quotethat.com` and a rich dataset (dashboard leads, bids, and a full **My-leads** set across every status). Your script's job is to ADD the handful of feature-specific rows a reviewer needs **into that same baseline company**, so they see baseline data + your feature together on one login.
>
> Do **not** mint a new Firebase user + new company just to hang a few rows off of — that creates an isolated company the reviewer gets pointed at (because `commit-and-pr` advertises the worker seed's credentials over the baseline's), stranding all the baseline data on a login they never open. That is exactly the QUO-665 failure: a `preview-w10@quotethat.local` company with 4 leads was advertised while the baseline's 17-lead My-leads set sat unseen on `preview@quotethat.com`.

The script must:

1. Initialize firebase-admin using the dev service account. Check `projects/api/src/config/` for how the dev SA key file is loaded — match that pattern exactly.

2. **Resolve the baseline preview company** — look up the contractor whose email is `preview@quotethat.com` and use its `companyId`. Seed your feature-specific rows into THAT company. Only create a separate Firebase user + company when the feature itself is about a fresh/isolated account (e.g. new-company onboarding, multi-company isolation); if you do, say so in a comment at the top of the file.

3. Seed minimal fixture data to exercise the feature's acceptance criteria, into the baseline company resolved in step 2. Derive from the plan — seed only what a reviewer needs beyond what the baseline already provides. If the baseline already seeds equivalent data (e.g. My-leads rows), reuse it rather than duplicating; add only the specific scenario your feature introduces.

4. If the feature involves the homeowner app: seed a homeowner project and generate its magic-link token.

5. Print to stdout as the **last line**:
   ```json
   {"email":"...","password":"...","homeowner_magic_link":"<url-or-null>"}
   ```
   - Default case (seeded into the baseline company): emit the **baseline** credentials (`preview@quotethat.com` / its password) or empty `email`/`password` — do NOT override them. `commit-and-pr` only overrides the advertised login when you emit a non-empty `email`/`password`, so leaving them keeps the reviewer on the fully-seeded baseline login.
   - Isolated-account case only: emit the new user's `email`/`password`.
   - Set `homeowner_magic_link` when the feature mints one; otherwise null.
   - Write errors to stderr and exit 1 on failure.

## Step 5 — Signal done

```bash
touch "$STEP_DONE_FILE"
```

> ⚠️ **This `touch` must be your literal last tool call — actually run it, don't just state that the step is done.** The orchestrator detects completion only when this file appears on disk; a closing summary sentence does not create it. Narrating completion without running the command leaves the step hanging until it is force-nudged.
