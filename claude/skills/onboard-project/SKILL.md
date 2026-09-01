---
name: onboard-project
description: Interactive wizard that onboards a new project onto muaddib. Inspects the target repo to infer what it can, asks the operator only where a human decision is genuinely required, generates the custom artifacts a project needs (hooks, compose overlay, worker-safe check command, PR-template override), then writes .muaddib/manifest.json + .muaddib/secrets.env and runs the manifest validator. Host-interactive — uses AskUserQuestion.
---

# Onboard a project onto muaddib

Walk the operator through everything a repo needs to run under muaddib. This is a
**host-interactive** wizard (launched by `muaddib-onboard.sh`), so `AskUserQuestion`
is expected and correct — the whole point is to gather the handful of decisions only
a human can make. Do **not** dispatch a fleet worker, commit, or open a PR.

Two ground rules the whole wizard follows:
- **Infer before you ask.** Inspect the repo (git remote, existing files, ports in
  use) and *propose* a value; only ask where the repo genuinely can't tell you.
- **Generate, don't instruct.** Where a project needs a hook, a compose overlay, a
  worker-safe check command, or a PR-template override, write the file yourself —
  don't hand the operator a to-do list.

The target repo path is in `$ARGUMENTS` (falls back to the current directory).
`$MUADDIB_DIR` (exported by the launcher) is the muaddib checkout — the validator,
example templates, and this skill live under it. The authoritative checklist this
wizard implements is `$MUADDIB_DIR/.muaddib/onboarding.md`; read it if you need the
full rationale for any item below.

## Step 1 — Locate the target repo and muaddib

```bash
TARGET="${ARGUMENTS:-$PWD}"
TARGET="$(cd "$TARGET" && pwd)"
# $MUADDIB_DIR is exported by muaddib-onboard.sh. Don't try to derive it from $0:
# inside a skill, $0 is the transient bash wrapper (e.g. /tmp/job-….sh), so
# dirname/../../.. resolves to garbage. If you're running this skill by hand,
# export MUADDIB_DIR (the muaddib checkout root) yourself before starting.
: "${MUADDIB_DIR:?export MUADDIB_DIR to the muaddib checkout root (normally set by muaddib-onboard.sh)}"
MUADDIB_DIR="$(cd "$MUADDIB_DIR" && pwd)"
echo "target=$TARGET"
echo "muaddib=$MUADDIB_DIR"
ls -la "$TARGET/.muaddib" 2>/dev/null || echo "(no .muaddib/ yet — fresh onboard)"
```

If `$TARGET/.muaddib/manifest.json` already exists, this is a **re-onboard**: read it
first and treat its values as the defaults you propose, so you refine rather than
overwrite the operator's prior choices.

## Step 2 — Verify account-level setup (never re-ask)

These are one-time-per-machine and owned by `install.sh`, not this wizard. Only
*check* them; point at the fix if missing.

```bash
CONDUCTOR="${CONDUCTOR_SECRETS_FILE:-$HOME/.muaddib/conductor-secrets.env}"
grep -q '^CLAUDE_CODE_OAUTH_TOKEN=.' "$CONDUCTOR" 2>/dev/null \
  && echo "✓ CLAUDE_CODE_OAUTH_TOKEN present" \
  || echo "✗ CLAUDE_CODE_OAUTH_TOKEN missing — run ./install.sh (or 'claude setup-token')"
grep -q '^SLACK_WEBHOOK_URL=.' "$CONDUCTOR" 2>/dev/null \
  && echo "✓ SLACK_WEBHOOK_URL present" \
  || echo "· SLACK_WEBHOOK_URL not set (optional — Slack alerts disabled; macOS notify still fires)"
for t in docker node gh claude jq; do command -v "$t" >/dev/null && echo "✓ $t" || echo "✗ $t missing"; done
```

If `CLAUDE_CODE_OAUTH_TOKEN` or a host tool is missing, tell the operator to run
`install.sh` and stop — onboarding can't finish without account-level bootstrap.
If only `SLACK_WEBHOOK_URL` is missing, offer (via `AskUserQuestion`) to record it in
the conductor-secrets file; skip silently if they decline.

## Step 3 — Infer project-level values, then confirm

Inspect the repo and build proposed values:

```bash
cd "$TARGET"
ORIGIN="$(git remote get-url origin 2>/dev/null || true)"
echo "origin=$ORIGIN"          # github.com/<owner>/<repo>(.git) → github source + owner/repo
basename "$(git rev-parse --show-toplevel 2>/dev/null || echo "$TARGET")"   # projectName candidate
```

