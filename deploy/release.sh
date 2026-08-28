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

# --- back up EVERY database before any migration runs --------------------------------------------
#
# This backed up "$DATA_ROOT/printshop.db" and nothing else. In multi-tenant mode — which is what
# every real install runs — that file is the DEFAULT handle, and lib/db.mjs says in as many words
# that it is never touched for a shop's data. The shops live in $DATA_ROOT/control.db (the registry
# and every login) and $DATA_ROOT/tenants/<slug>/printshop.db. So the snapshot taken at the single
# riskiest moment in the whole deploy — immediately before migrations run against real customer
# data — contained no invoices, no customers, and no way to sign in. 16 KB of nothing.
#
# Take a proper .backup of each one. `cp` is not a backup of a live SQLite database: the -wal may
# hold committed pages the file does not, and a stale -wal beside a restored db is worse than none.
if [ "${PSC_SKIP_BACKUP:-}" = '1' ]; then
  echo "!  PSC_SKIP_BACKUP=1 — deploying with NO pre-migration backup, at your own risk" >&2
else
  command -v sqlite3 >/dev/null 2>&1 || {
    echo "✗ sqlite3 is not installed, so no pre-migration backup can be taken." >&2
    echo "  A migration that fails on real data is unrecoverable without one. Install it:" >&2
    echo "    sudo apt-get install -y sqlite3" >&2
    echo "  Or, if you have your own backup and accept the risk:  PSC_SKIP_BACKUP=1 $0 $TAG" >&2
    exit 1
  }
  BAK_DIR="$DATA_ROOT/backups/pre-$TAG-$(date +%Y%m%d%H%M%S)"
  mkdir -p "$BAK_DIR"
  BAK_N=0
  while IFS= read -r DBF; do
    REL="${DBF#"$DATA_ROOT"/}"
    mkdir -p "$BAK_DIR/$(dirname "$REL")"
    sqlite3 "$DBF" ".backup '$BAK_DIR/$REL'" || { echo "✗ could not back up $DBF" >&2; exit 1; }
    BAK_N=$((BAK_N + 1))
  done < <(find "$DATA_ROOT" -path "$DATA_ROOT/backups" -prune -o -name '*.db' -type f -print | sort)
  # Zero databases means this found nothing to protect. That is not a clean run, it is a wrong
  # DATA_ROOT — and shipping past it is how the last backup turned out to be empty.
  [ "$BAK_N" -gt 0 ] || {
    echo "✗ no databases found under $DATA_ROOT — refusing to migrate with nothing backed up." >&2
    echo "  Set DATA_ROOT to the directory holding control.db and tenants/, or PSC_SKIP_BACKUP=1 to override." >&2
    exit 1
  }
  echo "→ $BAK_N database(s) backed up to $BAK_DIR"
  echo "  restore one with:  sudo systemctl stop $SERVICE && cp '$BAK_DIR/<path>.db' '$DATA_ROOT/<path>.db' && sudo systemctl start $SERVICE"
  # Keep the five most recent snapshots; the rest are just disk, and backup.sh re-archives them.
  ls -1dt "$DATA_ROOT/backups/pre-"* 2>/dev/null | tail -n +6 | while IFS= read -r OLD; do rm -rf "$OLD"; done
fi

# --- flip ---------------------------------------------------------------------------------------
# GNU `readlink -f` only requires all but the LAST component of a path to exist: given a `current`
# that does not exist yet, it prints that very path and exits 0. So on an install's FIRST deploy
# PREVIOUS came back as the link this script is about to replace — the healthy path then handed the
# operator a rollback command pointing current at current, and the failing path RAN it, leaving it a
# symlink to itself: ELOOP, WorkingDirectory unresolvable, Restart=always looping forever, all of it
# printed under the word "rolled back". BSD readlink exits 1 on the same input, which is why no Mac
# and no gate run ever saw it, and why the "first release on this install" branch below was
# unreachable on the Ubuntu box INSTALL.md targets. A previous release is only previous if it is a
# link that resolves to a directory that is really there.
PREVIOUS=''
if [ -L "$APP_ROOT/current" ]; then
  PREVIOUS="$(readlink -f "$APP_ROOT/current" 2>/dev/null || true)"
  [ -n "$PREVIOUS" ] && [ -d "$PREVIOUS" ] || PREVIOUS=''
