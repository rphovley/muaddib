#!/usr/bin/env bash
# Shared TCP-port helpers for the preview service scripts.
#
# Source it relative to the sourcing script, not via REPO/muaddib — the layout
# differs between a consuming project (REPO/muaddib/services/...) and muaddib
# self-hosting (REPO/services/...):
#   . "$(dirname "${BASH_SOURCE[0]}")/lib/port-utils.sh"
#
# No `set -e`/`set -u` assumptions: every helper returns 0 on the "nothing to
# do" path so a caller running under `set -euo pipefail` can call it bare.

# Is anything listening on $1? Uses bash's /dev/tcp — needs no external tooling.
port_up() { (echo > "/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# Kill whatever is bound to port $1.
#
# fuser (psmisc) and lsof are the obvious tools and are tried first, but the
# worker base image ships NEITHER — only iproute2's `ss`. Without the ss branch
# this silently killed nothing, so every caller "succeeded" while the old
# process kept the port (and, for a Vite server, kept serving a stale
# VITE_API_URL). Keep ss as a real fallback, not an afterthought.
kill_port() {
  local port="$1" pids=""
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${port}/tcp" 2>/dev/null || true
    return 0
  fi
  if command -v lsof >/dev/null 2>&1; then
    pids=$(lsof -ti :"$port" 2>/dev/null || true)
  elif command -v ss >/dev/null 2>&1; then
    pids=$(ss -ltnpH "sport = :${port}" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u)
  fi
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
  return 0
}

# Wait up to $2 seconds (default 15) for port $1 to be free. 0 = free.
wait_port_free() {
  local port="$1" max="${2:-15}" i
  for i in $(seq 1 "$max"); do port_up "$port" || return 0; sleep 1; done
  return 1
}

# Wait up to $2 seconds (default 90) for port $1 to be listening. 0 = up.
wait_port_up() {
  local port="$1" max="${2:-90}" i
  for i in $(seq 1 "$max"); do port_up "$port" && return 0; sleep 1; done
  return 1
}
