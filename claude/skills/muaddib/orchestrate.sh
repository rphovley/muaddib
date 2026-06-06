#!/usr/bin/env bash
# orchestrate.sh — fleet-specific control flow for /muaddib.
#
# Fleet variant of the muadib orchestrator. Key differences from the interactive version:
#   - Emits `implementation-fleet` (not `implementation`) in queue output.
#   - Emits NO_PAUSE directives so the LLM proceeds immediately between steps.
#
# The SKILL.md tells Claude to run each subcommand, read the directives it
# emits, and execute them immediately without pausing. The script never tries
# to invoke skills itself — only the LLM can do that.

set -euo pipefail

die() {
  echo "ERROR: $*" >&2
  exit 2
}

require_jq() {
  command -v jq >/dev/null 2>&1 || die "jq is required. Install with 'brew install jq'."
}

cmd="${1:-}"
shift || true

case "$cmd" in
  parse)
    input="${1:-}"
    [[ -n "$input" ]] || die "no Linear reference provided. Pass a URL or short ID (e.g. QUO-281)."

    if [[ "$input" =~ ^https?://linear\.app/[^/]+/issue/([A-Z]+-[0-9]+) ]]; then
      ticket_id="${BASH_REMATCH[1]}"
    elif [[ "$input" =~ ^([A-Z]+-[0-9]+)$ ]]; then
      ticket_id="${BASH_REMATCH[1]}"
    else
      die "could not parse Linear ticket ID from: $input
  Accepted formats:
    https://linear.app/<workspace>/issue/TEAM-123/<slug>
    TEAM-123"
    fi

    cat <<EOF
PARSED_TICKET: $ticket_id
NO_PAUSE: do not end the turn — proceed immediately to Step 2
INVOKE_SKILL: prepare-feast $ticket_id
EXPECT_RETURN: JSON array of ticket IDs (parent or sub-tickets) — bare array only, no surrounding text
THEN_RUN: ~/.claude/skills/muaddib/orchestrate.sh queue '<json-array>'
NO_PAUSE: after queue emits INVOKE_SKILL lines, execute them immediately in sequence without pausing
EOF
    ;;

  queue)
    require_jq
    json="${1:-}"
    [[ -n "$json" ]] || die "no ticket-id JSON provided to queue subcommand."

    echo "$json" | jq empty 2>/dev/null || die "invalid JSON. Expected array like [\"QUO-281\",\"QUO-282\"]. Got: $json"

    ids=$(echo "$json" | jq -r '.[]')
    [[ -n "$ids" ]] || die "ticket list is empty — /prepare-feast must return at least one ID."

    while read -r id; do
      [[ "$id" =~ ^[A-Z]+-[0-9]+$ ]] || die "ticket ID '$id' does not match expected pattern TEAM-NNN."
    done <<<"$ids"

    count=$(echo "$ids" | wc -l | tr -d ' ')
    echo "QUEUE_SIZE: $count"
    echo "TRACK: create one tracking task per ticket below; mark each complete after its INVOKE_SKILL line finishes."
    echo "ORDERING: sequential. Do not parallelize — each implementation branches from main."
    echo "NO_PAUSE: run each INVOKE_SKILL immediately without ending the turn between tickets."
    echo
    while read -r id; do
      echo "INVOKE_SKILL: implementation-fleet $id"
    done <<<"$ids"
    echo
    echo "THEN_RUN: ~/.claude/skills/muaddib/orchestrate.sh summary '<json-results>'"
    echo "  where <json-results> is JSON like: [{\"ticket\":\"QUO-281\",\"pr\":\"https://...\",\"status\":\"opened\"}]"
    echo "  status values: opened | failed | skipped"
    ;;

  summary)
    require_jq
    json="${1:-}"
    [[ -n "$json" ]] || die "no results JSON provided to summary subcommand."

    echo "$json" | jq empty 2>/dev/null || die "invalid JSON for summary."

    echo "=== /muaddib complete ==="
    echo "$json" | jq -r '.[] | "- \(.ticket) [\(.status // "opened")] → \(.pr // "no PR")"'
    echo
    total=$(echo "$json" | jq 'length')
    opened=$(echo "$json" | jq '[.[] | select(.status == "opened" or .status == null)] | length')
    failed=$(echo "$json" | jq '[.[] | select(.status == "failed")] | length')
    skipped=$(echo "$json" | jq '[.[] | select(.status == "skipped")] | length')
    echo "Total: $total | Opened: $opened | Failed: $failed | Skipped: $skipped"
    ;;

  *)
    die "unknown subcommand: '${cmd}'
  Usage: orchestrate.sh {parse|queue|summary} <arg>
    parse   <linear-url-or-id>      → emits PARSED_TICKET + NO_PAUSE + first INVOKE_SKILL
    queue   <json-array-of-ids>     → emits NO_PAUSE + one INVOKE_SKILL per ticket
    summary <json-array-of-results> → prints final report"
    ;;
esac
