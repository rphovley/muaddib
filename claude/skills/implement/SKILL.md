---
name: implement
description: Fleet implementation step. Writes code, tests, and a preview seed script for a Linear ticket. Used for both the initial pass and subsequent fix passes after review. Never commits — commit and PR are the wrapup step's job.
---

# Implement

Fleet-safe implementation step. **Never calls `AskUserQuestion`.** Never commits.

`$ARGUMENTS` is the Linear ticket identifier. `STATE_BRANCH` is already checked out by gather-context. If `STATE_REVIEW_FINDINGS` is non-empty this is a **fix pass** — address those findings instead of implementing from scratch.

## Step 1 — Load plan context

Call `mcp__linear__get_issue` with the identifier from `$ARGUMENTS`. Find the `## Plan` comment on this ticket or its parent (check the parent if `parentId` is set and no plan is on this ticket).

Read `CLAUDE.md` (root and per-project for the affected area). Read neighboring files in the plan's touched directories to match existing patterns.

## Step 2 — Implement

**Initial pass** (`STATE_REVIEW_FINDINGS` is empty or unset):

Work through the plan's work streams in dependency order. For each stream: read the relevant files, make changes, write tests inline. Do not expand scope beyond the plan. If the plan turns out to be wrong or incomplete, write BLOCKED state and stop rather than improvising:

```bash
printf 'BLOCKED %s\n' "$(date -u +%FT%TZ)" > "/var/run/agent-status/worker-${WORKER_INDEX:-0}.state" 2>/dev/null || true
```

**Fix pass** (`STATE_REVIEW_FINDINGS` is set):

Read `$STATE_REVIEW_FINDINGS`. For each finding: make the targeted fix. Keep changes minimal — do not touch unrelated code or refactor while fixing.

In both modes: do not commit.

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
