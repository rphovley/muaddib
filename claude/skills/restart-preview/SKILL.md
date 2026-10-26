---
name: restart-preview
description: Recover a stale or broken preview inside a muaddib worker — force-restart the API dev server, recreate the Cloudflare/localhost.run tunnels for every managed service, re-sync VITE_API_URL into the frontend dev servers, and update the open PR's Preview table with the fresh URLs. Use when the user asks to restart the tunnels/servers, the preview 502s, or a frontend keeps hitting a stale API tunnel URL.
---

# Restart Preview

Wraps `services/retunnel.sh` (manual tunnel/server recovery, see its own header
comment) with the two things it doesn't do on its own:

1. An **unconditional** API bounce — `retunnel.sh` leaves the API dev server
   alone if it's still listening (step 3b of that script), which is right for
   a dead-tunnel-only recovery but not for "restart the API too."
2. Writing the refreshed URLs back into the open PR's `## Preview` table, so a
   reviewer looking at the PR never clicks a dead link from the last restart.

Runs inside the worker container. `$ARGUMENTS` is unused. Each step below
re-derives `$REPO`/`$WORKER`/`$CONFIG` instead of relying on shell state from a
previous step — Bash tool invocations don't share shell state with each other.

## Step 1 — Force the API dev server down

Don't hand-roll the port kill. `kill_port` from `services/lib/port-utils.sh`
tries `fuser`, then `lsof`, then `ss` — and the worker image ships **only**
`ss`, so a `fuser`/`lsof`-only version of this step silently kills nothing and
`retunnel.sh` then finds a healthy port and skips the API bounce entirely.

```bash
REPO="${REPO_DIR:-/home/worker/repo}"
MUADDIB_ROOT="$REPO"; [ -d "$MUADDIB_ROOT/muaddib" ] && MUADDIB_ROOT="$MUADDIB_ROOT/muaddib"
CONFIG="$REPO/.muaddib/manifest.json"
. "$MUADDIB_ROOT/services/lib/port-utils.sh"

API_PORT=$(jq -r '.projects[] | select(.seedScript != null) | .port // empty' "$CONFIG" | head -1)

if [ -n "$API_PORT" ]; then
  kill_port "$API_PORT"
  wait_port_free "$API_PORT" 10 \
    && echo "API port :${API_PORT} is free" \
    || echo "WARNING: :${API_PORT} still bound after 10s — retunnel.sh will skip the API bounce"
fi
```

Report that warning if it appears: it means the API was *not* restarted, which
is the whole point of this skill over a bare `retunnel.sh`.

## Step 2 — Run the recovery script

```bash
REPO="${REPO_DIR:-/home/worker/repo}"
WORKER="${WORKER_INDEX:-1}"
MUADDIB_ROOT="$REPO"; [ -d "$MUADDIB_ROOT/muaddib" ] && MUADDIB_ROOT="$MUADDIB_ROOT/muaddib"
LOG="/tmp/restart-preview-${WORKER}.log"

bash "$MUADDIB_ROOT/services/retunnel.sh" > "$LOG" 2>&1; rc=$?; cat "$LOG"; echo "retunnel exit=$rc"; exit "$rc"
```

Redirect to a file and `cat` it — do **not** pipe into `tee`. `retunnel.sh`
leaves behind one `while true` supervisor loop per dev server, which outlives
the script (the next restart run kills it by pid — `kill_stale_supervisors` in
`services/lib/supervisors.sh`). Those loops redirect their own stdio now, but
anything that later forgets to would
hold the pipe's write end open after the script exits, so `tee` would never see
EOF and the tool call would block until its 10-minute timeout with the work
already finished. A redirect to a file can't wedge that way.

Expect the script to take **2–5 minutes** even when everything works: a cold
`tsx watch` API start (up to 90s), then one cloudflared handshake per service
(API + each frontend, up to 30s each, longer if it falls back to
localhost.run), then a readiness wait per frontend port (up to 60s each). It is
not hung — check the elapsed time against that budget before assuming it is.

