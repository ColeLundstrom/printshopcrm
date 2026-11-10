# 1.39.0 — Audit release: what was broken, fixed

Base: published v1.38.0 (`f90ef40`). No new runtime dependency and no licence change. One new
column (`estimates.edit_revision`), new indexes and one trigger are added per shop on first open;
no existing data is restated.

Seven independent audits ran against 1.38.0 — security and shop isolation, money correctness,
reliability, data model and starter data, a hands-on walkthrough as a new shop owner, a visual
review in both themes, and a feature comparison against Printavo, YoPrint, shopVOX, DecoNetwork and
others. This release is the confirmed findings, fixed. Each was reproduced before it was changed.

## Fixed: things a customer would have hit

- **Emails about a document carry the link to it.** Estimate, invoice, proof and follow-up emails
  said "viewable at the link below" and contained no link. Every such email now includes it; a
  shop's saved template that has no `{{link}}` gets the link on its own line above the sign-off.
- **An order paid on the website reaches production.** A paid gang-sheet order produced a paid
  invoice and nothing else: the estimate stayed "sent", no job opened, and Convert then refused
  with "Already invoiced". Payment now approves the estimate and opens the job; Convert repairs an
  order left in that state by an earlier version.
- **Single-shop installs can take card payments.** Checkout sent an empty metadata value and every
  payment failed with "Couldn't start checkout".
- **Gang-sheet orders are priced for everything on them.** More than 5,000 transfers was charged
  as 5,000, and a design wider than the roll was accepted at the minimum charge. Both are refused
  with a message that says what to do.
- **The pay page leads with the amount due**, its due date, and the Pay button; phone and email
  are tappable. The deposit offered is the shop's own percentage (Settings), not a fixed 50%.
- **A quote can be questioned, not only approved.** "Question, or need something changed?" lands
  the customer's message in the shop's conversation with them.
- **Quotes read in plain language** on the customer page: "2-color Front + 1-color Back".

## Fixed: money and records

- Two people saving the same quote no longer erase each other's lines; the second save is refused.
- QuickBooks IIF export posts sales tax to Sales Tax Payable, dates in the shop's time zone, takes
  `?from=&to=`, and leaves out history that was itself imported (`?imported=1` includes it).
- Revenue MTD, the assistant and the weekly pulse use the shop's calendar and agree with Reports.
- Profitability subtracts invoice credits and costs a decorated line that has a piece count but no
  size grid (it used to report a 100% margin).
- Timed follow-ups fire again for a re-sent quote, a new proof version or a moved due date.
- Document numbers are never issued twice, even after the newest record is deleted.
- A team store lets go of an estimate that is deleted.

## Fixed: imports from another system

Customer imports keep tax-exempt status, resale number and payment terms. Order imports keep amount
paid, balance, sales tax, PO number, job name and due dates; "Quote Approved" is an order, not an
open quote; "Completed" is not "paid"; a quantity with no size columns is no longer stored as size
M; snake_case headings map; a file with no recognisable columns is refused instead of creating $0
records. See `docs/MIGRATION.md`.

**Behaviour change for API callers:** in lenient mode, an order whose status says complete,
shipped or partial and which carries no amount-paid or balance column now returns
`import_status_review` rather than being guessed paid or unpaid.

## Security

No cross-shop data access was found. Fixed:

- State-changing requests on a signed-in session are refused when the browser says they came from
  another origin (`cross_site_request`); the realtime socket checks `Origin`.
- Payment-processor keys, provider and disconnect are owner-only (`owner_only_payments`).
- Shop, owner and member names are one line of text, so platform mail cannot carry a caller's
  paragraphs. Sign-in takes the same time for unknown addresses and has a per-connection ceiling.
- The outbound-mail cap is per shop, not per member. Support sign-in sessions last two hours.
  Outstanding reset links die with a password change.
- Public gang-sheet orders validate name and email; the chat widget accent must be a hex colour;
  a size name in Settings cannot carry markup.

## Easier to use

- **Home leads with "Needs you today"**, now including "customer approved — bill it" and "job done
  — still to collect".
- Estimates and invoices lists: search, sortable columns, 50 at a time.
- One primary button per screen; the rest under More. Sentence-case labels and US spelling.
- Guided estimate: "sizes to come" is stored as a piece count, not a fake size; optional stitch
  count and print size; the button says up front when it will copy a link rather than send email.
- The full editor has a labelled **Price this line** button.
- Job detail asks before moving an unproofed job to production or completing an unpaid one.
- Settings has a sticky save bar; New customer shows four fields with the rest under More details.
- Customer-facing **starter automations ship switched off** for new shops. Existing shops are
  unchanged.
- Visual pass in both themes: list tables align, phone cards fit the screen, text meets WCAG AA on
  customer pages, 11px type floor, stronger focus ring, white inputs in light theme.

## Under the hood

- Opening a shop database takes the write lock up front, so a second process cannot fail it.
- A webhook delivery is no longer sent twice when the retry tick lands during the first attempt.
- Indexes for open-invoice and event queries; report facts memoized; the insights sweep cached for
  a minute; idempotency receipts and supplier lookups pruned daily.
- Catalog: 33 more blanks (long sleeves, youth and ladies cuts, jackets, dad hats), two corrected
  rows. New shops get upcharges for 6XL and tall sizes and a standard-turnaround setting.

## Known limits

- The stock price book has no quantity break for 1–2 colour screen print above 12 pieces. Changing
  it changes quotes for every shop on the stock book, so it is not changed here.
- Team stores still take no online payment; QuickBooks Online has no connect screen; no shipping
  labels; supplier connections are lookup-only. These are the largest gaps against competitors.
- Signup does not yet confirm the email address before creating the shop.
- Session tokens are stored unhashed in the control database.
- List endpoints (`/api/estimates`, `/api/contacts`, `/api/invoices`) are still unpaginated on the
  server; the lists page on the client.
- The Printavo, YoPrint and shopVOX import mappings were tested against reconstructed samples, not
  files exported from those products.
