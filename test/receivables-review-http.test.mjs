import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createHttpTestServer } from './helpers/http-test-server.mjs'

test('receivables retain every positive balance and expose paused, settled and overpaid reviews without netting customers', { timeout: 120000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'psc-ar-review-')), dest = join(tmp, 'demo')
  const server = await createHttpTestServer()
  let db, control
  try {
    const built = spawnSync(process.execPath, ['bin/demo.mjs', dest, String(server.port)], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 90000 })
    assert.equal(built.status, 0, built.stderr)
    const env = JSON.parse(readFileSync(join(dest, 'demo-env.json'), 'utf8'))
    db = new DatabaseSync(join(dest, 'data/tenants', readdirSync(join(dest, 'data/tenants'))[0], 'printshop.db'))
    db.exec("UPDATE automations SET enabled=0; UPDATE invoices SET status='void',payment_review='';")
    const customer = Number(db.prepare("INSERT INTO contacts(name,company) VALUES('Review customer','Synthetic review shop')").run().lastInsertRowid)
    const insert = db.prepare('INSERT INTO invoices(contact_id,invoice_number,status,amount_due,amount_paid,due_date,payment_review) VALUES(?,?,?,?,?,?,?)')
    const ids = {}
    for (const [number, status, due, paid, review] of [
      ['REVIEW-OPEN', 'partial', 80.15, 20.05, 'Credit changed; verify the balance'],
      ['UNPAUSED', 'unpaid', 0.30, 0.20, ''],
      ['REVIEW-ZERO', 'paid', 0, 0, 'Fully credited; review before collecting'],
      ['REVIEW-OVERPAID', 'paid', 50, 75.25, 'Confirm the customer credit'],
      ['VOID-REVIEW', 'void', 999, 0, 'Excluded void'],
      ['SETTLED', 'paid', 25, 25, ''],
    ]) ids[number] = Number(insert.run(customer, number, status, due, paid, '2020-01-01', review).lastInsertRowid)
    const credit = db.prepare('INSERT INTO invoice_credits(reference,invoice_id,subtotal_cents,tax_cents,reason,currency,cancelled_at,created_at) VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)')
    credit.run('active-review-credit-001', ids['REVIEW-OPEN'], 2000, 150, 'Adjustment', 'USD', '')
    credit.run('cancelled-review-credit-001', ids['REVIEW-OPEN'], 90000, 0, 'Canceled adjustment', 'USD', '2026-01-01 00:00:00')
    credit.run('active-zero-credit-001', ids['REVIEW-ZERO'], 10000, 0, 'Full credit', 'USD', null)
    control = new DatabaseSync(join(dest, 'data/control.db'))
    const owner = control.prepare('SELECT tenant_id,password_hash FROM members LIMIT 1').get()
    const staffId = Number(control.prepare("INSERT INTO members(tenant_id,name,email,password_hash,role,status) VALUES(?,?,?,?,?,?)").run(owner.tenant_id, 'Review staff', 'review-staff@example.test', owner.password_hash, 'staff', 'active').lastInsertRowid)
    const staffToken = 'receivables-review-staff-session'
    control.prepare('INSERT INTO sessions(token,tenant_id,member_id,expires_at) VALUES(?,?,?,?)').run(staffToken, owner.tenant_id, staffId, new Date(Date.now() + 3600000).toISOString().replace('T', ' ').slice(0, 19))
    await server.start({ cwd: dest, env, args: ['--no-warnings', '--import', './bin/demo-network-guard.mjs', 'server.mjs'] })
    const login = await fetch(server.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'dylan@example.test', password: readFileSync(join(dest, 'LOGIN.txt'), 'utf8').match(/Password: (.+)/)[1] }) })
    assert.equal(login.status, 200)
    const cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
    const read = async (auth = cookie) => {
      const r = await fetch(server.base + '/api/reports/ar-aging', { headers: { Cookie: auth }, signal: AbortSignal.timeout(10000) })
      assert.equal(r.status, 200, await r.clone().text()); return r.json()
    }
    assert.equal((await fetch(server.base + '/api/reports/ar-aging')).status, 401)
    const before = db.prepare('SELECT * FROM invoices ORDER BY id').all()
    const report = await read()
    assert.equal(report.totals.due, 60.20)
    assert.equal(report.customers.length, 1)
    assert.equal(report.customers[0].total, 60.20)
    assert.equal(report.collection_review.due, 60.10)
    assert.equal(report.collection_review.unpaused_due, 0.10)
    assert.equal(report.collection_review.count, 3)
    assert.equal(report.collection_review.no_balance_count, 2)
    assert.equal(report.collection_review.overpaid, 25.25)
    const rows = report.collection_review.invoices
    const reviewed = rows.find(i => i.number === 'REVIEW-OPEN')
    assert.equal(reviewed.balance, 60.10)
    assert.equal(reviewed.amount_due, 80.15)
    assert.equal(reviewed.amount_paid, 20.05)
    assert.equal(reviewed.credit_total, 21.50)
    assert.equal(reviewed.payment_review, 'Credit changed; verify the balance')
    assert.equal(rows.find(i => i.number === 'REVIEW-ZERO').credit_total, 100)
    assert.equal(rows.find(i => i.number === 'REVIEW-OVERPAID').balance, -25.25)
    assert(!rows.some(i => ['VOID-REVIEW', 'SETTLED', 'UNPAUSED'].includes(i.number)))
    assert.equal(report.customers[0].invoices.find(i => i.number === 'UNPAUSED').credit_total, 0)
    assert.deepEqual((await read('psc_session=' + staffToken)).collection_review, report.collection_review)
    assert.deepEqual(db.prepare('SELECT * FROM invoices ORDER BY id').all(), before, 'Reading never clears a pause or changes invoice money')
    const signup = await fetch(server.base + '/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shop_name: 'Review neighbor', owner_name: 'Neighbor', owner_email: 'review-neighbor@example.test', password: 'Review-neighbor-fixture-1' }) })
    assert.equal(signup.status, 200, await signup.clone().text())
    const otherCookie = signup.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
    const other = await read(otherCookie)
    assert.equal(other.totals.due, 0)
    assert.deepEqual(other.collection_review, { due: 0, unpaused_due: 0, count: 0, no_balance_count: 0, overpaid: 0, invoices: [] })
    // Fully settled flagged invoices remain visible even when the ordinary A/R table is empty.
    db.prepare('UPDATE invoices SET amount_paid=amount_due WHERE id IN (?,?)').run(ids['REVIEW-OPEN'], ids.UNPAUSED)
    const settled = await read()
    assert.equal(settled.totals.due, 0)
    assert.equal(settled.customers.length, 0)
    assert.equal(settled.collection_review.count, 3)
    assert.equal(settled.collection_review.due, 0)
    // Follow the real credit lifecycle through authenticated routes, with no provider or cash action.
    const lifecycleId = Number(insert.run(customer, 'CREDIT-LIFECYCLE', 'unpaid', 100, 0, null, '').lastInsertRowid)
    const change = (path, body, auth = cookie) => fetch(server.base + path, { method: 'POST', headers: { Cookie: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const creditBody = { reference: 'ar-review-lifecycle-credit-001', subtotal: 25, tax: 0, reason: 'Synthetic allowance' }
    assert.equal((await change('/api/invoices/' + lifecycleId + '/credits', creditBody, 'psc_session=' + staffToken)).status, 403)
    assert.equal((await change('/api/invoices/' + lifecycleId + '/credits', creditBody)).status, 200)
    let lifecycle = await read()
    assert.equal(lifecycle.totals.due, 75)
    assert.equal(lifecycle.collection_review.due, 75)
    assert.equal(lifecycle.collection_review.invoices.find(i => i.id === lifecycleId).credit_total, 25)
    assert.equal((await change('/api/invoices/' + lifecycleId + '/credits/' + creditBody.reference + '/cancel', { reason: 'Synthetic correction' })).status, 200)
    lifecycle = await read()
    assert.equal(lifecycle.totals.due, 100)
    assert.equal(lifecycle.collection_review.due, 100)
    assert.equal(lifecycle.collection_review.invoices.find(i => i.id === lifecycleId).credit_total, 0)
    assert.equal((await change('/api/invoices/' + lifecycleId + '/payment-review', { note: 'Reviewed synthetic balance' }, 'psc_session=' + staffToken)).status, 403)
    assert.equal((await change('/api/invoices/' + lifecycleId + '/payment-review', { note: 'Reviewed synthetic balance' })).status, 200)
    lifecycle = await read()
    assert.equal(lifecycle.collection_review.due, 0)
    assert.equal(lifecycle.collection_review.unpaused_due, 100)
    assert.equal(lifecycle.collection_review.count, 3)
  } finally { await server.close(); db?.close(); control?.close(); rmSync(tmp, { recursive: true, force: true }) }
})
