# Releasing

**The rule: GitHub, the app server, and the website move together, or the release isn't finished.**

Three things can drift apart:

| | What it is | Source of truth |
|---|---|---|
| **GitHub** | the published source | `main` on github.com/ColeLundstrom/printshopcrm |
| **App server** | the running product | `/opt/printshopcrm-pro/current` |
| **Website** | what it claims to do | `/opt/printshopcrm/current` |

Drift between any two is a real failure, not untidiness:

- **Server ahead of GitHub** breaks the AGPL promise. The app shows every user a link to its source; if the running code isn't what that link serves, the offer is false.
- **GitHub ahead of the server** means the release notes describe software nobody is running.
- **Website ahead of either** is selling something that doesn't exist. **Website behind** is selling a feature you removed — which is how a marketing page ends up advertising a tool that was deleted three releases ago.

## One command

```bash
bash deploy/ship.sh v1.1.0 "what changed, in one line"
```

In order, stopping at the first failure:

1. Working tree clean, on `main`, up to date with the remote
2. `npm test` and `npm run test:e2e`
3. Push `main`, tag, push the tag → the tag builds and publishes the container image
4. Deploy to the app server as a new versioned release, run the gate **there**, flip the symlink, restart, health-check, roll back automatically if it fails to start
5. `verify-sync.sh` — every runtime file on the server matches the tag
6. Remind you, by name, of any product claim on the website that this release changed

Step 6 doesn't rebuild the website: marketing copy is a judgement call, not a diff. It tells you what to go and check.

## The website half

The website is a separate versioned release on the same box. When a release adds, removes, or changes a feature a customer can see, the website is part of that release:

```bash
cd <site-source-vNN>
npm run build
rsync -a ./ user@host:/opt/printshopcrm/releases/<name>/
ssh user@host "bash /opt/printshopcrm/releases/<name>/deploy/release.sh activate <name>"
```

**A removed feature is the dangerous direction.** Adding one and forgetting to announce it costs you a sale. Removing one and forgetting to un-announce it means the site sells something that isn't there — a customer signs up for it, doesn't find it, and stops trusting everything else on the page.

So when you remove a feature, grep the site source for it before you ship:

```bash
grep -rIn -i '<the feature>' --include='*.ts' --include='*.tsx' --include='*.js' . | grep -v node_modules | grep -v /dist/
```

Blog posts count. They are indexed, they rank, and they are the copy a stranger reads first. Rewrite the post rather than deleting it — the URL is earning traffic, and an honest article at that URL keeps it.

## Branch protection

`main` requires all six CI jobs green, a code-owner review, and resolved conversations before a PR
merges. Force-push and branch deletion are off.

`enforce_admins` is deliberately **off**: with one maintainer, requiring them to open a PR to
approve their own work is friction with no second pair of eyes to gain. `deploy/ship.sh` pushes
`main` directly and that is intended. The protection exists for *contributors'* PRs, which is where
review actually adds something.

If a second maintainer ever joins, turn `enforce_admins` on the same day.

## Checking without releasing

```bash
bash deploy/check-drift.sh              # all three, exits non-zero on drift
bash deploy/verify-sync.sh user@host /opt/printshopcrm-pro/current
```

`check-drift.sh` runs nightly on the server and posts to Slack when anything diverges, so drift surfaces on its own instead of being discovered months later by a customer.

## Rolling back

```bash
ssh user@host "sudo bash /opt/printshopcrm-pro/current/deploy/release.sh rollback"   # the app
ssh user@host "sudo bash /opt/printshopcrm/current/deploy/release.sh rollback"       # the website
```

`release.sh rollback` records where it came from, so running it twice takes you back and then
forward again rather than doing nothing. To go back further than one release:

```bash
ssh user@host "ls -1dt /opt/printshopcrm-pro/releases/*/ | head"
ssh user@host "sudo bash /opt/printshopcrm-pro/current/deploy/release.sh activate <release-name>"
```

**This puts the CODE back and nothing else.** A release whose migrations restated data — the
`once(...)` blocks in `lib/db.mjs` — is not undone by a symlink. `ship.sh` prints a pre-migration
snapshot path on every deploy; that is what puts the data back:

```bash
ssh user@host "sudo systemctl stop printshopcrm-pro \
  && sudo bash /opt/printshopcrm-pro/current/deploy/release.sh rollback \
  && sudo node /opt/printshopcrm-pro/current/bin/restore.mjs <snapshot-dir> --data-root /var/lib/printshopcrm --yes \
  && sudo systemctl start printshopcrm-pro"
```

Drop the `--yes` to see the plan first; it changes nothing without it.

A rollback puts the server behind GitHub on purpose. That's an accepted, temporary state — but it is still drift, and the nightly check will say so until you either roll forward or revert the tag. That nagging is the point.
