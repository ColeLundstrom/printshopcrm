# 1.40.0 — Store payments, live stock, shipping labels

Base: published v1.39.0 (`2c89144`). No new runtime dependency and no licence change. New columns
and tables are added per shop on first use; no existing data is restated. Every integration below
uses the shop's own account and takes nothing from the transaction.

## Team stores take payment

- **One switch per store, off by default**, offered once Stripe or Authorize.net is connected.
  Money goes straight to the shop's own processor account.
- Members see their total with sales tax before paying. The order is saved before the card page
  opens, so an abandoned checkout leaves an unpaid order with a pay-later link the shop can copy.
- The store screen shows who has paid, what has been collected and what is still to pay.
- When the store's estimate becomes an invoice, each prepaid order is posted to it as its own
  payment; the balance is what unpaid members still owe. One job is opened for the store, never
  one per member. If that posting cannot be completed the invoice is flagged for review.
- A refund at the processor marks the order and flags the store; a paid order cannot be removed.

## Live distributor stock on the quote

- Quote lines show the distributor's stock under each size box (S&S, SanMar, alphabroder, through
  the shop's own connection), with sizes the quote exceeds flagged, an "as of" time and Refresh.
  Cached ten minutes per style, limited to 20 lookups a minute per shop; an outage never blocks a
  quote.
- Purchase orders list the distributor's exact SKU per size and colour when the quote resolved
  them. Placing the order is still done in the supplier's portal.
- **Products → Blank catalog is editable** (managers): add the blanks you buy and correct any
  cost. Your price outranks the built-in estimate.
- Each job's Profitability card says where its blank cost came from: live, your price, catalog
  estimate, or approximate.

## Shipping labels

- Connect your own EasyPost account (Setup & connections → Shipping labels) and rate, buy and
  print labels from the job; carrier and tracking number are saved to the job's shipments.
- One purchase per label: a double click or a dropped connection cannot buy twice. "Check
  purchase" asks the carrier what happened instead of guessing.
- With a test key every label is marked TEST on screen and on paper, is not recorded as a
  shipment and is never sent to a customer.
- Tracking refreshes when the job is opened; "Email tracking to customer"; managers can void.

## QuickBooks Online (beta)

- The owner can connect QuickBooks Online from Books & A/R with the shop's own Intuit app keys.
  One-way push of customers, invoices and payments with a visible log, Sync now and Retry.
- Sales tax goes to a liability account instead of income; dates use the shop's time zone.
  Credits and refunds are listed for manual entry instead of stalling the queue.
- "Export for Xero" downloads invoices in Xero's import layout for a date range.

**Behaviour change:** connecting and disconnecting QuickBooks is now owner-only (was manager).

## Known limits

- **None of the four integrations has been run against a live third-party account.** Store
  payments were tested against a simulated Stripe (Authorize.net shares the code path but was not
  exercised for store orders); stock against simulated S&S and PromoStandards responses; labels
  against a simulated EasyPost; QuickBooks against a simulated Intuit. Response details taken from
  public documentation may differ in practice. Each fails with a readable message rather than
  blocking the work around it.
- Store members get no emailed receipt; the order page is the receipt. Prepaid money appears in
  Reports and A/R from the day it is posted to the invoice, not the day the member paid.
- Labels: domestic parcels on production jobs only; no customs forms, return labels or carrier
  webhooks. The customer portal does not show shipment status.
- QuickBooks: whether QuickBooks accepts the sales-tax item the app creates, and behaviour with
  automatic sales tax switched on, are unconfirmed. Xero's column layout was checked against a
  third-party guide.
- No quick-order CSV for SanMar or alphabroder.
- Carried from 1.39: the stock price book has no quantity break for 1–2 colour screen print;
  signup does not confirm the email address; server list endpoints are unpaginated.
