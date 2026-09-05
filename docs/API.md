# PrintShopCRM API

A stable REST API under `/api/v1`, plus signed outbound webhooks.

There is also a live, copy-pasteable version of this at **`/docs-api.html`** on any running install. Agent operations have an OpenAPI description at **`/openapi.json`**. Setup downloads a version filtered to a connection’s scopes with this installation’s absolute API URL; configure its bearer key separately. GET `/api/v1/production/team` lists active IDs/names under `production:read`.

> The API requires multi-tenant mode (`PSC_AUTH=1`), because an API key belongs to a shop. On a
> single-shop install the internal `/api/*` routes are open to whoever can reach the port.

---

## Authentication

For a new agent, use **Setup & connections → Connect your own agent** to create a separate named key with selected scopes and expiry. See [Agent connections](AGENT-CONNECTIONS.md) for production tools, pricing reads and permission boundaries. The legacy shared key below remains supported.

Every request carries a Bearer key:

```bash
curl https://shop.example.com/api/v1/me \
  -H "Authorization: Bearer psc_live_xxxxxxxxxxxxxxxxxxxx"
```

Get a key in the app under **Developers → API key**. The key is shown **once** on creation —
store it immediately. Rotating issues a new key and invalidates the old one at once.

Keys are scoped to one shop. A key can only ever read or write that shop's data.

Missing or invalid key → `401`:

```json
{ "error": "Provide your API key: Authorization: Bearer psc_live_…  (Settings → Developers)",
  "code": "invalid_api_key" }
```

## Rate limit

**120 requests per minute per shop**, sliding window. Over the limit you get a `429` carrying
`X-RateLimit-Limit` (the header is sent on the rejection, not on every successful response):

```json
{ "error": "Rate limit exceeded (120 requests/min). Retry in 34s.", "code": "rate_limited" }
```

## Conventions

- All requests and responses are JSON. Send `Content-Type: application/json` on writes.
- **Money is a number in dollars** (`684`, `737.01`) — not cents.
- Timestamps are UTC, `YYYY-MM-DD HH:MM:SS`. Dates are `YYYY-MM-DD`.
- List endpoints take `?limit=` (default 25, max 100) and `?offset=`, and return:

  ```json
  { "data": [ ... ], "has_more": true }
  ```

- Errors return an appropriate status and `{ "error": "...", "code": "..." }`. `code` is stable;
  `error` is human-readable and may be reworded.

### Safe retries for creation

For `POST /api/v1/customers` and `POST /api/v1/estimates`, send `Idempotency-Key` with a unique value per intended creation (8–128 letters, digits, dots, colons, underscores or hyphens; a UUID works). Persist that value before sending. After a timeout, retry the same body with the same key and credential. A successful retry returns the original 201 response with `Idempotency-Replayed: true`; the first response uses `false`.

Reusing a key with a different body returns 409 `idempotency_conflict`. Object field order is ignored; array order and value types are significant. Validation failures are rolled back and do not consume the key. Customer creation, estimate creation, pipeline records and the successful response receipt commit together. Rejected estimates leave no newly created inline customer, even without this header.

Receipts are scoped to the shop, authenticated credential (or signed-in member), and endpoint. They persist across restarts with no automatic expiry. Rotating credentials starts a new namespace: reconcile existing records before retrying with a replacement key. Replays return the original response snapshot, even if the record has since changed or been deleted; GET the record for current state. Requests without the header retain ordinary creation behavior and have no retry protection. A database restore restores only the receipts and records contained in that backup.

Replays do not repeat customer-created hooks. Those hooks run after commit and are not an exactly-once delivery guarantee: a process crash between commit and dispatch can omit an automation. The header does not add retry protection to other endpoints. Workflow writes continue to use revision conflicts.

### Errors are refusals, not guesses

Writes **reject** bad input rather than coercing it. An integration cannot see a silently-defaulted
value — it would just get a `201` and a wrong dollar figure on a document a customer signs. So an
unknown size, a fractional quantity, or a missing `unit_price` is a `400`, every time.

---

## Endpoints

### `GET /api/v1/me`

Confirms the key and identifies the shop. Good for a connection test.

