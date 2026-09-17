#!/usr/bin/env bash
# Add (or update) a muaddib checkout in the herdr-plugin project registry, so the
# optional herdr dispatch plugin can target it by name without a re-link. See
# herdr-plugin/README.md ("Driving several projects at once").
#
#   bin/herdr-register.sh <shortname> [<muaddib-checkout-dir>]
#
# <muaddib-checkout-dir> defaults to THIS checkout (the dir containing muaddib.sh
# next to bin/), so from inside any checkout you can just run:
#   ./bin/herdr-register.sh myproject
#
# The registry defaults to ${XDG_CONFIG_HOME:-~/.config}/muaddib/herdr-projects,
# overridable with $MUADDIB_HERDR_REGISTRY — the same variable the dispatch
# wrapper reads, so the two always agree. Idempotent: re-running for the same
# shortname rewrites that one entry and leaves every other line (and comments)
# untouched.
set -euo pipefail

BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_CHECKOUT="$(cd "$BIN_DIR/.." && pwd)"

NAME="${1:-}"
CHECKOUT_ARG="${2:-$DEFAULT_CHECKOUT}"
REGISTRY="${MUADDIB_HERDR_REGISTRY:-${XDG_CONFIG_HOME:-$HOME/.config}/muaddib/herdr-projects}"

if [ -z "$NAME" ]; then
    echo "herdr-register: usage: $(basename "$0") <shortname> [<muaddib-checkout-dir>]" >&2
    exit 2
fi
# The shortname is the first whitespace-delimited field of a registry line and
# is matched literally by the dispatch picker, so it must be a single token and
# can't masquerade as a comment.
case "$NAME" in
    *[[:space:]]*|'#'*)
        echo "herdr-register: shortname '$NAME' must be a single token that doesn't start with '#'" >&2
        exit 2 ;;
esac

CHECKOUT="$(cd "$CHECKOUT_ARG" 2>/dev/null && pwd)" || {
    echo "herdr-register: checkout dir '$CHECKOUT_ARG' does not exist" >&2; exit 1; }
if [ ! -x "$CHECKOUT/muaddib.sh" ]; then
    echo "herdr-register: '$CHECKOUT' has no executable muaddib.sh — not a muaddib checkout" >&2
    exit 1
fi

mkdir -p "$(dirname "$REGISTRY")"
touch "$REGISTRY"

# Rewrite the registry: drop any existing entry whose first field is this
# shortname, keep every other line verbatim (comments, blanks, other projects),
# then append the fresh mapping. A tab separates the two fields.
tmp="$(mktemp)"
while IFS= read -r line || [ -n "$line" ]; do
    first="${line%%[[:space:]]*}"
    [ "$first" = "$NAME" ] && continue
    printf '%s\n' "$line" >>"$tmp"
done < "$REGISTRY"
printf '%s\t%s\n' "$NAME" "$CHECKOUT" >>"$tmp"
mv "$tmp" "$REGISTRY"

echo "herdr-register: '$NAME' → $CHECKOUT   ($REGISTRY)"
