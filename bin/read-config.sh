#!/usr/bin/env bash
# Read .muaddib.json and export MUADDIB_PROJECT_NAME + MUADDIB_CONFIG_FILE.
# Source this script — do not execute directly.

_MUADDIB_BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# When muaddib is a git submodule, --show-superproject-working-tree returns the
# parent repo root. Falls back to --show-toplevel (plain subdirectory) then relative path.
REPO_ROOT="${MUADDIB_REPO:-$(git -C "$_MUADDIB_BIN_DIR" rev-parse --show-superproject-working-tree 2>/dev/null)}"
REPO_ROOT="${REPO_ROOT:-$(git -C "$_MUADDIB_BIN_DIR" rev-parse --show-toplevel 2>/dev/null)}"
REPO_ROOT="${REPO_ROOT:-$(cd "$_MUADDIB_BIN_DIR/../.." && pwd)}"
export REPO_ROOT
_MUADDIB_CONFIG="$REPO_ROOT/.muaddib.json"

if ! command -v jq &>/dev/null || [ ! -f "$_MUADDIB_CONFIG" ]; then
    export MUADDIB_PROJECT_NAME="quotethat"
    return 0 2>/dev/null || true
fi

MUADDIB_PROJECT_NAME="$(jq -r '.projectName' "$_MUADDIB_CONFIG")"
export MUADDIB_PROJECT_NAME
export MUADDIB_CONFIG_FILE="$_MUADDIB_CONFIG"
