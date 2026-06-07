---
name: commit-and-pr
description: Fleet wrapup step. Commits implementation changes, pushes the branch, opens a GitHub PR with preview URLs from state, writes pr_number to worker state and the webhook sentinel file, then posts a comment on the Linear ticket.
---

# Commit and PR

Fleet-safe wrapup step. **Never calls `AskUserQuestion`.**

`$ARGUMENTS` is the Linear ticket identifier. The runner injects these STATE_* env vars from worker state:
- `STATE_BRANCH` — the feature branch name
- `STATE_TICKET_URL` — the Linear ticket URL
- `STATE_API_TUNNEL_URL`, `STATE_PORTAL_URL`, `STATE_HO_URL` — preview tunnel URLs (empty in bug workflows)

## Step 1 — Verify branch

```bash
cd "${REPO_DIR:-/home/worker/repo}"
git status
git branch --show-current
```

If `git branch --show-current` does not match `$STATE_BRANCH`, write BLOCKED state and stop:

```bash
printf 'BLOCKED %s\n' "$(date -u +%FT%TZ)" > "/var/run/agent-status/worker-${WORKER_INDEX:-0}.state" 2>/dev/null || true
```

## Step 2 — Refresh preview credentials

Run the seed script to get credentials that reflect the current implementation:

```bash
REPO="${REPO_DIR:-/home/worker/repo}"
SEED_JSON=$(cd "$REPO" && \
    npx --prefix projects/api tsx projects/api/scripts/seed-preview.ts 2>/dev/null | tail -1 \
    || echo '{"email":"(unavailable)","password":"","homeowner_magic_link":null}')
PREVIEW_EMAIL=$(printf '%s' "$SEED_JSON" | jq -r '.email // "(unavailable)"')
PREVIEW_PASSWORD=$(printf '%s' "$SEED_JSON" | jq -r '.password // ""')
HO_MAGIC_LINK=$(printf '%s' "$SEED_JSON" | jq -r '.homeowner_magic_link // ""')
```

If `projects/api/scripts/seed-preview.ts` does not exist (bug workflow or not yet written), skip and leave all credential vars as `(unavailable)`.

## Step 3 — Commit

Stage specific files by name — never `git add -A` or `git add .`. Identify all changed files:

```bash
git diff --name-only main...HEAD
git ls-files --others --exclude-standard  # new untracked files
```

Stage each relevant file explicitly, then commit:

```bash
git add <file1> <file2> ...
git commit -m "<imperative summary ≤70 chars>

<one-paragraph body referencing the Linear ticket identifier>

Co-Authored-By: Claude <noreply@anthropic.com>"
```

If a pre-commit hook fails, fix the underlying issue and create a **new** commit. Never `--amend` or `--no-verify`.

## Step 4 — Push

```bash
git push -u origin "$STATE_BRANCH"
```

## Step 5 — Open PR

Use STATE_* vars for preview URLs; fall back to `(unavailable)` for any empty value.

```bash
REPO="${REPO_DIR:-/home/worker/repo}"
gh pr create --base main \
  --title "<imperative title ≤70 chars>" \
  --body "$(cat <<'PREOF'
## Summary
- <1–3 bullets>

## Linear
$STATE_TICKET_URL

## Preview
| Service | URL |
|---------|-----|
| API | ${STATE_API_TUNNEL_URL:-(unavailable)} |
| Portal | ${STATE_PORTAL_URL:-(unavailable)} |
| Homeowner | ${STATE_HO_URL:-(unavailable)} |

## Preview credentials
| Role | Login |
|------|-------|
| Contractor (Portal) | **$PREVIEW_EMAIL** / $PREVIEW_PASSWORD |
| Homeowner | ${STATE_HO_URL}${HO_MAGIC_LINK} _(magic-link — open directly)_ |

_Preview runs in a sandboxed Docker worker. Tear down with \`./muaddib/bin/teardown-worker.sh <N>\`._
_Leave feedback on the PR — the agent is watching and will address it._

## Test plan
- [ ] ...

## Review notes
<any deferred findings from the quality loop, or "None">

🤖 Generated with [Claude Code](https://claude.com/claude-code)
PREOF
)"
```

## Step 6 — Write pr_number to state and signal webhook job

```bash
PR_NUMBER=$(gh pr view --json number --jq '.number')
WORKER="${WORKER_INDEX:-0}"
STATE_CLI="${REPO_DIR:-/home/worker/repo}/muaddib/orchestrator/state-cli.js"

node "$STATE_CLI" "$WORKER" set pr_number "$PR_NUMBER"
printf '%s\n' "$PR_NUMBER" > "/tmp/pr-number-${WORKER}"
```

The webhook job (`watch-feedback.sh`) polls `/tmp/pr-number-${WORKER}` and registers the GitHub webhook once this file appears. Write it immediately after the PR is created.

## Step 7 — Post Linear comment

Call `mcp__linear__save_comment` on the ticket from `$ARGUMENTS` with:

```
PR opened: <pr-url>
Branch: $STATE_BRANCH
Preview: ${STATE_PORTAL_URL:-(unavailable)} (Portal) · ${STATE_HO_URL:-(unavailable)} (Homeowner)
Feedback: comment on the PR with /feedback — the agent is watching.
```

## Step 8 — Signal done

```bash
touch "$STEP_DONE_FILE"
```
