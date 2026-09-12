#!/usr/bin/env bash
# Provision and launch one isolated worker.
#   ./spawn-worker.sh <worker-number> [initial task prompt...]
#
# Ports: base + worker number, bases come from .muaddib/manifest.json's workerPorts
# (no defaults baked in here — see read-config.sh / README "Port scheme").
# Secrets: subscription token comes from your shell env or ~/.muaddib/conductor-secrets.env;
# GitHub token and non-prod app secrets come from a local .muaddib/secrets.env,
# injected as VALUES into the container.
set -euo pipefail

BIN_DIR="$(cd "$(dirname "$0")" && pwd)"
FLEET_DIR="$(cd "$BIN_DIR/.." && pwd)"
source "$FLEET_DIR/bin/read-config.sh"
source "$FLEET_DIR/bin/image-needs-rebuild.sh"
source "$FLEET_DIR/bin/worker-alloc.sh"
source "$FLEET_DIR/bin/herdr-exec.sh"
cd "$FLEET_DIR"

# When spawn-worker.sh is called from inside the dispatch Docker container
# (docker.sock bind-mounted), `docker compose` sends volume-mount paths to the
# HOST daemon, which resolves them on the host filesystem — not the container's.
# HOST_FLEET_DIR is the real host path to muaddib/; dispatch.sh sets it via env.
HOST_FLEET_DIR="${HOST_FLEET_DIR:-$FLEET_DIR}"

# The leading worker-number argument is now an optional *hint* (empty = auto).
# The real slot is chosen below under the allocation lock — a stale hint from a
# wrapper or the daemon can never cause a collision, because muaddib_select_worker
# always advances past any slot that's actually up. This preserves the existing
# "<worker-number> [task...]" arg shape (the daemon and fleet-control still pass a
# number).
WORKER_HINT="${1:-}"
shift || true
TASK="${*:-}"
if [ -n "$WORKER_HINT" ] && ! [[ "$WORKER_HINT" =~ ^[0-9]+$ ]]; then
    echo "worker-number hint must be an integer (or empty to auto-select)" >&2
    exit 1
fi

# Build the shared worker image if it's missing or stale, BEFORE taking the
# allocation lock — a cold build can take minutes and must NOT run while the lock
# is held (that would time every concurrent dispatch out after MUADDIB_ALLOC_TIMEOUT
# even while slots are free). The image tag is shared across all slots, so building
# here (not per-slot) is correct; two concurrent cold dispatches simply rebuild the
# same tag, which docker/BuildKit tolerate and cache. worker-entrypoint.sh and
# claude/ aren't re-synced from git at container runtime the way the rest of the
# repo is — see bin/image-needs-rebuild.sh for why this can't just be "does the tag
# exist". To force a rebuild regardless: `docker rmi ${MUADDIB_PROJECT_NAME}-worker:latest`.
export MUADDIB_WORKER_IMAGE="${MUADDIB_PROJECT_NAME}-worker:latest"
WORKER_DOCKERFILE="$(muaddib_worker_dockerfile "$FLEET_DIR" "$REPO_ROOT")"
MUADDIB_DOCKER_PREFIX="$(muaddib_docker_prefix "$REPO_ROOT")"
MUADDIB_BUILD_HASH="$(muaddib_image_build_hash "$FLEET_DIR" "$WORKER_DOCKERFILE")"

if muaddib_image_needs_rebuild "$MUADDIB_WORKER_IMAGE" "$MUADDIB_BUILD_HASH"; then
    echo "→ Building worker image (missing or stale)…"
    docker build -f "$FLEET_DIR/Dockerfile.base" -t muaddib-base:latest "$REPO_ROOT"
    docker build --build-arg "MUADDIB_PREFIX=$MUADDIB_DOCKER_PREFIX" \
        --label "muaddib.build-hash=$MUADDIB_BUILD_HASH" \
        -f "$WORKER_DOCKERFILE" -t "$MUADDIB_WORKER_IMAGE" "$REPO_ROOT"
fi

