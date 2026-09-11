#!/usr/bin/env bash
# Manually (re)build the base + worker images, exactly the way spawn-worker.sh
# builds them on a real dispatch — including the `muaddib.build-hash` label
# image-needs-rebuild.sh checks. A plain `docker build` with no label (the old
# `npm run muaddib:build`) produced an image that always looked stale to that
# check, so every subsequent dispatch rebuilt from scratch regardless of how
# fresh the content actually was. This script is the single source of truth for
# a manual build so it can't drift from what spawn-worker.sh does again.
#
#   ./bin/build-images.sh          normal build (layer cache used)
#   ./bin/build-images.sh --force  --no-cache on both images
set -euo pipefail

BIN_DIR="$(cd "$(dirname "$0")" && pwd)"
FLEET_DIR="$(cd "$BIN_DIR/.." && pwd)"
source "$FLEET_DIR/bin/read-config.sh"
source "$FLEET_DIR/bin/image-needs-rebuild.sh"

NOCACHE=()
[ "${1:-}" = "--force" ] && NOCACHE=(--no-cache)

WORKER_DOCKERFILE="$(muaddib_worker_dockerfile "$FLEET_DIR" "$REPO_ROOT")"
MUADDIB_DOCKER_PREFIX="$(muaddib_docker_prefix "$REPO_ROOT")"
MUADDIB_BUILD_HASH="$(muaddib_image_build_hash "$FLEET_DIR" "$WORKER_DOCKERFILE")"
WORKER_IMAGE="${MUADDIB_PROJECT_NAME}-worker:latest"

echo "→ Building muaddib-base:latest…"
docker build ${NOCACHE[@]+"${NOCACHE[@]}"} -f "$FLEET_DIR/Dockerfile.base" -t muaddib-base:latest "$REPO_ROOT"

echo "→ Building ${WORKER_IMAGE} (build-hash ${MUADDIB_BUILD_HASH})…"
docker build ${NOCACHE[@]+"${NOCACHE[@]}"} --build-arg "MUADDIB_PREFIX=$MUADDIB_DOCKER_PREFIX" \
    --label "muaddib.build-hash=$MUADDIB_BUILD_HASH" \
    -f "$WORKER_DOCKERFILE" -t "$WORKER_IMAGE" "$REPO_ROOT"

echo "✓ ${WORKER_IMAGE} built and labeled — the next dispatch will skip rebuilding."
