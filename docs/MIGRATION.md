# Bring existing records

Use Setup & connections → Import data. CSV is the supported interchange format for customer lists and historical orders. Keep original files and a backup, and preview a small representative sample first. Export templates and field names vary between CRM versions: this is a column-based importer, not a native API migration from every vendor.

Customer headers: name, email, phone, company, notes, tags. First/last name variants and many common vendor headers are recognized. Duplicate customers are skipped by email; rows without email require review before rerunning. Customer import never updates existing records. A row whose email or phone holds more than one address ("a@x.com, b@y.com") is refused and listed under `rejected` with the reason — one address per customer, as on the customer form.

Order headers: customer, email, invoice #, date, status, product, qty, unit price, total. Use ISO dates (YYYY-MM-DD). Common synonyms and apparel size columns are recognized. The preview groups repeated order numbers and shows totals before writing.

The current UI uses `status_policy: strict`. Explicit paid, unpaid, and quote states are accepted. Blank/unknown states, production completion without a payment state, and partial payments pause the whole import. Reconcile partial balances separately before importing. Historical invoice jobs are marked complete; active production and arbitrary workflow states need a separate migration. Do not relabel an uncertain payment merely to pass validation.

Direct legacy API calls without status_policy keep a lenient reading, with limits: a blank status and explicit settled words (paid, complete, delivered, shipped, closed) are imported as paid history; open, due, pending, not paid and the unpaid words are imported unpaid; cancelled, voided and refunded orders are skipped (counted as `skipped_cancelled`); any other status stops the import and is named in the error. In both modes cancelled/voided/refunded orders are skipped, a quantity above 1,000,000 pieces stops the import, and imported lines are priced at the file's own unit price — today's extended-size upcharges are never added to historical lines. New integrations should always send status_policy=strict. Granular balance imports require a versioned API transition.

Review totals and original invoice references after import. Repeating the exact same order export skips existing source references. If a source lacks order IDs, keep the exact original file for retries; re-exporting can change the fallback identity. PDFs, artwork, custom objects, mailbox archives and vendor-specific attachments are not imported by these CSV tools.

The preview is invalidated when pasted data changes, inputs stay locked while a request runs, and repeated clicks cannot submit competing imports from the same dialog. Failed batch imports report already-written counts rather than pretending nothing was saved.
