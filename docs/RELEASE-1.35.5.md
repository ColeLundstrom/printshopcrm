# v1.35.5 — Export the customer group you are viewing

Owners and managers can download the current Customers results with **Export matching CSV**. Name/company/email search, all/any included tags, and excluded tags use the same predicate for the screen and the CSV. The link is unavailable while a search is pending or has no matches, and old responses cannot enable an export for stale filters.

The existing manager-only CSV endpoint now accepts these customer filters. Full exports without filter parameters remain unchanged. Invalid filters return a JSON error before attachment headers. Exports retain streaming, CSV quoting, formula neutralization, and tenant isolation; responses are private and uncached.

No schema, pricing, credentials, sessions, or historical-record migrations. Catalog import, shared/saved filters, and CRM migration PR7 remain separate.

Validation includes matching exported customer IDs against filtered API results, no-match and invalid filters, formula/quote/newline handling, staff/anonymous rejection, cross-tenant isolation, unchanged records, stale UI responses, browser downloads, full regression/E2E, exact-commit CI, and copied production-data rehearsal before backed-up deployment.
