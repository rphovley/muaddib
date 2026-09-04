#!/usr/bin/env bash
# Spawn an isolated worker for a ticket reference OR a free-form task — one
# entry point covering all three peer ticket sources (linear, github, raw).
#
# The argument is auto-classified: if it's a ticket reference for the project's
# declared backend (a Linear URL / TEAM-123, or — for a github project — a
# GitHub issues URL / bare issue number), the worker runs `/muaddib <ref>` and
# the manifest's `ticketSource` selects linear vs github inside the worker.
# Otherwise the argument is free-form task text and dispatches through the raw
# backend (services/ticket-source/raw.js synthesizes a ticket from the text —
# no external ticket needed), exactly as the old `muaddib-task.sh` did.
#
# Classification reuses fetch-ticket.js's extractIdentifier() rather than a
# looser bash regex, so the github bare-number discipline (#73) can't diverge:
# for github it requires the whole argument to be `#?<number>` (a stray digit in
# a sentence is correctly rejected); for linear it matches a Linear URL or a
# `TEAM-123` token. Gating on the project's single declared backend keeps the
# decision binary — a project has exactly one ticket backend, and free-form text
# is the only other possibility.
#
#   npm run muaddib <linear-url-or-id | github-issue-url-or-number | "task text">
#   ./muaddib.sh    <ticket-ref-or-task-text>
#
# A resolved ticket reference dispatches the worker immediately and
# deterministically — running this command IS the decision, so there's no
# judgment left to make (an earlier version routed it through the Conductor's
# `dispatch-decision` skill first for exactly that judgment; removed once
# every real trigger turned out to already carry an explicit human "yes").
# But the *operator* still lands in the persistent Conductor session, not the
# worker's own — the fleet manager stays the thing you interact with; use
# `./muaddib/bin/attach.sh <n>` if you want the worker's own session instead.
# Free-form task text has no ticket for the fleet manager to track, so it
# dispatches straight to the worker and auto-attaches there, unchanged.
#
# Flags (leading, before the argument):
#   --raw       Skip detection; force raw dispatch. Use when a task's text could
#               look like a ticket reference (e.g. free-form text containing
#               `QUO-123`, which the linear path matches anywhere in the string)
#               and you want to guarantee raw. `muaddib-task.sh` is a thin alias
#               for `muaddib.sh --raw`.
#   --dry-run   Print the resolved dispatch (`source=<linear|github|raw>` and the
#               exact TASK) and exit before any docker/spawn call. Also enabled
#               via MUADDIB_DRY_RUN=1. Used by scripts/test-muaddib-dispatch.sh.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

FORCE_RAW=0
DRY_RUN=0
[ "${MUADDIB_DRY_RUN:-0}" = "1" ] && DRY_RUN=1

# Parse leading flags; stop at the first non-flag argument.
while [ "$#" -gt 0 ]; do
    case "$1" in
        --raw)     FORCE_RAW=1; shift ;;
        --dry-run) DRY_RUN=1;   shift ;;
        --)        shift; break ;;
        -*)        # A hyphen-leading token is a real unknown flag only before
                   # --raw. Once --raw forces raw dispatch, detection is skipped
                   # and the rest is literal task text (which may itself start
                   # with '-'), so stop flag-parsing here instead of erroring —
                   # muaddib-task.sh relies on this for hyphen-leading task text
                   # (it forwards "$@" without inserting a '--').
                   [ "$FORCE_RAW" -eq 1 ] && break
                   echo "muaddib: unknown flag: $1" >&2; exit 2 ;;
        *)         break ;;
    esac
done

source "$DIR/bin/read-config.sh"

# Everything after the flags is the argument. Joined (`$*`) so free-form task
# text passed as multiple words still works, exactly like the old muaddib-task.sh;
# a ticket reference is a single token, so joining is a no-op for it.
ARG="$*"
[ -n "$ARG" ] || { echo "usage: ./muaddib.sh [--raw] [--dry-run] <ticket-ref-or-task-text>" >&2; exit 1; }

# Classify: reuse extractIdentifier($ARG, $MUADDIB_TICKET_SOURCE). Non-empty →
# ticket dispatch for the declared backend; empty (or --raw) → raw dispatch.
if [ "$FORCE_RAW" -eq 1 ]; then
    IDENT=""
else
    IDENT="$(node -e 'const {extractIdentifier}=require(process.argv[1]);
      process.stdout.write(extractIdentifier(process.argv[2], process.argv[3]) || "")' \
      "$DIR/scripts/fetch-ticket.js" "$ARG" "$MUADDIB_TICKET_SOURCE")"
fi

if [ -n "$IDENT" ]; then
    # Ticket dispatch: the manifest's MUADDIB_TICKET_SOURCE selects the backend
    # inside the worker (no TICKET_SOURCE override), so both the linear and
    # github ticket call shapes are preserved exactly.
    SOURCE="$MUADDIB_TICKET_SOURCE"
    TASK="/muaddib ${ARG}"
else
    # Raw dispatch: pass the text through verbatim (no /muaddib prefix).
    SOURCE="raw"
    TASK="$ARG"
fi

if [ "$DRY_RUN" -eq 1 ]; then
    printf 'source=%s\n' "$SOURCE"
    printf 'task=%s\n' "$TASK"
    exit 0
fi

echo "→ muaddib (${SOURCE}): ${ARG}"

if [ "$SOURCE" = "raw" ]; then
    # Explicit, non-empty TICKET_IDENTIFIER short-circuits orchestrator.js's
    # parseTicketId() fallback, which regexes TASK for a Linear-shaped pattern
    # ([A-Z]+-\d+) — free-form text can accidentally match that (e.g. "GPT-4",
    # "step-1") and produce a misleading fake ticket ID. "raw" is a clean,
    # unambiguous placeholder: this value only ever becomes $ARGUMENTS for
    # claude-tui skill invocations, which is documentation/display only — every
    # skill that does real work reads STATE_TICKET_IDENTIFIER/STATE_TICKET_URL/
    # STATE_TICKET_TITLE instead, already correctly populated by fetch-ticket.js's
    # raw path regardless of this value.
    export TICKET_SOURCE=raw
    export TICKET_IDENTIFIER=raw

    # No ticket for the fleet manager to track — dispatch straight to the
    # worker and auto-attach there, as always. Empty slot arg → spawn-worker.sh
    # auto-selects the slot under its allocation lock (bin/worker-alloc.sh); it
    # announces the real slot via its "→ Spawning" line.
    exec "$DIR/bin/spawn-worker.sh" "" "$TASK"
fi

# Ticket dispatch: spawn deterministically — MUADIB_NO_ATTACH=1 (spawn-worker.sh's
# own spelling) suppresses ITS auto-attach so the operator lands in the
# Conductor's session instead of the worker's own. `conductor.sh --bg --attach`
# reuses a live Conductor daemon if one is up (types the message into it and
# attaches) or starts one detached with this as its initial prompt — either
# way it's purely informational, not an instruction the Conductor needs to act
# on; the spawn already happened.
MUADIB_NO_ATTACH=1 "$DIR/bin/spawn-worker.sh" "" "$TASK"
exec "$DIR/conductor.sh" --bg --attach \
  "FYI: worker dispatched directly for ${ARG} (${TASK}). No action needed — just letting you know."
