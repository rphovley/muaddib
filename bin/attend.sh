#!/usr/bin/env bash
# Single-pane fleet status. Reads the tiny state files the in-container hooks
# write, rings the terminal bell, and fires a macOS notification when any worker
# transitions to DONE, BLOCKED, WAITING_FOR_INPUT, or FAILED.
set -euo pipefail
FLEET_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATUS_DIR="$FLEET_DIR/status"

# Plain indexed array, not `declare -A` — labels are always "worker-N", and
# indexed arrays work on bash 3.2 (macOS's default /usr/bin/env bash), unlike
# associative arrays which need bash 4+.
prev_states=()

notify() {
    local worker_idx="$1" title="$2" body="$3"
    "$FLEET_DIR/services/notify.sh" "$worker_idx" "$title" "$body" 2>/dev/null || true
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
            idx="${label#worker-}"
            prev="${prev_states[$idx]:-}"

            if [ "$state_word" != "$prev" ]; then
                case "$state_word" in
                    DONE)              notify "$idx" "muaddib: $label" "Task complete ✓" ;;
                    DONE_FINAL)        notify "$idx" "muaddib: $label" "PR merged — tearing down ✓" ;;
                    BLOCKED)           notify "$idx" "muaddib: $label" "Waiting for your input" ;;
                    WAITING_FOR_INPUT) notify "$idx" "muaddib: $label" "Questions posted to Linear — needs answers" ;;
                    FEEDBACK)         notify "$idx" "muaddib: $label" "Preview live — waiting for feedback" ;;
                    FEEDBACK_WORKING) notify "$idx" "muaddib: $label" "Addressing PR feedback" ;;
                    AWAITING_REVIEW)   notify "$idx" "muaddib: $label" "A workflow step needs your input" ;;
                    FAILED)            notify "$idx" "muaddib: $label" "Worker failed — check logs" ;;
                esac
                prev_states[$idx]="$state_word"
            fi

            case "$state_word" in
                WAITING_FOR_INPUT) printf '  %-12s ⏳ %s\n' "$label" "$state_line" ;;
                FEEDBACK)         printf '  %-12s 🔭 %s\n' "$label" "$state_line" ;;
                FEEDBACK_WORKING) printf '  %-12s 🔧 %s\n' "$label" "$state_line" ;;
                AWAITING_REVIEW)   printf '  %-12s 🎨 %s\n' "$label" "$state_line" ;;
                *)                 printf '  %-12s %s\n'    "$label" "$state_line" ;;
            esac
        done
        if grep -lqE 'BLOCKED|FAILED|WAITING_FOR_INPUT|AWAITING_REVIEW' "${states[@]}" 2>/dev/null; then
            printf '\a' # bell
            echo
            echo "⚠ a worker needs attention (BLOCKED = answer it, FAILED = check logs,"
            echo "  WAITING_FOR_INPUT = answer questions on the Linear ticket then re-run /muaddib,"
            echo "  AWAITING_REVIEW = a workflow step is blocked on your input)."
        fi
    fi
    sleep 3
done
