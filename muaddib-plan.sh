#!/usr/bin/env bash
# Spawn an isolated worker that runs the plan-only workflow on a Linear ticket.
#   npm run muaddib:plan <linear-url-or-id>
#   ./muaddib-plan.sh    <linear-url-or-id>
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
TICKET="${1:?usage: npm run muaddib:plan <linear-url-or-id>}"

N=1
while [ "$N" -le 64 ] \
    && [ -n "$(docker ps -q --filter "label=com.docker.compose.project=quotethat-w${N}" 2>/dev/null)" ]; do
    N=$((N + 1))
done

echo "→ muaddib plan on worker ${N}: ${TICKET}"
WORKFLOW_FILE=muaddib/workflows/plan.json exec "$DIR/bin/spawn-worker.sh" "$N" "/muaddib ${TICKET}"
