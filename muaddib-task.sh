#!/usr/bin/env bash
# Spawn an isolated worker that runs a free-form task through the real
# feature.json workflow, via TICKET_SOURCE=raw (services/ticket-source/raw.js
# synthesizes a ticket from the task text — no external ticket needed).
#   npm run run-task "fix the auth token expiry bug in the portal"
#   ./run-task.sh "fix the auth token expiry bug in the portal"
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/bin/read-config.sh"
TASK="${*:-}"
[ -n "$TASK" ] || { echo "usage: ./muaddib-task.sh <task description>" >&2; exit 1; }

# Pick the lowest worker number not currently running (by compose project label).
N=1
while [ "$N" -le 64 ] \
    && [ -n "$(docker ps -q --filter "label=com.docker.compose.project=${MUADDIB_PROJECT_NAME}-w${N}" 2>/dev/null)" ]; do
    N=$((N + 1))
done

echo "→ muaddib-task on worker ${N}: ${TASK}"

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

exec "$DIR/bin/spawn-worker.sh" "$N" "$TASK"
