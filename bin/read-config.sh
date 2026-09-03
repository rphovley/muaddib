#!/usr/bin/env bash
# Read .muaddib/manifest.json and export MUADDIB_PROJECT_NAME + MUADDIB_CONFIG_FILE + MUADDIB_MODEL.
# Source this script — do not execute directly.

_MUADDIB_BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# When muaddib is a git submodule, --show-superproject-working-tree returns the
# parent repo root. Falls back to --show-toplevel (plain subdirectory) then relative path.
REPO_ROOT="${MUADDIB_REPO:-$(git -C "$_MUADDIB_BIN_DIR" rev-parse --show-superproject-working-tree 2>/dev/null)}"
REPO_ROOT="${REPO_ROOT:-$(git -C "$_MUADDIB_BIN_DIR" rev-parse --show-toplevel 2>/dev/null)}"
REPO_ROOT="${REPO_ROOT:-$(cd "$_MUADDIB_BIN_DIR/../.." && pwd)}"
export REPO_ROOT
_MUADDIB_CONFIG="$REPO_ROOT/.muaddib/manifest.json"

# Project-supplied compose overlay: adds project-specific services/env (e.g. a
# DB sidecar) to docker-compose.worker.yml without editing the generic base
# file. See README "Project compose overlay".
export MUADDIB_COMPOSE_OVERLAY="$REPO_ROOT/.muaddib/docker/docker-compose.worker.yml"

# The `-f` flags for the worker compose stack: base file, plus the project
# overlay if it supplied one. spawn-worker.sh and teardown-worker.sh MUST both
# use this (rather than each recomputing it) — they need to agree on which
# `-f` flags a given worker was brought up with, or teardown won't know about
# (and won't tear down) the overlay's services.
MUADDIB_COMPOSE_FILES=(-f "$_MUADDIB_BIN_DIR/../docker-compose.worker.yml")
[ -f "$MUADDIB_COMPOSE_OVERLAY" ] && MUADDIB_COMPOSE_FILES+=(-f "$MUADDIB_COMPOSE_OVERLAY")

# Usage: API_PORT=$(muaddib_worker_port "$MUADDIB_PORT_API" api "$WORKER")
# Shared by spawn-worker.sh and teardown-worker.sh so the port formula can't
# drift between the two — they must agree on a given worker's ports, or
# teardown's `docker compose down` won't correctly interpolate the stack it's
# tearing down. Defined ahead of the jq/config check below so it's always
# available to callers that source successfully.
muaddib_worker_port() {
    local base="$1" label="$2" worker="$3"
    : "${base:?set .muaddib/manifest.json workerPorts.$label}"
    echo $((base + worker))
}

# No fallback: a missing manifest or missing jq means every downstream script
# (ports, project name, compose stack) is unusable, so fail loudly here rather
# than let scripts limp along with guessed/empty values. See issue #6.
if [ ! -f "$_MUADDIB_CONFIG" ]; then
    echo "muaddib: missing $_MUADDIB_CONFIG — every muaddib script needs a project-supplied manifest; see muaddib/README.md" >&2
    return 1 2>/dev/null || exit 1
fi

if ! command -v jq &>/dev/null; then
    echo "muaddib: jq not found on PATH — install it (brew install jq); .muaddib/manifest.json can't be read without it." >&2
    return 1 2>/dev/null || exit 1
fi

MUADDIB_PROJECT_NAME="$(jq -r '.projectName // empty' "$_MUADDIB_CONFIG")"
if [ -z "$MUADDIB_PROJECT_NAME" ]; then
    echo "muaddib: $_MUADDIB_CONFIG is missing \"projectName\"" >&2
    return 1 2>/dev/null || exit 1
fi
export MUADDIB_PROJECT_NAME
export MUADDIB_CONFIG_FILE="$_MUADDIB_CONFIG"

# Account-level per-project dir — mirrors ~/.muaddib/conductor-secrets.env: it
# holds muaddib state that is generated per-spawn/dispatch (per-worker env files,
# the dispatch dedup ledger) and must NEVER live in the repo tree, where it could
# be committed. Kept here — the single place MUADDIB_PROJECT_NAME is resolved — so
# spawn and teardown can't drift on the path the way they used to. Workers get
# their own subdir. MUADDIB_ACCOUNT_DIR is overridable for tests/relocation.
export MUADDIB_ACCOUNT_DIR="${MUADDIB_ACCOUNT_DIR:-$HOME/.muaddib/$MUADDIB_PROJECT_NAME}"
export MUADDIB_WORKERS_DIR="$MUADDIB_ACCOUNT_DIR/workers"

