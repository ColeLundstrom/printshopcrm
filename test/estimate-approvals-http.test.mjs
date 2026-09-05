import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHttpTestServer } from './helpers/http-test-server.mjs'
import { initEstimateApprovalSchema } from '../lib/estimate-approval-schema.mjs'

test('legacy terms migration freezes only currently known terms and repeats without changing evidence', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE schema_migrations(name TEXT PRIMARY KEY);
      CREATE TABLE estimates(id INTEGER PRIMARY KEY,estimate_number TEXT,contact_id INTEGER,status TEXT,approved_at TEXT,items TEXT,total REAL);
      INSERT INTO settings VALUES('estimate_terms','Visible at upgrade');
      INSERT INTO estimates VALUES(1,'OLD-1',7,'approved','2024-01-01','[]',100);`)
    const original = db.prepare('SELECT * FROM estimates').get()
    initEstimateApprovalSchema(db)
    let row = db.prepare('SELECT * FROM estimates').get()
    for (const key of Object.keys(original)) assert.equal(row[key], original[key])
    assert.equal(row.terms_snapshot, 'Visible at upgrade'); assert.equal(row.terms_snapshot_source, 'legacy_migration')
    db.exec("UPDATE settings SET value='New default'; INSERT INTO estimates(id,estimate_number) VALUES(2,'NEW-2')")
    assert.equal(db.prepare('SELECT terms_snapshot FROM estimates WHERE id=2').get().terms_snapshot, 'New default')
    assert.equal(db.prepare('SELECT terms_snapshot_source FROM estimates WHERE id=2').get().terms_snapshot_source, 'created')
    initEstimateApprovalSchema(db)
    assert.equal(db.prepare('SELECT terms_snapshot FROM estimates WHERE id=1').get().terms_snapshot, 'Visible at upgrade')
    db.exec("INSERT INTO estimates(id,estimate_number,terms_snapshot) VALUES(3,'BLANK-3','')")
    assert.equal(db.prepare('SELECT terms_snapshot FROM estimates WHERE id=3').get().terms_snapshot, '')
    assert.equal(db.prepare('SELECT count(*) AS n FROM estimate_approval_history').get().n, 0, 'Migration must not invent approval events')
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  } finally { db.close() }
})

test('real quote revision preserves acceptance, expires old links, reopens pipeline and reorders accepted history', { timeout: 120000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'psc-quote-revision-')), dest = join(tmp, 'demo'), server = await createHttpTestServer()
  let db
  try {
    const built = spawnSync(process.execPath, ['bin/demo.mjs', dest, String(server.port)], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 90000 })
    assert.equal(built.status, 0, built.stderr)
    const env = JSON.parse(readFileSync(join(dest, 'demo-env.json'), 'utf8'))
    await server.start({ cwd: dest, env, args: ['--no-warnings', '--import', './bin/demo-network-guard.mjs', 'server.mjs'] })
    const login = await fetch(server.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'dylan@example.test', password: readFileSync(join(dest, 'LOGIN.txt'), 'utf8').match(/Password: (.+)/)[1] }) })
    assert.equal(login.status, 200)
    const cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
    const request = (path, { body, method = 'GET', authed = true } = {}) => fetch(new URL(path, server.base), {
      method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(authed ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000),
    })
    const json = async (path, options) => { const r = await request(path, options); assert([200,201].includes(r.status), await r.clone().text()); return r.json() }
    const detail = id => json('/api/estimates/' + id)
    const update = (id, body) => json('/api/estimates/' + id, { method: 'PUT', body })
    const approve = async id => json('/api/estimates/' + id + '/approve', { method: 'POST', body: { commercial_revision: (await detail(id)).commercial_revision } })
    const create = body => json('/api/estimates', { method: 'POST', body })
    const customer = await json('/api/contacts', { method: 'POST', body: { name: 'Quote revision fixture', email: 'revision@example.test' } })
    await json('/api/settings', { method: 'PUT', body: { estimate_terms: 'Original fixture terms' } })
    const line = { description: 'Fixture tees', detail: 'Blue print', decoration: 'Screen Print', sizes: { M: 1 }, unit_price: 100, taxable: true }
    const quote = await create({ contact_id: customer.id, items: [line], tax_rate: 0, notes: 'Original note', rush_days: 0, billing_address: '10 Buyer Lane', shipping_address: '20 Delivery Lane' })
    const id = quote.id
    db = new DatabaseSync(join(dest, 'data/tenants', readdirSync(join(dest, 'data/tenants'))[0], 'printshop.db'))
    let e = await detail(id), firstLink = e.share_url
    assert.equal(e.terms_snapshot, 'Original fixture terms')
    const publicApprove = firstLink.replace('/p/estimate/' + id + '?', '/p/estimate/' + id + '/approve?')
    assert.equal((await request(publicApprove, { method: 'POST', authed: false })).status, 302)
    e = await detail(id); const acceptedAt = e.approved_at
    assert.equal(e.status, 'approved'); assert(acceptedAt); assert.equal(e.approval_history.length, 1)
    assert.equal(e.approval_history[0].source, 'customer_link')
    assert.equal(e.approval_history[0].snapshot.total, 100)
    assert.equal(db.prepare('SELECT stage FROM opportunities WHERE estimate_id=?').get(id).stage, 'won')
    assert.match(await (await request(firstLink, { authed: false })).text(), /Approved — thank you/)

    const noOp = await update(id, { ...e, items: [{ ...line, unit_price: '100', taxable: true, sizes: { XL: 0, M: '1', S: 0 }, blank_cost: 12, matrix: { id: 9, name: 'Internal source only', row: '1', col: '1' } }], tax_rate: '0', rush_days: '0' })
    assert.equal(noOp.quote_revised, false); assert.equal(noOp.approval_invalidated, false)
    e = await detail(id); assert.equal(e.approved_at, acceptedAt); assert.equal(e.share_url, firstLink); assert.equal(e.status, 'approved')
    await json('/api/settings', { method: 'PUT', body: { estimate_terms: 'New default fixture terms' } })
    const sameTerms = await (await request(firstLink, { authed: false })).text()
    assert.match(sameTerms, /Original fixture terms/); assert.doesNotMatch(sameTerms, /New default fixture terms/)
    const pdf = Buffer.from(await (await request('/api/estimates/' + id + '/pdf')).arrayBuffer()).toString('latin1')
    assert.match(pdf, /Original fixture terms/); assert.doesNotMatch(pdf, /New default fixture terms/)

    const changed = await update(id, { items: [{ ...line, unit_price: 200 }] })
    assert.equal(changed.status, 'draft'); assert.equal(changed.approved_at, null); assert.equal(changed.sent_at, null)
    assert.equal(changed.approval_invalidated, true); assert.equal(changed.commercial_revision, 1)
    e = await detail(id); assert.notEqual(e.share_url, firstLink)
    assert.equal(e.approval_history[0].snapshot.total, 100); assert.equal(e.approval_history[0].approved_at, acceptedAt); assert(e.approval_history[0].revoked_at)
    assert.equal((await request(firstLink, { authed: false })).status, 403)
    assert.equal((await request(publicApprove, { method: 'POST', authed: false })).status, 403)
    const currentPage = await (await request(e.share_url, { authed: false })).text()
    assert.match(currentPage, /Approve this estimate/); assert.doesNotMatch(currentPage, /Approved — thank you/)
    let opp = db.prepare('SELECT * FROM opportunities WHERE estimate_id=?').get(id)
    assert.equal(opp.stage, 'quoted'); assert.equal(opp.value, 200); assert.equal(opp.won_at, null)
    for (const action of ['approve','convert']) for (const body of [{}, { commercial_revision: 0 }]) {
      const denied = await request('/api/estimates/' + id + '/' + action, { method: 'POST', body })
      assert.equal(denied.status, 409, 'Missing or stale revision cannot accept the edited quote')
      assert.equal((await denied.json()).code, 'estimate_changed')
    }
    assert.equal(db.prepare('SELECT count(*) AS n FROM invoices WHERE estimate_id=?').get(id).n, 0)
    assert.equal((await detail(id)).status, 'draft')

    await approve(id); e = await detail(id); assert.equal(e.approval_history.length, 2)
    const exact = () => JSON.stringify({ estimate: db.prepare('SELECT * FROM estimates WHERE id=?').get(id), history: db.prepare('SELECT * FROM estimate_approval_history WHERE estimate_id=? ORDER BY id').all(id), opportunity: db.prepare('SELECT * FROM opportunities WHERE estimate_id=?').get(id) })
    const beforeFailure = exact()
    db.exec("CREATE TRIGGER fixture_revision_failure BEFORE UPDATE ON estimates WHEN NEW.notes='force fixture rollback' BEGIN SELECT RAISE(ABORT,'fixture failure'); END")
    assert.equal((await request('/api/estimates/' + id, { method: 'PUT', body: { notes: 'force fixture rollback' } })).status, 500)
    assert.equal(exact(), beforeFailure, 'History, key, acceptance and pipeline roll back together')
    db.exec('DROP TRIGGER fixture_revision_failure')
    db.exec("CREATE TRIGGER fixture_pipeline_failure BEFORE UPDATE ON opportunities WHEN NEW.value=250 BEGIN SELECT RAISE(ABORT,'fixture pipeline failure'); END")
    assert.equal((await request('/api/estimates/' + id, { method: 'PUT', body: { items: [{ ...line, unit_price: 250 }] } })).status, 500)
    assert.equal(exact(), beforeFailure, 'Pipeline refusal also rolls back the revised quote and archived acceptance')
    db.exec('DROP TRIGGER fixture_pipeline_failure')
    await update(id, { items: [line] }); e = await detail(id)
    assert.equal(e.status, 'draft'); assert.equal(e.approved_at, null); assert.equal(e.commercial_revision, 2)
    assert.notEqual(e.share_url, firstLink, 'Undoing price cannot revive the old approval link')
    assert(e.approval_history.every(h => h.revoked_at))
    const newerDraft = await create({ contact_id: customer.id, items: [{ description: 'Unaccepted new idea', qty: 1, unit_price: 999 }], tax_rate: 0 })
    assert(newerDraft.id > id)
    const reorder = await json('/api/contacts/' + customer.id + '/reorder', { method: 'POST', body: {} })
    assert.equal(reorder.from, quote.estimate_number)
    const reordered = await detail(reorder.estimate_id)
    assert.equal(reordered.status, 'draft'); assert.equal(reordered.items[0].unit_price, 200)
    assert.equal(reordered.terms_snapshot, 'New default fixture terms')
    const alreadyAccepted = await create({ contact_id: customer.id, items: [{ description: 'New accepted order', qty: 1, unit_price: 325 }], tax_rate: 0 })
    await approve(alreadyAccepted.id)
    const fromAccepted = await json('/api/contacts/' + customer.id + '/reorder', { method: 'POST', body: {} })
    assert.equal(fromAccepted.from, alreadyAccepted.estimate_number)
    assert.equal((await detail(fromAccepted.estimate_id)).subtotal, 325, 'New reorder uses accepted line pricing before its current tax rate')

    const completedCustomer = await json('/api/contacts', { method: 'POST', body: { name: 'Imported completed work fixture' } })
    const completed = await create({ contact_id: completedCustomer.id, items: [{ description: 'Imported completed run', qty: 1, unit_price: 333 }], tax_rate: 0 })
    db.prepare("INSERT INTO jobs(contact_id,estimate_id,job_number,title,status,stage) VALUES(?,?,'FIX-COMPLETE','Imported complete fixture','complete','complete')").run(completedCustomer.id,completed.id)
    const completedReorder = await json('/api/contacts/' + completedCustomer.id + '/reorder', { method: 'POST', body: {} })
    assert.equal(completedReorder.from, completed.estimate_number)
    assert.equal((await detail(completedReorder.estimate_id)).subtotal, 333)

    for (const [field, value] of [['notes','Changed instructions'],['rush_days',3],['tax_rate',5],['billing_address','New billing location'],['shipping_address','New ship-to'],['terms_snapshot','Custom revised terms']]) {
      await approve(id)
      const prior = await detail(id), result = await update(id, { [field]: value })
      assert.equal(result.approval_invalidated, true, field + ' requires fresh approval')
      assert.equal(result.status, 'draft'); assert.equal(result.commercial_revision, prior.commercial_revision + 1)
      assert.equal((await request(prior.share_url, { authed: false })).status, 403)
    }
    const other = await json('/api/contacts', { method: 'POST', body: { name: 'Another fixture buyer', email: 'another-revision@example.test' } })
    const linkedQuote = await create({ contact_id: customer.id, items: [line], tax_rate: 0, shipping_address: '100 Original Lane' })
    const linkedJob = await json('/api/jobs', { method: 'POST', body: { contact_id: customer.id, estimate_id: linkedQuote.id, title: 'Earlier uninvoiced job', shipping_address: '100 Original Lane' } })
    await approve(linkedQuote.id)
    const beforeRetarget = await detail(linkedQuote.id)
    const deniedRetarget = await request('/api/estimates/' + linkedQuote.id, { method: 'PUT', body: { contact_id: other.id } })
    assert.equal(deniedRetarget.status, 409); assert.equal((await deniedRetarget.json()).code, 'quote_job_customer_mismatch')
    assert.deepEqual(await detail(linkedQuote.id), beforeRetarget, 'Retarget refusal leaves quote approval and history intact')
    // Reproduce a pre-upgrade bad association, which PUT now prevents, without real customer data.
    db.prepare('UPDATE estimates SET contact_id=? WHERE id=?').run(other.id, linkedQuote.id)
    const legacyConvert = await request('/api/estimates/' + linkedQuote.id + '/convert', { method: 'POST', body: { commercial_revision: 0 } })
    assert.equal(legacyConvert.status, 409); assert.equal((await legacyConvert.json()).code, 'quote_job_customer_mismatch')
    assert.equal(db.prepare('SELECT count(*) AS n FROM invoices WHERE estimate_id=?').get(linkedQuote.id).n, 0)
    db.prepare('UPDATE estimates SET contact_id=? WHERE id=?').run(customer.id, linkedQuote.id)
    await update(linkedQuote.id, { shipping_address: '300 Agreed Lane' })
    await approve(linkedQuote.id)
    const linkedCurrent = await detail(linkedQuote.id)
    const shippingConvert = await request('/api/estimates/' + linkedQuote.id + '/convert', { method: 'POST', body: { commercial_revision: linkedCurrent.commercial_revision } })
    assert.equal(shippingConvert.status, 409); assert.equal((await shippingConvert.json()).code, 'quote_job_shipping_mismatch')
    assert.equal((await json('/api/jobs/' + linkedJob.id)).shipping_address, '100 Original Lane', 'An explicit job destination is never silently replaced')
    assert.equal(db.prepare('SELECT count(*) AS n FROM invoices WHERE estimate_id=?').get(linkedQuote.id).n, 0)
    await json('/api/jobs/' + linkedJob.id, { method: 'PUT', body: { shipping_address: '300 Agreed Lane' } })
    const adopted = await json('/api/estimates/' + linkedQuote.id + '/convert', { method: 'POST', body: { commercial_revision: linkedCurrent.commercial_revision } })
    assert.equal(adopted.job_id, linkedJob.id); assert.equal(adopted.job_reused, true)
    assert.equal((await json('/api/invoices/' + adopted.invoice_id)).shipping_address, '300 Agreed Lane')
    assert.equal((await json('/api/jobs/' + linkedJob.id)).shipping_address, '300 Agreed Lane')
    await approve(id); const retargeted = await update(id, { contact_id: other.id })
    assert.equal(retargeted.approval_invalidated, true)
    opp = db.prepare('SELECT * FROM opportunities WHERE estimate_id=?').get(id)
    assert.equal(opp.contact_id, other.id); assert.equal(opp.stage, 'quoted')
    const neverAccepted = await json('/api/contacts', { method: 'POST', body: { name: 'Draft-only fixture' } })
    await create({ contact_id: neverAccepted.id, items: [line], tax_rate: 0 })
    assert.equal((await request('/api/contacts/' + neverAccepted.id + '/reorder', { method: 'POST', body: {} })).status, 400)
    assert.equal((await request('/api/estimates/' + id, { method: 'PUT', body: { terms_snapshot: { bad: true } } })).status, 400)
    const historyRows = db.prepare('SELECT snapshot FROM estimate_approval_history WHERE estimate_id=? ORDER BY commercial_revision').all(id)
    assert.equal(JSON.parse(historyRows[0].snapshot).contact_id, customer.id, 'Retargeting retains the accepted buyer')
    const neighborResponse = await request('/api/auth/signup', { method: 'POST', body: { shop_name: 'Approval history neighbor', owner_name: 'Neighbor', owner_email: 'history-neighbor@example.test', password: 'Fixture-neighbor-password-1' } })
    assert.equal(neighborResponse.status, 200)
    const neighborCookie = neighborResponse.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
    const neighborRead = await fetch(server.base + '/api/estimates/' + id, { headers: { Cookie: neighborCookie } })
    assert.equal(neighborRead.status, 404, 'Approval history is private to its original shop')
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally {
    await server.close(); db?.close(); rmSync(tmp, { recursive: true, force: true })
  }
})
