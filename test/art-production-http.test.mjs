import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'

const sourceBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" fill="navy"/></svg>')
const productionBytes = Buffer.from('%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 144 144\nnewpath 0 0 moveto 144 144 lineto stroke\nshowpage\n%%EOF\n')
const specs = { method: 'Screen Print', print_width: 12, print_height: 14, units: 'in',
  ink_notes: 'Fixture navy ink, white underbase', machine_profile: 'Fixture manual press' }

test('production artwork HTTP binds a manual technical release to current proof and private files, with stage and task gates', { timeout: 180000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'psc-art-production-')), dest = join(temp, 'demo'), probe = createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  let child, db, control, neighborDb
  try {
    const built = spawnSync(process.execPath, ['bin/demo.mjs', dest, String(port)], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 90000,
    })
    assert.equal(built.status, 0, built.stderr)
    const env = JSON.parse(readFileSync(join(dest, 'demo-env.json'), 'utf8')); env.PSC_TICK_MS = '3600000'
    let log = ''
    child = spawn(process.execPath, ['--no-warnings', '--import', './bin/demo-network-guard.mjs', 'server.mjs'], {
      cwd: dest, env, stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', data => { log += data }); child.stderr.on('data', data => { log += data })
    for (let i = 0; i < 600 && child.exitCode === null && !log.includes('(ws /ws live'); i++) await new Promise(resolve => setTimeout(resolve, 50))
    assert.match(log, /ws \/ws live/)
    const base = `http://127.0.0.1:${port}`
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'dylan@example.test', password: readFileSync(join(dest, 'LOGIN.txt'), 'utf8').match(/Password: (.+)/)[1] }) })
    assert.equal(login.status, 200)
    const owner = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
    const request = (path, body, method = 'POST', cookie = owner) => fetch(base + path, {
      method, headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const json = async (path, body, method = 'POST', cookie = owner) => {
      const response = await request(path, body, method, cookie)
      assert.equal(response.status, 200, await response.clone().text())
      return response.json()
    }
    const upload = (path, bytes, name, mime, fields = {}, cookie = owner) => {
      const form = new FormData()
      for (const [key, value] of Object.entries(fields)) form.append(key, String(value))
      form.append('file', new Blob([bytes], { type: mime }), name)
      return fetch(base + path, { method: 'POST', headers: { Cookie: cookie }, body: form })
    }
    const uploadJson = async (...args) => {
      const response = await upload(...args)
      assert.equal(response.status, 200, await response.clone().text())
      return response.json()
    }
    const job = await json('/api/jobs', { contact_id: 1, title: 'Manual technical release fixture', approval_gated: true })
    const state = (id = job.id, cookie = owner) => json(`/api/jobs/${id}/art-production`, undefined, 'GET', cookie)
    const pkg = () => json(`/api/jobs/${job.id}/print-package`, undefined, 'GET')
    const details = () => json(`/api/jobs/${job.id}`, undefined, 'GET')
    let current = await state()
    assert.equal(current.revision, 0); assert.equal(current.required, false); assert.equal(current.technical_ready, false)
    assert.equal(current.appearance, null); assert.deepEqual(current.source_files, []); assert.deepEqual(current.production_files, [])
    assert.equal((await pkg()).ready, false)

    const first = await uploadJson(`/api/jobs/${job.id}/art`, sourceBytes, 'appearance-one.svg', 'image/svg+xml')
    await json(`/api/art/${first.id}/decide`, { decision: 'approved', by: 'Fixture customer' })
    current = await state()
    assert.equal(current.appearance.id, first.id); assert.equal(current.appearance.approved, true)
    assert.equal(current.technical_ready, false, 'customer appearance approval cannot certify production files')
    assert.equal((await pkg()).ready, false)
    const ticketUrl = (await details()).ticket_url
    let ticket = await (await fetch(base + ticketUrl)).text()
    assert.ok(ticket.includes(first.filename))

    const beforeUpload = current.revision
    current = await uploadJson(`/api/jobs/${job.id}/art-assets`, sourceBytes, 'original-source.svg', 'image/svg+xml', { revision: beforeUpload, role: 'source' })
    assert.ok(current.revision > beforeUpload)
    assert.equal(current.source_files.length, 1); assert.equal(current.production_files.length, 0)
    const sourceId = current.source_files[0].id
    const staleUpload = await upload(`/api/jobs/${job.id}/art-assets`, productionBytes, 'stale.eps', 'application/postscript', { revision: beforeUpload, role: 'production' })
    assert.equal(staleUpload.status, 409)
    assert.equal((await state()).production_files.length, 0)
    current = await uploadJson(`/api/jobs/${job.id}/art-assets`, productionBytes, 'film-positive.eps', 'application/postscript', { revision: current.revision, role: 'production' })
    const productionId = current.production_files[0].id
    assert.equal(current.source_files[0].id, sourceId, 'production upload keeps the original source as a separate asset')
    assert.equal(current.technical_ready, false)
    const releaseBody = (revision, proofId = first.id) => ({ revision, proof_id: proofId,
      production_asset_ids: [productionId], source_asset_ids: [sourceId], specs, notes: 'Manually reviewed fixture files.', reviewed_confirmed: true })
    assert.equal((await request(`/api/jobs/${job.id}/art-release`, { ...releaseBody(current.revision), reviewed_confirmed: false })).status, 400)
    assert.equal((await request(`/api/jobs/${job.id}/art-release`, { ...releaseBody(current.revision), specs: { ...specs, print_width: 0 } })).status, 400)
    assert.equal((await request(`/api/jobs/${job.id}/art-release`, releaseBody(beforeUpload))).status, 409)
    assert.equal((await state()).revision, current.revision, 'invalid release attempts do not alter review state')
    const productionPath = join(dest, 'public/uploads', current.production_files[0].filename)
    try {
      writeFileSync(productionPath, Buffer.concat([productionBytes, Buffer.from('% fixture changed bytes\n')]))
      let invalid = await request(`/api/jobs/${job.id}/art-release`, releaseBody(current.revision))
      assert.equal(invalid.status, 409); assert.equal((await invalid.json()).code, 'art_asset_changed')
      writeFileSync(productionPath, productionBytes)
      renameSync(productionPath, productionPath + '.missing')
      try {
        assert.equal((await request(`/api/jobs/${job.id}/art-assets/${productionId}/download`, undefined, 'GET')).status, 404)
        invalid = await request(`/api/jobs/${job.id}/art-release`, releaseBody(current.revision))
        assert.equal(invalid.status, 409); assert.equal((await invalid.json()).code, 'art_asset_changed')
      } finally { renameSync(productionPath + '.missing', productionPath) }
    } finally { writeFileSync(productionPath, productionBytes) }
    assert.equal((await state()).revision, current.revision, 'failed byte-integrity checks cannot consume the review revision')

    const otherJob = await json('/api/jobs', { contact_id: 1, title: 'Other job asset fixture' })
    let other = await state(otherJob.id)
    other = await uploadJson(`/api/jobs/${otherJob.id}/art-assets`, productionBytes, 'other-job.eps', 'application/postscript', { revision: other.revision, role: 'production' })
    assert.equal((await request(`/api/jobs/${job.id}/art-release`, { ...releaseBody(current.revision), production_asset_ids: [other.production_files[0].id] })).status, 400)
    assert.equal((await request(`/api/jobs/${otherJob.id}/art-assets/${productionId}/download`, undefined, 'GET')).status, 404)

    current = await json(`/api/jobs/${job.id}/art-release`, releaseBody(current.revision))
    assert.equal(current.technical_ready, true); assert.equal(current.required, true)
    assert.equal(current.release.proof_id, first.id); assert.equal(current.release.art_revision, current.revision)
    assert.equal(current.release.production_manifest[0].id, productionId)
    assert.equal(current.release.production_manifest[0].sha256, createHash('sha256').update(productionBytes).digest('hex'))
    assert.equal(current.release.source_manifest[0].id, sourceId)
    assert.equal(current.release.source_manifest[0].sha256, createHash('sha256').update(sourceBytes).digest('hex'))
    assert.deepEqual(current.release.specs, specs)
    assert.equal((await pkg()).ready, true)
    const assetUrl = `/api/jobs/${job.id}/art-assets/${productionId}/download`
    assert.equal((await request(`/uploads/${current.production_files[0].filename}`, undefined, 'GET')).status, 404,
      'production assets are not available through public proof-file serving')
    const download = await request(assetUrl, undefined, 'GET')
    assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition'), /attachment/i)
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), productionBytes)
    assert.equal((await request(assetUrl, undefined, 'GET', '')).status, 401)
    ticket = await (await fetch(base + ticketUrl)).text()
    assert.ok(!ticket.includes(assetUrl), 'public work tickets never distribute production download links')

    const slug = readdirSync(join(dest, 'data/tenants'))[0]
    db = new DatabaseSync(join(dest, 'data/tenants', slug, 'printshop.db')); db.exec('PRAGMA busy_timeout=5000')
    control = new DatabaseSync(join(dest, 'data/control.db')); control.exec('PRAGMA busy_timeout=5000')
    const ownerRow = control.prepare('SELECT * FROM members LIMIT 1').get()
    const staffId = Number(control.prepare('INSERT INTO members(tenant_id,name,email,password_hash,role,status) VALUES(?,?,?,?,?,?)')
      .run(ownerRow.tenant_id, 'Fixture press operator', 'press-fixture@example.test', ownerRow.password_hash, 'staff', 'active').lastInsertRowid)
    control.prepare('INSERT INTO sessions(token,tenant_id,member_id,expires_at) VALUES(?,?,?,?)')
      .run('art-production-staff-fixture', ownerRow.tenant_id, staffId, new Date(Date.now() + 3600000).toISOString().replace('T', ' ').slice(0, 19))
    const staff = owner.replace(/=[^;]+/, '=art-production-staff-fixture')
    assert.equal((await state(job.id, staff)).technical_ready, true)
    assert.equal((await request(assetUrl, undefined, 'GET', staff)).status, 200)
    for (const [suffix, body] of [
      ['art-release', releaseBody(current.revision)],
      ['art-production/require', { revision: current.revision, required: false }],
      ['art-release/revoke', { revision: current.revision, note: 'Staff cannot revoke' }],
    ]) assert.equal((await request(`/api/jobs/${job.id}/${suffix}`, body, 'POST', staff)).status, 403)
    assert.equal((await state()).technical_ready, true)

    const signup = await request('/api/auth/signup', { shop_name: 'Neighbor art fixture', owner_name: 'Other owner',
      owner_email: 'neighbor-art@example.test', password: 'Neighbor-fixture-password' })
    assert.equal(signup.status, 200, await signup.clone().text())
    const neighbor = signup.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
    const neighborTenant = control.prepare("SELECT * FROM tenants WHERE owner_email='neighbor-art@example.test'").get()
    neighborDb = new DatabaseSync(join(dest, 'data/tenants', neighborTenant.slug, 'printshop.db'))
    neighborDb.prepare('INSERT INTO contacts(id,name,email) VALUES(?,?,?)').run(1, 'Neighbor customer', 'customer@neighbor.example.test')
    neighborDb.prepare('INSERT INTO jobs(id,contact_id,job_number,title,status,stage) VALUES(?,?,?,?,?,?)')
      .run(job.id, 1, 'NEIGHBOR-1', 'Same numeric job ID in another shop', 'active', 'new')
    assert.equal((await state(job.id, neighbor)).production_files.length, 0)
    assert.equal((await request(assetUrl, undefined, 'GET', neighbor)).status, 404)
    const crossRelease = await request(`/api/jobs/${job.id}/art-release`, releaseBody(0), 'POST', neighbor)
    assert.equal(crossRelease.status, 400)
    assert.equal((await state()).technical_ready, true, 'neighbor requests cannot modify the reviewed shop')

    current = await json(`/api/jobs/${job.id}/art-release/revoke`, { revision: current.revision, note: 'Recheck print setup' })
    assert.equal(current.technical_ready, false); assert.equal((await pkg()).ready, false)
    let blocked = await request(`/api/jobs/${job.id}/stage`, { stage: 'production' }, 'PATCH')
    assert.equal(blocked.status, 409)
    assert.match((await blocked.json()).error, /production|technical|release/i)
    const template = await json('/api/production/templates', { name: 'Technical release production fixture', steps: [
      { title: 'Print reviewed files', department: 'Screen Print', stage: 'production' },
      { title: 'Quality check', department: 'QC', stage: 'qc' },
    ] })
    let workflow = await json(`/api/production/jobs/${job.id}/workflow`, { revision: 0, template_ids: [template.id] })
    blocked = await request(`/api/production/jobs/${job.id}/tasks/${workflow.tasks[0].id}/action`, { revision: workflow.revision, action: 'complete' })
    assert.equal(blocked.status, 409); assert.match((await blocked.json()).error, /production|technical|release/i)
    blocked = await request(`/api/production/jobs/${job.id}/tasks/${workflow.tasks[0].id}/action`, {
      revision: workflow.revision, action: 'skip', note: 'A task skip cannot bypass the technical hold',
    })
    assert.equal(blocked.status, 409)
    const afterBlockedSkip = await json(`/api/v1/jobs/${job.id}/workflow`, undefined, 'GET')
    assert.equal(afterBlockedSkip.revision, workflow.revision, 'failed advancement rolls back the task event and revision')
    assert.equal(afterBlockedSkip.tasks[0].status, 'pending')
    current = await state()
    current = await json(`/api/jobs/${job.id}/art-release`, releaseBody(current.revision))
    workflow = await json(`/api/v1/jobs/${job.id}/workflow`, undefined, 'GET')
    await json(`/api/production/jobs/${job.id}/tasks/${workflow.tasks[0].id}/action`, { revision: workflow.revision, action: 'complete' })

    const beforeReplacement = current.revision
    const second = await uploadJson(`/api/jobs/${job.id}/art`, sourceBytes, 'appearance-two.svg', 'image/svg+xml')
    current = await state()
    assert.ok(current.revision > beforeReplacement)
    assert.equal(current.appearance.id, second.id); assert.equal(current.appearance.approved, false)
    assert.equal(current.technical_ready, false); assert.equal((await pkg()).ready, false)
    ticket = await (await fetch(base + ticketUrl)).text()
    assert.ok(!ticket.includes(first.filename), 'ticket cannot revive a historical approved proof')
    assert.ok(!ticket.includes(second.filename), 'a pending appearance proof is not shown as approved')
    assert.equal((await request(`/api/jobs/${job.id}/art-release`, releaseBody(current.revision, first.id))).status, 409)
    await json(`/api/art/${second.id}/decide`, { decision: 'approved', by: 'Fixture customer' })
    current = await state()
    assert.equal(current.appearance.approved, true); assert.equal(current.technical_ready, false)
    ticket = await (await fetch(base + ticketUrl)).text()
    assert.ok(ticket.includes(second.filename)); assert.ok(!ticket.includes(first.filename))
    current = await json(`/api/jobs/${job.id}/art-release`, releaseBody(current.revision, second.id))
    assert.equal(current.technical_ready, true)
    // Staff can provide new source files, but their upload invalidates the manager's old review.
    current = await uploadJson(`/api/jobs/${job.id}/art-assets`, sourceBytes, 'revised-source.svg', 'image/svg+xml', { revision: current.revision, role: 'source' }, staff)
    assert.equal(current.source_files.length, 2); assert.equal(current.technical_ready, false)
    assert.equal(current.appearance.approved, true, 'technical invalidation does not rewrite the customer appearance decision')
    assert.equal((await pkg()).ready, false)

    // Shops can still run their ordinary manual flow without opting into the technical gate.
    other = await state(otherJob.id)
    assert.equal(other.required, false)
    other = await json(`/api/jobs/${otherJob.id}/art-production/require`, { revision: other.revision, required: true })
    assert.equal((await request(`/api/jobs/${otherJob.id}/stage`, { stage: 'production' }, 'PATCH')).status, 409)
    other = await json(`/api/jobs/${otherJob.id}/art-production/require`, { revision: other.revision, required: false })
    assert.equal(other.technical_ready, false)
    await json(`/api/jobs/${otherJob.id}/stage`, { stage: 'production' }, 'PATCH')
    const preflightTemplate = await json('/api/production/templates', { name: 'Reusable preflight fixture', steps: [
      { title: 'Review prepared files', department: 'Prepress', stage: 'prepress', gate: 'preflight' },
    ] })
    const preflight = await json(`/api/production/jobs/${otherJob.id}/workflow`, { revision: 0, template_ids: [preflightTemplate.id] })
    assert.equal(preflight.tasks[0].gate, 'preflight')
    assert.equal((await request(`/api/production/jobs/${otherJob.id}/tasks/${preflight.tasks[0].id}/action`, {
      revision: preflight.revision, action: 'complete',
    })).status, 409, 'a reusable preflight task enforces its own review requirement before production')

    // Uninvoiced and older jobs can resolve their garment lines from the linked estimate.
    // Editing that estimate must invalidate its release just like changing the job directly.
    const originalItems = [{ description: 'Estimate white tee', sizes: { M: 10, L: 2 }, unit_price: 10 }]
    const estimate = await json('/api/estimates', { contact_id: 1, items: originalItems })
    const linked = await json('/api/jobs', { contact_id: 1, estimate_id: estimate.id, title: 'Estimate fallback production fixture' })
    const pinned = await json('/api/jobs', { contact_id: 1, estimate_id: estimate.id, title: 'Independent production grid fixture' })
    await json(`/api/jobs/${pinned.id}`, { line_sizes: [{ description: 'Pinned cap', garment: 'Pinned cap', sizes: { OS: 5 } }] }, 'PUT')
    const pinnedBefore = await state(pinned.id)
    const linkedProof = await uploadJson(`/api/jobs/${linked.id}/art`, sourceBytes, 'linked-appearance.svg', 'image/svg+xml')
    await json(`/api/art/${linkedProof.id}/decide`, { decision: 'approved' })
    let linkedState = await state(linked.id)
    linkedState = await uploadJson(`/api/jobs/${linked.id}/art-assets`, productionBytes, 'linked-production.eps', 'application/postscript', { role: 'production', revision: linkedState.revision })
    const linkedRelease = revision => ({ revision, proof_id: linkedProof.id, production_asset_ids: [linkedState.production_files[0].id],
      source_asset_ids: [], specs, reviewed_confirmed: true })
    linkedState = await json(`/api/jobs/${linked.id}/art-release`, linkedRelease(linkedState.revision))
    const linkedPkg = () => json(`/api/jobs/${linked.id}/print-package`, undefined, 'GET')
    const releasedRevision = linkedState.revision, releasedId = linkedState.release.id
    assert.equal((await linkedPkg()).ready, true)
    await json(`/api/estimates/${estimate.id}`, { notes: 'Billing note only' }, 'PUT')
    await json(`/api/estimates/${estimate.id}`, { items: [{ ...originalItems[0], unit_price: 12, sizes: { L: 2, M: 10 } }] }, 'PUT')
    assert.equal((await state(linked.id)).revision, releasedRevision)
    assert.equal((await linkedPkg()).ready, true, 'pricing, notes and size-key ordering do not change production requirements')
    const replacementItems = [{ description: 'Replacement navy hoodie', sizes: { L: 99 }, unit_price: 12 }]
    db.exec(`CREATE TRIGGER fixture_estimate_art_rollback BEFORE UPDATE ON jobs
      WHEN NEW.id=${linked.id} AND NEW.art_revision<>OLD.art_revision
      BEGIN SELECT RAISE(ABORT,'fixture art revision unavailable'); END`)
    try {
      assert.equal((await request(`/api/estimates/${estimate.id}`, { items: replacementItems }, 'PUT')).status, 500)
      assert.equal((await linkedPkg()).ready, true, 'failed release invalidation rolls back the estimate edit')
      assert.equal((await linkedPkg()).lines[0].description, 'Estimate white tee')
      assert.equal((await state(linked.id)).revision, releasedRevision)
    } finally { db.exec('DROP TRIGGER fixture_estimate_art_rollback') }
    await json(`/api/estimates/${estimate.id}`, { items: replacementItems }, 'PUT')
    let changedPackage = await linkedPkg()
    assert.equal(changedPackage.ready, false)
    assert.equal(changedPackage.lines[0].description, 'Replacement navy hoodie')
    assert.deepEqual(changedPackage.lines[0].sizes, { L: 99 })
    assert.ok((await state(linked.id)).revision > releasedRevision)
    assert.ok((await state(linked.id)).release.revoked_at)
    assert.equal((await state(pinned.id)).revision, pinnedBefore.revision, 'a job with its own garment grid is independent of the estimate fallback')
    await json(`/api/estimates/${estimate.id}`, { items: originalItems }, 'PUT')
    changedPackage = await linkedPkg()
    assert.equal(changedPackage.lines[0].description, 'Estimate white tee')
    assert.equal(changedPackage.ready, false, 'undoing a production change cannot revive the historical release')
    linkedState = await state(linked.id)
    linkedState = await json(`/api/jobs/${linked.id}/art-release`, linkedRelease(linkedState.revision))
    assert.equal(linkedState.technical_ready, true); assert.notEqual(linkedState.release.id, releasedId)

    // Reproduce the actual job form: it posts its unchanged quantities alongside title/date.
    // A board-created job initially has no stored line_sizes, and old grids can use any key order.
    const scheduled = await json('/api/jobs', { contact_id: 1, title: 'Scheduling fixture',
      garment: 'Gildan 5000 — Navy', quantities: '10 M / 2 L' })
    db.prepare('UPDATE jobs SET sizes=? WHERE id=?').run('{"L":2,"M":10}', scheduled.id)
    const scheduledProof = await uploadJson(`/api/jobs/${scheduled.id}/art`, sourceBytes, 'schedule-appearance.svg', 'image/svg+xml')
    await json(`/api/art/${scheduledProof.id}/decide`, { decision: 'approved' })
    let scheduledState = await state(scheduled.id)
    scheduledState = await uploadJson(`/api/jobs/${scheduled.id}/art-assets`, productionBytes, 'schedule-production.eps', 'application/postscript', { role: 'production', revision: scheduledState.revision })
    const releaseScheduled = async () => {
      scheduledState = await state(scheduled.id)
      scheduledState = await json(`/api/jobs/${scheduled.id}/art-release`, { revision: scheduledState.revision, proof_id: scheduledProof.id,
        production_asset_ids: [scheduledState.production_files[0].id], source_asset_ids: [], specs, reviewed_confirmed: true })
    }
    await releaseScheduled()
    const schedulingRevision = scheduledState.revision
    const originalStorage = db.prepare('SELECT line_sizes,sizes FROM jobs WHERE id=?').get(scheduled.id)
    const formBody = { contact_id: 1, title: 'Rescheduled printing', decoration: scheduled.decoration,
      garment: scheduled.garment, quantities: scheduled.quantities, due_date: '2026-12-03', assigned_to: 'Fixture press 1', notes: 'Schedule only', rush: true }
    await json(`/api/jobs/${scheduled.id}`, formBody, 'PUT')
    assert.equal((await state(scheduled.id)).revision, schedulingRevision)
    assert.equal((await state(scheduled.id)).technical_ready, true)
    assert.deepEqual({ ...db.prepare('SELECT line_sizes,sizes FROM jobs WHERE id=?').get(scheduled.id) }, { ...originalStorage },
      'unchanged effective production inputs keep original fallback and grid bytes')
    assert.equal(db.prepare('SELECT due_date FROM jobs WHERE id=?').get(scheduled.id).due_date, formBody.due_date)
    db.exec(`CREATE TRIGGER fixture_job_art_rollback BEFORE UPDATE ON jobs
      WHEN NEW.id=${scheduled.id} AND NEW.art_revision<>OLD.art_revision
      BEGIN SELECT RAISE(ABORT,'fixture job art revision unavailable'); END`)
    try {
      assert.equal((await request(`/api/jobs/${scheduled.id}`, { ...formBody, quantities: '11 M / 2 L' }, 'PUT')).status, 500)
      assert.equal(db.prepare('SELECT quantities FROM jobs WHERE id=?').get(scheduled.id).quantities, scheduled.quantities)
      assert.equal((await state(scheduled.id)).technical_ready, true)
    } finally { db.exec('DROP TRIGGER fixture_job_art_rollback') }
    await json(`/api/jobs/${scheduled.id}`, { ...formBody, quantities: '11 M / 2 L' }, 'PUT')
    assert.equal((await state(scheduled.id)).technical_ready, false)
    assert.equal(JSON.parse(db.prepare('SELECT sizes FROM jobs WHERE id=?').get(scheduled.id).sizes).M, 11)
    await json(`/api/jobs/${scheduled.id}`, formBody, 'PUT')
    assert.equal((await state(scheduled.id)).technical_ready, false, 'restoring old quantities still needs a new staff review')
    await releaseScheduled()
    await json(`/api/jobs/${scheduled.id}`, { ...formBody, garment: 'Gildan 18500 — Navy' }, 'PUT')
    assert.equal((await state(scheduled.id)).technical_ready, false)
    let scheduledPackage = await json(`/api/jobs/${scheduled.id}/print-package`, undefined, 'GET')
    assert.equal(scheduledPackage.lines[0].garment, 'Gildan 18500 — Navy')
    await releaseScheduled()
    await json(`/api/jobs/${scheduled.id}`, { line_sizes: [{ ...scheduledPackage.lines[0], garment: 'Different supplier SKU' }] }, 'PUT')
    assert.equal((await state(scheduled.id)).technical_ready, false, 'a changed explicit garment is not hidden by an unchanged description')
    scheduledPackage = await json(`/api/jobs/${scheduled.id}/print-package`, undefined, 'GET')
    assert.equal(scheduledPackage.lines[0].garment, 'Different supplier SKU')
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  } finally {
    neighborDb?.close(); control?.close(); db?.close()
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await new Promise(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 10000)
        child.once('exit', () => { clearTimeout(timer); resolve() })
      })
    }
    rmSync(temp, { recursive: true, force: true })
  }
})
