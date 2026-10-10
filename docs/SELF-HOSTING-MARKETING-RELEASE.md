# Self-hosting marketing corrections and release checks

Prepared 2026-10-10. Status: proposed marketing content; not deployed.

## Scope and evidence

The intended outcome is more successful installations on shops' own computers or servers. Keep the full application free to self-host. Paid hosting is optional; a hosted trial is a separate offer. Do not change billing, license text, or existing customer agreements.

The application checkout was inspected at commit `41fa29b6d4f064c69c47e880f82b95750071ccf8`. Its [RELEASING.md](https://github.com/ColeLundstrom/printshopcrm/blob/main/RELEASING.md) identifies marketing as a separate deployment. Marketing source was not found in this checkout or the accessible repository catalog. No application files were edited for this audit.

Public-page text was retrieved through web search/open on 2026-10-10. Retrieval freshness differs: the free-software result says it was crawled last month, the self-hosting page three days ago, and the home/open-source/pricing pages today. These are evidence of published/indexed copy, not proof of the exact current origin response. Recheck live pages before applying replacements. The tool could not retrieve robots.txt or sitemap.xml; this does not establish that either is missing or broken.

## Priority 1: correct backup and licensing claims

### Backup wording to replace wherever present

Affected text appears on [self-hosting](https://printshopcrm.com/services/self-hosted-print-shop-software/), [open source](https://printshopcrm.com/open-source/), [free software](https://printshopcrm.com/services/free-print-shop-software/), and [pricing](https://printshopcrm.com/pricing/): copying one database file is presented as a complete backup or migration procedure.

**Replacement copy:**

“Protect your shop with the documented backup and restore tools. A complete installation can include a control database, a database for each shop, and uploaded artwork. The backup script uses SQLite's backup operation and packages the artwork; keep a verified copy off the server. Do not copy a live database file as your backup procedure. Before relying on a backup, test a restore in a separate installation and check that you can sign in, find customer records, and open artwork.”

**Restore FAQ replacement:**

“Follow the installation guide's restore procedure. Stop the application, run the restore tool's preview as the service account, review its destinations, and only then perform the restore. The tool handles stale SQLite journal files and restores artwork when the archive includes it. Restart and verify the shop's records and files. An export for moving records is different from a complete recovery backup.”

Link “backup and restore tools” to [INSTALL.md, Backups](https://github.com/ColeLundstrom/printshopcrm/blob/main/INSTALL.md#backups), and “restore procedure” to [Putting a backup back](https://github.com/ColeLundstrom/printshopcrm/blob/main/INSTALL.md#putting-a-backup-back).

**Application evidence:** `INSTALL.md` lines 255–285 and 370–410; `deploy/backup.sh`; `bin/restore.mjs`. `bin/snapshot.mjs` snapshots databases using SQLite `VACUUM INTO`; it does not itself archive artwork, so do not present that command alone as a complete backup. Avoid copying commands to marketing pages where paths and service names can drift.

### Licensing and costs

The free-software page advertises commercial license exceptions. [HOSTING.md](https://github.com/ColeLundstrom/printshopcrm/blob/main/HOSTING.md) expressly says these are not part of the service. Remove that offer; do not modify the license or imply permission to relicense.

**Replacement copy:**

“PrintShopCRM is available under AGPL-3.0-or-later, with no software subscription or per-seat license charge for self-hosting. You provide and maintain the computer or server. Domains, email, payment processing and other external services may have their own charges. Optional paid hosting and setup services are separate from access to the application. Read the repository's license before modifying or distributing the software.”

Link the license to [LICENSE](https://github.com/ColeLundstrom/printshopcrm/blob/main/LICENSE), and optional hosting to the existing pricing page. Do not promise that hosting is permanently free or that self-hosting has no operating costs. No license change is proposed.

## Priority 2: make installation the primary conversion

Use this order on the home, free-software, open-source and self-hosting pages:

1. **Install free software** → https://github.com/ColeLundstrom/printshopcrm/blob/main/INSTALL.md
2. **Browse releases** → https://github.com/ColeLundstrom/printshopcrm/releases
3. **Optional paid hosting** → https://printshopcrm.com/pricing/

The release API confirmed a published, non-prerelease v1.35.7 at the time of review. It has source archives but no packaged installer assets. Do not label a source archive a Windows/Mac installer, or imply double-click installation. Update release-specific references when the next tested release is actually published.

Keep sign-in available for existing hosted customers. If a hosted-trial CTA is retained, label it “Try managed hosting” and display its duration plus the fact that continued hosting is paid beside it. Do not let it be the primary action on pages targeting free installation. Keep existing verified pricing; this work does not authorize a pricing change.

**Common hero supporting line:**

“Install on your own computer or server. Keep access to the full application without a software subscription. Your team handles setup, updates and backups; managed hosting is available separately.”

### Home page

The retrieved home page already separates self-hosting from paid hosting. Preserve that improvement and make its main button lead directly to installation rather than another marketing page.

Suggested title: `Free Self-Hosted Print Shop Software | PrintShopCRM`

Suggested H1: `Free print shop software you can run yourself`

Suggested description: `Manage print shop estimates, proofs, production and invoices. Install open-source PrintShopCRM on your own computer or server. Paid hosting is optional.`

### Free-software page

Suggested title: `Free Print Shop Software to Self-Host | PrintShopCRM`

Suggested H1: `Free print shop software for your own computer or server`

**Opening copy:**

“Run PrintShopCRM on hardware you control for estimates, artwork approvals, production tracking and invoices. The application is open source and free to self-host. Start with the installation guide, then test your own quoting and production workflow before moving daily work.”

**Replace the unverified resource and install-time promises:**

“PrintShopCRM uses Node.js and SQLite with no frontend build step. Installation requires a supported Node version, dependencies and configuration. Your storage and memory needs depend on shop records, artwork and workload. Follow the current requirements and setup instructions in the repository.”

Remove the numerical multi-shop memory claim, fixed dependency count, three-second promise, claims of customer adoption without evidence, and the claim that every table is exported to CSV. The current app has specified CSV exports and a JSON shop-data export that deliberately omits/redacts credentials and cached supplier data.

**Export FAQ replacement:**

“You can export supported business records as CSV and shop data as JSON. The JSON export identifies excluded or redacted credentials and cached data. Uploaded artwork and the installation's recovery data need the documented backup procedure. See the repository for available exports and backup instructions.”

**Competitor FAQ replacement:**

“Compare the total cost and operating responsibilities of each option. PrintShopCRM lets you inspect its source and operate your own installation. Commercial services may include hosting and support in paid plans. Check each provider's current pricing and trial terms, and test the workflows your shop needs.”

The current [Printavo pricing](https://www.printavo.com/pricing/) and [shopVOX pricing](https://shopvox.com/pricing/) pages describe paid plans and trials. They do not substantiate the free-software page's claim that both providers offer permanent free tiers. Link their primary pricing pages if naming them; do not speculate about motives or imply every competitor bills identically.

### Self-hosting page

Suggested title: `Install Self-Hosted Print Shop Software | PrintShopCRM`

Suggested H1: `Install PrintShopCRM on your own computer or server`

**Opening copy:**

“Choose a local evaluation or a production installation on a server you control. PrintShopCRM runs with Node.js and SQLite, with documented Node and Docker paths. You are responsible for authentication, persistent storage, updates and tested backups.”

**Installation choices:**

- **Try it on your computer.** Follow the local guide on Linux, macOS or Windows to evaluate the workflow. Demo records are for testing. Keep the evaluation private; complete the production setup before using real customer data on a public server.
- **Run your own production server.** Follow the production guide for a Linux server, authentication, TLS and persistent data/artwork storage. Set up backups and test recovery before switching daily work.
- **Use Docker.** Follow the documented image and volume configuration. A container does not remove the need for authentication, persistent storage, updates or backups.

Link the choices to the existing `INSTALL.md#try-it-locally`, `INSTALL.md#production-install`, and `deploy/DEPLOY.md#docker` sections. At the audited commit, `package.json` requires Node >=22.13.0; do not loosen this requirement. Do not advertise the worker's new demo flow until it has passed tests and shipped.

Replace both the one-file backup bullet and backup FAQ with the Priority 1 copy. Replace the terminal/setup FAQ with: “Self-hosting requires comfort with installation, configuration and ongoing maintenance. The repository provides step-by-step guides. If you prefer help, paid hosting and setup are optional.”

### Open-source page

Keep this page focused on license, source availability, contribution and data control. Use the primary installation CTA above, the Priority 1 cost/license wording, and safe export/backup wording. Link to CONTRIBUTING.md and LICENSE. Avoid blanket promises of permanent service continuity: external services and maintenance still matter even when source code is available.

## Release acceptance criteria

This is one bounded correction pass over existing pages, not a new set of search pages.

- [ ] Obtain the actual marketing source and record its revision. Check the current live response before changing text; do not replace already-correct sections blindly.
- [ ] Use one clear H1 and a descriptive, page-specific title/description. Preserve existing URLs and canonical relationships unless actual duplication warrants a separately reviewed change.
- [ ] Free-software, open-source and self-hosting heroes make installation their first and visually primary action on mobile and desktop.
- [ ] Source/install/release links open without a hosting account or lead form. Check link destinations, release identity and documented anchors.
- [ ] Any hosted trial is explicitly optional; continued hosting is paid. No billing code, license terms or customer agreements change.
- [ ] No copy-one-live-database backup advice remains on these pages, including metadata, FAQ JSON-LD, cards and related excerpts. Backups describe all applicable databases plus artwork; exports are not presented as full recovery backups.
- [ ] No commercial-license exception offer remains. AGPL-3.0-or-later text matches the repository's unchanged license metadata.
- [ ] Unsupported fixed installation-time, dependency-count, resource-use and customer-proof claims are removed. No invented testimonials, adoption counts, superiority scores or growth results are added.
- [ ] Competitor statements have current primary-source support, or are replaced with the neutral comparison above.
- [ ] Keyboard focus, readable button text, text wrapping, zoom and narrow-screen layout work. Preserve the existing contact form and verify its behavior without sending a real lead.
- [ ] Build and existing site tests pass. Test rendered metadata, structured data and CTA destinations, then deploy using the site's documented versioned release/rollback process.
- [ ] Fetch deployed pages after activation, record status/canonical/title/H1/CTA targets and screenshots, and confirm the deployed revision matches the tested source. Only then mark marketing changes live.

## Measurement and SEO limits

Primary outcome: visitors reaching installation/release guidance and ultimately completing self-hosted setup. A CTA click is only an install-intent proxy, not a verified installation. Do not add outbound telemetry to self-hosted installations without a separate privacy and authorization decision. Optional-hosting clicks are a separate secondary outcome.

If an authorized analytics system already exists, use aggregate existing data to compare install-guide clicks and landing-page search impressions/clicks before and after this change. No analytics or Search Console data was inspected here. There is no evidence yet of ranking, traffic or conversion improvement, and no guarantee is made.

The recommendation follows Google's guidance on [helpful, reliable content](https://developers.google.com/search/docs/fundamentals/creating-helpful-content), [descriptive titles](https://developers.google.com/search/docs/appearance/title-link) and [canonical URLs](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls). Prioritize truthful, useful installation guidance over additional near-duplicate pages.
