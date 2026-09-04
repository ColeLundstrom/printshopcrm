# Community roadmap and release standard

The goal is to make PrintShopCRM the dependable open-source operating system for print shops.
The optional paid service is hosting and basic setup. This is a direction, not a claim that the
current release replaces every specialized product.

## Protect the shop's working day

A change is ready when its regression tests pass, the full CI suite is green, and a reviewer has
checked its effect on customers, money, artwork, tenant separation, and existing data. New modules
need explicit acceptance cases and compatibility plans. Keep changes small enough to review.

- Every money-changing path uses the shared pricing code and preserves payment history.
- Every shop boundary is tested with a neighboring shop and with an unauthenticated visitor.
- Migrations must preserve existing records and be rehearsed against copies of old databases.
- A release requires a recoverable backup, strict health checks, and tested rollback instructions.
- Stable container images come from version tags only, after all reusable CI jobs pass.
- Hosted releases identify their version; compare deployed file hashes against that version.
- Experimental work stays out of stable releases until it meets the same requirements.

## Current scope

Implemented workflows include customers, quoting, approvals, invoices and payments, production
stages, artwork history, purchasing documents, price matrices, capacity planning, profitability,
imports/exports, staff roles, automations, and integration adapters. Automated tests are extensive;
external integrations still need provider-specific validation with the shop's own configuration.

## Expansion priorities

| Area | Current boundary | Acceptance work before calling it complete |
|---|---|---|
| Core shop operations | Implemented; continue real-shop validation | First-day walkthrough, cross-shop isolation, interrupted writes, replayed payments, upgrade and restore |
| Community releases | PR checks and code-owner review exist | Make every supported OS required; validate exact release tags; establish additional trusted reviewers |
| Stores and fundraising | Not a complete customer storefront product | Catalog, checkout, inventory reservations, order import, refunds, fulfillment, accessibility |
| Customer product designer | Not a complete online personalization system | Placement constraints, safe uploads, proof versioning, production-ready output |
| Decoration coverage | Screen print, embroidery, DTF and UV DTF; other methods vary | Shop-supplied fixtures for sublimation, vinyl, patches, laser, signs and wide format |
| Accounting | Invoices, payments, exports and QuickBooks adapter | Reconciliation, credits, taxes, audit history; a general ledger is a separate large module |
| Purchasing and inventory | Job purchasing documents and supplier adapters | Receiving, shortages, substitutions, stock reservations, partial shipments and returns |
| Localization | Currency/locale support exists; text largely inline | Translate strings, test dates and formats, accessibility review in each language |
| Scale and recovery | Per-shop SQLite, snapshots, strict health checks | Measured load targets, noisy-shop limits, off-site restore drills, documented capacity limits |

## Competitor reference points

The comparison is workflow-based. Printavo documents quoting, scheduling, payments, and shop
management: [Printavo features](https://www.printavo.com/features/). InkSoft documents online stores
and web-to-print: [InkSoft stores](https://www.inksoft.com/e-commerce-stores-and-web-to-print-sites/).
Those storefront and design workflows are material gaps; do not describe this release as a full
replacement for them. Reference pages checked September 4, 2026.

For the podcast, demonstrate the verified shop-management workflow and invite shops to shape the
next modules. Do not promise perfect reliability, complete competitor parity, or a delivery date
for unbuilt systems.

## Guided workspace follow-up

- OAuth mailbox connections and reliable inbound email synchronization (outgoing SMTP already works).
- Native migration adapters, editable column mapping, partial payment allocation, active production mapping, attachment reconciliation and resumable migration reports. The UI currently imports CSV customer/history records with strict payment-state review.
- Multiple independently revocable agent keys with endpoint scopes, audit attribution, expiry and install flows. The current single shop API key supports read-only or read-and-write access.
- Full Slack agent installation and granular action approvals. Existing Slack /quote is a draft workflow; external agents can use the REST API.
- Real customer-owned Twilio, SMTP and Slack end-to-end acceptance on a public staging host. Local tests use fixtures and the evaluation launcher blocks outbound network access.

### Payment accounting after the provider adapters

Stripe and Authorize.net hosted checkout now share verified, idempotent invoice posting. The next release gate is merchant-owned sandbox acceptance on public HTTPS. Stripe refunds, Authorize.net refunds/voids and explicit invoice credits now preserve history and pause collections for review. Chargebacks, unmatched external transactions, background reconciliation, QuickBooks credit/refund documents and jurisdiction-specific tax records remain before claiming complete payment accounting. See [PAYMENTS.md](PAYMENTS.md).
