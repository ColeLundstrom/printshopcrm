import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createHttpTestServer } from './helpers/http-test-server.mjs'
import { changedJobFields } from '../public/js/shared/job-edit-delta.js'

const formFor = job => ({
  title: job.title || '', decoration: job.decoration || 'Screen Print',
  quantities: job.quantities || '', garment: job.garment || '',
  due_date: job.due_date || '', assigned_to: job.assigned_to || '',
  shipping_address: job.shipping_address || '', notes: job.notes || '', rush: !!job.rush,
  contact_id: String(job.contact_id),
})

test('job edit payload includes only changed fields, including explicit clears', () => {
  const original = { contact_id: 2, title: 'Original', decoration: 'Mug Printing', quantities: '12 OS',
    garment: null, due_date: null, assigned_to: '', shipping_address: null, notes: 'Original note', rush: 1 }
  const form = formFor(original)
  assert.deepEqual(changedJobFields(original, form), {}, 'prefilled values must not be posted again')
  assert.deepEqual(changedJobFields(original, { ...form, title: 'Edited', notes: '', rush: false, due_date: '2026-12-01' }),
    { title: 'Edited', due_date: '2026-12-01', notes: '', rush: false })
  assert.deepEqual(changedJobFields({ ...original, decoration: null }, formFor({ ...original, decoration: null })), {},
    'the form default must not replace an unset decoration')
})

test('two job editors preserve newer unrelated fields and keep other shop data isolated', { timeout: 120000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'psc-job-delta-')), dest = join(temp, 'demo')
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
    const request = async (path, body, method = 'POST', cookie = owner) => {
      const response = await fetch(server.base + path, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) })
      return { status: response.status, body: await response.json() }
    }
    const ok = async (...args) => { const r = await request(...args); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body }
    const contact = await ok('/api/contacts', { name: 'Concurrent edit buyer' })
    const job = await ok('/api/jobs', { contact_id: contact.id, title: 'Original job', notes: 'Original note',
      decoration: 'Mug Printing', quantities: '12 M', due_date: '2026-12-01' })
    const invoices = () => db.prepare('SELECT id, amount_due, amount_paid, status FROM invoices ORDER BY id').all()
    const payments = () => db.prepare('SELECT * FROM payments ORDER BY id').all()
    const unrelated = { invoices: invoices(), payments: payments() }
    const staleForm = formFor(job)

    await ok(`/api/jobs/${job.id}`, { title: 'Teammate title', notes: 'Teammate note', rush: true }, 'PUT')
    const before = db.prepare('SELECT title, notes, rush, decoration, due_date FROM jobs WHERE id=?').get(job.id)
    const dueOnly = changedJobFields(job, { ...staleForm, due_date: '2026-12-05' })
    assert.deepEqual(dueOnly, { due_date: '2026-12-05' })
    const saved = await ok(`/api/jobs/${job.id}`, dueOnly, 'PUT')
    assert.equal(saved.title, before.title)
    assert.equal(saved.notes, before.notes)
    assert.equal(saved.rush, before.rush)
    assert.equal(saved.decoration, before.decoration)
    assert.equal(saved.due_date, '2026-12-05')
    assert.deepEqual({ invoices: invoices(), payments: payments() }, unrelated)

    const explicit = changedJobFields(job, { ...staleForm, title: 'My explicit title' })
    assert.deepEqual(explicit, { title: 'My explicit title' })
    assert.equal((await ok(`/api/jobs/${job.id}`, explicit, 'PUT')).title, 'My explicit title')
    assert.equal((await ok(`/api/jobs/${job.id}`, { rush: false }, 'PUT')).rush, 0)

    const signup = await request('/api/auth/signup', { shop_name: 'Neighbor edit fixture', owner_name: 'Neighbor',
      owner_email: 'neighbor-edit@example.test', password: 'Neighbor-edit-password-1' })
    assert.equal(signup.status, 200)
    const neighborLogin = await fetch(server.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'neighbor-edit@example.test', password: 'Neighbor-edit-password-1' }) })
    assert.equal(neighborLogin.status, 200)
    const neighbor = neighborLogin.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
    assert.equal((await request(`/api/jobs/${job.id}`, { notes: 'Cross-shop overwrite' }, 'PUT', neighbor)).status, 404)
    assert.equal(db.prepare('SELECT notes FROM jobs WHERE id=?').get(job.id).notes, 'Teammate note')
  } finally {
    db?.close()
    await server.close()
    rmSync(temp, { recursive: true, force: true })
  }
})
