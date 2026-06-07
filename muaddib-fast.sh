#!/usr/bin/env bash
# Spawn an isolated worker using the feature-fast workflow (no planning/review phases).
#   npm run muaddib:fast <linear-url-or-id>     (from the repo root)
#   ./muaddib-fast.sh   <linear-url-or-id>      (from this folder)
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
TICKET="${1:?usage: npm run muaddib:fast <linear-url-or-id>}"

N=1
while [ "$N" -le 64 ] \
    && [ -n "$(docker ps -q --filter "label=com.docker.compose.project=quotethat-w${N}" 2>/dev/null)" ]; do
    N=$((N + 1))
done

echo "→ muaddib:fast on worker ${N}: ${TICKET}"
WORKFLOW_FILE="$DIR/workflows/feature-fast.json" exec "$DIR/bin/spawn-worker.sh" "$N" "/muaddib ${TICKET}"
