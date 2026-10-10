/**
 * Dependency-free, shared planning models. All named inputs are required finite numbers;
 * no strings, missing-value defaults, or guessed shop rates. Currency is the caller's
 * currency, with two-decimal selling prices. These are estimates, not booked profit.
 *
 * The quote models ONE operation: setup + quantity / output_hour. Each hourly rate
 * applies to that complete time. Model additional operations separately rather than
 * pretending one throughput rate describes an entire mixed-method production route.
 * Spoilage is an additive material budget: quantity × (1 + spoilage_pct / 100).
 * This is not a yield/replacement calculation, a whole-item purchasing count, or
 * additional production time. Input throughput must already reflect expected losses.
 *
 * Costs exclude sales tax, freight, discounts, and other unentered expenses. Include
 * applicable costs explicitly and avoid double-counting overhead. Percentage and flat
 * payment fees are modeled without processor-specific rounding, minimums or fee rules.
 *
 * Decimal fractions preserve the supplied numbers' decimal spelling until final
 * output. A binary float epsilon around ceil() can either add a penny at an exact
 * boundary or silently underquote just above it. Selling prices use exact integer
 * cents; other outputs retain unrounded model precision for display by the caller.
 */

const ZERO = [0n, 1n]
const ONE = [1n, 1n]
const HUNDRED = [100n, 1n]
const SIXTY = [60n, 1n]
const MAX_CENTS = BigInt(Number.MAX_SAFE_INTEGER)
const QUOTE_FIELDS = [
  'quantity', 'garment_cost', 'consumable_cost', 'spoilage_pct', 'setup_minutes',
  'output_hour', 'machine_rate', 'labor_rate', 'overhead_rate', 'other_cost',
  'payment_pct', 'payment_flat', 'target_margin_pct',
]
const MONTH_FIELDS = [
  'fixed_cost_month', 'variable_cost_pct', 'target_profit_month',
  'forecast_revenue', 'productive_hours_month',
]
const QUOTE_WARNING = 'Do not count an expense twice across machine, labor, overhead rates and other costs. This is modeled profit before tax and any unentered costs.'
const MONTH_WARNING = 'Do not count an expense twice: fixed monthly costs must be excluded from the variable-cost percentage. Do not also subtract allocated quote overhead as a monthly variable cost.'

function gcd(a, b) {
  a = a < 0n ? -a : a
  while (b) [a, b] = [b, a % b]
  return a
}
function fraction(n, d = 1n) {
  if (d < 0n) { n = -n; d = -d }
  const common = gcd(n, d)
  return [n / common, d / common]
}
function decimal(value) {
  const [coefficient, exponent = '0'] = String(value).toLowerCase().split('e')
  const [whole, decimalPart = ''] = coefficient.split('.')
  const digits = BigInt(whole + decimalPart)
  const places = decimalPart.length - Number(exponent)
  return places >= 0 ? fraction(digits, 10n ** BigInt(places)) : fraction(digits * 10n ** BigInt(-places))
}
const add = (a, b) => fraction(a[0] * b[1] + b[0] * a[1], a[1] * b[1])
const subtract = (a, b) => fraction(a[0] * b[1] - b[0] * a[1], a[1] * b[1])
const multiply = (a, b) => fraction(a[0] * b[0], a[1] * b[1])
const divide = (a, b) => fraction(a[0] * b[1], a[1] * b[0])
const sum = values => values.reduce(add, ZERO)

