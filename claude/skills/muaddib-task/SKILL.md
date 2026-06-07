---
name: muaddib-task
description: Fleet-safe free-form task executor. Takes a task description and implements it end-to-end without a Linear ticket — reads CLAUDE.md, explores codebase, plans inline, implements, runs /check, commits, and opens a PR. Never calls AskUserQuestion in fleet context.
---

# Muaddib Task (Free-form)

Fleet-safe, no Linear ticket required. Takes a task description from `$ARGUMENTS` and implements it end-to-end. **Never calls `AskUserQuestion` in fleet context (`WORKER_INDEX` is set).** When a decision is ambiguous, make the most reasonable interpretation and document it in the PR body.

**Autonomous execution**: run all steps in a single continuous pass. Do not pause, narrate, or produce intermediate output between steps. Call the next tool immediately after the previous one completes. Only produce user-facing output as the final PR URL or when a `BLOCKED`/`FAILED` condition is reached.

Programmatic. **Auto-commits and opens a PR** — this is the documented exception to the user's usual "I handle my own commits" rule, scoped to fleet workers only.

## Step 0 — Collect task description (interactive only)

If `WORKER_INDEX` is set and `$ARGUMENTS` is empty, write `BLOCKED` to the state file and stop — a fleet worker must always be given a task.

If `WORKER_INDEX` is unset and `$ARGUMENTS` is empty, call `AskUserQuestion` to gather:

1. **Task** — what needs to be done (free-form description)
2. **Context / constraints** — any relevant background, scope limits, or things to avoid (optional)

Use the answers as the task description for all subsequent steps. If the user provides a task via `AskUserQuestion`, proceed — do not ask follow-up clarifying questions.

## Step 1 — Understand the task

Read the task from `$ARGUMENTS`. Then:

1. Read the root `CLAUDE.md` and any project-specific `CLAUDE.md` in the area the task touches.
2. Identify which project(s) under `projects/*` are affected.
3. If the task spans more than one directory or the affected area is unclear, spawn the `Explore` agent to locate the relevant files — do not grep the world inline.

## Step 2 — Plan (inline)

Produce a short plan without posting it anywhere:

- **Diagnosis** — what exactly needs to change and why
- **Files to touch** — concrete paths or globs
- **Work streams** — ordered list if there are dependencies, unordered if parallel
- **Test strategy** — what to write and how to verify
- **Acceptance criteria** — bulleted list of what "done" looks like

If the task is genuinely ambiguous in a way that would block safe implementation, write `BLOCKED` to the state file and stop:

```bash
printf 'BLOCKED %s\n' "$(date -u +%FT%TZ)" > "/var/run/agent-status/worker-${WORKER_INDEX}.state" 2>/dev/null || true
```

Otherwise proceed — document any interpretation choices in the PR body under "Decisions".

→ Proceed immediately to Step 3.

## Step 3 — Branch from `main`

```bash
git checkout main
git pull
git checkout -b task/<short-slug>
```

`<short-slug>` is 3–5 kebab-case words drawn from the task description. Example: `task/fix-auth-token-expiry`. If `WORKER_INDEX` is set, prefix with the worker number: `task/w<N>-fix-auth-token-expiry`.

If the working tree has uncommitted changes, stop and write `BLOCKED` to the state file — do not stash or discard.

## Step 4 — Implement

Work the plan's work streams in dependency order. For each:

1. Read neighboring files in the affected directory to match existing patterns.
2. Make the changes.
3. Write tests inline — do not defer tests to a later step.

Test conventions:
- API service edits → unit tests
- API database edits → integration tests
- Portal logic → component or hook regression tests
- Use `npm run test:unit` / `npm run test:integration`, not raw `vitest`.

Do not expand scope beyond the plan. If a discovery mid-implementation reveals the plan is wrong, write `BLOCKED` to the state file and stop — do not silently pivot.

→ Proceed immediately to Step 5.

## Step 5 — Write preview seed script

Write `projects/api/scripts/seed-preview.ts`. This script creates login-ready test data so the PR reviewer can exercise the feature without manual setup. It must be **idempotent**.

The script must:

1. Initialize firebase-admin using the dev service account (read the API's Firebase config to find the key file path).

2. Create or update a preview contractor user in Firebase:
   - Email: `preview-w${process.env.WORKER_INDEX || '0'}@quotethat.local`
   - Password: generate once with `require('crypto').randomBytes(6).toString('hex')`
   - If `auth/email-already-exists`, look up the UID and call `updateUser(uid, { password })`

3. Upsert a matching contractor record in the DB.

4. Seed minimal fixture data needed to exercise the feature — derive from the plan's acceptance criteria.

5. If the feature involves the homeowner app, seed a homeowner project and generate its magic-link URL.

6. Print to stdout as the **last line**:
   ```json
   {"email":"...","password":"...","homeowner_magic_link":"<url-or-null>"}
   ```

Add `seed-preview.ts` to the commit in Step 6.

## Step 6 — Run `/check`

Call `Skill(check)` with no `args`.

## Step 7 — Fix findings, then re-check

Triage output:

- **Blockers + majors** — fix every one.
- **Questions** — decide and act. Do not leave open.
- **Minors + nits** — fix if cheap; otherwise note in the PR body under "Review notes — deferred".

Re-run `Skill(check)`. Loop until clean **or** until **3 fix passes have run** — then write `FAILED` and stop:

```bash
printf 'FAILED %s\n' "$(date -u +%FT%TZ)" > "/var/run/agent-status/worker-${WORKER_INDEX}.state" 2>/dev/null || true
```

Do not commit, push, or open a PR on failure. If `WORKER_INDEX` is unset (non-fleet context), the write silently fails — that is expected.

→ Proceed immediately to Step 8.

## Step 8 — Commit

```bash
git add <specific files>
git commit -m "<imperative summary>

<one-paragraph body describing what changed and why>

Co-Authored-By: Claude <noreply@anthropic.com>"
```

Stage files by name — never `git add -A` / `git add .`.

If a pre-commit hook fails, fix the underlying issue and create a **new** commit. Never `--amend` or `--no-verify`.

## Step 9 — Start preview servers and tunnels (fleet only)

Skip this step if `WORKER_INDEX` is not set.

```bash
# 1. Run DB migrations
cd /home/worker/repo && npm run --prefix projects/api migrate:up

# 2. Run preview seed — capture credentials
SEED_JSON=$(cd /home/worker/repo && npx --prefix projects/api tsx \
    projects/api/scripts/seed-preview.ts 2>/tmp/seed-preview.log \
    | tail -1 \
    || echo '{"email":"(seed failed — see /tmp/seed-preview.log)","password":"","homeowner_magic_link":null}')
PREVIEW_EMAIL=$(printf '%s' "$SEED_JSON"    | jq -r '.email // "(unknown)"')
PREVIEW_PASSWORD=$(printf '%s' "$SEED_JSON" | jq -r '.password // "(unknown)"')
HO_MAGIC_LINK=$(printf '%s' "$SEED_JSON"   | jq -r '.homeowner_magic_link // ""')

# 3. Start API dev server
nohup npm run api:dev > /tmp/preview-api.log 2>&1 &
for i in $(seq 1 60); do (echo > /dev/tcp/localhost/8081) 2>/dev/null && break; sleep 1; done

# 4. API tunnel
nohup cloudflared tunnel --url http://localhost:8081 --no-autoupdate --protocol http2 > /tmp/cf-api.log 2>&1 &
API_TUNNEL_URL=""
for i in $(seq 1 30); do
    API_TUNNEL_URL=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' /tmp/cf-api.log 2>/dev/null | head -1 || true)
    [ -n "$API_TUNNEL_URL" ] && break; sleep 1
done

# 5. Start frontends
VITE_API_URL="$API_TUNNEL_URL" nohup npm run portal:dev > /tmp/preview-portal.log 2>&1 &
VITE_API_URL="$API_TUNNEL_URL" nohup npm run homeowner:dev > /tmp/preview-homeowner.log 2>&1 &
for i in $(seq 1 60); do
    (echo > /dev/tcp/localhost/5173) 2>/dev/null && (echo > /dev/tcp/localhost/5174) 2>/dev/null && break
    sleep 1
done

# 6. Frontend tunnels
nohup cloudflared tunnel --url http://localhost:5173 --no-autoupdate --protocol http2 > /tmp/cf-portal.log 2>&1 &
nohup cloudflared tunnel --url http://localhost:5174 --no-autoupdate --protocol http2 > /tmp/cf-homeowner.log 2>&1 &
PORTAL_URL=""; HO_URL=""
for i in $(seq 1 30); do
    PORTAL_URL=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' /tmp/cf-portal.log 2>/dev/null | head -1 || true)
    HO_URL=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' /tmp/cf-homeowner.log 2>/dev/null | head -1 || true)
    [ -n "$PORTAL_URL" ] && [ -n "$HO_URL" ] && break; sleep 1
done
```

## Step 10 — Push and open PR

```bash
git push -u origin <branch>
gh pr create --base main --title "<short title>" --body "$(cat <<'EOF'
## Summary
- <1–3 bullets>

## Task
<verbatim task description from $ARGUMENTS>

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

_Preview runs in a sandboxed Docker worker. Tear down with `./muaddib/bin/teardown-worker.sh <N>`._

## Decisions
<any interpretation choices made in Step 2, or "None">

## Test plan
- [ ] ...

## Review notes
<any deferred /check findings, or "None">

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

PR title ≤ 70 characters. Capture the PR number:
```bash
PR_NUMBER=$(gh pr view --json number --jq '.number')
```

Print the PR URL as the final line of output.

## Step 11 — Enter FEEDBACK mode (fleet only)

Skip if `WORKER_INDEX` is not set. Skip if `WORKER_INDEX` is set but the task has no associated Linear ticket (the feedback loop requires a Linear ticket for comment routing; leave a note in the PR body that feedback should be left as PR comments and the reviewer should re-run `/muaddib-task` manually).

```bash
printf 'FEEDBACK %s\n' "$(date -u +%FT%TZ)" \
    > "/var/run/agent-status/worker-${WORKER_INDEX}.state" 2>/dev/null || true

PR_NUMBER="$PR_NUMBER" \
LINEAR_ISSUE_ID="<issue UUID if known>" \
LINEAR_ISSUE_IDENTIFIER="<identifier if known>" \
LINEAR_TEAM_ID="<teamId if known>" \
nohup /home/worker/repo/muaddib/watch-feedback.sh \
    > /tmp/feedback-watcher.log 2>&1 &
```