```json
{ "shop": "Rebel Ink Press", "plan": "trial", "rate_limit": "120/min", "docs": "/docs-api.html" }
```

`plan` reflects this shop's billing state and has no effect on what the API can do — there is one
product and every shop has all of it.

### Customers

| | |
|---|---|
| `GET /api/v1/customers` | List. `?query=` searches name, email, and company. |
| `GET /api/v1/customers/:id` | One customer, plus `recent_jobs` and `recent_invoices` (20 each). |
| `POST /api/v1/customers` | Create. |

```json
{ "id": 7, "name": "Jamie Rivera", "email": "jamie@example.edu", "phone": "(555) 555-0142",
  "company": "Lakeside High School", "tags": "school,repeat", "created_at": "2026-08-23 16:42:05" }
```

### Estimates

| | |
|---|---|
| `GET /api/v1/estimates` | List. `?status=draft\|sent\|approved\|declined`. |
| `GET /api/v1/estimates/:id` | One estimate with its line items. |
| `POST /api/v1/estimates` | Create. |

**Create** resolves the customer by `customer_id`, or by `customer{}` — which matches an existing
contact on email and creates one if there is no match.

```bash
curl -X POST https://shop.example.com/api/v1/estimates \
  -H "Authorization: Bearer psc_live_xxxx" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: quote-20260904-001" \
  -d '{
    "customer": { "name": "Jamie Rivera", "email": "jamie@example.edu", "company": "Lakeside High School" },
    "items": [
      { "description": "72 tees, 2-color front", "sizes": { "S": 12, "M": 24, "L": 24, "XL": 12 },
        "unit_price": 9.50, "decoration": "Screen print" }
    ]
  }'
```

```json
{ "id": 41, "number": "EST-1041", "customer_id": 7, "status": "draft",
  "items": [ … ], "subtotal": 684, "tax": 53.01, "total": 737.01,
  "sent_at": null, "approved_at": null, "created_at": "2026-08-23 16:42:05" }
```

**Line item rules**

| Field | |
|---|---|
| `description` | Optional, truncated to 200 characters. |
| `sizes` | Object of size → whole count, e.g. `{"M":24,"2XL":6}`. At least one must be > 0. Unknown size keys are rejected — allowed: `YXS YS YM YL YXL XS S M L XL 2XL 3XL 4XL 5XL 6XL LT XLT 2XLT 3XLT 4XLT OSFA`. |
| `quantity` / `qty` | Use *instead of* `sizes` when sizes don't matter. Must be > 0. Recorded as an `M` count. |
| `unit_price` | **Required.** Price per piece, in dollars. Pass `0` explicitly for a no-charge line — omitting the field is a `400`, not a free line. |
| `decoration` | Optional label, e.g. `"Screen print"`, `"Embroidery"`. |
| `taxable` | Optional, defaults `true`. Set `false` for setup fees or labor where your state exempts them. |

Extended sizes (2XL and up) add your configured per-size upcharge on top of `unit_price`
automatically, so `subtotal` is usually more than `quantity × unit_price`. Tax comes from the shop's
rate, or is zero when the customer is flagged tax-exempt.

Limit of 50 line items per estimate.

### Jobs

| | |
|---|---|
| `GET /api/v1/jobs` | List. `?stage=` filters to a production stage. |
| `GET /api/v1/jobs/:id` | One job. |
| `POST /api/v1/jobs/:id/stage` | Move a job. Body: `{"stage":"production"}`. |

```json
{ "id": 12, "number": "JOB-1012", "customer_id": 7, "estimate_id": 41, "invoice_id": 33,
  "title": "300 tees — spirit shirt", "status": "active", "stage": "production",
  "decoration": "Screen print", "sizes": { "M": 120, "L": 120, "XL": 60 },
  "due_date": "2026-09-04", "rush": false, "created_at": "2026-08-23 16:42:05" }
```

Stages, in order: `new`, `art_approval`, `prepress`, `production`, `qc`, `shipping`, `complete`.

### Invoices and payments

