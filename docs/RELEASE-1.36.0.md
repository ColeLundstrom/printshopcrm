# 1.36.0 candidate: free profit planning and self-host reliability

Status: published review candidate in [draft PR #14](https://github.com/ColeLundstrom/printshopcrm/pull/14).
Repository publication was explicitly reauthorized on October 10, 2026 after an earlier cancellation.
The application candidate passed cross-platform CI and browser acceptance. The later dependency
notice packaging, browser-fixture and dependency-security corrections require fresh exact-current-commit CI. Production
access/backup/health checks remain required. Not deployed. The owner attested on October 10 that
he created the original code and logo; this is not independent ownership or legal clearance.
The requested staged Rust migration remains separate in [draft PR #15](https://github.com/ColeLundstrom/printshopcrm/pull/15)
and [the adoption backlog](ADOPTION-BACKLOG.md); it does not replace this working candidate.

Base: 41fa29b6d4f064c69c47e880f82b95750071ccf8 (1.35.7).

## Changes

- Free cost-plus profit planner, quantity price breaks with CSV export, and monthly break-even /
  target-profit model. Uses existing machine/employee cost configuration and makes no changes to
  customer quotes, invoices, payments, subscriptions or hosting contracts.
- Atomic database schema/default-setting bootstrap. Failure rolls back its batch instead of leaving
  partial migrations. Batching removes repeated disk commits without changing durability settings.
- Demo preparation errors identify the failing stage and timeout, termination or exit reason.
- Self-host installation doctor and documentation; clean local installation leads the README.
- Deterministic test-network fixtures: synthetic DNS and clean per-process environment, with external socket/provider-CLI calls blocked in test children. Production SSRF validation is unchanged.

## Evidence and release gates

The unmodified base passed 314 focused Node tests in the cloud Linux workspace (Node 24.19.0).
Initial full gates were limited by absent rsync/sqlite3 and public-DNS-dependent test fixtures.
Official Debian test prerequisites were subsequently materialized into temporary workspace tools;
no production machine or repository dependency set was changed.

Bootstrap regressions failed before the fix: partial migration left new tables committed, and
settings seeding could partially commit. Regression tests cover rollback, caller transactions,
tenant isolation, preserved settings and reopen/retry. Fresh bootstrap instrumentation found
185 unbatched write calls before the change and zero afterward. The existing Windows CI failure
stopped during demo shop creation before payment assertions. The candidate now passes the complete
Windows CI job, including unit/regression gates, E2E, seed/reset/reseed and server boot.

Profit-model and behavioral view tests cover exact price floors, margin versus markup, zeros,
invalid numbers, quantity breaks, forecast losses, stale reads/navigation, retry and export.
The independent review caught a whole-unit-currency display that could show a unit price below the computed floor; a failing JPY regression now passes with explicit model precision.

Full E2E: 1,262 checks passed, exit 0, with one explicit skip because this runner denies optional network-interface enumeration. Loopback binding and all other checks ran. The regression gate passed 955/955 after its narrow doctor-parser exception. Final focused suite: 375/375 passed. The full regression gate again passed 955/955 after the display fix. Independent review passed 61 focused checks and found no remaining material code blockers after both findings were fixed.

### Published candidate CI

Commit `ac7fcd9fc2c3608eeb19a7d5b433f90f1739a96b`, tree
`8f2add8a8e902a8374def9726373eaa2f3428d98`, passed [CI run 38087746230](https://github.com/ColeLundstrom/printshopcrm/actions/runs/38087746230):
Linux Node 22/current LTS, macOS, Windows, Docker persistence/compose, deployment configuration
validation and secret scanning. Linux Node 22 and macOS each ran 375 unit tests and 955 regression
checks with no skips, and their E2E gates passed without skips. Windows ran 373 unit tests with two
symlink-test skips, 925 regression checks with 30 POSIX skips, and E2E with two POSIX skips; the
Linux/macOS jobs cover those platform-specific paths. Stable-image publication correctly skips PRs.

Commit `62a232712a3e49f51bfe6a4d0fc903ff1e6185aa` passed [all applicable CI jobs, including browser checks](https://github.com/ColeLundstrom/printshopcrm/actions/runs/38089445604).
Its final local aggregate checks passed 380 unit tests, 955 regression checks and 1,262 E2E checks,
with the same one explicit local network-interface skip. Sixteen desktop/mobile browser scenario
groups passed in official Chrome 154.0.8037.97 with its sandbox enabled. The actual screenshots
were downloaded and inspected: valid calculations, invalid values, forecast losses and fresh
navigation states. [Screenshots, numeric CSVs and report](https://github.com/ColeLundstrom/printshopcrm/actions/runs/38089445604/artifacts/11683887335).

The cloud browser cannot reach the isolated executor localhost, so the normal CI browser job
supplies synthetic loopback smoke checks and screenshots. It explicitly stubs its exact `/ws` socket;
real WebSocket connectivity and message delivery are outside this visual test's scope. Browser
local-network protections remain enabled. Behavioral VM tests are not represented as a visual/browser
pass. No real provider payment or outbound email was made.

Any later commit must pass its own CI; the draft PR records the exact current candidate and results.
Production backup/health evidence is required before this document describes the release as shipped.

## Third-party notice correction

The locked dependency inventory identified one missing packaged notice: `@nodable/entities 3.0.0`
declares MIT but its npm archive omits the license text. The candidate now includes the unchanged
upstream notice and complete collected notices for all 114 current locked npm entries in
`THIRD_PARTY_NOTICES.md`, with source/version evidence and maintenance guidance under
`docs/third-party/`. Four regression tests verify lockfile/inventory correspondence, complete
notice text and exact upstream file matches; Docker CI compares the shipped notice bytes.

The application license is unchanged. Targeted security updates described below remove seven unused
transitive packages from the earlier 121-entry inventory. Eight entities package/runtime files match the
primary upstream commit; the declaration file matches an earlier source commit with the identical
MIT license. This qualified source match does not establish ownership or provide legal clearance.
Non-npm assets, base-image components and any other applicable obligations require their own review.

## Targeted dependency security corrections

The October 10 audit of the previous lockfile identified published advisories in three packages.
The candidate pins Multer 2.4.0 and Nodemailer 10.0.9 and locks Express's compatible transitive
proxy-addr at 2.0.8. No authentication, proxy-trust or network-security configuration is changed.
Seven unused packages disappear with Multer's removed concat-stream dependency. The new locked
inventory contains 114 entries. A fresh `npm audit --omit=dev` reported zero known advisories on
October 10; this is a point-in-time registry result, not a comprehensive security guarantee.

- [Multer aborted disk-upload cleanup](https://github.com/advisories/GHSA-3pph-fpjx-jg34): the
  application uses disk storage for mockups/logos. Authentication normally precedes those routes,
  but authorized uploaders reach this dependency. Memory-only CSV imports are outside this issue.
- [proxy-addr subnet trust](https://github.com/advisories/GHSA-jqcg-44mw-7w3h): particular short
  IPv4-mapped/zero-leading IPv6 trust subnets could trust unrelated addresses. The default numeric
  one-hop setting does not meet this specific condition; custom `PSC_TRUST_PROXY` settings may.
- Nodemailer 10.0.9 addresses the affected
  [TLS cache](https://github.com/advisories/GHSA-6vj9-mwq6-2f5v),
  [nested arrays](https://github.com/advisories/GHSA-8vvx-rff5-p5rq),
  [comment-joined parser](https://github.com/advisories/GHSA-prgh-xp8r-p3m5),
  [regex fallback](https://github.com/advisories/GHSA-v53p-9fqp-m79j), and
  [quoted local-part](https://github.com/advisories/GHSA-g57g-f23g-4646) advisories.
  Existing recipient guards reduce exposure, but manager-configured sender fields also enter the
  parser. The application's transport does not expose the differing `tls.servername` condition
  needed by that specific cache advisory. No actual unintended-recipient delivery is claimed.

[Nodemailer 10's release](https://github.com/nodemailer/nodemailer/releases/tag/v10.0.0) raises
its Node minimum to 20, below this application's existing minimum of 22.13, and moves package
implementation paths. Application imports already use the public package entry; the synthetic
billing-mail preload must use the package's ESM entry too. Focused regressions cover upload cleanup,
proxy trust and synthetic mail behavior; aggregate and exact-current-commit CI remain gates.
No real customer mail or payment was sent. See the PR for the final test results.

## Deployment and rollback

The documented app root is /opt/printshopcrm-pro/current; the separate marketing root is
/opt/printshopcrm/current. Verify these against the actual server. Do not modify unrelated sites.
Follow RELEASING.md and the existing snapshot/release/verify-sync tools. Preserve all tenant DBs,
control/usage data and uploaded artwork. Never use a live filesystem copy as the sole database backup.

No new schema columns or customer-data restatements are introduced by this candidate. Rolling back
code uses the existing prior release, but must still be rehearsed and checked against a snapshot.
Full competitor parity, external provider acceptance, financial-statement imports and storefront
replacement are not claimed. See ADOPTION-BACKLOG.md for the next milestones.
