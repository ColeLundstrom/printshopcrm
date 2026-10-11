import test from 'node:test'
import assert from 'node:assert/strict'
import { collectionReview, receivableInvoice } from '../lib/receivables-review.mjs'

test('the report shows credits as evidence, without deducting them twice or calling them cash', () => {
  const invoice = { id: 1, invoice_number: 'INV-1', amount_due: 75.29, amount_paid: 25.10, payment_review: 'Review credit', status: 'partial' }
  const before = structuredClone(invoice)
  const report = receivableInvoice(invoice, new Map([[1, 2471]]))
  assert.equal(report.balance, 50.19)
  assert.equal(report.credit_total, 24.71)
  assert.equal(report.amount_paid, 25.10)
  assert.deepEqual(invoice, before)
  assert.equal(receivableInvoice({ ...invoice, amount_due: 0, amount_paid: 0 }).balance, 0)
  assert.equal(receivableInvoice({ id: 2 }).credit_total, 0)
  assert.equal(receivableInvoice({ id: 2 }).payment_review, '')
})

test('cent sums stay exact at scale and nonpositive flagged invoices never reduce another invoice balance', () => {
  const invoices = Array.from({ length: 10000 }, (_, id) => receivableInvoice({ id, amount_due: 0.3, amount_paid: 0.2, payment_review: id % 2 ? 'Review' : '', status: 'partial' }))
  invoices.push(receivableInvoice({ id: 10001, amount_due: 100, amount_paid: 100.01, payment_review: 'Credit balance', status: 'paid' }))
  invoices.push(receivableInvoice({ id: 10002, amount_due: 0, amount_paid: 0, payment_review: 'Fully credited', status: 'paid' }))
  invoices.push(receivableInvoice({ id: 10003, amount_due: 999, amount_paid: 0, payment_review: 'Void', status: 'void' }))
  const report = collectionReview(invoices)
  assert.equal(report.due, 500)
  assert.equal(report.unpaused_due, 500)
  assert.equal(report.overpaid, 0.01)
  assert.equal(report.no_balance_count, 2)
  assert.equal(report.count, 5002)
  assert.deepEqual(collectionReview([]), { due: 0, unpaused_due: 0, count: 0, no_balance_count: 0, overpaid: 0, invoices: [] })
})
