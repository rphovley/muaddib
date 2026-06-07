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

docker exec -it "$cid" tmux attach -t "w${N}" || true
# Restore terminal state — tmux may not have sent its cleanup sequences if the
# container was killed before the PTY flushed (leaves mouse tracking active).
printf '\033[?1000l\033[?1002l\033[?1003l\033[?1005l\033[?1006l'
stty sane 2>/dev/null || true
