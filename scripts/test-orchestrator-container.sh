#!/usr/bin/env bash
# Orchestrator container integration test.
#
# Runs the orchestrator test suite inside the worker Docker image so that
# tmux, the event bus, job lifecycle, and volume mounts are exercised in the
# real container runtime rather than just as host Node.js processes.
#
# Test coverage (mirrors lib/__tests__/test-orchestrator.js):
#   testBootSequence    — BOOTING → STARTING_SERVICES → RUNNING → WATCHING
#   testFeedbackCycle   — webhook:feedback → WATCHING_FEEDBACK → WATCHING
#   testMergedExitsDone — webhook:merged → DONE_FINAL + orchestrator exits 0
#
# Requirements: Docker (with quotethat-worker:latest or ability to build it).
# Usage: ./muaddib/scripts/test-orchestrator-container.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ─── pre-flight ───────────────────────────────────────────────────────────────

if ! command -v docker >/dev/null 2>&1; then
    echo "SKIP — docker not available" >&2
    exit 0
fi

if ! docker image inspect quotethat-worker:latest >/dev/null 2>&1; then
    echo "→ Building worker image (this may take a while)…"
    docker build \
        -f "$REPO_ROOT/muaddib/Dockerfile.worker" \
        -t quotethat-worker:latest \
        "$REPO_ROOT"
fi

# ─── run ─────────────────────────────────────────────────────────────────────

echo "→ Running orchestrator container test…"

docker run --rm \
    --entrypoint bash \
    -v "$REPO_ROOT:/home/worker/repo" \
    -e REPO_DIR=/home/worker/repo \
    quotethat-worker:latest \
    -c "
        set -e
        cd /home/worker/repo/muaddib/lib
        echo '=== test-orchestrator (container) ==='
        node __tests__/test-orchestrator.js
        echo ''
        echo 'Orchestrator container test passed.'
    "
