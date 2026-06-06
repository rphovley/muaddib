#!/usr/bin/env bash
# Attach to a running worker's interactive Claude session.
#   ./attach.sh <worker-number>        (or: npm run muaddib:attach <n>)
# Ctrl-b then d detaches and leaves the worker running.
set -euo pipefail

N="${1:?usage: attach.sh <worker-number>}"
cid=$(docker ps -q \
    --filter "label=com.docker.compose.project=quotethat-w${N}" \
    --filter "name=worker" | head -1)

if [ -z "$cid" ]; then
    echo "worker ${N} is not running. Check ./attend.sh, or spawn it with 'npm run muaddib <ticket>'." >&2
    exit 1
fi

exec docker exec -it "$cid" tmux attach -t "w${N}"