# Per-worker port bases. No defaults here — a project must supply its own
# range to avoid colliding with whatever else is running on the host. See
# README "Port scheme".
MUADDIB_PORT_API="$(jq -r '.workerPorts.api // empty' "$_MUADDIB_CONFIG")"
MUADDIB_PORT_DB="$(jq -r '.workerPorts.db // empty' "$_MUADDIB_CONFIG")"
MUADDIB_PORT_SKETCH="$(jq -r '.workerPorts.sketch // empty' "$_MUADDIB_CONFIG")"
export MUADDIB_PORT_API MUADDIB_PORT_DB MUADDIB_PORT_SKETCH

# Pin the model Claude Code uses inside workers. Without this, workers fall back
# to the account default (currently Fable 5), whose gated availability causes an
# intermittent startup banner that races with the initial /skill command and
# yields "Unknown command". Empty when unset → workers use the account default.
MUADDIB_MODEL="$(jq -r '.model // empty' "$_MUADDIB_CONFIG")"
export MUADDIB_MODEL

# Ticket backend selection. Committed in the manifest so a project *declares* its
# backend instead of relying on an ad-hoc TICKET_SOURCE env var (which still wins
# as an override where it's forwarded — see spawn-worker.sh). Default "linear"
# keeps existing manifests working. Validated here — a typo'd backend should fail
# loud, not silently fall back (matches the "no guessed/empty values" convention
# above).
MUADDIB_TICKET_SOURCE="$(jq -r '.ticketSource // "linear"' "$_MUADDIB_CONFIG")"
case "$MUADDIB_TICKET_SOURCE" in
    linear|github) ;;
    *)
        echo "muaddib: $_MUADDIB_CONFIG has invalid \"ticketSource\": \"$MUADDIB_TICKET_SOURCE\" (must be \"linear\" or \"github\")" >&2
        return 1 2>/dev/null || exit 1
        ;;
esac
export MUADDIB_TICKET_SOURCE

# GitHub backend identifiers. Empty/absent for Linear-only projects — Linear's own
# identifier stays the LINEAR_TEAM_ID secret env var, not the committed manifest.
# `// empty` so a Linear project isn't forced to carry them; when ticketSource is
# "github" both are required, so fail loud if either is missing.
MUADDIB_GITHUB_OWNER="$(jq -r '.githubOwner // empty' "$_MUADDIB_CONFIG")"
MUADDIB_GITHUB_REPO="$(jq -r '.githubRepo // empty' "$_MUADDIB_CONFIG")"
export MUADDIB_GITHUB_OWNER MUADDIB_GITHUB_REPO

if [ "$MUADDIB_TICKET_SOURCE" = "github" ] && { [ -z "$MUADDIB_GITHUB_OWNER" ] || [ -z "$MUADDIB_GITHUB_REPO" ]; }; then
    echo "muaddib: $_MUADDIB_CONFIG sets \"ticketSource\":\"github\" but is missing \"githubOwner\"/\"githubRepo\"" >&2
    return 1 2>/dev/null || exit 1
fi

# Conductor autonomy level. Committed in the manifest so a project *declares* how
# much the Conductor may act on its own before escalating to a human (see
# muaddib#121). Default "L0" (report-only) keeps existing manifests unchanged.
# Validated here — a typo'd level should fail loud, not silently downgrade the
# Conductor's authority (matches the ticketSource case above). Levels: L0
# report-only, L1 answer low-risk/informational directly, L2 act on confirmed
# outcomes, L3 fully autonomous within .muaddib/goals.md caps.
# `//` would also swallow an explicit `false` into "L0"; match the JS validator,
# which only defaults null/absent and rejects `false`, by defaulting only null.
MUADDIB_AUTONOMY_LEVEL="$(jq -r 'if .autonomyLevel == null then "L0" else .autonomyLevel end' "$_MUADDIB_CONFIG")"
case "$MUADDIB_AUTONOMY_LEVEL" in
    L0|L1|L2|L3) ;;
    *)
        echo "muaddib: $_MUADDIB_CONFIG has invalid \"autonomyLevel\": \"$MUADDIB_AUTONOMY_LEVEL\" (must be \"L0\", \"L1\", \"L2\", or \"L3\")" >&2
        return 1 2>/dev/null || exit 1
        ;;
esac
export MUADDIB_AUTONOMY_LEVEL