function numeric(value, label) {
  if (value[0] === 0n) return 0
  const negative = value[0] < 0n
  const n = negative ? -value[0] : value[0]
  const d = value[1]
  let exponent = n.toString().length - d.toString().length
  if (exponent >= 0 ? n < d * 10n ** BigInt(exponent) : n * 10n ** BigInt(-exponent) < d) exponent--
  // String conversion avoids Infinity / Infinity for a finite ratio of large integers.
  const scale = 39 - exponent
  const significand = scale >= 0 ? n * 10n ** BigInt(scale) / d : n / (d * 10n ** BigInt(-scale))
  const result = Number(`${negative ? '-' : ''}${significand}e${exponent - 39}`)
  if (!Number.isFinite(result) || result === 0) throw new RangeError(`${label} cannot be represented as a finite nonzero number`)
  return result
}
function centsCeiling(value) {
  return (value[0] * 100n + value[1] - 1n) / value[1]
}
function safeCents(cents, label) {
  if (cents < 0n || cents > MAX_CENTS) throw new RangeError(`${label} exceeds safe integer cents`)
  return Number(cents)
}
function requireObject(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('input must be an object')
}
function validate(input, fields) {
  requireObject(input)
  for (const field of fields) {
    if (typeof input[field] !== 'number' || !Number.isFinite(input[field])) throw new TypeError(`${field} must be a finite number`)
    if (input[field] < 0) throw new RangeError(`${field} must be nonnegative`)
  }
}
function percentBelow100(input, field) {
  if (input[field] >= 100) throw new RangeError(`${field} must be less than 100`)
}

/**
 * @param {object} input See QUOTE_FIELDS. Costs are per unit except other_cost and
 * payment_flat (per job); all *_rate values are per modeled productive hour.
 * minimum_unit_price is rounded UP to cents. sell_total_cents is the authoritative
 * integer total; sell_total is that total divided by 100, not a float multiplication.
 * A zero-revenue quote returns modeled_margin_pct: null because 0/0 is undefined.
 */
export function calculateProfitQuote(input) {
  validate(input, QUOTE_FIELDS)
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) throw new RangeError('quantity must be a positive safe integer')
  if (input.output_hour <= 0) throw new RangeError('output_hour must be greater than zero')
  if (input.spoilage_pct > 100) throw new RangeError('spoilage_pct must be at most 100')
  percentBelow100(input, 'payment_pct')
  percentBelow100(input, 'target_margin_pct')

  const values = Object.fromEntries(QUOTE_FIELDS.map(field => [field, decimal(input[field])]))
  const retained = subtract(ONE, divide(add(values.payment_pct, values.target_margin_pct), HUNDRED))
  if (retained[0] <= 0n) throw new RangeError('combined payment_pct and target_margin_pct sum must be less than 100')
  const materials = multiply(values.quantity, add(ONE, divide(values.spoilage_pct, HUNDRED)))
  const runHours = divide(values.quantity, values.output_hour)
  const hours = add(divide(values.setup_minutes, SIXTY), runHours)
  const costs = {
    garments: multiply(materials, values.garment_cost),
    consumables: multiply(materials, values.consumable_cost),
    machine: multiply(hours, values.machine_rate),
    labor: multiply(hours, values.labor_rate),
    overhead: multiply(hours, values.overhead_rate),
    other: values.other_cost,
  }
  const cost = sum(Object.values(costs))
  const revenueFloor = divide(add(cost, values.payment_flat), retained)
  const unitCents = centsCeiling(divide(revenueFloor, values.quantity))
  const totalCents = unitCents * BigInt(input.quantity)
  const minimumUnitCents = safeCents(unitCents, 'minimum_unit_price')
  const sellTotalCents = safeCents(totalCents, 'sell_total')
  const revenue = fraction(totalCents, 100n)
  const fee = add(multiply(revenue, divide(values.payment_pct, HUNDRED)), values.payment_flat)
  const allCosts = add(cost, fee)
  const profit = subtract(revenue, allCosts)

  return {
    quantity: input.quantity,
    budgeted_material_units: numeric(materials, 'budgeted_material_units'),
    setup_minutes: input.setup_minutes,
    production_minutes: numeric(multiply(runHours, SIXTY), 'production_minutes'),
    total_minutes: numeric(multiply(hours, SIXTY), 'total_minutes'),
    productive_hours: numeric(hours, 'productive_hours'),
    costs: Object.fromEntries(Object.entries(costs).map(([key, value]) => [key, numeric(value, key)])),
    total_cost: numeric(cost, 'total_cost'),
    revenue_floor: numeric(revenueFloor, 'revenue_floor'),
    minimum_unit_cents: minimumUnitCents,
    minimum_unit_price: minimumUnitCents / 100,
    sell_total_cents: sellTotalCents,
    sell_total: sellTotalCents / 100,
    processing_fee: numeric(fee, 'processing_fee'),
    modeled_profit: numeric(profit, 'modeled_profit'),
    modeled_margin_pct: revenue[0] === 0n ? null : numeric(multiply(divide(profit, revenue), HUNDRED), 'modeled_margin_pct'),
    cost_per_productive_hour: numeric(divide(allCosts, hours), 'cost_per_productive_hour'),
    revenue_per_productive_hour: numeric(divide(revenue, hours), 'revenue_per_productive_hour'),
    profit_per_productive_hour: numeric(divide(profit, hours), 'profit_per_productive_hour'),
    spoilage_basis: 'Additive materials budget allowance: quantity × (1 + spoilage_pct / 100); not yield replacement or a purchasing count.',
    time_basis: 'One modeled operation: setup plus quantity / output_hour. All hourly rates and per-hour results include setup time.',
    fee_basis: 'One flat fee per job plus the percentage of selling revenue, unrounded; actual processor rules may differ.',
    warning: QUOTE_WARNING,
  }
}

