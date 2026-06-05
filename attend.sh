#!/usr/bin/env bash
# Single-pane fleet status. Reads the tiny state files the in-container hooks
# write, rings the terminal bell, and fires a macOS notification when any worker
# transitions to DONE, BLOCKED, WAITING_FOR_INPUT, or FAILED.
set -euo pipefail
STATUS_DIR="$(cd "$(dirname "$0")" && pwd)/status"

declare -A prev_states

notify() {
    local title="$1" body="$2"
    osascript -e "display notification \"$body\" with title \"$title\" sound name \"Glass\"" 2>/dev/null || true
}

while true; do
    clear
    echo "== agent fleet — $(date -u +%FT%TZ) =="
    shopt -s nullglob
    states=("$STATUS_DIR"/worker-*.state)
    if [ ${#states[@]} -eq 0 ]; then
        echo "(no workers running)"
    else
        for f in "${states[@]}"; do
            state_line="$(cat "$f" 2>/dev/null || echo "")"
            state_word="$(cut -d' ' -f1 <<<"$state_line")"
            label="$(basename "${f%.state}")"
            prev="${prev_states[$label]:-}"

            if [ "$state_word" != "$prev" ]; then
                case "$state_word" in
                    DONE)              notify "muaddib: $label" "Task complete ✓" ;;
                    BLOCKED)           notify "muaddib: $label" "Waiting for your input" ;;
                    WAITING_FOR_INPUT) notify "muaddib: $label" "Questions posted to Linear — needs answers" ;;
                    FAILED)            notify "muaddib: $label" "Worker failed — check logs" ;;
                esac
                prev_states[$label]="$state_word"
            fi

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
