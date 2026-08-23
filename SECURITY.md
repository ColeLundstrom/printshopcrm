# Security Policy

## Reporting a vulnerability

**Please don't open a public issue for a security problem.**

Report it privately through GitHub's
[Report a vulnerability](https://github.com/ColeLundstrom/printshopcrm/security/advisories/new)
form, which opens a private advisory visible only to the maintainers.

Please include: what the issue is, how to reproduce it, and what an attacker gets. A proof of
concept helps a great deal.

You'll get an acknowledgement within a few days. Fixes for anything that exposes customer data or
crosses a shop boundary are prioritised over everything else.

## Supported versions

The latest release on `main`. This is a small project — there are no long-term support branches, and
the fix for a reported issue lands on `main`.

## Deploying it safely

The most common problems in a self-hosted install aren't code bugs. In rough order of how often they
bite:

- **Set `PSC_SECRET`.** Customer share links — estimate approvals, art proofs — are HMACs derived
  from it. Anyone who knows it can forge a link to any customer's documents. Generate it randomly
  (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`), keep it out of
  version control, and don't reuse one across installs.
- **Set `PSC_AUTH=1` on anything reachable from the internet.** Without it there is no login and
  whoever reaches the port has full access. Single-shop mode is for a private network or an install
  already sitting behind another authentication layer.
- **Serve over HTTPS.** Session cookies get the `Secure` flag based on the request protocol, so
  plain HTTP means session cookies without it.
- **Set `PSC_PUBLIC_URL`.** The fallback trusts the incoming `Host` header, which a proxy can spoof
  into the links the app emails to customers.
- **Don't expose the app port.** nginx should reach it over loopback; only 80 and 443 belong in the
  firewall.
- **Don't run it as root.** The supplied systemd unit runs as a dedicated user with
  `ProtectSystem=strict` and a narrow `ReadWritePaths`.
- **Back the database up somewhere else.** A backup on the same disk isn't one.

## What the app already does

For context when you're assessing a finding:

- **Shop isolation is a hard boundary.** In multi-tenant mode each shop gets its own SQLite
  database. The request gate resolves a session to its shop and runs the entire request inside that
  shop's database through `AsyncLocalStorage`, so no query carries a `shop_id` that could be
  tampered with or forgotten.
- **Passwords** are scrypt-hashed with a per-member random salt, hashed off the event loop.
- **Customer links** are HMAC tokens compared in constant time and marked `noindex`. Work tickets,
  which carry costs and internal notes, are never customer-reachable.
- **Secrets never reach the browser.** API keys, tokens, and passwords held in shop settings are
  redacted out of the settings payload and replaced with a `<key>_set` boolean.
- **Outbound webhooks are SSRF-guarded.** URLs must be http(s) with no embedded credentials; the
  hostname is resolved and rejected if it lands in a private, loopback, link-local, carrier-NAT, or
  cloud-metadata range — which also blocks DNS rebinding — and redirects are never followed.
- **Webhook deliveries are signed** with HMAC-SHA256 over `{timestamp}.{body}` and carry a
  timestamp so receivers can reject replays.
- **The public API is key-scoped and rate-limited** to 120 requests/minute per shop. A shop's key
  cannot read another shop's data.
- **SQL is parameterised throughout.**
- **The service worker caches the app shell only** — never authenticated `/api/*` responses — and
  wipes its cache on logout, so a shared floor tablet can't serve one shop's data to the next login.

## Known limitations

Documented rather than hidden. None is a secret, and a patch for any of them is welcome:

- Webhook retry state is held in process, so pending retries are lost if the server restarts.
- `webhook_deliveries` has no retention policy and grows without bound.
- The SSRF guard has a small TOCTOU window between DNS validation and the actual `fetch`.
- `invoices.status` is recomputed on write, so an invoice becomes `overdue` on its next write rather
  than at the instant the due date passes.