fi
# sudo, like the rollback below and the restart after it: `current` is root-owned, so an unprivileged
# flip fails with Permission denied. Without `set -e` on this line that failure was survivable and
# silent — the script went on to restart the service, saw it come up on the OLD release, and printed
# "✓ <tag> is live".
sudo ln -sfn "$RELEASE" "$APP_ROOT/current" || { echo "✗ could not flip $APP_ROOT/current" >&2; exit 1; }
# Never record an empty or self-referential way home — a rollback that reads this file has to be
# able to trust it.
if [ -n "$PREVIOUS" ]; then
  echo "$PREVIOUS" | sudo tee "$APP_ROOT/.previous-release" >/dev/null
else
  sudo rm -f "$APP_ROOT/.previous-release"
fi

sudo systemctl restart "$SERVICE"

# --- is it actually serving? ---------------------------------------------------------------------
#
# This decided on `systemctl is-active`, which on a Type=simple unit goes true the moment the
# process FORKS — before the port is bound and before a single shop's database has been opened. So
# a release that started and then failed every request printed "✓ <tag> is live" and stayed flipped
# in. ship.sh was given a real /health probe in v1.14.0; this script — the one INSTALL.md tells
# self-hosters to run — was not. Ask the app the way a customer would.
#
# /health 503s when any shop's database will not open, which is exactly the failure a migration
# causes, so this is the check that catches the thing the backup above exists for.
PORT="$(systemctl show -p Environment --value "$SERVICE" 2>/dev/null | tr ' ' '\n' | sed -n 's/^PORT=//p' | tail -1)"
[ -n "$PORT" ] || PORT="$(sed -n 's/^[[:space:]]*PORT=//p' "$APP_ROOT/.env" 2>/dev/null | tr -d '"'"'"'[:space:]' | tail -1)"
# server.mjs: `const PORT = process.env.PORT || 3333`. An unset PORT is 3333, not unknown — and
# there is deliberately NO is-active fallback here, because falling back to it is what turned a
# broken release into a green one. If the app will not answer, the release does not stay.
[ -n "$PORT" ] || PORT=3333

# /health opens every tenant database, so a shop with a lot of shops legitimately takes longer than
# 20s to answer the first time. Raise this rather than letting a slow boot look like a bad release.
TRIES="${PSC_HEALTH_TRIES:-10}"
HEALTHY=0
for _ in $(seq 1 "$TRIES"); do
  sleep 2
  if curl -fsS --max-time 5 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then HEALTHY=1; break; fi
done

if [ "$HEALTHY" = '1' ]; then
  echo "✓ $TAG is live and answering /health"
  # `[ … ] && echo …` as the LAST command of the script makes its exit status the test's. On an
  # install's very first deploy there is no previous release, so the script printed "is live" and
  # then exited 1 — every CI step wrapping it went red over a deploy that had worked, and re-running
  # was refused because the release directory now existed. An `if` has no exit status to leak.
  if [ -n "$PREVIOUS" ]; then
    echo "  roll back with: sudo ln -sfn $PREVIOUS $APP_ROOT/current && sudo systemctl restart $SERVICE"
  else
    echo "  first release on this install — nothing to roll back to yet"
  fi
else
  echo "✗ $TAG is not answering /health on port $PORT — rolling back" >&2
  curl -sS --max-time 5 "http://127.0.0.1:$PORT/health" >&2 || true   # names the shops that are dark
  echo >&2
  if [ -n "$PREVIOUS" ] && [ -d "$PREVIOUS" ]; then
    sudo ln -sfn "$PREVIOUS" "$APP_ROOT/current"
    sudo systemctl restart "$SERVICE"
    echo "  rolled back to $PREVIOUS" >&2
  else
    echo "  NO PREVIOUS RELEASE RECORDED — the service is left on this one; fix it by hand" >&2
  fi
  journalctl -u "$SERVICE" -n 30 --no-pager >&2
  exit 1
fi
