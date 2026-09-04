# Workflow and costing scale verification

Verified on September 4, 2026 against synthetic fixtures. These are measured examples, not a concurrency or maximum-capacity guarantee.

## Cost comparisons

The comparison previously called the individual job calculator for every saved cost record. In a 5,000-job fixture that performed 60,001 database reads and took about 1,152 ms on the development Mac. The bulk calculator loads one read snapshot per table: 10 reads, approximately 151–169 ms on the same fixture, with the same allocated profit total. Catalog size, artwork, job complexity, disk speed, concurrent traffic and hardware affect actual performance.

The API now pages the displayed job list while computing machine, employee and decoration totals over **all saved job cost records**. Pagination does not change those totals. Individual job history and operation details remain available from the job endpoint; comparison rows contain summary fields.

`GET /api/costing/comparison?page=1&page_size=50` requires manager access. The response contains `jobs`, `pagination` (`page`, `page_size`, `pages`, `total`) and the comparison groups. Page size is 1–100, default 50; invalid values return 400.

## Department queues

The queue reads active jobs, pending tasks, payment holds, purchasing shortages and received counts once per table, using five reads. The same blocking function protects both display and task completion. A 5,000-job screen-print fixture (30,000 pending tasks) returned the 50-row QC page in approximately 138 ms on the development Mac. All 5,000 matching QC tasks contributed to the queue count.

`GET /api/production?department=QC&mine=1&page=1&page_size=50` returns `rows`, page metadata and `ready`/`waiting` totals over all matching tasks. Ready work precedes waiting work. Rush/date order is preserved within those groups. Task assignment and department filters survive page navigation. Pagination does not complete, skip or omit tasks from the underlying workflow.

The CI fixture uses 1,500 jobs and 9,000 tasks. It checks bounded read counts, credit-adjusted totals, consistency with individual job calculators, complete task counts, pagination, assignments, shortages, manual receiving, artwork gates and payment holds. Read-count assertions are deterministic across supported operating systems; elapsed-time observations are not used as flaky test thresholds.

## Remaining load work

These endpoints still aggregate the matching shop data in memory. This work removes repeated database scans and unbounded browser lists; it does not certify arbitrarily large installations. High concurrency, very large supplier catalogs, many operations per order, tens of thousands of runs sharing one estimate, and noisy-shop isolation still need dedicated load and recovery exercises before broader capacity claims.
