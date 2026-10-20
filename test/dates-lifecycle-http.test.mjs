import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHttpTestServer } from './helpers/http-test-server.mjs'
import { isoInZone, addDaysIso } from '../lib/shop-time.mjs'

test('shop time zone, job lifecycle and body validation over HTTP', { timeout: 180000 }, async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'psc-dates-')), dest = join(temp, 'demo'), server = await createHttpTestServer()
  let db, control
  try {
    const built = spawnSync(process.execPath, ['bin/demo.mjs', dest, String(server.port)], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 90000 })
    assert.equal(built.status, 0, built.stderr)
    const env = JSON.parse(readFileSync(join(dest, 'demo-env.json'), 'utf8')); env.PSC_TICK_MS = '3600000'
    db = new DatabaseSync(join(dest, 'data/tenants', readdirSync(join(dest, 'data/tenants'))[0], 'printshop.db'))
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000')
    control = new DatabaseSync(join(dest, 'data/control.db')); control.exec('PRAGMA busy_timeout=5000')
    const owner = control.prepare('SELECT * FROM members LIMIT 1').get()
    control.prepare("INSERT INTO sessions(token,tenant_id,member_id,expires_at) VALUES(?,?,?,datetime('now','+1 hour'))").run('dates-owner', owner.tenant_id, owner.id)
    await server.start({ cwd: dest, env, args: ['--no-warnings', '--import', './bin/demo-network-guard.mjs', 'server.mjs'] })
    const req = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
      const r = await fetch(server.base + path, { method, headers: { 'Content-Type': 'application/json', cookie: 'psc_session=dates-owner' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) })
      const text = await r.text()
      let json = null; try { json = JSON.parse(text) } catch { json = text }
      return { status: r.status, body: json }
    }
    const ok = async (path, body, method) => { const r = await req(path, body, method); assert.equal(r.status, 200, `${path} ${JSON.stringify(r.body)}`); return r.body }

    await t.test('the shop timezone decides what "today" is, and a bad zone is refused', async () => {
      const bad = await req('/api/settings', { timezone: 'Mars/Olympus_Mons' }, 'PUT')
      assert.equal(bad.status, 400); assert.equal(bad.body.code, 'timezone_invalid')
      assert.equal((await req('/api/settings', { timezone: { zone: 'UTC' } }, 'PUT')).body.code, 'timezone_invalid')
      // Kiritimati (UTC+14) and Pago Pago (UTC-11) are always on different dates.
      const ahead = 'Pacific/Kiritimati', behind = 'Pacific/Pago_Pago'
      assert.equal((await ok('/api/settings', { timezone: 'pacific/kiritimati' }, 'PUT')).timezone, ahead, 'stored canonical')
      const contact = await ok('/api/contacts', { name: 'Zone customer', email: 'zone@example.test' })
      const dueAhead = await ok('/api/jobs', { contact_id: contact.id, title: 'Due today, far east', due_date: isoInZone(ahead) })
      const dueBehind = await ok('/api/jobs', { contact_id: contact.id, title: 'Due today, far west', due_date: isoInZone(behind) })
      assert.equal((await ok('/api/today')).date, isoInZone(ahead))
      let dash = await ok('/api/dashboard')
      assert.ok(dash.due_today.some((j) => j.id === dueAhead.id)); assert.ok(!dash.due_today.some((j) => j.id === dueBehind.id))
      await ok('/api/settings', { timezone: behind }, 'PUT')
      assert.equal((await ok('/api/today')).date, isoInZone(behind))
      dash = await ok('/api/dashboard')
      assert.ok(dash.due_today.some((j) => j.id === dueBehind.id)); assert.ok(!dash.due_today.some((j) => j.id === dueAhead.id))
      // due_this_week is bound from the shop date too, not SQL date('now').
      const week = await ok('/api/jobs', { contact_id: contact.id, title: 'Due in a week', due_date: addDaysIso(isoInZone(behind), 7) })
      const weekAfter = await ok('/api/jobs', { contact_id: contact.id, title: 'Due in eight days', due_date: addDaysIso(isoInZone(behind), 8) })
      const counted = db.prepare("SELECT COUNT(*) n FROM jobs WHERE status='active' AND due_date <= ?").get(addDaysIso(isoInZone(behind), 7)).n
      assert.equal((await ok('/api/dashboard')).kpis.due_this_week, counted)
      for (const j of [dueAhead, dueBehind, week, weekAfter]) db.prepare("UPDATE jobs SET status='complete', stage='complete' WHERE id=?").run(j.id)
      assert.equal((await ok('/api/settings', { timezone: '' }, 'PUT')).timezone, '', 'blank = the server zone')
    })

    const customer = await ok('/api/contacts', { name: 'Lifecycle customer', email: 'lifecycle@example.test' })
    const stranger = await ok('/api/contacts', { name: 'Someone else', email: 'else@example.test' })
    const line = { description: 'Lifecycle tees', decoration: 'Screen Print', sizes: { M: 12 }, unit_price: 10 }

    await t.test('re-converting after a void adopts the finished job instead of opening a duplicate', async () => {
      const est = await ok('/api/estimates', { contact_id: customer.id, items: [line] })
      const rev = async () => (await ok('/api/estimates/' + est.id)).commercial_revision
      const first = await ok('/api/estimates/' + est.id + '/convert', { commercial_revision: await rev() })
      await ok('/api/jobs/' + first.job_id + '/stage', { stage: 'complete' }, 'PATCH')
      const dueBefore = db.prepare('SELECT due_date FROM jobs WHERE id=?').get(first.job_id).due_date
      await ok('/api/invoices/' + first.invoice_id + '/void', { reason: 'wrong PO' })
      const again = await ok('/api/estimates/' + est.id + '/convert', { commercial_revision: await rev() })
      assert.equal(again.job_id, first.job_id); assert.equal(again.job_reused, true)
      const jobs = db.prepare('SELECT * FROM jobs WHERE estimate_id=?').all(est.id)
      assert.equal(jobs.length, 1, 'one job for one order')
      assert.equal(jobs[0].status, 'complete'); assert.equal(jobs[0].invoice_id, again.invoice_id); assert.equal(jobs[0].due_date, dueBefore)
      assert.equal((await req('/api/estimates/' + est.id + '/convert', { commercial_revision: await rev(), title: { x: 1 } })).status, 409, 'already invoiced is still checked first')
      const fresh = await ok('/api/estimates', { contact_id: customer.id, items: [line] })
      assert.equal((await req('/api/estimates/' + fresh.id + '/convert', { commercial_revision: 0, title: { x: 1 } })).status, 400)
    })

    await t.test('autopilot never marks a quote sent for a customer it cannot email', async () => {
      const silent = await ok('/api/contacts', { name: 'Quentin Noemail' })
      const est = await ok('/api/estimates', { contact_id: silent.id, items: [line] })
      const outbox = () => db.prepare('SELECT COUNT(*) n FROM email_log').get().n
      const before = outbox(), deal = db.prepare('SELECT stage FROM opportunities WHERE estimate_id=?').get(est.id)?.stage
      for (let i = 0; i < 2; i++) {
        const r = await req('/api/autopilot/commit', { estimate_id: est.id })
        assert.equal(r.status, 400); assert.equal(r.body.code, 'no_email', 'a retry gives the same answer, never "Already sent"')
      }
      const after = db.prepare('SELECT status, sent_at FROM estimates WHERE id=?').get(est.id)
      assert.equal(after.status, 'draft'); assert.equal(after.sent_at, null)
      assert.equal(outbox(), before)
      assert.equal(db.prepare('SELECT stage FROM opportunities WHERE estimate_id=?').get(est.id)?.stage, deal, 'the deal did not move')
      // Full-auto: the draft is written and the send is reported as blocked, not a 500.
      const auto = await req('/api/autopilot', { text: 'Hi, we need 48 black Gildan 5000 tees, 1 color front. Thanks!', contact_name: 'Quentin Noemail', mode: 'auto' })
      assert.equal(auto.status, 200, JSON.stringify(auto.body))
      assert.equal(auto.body.mode, 'auto')
      assert.equal(auto.body.committed, false); assert.equal(auto.body.send_blocked, 'no_email')
      assert.equal(auto.body.estimate.status, 'draft')
      assert.equal(outbox(), before)
    })

    await t.test('POST /api/jobs validates its links, its status and its field types', async () => {
      const mine = await ok('/api/estimates', { contact_id: customer.id, items: [line] })
      const theirs = await ok('/api/estimates', { contact_id: stranger.id, items: [line] })
      const make = (extra) => req('/api/jobs', { contact_id: customer.id, title: 'Typed job', ...extra })
      assert.equal((await make({ estimate_id: 99999999 })).status, 404)
      assert.equal((await make({ invoice_id: 99999999 })).status, 404)
      assert.equal((await make({ estimate_id: 'abc' })).status, 400)
      const cross = await make({ estimate_id: theirs.id })
      assert.equal(cross.status, 409); assert.equal(cross.body.code, 'customer_mismatch')
      const linked = await make({ estimate_id: mine.id })
      assert.equal(linked.status, 200); assert.equal(linked.body.estimate_id, mine.id)
      const done = await make({ stage: 'complete' })
      assert.equal(done.body.stage, 'complete'); assert.equal(done.body.status, 'complete'); assert.ok(done.body.ship_date)
      for (const field of ['title', 'notes', 'quantities', 'assigned_to']) {
        const r = await make({ [field]: { nested: true } })
        assert.equal(r.status, 400, field); assert.equal(r.body.field, field)
      }
      assert.equal((await make({ notes: ['a'] })).status, 400)
      assert.equal((await make({ due_date: '2026-02-30' })).status, 400, 'a real calendar day')
      assert.equal((await make({ due_date: '2028-02-29' })).status, 200)
      const job = await ok('/api/jobs/' + linked.body.id)
      assert.equal((await req('/api/jobs/' + job.id, { due_date: '2026-04-31' }, 'PUT')).status, 400)
    })

    await t.test('invoice due dates and estimate/automation/receptionist bodies refuse junk with 400s', async () => {
      const est = await ok('/api/estimates', { contact_id: customer.id, items: [line] })
      const conv = await ok('/api/estimates/' + est.id + '/convert', { commercial_revision: 0 })
      for (const due_date of ['2026-13-45', '2026-02-30', '2026-00-10'])
        assert.equal((await req('/api/invoices/' + conv.invoice_id, { due_date }, 'PUT')).status, 400, due_date)
      assert.equal((await ok('/api/invoices/' + conv.invoice_id, { due_date: '2028-02-29' }, 'PUT')).due_date, '2028-02-29')
      assert.equal((await req('/api/estimates', { contact_id: customer.id, items: [line], notes: {} })).status, 400)
      const draft = await ok('/api/estimates', { contact_id: customer.id, items: [line] })
      assert.equal((await req('/api/estimates/' + draft.id, { notes: { a: 1 } }, 'PUT')).status, 400)
      assert.equal((await req('/api/estimates/' + draft.id, { notes: 'plain' }, 'PUT')).status, 200)
      const rule = { trigger: 'invoice.paid', actions: [{ key: 'note.log', config: { body: 'paid' } }] }
      for (const name of [5, {}, ['x'], null, '  ']) assert.equal((await req('/api/automations', { ...rule, name })).status, 400, JSON.stringify(name))
      for (const body of [{ name: { a: 1 } }, { greeting: ['hi'] }, { knowledge: { k: 1 } }])
        assert.equal((await req('/api/agent/config', body, 'PUT')).status, 400, JSON.stringify(body))
      assert.equal((await req('/api/agent/config', { greeting: 'Hello there' }, 'PUT')).status, 200)
    })

    await t.test('an assistant move gets the timeline row, job.stage automation and LIKE-safe matching', async () => {
      const team = await ok('/api/contacts', { name: 'Zephyrcats Booster Club', email: 'zephyr@example.test' })
      const job = await ok('/api/jobs', { contact_id: team.id, title: 'Zephyrcats spirit tees' })
      await ok('/api/automations', { name: 'Production note', trigger: 'job.stage', params: { stage: 'production' }, actions: [{ key: 'note.log', config: { body: 'on press' } }] })
      const r = await ok('/api/assistant', { message: 'move the Zephyrcats job to production' })
      assert.match(r.reply, /Moved/)
      assert.equal(db.prepare('SELECT stage FROM jobs WHERE id=?').get(job.id).stage, 'production')
      const scan = db.prepare('SELECT * FROM job_scans WHERE job_id=? ORDER BY id DESC').get(job.id)
      assert.equal(scan.source, 'assistant'); assert.equal(scan.from_stage, 'new'); assert.equal(scan.to_stage, 'production')
      assert.equal(db.prepare("SELECT COUNT(*) n FROM automation_runs WHERE automation_name='Production note' AND entity_id=?").get(job.id).n, 1)
      const long = await req('/api/assistant', { message: 'find ' + 'z'.repeat(60000) })
      assert.equal(long.status, 200, 'a pasted wall of text is capped, not a 500')
    })

    await t.test('recording a shipment on an order that does not exist is a 404, not a 400', async () => {
      const r = await req('/api/orders/99999999/shipments', {})
      assert.equal(r.status, 404)
    })
  } finally { await server.close(); db?.close(); control?.close(); rmSync(temp, { recursive: true, force: true }) }
})
