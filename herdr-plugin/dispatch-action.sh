#!/usr/bin/env bash
# herdr action wrapper — dispatch a muaddib worker from inside herdr.
#
# This is a thin call-through, nothing more. herdr actions have no native
# input-prompt flow, so this script prompts the operator for a ticket ID (or
# free-form task text) itself, then invokes muaddib's *existing* dispatch entry
# point. It contains NO dispatch logic — it only picks which entry script to
# run and hands off. The core dispatch path (bin/spawn-worker.sh, muaddib.sh,
# the dispatch daemon) is untouched.
#
#   bash dispatch-action.sh [default|plan|fast]
#
# Invoked by herdr via the actions declared in herdr-plugin.toml. Safe to run
# by hand too (e.g. to test the wrapper without herdr) — when `herdr` isn't on
# PATH it falls back to running the dispatch directly in the current terminal.
set -euo pipefail

MODE="${1:-default}"

# Resolve this plugin dir robustly, regardless of herdr's action CWD, then step
# up to the muaddib checkout root (the plugin lives at <muaddib>/herdr-plugin/).
# Same spirit as bin/read-config.sh: never assume the caller's working dir.
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MUADDIB_DIR="$(cd "$PLUGIN_DIR/.." && pwd)"

# Map mode → the existing entry script (invoked by absolute path so it works
# from any CWD) and a human label for the pane / prompt.
case "$MODE" in
    default) ENTRY="$MUADDIB_DIR/muaddib.sh";       LABEL="muaddib" ;;
    plan)    ENTRY="$MUADDIB_DIR/muaddib-plan.sh";  LABEL="muaddib:plan" ;;
    fast)    ENTRY="$MUADDIB_DIR/muaddib-fast.sh";  LABEL="muaddib:fast" ;;
    *)
        echo "dispatch-action: unknown mode '$MODE' (expected default|plan|fast)" >&2
        exit 2
        ;;
esac

if [ ! -x "$ENTRY" ]; then
    echo "dispatch-action: cannot find dispatch entry point: $ENTRY" >&2
    exit 1
fi

# Prompt for the ticket ID / task text. plan/fast take a ticket reference;
# default (muaddib.sh) auto-detects a ticket reference vs. free-form task text.
if [ "$MODE" = "default" ]; then
    prompt="Ticket reference or task text for ${LABEL}: "
else
    prompt="Ticket reference for ${LABEL}: "
fi
printf '%s' "$prompt" >&2
IFS= read -r TICKET || true
# Trim surrounding whitespace so a stray trailing space/newline can't dispatch
# an empty argument.
TICKET="${TICKET#"${TICKET%%[![:space:]]*}"}"
TICKET="${TICKET%"${TICKET##*[![:space:]]}"}"
if [ -z "$TICKET" ]; then
    echo "dispatch-action: no ticket/task entered — aborting." >&2
    exit 1
fi

# Open a plugin-owned pane (the sanctioned primitive for a plugin's own pane —
# NOT the generic `pane run` bin/herdr-exec.sh uses) running the dispatch. This
# keeps the operator's current pane unblocked while the worker session lives in
# the new pane. Falls back to a direct in-terminal dispatch when herdr isn't
# available, so the wrapper still works when run by hand and stays zero-impact
# on a host without herdr.
#
# default mode goes through muaddib.sh's flag parser, which rejects a leading
# '-'/'--' token as an unknown flag. Insert a literal '--' guard so free-form
# task text starting with a hyphen is treated as the argument, not a flag (the
# same raw-path trick muaddib-task.sh relies on). plan/fast take a single-token
# ticket reference, so they need no guard.
if [ "$MODE" = "default" ]; then
    ENTRY_ARGS=(-- "$TICKET")
else
    ENTRY_ARGS=("$TICKET")
fi

# NOTE: the exact flags for `herdr plugin pane open` are NOT verified against
# the 0.8.0 binary (only the subcommand's existence is). The operator should
# confirm/adjust these during the live `herdr plugin link` pass — see README.md.
if command -v herdr >/dev/null 2>&1; then
    exec herdr plugin pane open --title "${LABEL} ${TICKET}" -- "$ENTRY" "${ENTRY_ARGS[@]}"
else
    echo "→ herdr not found on PATH — dispatching directly in this terminal." >&2
    exec "$ENTRY" "${ENTRY_ARGS[@]}"
fi
