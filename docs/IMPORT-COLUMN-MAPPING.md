# Import column mapping

Customers → Import CSV and Import order history now offer “Match your columns”. Upload or paste a CSV, review suggested sources, choose custom headings, then preview. “Do not import” suppresses that field even when a recognized synonym is present. Every edit disables Import until another preview succeeds. A new file resets the choices. First/last names are supported; recognized apparel size columns remain automatic for orders.

The same field-to-header `mapping` object is accepted by JSON and multipart requests to `/api/import/contacts` and `/api/import/orders`. `mapping_only: true` returns headers, examples, field names and suggested mapping without writing data. Invalid fields or missing mapped headers return 400. Existing callers omitting mapping retain automatic synonym fallback behavior.

The UI retains strict paid/unpaid/quote review. Mapping a production-completed column does not establish payment. Partial-payment reconciliation, artwork/attachments, custom-field migration and active-production migration remain separate gaps. Customer deduplication uses email; rows without email need manual duplicate review. Choices apply to the current import and are not saved as reusable import profiles yet.

Verified with parser mapping tests, authenticated JSON and multipart preview/commit tests, duplicate retry tests, and a browser import of a synthetic customer.
