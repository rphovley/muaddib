#!/usr/bin/env bash
# Integration test for the start-servers.sh seed step.
#
# Exercises seed-preview.ts against a running worker's sidecar DB and verifies:
#   1. The process exits within SEED_TIMEOUT seconds (no pipe/pool hang)
#   2. SEED_JSON is valid JSON containing an email field
#
# Requires a running worker (npm run muaddib or npm run muaddib-task first).
# Usage: ./muaddib/scripts/test-start-servers.sh [worker-number]
#
# Options:
#   SEED_TIMEOUT — seconds to wait before declaring a hang (default: 60)

set -euo pipefail

WORKER="${1:-1}"
PROJECT="quotethat-w${WORKER}"
SEED_TIMEOUT="${SEED_TIMEOUT:-60}"

log()  { echo "[test-start-servers] $*"; }
fail() { echo "FAIL — $*" >&2; exit 1; }

# Portable timeout: run "$@" in background, kill after $1 seconds, return 124 on timeout.
run_with_timeout() {
    local secs=$1; shift
    "$@" &
    local pid=$! elapsed=0
    while kill -0 "$pid" 2>/dev/null; do
        if [ "$elapsed" -ge "$secs" ]; then
            kill "$pid" 2>/dev/null || true
            wait "$pid" 2>/dev/null || true
            return 124
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done
    wait "$pid"
}

# --- pre-flight ---

if ! command -v docker >/dev/null 2>&1; then
    echo "SKIP — docker not available" >&2
    exit 0
fi

if [ -z "$(docker ps -q --filter "label=com.docker.compose.project=${PROJECT}" --filter "name=worker")" ]; then
    echo "SKIP — no running worker ${WORKER} (project ${PROJECT})" >&2
    echo "       start one first: npm run muaddib <ticket-url>" >&2
    exit 0
fi

log "worker ${WORKER} is running — testing seed step (timeout: ${SEED_TIMEOUT}s)..."

# --- run seed (file redirect, not pipe, to avoid the esbuild fd hang) ---

SEED_EXIT=0
run_with_timeout "${SEED_TIMEOUT}" \
    docker compose -p "$PROJECT" exec -T worker bash -c '
        cd /home/worker/repo
        npx --prefix projects/api tsx \
            projects/api/scripts/seed-preview.ts \
            > /tmp/test-seed-out.txt \
            2>/tmp/test-seed-err.txt
    ' || SEED_EXIT=$?

if [ "$SEED_EXIT" = "124" ]; then
    log "seed stderr (last 20 lines):"
    docker compose -p "$PROJECT" exec -T worker \
        tail -20 /tmp/test-seed-err.txt 2>/dev/null || true
    fail "seed did not exit within ${SEED_TIMEOUT}s — pipe/pool hang suspected"
fi

# --- validate output ---

SEED_JSON=$(docker compose -p "$PROJECT" exec -T worker \
    bash -c 'tail -1 /tmp/test-seed-out.txt 2>/dev/null || true' \
    2>/dev/null | tr -d '\r')

if [ -z "$SEED_JSON" ]; then
    log "seed stderr:"
    docker compose -p "$PROJECT" exec -T worker \
        cat /tmp/test-seed-err.txt 2>/dev/null || true
    fail "SEED_JSON was empty — seed may have crashed (exit code: ${SEED_EXIT})"
fi

EMAIL=$(printf '%s' "$SEED_JSON" | jq -r '.email // empty' 2>/dev/null || true)
if [ -z "$EMAIL" ]; then
    log "raw output: $SEED_JSON"
    fail "output is not valid JSON with an email field"
fi

log "seed log:"
docker compose -p "$PROJECT" exec -T worker \
    cat /tmp/test-seed-err.txt 2>/dev/null || true

echo ""
echo "PASS — seed exited within ${SEED_TIMEOUT}s, email=${EMAIL}"