/**
 * Monthly contribution-margin planning. fixed_cost_month is separate from the
 * variable_cost_pct of revenue. target_profit_month is before tax and unentered
 * expenses. Sales thresholds are rounded UP to cents; forecast profit is unrounded.
 */
export function calculateBreakEven(input) {
  validate(input, MONTH_FIELDS)
  percentBelow100(input, 'variable_cost_pct')
  if (input.productive_hours_month <= 0) throw new RangeError('productive_hours_month must be greater than zero')
  const values = Object.fromEntries(MONTH_FIELDS.map(field => [field, decimal(input[field])]))
  const contribution = subtract(ONE, divide(values.variable_cost_pct, HUNDRED))
  const breakEvenCents = centsCeiling(divide(values.fixed_cost_month, contribution))
  const targetCents = centsCeiling(divide(add(values.fixed_cost_month, values.target_profit_month), contribution))
  const breakEven = safeCents(breakEvenCents, 'break_even_sales') / 100
  const target = safeCents(targetCents, 'target_sales') / 100
  const forecastProfit = subtract(multiply(values.forecast_revenue, contribution), values.fixed_cost_month)
  return {
    contribution_margin_pct: numeric(multiply(contribution, HUNDRED), 'contribution_margin_pct'),
    break_even_sales: breakEven,
    target_sales: target,
    forecast_modeled_profit: numeric(forecastProfit, 'forecast_modeled_profit'),
    break_even_sales_per_hour: numeric(divide(fraction(breakEvenCents, 100n), values.productive_hours_month), 'break_even_sales_per_hour'),
    required_sales_per_hour: numeric(divide(fraction(targetCents, 100n), values.productive_hours_month), 'required_sales_per_hour'),
    warning: MONTH_WARNING,
  }
}

/** Same quote model at each supplied quantity; preserve order and duplicates.
 * input.quantity is replaced by each quantity and may be omitted. An empty list is
 * allowed but still validates the remaining inputs. No supplier discounts assumed.
 */
export function quantityPriceBreaks(input, quantities) {
  requireObject(input)
  if (!Array.isArray(quantities)) throw new TypeError('quantities must be an array')
  if (quantities.length === 0) {
    calculateProfitQuote({ ...input, quantity: 1 })
    return []
  }
  return Array.from(quantities, quantity => calculateProfitQuote({ ...input, quantity }))
}
