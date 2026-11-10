# Connect your shop

Open **Setup & connections** from the sidebar. Every core workflow works without an AI model or model API key. Staff can work from Today; owners and managers connect services.

## Email on your domain

Use the email wizard to choose Google Workspace or enter your mailbox provider’s SMTP settings. Enter an authorized From address and supported SMTP/app password. Google presets fill the server, port and TLS settings; other providers use the advanced server section. Save and send a test to your own shop or sign-in email. Saving credentials alone does not verify delivery.

Follow your email provider’s SPF, DKIM and DMARC instructions. Do not guess DNS values or replace existing mail routing. Some providers or account policies disable password-based SMTP; those need a supported SMTP service or a future OAuth mailbox connector. Outgoing SMTP is implemented. Replies reach the existing mailbox; automatic mailbox synchronization into Conversations is still a roadmap item.

Google’s current guidance: https://support.google.com/a/answer/176600

On a hosted, multi-shop server the SMTP server must be a public mail host: a server name or address that points at a private, loopback or link-local network is refused when you save it and again on every connection. Self-hosters running a single shop can use a relay on their own network without any change; the operator of a multi-shop server whose relay lives on the LAN can allow it with `PSC_SMTP_ALLOW_PRIVATE=1`. When a shop has not finished its own SMTP and mail goes through the server-wide relay, it is sent from the operator’s address with the shop’s address as Reply-To. Connection and sign-in failures are reported in plain words (with a code such as `ECONNECTION` or `EAUTH`), never by repeating the remote server’s reply.

## Twilio SMS

Save your own Account SID, Auth Token and SMS-capable number (or Messaging Service SID). Test outgoing SMS to your shop phone. Under Setup → Receive texts, copy the exact incoming URL. In Twilio’s number configuration choose **A message comes in → Webhook → HTTP POST**, paste it, and save. For a Messaging Service, use its inbound handling configuration and the correct service SID. Complete Twilio’s applicable account/number registration.

A public HTTPS deployment is required for real callbacks. Set `PSC_PUBLIC_URL` to its canonical origin. Incoming callbacks use the shop’s credentials, verify all form fields with `X-Twilio-Signature`, require matching account and destination, and atomically record the MessageSid receipt with the inbox message. Retries are idempotent across restarts. Suspended shops are rejected. Billing expiry does not discard a customer’s incoming text.

Known senders match a normalized phone. New or ambiguous numbers produce a contact to review. SMS bodies go into Conversations as unread messages. MMS attachment counts are identified; attachments are not fetched. No model, reply, or marketing automation is invoked.

Twilio protocol references: https://www.twilio.com/docs/messaging/guides/webhook-request and https://www.twilio.com/docs/usage/security

## Optional Slack and agents

The built-in Slack connection creates quote drafts. An opt-in [Slack shop assistant](SLACK-SHOP-ASSISTANT.md) adds linked staff identities, department/job tools and Review/Auto actions. Copy its app manifest from Settings → Slack, install it in your workspace, save its bot token and signing secret, and run the connection test. See https://docs.slack.dev/app-manifests/ . The synthetic callback test verifies reachability with the stored secret; only a real Slack event verifies that the stored secret actually matches Slack’s copy.

An existing external agent can use the shop REST API while keeping its own Slack/model runtime. Setup provides the base URL, request headers, connection test and documentation. A new agent key is read-only. Owners/managers can enable read-and-write access explicitly. This is a shop-wide policy for its single API key, including any other integrations sharing it. Existing keys retain their previous access for compatibility. Revoking or rotating a key invalidates it. For new integrations, use the separate named keys under Setup → Connect your own agent. They add selected scopes, expiry, per-key audit and individual revocation; see [Agent connections](AGENT-CONNECTIONS.md). OAuth installation remains future work.

Keep the PrintShopCRM key in the agent runtime’s secret storage. It is not a model-provider key. Test with GET /api/v1/me. Read-only keys cannot invoke mutations, even when a valid owner browser cookie accompanies the request. External agents must implement their own workspace/user permissions and approval policy. This connector does not install or host an external agent.

Use **Work manually** to turn off model selection and require human review in assisted workflows. Independently configured automation rules remain separately controlled in Automations.

## Payments

Use **Setup & connections → Set up payments** for Stripe or Authorize.net, or leave online payments off and record payments manually. Follow [Payment connections](PAYMENTS.md) for credentials, signed callbacks, test-mode verification and reconciliation limits. Existing Stripe users need the new callback signing secret before new checkouts can start.

## Suppliers: live stock and blank costs

Settings → Wholesale Suppliers takes your own S&S Activewear account number and API key, and/or your
SanMar or alphabroder PromoStandards login. Credentials are stored per shop and never shared.

Once one is connected, a quote line that names a style number shows the distributor's stock under
each size box, in both the estimate editor and the guided estimate:

- **Which colour.** The line's own wording decides: `Gildan 5000 Tee — Black — 2/0 Front`. Text in
  brackets that mentions ink is the ink, not the shirt. With no colour on the line, stock is not
  shown and the line lists a few colours the distributor carries.
- **What the numbers mean.** A plain number is on hand; `low: 18` is under two dozen; `out` is
  none; `only 18` in red means the quote asks for more than the distributor has.
- **How fresh.** The line says "as of" when the distributor answered. Answers are reused for ten
  minutes per style (every colour of a style is one lookup); **Refresh** asks again. Each shop may
  make 20 distributor lookups a minute.
- **When it cannot be shown.** Not connected, style not found, or the distributor not answering
  each read as one quiet line. Stock never blocks typing, pricing or saving a quote.

When stock resolves, the quote line also keeps the distributor's exact SKU for each size being
ordered. Those SKUs follow the line to the job and appear on its purchase order, so the PO names
the precise blanks instead of a style-level code. If the line's wording changes, the SKUs are
dropped and resolved again. **The software still does not place the order**: download the PO, enter
those SKUs in the supplier's portal, and record the supplier's confirmation on the job.

PromoStandards inventory (SanMar, alphabroder) carries no price, so those lines show stock and SKU
only. S&S returns your negotiated price as well.

### Your own blank catalog

Products → Blank catalog lists every blank the app knows a cost for. A manager can **Add a blank**
(brand, style number, what you pay) or **Edit** any row. Each row is labelled:

- **Your price** — a cost you entered. It outranks the built-in row for the same style.
- **Catalog estimate** — a built-in ballpark. Correct it to what you pay.

A job's Profitability card says which was used for its blanks: live distributor cost, your price,
catalog estimate, or **approximate — blank not in your catalog** when the style was not found and
the cost was borrowed from a similar garment. Add that blank to make the number real. Built-in rows
can be corrected but not removed; blanks you added can be taken out.

## QuickBooks Online

Open **Books & A/R → QuickBooks Online**. The connection is **one-way: PrintShopCRM → QuickBooks**. Customers, invoices and payments are sent to QuickBooks; nothing is read back into the shop.

Only the shop owner can set it up. It uses an Intuit app that belongs to your shop:

1. At developer.intuit.com open **My Hub → App dashboard**, create an app with the **Accounting** scope, and open its **Keys & credentials**.
2. Copy the **Redirect URI** shown on the card into the app’s Redirect URIs. On a hosted install set `PSC_PUBLIC_URL` so this address is the public one.
3. Paste the app’s **Client ID** and **Client Secret** on the card, choose Production (your real books) or Sandbox (an Intuit test company), and save. The secret is stored on the server and never shown again.
4. Press **Connect QuickBooks** and approve access to your company. The card then names the company it is connected to.

What is sent:

- **Customers** are matched by display name and created when missing.
- **Invoices** carry the invoice number, the shop-local invoice date and due date, and one line per quoted line.
- **Sales tax** is sent as its own line through an item named “Sales Tax (PrintShopCRM)”, which is created on the first taxed invoice and mapped to a “Sales Tax Payable” liability account. To post it elsewhere, change that item’s account in QuickBooks. If QuickBooks’ automatic sales tax is also on, mark the customer or invoice non-taxable there; the card reports an invoice whose total in QuickBooks differs from the shop’s. The older behaviour (a plain line, which counts as income) is still available under **App keys and options**.
- **Payments** are applied to their invoice with the shop-local payment date.
- **Voids** void the invoice in QuickBooks when no money is recorded on it.

What is not sent: invoice credits, card refunds, and a voided invoice that has money on it. Those rows appear as **Enter by hand** with the reason; enter them in QuickBooks and press **Mark done**. They never hold up other invoices.

The card shows every invoice as Synced, Waiting, Will retry, Failed or Enter by hand, with the reason in plain words. **Sync now** sends everything waiting; **Retry all failed** puts failed rows back on the queue. A failed push is retried automatically up to six times with increasing gaps. If the sign-in expires or is revoked, the card says **QuickBooks needs to be reconnected** and everything waiting stays queued until the owner reconnects.

**Disconnect QuickBooks** removes the keys and tokens from the shop. Nothing already in QuickBooks is changed.

### Export for Xero

There is no Xero connection. **Export for Xero** on the same card downloads invoices as a CSV in Xero’s sales-invoice import layout for a date range in the shop’s time zone. Import it in Xero under Invoices → Import; Xero creates drafts for you to approve. Set the sales account code and the tax rate name to match your Xero organisation (defaults: `200` and `Tax on Sales`). Dates are written month-first for a US-English shop and day-first otherwise; add `&date=dmy` or `&date=mdy` to the download address to force one.

QuickBooks Desktop users can still download an IIF file from the same card.
