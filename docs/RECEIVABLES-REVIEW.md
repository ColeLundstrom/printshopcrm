# Receivables collection review

Books & A/R keeps the entire positive balance of every non-void invoice in its aging totals,
including invoices whose saved `payment_review` flag pauses collections. The Collection review
section exposes those flags and their saved reasons without clearing them or requesting money.

## Reconciliation

- **Net invoice** is the saved invoice `amount_due`. Active invoice credits have already reduced
  this amount; the report does not subtract them again.
- **Recorded payments** is the saved invoice `amount_paid`, including the effects of recorded
  payment reversals. This is ledger evidence, not a verification of a bank deposit.
- **Balance** is net invoice less recorded payments, computed in integer cents.
- **Active credits** adds each uncanceled credit's subtotal and tax cents. These are non-cash
  allowances; issuing a credit does not prove a refund was sent.
- **Receivables marked for review** includes only positive balances on flagged invoices.
  **No saved review flag** includes the other positive balances. Together they reconcile to the
  full A/R total. The absence of a flag does not establish that collecting payment is safe.
- Fully credited, settled and overpaid flagged invoices remain in the review section, even when
  no positive receivables remain. Their nonpositive balances never reduce another invoice's A/R.
  Voided invoices remain excluded.

Customer invoice details show the same saved amounts and link to the existing invoice screen.
The existing aging convention is unchanged: when no due date is saved, the invoice creation date
is the fallback. The invoice detail labels that fallback rather than inventing a payment term.

## Boundaries

The report is read-only and uses the current authenticated tenant's database. It preserves the
existing staff access to Books & A/R; the QuickBooks queue still requires a manager or owner.
Review reasons are already available to these roles on the corresponding invoice. No provider
lookup, payment, message, collection resumption or external accounting write is performed.

This is invoice-balance reporting, not a profit, cash-flow or tax calculation. It does not use
estimate revenue or modeled job costs. Existing statements, exports, collection controls,
Profitability and Job costing are unchanged.

## Focused checks

Run `node --test test/receivables-review*.test.mjs` for synthetic HTTP, money and view tests:
cent rounding and large sums, active/canceled credits, no double credit deduction, empty inputs,
zero and negative balances, void exclusion, owner/staff/unauthenticated access, tenant isolation,
read-only behavior, escaped text, missing due-date labels, retry, and stale navigation/identity
responses. These are feature tests, not acceptance of any other pending candidate.

## Browser evidence

The separate `node test/browser/receivables-review-smoke.mjs` command uses the repository's
isolated Playwright 1.64.0 install in `.browser-tools` and the runner's official Google Chrome
with its sandbox enabled. Prepare those prerequisites using the instructions in CONTRIBUTING.md.
The script creates its own disposable synthetic shop and neighboring tenant, retains the demo
server's outbound guard, limits browser traffic to the exact loopback app, and blocks browser
writes before they reach the server. The app's local realtime socket is explicitly stubbed.

At 1440 × 1000 and 390 × 844 it checks the three review states, excluded void/settled invoices,
keyboard drilldowns, invoice links, delayed responses across Back/Forward, tenant isolation,
page overflow, browser errors and unchanged saved financial rows. It saves actual rendered
`browser-artifacts/receivables-*.png` screenshots and `receivables-review-report.json`, including
the browser/tooling versions and each scenario result. Authentication state and demo credentials
are never saved with that evidence. The JSON report is also written when startup or a check fails.

A missing official Chrome installation or an unavailable sandbox is a visible test failure,
not permission to disable the sandbox. Static/fixture tests do not establish that the browser
scenarios or screenshots passed; the standalone command must run on a supported CI runner.
