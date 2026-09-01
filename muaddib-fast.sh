#!/usr/bin/env bash
# Spawn an isolated worker using the feature-fast workflow (no planning/review phases).
#   npm run muaddib:fast <linear-url-or-id>     (from the repo root)
#   ./muaddib-fast.sh   <linear-url-or-id>      (from this folder)
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/bin/read-config.sh"
TICKET="${1:?usage: npm run muaddib:fast <linear-url-or-id>}"

echo "→ muaddib:fast: ${TICKET}"
# Empty slot arg → spawn-worker.sh auto-selects the slot under its allocation
# lock (see bin/worker-alloc.sh) and announces the real slot itself.
# Host-side path — spawn-worker.sh already translates anything under
# REPO_ROOT into the right container path, nested-submodule or not.
WORKFLOW_FILE="$DIR/workflows/feature-fast.json" exec "$DIR/bin/spawn-worker.sh" "" "/muaddib ${TICKET}"
