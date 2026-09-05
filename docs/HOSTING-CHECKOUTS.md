# Recovering a hosting checkout

This guide concerns the optional managed-hosting subscription. Shop invoice payments and voluntary
[project support](PROJECT-SUPPORT.md) are separate.

## Shop owner

Open **Hosting** to see the saved checkout. **Continue checkout** uses that checkout's original
terms. **Check payment status** asks Stripe for its current state. If the connection failed,
wait briefly and check again rather than paying through another link.

To choose another billing interval, use **Close unpaid checkout** first. The server verifies
that Stripe expired the session before allowing a replacement. Returning from the Stripe page
alone does not close it. If payment completed while the session was being closed, the server
reconciles the subscription instead.

If Stripe created a session but its response was lost, the server retries with the saved request
and idempotency key. After the retry window, automatic creation stays on hold. The server operator
can find the original Checkout Session ID in Stripe; the owner can enter it under **Recover a
checkout with its Stripe ID**. The server verifies its account, shop, plan, original terms and
subscription before using it. A supplied ID is never enough to establish payment by itself.

An existing nonterminal hosting subscription uses **Manage hosting**. When a local record says
canceled, the server also checks the prior subscription at Stripe before opening a new checkout.
Changing a local status does not cancel a Stripe subscription.

## Server operator

In **Control Room**, use a shop's **Hosting** button to inspect saved checkout state and unresolved
payment reviews. This requires the platform administrator's owner account. Staff and other shop
owners cannot access it.

Review the exact checkout and subscription in the connected Stripe account. If an extra paid
subscription exists, handle the appropriate cancellation or refund in Stripe. Then enter what you
checked and choose **Verify and close review**. The server retrieves current provider evidence
before recording resolution. It permits closure only when the payment is safely associated with
the shop's current subscription, the extra subscription has ended, or the session expired.
The review action itself does not issue a refund or change a Stripe subscription.

Unresolved checkouts and payment anomalies block new hosting creation and shop deletion. Resolution
retains history. If the provider cannot establish a safe outcome, keep the review open and reconcile
the account before proceeding. Do not clear database fields to bypass the hold.

Use the original platform Stripe account and mode. Rotating a secret within the same account can
recover an existing intent. Switching to another account or between test and live modes cannot.
Aggregate in-flight, unresolved, stranded and anomaly counts are available to the administrator
through `GET /api/admin/billing`.

## Reliability boundaries

- One unresolved hosting intent per shop is enforced in the control database. Creation parameters,
  account identity and provider idempotency key are immutable. Database leases coordinate recovery;
  provider calls run outside transactions.
- Session verification and subscription binding use recorded intent metadata and current provider
  objects. Hosting revisions reject an interleaving update instead of applying stale state.
- Unknown writes retain the same request/key. Automatic creation retries stop after 23 hours from
  the first attempt or the attempt limit. Stripe may remove an idempotency key after 24 hours, and
  may cache an initial error response. A new key would be unsafe without reconciliation.
  [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests)
- Expiration is verified against current provider state. An open session can expire; a completed
  session must be reconciled as a payment.
  [Stripe session expiration](https://docs.stripe.com/api/checkout/sessions/expire)
- Work is bounded by concurrency, deadlines, response sizes and history limits. Reaching a limit
  reports a hold; it does not silently discard payment history or create a replacement payment.
- Back up the control database alongside shop databases. Recovery depends on the recorded intent,
  parameters and payment evidence, not only the tenant's current subscription ID.

Isolated tests exercise these recovery paths without real payments. The deployment's actual Stripe
account, webhook signing secret, public HTTPS callback and merchant-owned sandbox still require
acceptance before live billing. This guide does not establish end-to-end acceptance of shop invoice
payments, refunds or additional payment providers.
