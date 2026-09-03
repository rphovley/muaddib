#!/usr/bin/env bash
# Conductor daemon entry point — runs services/conductor-daemon.js as a plain
# Node process managing a persistent `claude` tmux session.
#   ./conductor.sh                      — foreground, bare idle daemon (Ctrl-C stops cleanly)
#   ./conductor.sh QUO-507              — start + feed QUO-507 to the session as its initial prompt
#   ./conductor.sh "look into the flaky preview"  — same, with free-form task text
#   ./conductor.sh /some-skill ...      — a leading `/` runs a skill (typed verbatim into the TUI)
#   ./conductor.sh --bg [ticket-or-task]— start detached (PID in .muaddib-conductor.pid)
#   ./conductor.sh --stop               — SIGTERM the daemon (kills its claude session)
# When a daemon is already running, a ticket/task is sent to the existing session
# (reuse) instead of spawning a second competing daemon.
#
# Also available as `npm run muaddib:conductor <ticket-or-task>` (and `--bg`).
#
# Full containerization (Dockerfile.conductor + docker-compose.conductor.yml) is
# a deferred follow-on: the skeleton AC needs the Node lifecycle + persistent
# session, not a container. This mirrors dispatch.sh's secret-loading but runs
# the daemon directly rather than via docker compose.
set -euo pipefail

FLEET_DIR="$(cd "$(dirname "$0")" && pwd)"
DAEMON="$FLEET_DIR/services/conductor-daemon.js"
# Overridable so the dispatch routing (below) is testable without a real daemon —
# a test can point this at a temp file holding a live/absent PID.
PID_FILE="${CONDUCTOR_PID_FILE:-$FLEET_DIR/.muaddib-conductor.pid}"

usage() {
  echo "usage: conductor.sh [--bg|--stop] [--attach] [--dry-run] [ticket-or-task]" >&2
}

# True iff a daemon we started is still running (matches --stop's liveness check).
daemon_alive() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

# Tear down any tmux session lingering under the daemon's session name (default
# 'conductor'). ConductorSession.start() is idempotent — it *adopts* an existing
# session of that name rather than relaunching, which is right for the reuse
# path. But a fresh launch (fg/bg) is chosen only when no daemon is running (per
# the PID file), so a session still up under that name is an orphan from a
# crashed daemon; adopting it would skip start()'s readiness wait and baseline
# snapshot and type the prompt into an unverified session. Clear it first so
# start() brings up a clean, verified one.
clear_stale_session() {
  tmux kill-session -t "${CONDUCTOR_SESSION_NAME:-conductor}" 2>/dev/null || true
}

# Block until the Conductor's tmux session exists (up to 60s — matches
# ConductorSession's own default readyTimeoutMs), then exec into it so the
# operator lands in the real interactive session instead of a background PID
# with no visible output. MUADIB_NO_ATTACH=1 (the same escape hatch
# spawn-worker.sh honors) skips this — for a programmatic caller (a script,
# dispatch-daemon) that must not have its process replaced by an attach.
attach_when_ready() {
  [ "${MUADIB_NO_ATTACH:-0}" = "1" ] && return 0
  local session="${CONDUCTOR_SESSION_NAME:-conductor}"
  local i
  for i in $(seq 1 60); do
    tmux has-session -t "$session" 2>/dev/null && exec tmux attach -t "$session"
    sleep 1
  done
  echo "conductor.sh: session '$session' did not come up within 60s — not attaching (watch: tmux attach -t $session once it is)" >&2
}

# ─── argument parsing ───────────────────────────────────────────────────────────
# Extract leading flags; everything after them is the ticket/task. Mirrors
# muaddib.sh's leading-flag-then-argument shape.
BG=0
STOP=0
ATTACH=0
DRY_RUN=0
[ "${CONDUCTOR_DRY_RUN:-0}" = "1" ] && DRY_RUN=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bg)      BG=1; shift ;;
    --stop)    STOP=1; shift ;;
    --attach)  ATTACH=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --)        shift; break ;;
    -*)        usage; exit 1 ;;
    *)         break ;;
  esac
done

