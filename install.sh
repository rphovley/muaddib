#!/usr/bin/env bash
# muaddib/install.sh — guided first-time setup for muaddib workers and dispatch daemon.
# Safe to re-run: skips steps that are already complete.
set -euo pipefail

FLEET_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$FLEET_DIR/bin/read-config.sh"
ENV_EXAMPLE="$REPO_ROOT/non-prod.env.example"
ENV_FILE="$REPO_ROOT/non-prod.env"

# ─── output helpers ───────────────────────────────────────────────────────────

if [ -t 1 ]; then
    GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'
else
    GREEN=''; YELLOW=''; RED=''; BOLD=''; DIM=''; RESET=''
fi

ok()   { printf "${GREEN}  ✓${RESET}  %s\n" "$*"; }
warn() { printf "${YELLOW}  ⚠${RESET}  %s\n" "$*"; }
fail() { printf "${RED}  ✗${RESET}  %s\n" "$*"; }
info() { printf "${DIM}     %s${RESET}\n" "$*"; }
step() { printf "\n${BOLD}%s${RESET}\n" "$*"; }
ask()  { printf "${YELLOW}  ?${RESET}  %s " "$*"; }

ERRORS=0
WARNINGS=0
err()  { fail "$@"; ERRORS=$((ERRORS + 1)); }
note() { warn "$@"; WARNINGS=$((WARNINGS + 1)); }

# ─── env file helpers ─────────────────────────────────────────────────────────

# Read a key from the env file (returns empty for missing or commented-out keys).
env_get() {
    local key="$1"
    grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r' || true
}

# Upsert key=value in the env file (removes any prior active or commented line).
env_set() {
    local key="$1" val="$2"
    grep -v -E "^[[:space:]]*#?[[:space:]]*${key}=" "$ENV_FILE" > "${ENV_FILE}.tmp" 2>/dev/null \
        && mv "${ENV_FILE}.tmp" "$ENV_FILE"
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
}

# True if the value looks like an unfilled placeholder.
is_placeholder() {
    case "${1:-}" in
        ""|test|changeme|"your_"*|"lin_api_..."*) return 0 ;;
        *) return 1 ;;
    esac
}

# ─── Linear GraphQL helper ────────────────────────────────────────────────────

linear_query() {
    local gql="$1" key="${2:-}"
    [ -z "$key" ] && key="$(env_get LINEAR_API_KEY)"
    is_placeholder "$key" && return 1
    curl -sf \
        -H "Authorization: $key" \
        -H "Content-Type: application/json" \
        --data "{\"query\":\"${gql}\"}" \
        https://api.linear.app/graphql 2>/dev/null || return 1
}

# ─── header ───────────────────────────────────────────────────────────────────

printf "\n${BOLD}muaddib — guided setup${RESET}\n"
printf "Checks prerequisites, sets up non-prod.env, and builds the worker image.\n"
printf "Safe to re-run at any time.\n"

# ─── 1. prerequisites ─────────────────────────────────────────────────────────

step "1. Prerequisites"

check_tool() {
    local cmd="$1" hint="$2" required="${3:-required}"
    if command -v "$cmd" &>/dev/null; then
        ok "$cmd"
        return 0
    fi
    if [ "$required" = "required" ]; then
        err "$cmd not found — $hint"
    else
        note "$cmd not found (needed for dispatch daemon) — $hint"
    fi
    return 1
}

check_tool docker      "install Docker Desktop: https://www.docker.com/products/docker-desktop"
check_tool node        "brew install node  (or use nvm)"
check_tool gh          "brew install gh"
check_tool claude      "npm install -g @anthropic-ai/claude-code"
check_tool cloudflared "brew install cloudflared" optional
check_tool jq          "brew install jq" optional

HAS_JQ=0
command -v jq &>/dev/null && HAS_JQ=1

# ─── 2. Docker running ────────────────────────────────────────────────────────