- **projectName** — repo directory / git remote name.
- **ticketSource** — if `origin` is on `github.com`, propose `github` and parse
  `githubOwner`/`githubRepo` from it. Otherwise propose `linear` (a Linear workspace
  isn't detectable from the repo, so this one you must ask). Never write `raw` — it's
  a dispatch-time override, not a manifest value.
- **`workerPorts.{api,db,sketch}` + `dispatchPort`** — there's no baked default.
  Scan the host for a free, non-colliding range:

```bash
# Existing muaddib projects (account dirs) and any manifests you can find, so the
# proposed range doesn't overlap one already in use.
ls -1 "$HOME/.muaddib" 2>/dev/null | grep -v conductor-secrets || true
# Ports currently listening, to steer clear of them.
(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null || netstat -an 2>/dev/null | grep LISTEN) | awk '{print $NF}' | grep -oE '[0-9]+$' | sort -un | tail -20
```

Propose a coherent, non-overlapping block (e.g. `api:9089 db:6442 sketch:5386
dispatch:4999` shifted to a free range). Use `AskUserQuestion` to confirm the inferred
projectName, ticketSource (+owner/repo), and the port block in one pass — pre-filling
your proposals as the recommended options.

## Step 4 — Ask the genuine human decisions

Only things the repo can't answer. Batch into `AskUserQuestion` calls (≤4 options each):

1. **`model`** — default `claude-opus-4-8`; confirm or override.
2. **`retryThreshold`** — default `3`; confirm.
3. **`projects[]`** — for each buildable project in the repo: its `name`, `path`
   (relative to repo root), and `checkCommand` (lint/typecheck/test entry). Ask which
   projects run a preview server; those also need `devScript` / `seedScript` / `port`
   (`start-servers.js` keys API vs frontend off `seedScript` vs `devScript`).
4. **Credentials** — a human must mint these; you can't. State the exact scopes and
   where each goes, then collect the values (or let them paste later into
   `.muaddib/secrets.env`):
   - **`GITHUB_TOKEN`** (fine-grained PAT, this repo only) — scopes: Contents r/w,
     Issues r/w, Pull requests r/w, Webhooks r/w, Metadata ro. → `.muaddib/secrets.env`.
   - For Linear: **`LINEAR_API_KEY`**, **`LINEAR_TEAM_ID`**, user handle.
5. **Goal Context (`goals.md`)** — never blocking (`goals.js` bootstraps a generic
   template on first read). Offer a project-specific pass; skip if declined.

## Step 5 — Generate custom artifacts (only when the repo's shape needs it)

Inspect the repo and generate — don't describe — each only if warranted:

- **`.muaddib/hooks/on-worker-start.sh`** (chmod +x) — if the project needs per-start
  setup (materializing secrets into config files, etc.). Invoked by
  `worker-entrypoint.sh` when present + executable.
- **`.muaddib/docker/docker-compose.worker.yml`** overlay — if the project needs a DB
  sidecar or extra services (inspect the repo's compose / DB usage). Merged onto the
  base worker compose via `read-config.sh`'s `MUADDIB_COMPOSE_FILES`.
- **Worker-safe `checkCommand`** — if the repo's test entry wraps `docker run` (like
  muaddib's own `run_tests.sh` does when *not* self-hosting), generate a docker-free
  variant: a worker has no docker.sock.
- **`.muaddib/pr-template.md`** — only if the generic default doesn't fit. Seed from
  `$MUADDIB_DIR/claude/skills/commit-and-pr/pr-template.example.md`.

## Step 6 — Write manifest + secrets

Write `$TARGET/.muaddib/manifest.json` from the confirmed values. Shape (omit keys
that don't apply, e.g. github fields for a Linear project):

```json
{
  "projectName": "...",
  "dispatchPort": 4999,
  "model": "claude-opus-4-8",
  "ticketSource": "github",
  "githubOwner": "...",
  "githubRepo": "...",
  "retryThreshold": 3,
  "workerPorts": { "api": 9089, "db": 6442, "sketch": 5386 },
  "projects": [
    { "name": "...", "path": ".", "checkCommand": "..." }
  ]
}
```

Write secrets by **upsert** (never clobber an existing `.muaddib/secrets.env` — add/
replace only the keys you collected). Seed the file from the example if absent:

```bash
cd "$TARGET"
[ -f .muaddib/secrets.env ] || { [ -f .muaddib/secrets.env.example ] && cp .muaddib/secrets.env.example .muaddib/secrets.env; }
# Upsert helper — removes any prior active/commented line, then appends. Mirrors install.sh's env_set.
# Note: `grep -v` exits 1 when it filters out *every* line (file held only this
# key, or was empty), which under `set -e` would abort before the append and
# silently drop the key — so `|| true` keeps the removal best-effort. The
# redirection always creates the .tmp even when grep matches nothing, so the mv
# is safe. `%q` quotes the value so spaces / # / quotes survive a later `source`.
env_set() { local k="$1" v="$2" f=.muaddib/secrets.env; grep -v -E "^[[:space:]]*#?[[:space:]]*${k}=" "$f" > "$f.tmp" 2>/dev/null || true; mv "$f.tmp" "$f"; printf '%s=%q\n' "$k" "$v" >> "$f"; }
# e.g. env_set GITHUB_TOKEN "$TOKEN"   (only for values the operator actually supplied)
```

`.muaddib/secrets.env` is gitignored; `.muaddib/manifest.json` is committed. Do **not**
print secret values back to the terminal.

## Step 7 — Validate

Run the consolidated validator and surface its output. Fix any errors before
declaring the project onboarded (a warning is advisory — report it, don't block).

```bash
node "$MUADDIB_DIR/services/validate-manifest.js" "$TARGET"
```

Then summarize for the operator: what was inferred, what they chose, which artifacts
were generated, and the next command to run (`./muaddib.sh <ticket-or-task>` or
`npm run muaddib:start` for the dispatch daemon). Note that the credential scopes set
up here already cover backlog listing if that capability lands later — no re-onboard
needed.
