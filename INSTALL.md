# Installing PrintShopCRM

Two paths:

- **[Try it locally](#try-it-locally)** — two minutes, any laptop.
- **[Production install](#production-install)** — a Linux server on your own domain with SSL.

Don't want to run a server at all? See [HOSTING.md](HOSTING.md).

---

## Requirements

| | |
|---|---|
| **Node.js** | **22.0 or newer.** Non-negotiable — the app uses the built-in `node:sqlite` module. |
| OS | Linux, macOS, or Windows. Production instructions below assume Ubuntu/Debian. |
| Database | None to install. SQLite is inside Node. |
| RAM | 512 MB is plenty. The live reference install idles around 80 MB. |
| Disk | ~150 MB for the app and dependencies, plus your uploads and database. |

Check your version:

```bash
node --version
```

If that prints anything below `v22`, install Node 22 first — see
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
node --version      # expect v22.x or newer
```

### 2. Get the code

```bash
sudo mkdir -p /opt/printshopcrm
sudo chown "$USER" /opt/printshopcrm
git clone https://github.com/ColeLundstrom/printshopcrm.git /opt/printshopcrm
cd /opt/printshopcrm
npm ci --omit=dev
```

### 3. Put the database outside the app directory

This matters. Keep your data somewhere an upgrade cannot overwrite:

```bash
sudo mkdir -p /var/lib/printshopcrm
sudo chown "$USER" /var/lib/printshopcrm
```

### 4. Configure

```bash
cp .env.example .env
node -e "console.log('PSC_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
```

Edit `.env`. The minimum for a production install:

```ini
PORT=3870
PSC_SECRET=<the value you just generated>
PSC_DB=/var/lib/printshopcrm/printshop.db
PSC_PUBLIC_URL=https://shop.example.com
PSC_AUTH=1
```

**`PSC_SECRET` is required.** Customer share links — estimate approvals, art proofs — are HMACs
derived from it. Anyone who knows it can forge a link to any customer's documents. Generate it
randomly, never commit it, and don't reuse one across installs.

**`PSC_AUTH=1` turns on logins.** Leave it off only if the app is on a private network or behind
another authentication layer, because without it anyone who can reach the port has full access.

**`PSC_PUBLIC_URL`** should be your real external URL. Without it the app falls back to the
incoming `Host` header to build customer links, and a proxy can spoof that.

`.env.example` documents every other variable.

### 5. Run it as a service

A ready unit file is in [`deploy/printshopcrm.service`](deploy/printshopcrm.service):

```bash
sudo cp deploy/printshopcrm.service /etc/systemd/system/
sudo nano /etc/systemd/system/printshopcrm.service     # set User= and the paths
sudo systemctl daemon-reload
sudo systemctl enable --now printshopcrm
systemctl status printshopcrm
```

Logs:

```bash
journalctl -u printshopcrm -f
```

### 6. nginx and SSL

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

### 7. Firewall

```bash
sudo ufw allow 22,80,443/tcp
sudo ufw enable
```

The app port (3870) must **not** be open — nginx reaches it over loopback.

### 8. First login

Visit `https://shop.example.com`. With `PSC_AUTH=1` you'll get a signup screen; the first account
you create is the shop owner. Then go to **Settings** and set your shop name, address, tax rate,
hourly rate, and utilization — the costing engine needs those to tell you the truth about margin.

---

## Backups

Everything is in one directory. Back up `/var/lib/printshopcrm/`.

Use SQLite's own backup command rather than copying the file, so you can't catch a write in
progress:

```bash
sqlite3 /var/lib/printshopcrm/printshop.db ".backup '/var/backups/printshop-$(date +%F).db'"
```

A nightly cron:

```cron
0 3 * * * sqlite3 /var/lib/printshopcrm/printshop.db ".backup '/var/backups/printshop-$(date +\%F).db'" && find /var/backups -name 'printshop-*.db' -mtime +30 -delete
```

In multi-tenant mode also back up `control.db` and the whole `tenants/` directory beside it — a
tenant database without its control row is an orphan.

Customer artwork lives in `public/uploads/`. Back that up too, or proofs come back as broken images.

Copy a backup off the machine. A backup on the same disk is not a backup.

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

---

## Troubleshooting

**`.env not found. Continuing without it.` on start**
Not an error. Node says this when there's no `.env` file, which is normal for a local trial — the
app runs on its defaults. It goes away once you create one (`cp .env.example .env`).

**`SyntaxError` or "node:sqlite not found" on start**
Node is older than 22. Check `node --version`. If you installed 22 but systemd runs an old one,
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
