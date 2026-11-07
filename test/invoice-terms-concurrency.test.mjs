import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createHttpTestServer } from './helpers/http-test-server.mjs'
import { invoiceTermsChanges, invoiceTermsExpected } from '../public/js/shared/invoice-terms.js'

test('invoice terms dialog sends only changed fields and includes the opening values', () => {
  const opening = { due_date: '2026-11-20', po_number: 'PO-1', billing_address: null, shipping_address: 'Dock 1' }
  const form = { due_date: '2026-11-21', po_number: 'PO-1', billing_address: '', shipping_address: 'Dock 1' }
  const changes = invoiceTermsChanges(opening, form)
  assert.deepEqual(changes, { due_date: '2026-11-21' })
  assert.deepEqual(invoiceTermsExpected(opening, changes), { due_date: '2026-11-20' })
  assert.deepEqual(invoiceTermsChanges(opening, { ...form, po_number: '', billing_address: 'New billing' }),
    { due_date: '2026-11-21', po_number: '', billing_address: 'New billing' })
})

test('invoice terms preserve unrelated edits and require an explicit same-field resolution', { timeout: 120000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'psc-invoice-terms-')), dest = join(temp, 'demo')
  const server = await createHttpTestServer()
  let db
  try {
    const built = spawnSync(process.execPath, ['bin/demo.mjs', dest, String(server.port)], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 90000,
    })
    assert.equal(built.status, 0, built.stderr)
    db = new DatabaseSync(join(dest, 'data/tenants', readdirSync(join(dest, 'data/tenants'))[0], 'printshop.db'))
    db.exec('PRAGMA busy_timeout=5000')
    const env = JSON.parse(readFileSync(join(dest, 'demo-env.json'), 'utf8'))
    env.PSC_TICK_MS = '3600000'
    await server.start({ cwd: dest, env, args: ['--no-warnings', '--import', './bin/demo-network-guard.mjs', 'server.mjs'] })
    const login = await fetch(server.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'dylan@example.test', password: readFileSync(join(dest, 'LOGIN.txt'), 'utf8').match(/Password: (.+)/)[1] }) })
    assert.equal(login.status, 200)
    const owner = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
    const request = async (path, body, method = 'GET', cookie = owner) => {
      const response = await fetch(server.base + path, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) })
      return { status: response.status, body: await response.json() }
    }
    const ok = async (...args) => { const r = await request(...args); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body }
    const start = await ok('/api/invoices/1')
    const snapshot = () => ({
      payments: db.prepare('SELECT * FROM payments ORDER BY id').all(),
      money: db.prepare('SELECT id,amount_due,amount_paid FROM invoices ORDER BY id').all(),
    })
    const unrelated = snapshot()
    const firstPo = `${start.po_number || 'PO'}-teammate`
    await ok('/api/invoices/1', { po_number: firstPo, expected: { po_number: start.po_number ?? '' } }, 'PUT')
    const due = start.due_date === '2026-12-03' ? '2026-12-04' : '2026-12-03'
    const dueOnly = invoiceTermsChanges(start, { ...start, due_date: due })
    assert.deepEqual(dueOnly, { due_date: due })
    const saved = await ok('/api/invoices/1', { ...dueOnly, expected: invoiceTermsExpected(start, dueOnly) }, 'PUT')
    assert.equal(saved.due_date, due)
    assert.equal(saved.po_number, firstPo)
    assert.equal(saved.status, 'partial', 'moving an overdue invoice into the future recomputes its status')
    assert.deepEqual(snapshot(), unrelated, 'terms edits never alter invoice money or recorded payments')

    const secondPo = `${firstPo}-newer`
    await ok('/api/invoices/1', { po_number: secondPo, expected: { po_number: firstPo } }, 'PUT')
    const conflict = await request('/api/invoices/1', { po_number: 'My PO', expected: { po_number: firstPo } }, 'PUT')
    assert.equal(conflict.status, 409)
    assert.equal(conflict.body.code, 'invoice_terms_conflict')
    assert.deepEqual(conflict.body.conflicts, [{ field: 'po_number', current: secondPo }])
    assert.equal(db.prepare('SELECT po_number FROM invoices WHERE id=1').get().po_number, secondPo)
    const resolved = await ok('/api/invoices/1', { po_number: 'My PO', expected: { po_number: secondPo } }, 'PUT')
    assert.equal(resolved.po_number, 'My PO')
    assert.equal(resolved.due_date, due)
    assert.equal((await request('/api/invoices/1', { po_number: 'Bad precondition', expected: {} }, 'PUT')).status, 400)

    const signup = await request('/api/auth/signup', { shop_name: 'Neighbor fixture', owner_name: 'Neighbor',
      owner_email: 'neighbor-invoice@example.test', password: 'Neighbor-invoice-password-1' }, 'POST')
    assert.equal(signup.status, 200)
    const neighborLogin = await fetch(server.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'neighbor-invoice@example.test', password: 'Neighbor-invoice-password-1' }) })
    assert.equal(neighborLogin.status, 200)
    const neighbor = neighborLogin.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
    assert.equal((await request('/api/invoices/1', { po_number: 'Cross-shop' }, 'PUT', neighbor)).status, 404)
    assert.equal(db.prepare('SELECT po_number FROM invoices WHERE id=1').get().po_number, 'My PO')
  } finally {
    db?.close()
    await server.close()
    rmSync(temp, { recursive: true, force: true })
  }
})
