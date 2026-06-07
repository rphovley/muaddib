---
name: implement
description: Fleet implementation step. Writes code, tests, and a preview seed script for a Linear ticket. Used for both the initial pass and subsequent fix passes after review. Never commits — commit and PR are the wrapup step's job.
---

# Implement

Fleet implementation step. Never commits.

**If a blocking question arises mid-implementation** and cannot be resolved by reading the codebase: post to Linear as a `@mention` comment, fire a macOS notify via the event bus, then call `AskUserQuestion`. Do not block silently.

`$ARGUMENTS` is the Linear ticket identifier. `STATE_BRANCH` is already checked out.

There are three modes — check which applies before doing anything else:

- **Check fix pass**: `STATE_CHECK_STATUS === 'fail'` and `STATE_CHECK_OUTPUT` is non-empty → fix failing tests/checks only. Skip Steps 1 and 4 entirely.
- **Review fix pass**: `STATE_REVIEW_FINDINGS` is non-empty → fix review findings only. Skip Steps 1 and 4 entirely.
- **Initial pass**: neither of the above → implement from scratch.

## Step 1 — Load plan context (initial pass only)

Skip this step on a check fix pass or review fix pass.

Read `.muaddib/plan.md` in the repo root — this is the authoritative plan written by `analyze-ticket` / `ask-questions`. If that file does not exist, fall back to finding the `## Plan` comment via `mcp__linear__get_issue` on `$ARGUMENTS` (or its parent).

Read `CLAUDE.md` (root and per-project for the affected area). Read neighboring files in the plan's touched directories to match existing patterns.

## Step 2 — Implement

**Check fix pass** (`STATE_CHECK_STATUS === 'fail'`, `STATE_CHECK_OUTPUT` is set):

The ticket scope is already implemented — do not re-read the plan or re-verify feature completeness. Read `$STATE_CHECK_OUTPUT` directly. It contains labeled sections of raw compiler/test output (`=== api:check ===`, etc.). Fix only the specific errors shown. Keep changes minimal — do not touch code unrelated to the failures.

**Review fix pass** (`STATE_REVIEW_FINDINGS` is set):

Read `$STATE_REVIEW_FINDINGS`. For each finding: make the targeted fix. Keep changes minimal — do not touch unrelated code or refactor while fixing.

**Initial pass** (neither of the above):

Work through the plan's work streams in dependency order. For each stream: read the relevant files, make changes, write tests inline. Do not expand scope beyond the plan. If the plan turns out to be wrong or incomplete, write BLOCKED state and stop rather than improvising:

```bash
printf 'BLOCKED %s\n' "$(date -u +%FT%TZ)" > "/var/run/agent-status/worker-${WORKER_INDEX:-0}.state" 2>/dev/null || true
```

In all modes: do not commit.

## Step 3 — Write tests

For every new or changed code path, write a dedicated test. Follow project conventions (from CLAUDE.md):
- API service edits → unit tests (`npm run test:unit`)
- API database edits → integration tests (`npm run test:integration`)
- Portal / homeowner logic → component or hook tests

Fold tests into the same step as the code they cover — not a separate phase.

## Step 4 — Write preview seed script (initial pass only)

Skip this step if `STATE_REVIEW_FINDINGS` is set.

Write `projects/api/scripts/seed-preview.ts`. Must be idempotent — safe to run on every preview startup.

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