# The ticket/task is everything left, joined (`$*`) so multi-word task text passed
# as separate words still works; a single ticket token joins to itself.
TICKET="$*"

# ─── routing decision ───────────────────────────────────────────────────────────
# Resolve mode + prompt purely from the flags, the ticket, and whether a daemon is
# already up — no side effects yet, so --dry-run can print it and exit.
#   stop  — tear the daemon down
#   reuse — daemon already up + a ticket/task → send it to the existing session
#   fg    — no daemon, foreground, with a ticket/task
#   bg    — no daemon, backgrounded, with a ticket/task
#   start — no ticket/task → bare idle daemon (foreground or, with --bg, detached)
PROMPT=""
if [ "$STOP" -eq 1 ]; then
  MODE="stop"
elif [ -n "$TICKET" ]; then
  PROMPT="$TICKET"
  if daemon_alive; then
    MODE="reuse"
  elif [ "$BG" -eq 1 ]; then
    MODE="bg"
  else
    MODE="fg"
  fi
else
  MODE="start"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  printf 'mode=%s\n' "$MODE"
  printf 'prompt=%s\n' "$PROMPT"
  exit 0
fi

# ─── secrets for non-interactive startup ───────────────────────────────────────
# ~/.zshrc exports CLAUDE_CODE_OAUTH_TOKEN only for *interactive* shells, so a
# daemon started at reboot / launchd / cron inherits nothing — the daemon's
# validateEnv() would then fail fast. Backfill from the account-level secrets
# file (shell env still wins over the file — see bin/load-env-file.sh). This is
# the same account-level token, in the same file, dispatch.sh already reads.
source "$FLEET_DIR/bin/load-env-file.sh"
CONDUCTOR_SECRETS_FILE="${CONDUCTOR_SECRETS_FILE:-$HOME/.muaddib/conductor-secrets.env}"
muaddib_load_env_file "$CONDUCTOR_SECRETS_FILE"

# Tearing the daemon down (--stop) is pure process management — it needs no
# subscription token, so a missing one must not block a stop.
if [ "$MODE" != "stop" ] && [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "conductor.sh: CLAUDE_CODE_OAUTH_TOKEN is not set (expected in the shell env or $CONDUCTOR_SECRETS_FILE)" >&2
  exit 1
fi

# ─── dispatch ───────────────────────────────────────────────────────────────────
case "$MODE" in
  stop)
    if daemon_alive; then
      kill -TERM "$(cat "$PID_FILE")"
      rm -f "$PID_FILE"
      echo "→ conductor-daemon stopped"
    else
      echo "conductor.sh: no running daemon (stale or missing $PID_FILE)" >&2
      rm -f "$PID_FILE"
    fi
    ;;
  reuse)
    # A daemon is already up — hand the prompt to its existing session rather
    # than spawning a second competing daemon. The --send subcommand verifies
    # the session is alive, types the prompt, and exits.
    node "$DAEMON" --send "$TICKET"
    echo "→ sent to running conductor-daemon (PID $(cat "$PID_FILE"))"
    [ "$ATTACH" -eq 1 ] && attach_when_ready
    ;;
  bg)
    clear_stale_session
    nohup node "$DAEMON" "$TICKET" >"$FLEET_DIR/.muaddib-conductor.log" 2>&1 &
    echo $! > "$PID_FILE"
    echo "→ conductor-daemon started (PID $(cat "$PID_FILE"), logs: $FLEET_DIR/.muaddib-conductor.log)"
    [ "$ATTACH" -eq 1 ] && attach_when_ready
    ;;
  fg)
    clear_stale_session
    exec node "$DAEMON" "$TICKET"
    ;;
  start)
    if [ "$BG" -eq 1 ]; then
      if daemon_alive; then
        echo "conductor.sh: already running (PID $(cat "$PID_FILE"))" >&2
        exit 1
      fi
      nohup node "$DAEMON" >"$FLEET_DIR/.muaddib-conductor.log" 2>&1 &
      echo $! > "$PID_FILE"
      echo "→ conductor-daemon started (PID $(cat "$PID_FILE"), logs: $FLEET_DIR/.muaddib-conductor.log)"
    else
      exec node "$DAEMON"
    fi
    ;;
esac
