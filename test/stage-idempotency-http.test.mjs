import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createHttpTestServer } from './helpers/http-test-server.mjs'

test('repeated order and job stages preserve timestamps, history and tenant boundaries', { timeout: 120000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'psc-stage-idempotency-'))
  const dest = join(temp, 'demo')
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
    const cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
    const request = async (path, body, method = 'POST', auth = cookie) => {
      const response = await fetch(server.base + path, { method, headers: { Cookie: auth, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) })
      return { status: response.status, body: await response.json() }
    }
    const ok = async (...args) => { const result = await request(...args); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body }
    const contact = await ok('/api/contacts', { name: 'Stage test buyer' })
    const estimate = await ok('/api/estimates', { contact_id: contact.id, items: [{ description: 'Sample tees', sizes: { M: 2 }, unit_price: 10 }], tax_rate: 0 })
    const job = await ok('/api/jobs', { contact_id: contact.id, estimate_id: estimate.id, title: 'Stage test job', quantities: '2 M' })
    const order = () => db.prepare('SELECT board_stage, stage_moved_at FROM estimates WHERE id=?').get(estimate.id)
    const work = () => db.prepare('SELECT stage, sort_order, status, updated_at, ship_date FROM jobs WHERE id=?').get(job.id)
    const history = () => ({
      activities: db.prepare('SELECT id, type, description FROM activities WHERE contact_id=? ORDER BY id').all(contact.id),
      scans: db.prepare('SELECT id, from_stage, to_stage, source FROM job_scans WHERE job_id=? ORDER BY id').all(job.id),
      deliveries: db.prepare('SELECT id, event FROM webhook_deliveries ORDER BY id').all(),
    })
    const initial = { order: order(), work: work(), history: history() }
    await ok(`/api/orders/${estimate.id}/stage`, { stage: 'quote' }, 'PUT')
    await ok(`/api/jobs/${job.id}/stage`, { stage: 'new' }, 'PATCH')
    await ok(`/api/v1/jobs/${job.id}/stage`, { stage: 'new' })
    await ok('/api/scan', { job_id: job.id, to_stage: 'new' })
    assert.deepEqual({ order: order(), work: work(), history: history() }, initial)

    await ok(`/api/orders/${estimate.id}/stage`, { stage: 'paid' }, 'PUT')
    await ok(`/api/jobs/${job.id}/stage`, { stage: 'art_approval' }, 'PATCH')
    const moved = { order: order(), work: work(), history: history() }
    assert.equal(moved.order.board_stage, 'paid')
    assert.equal(moved.work.stage, 'art_approval')
    assert.equal(moved.history.scans.length, initial.history.scans.length + 1)
    await ok(`/api/orders/${estimate.id}/stage`, { stage: 'paid' }, 'PUT')
    await ok(`/api/jobs/${job.id}/stage`, { stage: 'art_approval' }, 'PATCH')
    await ok(`/api/v1/jobs/${job.id}/stage`, { stage: 'art_approval' })
    await ok('/api/scan', { job_id: job.id, to_stage: 'art_approval' })
    assert.deepEqual({ order: order(), work: work(), history: history() }, moved)

    await ok(`/api/jobs/${job.id}/stage`, { stage: 'art_approval', sort_order: 42 }, 'PATCH')
    assert.equal(work().sort_order, 42)
    assert.deepEqual(history(), moved.history, 'reordering within one column is not a stage event')
    const reordered = work()
    await ok(`/api/jobs/${job.id}/stage`, { stage: 'art_approval', sort_order: 42 }, 'PATCH')
    assert.deepEqual(work(), reordered)

    const signup = await request('/api/auth/signup', { shop_name: 'Other stage fixture', owner_name: 'Other owner',
      owner_email: 'other-stage@example.test', password: 'Other-stage-password-1' })
    assert.equal(signup.status, 200)
    // A neighbor's session cannot operate on either record; the owner still sees the same rows.
    const neighborLogin = await fetch(server.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'other-stage@example.test', password: 'Other-stage-password-1' }) })
    assert.equal(neighborLogin.status, 200)
    const neighborCookie = neighborLogin.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
    assert.equal((await request(`/api/orders/${estimate.id}/stage`, { stage: 'paid' }, 'PUT', neighborCookie)).status, 404)
    assert.equal((await request(`/api/jobs/${job.id}/stage`, { stage: 'art_approval' }, 'PATCH', neighborCookie)).status, 404)
    assert.deepEqual(work(), reordered)
    assert.deepEqual(order(), moved.order)
  } finally {
    db?.close()
    await server.close()
    rmSync(temp, { recursive: true, force: true })
  }
})
