# 1.36.3 cloud workflow release preparation

Status: version preparation, not a tag, image publication or production deployment. The reviewed
product changes merged through [PR #18](https://github.com/ColeLundstrom/printshopcrm/pull/18)
at `be223c5645971c7e60ff1d47adf20f3bd73827d4`, tree
`569cf0d04b80295ab76f485d16bf2d06d876fa7d`. The base is published v1.36.2 at
`b925c0d6637c27c01347d7a76255e82d8da8a013`. The separate unpublished 1.36.1 candidate
and preserved desktop workstreams are excluded. No version tag may be overwritten.

## Changes

- Duplicate a quote for an existing customer with copied-price/notes review and current destination
  defaults. Retry receipts recover a saved draft after an uncertain response. Immutable creation
  identities guard source and result row-ID reuse. See [quote reuse](QUOTE-DUPLICATION.md).
- Review recorded purchase orders across the shop, with supplier/search filters, paging, per-line
  shortages, placement evidence and receiving links. Closing a shortage stays distinct from
  receiving it. This queue is read-only; it does not place supplier orders. See [Purchasing](PURCHASING-QUEUE-VERIFICATION.md).
- Review flagged positive, settled and overpaid invoices in Books. Active credits are displayed as
  evidence and never subtracted twice or netted across customers. No collection/refund is sent.
  See [Books](RECEIVABLES-REVIEW.md).
- Public-proof submissions with contradictory/repeated decisions or non-text notes are refused
  before sign-off. Valid canonical decisions and documented string aliases remain compatible.
- Use the isolated, outbound-blocked demo for a [first-job walkthrough](FIRST-JOB.md), including
  quote, proof, production, partial recorded payments, restart and repeat order. Blank self-host
  setup remains separate. [Website publication](FIRST-JOB-PUBLICATION.md) requires its own source review.

No runtime dependency, existing contract/price, provider configuration or license change. AGPL
and third-party notices remain. These are bounded improvements, not full competitor/accounting
parity or verified live provider delivery.

## Verified product checkpoint

[PR head CI](https://github.com/ColeLundstrom/printshopcrm/actions/runs/38145386300) passed on
head `03fca7a9579ec924718fb66ced1bb00d5d559df9`, with the identical tree subsequently merged.
Linux 22 and macOS ran 463 Node tests, 955 aggregate checks and E2E successfully. Windows passed
461 Node tests with two platform skips, 925 aggregate checks with 30 POSIX-only skips, and E2E
with two POSIX skips. The platform-specific cases pass on Linux/macOS. Linux LTS, Docker, secrets
and deploy-configuration checks also passed. The main-only existing-image check is not a PR gate.

All five browser suites passed with pinned Playwright 1.64.0 and official Google Chrome
154.0.8037.97, sandbox enabled. The [artifact](https://github.com/ColeLundstrom/printshopcrm/actions/runs/38145386300/artifacts/11704915512)
contains 55 screenshots and five passing reports; ten final desktop/mobile/tablet screenshots
were visually inspected. Coverage includes quote retry/recovery and focus, Purchasing filters and
short-close, Books navigation and tenant isolation, and public-proof rejection/approval/replay.
Realtime sockets are mocked and all shops are disposable synthetic fixtures. This is targeted
keyboard/visual coverage, not a comprehensive accessibility audit.

The version-preparation commit, merged main and any future tag each require their own exact-head
CI receipt. Prior checkpoint success is not a substitute. Version fields in package.json and the
lockfile must agree with the intended tag before publication.

## Data and rollback

Only quote duplication adds schema: a tenant-local identity table with atomic backfill, insert and
immutability triggers, and estimate-deletion cascade lifetime. Existing commercial records are not
restated. Copy, activity, deal, identity and receipt commit atomically. Keep the complete identity
and receipt state together in database backups. Never regenerate identities or discard receipts
to make an old retry pass. On older-code rollback, pause duplicate actions and reconcile uncertain
copies while retaining the additive table/triggers. A full browser reload loses the in-memory
retry reference, so check Estimates before starting another copy after reload.

## Unfinished stable-release gates

Follow [RELEASING.md](../RELEASING.md): reviewed exact-head tests, synchronized source/app/site
versioning, current consistent control/tenant-database and artwork backup, isolated restore
rehearsal, verified rollback pointer, server-side gate and strict health, exact source offer and
runtime-file synchronization. The tag must be a new version that belongs to main. Image publishing
waits for reusable CI and must finish before its registry availability is announced.

The cloud work has no authenticated native GitHub CLI or supported tag/release-write connector.
The existing production route depends on the user's computer, which was closed during this work.
Do not create credentials, change permissions or bypass these access limits. A merged PR alone
is not a deployed release. Recheck access through the supported environment route when resuming.
