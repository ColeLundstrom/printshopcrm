import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createHttpTestServer } from './helpers/http-test-server.mjs'

test('a removed member id is never re-issued, the shop forgets their links, and shop SMTP cannot reach the server network', { timeout: 120000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'psc-member-identity-')), dest = join(tmp, 'demo')
  const httpServer = await createHttpTestServer()
  let db, control, banner
  const sockets = new Set()
  let bannerConnections = 0
  try {
    const built = spawnSync(process.execPath, ['bin/demo.mjs', dest, String(httpServer.port)], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 90000 })
    assert.equal(built.status, 0, built.stderr)
    const env = JSON.parse(readFileSync(join(dest, 'demo-env.json'), 'utf8'))
    assert.equal(env.PSC_AUTH, '1')
    let log = ''
    await httpServer.start({ cwd: dest, env, args: ['--no-warnings', '--import', './bin/demo-network-guard.mjs', 'server.mjs'], onOutput: (t) => { log += t } })
    const base = httpServer.base
    const login = async (email, password) => {
      const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })
      assert.equal(r.status, 200, await r.clone().text())
      return r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
    }
    const owner = await login('dylan@example.test', readFileSync(join(dest, 'LOGIN.txt'), 'utf8').match(/Password: (.+)/)[1])
    const call = (cookie, method, path, body) => fetch(base + path, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const slug = readdirSync(join(dest, 'data/tenants'))[0]
    db = new DatabaseSync(join(dest, 'data/tenants', slug, 'printshop.db'))
    control = new DatabaseSync(join(dest, 'data/control.db'))

    // ---- member ids come from a sequence that never goes backwards ----
    const add = async (email) => {
      const r = await call(owner, 'POST', '/api/members', { name: email.split('@')[0], email, password: 'fixture-pass-123', role: 'staff' })
      assert.equal(r.status, 200, await r.clone().text())
      return (await r.json()).id
    }
    const leaver = await add('leaver@example.test')
    assert.equal(leaver, control.prepare('SELECT MAX(id) n FROM members').get().n, 'the leaver holds the highest id, the case SQLite would re-issue')
    const job = db.prepare('SELECT id FROM jobs LIMIT 1').get().id
    db.prepare("INSERT INTO slack_operator_members(user_id,member_id) VALUES('ULEAVER',?)").run(leaver)
    db.prepare('INSERT INTO costing_employees(member_id,hourly_cost) VALUES(?,31)').run(leaver)
    db.prepare("INSERT INTO production_preferences(member_id,department) VALUES(?,'press')").run(leaver)
    const openTask = Number(db.prepare("INSERT INTO production_tasks(job_id,title,department,stage,position,assigned_id,status) VALUES(?,'Print fronts','press','production',90,?,'pending')").run(job, leaver).lastInsertRowid)
    const doneTask = Number(db.prepare("INSERT INTO production_tasks(job_id,title,department,stage,position,assigned_id,status) VALUES(?,'Burn screens','screens','production',91,?,'done')").run(job, leaver).lastInsertRowid)

    const del = await call(owner, 'DELETE', '/api/members/' + leaver)
    assert.equal(del.status, 200, await del.clone().text())
    assert.equal(db.prepare('SELECT count(*) n FROM slack_operator_members WHERE member_id=?').get(leaver).n, 0, 'the Slack link goes with the person')
    assert.equal(db.prepare('SELECT count(*) n FROM costing_employees WHERE member_id=?').get(leaver).n, 0)
    assert.equal(db.prepare('SELECT count(*) n FROM production_preferences WHERE member_id=?').get(leaver).n, 0)
    assert.equal(db.prepare('SELECT assigned_id FROM production_tasks WHERE id=?').get(openTask).assigned_id, null, 'open work goes back to the queue')
    assert.equal(db.prepare('SELECT assigned_id FROM production_tasks WHERE id=?').get(doneTask).assigned_id, leaver, 'finished work keeps its history')

    const hire = await add('new-hire@example.test')
    assert.ok(hire > leaver, `new hire got id ${hire}; the removed member had ${leaver}`)

    // Restart: the high-water mark is durable, and boot-time migration keeps every existing id.
    const before = control.prepare('SELECT id,email FROM members ORDER BY id').all().map((r) => ({ ...r }))
    await call(owner, 'DELETE', '/api/members/' + hire)
    await httpServer.stop()
    await httpServer.start({ cwd: dest, env, args: ['--no-warnings', '--import', './bin/demo-network-guard.mjs', 'server.mjs'], onOutput: (t) => { log += t } })
    const owner2 = await login('dylan@example.test', readFileSync(join(dest, 'LOGIN.txt'), 'utf8').match(/Password: (.+)/)[1])
    const r2 = await call(owner2, 'POST', '/api/members', { name: 'Third', email: 'third@example.test', password: 'fixture-pass-123', role: 'staff' })
    assert.equal(r2.status, 200)
    assert.ok((await r2.json()).id > hire)
    const after = control.prepare('SELECT id,email FROM members ORDER BY id').all().map((r) => ({ ...r }))
    assert.deepEqual(after.filter((m) => m.email !== 'third@example.test'), before.filter((m) => m.email !== 'new-hire@example.test'))

    // ---- shop SMTP: refused on save, refused on verify, verify needs a manager ----
    for (const host of ['127.0.0.1', '169.254.169.254', 'localhost', '[::1]']) {
      const r = await call(owner2, 'PUT', '/api/settings', { smtp_host: host })
      assert.equal(r.status, 400, host)
      const b = await r.json()
      assert.equal(b.code, 'smtp_host_blocked')
      assert.match(b.error, /private or internal network/)
    }
    assert.notEqual(db.prepare("SELECT value FROM settings WHERE key='smtp_host'").get()?.value, '127.0.0.1')

    banner = net.createServer((s) => { bannerConnections++; sockets.add(s); s.on('error', () => {}); s.write('SSH-2.0-OpenSSH_9.6 fixture\r\n') })
    let port = 4800 + Math.floor(Math.random() * 90)
    while (!(await new Promise((resolve) => { banner.once('error', () => resolve(false)); banner.listen(port, '127.0.0.1', () => resolve(true)) }))) { port++; assert.ok(port <= 4899) }
    // A row written before this release (or straight into the database) is still refused at connect time.
    for (const [k, v] of Object.entries({ smtp_host: '127.0.0.1', smtp_port: String(port), smtp_user: 'u', smtp_pass: 'p', smtp_from: 'orders@example.test' })) {
      db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v)
    }
    const v = await call(owner2, 'POST', '/api/notify/verify-email')
    assert.equal(v.status, 200)
    const vb = await v.json()
    assert.equal(vb.ok, false)
    assert.match(vb.error, /private or internal network/)
    assert.doesNotMatch(vb.error, /SSH/)
    assert.equal(bannerConnections, 0, 'verify must not open a socket into the server network')

    const staff = await add('staffer@example.test')
    assert.ok(staff)
    const staffCookie = await login('staffer@example.test', 'fixture-pass-123')
    const denied = await call(staffCookie, 'POST', '/api/notify/verify-email')
    assert.equal(denied.status, 403)
    assert.equal(bannerConnections, 0)
  } finally {
    db?.close(); control?.close()
    for (const s of sockets) s.destroy()
    if (banner?.listening) await new Promise((r) => banner.close(r))
    await httpServer.close()
    rmSync(tmp, { recursive: true, force: true })
  }
})
