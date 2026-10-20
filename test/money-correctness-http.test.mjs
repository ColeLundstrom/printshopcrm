import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHttpTestServer } from './helpers/http-test-server.mjs'

test('money correctness over HTTP: currency precision, paid announcements, line validation, imports and tax overrides', { timeout: 180000 }, async t => {
  const temp = mkdtempSync(join(tmpdir(), 'psc-money-')), dest = join(temp, 'demo'), server = await createHttpTestServer()
  let db, control
  try {
    const built = spawnSync(process.execPath, ['bin/demo.mjs', dest, String(server.port)], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 120000 })
    assert.equal(built.status, 0, built.stderr)
    const env = JSON.parse(readFileSync(join(dest, 'demo-env.json'), 'utf8')); env.PSC_TICK_MS = '3600000'
    db = new DatabaseSync(join(dest, 'data/tenants', readdirSync(join(dest, 'data/tenants'))[0], 'printshop.db'))
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000')
    control = new DatabaseSync(join(dest, 'data/control.db'))
    const owner = control.prepare('SELECT * FROM members LIMIT 1').get()
    control.prepare("INSERT INTO sessions(token,tenant_id,member_id,expires_at) VALUES(?,?,?,datetime('now','+1 hour'))").run('money-owner', owner.tenant_id, owner.id)
    await server.start({ cwd: dest, env, args: ['--no-warnings', '--import', './bin/demo-network-guard.mjs', 'server.mjs'] })
    const req = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
      const r = await fetch(server.base + path, { method, headers: { 'Content-Type': 'application/json', cookie: 'psc_session=money-owner' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) })
      return { status: r.status, body: await r.json().catch(() => ({})) }
    }
    const ok = async (path, body, method) => { const r = await req(path, body, method); assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}`); return r.body }
    const customer = await ok('/api/contacts', { name: 'Money fixture customer', email: 'money-fixture@example.test' })
    const quote = (items, extra = {}) => req('/api/estimates', { contact_id: customer.id, items, ...extra })
    const invoiceFor = async (items, extra) => {
      const e = await quote(items, extra); assert.equal(e.status, 200, JSON.stringify(e.body))
      const conv = await ok(`/api/estimates/${e.body.id}/convert`, {})
      return { estimate: e.body, invoice: db.prepare('SELECT * FROM invoices WHERE id=?').get(conv.invoice_id) }
    }

    await t.test('a yen invoice totals to whole yen and can be paid in full', async () => {
      await ok('/api/settings', { currency: 'JPY' }, 'PUT')
      try {
        const { estimate, invoice } = await invoiceFor([{ description: 'Yen tee', sizes: { M: 13 }, unit_price: 1150 }], { tax_rate: 7.75 })
        assert.deepEqual([estimate.subtotal, estimate.tax, estimate.total], [14950, 1159, 16109])
        assert.equal(invoice.amount_due, 16109)
        const paid = await ok(`/api/invoices/${invoice.id}/payments`, { amount: 16109, method: 'cash' })
        assert.equal(paid.status, 'paid')
        assert.equal(paid.amount_paid, 16109)
      } finally { await ok('/api/settings', { currency: 'USD' }, 'PUT') }
    })

    await t.test('a payment settled under review is announced once, when the review clears', async () => {
      db.prepare("INSERT INTO automations(name,trigger,actions) VALUES('Money fixture paid note','invoice.paid',?)").run(JSON.stringify([{ key: 'note.log', config: { body: 'Paid fixture' } }]))
      const { estimate, invoice } = await invoiceFor([{ description: 'Review tee', qty: 10, unit_price: 10 }])
      const runs = () => db.prepare("SELECT count(*) n FROM automation_runs WHERE trigger='invoice.paid' AND automation_name='Money fixture paid note' AND entity_id=?").get(invoice.id).n
      const stage = () => db.prepare('SELECT board_stage FROM estimates WHERE id=?').get(estimate.id).board_stage
      db.prepare("UPDATE invoices SET payment_review='Fixture review' WHERE id=?").run(invoice.id)
      assert.equal((await ok(`/api/invoices/${invoice.id}/payments`, { amount: invoice.amount_due, method: 'check' })).status, 'paid')
      assert.equal(runs(), 0, 'nothing is announced while the payment is under review')
      assert.notEqual(stage(), 'paid')
      await ok(`/api/invoices/${invoice.id}/payment-review`, { note: 'Verified the cheque cleared' })
      assert.equal(runs(), 1, 'clearing the review announces the payoff')
      assert.equal(stage(), 'paid', 'and the order card reaches Paid')
      db.prepare("UPDATE invoices SET payment_review='Second fixture review' WHERE id=?").run(invoice.id)
      await ok(`/api/invoices/${invoice.id}/payment-review`, { note: 'Reviewed again' })
      assert.equal(runs(), 1, 'never twice for the same payoff')
      // An ordinary payoff still announces exactly once.
      const plain = await invoiceFor([{ description: 'Plain tee', qty: 2, unit_price: 10 }])
      await ok(`/api/invoices/${plain.invoice.id}/payments`, { amount: plain.invoice.amount_due, method: 'cash' })
      assert.equal(db.prepare("SELECT count(*) n FROM automation_runs WHERE trigger='invoice.paid' AND automation_name='Money fixture paid note' AND entity_id=?").get(plain.invoice.id).n, 1)
    })

    await t.test('client-supplied size upcharges, size keys, counts, taxable and quantities are validated', async () => {
      const tee = (extra) => [{ description: 'Validated tee', sizes: { M: 50 }, unit_price: 10, ...extra }]
      assert.equal((await quote(tee({ size_upcharges: { M: 1e306 } }))).status, 400, 'an overflowing upcharge is refused, not stored as $0')
      assert.equal((await quote(tee({ size_upcharges: { M: -9.99 } }))).status, 400, 'a negative upcharge is refused')
      assert.equal((await quote(tee({ size_upcharges: { '<b>': 1 } }))).status, 400)
      assert.equal((await quote(tee({ size_upcharges: { m: 1, M: 2 } }))).status, 400, 'an ambiguous table is refused')
      const fine = await quote(tee({ size_upcharges: { M: 1 } }))
      assert.equal(fine.status, 200); assert.equal(fine.body.subtotal, 550)
      const collide = await quote([{ description: 'Case collision', sizes: { m: 10, M: 5 }, unit_price: 10, size_upcharges: {} }])
      assert.equal(collide.status, 200); assert.equal(collide.body.items[0].sizes.M, 15); assert.equal(collide.body.subtotal, 150, '{m:10, M:5} is fifteen mediums')
      const frac = await quote([{ description: 'Fraction', sizes: { M: 10.5 }, unit_price: 10, size_upcharges: {} }])
      assert.equal(frac.body.items[0].sizes.M, 10); assert.equal(frac.body.subtotal, 100)
      const exempt = await quote([{ description: 'Taxable', qty: 1, unit_price: 100 }, { description: 'Freight', qty: 1, unit_price: 50, taxable: 'false' }], { tax_rate: 10 })
      assert.equal(exempt.status, 200); assert.equal(exempt.body.tax, 10, 'taxable:"false" is not taxed'); assert.equal(exempt.body.items[1].taxable, false)
      assert.equal((await quote([{ description: 'Bad taxable', qty: 1, unit_price: 1, taxable: 'no' }])).status, 400)
      assert.equal((await quote([{ description: 'Huge', qty: 1e12, unit_price: 5 }])).status, 400, 'a flat quantity above MAX_PIECES is refused')
      const draft = await quote([{ description: 'Edit me', qty: 1, unit_price: 5 }])
      assert.equal((await req(`/api/estimates/${draft.body.id}`, { items: [{ description: 'Huge', quantity: 2e6, unit_price: 5 }] }, 'PUT')).status, 400)
    })

    await t.test('a $0 order is not stored unpaid or chased as overdue', async () => {
      const { invoice } = await invoiceFor([{ description: 'Free sample', qty: 1, unit_price: 0 }])
      assert.equal(invoice.status, 'paid')
      db.prepare("INSERT INTO invoices(contact_id,invoice_number,amount_due,status,due_date) VALUES(?,'LEGACY-ZERO',0,'unpaid','2020-01-01')").run(customer.id)
      const followups = await ok('/api/followups')
      assert.ok(!followups.overdue.some((i) => i.invoice_number === 'LEGACY-ZERO' || i.id === invoice.id), 'nothing owed, nothing overdue')
    })

    await t.test('an invoiced quote is not on the stale list', async () => {
      const e = await quote([{ description: 'Website gang sheet', qty: 1, unit_price: 40 }])
      db.prepare("UPDATE estimates SET status='sent', sent_at='2020-01-01 00:00:00' WHERE id=?").run(e.body.id)
      assert.ok((await ok('/api/followups')).stale.some((s) => s.id === e.body.id))
      db.prepare("INSERT INTO invoices(estimate_id,contact_id,invoice_number,amount_due,amount_paid,status) VALUES(?,?,'WEB-PAID',40,40,'paid')").run(e.body.id, customer.id)
      assert.ok(!(await ok('/api/followups')).stale.some((s) => s.id === e.body.id), 'a paying customer is not chased about a quote')
    })

    await t.test('a payment already in QuickBooks is not deleted locally without saying it was reversed there', async () => {
      const { invoice } = await invoiceFor([{ description: 'Books tee', qty: 1, unit_price: 30 }])
      await ok(`/api/invoices/${invoice.id}/payments`, { amount: 30, method: 'check' })
      const p = db.prepare('SELECT id FROM payments WHERE invoice_id=?').get(invoice.id)
      db.prepare("UPDATE payments SET qbo_id='77' WHERE id=?").run(p.id)
      const refused = await req(`/api/payments/${p.id}`, undefined, 'DELETE')
      assert.equal(refused.status, 409); assert.equal(refused.body.code, 'qbo_synced_payment')
      assert.ok(db.prepare('SELECT 1 FROM payments WHERE id=?').get(p.id))
      assert.equal((await req(`/api/payments/${p.id}`, { qbo_reversed: true }, 'DELETE')).status, 200)
      assert.equal(db.prepare('SELECT 1 FROM payments WHERE id=?').get(p.id), undefined)
    })

    await t.test('order import: statuses, historical upcharges and quantity caps', async () => {
      const csv = [
        'Order #,Customer,Email,Date,Status,Product,M,2XL,Unit Price',
        'IMP-1,Import Fixture,import-fixture@example.test,2026-03-01,Paid,Tee,5,5,10',
        'IMP-2,Import Fixture,import-fixture@example.test,2026-03-02,Cancelled,Tee,5,0,10',
        'IMP-3,Import Fixture,import-fixture@example.test,2026-03-03,Refunded,Tee,5,0,10',
        'IMP-4,Import Fixture,import-fixture@example.test,2026-03-04,Open,Tee,5,0,10',
        'IMP-5,Import Fixture,import-fixture@example.test,2026-03-05,Payment Due,Tee,5,0,10',
        'IMP-6,Import Fixture,import-fixture@example.test,2026-03-06,Not Paid,Tee,5,0,10',
      ].join('\n')
      const r = await ok('/api/import/orders', { text: csv })
      assert.equal(r.imported, 4); assert.equal(r.skipped_cancelled, 2); assert.equal(r.unpaid_invoices, 3)
      const inv = (ref) => db.prepare('SELECT i.* FROM invoices i JOIN estimates e ON e.id=i.estimate_id WHERE e.source_ref=?').get(ref)
      assert.equal(inv('IMP-1').status, 'paid')
      assert.equal(inv('IMP-1').amount_due, 100, "today's 2XL upcharge is not added to a historical line")
      assert.deepEqual(JSON.parse(db.prepare("SELECT items FROM estimates WHERE source_ref='IMP-1'").get().items)[0].size_upcharges, {})
      for (const ref of ['IMP-4', 'IMP-5', 'IMP-6']) { assert.equal(inv(ref).status, 'unpaid', ref); assert.equal(inv(ref).amount_paid, 0) }
      assert.equal(inv('IMP-2'), undefined)
      const unknown = await req('/api/import/orders', { text: 'Order #,Customer,Email,Date,Status,Product,Qty,Unit Price\nIMP-7,Import Fixture,import-fixture@example.test,2026-03-07,In Production,Tee,5,10' })
      assert.equal(unknown.status, 400); assert.equal(unknown.body.code, 'import_status_review')
      const huge = await req('/api/import/orders', { text: 'Order #,Customer,Email,Date,Status,Product,Qty,Unit Price\nIMP-8,Import Fixture,import-fixture@example.test,2026-03-08,Paid,Tee,99999999,5' })
      assert.equal(huge.status, 400); assert.equal(huge.body.code, 'import_quantity')
      assert.equal(db.prepare("SELECT count(*) n FROM estimates WHERE source_ref IN ('IMP-7','IMP-8')").get().n, 0)
    })

    await t.test('contact import refuses a row with two email addresses, with a reason', async () => {
      const r = await ok('/api/import/contacts', { text: 'Name,Email\nTwo Address Co,"a@example.test, b@example.test"\nOne Address Co,one-address@example.test' })
      assert.equal(r.created, 1)
      assert.equal(r.rejected.length, 1); assert.match(r.rejected[0].reason, /single email address/)
      assert.equal(db.prepare("SELECT count(*) n FROM contacts WHERE name='Two Address Co'").get().n, 0)
    })

    await t.test('a deliberate tax on an exempt buyer survives unrelated edits and duplication', async () => {
      const resale = await ok('/api/contacts', { name: 'Resale fixture', email: 'resale-fixture@example.test', tax_exempt: true })
      const e = await ok('/api/estimates', { contact_id: resale.id, items: [{ description: 'Personal-use tees', qty: 10, unit_price: 10 }], tax_rate: 8, tax_exempt_override: true })
      assert.equal(e.tax, 8)
      const resaved = await ok(`/api/estimates/${e.id}`, {}, 'PUT')
      assert.equal(resaved.tax, 8); assert.equal(resaved.quote_revised, false, 'a save that changes nothing does not revise the quote or revoke its approval')
      const edited = await ok(`/api/estimates/${e.id}`, { notes: 'Delivery on Friday' }, 'PUT')
      assert.equal(edited.tax, 8, 'a notes edit keeps the deliberate tax')
      const viewed = await ok(`/api/estimates/${e.id}`)
      const copy = await ok(`/api/estimates/${e.id}/duplicate`, { request_id: 'money-override-copy', commercial_revision: viewed.commercial_revision, source_identity: viewed.source_identity })
      assert.equal(db.prepare('SELECT tax FROM estimates WHERE id=?').get(copy.id).tax, 8, 'the copy for the same buyer keeps it')
      const cleared = await ok(`/api/estimates/${e.id}`, { tax_exempt_override: false }, 'PUT')
      assert.equal(cleared.tax, 0, 'and it can still be switched off explicitly')
    })

    await t.test('the credit dialog is offered the pre-tax remaining amount', async () => {
      const { invoice } = await invoiceFor([{ description: 'Credit tee', qty: 10, unit_price: 10 }], { tax_rate: 10 })
      assert.equal(invoice.amount_due, 110)
      const ref = await ok(`/api/invoices/${invoice.id}/credit-reference`)
      assert.equal(ref.remaining.subtotal, 100); assert.equal(ref.remaining.tax, 10)
      const credited = await ok(`/api/invoices/${invoice.id}/credits`, { reference: ref.reference, subtotal: ref.remaining.subtotal, tax: ref.remaining.tax, reason: 'Whole order cancelled' })
      assert.equal(credited.invoice.amount_due, 0)
    })

    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  } finally { await server.close(); db?.close(); control?.close(); rmSync(temp, { recursive: true, force: true }) }
})
