# Buyer and accounts-payable contacts

A customer remains the account that owns its quotes, invoices, payments, jobs and conversation. An accounts-payable address is a delivery destination, not another customer account. Two customers can use the same AP email without their balances or conversations being combined.

In the customer editor, choose **Same as buyer**, **Separate accounts payable**, or **No billing email**. These defaults apply when a document is created. Each quote saves its buyer and billing recipients; its invoice inherits those saved recipients. Changing customer defaults later does not redirect existing documents.

Quote emails go to the saved buyer. Invoice emails, payment-link requests, reminders and invoice-triggered email automation use the saved billing recipient. `{{first_name}}`, `{{recipient_name}}` and `{{recipient_first_name}}` refer to the actual email recipient. Buyer account associations remain unchanged. A blank custom AP email or No billing email blocks document email without falling back to the buyer; it does not disable a customer's public payment page.

Managers can use **Delivery contacts → Edit recipients** on a document. **Use customer defaults** deliberately copies the current customer details into that document. Saving requires the recipient revision currently displayed; a stale editor cannot replace newer recipients. While a message is actively sending, recipient edits wait for its delivery result. Completed edits retain before/after recipient history and mark prior unsent document messages for review.

Changing a quote's buyer name or email also creates a new commercial draft and expires the old approval link. Prior approval evidence remains in the quote history. Changing only its AP destination does not revoke commercial approval or a job's technical artwork release. Once invoiced, edit recipients on the invoice.

## Drafts and delayed automation

An outbox message retains the destination and greeting it was created with. A recipient change blocks sending its old draft; review the document and create a fresh message. Delayed automation captures the document recipient revision. A changed revision parks the old sequence as `recipient_review`; its Automation row links to the document. Review the recipient, cancel the old sequence, and create the required fresh message. Resume does not silently redirect a parked sequence.

The customer conversation shows the actual outgoing email recipient. Ordinary conversation replies still go to the buyer. Use the invoice's send/payment/reminder actions for its saved AP destination. SMS uses the existing customer phone; there is no separate AP phone field. Customer statements remain account-wide PDF downloads, without an automatic statement-email route.

## Upgrade boundaries

Existing documents receive snapshots of the contact details known at upgrade, labeled `legacy_migration`. This does not recover the exact recipients of historical documents. Delivered email rows keep their original recorded destination. Older unsent document-like messages without a reliable document ID are held for review, as are unsent emails with no saved destination. Their content and recorded addresses are retained; the migration does not guess document identities from subjects.

Older delayed sequences without a recipient revision may proceed only when their captured buyer name and email exactly match the current saved document recipient and that document is still at revision zero. Otherwise they are parked for review. Company and telephone fields on documents continue to use the existing customer record; this feature is not a complete immutable legal-document archive.

## API and verification

Customer create/edit accepts `billing_mode` (`buyer`, `custom`, `none`), `billing_name`, and `billing_email`. A custom email must be one address, never a list or header. Deliberate empty values are preserved.

Manager-only `PUT /api/estimates/:id/recipients` and `PUT /api/invoices/:id/recipients` require integer `recipient_revision`. They accept billing fields and optional `use_customer_defaults: true`; the quote editor also exposes `buyer_name` and `buyer_email`. Document send/nudge/payment-request actions require the expected recipient revision after a recipient edit. Omitting it remains compatible only at revision zero.

The focused tests exercise actual isolated HTTP routes and the real queue/template/delivery bookkeeping with only the final SMTP transport replaced by a local capture. They cover restart, stale drafts, delayed and legacy sequences, blank recipients, a concurrent delivery/edit fence visible from an independent SQLite connection, approval/history rollback, unchanged technical artwork release, staff and cross-shop denial, and detached editor completion. They do not send email or call payment providers.
