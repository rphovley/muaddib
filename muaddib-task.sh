#!/usr/bin/env bash
# Spawn an isolated worker that runs /muaddib-task on a free-form task prompt.
# No Linear ticket required.
#   npm run run-task "fix the auth token expiry bug in the portal"
#   ./run-task.sh "fix the auth token expiry bug in the portal"
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
TASK="${*:?usage: npm run run-task <task description>}"

# Pick the lowest worker number not currently running (by compose project label).
N=1
while [ "$N" -le 64 ] \
    && [ -n "$(docker ps -q --filter "label=com.docker.compose.project=quotethat-w${N}" 2>/dev/null)" ]; do
    N=$((N + 1))
done

echo "→ muaddib-task on worker ${N}: ${TASK}"
exec "$DIR/spawn-worker.sh" "$N" "/muaddib-task ${TASK}"
