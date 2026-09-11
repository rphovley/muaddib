#!/usr/bin/env bash
# Shared helper: run a herdr CLI command from wherever this process happens to
# be running.
#
# herdr is a native macOS binary talking to a host-local Unix socket
# (~/.config/herdr/herdr.sock) — it isn't installed inside the Linux dispatch
# container, and the socket can't usefully be bind-mounted in either: the only
# client that speaks herdr's internal wire protocol correctly is the real
# binary, which can't run there (wrong OS/arch). So when `herdr` isn't on PATH,
# fall back to the host-side bridge (bin/herdr-bridge.sh, started by
# dispatch.sh): drop a request file in the directory
# docker-compose.dispatch.yml bind-mounts as /dispatch-state, and the bridge —
# running directly on the host, outside any container — runs the real `herdr`
# and writes the result back. Both spawn-worker.sh and teardown-worker.sh
# source this file and call herdr_exec instead of herdr directly, so they work
# unchanged whether invoked from an interactive host shell or the dispatch
# daemon's container.
#
# On the host (interactive dispatch) `command -v herdr` succeeds and this is a
# thin passthrough — zero behavior change from calling herdr directly.

herdr_available() {
    command -v herdr &>/dev/null && return 0
    [ -n "${MUADDIB_HERDR_BRIDGE_DIR:-}" ] && [ -d "$MUADDIB_HERDR_BRIDGE_DIR" ]
}

herdr_exec() {
    if command -v herdr &>/dev/null; then
        herdr "$@"
        return $?
    fi
    if [ -z "${MUADDIB_HERDR_BRIDGE_DIR:-}" ] || [ ! -d "$MUADDIB_HERDR_BRIDGE_DIR" ]; then
        return 127
    fi

    local id req out done_file i exit_code
    id="herdr-$(date +%s%N)-$$-${RANDOM}"
    req="$MUADDIB_HERDR_BRIDGE_DIR/${id}.req"
    out="$MUADDIB_HERDR_BRIDGE_DIR/${id}.out"
    done_file="$MUADDIB_HERDR_BRIDGE_DIR/${id}.done"

    # Written as a JSON array (not a raw command line) so args with spaces —
    # e.g. the tmux-attach command line, a task-derived title — survive the
    # round trip without shell re-quoting on either side. The `--` before "$@"
    # is required: without it, jq's own arg parser tries to interpret a
    # flag-shaped positional (e.g. --label, --no-focus) as a jq option and
    # errors out instead of treating it as data.
    if ! jq -nc '$ARGS.positional' --args -- "$@" >"${req}.tmp" 2>/dev/null; then
        rm -f "${req}.tmp"
        return 127
    fi
    mv "${req}.tmp" "$req"

    # The bridge polls at 0.1s; 10s is generous slack for a busy host.
    for i in $(seq 1 100); do
        [ -f "$done_file" ] && break
        sleep 0.1
    done
    if [ ! -f "$done_file" ]; then
        rm -f "$req" "$out" "$done_file" 2>/dev/null
        return 1
    fi
    cat "$out" 2>/dev/null
    exit_code="$(cat "$done_file" 2>/dev/null || echo 1)"
    rm -f "$out" "$done_file" 2>/dev/null
    return "${exit_code:-1}"
}
