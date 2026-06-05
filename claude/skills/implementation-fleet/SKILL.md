---
name: implementation-fleet
description: Fleet-safe variant of /implementation. Implements a Linear ticket end-to-end — branches, writes code, writes tests, runs /check, fixes findings, commits, opens a PR. On 3 consecutive failed /check passes, writes FAILED to the worker state file and exits instead of prompting the user.
---

# Implementation (Fleet)

Fleet-safe variant of `/implementation`. **Never calls `AskUserQuestion`.** Designed for headless Docker workers where no user is at the terminal.

Programmatic. **Auto-commits and opens a PR** — this is the documented exception to the user's usual "I handle my own commits" rule, scoped to the `/muaddib` workflow only. Do not apply this exception outside `/muaddib`-style automation.

## Step 1 — Load the ticket plan

Call `mcp__linear__get_issue` with the ID from `$ARGUMENTS`. Then call `mcp__linear__list_comments` for the same ticket and find the most recent comment whose body starts with `## Plan`.

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

## Step 5 — Run `/check`

Call `Skill(check)` with no `args`. It runs the per-project `npm` checks and then `/review`.

## Step 6 — Fix findings, then re-check

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

## Step 7 — Commit

```
git add <specific files>
git commit -m "<imperative summary>

<one-paragraph body referencing the Linear ticket ID>

Co-Authored-By: Claude <noreply@anthropic.com>"
```

Stage files by name — never `git add -A` / `git add .`.

If a pre-commit hook fails, fix the underlying issue and create a **new** commit. Never `--amend` or `--no-verify`.

## Step 8 — Start preview servers and tunnels (fleet only)

Skip this step if `WORKER_INDEX` is not set.

The startup order matters: DB migrations must run before the API starts; the API tunnel URL must be known before the frontends start (so they can call the preview API, not prod).

```bash
# 1. Run DB migrations against the ephemeral dev DB
cd /home/worker/repo && npm run --prefix projects/api migrate:up

# 2. Start the API dev server in the background
nohup npm run api:dev > /tmp/preview-api.log 2>&1 &

# 3. Wait for the API to bind on port 8081 (up to 60 s)
for i in $(seq 1 60); do
    (echo > /dev/tcp/localhost/8081) 2>/dev/null && break
    sleep 1
done

# 4. Open a Cloudflare quick tunnel for the API and capture its URL
nohup cloudflared tunnel --url http://localhost:8081 --no-autoupdate \
    > /tmp/cf-api.log 2>&1 &
API_TUNNEL_URL=""
for i in $(seq 1 30); do
    API_TUNNEL_URL=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' \
        /tmp/cf-api.log 2>/dev/null | head -1 || true)
    [ -n "$API_TUNNEL_URL" ] && break
    sleep 1
done

# 5. Start portal then homeowner with the API tunnel URL so their API calls
#    reach the containerized API rather than the prod endpoint.
#    Portal binds to 5173 first; homeowner auto-increments to 5174.
VITE_API_URL="$API_TUNNEL_URL" nohup npm run portal:dev \
    > /tmp/preview-portal.log 2>&1 &
VITE_API_URL="$API_TUNNEL_URL" nohup npm run homeowner:dev \
    > /tmp/preview-homeowner.log 2>&1 &

# 6. Wait for both Vite servers to bind
for i in $(seq 1 60); do
    (echo > /dev/tcp/localhost/5173) 2>/dev/null && \
    (echo > /dev/tcp/localhost/5174) 2>/dev/null && break
    sleep 1
done

# 7. Open tunnels for portal and homeowner
nohup cloudflared tunnel --url http://localhost:5173 --no-autoupdate \
    > /tmp/cf-portal.log 2>&1 &
nohup cloudflared tunnel --url http://localhost:5174 --no-autoupdate \
    > /tmp/cf-homeowner.log 2>&1 &

# 8. Capture all three tunnel URLs (wait up to 30 s each)
PORTAL_URL=""
HO_URL=""
for i in $(seq 1 30); do
    PORTAL_URL=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' \
        /tmp/cf-portal.log 2>/dev/null | head -1 || true)
    HO_URL=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' \
        /tmp/cf-homeowner.log 2>/dev/null | head -1 || true)
    [ -n "$PORTAL_URL" ] && [ -n "$HO_URL" ] && break
    sleep 1
done
```

If any URL is still empty after the wait, proceed and mark that service as "unavailable" in the PR body.

## Step 9 — Push and open PR

```
git push -u origin <branch>
gh pr create --base main --title "<short title>" --body "$(cat <<'EOF'
## Summary
- <1–3 bullets>

## Linear
<ticket URL>

## Preview
| Service | URL |
|---------|-----|
| API | <$API_URL or "unavailable"> |
| Portal | <$PORTAL_URL or "unavailable"> |
| Homeowner | <$HO_URL or "unavailable"> |

_Preview runs in a sandboxed Docker worker. Tear down with `./muaddib/teardown-worker.sh <N>`._

## Test plan
- [ ] ...

## Review notes
<any deferred /check findings, or "None">

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

PR title ≤ 70 characters. Detail belongs in the body.

## Step 9 — Update the ticket

Post a comment on the Linear ticket via `mcp__linear__save_comment`:

```
PR opened: <pr-url>
Branch: <branch-name>
```

Print the PR URL to the user as the final line of output.
