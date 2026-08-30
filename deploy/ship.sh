#!/usr/bin/env bash
#
# Ship a release: GitHub and the app server, in one pass, in the right order.
#
#   bash deploy/ship.sh v1.1.0 "what changed, in one line"
#
# Stops at the first failure and tells you what state you are in. See RELEASING.md.
#
# Env:
#   APP_HOST   user@host of the app server        (required)
#   SSH_KEY    identity file
#   APP_ROOT   /opt/printshopcrm-pro
#   SERVICE    printshopcrm-pro
#   DATA_UPLOADS  path the release's public/uploads must symlink to

set -uo pipefail
cd "$(dirname "$0")/.."

TAG="${1:-}"
SUMMARY="${2:-}"
APP_HOST="${APP_HOST:-}"
SSH_KEY="${SSH_KEY:-}"
APP_ROOT="${APP_ROOT:-/opt/printshopcrm-pro}"
SERVICE="${SERVICE:-printshopcrm-pro}"
HEALTH_TRIES="${PSC_HEALTH_TRIES:-10}"
DATA_UPLOADS="${DATA_UPLOADS:-$APP_ROOT/data/uploads}"

die() { printf '\n  ✗ %s\n\n' "$1" >&2; exit 1; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

[ -n "$TAG" ] || die "usage: bash deploy/ship.sh <tag> \"summary\"   e.g. v1.1.0 \"fix overdue filter\""
[ -n "$APP_HOST" ] || die "set APP_HOST=user@host"
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+ ]] || die "tag should look like v1.2.3"

SSH=(ssh); [ -n "$SSH_KEY" ] && SSH=(ssh -i "$SSH_KEY")
RSYNC_E="ssh"; [ -n "$SSH_KEY" ] && RSYNC_E="ssh -i $SSH_KEY"

# ---------------------------------------------------------------- 1. preconditions
step "Checking the working tree"
[ -z "$(git status --porcelain)" ] || die "uncommitted changes — commit or stash first"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || die "on '$BRANCH' — releases ship from main"
git fetch --quiet origin
# Being AHEAD of origin/main is the normal state here — you commit, then you ship, and step 3 does
# the push. Requiring HEAD == origin/main made the "one command" release impossible for the case it
# exists to serve. What must be refused is being BEHIND or DIVERGED: shipping then would either
# publish a tag missing someone else's commits, or fail the push halfway and leave GitHub, the tag
# and the server disagreeing — the exact drift RELEASING.md is about.
BEHIND="$(git rev-list --count HEAD..origin/main)"
[ "$BEHIND" = "0" ] || die "main is $BEHIND commit(s) behind origin/main — pull (and re-run the gates) first"
AHEAD="$(git rev-list --count origin/main..HEAD)"
git rev-parse "$TAG" >/dev/null 2>&1 && die "$TAG already exists"
echo "  clean, on main, $([ "$AHEAD" = "0" ] && echo 'in step with origin' || echo "$AHEAD commit(s) to push")"

# ---------------------------------------------------------------- 2. tests
step "Running the gates"
npm test || die "unit tests failed — nothing shipped"
npm run test:e2e || die "end-to-end tests failed — nothing shipped"

# ---------------------------------------------------------------- 3. GitHub
step "Tagging and pushing to GitHub"
git tag -a "$TAG" -m "${SUMMARY:-$TAG}" || die "could not create the tag"
git push origin main --quiet || die "push failed"
git push origin "$TAG" --quiet || die "tag push failed — GitHub and your tree now disagree"
echo "  pushed $TAG (this also builds and publishes the container image)"

# ---------------------------------------------------------------- 4. app server
REL_NAME="${TAG}-$(date +%Y-%m-%d)"
REL="$APP_ROOT/releases/$REL_NAME"
step "Deploying to $APP_HOST as $REL_NAME"

"${SSH[@]}" "$APP_HOST" "test ! -e '$REL'" || die "$REL already exists on the server"

rsync -a -e "$RSYNC_E" \
  --exclude node_modules --exclude .git --exclude data --exclude '.env' \
  --exclude 'public/uploads' --exclude '*.db' --exclude '*.db-wal' --exclude '*.db-shm' \
  --exclude 'docs/img' \
  ./ "$APP_HOST:$REL/" || die "rsync failed — nothing was flipped"