step "2. Docker daemon"

if command -v docker &>/dev/null; then
    if docker info &>/dev/null 2>&1; then
        ok "Docker daemon is running"
    else
        err "Docker daemon is not running — start Docker Desktop, then re-run"
    fi
fi

# ─── 3. Shell tokens ──────────────────────────────────────────────────────────

step "3. Shell environment tokens"

printf "${DIM}     These must be exported in your shell before spawning workers or starting dispatch.${RESET}\n"

check_shell_token() {
    local var="$1" how="$2"
    if [ -n "${!var:-}" ]; then
        ok "$var is set"
    else
        err "$var not set"
        info "$how"
        info "Add 'export ${var}=...' to ~/.zshrc or ~/.bashrc to persist."
    fi
}

check_shell_token CLAUDE_CODE_OAUTH_TOKEN \
    "Run: claude setup-token"

check_shell_token GITHUB_TOKEN \
    "Create a fine-grained PAT: github.com/settings/personal-access-tokens/new  (Contents r/w + Pull requests w)"

# LINEAR_API_KEY in shell is required for dispatch; also used to populate non-prod.env below.
if [ -n "${LINEAR_API_KEY:-}" ]; then
    ok "LINEAR_API_KEY is set in shell"
fi

if [ -n "${LINEAR_TEAM_ID:-}" ]; then
    ok "LINEAR_TEAM_ID is set in shell"
fi

# ─── 4. non-prod.env ──────────────────────────────────────────────────────────

step "4. non-prod.env"

if [ ! -f "$ENV_FILE" ]; then
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    ok "Created non-prod.env from template"
else
    ok "non-prod.env exists"
fi

# Resolve the best API key we have: shell env takes precedence over file.
BEST_API_KEY="${LINEAR_API_KEY:-$(env_get LINEAR_API_KEY)}"

# --- LINEAR_API_KEY ---

if ! is_placeholder "$BEST_API_KEY"; then
    ok "LINEAR_API_KEY is set"
    # Keep the file in sync if shell has it but file doesn't.
    if is_placeholder "$(env_get LINEAR_API_KEY)"; then
        env_set LINEAR_API_KEY "$BEST_API_KEY"
    fi
else
    note "LINEAR_API_KEY not set"
    info "Linear → Settings → Security & access → Personal API keys → Create key"
    if [ -t 0 ]; then
        ask "Paste your Linear API key (or press Enter to skip):"
        read -rs BEST_API_KEY; echo
        if ! is_placeholder "$BEST_API_KEY"; then
            env_set LINEAR_API_KEY "$BEST_API_KEY"
            ok "LINEAR_API_KEY saved to non-prod.env"
        else
            info "Skipped — workers and dispatch won't be able to read/post to Linear."
        fi
    fi
fi

# --- Fetch viewer info from Linear (user handle + assignee UUID) ---

VIEWER_ID=""
VIEWER_HANDLE=""
if [ "$HAS_JQ" -eq 1 ] && ! is_placeholder "$BEST_API_KEY"; then
    VIEWER_JSON=$(linear_query '{ viewer { id displayName name } }' "$BEST_API_KEY" || true)
    if [ -n "$VIEWER_JSON" ]; then
        VIEWER_ID=$(printf '%s' "$VIEWER_JSON" \
            | jq -r '.data.viewer.id // empty' 2>/dev/null || true)
        VIEWER_HANDLE=$(printf '%s' "$VIEWER_JSON" \
            | jq -r '.data.viewer.displayName // .data.viewer.name // empty' 2>/dev/null || true)
    fi
fi

# --- LINEAR_USER_HANDLE ---

CURRENT_HANDLE=$(env_get LINEAR_USER_HANDLE)
if ! is_placeholder "$CURRENT_HANDLE"; then
    ok "LINEAR_USER_HANDLE is set (${CURRENT_HANDLE})"
