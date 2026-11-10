# Payment connections

PrintShopCRM works without online payments or AI. Record cash, check, bank transfer, or a payment collected elsewhere on an invoice. The community edition takes no application fee; the processor charges its own fees. Managed hosting is a separate service.

Online checkout supports **Stripe** and **Authorize.net Accept Hosted**. Choose one under **Setup & connections → Set up payments**. Switching providers affects new checkouts; keep the previous account's credentials and callback active until its pending checkouts are resolved.

## Stripe

1. Save your own Stripe secret key. Use a test key first.
2. Copy the shop's callback URL from Payment connections into Stripe Workbench → Webhooks → add event destination for your account.
3. Subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `refund.created`, `refund.updated` and `refund.failed`.
4. Save that destination's `whsec_…` signing secret in PrintShopCRM. New checkouts require this secret as well as the account key.
5. Verify a test checkout and callback. Check **Online checkout activity**, then verify the test did not change the invoice balance. Configure the live destination and live account key separately before collecting real money.

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
   - `net.authorize.payment.refund.created`
   - `net.authorize.payment.void.created`
5. Use **Save & test credentials**. This authenticates only; it does not charge a card or verify callback delivery.
6. Complete a sandbox hosted checkout and verify its callback before configuring a live account.

The customer enters card details on Authorize.net. PrintShopCRM stores a short-lived hosted token, not card numbers or security codes. Hosted tokens have a limited window for opening the payment form. Expiry of that window does not prove that an already opened form cannot be paid. An unresolved checkout therefore stays on hold until its outcome is verified; it does not automatically create a replacement link. Authorization-only, declined, held, and voided transactions do not settle invoices. A successful callback is verified through `getTransactionDetails` before recording payment. [Accept Hosted](https://developer.authorize.net/api/reference/features/accept-hosted.html), [payment webhooks](https://developer.authorize.net/api/reference/features/webhooks.html).

## Reconciliation and reliability

Each new checkout stores its shop-local invoice/estimate reference, provider, amount, currency, and test mode. Verification must match all of them. Changing shop currency during an open checkout requires reconciliation. Stripe and Authorize.net test payments appear as **test paid** without changing invoices, triggering payment automations, or moving production.

The payment row, invoice balance, order stage, QuickBooks queue entry, and checkout completion are written in one SQLite transaction. Retried callbacks and simultaneous return-page confirmations do not double-post. A second verified Authorize.net capture for an already completed checkout records the full additional amount and pauses further collection for manager review. A payment arriving after an invoice is voided is recorded visibly while the invoice stays void. Overpayments retain the full amount and show a refund warning.

**Online checkout activity → Check provider** retrieves the existing transaction; it never creates a charge. For Authorize.net, supply the transaction ID from your merchant dashboard. Errors are retained for staff review. Provider retries handle temporary callback failures; this version does not include a background polling reconciler. Email/automation notifications run after the financial commit and are not guaranteed across a process crash at that boundary.

### Open checkouts and recovery

An invoice and its related estimate share one unresolved collection reservation. A second browser tab cannot open a competing deposit or balance checkout. The public payment page signs its displayed balance; a stale page must refresh before opening checkout. Manual payments or invoice changes while a checkout is open pause further collection.

Owners and managers can find **Online checkout activity** on the invoice and Payment connections. Resume retrieves the saved checkout; it does not automatically redirect staff. Stripe and Connect can close an open session only after the provider confirms expiration. An interrupted Stripe create can replay the exact saved request and key for up to 23 hours. After that, enter the original session ID from the merchant account and check it; no new session is guessed. Authorize.net recovery uses the original transaction ID. There is no local “assume unpaid” override.

Verified payment evidence is saved before applying it to the invoice, so a failed financial transaction cannot erase the provider receipt. Unexpected money appears under **Payments needing review**. A receipt that could not be applied remains held for reconciliation; changing an invoice or dismissing a warning is not proof that money was refunded. Historical pending checkouts also require verification before a replacement.

These controls follow [Stripe idempotency](https://docs.stripe.com/api/idempotent_requests), [verified Checkout expiration](https://docs.stripe.com/api/checkout/sessions/expire), and [Authorize.net Accept Hosted](https://developer.authorize.net/api/reference/features/accept-hosted.html). They do not replace checking the merchant account when a provider outcome remains uncertain.

## Refunds, voids and invoice credits

Initiate refunds and transaction voids in the processor dashboard. Signed callbacks fetch the authoritative record, match its original checkout, and append an adjustment to the payment ledger. Original payments remain intact. Duplicate callbacks do not double-post. A failed/canceled refund that restores funds appends a compensating entry instead of deleting history. A reversal arriving before the payment callback writes both records atomically without receipt automations or production advancement. Sandbox reversals never change balances.

Supported events are Stripe `refund.created`, `refund.updated`, `refund.failed`, plus Authorize.net `net.authorize.payment.refund.created` and `net.authorize.payment.void.created`. Stripe refunds must resolve to a Checkout Session with this shop's metadata and PaymentIntent. Authorize.net refunds must resolve through the original transaction to a persisted checkout. Unmatched/offline payments require manual reconciliation. See the [Stripe refund object](https://docs.stripe.com/api/refunds/object) and [Authorize.net transaction types](https://developer.authorize.net/api/reference/features/payment-transactions.html).

A refund returns money; a credit reduces the invoice. Staff review these separately:

1. Open **Payment connections → Refunds & voids**. Recheck pending transactions from the provider without issuing another refund. Authorize.net pending refunds reduce net receipts while pending; pending Stripe refunds apply only when they succeed. Both pause collections.
2. On the invoice, use **Issue credit** if part of the work was canceled. Enter the allowance, actual tax adjustment and a customer-visible reason. The original invoice total and item lines stay available; the adjusted total reflects credits. The app refuses credits beyond the original subtotal or tax, and refuses a guessed tax adjustment when the historical tax breakdown is unavailable. Credits move no money and do not advance production.
3. **Review balance** records the manager's explanation before allowing new payment requests. Pending refunds must be resolved first. If a whole invoice was canceled and net received is zero, use Void. Cancel a mistaken credit with a reason; history remains and review reopens.

New invoice-related outbox drafts are associated with their invoice and become unusable after a reversal/credit; generate a fresh message after review. Queued invoice sequences stop for review, and their current balance is rechecked before they resume. Legacy drafts without an invoice association, messages already handed to the delivery provider, and external scheduled messages cannot be recalled: review those manually. This is not a blanket recall mechanism.

Invoice PDFs show credits and returned payments. QuickBooks sync explicitly stops on invoices with credits or processor reversals; this release does not create QuickBooks CreditMemo or RefundReceipt documents. Reconcile those books separately. Invoice credits are adjustments within this CRM, not a complete jurisdiction-specific credit-note/tax reporting system.

## Team store orders paid at checkout

A team store (**Merch stores**) can take payment when members order. It is one switch per store, off by default, and it can only be switched on while the shop's own processor is ready — the money goes to the shop's Stripe or Authorize.net account through the same durable checkout described above. There is no platform fee and no second processor.

- **What a member is charged.** The store price of what they picked, plus sales tax at the rate of the customer the store was opened for (0 for a tax-exempt customer). The order page shows the total with tax before they continue; that figure is what the checkout charges.
- **Saved first, paid second.** The order is stored before the checkout opens. A checkout that fails to start, expires or is abandoned leaves an unpaid order and a private link the member (or the shop, with **Copy pay link**) can use to pay later. While a checkout for an order is open, paying again resumes that same checkout; a paid order is never offered for payment again.
- **Callbacks.** The signed provider callback and the member's return to the site both reconcile the payment, once. The session must carry this shop, this order, the reserved amount and currency, and the account that created it; anything else is held for review under **Payment connections** and the order stays unpaid.
- **Closing.** After the close date, or once the store is closed or turned into its estimate, no new orders and no new payments are accepted. Orders already paid stay. A checkout that was opened before the store closed and is completed afterwards is still recorded — the money is real.
- **Reaching the books.** Member payments wait on the store until its one estimate is converted. At that moment each prepaid order is posted to the invoice as its own payment row ("Team store order #N — Name paid online"), exactly once, and the invoice balance is what the unpaid members still owe. A member who pays after the invoice exists is posted to it straight away. Reports, A/R and QuickBooks see the money from the invoice date of posting, not from the day the member paid.
- **Estimate total.** When any order has been taxed, the estimate bills exactly the sum of the orders. Per-order rounding can differ from tax on the summed goods by a cent or two; the difference appears as a stated "Sales tax adjustment" line.
- **Refunds.** Refund at the processor. A refund of a payment already on the invoice follows the invoice path above. A refund that arrives before the store has an invoice marks the order **Refunded**, flags the store for a payment check, and — when the invoice is later raised — posts both the payment and its refund and holds the invoice for review. A paid order cannot be removed, and a store holding unposted payments cannot be deleted.
- **Production.** A paid member order never opens a job. Production starts from the store's single estimate.
- **Test keys** record a test checkout and leave the order unpaid.

Not covered: per-member receipts by email (the order page is the receipt), partial payment of an order, a second different payment against one order (flagged for a manual refund), and stores taking payment on the legacy Lite edition have not been exercised. The Authorize.net path uses the same code as invoices but has only been tested with the Stripe fixture.

## Current boundaries

- Chargebacks/disputes, payments created outside this app, and unsupported provider states require manual reconciliation. Refunds/voids are initiated at the provider, not through an app button. This release is not complete payment-accounting parity.
- Online adapters currently cover Stripe and Authorize.net. Other providers can be used outside the app and recorded manually. No arbitrary custom gateway URL or generic credential forwarding is supported.
- The separate legacy Lite edition continues to use its existing Stripe Connect business model. This release does not migrate those merchant accounts or change their existing fee arrangements.
- Credentials and tokens are excluded from browser responses. SQLite files and backups still require normal server access protection; this release does not add encryption at rest.
- Local fixture tests verify request construction and reconciliation behavior, including failures and replays. They are not a substitute for merchant-owned sandbox acceptance and an actual signed callback on the deployed HTTPS hostname.

## Adding an adapter

Use a hosted/tokenized checkout with no card data passing through the app. Integrate with the persisted payment-attempt flow. Implement provider authentication, callback verification, authoritative transaction retrieval, amount/currency/reference checks, and test-mode isolation. Add local HTTP fixtures covering duplicate delivery, a forged signature, another shop, wrong amounts/currency, delayed payments, decline/hold, rollback, and test payments before enabling the adapter. Do not treat a browser redirect or a submitted “paid” flag as proof of payment.

## QR-to-pay

The invoice PDF prints a **Scan to pay** QR code beside the totals when the invoice is not void and still has a balance due. The code opens the invoice's existing customer pay link (`/p/pay/:id` with its share token, and the shop slug on multi-tenant installs), so it carries no extra access. A paid, overpaid or void invoice prints no code. The code is drawn as vector rectangles from the `qrcode` module's matrix; the PDF writer embeds no image. The absolute link uses `PSC_PUBLIC_URL` when set, otherwise the host the PDF was requested from. Set `PSC_PUBLIC_URL` so printed codes do not point at a LAN address.

The online pay page also shows the same code under the pay buttons, so a customer viewing it on a computer can pay from a phone. It is hidden when online payments are not configured. The staff work ticket (`/p/ticket/:id`) includes a QR code for the staff job page (`/#/jobs/:id`). Opening it requires a staff sign-in.
