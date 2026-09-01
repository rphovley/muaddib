#!/usr/bin/env bash
# Conductor daemon entry point — runs services/conductor-daemon.js as a plain
# Node process managing a persistent `claude` tmux session.
#   ./conductor.sh          — foreground (Ctrl-C stops cleanly)
#   ./conductor.sh --bg     — start detached (PID in .muaddib-conductor.pid)
#   ./conductor.sh --stop   — SIGTERM the daemon (kills its claude session)
#
# Full containerization (Dockerfile.conductor + docker-compose.conductor.yml) is
# a deferred follow-on: the skeleton AC needs the Node lifecycle + persistent
# session, not a container. This mirrors dispatch.sh's secret-loading but runs
# the daemon directly rather than via docker compose.
set -euo pipefail

FLEET_DIR="$(cd "$(dirname "$0")" && pwd)"
DAEMON="$FLEET_DIR/services/conductor-daemon.js"
PID_FILE="$FLEET_DIR/.muaddib-conductor.pid"

# ─── secrets for non-interactive startup ───────────────────────────────────────
# ~/.zshrc exports CLAUDE_CODE_OAUTH_TOKEN only for *interactive* shells, so a
# daemon started at reboot / launchd / cron inherits nothing — the daemon's
# validateEnv() would then fail fast. Backfill from the account-level secrets
# file (shell env still wins over the file — see bin/load-env-file.sh). This is
# the same account-level token, in the same file, dispatch.sh already reads.
source "$FLEET_DIR/bin/load-env-file.sh"
CONDUCTOR_SECRETS_FILE="${CONDUCTOR_SECRETS_FILE:-$HOME/.muaddib/conductor-secrets.env}"
muaddib_load_env_file "$CONDUCTOR_SECRETS_FILE"

if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "conductor.sh: CLAUDE_CODE_OAUTH_TOKEN is not set (expected in the shell env or $CONDUCTOR_SECRETS_FILE)" >&2
  exit 1
fi

case "${1:-}" in
  --bg)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "conductor.sh: already running (PID $(cat "$PID_FILE"))" >&2
      exit 1
    fi
    nohup node "$DAEMON" >"$FLEET_DIR/.muaddib-conductor.log" 2>&1 &
    echo $! > "$PID_FILE"
    echo "→ conductor-daemon started (PID $(cat "$PID_FILE"), logs: $FLEET_DIR/.muaddib-conductor.log)"
    ;;
  --stop)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      kill -TERM "$(cat "$PID_FILE")"
      rm -f "$PID_FILE"
      echo "→ conductor-daemon stopped"
    else
      echo "conductor.sh: no running daemon (stale or missing $PID_FILE)" >&2
      rm -f "$PID_FILE"
    fi
    ;;
  "")
    exec node "$DAEMON"
    ;;
  *)
    echo "usage: conductor.sh [--bg|--stop]" >&2
    exit 1
    ;;
esac