elif [ -n "$VIEWER_HANDLE" ]; then
    env_set LINEAR_USER_HANDLE "$VIEWER_HANDLE"
    ok "LINEAR_USER_HANDLE set to \"${VIEWER_HANDLE}\" (auto-fetched from Linear)"
else
    note "LINEAR_USER_HANDLE not set"
    info "Set to your Linear display name — used for @mentions in /grill-me comments."
    info "Linear → Settings → Account → Profile → Display name"
fi

# --- DISPATCH_ASSIGNEE_ID ---

CURRENT_ASSIGNEE=$(env_get DISPATCH_ASSIGNEE_ID)
if ! is_placeholder "$CURRENT_ASSIGNEE"; then
    ok "DISPATCH_ASSIGNEE_ID is set (${CURRENT_ASSIGNEE})"
elif [ -n "$VIEWER_ID" ]; then
    env_set DISPATCH_ASSIGNEE_ID "$VIEWER_ID"
    ok "DISPATCH_ASSIGNEE_ID set to ${VIEWER_ID} (auto-fetched from Linear)"
else
    note "DISPATCH_ASSIGNEE_ID not set"
    info "Prevents multi-machine duplicate dispatch — set to your Linear user UUID."
    info "Find it: run this script again after setting LINEAR_API_KEY."
fi

# --- LINEAR_TEAM_ID ---

BEST_TEAM="${LINEAR_TEAM_ID:-$(env_get LINEAR_TEAM_ID)}"

if ! is_placeholder "$BEST_TEAM"; then
    ok "LINEAR_TEAM_ID is set"
    if is_placeholder "$(env_get LINEAR_TEAM_ID)"; then
        env_set LINEAR_TEAM_ID "$BEST_TEAM"
    fi
elif [ "$HAS_JQ" -eq 1 ] && ! is_placeholder "$BEST_API_KEY"; then
    TEAMS_JSON=$(linear_query '{ teams { nodes { id name } } }' "$BEST_API_KEY" || true)
    TEAM_COUNT=$(printf '%s' "$TEAMS_JSON" \
        | jq '.data.teams.nodes | length' 2>/dev/null || echo 0)

    if [ "${TEAM_COUNT:-0}" -eq 1 ]; then
        T_ID=$(printf '%s' "$TEAMS_JSON" \
            | jq -r '.data.teams.nodes[0].id' 2>/dev/null || true)
        T_NAME=$(printf '%s' "$TEAMS_JSON" \
            | jq -r '.data.teams.nodes[0].name' 2>/dev/null || true)
        env_set LINEAR_TEAM_ID "$T_ID"
        ok "LINEAR_TEAM_ID set to ${T_ID} (\"${T_NAME}\", auto-fetched from Linear)"
        BEST_TEAM="$T_ID"
    elif [ "${TEAM_COUNT:-0}" -gt 1 ] && [ -t 0 ]; then
        note "Multiple Linear teams found — cannot auto-select:"
        printf '%s' "$TEAMS_JSON" \
            | jq -r '.data.teams.nodes[] | "       \(.id)  \(.name)"' 2>/dev/null || true
        ask "Paste the team UUID for dispatch, or press Enter to skip:"
        read -r _input; echo
        if ! is_placeholder "$_input"; then
            env_set LINEAR_TEAM_ID "$_input"
            ok "LINEAR_TEAM_ID saved to non-prod.env"
            BEST_TEAM="$_input"
        fi
    else
        note "LINEAR_TEAM_ID not set — dispatch daemon requires this"
        info "Linear → Settings → My Team → copy UUID from the URL."
    fi
else
    note "LINEAR_TEAM_ID not set — dispatch daemon requires this"
    info "Linear → Settings → My Team → copy UUID from the URL."
fi

# --- DISPATCH_WEBHOOK_SECRET ---

