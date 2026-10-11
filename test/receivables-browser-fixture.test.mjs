import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { seedReceivablesReview, receivablesSnapshot } from './browser/receivables-fixture.mjs'
import { receivableInvoice, collectionReview } from '../lib/receivables-review.mjs'

test('browser fixture records coherent credits and payments with exact expected review totals', async () => {
  process.env.PSC_DB = ':memory:'
  const { initDb } = await import('../lib/db.mjs')
  const { initAutomations } = await import('../lib/automations.mjs')
  const db = new DatabaseSync(':memory:')
  try {
    initDb(db); initAutomations(db)
    const fixture = seedReceivablesReview(db), before = receivablesSnapshot(db)
    assert.equal(Object.keys(fixture.ids).length, 6)
    const credits = new Map(db.prepare('SELECT invoice_id,SUM(subtotal_cents+tax_cents) cents FROM invoice_credits WHERE cancelled_at IS NULL GROUP BY invoice_id').all().map(c => [c.invoice_id, c.cents]))
    const invoices = db.prepare('SELECT * FROM invoices').all()
    for (const i of invoices) {
      const cash = db.prepare('SELECT COALESCE(SUM(amount),0) total FROM payments WHERE invoice_id=?').get(i.id).total
      assert.equal(cash, i.amount_paid)
      if (i.credit_base) assert.equal(Math.round(JSON.parse(i.credit_base).amount_due * 100) - credits.get(i.id), Math.round(i.amount_due * 100))
    }
    const review = collectionReview(invoices.map(i => receivableInvoice(i, credits)))
    assert.equal(review.due, 60.10); assert.equal(review.unpaused_due, 0.10)
    assert.equal(review.count, 3); assert.equal(review.no_balance_count, 2); assert.equal(review.overpaid, 25.25)
    assert.deepEqual(receivablesSnapshot(db), before)
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { db.close() }
})

test('Books browser smoke uses isolated pinned tooling, guards, real screenshots and explicit evidence', () => {
  const source = readFileSync(new URL('./browser/receivables-review-smoke.mjs', import.meta.url), 'utf8')
  assert.match(source, /\.browser-tools\/node_modules\/playwright/)
  assert.match(source, /1\.64\.0/)
  assert.match(source, /channel: 'chrome'.*chromiumSandbox: true/)
  assert(!source.includes('--no-sandbox'))
  assert.match(source, /demo-network-guard\.mjs/)
  assert.match(source, /isolateBrowser\(/)
  assert.match(source, /serviceWorkers: 'block'/)
  assert.match(source, /unexpectedWrites\.push/)
  assert.match(source, /route\.abort\('blockedbyclient'\)/)
  assert.match(source, /page\.screenshot\(/)
  assert.match(source, /receivables-review-report\.json/)
  assert.match(source, /receivablesSnapshot\(db\), before/)
  assert.match(source, /page\.goBack\(\)/)
  assert.match(source, /page\.goForward\(\)/)
  assert(!source.includes('storageState('), 'Never save demo session state with review evidence')
})
