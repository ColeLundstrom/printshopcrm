# Managed hosting & setup

The repository is the whole product. Self-hosting is fully supported, always will be, and nothing is
held back for a paid tier — there is no "open core," no feature flags, and no license key. **Running
PrintShopCRM for your own print shop is free forever, commercial use included.**

The one thing the [license](LICENSE) reserves is selling it *to other people* as a hosted service.
That's the business, and it's stated plainly rather than enforced through crippled features.

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

Two different things, with two different answers:

**Setting it up on a client's own server, for a fee — allowed, no license needed.** Install it,
migrate their data, configure their pricing, bill them for the work, walk away. The client is
self-hosting; you were the labour. That's explicitly granted.

**Running it for clients on infrastructure you control — needs a commercial license.** That's a
hosted service, which is the one use the [license](LICENSE) reserves. If that's the business you
want to be in, that's a conversation, not a wall: get in touch through
[Discussions](https://github.com/ColeLundstrom/printshopcrm/discussions) and we'll work out terms.
Reseller and white-label arrangements are available.

Either way, the branding hooks are built in:

```ini
PSC_HOST_BADGE_TEXT=Set up by Your Company
PSC_HOST_BADGE_URL=https://yourcompany.com
```

puts your credit in the sidebar, and `PSC_BRAND_NAME` / `PSC_BRAND_TAG` / `PSC_BRAND_ACCENT` rename
and re-skin the whole app. Unset, nothing renders and no third-party branding appears anywhere —
which is what a shop self-hosting for itself wants.

---

## Why it's licensed this way

Worth saying out loud, because "source available" gets a fair amount of side-eye.

The entire pitch of this project is that shop software shouldn't hold you hostage — no feature
tiers, no export fees, no forced payment processor, no per-seat pricing that climbs every year.
Keeping that promise means the project has to be funded by something. It's funded by hosting.

So the license draws the line exactly where the money is and nowhere else. Your shop gets
everything, free, with the source. What it doesn't allow is someone taking the same code, standing
up a competing service, and out-marketing the person maintaining it — which would end with the
project unmaintained and every shop on it stranded. That's the whole reasoning.

And it expires: each version turns into Apache 2.0 four years after release, automatically, whether
or not anyone is still around to agree to it.
