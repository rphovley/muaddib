#!/usr/bin/env bash
# Run the orchestrator lib test suite inside the worker container.
# Always runs via docker so tmux and all runtime deps are available.
#
# Usage: ./muaddib/orchestrator/run_tests.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

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
        cd /home/worker/repo/muaddib/orchestrator
        echo '=== test-event-bus ==='
        node __tests__/test-event-bus.js
        echo '=== test-job ==='
        node __tests__/test-job.js
        echo '=== test-orchestrator ==='
        node __tests__/test-orchestrator.js
        echo '=== test-runner ==='
        node __tests__/test-runner.js
        echo '=== test-state ==='
        node __tests__/test-state.js
        echo ''
        echo 'All test suites passed.'
    "
