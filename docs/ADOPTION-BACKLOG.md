# Self-host adoption and product backlog

Updated October 10, 2026. The goal is broad use of the complete free software on a shop's own
computer or server. Optional managed hosting remains paid and must not be the default path or
unlock features. Preserve existing hosting agreements and all shop prices/payment history.

## Candidate 1.36.0

See [release evidence](RELEASE-1.36.0.md). Includes atomic database bootstrap, better demo failure
diagnostics, a free profit planning model, and a self-host installation doctor. Candidate code
is not a claim of a production deployment or complete competitor parity.

## Publication status

Repository publishing was explicitly reauthorized on October 10, 2026 after the earlier cancelled
GitHub tree creation. The earlier pause is resolved. Resume from the verified candidate and avoid
duplicating confirmed source uploads. Exact-commit CI and verified deployment access, backups,
rollback and health checks remain release gates; repository publication is not deployment.

## Next product milestones, in order

1. **Release confidence and installation.** Complete current-commit Linux/macOS/Windows/Docker CI;
   verify the exact production target, consistent snapshots, artwork, and rollback before deployment.
   Test a first install, first quote-to-payment workflow, update and restore on each supported OS.
   Offer clean local operation without hosted sign-up; never seed a working shop to demonstrate it.
2. **Safe migration from paid tools.** Start from a shop-authorized export, retain its original,
   preview CSV mappings, identify unsupported fields and require reconciliation before live use.
   Verify duplicate/idempotent and resumable imports, committed-row counts, customer links, active
   work, quote revisions, balances/partial payments, dates, artwork and rollback. A successful
   customer/history CSV import is not evidence of complete financial or active-job migration.
   Test twice-imported fixtures and interrupted batches without touching real shop data.
3. **Financial data foundation.** Define sales, gross/contribution/operating profit, cash received,
   credits/refunds, date ranges and estimated-versus-recorded cost coverage consistently across
   screens. Add customer/product/job rollups with fixture reconciliation and drill-down lineage.
   Preserve mixed-method and split-job allocations. Missing costs must be visible, never fabricated.
4. **Accounting import and goals.** Add reviewable financial-statement/QuickBooks import with source,
   mapping, deduplication, reconciliation and rollback; then persistent budgets, goals and alerts.
   No claim of full accounting before reconciliation and provider acceptance are proven.
5. **Quote-to-reorder decisions.** Expand conversion and reorder reporting using explicit time windows,
   customer cohorts and complete cost coverage; test accepted quotes, revisions, cancellations,
   stale inventory, and duplicate inbound requests. Verify the reported duplicate GHL task issue
   against its actual deployment source before editing this repository to address it.
6. **Workflow coverage.** Method-specific capacity, damaged receiving, payment terms/deposit targets,
   carrier integrations, storefront/fundraising and designer workflows remain separately scoped
   projects. Each needs a data model, failure recovery and user acceptance before replacement claims.

## Website and adoption work

See [the source-backed marketing handoff](SELF-HOSTING-MARKETING-RELEASE.md) for exact replacement copy and acceptance checks.

The marketing site is a separate deployment from this application. Preserve its URLs and existing
search value while making download/install and self-host documentation the primary calls to action.
Label a managed-hosting trial as hosted and optional. Correct obsolete commercial-license language,
unsupported resource/speed claims, and any advice that suggests copying a live SQLite database is
a reliable backup. Link complete snapshot/restore guidance including tenant databases and artwork.

Measure adoption only through voluntarily supplied feedback or clearly consented, aggregate signals
such as a successful first install and first completed workflow. Do not add customer tracking,
remote install telemetry, or a hosted account requirement in pursuit of adoption.

## Recurring review standard

Start with the latest remote commit and open PRs. Reproduce defects against synthetic data, write a
failing test, implement the smallest useful fix, run aggregate gates, and publish reviewable evidence.
Avoid simultaneous conflicting releases. Record current blockers and exact CI/deployment state.
