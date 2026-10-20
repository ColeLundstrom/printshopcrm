# 1.37.0 — Shop TV, customer portal, profit meter, and an audit pass

Base: published v1.36.3 (`1c01878`). Built from a full audit of the running product — money paths,
job lifecycle, tenant isolation and authentication, every GET route on an empty and a seeded shop,
and the frontend — followed by the fixes and the features below. No new runtime dependency, no
licence change; AGPL source links and third-party notices are unchanged.

## New

- **Shop TV** (`#/tv`): a full-screen live wallboard for the screen over the presses — pieces on
  the floor, due today, late, proofs out, on-track share, shipped this week, every active job by
  stage, and a ticker of recent moves. Repaints on the realtime board/production events and glows a
  card that changed columns. Revenue appears only for managers; `?money=0` hides it on a screen
  customers can see. Carries the AGPL source link, since it hides the sidebar.
- **Profit meter** on every quote: a gauge of estimated margin against the shop's target, profit /
  cost / revenue / profit per press-hour, and the walk-away price that hits the target. One click
  raises the garment prices to it, with undo. A garment with no known blank cost is named, instead
  of being costed as free.
- **Shop pulse** on Today (managers): twelve Monday-based weeks of won vs collected, collected over
  the last four weeks against the four before, 90-day quote win rate, and margin kept on finished
  jobs.
- **Customer portal**: one tenant-scoped link per customer listing their sent quotes, proofs
  awaiting a decision, invoices with a Pay button when payable, and jobs in production with a stage
  stepper. See [CUSTOMER-PORTAL.md](CUSTOMER-PORTAL.md).
- **Scan-to-pay QR** on invoice PDFs with a balance (vector, no image embedding) and on the online
  pay page; a job QR on the work ticket.
- **Printavo and YoPrint customer-export presets** in the CSV import, auto-detected from the header
  row and fully editable. Header names are matched by aliases, not claimed exact.
- **Shop time zone** (Settings → Shop, prefilled from the owner's browser). See
  [TIMEZONE.md](TIMEZONE.md).
- `npm run showcase`: reseeds the demo shop and adds a quarter of fictional history for demos.

## Fixed — money

- Zero-decimal currencies (JPY…) could never be fully paid: totals, deposits and payment guards now
  round to the currency's minor unit. USD output is byte-identical.
- `invoice.paid` and the order card's move to Paid never happened for an invoice settled under a
  payment review; now announced exactly once when the review clears.
- Client-supplied `size_upcharges` could zero or slash a quote; size keys differing by case
  overwrote each other; `taxable: "false"` was taxed; flat quantities were uncapped.
- Numeric matrix headers were read as column indexes.
- A $0 invoice from convert was stored unpaid and chased as overdue.
- CSV order import booked cancelled, refunded and unpaid orders as paid revenue, applied today's
  size upcharges to history, and accepted absurd quantities. Contact import stored multi-address
  emails.
- Deleting a payment already in QuickBooks, and voided invoices, no longer leave QBO disagreeing.
- A deliberate tax override on an exempt buyer survived an unrelated edit only by accident; it is
  now stored. The credit dialog pre-fills the pre-tax remainder.

## Fixed — dates and job lifecycle

- "Today" was the UTC date across the server: after 5pm on the US west coast, invoices due today
  read overdue, net terms landed a day late, ship dates were tomorrow, and the "1 day past due"
  reminder emailed customers on the due date.
- Re-converting a quote whose job was already complete created a second production job.
- Autopilot marked an estimate sent before the email could fail, and full-auto mode returned a 500
  after partial writes.
- Stage moves from the assistant and from workflow tasks skipped automations, the scan timeline and
  the live board; workflow moves into Shipping did not stamp a ship date; "flag rush" never worked
  on workflow jobs.
- Impossible dates (2026-02-30, 2026-13-45) were accepted; wrong-type fields returned 500s; the
  assistant crashed on very long messages and could not match its own example phrasing.

## Fixed — security

- A deleted shop's slug carried its owner's learned public origin to the next shop of that name,
  putting an attacker's domain in that owner's password-reset emails. Origins are keyed by tenant id.
- Shop SMTP settings could be used to probe the server's network; hosts are now vetted and pinned,
  with an operator escape hatch for LAN relays. Operator SMTP credentials never travel to a
  shop-typed host, and shops can no longer choose the From address on the operator's relay.
- Member ids were reused, so a removed employee's Slack link resolved to the next hire. Ids now come
  from a never-decreasing sequence, and removing a member clears their shop-side links.
- Saving onboarding answers is owner-only and size-limited.

## Fixed — interface

- "Request payment" and invoice "Send" said *emailed* with no email connected; payment-credential
  removal never ran; the invoice's "From estimate" link had no number; onboarding showed two
  identical buttons.
- The Job Board fills the window with its scrollbar at the bottom; drag keeps the empty-column
  placeholder right.
- Every route gets a loading skeleton; native `prompt()`/`confirm()` replaced with app dialogs;
  emoji and glyph icons replaced with the sprite set; light-theme tints derived from tokens.
- One fewer serial request on every cold load and two fewer per navigation; stamped assets are
  served immutable, keyed to a content hash of every stamped file.

## Known limits

- A paid website gang-sheet order still leaves its estimate at *sent* and opens no job (it is no
  longer chased as stale).
- Revenue month boundaries compare a shop-local date against UTC payment timestamps, which can be a
  few hours off at month end.
- Import presets have not been checked against real Printavo/YoPrint export files.
