import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,readFileSync,readdirSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import vm from 'node:vm'
import { createHttpTestServer } from './helpers/http-test-server.mjs'
import { seedPurchasingFixture } from './helpers/purchasing-fixture.mjs'

test('purchasing HTTP is authenticated and read-only for staff; live receipts and short closes remain separate', { timeout: 120000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'psc-purchasing-http-')), dest = join(temp, 'demo')
  const server = await createHttpTestServer()
  let db, control
  try {
    const built = spawnSync(process.execPath, ['bin/demo.mjs', dest, String(server.port)], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 90000 })
    assert.equal(built.status, 0, built.stderr)
    const env = JSON.parse(readFileSync(join(dest, 'demo-env.json'), 'utf8')); env.PSC_TICK_MS = '3600000'
    const slug = readdirSync(join(dest, 'data/tenants'))[0]
    db = new DatabaseSync(join(dest, 'data/tenants', slug, 'printshop.db')); db.exec('PRAGMA busy_timeout=5000')
    const fixtures = seedPurchasingFixture(db)
    await server.start({ cwd: dest, env, args: ['--no-warnings', '--import', './bin/demo-network-guard.mjs', 'server.mjs'] })
    assert.equal((await fetch(server.base + '/api/purchasing')).status, 401)
    const login = await fetch(server.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'dylan@example.test', password: readFileSync(join(dest, 'LOGIN.txt'), 'utf8').match(/Password: (.+)/)[1] }) })
    assert.equal(login.status, 200)
    const owner = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
    control = new DatabaseSync(join(dest, 'data/control.db')); control.exec('PRAGMA busy_timeout=5000')
    const member = control.prepare('SELECT * FROM members LIMIT 1').get()
    const staffId = Number(control.prepare('INSERT INTO members(tenant_id,name,email,password_hash,role,status) VALUES(?,?,?,?,?,?)').run(member.tenant_id, 'Receiver', 'receiver@example.test', member.password_hash, 'staff', 'active').lastInsertRowid)
    control.prepare('INSERT INTO sessions(token,tenant_id,member_id,expires_at) VALUES(?,?,?,?)').run('fixture-purchasing-staff', member.tenant_id, staffId, new Date(Date.now()+3600000).toISOString().replace('T',' ').slice(0,19))
    const staff = owner.replace(/=[^;]+/, '=fixture-purchasing-staff')
    const request = async (path, cookie = staff, method = 'GET', body) => {
      const response = await fetch(server.base + path, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      return { status: response.status, json: await response.json() }
    }
    const snapshot = () => JSON.stringify(['purchase_orders','po_lines','jobs','po_manual_confirmations'].map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY ' + (table === 'po_manual_confirmations' ? 'po_id' : 'id')).all()))
    const before = snapshot()
    const q = await request('/api/purchasing?q=PURCHASING&page_size=2')
    assert.equal(q.status, 200)
    assert.equal(q.json.total, 4)
    assert.equal(q.json.rows.length, 2)
    assert.equal(q.json.rows[0].id, fixtures.partial.id)
    assert.equal(q.json.rows[0].outstanding, 6)
    assert.equal(q.json.summary.short_closed, 1)
    assert.equal((await request('/api/purchasing?q=PURCHASING&state=all', owner)).json.total, 6)
    assert.equal((await request('/api/purchasing?state=bad')).status, 400)
    assert.equal((await request('/api/purchasing?page_size=1000')).status, 400)
    assert.equal(snapshot(), before, 'Queue reads do not alter POs, counts, confirmations or jobs')
    // Execute the actual existing job view with an actual staff HTTP response. Only the DOM
    // boundary is stubbed; this verifies the handoff even when no workflow exists on the job.
    const detail = (await request('/api/production/jobs/' + fixtures.partial.jobId)).json
    for (const query of ['', '?receiving=1', '?receiving=10', '?other=1&receiving=1']) {
      const nodes = new Map()
      const $ = key => { if (!nodes.has(key)) nodes.set(key, { innerHTML: '', style: {}, classList: { contains: () => false } }); return nodes.get(key) }
      const context = vm.createContext({ api: { get: async path => { assert.equal(path, '/api/production/jobs/' + fixtures.partial.jobId + query); return detail } },
        $, $$: () => [], esc: value => String(value ?? ''), setPage() {}, mountShipments() {}, fmtDate: value => value,
        window: { addEventListener() {} }, location: { hash: '#/production/jobs/' + fixtures.partial.jobId + query }, document: { body: { classList: { contains: () => false } } } })
      const source = readFileSync(new URL('../public/js/views/production.js', import.meta.url), 'utf8').replace(/^import[^\n]+\n/gm, '').replaceAll('export async function ', 'async function ')
      vm.runInContext(source + '\nglobalThis.show = productionJobView;', context)
      await context.show(fixtures.partial.jobId)
      assert.equal(/<details class="card card-b" open><summary>Receiving/.test($('#view').innerHTML), query.endsWith('receiving=1'))
    }
    assert.equal((await request('/api/purchase-orders/' + fixtures.partial.id + '/close', staff, 'POST', {})).status, 403)
    assert.equal((await request('/api/purchase-orders/' + fixtures.partial.id + '/close', owner, 'POST', {})).status, 200)
    assert.equal((await request('/api/purchasing?q=PURCHASING&state=short_closed')).json.total, 2)
    assert.equal((await request('/api/purchasing?q=PURCHASING')).json.total, 3)
    assert.equal((await request('/api/purchase-orders/' + fixtures.partial.id + '/reopen', owner, 'POST', {})).status, 200)
    assert.equal((await request('/api/purchasing?q=PURCHASING')).json.total, 4)
    db.prepare('UPDATE po_lines SET qty_received=qty_ordered WHERE po_id=?').run(fixtures.partial.id)
    assert.equal((await request('/api/purchasing?q=PURCHASING')).json.total, 3)
    assert.equal((await request('/api/purchasing?q=PURCHASING&state=received')).json.total, 2)
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { await server.close(); db?.close(); control?.close(); rmSync(temp, { recursive: true, force: true }) }
})