| | |
|---|---|
| `GET /api/v1/invoices` | List. `?status=unpaid\|partial\|paid\|overdue\|void`. |
| `GET /api/v1/invoices/:id` | One invoice. |
| `GET /api/v1/payments` | Payments across invoices. `?invoice_id=` narrows it. |

```json
{ "id": 33, "number": "INV-1033", "customer_id": 7, "estimate_id": 41, "status": "partial",
  "amount_due": 737.01, "amount_paid": 368.51, "balance": 368.50,
  "due_date": "2026-09-14", "paid_at": null, "created_at": "2026-08-23 16:42:05" }
```

Invoice `status` is derived — you cannot set it directly, and it corrects itself if a payment is
removed. It is a function of the recorded payments **and the calendar**, and it has five values:

| | |
|---|---|
| `unpaid` | Nothing recorded against it yet. |
| `partial` | Part paid, and not yet past `due_date`. |
| `overdue` | Unpaid or part paid, and past `due_date`. Outranks `partial`. |
| `paid` | Settled. Outranks everything. |
| `void` | Cancelled. Not a demand for money, whatever its dates say. |

**`overdue` is the one that catches integrations out.** An invoice with money outstanding reports
`overdue` the day after `due_date`, so it appears under *none* of `unpaid`, `partial` or `paid` —
poll those three and you will not see the shop's late money. To sweep everything owed, ask for
`unpaid`, `partial` and `overdue`, or list without a `?status=` and filter on `balance > 0`.

---

## Webhooks

Register endpoints under **Developers → Webhooks**, or through the API:

| | |
|---|---|
| `GET /api/v1/webhooks` | List your subscriptions. |
| `POST /api/v1/webhooks` | Create: `{"url":"https://…","events":["invoice.paid"],"secret":"whsec_…"}`. `secret` is what deliveries are signed with — send your own (24 characters or more) or omit it and one is generated. Either way it is returned **once**, in this response. |
| `DELETE /api/v1/webhooks/:id` | Remove one. |

Webhook management requires a key belonging to an **owner or manager**.

### Events

`contact.created` · `estimate.sent` · `estimate.approved` · `invoice.paid` · `job.stage` ·
`art.sent` · `art.approved` · `art.rejected` · `opportunity.won` · `opportunity.lost` ·
`conversation.received`

### Verifying the signature

Every delivery carries `X-PSC-Signature`:

```
X-PSC-Signature: t=1756049325,v1=5f2c…64-hex-chars
```

The signature is `HMAC-SHA256(secret, "{t}.{raw_request_body}")`. Verify against the **raw** body
before parsing it, and reject anything older than five minutes:

```js
import crypto from 'node:crypto'

function verify(secret, rawBody, header, toleranceSec = 300) {
  const m = /t=(\d+),v1=([0-9a-f]{64})/.exec(header || '')
  if (!m) return false
  const t = Number(m[1])
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > toleranceSec) return false   // replay window
  const expect = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
  return crypto.timingSafeEqual(Buffer.from(m[2], 'hex'), Buffer.from(expect, 'hex'))
}
```

Use a constant-time comparison, as above — a plain `===` leaks the signature a byte at a time.

### Delivery behaviour

- Respond `2xx` within 10 seconds. Anything else counts as a failure.
- Failures are retried with backoff; the last 25 attempts and their errors are visible under
  Developers.
- **Redirects are never followed**, and the target must resolve to a public address — private,
  loopback, link-local, carrier-NAT, and cloud-metadata ranges are refused, which also blocks DNS
  rebinding. A webhook pointed at `localhost` or `169.254.169.254` is rejected at registration.
- Delivery is at-least-once. Make your handler idempotent — key on the event id.

---

## Price matrices

Not part of `/api/v1` — these are session-authenticated app routes under `/api/matrices`, used by
the Pricing screen and the quote editor. They are documented because the shape is the whole point of
the feature and integrators ask for it.

