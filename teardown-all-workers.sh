#!/usr/bin/env bash
# Tear down all active workers.
set -euo pipefail
FLEET_DIR="$(cd "$(dirname "$0")" && pwd)"

# Collect worker numbers from running Docker projects AND leftover env files.
workers=()

while IFS= read -r project; do
    n="${project#quotethat-w}"
    [[ "$n" =~ ^[0-9]+$ ]] && workers+=("$n")
done < <(docker compose ls --format json 2>/dev/null \
    | python3 -c "import sys,json; [print(p['Name']) for p in json.load(sys.stdin) if p['Name'].startswith('quotethat-w')]" 2>/dev/null || true)

for env_file in "$FLEET_DIR"/.worker-*.env; do
    [[ -f "$env_file" ]] || continue
    base="${env_file##*/.worker-}"
    n="${base%.env}"
    [[ "$n" =~ ^[0-9]+$ ]] && workers+=("$n")
done

# Deduplicate (portable: avoid mapfile which requires bash 4)
unique_workers=()
while IFS= read -r n; do unique_workers+=("$n"); done \
    < <(printf '%s\n' "${workers[@]}" | sort -un)
workers=("${unique_workers[@]}")

if [[ ${#workers[@]} -eq 0 ]]; then
    echo "No active workers found."
    exit 0
fi

echo "Tearing down workers: ${workers[*]}"
for WORKER in "${workers[@]}"; do
    "$FLEET_DIR/teardown-worker.sh" "$WORKER"
done
