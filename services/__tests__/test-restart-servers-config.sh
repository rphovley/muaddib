#!/usr/bin/env bash
# Config-parse test for services/restart-servers.sh — asserts the manifest-driven
# API/frontend selection (same selectors as retunnel.sh / start-servers.js) via
# the script's RESTART_SERVERS_PRINT_CONFIG parse-only mode. Hermetic: parse-only
# mode prints the selection and exits before touching any port, migration, or
# process, so no live container is needed.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESTART="$SCRIPT_DIR/../restart-servers.sh"

PASS=0; FAIL=0

run_test() {
  local name="$1" fn="$2"
  local tmp log
  tmp=$(mktemp -d)
  log="$tmp/test.log"
  if "$fn" "$tmp" >"$log" 2>&1; then
    echo "  $name... PASS"; PASS=$((PASS + 1))
  else
    echo "  $name... FAIL"; sed 's/^/    /' "$log"; FAIL=$((FAIL + 1))
  fi
  rm -rf "$tmp"
}

# Write a fixture manifest ($2 = JSON) into $1/.muaddib/manifest.json.
write_manifest() {
  mkdir -p "$1/.muaddib"
  printf '%s\n' "$2" > "$1/.muaddib/manifest.json"
}

# Run restart-servers.sh in parse-only mode against fixture repo $1 and echo the
# requested KEY= line's value.
config_value() {
  local repo="$1" key="$2"
  RESTART_SERVERS_PRINT_CONFIG=1 REPO_DIR="$repo" WORKER_INDEX=99 bash "$RESTART" 2>/dev/null \
    | grep "^${key}=" | head -1 | cut -d= -f2-
}

# ─── tests ────────────────────────────────────────────────────────────────────

test_api_selected_by_seedscript() {
  local tmp="$1"
  write_manifest "$tmp" '{"projectName":"qt","projects":[
    {"name":"api","path":"projects/api","devScript":"api:dev","port":9000,"seedScript":"projects/api/seed.ts"},
    {"name":"portal","path":"projects/portal","devScript":"portal:dev","port":3000}
  ]}'
  local port path dev
  port=$(config_value "$tmp" API_PORT)
  path=$(config_value "$tmp" API_PATH)
  dev=$(config_value "$tmp" API_DEV_SCRIPT)
  [ "$port" = "9000" ]            || { echo "expected API_PORT=9000, got '$port'"; return 1; }
  [ "$path" = "projects/api" ]    || { echo "expected API_PATH=projects/api, got '$path'"; return 1; }
  [ "$dev" = "api:dev" ]          || { echo "expected API_DEV_SCRIPT=api:dev, got '$dev'"; return 1; }
}

test_frontends_filtered() {
  # devScript + no seedScript = frontend; a static project (no devScript) is excluded.
  local tmp="$1"
  write_manifest "$tmp" '{"projectName":"qt","projects":[
    {"name":"api","path":"projects/api","devScript":"api:dev","port":9000,"seedScript":"projects/api/seed.ts"},
    {"name":"portal","path":"projects/portal","devScript":"portal:dev","port":3000},
    {"name":"homeowner","path":"projects/ho","devScript":"ho:dev","port":3001},
    {"name":"static","path":"static"}
  ]}'
  local names ports paths
  names=$(config_value "$tmp" FRONTEND_NAMES)
  ports=$(config_value "$tmp" FRONTEND_PORTS)
  paths=$(config_value "$tmp" FRONTEND_PATHS)
  [ "$names" = "portal homeowner" ]           || { echo "expected FRONTEND_NAMES='portal homeowner', got '$names'"; return 1; }
  [ "$ports" = "3000 3001" ]                  || { echo "expected FRONTEND_PORTS='3000 3001', got '$ports'"; return 1; }
  [ "$paths" = "projects/portal projects/ho" ] || { echo "expected FRONTEND_PATHS='projects/portal projects/ho', got '$paths'"; return 1; }
}

test_no_previewable_projects() {
  # muaddib self-hosting: a single project with no seedScript/devScript → no API,
  # no frontends (the script then no-ops to restart_ready at runtime).
  local tmp="$1"
  write_manifest "$tmp" '{"projectName":"muaddib","projects":[
    {"name":"muaddib","path":".","checkCommand":"./run_tests.sh"}
  ]}'
  local port names
  port=$(config_value "$tmp" API_PORT)
  names=$(config_value "$tmp" FRONTEND_NAMES)
  [ -z "$port" ]  || { echo "expected empty API_PORT, got '$port'"; return 1; }
  [ -z "$names" ] || { echo "expected empty FRONTEND_NAMES, got '$names'"; return 1; }
}

# ─── run ─────────────────────────────────────────────────────────────────────

run_test "API project selected by non-null seedScript"      test_api_selected_by_seedscript
run_test "frontends filtered by devScript/no-seedScript"     test_frontends_filtered
run_test "no previewable projects → empty API + frontends"   test_no_previewable_projects

echo ""
echo "$PASS/$((PASS + FAIL)) passed"
[ "$FAIL" -eq 0 ] || exit 1
