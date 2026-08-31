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
