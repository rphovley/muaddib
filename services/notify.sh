#!/usr/bin/env bash
# Desktop notification hook — called by runner.js (fireNotification) when a
# workflow step needs a human, warns it's slow, or reports quiet progress.
#
# Renders the shared notification object orchestrator/notify-format.js builds:
# an enriched title (project + ticket) and a per-kind subtitle.
#
# Usage: notify.sh <worker> <title> <subtitle> [tier] [sound]
#   tier  — "alert" (default) or "info" (quiet progress; no sound)
#   sound — macOS sound name for alerts (default "Glass"); ignored for info
#
# Backwards-tolerant: the legacy two-arg form  notify.sh <worker> <message>  is
# still honored — the message becomes the subtitle under a generic title. Always
# echoes to stdout so the log captures the notification regardless of platform;
# fires a macOS notification when osascript is available.

WORKER="${1:-0}"

if [ "$#" -ge 3 ]; then
  TITLE="${2}"
  SUBTITLE="${3}"
  TIER="${4:-alert}"
  SOUND="${5:-}"
else
  # Legacy two-arg call: notify.sh <worker> <message>.
  TITLE="muaddib: worker-${WORKER}"
  SUBTITLE="${2:-}"
  TIER="alert"
  SOUND=""
fi

echo "[notify w${WORKER}] ${TITLE} — ${SUBTITLE}"

# Escape for embedding inside an AppleScript double-quoted string literal:
# backslash first, then double-quote. Prevents osascript breakage/injection from
# ticket titles that contain quotes or backslashes.
applescript_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

TITLE_ESC="$(applescript_escape "$TITLE")"
SUBTITLE_ESC="$(applescript_escape "$SUBTITLE")"

# Quiet progress (info tier) makes no sound; alerts use the caller's sound,
# falling back to Glass.
if [ "$TIER" = "info" ]; then
  SOUND_CLAUSE=""
elif [ -n "$SOUND" ]; then
  SOUND_CLAUSE=" sound name \"$(applescript_escape "$SOUND")\""
else
  SOUND_CLAUSE=" sound name \"Glass\""
fi

osascript -e "display notification \"${SUBTITLE_ESC}\" with title \"${TITLE_ESC}\"${SOUND_CLAUSE}" 2>/dev/null || true
