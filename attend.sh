#!/usr/bin/env bash
# Single-pane fleet status. Reads the tiny state files the in-container hooks
# write, and rings the terminal bell when any worker is BLOCKED (waiting on you,
# e.g. /grill-me or a permission prompt) or WAITING_FOR_INPUT (async grill-me
# posted questions to Linear — answer them and re-run /muaddib).
set -euo pipefail
STATUS_DIR="$(cd "$(dirname "$0")" && pwd)/status"

while true; do
    clear
    echo "== agent fleet — $(date -u +%FT%TZ) =="
    shopt -s nullglob
    states=("$STATUS_DIR"/worker-*.state)
    if [ ${#states[@]} -eq 0 ]; then
        echo "(no workers running)"
    else
        for f in "${states[@]}"; do
            state_line="$(cat "$f")"
            state_word="$(cut -d' ' -f1 <<<"$state_line")"
            label="$(basename "${f%.state}")"
            if [ "$state_word" = "WAITING_FOR_INPUT" ]; then
                printf '  %-12s ⏳ %s\n' "$label" "$state_line"
            else
                printf '  %-12s %s\n' "$label" "$state_line"
            fi
        done
        if grep -lqE 'BLOCKED|FAILED|WAITING_FOR_INPUT' "${states[@]}" 2>/dev/null; then
            printf '\a' # bell
            echo
            echo "⚠ a worker needs attention (BLOCKED = answer it, FAILED = check logs,"
            echo "  WAITING_FOR_INPUT = answer questions on the Linear ticket then re-run /muaddib)."
        fi
    fi
    sleep 3
done
