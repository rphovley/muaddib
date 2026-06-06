#!/usr/bin/env bash
# Run all muaddib test suites that don't require a live worker container.
# Runs inside Docker so tmux, Node, and all runtime deps are available.
#
# Usage: ./muaddib/run_tests.sh
#
# Excluded (require a running worker): test-start-servers.sh,
# test-orchestrator-container.sh, test-webhook-container.sh,
# test-webhook-receiver.sh — run those manually against a live worker.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if ! docker image inspect quotethat-worker:latest >/dev/null 2>&1; then
    echo "→ Building worker image…"
    docker build -f "$REPO_ROOT/muaddib/Dockerfile.worker" -t quotethat-worker:latest "$REPO_ROOT"
fi

echo "→ Running tests in container…"
docker run --rm \
    --entrypoint bash \
    -v "$REPO_ROOT:/home/worker/repo" \
    -e REPO_DIR=/home/worker/repo \
    quotethat-worker:latest \
    -c "
        set -e
        REPO=/home/worker/repo

        echo '=== orchestrator/test-event-bus ==='
        node \$REPO/muaddib/orchestrator/__tests__/test-event-bus.js

        echo '=== orchestrator/test-job ==='
        node \$REPO/muaddib/orchestrator/__tests__/test-job.js

        echo '=== orchestrator/test-orchestrator ==='
        node \$REPO/muaddib/orchestrator/__tests__/test-orchestrator.js

        echo '=== orchestrator/test-runner ==='
        node \$REPO/muaddib/orchestrator/__tests__/test-runner.js

        echo '=== orchestrator/test-state ==='
        node \$REPO/muaddib/orchestrator/__tests__/test-state.js

        echo '=== scripts/test-run-checks ==='
        bash \$REPO/muaddib/scripts/test-run-checks.sh

        echo '=== scripts/test-fetch-ticket ==='
        node \$REPO/muaddib/scripts/test-fetch-ticket.js

        echo ''
        echo 'All test suites passed.'
    "