With the API port now free, `retunnel.sh` relaunches the API and supervises it.
(If the project's `on-servers-start` hook wins the race and relaunches the API
first, `retunnel.sh` kills that hook and adopts the fresh process instead — the
API still ends up restarted, with exactly one supervisor on the port.)
It then unconditionally recreates every managed tunnel (cloudflared →
localhost.run fallback), bounces every frontend dev server with the fresh
`VITE_API_URL`, opens new frontend tunnels, and writes
`/tmp/preview-urls-${WORKER}.env` + worker state. It never touches the webhook
tunnel on :9090.

Check the log for `API tunnel URL: <empty>` or a "not ready after" warning —
if either appears, say so plainly in your final summary. Don't report success
when a URL came back empty or a port never recovered.

## Step 3 — Update the PR's Preview table

Skip this step (and say so in your final summary) if there's no open PR yet.

```bash
REPO="${REPO_DIR:-/home/worker/repo}"
WORKER="${WORKER_INDEX:-1}"
CONFIG="$REPO/.muaddib/manifest.json"
URLS_FILE="/tmp/preview-urls-${WORKER}.env"

PR_NUMBER=""
[ -f "/tmp/pr-number-${WORKER}" ] && PR_NUMBER=$(cat "/tmp/pr-number-${WORKER}")
[ -z "$PR_NUMBER" ] && PR_NUMBER=$(gh pr view --json number --jq .number 2>/dev/null || true)

if [ -z "$PR_NUMBER" ]; then
  echo "no open PR for this branch — skipping PR update"
else
  # shellcheck disable=SC1090
  [ -f "$URLS_FILE" ] && . "$URLS_FILE"

  readarray -t FRONTEND_NAMES < <(jq -r '.projects[] | select(.seedScript == null and .devScript != null) | .name' "$CONFIG")

  NEW_PREVIEW=$(
    echo "## Preview"
    echo "| Service | URL |"
    echo "|---------|-----|"
    echo "| API | ${API_TUNNEL_URL:-(unavailable)} |"
    for name in "${FRONTEND_NAMES[@]}"; do
      var="$(tr '[:lower:]' '[:upper:]' <<<"$name")_URL"
      url="${!var:-(unavailable)}"
      [ "$name" = "portal" ] && [ "$url" != "(unavailable)" ] && url="${url}?is_preview=true"
      display="$(tr '[:lower:]' '[:upper:]' <<<"${name:0:1}")${name:1}"
      echo "| ${display} | ${url} |"
    done
  )

  gh pr view "$PR_NUMBER" --json body --jq .body > "/tmp/pr-body-${WORKER}.md"

  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const body = fs.readFileSync(file, "utf8");
    const replacement = process.argv[2] + "\n";
    // m makes $ match end-of-LINE, not end-of-string — the end-of-string
    // alternative must be spelled as a lookahead for "no characters left",
    // not a bare $, or the lazy match stops one line too early.
    const re = /^## Preview$\n[\s\S]*?(?=\n## |(?![\s\S]))/m;
    if (!re.test(body)) process.exit(1);
    fs.writeFileSync(file, body.replace(re, replacement));
  ' "/tmp/pr-body-${WORKER}.md" "$NEW_PREVIEW" \
    && gh pr edit "$PR_NUMBER" --body-file "/tmp/pr-body-${WORKER}.md" \
    && echo "PR #${PR_NUMBER} Preview table updated" \
    || echo "PR #${PR_NUMBER} has no ## Preview section (no .muaddib/pr-template.md override, or a hand-edited body) — left untouched"
fi
```

## Step 4 — Report back in the chat

Don't let the result sit only in the log file or the PR — your reply to the
user must include, directly:

- the fresh API tunnel URL and every frontend URL (from `$URLS_FILE`)
- the unchanged preview credentials (email/password/magic link), also in
  `$URLS_FILE`
- whether the PR was updated, and which PR number
- any warning from Step 2 (empty tunnel URL, a port that never came back),
  called out explicitly rather than buried under a generic "done"