# shellcheck disable=SC2029
"${SSH[@]}" "$APP_HOST" "
  set -e
  ln -sfn '$DATA_UPLOADS' '$REL/public/uploads'
  cd '$REL' && npm ci --omit=dev >/dev/null 2>&1
  node bin/gate.mjs >/dev/null || { echo 'GATE FAILED ON THE SERVER'; exit 1; }
  # GNU readlink -f prints a path whose LAST component is missing and exits 0, so on a first
  # deploy PREV came back as the link about to be replaced and the rollback below pointed current
  # at itself: ELOOP, and Restart=always looping on it forever. A way home has to be a link that
  # resolves to a directory that is really there. (See deploy/release.sh for the full account.)
  PREV=''
  if [ -L '$APP_ROOT/current' ]; then
    PREV=\$(readlink -f '$APP_ROOT/current' 2>/dev/null || true)
    [ -n \"\$PREV\" ] && [ -d \"\$PREV\" ] || PREV=''
  fi
  if [ -n \"\$PREV\" ]; then echo \"\$PREV\" | sudo tee '$APP_ROOT/.previous-release' >/dev/null
  else sudo rm -f '$APP_ROOT/.previous-release'; fi
  sudo ln -sfn '$REL' '$APP_ROOT/current'
  # NOT bare. Under the \`set -e\` at the top of this block a non-zero \`systemctl restart\` ended the
  # remote script right here — after the flip — so the /health loop and the rollback below were
  # unreachable, and the outer die()'s \"see the output above for whether it rolled back\" had no
  # answer in it. systemd returns non-zero when the unit fails to START (203/EXEC, 226/NAMESPACE),
  # which is the one failure where the app cannot be asked whether it is healthy.
  sudo systemctl restart '$SERVICE' || echo 'systemctl restart exited non-zero — checking /health anyway'

  # is-active on a Type=simple unit goes true the moment the process FORKS — before the port is
  # bound and before a single database is opened. It was the whole liveness gate, so a release that
  # booted and then failed every request still counted as a successful deploy, and the automatic
  # rollback never fired. Ask the app itself, over HTTP, the way a customer would.
  #
  # systemctl show, not a grep of the unit file: it resolves drop-in overrides too, and the SHIPPED
  # deploy/printshopcrm.service carries no Environment=PORT at all — it uses an EnvironmentFile. So
  # the old grep found nothing, the old code then fell back to is-active, and the gate quietly
  # became the exact check it was written to replace. Both seds are pipelines, so `set -e` never
  # caught the failure to read either file.
  PORT=\$(systemctl show -p Environment --value '$SERVICE' 2>/dev/null | tr ' ' '\\n' | sed -n 's/^PORT=//p' | tail -1)
  [ -n \"\$PORT\" ] || PORT=\$(sed -n 's/^[[:space:]]*PORT=//p' '$APP_ROOT/.env' 2>/dev/null | tr -d '\\042\\047[:space:]' | tail -1)
  # server.mjs: \`const PORT = process.env.PORT || 3333\`. An unset PORT is 3333, not unknown. There
  # is deliberately no is-active fallback: if the app will not answer, the release does not ship.
  [ -n \"\$PORT\" ] || PORT=3333
  # /health opens every tenant database, so an install with a lot of shops legitimately takes longer
  # than 20s to answer the first time. PSC_HEALTH_TRIES raises it rather than letting a slow boot
  # look like a bad release.
  #
  # ?strict=1 on purpose. Plain /health is the PLATFORM's liveness probe — Dockerfile's
  # HEALTHCHECK, fly.toml's checks, render.yaml's healthCheckPath — and it stays 200 (degraded)
  # when one shop's database is dark, because taking every healthy shop out of the load balancer
  # over one lost file is a worse outage than the one being reported. The DEPLOY gate is the
  # question this loop is asking, and it is stricter: a release that leaves any shop unable to open
  # its database is a release that rolls back.
  HEALTHY=0
  for _ in \$(seq 1 $HEALTH_TRIES); do
    sleep 2
    if curl -fsS --max-time 5 \"http://127.0.0.1:\$PORT/health?strict=1\" >/dev/null 2>&1; then HEALTHY=1; break; fi
  done

  if [ \"\$HEALTHY\" != '1' ]; then
    echo \"RELEASE IS NOT ANSWERING /health?strict=1 ON PORT \$PORT — rolling back\"
    curl -sS --max-time 5 \"http://127.0.0.1:\$PORT/health?strict=1\" || true   # names the shops that are dark
    echo
    if [ -n \"\$PREV\" ] && [ -d \"\$PREV\" ]; then
      sudo ln -sfn \"\$PREV\" '$APP_ROOT/current'
      sudo systemctl restart '$SERVICE' || echo \"…and the rollback's own restart exited non-zero — the service may be down\"
      echo 'rolled back to the previous release'
    else
      echo 'NO PREVIOUS RELEASE RECORDED — the service is left stopped/broken, fix it by hand'
    fi
    exit 1
  fi
" || die "server deploy failed — see the output above for whether it rolled back. GitHub is now AHEAD of the server: fix and re-run, or revert the tag."
echo "  live and answering /health"

# ---------------------------------------------------------------- 5. prove it
step "Verifying the server runs exactly this source"
bash deploy/verify-sync.sh "$APP_HOST" "$APP_ROOT/current" ${SSH_KEY:+"$SSH_KEY"} \
  || die "server does not match the tag — investigate before announcing"

# ---------------------------------------------------------------- 6. the website
step "Website"
cat <<EOF
  The website is a separate release and is NOT updated by this script — marketing copy is a
  judgement call, not a diff.

  If $TAG added, removed or changed anything a customer can see, update the site too:
    · a REMOVED feature is the dangerous one — the site will keep selling it
    · grep the site source, blog posts included, before you call this shipped
    · rewrite stale posts rather than deleting them; the URL is earning traffic

  Then:  bash deploy/release.sh activate <site-release>      (see RELEASING.md)
EOF

step "Shipped $TAG"
echo "  GitHub:  https://github.com/ColeLundstrom/printshopcrm/releases/tag/$TAG"
echo "  Server:  $REL_NAME"
echo "  Roll back: sudo ln -sfn \$(cat $APP_ROOT/.previous-release) $APP_ROOT/current && sudo systemctl restart $SERVICE"
echo
