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

# ─── account-level secrets (non-interactive startup) ──────────────────────────
# ~/.zshrc exports CLAUDE_CODE_OAUTH_TOKEN / GITHUB_TOKEN only for *interactive*
# shells, so a daemon started at reboot / launchd / cron inherits neither — the
# docker-compose interpolation below (and spawn-worker.sh downstream) then fails.
# Source an account-level secrets file to supply them, honoring the "shell env
# wins over file" convention used elsewhere (spawn-worker.sh, install.sh): only
# export a KEY the current environment doesn't already have. Missing file → no-op
# (interactive shells already have the vars via ~/.zshrc). Deliberately NOT
# ~/.zshenv — that would expose these tokens to every process on the machine.
CONDUCTOR_SECRETS_FILE="${CONDUCTOR_SECRETS_FILE:-$HOME/.muaddib/conductor-secrets.env}"
if [ -f "$CONDUCTOR_SECRETS_FILE" ]; then
  while IFS= read -r _line || [ -n "$_line" ]; do
    _line="${_line#"${_line%%[![:space:]]*}"}"   # strip leading whitespace
    [ -z "$_line" ] && continue                   # skip blank lines
    case "$_line" in \#*) continue ;; esac        # skip comments
    _line="${_line#export }"                       # strip optional leading 'export '
    _key="${_line%%=*}"
    [ "$_key" = "$_line" ] && continue            # no '=' → not a KEY=VALUE line
    if [ -z "${!_key:-}" ]; then                  # shell env wins over the file
      export "${_key}=${_line#*=}"
    fi
  done < "$CONDUCTOR_SECRETS_FILE"
fi

case "${1:-}" in
  --bg)
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up -d --build
    echo "→ dispatch-daemon started (logs: docker compose -p ${PROJECT} -f ${COMPOSE_FILE} logs -f)"
    ;;
  --stop)
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" down
    echo "→ dispatch-daemon stopped"
    ;;
  "")
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up --build
    ;;
  *)
    echo "usage: dispatch.sh [--bg|--stop]" >&2
    exit 1
    ;;
esac
