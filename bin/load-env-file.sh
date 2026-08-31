#!/usr/bin/env bash
# Shared "shell-env-wins" env-file loader. Source this, then call
# muaddib_load_env_file <path> for each file you want to backfill from.
#
# Only exports a KEY the current shell doesn't already have — an explicit
# export in the invoking shell (e.g. an interactive ~/.zshrc) always wins over
# whatever a file supplies. Missing file is a silent no-op. Convention shared
# by dispatch.sh (account-level ~/.muaddib/conductor-secrets.env) and
# spawn-worker.sh (that file, plus the project-level .muaddib/secrets.env).

muaddib_load_env_file() {
  local file="$1"
  [ -f "$file" ] || return 0
  local _line _key
  while IFS= read -r _line || [ -n "$_line" ]; do
    _line="${_line#"${_line%%[![:space:]]*}"}"   # strip leading whitespace
    [ -z "$_line" ] && continue                   # skip blank lines
    case "$_line" in \#*) continue ;; esac        # skip comments
    _line="${_line#export }"                       # strip optional leading 'export '
    _key="${_line%%=*}"
    [ "$_key" = "$_line" ] && continue            # no '=' → not a KEY=VALUE line
    if [ -z "${!_key:-}" ]; then                  # shell env wins over the file
      export "${_key}=${_line#*=}"
    fi
  done < "$file"
}
