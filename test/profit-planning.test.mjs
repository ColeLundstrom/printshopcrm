import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateProfitQuote, calculateBreakEven, quantityPriceBreaks } from '../public/js/shared/profit-planning.js'

const quote = (changes = {}) => ({
  quantity: 100, garment_cost: 4, consumable_cost: 1, spoilage_pct: 5,
  setup_minutes: 30, output_hour: 100, machine_rate: 20, labor_rate: 30,
  overhead_rate: 10, other_cost: 5, payment_pct: 3, payment_flat: 0.3,
  target_margin_pct: 40, ...changes,
})
const monthly = (changes = {}) => ({
  fixed_cost_month: 6000, variable_cost_pct: 40, target_profit_month: 3000,
  forecast_revenue: 20000, productive_hours_month: 120, ...changes,
})
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 1e-10 * Math.max(1, Math.abs(expected)), `${actual} ≈ ${expected}`)

test('a quote budgets spoilage, setup, production and every explicit cost exactly once', () => {
  const result = calculateProfitQuote(quote())
  assert.equal(result.quantity, 100)
  assert.equal(result.budgeted_material_units, 105)
  assert.equal(result.setup_minutes, 30)
  assert.equal(result.production_minutes, 60)
  assert.equal(result.total_minutes, 90)
  assert.equal(result.productive_hours, 1.5)
  assert.deepEqual(result.costs, { garments: 420, consumables: 105, machine: 30, labor: 45, overhead: 15, other: 5 })
  assert.equal(result.total_cost, 620)
  close(result.revenue_floor, 620.3 / 0.57)
  assert.equal(result.minimum_unit_cents, 1089)
  assert.equal(result.minimum_unit_price, 10.89)
  assert.equal(result.sell_total_cents, 108900)
  assert.equal(result.sell_total, 1089)
  assert.equal(result.processing_fee, 32.97)
  assert.equal(result.modeled_profit, 436.03)
  close(result.modeled_margin_pct, 436.03 / 1089 * 100)
  close(result.cost_per_productive_hour, 652.97 / 1.5)
  assert.equal(result.revenue_per_productive_hour, 726)
  close(result.profit_per_productive_hour, 436.03 / 1.5)
  assert.match(result.spoilage_basis, /allowance/i)
  assert.match(result.time_basis, /one.*operation/i)
  assert.match(result.fee_basis, /unrounded/i)
  assert.match(result.warning, /twice|double.count/i)
})

test('target margin is a share of revenue, never a markup on cost', () => {
  const result = calculateProfitQuote(quote({ quantity: 1, garment_cost: 10, consumable_cost: 0, spoilage_pct: 0,
    setup_minutes: 0, machine_rate: 0, labor_rate: 0, overhead_rate: 0, other_cost: 0,
    payment_pct: 0, payment_flat: 0, target_margin_pct: 50 }))
  assert.equal(result.minimum_unit_price, 20)
  assert.equal(result.modeled_profit, 10)
  assert.equal(result.modeled_margin_pct, 50)
})

test('spoilage is an additive materials allowance, not replacement yield or extra runtime', () => {
  const result = calculateProfitQuote(quote({ quantity: 3, spoilage_pct: 100, setup_minutes: 0, output_hour: 60 }))
  assert.equal(result.budgeted_material_units, 6)
  assert.equal(result.costs.garments, 24)
  assert.equal(result.costs.consumables, 6)
  assert.equal(result.production_minutes, 3)
  const fractional = calculateProfitQuote(quote({ quantity: 3, spoilage_pct: 1 }))
  assert.equal(fractional.budgeted_material_units, 3.03)
})

test('cent pricing rounds up without an extra cent on an exact decimal boundary', () => {
  const base = quote({ quantity: 1, garment_cost: 0.1, consumable_cost: 0.2, spoilage_pct: 0,
    setup_minutes: 0, machine_rate: 0, labor_rate: 0, overhead_rate: 0, other_cost: 0,
    payment_pct: 0, payment_flat: 0, target_margin_pct: 0 })
  assert.equal(calculateProfitQuote(base).minimum_unit_cents, 30)
  assert.equal(calculateProfitQuote({ ...base, garment_cost: 0.100000000000001 }).minimum_unit_cents, 31)
  assert.equal(calculateProfitQuote({ ...base, quantity: 3, garment_cost: 0, consumable_cost: 0, other_cost: 1 }).sell_total, 1.02)
  const thirds = calculateProfitQuote({ ...base, garment_cost: 0, consumable_cost: 0, output_hour: 3, machine_rate: 0.9 })
  assert.equal(thirds.minimum_unit_cents, 30)
})

