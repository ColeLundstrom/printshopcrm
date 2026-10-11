import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHttpTestServer } from './helpers/http-test-server.mjs'

test('customer payment terms set invoice due dates while production dates and old invoices stay fixed', { timeout: 120000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'psc-payment-terms-')), dest = join(tmp, 'demo')
  const server = await createHttpTestServer()
  try {
    const built = spawnSync(process.execPath, ['bin/demo.mjs', dest, String(server.port)], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 90000 })
    assert.equal(built.status, 0, built.stderr)
    const env = JSON.parse(readFileSync(join(dest, 'demo-env.json'), 'utf8'))
    await server.start({ cwd: dest, env, args: ['--no-warnings', '--import', './bin/demo-network-guard.mjs', 'server.mjs'] })
    const login = await fetch(server.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'dylan@example.test', password: readFileSync(join(dest, 'LOGIN.txt'), 'utf8').match(/Password: (.+)/)[1] }) })
    assert.equal(login.status, 200)
    const cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
    const req = (path, body, method = body === undefined ? 'GET' : 'POST') => fetch(server.base + path, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) })
    const ok = async (path, body, method) => { const r = await req(path, body, method); assert.equal(r.status, 200, await r.clone().text()); return r.json() }
    const customer = await ok('/api/contacts', { name: 'Terms fixture', payment_term: 'net_30' })
    assert.equal(customer.payment_term, 'net_30')
    assert.equal((await fetch(server.base + '/api/contacts/' + customer.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payment_term: 'due_on_receipt' }) })).status, 401)
    const bad = await req('/api/contacts/' + customer.id, { payment_term: 'net_999' }, 'PUT')
    assert.equal(bad.status, 400)
    assert.equal((await ok('/api/contacts/' + customer.id)).contact.payment_term, 'net_30')
    const estimate = await ok('/api/estimates', { contact_id: customer.id, items: [{ description: 'Synthetic tees', sizes: { M: 12 }, unit_price: 10 }], tax_rate: 0 })
    const detail = await ok('/api/estimates/' + estimate.id)
    assert.equal(detail.customer_payment_term, 'net_30')
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
  } finally { await server.close(); rmSync(tmp, { recursive: true, force: true }) }
})
