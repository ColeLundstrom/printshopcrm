# Shipping and collection records

Sales → Orders and a job’s department view use one shipment ledger. Add each parcel, customer pickup or local delivery separately. Choose a production job when an order has several. A reference is a record entered by staff; it is not carrier acceptance or delivery confirmation. Enter the optional dispatch/collection date only when that event has occurred.

Saving tracking does not move a Sales card, complete production tasks, satisfy an artwork hold, settle an invoice or send a customer message. The Sales stage has its own Save stage action. Department staff record shipments through their available shipping task; its assignment and live requirements are checked again when saving. Managers can record and correct shipment history. These controls work without AI or a carrier account.

Managers use **Correct record** to replace a mistaken reference or mark it void, with a reason. Previous values, actor and timestamps stay in history. A dispatch address is saved when dispatch is first recorded and does not change when the job’s destination later changes. A subsequent destination change may need a replacement shipment record; editing the customer’s defaults does not reroute an old parcel. Orders/jobs/customers with shipment evidence cannot be deleted or moved to another customer through ordinary quote editing, including after a record is voided.

Old Orders tracking and old department shipments are imported separately. The same tracking text may describe one parcel twice; legacy entries are labeled for review rather than silently merged or counted as verified parcels. An unknown original date stays unknown. The old tables remain in full exports for compatibility; use the new **Shipments** and **Shipment events** CSV exports for the unified records.

The browser keeps unsent shipment drafts and uncertain-save retries with their order/job for the current signed-in session. A failed connection offers **Retry same save**, retaining the original request. A revision conflict keeps the draft and asks for a refresh before resubmission. Reloading the browser can lose an unsent draft; saved records and server receipts are durable.

## Internal API and retries

- `GET /api/orders/:id/shipments` returns the canonical `records`, history and available job `scopes`.
- `GET /api/production/jobs/:id` includes the same `shipping` structure alongside the job workflow.
- `POST /api/orders/:id/shipments` and `POST /api/production/jobs/:id/shipments` record one intended shipment.
- Manager-only `POST /api/shipping/:id/correct` and `/void` retain the original entry in history.

A new write includes `request_id` (8–128 letters, digits, dots, colons, underscores or hyphens), `shipping_revision`, and the linked job’s `production_revision`. Orders writes must explicitly select `job_id` when a job exists. Fields are `kind` (`parcel`, `pickup`, `local_delivery`), `carrier` (60 characters), `tracking_number` (100), `note` (1000), and optional `dispatched_on` (a real `YYYY-MM-DD` date). Corrections also include `record_revision` and a reason up to 500 characters. Text rejects control characters.

Persist the intended request before posting it. After a lost response, retry the exact body with the same signed-in actor and request ID. It returns the original mutation receipt, marked `replayed`, with current records on the read-capable response; it does not create another event or repeat a task/stage change. A different body with the same ID returns `409 idempotency_conflict`. New writes with old revisions return `409`. Receipts are scoped to the shop and actor and survive restart. They are not a universal ban on a person intentionally recording two identical parcels with separate request IDs.

The older Floor request without `request_id` retains its production `revision` check and exact-duplicate no-op, without the newer replay guarantee. Legacy `PUT /api/orders/:id/tracking` affects only its own legacy record, never extra parcels; changed values require choosing the normal shipment flow when production jobs exist. Managers correct legacy records. Identical old-field writes do nothing, including after a manual stage change.

Carrier tracking webhooks and automatic delivery notifications are not implemented. Labels can be bought here on the shop’s own EasyPost account — see **Shipping labels** below. The starter packing notification describes entering the shipping department; existing custom automation wording is preserved and should be reviewed by its owner.

## Shipping labels

Optional. A shop connects its **own** EasyPost account under Setup & connections → Shipping labels (an API key, the ship-from address, a usual box, and whether staff may buy). Labels are bought at the shop’s own carrier rates; PrintShopCRM adds nothing and is never the merchant. Start with EasyPost’s test key: it makes sample labels and cannot spend money.

On a job’s department view, under **Outgoing shipments / collection**:

1. **Create a shipping label.** The ship-to fields are prefilled by reading the job’s typed address; a person confirms or corrects them. Add one row per box (weight; dimensions optional). One box is one label.
2. **Get rates.** Each box lists carrier, service, days and price, with the cheapest and the fastest marked.
3. **Buy label…** asks once more, stating the price and that it charges the shop’s label account. The label image is downloaded and kept with the shop’s files; **Print label** opens a 4 × 6 page.
4. The carrier and tracking number are written to the same shipment ledger described above, as a parcel record with no dispatch date. Like any shipment record, this does not move the job, complete a task or message the customer.
5. **Email tracking to customer** is a separate button and sends once. **Void label** (managers) asks the carrier for a refund and, when the carrier accepts the request, voids the ledger record the label wrote, keeping its history.

**One purchase per label.** Buying claims the box before any request is sent. If the answer is lost, the box shows *Purchase not confirmed* with **Check purchase**, which asks EasyPost whether that shipment was bought and finishes from the answer; it never buys. Pressing Buy twice, or retrying after a timeout, cannot buy a second label for the same box.

**Test labels** are marked TEST on screen and across the printed label, are not written to the shipment ledger, and cannot be emailed to a customer.

**Who can buy.** Whoever may record a shipment on that job: managers always; staff only on a shipping task assigned to them (or unassigned) and only when the shop has switched *Staff can buy labels* on. Setup, voiding and disconnecting are manager-only.

**Tracking** is read from EasyPost when the job is opened (at most every 30 minutes per label) and with **Refresh tracking**. There are no inbound carrier webhooks, and the customer portal does not show shipment status.

Not included: customs forms and international paperwork, insurance, pickups, return labels, batch buying, thermal ZPL output, and labels for orders that have no production job.

### Label API

All routes need a signed-in member; every label belongs to the shop whose database it is in.

- `GET/PUT /api/shipping/labels/setup` — connection state (never the key) / save key, `ship_from`, `parcel_default`, `staff_can_buy` (manager).
- `POST /api/shipping/labels/setup/test`, `/disconnect` (manager).
- `GET /api/production/jobs/:id/labels` — setup, parsed `ship_to`, `can_buy`, and the job’s labels.
- `POST /api/production/jobs/:id/labels/rates` — `{ request_id, to, boxes[] }`. The same `request_id` returns the same rows.
- `POST /api/shipping/labels/:id/buy` — `{ rate_id, confirm_price_cents }`; the price must equal the stored rate.
- `POST /api/shipping/labels/:id/check | track | discard | notify`, and manager-only `/void` with `{ reason }`.
- `GET /api/shipping/labels/:id/file` (PNG) and `/print` (HTML). Label files are not served from `/uploads`.

The API key is stored with the shop’s other secrets and is never returned to a browser. The server talks only to `api.easypost.com` and downloads label images only from EasyPost’s file hosts.