test('rounded-up prices satisfy the requested margin and the previous cent cannot', () => {
  for (const quantity of [1, 3, 12, 100, 1000]) {
    for (const target_margin_pct of [0, 20, 40, 80, 96.99]) {
      const input = quote({ quantity, target_margin_pct })
      const result = calculateProfitQuote(input)
      assert.ok(result.modeled_margin_pct + 1e-10 >= target_margin_pct)
      const previousRevenue = (result.minimum_unit_cents - 1) * quantity / 100
      const previousProfit = previousRevenue * (1 - input.payment_pct / 100) - result.total_cost - input.payment_flat
      assert.ok(previousProfit < previousRevenue * target_margin_pct / 100)
      assert.equal(result.sell_total_cents, result.minimum_unit_cents * quantity)
    }
  }
})

test('generated plans retain their margin floor across mixed quantities, costs and throughput', () => {
  let seed = 20261010
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
  const amount = maximum => Math.round(random() * maximum * 100) / 100
  for (let i = 0; i < 500; i++) {
    const input = quote({
      quantity: 1 + Math.floor(random() * 10000), garment_cost: amount(100), consumable_cost: amount(10),
      spoilage_pct: amount(100), setup_minutes: amount(120), output_hour: 1 + amount(500),
      machine_rate: amount(200), labor_rate: amount(100), overhead_rate: amount(100),
      other_cost: amount(100), payment_pct: amount(5), payment_flat: amount(1), target_margin_pct: amount(90),
    })
    const result = calculateProfitQuote(input)
    assert.ok(result.modeled_margin_pct + 1e-10 >= input.target_margin_pct)
    assert.equal(result.sell_total_cents, result.minimum_unit_cents * input.quantity)
    close(result.sell_total - result.total_cost - result.processing_fee, result.modeled_profit)
    close(result.cost_per_productive_hour + result.profit_per_productive_hour, result.revenue_per_productive_hour)
  }
})

test('zero-cost quotes have zero revenue and explicitly undefined margin', () => {
  const result = calculateProfitQuote(quote({ garment_cost: 0, consumable_cost: 0, machine_rate: 0,
    labor_rate: 0, overhead_rate: 0, other_cost: 0, payment_flat: 0 }))
  assert.equal(result.sell_total, 0)
  assert.equal(result.modeled_profit, 0)
  assert.equal(result.modeled_margin_pct, null)
  assert.equal(result.cost_per_productive_hour, 0)
})

test('each quote field rejects missing, string, non-finite and negative values', () => {
  for (const field of Object.keys(quote())) {
    for (const value of [undefined, null, '', '2', false, {}, NaN, Infinity, -Infinity]) {
      assert.throws(() => calculateProfitQuote(quote({ [field]: value })), TypeError, `${field}: ${String(value)}`)
    }
    assert.throws(() => calculateProfitQuote(quote({ [field]: -1 })), RangeError, field)
    const missing = quote()
    delete missing[field]
    assert.throws(() => calculateProfitQuote(missing), TypeError, field)
  }
  for (const input of [undefined, null, [], 1, 'quote']) assert.throws(() => calculateProfitQuote(input), TypeError)
})

test('invalid quantity, rate and percentage boundaries fail closed', () => {
  for (const quantity of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => calculateProfitQuote(quote({ quantity })), RangeError)
  assert.throws(() => calculateProfitQuote(quote({ output_hour: 0 })), RangeError)
  assert.throws(() => calculateProfitQuote(quote({ spoilage_pct: 100.01 })), RangeError)
  for (const field of ['payment_pct', 'target_margin_pct']) assert.throws(() => calculateProfitQuote(quote({ [field]: 100 })), RangeError)
  for (const target_margin_pct of [97, 98]) assert.throws(() => calculateProfitQuote(quote({ target_margin_pct })), /sum|combined/i)
  // The decimal sum is exactly 100 although floating subtraction can leave a tiny remainder.
  assert.throws(() => calculateProfitQuote(quote({ payment_pct: 0.1, target_margin_pct: 99.9 })), /sum|combined/i)
  assert.doesNotThrow(() => calculateProfitQuote(quote({ payment_pct: 0, target_margin_pct: 99.999 })))
})

