#!/usr/bin/env bash
# herdr action wrapper — dispatch a muaddib worker from inside herdr.
#
# This is a thin call-through, nothing more. herdr actions have no native
# input-prompt flow, so this script prompts the operator for a ticket ID (or
# free-form task text) itself, then invokes muaddib's *existing* dispatch entry
# point. It contains NO dispatch logic — it only picks which checkout + entry
# script to run and hands off. The core dispatch path (bin/spawn-worker.sh,
# muaddib.sh, the dispatch daemon) is untouched.
#
#   bash dispatch-action.sh [default|plan|fast]
#
# Invoked by herdr via the actions declared in herdr-plugin.toml. Safe to run
# by hand too (e.g. to test the wrapper without herdr) — when `herdr` isn't on
# PATH it falls back to running the dispatch directly in the current terminal.
#
# WHICH CHECKOUT does a dispatch target? herdr registers a plugin host-globally
# (one herdr per machine), so a single linked copy of this plugin must be able
# to drive *several* muaddib checkouts at once. The target is therefore resolved
# at RUN TIME, in this priority order — see README.md ("Driving several projects
# at once"):
#   1. $MUADDIB_DIR, if the caller set it explicitly (escape hatch / tests).
#   2. herdr's active-pane CWD ($HERDR_PANE_CWD / $HERDR_CWD): walk up to the
#      nearest muaddib checkout, so a dispatch targets the repo of the pane you
#      invoked it from. (The env-var names are best-effort against herdr 0.8.0 —
#      confirm on your host; when they're absent this step is simply skipped.)
#   3. A project registry ($MUADDIB_HERDR_REGISTRY, default
#      ${XDG_CONFIG_HOME:-~/.config}/muaddib/herdr-projects): one usable entry
#      is used silently, several prompt a project picker.
#   4. Legacy: the checkout this plugin is physically linked inside
#      (<checkout>/herdr-plugin/) — the original single-project behavior.
set -euo pipefail

MODE="${1:-default}"

# Resolve this plugin dir robustly, regardless of herdr's action CWD. Same
# spirit as bin/read-config.sh: never assume the caller's working dir.
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Registry location — overridable for tests / power users.
REGISTRY="${MUADDIB_HERDR_REGISTRY:-${XDG_CONFIG_HOME:-$HOME/.config}/muaddib/herdr-projects}"

# ─── checkout resolution ─────────────────────────────────────────────────────

# Echo the nearest ancestor of $1 (inclusive) that looks like a muaddib checkout
# — i.e. has an executable muaddib.sh. Non-zero (and no output) if none is found
# on the way up to /.
find_muaddib_root() {
    local d="$1"
    [ -n "$d" ] || return 1
    d="$(cd "$d" 2>/dev/null && pwd)" || return 1
    while :; do
        [ -x "$d/muaddib.sh" ] && { printf '%s\n' "$d"; return 0; }
        [ "$d" = "/" ] && return 1
        d="$(dirname "$d")"
    done
}

# Read the registry into parallel arrays REG_NAMES / REG_DIRS. Format, one entry
# per line: "<shortname>  <absolute-path>". Blank lines and '#' comments are
# ignored; a missing file just yields empty arrays.
REG_NAMES=(); REG_DIRS=()
load_registry() {
    [ -f "$REGISTRY" ] || return 0
    local name dir
    while read -r name dir _; do
        [ -n "$name" ] || continue
        case "$name" in '#'*) continue ;; esac
        [ -n "$dir" ] || continue
        REG_NAMES+=("$name"); REG_DIRS+=("$dir")
    done < "$REGISTRY"
}

# Print a numbered picker (to stderr, so it's visible) and echo the chosen dir
# (to stdout). Reads the choice — an index or a shortname — from stdin, ahead of
# the ticket prompt. Non-zero on empty/invalid selection.
pick_project_from_registry() {
    local i choice idx
    echo "Multiple muaddib projects registered — pick one:" >&2
    for i in "${!REG_NAMES[@]}"; do
        printf '  %d) %-16s %s\n' "$((i + 1))" "${REG_NAMES[$i]}" "${REG_DIRS[$i]}" >&2
    done
    printf 'Project number or name: ' >&2
    IFS= read -r choice || true
    choice="${choice#"${choice%%[![:space:]]*}"}"
    choice="${choice%"${choice##*[![:space:]]}"}"
    [ -n "$choice" ] || { echo "dispatch-action: no project selected — aborting." >&2; return 1; }
    if [[ "$choice" =~ ^[0-9]+$ ]]; then
        idx=$((choice - 1))
        if [ "$idx" -ge 0 ] && [ "$idx" -lt "${#REG_NAMES[@]}" ]; then
            printf '%s\n' "${REG_DIRS[$idx]}"; return 0
        fi
        echo "dispatch-action: '$choice' is out of range (1-${#REG_NAMES[@]})." >&2; return 1
    fi
    for i in "${!REG_NAMES[@]}"; do
        [ "${REG_NAMES[$i]}" = "$choice" ] && { printf '%s\n' "${REG_DIRS[$i]}"; return 0; }
    done
    echo "dispatch-action: no registered project named '$choice'." >&2; return 1
}

# Resolve the target checkout per the priority order documented in the header.
resolve_muaddib_dir() {
    # 1. Explicit override.
    [ -n "${MUADDIB_DIR:-}" ] && { printf '%s\n' "$MUADDIB_DIR"; return 0; }

    # 2. herdr active-pane CWD → nearest checkout above it.
    local cwd root
    for cwd in "${HERDR_PANE_CWD:-}" "${HERDR_CWD:-}"; do
        [ -n "$cwd" ] || continue
        root="$(find_muaddib_root "$cwd")" && { printf '%s\n' "$root"; return 0; }
    done

    # 3. Registry: one entry is unambiguous; several prompt a picker.
    load_registry
    if [ "${#REG_NAMES[@]}" -eq 1 ]; then printf '%s\n' "${REG_DIRS[0]}"; return 0; fi
    if [ "${#REG_NAMES[@]}" -gt 1 ]; then pick_project_from_registry; return "$?"; fi

    # 4. Legacy: the checkout this plugin is linked inside.
    if [ -x "$PLUGIN_DIR/../muaddib.sh" ]; then (cd "$PLUGIN_DIR/.." && pwd); return 0; fi

    return 1
}

if ! MUADDIB_DIR="$(resolve_muaddib_dir)"; then
    {
        echo "dispatch-action: couldn't determine which muaddib checkout to dispatch into."
        echo "  Do one of:"
        echo "    • register your checkouts in $REGISTRY"
        echo "      (one 'shortname  /abs/path/to/checkout' per line), or"
        echo "    • link this plugin from inside a checkout's herdr-plugin/, or"
        echo "    • set MUADDIB_DIR (or let herdr pass HERDR_PANE_CWD)."
    } >&2
    exit 1
fi

# ─── dispatch ────────────────────────────────────────────────────────────────

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
