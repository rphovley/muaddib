---
name: implementation-fleet
description: Fleet-safe variant of /implementation. Implements a Linear ticket end-to-end — branches, writes code, writes tests, runs /check, fixes findings, commits, opens a PR. On 3 consecutive failed /check passes, writes FAILED to the worker state file and exits instead of prompting the user.
---

# Implementation (Fleet)

Fleet-safe variant of `/implementation`. **Never calls `AskUserQuestion`.** Designed for headless Docker workers where no user is at the terminal.

Programmatic. **Auto-commits and opens a PR** — this is the documented exception to the user's usual "I handle my own commits" rule, scoped to the `/muaddib` workflow only. Do not apply this exception outside `/muaddib`-style automation.

## Step 1 — Load the ticket plan

Call `mcp__linear__get_issue` with the ID from `$ARGUMENTS`. Capture:
- `id` (UUID), `identifier`, `title`, `url`
- `teamId` (UUID)

Then call `mcp__linear__list_comments` for the same ticket and find the most recent comment whose body starts with `## Plan`.

If no plan comment exists, stop and tell the user to run `/prepare-feast <ticket-id>` first. Do not improvise a plan.

If the plan exists but is on the *parent* ticket (this is a sub-ticket created by `/prepare-feast`), use the parent's plan filtered to this work stream — the sub-ticket description should already contain that filtered portion.

## Step 2 — Branch from `main`

```
git checkout main
git pull
git checkout -b <ticket-identifier-lowercased>-<short-slug>
```

`<short-slug>` is 2–4 kebab-case words drawn from the ticket title. Example branch: `quo-281-grilled-section`.

If the working tree has uncommitted changes, stop and surface them — do not stash or discard.

## Step 3 — Implement

Work the plan's work streams **in dependency order**. For each one:

1. Read the relevant `CLAUDE.md` files (root + per-project).
2. Read neighboring files in the affected directory to match existing patterns.
3. Make the changes.

Do not expand scope beyond the plan. If the plan turns out to be wrong, write `BLOCKED` to the worker state file (see Step 6 failure format) and stop.

## Step 4 — Write tests

For every new code path, write a dedicated test. Follow project conventions:
- API service edits → unit tests
- API database edits → integration tests
- Portal logic → component or hook regression tests
- Use `npm run test:unit` / `npm run test:integration`, not raw `vitest`.

Fold tests into the same step as the code they cover — not a separate "tests" phase.

## Step 5 — Write preview seed script

Write `projects/api/scripts/seed-preview.ts`. This script creates login-ready test data so the PR reviewer can immediately exercise the feature without manual setup. It must be **idempotent** — safe to run on every preview startup.

The script must:

1. Initialize firebase-admin using the dev service account (read the API's Firebase config to find the key file path — check `projects/api/src/config/` for how the dev SA is loaded).

2. Create or update a preview contractor user in Firebase:
   - Email: `preview-w${process.env.WORKER_INDEX || '0'}@quotethat.local`
   - Password: `node -e "process.stdout.write(require('crypto').randomBytes(6).toString('hex'))"` — generate this once at the top of the script and reuse it
   - If `auth/email-already-exists`, look up the user by email and call `updateUser(uid, { password })` instead

3. Upsert a matching contractor record in the DB (use the `db` instance from `@/database/index.js`; look at existing contractor DB patterns for the upsert shape).

4. Seed minimal fixture data that an acceptance-criteria reviewer needs to exercise the feature — derive this from the plan's work streams and acceptance criteria. Only seed what is necessary.

5. If the feature involves the homeowner app and homeowner auth uses a magic-link token, seed a homeowner project and generate its token; output the full magic-link URL in the JSON.

6. Print to stdout as the **last line**:
   ```json
   {"email":"...","password":"...","homeowner_magic_link":"<url-or-null>"}
   ```
   Write errors to stderr and exit 1 on failure.

Add `seed-preview.ts` to the commit in Step 7.

## Step 6 — Run `/check`

Call `Skill(check)` with no `args`. It runs the per-project `npm` checks and then `/review`.

## Step 7 — Fix findings, then re-check

Triage `/check` output:

- **Blockers + majors** — fix every one.
- **Questions** — decide and act. Do not leave open.
- **Minors + nits** — fix if cheap; otherwise note in the PR body under "Review notes — deferred".

Re-run `Skill(check)`. Loop until clean **or** until **3 fix passes have run** — then:

```bash
printf 'FAILED %s\n' "$(date -u +%FT%TZ)" > "/var/run/agent-status/worker-${WORKER_INDEX}.state" 2>/dev/null || true
```

Stop immediately. Do not commit, push, or open a PR. The worker state signals `attend.sh` that this worker needs human attention.

If `WORKER_INDEX` is unset (non-fleet context), the write silently fails — that is expected.

## Step 8 — Commit

```
git add <specific files>
git commit -m "<imperative summary>

<one-paragraph body referencing the Linear ticket ID>

Co-Authored-By: Claude <noreply@anthropic.com>"
```

Stage files by name — never `git add -A` / `git add .`.

If a pre-commit hook fails, fix the underlying issue and create a **new** commit. Never `--amend` or `--no-verify`.

## Step 9 — Push and open PR

```bash
git push -u origin <branch>
```

If `WORKER_INDEX` is set, read preview URLs written by the servers job:

```bash
URLS_FILE="/tmp/preview-urls-${WORKER_INDEX}.env"
if [ -f "$URLS_FILE" ]; then
    # shellcheck source=/dev/null
    source "$URLS_FILE"
else
    API_TUNNEL_URL="(unavailable)"
    PORTAL_URL="(unavailable)"
    HO_URL="(unavailable)"
    PREVIEW_EMAIL="(unavailable)"
    PREVIEW_PASSWORD=""
    HO_MAGIC_LINK=""
fi
```

Open the PR:

```
gh pr create --base main --title "<short title>" --body "$(cat <<'EOF'
## Summary
- <1–3 bullets>

## Linear
<ticket URL>

## Preview
| Service | URL |
|---------|-----|
| API | <$API_TUNNEL_URL or "unavailable"> |
| Portal | <$PORTAL_URL or "unavailable"> |
| Homeowner | <$HO_URL or "unavailable"> |

## Preview credentials
| Role | Login |
|------|-------|
| Contractor (Portal) | **$PREVIEW_EMAIL** / `$PREVIEW_PASSWORD` |
| Homeowner | $HO_URL$HO_MAGIC_LINK _(magic-link — open directly)_ |

_Preview runs in a sandboxed Docker worker. Tear down with `./muaddib/teardown-worker.sh <N>`._
_Leave feedback on the PR — the agent is watching and will address it._

## Test plan
- [ ] ...

## Review notes
<any deferred /check findings, or "None">

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

PR title ≤ 70 characters. After the PR is created, capture the number and write it for the webhook job:

```bash
PR_NUMBER=$(gh pr view --json number --jq '.number')
```

If `WORKER_INDEX` is set:

```bash
printf '%s\n' "$PR_NUMBER" > "/tmp/pr-number-${WORKER_INDEX}"
```

## Step 10 — Update the Linear ticket

Post a comment on the ticket via `mcp__linear__save_comment`:

```
PR opened: <pr-url>
Branch: <branch-name>
Preview: <portal-url> (Portal) · <ho-url> (Homeowner)
Feedback: comment on the PR with /feedback — the agent is watching.
```

Print the PR URL as the final line of output.
