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
[ -n "$TAG" ] || { echo "usage: $0 <tag>   e.g. $0 v1.1.0" >&2; echo "       $0 rollback" >&2; echo "       $0 activate <release-name>" >&2; exit 1; }

SRC="${SRC:-$(cd "$(dirname "$0")/.." && pwd)}"

##
## The defaults describe THE INSTALL THIS COPY OF THE SCRIPT BELONGS TO, not /opt/printshopcrm.
##
## They used to be three hardcoded constants, and every caller invokes this script the way ship.sh
## and RELEASING.md print it —
##
##     ssh host "sudo bash /opt/printshopcrm-pro/current/deploy/release.sh rollback"
##
## — with APP_ROOT and SERVICE unset in that shell. So the "roll the app back" command rolled back
## /opt/printshopcrm: the marketing WEBSITE. Measured end to end on a simulated server, the full
## recovery chain ship.sh prints after every deploy exited 0, printed "✓ is live" and "Restored 3
## database(s) / 600 contacts" — while the app stayed on the bad release with 541 of its 600
## contacts, and the website silently went back a version. Restarting then re-ran the migration
## that ate the rows, and the loop reported success every time.
##
## A rollback that redeploys the bad code is worse than having no rollback command. Derive the
## root by walking up from the script that is actually executing: it lives at
## <root>/current/deploy/release.sh or <root>/releases/<tag>/deploy/release.sh, and the `cd` above
## has already resolved `current` to the release it points at. The install root is the first
## ancestor holding both `releases/` and `current`.
##
if [ -z "${APP_ROOT:-}" ]; then
  _d="$SRC"
  while [ "$_d" != "/" ] && [ -n "$_d" ]; do
    _p="$(dirname "$_d")"
    if [ -d "$_p/releases" ] && [ -e "$_p/current" ]; then APP_ROOT="$_p"; break; fi
    _d="$_p"
  done
  unset _d _p
fi
APP_ROOT="${APP_ROOT:-/opt/printshopcrm}"
# The unit is named after the root it serves — /opt/printshopcrm-pro is printshopcrm-pro — so a
# derived APP_ROOT must carry its SERVICE with it or the rollback restarts the wrong daemon.
SERVICE="${SERVICE:-$(basename "$APP_ROOT")}"
# Multi-tenant installs keep control.db and tenants/ under the app root; the single-file layout
# this script was first written for keeps them in /var/lib. Pick the one that is actually there,
# so the snapshot and the restore hint both name the databases that hold the shop's work.
if [ -z "${DATA_ROOT:-}" ]; then
  if [ -d "$APP_ROOT/data" ]; then DATA_ROOT="$APP_ROOT/data"; else DATA_ROOT="/var/lib/printshopcrm"; fi
fi

# Say which install is about to be changed. Every defect above was invisible because the script
# never named the thing it was acting on.
echo "→ install   $APP_ROOT  (service $SERVICE, data $DATA_ROOT)" >&2

##
## Subcommands, because RELEASING.md and ship.sh have both been printing two of these for
## releases and this script had none — every argument was a version tag.
##
##   `release.sh rollback` built a NEW release out of $SRC (which, invoked the documented way as
##   /opt/printshopcrm/current/deploy/release.sh, is the very code you are running away from),
##   named it `releases/rollback`, ran the gate against it, flipped `current` onto it and exited
##   0 with "✓ rollback is live". It also burned `predeploy-rollback-<stamp>` into the backup
##   namespace, and every later attempt is refused for ever because releases/rollback exists.
##
##   `release.sh activate <name>` — which ship.sh prints at the end of EVERY successful release —
##   discarded the name and created a release directory called `activate`.
##
## Both measured on a simulated server. A rollback that deploys the bad code again is worse than
## no rollback command at all.
##
list_releases() { ls -1dt "$APP_ROOT/releases/"*/ 2>/dev/null | head -8 | sed 's/^/    /' >&2; }

