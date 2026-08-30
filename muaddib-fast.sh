#!/usr/bin/env bash
# Spawn an isolated worker using the feature-fast workflow (no planning/review phases).
#   npm run muaddib:fast <linear-url-or-id>     (from the repo root)
#   ./muaddib-fast.sh   <linear-url-or-id>      (from this folder)
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/bin/read-config.sh"
TICKET="${1:?usage: npm run muaddib:fast <linear-url-or-id>}"

N=1
while [ "$N" -le 64 ] \
    && [ -n "$(docker ps -q --filter "label=com.docker.compose.project=${MUADDIB_PROJECT_NAME}-w${N}" 2>/dev/null)" ]; do
    N=$((N + 1))
done

echo "→ muaddib:fast on worker ${N}: ${TICKET}"
# Host-side path — spawn-worker.sh already translates anything under
# REPO_ROOT into the right container path, nested-submodule or not.
WORKFLOW_FILE="$DIR/workflows/feature-fast.json" exec "$DIR/bin/spawn-worker.sh" "$N" "/muaddib ${TICKET}"
