#!/usr/bin/env bash
# Test suite for bin/worker-alloc.sh — the cross-process worker-slot allocator.
# Covers:
#   - muaddib_select_worker against a stubbed `docker` (skips busy slots, picks
#     the lowest free, honors a hint, errors when all slots are busy)
#   - mutual exclusion: a second acquire blocks while the lock is held, then
#     either succeeds once it's released or times out LOUDLY
#   - the mkdir fallback breaking a lock whose holder PID is dead
#   - the EXIT trap releasing the lock when a holder exits without unlocking
#
# Self-contained — needs no docker daemon or worker containers (docker is stubbed
# with a fake on PATH; the lock primitives touch only tmp files/dirs).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ALLOC="$REPO_ROOT/bin/worker-alloc.sh"

PASS=0; FAIL=0

# ─── test runner ─────────────────────────────────────────────────────────────
# Each test function receives a fresh $TMP dir as $1.
run_test() {
  local name="$1" fn="$2" tmp log
  tmp=$(mktemp -d); log="$tmp/test.log"
  if "$fn" "$tmp" >"$log" 2>&1; then
    echo "  $name... PASS"; PASS=$((PASS + 1))
  else
    echo "  $name... FAIL"; sed 's/^/    /' "$log"; FAIL=$((FAIL + 1))
  fi
  rm -rf "$tmp"
}

# ─── helpers ─────────────────────────────────────────────────────────────────

# Write a fake `docker` into $1/bin that answers the one query
# muaddib_select_worker makes — `docker ps -q --filter label=...project=<p>-w<N>`.
# It echoes a fake container id (i.e. reports the slot "up") for every worker
# number listed in $2 (space-separated), and prints nothing otherwise.
make_fake_docker() {
  local dir="$1" busy="$2"
  mkdir -p "$dir/bin"
  cat > "$dir/bin/docker" <<EOF
#!/usr/bin/env bash
busy="${busy}"
for a in "\$@"; do
  case "\$a" in
    label=com.docker.compose.project=*-w*)
      n="\${a##*-w}"
      for b in \$busy; do
        [ "\$b" = "\$n" ] && { echo "fakecid\${n}"; exit 0; }
      done
      ;;
  esac
done
exit 0
EOF
  chmod +x "$dir/bin/docker"
}

# Run a snippet with worker-alloc.sh sourced. $1 = extra env assignments (may be
# empty), $2 = shell body. Kept as a helper so the quoting lives in one place.
in_alloc() { bash -c "source \"$ALLOC\"; $1"; }

# ─── muaddib_select_worker ─────────────────────────────────────────────────────

test_select_picks_lowest_free() {
  local tmp="$1"; make_fake_docker "$tmp" "1 2"
  local got
  got=$(PATH="$tmp/bin:$PATH" MUADDIB_PROJECT_NAME=proj in_alloc 'muaddib_select_worker')
  [ "$got" = "3" ] || { echo "expected 3, got '$got'"; return 1; }
}

test_select_hint_advances_past_busy() {
  # Hint points at a busy slot → must advance past it, never return it.
  local tmp="$1"; make_fake_docker "$tmp" "5"
  local got
  got=$(PATH="$tmp/bin:$PATH" MUADDIB_PROJECT_NAME=proj in_alloc 'muaddib_select_worker 5')
  [ "$got" = "6" ] || { echo "expected 6, got '$got'"; return 1; }
}

test_select_hint_free_returned() {
  # Hint points at a free slot above a busy low slot → returns the hint.
  local tmp="$1"; make_fake_docker "$tmp" "1"
  local got
  got=$(PATH="$tmp/bin:$PATH" MUADDIB_PROJECT_NAME=proj in_alloc 'muaddib_select_worker 3')
  [ "$got" = "3" ] || { echo "expected 3, got '$got'"; return 1; }
}

test_select_all_busy_errors() {
  local tmp="$1"; make_fake_docker "$tmp" "1 2 3"
  local got rc
  got=$(PATH="$tmp/bin:$PATH" MUADDIB_PROJECT_NAME=proj MUADDIB_MAX_WORKERS=3 \
        in_alloc 'muaddib_select_worker'); rc=$?
  [ "$rc" -ne 0 ] || { echo "expected non-zero exit when all slots busy"; return 1; }
  [ -z "$got" ] || { echo "expected empty output, got '$got'"; return 1; }
}

# ─── mutual exclusion (flock path) ─────────────────────────────────────────────

