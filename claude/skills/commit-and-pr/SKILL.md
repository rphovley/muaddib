---
name: commit-and-pr
description: Fleet wrapup step. Commits implementation changes, pushes the branch, opens a GitHub PR with preview URLs from state, writes pr_number to worker state and the webhook sentinel file, then posts a comment on the Linear ticket.
---

# Commit and PR

Fleet-safe wrapup step. **Never calls `AskUserQuestion`.**

`$ARGUMENTS` is the Linear ticket identifier. The runner injects these STATE\_\* env vars from worker state:

- `STATE_BRANCH` — the feature branch name
- `STATE_TICKET_URL` — the Linear ticket URL
- `STATE_API_TUNNEL_URL`, `STATE_PORTAL_URL`, `STATE_HOMEOWNER_URL` — preview tunnel URLs

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

First apply any pending migrations so the seed scripts see the current schema:

```bash
REPO="${REPO_DIR:-/home/worker/repo}"
(cd "$REPO/projects/api" && npm run migrate:up 2>&1) || true
```

Then run the **baseline** seed to get the standard preview contractor credentials:

```bash
BASELINE_SEED="$REPO/projects/api/scripts/seed-preview.ts"
SEED_JSON=$(cd "$REPO" && npx --prefix projects/api tsx "$BASELINE_SEED" 2>/dev/null | tail -1)
PREVIEW_EMAIL=$(printf '%s' "$SEED_JSON" | jq -r '.email // "(unavailable)"')
PREVIEW_PASSWORD=$(printf '%s' "$SEED_JSON" | jq -r '.password // ""')
HO_MAGIC_LINK=$(printf '%s' "$SEED_JSON" | jq -r '.homeowner_magic_link // ""')
```

If a **worker-specific** seed exists, run it on top to add feature-specific data or override credentials:

```bash
WORKER_SEED="$REPO/projects/api/scripts/seed-preview-w${WORKER_INDEX:-0}.ts"
if [ -f "$WORKER_SEED" ]; then
  W_JSON=$(cd "$REPO" && npx --prefix projects/api tsx "$WORKER_SEED" 2>/dev/null | tail -1)
  W_EMAIL=$(printf '%s' "$W_JSON" | jq -r '.email // ""')
  W_PASSWORD=$(printf '%s' "$W_JSON" | jq -r '.password // ""')
  W_HO_MAGIC_LINK=$(printf '%s' "$W_JSON" | jq -r '.homeowner_magic_link // ""')
  [ -n "$W_EMAIL" ]         && PREVIEW_EMAIL="$W_EMAIL"
  [ -n "$W_PASSWORD" ]      && PREVIEW_PASSWORD="$W_PASSWORD"
  [ -n "$W_HO_MAGIC_LINK" ] && HO_MAGIC_LINK="$W_HO_MAGIC_LINK"
fi
```

The worker's seed script is optional — if it doesn't exist the baseline credentials are used. Workers write `seed-preview-w<N>.ts` only when their feature needs extra data beyond what the baseline provides.

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

Normalize the preview URLs and credentials first, so neither a template nor the default ever prints a bare `$VAR` — empty values fall back to `(unavailable)`:

```bash
STATE_TICKET_URL="${STATE_TICKET_URL:-(none)}"
STATE_API_TUNNEL_URL="${STATE_API_TUNNEL_URL:-(unavailable)}"
STATE_PORTAL_URL="${STATE_PORTAL_URL:-(unavailable)}"
STATE_HOMEOWNER_URL="${STATE_HOMEOWNER_URL:-(unavailable)}"
PREVIEW_EMAIL="${PREVIEW_EMAIL:-(unavailable)}"
PREVIEW_PASSWORD="${PREVIEW_PASSWORD:-(unavailable)}"
# Portal preview URL — only append the query string when the URL is real,
# so an unavailable portal never renders "(unavailable)?is_preview=true".
if [ "$STATE_PORTAL_URL" != "(unavailable)" ]; then
  STATE_PORTAL_PREVIEW_URL="${STATE_PORTAL_URL}?is_preview=true"
else
  STATE_PORTAL_PREVIEW_URL="(unavailable)"
fi
```

Compute the homeowner credential — only combine the URL and magic-link when both are really present:

```bash
if [ "$STATE_HOMEOWNER_URL" != "(unavailable)" ] && [ -n "$HO_MAGIC_LINK" ]; then
  HO_CREDENTIAL="${STATE_HOMEOWNER_URL}${HO_MAGIC_LINK} _(magic-link — open directly)_"
else
  HO_CREDENTIAL="(unavailable)"
fi
```

