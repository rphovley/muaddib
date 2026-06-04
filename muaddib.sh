#!/usr/bin/env bash
# Spawn an isolated worker that runs /muaddib on a Linear ticket.
#   npm run muaddib <linear-url-or-id>     (from the repo root)
#   ./muaddib.sh    <linear-url-or-id>     (from this folder)
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
TICKET="${1:?usage: npm run muaddib <linear-url-or-id>}"

# Pick the lowest worker number not currently running (by compose project label).
N=1
while [ "$N" -le 64 ] \
    && [ -n "$(docker ps -q --filter "label=com.docker.compose.project=quotethat-w${N}" 2>/dev/null)" ]; do
    N=$((N + 1))
done

echo "→ muaddib on worker ${N}: ${TICKET}"
exec "$DIR/spawn-worker.sh" "$N" "/muaddib ${TICKET}"
