import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHttpTestServer } from './helpers/http-test-server.mjs'
import { DatabaseSync } from 'node:sqlite'
test(
  'production HTTP: templates repeat, staff assignments hold, QR stays in its shop and costs stay private',
  { timeout: 120000 },
  async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'psc-production-')),
      dest = join(tmp, 'demo')
    const httpServer = await createHttpTestServer(), port = httpServer.port
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
      await httpServer.start({cwd: dest, env,
        args: ['--no-warnings', '--import', './bin/demo-network-guard.mjs', 'server.mjs'],
        onOutput: text => { log += text },
      })
      child = httpServer.child
      // Windows under concurrent CI load can take longer than five seconds to start.
      // Wait for this owned child, never for an unrelated listener on the chosen port.
      for (let i = 0; i < 600 && child.exitCode === null && !log.includes('(ws /ws live'); i++)
        await new Promise((r) => setTimeout(r, 50))
      assert.match(log, /ws \/ws live/)
      const base = httpServer.base
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
      assert.equal((await req('/api/production?page_size=10000', undefined, 'GET')).status, 400)
      assert.equal((await req('/api/costing/comparison?page=0', undefined, 'GET')).status, 400)
      const originalBrand = (await json('/api/settings', undefined, 'GET')).settings
      assert.equal(
        (await req('/api/settings', { brand_primary: '#ffffff;bad', brand_name: 'Should not save' }, 'PUT'))
          .status,
        400
      )
      assert.equal(
        (await json('/api/settings', undefined, 'GET')).settings.brand_name,
        originalBrand.brand_name
      )
      await json(
        '/api/settings',
        { brand_primary: '#1234AB', brand_secondary: '#FFCC00', brand_theme: 'light' },
        'PUT'
      )
      const branded = (await json('/api/settings', undefined, 'GET')).settings
      assert.equal(branded.brand_primary, '#1234ab')
      assert.equal(branded.brand_theme, 'light')
      const uploadLogo = async (bytes, mime, name, cookie = owner) => {
        const body = new FormData()
        body.append('file', new Blob([bytes], { type: mime }), name)
        return fetch(base + '/api/settings/logo', { method: 'POST', headers: { Cookie: cookie }, body })
      }
      assert.equal((await uploadLogo('not an image', 'image/png', 'bad.png')).status, 400)
      const image = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJwAAAABJRU5ErkJggg==',
        'base64'
      )
      const logoResponse = await uploadLogo(image, 'image/png', 'logo.png')
      assert.equal(logoResponse.status, 200)
      const logo = (await logoResponse.json()).shop_logo
      assert.equal((await req('/uploads/' + logo, undefined, 'GET')).status, 200)
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
      const contactCsv = 'Buyer,Reply Address\nMapping Fixture,mapping@example.test'
      const contactMapping = { name: 'buyer', email: 'reply address' }
      const contactCount = () => db.prepare('SELECT count(*) AS n FROM contacts').get().n
      const beforeMapping = contactCount()
      const suggested = await json('/api/import/contacts', { text: contactCsv, mapping_only: true })
      assert.deepEqual(suggested.headers, ['buyer', 'reply address'])
      assert.equal(suggested.mapping.name, null)
      const contactPreview = await json('/api/import/contacts', { text: contactCsv, mapping: contactMapping, preview: true })
      assert.equal(contactPreview.sample[0].email, 'mapping@example.test')
      assert.equal(contactCount(), beforeMapping)
      assert.equal((await req('/api/import/contacts', { text: contactCsv, mapping: { name: 'missing' } })).status, 400)
      assert.equal(contactCount(), beforeMapping)
      assert.equal((await json('/api/import/contacts', { text: contactCsv, mapping: contactMapping })).created, 1)
      assert.equal((await json('/api/import/contacts', { text: contactCsv, mapping: contactMapping })).created, 0)
      const orderCsv = 'Buyer,Document,Settlement,Charge\nMapping Fixture,MAP-001,unpaid,120'
      const orderMapping = { customer_name: 'buyer', order_number: 'document', status: 'settlement', total: 'charge' }
      const invoiceCount = () => db.prepare('SELECT count(*) AS n FROM invoices').get().n
      const beforeInvoices = invoiceCount()
      const orderPreview = await json('/api/import/orders', { text: orderCsv, mapping: orderMapping, status_policy: 'strict', preview: true })
      assert.equal(orderPreview.sample[0].total, 120)
      assert.equal(orderPreview.payment_states.unpaid, 1)
      assert.equal(invoiceCount(), beforeInvoices)
      const multipart = new FormData()
      multipart.append('file', new Blob([orderCsv], { type: 'text/csv' }), 'old-system.csv')
      multipart.append('mapping', JSON.stringify(orderMapping))
      multipart.append('status_policy', 'strict')
      const importedOrder = await fetch(base + '/api/import/orders', { method: 'POST', headers: { Cookie: owner }, body: multipart })
      assert.equal(importedOrder.status, 200, await importedOrder.clone().text())
      assert.equal((await importedOrder.json()).imported, 1)
      assert.equal(invoiceCount(), beforeInvoices + 1)
      assert.equal(db.prepare('SELECT e.total FROM invoices i JOIN estimates e ON e.id=i.estimate_id ORDER BY i.id DESC LIMIT 1').get().total, 120)
      assert.equal((await json('/api/import/orders', { text: orderCsv, mapping: orderMapping, status_policy: 'strict' })).skipped_duplicates, 1)
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
      assert.equal((await req('/api/settings', { brand_primary: '#abcdef' }, 'PUT', staffCookie)).status, 403)
      assert.equal((await uploadLogo(image, 'image/png', 'staff-logo.png', staffCookie)).status, 403)

      assert.equal((await req('/api/production/templates', { ...template }, 'POST', staffCookie)).status, 403)
      const neighbor = await req('/api/auth/signup', {
        shop_name: 'Neighbor branding test',
        owner_name: 'Other owner',
        owner_email: 'neighbor-branding@example.test',
        password: 'Neighbor-test-password-1'
      })
      assert.equal(neighbor.status, 200, await neighbor.clone().text())
      const neighborCookie = neighbor.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ')
      assert.equal((await json('/api/settings', undefined, 'GET', neighborCookie)).settings.brand_primary, '')
      assert.equal((await req('/uploads/' + logo, undefined, 'GET', neighborCookie)).status, 404)
      assert.equal((await req('/api/production/jobs/1', undefined, 'GET', neighborCookie)).status, 404)
      await json('/api/settings/logo', undefined, 'DELETE')
      await json('/api/settings', { brand_primary: '', brand_secondary: '', brand_theme: '' }, 'PUT')

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
      const timingJob = await json('/api/jobs', { contact_id:1,title:'Calendar-only job',decoration:'Manual',quantities:'1 M' })
      let timingDetail = await json('/api/production/jobs/' + timingJob.id, undefined, 'GET')
      const timingBody = { revision:timingDetail.revision,timing:{enabled:true,start_date:'2026-09-04',turnaround_days:5,day_basis:'business'},reason:'Standard turnaround' }
      assert.equal((await req(`/api/production/jobs/${timingJob.id}/timing`, timingBody, 'PUT', staffCookie)).status,403)
      timingDetail = await json(`/api/production/jobs/${timingJob.id}/timing`, timingBody, 'PUT')
      assert.equal(timingDetail.timing.planned_production_date,'2026-09-11')
      assert.equal((await req(`/api/production/jobs/${timingJob.id}/timing`, timingBody, 'PUT')).status,409)
      assert.equal((await req(`/api/jobs/${timingJob.id}/stage`,{stage:'production'},'PATCH')).status,200)
      const calendar = await json('/api/production/calendar?start=2026-09-01&end=2026-09-30',undefined,'GET',staffCookie)
      assert.ok(calendar.events.some(e=>e.job_id===timingJob.id && e.date==='2026-09-11'))
      assert.equal((await req('/api/production/calendar?start=bad&end=2026-09-30',undefined,'GET')).status,400)

    } finally {
      db?.close()
      control?.close()
      await httpServer.close()
      rmSync(tmp, { recursive: true, force: true })
    }
  }
)
