# v1.35.3 — Reliable price-sheet imports

A blank CSV heading could shift prices into the wrong column, and oversized sheets were silently truncated. Matrix CSV/TSV imports now validate the complete sheet before saving: exact row widths, distinct nonempty headings, valid nonnegative prices, proper quoting, and the existing 60-row / 40-column / 2 MB limits. Quoted commas, escaped quotes, multiline headings, zero prices and blank cells retain their meaning.

File replacements ask before changing the saved grid. Paste replacements name the action explicitly and warn about unsaved edits. Cancelling or validation failure preserves edits; corrected files can be selected again. Progress prevents duplicate in-flight uploads, persistent errors support correction, and late replies cannot navigate a different screen or account. Uncertain network failures are not represented as confirmed saves or confirmed rollbacks.

Imports are transactional, so an activity-log failure cannot leave an apparently failed new matrix behind. Invalid replacement IDs cannot accidentally create a new matrix. Existing manager permissions and tenant boundaries remain enforced. Replacement retains saved matrix metadata, and existing estimates keep their prices.

Validation includes parser boundary tests, authenticated HTTP tests for roles, tenant isolation and rollback, view retry/stale-response tests, the full test suite, E2E, and manual browser cancellation/retry checks in a synthetic outbound-blocked demo. Deployment additionally requires exact-commit CI, copied-data rehearsal, a fresh stopped backup, configuration comparison and existing-session acceptance.

This is matrix price-sheet import reliability, not product-catalog CSV import or the separate CRM migration in PR #7. No schema or dependency changes.
