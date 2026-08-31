#!/usr/bin/env bash
# Conductor daemon entry point — runs the process-lifecycle skeleton directly on
# the host / base image. Full container packaging (a docker-compose.conductor.yml
# / Dockerfile.conductor, install-script wiring analogous to dispatch) is
# deliberately deferred to a later milestone issue.
#   ./conductor.sh          — foreground (Ctrl-C stops cleanly via SIGINT)
#   ./conductor.sh --bg     — start detached (PID recorded, logs to a file)
#   ./conductor.sh --stop   — stop a --bg daemon (SIGTERM)
set -euo pipefail

FLEET_DIR="$(cd "$(dirname "$0")" && pwd)"
CONDUCTOR_JS="$FLEET_DIR/services/conductor.js"

# Runtime files (pid + log) live outside any repo tree, mirroring how dispatch
# keeps its state under ~/.muaddib/. Overridable so tests don't touch $HOME.
CONDUCTOR_RUNTIME_DIR="${CONDUCTOR_RUNTIME_DIR:-$HOME/.muaddib}"
PID_FILE="$CONDUCTOR_RUNTIME_DIR/conductor.pid"
LOG_FILE="$CONDUCTOR_RUNTIME_DIR/conductor.log"
mkdir -p "$CONDUCTOR_RUNTIME_DIR"

# ─── secrets for non-interactive startup ───────────────────────────────────────
# CLAUDE_CODE_OAUTH_TOKEN is account-level (tied to the Claude subscription, not
# any one repo) — a Conductor started at reboot / launchd / cron inherits no
# ~/.zshrc export, so backfill it from the account-level, chmod-600, git-ignored
# ~/.muaddib/conductor-secrets.env (shell env still wins — see bin/load-env-file.sh).
source "$FLEET_DIR/bin/load-env-file.sh"
CONDUCTOR_SECRETS_FILE="${CONDUCTOR_SECRETS_FILE:-$HOME/.muaddib/conductor-secrets.env}"
muaddib_load_env_file "$CONDUCTOR_SECRETS_FILE"

conductor_running() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

case "${1:-}" in
  --bg)
    if conductor_running; then
      echo "→ conductor already running (PID $(cat "$PID_FILE"))"
      exit 0
    fi
    nohup node "$CONDUCTOR_JS" >>"$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    echo "→ conductor started (PID $!, logs: $LOG_FILE)"
    ;;
  --stop)
    if conductor_running; then
      pid="$(cat "$PID_FILE")"
      kill "$pid" 2>/dev/null || true
      rm -f "$PID_FILE"
      echo "→ conductor stopped (PID $pid)"
    else
      rm -f "$PID_FILE"
      echo "→ conductor not running"
    fi
    ;;
  "")
    exec node "$CONDUCTOR_JS"
    ;;
  *)
    echo "usage: conductor.sh [--bg|--stop]" >&2
    exit 1
    ;;
esac
