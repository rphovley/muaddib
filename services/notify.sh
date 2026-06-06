#!/usr/bin/env bash
# Notification hook — called by runner.js when any workflow job emits a
# notify event.
#
# Usage: notify.sh <worker> <message>
#
# Fires a macOS notification when osascript is available; always echoes to
# stdout so the log captures it regardless of platform.

WORKER="${1:-0}"
MSG="${2:-}"

echo "[notify w${WORKER}] ${MSG}"

osascript -e "display notification \"${MSG}\" with title \"muaddib: worker-${WORKER}\" sound name \"Glass\"" 2>/dev/null || true
