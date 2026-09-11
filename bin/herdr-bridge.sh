#!/usr/bin/env bash
# Host-side companion for the dispatch daemon's herdr integration.
#
# The dispatch daemon (services/dispatch-daemon.js) runs inside the Linux
# quotethat-dispatch container and shells out to spawn-worker.sh there, same
# as it does on the host. herdr is a native macOS binary + host-local Unix
# socket — unreachable from inside that container. Rather than reimplement
# herdr's internal wire protocol (undocumented, versioned, would silently
# drift), this script runs directly on the host — started by dispatch.sh,
# outside any container — and executes real `herdr` calls on behalf of
# spawn-worker.sh/teardown-worker.sh running in the container. Both sides
# rendezvous through <bridge-dir>, a subdirectory of the same host path
# docker-compose.dispatch.yml already bind-mounts as /dispatch-state.
# See bin/herdr-exec.sh for the request side of this protocol.
#
#   ./herdr-bridge.sh <bridge-dir>
#
# Known limitation: this is a plain background process, not managed by
# launchd — it does not come back on its own after a host reboot. Re-run
# dispatch.sh (which restarts it alongside the daemon container) if herdr
# integration stops working after a reboot.
set -euo pipefail

DIR="${1:?usage: herdr-bridge.sh <bridge-dir>}"
mkdir -p "$DIR"

trap 'exit 0' TERM INT

# Requests older than this were dropped by a bridge/daemon that died
# mid-round-trip; a fresh one was never going to be picked up anyway.
find "$DIR" -maxdepth 1 -name '*.req' -mmin +5 -delete 2>/dev/null || true
find "$DIR" -maxdepth 1 -name '*.processing' -mmin +5 -delete 2>/dev/null || true

# One request's handling lives in a function, called with `|| true` at the
# call site, so a bad request can degrade to a failed response instead of
# taking the whole (long-lived, unattended) watcher down with it.
handle_request() {
    local req="$1" id proc arg args out exit_code
    id="$(basename "$req" .req)"
    proc="$DIR/${id}.processing"
    # Atomic claim (rename) — harmless if this script is ever run twice.
    mv "$req" "$proc" 2>/dev/null || return 0

    args=()
    while IFS= read -r arg; do args+=("$arg"); done < <(jq -r '.[]' "$proc" 2>/dev/null)

    out="$DIR/${id}.out"
    exit_code=0
    # ${args[@]+"${args[@]}"}, not "${args[@]}": macOS ships bash 3.2 by
    # default, where `"${args[@]}"` on a zero-element array is a nounset
    # error under `set -u` (fixed in bash 4.4+) — this is the same guard
    # bin/build-images.sh already uses for the same reason.
    herdr ${args[@]+"${args[@]}"} >"$out" 2>&1 || exit_code=$?
    # Written last, after $out is fully flushed — herdr_exec's poll loop
    # treats this file's existence as "the response is ready to read".
    printf '%s' "$exit_code" >"$DIR/${id}.done"
    rm -f "$proc"
}

while :; do
    for req in "$DIR"/*.req; do
        [ -e "$req" ] || continue
        handle_request "$req" || true
    done
    sleep 0.1
done
