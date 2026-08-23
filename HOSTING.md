# Managed hosting & setup

PrintShopCRM is open source under the [AGPL](LICENSE) and the repository is the whole product.
Self-hosting is fully supported, always will be, and nothing is held back for a paid tier — no
"open core," no feature flags, no license key. **Running it for your own print shop is free forever,
commercial use included.**

Same arrangement WordPress has: the software is free, the services around it are the business.

This page is for shops that would rather not run a server.

---

## Self-host (free, forever)

```bash
git clone https://github.com/ColeLundstrom/printshopcrm.git
cd printshopcrm && npm install && npm start
```

You run it, you own it, you keep the database. [INSTALL.md](INSTALL.md) covers a full production
deployment — nginx, SSL, systemd, backups, upgrades.

**Good fit if** someone on your team is comfortable with a Linux server, or you already run one.
Realistically that's about an hour to set up and a few minutes a month: apply updates, check that
backups are restoring.

---

## Managed hosting by MerchTroop

We run it for you on our infrastructure.

- **Setup and configuration** — your shop's rates, tax, size upcharges, price matrix, and templates
  configured against how you actually quote, not left at the defaults.
- **Data migration** from your current tool — customers, order history, open quotes and invoices.
  Order history matters more than it sounds: it's what makes reorder detection and "same as last
  time" work from day one instead of a year from now.
- **Your own domain** with SSL, e.g. `shop.yourprintshop.com`.
- **Backups**, taken daily and kept off the machine, with restores tested.
- **Updates applied** — security fixes and new versions, without you scheduling a maintenance window.
- **Monitoring** — someone notices the box is down before your shop does on a Monday morning.
- **Support** from people who have actually run a print shop.

**Pricing is not published yet** — it's set per shop based on size and what migration is involved.
Ask and you'll get a real number, not a funnel.

### Setup only

If you want to self-host but not do the initial lift, we'll do the install, migration, and
configuration on **your** server and hand it over. One-time fee, no ongoing relationship, and
nothing about the result depends on us afterwards — it's the same software either way, and running
it for your own shop needs no license from anyone.

---

## What you're not signing up for

The reason this project exists is that shops get trapped by their tools. So, in writing:

- **Your data is yours and it leaves easily.** Every table exports to CSV, including line items with
  size breakdowns, plus the whole database as one JSON file. No export fee, no support ticket. On a
  managed plan you can ask for a copy of your raw SQLite database at any time and get it.
- **No feature gating.** Hosted and self-hosted run identical code. Paying us buys operations, not
  capabilities.
- **No forced payment processor.** You connect your own Stripe key and customer money goes straight
  to your account. We are never the merchant of record and take no cut of your sales.
- **Leaving is a file copy.** Take the database, point it at your own server, done. We'll help you
  move off.

---

## Get in touch

- **[printshopcrm.com](https://printshopcrm.com)** — hosted plans and setup
- **[GitHub Discussions](https://github.com/ColeLundstrom/printshopcrm/discussions)** — questions
  about self-hosting, answered in public so the next shop finds the answer

---

## Agencies, consultants, and resellers

Set it up for clients, host it for clients, build a business on it — the AGPL permits all of it.
Two obligations come with running it as a service, and both are easy:

1. **Publish your modifications.** If you patch it and run that patched version for other people,
   your changes have to be available to those users. Unmodified deployments have nothing to publish.
2. **Point the source link at your fork.** Set `PSC_SOURCE_URL` to your repository. The app shows a
   source link to every user; that's how AGPL §13 is satisfied, and leaving it aimed at upstream
   while running patched code isn't compliance.

**If the copyleft doesn't work for your business** — you've built proprietary integrations you can't
publish, or your customers' contracts forbid it — **commercial licenses that release you from AGPL
terms are available.** That's a conversation, not a wall:
[Discussions](https://github.com/ColeLundstrom/printshopcrm/discussions). White-label and reseller
arrangements exist too.

The branding hooks are built in either way:

```ini
PSC_HOST_BADGE_TEXT=Hosted by Your Company
PSC_HOST_BADGE_URL=https://yourcompany.com
PSC_SOURCE_URL=https://github.com/yourcompany/printshopcrm
```

The badge puts your credit in the sidebar, and `PSC_BRAND_NAME` / `PSC_BRAND_TAG` /
`PSC_BRAND_ACCENT` rename and re-skin the whole app. Unset, no third-party branding appears
anywhere — which is what a shop self-hosting for itself wants.

---

## Why it's licensed this way

The entire pitch of this project is that shop software shouldn't hold you hostage — no feature
tiers, no export fees, no forced payment processor, no per-seat pricing that climbs every year.
Keeping that promise means the software itself has to be genuinely free, or it's just a nicer cage.

So it's AGPL. Your shop gets everything, permanently, and no future owner can take it back — AGPL
grants are irrevocable, so every version ever published stays free no matter what happens to
whoever maintains it.

The copyleft exists so improvements come back. If someone builds better embroidery costing on top
of this and runs it for shops, those shops' improvements return to every other shop instead of
vanishing into a proprietary fork. That's the trade, and it's the same one that made WordPress the
default rather than a footnote.

The business is hosting, setup, migration, support, and commercial licenses for companies that need
out of the copyleft. None of it depends on withholding software from you.