case "$TAG" in
  rollback)
    PREV=$(cat "$APP_ROOT/.previous-release" 2>/dev/null || true)
    # -L first: GNU readlink -f prints a path whose LAST component is missing and exits 0, so on a
    # box with no `current` yet this came back as the link itself and we would have recorded a
    # pointer to nothing. Same guard ship.sh carries, for the same reason.
    CUR=''
    if [ -L "$APP_ROOT/current" ]; then
      CUR=$(readlink -f "$APP_ROOT/current" 2>/dev/null || true)
      [ -n "$CUR" ] && [ -d "$CUR" ] || CUR=''
    fi
    if [ -z "$PREV" ] || [ ! -d "$PREV" ]; then
      echo "no usable previous release recorded in $APP_ROOT/.previous-release" >&2
      echo "  pick one by hand:  $0 activate <name>" >&2; list_releases; exit 1
    fi
    if [ "$PREV" = "$CUR" ]; then
      # The old one-liner in ship.sh and RELEASING.md never updated .previous-release, so after one
      # rollback both pointed at the same release and running it again was a silent no-op: exit 0,
      # /health 200, nothing changed, nothing said. Say so, and offer the way further back.
      echo "already on $PREV — .previous-release names the release that is live, so there is nothing to roll back to." >&2
      echo "  to go back further:  $0 activate <name>" >&2; list_releases; exit 1
    fi
    echo "→ rolling back to $PREV"
    sudo ln -sfn "$PREV" "$APP_ROOT/current"
    # Record where we came FROM, so a second rollback works instead of being a no-op.
    [ -n "$CUR" ] && echo "$CUR" | sudo tee "$APP_ROOT/.previous-release" >/dev/null
    # NOT bare: `set -e` is on, and a unit that fails to START returns non-zero — which would end
    # the script here, before the line that tells the operator what they are actually looking at.
    sudo systemctl restart "$SERVICE" || echo "  !  systemctl restart exited non-zero — the service may be down; check: systemctl status $SERVICE"
    echo "  ✓ $PREV is live. This restored the CODE only — a data migration needs a restore from"
    echo "    the pre-deploy snapshot under $DATA_ROOT/backups."
    exit 0 ;;
  activate)
    NAME="${2:-}"
    [ -n "$NAME" ] || { echo "usage: $0 activate <release-name>" >&2; list_releases; exit 1; }
    [ -d "$APP_ROOT/releases/$NAME" ] || { echo "no release '$NAME' under $APP_ROOT/releases" >&2; list_releases; exit 1; }
    CUR=''
    if [ -L "$APP_ROOT/current" ]; then
      CUR=$(readlink -f "$APP_ROOT/current" 2>/dev/null || true)
      [ -n "$CUR" ] && [ -d "$CUR" ] || CUR=''
    fi
    echo "→ activating $NAME"
    sudo ln -sfn "$APP_ROOT/releases/$NAME" "$APP_ROOT/current"
    [ -n "$CUR" ] && echo "$CUR" | sudo tee "$APP_ROOT/.previous-release" >/dev/null
    sudo systemctl restart "$SERVICE" || echo "  !  systemctl restart exited non-zero — the service may be down; check: systemctl status $SERVICE"
    echo "  ✓ $NAME is live"
    exit 0 ;;
esac

# Anything else has to be a version tag. Without this, one mistyped word silently deploys the
# current tree under that word's name and flips onto it.
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+ ]] || {
  echo "'$TAG' is not a version tag." >&2
  echo "  usage: $0 v1.2.3 | $0 rollback | $0 activate <release-name>" >&2
  exit 1; }

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
  BAK_DIR="$DATA_ROOT/backups/predeploy-$TAG-$(date +%Y%m%d%H%M%S)"
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
  # NOT `cp`. Every database here runs in WAL mode, so a crash — the thing you are recovering from
  # — leaves a -wal on disk holding committed frames. SQLite validates a WAL by its own checksums,
  # not against the file it sits beside, so `cp` puts the backup down and the next start replays
  # the crash-time log straight over it. Measured: restore a 500-customer backup, get the 1000 rows
  # you were trying to undo, quick_check "ok", exit 0. Which is 28 lines below this script's own
  # warning that a stale -wal is worse than none.
  # The CODE goes back first. Restoring under the release that ate the data just lets it eat the
  # data again on start — measured: 562 rows restored, 562 rows gone the moment the service came
  # up, because the once(...) migration re-ran against the restored file. And --yes is on the line
  # because it prints the plan and changes nothing without it, which the old line said and then
  # made you work out for yourself.
  echo "  put one back with:  sudo systemctl stop $SERVICE \\"
  echo "    && sudo ln -sfn \$(cat $APP_ROOT/.previous-release) $APP_ROOT/current \\"
  echo "    && node $APP_ROOT/current/bin/restore.mjs '$BAK_DIR' --data-root '$DATA_ROOT' --yes \\"
  echo "    && sudo systemctl start $SERVICE"
  echo "  (drop the --yes to see the plan first — it changes nothing without it)"
  # Keep the five most recent DEPLOY snapshots; the rest are just disk, and backup.sh re-archives
  # them.
  #
  # The prefix is `predeploy-` and the prune is anchored to it, because bin/restore.mjs writes its
  # safety copy into this same directory as `pre-restore-<stamp>` — and that copy holds the ONLY
  # copy of the shop's previous artwork, because restore MOVES the live uploads there rather than
  # copying them. The old `pre-*` glob matched both, so five ordinary deploys silently rm -rf'd the
  # one thing a restore leaves behind to undo itself: proofs, mockups and logos, gone, exit 0,
  # nothing printed. `pre-v` prunes snapshots written under the old prefix, and cannot match
  # `pre-restore-`. The uploads-previous check below is the belt to that braces: nothing in here
  # that is holding somebody's art library gets deleted by this script, whatever it is called.
  for PFX in predeploy- pre-v; do
    # `set -euo pipefail` is on and a prefix that matches nothing makes `ls` exit 1, which would
    # abort the deploy on an install that has never used the legacy prefix. `|| true` on the head
    # of the pipeline, not the tail, so a real failure in the loop body still surfaces.
    { ls -1dt "$DATA_ROOT/backups/$PFX"* 2>/dev/null || true; } | tail -n +6 | while IFS= read -r OLD; do
      if [ -e "$OLD/uploads-previous" ]; then
        echo "  keeping $OLD — it holds the only copy of artwork a restore set aside"
      else
        rm -rf "$OLD"
      fi
    done
  done
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

