#!/usr/bin/env bash
# Spawn an isolated worker that runs the plan-only workflow on a Linear ticket.
#   npm run muaddib:plan <linear-url-or-id>
#   ./muaddib-plan.sh    <linear-url-or-id>
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/bin/read-config.sh"
TICKET="${1:?usage: npm run muaddib:plan <linear-url-or-id>}"

N=1
while [ "$N" -le 64 ] \
    && [ -n "$(docker ps -q --filter "label=com.docker.compose.project=${MUADDIB_PROJECT_NAME}-w${N}" 2>/dev/null)" ]; do
    N=$((N + 1))
done

echo "→ muaddib plan on worker ${N}: ${TICKET}"
# Host-side path — spawn-worker.sh already translates anything under
# REPO_ROOT into the right container path, nested-submodule or not. (A
# relative path here would instead resolve against the container's CWD,
# which has the same nested-submodule assumption baked in.)
WORKFLOW_FILE="$DIR/workflows/plan.json" exec "$DIR/bin/spawn-worker.sh" "$N" "/muaddib ${TICKET}"
