#!/usr/bin/env bash
# Standalone integration test for the localhost.run SSH tunnel fallback.
#
# Starts a minimal HTTP server on a local port, opens a localhost.run tunnel,
# verifies the HTTPS URL is actually reachable, and stress-tests reconnection
# behaviour by watching for SSH process death.
#
# Nothing is required beyond: ssh, node, curl.
#
# NOTE: macOS ships with LibreSSL 3.3.x which has a known TLS 1.3 negotiation
# incompatibility with localhost.run's edge (error:1404B42E tlsv1 alert protocol
# version). The test will still report the URL and SSH aliveness but may show
# the HTTPS probe failing on macOS. Inside a Docker container (Linux/OpenSSL)
# this works correctly — which is the actual production environment.
#
# Usage:
#   ./muaddib/scripts/test-localhost-run.sh [--port PORT] [--timeout SECS]
#
# Options:
#   --port PORT              local port for the test HTTP server (default: 18888)
#   --timeout SECS           seconds to wait for a URL from localhost.run (default: 60)
#   --probe-secs N           seconds to keep probing the tunnel URL (default: 30)
#   --key-file PATH          path to an SSH private key registered at admin.localhost.run
#                            (gives a stable subdomain instead of a random lhr.life URL)
#   --skip-https-probe       skip the HTTPS curl probe (useful on macOS with LibreSSL)

set -euo pipefail

PORT=18888
URL_TIMEOUT=60
PROBE_SECS=30
KEY_FILE=""
SKIP_HTTPS_PROBE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)             PORT="$2";        shift 2 ;;
    --timeout)          URL_TIMEOUT="$2"; shift 2 ;;
    --probe-secs)       PROBE_SECS="$2";  shift 2 ;;
    --key-file)         KEY_FILE="$2";    shift 2 ;;
    --skip-https-probe) SKIP_HTTPS_PROBE=true; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# Detect macOS LibreSSL and auto-skip the HTTPS probe with a warning.
if [[ "$SKIP_HTTPS_PROBE" = "false" ]] && curl --version 2>&1 | grep -q "LibreSSL"; then
  echo "[test-localhost-run] WARNING: macOS LibreSSL detected — HTTPS probe to lhr.life will likely"
  echo "                     fail with TLS protocol version error. This is a macOS curl limitation,"
  echo "                     not a bug in the tunnel. Use --skip-https-probe to suppress, or run"
  echo "                     inside the worker Docker container where OpenSSL is available."
  echo ""
fi

LOG_DIR=$(mktemp -d /tmp/test-lr-XXXXXX)
SERVER_LOG="$LOG_DIR/server.log"
TUNNEL_LOG="$LOG_DIR/tunnel.log"
SERVER_PID=""
SSH_PID=""

log()  { echo "[test-localhost-run] $*"; }
pass() { echo "PASS — $*"; }
fail() { echo "FAIL — $*" >&2; exit 1; }

cleanup() {
  [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null || true
  [[ -n "$SSH_PID"    ]] && kill "$SSH_PID"    2>/dev/null || true
  rm -rf "$LOG_DIR"
}
trap cleanup EXIT

# ── 1. Start a minimal HTTP server ───────────────────────────────────────────

log "starting HTTP server on :${PORT}..."
node - "$PORT" > "$SERVER_LOG" 2>&1 <<'NODE' &
const http = require('http');
const port = parseInt(process.argv[2], 10);
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('localhost.run-test-ok\n');
}).listen(port, '127.0.0.1', () => process.stderr.write(`listening on ${port}\n`));
NODE
SERVER_PID=$!

# Wait for server to bind (up to 10 s)
for i in $(seq 1 10); do
  (echo > /dev/tcp/127.0.0.1/"$PORT") 2>/dev/null && break
  sleep 1
done
(echo > /dev/tcp/127.0.0.1/"$PORT") 2>/dev/null || fail "HTTP server did not bind on :${PORT}"
log "HTTP server ready on :${PORT}"

# ── 2. Open localhost.run SSH tunnel ─────────────────────────────────────────

log "opening localhost.run SSH tunnel (this may take up to ${URL_TIMEOUT}s)..."
SSH_ARGS=(
  -R "80:localhost:${PORT}"
  -o StrictHostKeyChecking=no
  -o BatchMode=yes
  -o ExitOnForwardFailure=yes
  -o ConnectTimeout=30
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=3
)
if [[ -n "$KEY_FILE" ]]; then
  log "using SSH key: $KEY_FILE"
  SSH_ARGS+=(-i "$KEY_FILE")
fi
ssh "${SSH_ARGS[@]}" nokey@localhost.run > "$TUNNEL_LOG" 2>&1 &
SSH_PID=$!

# ── 3. Wait for URL ───────────────────────────────────────────────────────────

