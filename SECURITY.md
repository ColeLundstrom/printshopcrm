# Security Policy

## Reporting a vulnerability

**Please don't open a public issue for a security problem.**

Use GitHub's private
[Report a vulnerability](https://github.com/ColeLundstrom/printshopcrm/security/advisories/new)
form. Include the affected version, installation mode, reproduction steps, and impact. Use
synthetic data where possible; do not include real customer records, passwords, or API keys.

We aim to acknowledge reports within **three working days**. This is a target, not a guaranteed
response time. Customer-data exposure, account takeover, and access across shop boundaries receive
priority. Follow up in the same private channel if you have not heard back; keep reproduction
details private while maintainers investigate and coordinate a fix.

## Supported versions

Security fixes are developed on `main`; older versions have no separate long-term support branches.
Use the advisory and release notes to identify a version containing a fix, and back up before updating.

## Deploying it safely

- **Set a strong, unique `PSC_SECRET`.** It signs document and file links. Generate it randomly
  (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`), keep it out of
  version control, and preserve it securely between restarts. Changing it invalidates existing signed links.
- **Set `PSC_AUTH=1` on anything reachable from the internet.** Without it there is no login and
  role checks do not restrict access. Unauthenticated mode belongs only behind a separate trusted
  access boundary.
- **Serve over HTTPS behind a correctly configured proxy.** Cookies use `HttpOnly` and `SameSite=Lax`;
  `Secure` depends on the detected request protocol. Keep the application port private and have the
  proxy overwrite forwarded headers rather than trusting client-supplied values.
- **Set `PSC_PUBLIC_URL` to the public HTTPS address.** Some link generation otherwise falls back
  to a learned shop origin or the request's `Host` header.
- **Don't run it as root.** The supplied systemd unit runs as a dedicated user with
  `ProtectSystem=strict` and a narrow `ReadWritePaths`.
- **Protect and back up the complete installation data.** Include the control/default and tenant
  databases, uploaded artwork and logos, and separately protected configuration/secrets. Database-only
  `bin/snapshot.mjs` does not include uploads. See [installation and backups](INSTALL.md) and
  [the backup script](deploy/backup.sh); verify a restore and keep an off-server copy.

## What the app already does

- **Shop access:** authenticated requests select a shop's separate SQLite database and apply member
  roles. Public document links and uploaded files have their own access checks. This does not isolate
  shops from the server operator, who controls the shared process and files.
- **Passwords and recovery:** passwords use asynchronous scrypt with random salts. Reset tokens are
  stored as hashes, expire after 60 minutes, and are consumed after use. Password changes invalidate
  the member's existing sessions.
- **Settings credentials:** listed secret settings are blanked in ordinary settings responses, with
  `<key>_set` flags. Newly created API credentials are intentionally shown once to their authorized
  creator; protect them like passwords.
- **API access:** the public API is shop-bound and limited to 120 requests per minute per shop.
  Scoped agent keys add expiry, revocation, and explicit permissions. The legacy shop API key has
  broader access; prefer scoped keys for an external agent. See [API documentation](docs/API.md).
- **Developer webhook subscriptions:** delivery validates resolved addresses and pins the connection
  to a checked address, retains the hostname for HTTPS verification, and does not follow redirects.
  Signed deliveries include a timestamp. Persisted delivery rows retain automatic retry state across
  restarts. Receivers must verify signatures and handle duplicate events;
  a signature alone does not provide exactly-once delivery.
- **Offline cache:** the service worker caches public app-shell assets, excludes API responses,
  document pages and uploads, and clears its caches on logout. Downloads and other browser storage
  remain the device owner's responsibility.

## Account recovery

UI password reset needs the **server's mail configuration**, not only a shop's SMTP settings.
An authorized server operator can reset an existing account using the correct installation's
database paths and service account:

```bash
npm run admin -- reset-password owner@yourshop.com
```

The command generates and prints a password when one is not supplied. Keep its output private.
It requires database write access; it is not a recovery route available to an ordinary remote user.

## Known limitations

- Stored business data and reusable integration credentials are not encrypted by the application
  at rest. Restrict filesystem and backup access; use host/storage encryption where needed. A server
  administrator or compromised service account can read them.
- Signed document URLs are bearer access: anyone with a valid link can use it. Internal work-ticket
  links can expose costs and staff notes without a login; share them only with staff. Search-engine
  `noindex` metadata is not access control.
- AI is optional. When enabled, relevant prompts and shop context go to the configured model provider;
  Slack and other integrations also receive data for their enabled functions. Review provider terms,
  agent scopes and automation settings before connecting them. Model output is not a security boundary
  or a guarantee of correct estimates. The core CRM works without a model connection.
- Automated tests and security controls do not establish that every deployment or integration is
  secure. Keep the application, runtime and host patched, and report suspected gaps privately.
