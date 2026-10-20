# Import column mapping

Customers → Import CSV and Import order history now offer “Match your columns”. Upload or paste a CSV, review suggested sources, choose custom headings, then preview. “Do not import” suppresses that field even when a recognized synonym is present. Every edit disables Import until another preview succeeds. A new file resets the choices. First/last names are supported; recognized apparel size columns remain automatic for orders.

The same field-to-header `mapping` object is accepted by JSON and multipart requests to `/api/import/contacts` and `/api/import/orders`. `mapping_only: true` returns headers, examples, field names and suggested mapping without writing data. Invalid fields or missing mapped headers return 400. Existing callers omitting mapping retain automatic synonym fallback behavior.

The UI retains strict paid/unpaid/quote review. Mapping a production-completed column does not establish payment. Partial-payment reconciliation, artwork/attachments, custom-field migration and active-production migration remain separate gaps. Customer deduplication uses email; rows without email need manual duplicate review. Choices apply to the current import and are not saved as reusable import profiles yet.

## Switcher presets (customer import)

The customer import detects the export format from its header row. It then pre-selects columns for one of three presets: **Generic**, **Printavo customer export** or **YoPrint customer export**. The mapper shows the result, for example “Detected: Printavo export”. An **Export format** selector switches presets, and every column stays editable.

- **Printavo:** Two or more Printavo-specific headers identify the file, such as `Customer ID`, `Tax Exempt`, `Tax Resale No.`, `Billing Address - Address 1`/`- City` and `Owner Name`. First Name and Last Name become the contact name. Company is kept as the company, or used as the name when there is no person. The split billing and shipping address columns are combined into postal addresses. Merch-style `Billing Address1` and `Billing Zip` are also accepted.
- **YoPrint:** Two or more of YoPrint's snake_case template headers identify the file, such as `customer_name`, `customer_tax_exempt`, `customer_resale_number`, `customer_internal_notes`, `billing_postcode`, `billing_country_code` and `contact_email`. `customer_name` becomes the company, `contact_first_name`/`contact_last_name` become the name, and `customer_internal_notes` becomes notes.

**Accuracy note:** Neither vendor publishes a complete, verbatim export header list. These presets are built from the column descriptions in their help articles. Matching therefore uses case-insensitive aliases and ignores spacing and punctuation (`_`, `-`, `.`, `?`, `#`, `/`, parentheses). It is not an exact column contract. Fields a preset does not name fall back to the generic synonyms, so check the preview before importing. Order-history import uses only the Generic mapping. `mapping_only` responses now include `preset`, `detected` and `presets` (each with its suggested `mapping`). API callers that omit `mapping` keep the generic automatic fallback. To use a preset, send back the mapping that `mapping_only` returned. Tax-exempt status, resale numbers, owner and payment terms are not imported.

Verified with parser mapping tests, authenticated JSON and multipart preview/commit tests, duplicate retry tests, and a browser import of a synthetic customer.
