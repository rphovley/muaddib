#!/usr/bin/env bash
# Shared worker-slot allocator — a cross-process mutex around the check-then-claim
# window plus the lowest-free-slot scan it protects.
#
# Worker-slot selection ("pick the lowest worker number not currently running")
# is a check-then-act TOCTOU race: the `docker ps` scan and the claiming
# `docker compose up` are separated in space and time, so simultaneous dispatches
# all compute the same N and then collide on `docker compose up`. bin/spawn-worker.sh
# is the single authoritative allocator (every dispatch path — the muaddib*.sh
# wrappers and the dispatch daemon — exec/spawns it), so wrapping *its*
# check-then-claim in a real mutex fixes every caller at once. See issue #84.
#
# Source this file — do not execute it directly.

# Max seconds to wait for the allocation lock before failing loudly. A dispatch
# only holds the lock across a `docker ps` scan + `docker compose up -d` — the
# potentially slow one-time image build runs BEFORE the lock is taken (see
# bin/spawn-worker.sh), so 120s comfortably covers a burst of concurrent
# dispatches while still surfacing a genuinely stuck holder instead of hanging
# forever.
: "${MUADDIB_ALLOC_TIMEOUT:=120}"

# Highest worker slot to consider — matches the 1..64 ceiling the wrappers used.
: "${MUADDIB_MAX_WORKERS:=64}"

# Internal lock state, so muaddib_alloc_unlock / the EXIT trap know which
# primitive we acquired and what to release. Fixed FD 9 (a literal — bash 3.2,
# still the stock macOS shell, has no `{var}>` FD-allocation syntax).
_MUADDIB_LOCK_MODE=""    # "flock" | "mkdir" | "" (nothing held)
_MUADDIB_LOCK_PATH=""    # flock: the lock file;  mkdir: the lock directory
_MUADDIB_LOCK_FD=9
_MUADDIB_PREV_EXIT_TRAP="" # caller's EXIT trap, captured so release can restore it

# muaddib_alloc_lock <lock-path>
# Acquire the global allocation mutex. Uses an atomic `mkdir` mutex — the ONE
# primitive available identically on the stock macOS host (which ships no `flock`
# binary) AND inside the Linux dispatch container, so a host dispatch and a
# daemon dispatch, sharing the same bind-mounted lock path, actually exclude each
# other. Preferring `flock` where present would hand the two sides *different*
# locks (a flock'd file vs. a mkdir'd dir on the same path) and thus NO mutual
# exclusion across the host/container boundary. Blocks up to MUADDIB_ALLOC_TIMEOUT
# seconds, then FAILS LOUDLY (returns non-zero) rather than proceeding to collide.
# Installs an EXIT trap so a crash between acquire and the explicit
# muaddib_alloc_unlock can't leak the lock (restoring any EXIT trap the caller had
# on release). Set MUADDIB_ALLOC_USE_FLOCK=1 to force the flock path (the test
# suite exercises it directly).
muaddib_alloc_lock() {
    local path="${1:?muaddib_alloc_lock: lock path required}"

    # Remember the caller's existing EXIT trap so unlock can restore it instead of
    # blanket-clearing it (bash 3.2 has no trap stacking — `trap -p` round-trips).
    _MUADDIB_PREV_EXIT_TRAP="$(trap -p EXIT)"

    if [ "${MUADDIB_ALLOC_USE_FLOCK:-0}" = "1" ] && command -v flock >/dev/null 2>&1; then
        _MUADDIB_LOCK_MODE="flock"
        _MUADDIB_LOCK_PATH="$path"
        # Ensure the lock file exists, then open it READ-ONLY on the fixed FD
        # (literal — no `{fd}<` under bash 3.2). flock needs only an open
        # descriptor, not write access; opening for write (`>`) would EACCES for a
        # non-root user against a root-created 0644 file (mixed host/daemon
        # ownership), surfacing as a misleading lock timeout.
        [ -e "$path" ] || : >"$path" 2>/dev/null || true
        eval "exec ${_MUADDIB_LOCK_FD}<\"\$path\""
        trap 'muaddib_alloc_unlock' EXIT
        if ! flock -w "$MUADDIB_ALLOC_TIMEOUT" "$_MUADDIB_LOCK_FD"; then
            echo "muaddib: timed out after ${MUADDIB_ALLOC_TIMEOUT}s waiting for the worker-allocation lock ($path)" >&2
            return 1
        fi
        return 0
    fi

    # Fallback: an atomic mkdir mutex (mkdir either creates the dir or fails, so
    # it's a portable test-and-set). The lock dir is <path>.d; its pid file lets a
    # later waiter break a lock whose holder died mid-claim.
    _MUADDIB_LOCK_MODE="mkdir"
    _MUADDIB_LOCK_PATH="${path}.d"
    trap 'muaddib_alloc_unlock' EXIT
    local waited=0 holder
    while ! mkdir "$_MUADDIB_LOCK_PATH" 2>/dev/null; do
        # Break a stale lock: the holder PID is recorded and no longer alive.
        holder="$(cat "$_MUADDIB_LOCK_PATH/pid" 2>/dev/null || true)"
        if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
            rm -rf "$_MUADDIB_LOCK_PATH"
            continue
        fi
        if [ "$waited" -ge "$MUADDIB_ALLOC_TIMEOUT" ]; then
            echo "muaddib: timed out after ${MUADDIB_ALLOC_TIMEOUT}s waiting for the worker-allocation lock ($_MUADDIB_LOCK_PATH, held by pid ${holder:-unknown})" >&2
            # We never acquired it — clear state so unlock/the trap don't remove
            # the current holder's directory out from under them.
            _MUADDIB_LOCK_MODE=""
            _MUADDIB_LOCK_PATH=""
            return 1
        fi
        sleep 1
        waited=$((waited + 1))
    done
    printf '%s\n' "$$" > "$_MUADDIB_LOCK_PATH/pid"
    return 0
}

