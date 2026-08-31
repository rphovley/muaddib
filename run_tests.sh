#!/usr/bin/env bash
# Run all muaddib test suites that don't require a live worker container.
#
# When already running inside a muaddib worker container (WORKER_INDEX is
# set — e.g. muaddib self-hosting its own checkScript), runs the suites
# directly: tmux/Node/deps are already the right versions, so wrapping in
# another `docker run` would need docker-in-docker for no benefit.
# Otherwise wraps them in `docker run` against the worker image, so a bare
# host without tmux/the right Node version still gets a matching environment.
#
# Usage: ./muaddib/run_tests.sh
#
# Excluded (require a running worker): test-start-servers.sh,
# test-orchestrator-container.sh, test-webhook-container.sh,
# test-webhook-receiver.sh — run those manually against a live worker.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/bin/read-config.sh"
source "$SCRIPT_DIR/bin/image-needs-rebuild.sh"

# Single source of truth for the suite list — executed either directly
# (self-hosted) or inside `docker run -c` (host). $MUADDIB is the only free
# variable, set by each branch below to wherever muaddib's own root actually is.
TEST_SCRIPT='
    set -e

    echo "=== orchestrator/test-event-bus ==="
    node "$MUADDIB/orchestrator/__tests__/test-event-bus.js"

    echo "=== orchestrator/test-job ==="
    node "$MUADDIB/orchestrator/__tests__/test-job.js"

    echo "=== orchestrator/test-orchestrator ==="
    node "$MUADDIB/orchestrator/__tests__/test-orchestrator.js"

    echo "=== orchestrator/test-runner ==="
    node "$MUADDIB/orchestrator/__tests__/test-runner.js"

    echo "=== orchestrator/test-state ==="
    node "$MUADDIB/orchestrator/__tests__/test-state.js"

    echo "=== orchestrator/test-decision-log ==="
    node "$MUADDIB/orchestrator/__tests__/test-decision-log.js"

    echo "=== orchestrator/test-decision-log-cli ==="
    node "$MUADDIB/orchestrator/__tests__/test-decision-log-cli.js"

    echo "=== orchestrator/test-token-tracker ==="
    node "$MUADDIB/orchestrator/__tests__/test-token-tracker.js"

    echo "=== orchestrator/test-ticket-cli ==="
    node "$MUADDIB/orchestrator/__tests__/test-ticket-cli.js"

    echo "=== scripts/test-read-config ==="
    bash "$MUADDIB/scripts/test-read-config.sh"

    echo "=== scripts/test-run-checks ==="
    bash "$MUADDIB/scripts/test-run-checks.sh"

    echo "=== scripts/test-fetch-ticket ==="
    node "$MUADDIB/scripts/test-fetch-ticket.js"

    echo "=== services/test-ticket-source ==="
    node "$MUADDIB/services/__tests__/test-ticket-source.js"

    echo "=== services/test-linear-webhook ==="
    node "$MUADDIB/services/__tests__/test-linear-webhook.js"

    echo "=== services/test-dispatch-queue ==="
    node "$MUADDIB/services/__tests__/test-dispatch-queue.js"

    echo "=== services/test-dispatch-daemon ==="
    node "$MUADDIB/services/__tests__/test-dispatch-daemon.js"

    echo "=== services/test-start-servers-config ==="
    node "$MUADDIB/services/__tests__/test-start-servers-config.js"

    echo "=== services/test-muaddib-config ==="
    node "$MUADDIB/services/__tests__/test-muaddib-config.js"

    echo "=== services/test-goals ==="
    node "$MUADDIB/services/__tests__/test-goals.js"

    echo ""
    echo "All test suites passed."
'

if [ -n "${WORKER_INDEX:-}" ]; then
    echo "→ Inside a worker container — running tests directly…"
    MUADDIB="$SCRIPT_DIR" bash -c "$TEST_SCRIPT"
else
    WORKER_IMAGE="${MUADDIB_PROJECT_NAME}-worker:latest"
    WORKER_DOCKERFILE="$(muaddib_worker_dockerfile "$SCRIPT_DIR" "$REPO_ROOT")"
    MUADDIB_DOCKER_PREFIX="$(muaddib_docker_prefix "$REPO_ROOT")"
    MUADDIB_BUILD_HASH="$(muaddib_image_build_hash "$SCRIPT_DIR" "$WORKER_DOCKERFILE")"

    if muaddib_image_needs_rebuild "$WORKER_IMAGE" "$MUADDIB_BUILD_HASH"; then
        echo "→ Building worker image (missing or stale)…"
        docker build -f "$SCRIPT_DIR/Dockerfile.base" -t muaddib-base:latest "$REPO_ROOT"
        docker build --build-arg "MUADDIB_PREFIX=$MUADDIB_DOCKER_PREFIX" \
            --label "muaddib.build-hash=$MUADDIB_BUILD_HASH" \
            -f "$WORKER_DOCKERFILE" -t "$WORKER_IMAGE" "$REPO_ROOT"
    fi

    echo "→ Running tests in container…"
    docker run --rm \
        --entrypoint bash \
        -v "$REPO_ROOT:/home/worker/repo" \
        -e MUADDIB=/home/worker/repo/muaddib \
        "$WORKER_IMAGE" \
        -c "$TEST_SCRIPT"
fi
