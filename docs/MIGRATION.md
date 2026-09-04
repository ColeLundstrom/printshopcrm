# Bring existing records

Use Setup & connections → Import data. CSV is the supported interchange format for customer lists and historical orders. Keep original files and a backup, and preview a small representative sample first. Export templates and field names vary between CRM versions: this is a column-based importer, not a native API migration from every vendor.

Customer headers: name, email, phone, company, notes, tags. First/last name variants and many common vendor headers are recognized. Duplicate customers are skipped by email; rows without email require review before rerunning. Customer import never updates existing records.

Order headers: customer, email, invoice #, date, status, product, qty, unit price, total. Use ISO dates (YYYY-MM-DD). Common synonyms and apparel size columns are recognized. The preview groups repeated order numbers and shows totals before writing.

The current UI uses `status_policy: strict`. Explicit paid, unpaid, and quote states are accepted. Blank/unknown states, production completion without a payment state, and partial payments pause the whole import. Reconcile partial balances separately before importing. Historical invoice jobs are marked complete; active production and arbitrary workflow states need a separate migration. Do not relabel an uncertain payment merely to pass validation.

For backwards compatibility, direct legacy API calls without status_policy retain the old settled-history fallback. New integrations should always send status_policy=strict. Granular balance imports and removal of that legacy fallback require a versioned API transition.

Review totals and original invoice references after import. Repeating the exact same order export skips existing source references. If a source lacks order IDs, keep the exact original file for retries; re-exporting can change the fallback identity. PDFs, artwork, custom objects, mailbox archives and vendor-specific attachments are not imported by these CSV tools.

The preview is invalidated when pasted data changes, inputs stay locked while a request runs, and repeated clicks cannot submit competing imports from the same dialog. Failed batch imports report already-written counts rather than pretending nothing was saved.