A matrix is a named grid with free-text headings and no built-in meaning. See
[Price matrices](../README.md#price-matrices) for the concept.

```json
{
  "id": 3,
  "name": "Mug Printing",
  "description": "All-in per-piece pricing.",
  "rowLabel": "Quantity",
  "colLabel": "Mug size",
  "unit": "piece",
  "isDefault": true,
  "rows": ["1-11", "12-23", "24+"],
  "cols": ["11 oz", "15 oz", "20 oz tumbler"],
  "cells": [[18, 20, 26], [13, 14.5, 20], [11.5, 13, 18]]
}
```

`cells` is dense and positional: `cells[rowIndex][colIndex]`, `null` for "no price set". It is
always exactly `rows.length × cols.length` — send a grid the wrong size and the server squares it up
rather than rejecting it, keeping every value that still has a home.

`unit` is `"piece"` (multiply by quantity) or `"flat"` (the whole line charge, quantity ignored).

| | |
|---|---|
| `GET /api/matrices` | Every matrix as a summary, plus the starter templates and the field limits. |
| `GET /api/matrices/:id` | One matrix, with every cell. |
| `POST /api/matrices` | Create. Send a full matrix, or `{"template": "dtf"}` to seed from a starter. Manager+. |
| `PUT /api/matrices/:id` | Save. Omitted fields keep their current value. Manager+. |
| `POST /api/matrices/:id/duplicate` | Copy, named `"<name> (copy)"` unless you pass `name`. Manager+. |
| `POST /api/matrices/:id/default` | Pre-select it on new quotes. Exactly one matrix is the default. Manager+. |
| `DELETE /api/matrices/:id` | Delete. If it was the default, the oldest remaining matrix takes over. Manager+. |
| `POST /api/matrices/import` | Read a CSV upload or a pasted grid (`text`). Pass `replace: <id>` to overwrite an existing matrix, or `name` to create a new one. Manager+. |
| `GET /api/matrices/:id/price` | Look one price up. |

Template keys: `screen-print`, `dtf`, `embroidery`, `heat-press`, `drinkware`, `patches`, `laser`,
`blank`.

### Looking a price up

```bash
curl "https://shop.example.com/api/matrices/3/price?col=11%20oz&qty=30" -b cookies.txt
```

`row` and `col` each accept **an index or the heading text** (case-insensitive). Omit `row` and pass
`qty`, and a matrix whose row headings read as quantity bands picks its own row:

```json
{
  "matrix": { "id": 3, "name": "Mug Printing", "unit": "piece", "rowLabel": "Quantity", "colLabel": "Mug size" },
  "suggestedRow": 2,
  "price": 11.5,
  "rowIndex": 2, "colIndex": 0,
  "row": "24+", "col": "11 oz",
  "unit": "piece",
  "amount": 345
}
```

An empty cell returns `200` with `"price": null`. That is a real answer — *we don't price that
combination* — not an error, and callers must not treat it as zero.

### Provenance on an estimate

A line priced from a matrix carries an optional `matrix` object alongside the usual fields:

```json
{ "description": "Team mugs", "qty": 30, "unit_price": 11.5,
  "matrix": { "id": 3, "name": "Mug Printing", "row": "24+", "col": "11 oz" } }
```

It records where the number came from, nothing more — the money is computed from `unit_price`
exactly as it is for every other line, and the field never appears on a customer-facing document.
Different lines on one estimate may cite different matrices.

---

## Embed API

Two unauthenticated endpoints back the embeddable gang-sheet builder. They resolve the shop by its
public `embed_key`, never by an API key, so the snippet is safe to paste into a public web page:

| | |
|---|---|
| `GET /api/embed/config?shop=<embed_key>` | Branding, pricing, and checkout mode. Never returns a secret key. |
| `POST /api/embed/gangsheet/order` | Re-nests server-side, creates the contact and estimate, and starts checkout. |

The order endpoint re-computes the layout and price on the server, so a tampered client cannot
change what a customer is charged.

---

## Exports

Not part of `/api/v1`, but worth knowing: `GET /api/export/<table>.csv` covers `contacts`,
`estimates`, `invoices`, `payments`, `jobs`, `activities`, `art_versions` and `line_items` — the
last being every line of every document flattened, with size breakdowns, which nobody else gives
you. The whole database, every table, exports as one JSON file from Settings. There is no export
fee and no support ticket. Each shop's database is a plain SQLite file you can copy (a
multi-tenant install has one per shop, plus the registry — see INSTALL.md).
