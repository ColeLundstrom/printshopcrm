# Payment connections

PrintShopCRM works without online payments or AI. Record cash, check, bank transfer, or a payment collected elsewhere on an invoice. The community edition takes no application fee; the processor charges its own fees. Managed hosting is a separate service.

Online checkout supports **Stripe** and **Authorize.net Accept Hosted**. Choose one under **Setup & connections → Set up payments**. Switching providers affects new checkouts; keep the previous account's credentials and callback active until its pending checkouts are resolved.

## Stripe

1. Save your own Stripe secret key. Use a test key first.
2. Copy the shop's callback URL from Payment connections into Stripe Workbench → Webhooks → add event destination for your account.
3. Subscribe to `checkout.session.completed` and `checkout.session.async_payment_succeeded`.
4. Save that destination's `whsec_…` signing secret in PrintShopCRM. New checkouts require this secret as well as the account key.
5. Verify a test checkout and callback. Check **Recent checkouts**, then verify the test did not change the invoice balance. Configure the live destination and live account key separately before collecting real money.

Existing Stripe users must configure the new callback before this release can start new checkouts. Existing return links still verify completed sessions. Callback URLs require a publicly reachable HTTPS installation; local previews cannot receive provider events.

Stripe now uses the shop currency and its required minor units. Whole-unit currencies reject fractional totals instead of silently charging a different amount. Stored internal totals remain rounded to hundredths; unsupported finer amounts require manual reconciliation. [Stripe currencies](https://docs.stripe.com/currencies).

Signed callbacks verify the checkout again against Stripe. Payment recording no longer requires the customer to return to the app. A return page can also verify the session. [Stripe fulfillment guidance](https://docs.stripe.com/checkout/fulfillment).

## Authorize.net

1. Select **Authorize.net** and **Sandbox**. Sandbox and live accounts have separate credentials.
2. In the merchant interface, open Account → Settings → API Credentials & Keys. Save API Login ID, Transaction Key, and Signature Key. The Signature Key contains 128 hexadecimal characters.
3. Set the merchant account currency to the actual settlement currency. It must match the shop currency.
4. In Account → Webhooks, add the callback URL shown in PrintShopCRM, set it Active, and subscribe to:
   - `net.authorize.payment.authcapture.created`
   - `net.authorize.payment.capture.created`
   - `net.authorize.payment.priorAuthCapture.created`
   - `net.authorize.payment.fraud.approved`
5. Use **Save & test credentials**. This authenticates only; it does not charge a card or verify callback delivery.
6. Complete a sandbox hosted checkout and verify its callback before configuring a live account.

The customer enters card details on Authorize.net. PrintShopCRM stores a short-lived hosted token, not card numbers or security codes. Hosted tokens expire; the customer can return to the invoice for a new link. Authorization-only, declined, held, and voided transactions do not settle invoices. A successful callback is verified through `getTransactionDetails` before recording payment. [Accept Hosted](https://developer.authorize.net/api/reference/features/accept-hosted.html), [payment webhooks](https://developer.authorize.net/api/reference/features/webhooks.html).

## Reconciliation and reliability

Each new checkout stores its shop-local invoice/estimate reference, provider, amount, currency, and test mode. Verification must match all of them. Changing shop currency during an open checkout requires reconciliation. Stripe and Authorize.net test payments appear as **test paid** without changing invoices, triggering payment automations, or moving production.

The payment row, invoice balance, order stage, QuickBooks queue entry, and checkout completion are written in one SQLite transaction. Retried callbacks and simultaneous return-page confirmations do not double-post. A second Authorize.net transaction for an already completed checkout is flagged for review, not silently ignored. A payment arriving after an invoice is voided is recorded visibly while the invoice stays void. Overpayments retain the full amount and show a refund warning.

**Recent checkouts → Recheck payment** retrieves the existing transaction; it never creates a charge. For Authorize.net, supply the transaction ID from your merchant dashboard. Errors are retained for staff review. Provider retries handle temporary callback failures; this version does not include a background polling reconciler. Email/automation notifications run after the financial commit and are not guaranteed across a process crash at that boundary.

## Current boundaries

- Issue refunds and voids in the processor dashboard. Refunds, chargebacks, and processor-side voids are **not automatically imported into the invoice ledger**. Reconcile them with your invoice and bookkeeping records. This is a release-readiness limitation, not a claim of complete payment-accounting parity.
- Online adapters currently cover Stripe and Authorize.net. Other providers can be used outside the app and recorded manually. No arbitrary custom gateway URL or generic credential forwarding is supported.
- The separate legacy Lite edition continues to use its existing Stripe Connect business model. This release does not migrate those merchant accounts or change their existing fee arrangements.
- Credentials and tokens are excluded from browser responses. SQLite files and backups still require normal server access protection; this release does not add encryption at rest.
- Local fixture tests verify request construction and reconciliation behavior, including failures and replays. They are not a substitute for merchant-owned sandbox acceptance and an actual signed callback on the deployed HTTPS hostname.

## Adding an adapter

Use a hosted/tokenized checkout with no card data passing through the app. Integrate with the persisted payment-attempt flow. Implement provider authentication, callback verification, authoritative transaction retrieval, amount/currency/reference checks, and test-mode isolation. Add local HTTP fixtures covering duplicate delivery, a forged signature, another shop, wrong amounts/currency, delayed payments, decline/hold, rollback, and test payments before enabling the adapter. Do not treat a browser redirect or a submitted “paid” flag as proof of payment.