# NOT bare. Under `set -e` a non-zero `systemctl restart` ended the script on this line — after
# `current` had already been flipped — so the port lookup, the /health loop, the rollback and the
# journalctl dump below were all unreachable. systemd returns non-zero when the unit fails to
# START: 203/EXEC if ExecStart's hardcoded /usr/bin/node has moved to nvm, 226/NAMESPACE if
# ReadWritePaths no longer resolves. That is exactly the failure where the app cannot be asked
# whether it is healthy, and it was the one where the health-based rollback never ran. Let it fail,
# and let the loop below reach its own conclusion.
sudo systemctl restart "$SERVICE" || echo "!  systemctl restart exited non-zero — checking whether anything is serving anyway" >&2

# --- is it actually serving? ---------------------------------------------------------------------
#
# This decided on `systemctl is-active`, which on a Type=simple unit goes true the moment the
# process FORKS — before the port is bound and before a single shop's database has been opened. So
# a release that started and then failed every request printed "✓ <tag> is live" and stayed flipped
# in. ship.sh was given a real /health probe in v1.14.0; this script — the one INSTALL.md tells
# self-hosters to run — was not. Ask the app the way a customer would.
#
# ?strict=1 on purpose, and this is the whole point of the probe. Plain /health is the PLATFORM's
# liveness probe: it stays 200 `{"ok":true,"degraded":true}` when one shop's database will not open,
# because answering 503 there would de-route every HEALTHY shop on the box. The DEPLOY gate asks a
# stricter question — a release that leaves any shop unable to open its database is a release that
# rolls back — and only ?strict=1 answers it. That is exactly the failure a migration causes on one
# shop's real data, and exactly the thing the pre-migration backup above exists for. Polling plain
# /health here printed "✓ is live" over it and never restored the snapshot it had just taken.
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
  if curl -fsS --max-time 5 "http://127.0.0.1:$PORT/health?strict=1" >/dev/null 2>&1; then HEALTHY=1; break; fi
done

if [ "$HEALTHY" = '1' ]; then
  echo "✓ $TAG is live and answering /health?strict=1"
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
  echo "✗ $TAG is not answering /health?strict=1 on port $PORT — rolling back" >&2
  curl -sS --max-time 5 "http://127.0.0.1:$PORT/health?strict=1" >&2 || true   # names the shops that are dark
  echo >&2
  if [ -n "$PREVIOUS" ] && [ -d "$PREVIOUS" ]; then
    sudo ln -sfn "$PREVIOUS" "$APP_ROOT/current"
    # Same reason, and it matters more here: if THIS restart fails the operator must still be told
    # where the box was left, and still get the journalctl dump below.
    sudo systemctl restart "$SERVICE" || echo "  …and the rollback's own restart exited non-zero — the service may be down" >&2
    echo "  rolled back to $PREVIOUS" >&2
  else
    echo "  NO PREVIOUS RELEASE RECORDED — the service is left on this one; fix it by hand" >&2
  fi
  journalctl -u "$SERVICE" -n 30 --no-pager >&2
  exit 1
fi