test_flock_mutual_exclusion() {
  command -v flock >/dev/null 2>&1 || { echo "flock absent — skipping"; return 0; }
  # flock is opt-in (mkdir is the default, portable primitive) — force it here so
  # this test exercises the flock path specifically.
  local tmp="$1" lock="$tmp/a.lock"
  ( MUADDIB_ALLOC_USE_FLOCK=1 in_alloc "muaddib_alloc_lock '$lock' || exit 1; touch '$tmp/held'; sleep 2; muaddib_alloc_unlock" ) &
  local holder=$!
  for _ in $(seq 1 50); do [ -f "$tmp/held" ] && break; sleep 0.1; done
  [ -f "$tmp/held" ] || { echo "holder never acquired"; kill "$holder" 2>/dev/null; return 1; }
  # Second acquire, short timeout, must fail loudly while the holder holds.
  local out rc
  out=$(MUADDIB_ALLOC_USE_FLOCK=1 MUADDIB_ALLOC_TIMEOUT=1 in_alloc "muaddib_alloc_lock '$lock'" 2>&1); rc=$?
  wait "$holder" 2>/dev/null
  [ "$rc" -ne 0 ] || { echo "second acquire should have timed out (rc=$rc)"; return 1; }
  case "$out" in *"timed out"*) ;; *) echo "expected a loud timeout message, got: $out"; return 1;; esac
}

# ─── mutual exclusion + release (mkdir fallback) ───────────────────────────────

test_mkdir_blocks_until_release() {
  local tmp="$1" lock="$tmp/b.lock"
  ( MUADDIB_ALLOC_NO_FLOCK=1 in_alloc "muaddib_alloc_lock '$lock' || exit 1; touch '$tmp/held'; sleep 1; muaddib_alloc_unlock" ) &
  local holder=$!
  for _ in $(seq 1 50); do [ -f "$tmp/held" ] && break; sleep 0.1; done
  [ -f "$tmp/held" ] || { echo "holder never acquired"; kill "$holder" 2>/dev/null; return 1; }
  # Generous timeout: must block while held, then acquire once released.
  local rc
  MUADDIB_ALLOC_NO_FLOCK=1 MUADDIB_ALLOC_TIMEOUT=10 \
    in_alloc "muaddib_alloc_lock '$lock' || exit 1; muaddib_alloc_unlock"; rc=$?
  wait "$holder" 2>/dev/null
  [ "$rc" -eq 0 ] || { echo "waiter should acquire after release (rc=$rc)"; return 1; }
}

test_mkdir_timeout_loud() {
  local tmp="$1" lock="$tmp/c.lock"
  ( MUADDIB_ALLOC_NO_FLOCK=1 in_alloc "muaddib_alloc_lock '$lock' || exit 1; touch '$tmp/held'; sleep 3; muaddib_alloc_unlock" ) &
  local holder=$!
  for _ in $(seq 1 50); do [ -f "$tmp/held" ] && break; sleep 0.1; done
  [ -f "$tmp/held" ] || { echo "holder never acquired"; kill "$holder" 2>/dev/null; return 1; }
  local out rc
  out=$(MUADDIB_ALLOC_NO_FLOCK=1 MUADDIB_ALLOC_TIMEOUT=1 in_alloc "muaddib_alloc_lock '$lock'" 2>&1); rc=$?
  wait "$holder" 2>/dev/null
  [ "$rc" -ne 0 ] || { echo "expected timeout failure (rc=$rc)"; return 1; }
  case "$out" in *"timed out"*) ;; *) echo "expected a loud timeout message, got: $out"; return 1;; esac
}

test_mkdir_stale_break() {
  # A leftover lock dir whose recorded holder PID is dead must be broken.
  local tmp="$1" lock="$tmp/d.lock"
  mkdir -p "$lock.d"
  echo 999999 > "$lock.d/pid"   # a PID that is not running
  local rc
  MUADDIB_ALLOC_NO_FLOCK=1 MUADDIB_ALLOC_TIMEOUT=3 \
    in_alloc "muaddib_alloc_lock '$lock' || exit 1; muaddib_alloc_unlock"; rc=$?
  [ "$rc" -eq 0 ] || { echo "should break a stale lock and acquire (rc=$rc)"; return 1; }
}

test_exit_trap_releases_mkdir() {
  # A holder that exits WITHOUT unlocking must still release via the EXIT trap.
  local tmp="$1" lock="$tmp/e.lock"
  MUADDIB_ALLOC_NO_FLOCK=1 in_alloc "muaddib_alloc_lock '$lock' || exit 1"
  [ ! -d "$lock.d" ] || { echo "EXIT trap should have removed $lock.d"; return 1; }
}

# ─── run ─────────────────────────────────────────────────────────────────────

cd "$REPO_ROOT"

run_test "select: picks lowest free slot"            test_select_picks_lowest_free
run_test "select: hint on a busy slot advances"      test_select_hint_advances_past_busy
run_test "select: hint on a free slot is returned"   test_select_hint_free_returned
run_test "select: all slots busy → errors"           test_select_all_busy_errors
run_test "lock: flock mutual exclusion (loud timeout)" test_flock_mutual_exclusion
run_test "lock: mkdir blocks then acquires on release"  test_mkdir_blocks_until_release
run_test "lock: mkdir loud timeout while held"       test_mkdir_timeout_loud
run_test "lock: mkdir breaks a dead holder's lock"   test_mkdir_stale_break
run_test "lock: EXIT trap releases (mkdir)"          test_exit_trap_releases_mkdir

echo ""
echo "$PASS/$((PASS + FAIL)) passed"
[ "$FAIL" -eq 0 ] || exit 1
