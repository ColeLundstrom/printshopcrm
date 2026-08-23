# Deploying PrintShopCRM

Pick whichever matches how you like to run things. All of them run identical code.

| | Effort | Cost | Good for |
|---|---|---|---|
| [Docker](#docker) | 2 minutes | your own hardware | Anyone with Docker; a shop PC or NAS |
| [Fly.io](#flyio) | 10 minutes | ~$5/mo | Cheapest real cloud, global |
| [Render](#render) | 10 minutes | ~$7/mo | Least command line |
| [Your own VPS](../INSTALL.md) | 30 minutes | ~$5/mo | Full control, no platform lock-in |
| [Managed by MerchTroop](../HOSTING.md) | none | ask | Not wanting any of this |

---

## The one thing every option has in common

**The database is a file, and it has to live on persistent storage.**

Every cloud platform below has an ephemeral filesystem by default. If you skip the volume or disk
step, everything appears to work — and then a deploy or a restart silently returns you to an empty
shop with your customers, quotes, and invoice history gone. There's no warning, because from the
app's point of view it's a first run.

Each section below makes the persistent bit explicit. Don't skip it.

Also back it up somewhere off the machine. A volume is not a backup.

---

## Docker

```bash
git clone https://github.com/ColeLundstrom/printshopcrm.git
cd printshopcrm
cp .env.example .env
```

Generate a secret and put it in `.env` as `PSC_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then:

```bash
docker compose up -d
```

Open <http://localhost:3333>.

Prefer not to build? Pull the published image instead:

```bash
docker run -d --name printshopcrm \
  -p 3333:3333 \
  -e PSC_SECRET=your-generated-secret \
  -e PSC_AUTH=1 \
  -v printshopcrm-data:/data \
  -v printshopcrm-uploads:/app/public/uploads \
  ghcr.io/colelundstrom/printshopcrm:latest
```

Images are published for x86 and ARM, so this runs on a cheap ARM VPS or a Raspberry Pi too.

**Housekeeping**

```bash
docker compose logs -f                    # logs
git pull && docker compose up -d --build  # update
docker compose down                       # stop (data is safe)
docker compose down -v                    # stop AND DELETE THE DATA — that's what -v means
```

**Backups.** Everything is in the two named volumes:

```bash
docker run --rm -v printshopcrm-data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/printshopcrm-$(date +%F).tar.gz /data
```

Put it somewhere other than the machine it came from.

---

## Fly.io

```bash
cp deploy/fly.toml fly.toml
fly launch --no-deploy --copy-config
fly volumes create printshopcrm_data --size 3
fly secrets set PSC_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
fly deploy
```

Then point the app at its real URL so customer links are correct:

```bash
fly secrets set PSC_PUBLIC_URL=https://your-app.fly.dev
```

The volume is what makes your data survive deploys — `fly.toml` mounts it at `/data`, which is
where `PSC_DB` points. Keep `min_machines_running = 1`: if Fly stops the last machine, the
scheduled automations that chase overdue invoices and slipping deadlines stop with it.

SSL and a `.fly.dev` domain come free. `fly certs add shop.yourbusiness.com` for your own.

---

## Render

1. `cp deploy/render.yaml render.yaml`, commit, and push to your GitHub fork.
2. Render dashboard → **New** → **Blueprint** → select the repo.
3. Deploy.

`PSC_SECRET` is generated for you. Afterwards set `PSC_PUBLIC_URL` to your service URL under
Settings → Environment.

**The free plan will not work** — it has no persistent disk, so your shop's database is destroyed on
every deploy. The blueprint specifies the Starter plan and a 5 GB disk for exactly that reason.

Because a persistent disk pins the service to a single instance, don't raise the instance count.
SQLite has one writer, and this app is built around one process.

---

## Which should you pick?

If you already run Docker anywhere — a NAS, a home server, an office box — use Docker. It's the
least moving parts and nothing is rented.

If you want it on the internet with the least fuss, Fly is cheapest and Render involves the least
terminal.

If you want full control, or you're already paying for a VPS, [INSTALL.md](../INSTALL.md) walks
through nginx, SSL, systemd and backups on a plain Linux box.

If none of that sounds like a good use of your week, [that's what the hosted option is
for](../HOSTING.md).
