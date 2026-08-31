# Installing PrintShopCRM

Three paths:

- **[Try it locally](#try-it-locally)** — about a minute, any laptop (Linux, macOS, or Windows).
- **[Docker](deploy/DEPLOY.md#docker)** — one command, if you already run containers.
- **[Production install](#production-install)** — a Linux server on your own domain with SSL.

Deploying to Fly.io or Render instead? [deploy/DEPLOY.md](deploy/DEPLOY.md) covers those, and
compares all the options.

Don't want to run a server at all? See [HOSTING.md](HOSTING.md).

---

## Requirements

| | |
|---|---|
| **Node.js** | **22.13.0 or newer.** Non-negotiable — the app uses the built-in `node:sqlite` module, which is flagged off before 22.13. |
| OS | Linux, macOS, or Windows — all three are covered by CI. Production instructions below assume Ubuntu/Debian. |
| Database | None to install. SQLite is inside Node. |
| RAM | 512 MB is plenty. The live reference install idles around 80 MB. |
| Disk | ~150 MB for the app and dependencies, plus your uploads and database. |

Check your version:

```bash
node --version
```

If that prints anything below `v22.13.0`, install Node 22 first — see
[Installing Node 22](#installing-node-22) below.

---

## Try it locally

```bash
git clone https://github.com/ColeLundstrom/printshopcrm.git
cd printshopcrm
npm install
npm run seed
npm start
```

Open **http://localhost:3333**.

`npm run seed` loads a demo shop mid-week — eight customers, nine estimates, eight jobs spread
across the production board — so nothing is empty while you look around. Skip it for a genuinely
blank shop; the database creates itself on first start either way.

`seed` and `reset` are **demo** scripts. They print the database they are about to write to, and
they refuse to run against any database that has records in it and is not the demo shop — whether
or not that shop ever filled its name in under Settings. So pointing `PSC_DB` at a live install
and typing `npm run reset` by mistake stops with a message instead of deleting the shop. If you really do mean to wipe a named shop, back it up and use
`PSC_SEED_FORCE=1 npm run seed`.

```bash
npm run reset     # wipe and reseed
npm run dev       # restart on file changes
npm test          # run the test suite
```

---

## Production install

The reference deployment: one small VPS, nginx terminating SSL, the app on `127.0.0.1:3870`,
systemd keeping it alive.

### 1. Installing Node 22

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version      # expect v22.13.0 or newer
```

### 2. Make the account the service runs as

`deploy/printshopcrm.service` ships `User=printshopcrm`, and nothing creates that account for you.
Do this before anything else, because the two directories below have to belong to it — systemd
refuses a unit whose `User=` does not exist (`status=217/USER`), and `Restart=always` then retries
it forever.

```bash
sudo useradd --system --home-dir /var/lib/printshopcrm --shell /usr/sbin/nologin printshopcrm
```

If you'd rather run it as some other account, that is fine — use that name everywhere below and in
the unit file's `User=`/`Group=`. What must not happen is the app running as one account while its
database and uploads belong to another: you get `PrintShopCRM could not create its data directory`
or `attempt to write a readonly database`, on a service that otherwise looks like it started.

### 3. Get the code

```bash
sudo mkdir -p /opt/printshopcrm
sudo chown -R printshopcrm:printshopcrm /opt/printshopcrm
sudo -u printshopcrm git clone https://github.com/ColeLundstrom/printshopcrm.git /opt/printshopcrm
cd /opt/printshopcrm
sudo -u printshopcrm npm ci --omit=dev
# The service runs `current`, never the checkout directly. Point it at the checkout now and a
# hand-managed install behaves exactly as it always has; deploy/release.sh then re-points it at
# releases/<tag>/ on every deploy, and rolling back is repointing it at the previous one. Without
# this symlink the unit has nothing to run — and if you point the unit at the checkout instead,
# release.sh will flip `current` on every deploy while the service keeps serving the original
# clone, forever, with /health and verify-sync.sh both reporting success.
sudo -u printshopcrm ln -sfn /opt/printshopcrm /opt/printshopcrm/current
```

### 4. Put your data outside the app directory

This matters more than it looks. Two things must live where an upgrade cannot touch them: the
**database** and the **uploads directory**.

```bash
sudo mkdir -p /var/lib/printshopcrm/uploads
# The account in the unit file's User=, not your login. This is the single most common cause of a
# service that starts and then cannot write.
sudo chown -R printshopcrm:printshopcrm /var/lib/printshopcrm
# public/uploads ships as a real directory (it holds a tracked .gitkeep), and `ln -sfn` pointed at
# an existing directory creates the link INSIDE it — you get public/uploads/uploads, exit status 0,
# and no warning. Artwork then writes to the app directory, the backup archives an empty
# /var/lib/printshopcrm/uploads, and both look fine until an upgrade deletes the originals.
sudo rm -rf /opt/printshopcrm/public/uploads
sudo -u printshopcrm ln -sfn /var/lib/printshopcrm/uploads /opt/printshopcrm/public/uploads
# Verify: this must print the symlink, not a directory.
ls -ld /opt/printshopcrm/public/uploads
```

`public/uploads` holds customer artwork. If you leave it as a real directory inside the app and
later deploy by copying a fresh checkout over the top, every proof uploaded before that deploy
becomes a broken image — the files are still on disk, just in the directory you replaced. Making it
a symlink to persistent storage on day one avoids the whole class of problem.

[`deploy/release.sh`](deploy/release.sh) does this correctly if you'd rather deploy with a script:
it keeps releases in `releases/<tag>/`, symlinks uploads and `.env` into each one, runs the test
suite before flipping `current`, and rolls back automatically if the service fails to start.

### 5. Configure

```bash
sudo -u printshopcrm cp .env.example .env
sudo chmod 600 /opt/printshopcrm/.env    # see below — this one is not optional
node -e "console.log('PSC_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
```

`cp` leaves the copy at the mode your umask gives it — usually `0644` — and
`/opt/printshopcrm` is `0755`, so without the `chmod` every account on the box can read this
file. **`PSC_SECRET` signs every customer link the product issues**: estimate approval, payment,
proof, work ticket. Anyone who can read that one line can mint a valid link to any customer's
documents on any shop on this install, with nothing in any log to distinguish it from a real one.
Your SMTP password, Stripe secret, QuickBooks refresh token and Drive backup token are on the
lines beneath it.

Edit `.env`. The minimum for a production install:

```ini
PORT=3870
PSC_HOST=127.0.0.1
PSC_TRUST_PROXY=1
PSC_SECRET=<the value you just generated>
PSC_DB=/var/lib/printshopcrm/printshop.db
PSC_PUBLIC_URL=https://shop.example.com
PSC_AUTH=1
```

**`PSC_HOST=127.0.0.1` is what puts the app behind nginx.** Without it the server binds every
interface, so it also answers directly on the box's LAN and public addresses — around nginx, and
around the TLS nginx is terminating. Leave it unset in Docker, where the container needs to accept
connections from outside itself.

**`PSC_SECRET` is required.** Customer share links — estimate approvals, art proofs — are HMACs
derived from it. Anyone who knows it can forge a link to any customer's documents. Generate it
randomly, never commit it, and don't reuse one across installs.

**`PSC_AUTH=1` turns on logins.** Leave it off only if the app is on a private network or behind
another authentication layer, because without it anyone who can reach the port has full access.

**`PSC_PUBLIC_URL`** should be your real external URL. Without it the app falls back to the
incoming `Host` header to build customer links, and a proxy can spoof that.

`.env.example` documents every other variable.

### 6. Run it as a service

A ready unit file is in [`deploy/printshopcrm.service`](deploy/printshopcrm.service):

```bash
sudo cp deploy/printshopcrm.service /etc/systemd/system/
sudo nano /etc/systemd/system/printshopcrm.service     # only if you changed the paths or the account
sudo systemctl daemon-reload
sudo systemctl enable --now printshopcrm
systemctl status printshopcrm
```

Logs:

```bash
journalctl -u printshopcrm -f
```

### 7. nginx and SSL

Copy both config files — [`deploy/nginx.conf`](deploy/nginx.conf) and
[`deploy/upgrade-map.conf`](deploy/upgrade-map.conf) — and replace `shop.example.com` with your
domain (and `3870` with your `PORT`):

```bash
sudo cp deploy/upgrade-map.conf /etc/nginx/conf.d/
sudo cp deploy/nginx.conf /etc/nginx/sites-available/printshopcrm
sudo nano /etc/nginx/sites-available/printshopcrm     # set your domain and port
sudo ln -s /etc/nginx/sites-available/printshopcrm /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Both files are needed. `upgrade-map.conf` defines `$connection_upgrade`, which the vhost
references; without it nginx refuses to start with `unknown "connection_upgrade" variable`.

Then issue a certificate — certbot rewrites the vhost for TLS and sets up auto-renewal:

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d shop.example.com
```

Point your domain's A record at the server before running certbot, or validation fails.

The supplied config already proxies WebSocket upgrades, which the app uses for live board updates.
Without those two `proxy_set_header` lines the board silently stops updating in real time.

### 8. Firewall

```bash
sudo ufw allow 22,80,443/tcp
sudo ufw enable
```

The app port (3870) must **not** be open — nginx reaches it over loopback.

### 9. First login

Visit `https://shop.example.com`. With `PSC_AUTH=1` you'll get a signup screen; the first account
you create is the shop owner. Then go to **Settings** and set your shop name, address, tax rate,
hourly rate, and utilization — the costing engine needs those to tell you the truth about margin.

---

## Backups

**Do this on day one, not the day after you need it.**

[`deploy/backup.sh`](deploy/backup.sh) handles all of it — every database (control plus one per
shop in multi-tenant mode), customer artwork, verification, and retention:

```bash
sudo apt-get install -y sqlite3
sudo cp deploy/backup.sh /usr/local/bin/printshopcrm-backup
sudo chmod +x /usr/local/bin/printshopcrm-backup

# run it once by hand to confirm it works
sudo DATA_ROOT=/var/lib/printshopcrm BACKUP_ROOT=/var/backups/printshopcrm printshopcrm-backup
```

Then nightly, via `/etc/cron.d/printshopcrm-backup`:

```cron
0 3 * * * root DATA_ROOT=/var/lib/printshopcrm BACKUP_ROOT=/var/backups/printshopcrm KEEP_DAYS=30 /usr/local/bin/printshopcrm-backup >> /var/log/printshopcrm-backup.log 2>&1 || echo "PrintShopCRM backup FAILED $(date) — see /var/log/printshopcrm-backup.log"
```

The `|| echo` is load-bearing. **cron mails you on OUTPUT, not on exit status** — with the
redirect alone, a night that failed is a line in a log file nobody reads. The `echo` fires only on
a non-zero exit, so a failure becomes mail and a good night stays silent.

Three things that script does which a naive `cp` does not, and which all matter:

- **Uses SQLite's `.backup`, never a file copy.** Copying a live database can capture a write in
  progress and produce an archive that restores to a corrupt file — and you discover that on the
  one day it matters.
- **Backs up every tenant database and the control database.** A tenant database without its
  control row is an orphan you cannot log into.
- **Includes `uploads/`, and verifies each snapshot opens** with `PRAGMA quick_check` before
  declaring success. Skip the artwork and restored proofs come back as broken images.

### Get a copy off the machine — Google Drive is built in

A backup on the disk that just failed is not a backup. Backing up to **your own** Google Drive is
one-time setup:

1. At [Google Cloud credentials](https://console.cloud.google.com/apis/credentials), create an
   OAuth client of type **Web application**, and enable the **Google Drive API** for that project.
2. Add `http://127.0.0.1:4765` to that client's **Authorized redirect URIs**. Google retired the
   old copy-a-code flow in 2022, so authorization has to come back to a loopback address.
3. Put the client id and secret in your `.env` as `PSC_BACKUP_GDRIVE_CLIENT_ID` /
   `PSC_BACKUP_GDRIVE_CLIENT_SECRET`.
4. Run the consent flow:

   ```bash
   sudo -u printshopcrm npm run drive -- connect
   ```

   It prints a URL and waits for the redirect. **On a headless server**, either forward the port
   from your laptop first:

   ```bash
   ssh -L 4765:127.0.0.1:4765 user@your-server
   ```

   or skip the port entirely and paste the redirected URL back instead:

   ```bash
   sudo -u printshopcrm npm run drive -- connect --manual
   ```

   (The browser will show a "can't reach this page" error at `127.0.0.1` — that's expected. Copy
   the whole address out of the URL bar; the code is in it.)

5. Put the refresh token it prints in `.env` as `PSC_BACKUP_GDRIVE_REFRESH_TOKEN`.

Port 4765 is the default; set `PSC_BACKUP_GDRIVE_PORT` if it clashes, and use the matching URI in
Google Cloud.

From then on `backup.sh` uploads every nightly archive automatically and keeps the most recent 30
in Drive. Check it any time with `sudo -u printshopcrm npm run drive -- status`.

`backup.sh` reads the `PSC_BACKUP_GDRIVE_*` lines straight out of `/opt/printshopcrm/.env`, because
cron does not load that file the way `npm run` does. If your app lives somewhere else, add
`APP_DIR=/path/to/printshopcrm` to the cron entry. If the token is in `.env` but the script cannot
read it, the run says so and exits non-zero rather than reporting a backup that never left the box.

**This is your Drive and your Google account.** The credentials live in your own environment; there
is no shared account and no default destination. Two things worth knowing:

- The scope is `drive.file`, the narrowest Google offers — this can only ever see files it created
  itself. It cannot read your existing documents, and revoking access at
  [myaccount.google.com/permissions](https://myaccount.google.com/permissions) leaves your Drive
  exactly as it was apart from the backup folder.
- Retention only ever deletes from that one folder, oldest first, and never the newest archive.

Prefer something else? The script's footer has one-liners for `rclone`, `aws s3 cp`, and `scp` —
add whichever you already use to the same cron entry.

**Restore one, once, somewhere else.** An untested backup is a hope:

```bash
tar xzf 20260823-030000.tar.gz
PSC_DB=$PWD/20260823-030000/printshop.db npm start
```

If that starts and your customers are in it, you have backups. If you have never done it, you
don't.

### Putting a backup back

```bash
tar xzf 20260823-030000.tar.gz          # if you are restoring from a nightly archive
sudo systemctl stop printshopcrm
sudo -u printshopcrm npm run restore -- 20260823-030000 --data-root /var/lib/printshopcrm        # shows the plan
sudo -u printshopcrm npm run restore -- 20260823-030000 --data-root /var/lib/printshopcrm --yes  # does it
sudo systemctl start printshopcrm
```

`sudo -u printshopcrm`, not bare and not plain `sudo`. Your `.env` is `chmod 600` and owned by the
service account (that is what the install step above told you to do), and Node reports a file it
cannot *read* exactly as it reports one that is not there — `.env not found. Continuing without
it.`, exit 0 — so as any other user this reads the wrong `PSC_DB` and restores into the wrong
place. Running as root has the same problem in reverse: it leaves root-owned databases the service
cannot write.

The first run changes nothing. It prints what it would replace and what with — "500 customers"
over "1000 customers" — so you can see you have the right archive before anything is overwritten.

**Do not use `cp`.** Every PrintShopCRM database runs in WAL mode, so a crash — the thing you are
usually recovering from — leaves a `printshop.db-wal` on disk holding committed pages. SQLite
validates that log by its own internal checksums, not against the database it sits beside, so
copying a backup over the `.db` and leaving the log there means the next start replays the
crash-time log straight over what you just restored. It exits 0, `PRAGMA quick_check` says `ok`,
and you are back to the state you were trying to undo. `bin/restore.mjs` moves the `-wal` and
`-shm` aside instead of leaving or deleting them, so the last few minutes of work are still
recoverable if you need them.

It restores the **artwork** as well as the databases. `deploy/backup.sh` writes an
`uploads.tar.gz` beside them, and that is the half of your data you cannot re-derive — every
approved proof, every mockup, your shop logo. A restore that put the databases back and left the
files behind came up looking perfectly healthy with every image on every screen broken. If the
backup you point it at has no artwork in it, it says so in as many words rather than reporting
success. `--skip-art` leaves the files on disk alone, if that is what you actually want.

It also verifies the backup *before* touching the live database, refuses to run while anything
still has a database open, keeps a copy of everything it replaced in
`/var/lib/printshopcrm/backups/pre-restore-<timestamp>/` so the restore is itself undoable, and
puts the original owner and permissions back — otherwise a `sudo` restore leaves root-owned files
and the service comes up with "attempt to write a readonly database".

---

## Upgrading

```bash
cd /opt/printshopcrm
sqlite3 /var/lib/printshopcrm/printshop.db ".backup '/var/backups/pre-upgrade.db'"
git pull
npm ci --omit=dev
sudo systemctl restart printshopcrm
journalctl -u printshopcrm -n 30
```

Schema migrations run automatically at startup and are additive — they add columns and tables, they
don't drop them. Take the backup anyway.

To verify before restarting, run the tests against the new code:

```bash
node bin/gate.mjs
```

### Confirming the server runs what the repo says

```bash
bash deploy/verify-sync.sh user@your-server /opt/printshopcrm/current
```

Compares a checksum of every runtime file against your working tree and reports anything that
drifted — a hand-edit made on the server during an incident and then forgotten, or a deploy that
half-finished. Exit 0 means the running service is byte-for-byte the published source, which is
also how an AGPL deployment demonstrates it is serving what it claims to.

---

## Troubleshooting

**Locked out — forgot the password, and the reset email never arrives**

Expected on a fresh install: password reset goes out by email, and a new install has no mail
configured yet. Recover it from the server, where you have filesystem access anyway:

```bash
cd /opt/printshopcrm/current
sudo -u printshopcrm npm run admin -- list-shops                       # the shops and their owners
sudo -u printshopcrm npm run admin -- reset-password owner@yourshop.com
```

That prints a new password immediately — no email involved. `npm run admin` on its own lists every
command (there's also `list-users` and `promote`, for when the only owner has left the business).

Set `PSC_DB` if your database isn't at the default path:

```bash
sudo -u printshopcrm PSC_DB=/var/lib/printshopcrm/printshop.db npm run admin -- list-shops
```

If `list-shops` says **"No shops in …"** on a server you know has shops, it is telling you which
database it read — that is the wrong path, or `.env` was not readable. See the next entry.

**`.env not found. Continuing without it.`**
Usually not an error: Node says this when there is no `.env` file, which is normal for a local
trial, and the app runs on its defaults.

**It is an error when you are not the user that owns the file.** `.env` is `chmod 600`, and Node
prints this same line for a file it cannot READ — then carries on with defaults, exit 0. So
`npm run admin`, `npm run restore` and `npm run drive` all quietly operate on the built-in default
paths instead of yours. Check with:

```bash
sudo -u printshopcrm head -1 /opt/printshopcrm/.env    # prints a line: readable, all is well
```

If that works and a bare `head -1` does not, prefix every `npm run` on this box with
`sudo -u printshopcrm`.

**`SyntaxError` or "node:sqlite not found" on start**
Node is older than 22.13.0 — `node:sqlite` is flagged off before that, so 22.4 and 22.12 fail here
too, not just Node 20. Check `node --version`. If you installed 22.13 but systemd runs an old one,
put the absolute path in the unit's `ExecStart` (`which node`).

**"SQLite is an experimental feature" warning**
Expected and harmless. `--no-warnings` in the start script suppresses it.

**502 Bad Gateway**
The app isn't running or nginx has the wrong port. `systemctl status printshopcrm`, then confirm
`proxy_pass` matches `PORT`.

**Board doesn't update live**
The WebSocket upgrade isn't getting through. Check for the `Upgrade` / `Connection` headers in your
nginx location block.

**Customer approval links 404 or "invalid link"**
`PSC_SECRET` changed. Links are HMACs of it, so rotating invalidates every previously-sent link.
Set it once and keep it.

**Emails aren't arriving**
Nothing is lost — undeliverable mail is recorded in **Outbox**, tagged `logged`. Check mail settings
per shop in Settings. Google and Microsoft both reject a normal account password over SMTP; you need
an app password.

**Permission denied writing the database**
The service `User=` must own `PSC_DB`'s directory and `public/uploads/`.

---

## Uninstalling

```bash
sudo systemctl disable --now printshopcrm
sudo rm /etc/systemd/system/printshopcrm.service
sudo rm /etc/nginx/sites-enabled/printshopcrm
sudo systemctl reload nginx
# your data — copy it somewhere first if you want it
sudo rm -rf /opt/printshopcrm /var/lib/printshopcrm
```
