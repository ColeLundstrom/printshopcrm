import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { utcStampOfLocalMidnight } from '../lib/shop-time.mjs'
import { jobPieces } from '../lib/capacity.mjs'

const root = new URL('..', import.meta.url)
const read = (f) => readFileSync(new URL(f, root), 'utf8')

/** Run `code` in a fresh process against an in-memory shop database. */
function child(code, env = {}) {
  const prelude = `import assert from 'node:assert/strict';const lib=(f)=>import(new URL('lib/'+f, ${JSON.stringify(root.href)}).href);`
  const run = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', prelude + code], {
    env: { ...process.env, PSC_DB: ':memory:', TZ: 'UTC', ...env }, encoding: 'utf8', timeout: 30000,
  })
  assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`)
  return run.stdout
}

test('local midnight as a UTC stamp: the bound "this month" is compared against', () => {
  assert.equal(utcStampOfLocalMidnight('America/Los_Angeles', '2026-11-01'), '2026-11-01 07:00:00') // PDT
  assert.equal(utcStampOfLocalMidnight('America/Los_Angeles', '2026-11-02'), '2026-11-02 08:00:00') // PST, after the change
  assert.equal(utcStampOfLocalMidnight('Asia/Tokyo', '2026-11-01'), '2026-10-31 15:00:00')
  assert.equal(utcStampOfLocalMidnight('Asia/Kolkata', '2026-11-01'), '2026-10-31 18:30:00')
  assert.equal(utcStampOfLocalMidnight('UTC', '2026-11-01'), '2026-11-01 00:00:00')
})

test('a grid-less order stored as "500 pcs" still has pieces for capacity', () => {
  assert.equal(jobPieces({ sizes: '{}', quantities: '500 pcs' }), 500)
  assert.equal(jobPieces({ sizes: '{}', quantities: '1,200 pieces' }), 1200)
  assert.equal(jobPieces({ sizes: '{"M":12,"L":12}', quantities: '500 pcs' }), 24, 'a real size grid still wins')
  assert.equal(jobPieces({ sizes: '{}', quantities: 'ask the customer' }), 0)
})

test('names that go into platform mail are one line', () => {
  child(`
    const { oneLineName } = await lib('tenants.mjs')
    assert.equal(oneLineName('Bob\\n\\nACTION REQUIRED: your card was declined\\tnow'), 'Bob ACTION REQUIRED: your card was declined now')
    assert.equal(oneLineName('  Ink & Thread  '), 'Ink & Thread')
    assert.equal(oneLineName('x'.repeat(300)).length, 80)
    assert.equal(oneLineName(null), '')
  `)
})

test('a document number is never issued twice, even after the newest row is deleted', () => {
  child(`
    const db = await lib('db.mjs')
    db.run("INSERT INTO contacts (name, created_at, updated_at) VALUES ('A', datetime('now'), datetime('now'))")
    const first = db.nextEstimateNumber()
    db.run('INSERT INTO estimates (contact_id, estimate_number, status, items, subtotal, tax, total, created_at) VALUES (1,?,?,?,0,0,0,datetime(\\'now\\'))', first, 'draft', '[]')
    const second = db.nextEstimateNumber()
    db.run('INSERT INTO estimates (contact_id, estimate_number, status, items, subtotal, tax, total, created_at) VALUES (1,?,?,?,0,0,0,datetime(\\'now\\'))', second, 'draft', '[]')
    db.run('DELETE FROM estimates WHERE estimate_number = ?', second)
    const third = db.nextEstimateNumber()
    assert.notEqual(third, second, 'the deleted estimate\\'s number came back')
    assert.equal(Number(third.split('-')[1]), Number(second.split('-')[1]) + 1)
  `)
})

test('profitability: credits come off revenue and a flat decorated line is costed', () => {
  child(`
    const db = await lib('db.mjs'); const { initSuppliers } = await lib('suppliers.mjs'); const { jobRoi } = await lib('roi.mjs')
    initSuppliers(db.getDb())
    db.run("INSERT INTO contacts (name, created_at, updated_at) VALUES ('A', datetime('now'), datetime('now'))")
    const items = JSON.stringify([{ description: 'Gildan 5000 tee — 1/0 Front', decoration: 'Screen Print', qty: 500, unit_price: 8 }])
    db.run("INSERT INTO estimates (contact_id, estimate_number, status, items, subtotal, tax, total, created_at) VALUES (1,'EST-1','approved',?,4000,0,4000,datetime('now'))", items)
    db.run("INSERT INTO invoices (estimate_id, contact_id, invoice_number, status, amount_due, amount_paid, created_at) VALUES (1,1,'INV-1','unpaid',4000,0,datetime('now'))")
    db.run("INSERT INTO jobs (contact_id, estimate_id, invoice_id, job_number, title, status, stage, sizes, quantities, created_at, updated_at) VALUES (1,1,1,'JOB-1','Tees','active','new','{}','500 pcs',datetime('now'),datetime('now'))")
    const job = db.get('SELECT * FROM jobs WHERE id=1')
    const before = jobRoi(job)
    assert.equal(before.revenue, 4000)
    assert.ok(before.cost > 1000, 'a 500-piece decorated run with no size grid was costed at ' + before.cost)
    db.run("INSERT INTO invoice_credits(reference,invoice_id,subtotal_cents,tax_cents,reason,currency,created_at) VALUES('c1',1,200000,0,'Half misprinted','USD',CURRENT_TIMESTAMP)")
    assert.equal(jobRoi(job).revenue, 2000, 'a $2,000 credit must come off the sale')
    assert.equal(jobRoi(job, undefined, null, null, { gross: true }).revenue, 4000, 'costing asks for the gross figure and allocates credits itself')
  `)
})

test('starter automations that reach a customer ship switched off; staff notices stay on', () => {
  child(`
    const db = await lib('db.mjs'); const a = await lib('automations.mjs')
    a.initAutomations(db.getDb()); a.seedAutomations()
    const rows = db.all('SELECT name, enabled, actions FROM automations')
    assert.ok(rows.length >= 10)
    for (const r of rows) {
      const reaches = JSON.parse(r.actions).some((x) => x.key === 'email.customer' || x.key === 'sms.customer')
      assert.equal(r.enabled, reaches ? 0 : 1, r.name)
    }
  `)
})

test('server guards added in 1.39 are still in place', () => {
  const src = read('server.mjs')
  assert.match(src, /code: 'cross_site_request'/, 'cross-site writes on a session must be refused')
  assert.match(src, /code: 'owner_only_payments'/, 'payment destination settings are owner-only')
  assert.match(src, /code: 'estimate_edited_elsewhere'/, 'a stale quote save must be refused')
  assert.match(src, /const withDocumentLink = /, 'document emails carry their link')
  assert.match(src, /function openJobForPaidEstimate\(/, 'an order paid online opens its job')
  assert.match(src, /Sales Tax Payable/, 'the QuickBooks export splits tax out of income')
  assert.match(read('lib/realtime.mjs'), /forbidden origin/, 'the WebSocket checks Origin')
  assert.match(read('lib/db.mjs'), /BEGIN IMMEDIATE/, 'schema bootstrap takes the write lock up front')
})
