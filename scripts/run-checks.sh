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

# ─── bucket files by project ─────────────────────────────────────────────────

has_api=0; has_portal=0; has_homeowner=0; has_app_install=0
while IFS= read -r f; do
  case "$f" in
    projects/api/*)          has_api=1 ;;
    projects/portal/*)       has_portal=1 ;;
    projects/homeowner/*)    has_homeowner=1 ;;
    projects/app_install/*)  has_app_install=1 ;;
  esac
done <<< "$CHANGED"

# ─── run checks ──────────────────────────────────────────────────────────────

FAILED=0
cd "$REPO"

if [ "$has_api" -eq 1 ]; then
  log "api: running checks..."
  if capture "api:check" npm run api:check; then
    log "api: PASS"
  else
    log "api: FAIL"
    FAILED=1
  fi
fi

if [ "$has_portal" -eq 1 ]; then
  log "portal: running lint + test..."
  portal_ok=1
  capture "portal:lint" npm --prefix projects/portal run lint || portal_ok=0
  capture "portal:test" npm --prefix projects/portal run test || portal_ok=0
  if [ "$portal_ok" -eq 1 ]; then
    log "portal: PASS"
  else
    log "portal: FAIL"
    FAILED=1
  fi
fi

if [ "$has_homeowner" -eq 1 ]; then
  log "homeowner: running lint + test..."
  homeowner_ok=1
  capture "homeowner:lint" npm --prefix projects/homeowner run lint || homeowner_ok=0
  capture "homeowner:test" npm --prefix projects/homeowner run test || homeowner_ok=0
  if [ "$homeowner_ok" -eq 1 ]; then
    log "homeowner: PASS"
  else
    log "homeowner: FAIL"
    FAILED=1
  fi
fi

if [ "$has_app_install" -eq 1 ]; then
  log "app_install: running lint..."
  if capture "app_install:lint" npm --prefix projects/app_install run lint; then
    log "app_install: PASS"
  else
    log "app_install: FAIL"
    FAILED=1
  fi
fi

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
