import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'

process.env.PSC_DB = ':memory:'
const pricing = await import('../public/js/shared/pricing.js')
const { stripeUnits } = await import('../lib/payment-currency.mjs')

// 13 × ¥1,150 at 7.75% — the invoice a yen shop could never settle.
const YEN_ORDER = [{ description: 'Tee', sizes: { M: 13 }, unit_price: 1150, size_upcharges: {} }]

test('zero-decimal currencies keep money to their own minor unit; dollars are byte-identical', () => {
  assert.equal(pricing.currencyDigits('JPY'), 0)
  assert.equal(pricing.currencyDigits('KRW'), 0)
  assert.equal(pricing.currencyDigits('ISK'), 0)
  assert.equal(pricing.currencyDigits('USD'), 2)
  assert.equal(pricing.currencyDigits('KWD'), 2, 'three-decimal currencies stay at hundredths, as before')
  assert.equal(pricing.currencyDigits('usd'), 2)
  assert.equal(pricing.currencyDigits('nonsense'), 2)

  const usd = pricing.computeTotals(YEN_ORDER, 7.75, {})
  assert.deepEqual(usd, { subtotal: 14950, tax: 1158.63, total: 16108.63 }, 'unset precision is the historical cents rounding')
  for (const n of [1.005, 2.675, -0.5, 1918, 1e400, NaN]) assert.equal(pricing.roundMoney(n, 2), pricing.round2(n))
  try {
    pricing.setMoneyDigits(pricing.currencyDigits('JPY'))
    const yen = pricing.computeTotals(YEN_ORDER, 7.75, {})
    assert.deepEqual(yen, { subtotal: 14950, tax: 1159, total: 16109 })
    assert.equal(pricing.lineAmount({ qty: 3, unit_price: 333.4 }), 1000)
    // The 50% deposit on a ¥16,109 invoice is ¥8,055 — a whole-yen amount Stripe can charge.
    const deposit = pricing.roundMoney(Math.min(16109, 16109 * 0.5))
    assert.equal(deposit, 8055)
    assert.equal(stripeUnits(Math.round(deposit * 100), 'JPY'), 8055)
    assert.equal(Object.is(pricing.roundMoney(-0.4), -0), false, 'never negative zero')
  } finally { pricing.setMoneyDigits(2) }
  assert.deepEqual(pricing.computeTotals(YEN_ORDER, 7.75, {}), usd)
})

test('the server reads money precision from the current shop, and credits respect it', async () => {
  const db = await import('../lib/db.mjs')
  const { addInvoiceCredit, creditRemaining } = await import('../lib/invoice-credits.mjs')
  db.setSetting('currency', 'JPY')
  try {
    assert.deepEqual(db.computeTotals(YEN_ORDER, 7.75, {}), { subtotal: 14950, tax: 1159, total: 16109 })
    db.run("INSERT INTO contacts(id,name,email) VALUES(1,'Yen customer','yen@example.test')")
    db.run("INSERT INTO estimates(id,contact_id,estimate_number,subtotal,tax,total,status) VALUES(1,1,'EST-1',14950,1159,16109,'approved')")
    db.run("INSERT INTO invoices(id,contact_id,estimate_id,invoice_number,amount_due) VALUES(1,1,1,'INV-1',16109)")
    assert.throws(() => addInvoiceCredit(1, { reference: crypto.randomUUID(), subtotal: '100.50', reason: 'Fractional yen' }), /whole units/)
    // The credit dialog pre-fills the PRE-TAX amount still creditable, never the tax-inclusive balance.
    assert.deepEqual(creditRemaining(db.get('SELECT * FROM invoices WHERE id=1')), { subtotal: 14950, tax: 1159, tax_known: true })
    const full = addInvoiceCredit(1, { reference: crypto.randomUUID(), subtotal: 14950, tax: 1159, reason: 'Order cancelled' })
    assert.equal(full.invoice.amount_due, 0)
    assert.deepEqual(creditRemaining(db.get('SELECT * FROM invoices WHERE id=1')), { subtotal: 0, tax: 0, tax_known: true })
  } finally { db.setSetting('currency', 'USD') }
  assert.deepEqual(db.computeTotals(YEN_ORDER, 7.75, {}), { subtotal: 14950, tax: 1158.63, total: 16108.63 })
})

test('invoice.paid re-arms when an invoice stops being paid, and the review latch is persisted', async () => {
  const db = await import('../lib/db.mjs')
  db.run("INSERT INTO contacts(id,name,email) VALUES(2,'Latch customer','latch@example.test')")
  db.run("INSERT INTO invoices(id,contact_id,invoice_number,amount_due) VALUES(2,2,'INV-2',100)")
  db.run('INSERT INTO payments(id,invoice_id,amount) VALUES(20,2,100)')
  assert.equal(db.syncInvoiceStatus(2).status, 'paid')
  db.run("UPDATE invoices SET paid_notified_at='2026-01-01 00:00:00' WHERE id=2")
  assert.equal(db.syncInvoiceStatus(2).paid_notified_at, '2026-01-01 00:00:00', 'staying paid keeps the latch')
  db.run('DELETE FROM payments WHERE id=20')
  const reopened = db.syncInvoiceStatus(2)
  assert.notEqual(reopened.status, 'paid')
  assert.equal(reopened.paid_notified_at, null, 'leaving paid re-arms the announcement')
  const cols = db.all('PRAGMA table_info(estimates)').map((c) => c.name)
  assert.ok(cols.includes('tax_exempt_override'), 'a deliberate exempt-buyer override is a stored fact')
})

