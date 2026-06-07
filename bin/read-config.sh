#!/usr/bin/env bash
# Read .muaddib.json and export MUADDIB_PROJECT_NAME + MUADDIB_CONFIG_FILE.
# Source this script — do not execute directly.

_MUADDIB_BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_MUADDIB_REPO_ROOT="$(cd "$_MUADDIB_BIN_DIR/../.." && pwd)"
_MUADDIB_CONFIG="$_MUADDIB_REPO_ROOT/.muaddib.json"

if ! command -v jq &>/dev/null || [ ! -f "$_MUADDIB_CONFIG" ]; then
    export MUADDIB_PROJECT_NAME="quotethat"
    return 0 2>/dev/null || true
fi

MUADDIB_PROJECT_NAME="$(jq -r '.projectName' "$_MUADDIB_CONFIG")"
export MUADDIB_PROJECT_NAME
export MUADDIB_CONFIG_FILE="$_MUADDIB_CONFIG"
