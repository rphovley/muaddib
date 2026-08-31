#!/usr/bin/env bash
# Thin raw-forcing alias for muaddib.sh — dispatches a free-form task through the
# real workflow via TICKET_SOURCE=raw (services/ticket-source/raw.js synthesizes
# a ticket from the task text — no external ticket needed).
#
# muaddib.sh now auto-detects ticket-vs-task, so this alias is only needed when a
# task's text could look like a ticket reference and you want to *guarantee* raw
# dispatch (e.g. free-form text that happens to contain `QUO-123`, which the
# linear path matches anywhere in the string). All worker-picking/spawn logic
# lives in muaddib.sh; `--raw` there skips detection and forces raw.
#
#   npm run run-task "fix the auth token expiry bug in the portal"
#   ./muaddib-task.sh "fix the auth token expiry bug in the portal"
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

# muaddib.sh --raw with no argument still errors (usage-error-on-empty preserved).
exec "$DIR/muaddib.sh" --raw "$@"