# Release the mutex. Idempotent — safe to call from both the explicit release
# point and the EXIT trap (the second call is a no-op).
muaddib_alloc_unlock() {
    case "$_MUADDIB_LOCK_MODE" in
        flock)
            flock -u "$_MUADDIB_LOCK_FD" 2>/dev/null || true
            eval "exec ${_MUADDIB_LOCK_FD}>&-" 2>/dev/null || true
            ;;
        mkdir)
            [ -n "$_MUADDIB_LOCK_PATH" ] && rm -rf "$_MUADDIB_LOCK_PATH" 2>/dev/null || true
            ;;
    esac
    _MUADDIB_LOCK_MODE=""
    _MUADDIB_LOCK_PATH=""
    # Restore the caller's EXIT trap rather than clearing every EXIT trap — a
    # blanket `trap - EXIT` would silently drop cleanup the sourcing shell had
    # installed. `trap -p` output is eval-able and re-installs the exact handler.
    if [ -n "$_MUADDIB_PREV_EXIT_TRAP" ]; then
        eval "$_MUADDIB_PREV_EXIT_TRAP"
    else
        trap - EXIT
    fi
    _MUADDIB_PREV_EXIT_TRAP=""
}

# muaddib_select_worker [start]
# Print the lowest free worker slot >= start (default 1), skipping any slot whose
# compose project is actually up (matched by the com.docker.compose.project
# label). MUST be called under muaddib_alloc_lock so the scan and the caller's
# subsequent claim are atomic — this is what makes a stale `start` hint safe: we
# always advance past a slot that is genuinely running, so two dispatches can
# never settle on the same N. MUADDIB_PROJECT_NAME must be set (read-config.sh).
# Prints nothing and returns 1 when every slot 1..MUADDIB_MAX_WORKERS is busy.
# `docker`-driven so the test suite can stub it with a fake `docker` on PATH.
muaddib_select_worker() {
    local n="${1:-1}"
    : "${MUADDIB_PROJECT_NAME:?muaddib_select_worker: MUADDIB_PROJECT_NAME not set}"
    # A non-integer / sub-1 hint just means "start from 1".
    [[ "$n" =~ ^[0-9]+$ ]] && [ "$n" -ge 1 ] || n=1
    while [ "$n" -le "$MUADDIB_MAX_WORKERS" ]; do
        if [ -z "$(docker ps -q --filter "label=com.docker.compose.project=${MUADDIB_PROJECT_NAME}-w${n}" 2>/dev/null)" ]; then
            printf '%s\n' "$n"
            return 0
        fi
        n=$((n + 1))
    done
    return 1
}
