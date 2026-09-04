# Connect an existing agent

PrintShopCRM works without AI. This optional connection lets an agent that already runs in Slack or another app use selected shop API operations. It does not install that runtime, supply model credentials, or verify its Slack user permissions.

Open **Setup & connections → Connect your own agent**. Name the connection, select permissions, and choose an expiry of 1–365 days (90 by default). Copy the generated key into the agent’s secret storage. It appears once; only its SHA-256 hash is stored. The key belongs to the manager who created it. Suspension, disabling the member or demoting them below manager prevents use. Revocation is permanent; disabling/demoting an account is checked dynamically and access can return if it is restored before expiry.

Each connection has its own key and permissions. Replacing one does not rotate the legacy shared shop key or another agent’s connection. To rotate safely: create a replacement, configure and test the agent, then revoke the old connection. The screen lists expiry and last use. Up to 50 unrevoked, unexpired keys may exist in a shop.

## Request contract

Use `Authorization: Bearer YOUR_AGENT_KEY` with the shop’s public HTTPS `/api/v1` base URL. `GET /me` returns the connection’s granted scopes and expiry. All keys share the existing per-shop limit of 120 requests/minute. A browser cookie cannot increase an agent key’s permissions or change its shop. Agent keys cannot use internal `/api/*` endpoints, edit settings, issue keys, or read/manage webhook signing secrets.

| Permission | Operations |
|---|---|
| `pricing:read` | GET `/pricing`, `/matrices/:id`, `/matrices/:id/price` |
| `customers:read` | GET `/customers` and `/customers/:id` |
| `customers:write` | POST `/customers` |
| `estimates:read` | GET `/estimates` and `/estimates/:id` |
| `estimates:write` | POST `/estimates` (draft) |
| `invoices:read` | GET `/invoices` and `/invoices/:id` |
| `payments:read` | GET `/payments` |
| `jobs:read` | GET `/jobs` and `/jobs/:id` |
| `jobs:stage` | POST `/jobs/:id/stage` |
| `production:read` | GET `/production/queue`, `/jobs/:id/workflow` |
| `production:write` | Complete tasks, assign pending tasks, set job timing through the endpoints below |

Permissions are independent. Draft creation with an inline new customer also needs `customers:write`; otherwise provide an existing `customer_id`. `/pricing` supplies the same resolved price book, custom-matrix summaries and selected pricing defaults used by the shop. Fetch a custom matrix to inspect every cell. A matrix price lookup with no matching price returns `price:null`, not a free price. These are pricing data tools, not a complete conversational quoting agent or guaranteed live blank-cost lookup.

## Production tools

Use numeric record IDs returned by the API. Fetch `/jobs/:id/workflow` first to obtain task IDs and the current `revision`.

- POST `/jobs/:id/tasks/:taskId/action`: `{"revision":3,"action":"complete"}`. Existing task order, receiving, artwork and payment holds still apply. Skip/reopen corrections remain in the web UI.
- PUT `/jobs/:id/tasks/:taskId/assignment`: `{"revision":3,"assigned_id":7}`. Use `null` to unassign. Only pending tasks can be edited.
- PUT `/jobs/:id/timing`: `{"revision":3,"timing":{"enabled":true,"production_date":"2026-10-15"},"reason":"Shipping delay"}`. Optional turnaround/task scheduling remains governed by the shared timing engine.
- GET `/production/queue?department=QC&page=1`: department tasks, totals and pagination. `mine=1` uses the manager account associated with this connection.

On HTTP 409, reload the workflow and review the changed state before proposing another action. Do not blindly repeat a timed-out draft-creation request: the generic customer/estimate API does not yet provide idempotency keys. The built-in Slack assistant has separate delivery receipts and confirmation handling.

API writes happen immediately. The external agent must implement its own review/approval policy. Customer creation and stage changes can trigger configured shop automations. This is different from the built-in Slack draft path, which suppresses new-customer automation. Agent keys do not authorize direct card charges, customer-message sending, artwork approval, credential access or webhook administration.

## Audit and verification

Recent requests show method, route, response status and timestamp per connection. The latest 1,000 requests are retained per key; the screen shows 50. Bodies, query strings and keys are not logged. Unrecognized paths are replaced by a fixed label. Production events identify the agent name. Audit writes and business writes are separate: this is operational traceability, not a tamper-evident financial audit ledger.

Fixture and HTTP tests cover hash-only storage, expiration, independent revocation, current member/shop status, neighboring shops, cookie precedence, denied resources, protected inline customer creation, pricing access, production holds, stale revisions and request audit. Migration rehearsal uses private database copies. A real external agent/Slack/model installation still needs acceptance with the shop’s own configuration.
