#!/usr/bin/env bash
# Read .muaddib.json and export MUADDIB_PROJECT_NAME + MUADDIB_CONFIG_FILE + MUADDIB_MODEL.
# Source this script — do not execute directly.

_MUADDIB_BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# When muaddib is a git submodule, --show-superproject-working-tree returns the
# parent repo root. Falls back to --show-toplevel (plain subdirectory) then relative path.
REPO_ROOT="${MUADDIB_REPO:-$(git -C "$_MUADDIB_BIN_DIR" rev-parse --show-superproject-working-tree 2>/dev/null)}"
REPO_ROOT="${REPO_ROOT:-$(git -C "$_MUADDIB_BIN_DIR" rev-parse --show-toplevel 2>/dev/null)}"
REPO_ROOT="${REPO_ROOT:-$(cd "$_MUADDIB_BIN_DIR/../.." && pwd)}"
export REPO_ROOT
_MUADDIB_CONFIG="$REPO_ROOT/.muaddib.json"

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
# available, even along the degraded-fallback path.
muaddib_worker_port() {
    local base="$1" label="$2" worker="$3"
    : "${base:?set .muaddib.json workerPorts.$label}"
    echo $((base + worker))
}

if ! command -v jq &>/dev/null || [ ! -f "$_MUADDIB_CONFIG" ]; then
    if ! command -v jq &>/dev/null; then
        echo "muaddib: jq not found on PATH — install it (brew install jq)." \
            ".muaddib.json can't be read without it, so worker ports etc. won't resolve." >&2
    fi
    export MUADDIB_PROJECT_NAME="quotethat"
    export MUADDIB_PORT_API="" MUADDIB_PORT_DB="" MUADDIB_PORT_SKETCH=""
    return 0 2>/dev/null || true
fi

MUADDIB_PROJECT_NAME="$(jq -r '.projectName' "$_MUADDIB_CONFIG")"
export MUADDIB_PROJECT_NAME
export MUADDIB_CONFIG_FILE="$_MUADDIB_CONFIG"

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
