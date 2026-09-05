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

If a payment notification arrived while Stripe could not be reached, **Payments awaiting
verification** retains its exact Checkout identity. The owner sees a pending-payment notice in Hosting;
the administrator can choose **Check payment** in the shop's Hosting panel. This retrieves the
recorded session and current subscription, then either reconciles hosting or creates a payment
review for the operator. Failed checks remain visible and block a new payable checkout. A cleared
receipt stays in the audit history, and retrying it does not make another provider request.

## Deleting a shop

Deletion does not cancel hosting. End its subscription using **Manage hosting** or Stripe, then
retry **Delete** in Control Room. A scheduled cancellation still counts as active until the
provider says the subscription ended. Local `canceled` text is not sufficient evidence.

The server checks the actual account and test/live mode, exact customer and subscription, and
the shop's hosting provenance. It also checks recorded extra subscriptions, resolved payment
reviews and pending payment-verification receipts. These remain liabilities even when the local
shop no longer has a current subscription binding. Only provider-confirmed `canceled` or
`incomplete_expired` subscriptions, or an exact expired checkout with no subscription, permit
removal. Unresolved payment reviews must first be reconciled using the controls above.

Unavailable credentials/provider responses, mismatched records, active subscriptions, concurrent
hosting changes and verification limits preserve the shop. Read failures need a retry; inconsistent
history needs operator review. Neither deletion nor payment verification cancels, refunds or
creates a Stripe payment.

The control database retains a deletion tombstone and verified billing evidence. Retrying a
successful deletion returns its recorded result without querying Stripe or deleting a directory
again. If the registry was removed but data cleanup failed or its final result could not be saved,
the response explicitly reports that the cleanup outcome needs operator review. It does not
claim the shop is still present. Back up and retain the control database as part of financial
recovery history.

For integrations and operator scripts, `deleteTenantWithHostingCheck(id)` is the asynchronous
entry point. The synchronous `deleteTenantFully(id)` still works for never-billed shops and
refuses previously billed shops without the internal one-use verification. No caller-supplied
boolean or local subscription-status edit bypasses that guard.

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
- Deletion uses a database-visible 120-second lease and checks the captured hosting revision and
  retained-history digest again in the same transaction as registry removal. Provider reads run
  outside that transaction. Checkout admission and received hosting-event verification share
  database-visible leases; failed received-payment verification retains a durable receipt after
  the active lease ends. Another process or a restarted server sees the same hold.
- A deletion check permits at most 24 provider reads, 500 records per history category and four
  combined deletion/event operations. It stops starting reads after a 60-second work budget;
  an already-started request has its existing 15-second timeout, so an unsuccessful check may
  take roughly 75 seconds before returning. Expired leases never grant approval: retry performs
  fresh verification. A history beyond the configured limits requires operator review.
- These checks cover recorded hosting liabilities and already-admitted payment notifications.
  They do not discover arbitrary unrecorded subscriptions or unrelated products in Stripe.

Isolated tests exercise these recovery paths without real payments. The deployment's actual Stripe
account, webhook signing secret, public HTTPS callback and merchant-owned sandbox still require
acceptance before live billing. This guide does not establish end-to-end acceptance of shop invoice
payments, refunds or additional payment providers.
