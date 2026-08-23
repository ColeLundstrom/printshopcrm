#!/usr/bin/env bash
#
# Nightly backup of every PrintShopCRM database plus customer artwork.
#
#   sudo cp deploy/backup.sh /usr/local/bin/printshopcrm-backup
#   sudo chmod +x /usr/local/bin/printshopcrm-backup
#   sudo crontab -e     →   0 3 * * * /usr/local/bin/printshopcrm-backup
#
# Uses SQLite's own `.backup`, never `cp`. Copying a live SQLite file can capture a write in
# progress and produce an archive that restores to a corrupt database — and you find out on the
# day you need it. `.backup` takes a consistent snapshot of a database that is being written to.
#
# Requires sqlite3:  apt-get install -y sqlite3
#
# THIS WRITES TO THE SAME MACHINE. A backup sitting on the disk that just died is not a backup.
# See the note at the bottom for getting a copy off the box — that part is not optional.

set -uo pipefail

DATA_ROOT="${DATA_ROOT:-/var/lib/printshopcrm}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/printshopcrm}"
KEEP_DAYS="${KEEP_DAYS:-30}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_ROOT/$STAMP"

command -v sqlite3 >/dev/null 2>&1 || { echo "sqlite3 is not installed — apt-get install -y sqlite3" >&2; exit 1; }
[ -d "$DATA_ROOT" ] || { echo "no data directory at $DATA_ROOT (set DATA_ROOT)" >&2; exit 1; }

mkdir -p "$DEST"
failed=0
count=0

# Every .db under the data root: the control database and one per shop.
while IFS= read -r db; do
  rel="${db#"$DATA_ROOT"/}"
  out="$DEST/$rel"
  mkdir -p "$(dirname "$out")"
  if sqlite3 "$db" ".backup '$out'" 2>/dev/null; then
    count=$((count + 1))
  else
    echo "FAILED to back up $db" >&2
    failed=$((failed + 1))
  fi
done < <(find "$DATA_ROOT" -name '*.db' -not -name '*-wal' -not -name '*-shm')

# Customer artwork. Without it, restored proofs come back as broken images.
if [ -d "$DATA_ROOT/uploads" ]; then
  tar czf "$DEST/uploads.tar.gz" -C "$DATA_ROOT" uploads 2>/dev/null || { echo "FAILED to archive uploads" >&2; failed=$((failed + 1)); }
fi

# Verify what we just wrote actually opens. A backup nobody has ever restored is a hope, not a plan.
while IFS= read -r bk; do
  sqlite3 "$bk" 'PRAGMA quick_check;' >/dev/null 2>&1 || { echo "VERIFY FAILED: $bk is not a readable database" >&2; failed=$((failed + 1)); }
done < <(find "$DEST" -name '*.db')

tar czf "$DEST.tar.gz" -C "$BACKUP_ROOT" "$STAMP" 2>/dev/null && rm -rf "$DEST"

# Retention.
find "$BACKUP_ROOT" -maxdepth 1 -name '*.tar.gz' -mtime "+$KEEP_DAYS" -delete 2>/dev/null

SIZE="$(du -h "$DEST.tar.gz" 2>/dev/null | cut -f1)"

# ---------------------------------------------------------------------------
# Off-site copy. A backup on the disk that just failed is not a backup.
#
# Runs only when PSC_BACKUP_GDRIVE_REFRESH_TOKEN is set, and uploads to the Drive of whoever
# configured it — your install, your Google account. See `node bin/backup-drive.mjs connect`.
# A failed upload is reported but does NOT fail the local backup, which already succeeded.
# ---------------------------------------------------------------------------
APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
if [ -n "${PSC_BACKUP_GDRIVE_REFRESH_TOKEN:-}" ] && [ -f "$APP_DIR/bin/backup-drive.mjs" ]; then
  if node --no-warnings "$APP_DIR/bin/backup-drive.mjs" upload "$DEST.tar.gz"; then
    offsite=" · copied off-site"
  else
    echo "WARNING: off-site upload failed — this backup exists only on this machine" >&2
    offsite=" · OFF-SITE UPLOAD FAILED"
    failed=$((failed + 1))
  fi
else
  offsite=""
fi

if [ "$failed" -gt 0 ]; then
  echo "$(date +%Y-%m-%dT%H:%M:%S%z) backup FINISHED WITH $failed FAILURE(S) — $count db(s), $DEST.tar.gz ($SIZE)$offsite"
  exit 1
fi
echo "$(date +%Y-%m-%dT%H:%M:%S%z) backup ok — $count database(s), $DEST.tar.gz ($SIZE), keeping ${KEEP_DAYS}d$offsite"

# ---------------------------------------------------------------------------
# OFF-SITE OPTIONS
#
# Google Drive is built in — your own Drive, one-time setup:
#   node bin/backup-drive.mjs connect
# then set PSC_BACKUP_GDRIVE_* in the environment this script runs under.
#
# Or use anything else you already have:
#   rclone copy "$DEST.tar.gz" remote:printshopcrm-backups/
#   aws s3 cp   "$DEST.tar.gz" s3://your-bucket/printshopcrm/
#   scp         "$DEST.tar.gz" you@another-host:/backups/
#
# Then actually restore one somewhere else, once, so you know it works:
#   tar xzf 20260823-030000.tar.gz
#   PSC_DB=$PWD/20260823-030000/printshop.db npm start
# ---------------------------------------------------------------------------