# Serialize slot allocation across every dispatch path. The lock is held from the
# `docker ps` scan (muaddib_select_worker) through `docker compose up -d` (the
# actual claim) and released immediately after — exactly the check-then-claim
# window that races. The lock file lives under status/, which is bind-mounted into
# the dispatch container (docker-compose.dispatch.yml `..:/repo`), so a host
# dispatch and a daemon dispatch share the same lock. status/ must exist first —
# create it here (the later chmod-777 setup is now redundant of this).
mkdir -p "$FLEET_DIR/status" && chmod 777 "$FLEET_DIR/status" 2>/dev/null || true
muaddib_alloc_lock "$FLEET_DIR/status/.worker-alloc.lock" || exit 1
WORKER="$(muaddib_select_worker "${WORKER_HINT:-1}")" || {
    echo "✗ No free worker slot — all ${MUADDIB_MAX_WORKERS:-64} are in use." >&2
    muaddib_alloc_unlock
    exit 1
}

# Emit the real slot for non-interactive dispatchers (the dispatch daemon): the
# leading arg was only a hint, and the allocator may have advanced past it to a
# free slot, so a caller must learn the slot actually claimed here — otherwise it
# logs, attaches, or tears down the wrong worker. Interactive runs already show
# the slot in the human-readable lines below.
[ "${MUADIB_NO_ATTACH:-0}" = "1" ] && echo "WORKER_SLOT=${WORKER}"

API_PORT=$(muaddib_worker_port "$MUADDIB_PORT_API" api "$WORKER")
DB_PORT=$(muaddib_worker_port "$MUADDIB_PORT_DB" db "$WORKER")
SKETCH_PORT=$(muaddib_worker_port "$MUADDIB_PORT_SKETCH" sketch "$WORKER")
PROJECT="${MUADDIB_PROJECT_NAME}-w${WORKER}"
BRANCH="agent/w${WORKER}/$(date -u +%Y%m%d-%H%M%S)"

# --- host-provided inputs ---
REPO_URL="${REPO_URL:-$(git -C "$REPO_ROOT" remote get-url origin \
    | sed -E 's#^git@github.com:#github.com/#; s#^https://##; s#^http://##')}"
CLAUDE_SKILLS_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"

# Merge personal skills from host with fleet skills from this repo. Fleet
# skills take precedence so /muaddib and its variants are always current.
MERGED_SKILLS="$FLEET_DIR/status/.skills-${WORKER}"
rm -rf "$MERGED_SKILLS" && mkdir -p "$MERGED_SKILLS"
[ -d "$CLAUDE_SKILLS_DIR" ] && cp -r "$CLAUDE_SKILLS_DIR/." "$MERGED_SKILLS/"
cp -r "$FLEET_DIR/claude/skills/." "$MERGED_SKILLS/"

