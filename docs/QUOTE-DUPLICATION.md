# Reuse a quote for an existing customer

On an estimate, choose **Duplicate**, select the customer, then choose **Create draft & edit**.
The original customer is selected initially. Names include company and email where available to
help distinguish customers with the same name. Closing the dialog before creating makes no change.

The new draft keeps line items, size grids, saved prices and upcharges, decoration details, notes,
quote metadata and rush tier. Review old prices and customer-specific notes before sending.
The selected customer's current addresses and delivery contacts and current shop estimate terms
are snapshotted by the existing insert rules. Another customer gets their own tax treatment;
a same-customer copy retains the source rate subject to that customer's tax exemption. Existing
customer payment terms still apply when converting the draft to an invoice.

No email, customer approval, invoice, payment, production job or artwork approval is created.
The source is unchanged. The new quote gets its own number, share key, draft status and open
pipeline deal. This works with any estimate and is separate from selecting an accepted order on
a customer's page.

## Lost responses and interrupted navigation

The dialog sends a unique request reference with the source's commercial revision and immutable
creation identity. Repeated clicks
share one in-flight action. If the result is uncertain, **Retry same copy** sends the same payload
and reference and recovers the original draft. The customer choice stays locked until the outcome
is known. A source changed before the first successful copy is refused and must be reviewed again.

The unresolved action survives Close, navigation, Back and reopening Duplicate within the current
signed-in app session. A late response cannot navigate an older page, close another dialog or
render under a different account. If a copy completed while its dialog was closed, reopening offers
the already-created draft, revalidating the same durable receipt before opening it. A full page
reload discards this in-memory reference, so check Estimates
for a created draft before starting a new action after a reload.

Server receipts persist across restarts in the existing per-shop `api_create_receipts` table.
The estimate, activity entry, pipeline deal and receipt commit atomically; a failure rolls them all
back. A replay resolves before source revalidation, so later source edits do not create another
quote. If the created quote was deleted, replay returns `duplicate_draft_missing` instead of creating
it again or navigating to a reused row ID or estimate number. Legitimate edits to the created
draft do not change its creation identity, even when its customer approval link rotates.

## Additive schema and recovery

Every default and tenant database initializes `estimate_copy_identities`, with one random non-secret
128-bit identity per estimate. Existing estimates are backfilled without changing their records.
An insert trigger creates identities for all future estimate inserts, including writes by an older
application version after a code rollback. The identity table prevents identity updates; its foreign
key cascades on estimate deletion, including customer-deletion cascades. Reusing a SQLite row ID
or estimate number therefore receives a different creation identity.

The duplicate receipt stores `_created_identity` internally. This metadata is stripped from both
first and replayed route responses. Older receipts without this metadata fail closed with
`duplicate_draft_missing`; the shop must check Estimates rather than silently create another copy.
Other API receipt operation formats are unchanged. Back up and restore the complete SQLite
database, retaining both identity and receipt tables and their triggers. Do not drop this additive
table on a code rollback. Business-data exports do not substitute for a state-preserving database
snapshot, including receipt history.

## Internal route compatibility

`POST /api/estimates/:id/duplicate` keeps its 200 response shape:
`{ "ok": true, "id": 123, "estimate_number": "EST-1012" }`.

- `contact_id`: optional existing customer; omission keeps the original customer
- `commercial_revision`: optional for legacy clients; the dialog always supplies it
- `source_identity`: optional for legacy clients; the dialog sends the authenticated detail
  response's non-secret value and refuses to copy when it cannot verify the source
- `request_id`: optional 8–128 character retry reference, using letters, digits, `.`, `:`, `_` or `-`
- The `Idempotency-Key` header is also accepted. If both are supplied, they must match.
- Retries must use the same body and signed-in member. A changed body with the same key returns 409.
- Successful keyed responses include `Idempotency-Replayed: false` or `true`.
- Legacy calls without a key still create a new copy on each call, but creation is now transactional.

Receipts are scoped by source, signed-in member and the already-authorized shop database. Existing
staff permissions are unchanged. The route remains an internal app route, not a new external-agent
operation or an expansion of API key scope.

## Verification

The regression first failed on the original base: the same keyed request returned EST-1012 rather
than the first draft EST-1011. Focused HTTP and UI-state tests cover:

- Original and different customers, tax exemption, addresses, delivery contacts and payment terms
- Preserved lines, sizes, prices, rush tier and notes, fresh draft identity, unchanged source/history
- Repeated requests, changed-payload conflicts, process restart and deleted-copy recovery
- Unauthenticated requests, staff access and another tenant with identical source/customer IDs
- Stale source revision, invalid/deleted customer, negative totals and transaction-failure injection
- Repeated clicks, uncertain retries, Close/reopen, late replies, newer navigation, account changes,
  failed customer loading and unavailable secure randomness
- Source and target ID/number reuse, cascade deletion, edited-target replay, legacy receipt refusal,
  backfill, old-code inserts and interrupted migration rollback

Run focused checks with `node --test test/estimate-duplicate-*.test.mjs test/estimate-copy-schema.test.mjs`, then the required
`npm test` and `npm run test:e2e` gates.

The initial candidate's cloud verification on October 11, 2026 passed all 408 Node tests and all 955 aggregate checks;
the E2E command exited 0 with "all pass (1 skipped)". The skipped off-loopback bind assertion
requires network-interface discovery, which this runner denied. The initial runs lacked `sqlite3` and
`rsync`. Final runs used verified official Debian packages through process-local PATH and library
paths; no fake binaries, application dependencies or test gates were substituted.
The creation-identity follow-on passes 14 focused HTTP, UI-state and migration checks, 416 Node
tests, all 955 aggregate checks and E2E with the same one runner-limited assertion skipped.
The test-only response-fault helper adds four passing isolation/error-drain tests. Aggregate gates
must also run on the integrated commit.

`node test/browser/estimate-duplicate-smoke.mjs` supplies a disposable desktop/mobile test with
sandbox-enabled official Chrome, exact-loopback HTTP isolation, mocked realtime and screenshot
output in `browser-artifacts/`. Use the pinned isolated Playwright setup in CONTRIBUTING.md.
The harness covers customer selection, cancel/focus, copied draft, tax/address defaults,
Back/Forward without extra writes, committed-but-lost responses with Close/reopen recovery,
and navigation before delayed success followed by receipt revalidation. The fault interceptor
accepts only the exact synthetic duplicate POST, refuses redirects and external destinations,
tracks and drains its callbacks, and keeps the base origin guard installed. Its screenshots and
browser execution remain unverified in the
cloud shell: Chromium startup was blocked by local socket restrictions; the separate supported
cloud browser could not reach that shell's loopback server. No sandbox bypass was used.

No runtime dependency, license or third-party notice changed. Cross-platform and browser
CI remain release gates; passing local fixtures does not establish production readiness.
