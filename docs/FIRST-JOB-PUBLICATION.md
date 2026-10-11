# First-job evaluation guide: publication handoff

Prepared October 11, 2026. This is a repository documentation candidate, not a deployed website
change. The source baseline is `b925c0d6637c27c01347d7a76255e82d8da8a013` (application v1.36.2).

## Delivered scope

- [First-job guide](FIRST-JOB.md): one fictional 48-shirt order with a $600 invoice, customer
  approval, current appearance proof, linked production record, $200/$400 sample payments,
  restart verification and a fresh repeat-order draft.
- README and INSTALL send first-time evaluators to the existing isolated demo. Blank local
  installation remains available as a separate path. No seed/reset command is needed to try it.
- Entry-point copy distinguishes exports from complete backups, states self-hosting operating
  responsibilities and removes unsupported fixed install-time/resource promises.
- `test/first-job-guide.test.mjs` checks local documentation links, actual UI labels and the
  documented example through real local HTTP routes, with demo outbound guards enabled.

No application behavior, pricing, payment terms, hosting contract, contact form, provider
integration, license, production data or other website is changed.

## Relationship to the pending marketing-site work

The separate Mac candidate on `codex/self-host-install-journey`, based on marketing revision
`87249d01eb438ca0e38cffe53081e1f194c12d76`, remains uncommitted and was not accessed or copied
for this work. Its recorded handoff covers the homepage and three self-hosting pages, including
install/release CTAs, optional-hosting labels, backup/export/license copy and generated search HTML.

This candidate supplies the next useful destination after those installation CTAs. It changes
only the application repository's documentation and its new regression test. Do not overwrite
the pending marketing changes or rebuild the live site from this repository.

## Source evidence

Public text was retrieved on October 11 through the web reader:

- [Homepage](https://printshopcrm.com/): an existing section invites visitors to test a real
  estimate/proof/job/invoice workflow, but supplies no concrete reconciled example. Its self-host
  explanation already distinguishes paid hosting; preserve that improvement.
- [Self-hosting page](https://printshopcrm.com/services/self-hosted-print-shop-software/): the
  retrieved page still leads with a hosted trial and describes file-copy backups. Those issues
  belong to the existing Mac candidate and were not duplicated here.

The web reader reported these pages crawled that day. This is retrieved public-page evidence,
not a verified origin byte capture or a claim that the pending marketing changes are live.

The guide's product claims were checked against the application source at the baseline:

- `bin/demo.mjs`, `bin/demo-network-guard.mjs` and demo tests: separate data, private generated
  local login, loopback binding, existing-directory refusal and blocked outbound application calls.
- `public/js/views/estimates.js` and estimate routes in `server.mjs`: size/rate editing, customer
  links, acceptance history, conversion, payment-term controls and a fresh duplicate draft.
- `public/js/views/board.js`, proof routes and `docs/ARTWORK.md`: current proof/version handling,
  customer decisions, work ticket, separate technical review and limits.
- `public/js/views/invoices.js`, payment routes and `docs/PAYMENTS.md`: manual partial payments,
  balance reconciliation and provider-acceptance boundaries.
- `INSTALL.md`, backup/restore tools and JSON export routes: backups include applicable databases
  and artwork; exported shop data has documented exclusions/redactions.

The added example, prose and test were written for this repository from these public/source
behaviors. No testimonials, competitor code/assets, adoption figures or ranking claims were used.
Existing license and third-party notices remain unchanged.

## Optional website integration after review

Once the guide is merged and its main-branch URL resolves, add one secondary link inside the
homepage's existing first-job section, preserving the Mac candidate's primary install CTA:

> Try one fictional order before you switch. Follow 48 shirts through a quote, customer approval,
> art proof, linked production record, partial payments and a restart check. The isolated demo
> runs on your computer and blocks outbound application connections.

Link text: **Follow the first-job walkthrough**.

Intended destination after merge:
`https://github.com/ColeLundstrom/printshopcrm/blob/main/docs/FIRST-JOB.md`

This destination is not asserted to exist on main yet. Check it before enabling the link. A short
link on the existing self-hosting page is sufficient; do not create near-duplicate city/industry
pages or copy this guide across the site's search pages. Keep existing pricing, sign-in and
contact form behavior unchanged. No analytics, tracking pixels or install telemetry are added.

## Remaining publication gates

Completed in the isolated cloud checkout on Node 24.19.0:

- `node --test --test-concurrency=4 test/*.test.mjs`: 404 passed, 0 failed.
- `node bin/gate.mjs`: 955 passed, 0 failed with the required SQLite/rsync tools available.
- `node bin/gate-e2e.mjs`: all pass, one existing environment-dependent skip.
- New guide and demo-focused tests: 7 passed, including restart and persisted proof bytes.
- `node --check test/first-job-guide.test.mjs` and `git diff --check`: passed.

The Node dependency records matched the baseline lockfile; the existing cloud dependency tree
was reused. An initial gate run without SQLite/rsync had the same 17 failures on the untouched
baseline and candidate. Reusing verified official Debian packages with process-local tool/library
paths resolved all 17. No production service or system setting was changed for these checks.

1. Review the repository diff and complete exact-head CI. Repository publication alone does not
   deploy the marketing site or application.
2. Obtain and reconcile the authoritative marketing source with its preserved Mac candidate.
   The current cloud checkout contains the application, not that marketing source.
3. Integrate the small secondary link only after its destination exists. Run the site's build,
   generated-HTML checks, desktop/mobile review and dry-run-only form tests.
4. Use the separately authorized versioned publication process with rollback, then verify actual
   deployed pages and CTA destinations. No VPS or other deployment was attempted here.

Local visual review was attempted with the cloud computer's installed Playwright and Chromium,
with the browser sandbox enabled. Chromium failed before creating a page because its singleton
socket was not permitted. No screenshot or desktop/mobile visual pass is claimed, and the
sandbox was not disabled. The repository's existing CI browser job uses official Google Chrome
with its sandbox enabled; keep that gate and human guide review separate from the HTTP evidence.
