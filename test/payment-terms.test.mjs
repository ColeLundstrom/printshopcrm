import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createHttpTestServer } from './helpers/http-test-server.mjs'
import { paymentDueDate } from '../lib/payment-terms.mjs'

test('date-only terms cross leap days, year end and daylight-saving boundaries without local-clock drift', () => {
  assert.equal(paymentDueDate('due_on_receipt', '2028-02-29'), '2028-02-29')
  assert.equal(paymentDueDate('net_30', '2028-02-29'), '2028-03-30')
  assert.equal(paymentDueDate('net_15', '2026-12-25'), '2027-01-09')
  assert.equal(paymentDueDate('net_45', '2026-10-31'), '2026-12-15')
  assert.equal(paymentDueDate('net_15', '2027-03-07'), '2027-03-22')
})

test('customer payment terms set invoice due dates while production dates and old invoices stay fixed', { timeout: 120000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'psc-payment-terms-')), dest = join(tmp, 'demo')
  const server = await createHttpTestServer()
  let control
  try {
    const built = spawnSync(process.execPath, ['bin/demo.mjs', dest, String(server.port)], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 90000 })
    assert.equal(built.status, 0, built.stderr)
    const env = JSON.parse(readFileSync(join(dest, 'demo-env.json'), 'utf8'))
    control = new DatabaseSync(join(dest, 'data', 'control.db'))
    const owner = control.prepare('SELECT id,tenant_id,password_hash FROM members LIMIT 1').get()
    const staffId = Number(control.prepare("INSERT INTO members(tenant_id,name,email,password_hash,role,status) VALUES(?,?,?,?,?,?)").run(owner.tenant_id, 'Terms staff fixture', 'terms-staff@example.test', owner.password_hash, 'staff', 'active').lastInsertRowid)
    const staffToken = 'terms-staff-session-' + staffId
    control.prepare('INSERT INTO sessions(token,tenant_id,member_id,expires_at) VALUES(?,?,?,?)').run(staffToken, owner.tenant_id, staffId, new Date(Date.now() + 3600000).toISOString().replace('T', ' ').slice(0, 19))
    await server.start({ cwd: dest, env, args: ['--no-warnings', '--import', './bin/demo-network-guard.mjs', 'server.mjs'] })
    const login = await fetch(server.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'dylan@example.test', password: readFileSync(join(dest, 'LOGIN.txt'), 'utf8').match(/Password: (.+)/)[1] }) })
    assert.equal(login.status, 200)
    const cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
    const req = (path, body, method = body === undefined ? 'GET' : 'POST') => fetch(server.base + path, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) })
    const ok = async (path, body, method) => { const r = await req(path, body, method); assert.equal(r.status, 200, await r.clone().text()); return r.json() }
    const customer = await ok('/api/contacts', { name: 'Terms fixture', payment_term: 'net_30' })
    assert.equal(customer.payment_term, 'net_30')
    assert.equal((await fetch(server.base + '/api/contacts/' + customer.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payment_term: 'due_on_receipt' }) })).status, 401)
    const staffEdit = await fetch(server.base + '/api/contacts/' + customer.id, { method: 'PUT', headers: { Cookie: 'psc_session=' + staffToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ payment_term: 'net_30' }) })
    assert.equal(staffEdit.status, 200, await staffEdit.text())
    const neighbor = await req('/api/auth/signup', { shop_name: 'Terms neighbor', owner_name: 'Neighbor', owner_email: 'terms-neighbor@example.test', password: 'Terms-neighbor-fixture-1' })
    assert.equal(neighbor.status, 200, await neighbor.clone().text())
    const neighborCookie = neighbor.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
    const otherRequest = (path, body, method = body === undefined ? 'GET' : 'POST') => fetch(server.base + path, { method, headers: { Cookie: neighborCookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    assert.equal((await otherRequest('/api/contacts/' + customer.id)).status, 404)
    assert.equal((await otherRequest('/api/contacts/' + customer.id, { payment_term: 'due_on_receipt' }, 'PUT')).status, 404)
    const bad = await req('/api/contacts/' + customer.id, { payment_term: 'net_999' }, 'PUT')
    assert.equal(bad.status, 400)
    assert.equal((await req('/api/contacts/' + customer.id, { payment_term: null }, 'PUT')).status, 400)
    assert.equal((await req('/api/contacts', { name: 'Rejected null term', payment_term: null })).status, 400)
    assert.equal((await ok('/api/contacts/' + customer.id)).contact.payment_term, 'net_30')
    const estimate = await ok('/api/estimates', { contact_id: customer.id, items: [{ description: 'Synthetic tees', sizes: { M: 12 }, unit_price: 10 }], tax_rate: 0 })
    const detail = await ok('/api/estimates/' + estimate.id)
    assert.equal(detail.customer_payment_term, 'net_30')
    assert.equal((await otherRequest('/api/estimates/' + estimate.id)).status, 404)
    assert.equal((await otherRequest('/api/estimates/' + estimate.id + '/convert', {})).status, 404)
    assert.equal((await req('/api/estimates/' + estimate.id + '/convert', { commercial_revision: detail.commercial_revision + 1 })).status, 409)
    assert.equal((await req('/api/estimates/' + estimate.id + '/convert', { commercial_revision: detail.commercial_revision, payment_term: 'net_999' })).status, 400)
    assert.equal((await req('/api/estimates/' + estimate.id + '/convert', { commercial_revision: detail.commercial_revision, payment_term: null })).status, 400)
    assert.equal((await req('/api/estimates/' + estimate.id + '/convert', { commercial_revision: detail.commercial_revision, payment_due_date: '2027-02-30' })).status, 400)
    assert.equal((await req('/api/estimates/' + estimate.id + '/convert', { commercial_revision: detail.commercial_revision, due_date: 'not-a-date' })).status, 400)
    assert.equal((await ok('/api/estimates/' + estimate.id)).invoice, undefined)
    const before = new Date().toISOString().slice(0, 10)
    const converted = await ok('/api/estimates/' + estimate.id + '/convert', { commercial_revision: detail.commercial_revision, production_due_date: '2027-02-12' })
    const due = (await ok('/api/invoices/' + converted.invoice_id)).due_date
    const expected = new Date(Date.parse(before + 'T00:00:00Z') + 30 * 864e5).toISOString().slice(0, 10)
    assert.equal(due, expected)
    assert.equal((await ok('/api/jobs/' + converted.job_id)).due_date, '2027-02-12')
    assert.equal((await req('/api/estimates/' + estimate.id + '/convert', {})).status, 409)
    await ok('/api/contacts/' + customer.id, { payment_term: 'due_on_receipt' }, 'PUT')
    assert.equal((await ok('/api/invoices/' + converted.invoice_id)).due_date, due)
    const next = await ok('/api/estimates', { contact_id: customer.id, items: [{ description: 'More tees', sizes: { M: 5 }, unit_price: 10 }], tax_rate: 0 })
    const nextDetail = await ok('/api/estimates/' + next.id)
    const nextConverted = await ok('/api/estimates/' + next.id + '/convert', { commercial_revision: nextDetail.commercial_revision, payment_due_date: '2027-04-01' })
    assert.equal((await ok('/api/invoices/' + nextConverted.invoice_id)).due_date, '2027-04-01')
    const third = await ok('/api/estimates', { contact_id: customer.id, items: [{ description: 'Another synthetic order', sizes: { L: 2 }, unit_price: 10 }], tax_rate: 0 })
    const thirdDetail = await ok('/api/estimates/' + third.id)
    const thirdConverted = await ok('/api/estimates/' + third.id + '/convert', { commercial_revision: thirdDetail.commercial_revision, payment_term: 'net_45' })
    const fortyFive = new Date(Date.parse(before + 'T00:00:00Z') + 45 * 864e5).toISOString().slice(0, 10)
    assert.equal((await ok('/api/invoices/' + thirdConverted.invoice_id)).due_date, fortyFive)
    const fourth = await ok('/api/estimates', { contact_id: customer.id, items: [{ description: 'Concurrent fixture', sizes: { M: 2 }, unit_price: 10 }], tax_rate: 0 })
    const fourthDetail = await ok('/api/estimates/' + fourth.id)
    const attempts = await Promise.all([0, 1].map(() => req('/api/estimates/' + fourth.id + '/convert', { commercial_revision: fourthDetail.commercial_revision })))
    assert.deepEqual(attempts.map(r => r.status).sort(), [200, 409])
    const record = await ok('/api/estimates/' + fourth.id)
    assert.equal(record.invoice.id, (await attempts.find(r => r.status === 200).json()).invoice_id)
  } finally { await server.close(); control?.close(); rmSync(tmp, { recursive: true, force: true }) }
})