CURRENT_SECRET=$(env_get DISPATCH_WEBHOOK_SECRET)
if ! is_placeholder "$CURRENT_SECRET"; then
    ok "DISPATCH_WEBHOOK_SECRET is set"
else
    if command -v node &>/dev/null; then
        GENERATED=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
        env_set DISPATCH_WEBHOOK_SECRET "$GENERATED"
        ok "DISPATCH_WEBHOOK_SECRET generated and saved"
    else
        note "DISPATCH_WEBHOOK_SECRET not set (node unavailable to generate)"
        info "Set manually: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    fi
fi

# --- Shell env reminder for dispatch startup ---

printf "\n${DIM}     Dispatch daemon also requires these vars exported in your shell:${RESET}\n"

for _var in LINEAR_API_KEY LINEAR_TEAM_ID; do
    _val="${!_var:-}"
    if [ -z "$_val" ] && [ "$_var" = "LINEAR_API_KEY" ]; then
        _val="$(env_get LINEAR_API_KEY)"
    fi
    if [ -z "$_val" ] && [ "$_var" = "LINEAR_TEAM_ID" ]; then
        _val="$(env_get LINEAR_TEAM_ID)"
    fi
    if ! is_placeholder "$_val"; then
        info "export ${_var}=${_val:0:12}…  ← set in non-prod.env; also add to your shell profile"
    else
        note "${_var} must be exported before running npm run muaddib:start"
    fi
done

# ─── 5. Worker Docker image ───────────────────────────────────────────────────

step "5. Worker Docker image"

if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
    WORKER_IMAGE="${MUADDIB_PROJECT_NAME}-worker:latest"
    if docker image inspect "$WORKER_IMAGE" &>/dev/null 2>&1; then
        BUILT_AT=$(docker image inspect "$WORKER_IMAGE" \
            --format '{{.Created}}' 2>/dev/null | cut -c1-19 || echo "unknown")
        ok "${WORKER_IMAGE} exists (built ${BUILT_AT})"
        info "To rebuild after lockfile changes: npm run muaddib:build"
    else
        note "${WORKER_IMAGE} not built yet"
        if [ -t 0 ]; then
            ask "Build it now? Takes ~3–5 min on first run. [y/N]"
            read -r _yn; echo
            if [[ "${_yn:-}" =~ ^[Yy]$ ]]; then
                cd "$REPO_ROOT"
                docker build -f muaddib/Dockerfile.worker -t "$WORKER_IMAGE" .
                ok "${WORKER_IMAGE} built"
            else
                info "Build later: npm run muaddib:build"
            fi
        else
            info "Build when ready: npm run muaddib:build"
        fi
    fi
else
    info "Skipped — Docker not available."
fi

# ─── summary ──────────────────────────────────────────────────────────────────

printf "\n${BOLD}Summary${RESET}\n"

if [ "$ERRORS" -eq 0 ] && [ "$WARNINGS" -eq 0 ]; then
    printf "${GREEN}Everything looks good.${RESET}\n\n"
elif [ "$ERRORS" -eq 0 ]; then
    printf "${YELLOW}%d warning(s) — workers will run but some features may be limited.${RESET}\n\n" "$WARNINGS"
else
    printf "${RED}%d error(s)${RESET} and ${YELLOW}%d warning(s)${RESET} — fix errors and re-run.\n\n" "$ERRORS" "$WARNINGS"
fi

printf "Spawn a worker  : npm run muaddib QUO-<number>\n"
printf "Monitor fleet   : ./muaddib/bin/attend.sh\n"
printf "\n"
printf "Dispatch daemon (requires LINEAR_API_KEY + LINEAR_TEAM_ID in shell):\n"
printf "  Start : npm run muaddib:start\n"
printf "  Stop  : npm run muaddib:stop\n"
printf "  Logs  : docker compose -p %s-dispatch -f muaddib/docker-compose.dispatch.yml logs -f\n" "${MUADDIB_PROJECT_NAME}"
printf "\n"
