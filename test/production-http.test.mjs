import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
test(
  'production HTTP: templates repeat, staff assignments hold, QR stays in its shop and costs stay private',
  { timeout: 120000 },
  async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'psc-production-')),
      dest = join(tmp, 'demo'),
      probe = createServer()
    await new Promise((r) => probe.listen(0, '127.0.0.1', r))
    const port = probe.address().port
    await new Promise((r) => probe.close(r))
    let child, db, control
    try {
      const built = spawnSync(process.execPath, ['bin/demo.mjs', dest, String(port)], {
        cwd: new URL('..', import.meta.url),
        encoding: 'utf8',
        timeout: 90000
      })
      assert.equal(built.status, 0, built.stderr)
      const env = JSON.parse(readFileSync(join(dest, 'demo-env.json'), 'utf8'))
      let log = ''
      child = spawn(
        process.execPath,
        ['--no-warnings', '--import', './bin/demo-network-guard.mjs', 'server.mjs'],
        { cwd: dest, env, stdio: ['ignore', 'pipe', 'pipe'] }
      )
      child.stdout.on('data', (x) => (log += x))
      child.stderr.on('data', (x) => (log += x))
      for (let i = 0; i < 100 && !log.includes('(ws /ws live'); i++)
        await new Promise((r) => setTimeout(r, 50))
      assert.match(log, /ws \/ws live/)
      const base = `http://127.0.0.1:${port}`
      const login = await fetch(base + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'dylan@example.test',
          password: readFileSync(join(dest, 'LOGIN.txt'), 'utf8').match(/Password: (.+)/)[1]
        })
      })
      assert.equal(login.status, 200, log)
      const owner = login.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ')
      const req = (path, body, method = 'POST', cookie = owner) =>
        fetch(base + path, {
          method,
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        })
      const json = async (path, body, method = 'POST', cookie = owner) => {
        const r = await req(path, body, method, cookie)
        assert.equal(r.status, 200, await r.clone().text())
        return r.json()
      }
      const conf = await json('/api/production/templates', undefined, 'GET'),
        template = conf.templates[0]
      let d = await json('/api/production/jobs/1/workflow', { revision: 0, template_ids: [template.id] })
      assert.equal(d.tasks[0].title, 'Receive and count')
      const bad = await req('/api/production/jobs/1?shop=other', undefined, 'GET')
      assert.equal(bad.status, 403)
      assert.equal(
        (await req('/api/production/jobs/1/qr', undefined, 'GET')).headers.get('content-type'),
        'image/svg+xml; charset=utf-8'
      )
      assert.equal((await req('/api/jobs/1/stage', { stage: 'complete' }, 'PATCH')).status, 409)
      const slug = readdirSync(join(dest, 'data', 'tenants'))[0]
      db = new DatabaseSync(join(dest, 'data', 'tenants', slug, 'printshop.db'))
      control = new DatabaseSync(join(dest, 'data', 'control.db'))
      const first = control.prepare('SELECT * FROM members LIMIT 1').get()
      control
        .prepare('INSERT INTO members(tenant_id,name,email,password_hash,role,status) VALUES(?,?,?,?,?,?)')
        .run(first.tenant_id, 'QC employee', 'qc@example.test', first.password_hash, 'staff', 'active')
      const member = control.prepare("SELECT id FROM members WHERE email='qc@example.test'").get()
      control
        .prepare(
          "INSERT INTO sessions(token,tenant_id,member_id,expires_at) VALUES('test-production-staff',?,?,?)"
        )
        .run(
          first.tenant_id,
          member.id,
          new Date(Date.now() + 3600000).toISOString().replace('T', ' ').slice(0, 19)
        )
      const staffCookie = owner.replace(/=[^;]+/, '=test-production-staff')
      assert.equal((await req('/api/costing/config', undefined, 'GET', staffCookie)).status, 403)
      assert.equal((await req('/api/production/templates', { ...template }, 'POST', staffCookie)).status, 403)
      d = await json(
        '/api/production/jobs/1/tasks/' + d.tasks[0].id,
        { ...d.tasks[0], revision: d.revision, assigned_id: first.id },
        'PUT'
      )
      assert.equal(
        (
          await req(
            `/api/production/jobs/1/tasks/${d.tasks[0].id}/action`,
            { revision: d.revision, action: 'complete' },
            'POST',
            staffCookie
          )
        ).status,
        403
      )
      d = await json(
        '/api/production/jobs/1/tasks/' + d.tasks[0].id,
        { ...d.tasks[0], revision: d.revision, assigned_id: member.id },
        'PUT'
      )
      const po = Number(
        db
          .prepare("INSERT INTO purchase_orders(job_id,po_number,status) VALUES(1,'PO-FIXTURE','submitted')")
          .run().lastInsertRowid
      )
      const line = Number(
        db.prepare('INSERT INTO po_lines(po_id,qty_ordered,qty_received) VALUES(?,10,0)').run(po)
          .lastInsertRowid
      )
      const receipt = { revision: d.revision, counts: [{ line_id: line, qty_received: 8 }] }
      d = await json(`/api/production/jobs/1/receive/${po}`, receipt, 'POST', staffCookie)
      assert.equal(
        (await req(`/api/production/jobs/1/receive/${po}`, receipt, 'POST', staffCookie)).status,
        409
      )
      assert.equal(db.prepare('SELECT qty_received FROM po_lines WHERE id=?').get(line).qty_received, 8)
      assert.equal(
        (
          await req(
            `/api/production/jobs/1/tasks/${d.tasks[0].id}/action`,
            { revision: d.revision, action: 'complete' },
            'POST',
            staffCookie
          )
        ).status,
        409
      )
      d = await json(
        `/api/production/jobs/1/receive/${po}`,
        { revision: d.revision, counts: [{ line_id: line, qty_received: 10 }] },
        'POST',
        staffCookie
      )
      d = await json(
        `/api/production/jobs/1/tasks/${d.tasks[0].id}/action`,
        { revision: d.revision, action: 'complete' },
        'POST',
        staffCookie
      )
      assert.equal(d.tasks[0].completed_by, 'QC employee')
      await json('/api/production/auto', { enabled: true }, 'PUT')
      const newJob = await json('/api/jobs', {
        contact_id: 1,
        title: 'Automatic tasks',
        decoration: 'Screen Print',
        quantities: '10 M'
      })
      assert.equal(
        (await json('/api/production/jobs/' + newJob.id, undefined, 'GET')).tasks.length,
        template.steps.length
      )
      await json(
        '/api/costing/config',
        {
          settings: { hours_day: 8, days_week: 5, productive_pct: 75, overhead_month: 1000 },
          employees: [{ member_id: first.id, hourly_cost: 25 }]
        },
        'PUT'
      )
      const machine = await json('/api/costing/machines', {
        name: 'Press',
        method: 'Screen printing',
        hourly_cost: 10,
        output_hour: 200,
        setup_minutes: 30,
        hours_week: 40
      })
      const cost = await json('/api/costing/jobs/1/operations', {
        revision: 0,
        machine_id: machine.id,
        member_id: first.id,
        units: 100,
        planned_minutes: null,
        actual_minutes: 60,
        good_units: 98
      })
      assert.equal(cost.operations[0].output_hour, 98)
      assert.equal((await json('/api/costing/comparison', undefined, 'GET')).machines.length, 1)
    } finally {
      db?.close()
      control?.close()
      if (child && !child.killed) {
        child.kill('SIGTERM')
        await new Promise((r) => child.once('exit', r))
      }
      rmSync(tmp, { recursive: true, force: true })
    }
  }
)
