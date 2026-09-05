# Import reliability and remaining responsiveness work

## Customer import guarantees

Customer CSV preview estimates the result from the current customer book. During import, email matching is checked again under the database write lock, so another import committing after the preview does not create another customer with that email. Matching is case-insensitive. Rows without an email still cannot be matched reliably on retry; review those for duplicates.

Counters advance only after a batch commits. A failed INSERT or COMMIT rolls back the active batch; earlier batches remain saved. The partial response names the number actually committed and instructs the shop to retry the same file. A failure to write the final activity entry cannot turn a saved import into a generic error. This activity entry is best-effort, not a durable import ledger.

An individual constraint violation can skip a row. A savepoint also removes that row's trigger side effects. Storage failures, transaction-level rollbacks and commit failures stop the import instead of being silently counted as bad rows. An ignored insert also counts as skipped, with its trigger effects removed. The normal response's skipped count includes rejected rows, and the import dialog stays open to show skipped rows until dismissed. Imports still use synchronous SQLite in batches; this change does not promise bounded server response time.

Tests exercise actual deferred foreign-key failure at COMMIT, trigger rollback, row-trigger side effects, concurrent email matching and separate shop handles. The HTTP fixture commits 500 customers, fails the next batch and the activity write, checks a truthful partial response, then retries to finish exactly 600 customers without duplicating the first batch. Simulated disk-full error propagation is also covered; it is not a physical full-volume test.

## Confirmed latency limitation

The unchanged end-to-end gate requires every import health probe to return HTTP 200 with `ok:true` and the worst response to stay below 1,500 ms. A 9,000-order Windows import at revision `74bc9c3` recorded a 2,365 ms synchronous SQLite commit and a 2,396 ms health response (GitHub run 33932163227). Revision `e51bd86` subsequently passed all seven required jobs, with a 706 ms maximum commit, 749 ms worst order-import health response and 569 ms worst customer-import response (run 33932685808). Passing later runs does not eliminate the observed variance.

A separate local SQLite experiment held a worker transaction for 1,800 ms. A main-thread WAL read took less than 1 ms, but a synchronous main-thread write waited 1,811 ms and delayed a timer by 1,793 ms. Moving import writes into a worker alone would therefore leave the process vulnerable: `/health` and ordinary writers use a synchronous connection with a five-second busy timeout.

## Checkpoint maintenance during imports

Customer and order imports keep transactions on their original authorized connection. On SQLite 3.51.3 or newer, a separate worker runs PASSIVE checkpoints after committed batches. SQLite documents that default automatic checkpoints can make occasional commits slower; PASSIVE uses a checkpoint lock without taking a writer lock. FULL transaction durability remains unchanged, so WAL synchronization can still block a commit. This optimization is not a response-time guarantee. Sources: [WAL performance](https://sqlite.org/wal.html#performance_considerations), [checkpoint locking](https://sqlite.org/c3ref/wal_checkpoint_v2.html).

The process starts at most two checkpoint workers. Concurrent imports on the same connection share a worker and coalesce maintenance requests. Other shops retain ordinary automatic checkpointing when capacity is occupied. Old SQLite engines, in-memory/non-WAL databases, startup failure and `PSC_IMPORT_CHECKPOINTS=off` also retain the previous behavior. The version guard avoids a documented concurrent WAL-reset corruption bug; older vendor backports are conservatively not enabled. [SQLite WAL-reset fix](https://sqlite.org/wal.html#the_wal_reset_bug).

The worker opens only the existing connection's database path using a `mode=rw` URI; it cannot create a missing shop or run migrations. Automatic checkpoints are disabled only after the worker is ready and restored after the last import or a worker failure. A restoration failure retains the original value for recovery; persistent failure stops subsequent import batches and reports the saved count. Tenant deletion refuses before changing registry/data while an import lease, its worker or outstanding setting restoration remains active. Worker exit, startup, failure and shutdown paths preserve the original setting. A hard process stop relies on SQLite recovery, not an in-memory progress promise.

Imports await maintenance between batches, bounding the checkpoint queue. A reader holding more than 64 MiB of uncheckpointed WAL history stops further import batches and returns the committed count with instructions to let the export/backup finish before retrying. This is a pending-frame limit, checked after COMMIT, not a strict file-size quota: the last batch can overshoot it and SQLite may retain an already-checkpointed WAL allocation. Worker failure restores ordinary checkpointing; it does not erase a committed batch or claim that it rolled back.

Order imports also treat their final timeline entry as best-effort so a logging failure cannot hide saved orders. Focused integration tests exercise overlapping imports, deletion refusal without partial deletion, a real pinned reader, ordinary same-shop writes, worker/process loss, restart and deduplicated resumption. The unchanged full HTTP gate continues to measure import health latency; the prior Windows failure remains evidence of a release risk until cross-platform measurements establish the improvement.

## Requirements before moving import transactions to workers

- Extract parsing and graph-writing logic without importing modules that open or migrate databases as a side effect. `csv.mjs` currently depends on `db.mjs`, which opens the default database on import.
- Capture the authorized tenant and existing database path before queueing. Never derive a filesystem path from an import request or create a missing shop database in a worker. Coordinate tenant removal and shutdown with active work.
- Coordinate every writer for a given database, including HTTP handlers, payment callbacks, scheduled automations and health probes. A middleware-only lock would miss background work and public callbacks. A worker must not make the main process wait synchronously for its lock.
- Preserve a real writable-health signal. Returning unconditional success, ignoring failed probes, relaxing the latency threshold or weakening SQLite durability would hide the defect.
- Bound worker concurrency, queued bytes, runtime and memory. Preserve order-level atomicity, stable import identities, current pricing/settings semantics and accurate rollback counts.
- Persist progress in the same transaction as imported rows before promising exact crash counts. A worker can die after COMMIT but before its acknowledgment reaches the parent. In-memory counters cannot establish what was saved in that window.
- Verify same-shop reads and writes, neighboring-shop reads and writes, health checks, duplicate concurrent imports, lock contention, worker crashes, shutdown and tenant removal. Retain the current full-disk/read-only failure contracts.

Moving transactions to workers remains an unresolved architecture change. The checkpoint-only worker above does not move parsing, SQL writes or FULL commit synchronization away from the request thread.
