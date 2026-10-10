# 1.36.0 candidate: free profit planning and self-host reliability

Status: published review candidate in [draft PR #14](https://github.com/ColeLundstrom/printshopcrm/pull/14).
Repository publication was explicitly reauthorized on October 10, 2026 after an earlier cancellation.
The application candidate passed cross-platform CI; browser evidence is being added before final
release acceptance. Production access/backup/health checks remain required. Not deployed.

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

Browser-level visual acceptance remains pending: the cloud browser cannot reach the isolated
executor localhost, and direct Chromium startup is blocked by the execution sandbox. A normal CI
browser job supplies synthetic loopback smoke checks and screenshots for review. Behavioral VM
tests are not represented as a visual/browser pass. No real provider payment or outbound email was made.

Any later commit must pass its own CI; the draft PR records the exact current candidate and results.
Production backup/health evidence is required before this document describes the release as shipped.

## Deployment and rollback

The documented app root is /opt/printshopcrm-pro/current; the separate marketing root is
/opt/printshopcrm/current. Verify these against the actual server. Do not modify unrelated sites.
Follow RELEASING.md and the existing snapshot/release/verify-sync tools. Preserve all tenant DBs,
control/usage data and uploaded artwork. Never use a live filesystem copy as the sole database backup.

No new schema columns or customer-data restatements are introduced by this candidate. Rolling back
code uses the existing prior release, but must still be rehearsed and checked against a snapshot.
Full competitor parity, external provider acceptance, financial-statement imports and storefront
replacement are not claimed. See ADOPTION-BACKLOG.md for the next milestones.