# `cp -r SRC/. DST` exits 0 even when SRC is transiently empty (a concurrent
# git/submodule op on this shared tree, a bind-mount consistency lag) — under
# `set -e` that silent no-op never surfaces as a failure, so a worker can boot
# fully "successfully" with zero skills and every "/skill" invocation for its
# entire run then fails with "Unknown command" (QUO-543 postmortem: no error,
# no daemon log, hours of work with none of the fleet skills ever loaded).
# Verify the copy actually landed the expected skills before going any
# further, and dump enough state to diagnose the source-side race if it
# recurs — this check is the only thing that will have caught it.
FLEET_SKILL_COUNT=$(find "$FLEET_DIR/claude/skills" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
MERGED_SKILL_COUNT=$(find "$MERGED_SKILLS" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
if [ "$MERGED_SKILL_COUNT" -eq 0 ] || [ "$MERGED_SKILL_COUNT" -lt "$FLEET_SKILL_COUNT" ]; then
    {
        echo "✗ Skill provisioning failed for worker ${WORKER}: expected ${FLEET_SKILL_COUNT} fleet skill(s)"
        echo "  from ${FLEET_DIR}/claude/skills but only ${MERGED_SKILL_COUNT} landed in ${MERGED_SKILLS}."
        echo "  cp -r did not error — its source read as empty or partial at copy time. Diagnostics:"
        echo "  --- ls -la \$FLEET_DIR/claude/skills ---"
        ls -la "$FLEET_DIR/claude/skills" 2>&1
        echo "  --- ls -la \$MERGED_SKILLS ---"
        ls -la "$MERGED_SKILLS" 2>&1
        echo "  --- git -C \$FLEET_DIR status --short ---"
        git -C "$FLEET_DIR" status --short 2>&1
        echo "  --- git -C \$FLEET_DIR log -1 --format='%H %ci %s' ---"
        git -C "$FLEET_DIR" log -1 --format='%H %ci %s' 2>&1
        echo "  Aborting before docker compose up — no half-provisioned worker will be created."
    } >&2
    exit 1
fi

# Use the host-side path so docker compose mounts the right directory on the host.
CLAUDE_SKILLS_DIR="$HOST_FLEET_DIR/status/.skills-${WORKER}"

# Backfill from file if the invoking shell doesn't already have these (shell
# env still wins — see bin/load-env-file.sh). CLAUDE_CODE_OAUTH_TOKEN is
# account-level (~/.muaddib/conductor-secrets.env, not tied to any one repo);
# GITHUB_TOKEN is project-scoped (a PAT limited to this repo), so it comes
# from the project's own .muaddib/secrets.env — the same file read as
# SHARED_ENV below for non-prod app config.
source "$FLEET_DIR/bin/load-env-file.sh"
muaddib_load_env_file "$HOME/.muaddib/conductor-secrets.env"
muaddib_load_env_file "$REPO_ROOT/.muaddib/secrets.env"

: "${CLAUDE_CODE_OAUTH_TOKEN:?export your subscription token first: run 'claude setup-token'}"
: "${GITHUB_TOKEN:?export a repo-scoped GitHub token (push branches + open PRs only)}"

# --- non-prod app secrets: a local dotenv file (dev/local values only) ---
SHARED_ENV="${WORKER_SHARED_ENV:-$REPO_ROOT/.muaddib/secrets.env}"
[ -f "$SHARED_ENV" ] || {
    echo "missing ${SHARED_ENV} — copy .muaddib/secrets.env.example to .muaddib/secrets.env and fill it in" >&2
    exit 1
}
# Per-worker env file lives under the account-level dir (~/.muaddib/<project>/
# workers/), never in the repo tree — it carries the subscription + GitHub tokens
# and is regenerated every spawn. MUADDIB_WORKERS_DIR comes from read-config.sh.
mkdir -p "$MUADDIB_WORKERS_DIR"
ENV_FILE="$MUADDIB_WORKERS_DIR/.worker-${WORKER}.env"
cp "$SHARED_ENV" "$ENV_FILE"
# Guard against a missing trailing newline in secrets.env — without this, the
# append below would land on the end of its last line and corrupt both values
# (e.g. STRIPE_CONNECT_STATE_SECRET=xxxxCLAUDE_CODE_OAUTH_TOKEN=sk-ant-xxxx).
printf '\n' >>"$ENV_FILE"

# Append worker-specific dynamic values. If the project supplies a DB compose
# overlay (see read-config.sh's MUADDIB_COMPOSE_OVERLAY), its PG_*/DATABASE_URL
# `environment:` block overrides this env_file, force-pointing the DB connection
# at the local sidecar regardless of what's in secrets.env — but that guarantee
# lives in the project's overlay, not in this generic base file.
cat >>"$ENV_FILE" <<EOF
CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN}
GITHUB_TOKEN=${GITHUB_TOKEN}
REPO_URL=${REPO_URL}
BRANCH=${BRANCH}
WORKER_INDEX=${WORKER}
TASK="${TASK}"
CLAUDE_PERMISSION_MODE=${CLAUDE_PERMISSION_MODE:-bypassPermissions}
NODE_ENV=development
MUADDIB_PROJECT_NAME=${MUADDIB_PROJECT_NAME}
EOF

# Slack notifications (optional). SLACK_WEBHOOK_URL is account-level — it comes
# from ~/.muaddib/conductor-secrets.env (loaded above) like CLAUDE_CODE_OAUTH_TOKEN —
# so forward it into the worker only when it's actually set. notify.js no-ops
# cleanly when it's absent, so an unconfigured fleet is unaffected.
[ -n "${SLACK_WEBHOOK_URL:-}" ] && echo "SLACK_WEBHOOK_URL=${SLACK_WEBHOOK_URL}" >>"$ENV_FILE"
if [ -n "${WORKFLOW_FILE:-}" ]; then
  # muaddib-fast.sh / muaddib-plan.sh already set the worker path directly.
  # The dispatch daemon sets the dispatch container path (/repo/...) — translate
  # it to the worker container path (/home/worker/repo/...).
  case "$WORKFLOW_FILE" in
    "${REPO_ROOT}"/*)
      echo "WORKFLOW_FILE=/home/worker/repo/${WORKFLOW_FILE#"${REPO_ROOT}/"}" >>"$ENV_FILE" ;;
    *)
      echo "WORKFLOW_FILE=${WORKFLOW_FILE}" >>"$ENV_FILE" ;;
  esac
fi

# Let LINEAR_API_KEY come from the shell env too (overrides .muaddib/secrets.env if set).
[ -n "${LINEAR_API_KEY:-}" ] && echo "LINEAR_API_KEY=${LINEAR_API_KEY}" >>"$ENV_FILE"

# Ticket source selection. An explicit env var wins (muaddib-task.sh sets these
# for free-form/raw dispatch); otherwise default from the committed manifest
# (MUADDIB_TICKET_SOURCE, via read-config.sh) so the project's declared backend
# takes effect without an env override.
echo "TICKET_SOURCE=${TICKET_SOURCE:-$MUADDIB_TICKET_SOURCE}" >>"$ENV_FILE"
[ -n "${TICKET_IDENTIFIER:-}" ] && echo "TICKET_IDENTIFIER=${TICKET_IDENTIFIER}" >>"$ENV_FILE"
# GitHub identifiers come from the committed manifest (via read-config.sh) so the
# github backend has its owner/repo inside the worker (empty for Linear projects).
# Sourced from the manifest only — unlike TICKET_SOURCE there's no flow that sets
# these as env vars, so a generically-named ambient GITHUB_OWNER/GITHUB_REPO must
# not silently override the project's declared identifiers.
[ -n "$MUADDIB_GITHUB_OWNER" ] && echo "GITHUB_OWNER=${MUADDIB_GITHUB_OWNER}" >>"$ENV_FILE"
[ -n "$MUADDIB_GITHUB_REPO" ] && echo "GITHUB_REPO=${MUADDIB_GITHUB_REPO}" >>"$ENV_FILE"

# Pin the Claude Code model (from .muaddib/manifest.json "model", via read-config.sh).
# Applies to every `claude` call in the container — orchestrator task steps and
# interactive sessions alike — since this env file is the container's env_file.
[ -n "${MUADDIB_MODEL:-}" ] && echo "ANTHROPIC_MODEL=${MUADDIB_MODEL}" >>"$ENV_FILE"

chmod 600 "$ENV_FILE"

export WORKER_API_PORT="$API_PORT" WORKER_DB_PORT="$DB_PORT" WORKER_SKETCH_PORT="$SKETCH_PORT" \
    WORKER_ENV_FILE="$ENV_FILE" WORKER_INDEX="$WORKER" \
    CLAUDE_SKILLS_DIR="$CLAUDE_SKILLS_DIR" \
    HOST_TMPDIR="${HOST_TMPDIR:-${TMPDIR:-/tmp}}" \
    HOST_DESKTOP="${HOST_DESKTOP:-$HOME/Desktop}"

STATE_FILE="$FLEET_DIR/status/worker-${WORKER}.state"
: >"$STATE_FILE" # clear any stale state from a previous run

echo "→ Spawning ${PROJECT}: API :${API_PORT}  DB :${DB_PORT}  sketch :${SKETCH_PORT}  branch ${BRANCH}"

# MUADDIB_COMPOSE_FILES (base + project overlay, if any) comes from
# read-config.sh — teardown-worker.sh must use the exact same list.
docker compose -p "$PROJECT" \
    --project-directory "$HOST_FLEET_DIR" \
    "${MUADDIB_COMPOSE_FILES[@]}" up -d

# Capture container ID immediately — before it can be removed on fast exit.
WORKER_CID=$(docker compose -p "$PROJECT" \
    --project-directory "$HOST_FLEET_DIR" \
    "${MUADDIB_COMPOSE_FILES[@]}" ps -q worker 2>/dev/null | head -1)

# Claim complete (slot is now backed by a running compose project). Release the
# allocation lock so other dispatches can proceed — the provisioning wait below
# (clone + deps + MCP, up to 5 min) must NOT hold the mutex.
muaddib_alloc_unlock

# Wait for the worker to finish provisioning (clone + deps + MCP). If it dies,
# surface its logs to THIS console instead of reporting a false "up".
echo "→ provisioning (clone + deps + MCP)…"
SECONDS=0
while :; do
    # READY      = interactive mode (no TASK set)
    # RUNNING / FEEDBACK* = task mode: orchestrator past provisioning
    case "$(cut -d' ' -f1 "$STATE_FILE" 2>/dev/null || true)" in
        READY|RUNNING|FEEDBACK|FEEDBACK_WORKING) break ;;
    esac
    if [ -z "$(docker ps -q --filter "label=com.docker.compose.project=${PROJECT}" --filter "name=worker")" ]; then
        {
            echo
            echo "✗ Worker ${WORKER} exited during provisioning. Last log lines:"
            echo "────────────────────────────────────────────────────────────"
            docker logs "${WORKER_CID}" 2>&1 | tail -30
            echo "────────────────────────────────────────────────────────────"
            echo "Fix the cause, then:  ./bin/teardown-worker.sh ${WORKER}  &&  re-run."
        } >&2
        exit 1
    fi
    if [ "$SECONDS" -ge 300 ]; then
        echo "✗ Worker ${WORKER} not READY after ${SECONDS}s. Recent logs:" >&2
        docker logs "${WORKER_CID}" 2>&1 | tail -30 >&2
        echo "(container still running — attach to inspect)" >&2
        exit 1
    fi
    sleep 2
done

echo
echo "✓ Worker ${WORKER} up and READY."

# Events-file watcher: tails the JSONL event bus written by the orchestrator
# inside the container.
EVENTS_FILE="$FLEET_DIR/status/worker-${WORKER}.events"
# Written by the herdr integration below, once (and if) it creates a pane for
# this worker — the watcher starts before that block runs, so it re-reads this
# file per-event rather than capturing a pane id up front. Absent/empty simply
# means herdr isn't in play for this worker; reporting is skipped, nothing else
# in the watcher depends on it.
HERDR_PANE_FILE="$FLEET_DIR/status/worker-${WORKER}.herdr-pane"
rm -f "$HERDR_PANE_FILE"
(
    # Wait up to 60 s for the events file to appear (created at first orchestrator emit).
    for _i in $(seq 1 60); do
        [ -f "$EVENTS_FILE" ] && break
        sleep 1
    done
    [ -f "$EVENTS_FILE" ] || exit 0  # container exited before events were written

    # Parse orchestrator state from a JSONL line using node (always available).
    _parse_state() {
        node -e "
          try {
            const e = JSON.parse(process.argv[1]);
            if (e.job === 'orchestrator' && e.event === 'state_changed')
              process.stdout.write(e.payload.state || '');
          } catch (_) {}
        " "$1" 2>/dev/null || true
    }

    while IFS= read -r _ev_line; do
        _state=$(_parse_state "$_ev_line")
        [ -z "$_state" ] && continue

        _notify_body="" _notify_mac_sound="" _notify_herdr_sound=""
        case "$_state" in
            WAITING_FOR_INPUT) _notify_body="Questions posted to Linear — needs your answers" ; _notify_mac_sound="Glass" ; _notify_herdr_sound="request" ;;
            BLOCKED)           _notify_body="Waiting for your input" ; _notify_mac_sound="Glass" ; _notify_herdr_sound="request" ;;
            FEEDBACK)          _notify_body="Preview live — waiting for feedback" ; _notify_mac_sound="Glass" ; _notify_herdr_sound="request" ;;
            FEEDBACK_WORKING)  _notify_body="Addressing PR feedback" ; _notify_mac_sound="Glass" ; _notify_herdr_sound="request" ;;
            AWAITING_REVIEW)   _notify_body="A workflow step needs your input" ; _notify_mac_sound="Glass" ; _notify_herdr_sound="request" ;;
            DONE_FINAL)        _notify_body="PR merged — preview torn down ✓" ; _notify_mac_sound="Glass" ; _notify_herdr_sound="done" ;;
            FAILED)            _notify_body="Worker ${WORKER} failed — check muaddib/status/ logs, then teardown-worker.sh ${WORKER}" ; _notify_mac_sound="Basso" ; _notify_herdr_sound="request" ;;
        esac
        if [ -n "$_notify_body" ]; then
            # Native macOS banner — works from an interactive host dispatch
            # regardless of whether herdr (or any terminal) is in view. A no-op
            # (osascript isn't on PATH) when this watcher runs inside the
            # dispatch container, same as before.
            osascript -e "display notification \"${_notify_body}\" with title \"muaddib: worker-${WORKER}\" sound name \"${_notify_mac_sound}\"" 2>/dev/null || true
            # herdr's own notification — the one path that also reaches a
            # daemon-spawned worker, since osascript can't run in that
            # container at all (see herdr_available in bin/herdr-exec.sh).
            herdr_available && herdr_exec notification show "muaddib: worker-${WORKER}" \
                --body "$_notify_body" --sound "$_notify_herdr_sound" >/dev/null 2>&1 || true
        fi

        # Push the orchestrator's own (authoritative — not pane-text guesswork)
        # state to herdr, if a pane exists for this worker. herdr's report-agent
        # only accepts idle|working|blocked|unknown, so orchestrator states that
        # mean "needs a human" collapse to blocked; states that mean "still going"
        # collapse to working; finished/idle states collapse to idle. FAILED maps
        # to blocked too — it needs a human, same as an approval/question would.
        _herdr_pane="$(cat "$HERDR_PANE_FILE" 2>/dev/null || true)"
        if [ -n "$_herdr_pane" ] && herdr_available; then
            case "$_state" in
                RUNNING|FEEDBACK_WORKING)                       _herdr_state=working ;;
                WAITING_FOR_INPUT|BLOCKED|FEEDBACK|AWAITING_REVIEW|FAILED) _herdr_state=blocked ;;
                READY|DONE|DONE_FINAL)                          _herdr_state=idle ;;
                *)                                               _herdr_state="" ;;
            esac
            [ -n "$_herdr_state" ] && herdr_exec pane report-agent "$_herdr_pane" \
                --source muaddib-worker --agent claude --state "$_herdr_state" \
                --message "$_state" >/dev/null 2>&1 || true
        fi

        case "$_state" in
            DONE|DONE_FINAL)
                echo "→ Worker ${WORKER} finished (${_state}) — tearing down..."
                "$BIN_DIR/teardown-worker.sh" "$WORKER" 2>/dev/null || true
                break
                ;;
            FAILED)
                echo "→ Worker ${WORKER} FAILED — logs at muaddib/status/worker-${WORKER}-*.log"
                echo "   Inspect, then run: ./bin/teardown-worker.sh ${WORKER}"
                break
                ;;
        esac
    done < <(tail -n 0 -f "$EVENTS_FILE" 2>/dev/null)
) &
disown $!

# Switch to the most recently created window (current job) before attaching, so
# whoever looks at this session lands on the Claude session, not the base shell.
docker exec "${WORKER_CID}" tmux select-window -t "w${WORKER}:{end}" 2>/dev/null || true

# Herdr integration (optional): if herdr is available, land the worker's
# session in its own herdr tab instead of blocking this terminal — dispatch
# stays free for the next command. The target workspace is resolved by LABEL
# (defaulting to the project name — override with MUADDIB_HERDR_LABEL), never a
# stored ID: herdr workspace IDs are assigned per server session and are not
# expected to survive a herdr restart, so pinning one in a dotfile would
# silently go stale. Looked up fresh on every dispatch, created on first use if
# it doesn't exist yet — no setup step. Falls straight through to the
# direct-attach path below on any failure (herdr not running, unexpected
# response shape, etc.), so an unavailable herdr never changes existing
# behavior.
#
# "Available" (herdr_available, bin/herdr-exec.sh) means either the real
# binary is on PATH (host/interactive dispatch) or the host-side bridge
# directory is mounted in (dispatch-daemon container — see herdr-bridge.sh for
# why the container can't just call the binary itself). herdr_exec picks
# whichever applies transparently.
#
# Deliberately NOT gated on MUADIB_NO_ATTACH: that flag exists so a programmatic
# caller (fleet-control.js, the dispatch daemon) never gets wedged by the
# blocking direct `tmux attach` further below — see fleet-control.js's spawn().
# herdr pane creation is async either way (`pane run` fires the command into a
# separate pane and returns immediately), so it never blocks the caller and
# should run for daemon-spawned workers too, not just interactive dispatch —
# that's what gives every in-flight worker a herdr pane without anyone having to
# attach first.
if herdr_available; then
    HERDR_LABEL="${MUADDIB_HERDR_LABEL:-$MUADDIB_PROJECT_NAME}"
    WORKSPACE_ID="$(herdr_exec workspace list 2>/dev/null \
        | jq -r --arg want "$HERDR_LABEL" \
            '(.result.workspaces // [])[] | select(.label==$want) | .workspace_id' 2>/dev/null \
        | head -1)"

    # herdr's left-hand "agents" sidebar renders the TAB LABEL (not the pane's
    # report-metadata --title), so fold the ticket identifier into the label to
    # give each worker some context there. The ticket is the last whitespace-
    # separated token of TASK (e.g. TASK="/muaddib muaddib#151"); only accept it
    # when it looks like a real ticket id — GitHub-style "<repo>#<number>" or
    # Linear-style "<UPPER>-<number>" — so free-text/interactive spawns fall back
    # to the bare "w${WORKER}". Cap the token length so a pathological TASK can't
    # produce an unwieldy label.
    TAB_LABEL="w${WORKER}"
    TICKET="${TASK##* }"
    TICKET="${TICKET:0:40}"
    if [[ "$TICKET" =~ ^[^[:space:]]+#[0-9]+$ || "$TICKET" =~ ^[A-Z]+-[0-9]+$ ]]; then
        TAB_LABEL="w${WORKER} ${TICKET}"
    fi

    # No existing workspace for this project — create one. Creating a workspace
    # also creates one starter tab/pane (herdr's own behavior, not ours); reuse
    # THAT pane for worker 1 instead of leaving it blank and opening a second tab
    # via `tab create` below.
    PANE_ID=""
    if [ -z "$WORKSPACE_ID" ]; then
        WS_JSON="$(herdr_exec workspace create --label "$HERDR_LABEL" --no-focus 2>/dev/null || true)"
        WORKSPACE_ID="$(printf '%s' "$WS_JSON" | jq -r '.result.workspace.workspace_id // empty' 2>/dev/null)"
        PANE_ID="$(printf '%s' "$WS_JSON" | jq -r '.result.root_pane.pane_id // empty' 2>/dev/null)"
        STARTER_TAB_ID="$(printf '%s' "$WS_JSON" | jq -r '.result.tab.tab_id // empty' 2>/dev/null)"
        [ -n "$STARTER_TAB_ID" ] && herdr_exec tab rename "$STARTER_TAB_ID" "$TAB_LABEL" >/dev/null 2>&1 || true
    fi

    if [ -n "$WORKSPACE_ID" ] && [ -z "$PANE_ID" ]; then
        TAB_JSON="$(herdr_exec tab create --workspace "$WORKSPACE_ID" --label "$TAB_LABEL" --no-focus 2>/dev/null || true)"
        PANE_ID="$(printf '%s' "$TAB_JSON" | jq -r '.result.root_pane.pane_id // empty' 2>/dev/null || true)"
    fi

    if [ -n "$PANE_ID" ] \
        && herdr_exec pane run "$PANE_ID" "docker exec -it ${WORKER_CID} tmux attach -t w${WORKER}" >/dev/null 2>&1; then
        herdr_exec pane report-metadata "$PANE_ID" --source muaddib-worker --title "w${WORKER}: ${TASK:0:60}" >/dev/null 2>&1 || true
        # Seed an initial state directly — don't rely on the events watcher to
        # observe this. By the time this line runs, the worker has already passed
        # its own READY/RUNNING check (that's what let spawn-worker.sh get this
        # far), so that transition is already sitting in EVENTS_FILE. The watcher
        # below tails with `-n 0` (deliberately skips backlog, so a re-attach
        # doesn't replay old events) and starts AFTER this point, so it can never
        # observe an event that landed before it attached — the very first
        # state_changed transition is always in that backlog. Without this seed, a
        # worker that finishes cleanly without ever hitting a later distinct state
        # (WAITING_FOR_INPUT/BLOCKED/FEEDBACK/DONE/FAILED) would sit at herdr's
        # default "unknown" agent_status for its entire run.
        herdr_exec pane report-agent "$PANE_ID" --source muaddib-worker --agent claude --state working --message RUNNING >/dev/null 2>&1 || true
        # Let the events-file watcher (already running in the background, started
        # above) find this pane so it can push state via `herdr pane report-agent`.
        printf '%s' "$PANE_ID" >"$HERDR_PANE_FILE"
        echo "  Worker ${WORKER} attached in herdr (workspace \"${HERDR_LABEL}\", pane ${PANE_ID})."
        echo "  Re-attach: ./bin/attach.sh ${WORKER}  ·  Monitor: ./bin/attend.sh  ·  Stop: ./bin/teardown-worker.sh ${WORKER}"
        echo "  Sketch (UI/UX prototyping): when the agent opens one, view it at http://localhost:${SKETCH_PORT}"
        exit 0
    fi
    echo "  (herdr unavailable or tab creation failed — falling back to direct attach)" >&2
fi

# Drop straight into the agent's interactive session when we have a terminal.
# Ctrl-b then d detaches and leaves the worker running. Opt out with
# MUADIB_NO_ATTACH=1 (e.g. when fire-and-forging several workers from a script).
if [ "${MUADIB_NO_ATTACH:-0}" != "1" ] && [ -t 0 ] && [ -t 1 ]; then
    echo "  Attaching — Ctrl-b then d to detach (worker keeps running)."
    echo "  Re-attach: ./bin/attach.sh ${WORKER}  ·  Monitor: ./bin/attend.sh  ·  Stop: ./bin/teardown-worker.sh ${WORKER}"
    echo "  Sketch (UI/UX prototyping): when the agent opens one, view it at http://localhost:${SKETCH_PORT}"
    docker exec -it "${WORKER_CID}" tmux attach -t "w${WORKER}" || true
    # Restore terminal state — tmux may not have sent its cleanup sequences if the
    # container was killed before the PTY flushed (leaves mouse tracking active).
    printf '\033[?1000l\033[?1002l\033[?1003l\033[?1005l\033[?1006l'
    stty sane 2>/dev/null || true
    # After detach or task completion, teardown immediately if the task is done.
    # (The background watcher above handles the no-attach case within ~5 s.)
    state="$(cut -d' ' -f1 "$FLEET_DIR/status/worker-${WORKER}.state" 2>/dev/null || echo "")"
    if [ "$state" = "DONE" ] || [ "$state" = "FAILED" ]; then
        echo "→ Task complete — tearing down worker ${WORKER}..."
        "$BIN_DIR/teardown-worker.sh" "$WORKER" 2>/dev/null || true
    fi
    exit 0
fi

cat <<EOF
  Attach    : ./bin/attach.sh ${WORKER}
  Monitor   : ./bin/attend.sh
  Tear down : ./bin/teardown-worker.sh ${WORKER}
  Sketch    : http://localhost:${SKETCH_PORT} (once the agent opens a session)
EOF
