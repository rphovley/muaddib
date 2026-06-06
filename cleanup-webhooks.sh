#!/usr/bin/env bash
# Remove all stale muaddib preview webhooks from Linear.
#
# Muaddib webhooks are identified by their trycloudflare.com URL — the domain
# used by cloudflared quick tunnels. Workers clean up their own webhook on exit
# via trap; this script handles the case where a worker crashed before cleanup.
#
# Usage (from anywhere with LINEAR_API_KEY set):
#   LINEAR_API_KEY=<key> ./muaddib/cleanup-webhooks.sh
set -euo pipefail

: "${LINEAR_API_KEY:?export LINEAR_API_KEY first}"

linear_gql() {
    curl -s -X POST https://api.linear.app/graphql \
        -H "Authorization: ${LINEAR_API_KEY}" \
        -H "Content-Type: application/json" \
        --data-binary "$1"
}

echo "Fetching Linear webhooks..."

LIST_RESPONSE=$(linear_gql '{"query":"{ webhooks { nodes { id url enabled } } }"}')

# Sanity-check the response
if ! printf '%s' "$LIST_RESPONSE" | jq -e '.data.webhooks.nodes' > /dev/null 2>&1; then
    echo "error: unexpected response from Linear API:" >&2
    printf '%s\n' "$LIST_RESPONSE" >&2
    exit 1
fi

HOOKS_JSON=$(printf '%s' "$LIST_RESPONSE" \
    | jq '[.data.webhooks.nodes[] | select(.url | contains("trycloudflare.com")) | {id, url}]')

COUNT=$(printf '%s' "$HOOKS_JSON" | jq 'length')

if [ "$COUNT" -eq 0 ]; then
    echo "No stale muaddib webhooks found."
    exit 0
fi

echo "Found ${COUNT} stale webhook(s):"
printf '%s' "$HOOKS_JSON" | jq -r '.[] | "  \(.id) → \(.url)"'
echo

printf '%s' "$HOOKS_JSON" | jq -r '.[].id' | while IFS= read -r HOOK_ID; do
    echo "  Deleting ${HOOK_ID}..."
    linear_gql "{\"query\":\"mutation { webhookDelete(id: \\\"${HOOK_ID}\\\") { success } }\"}" \
        | jq -r 'if .data.webhookDelete.success then "  ✓ deleted" else "  ✗ failed: \(.)" end'
done

echo "Done — removed ${COUNT} muaddib webhook(s)."
