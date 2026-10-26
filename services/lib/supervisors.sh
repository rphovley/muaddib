#!/usr/bin/env bash
# Shared dev-server supervision for the preview service scripts: who is allowed
# to relaunch a preview server, and how a script takes that job over.
#
# Source it relative to the sourcing script, alongside port-utils.sh:
#   . "$(dirname "${BASH_SOURCE[0]}")/lib/supervisors.sh"
#
# The problem this exists to solve: three different scripts bounce preview dev
# servers (start-servers.sh, restart-servers.sh, retunnel.sh) and a project's
# own on-servers-start hook supervises them at boot. Any supervisor that
# survives a port kill relaunches its server ~2s later, so the bouncing script
# and the survivor end up fighting over the same port indefinitely — two
# `tsx watch` processes on the API port, one of which loses with EADDRINUSE.
# kill_stale_supervisors() is the single correct answer to "who still thinks
# they own these servers"; supervise_port() is the single correct way to take
# that ownership back.
#
# Expects: WORKER (names the pidfile), REPO (cwd for launched dev servers), and
# lib/port-utils.sh sourced for port_up(). log()/warn() are used when the
# caller defines them, so messages keep the caller's prefix.
#
# No `set -e`/`set -u` assumptions: every helper returns 0 on the "nothing to
# do" path so a caller running under `set -euo pipefail` can call it bare.

if ! declare -F log >/dev/null 2>&1; then
  log() { echo "[supervisors w${WORKER:-?}] $*" >&2; }
fi
if ! declare -F warn >/dev/null 2>&1; then
  warn() { echo "[supervisors w${WORKER:-?}] WARNING: $*" >&2; }
fi

# ── Bookkeeping ────────────────────────────────────────────────────────────────

# Relaunch loops are subshells, so their argv is just the parent script's —
# there is no `pkill -f` pattern that selects an earlier run's loops without
# also matching the run doing the killing. So each loop records its pid here
# and kill_recorded_supervisors() reads them back.
supervisor_pidfile() {
  echo "${MUADDIB_SUPERVISOR_PIDFILE:-/tmp/muaddib-supervisors-${WORKER:-${WORKER_INDEX:-1}}.pids}"
}

record_supervisor() {  # $1 label, $2 pid
  printf '%s %s\n' "$1" "$2" >> "$(supervisor_pidfile)"
  return 0
}

# Full command line of a pid, empty when it's gone. /proc is authoritative in
# the worker container; ps covers a macOS host running the tests.
pid_cmdline() {  # $1 pid
  if [ -r "/proc/$1/cmdline" ]; then
    tr '\0' ' ' < "/proc/$1/cmdline"
  else
    ps -o command= -p "$1" 2>/dev/null || true
  fi
  return 0
}

# Kill relaunch loops recorded by earlier runs of any of these scripts.
kill_recorded_supervisors() {
  local pidfile label pid cmd killed=0
  pidfile=$(supervisor_pidfile)
  [ -f "$pidfile" ] || { log "no supervisor loops recorded in ${pidfile}"; return 0; }
  while read -r label pid _rest; do
    [ -n "${pid:-}" ] || continue
    [ "$pid" = "$$" ] && continue
    kill -0 "$pid" 2>/dev/null || continue
    # Guard against pid reuse: a recycled pid now belonging to something else
    # must not be killed just because it once was one of our loops.
    cmd=$(pid_cmdline "$pid")
    case "$cmd" in
      *retunnel.sh*|*restart-servers.sh*|*start-servers.sh*) ;;
      *) log "recorded pid ${pid} (${label}) is no longer one of ours — leaving it"; continue ;;
    esac
    if kill "$pid" 2>/dev/null; then
      log "killed stale ${label} supervisor loop (pid ${pid})"
      killed=$((killed + 1))
    fi
  done < "$pidfile"
  [ "$killed" -gt 0 ] || log "no live supervisor loops to kill"
  : > "$pidfile"
  return 0
}

# Kill every process that would relaunch a preview dev server behind our back.
# Call this BEFORE killing any port: a survivor relaunches the old server ~2s
# later and the two fight over the port indefinitely. Four kinds exist, and
# missing any one of them reproduces that fight:
#
#   1. services/start-servers.js — muaddib's servers job.
#   2. services/start-servers.sh — the shell servers job. The pattern also
#      matches its own `while true` subshells, which share its argv.
#   3. .muaddib/hooks/on-servers-start{.js,.sh} — the PROJECT hook, and the one
#      that actually holds the per-server restart timers (startWithRestart()).
#      `pkill -f start-servers.js` does NOT match "on-servers-start.js" — the
#      substring differs — so cleanup that only killed start-servers.js orphaned
#      the real supervisor and left it relaunching servers against us. That is
#      the API-port fight, and it survived every restart path until this helper.
#   4. `while true` loops left by an earlier retunnel/restart run, by pid.
#
# The dev servers themselves are deliberately left running (orphaned): the
# caller either rebinds the port next, or hands the live process to
# supervise_port(), which adopts it without a restart.
kill_stale_supervisors() {
  pkill -f "services/start-servers.js" 2>/dev/null \
    && log "killed start-servers.js supervisor" || log "no start-servers.js supervisor found"
  pkill -f "services/start-servers.sh" 2>/dev/null \
    && log "killed start-servers.sh supervisor" || log "no start-servers.sh supervisor found"
  pkill -f "hooks/on-servers-start" 2>/dev/null \
    && log "killed on-servers-start project hook" || log "no on-servers-start project hook found"
  kill_recorded_supervisors
  sleep 1
  return 0
}

# Supervise a dev server on a port, in the background, adopting whatever is
# already listening there.
#
#   supervise_port <label> <port> <devScript> <logfile> [NAME=value ...]
#
# The loop launches the dev server only while the port is NOT bound, which is
# what makes adoption work: a server left healthy-but-unsupervised (its old
# supervisor having just been killed) is picked up with zero downtime. That
# matters because a cold `tsx watch` start costs ~a minute of API downtime, and
# because an unsupervised-but-healthy API is how the API silently stayed dead
# behind a working tunnel after the next crash.
#
# devScript is a SHELL COMMAND (manifest: "npm run api:dev"), run via `sh -c`
# exactly as the project's on-servers-start hook runs it — not a bare npm script
# name. `npm run "npm run api:dev"` is a "Missing script" error on every
# iteration, which is what made the relaunch silently never bind the port.
#
# Two details are load-bearing:
#
#   - `|| true` on the dev-server call. The subshell inherits `set -e` from the
#     caller and a `while` BODY is not one of its exempt contexts, so without it
#     the first nonzero exit (an EADDRINUSE, say) kills the supervisor itself
#     and leaves nothing watching the port at all.
#   - the redirections sit on the SUBSHELL, not the inner commands. This loop
#     outlives the script, and an inherited stdout holds the caller's pipe
#     write-end open forever, so `retunnel.sh | tee log` would never terminate.
supervise_port() {
  local label="$1" port="$2" script="$3" logfile="$4"
  shift 4
  ( cd "${REPO:-.}" || exit 1
    while true; do
      if ! port_up "$port"; then
        env "$@" sh -c "$script" || true
        echo "[${label}] exited, restarting in 2s..."
      fi
      sleep 2
    done ) < /dev/null >> "$logfile" 2>&1 &
  record_supervisor "$label" "$!"
  log "supervising ${label} on :${port} (pid $!, log: ${logfile})"
  return 0
}
