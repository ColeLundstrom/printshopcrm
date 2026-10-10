# Free profit planner

Open **Money → Profit planner** as an owner or manager. The entire tool is part of the
AGPL software and runs without a subscription, AI key or payment-provider connection.
It is available in both existing product editions. Manager access protects employee costs;
it is not a paid-feature restriction.

## Cost-plus pricing

Enter a finished quantity, blank and supplies costs, material allowance, setup time, output
per productive hour, machine cost, loaded labor, allocated overhead, other run costs, payment
fee assumptions and target margin. Load an existing machine/employee configuration when useful,
or select **Try example costs** for an explicitly illustrative scenario.

The model covers one operation. Setup plus quantity/output determines hours. All hourly rates
apply to that complete time. Extra material allowance is additive: quantity × (1 + allowance%).
It does not add replacement production time or produce whole-piece purchasing quantities.
Include additional operations fully in Other costs, or use the job costing workflow for separate
machine runs. Do not count outsourced work, labor or overhead twice.

The minimum sales amount is:

    (modeled production costs + fixed processing fee)
    / (1 - target margin fraction - processing percentage fraction)

This is margin on sales, not markup on costs. Unit prices round **up** to cents, and the total
is integer unit cents × quantity. The shared model uses exact decimal fractions for the ceiling
calculation. Fee estimates do not reproduce every processor's rounding or minimum charges.
A zero-value scenario has no defined margin and displays N/A. Sales tax and unentered costs
are excluded. Use the same currency throughout; the pricing model currently uses two-decimal
unit increments even when a shop's display currency convention differs.

Quantity breaks use the same assumptions, including fixed setup and Other costs, at each
quantity. No supplier discount or capacity availability is inferred. Download the CSV for a
reference sheet. This tool does not save a price matrix, edit a quote, charge a customer or
change existing agreements. Scenarios remain on the page and are discarded when leaving it.

## Monthly break-even and profit goals

Enter fixed monthly costs, variable costs as a percentage of sales, desired monthly profit,
forecast sales before tax, and productive hours. The screen reminds you of saved shared
overhead, but does not assume that overhead includes fixed payroll, owner pay, debt service,
every expense, or cash needs.

Break-even sales = fixed costs / contribution margin. Target sales add target profit to the
numerator. Contribution margin = 1 - variable-cost fraction. Forecast modeled profit = forecast
sales × contribution margin - fixed costs. Do not subtract allocated fixed overhead again as
variable cost. Required sales per productive hour is an average operating target, not a staffing,
capacity, tax or cash-flow forecast. No result is a guarantee of demand or earned profit.

## Related tools and remaining scope

Job costing stores actual/planned operation time with historical rate snapshots. Machine,
employee and decoration-method comparisons allocate whole-job profit by operation time;
allocation is not causation. The pipeline and reorder tools cover their documented workflows.

This release does not provide full accounting-statement import/reconciliation, a general ledger,
complete customer/product profitability rollups, persistent budget alerts, or all Print Profit /
Inktavo functionality. External integrations still need provider-owned acceptance testing.
See [the adoption backlog](ADOPTION-BACKLOG.md) and [core readiness](CORE-READINESS.md).
