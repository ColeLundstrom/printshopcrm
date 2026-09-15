# v1.35.1 — Accurate daily priorities at shop scale

Today now loads its counters and ranked work queue in one authenticated request. It no longer downloads complete customer, invoice and estimate lists just to count them, or mistakes a failed list request for an empty shop.

- Overdue floor jobs show their actual overdue date, instead of “due tomorrow.”
- The approval counter includes every active job in the approval stage, even though the action preview remains capped.
- Upcoming work covers today through seven days ahead; older unfinished jobs appear separately as overdue.
- Paid, void, zero-balance and overpaid invoices do not become collection actions or subtract from money at risk.
- Shops with existing jobs retain their daily work queue rather than seeing the first-job setup card.

This patch changes read-only presentation and aggregate queries. It introduces no schema migrations, dependency upgrades, account changes, billing changes or outbound automation changes. Existing session cookies and customer records remain compatible. Source changes from v1.35.0 are confined to Today, release version metadata, regression fixtures and these notes.

## Verification

New HTTP coverage uses 1,500 customers, twenty approval-stage jobs, overdue/current/future work, zero/credit/void balances, owner/staff sessions and a second isolated tenant. It checks response size, correct counts and unchanged customer/production records. The view test checks one request, onboarding behavior and error propagation. An older deadline parsing gate now uses a fixed test clock so its explicit September 2026 fixture remains repeatable.

Production acceptance requires the complete unit/regression/E2E suites, mandatory CI jobs, a copied-data rehearsal, preserved-data backup, source parity, strict health, and existing-session reads. Test and deployment receipts are retained privately by the operator, without customer data in this repository.

## Competitive context

Reviewed September 15, 2026: [Printavo](https://www.printavo.com/) emphasizes quoting, approvals, payments and production; [InkSoft](https://www.inksoft.com/manage-everything/) centralizes order and production management. This pass improves the accuracy and loading cost of those everyday workflows in PrintShopCRM. It does not claim benchmarked superiority over every competing product. Broader parity and workflow speed need comparative user testing.

## Public source alignment

Pro was already running the v1.35.0 community workflow source at `2969e28`. This publication also brings that previously deployed source onto the public main/release path. Operators upgrading from the older published v1.34.2 should snapshot their data and follow RELEASING.md; the intervening v1.35.0 changes include additive schema and composite pricing formats, so rolling old code back over newly edited pricing is not safe.
