import test from 'node:test'
import assert from 'node:assert/strict'
import { priceForMargin, raiseToSubtotal, lineBlankCostKnown, computeTotals, margin } from '../public/js/shared/pricing.js'

test('priceForMargin is cost ÷ (1 − target), rounded UP to the cent', () => {
  assert.equal(priceForMargin(55, 45), 100)
  assert.equal(priceForMargin(170.92, 45), 310.77) // 310.763… → never a cent short
  assert.equal(priceForMargin(100, 0), 100, 'a 0% target is break-even')
  assert.equal(priceForMargin('60', '40'), 100, 'numeric strings from settings are accepted')
  assert.equal(priceForMargin(1, 33.3), 1.5)
})
test('the walk-away price always reads as at least the target on margin()', () => {
  for (const cost of [0.01, 1, 7.77, 58.63, 151.34, 170.92, 1531.67, 98765.43]) {
    for (const target of [1, 12.5, 25, 33.3, 40, 45, 50, 62.5, 75, 90, 99]) {
      const p = priceForMargin(cost, target)
      assert.ok(margin(p, cost).margin >= target, `${cost} @ ${target}% → ${p} reads ${margin(p, cost).margin}%`)
      assert.ok(margin(p - 0.01, cost).margin <= target + 0.05 || p - 0.01 <= cost, `${p} is the minimum, not padded`)
    }
  }
})
test('priceForMargin: a target of 100% or more has no price', () => {
  assert.equal(priceForMargin(50, 100), null)
  assert.equal(priceForMargin(50, 150), null)
  assert.equal(priceForMargin(0, 100), null)
})
test('priceForMargin: zero cost needs no revenue', () => {
  assert.equal(priceForMargin(0, 45), 0)
  assert.equal(priceForMargin(0, -20), 0)
})
test('priceForMargin: negative and non-numeric inputs', () => {
  assert.equal(priceForMargin(-10, 45), null, 'a negative cost is not a cost')
  assert.equal(priceForMargin(110, -10), 100, 'a negative target is the price that loses exactly that much')
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, '', 'abc']) {
    assert.equal(priceForMargin(bad, 45), null, `cost ${String(bad)}`)
    assert.equal(priceForMargin(100, bad), null, `target ${String(bad)}`)
  }
})

const tee = (o = {}) => ({ description: 'Gildan 5000', decoration: 'Screen Print', sizes: { M: 20, '2XL': 4 }, unit_price: 10, taxable: true, ...o })
test('raiseToSubtotal scales garment unit prices to reach the target and leaves fees, discounts and upcharges alone', () => {
  const up = { '2XL': 2 }
  const items = [tee(), tee({ sizes: { L: 12 }, unit_price: 14.5 }), { description: 'Setup', qty: 1, unit_price: 30, taxable: false }, { description: 'Discount', qty: 1, unit_price: -25, taxable: true }]
  const before = computeTotals(items, 8.25, up)
  const plan = raiseToSubtotal(items, 600, up)
  assert.deepEqual(plan.changes.map((c) => c.index), [0, 1])
  assert.equal(items[0].unit_price, 10, 'pure: the input is untouched')
  const next = structuredClone(items)
  for (const c of plan.changes) next[c.index].unit_price = c.to
  const after = computeTotals(next, 8.25, up)
  assert.ok(after.subtotal >= 600 && after.subtotal < 600 + 36 * 0.01 + 0.001, `subtotal ${after.subtotal} lands on target within a cent per piece`)
  assert.equal(after.tax, Math.round(Math.max(0, after.subtotal - 30) * 8.25) / 100, 'tax follows the new subtotal through computeTotals')
  assert.ok(before.subtotal < after.subtotal)
  assert.equal(next[2].unit_price, 30); assert.equal(next[3].unit_price, -25)
  const ratio = (c) => c.to / c.from
  assert.ok(Math.abs(ratio(plan.changes[0]) - ratio(plan.changes[1])) < 0.002, 'one common factor, so relative pricing is kept')
})
test('raiseToSubtotal: nothing to do or nothing to scale', () => {
  assert.equal(raiseToSubtotal([tee()], 100, {}), null, 'already above target')
  assert.equal(raiseToSubtotal([tee({ unit_price: 0 })], 100, {}), null, 'no unit price to scale')
  assert.equal(raiseToSubtotal([{ description: 'Fee', qty: 1, unit_price: 10 }], 100, {}), null, 'fees are never scaled')
  assert.equal(raiseToSubtotal([tee({ decoration_pricing: { locations: [] } })], 10000, {}), null, 'an invalid per-location line does not throw')
  assert.equal(raiseToSubtotal([tee()], null, {}), null)
  assert.equal(raiseToSubtotal([tee()], NaN, {}), null)
  assert.equal(raiseToSubtotal(null, 100, {}), null)
})

test('lineBlankCostKnown separates "free" from "unknown"', () => {
  assert.equal(lineBlankCostKnown({ description: 'Custom order' }), false)
  assert.equal(lineBlankCostKnown({ description: 'Garment — 2/0 Front' }), false, 'the calculator description alone says nothing')
  assert.equal(lineBlankCostKnown({ description: 'Garment — 2/0 Front', garment_cost: 4 }), true)
  assert.equal(lineBlankCostKnown({ description: 'x', garment_cost: 0 }), true, 'an explicit 0 is the shop saying the blank is free')
  assert.equal(lineBlankCostKnown({ description: 'x', blank_cost: 5.75 }), true)
  assert.equal(lineBlankCostKnown({ description: 'x', blank_cost: '' }), false)
  assert.equal(lineBlankCostKnown({ description: 'x', garment_cost: -1 }), false)
  assert.equal(lineBlankCostKnown({ description: 'x', matrix: { customerSupplied: true } }), true)
  assert.equal(lineBlankCostKnown({ description: 'Gildan 5000 tees' }), true, 'a catalogue match is a known estimate')
})
