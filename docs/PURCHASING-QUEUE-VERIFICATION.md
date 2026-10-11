# Purchasing queue verification

Base: `b925c0d6637c27c01347d7a76255e82d8da8a013` (v1.36.2). Cloud validation: 2026-10-11, Node 24.19.0.

## Scope

A read-only shop-wide list of recorded POs, with placement evidence separate from receipt quantities,
search/supplier/view filters, summary counts, pagination, job deadlines and existing job/receiving links.
No supplier request, receiving mutation, job-stage guard, payment, schema change, new runtime dependency,
real account or real shop data is part of this change. Existing AGPL licensing and notices are retained.

This is adjacent to the separate material-readiness work: it does not implement or replace a production
hold. Existing receipt and short-close/reopen controls retain their current authorization and behavior.
An empty queue cannot establish production readiness because jobs with no PO and manual counts are outside its scope.

## Checks completed

- Focused data, HTTP and view regression suite: 10 passed.
- Aggregate Node suite: 412 passed, 0 failed.
- Repository gate: 955 passed, 0 failed.
- End-to-end gate: all pass, one environment skip. Network-interface discovery was denied by the cloud
  runner, so the off-loopback bind assertion was not exercised.
- Syntax checks and `git diff --check` passed.

The tests use synthetic data. Cases cover partial/missing quantities, legacy/unconfirmed placements,
manual acknowledgement evidence, received POs, explicit short closes, reopen, completed and missing
jobs, empty line quantities, per-size shortages, literal search, malformed filters, paging, 1,500 POs,
constant query count, tenant isolation, staff access, anonymous rejection, no data writes from reads,
HTML escaping, stale navigation responses, empty/error states and the receiving-panel handoff.

The first aggregate gate attempt lacked `rsync`/`sqlite3` and failed deployment/backup fixtures. The passing
run used separately verified Debian snapshot executables and libraries through process-local PATH and
LD_LIBRARY_PATH. No application dependency, system security setting or test assertion was changed for that.

## Browser verification still required

`node test/browser/purchasing-smoke.mjs` is registered in the existing CI browser job. It uses the
repository's official Chrome channel, existing isolated Playwright tooling, a throwaway demo and a
sandbox-enabled browser. It covers desktop (1440), tablet (768) and phone (414, 375, 320) widths, search,
supplier and status filters, pagination/Back, short-close wording, receiving links, empty states,
labels, overflow, errors and the absence of browser writes. The existing browser isolation helper
blocks external destinations and stubs only the demo's exact WebSocket endpoint.

This harness was attempted locally with the installed Chromium. Browser startup was blocked by the
cloud runner: `socket() failed: Operation not permitted`. The existing cloud browser also could not
reach the shell's isolated loopback server. No sandbox was disabled and no server was exposed publicly.
**No desktop/mobile screenshot, browser rendering pass or physical-device verification is claimed.**
The browser job must pass in a supported environment before treating visual/interaction verification
as complete. Outputs, when the browser runs, are `browser-artifacts/purchasing-*.png` and
`browser-artifacts/purchasing-report.json`; failed startup produces a report without screenshots.

## Independent-review corrections

A follow-on review found that a different asynchronous route can leave the old Purchasing loader
connected. The response guard now captures both the full route hash and the signed-in identity,
and ignores late successes and errors if either changes. Deferred regressions keep the loader
connected to exercise that specific failure; they failed before the guard correction.

The browser report now redacts the complete serialized result, including nested isolation errors,
after cleanup. Scenario assertions run after isolation teardown so an unexpected teardown error
cannot leave a passing report. Both report regressions execute the actual harness statements,
failed before the corrections and passed afterward. The follow-on focused suite passed all 13 tests;
syntax and diff checks passed. The aggregate and E2E numbers above describe the initial feature
commit; combined integration gates remain the integration owner's verification step. These changes
do not remove the browser-startup limitation or establish a browser rendering pass.

## CI label-matching correction

PR #18 browser run 38143653343, job 114482428628, reached and captured the initial desktop queue,
then timed out looking up the exact `View` label. Its report contained no page, console, network,
blocked-request or unexpected-write errors. The wrapped native label also contained the select's
options. Playwright 1.64.0's [label lookup and text collection](https://github.com/microsoft/playwright/blob/v1.64.0/packages/injected/src/selectorUtils.ts#L61-L125)
include those descendant texts; the [label selector and exact matcher](https://github.com/microsoft/playwright/blob/v1.64.0/packages/injected/src/injectedScript.ts#L470-L479)
therefore cannot match that full text to `View` alone.

The filter fields now use sibling labels and controls inside the existing `.field` wrapper. Explicit
`for`/`id` associations, visible labels and exact label-based browser interactions remain intact.
A rendered-markup regression failed before this fix and passed afterward. The browser smoke also
asserts each native label's exact text before interacting, so changing option text cannot pollute it.
All 14 focused purchasing tests and syntax/diff checks passed. The new head still needs the combined
CI browser run; the earlier initial-desktop screenshot does not verify this correction or mobile UI.
