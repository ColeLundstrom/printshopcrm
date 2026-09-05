import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHttpTestServer } from './helpers/http-test-server.mjs'

test('actual shipping HTTP preserves permissions, durable receipts, associations and dispatch history', { timeout: 120000 }, async t => {
  const temp = mkdtempSync(join(tmpdir(), 'psc-shipping-http-')), dest = join(temp, 'demo')
  const server = await createHttpTestServer()
  let db, control
  try {
    const built = spawnSync(process.execPath, ['bin/demo.mjs', dest, String(server.port)], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 90000,
    })
    assert.equal(built.status, 0, built.stderr)
    const env = JSON.parse(readFileSync(join(dest, 'demo-env.json'), 'utf8'))
    env.PSC_TICK_MS = '3600000'
    const start = () => server.start({ cwd: dest, env, args: ['--no-warnings', '--import', './bin/demo-network-guard.mjs', 'server.mjs'] })
    control = new DatabaseSync(join(dest, 'data/control.db')); control.exec('PRAGMA busy_timeout=5000')
    db = new DatabaseSync(join(dest, 'data/tenants', readdirSync(join(dest, 'data/tenants'))[0], 'printshop.db'))
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON')
    const member = control.prepare('SELECT * FROM members LIMIT 1').get(), actors = {}
    for (const name of ['Alex', 'Sam']) {
      const id = Number(control.prepare('INSERT INTO members(tenant_id,name,email,password_hash,role,status) VALUES(?,?,?,?,?,?)')
        .run(member.tenant_id, name + ' shipping fixture', name.toLowerCase() + '-shipping@example.test', member.password_hash, 'staff', 'active').lastInsertRowid)
      const token = 'fixture-shipping-' + id
      control.prepare('INSERT INTO sessions(token,tenant_id,member_id,expires_at) VALUES(?,?,?,?)')
        .run(token, member.tenant_id, id, new Date(Date.now() + 3600000).toISOString().replace('T', ' ').slice(0, 19))
      actors[name] = { id, cookie: 'psc_session=' + token }
    }
    await start()
    const login = await fetch(server.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'dylan@example.test', password: readFileSync(join(dest, 'LOGIN.txt'), 'utf8').match(/Password: (.+)/)[1] }) })
    assert.equal(login.status, 200)
    const owner = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
    const request = async (path, body, method = 'POST', cookie = owner) => {
      const response = await fetch(server.base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) })
      const text = await response.text()
      return { status: response.status, body: text ? JSON.parse(text) : null }
    }
    const ok = async (...args) => { const r = await request(...args); assert([200,201].includes(r.status), JSON.stringify(r)); return r.body }
    const denied = async (status, ...args) => { const r = await request(...args); assert.equal(r.status, status, JSON.stringify(r)); return r.body }
    const rows = table => db.prepare('SELECT * FROM "' + table + '" ORDER BY rowid').all()
    const snapshot = tables => JSON.stringify(Object.fromEntries(tables.map(table => [table, rows(table)])))
    const shippingTables = ['shipping_scopes','shipping_records','shipping_events','shipping_requests','production_jobs','production_events','production_tasks','jobs','estimates','invoices','payments','messages','email_log']
    const sideEffects = ['production_tasks','jobs','estimates','invoices','payments','messages','email_log']
    let serial = 0
    const order = async () => {
      const contact = await ok('/api/contacts', { name: 'Shipping buyer ' + ++serial, shipping_address: '100 Original Lane' })
      const estimate = await ok('/api/estimates', { contact_id: contact.id, items: [{ description: 'Fixture tees', sizes: { M: 2 }, unit_price: 10 }], tax_rate: 0 })
      return { contact, estimate }
    }
    const work = async ({ parent, assigned = actors.Alex.id, enroll = true } = {}) => {
      parent ||= await order()
      const job = await ok('/api/jobs', { contact_id: parent.contact.id, estimate_id: parent.estimate.id,
        title: 'Shipping fixture ' + ++serial, decoration: 'Fixture custom method', quantities: '2 M' })
      // A no-art-required baseline isolates the shipping permission; explicit approval and
      // technical holds are exercised below rather than accidentally blocking every fixture.
      db.prepare('UPDATE jobs SET approval_gated=0 WHERE id=?').run(job.id)
      if (enroll) {
        const template = await ok('/api/production/templates', { name: 'Shipping fixture flow ' + serial, steps: [
          { title: 'Dispatch fixture order', department: 'Shipping', stage: 'shipping', gate: '', assigned_id: assigned },
        ] })
        await ok('/api/production/jobs/' + job.id + '/workflow', { revision: 0, template_ids: [template.id] })
      }
      return { ...parent, job, floor: '/api/production/jobs/' + job.id, sales: '/api/orders/' + parent.estimate.id + '/shipments' }
    }
    const view = (w, cookie = owner) => ok(w.sales, undefined, 'GET', cookie)
    const detail = (w, cookie = owner) => ok(w.floor, undefined, 'GET', cookie)
    const payload = async (w, suffix, extra = {}, cookie = owner) => {
      const scope = (await view(w, cookie)).scopes.find(s => s.job_id === w.job.id)
      return { request_id: 'shipping-fixture-' + suffix, shipping_revision: scope.shipping_revision, production_revision: scope.production_revision,
        kind: 'parcel', carrier: 'UPS', tracking_number: 'FIX-' + suffix, note: '', ...extra }
    }

    await t.test('both entry points enforce current staff assignment and holds; replay survives task completion and restart', async () => {
      const w = await work(), initial = await payload(w, 'staff-first', {}, actors.Alex.cookie)
      assert.equal((await view(w, actors.Alex.cookie)).scopes[0].can_record, true)
      assert.equal((await view(w, actors.Sam.cookie)).scopes[0].can_record, false)
      const before = snapshot(shippingTables)
      await denied(403, w.floor + '/shipments', initial, 'POST', actors.Sam.cookie)
      await denied(403, w.sales, { ...initial, job_id: w.job.id }, 'POST', actors.Sam.cookie)
      await denied(403, w.sales, { ...initial, job_id: null }, 'POST', actors.Alex.cookie)
      assert.equal(snapshot(shippingTables), before)
      const holdInvoice = Number(db.prepare("INSERT INTO invoices(contact_id,estimate_id,invoice_number,payment_review) VALUES(?,?,?,'Fixture payment review')")
        .run(w.contact.id, w.estimate.id, 'FIX-HOLD-' + w.job.id).lastInsertRowid)
      db.prepare('UPDATE jobs SET invoice_id=? WHERE id=?').run(holdInvoice, w.job.id)
      const holds = [
        { text: /Payment review/, release: () => db.prepare("UPDATE invoices SET payment_review='' WHERE id=?").run(holdInvoice) },
        { set: () => db.prepare('UPDATE jobs SET approval_gated=1,art_approved_at=NULL WHERE id=?').run(w.job.id), text: /Artwork approval/, release: () => db.prepare('UPDATE jobs SET approval_gated=0 WHERE id=?').run(w.job.id) },
        { set: () => db.prepare('UPDATE jobs SET art_release_required=1 WHERE id=?').run(w.job.id), text: /Technical production release/, release: () => db.prepare('UPDATE jobs SET art_release_required=0 WHERE id=?').run(w.job.id) },
        { set: () => db.prepare("UPDATE jobs SET status='complete' WHERE id=?").run(w.job.id), text: /not active/, release: () => db.prepare("UPDATE jobs SET status='active' WHERE id=?").run(w.job.id) },
        { set: () => db.prepare("UPDATE production_tasks SET stage='qc' WHERE job_id=?").run(w.job.id), text: /shipping task/, release: () => db.prepare("UPDATE production_tasks SET stage='shipping' WHERE job_id=?").run(w.job.id) },
      ]
      for (const hold of holds) {
        hold.set?.()
        const d = await view(w, actors.Alex.cookie); assert.equal(d.scopes[0].can_record, false); assert.match(d.scopes[0].blocked, hold.text)
        const unchanged = snapshot(shippingTables)
        await denied(403, w.floor + '/shipments', initial, 'POST', actors.Alex.cookie)
        await denied(403, w.sales, { ...initial, job_id: w.job.id }, 'POST', actors.Alex.cookie)
        assert.equal(snapshot(shippingTables), unchanged)
        hold.release()
      }
      const unaffected = snapshot(sideEffects)
      const pair = await Promise.all([ok(w.floor + '/shipments', initial, 'POST', actors.Alex.cookie), ok(w.floor + '/shipments', initial, 'POST', actors.Alex.cookie)])
      assert.equal(pair.filter(r => r.shipment_mutation.replayed).length, 1)
      assert.equal(pair.filter(r => !r.shipment_mutation.replayed).length, 1)
      const id = pair[0].shipment_mutation.id
      assert.equal(snapshot(sideEffects), unaffected, 'Recording cannot advance tasks/stages, stamp shipping, notify or change money')
      assert.equal(db.prepare('SELECT count(*) n FROM shipping_records WHERE job_id=?').get(w.job.id).n, 1)
      assert.equal(db.prepare('SELECT count(*) n FROM shipping_events WHERE shipment_id=?').get(id).n, 1)
      assert.equal(db.prepare("SELECT count(*) n FROM production_events WHERE job_id=? AND action='shipment.record'").get(w.job.id).n, 1)
      assert.equal((await view(w)).records.find(r => r.id === id).tracking_number, initial.tracking_number)
      assert.equal((await detail(w)).shipping.records.find(r => r.id === id).tracking_number, initial.tracking_number)
      const d = await detail(w, actors.Alex.cookie)
      await ok(w.floor + '/tasks/' + d.tasks[0].id + '/action', { revision: d.revision, action: 'complete' }, 'POST', actors.Alex.cookie)
      const progressed = snapshot(shippingTables)
      const replay = await ok(w.floor + '/shipments', initial, 'POST', actors.Alex.cookie)
      assert.equal(replay.shipment_mutation.replayed, true); assert.equal(replay.shipping.scopes[0].can_record, false)
      assert.equal(snapshot(shippingTables), progressed)
      await denied(409, w.floor + '/shipments', { ...initial, note: 'Different payload' }, 'POST', actors.Alex.cookie)
      await denied(403, w.floor + '/shipments', { ...initial, request_id: 'shipping-fixture-new-after-done' }, 'POST', actors.Alex.cookie)
      await server.stop(); await start()
      assert.equal((await ok(w.floor + '/shipments', initial, 'POST', actors.Alex.cookie)).shipment_mutation.replayed, true)
      assert.equal(snapshot(shippingTables), progressed)
    })

    await t.test('multiple job scopes retain dispatch addresses, correction/void history, exports and deletion guards', async () => {
      const w = await work({ assigned: null }), other = await work({ parent: { contact: w.contact, estimate: w.estimate }, assigned: null })
      assert.equal((await view(w, actors.Sam.cookie)).scopes.length, 2)
      assert((await view(w, actors.Sam.cookie)).scopes.every(s => s.can_record))
      const body = await payload(w, 'dispatched', { dispatched_on: '2026-09-04' })
      const unaffected = snapshot(sideEffects)
      const made = await ok(w.sales, { ...body, job_id: w.job.id })
      const id = made.mutation.id
      assert.equal(snapshot(sideEffects), unaffected)
      const otherBody = await payload(other, 'pickup', { kind: 'pickup', carrier: '', tracking_number: 'Collected by fixture customer' }, actors.Sam.cookie)
      await ok(other.sales, { ...otherBody, job_id: other.job.id }, 'POST', actors.Sam.cookie)
      const current = (await view(w)).records.find(r => r.id === id)
      assert.equal(current.shipping_address, '100 Original Lane')
      assert.equal(current.history.length, 1)
      assert.equal((await detail(w)).shipments.filter(r => r.job_id === other.job.id).length, 0)
      await denied(403, '/api/shipping/' + id + '/correct', {}, 'POST', actors.Alex.cookie)
      await ok('/api/jobs/' + w.job.id, { shipping_address: '200 New Job Address' }, 'PUT')
      const correction = await payload(w, 'corrected', { record_revision: current.revision, reason: 'Carrier printed the wrong reference', dispatched_on: '2026-09-04' })
      const corrected = await ok('/api/shipping/' + id + '/correct', correction)
      assert.equal(corrected.mutation.id, id)
      const after = (await view(w)).records.find(r => r.id === id)
      assert.equal(after.shipping_address, '100 Original Lane', 'Unrelated tracking correction preserves dispatch destination')
      assert.equal(after.history.length, 2); assert.equal(after.history[1].before.tracking_number, body.tracking_number)
      const exact = snapshot(shippingTables)
      assert.equal((await ok('/api/shipping/' + id + '/correct', correction)).mutation.replayed, true)
      assert.equal(snapshot(shippingTables), exact)
      await denied(409, '/api/shipping/' + id + '/correct', { ...correction, reason: 'Different reason' })
      const stale = await payload(w, 'stale-record', { record_revision: current.revision, reason: 'Stale edit', dispatched_on: '2026-09-04' })
      await denied(409, '/api/shipping/' + id + '/correct', stale)
      const voidBody = await payload(w, 'void', { record_revision: after.revision, reason: 'Wrong parcel was recorded' })
      await ok('/api/shipping/' + id + '/void', voidBody)
      const voided = (await view(w)).records.find(r => r.id === id)
      assert.equal(voided.status, 'void'); assert.equal(voided.history.length, 3)
      const replayed = await ok(w.sales, { ...body, job_id: w.job.id })
      assert.equal(replayed.mutation.replayed, true); assert.equal(replayed.records.find(r => r.id === id).status, 'void')
      await denied(409, '/api/jobs/' + w.job.id, undefined, 'DELETE')
      await denied(409, '/api/estimates/' + w.estimate.id, undefined, 'DELETE')
      const exported = await ok('/api/export/all.json', undefined, 'GET')
      assert.equal(exported.tables.shipping_records.find(r => r.id === id).status, 'void')
      assert.equal(exported.tables.shipping_events.filter(r => r.shipment_id === id).length, 3)
      const csv = await fetch(server.base + '/api/export/shipments.csv', { headers: { Cookie: owner } })
      assert.equal(csv.status, 200); assert.match(await csv.text(), /FIX-corrected/)
    })

    await t.test('legacy adapter preserves independent parcels and reopening; historical buyer and customer deletion are protected', async () => {
      const { contact, estimate } = await order(), sales = '/api/orders/' + estimate.id + '/shipments'
      const canonicalBody = { request_id: 'shipping-fixture-canonical-legacy-collision', shipping_revision: 0, kind: 'parcel', carrier: 'UPS', tracking_number: 'CANONICAL-SAME', note: '' }
      const canonical = await ok(sales, canonicalBody), canonicalId = canonical.mutation.id
      const original = { ...db.prepare('SELECT * FROM shipping_records WHERE id=?').get(canonicalId) }
      await ok('/api/orders/' + estimate.id + '/tracking', { carrier: 'UPS', tracking_number: 'CANONICAL-SAME' }, 'PUT')
      assert.deepEqual({ ...db.prepare('SELECT * FROM shipping_records WHERE id=?').get(canonicalId) }, original,
        'Legacy adapter must not take ownership of an independent canonical parcel')
      let v = await ok(sales, undefined, 'GET')
      assert.equal(v.records.length, 2); assert.equal(v.records.filter(r => r.source_key === 'order:' + estimate.id).length, 1)
      await ok('/api/orders/' + estimate.id + '/tracking', { carrier: 'USPS', tracking_number: 'LEGACY-REVISED' }, 'PUT')
      assert.deepEqual({ ...db.prepare('SELECT * FROM shipping_records WHERE id=?').get(canonicalId) }, original)
      await ok('/api/orders/' + estimate.id + '/stage', { stage: 'shipped' }, 'PUT')
      await ok('/api/orders/' + estimate.id + '/stage', { stage: 'printing' }, 'PUT')
      const beforeNoop = snapshot(shippingTables)
      const noop = await ok('/api/orders/' + estimate.id + '/tracking', { carrier: 'USPS', tracking_number: 'LEGACY-REVISED' }, 'PUT')
      assert.equal(noop.changed, false); assert.equal(snapshot(shippingTables), beforeNoop)
      assert.equal(db.prepare('SELECT board_stage FROM estimates WHERE id=?').get(estimate.id).board_stage, 'printing')
      const newCustomer = await ok('/api/contacts', { name: 'Other historical shipping buyer' })
      const beforeRetarget = snapshot(shippingTables)
      await denied(409, '/api/estimates/' + estimate.id, { contact_id: newCustomer.id }, 'PUT')
      assert.equal(snapshot(shippingTables), beforeRetarget)
      await denied(409, '/api/contacts/' + contact.id, undefined, 'DELETE')
      assert(db.prepare('SELECT 1 FROM contacts WHERE id=?').get(contact.id))
      assert.equal(db.prepare('SELECT count(*) n FROM shipping_records WHERE estimate_id=?').get(estimate.id).n, 2)
    })

    await t.test('old Floor payload stays usable without implicit workflow enrollment or duplicate history', async () => {
      const w = await work({ assigned: null })
      const d = await detail(w, actors.Alex.cookie)
      const oldBody = { revision: d.revision, carrier: 'USPS', tracking_number: 'OLD-FLOOR-REFERENCE', note: 'Legacy client fixture' }
      const recorded = await ok(w.floor + '/shipments', oldBody, 'POST', actors.Alex.cookie)
      assert.equal(recorded.shipment_mutation.changed, true)
      const id = recorded.shipment_mutation.id, before = snapshot(shippingTables)
      // Older clients had only the production revision. A refresh plus an identical value
      // remains a no-op; a durable stale-revision replay requires the new request_id.
      const duplicate = await ok(w.floor + '/shipments', { ...oldBody, revision: recorded.revision }, 'POST', actors.Alex.cookie)
      assert.equal(duplicate.shipment_mutation.id, id); assert.equal(duplicate.shipment_mutation.changed, false)
      assert.equal(snapshot(shippingTables), before)
      await denied(409, w.floor + '/shipments', oldBody, 'POST', actors.Alex.cookie)
      const job = await ok('/api/jobs', { contact_id: w.contact.id, title: 'Job-only shipping history fixture', quantities: '1 M', decoration: 'Fixture custom method' })
      const path = '/api/production/jobs/' + job.id
      const jobOnly = await ok(path, undefined, 'GET')
      assert.equal(jobOnly.revision, 0); assert.equal(jobOnly.tasks.length, 0)
      const outcome = await ok(path + '/shipments', { request_id: 'shipping-fixture-job-only', shipping_revision: 0, production_revision: 0,
        kind: 'local_delivery', carrier: '', tracking_number: 'Local delivery fixture', note: '' })
      assert.equal(outcome.tasks.length, 0); assert.equal(outcome.revision, 0)
      assert.equal(outcome.shipping.records[0].estimate_id, null)
      assert.equal(outcome.shipping.records[0].job_id, job.id)
      assert.equal(db.prepare('SELECT count(*) n FROM production_jobs WHERE job_id=?').get(job.id).n, 0,
        'Manager recording a historical dispatch must not enroll an old job into a workflow')
    })

    await t.test('bad input, stale writes, association and tenant boundaries reject atomically', async () => {
      const w = await work(), unrelated = await work()
      const body = await payload(w, 'atomic')
      for (const patch of [{ kind: 'not-a-method' }, { carrier: {} }, { tracking_number: 'bad\nreference' }, { dispatched_on: '2026-02-30' }, { request_id: 'tiny' }, { shipping_revision: 99 }, { production_revision: 99 }]) {
        const before = snapshot(shippingTables)
        const r = await request(w.sales, { ...body, job_id: w.job.id, ...patch })
        assert([400,409].includes(r.status), JSON.stringify(r)); assert.equal(snapshot(shippingTables), before)
      }
      await denied(409, w.sales, { ...body, job_id: unrelated.job.id })
      await denied(400, w.sales, { ...body, job_id: String(w.job.id) })
      await denied(401, w.sales, undefined, 'GET', '')
      db.prepare('UPDATE jobs SET contact_id=? WHERE id=?').run(unrelated.contact.id, w.job.id)
      const mismatch = await view(w); assert.equal(mismatch.scopes[0].can_record, false)
      await denied(409, w.sales, { ...body, job_id: w.job.id })
      db.prepare('UPDATE jobs SET contact_id=? WHERE id=?').run(w.contact.id, w.job.id)
      const beforeFault = snapshot(shippingTables)
      db.exec("CREATE TRIGGER fixture_shipping_receipt_failure BEFORE INSERT ON shipping_requests WHEN NEW.request_id='shipping-fixture-atomic' BEGIN SELECT RAISE(ABORT,'fixture shipment receipt failure'); END")
      await denied(500, w.sales, { ...body, job_id: w.job.id })
      assert.equal(snapshot(shippingTables), beforeFault, 'Receipt failure rolls back record/event/projection and both revisions')
      db.exec('DROP TRIGGER fixture_shipping_receipt_failure')
      const results = await Promise.all([
        request(w.sales, { ...body, job_id: w.job.id }),
        request(w.sales, { ...body, request_id: 'shipping-fixture-competing', tracking_number: 'COMPETING', job_id: w.job.id }),
      ])
      assert.deepEqual(results.map(r => r.status).sort(), [200,409])
      const success = results.find(r => r.status === 200).body
      const id = success.mutation.id
      const signup = await fetch(server.base + '/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shop_name: 'Shipping isolated neighbor', owner_name: 'Fixture neighbor', owner_email: 'shipping-neighbor@example.test', password: 'Fixture-neighbor-password-1' }) })
      assert.equal(signup.status, 200)
      const neighbor = signup.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
      await denied(404, w.sales, undefined, 'GET', neighbor)
      await denied(404, '/api/shipping/' + id + '/void', { request_id: 'neighbor-shipment-void', shipping_revision: 0, record_revision: 1, reason: 'Must stay in neighbor shop' }, 'POST', neighbor)
      const unowned = await work({ enroll: false })
      const unownedBody = await payload(unowned, 'no-workflow')
      assert.equal((await view(unowned, actors.Alex.cookie)).scopes[0].can_record, false)
      await denied(403, unowned.floor + '/shipments', unownedBody, 'POST', actors.Alex.cookie)
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    })
  } finally {
    await server.close(); db?.close(); control?.close(); rmSync(temp, { recursive: true, force: true })
  }
})
