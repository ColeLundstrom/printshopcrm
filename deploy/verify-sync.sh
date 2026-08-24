#!/usr/bin/env bash
#
# Is the deployed server running exactly the code in this repository?
#
#   bash deploy/verify-sync.sh user@host /opt/printshopcrm/current
#   bash deploy/verify-sync.sh rosieadmin@1.2.3.4 /opt/printshopcrm-pro/current ~/.ssh/id_ed25519
#
# Open source only means something if the running service matches the published source, so this is
# also how an AGPL deployment demonstrates it is serving what it says it is.
#
# Compares a SHA-256 of every tracked runtime file — server, lib, public, bin, package.json — and
# ignores documentation, CI and deploy configs, which never ship. Exit 0 means identical.

set -uo pipefail

HOST="${1:-}"
REMOTE="${2:-/opt/printshopcrm/current}"
KEY="${3:-}"

[ -n "$HOST" ] || { echo "usage: $0 <user@host|local> [path] [ssh-key]" >&2; exit 1; }
# "local" reads the deployed path directly, for running this ON the server (where sshing to
# yourself needs a key you probably haven't set up).
LOCAL_MODE=0
[ "$HOST" = "local" ] || [ "$HOST" = "localhost" ] && LOCAL_MODE=1
SSH=(ssh); [ -n "$KEY" ] && SSH=(ssh -i "$KEY")

command -v git >/dev/null || { echo "git required" >&2; exit 1; }
cd "$(dirname "$0")/.."

LOCAL_SUMS=$(mktemp); REMOTE_SUMS=$(mktemp); FILES=$(mktemp)
trap 'rm -f "$LOCAL_SUMS" "$REMOTE_SUMS" "$FILES"' EXIT

# Only what actually runs on the server.
git ls-files \
  | grep -E '^(server\.mjs|seed\.mjs|package\.json|lib/|public/|bin/)' \
  | grep -v '^docs/' \
  | grep -v 'public/uploads/' \
  > "$FILES"

SHA=$(command -v sha256sum >/dev/null && echo sha256sum || echo "shasum -a 256")
while read -r f; do $SHA "$f"; done < "$FILES" | awk '{print $1"  "$2}' | sort -k2 > "$LOCAL_SUMS"

SUM_SCRIPT="cd '$REMOTE' 2>/dev/null || exit 9; while read -r f; do if [ -f \"\$f\" ]; then sha256sum \"\$f\"; else echo \"MISSING  \$f\"; fi; done"
if [ "$LOCAL_MODE" = "1" ]; then
  bash -c "$SUM_SCRIPT" < "$FILES" | awk '{print $1"  "$2}' | sort -k2 > "$REMOTE_SUMS"
else
  # shellcheck disable=SC2029
  "${SSH[@]}" "$HOST" "$SUM_SCRIPT" < "$FILES" | awk '{print $1"  "$2}' | sort -k2 > "$REMOTE_SUMS"
fi

if [ ! -s "$REMOTE_SUMS" ]; then
  echo "  could not read $REMOTE${LOCAL_MODE:+ locally}" >&2
  exit 1
fi

TOTAL=$(wc -l < "$FILES" | tr -d ' ')
if diff -q "$LOCAL_SUMS" "$REMOTE_SUMS" >/dev/null; then
  echo "  ✓ in sync — all $TOTAL runtime files at $REMOTE match this working tree"
  exit 0
fi

echo "  ✗ DRIFT — the deployed code is not what is in this repository:"
join -j2 -o 0,1.1,2.1 "$LOCAL_SUMS" "$REMOTE_SUMS" 2>/dev/null | awk '$2!=$3 {print "    differs: "$1}'
grep '^MISSING' "$REMOTE_SUMS" | awk '{print "    missing on server: "$2}'
comm -13 <(cut -c66- "$REMOTE_SUMS" | sort) <(cut -c66- "$LOCAL_SUMS" | sort) 2>/dev/null | sed 's/^/    only local: /'
echo
echo "  Deploy the current tree with deploy/release.sh, or investigate what changed on the server."
exit 1