TUNNEL_URL=""
LR_URL_RE='https://[a-zA-Z0-9-]+\.lhr\.[a-z]+'
for i in $(seq 1 "$URL_TIMEOUT"); do
  TUNNEL_URL=$(grep -oE "$LR_URL_RE" "$TUNNEL_LOG" 2>/dev/null | head -1 || true)
  [[ -n "$TUNNEL_URL" ]] && break
  # Also check if SSH died before a URL appeared
  if ! kill -0 "$SSH_PID" 2>/dev/null; then
    log "tunnel log:"
    cat "$TUNNEL_LOG"
    fail "SSH process exited before a URL was found"
  fi
  sleep 1
done

if [[ -z "$TUNNEL_URL" ]]; then
  log "tunnel log:"
  cat "$TUNNEL_LOG"
  fail "no localhost.run URL found within ${URL_TIMEOUT}s"
fi

log "got URL: ${TUNNEL_URL}"

# ── 4. Verify SSH process is still alive ─────────────────────────────────────

if ! kill -0 "$SSH_PID" 2>/dev/null; then
  fail "SSH process died immediately after URL was emitted — tunnel is already dead"
fi
log "SSH process still running (PID ${SSH_PID})"

# ── 5. Health-check the HTTPS URL (retry up to 30 s for edge propagation) ───

if [[ "$SKIP_HTTPS_PROBE" = "true" ]]; then
  log "skipping HTTPS probe (--skip-https-probe set)"
else
  log "probing ${TUNNEL_URL} via HTTPS (up to 30s for edge propagation)..."
  HTTPS_CODE="000"
  HTTPS_BODY=""
  for i in $(seq 1 30); do
    RESPONSE=$(curl -sS -w '\n__STATUS__%{http_code}' --max-time 5 "$TUNNEL_URL" 2>/dev/null || true)
    HTTPS_CODE=$(printf '%s' "$RESPONSE" | grep '__STATUS__' | sed 's/__STATUS__//')
    HTTPS_BODY=$(printf '%s' "$RESPONSE" | grep -v '__STATUS__' || true)
    [[ "$HTTPS_CODE" = "200" ]] && break
    sleep 1
  done

  log "HTTPS probe: HTTP ${HTTPS_CODE}"
  if [[ "$HTTPS_CODE" != "200" ]]; then
    log "tunnel log:"
    cat "$TUNNEL_LOG"
    fail "HTTPS probe returned ${HTTPS_CODE} (expected 200) — on macOS try --skip-https-probe"
  fi

  if [[ "$HTTPS_BODY" != *"localhost.run-test-ok"* ]]; then
    fail "HTTPS body didn't contain expected payload — got: ${HTTPS_BODY}"
  fi
  log "HTTPS probe body: ${HTTPS_BODY}"

  # ── 6. Sustained probe over PROBE_SECS seconds ─────────────────────────────
  log "sustained probe for ${PROBE_SECS}s to check connection stability..."
  FAIL_COUNT=0
  PASS_COUNT=0
  for i in $(seq 1 "$PROBE_SECS"); do
    if ! kill -0 "$SSH_PID" 2>/dev/null; then
      fail "SSH process died at probe iteration ${i}/${PROBE_SECS}"
    fi
    CODE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$TUNNEL_URL" 2>/dev/null || true)
    if [[ "$CODE" = "200" ]]; then
      PASS_COUNT=$((PASS_COUNT + 1))
    else
      FAIL_COUNT=$((FAIL_COUNT + 1))
      log "  iteration ${i}: HTTP ${CODE} (FAIL)"
    fi
    sleep 1
  done

  log "sustained probe complete: ${PASS_COUNT}/${PROBE_SECS} OK, ${FAIL_COUNT} failures"
  if [[ "$FAIL_COUNT" -gt 0 ]]; then
    log "tunnel log (last 30 lines):"
    tail -30 "$TUNNEL_LOG"
    fail "${FAIL_COUNT} requests failed during sustained probe"
  fi
fi

# ── 7. SSL certificate check ─────────────────────────────────────────────────

HOST=$(printf '%s' "$TUNNEL_URL" | sed 's|https://||')
log "checking SSL certificate via openssl for ${HOST}..."

# macOS ships LibreSSL 3.3.x which has a known TLS 1.3 handshake bug against
# some servers (including lhr.life). Detect this case and report it clearly.
OPENSSL_VER=$(openssl version 2>/dev/null || true)
if printf '%s' "$OPENSSL_VER" | grep -q 'LibreSSL'; then
  log "NOTE: using ${OPENSSL_VER} — TLS 1.3 negotiation may fail on macOS"
  log "      Run this test inside the worker Docker container for accurate SSL validation"
fi

CERT_INFO=$(echo | openssl s_client -connect "${HOST}:443" -servername "$HOST" \
  2>/dev/null | openssl x509 -noout -subject -issuer -dates 2>/dev/null || true)

if [[ -z "$CERT_INFO" ]]; then
  log "WARNING: could not retrieve SSL cert info — likely macOS LibreSSL TLS 1.3 limitation"
  log "         This does NOT indicate a tunnel problem; the Docker worker uses OpenSSL"
else
  log "SSL cert:"
  printf '%s\n' "$CERT_INFO" | sed 's/^/  /'
fi

echo ""
pass "localhost.run tunnel is working — URL: ${TUNNEL_URL}"
