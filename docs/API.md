# PrintShopCRM API

A stable REST API under `/api/v1`, plus signed outbound webhooks.

There is also a live, copy-pasteable version of this at **`/docs-api.html`** on any running install.

> The API requires multi-tenant mode (`PSC_AUTH=1`), because an API key belongs to a shop. On a
> single-shop install the internal `/api/*` routes are open to whoever can reach the port.

---

## Authentication

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
| `sizes` | Object of size → whole count, e.g. `{"M":24,"2XL":6}`. At least one must be > 0. Unknown size keys are rejected — allowed: `YXS YS YM YL XS S M L XL 2XL 3XL 4XL 5XL OSFA`. |
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
| `GET /api/v1/invoices` | List. `?status=unpaid\|partial\|paid`. |
| `GET /api/v1/invoices/:id` | One invoice. |
| `GET /api/v1/payments` | Payments across invoices. `?invoice_id=` narrows it. |

```json
{ "id": 33, "number": "INV-1033", "customer_id": 7, "estimate_id": 41, "status": "partial",
  "amount_due": 737.01, "amount_paid": 368.51, "balance": 368.50,
  "due_date": "2026-09-14", "paid_at": null, "created_at": "2026-08-23 16:42:05" }
```

Invoice `status` is always derived from recorded payments — you cannot set it directly, and it will
correct itself if a payment is removed.

---

## Webhooks

Register endpoints under **Developers → Webhooks**, or through the API:

| | |
|---|---|
| `GET /api/v1/webhooks` | List your subscriptions. |
| `POST /api/v1/webhooks` | Create: `{"url":"https://…","events":["invoice.paid"],"secret":"whsec_…"}` |
| `DELETE /api/v1/webhooks/:id` | Remove one. |

Webhook management requires a key belonging to an **owner or manager**.

### Events

`contact.created` · `estimate.sent` · `estimate.approved` · `invoice.paid` · `job.stage` ·
`art.sent` · `art.approved` · `art.rejected` · `opportunity.won` · `opportunity.lost` ·
`conversation.received` · `separation.saved`

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

Not part of `/api/v1`, but worth knowing: every table exports to CSV — including line items with
size breakdowns — and the whole database exports as one JSON file, from Settings. There is no
export fee and no support ticket. The database itself is a single SQLite file you can copy.
