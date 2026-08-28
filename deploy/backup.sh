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

# Refuse up front rather than half-succeeding. Roughly 2x the data size covers the uncompressed
# snapshot plus its archive; failing here is a loud, actionable exit rather than a partial run.
AVAIL="$(df -Pk "$(dirname "$BACKUP_ROOT")" 2>/dev/null | awk 'NR==2{print $4}')"
NEED="$(du -sk "$DATA_ROOT" 2>/dev/null | cut -f1)"
if [ -n "$AVAIL" ] && [ -n "$NEED" ] && [ "$AVAIL" -le $((NEED * 2)) ]; then
  echo "not enough free space for a backup: ${AVAIL}K available, about $((NEED * 2))K needed" >&2
  exit 1
fi

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

# A backup of nothing is not a backup. With count=0 and failed=0 this script printed
# "backup ok - 0 database(s)" and exited 0, so a typo'd DATA_ROOT, a moved PSC_DB or an unmounted
# volume produced a green cron line every night and thirty days of empty archives. You find out on
# the day you need it, which is the one day it must not be a surprise.
if [ "$count" -eq 0 ]; then
  echo "FAILED: no databases found under $DATA_ROOT — is DATA_ROOT right, and is the volume mounted?" >&2
  failed=$((failed + 1))
fi

# Customer artwork. Without it, restored proofs come back as broken images.
#
# -h so that a SYMLINKED uploads directory is archived by CONTENT. INSTALL.md has the app's
# public/uploads symlinked onto the data volume, and plain `tar cz` stores a symlink as one link
# entry: the archive was created, tar exited 0, and not one piece of artwork was in it.
if [ -e "$DATA_ROOT/uploads" ]; then
  if tar czhf "$DEST/uploads.tar.gz" -C "$DATA_ROOT" uploads 2>/dev/null; then
    art_src="$(find -L "$DATA_ROOT/uploads" -type f 2>/dev/null | wc -l | tr -d ' ')"
    art_arc="$(tar tzf "$DEST/uploads.tar.gz" 2>/dev/null | grep -vc '/$' || true)"
    if [ "$art_src" -gt 0 ] && [ "$art_arc" -eq 0 ]; then
      echo "FAILED: $art_src artwork file(s) on disk but none in the archive" >&2
      failed=$((failed + 1))
    fi
  else
    echo "FAILED to archive uploads" >&2
    failed=$((failed + 1))
  fi
else
  # Not a failure on a brand-new install that has never had an upload — but never silent, because
  # the alternative is discovering it during a restore.
  echo "WARNING: no artwork directory at $DATA_ROOT/uploads — restored proofs will be broken images" >&2
fi

# Verify what we just wrote actually opens. A backup nobody has ever restored is a hope, not a plan.
while IFS= read -r bk; do
  sqlite3 "$bk" 'PRAGMA quick_check;' >/dev/null 2>&1 || { echo "VERIFY FAILED: $bk is not a readable database" >&2; failed=$((failed + 1)); }
done < <(find "$DEST" -name '*.db')

# Test the tar. This used to be `tar ... 2>/dev/null && rm -rf "$DEST"`, with the exit status
# never checked and the reason thrown away — so a failed archive (a full disk being the realistic
# cause) still reached the "backup ok" line at the bottom and exited 0. Cron logged a clean run
# every night while the newest archive was a truncated gzip, and you find out on the day you need
# it. The `&&` also skipped the cleanup, leaving the uncompressed snapshot behind to consume more
# of the disk that caused the failure, which retention never swept because it only matched *.tar.gz.
if tar czf "$DEST.tar.gz" -C "$BACKUP_ROOT" "$STAMP"; then
  rm -rf "$DEST"
else
  echo "FAILED to create $DEST.tar.gz — check free space on $BACKUP_ROOT" >&2
  failed=$((failed + 1))
  rm -rf "$DEST" "$DEST.tar.gz"
fi

# Retention. Sweep stray snapshot DIRECTORIES too, not just archives — a night that failed before
# the tar leaves one behind, and without this they accumulate forever.
find "$BACKUP_ROOT" -maxdepth 1 -name '*.tar.gz' -mtime "+$KEEP_DAYS" -delete 2>/dev/null
find "$BACKUP_ROOT" -maxdepth 1 -mindepth 1 -type d -mtime "+$KEEP_DAYS" -exec rm -rf {} + 2>/dev/null

SIZE="$(du -h "$DEST.tar.gz" 2>/dev/null | cut -f1)"

# ---------------------------------------------------------------------------
# Off-site copy. A backup on the disk that just failed is not a backup.
#
# Runs only when PSC_BACKUP_GDRIVE_REFRESH_TOKEN is set, and uploads to the Drive of whoever
# configured it — your install, your Google account. See `node bin/backup-drive.mjs connect`.
# A failed upload is reported but does NOT fail the local backup, which already succeeded.
# ---------------------------------------------------------------------------
# Where the app itself lives, so we can find the uploader.
#
# This used to be only `dirname $0/..` — and the header of this very file tells you to install it
# as /usr/local/bin/printshopcrm-backup, which makes that /usr/local. bin/backup-drive.mjs is not
# there, the `-f` test below failed, and the script printed "backup ok" having sent NOTHING
# off-site. An operator who had connected Google Drive believed their backups were leaving the box
# for as long as it took the box to die. Look in the documented install locations too, and if the
# uploader still cannot be found while off-site backup is CONFIGURED, say so loudly.
APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
if [ ! -f "$APP_DIR/bin/backup-drive.mjs" ]; then
  for candidate in /opt/printshopcrm-pro/current /opt/printshopcrm/current /opt/printshopcrm; do
    if [ -f "$candidate/bin/backup-drive.mjs" ]; then APP_DIR="$candidate"; break; fi
  done
fi
if [ -n "${PSC_BACKUP_GDRIVE_REFRESH_TOKEN:-}" ] && [ ! -f "$APP_DIR/bin/backup-drive.mjs" ]; then
  echo "WARNING: off-site backup is configured, but bin/backup-drive.mjs was not found under $APP_DIR." >&2
  echo "         THIS BACKUP EXISTS ONLY ON THIS MACHINE. Re-run with APP_DIR=/path/to/printshopcrm." >&2
fi
if [ -f "$DEST.tar.gz" ] && [ -n "${PSC_BACKUP_GDRIVE_REFRESH_TOKEN:-}" ] && [ -f "$APP_DIR/bin/backup-drive.mjs" ]; then
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
