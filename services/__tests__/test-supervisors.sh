#!/usr/bin/env bash
# Behaviour tests for services/lib/supervisors.sh — the three failure modes that
# took the preview API down behind a healthy tunnel:
#
#   1. kill_stale_supervisors() must kill a project's on-servers-start hook.
#      `pkill -f start-servers.js` never matched it, so the hook survived every
#      restart path and fought the relaunching script for the API port.
#   2. supervise_port() must survive a dev server that exits nonzero. The loop
#      inherits `set -e` and a `while` body is not an exempt context, so a
#      missing `|| true` kills the supervisor on the first EADDRINUSE and leaves
#      the port unwatched.
#   3. supervise_port() must run devScript as a SHELL COMMAND ("npm run api:dev"),
#      not as an npm script name, and must adopt an already-listening port
#      instead of launching a second server onto it.
#
# Hermetic: fake dev servers are `sleep`/`exit 1` shell snippets and a listener
# is a plain `nc`-free bash/python one-liner on an ephemeral port. No container,
# no npm, no network.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="$SCRIPT_DIR/../lib"

PASS=0; FAIL=0

run_test() {
  local name="$1" fn="$2"
  local tmp log
  tmp=$(mktemp -d)
  log="$tmp/test.log"
  if ( "$fn" "$tmp" ) >"$log" 2>&1; then
    echo "  $name... PASS"; PASS=$((PASS + 1))
  else
    echo "  $name... FAIL"; sed 's/^/    /' "$log"; FAIL=$((FAIL + 1))
  fi
  rm -rf "$tmp"
}

# Source the lib the way a service script does, with a pidfile scoped to $1 so
# concurrent runs (and the real worker's pidfile) can't interfere.
load_lib() {  # $1 tmpdir
  WORKER=99
  REPO="$1"
  MUADDIB_SUPERVISOR_PIDFILE="$1/supervisors.pids"
  log()  { echo "[test] $*" >&2; }
  warn() { echo "[test] WARNING: $*" >&2; }
  # shellcheck source=../lib/port-utils.sh
  . "$LIB_DIR/port-utils.sh"
  # shellcheck source=../lib/supervisors.sh
  . "$LIB_DIR/supervisors.sh"
}

# A port nothing is listening on. Picked by binding :0 and closing it, so it's
# free as of now — the same ephemeral-port race every test harness lives with.
free_port() {
  python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'
}

# Background a listener on $1 and echo its pid. Holds the port until killed.
start_listener() {  # $1 port
  python3 -c '
import socket, sys, time
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", int(sys.argv[1])))
s.listen(8)
time.sleep(600)
' "$1" >/dev/null 2>&1 &
  echo $!
}

# ─── tests ────────────────────────────────────────────────────────────────────

# kill_stale_supervisors must match the PROJECT hook, not just start-servers.js.
test_kills_on_servers_start_hook() {
  local tmp="$1"
  load_lib "$tmp"
  mkdir -p "$tmp/.muaddib/hooks"
  echo 'setTimeout(() => {}, 600000);' > "$tmp/.muaddib/hooks/on-servers-start.js"
  node "$tmp/.muaddib/hooks/on-servers-start.js" >/dev/null 2>&1 &
  local hook_pid=$!
  sleep 1
  kill -0 "$hook_pid" 2>/dev/null || { echo "fixture hook died before the test ran"; return 1; }

  kill_stale_supervisors >/dev/null 2>&1
  sleep 1

  if kill -0 "$hook_pid" 2>/dev/null; then
    kill "$hook_pid" 2>/dev/null
    echo "on-servers-start hook (pid ${hook_pid}) survived kill_stale_supervisors"
    return 1
  fi
}

# A recorded loop from an earlier run must be killed; an unrelated process with
# a recorded-looking pid must not be.
test_kills_recorded_loops_only() {
  local tmp="$1"
  load_lib "$tmp"

  # A loop whose argv looks like one of ours (bash running retunnel.sh).
  printf 'while true; do sleep 1; done\n' > "$tmp/retunnel.sh"
  bash "$tmp/retunnel.sh" >/dev/null 2>&1 &
  local ours=$!
  # An unrelated process that happens to be listed in the pidfile.
  sleep 600 &
  local theirs=$!
  record_supervisor api "$ours"
  record_supervisor portal "$theirs"
  sleep 1

  kill_recorded_supervisors >/dev/null 2>&1
  sleep 1

  local rc=0
  if kill -0 "$ours" 2>/dev/null; then
    echo "recorded loop (pid ${ours}) survived kill_recorded_supervisors"; rc=1
  fi
  if ! kill -0 "$theirs" 2>/dev/null; then
    echo "unrelated process (pid ${theirs}) was killed — pid-reuse guard failed"; rc=1
  fi
  # The pidfile must be truthful afterwards, or the next run kills nothing.
  if [ -s "$MUADDIB_SUPERVISOR_PIDFILE" ]; then
    echo "pidfile not cleared: $(cat "$MUADDIB_SUPERVISOR_PIDFILE")"; rc=1
  fi
  kill "$ours" "$theirs" 2>/dev/null
  return "$rc"
}