test('timed automations never chase a $0 balance or a quote that is already invoiced', async () => {
  const db = await import('../lib/db.mjs')
  const { initAutomations, tick } = await import('../lib/automations.mjs')
  initAutomations(db.getDb())
  db.run("INSERT INTO contacts(id,name,email) VALUES(3,'Zero customer','zero@example.test')")
  db.run("INSERT INTO estimates(id,contact_id,estimate_number,subtotal,tax,total,status,sent_at) VALUES(30,3,'EST-30',0,0,0,'sent','2020-01-01 00:00:00')")
  db.run("INSERT INTO estimates(id,contact_id,estimate_number,subtotal,tax,total,status,sent_at) VALUES(31,3,'EST-31',50,0,50,'sent','2020-01-01 00:00:00')")
  // A stored 'unpaid' with nothing owed (the shape convert used to write for a $0 order).
  db.run("INSERT INTO invoices(id,contact_id,estimate_id,invoice_number,amount_due,status,due_date) VALUES(30,3,30,'INV-30',0,'unpaid','2020-01-01')")
  db.run("INSERT INTO invoices(id,contact_id,invoice_number,amount_due,status,due_date) VALUES(31,3,'INV-31',75,'unpaid','2020-01-01')")
  db.run("INSERT INTO automations(name,trigger,params,actions) VALUES('Chase','invoice.overdue','{\"days\":1}',?)", JSON.stringify([{ key: 'note.log', config: { body: 'Chased' } }]))
  db.run("INSERT INTO automations(name,trigger,params,actions) VALUES('Nudge','estimate.stale','{\"days\":3}',?)", JSON.stringify([{ key: 'note.log', config: { body: 'Nudged' } }]))
  const out = tick({ queueEmail: () => {}, queueSms: () => {} })
  const fired = (out?.fired || out || []).join?.('\n') ?? String(out)
  assert.doesNotMatch(fired, /INV-30/, 'nothing is overdue on an invoice that owes nothing')
  assert.match(fired, /INV-31/)
  assert.doesNotMatch(fired, /EST-30/, 'a quote with a live invoice is not waiting for an answer')
  assert.match(fired, /EST-31/)
})

test('matrix headers that look like numbers are labels first', async () => {
  const { lookupPrice } = await import('../lib/matrices.mjs')
  const m = { rows: ['12-23', '24-47'], cols: ['1', '2', '3', '4'], cells: [[10, 12, 14, 16], [8, 9, 10, 11]], unit: 'piece' }
  assert.equal(lookupPrice(m, { row: '12-23', col: '2' }).price, 12, 'col "2" is the 2-colour column, not the third')
  assert.equal(lookupPrice(m, { row: 0, col: 2 }).price, 14, 'a JSON number is still an index')
  const named = { ...m, cols: ['Front', 'Back'], cells: [[5, 6], [4, 5]] }
  assert.equal(lookupPrice(named, { row: '0', col: '1' }).price, 6, 'a numeric string with no such label falls back to its index (query strings)')
  assert.equal(lookupPrice(named, { row: '24-47', col: 'back' }).price, 5)
})

test('order import statuses: cancelled is skipped, open/due is unpaid, only settled words are paid', async () => {
  const { importOrderStatus, strictImportStatus } = await import('../lib/csv.mjs')
  const cases = {
    '': 'paid', Paid: 'paid', Complete: 'paid', Delivered: 'paid', Shipped: 'paid', Closed: 'paid',
    Cancelled: 'cancelled', Canceled: 'cancelled', Refunded: 'cancelled', Void: 'cancelled',
    Open: 'unpaid', 'Not Paid': 'unpaid', 'Payment Due': 'unpaid', Pending: 'unpaid', Invoiced: 'unpaid', Overdue: 'unpaid',
    Quote: 'quote', Draft: 'quote',
    'In Production': null, 'Partially refunded': null, Approved: null,
  }
  for (const [status, want] of Object.entries(cases)) assert.equal(importOrderStatus(status), want, JSON.stringify(status))
  assert.equal(strictImportStatus('Refunded'), 'cancelled')
  assert.equal(strictImportStatus('complete'), null, 'strict mode still refuses to read completion as payment')
})

test('QuickBooks: a voided invoice is voided there, never pushed as live A/R', async () => {
  const qbo = await import('../lib/quickbooks.mjs')
  let seen
  const fetch = async (url, init) => { seen = { url, body: JSON.parse(init.body) }; return new Response(JSON.stringify({ Invoice: { Id: '1042', SyncToken: '4' } })) }
  const r = await qbo.voidInvoice({ realmId: 'r', accessToken: 't', apiBase: 'https://qbo.test', qboId: '1042', syncToken: '3', fetch })
  assert.deepEqual(r, { ok: true, id: '1042', syncToken: '4' })
  assert.match(seen.url, /\/invoice\?operation=void$/)
  assert.deepEqual(seen.body, { Id: '1042', SyncToken: '3' })
  const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  const inner = src.slice(src.indexOf('async function syncInvoiceToQboInner'))
  assert.ok(inner.indexOf("inv.status === 'void'") > 0 && inner.indexOf("inv.status === 'void'") < inner.indexOf('qbo.pushInvoice('), 'the void check runs before any invoice push')
})
