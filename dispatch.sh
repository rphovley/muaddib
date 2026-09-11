#!/usr/bin/env bash
# Dispatch daemon entry point — manages the daemon via Docker Compose.
#   ./dispatch.sh          — foreground (Ctrl-C stops cleanly)
#   ./dispatch.sh --bg     — start detached (restart: unless-stopped)
#   ./dispatch.sh --stop   — deregister webhook, remove container
set -euo pipefail

FLEET_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$FLEET_DIR/bin/read-config.sh"
COMPOSE_FILE="${FLEET_DIR}/docker-compose.dispatch.yml"
PROJECT="${MUADDIB_PROJECT_NAME}-dispatch"
export MUADDIB_DISPATCH_IMAGE="${MUADDIB_PROJECT_NAME}-dispatch:latest"

# Derive DISPATCH_PORT: existing env override → .muaddib/manifest.json dispatchPort → default 3999.
# Set dispatchPort in .muaddib/manifest.json (or export DISPATCH_PORT before running) to a unique
# port per project when running two dispatch daemons on the same machine.
DISPATCH_PORT="${DISPATCH_PORT:-$(jq -r '.dispatchPort // 3999' "${MUADDIB_CONFIG_FILE:-/dev/null}" 2>/dev/null || echo 3999)}"
export DISPATCH_PORT

# HOST_FLEET_DIR is the real host-filesystem path to muaddib/.
# spawn-worker.sh uses it so `docker compose` resolves volume mounts on the
# host rather than against the container's bind-mount path.
export HOST_FLEET_DIR="$FLEET_DIR"

# Account-level per-project dir (MUADDIB_ACCOUNT_DIR from read-config.sh, honoring
# any override) — bind-mounted into the dispatch container as /dispatch-state (see
# docker-compose.dispatch.yml) to persist the dedup ledger. Create it here as the
# invoking (non-root) user so the mount source exists and isn't lazily
# root-created by Docker with the wrong ownership.
mkdir -p "$MUADDIB_ACCOUNT_DIR"

# ─── herdr bridge (optional) ────────────────────────────────────────────────────
# herdr is a host-only macOS binary/socket — the dispatch container can't call
# it directly (see bin/herdr-bridge.sh for why). If herdr is installed on this
# host, run its bridge alongside the daemon so daemon-spawned workers still get
# a herdr pane, same as interactive dispatch already does. A no-op host without
# herdr sees no change: the bridge dir is never created, and spawn-worker.sh's
# herdr_available check (bin/herdr-exec.sh) fails closed exactly as before.
HERDR_BRIDGE_DIR="$MUADDIB_ACCOUNT_DIR/herdr-bridge"
HERDR_BRIDGE_PID_FILE="$MUADDIB_ACCOUNT_DIR/herdr-bridge.pid"

start_herdr_bridge() {
    command -v herdr &>/dev/null || return 0
    # Already running (e.g. a previous --bg that was never --stop'd) — don't
    # spawn a second poller onto the same directory.
    if [ -f "$HERDR_BRIDGE_PID_FILE" ] && kill -0 "$(cat "$HERDR_BRIDGE_PID_FILE")" 2>/dev/null; then
        return 0
    fi
    mkdir -p "$HERDR_BRIDGE_DIR"
    "$FLEET_DIR/bin/herdr-bridge.sh" "$HERDR_BRIDGE_DIR" \
        >"$MUADDIB_ACCOUNT_DIR/herdr-bridge.log" 2>&1 &
    disown $!
    echo $! >"$HERDR_BRIDGE_PID_FILE"
}

stop_herdr_bridge() {
    [ -f "$HERDR_BRIDGE_PID_FILE" ] || return 0
    kill "$(cat "$HERDR_BRIDGE_PID_FILE")" 2>/dev/null || true
    rm -f "$HERDR_BRIDGE_PID_FILE"
}

# ─── secrets for non-interactive startup ───────────────────────────────────────
# ~/.zshrc exports these only for *interactive* shells, so a daemon started at
# reboot / launchd / cron inherits neither — the docker-compose interpolation
# below (both vars are hard ${VAR:?...} requirements in docker-compose.dispatch.yml)
# then fails. Backfill from two files (shell env still wins over either — see
# bin/load-env-file.sh):
#   - CLAUDE_CODE_OAUTH_TOKEN is account-level (tied to the Claude subscription,
#     not any one repo) — ~/.muaddib/conductor-secrets.env. Deliberately NOT
#     ~/.zshenv — that would expose it to every process on the machine.
#   - GITHUB_TOKEN is project-scoped (a PAT limited to this repo) — the
#     project's own .muaddib/secrets.env, the same file spawn-worker.sh reads.
source "$FLEET_DIR/bin/load-env-file.sh"
CONDUCTOR_SECRETS_FILE="${CONDUCTOR_SECRETS_FILE:-$HOME/.muaddib/conductor-secrets.env}"
muaddib_load_env_file "$CONDUCTOR_SECRETS_FILE"
muaddib_load_env_file "$FLEET_DIR/.muaddib/secrets.env"

case "${1:-}" in
  --bg)
    start_herdr_bridge
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up -d --build
    echo "→ dispatch-daemon started (logs: docker compose -p ${PROJECT} -f ${COMPOSE_FILE} logs -f)"
    ;;
  --stop)
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" down
    stop_herdr_bridge
    echo "→ dispatch-daemon stopped"
    ;;
  "")
    start_herdr_bridge
    trap stop_herdr_bridge EXIT
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up --build
    ;;
  *)
    echo "usage: dispatch.sh [--bg|--stop]" >&2
    exit 1
    ;;
esac
