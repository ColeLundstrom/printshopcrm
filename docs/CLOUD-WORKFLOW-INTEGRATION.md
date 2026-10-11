# Cloud workflow integration acceptance

Prepared October 11, 2026. Base: `b925c0d6637c27c01347d7a76255e82d8da8a013`
(v1.36.2), verified against the repository's main ref before integration. This review originally
prepared a candidate without a version bump or deployment. PR #18 subsequently merged the
reviewed source; current release preparation is recorded in [1.36.3](RELEASE-1.36.3.md). It excludes the older unpublished
four-feature 1.36.1 candidate and the preserved desktop workstreams.

## Included original work

The source IDs below identify local handoff commits. The combined PR head and tree are the
remote review target; do not assume every handoff commit is separately published.

| Slice | Source commit | Behavior and limits |
| --- | --- | --- |
| Quote duplication | `b4b0a48b2b8592284d4df20c66ea9ff0d46191d8` | Pick an existing customer, review copied prices/notes, create a fresh draft with current destination defaults. Optional retry keys use existing tenant/member-scoped receipts; a saved result survives server restart. The dialog retains uncertain requests only in the current browser session, not after a full reload. See [quote duplication](QUOTE-DUPLICATION.md). |
| Purchasing | `928c23964a8b8a7380e74d0093d26b5fbdf4a377` | Read-only, paged shop-wide recorded POs, filters, line-level shortages, placement evidence and receiving links. Short-close stays separate from received quantity. No supplier submission or live delivery claim. See [purchasing evidence](PURCHASING-QUEUE-VERIFICATION.md). |
| Books and A/R | `2897543df0d8cc6df4a69362952c1dfd7d5ae8cd` | Keep review-flagged positive, settled and overpaid invoices visible. Credits appear as evidence and are not subtracted twice; another customer's credit never offsets a receivable. No collection, refund or accounting-provider action. See [receivables review](RECEIVABLES-REVIEW.md). |
| Public proofs | `7c6aa3b8051d4812576bab09434a64bbc4752b86` | Conflicting canonical/legacy decisions, repeated fields and non-text notes fail before sign-off. Canonical decisions and documented string aliases remain compatible. Current-version, tenant, token, rollback and replay boundaries have real HTTP regression tests. |
| First-job evaluation | `97b01ad8d389e7014416149d3905423aa5079e93` | Existing outbound-blocked demo becomes the first-run path; a fictional 48-shirt/$600 order checks proof, job, partial payments, restart and repeat draft. Separate blank and production setup remain documented. See [first job](FIRST-JOB.md) and [website handoff](FIRST-JOB-PUBLICATION.md). |

No new runtime dependency, price, contract, provider setting or license change is included.
The additions follow this repository's source and test conventions; no competitor code or assets
were imported. AGPL and bundled third-party notices are retained. This record is scoped provenance,
not a guarantee of global code uniqueness, full competitor parity or legal clearance.

## Test and browser acceptance

Individual slice tests are evidence only for those slice commits. Combined gates must pass after
integration, including any review fixes and browser-harness additions. All fixtures use disposable
synthetic shops and the existing outbound guard. No real messages, suppliers, payments or customer
records are exercised.

After the identity and stale-response fixes, the combined local runtime checks passed on
Node 24.19.0: 454 Node tests, 955 regression checks, and E2E with one explicit off-loopback
network-interface discovery skip at local checkpoint `6221a5cb8113d4214305d177363030d07bd15d92`.
This includes the loading-dialog focus regression. Later browser-fixture and label corrections
add focused checks and must pass the exact current PR checks; these checkpoint counts are not
a substitute for final-head CI.

Local full checks require the supported SQLite and rsync command-line prerequisites. The cloud
runner reuses verified official Debian packages through process-local tool/library paths; it does
not substitute shims or change system configuration. A denied network-interface enumeration can
skip the documented off-loopback assertion; loopback and other E2E checks must still pass.

The existing CI browser job uses pinned Playwright with official Google Chrome and the sandbox
enabled. It must exercise the quote, purchasing and Books additions alongside the original planner,
preserve redacted synthetic reports/screenshots, and complete exact-commit CI. The public-proof
browser smoke also checks invalid forms, changes requested, replacement approval and replay,
alongside the separate HTTP boundary tests. Cloud browser startup restrictions are not a visual pass. Inspect
actual CI pixels at desktop/mobile widths before marking visual acceptance complete. See the PR's
exact-head checks and attached workflow artifacts for terminal results; a pending run is not a pass.

## Persistence and rollback review

- Purchasing, Books, public-proof validation and the guide add no schema migration.
- Duplication uses the existing `api_create_receipts` table and adds the tenant-local
  `estimate_copy_identities` table. Backfill gives existing estimates a non-secret random creation
  identity without changing their commercial data. An insert trigger also covers older-code
  inserts; a guard refuses identity updates, and estimate deletion cascades to its identity.
  Quote, identity, activity, deal and successful receipt commit atomically; a failed write must
  leave none. Replayed deleted drafts must be refused even if their numeric ID and document number are reused. The identity hardening also guards a stale source dialog and revalidates cached off-screen success.
- Old application versions can read the additive schema, but do not honor this duplication
  endpoint's new retry contract. Retain the identity table and triggers; never discard or regenerate
  identities to make a retry pass. Back up and restore identities and receipts together with the
  complete shop database. Before rolling back, pause duplicate actions and reconcile any
  uncertain copies. Do not discard receipt records or encourage blind retries against old code.
- Preserve all records and artwork. A data-backup restore is a separate recovery action requiring
  reconciliation of writes since that backup, not a routine code rollback.

## Release and deployment gates

A draft integration PR does not authorize or establish deployment. Before a new stable release:
verify exact final-head Linux/macOS/Windows/Docker/browser checks, reviewed screenshots, the normal
version/main/tag/application/site synchronization, a consistent database-and-artwork backup,
an isolated restore rehearsal, a rollback pointer, health and exact source-offer checks.

The known server route depends on the user's connected computer; it is closed during this cloud
integration. No VPS target or credentials are accessed here. The marketing site's separate source
and preserved candidate must be reconciled before website publication. Keep the current live
release unchanged while these gates remain open.
