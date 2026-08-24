# PrintShopCRM

**Open-source shop management for screen printers, embroiderers, and DTF shops — with the CRM built in.**

Quoting, estimates, invoicing, a production board, art proofing, purchasing, and per-job
profitability in one app. Node.js + SQLite. No build step, four runtime dependencies, one database
file you can copy.

[![CI](https://github.com/ColeLundstrom/printshopcrm/actions/workflows/ci.yml/badge.svg)](https://github.com/ColeLundstrom/printshopcrm/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)
[![Docker image](https://img.shields.io/badge/ghcr.io-printshopcrm-2496ed?logo=docker&logoColor=white)](https://github.com/ColeLundstrom/printshopcrm/pkgs/container/printshopcrm)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)

```bash
git clone https://github.com/ColeLundstrom/printshopcrm.git
cd printshopcrm
npm install
npm run seed      # optional: a demo shop mid-week, so the app isn't empty
npm start         # → http://localhost:3333
```

That's the whole install — measured at about 3 seconds on a cold npm cache. No Postgres, no Redis,
no build pipeline, nothing to compile.

Prefer containers?

```bash
docker run -p 3333:3333 -e PSC_SECRET=$(openssl rand -hex 32) \
  -v printshopcrm-data:/data ghcr.io/colelundstrom/printshopcrm:latest
```

Runs on **Linux, macOS, and Windows** (Node 22+), and on x86 or ARM in Docker. Deploying to a
server? See **[deploy/DEPLOY.md](deploy/DEPLOY.md)** for Docker Compose, Fly.io, Render, or a plain
VPS.

---

## Screenshots

|  |  |
|---|---|
| ![Dashboard](docs/img/dashboard.png) **Today** — what's at risk, ranked by money | ![Job board](docs/img/job-board.png) **Job board** — drag-to-move production kanban |
| ![Profitability](docs/img/profitability.png) **Profitability** — every job, costed | ![Capacity](docs/img/capacity.png) **Capacity** — can you actually hit that date? |

---

## Why this exists

Most shop-management tools tell you what you *invoiced*. They don't tell you what you *kept*.

Shops routinely discover they underpriced a job months later, by watching gross revenue. The reason
is structural: a press only actually prints roughly a quarter to a third of the clock — the rest is
setup, approvals, breaks, packing — so costing labor at a raw hourly rate understates it by around
3×. A job can look like 40% margin on paper and lose money in the building.

PrintShopCRM costs every job against your real utilization and tells you **while the price is still
editable**. That's the whole idea. Everything else is the shop-management software you need around
it so that number is based on real data instead of a spreadsheet.

Three more things it does that are unusual:

- **Turnaround starts at art approval, so the schedule does too.** Your terms say "10 business days
  from proof approval." Most tools store a due date typed at intake that never moves — a proof
  sitting in an inbox for four days silently eats four days of production. Here, approval-gated jobs
  recompute their own due date and the dashboard surfaces deadlines that have already slipped.
- **Per-size pricing is a first-class object.** The size grid carries real per-size upcharges and
  flows estimate → job → work ticket → PDF → export. Quantity is *derived* from the grid, so the two
  can never disagree.
- **Your data is not the moat.** Every table exports to CSV — including line items with size
  breakdowns — plus everything as one JSON file. No ticket, no fee. The database is a single file.

---

## Features

**Sales**
- Customers with tags, notes, lifetime value, and a timeline fed by every other module
- Estimates with a size/color matrix, per-size upcharges, live totals, PDF, and a no-login customer approval link
- Sales pipeline with weighted value and win rate, auto-synced from estimate events
- Two-way conversation inbox (email + SMS, both directions)
- Follow-ups: quotes that went quiet and invoices nobody chased, ranked by value
- Reorder Radar: customers due for their next run, based on their own history

**Production**
- Drag-to-move job board (pointer-based, works on touch) with rush/late/unpaid/assignee filters
- Art & prepress: versioned proofs, customer approve/reject with notes, approval advances the job *and* moves the due date
- Printable work tickets with a hard "NO APPROVED ART — do not print" block when the proof isn't signed off
- Capacity planner: schedules a prospective job against the committed board and returns a real ship date
- Floor Mode: Code 128 barcode scanning that feeds measured labor back into costing
- DTF resize and a gang-sheet builder (embeddable on your own site, checking out through *your* Stripe key)

**Money**
- Quoting calculator: garment × markup + imprint charge scaled by run length and colors-per-location + one-time screens; tiered rush; dark garments automatically add an underbase
- Custom price matrices — upload your own grid and it wins over the calculator
- Invoices with partial payments, running balance, and status always derived from the payments table
- Per-job and shop-wide profitability with cost breakdown and $/productive-hour
- Books & A/R: aging buckets and customer statements
- QuickBooks Online sync plus IIF export

**Purchasing**
- Garment catalog with real costs feeding the ROI engine
- S&S Activewear and SanMar lookups when you connect an account, catalog fallback when you don't
- Purchase orders consolidated per style/size to avoid split shipments

**Automation & integration**
- Event and time-based rules with multi-step drip sequences (email → wait → text)
- Autopilot: paste a customer email and it becomes a structured draft order — review-first by default
- AI receptionist for inbound quote requests (bring your own Anthropic or OpenAI key; a deterministic parser runs with no key at all)
- Public REST API (`/api/v1`) with Bearer keys, plus signed outbound webhooks — see [docs/API.md](docs/API.md)
- CSV import for customers and full order history, so reorder features work on day one

**The app itself**
- Light and dark themes, tuned separately rather than inverted
- ⌘K command palette, full keyboard navigation, undo-instead-of-confirm on reversible actions
- A sidebar that starts with the daily loop — quote → produce → invoice → get paid — and folds the
  power tools behind one click, so the first screen isn't 27 destinations deep
- Multi-tenant mode: one isolated SQLite database per shop, real staff logins with owner/manager/staff roles
- PWA — installable, works on a shop-floor tablet

---

## Self-hosting

Full instructions — Node install, nginx reverse proxy, SSL, systemd unit, backups, upgrades — are in
**[INSTALL.md](INSTALL.md)**.

The short version for a Linux box:

```bash
git clone https://github.com/ColeLundstrom/printshopcrm.git /opt/printshopcrm
cd /opt/printshopcrm
npm ci --omit=dev
cp .env.example .env        # then edit it — PSC_SECRET is required
node --no-warnings server.mjs
```

Put nginx in front of it, point a domain at the box, run certbot, and install the systemd unit from
[`deploy/printshopcrm.service`](deploy/printshopcrm.service). INSTALL.md has all of it verbatim.

### Single shop vs. multi-tenant

| | |
|---|---|
| **Single shop** (default) | One database, no login. Fine behind your own network or a reverse-proxy auth layer. |
| **Multi-tenant** (`PSC_AUTH=1`) | Signup, staff logins with roles, and a separate isolated SQLite database per shop. Use this for anything reachable from the internet. |

Set `PSC_SECRET` in production either way — customer share links derive from it.

### Configuration

Everything is environment variables plus per-shop settings stored in the database. Nothing is
hardcoded. See **[.env.example](.env.example)** for every variable with comments, and Settings
inside the app for per-shop values (tax rate, hourly rate, mail, supplier accounts, Stripe keys).

Secrets stored in settings are redacted out of any response sent to the browser.

---

## Hosted option

Self-hosting is fully supported and always will be — this repo is the whole product, not a teaser,
and running it for your own shop is free forever.

If you'd rather not run a server, **managed hosting and setup are available from MerchTroop**:
backups, updates, SSL, monitoring, and data migration off your current tool. See
**[HOSTING.md](HOSTING.md)**.

That's the deal, plainly: the software is free and always will be, and paying us buys operations —
not features. Hosted and self-hosted run identical code.

---

## Running it day to day

```bash
npm run admin                                     # what the admin tool can do
npm run admin -- list-shops                       # shops and their owners
npm run admin -- reset-password owner@shop.com    # set a password with no email involved
```

That last one is the way out of a lockout. Password reset normally goes by email, and a fresh
install has none configured — so anyone with server access can recover an account directly. It
grants no privilege they didn't already have, since the databases are right there on disk.

## Tests

```bash
npm test           # 61 unit tests, no network, runs in seconds
npm run test:e2e   # 17 end-to-end checks against a throwaway database
npm run test:all   # both
```

Pure Node, no test framework and no shell dependencies — they run identically on Linux, macOS, and
Windows. CI runs both on Node 22 and current LTS, on Ubuntu and Windows, plus a Docker build that
boots the container and checks the data volume survives a container replacement.

Both must pass before a release. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## How it fits together

```
server.mjs                    routes, static serving, customer-facing pages
lib/db.mjs                    schema, migrations, settings, scheduling
lib/tenants.mjs               multi-tenant control plane (registry, members, sessions)
lib/pdf.mjs                   PDF writer — no dependency, writes the bytes directly
lib/roi.mjs                   job costing and margin
lib/capacity.mjs              press-time scheduling
public/js/shared/pricing.js   pricing + costing, imported by BOTH server and browser
public/js/views/              one file per screen
bin/gate.mjs                  the test suite
```

Two design rules worth knowing before you change anything:

- **`public/js/shared/pricing.js` is imported by both sides** — the browser as a module URL, the
  server as a file path. The total shown in the editor is computed by the same code that writes the
  invoice, so money cannot drift between them.
- **Invoice status is always derived** from the payments table via `syncInvoiceStatus()`, never set
  by hand. Delete a payment and the invoice correctly reopens.

Customer links (`/p/estimate/:id`, `/p/art/:id`) are unguessable HMAC tokens compared in constant
time and marked `noindex`; no account required. Work tickets (`/p/ticket/:id`) are internal-only —
they carry costs and staff notes and are never sent out.

Multi-tenant isolation uses `AsyncLocalStorage`: the request gate resolves a session to its shop and
runs the entire request inside that shop's database, so no query in the app needs a `shop_id` and
one shop cannot reach another's data.

---

## Requirements

- **Node.js 22 or newer** — uses the built-in `node:sqlite` module, so there is no native SQLite
  build step and nothing to compile.
- That's it. Four runtime dependencies: `express`, `multer`, `nodemailer`, `ws`.

Runs on Linux, macOS, and Windows — all three are exercised by CI on every push. Or skip Node
entirely and use the container image, published for `linux/amd64` and `linux/arm64`:

```bash
docker pull ghcr.io/colelundstrom/printshopcrm:latest
```

For reference, the production install this is developed against serves 14 shops in about **40 MB of
RAM** on a small VPS.

---

## Contributing

**This project wants a community, and shop owners count as contributors.**

The hardest thing to get right here isn't the code — it's modelling how shops actually quote,
schedule, and cost work. That knowledge lives in print shops, not in repositories. If something in
here doesn't match how your shop works, [open an issue and say
so](https://github.com/ColeLundstrom/printshopcrm/issues/new/choose). There's a template for exactly
that, and it needs no code.

Also wanted: more supplier integrations, more decoration methods (sublimation, vinyl, patches and
laser are thin), translations, and anything labelled
[`good first issue`](https://github.com/ColeLundstrom/printshopcrm/labels/good%20first%20issue).

Read [CONTRIBUTING.md](CONTRIBUTING.md) before a code PR — it covers the setup, the house rules, and
the one hard rule: **a bug fix needs a failing test first.** Planning something large? Open a
[discussion](https://github.com/ColeLundstrom/printshopcrm/discussions) first so it doesn't sit.

By contributing you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

Security issues: please report privately, see [SECURITY.md](SECURITY.md).

## License

**GNU AGPL v3** — see [LICENSE](LICENSE). Real, OSI-approved open source, the same deal WordPress
made: the software is free, and the services around it are the business.

- ✅ **Run it for your print shop, free, forever** — commercially, modified however you like. Your
  shop's data and your private changes are yours; nothing obliges you to publish anything.
- ✅ **Fork it, sell services around it, build on it.**
- ⚖️ **If you run a modified version as a service for other people, publish your changes.** That's
  the copyleft bargain — improvements to a shared tool come back to the shops using it, instead of
  disappearing into someone's proprietary fork.
- 💼 **Don't want that obligation?** Commercial licenses that release you from AGPL terms are
  available — [get in touch](https://github.com/ColeLundstrom/printshopcrm/discussions).

If you deploy this for others, set `PSC_SOURCE_URL` to your own repository. The app shows a source
link to every user, which is how AGPL §13 is satisfied — pointing it at upstream while running
patched code is not compliance.
