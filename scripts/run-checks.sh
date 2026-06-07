#!/usr/bin/env bash
# Diff-based check runner. Detects which projects changed relative to main,
# runs their check scripts, then writes check_status=pass|fail to worker state.
#
# Always exits 0 — failures are signalled via check_status=fail in state so
# the runner's quality-loop can handle retries without aborting the workflow.
#
# Required env: WORKER_INDEX
# Optional env: REPO_DIR, STATE_DIR

set -uo pipefail

: "${WORKER_INDEX:?WORKER_INDEX not set}"

REPO="${REPO_DIR:-/home/worker/repo}"
STATE_CLI="$REPO/muaddib/orchestrator/state-cli.js"
CONFIG="$REPO/.muaddib.json"

log() { echo "[run-checks w${WORKER_INDEX}] $*"; }

write_status() {
  node "$STATE_CLI" "$WORKER_INDEX" set check_status "$1" || true
}

write_output() {
  node "$STATE_CLI" "$WORKER_INDEX" set check_output "$1" || true
}

TMPOUT=$(mktemp)
FAILED_OUTPUT=""

capture() {
  local label="$1"; shift
  if "$@" >"$TMPOUT" 2>&1; then
    return 0
  else
    FAILED_OUTPUT="${FAILED_OUTPUT}=== ${label} ===
$(cat "$TMPOUT")
"
    return 1
  fi
}

# ─── collect changed files across all diff scopes ────────────────────────────

CHANGED=$(
  {
    git -C "$REPO" diff --name-only main...HEAD 2>/dev/null || true
    git -C "$REPO" diff --name-only             2>/dev/null || true
    git -C "$REPO" diff --name-only --staged    2>/dev/null || true
  } | sort -u
)

if [ -z "$CHANGED" ]; then
  log "no changes detected — skipping"
  write_status pass
  exit 0
fi

# ─── run checks per project ───────────────────────────────────────────────────

FAILED=0
cd "$REPO"

while IFS= read -r project; do
    NAME=$(printf '%s' "$project" | jq -r '.name')
    PROJ_PATH=$(printf '%s' "$project" | jq -r '.path')
    CHECK_SCRIPT=$(printf '%s' "$project" | jq -r '.checkScript // empty')
    LINT_SCRIPT=$(printf '%s' "$project" | jq -r '.lintScript // empty')
    TEST_SCRIPT=$(printf '%s' "$project" | jq -r '.testScript // empty')

    echo "$CHANGED" | grep -q "^${PROJ_PATH}/" || continue

    log "${NAME}: running checks..."
    ok=1
    [ -n "$CHECK_SCRIPT" ] && { capture "${NAME}:check" npm run "$CHECK_SCRIPT" || ok=0; }
    [ -n "$LINT_SCRIPT"  ] && { capture "${NAME}:lint"  npm run "$LINT_SCRIPT"  || ok=0; }
    [ -n "$TEST_SCRIPT"  ] && { capture "${NAME}:test"  npm run "$TEST_SCRIPT"  || ok=0; }
    [ "$ok" -eq 1 ] && log "${NAME}: PASS" || { log "${NAME}: FAIL"; FAILED=1; }
done < <(jq -c '.projects[]' "$CONFIG")

rm -f "$TMPOUT"

# ─── write result ─────────────────────────────────────────────────────────────

if [ "$FAILED" -eq 1 ]; then
  log "result: FAIL"
  write_status fail
  write_output "$FAILED_OUTPUT"
else
  log "result: PASS"
  write_status pass
  write_output ""
fi

exit 0