**Project-overridable body.** muaddib ships a generic, source-neutral default (Summary / Ticket / Test plan / Review notes — no Preview or credentials sections, since those are quotethat-specific). A project overrides the whole body by committing `$REPO/.muaddib/pr-template.md`; when that file exists it becomes the PR body verbatim, with `$VAR` / `${VAR}` interpolated from the vars above (see the README "PR body template" section for the full variable list, and `pr-template.example.md` in this skill for quotethat's original sections). muaddib self-hosts with **no** override, so its own PRs use the default — no `## Linear`, no empty Preview tables.

The narrative sections you author — the Summary bullets, Test plan, and Review notes — are carried in their own vars (`PR_SUMMARY`, `PR_TEST_PLAN`, `PR_REVIEW_NOTES`), so **replace the placeholders below with the real content before building the body**. Both the default and a project template interpolate them, so neither ever ships a bare `<1–3 bullets>` placeholder.

```bash
REPO="${REPO_DIR:-/home/worker/repo}"
PR_TEMPLATE="$REPO/.muaddib/pr-template.md"

# Agent-authored narrative — fill these with the real PR content.
PR_SUMMARY="- <1–3 bullets>"
PR_TEST_PLAN="- [ ] ..."
PR_REVIEW_NOTES='<any deferred findings from the quality loop, or "None">'

export STATE_TICKET_URL STATE_API_TUNNEL_URL STATE_PORTAL_URL STATE_PORTAL_PREVIEW_URL \
       STATE_HOMEOWNER_URL PREVIEW_EMAIL PREVIEW_PASSWORD HO_MAGIC_LINK HO_CREDENTIAL \
       PR_SUMMARY PR_TEST_PLAN PR_REVIEW_NOTES

# Interpolate $VAR / ${VAR} from the environment — injection-safe, no shell eval.
# A leading HTML comment is stripped; an unknown $VAR is left literal (prose like
# a "$5" price survives); $$ escapes a literal $.
interpolate() {
  node -e 'const fs=require("fs");const src=process.argv[1]==="-"?fs.readFileSync(0,"utf8"):fs.readFileSync(process.argv[1],"utf8");process.stdout.write(src.replace(/^\s*<!--[\s\S]*?-->\s*/,"").replace(/\$\$|\$\{(\w+)\}|\$(\w+)/g,(m,a,b)=>m==="$$"?"$":(process.env[a||b]??m)))' "$1"
}

if [ -f "$PR_TEMPLATE" ]; then
  PR_BODY=$(interpolate "$PR_TEMPLATE")
else
  # Quoted heredoc — no shell expansion; interpolate fills the vars safely.
  PR_BODY=$(interpolate - <<'PREOF'
## Summary
$PR_SUMMARY

## Ticket
$STATE_TICKET_URL

## Test plan
$PR_TEST_PLAN

## Review notes
$PR_REVIEW_NOTES

🤖 Generated with [Claude Code](https://claude.com/claude-code)
PREOF
)
fi

gh pr create --base main \
  --title "<imperative title ≤70 chars>" \
  --body "$PR_BODY"
```

The Step 2 credential computation (`PREVIEW_EMAIL`, `PREVIEW_PASSWORD`, `HO_MAGIC_LINK`) is tolerant (`|| true`, `2>/dev/null`) and is consumed only by a project override that references those vars; the generic default never touches them.

## Step 6 — Write pr_number to state and signal webhook job

```bash
PR_NUMBER=$(gh pr view --json number --jq '.number')
WORKER="${WORKER_INDEX:-0}"
MUADDIB_ROOT="${REPO_DIR:-/home/worker/repo}"
if [ -d "$MUADDIB_ROOT/muaddib" ]; then MUADDIB_ROOT="$MUADDIB_ROOT/muaddib"; fi
STATE_CLI="$MUADDIB_ROOT/orchestrator/state-cli.js"

node "$STATE_CLI" "$WORKER" set pr_number "$PR_NUMBER"
printf '%s\n' "$PR_NUMBER" > "/tmp/pr-number-${WORKER}"
```

The webhook job (`watch-feedback.sh`) polls `/tmp/pr-number-${WORKER}` and registers the GitHub webhook once this file appears. Write it immediately after the PR is created.

## Step 7 — Post Linear comment

Skip this step entirely if `$STATE_TICKET_URL` is empty — there's no real ticket to post back to (e.g. a free-form task). Otherwise, post to the ticket from `$ARGUMENTS` via the source-neutral ticket CLI (works for whatever `TICKET_SOURCE` the project uses — Linear, GitHub, or a no-op for raw):

```bash
MUADDIB_ROOT="${REPO_DIR:-/home/worker/repo}"
if [ -d "$MUADDIB_ROOT/muaddib" ]; then MUADDIB_ROOT="$MUADDIB_ROOT/muaddib"; fi
TICKET_CLI="$MUADDIB_ROOT/orchestrator/ticket-cli.js"
node "$TICKET_CLI" post-comment "$ARGUMENTS" <<EOF
PR opened: <pr-url>
Branch: $STATE_BRANCH
Preview: ${STATE_PORTAL_URL:-(unavailable)} (Portal) · ${STATE_HOMEOWNER_URL:-(unavailable)} (Homeowner)
Feedback: comment on the PR with /feedback — the agent is in feedback mode.
EOF
```

## Step 8 — Signal done

```bash
touch "$STEP_DONE_FILE"
```

> ⚠️ **This `touch` must be your literal last tool call — actually run it, don't just state that the step is done.** The orchestrator detects completion only when this file appears on disk; a closing summary sentence does not create it. Narrating completion without running the command leaves the step hanging until it is force-nudged.
