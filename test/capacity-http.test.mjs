import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHttpTestServer } from './helpers/http-test-server.mjs'

test('actual capacity HTTP supplies method and remaining-work evidence and enforces manager settings access', { timeout: 120000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'psc-capacity-http-')), dest = join(temp, 'demo'), server = await createHttpTestServer()
  let db, control
  try {
    const built = spawnSync(process.execPath, ['bin/demo.mjs', dest, String(server.port)], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 90000,
    })
    assert.equal(built.status, 0, built.stderr)
    const env = JSON.parse(readFileSync(join(dest, 'demo-env.json'), 'utf8')); env.PSC_TICK_MS = '3600000'
    db = new DatabaseSync(join(dest, 'data/tenants', readdirSync(join(dest, 'data/tenants'))[0], 'printshop.db'))
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON')
    // Exclude the synthetic demo backlog so each case controls all active model inputs.
    db.exec("UPDATE jobs SET status='complete'")
    control = new DatabaseSync(join(dest, 'data/control.db')); control.exec('PRAGMA busy_timeout=5000')
    const original = control.prepare('SELECT * FROM members LIMIT 1').get()
    const staffId = Number(control.prepare('INSERT INTO members(tenant_id,name,email,password_hash,role,status) VALUES(?,?,?,?,?,?)')
      .run(original.tenant_id, 'Capacity staff fixture', 'capacity-staff@example.test', original.password_hash, 'staff', 'active').lastInsertRowid)
    control.prepare('INSERT INTO sessions(token,tenant_id,member_id,expires_at) VALUES(?,?,?,?)')
      .run('fixture-capacity-staff', original.tenant_id, staffId, new Date(Date.now() + 3600000).toISOString().replace('T', ' ').slice(0, 19))
    const staff = 'psc_session=fixture-capacity-staff'
    await server.start({ cwd: dest, env, args: ['--no-warnings', '--import', './bin/demo-network-guard.mjs', 'server.mjs'] })
    const login = await fetch(server.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'dylan@example.test', password: readFileSync(join(dest, 'LOGIN.txt'), 'utf8').match(/Password: (.+)/)[1] }) })
    assert.equal(login.status, 200)
    const owner = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
    const request = async (path, { method = 'GET', body, cookie = owner } = {}) => {
      const r = await fetch(server.base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) })
      return { status: r.status, body: await r.json() }
    }
    const ok = async (...args) => { const r = await request(...args); assert([200,201].includes(r.status), JSON.stringify(r)); return r.body }
    const post = (path, body) => ok(path, { method: 'POST', body })
    const report = cookie => ok('/api/capacity', { cookie })
    const promise = body => post('/api/capacity/promise', { pieces: 144, colors: 2, decoration: 'Screen Print', ...body })
    let serial = 0
    const makeJob = async ({ decoration = 'Screen Print', methods = [decoration], stage = 'new' } = {}) => {
      const estimate = await post('/api/estimates', { contact_id: 1, tax_rate: 0,
        items: methods.map(method => ({ description: 'Capacity fixture tees', decoration: method, sizes: { M: 144 }, unit_price: 10 })) })
      const job = await post('/api/jobs', { contact_id: 1, estimate_id: estimate.id, title: 'Capacity fixture ' + ++serial,
        decoration, quantities: (methods.length * 144) + ' M', stage })
      db.prepare('UPDATE jobs SET approval_gated=0 WHERE id=?').run(job.id)
      return job
    }
    const retire = job => db.prepare("UPDATE jobs SET status='complete' WHERE id=?").run(job.id)
    const flow = async (job, stages) => {
      const template = await post('/api/production/templates', { name: 'Capacity flow ' + ++serial,
        steps: stages.map((stage, n) => ({ title: 'Fixture task ' + n, department: stage === 'production' ? 'Screen printing' : 'QC', stage, gate: '', assigned_id: null })) })
      await post('/api/production/jobs/' + job.id + '/workflow', { revision: 0, template_ids: [template.id] })
    }
    const completeFirst = async job => {
      const detail = await ok('/api/production/jobs/' + job.id)
      const task = detail.tasks.find(t => t.status === 'pending')
      return post('/api/production/jobs/' + job.id + '/tasks/' + task.id + '/action', { revision: detail.revision, action: 'complete' })
    }

    const supported = await makeJob()
    let data = await report(owner)
    assert.equal(data.can_manage, true); assert.equal(data.scope_complete, true); assert.equal(data.modeled_count, 1)
    assert.equal(data.jobs.find(j => j.id === supported.id).scope_state, 'modeled')
    const staffView = await report(staff)
    assert.equal(staffView.can_manage, false); assert.equal(staffView.modeled_count, 1)
    const beforeSettings = JSON.stringify(db.prepare("SELECT * FROM settings WHERE key LIKE 'capacity_%' OR key IN ('press_type','utilization_pct') ORDER BY key").all())
    assert.equal((await request('/api/capacity/settings', { method: 'PUT', body: { capacity_stations: 8 }, cookie: staff })).status, 403)
    assert.equal(JSON.stringify(db.prepare("SELECT * FROM settings WHERE key LIKE 'capacity_%' OR key IN ('press_type','utilization_pct') ORDER BY key").all()), beforeSettings)
    const changed = await ok('/api/capacity/settings', { method: 'PUT', body: { capacity_stations: 2 } })
    assert.equal(changed.can_manage, true); assert.equal(changed.capacity.stations, 2)
    const validSettings = JSON.stringify(db.prepare('SELECT * FROM settings ORDER BY key').all())
    for (const body of [
      { capacity_stations: 3, capacity_hours_per_day: 25 },
      { capacity_stations: 1e99 }, { capacity_stations: 1.5 },
      { utilization_pct: 0 }, { capacity_default_colors: 13 }, { press_type: 'unknown' },
    ]) {
      const refused = await request('/api/capacity/settings', { method: 'PUT', body })
      assert.equal(refused.status, 400); assert.equal(refused.body.code, 'invalid_capacity_setting')
      assert.equal(JSON.stringify(db.prepare('SELECT * FROM settings ORDER BY key').all()), validSettings,
        'A rejected multi-field settings edit must not partially save a valid earlier field')
    }
    for (const due_date of ['2026-02-30', '2026-02-29', '2026-13-01', 'tomorrow', ['2026-09-08']]) {
      const refused = await request('/api/capacity/promise', { method: 'POST', body: { pieces: 144, colors: 2, decoration: 'Screen Print', due_date } })
      assert.equal(refused.status, 400); assert.equal(refused.body.code, 'invalid_date')
    }
    for (const body of [{ pieces: 1e99 }, { pieces: 1.5 }, { pieces: 0 }, { pieces: true }, { pieces: 144, colors: 13 }]) {
      const refused = await request('/api/capacity/promise', { method: 'POST', body: { decoration: 'Screen Print', ...body } })
      assert.equal(refused.status, 400); assert.equal(refused.body.code, 'invalid_capacity_input')
    }
    assert((await promise({ due_date: '2028-02-29' })).earliestFinish, 'A real leap-day date remains accepted')
    const positive = await promise({})
    assert.equal(positive.scope_complete, true); assert.match(positive.earliestFinish, /^\d{4}-\d{2}-\d{2}$/)
    for (const body of [{ decoration: 'Embroidery' }, { decoration: '' }, { decoration: 'Screen Print', method: 'Embroidery' }]) {
      const unsupported = await promise(body)
      assert.equal(unsupported.earliestFinish, null, 'Conflicting or unsupported proposed methods must not receive a date')
      assert.equal(unsupported.feasible, null)
    }

    for (const options of [{ decoration: '' }, { decoration: 'Embroidery' }, { decoration: 'Screen Print', methods: ['Screen Print','DTF Transfer'] }]) {
      const other = await makeJob(options)
      data = await report()
      assert.equal(data.scope_complete, false)
      assert.equal(data.jobs.find(j => j.id === other.id).scope_state, 'unresolved')
      assert.equal((await promise({})).earliestFinish, null)
      retire(other)
    }
    // The saved per-garment job override is separate evidence from the linked estimate.
    db.prepare('UPDATE jobs SET line_sizes=? WHERE id=?').run(JSON.stringify([{ sizes: { M: 144 }, decoration: 'Embroidery' }]), supported.id)
    assert.equal((await report()).jobs.find(j => j.id === supported.id).scope_state, 'unresolved')
    db.prepare("UPDATE jobs SET line_sizes='[]' WHERE id=?").run(supported.id)
    retire(supported)

    const legacyQc = await makeJob({ stage: 'qc' })
    data = await report(); assert.equal(data.jobs.find(j => j.id === legacyQc.id).scope_state, 'finished'); assert.equal(data.modeled_count, 0)
    const finishedPrint = await makeJob(); await flow(finishedPrint, ['production','qc']); await completeFirst(finishedPrint)
    data = await report()
    assert.equal(data.jobs.find(j => j.id === finishedPrint.id).stage, 'qc')
    assert.equal(data.jobs.find(j => j.id === finishedPrint.id).scope_state, 'finished')
    assert.equal(data.modeled_count, 0); assert.equal(data.scope_complete, true)

    const laterPrint = await makeJob(); await flow(laterPrint, ['production','qc','production']); await completeFirst(laterPrint)
    data = await report()
    const later = data.jobs.find(j => j.id === laterPrint.id)
    assert.equal(later.stage, 'qc'); assert.equal(later.workflow_tasks.filter(t => t.stage === 'production').length, 2)
    assert.equal(later.scope_state, 'unresolved'); assert.equal(later.scope_code, 'multiple_production_steps')
    assert.equal((await promise({})).earliestFinish, null, 'A later pending press step must not disappear because the card is in QC')
    await completeFirst(laterPrint); await completeFirst(laterPrint)
    assert.equal((await report()).scope_complete, true)
    assert((await promise({})).earliestFinish)
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { await server.close(); db?.close(); control?.close(); rmSync(temp, { recursive: true, force: true }) }
})
