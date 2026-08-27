#!/usr/bin/env bash
#
# Deploy a new PrintShopCRM release next to the current one and flip a symlink.
#
#   sudo -u printshopcrm bash deploy/release.sh v1.1.0
#
# Layout it maintains:
#
#   /opt/printshopcrm/releases/<tag>/     the code, immutable once deployed
#   /opt/printshopcrm/current  ->         symlink to the live release
#   /var/lib/printshopcrm/printshop.db    the database  (PSC_DB, outside releases)
#   /var/lib/printshopcrm/uploads/        customer artwork (outside releases)
#
# The two things that must live OUTSIDE a release are the database and the uploads directory.
# Uploads are easy to get wrong: if public/uploads is a real directory inside the release, every
# deploy silently strands the artwork in the old one and every proof uploaded before that deploy
# becomes a broken image. So this script symlinks it to the persistent path, every time.
#
# Rolling back is repointing `current` at the previous release and restarting.

set -euo pipefail

TAG="${1:-}"
[ -n "$TAG" ] || { echo "usage: $0 <tag>   e.g. $0 v1.1.0" >&2; exit 1; }

APP_ROOT="${APP_ROOT:-/opt/printshopcrm}"
DATA_ROOT="${DATA_ROOT:-/var/lib/printshopcrm}"
SERVICE="${SERVICE:-printshopcrm}"
SRC="${SRC:-$(cd "$(dirname "$0")/.." && pwd)}"

RELEASE="$APP_ROOT/releases/$TAG"
UPLOADS="$DATA_ROOT/uploads"

[ -e "$RELEASE" ] && { echo "refusing: $RELEASE already exists — pick a new tag" >&2; exit 1; }

echo "→ source   $SRC"
echo "→ release  $RELEASE"

mkdir -p "$APP_ROOT/releases" "$UPLOADS"

# --- copy the code, never the data -------------------------------------------------------------
rsync -a \
  --exclude node_modules \
  --exclude .git \
  --exclude data \
  --exclude '.env' \
  --exclude 'public/uploads' \
  --exclude '*.db' --exclude '*.db-wal' --exclude '*.db-shm' \
  "$SRC/" "$RELEASE/"

# --- persistent uploads ------------------------------------------------------------------------
rm -rf "$RELEASE/public/uploads"
ln -s "$UPLOADS" "$RELEASE/public/uploads"

# --- config ------------------------------------------------------------------------------------
# .env stays with the app root so it survives releases; link it in.
if [ -f "$APP_ROOT/.env" ]; then
  ln -sf "$APP_ROOT/.env" "$RELEASE/.env"
else
  echo "!  $APP_ROOT/.env not found — the app will start on defaults. See .env.example." >&2
fi

# --- dependencies ------------------------------------------------------------------------------
( cd "$RELEASE" && npm ci --omit=dev )

# --- gate: never flip the symlink onto code that fails its own tests ----------------------------
echo "→ running tests against the new release"
( cd "$RELEASE" && node bin/gate.mjs )

# --- back up the database before any migration runs ---------------------------------------------
if command -v sqlite3 >/dev/null 2>&1 && [ -f "$DATA_ROOT/printshop.db" ]; then
  BAK="$DATA_ROOT/backups/pre-$TAG-$(date +%Y%m%d%H%M%S).db"
  mkdir -p "$(dirname "$BAK")"
  sqlite3 "$DATA_ROOT/printshop.db" ".backup '$BAK'"
  echo "→ database backed up to $BAK"
else
  echo "!  sqlite3 not installed — skipping the pre-deploy backup. Install it: apt-get install sqlite3" >&2
fi

# --- flip ---------------------------------------------------------------------------------------
PREVIOUS="$(readlink -f "$APP_ROOT/current" 2>/dev/null || true)"
# sudo, like the rollback below and the restart after it: `current` is root-owned, so an unprivileged
# flip fails with Permission denied. Without `set -e` on this line that failure was survivable and
# silent — the script went on to restart the service, saw it come up on the OLD release, and printed
# "✓ <tag> is live".
sudo ln -sfn "$RELEASE" "$APP_ROOT/current" || { echo "✗ could not flip $APP_ROOT/current" >&2; exit 1; }
echo "$PREVIOUS" | sudo tee "$APP_ROOT/.previous-release" >/dev/null

sudo systemctl restart "$SERVICE"
sleep 2

if systemctl is-active --quiet "$SERVICE"; then
  echo "✓ $TAG is live"
  [ -n "$PREVIOUS" ] && echo "  roll back with: sudo ln -sfn $PREVIOUS $APP_ROOT/current && sudo systemctl restart $SERVICE"
else
  echo "✗ service failed to start — rolling back" >&2
  [ -n "$PREVIOUS" ] && sudo ln -sfn "$PREVIOUS" "$APP_ROOT/current" && sudo systemctl restart "$SERVICE"
  journalctl -u "$SERVICE" -n 30 --no-pager >&2
  exit 1
fi
