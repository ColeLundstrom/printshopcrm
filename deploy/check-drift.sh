#!/usr/bin/env bash
#
# Are GitHub, the app server and the website all on the same release?
#
#   bash deploy/check-drift.sh                       # from a clone, checks everything it can
#   SLACK_WEBHOOK=... bash deploy/check-drift.sh     # posts only when something has drifted
#
# Exit 0 = in step. Exit 1 = drift. Run it nightly; see RELEASING.md for why drift matters
# (an AGPL install whose source link doesn't match the running code is making a false offer).
#
# Env:
#   APP_HOST      user@host of the server            (default: none, skips the server checks)
#   SSH_KEY       identity file for that host
#   APP_PATH      /opt/printshopcrm-pro/current
#   SITE_PATH     /opt/printshopcrm/current
#   SLACK_WEBHOOK incoming-webhook URL for the alert
#   SLACK_TOKEN + SLACK_CHANNEL   bot-token alternative to the webhook

set -uo pipefail
cd "$(dirname "$0")/.."

APP_HOST="${APP_HOST:-}"
SSH_KEY="${SSH_KEY:-}"
APP_PATH="${APP_PATH:-/opt/printshopcrm-pro/current}"
SITE_PATH="${SITE_PATH:-/opt/printshopcrm/current}"

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10)
[ -n "$SSH_KEY" ] && SSH=(ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=10)
# APP_HOST=local reads the paths directly — for running this ON the server itself.
LOCAL_MODE=0
[ "$APP_HOST" = "local" ] || [ "$APP_HOST" = "localhost" ] && LOCAL_MODE=1
readlink_rel() {
  if [ "$LOCAL_MODE" = "1" ]; then basename "$(readlink -f "$1" 2>/dev/null)" 2>/dev/null || echo '?'
  else "${SSH[@]}" "$APP_HOST" "basename \$(readlink -f '$1')" 2>/dev/null || echo '?'; fi
}

problems=()
note() { printf '  %s\n' "$1"; }
bad()  { printf '  ✗ %s\n' "$1"; problems+=("$1"); }
good() { printf '  ✓ %s\n' "$1"; }

echo
echo "PrintShopCRM — release drift check"
echo

# ---------------------------------------------------------------- git / GitHub
git fetch --quiet origin 2>/dev/null || true
LOCAL="$(git rev-parse --short HEAD 2>/dev/null || echo '?')"
REMOTE="$(git rev-parse --short origin/main 2>/dev/null || echo '?')"
# `git status --porcelain` printing nothing because git REFUSED to run looks exactly like a clean
# tree, so capture git's own exit status rather than the emptiness of its output.
DIRTY_RAW="$(git status --porcelain 2>/dev/null)"; DIRTY_OK=$?
DIRTY="$(printf '%s' "$DIRTY_RAW" | grep -c . || true)"

note "local HEAD    $LOCAL"
note "origin/main   $REMOTE"

# A monitor must never report green because it failed to look.
#
# These were `$(git rev-parse … || echo '?')`, so when git refused the repo BOTH sides became '?',
# '?' = '?' compared equal, and the drift check printed "✓ GitHub matches this working tree". That
# is what was happening in production: root ran this against a repo git rejected for dubious
# ownership, and /var/log/printshopcrm-drift.log shows `local HEAD ?` / `origin/main ?` followed by
# two green ticks every night. The only monitoring in the repo was reporting success by failing.
if [ "$LOCAL" = "?" ] || [ "$REMOTE" = "?" ]; then
  bad "could not read git here — this check did not run (dubious ownership? not a clone? no origin?)"
  note "      try: git config --global --add safe.directory \"$(pwd)\""
elif [ "$LOCAL" = "$REMOTE" ]; then
  good "GitHub matches this working tree"
else
  bad "GitHub is out of step with this working tree ($LOCAL vs $REMOTE)"
fi

if [ "$DIRTY_OK" -ne 0 ]; then
  bad "could not read the working tree state — this check did not run"
elif [ "$DIRTY" = "0" ]; then
  good "working tree is clean"
else
  bad "$DIRTY uncommitted change(s) — whatever is deployed is not fully in git"
fi

# ---------------------------------------------------------------- app server
if [ -n "$APP_HOST" ]; then
  echo
  if bash deploy/verify-sync.sh "$APP_HOST" "$APP_PATH" ${SSH_KEY:+"$SSH_KEY"} >/tmp/psc-sync.$$ 2>&1; then
    good "app server runs exactly this source"
  else
    bad "app server has drifted from the source"
    sed 's/^/      /' /tmp/psc-sync.$$ | head -12
  fi
  rm -f /tmp/psc-sync.$$

  # The app tells every user where its source is (AGPL §13). If that link is a repo whose
  # HEAD is not what the server runs, the offer the app makes is not true.
  REL="$(readlink_rel "$APP_PATH")"
  note "app release   $REL"

  SITE_REL="$(readlink_rel "$SITE_PATH")"
  note "site release  $SITE_REL"
  [ "$SITE_REL" = "?" ] && bad "could not read the website release" || good "website is serving a named release"
else
  echo
  note "APP_HOST not set — skipped the server and website checks"
fi

# ---------------------------------------------------------------- report
echo
if [ ${#problems[@]} -eq 0 ]; then
  echo "  In step: GitHub, the app server and the website agree."
  exit 0
fi

echo "  DRIFT — ${#problems[@]} problem(s):"
for p in "${problems[@]}"; do echo "    · $p"; done
echo
echo "  See RELEASING.md. Ship with deploy/ship.sh so all three move together."

# Alert, but only on drift — a nightly "all fine" message trains you to ignore the channel.
TEXT=":warning: *PrintShopCRM release drift*\\n$(printf '• %s\\n' "${problems[@]}")\\n_See RELEASING.md_"
if [ -n "${SLACK_WEBHOOK:-}" ]; then
  curl -sf -X POST -H 'Content-Type: application/json' \
    -d "{\"text\":\"$TEXT\"}" "$SLACK_WEBHOOK" >/dev/null || echo "  (slack webhook post failed)"
elif [ -n "${SLACK_TOKEN:-}" ] && [ -n "${SLACK_CHANNEL:-}" ]; then
  curl -sf -X POST https://slack.com/api/chat.postMessage \
    -H "Authorization: Bearer $SLACK_TOKEN" -H 'Content-Type: application/json' \
    -d "{\"channel\":\"$SLACK_CHANNEL\",\"text\":\"$TEXT\"}" >/dev/null || echo "  (slack post failed)"
fi

exit 1
