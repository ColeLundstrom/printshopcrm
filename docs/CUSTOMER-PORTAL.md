# Customer portal

One link per customer that lists everything the shop has already sent them: estimates to approve,
proofs awaiting a decision, invoices with their balance, and jobs in progress with a stage stepper
and due date. It replaces "which email had the link?" with a single bookmark.

## For staff

Open a customer (Customers → name). The header has **Customer portal** (copies the link) and
**Open** (previews it in a new tab). Send the link however you like; it does not expire on its own.

The individual estimate, proof and payment pages also show **All your orders →**, which opens the
same portal for that document's customer.

API: `GET /api/contacts/:id/portal-link` (signed-in staff) → `{ "url": "https://…/p/account/12?k=…&s=…" }`.

## What the customer sees

| Section | Shown | Not shown |
| --- | --- | --- |
| Estimates | sent, approved, invoiced, declined | drafts (never sent; a revised quote returns to draft and its old link dies) |
| Proofs | the current version, once sent, until decided | draft, superseded or already-decided proofs |
| Invoices | every non-void invoice, open ones first; **Pay** when online payment is set up, a balance remains and no payment review is open | void invoices |
| Jobs | jobs not yet complete, with the board stages as a stepper | completed jobs |

Each list is capped at the newest 25 rows. Every action button is the existing `/p/estimate`,
`/p/art` or `/p/pay` link, so approve-once, superseded-proof and void/payment-review guards apply
unchanged. The portal itself changes nothing.

## Security

- The token is `token('account', contactId, shopSlug, key)` — the same HMAC as every `/p/` link —
  so it is unforgeable without the server secret and bound to one shop: replaying it with another
  shop's `?s=` fails. `?t=` is accepted as an alias for `?k=`.
- `key` is a random per-customer value in `customer_portal_keys` (created on first use, one row
  per contact, `ON DELETE CASCADE`). Deleting a customer kills their link, so a reused contact id
  never opens the previous customer's account.
- A bad, foreign or stale token gets the same 403 "Link expired" page as the other `/p/` routes.
- Responses are `Cache-Control: private, no-store`.

## Limitations

- There is no "reset link" button yet. To revoke a customer's link, delete their row from
  `customer_portal_keys`; the next copy mints a new one.
- The portal is read-only: no customer login, messaging or reorder.