# supervise_port launches devScript as a shell command on a free port.
test_launches_shell_command() {
  local tmp="$1"
  load_lib "$tmp"
  local port; port=$(free_port)

  # A shell command with arguments — the shape of a real devScript
  # ("npm run api:dev"), which `npm run "$script"` cannot run.
  supervise_port api "$port" "printf started > '$tmp/marker'; sleep 600" "$tmp/api.log" >/dev/null 2>&1
  local loop=$!
  sleep 3

  local rc=0
  [ -f "$tmp/marker" ] || { echo "devScript never ran (no marker file)"; rc=1; }
  kill_recorded_supervisors >/dev/null 2>&1
  pkill -P "$loop" 2>/dev/null
  return "$rc"
}

# The set -e regression guard: a dev server that exits nonzero must be
# relaunched, not take the supervisor down with it.
#
# This has to run in a SEPARATE bash process. run_test calls each test as an
# `if` condition, and bash suppresses -e for the whole dynamic extent of a
# function invoked in a tested context — including subshells it spawns. A
# `set -euo pipefail` written inside this function would therefore be inert and
# the test would pass whether or not supervise_port guards the call. A fresh
# `bash fixture.sh` honours the -e in its own script, which is exactly the
# shell the real callers (retunnel.sh, restart-servers.sh) give the loop.
test_survives_nonzero_exit() {
  local tmp="$1"
  load_lib "$tmp"   # for the pidfile + cleanup; the fixture loads its own copy
  local port; port=$(free_port)

  cat > "$tmp/fixture.sh" <<FIXTURE
#!/usr/bin/env bash
set -euo pipefail
WORKER=99
REPO="$tmp"
MUADDIB_SUPERVISOR_PIDFILE="$MUADDIB_SUPERVISOR_PIDFILE"
. "$LIB_DIR/port-utils.sh"
. "$LIB_DIR/supervisors.sh"
supervise_port api "$port" "echo attempt >> '$tmp/attempts'; exit 1" "$tmp/api.log"
FIXTURE

  bash "$tmp/fixture.sh" >/dev/null 2>&1
  sleep 7

  local attempts rc=0
  attempts=$(wc -l < "$tmp/attempts" 2>/dev/null | tr -d ' ')
  [ "${attempts:-0}" -ge 2 ] \
    || { echo "dev server ran ${attempts:-0}x — supervisor died on the first nonzero exit"; rc=1; }
  kill_recorded_supervisors >/dev/null 2>&1
  return "$rc"
}

# Adoption: a port someone else is already listening on must NOT get a second
# server launched onto it (that's the two-watchers-one-port fight).
test_adopts_live_port() {
  local tmp="$1"
  load_lib "$tmp"
  local port; port=$(free_port)
  local listener; listener=$(start_listener "$port")
  sleep 1
  port_up "$port" || { kill "$listener" 2>/dev/null; echo "fixture listener never bound :${port}"; return 1; }

  supervise_port api "$port" "printf relaunched > '$tmp/marker'; sleep 600" "$tmp/api.log" >/dev/null 2>&1
  sleep 4

  local rc=0
  if [ -f "$tmp/marker" ]; then
    echo "supervise_port relaunched the dev server onto an already-bound port"
    rc=1
  fi

  # ...and once the adopted server dies, the supervisor must take over.
  kill "$listener" 2>/dev/null
  sleep 5
  [ -f "$tmp/marker" ] \
    || { echo "supervisor never relaunched after the adopted server exited"; rc=1; }

  kill_recorded_supervisors >/dev/null 2>&1
  return "$rc"
}

# ─── run ─────────────────────────────────────────────────────────────────────

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not available — skipping supervisors tests"
  exit 0
fi

run_test "kill_stale_supervisors kills the on-servers-start hook"  test_kills_on_servers_start_hook
run_test "kill_recorded_supervisors kills our loops, not others"   test_kills_recorded_loops_only
run_test "supervise_port runs devScript as a shell command"        test_launches_shell_command
run_test "supervise_port survives a nonzero dev-server exit"       test_survives_nonzero_exit
run_test "supervise_port adopts an already-listening port"         test_adopts_live_port

echo ""
echo "$PASS/$((PASS + FAIL)) passed"
[ "$FAIL" -eq 0 ] || exit 1