test('unrepresentable totals and overflow never become Infinity or unsafe integer cents', () => {
  for (const changes of [{ garment_cost: Number.MAX_VALUE }, { quantity: Number.MAX_SAFE_INTEGER }, { output_hour: Number.MIN_VALUE }, { other_cost: 1e14 }]) {
    assert.throws(() => calculateProfitQuote(quote(changes)), RangeError)
  }
})

test('quantity price breaks reallocate setup and fixed fees without modifying the input or sorting', () => {
  const input = Object.freeze(quote())
  const quantities = Object.freeze([100, 12, 1000, 12])
  const results = quantityPriceBreaks(input, quantities)
  assert.deepEqual(results.map(row => row.quantity), [...quantities])
  for (let i = 0; i < quantities.length; i++) assert.deepEqual(results[i], calculateProfitQuote({ ...input, quantity: quantities[i] }))
  assert.ok(results[1].minimum_unit_price > results[0].minimum_unit_price)
  assert.ok(results[0].minimum_unit_price > results[2].minimum_unit_price)
  const withoutQuantity = { ...input }
  delete withoutQuantity.quantity
  assert.equal(quantityPriceBreaks(withoutQuantity, [12])[0].quantity, 12)
  assert.deepEqual(quantityPriceBreaks(withoutQuantity, []), [])
  assert.throws(() => quantityPriceBreaks(quote({ garment_cost: NaN }), []), TypeError)
  assert.throws(() => quantityPriceBreaks(input, '12'), TypeError)
  assert.throws(() => quantityPriceBreaks(input, [12, '24']), TypeError)
  assert.throws(() => quantityPriceBreaks(input, [0]), RangeError)
  assert.throws(() => quantityPriceBreaks(input, new Array(2)), TypeError)
})

test('break-even separates fixed costs from variable contribution and target profit', () => {
  const result = calculateBreakEven(monthly())
  assert.equal(result.contribution_margin_pct, 60)
  assert.equal(result.break_even_sales, 10000)
  assert.equal(result.target_sales, 15000)
  assert.equal(result.forecast_modeled_profit, 6000)
  close(result.break_even_sales_per_hour, 10000 / 120)
  assert.equal(result.required_sales_per_hour, 125)
  assert.match(result.warning, /twice|double.count/i)
  assert.equal(calculateBreakEven(monthly({ forecast_revenue: 0 })).forecast_modeled_profit, -6000)
})

test('break-even handles zero fixed costs and ceiling-cent threshold requirements', () => {
  const zero = calculateBreakEven(monthly({ fixed_cost_month: 0, target_profit_month: 0, forecast_revenue: 0 }))
  assert.equal(zero.break_even_sales, 0)
  assert.equal(zero.target_sales, 0)
  assert.equal(zero.forecast_modeled_profit, 0)
  const fractional = calculateBreakEven(monthly({ fixed_cost_month: 1, variable_cost_pct: 70, target_profit_month: 0.01 }))
  assert.equal(fractional.break_even_sales, 3.34)
  assert.equal(fractional.target_sales, 3.37)
  const exact = calculateBreakEven(monthly({ fixed_cost_month: 0.3, variable_cost_pct: 0, target_profit_month: 0.1 }))
  assert.equal(exact.break_even_sales, 0.3)
  assert.equal(exact.target_sales, 0.4)
})

test('every break-even field must be a finite number within its own bounds', () => {
  for (const field of Object.keys(monthly())) {
    for (const value of [undefined, null, '2', NaN, Infinity, false]) assert.throws(() => calculateBreakEven(monthly({ [field]: value })), TypeError, field)
    assert.throws(() => calculateBreakEven(monthly({ [field]: -1 })), RangeError, field)
  }
  assert.throws(() => calculateBreakEven(monthly({ variable_cost_pct: 100 })), RangeError)
  assert.throws(() => calculateBreakEven(monthly({ productive_hours_month: 0 })), RangeError)
  assert.throws(() => calculateBreakEven(monthly({ fixed_cost_month: Number.MAX_VALUE })), RangeError)
  assert.throws(() => calculateBreakEven(monthly({ productive_hours_month: Number.MIN_VALUE })), RangeError)
  assert.doesNotThrow(() => calculateBreakEven(monthly({ variable_cost_pct: 99.999 })))
  for (const input of [undefined, null, [], 'month']) assert.throws(() => calculateBreakEven(input), TypeError)
})
