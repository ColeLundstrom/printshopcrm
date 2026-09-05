import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

process.env.PSC_DB = ':memory:'
const dbmod = await import('../lib/db.mjs')
const art = await import('../lib/art-production.mjs')
const { initProductionSchema } = await import('../lib/production-schema.mjs')
const { initDb, getDb, tenantStore, run, get, all, tx, SCHEMA, inTransaction } = dbmod
after(() => getDb().close())
const reviewer = { id: 7, name: 'Production manager' }
const specs = { method: 'Screen printing', print_width: 10, print_height: 12, units: 'in', ink_notes: 'Two spot inks; compare to swatches', machine_profile: 'Manual press A' }
let serial = 0
function assetInput(revision, role, extra = {}) {
  return { revision, role, filename: `asset-${++serial}.png`, original_name: `${role} artwork.png`, mime: 'image/png', size: 4096, sha256: 'a'.repeat(64), ...extra }
}
async function fixture(fn) {
  const db = new DatabaseSync(':memory:'); initDb(db)
  try {
    return await tenantStore.run({ db }, async () => {
      run("INSERT INTO contacts(id,name) VALUES(1,'Synthetic customer')")
      for (const id of [1, 2]) {
        run("INSERT INTO jobs(id,contact_id,job_number,title,status,stage,art_approved_at) VALUES(?,1,?,'Artwork fixture','active','production','2026-09-04 10:00:00')", id, 'JOB-' + id)
        run("INSERT INTO art_versions(id,job_id,version,filename,original_name,mime,size,status,decided_at,decided_by) VALUES(?,?,1,?,'Customer proof.png','image/png',500,'approved','2026-09-04 10:00:00','Customer')", id, id, `proof-${id}.png`)
      }
      return await fn(db)
    })
  } finally { db.close() }
}
function ready(jobId = 1) {
  let state = art.getArtProduction(jobId)
  state = art.addArtAsset(jobId, assetInput(state.revision, 'source'), reviewer)
  state = art.addArtAsset(jobId, assetInput(state.revision, 'production'), reviewer)
  return art.releaseArt(jobId, { revision: state.revision, proof_id: state.appearance.id,
    production_asset_ids: [state.production_files[0].id], source_asset_ids: [state.source_files[0].id], specs, notes: 'Reviewed source and handoff in shop software.', reviewed_confirmed: true }, reviewer)
}
function releaseInput(state, extra = {}) {
  return { revision: state.revision, proof_id: state.appearance.id, production_asset_ids: state.production_files.map(f => f.id),
    source_asset_ids: state.source_files.map(f => f.id), specs, reviewed_confirmed: true, ...extra }
}

test('technical release records independent immutable file manifests and opts the job into enforcement', async () => fixture(() => {
  const before = art.getArtProduction(1)
  assert.equal(before.revision, 0)
  assert.equal(before.required, false)
  assert.equal(before.appearance.approved, true)
  assert.equal(before.technical_ready, false, 'customer approval never implies technical readiness')
  let state = ready()
  assert.equal(state.revision, 3)
  assert.equal(state.required, true)
  assert.equal(state.technical_ready, true)
  assert.deepEqual(state.blocking_reasons, [])
  assert.equal(state.release.proof_snapshot.id, 1)
  assert.equal(state.release.production_manifest[0].sha256, 'a'.repeat(64))
  assert.equal(state.release.source_manifest[0].role, 'source')
  assert.equal(state.release.reviewed_by, reviewer.name)
  assert.equal(state.release.reviewed_by_id, reviewer.id)
  assert.deepEqual(state.release.specs, specs)
  assert.equal(get('SELECT COUNT(*) n FROM production_jobs').n, 0, 'release never enrolls a legacy job')
  const same = art.requireArtRelease(1, { revision: state.revision, required: true }, reviewer)
  assert.equal(same.revision, state.revision)
  assert.equal(same.technical_ready, true, 'saving an already-enabled requirement must not revoke the release')
  assert.throws(() => run("UPDATE art_assets SET sha256=? WHERE id=?", 'b'.repeat(64), state.production_files[0].id), /immutable/)
  assert.throws(() => run("UPDATE art_releases SET specs='{}' WHERE id=?", state.release.id), /immutable/)
  const oldRelease = state.release
  state = art.addArtAsset(1, assetInput(state.revision, 'source'), reviewer)
  assert.equal(state.required, true)
  assert.equal(state.technical_ready, false)
  assert.ok(state.release.revoked_at)
  assert.match(state.release.revoked_reason, /Source file uploaded/)
  assert.deepEqual(state.release.production_manifest, oldRelease.production_manifest, 'old handoff evidence is never rewritten')
}))

test('release snapshot binds inherited estimate garment lines without invalidating for pricing-only changes', async () => fixture(() => {
  const items = [{ description: 'White tee', sizes: { M: 10 }, unit_price: 20 }]
  run("INSERT INTO estimates(id,contact_id,estimate_number,items) VALUES(1,1,'EST-INHERITED',?)", JSON.stringify(items))
  run('UPDATE jobs SET estimate_id=1 WHERE id=1')
  const released = ready()
  assert.equal(released.technical_ready, true)
  run('UPDATE estimates SET items=? WHERE id=1', JSON.stringify([{ ...items[0], unit_price: 25 }]))
  assert.equal(art.getArtProduction(1).technical_ready, true)
  run('UPDATE estimates SET items=? WHERE id=1', JSON.stringify([{ description: 'Navy hoodie', sizes: { L: 99 }, unit_price: 25 }]))
  assert.equal(art.getArtProduction(1).technical_ready, false, 'even a writer omitting recordArtChange cannot reuse the release with changed inherited garments')
  assert.equal(art.readinessForJobs([1]).get(1).technical_ready, false)
}))

test('release validation rejects stale/current-unapproved proofs, wrong roles, other jobs and unconfirmed specifications', async () => fixture(() => {
  let state = art.addArtAsset(1, assetInput(0, 'source'), reviewer)
  state = art.addArtAsset(1, assetInput(state.revision, 'production'), reviewer)
  const other = art.addArtAsset(2, assetInput(0, 'production'), reviewer)
  const invalid = [
    { revision: 0 }, { proof_id: 2 }, { reviewed_confirmed: 'true' }, { reviewed_confirmed: false },
    { production_asset_ids: [] }, { production_asset_ids: [state.source_files[0].id] },
    { production_asset_ids: [other.production_files[0].id] },
    { source_asset_ids: [state.production_files[0].id] },
    { production_asset_ids: [state.production_files[0].id, state.production_files[0].id] },
    { specs: { ...specs, print_width: 0 } }, { specs: { ...specs, print_height: Infinity } },
    { specs: { ...specs, print_width: '10' } }, { specs: { ...specs, units: 'pixels' } },
    { specs: { ...specs, method: '' } },
  ]
  for (const input of invalid) assert.throws(() => art.releaseArt(1, releaseInput(state, input), reviewer))
  assert.deepEqual(art.getArtProduction(1), state)
  assert.equal(get('SELECT COUNT(*) n FROM art_releases').n, 0)
  run('UPDATE jobs SET art_approved_at=NULL WHERE id=1')
  assert.throws(() => art.releaseArt(1, releaseInput(state), reviewer), /Approve the current/)
  run("UPDATE jobs SET art_approved_at='2026-09-04 10:00:00' WHERE id=1")
  run("UPDATE art_versions SET status='sent' WHERE id=1")
  assert.throws(() => art.releaseArt(1, releaseInput(state), reviewer), /Approve the current/)
  run("UPDATE art_versions SET status='approved' WHERE id=1")
  tx(() => {
    run("INSERT INTO art_versions(job_id,version,filename,status) VALUES(1,2,'new-proof.png','draft')")
    art.recordArtChange(1, reviewer, 'New proof requires approval')
  })
  state = art.getArtProduction(1)
  assert.equal(state.appearance.version, 2)
  assert.equal(state.appearance.approved, false)
  assert.throws(() => art.releaseArt(1, releaseInput(state, { proof_id: 1 }), reviewer), /Approve the current/)
}))

test('asset limits and validation reject unsafe or conflicting metadata without changing revision', async () => fixture(() => {
  for (const extra of [
    { role: 'proof' }, { filename: '../another-job.png' }, { filename: 'source/file.png' },
    { original_name: '' }, { mime: 'text/plain; charset=utf8' }, { size: 0 }, { size: 40 * 1024 * 1024 + 1 },
    { sha256: 'not-a-digest' },
  ]) assert.throws(() => art.addArtAsset(1, assetInput(0, 'source', extra), reviewer), error => error.status === 400 && error.expose === true)
  assert.equal(art.getArtProduction(1).revision, 0)
  assert.equal(get('SELECT COUNT(*) n FROM art_assets').n, 0)
  const state = art.addArtAsset(1, assetInput(0, 'source', { filename: 'unique-source.png' }), reviewer)
  assert.throws(() => art.addArtAsset(2, assetInput(0, 'source', { filename: 'unique-source.png' }), reviewer), error => error.code === 'art_asset_exists' && error.status === 409)
  for (let i = 0; i < 99; i++) run("INSERT INTO art_assets(job_id,role,filename,original_name,mime,size,sha256,created_by) VALUES(1,'source',?,'Old source.png','image/png',1,?,'Synthetic fixture')", `old-source-${i}.png`, 'b'.repeat(64))
  assert.throws(() => art.addArtAsset(1, assetInput(state.revision, 'source'), reviewer), error => error.code === 'art_asset_limit')
  assert.equal(art.getArtProduction(1).revision, state.revision)
  assert.equal(get('SELECT COUNT(*) n FROM art_assets WHERE job_id=1').n, 100)
}))

test('proof changes and deletion invalidate release while preserving its audit snapshot and task revisions', async () => fixture(() => {
  run('INSERT INTO production_jobs(job_id) VALUES(1)')
  let state = ready(), productionRevision = get('SELECT revision FROM production_jobs WHERE job_id=1').revision
  const release = state.release
  assert.throws(() => art.recordArtChange(1, reviewer, 'Outside transaction'), error => error.code === 'art_transaction_required')
  assert.equal(art.getArtProduction(1).revision, state.revision)
  tx(() => {
    run("UPDATE art_versions SET status='sent' WHERE id=1")
    run('UPDATE jobs SET art_approved_at=NULL WHERE id=1')
    art.recordArtChange(1, 'Proof artist', 'Proof sent again for approval')
  })
  state = art.getArtProduction(1)
  assert.equal(state.revision, release.art_revision + 1)
  assert.equal(get('SELECT revision FROM production_jobs WHERE job_id=1').revision, productionRevision + 1)
  assert.equal(get('SELECT actor FROM production_events ORDER BY id DESC LIMIT 1').actor, 'Proof artist')
  assert.equal(state.technical_ready, false)
  assert.equal(state.release.proof_snapshot.status, 'approved')
  tx(() => {
    run("UPDATE art_versions SET status='approved' WHERE id=1")
    run("UPDATE jobs SET art_approved_at='2026-09-05 10:00:00' WHERE id=1")
    art.recordArtChange(1, reviewer, 'Replacement approval recorded')
  })
  state = art.releaseArt(1, releaseInput(art.getArtProduction(1)), reviewer)
  assert.equal(state.technical_ready, true)
  run('DELETE FROM art_versions WHERE id=1')
  state = art.getArtProduction(1)
  assert.equal(state.appearance, null)
  assert.equal(state.technical_ready, false)
  assert.equal(state.release.proof_id, null)
  assert.equal(state.release.proof_snapshot.id, 1)
  assert.match(state.release.revoked_reason, /proof deleted/)
  assert.equal(get('SELECT COUNT(*) n FROM art_releases WHERE job_id=1').n, 2)
}))

test('transaction errors restore assets, proof approval, release history and both revisions atomically', async () => fixture(db => {
  run('INSERT INTO production_jobs(job_id) VALUES(1)')
  const state = ready(), revision = get('SELECT revision FROM production_jobs WHERE job_id=1').revision
  const history = all('SELECT * FROM production_events')
  db.exec("CREATE TRIGGER fail_art_event BEFORE INSERT ON production_events BEGIN SELECT RAISE(ABORT,'fixture art event failure'); END")
  assert.throws(() => art.addArtAsset(1, assetInput(state.revision, 'production'), reviewer), /fixture art event failure/)
  assert.deepEqual(art.getArtProduction(1), state)
  assert.throws(() => tx(() => {
    run("UPDATE art_versions SET status='rejected' WHERE id=1")
    run('UPDATE jobs SET art_approved_at=NULL WHERE id=1')
    art.recordArtChange(1, reviewer, 'Proof rejected')
  }), /fixture art event failure/)
  assert.deepEqual(art.getArtProduction(1), state)
  assert.equal(get('SELECT revision FROM production_jobs WHERE job_id=1').revision, revision)
  assert.deepEqual(all('SELECT * FROM production_events'), history)
  db.exec('DROP TRIGGER fail_art_event')
  db.exec("CREATE TRIGGER fail_art_release BEFORE INSERT ON art_releases BEGIN SELECT RAISE(ABORT,'fixture release failure'); END")
  assert.throws(() => art.releaseArt(1, releaseInput(state), reviewer), /fixture release failure/)
  assert.deepEqual(art.getArtProduction(1), state, 'failed replacement does not revoke the existing release')
  assert.deepEqual(all('SELECT * FROM production_events'), history)
  assert.equal(inTransaction(), false)
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
}))

test('legacy manual approvals remain optional, appearance mockups force release, and revoke never rewrites evidence', async () => fixture(() => {
  run('DELETE FROM art_versions WHERE id=1')
  const legacy = art.getArtProduction(1)
  assert.equal(legacy.required, false)
  assert.equal(legacy.appearance, null)
  assert.equal(legacy.technical_ready, false)
  assert.equal(get('SELECT art_approved_at FROM jobs WHERE id=1').art_approved_at, '2026-09-04 10:00:00')
  assert.equal(art.requireArtRelease(1, { revision: 0, required: true }, reviewer).required, true)
  assert.equal(art.requireArtRelease(1, { revision: 1, required: false }, reviewer).required, false)
  let state = ready(2)
  const releaseId = state.release.id
  assert.throws(() => art.revokeArtRelease(2, { revision: state.revision, note: '' }, reviewer), /revocation reason/)
  state = art.revokeArtRelease(2, { revision: state.revision, note: 'Press file has the wrong underbase' }, reviewer)
  assert.equal(state.required, true)
  assert.equal(state.technical_ready, false)
  assert.equal(state.release.id, releaseId)
  assert.equal(state.release.revoked_reason, 'Press file has the wrong underbase')
  assert.throws(() => run('UPDATE art_releases SET revoked_at=NULL WHERE id=?', releaseId), /immutable/)
  run("UPDATE art_versions SET purpose='appearance_mockup' WHERE id=2")
  run('UPDATE jobs SET art_release_required=0 WHERE id=2')
  state = art.getArtProduction(2)
  assert.equal(state.required, true, 'mockup purpose enforces the requirement even without a stored flag')
  assert.throws(() => art.requireArtRelease(2, { revision: state.revision, required: false }, reviewer), error => error.code === 'art_release_required')
}))

test('bulk readiness is tenant-scoped, reads current state and detects altered proof or missing manifest records', async () => fixture(async db => {
  const state = ready()
  let queries = 0
  const prepare = db.prepare.bind(db)
  db.prepare = sql => { queries++; return prepare(sql) }
  const results = art.readinessForJobs([{ id: 1, art_revision: -100, art_release_required: 0 }, { id: 2 }, { id: 999 }])
  db.prepare = prepare
  assert.equal(queries, 4, 'readiness query count is independent of jobs in the group')
  assert.equal(results.get(1).revision, state.revision)
  assert.equal(results.get(1).technical_ready, true)
  assert.equal(results.get(2).technical_ready, false)
  assert.equal(results.has(999), false)
  const other = new DatabaseSync(':memory:'); initDb(other)
  try {
    tenantStore.run({ db: other }, () => {
      run("INSERT INTO contacts(id,name) VALUES(1,'Other tenant')")
      run("INSERT INTO jobs(id,contact_id,job_number) VALUES(1,1,'OTHER-1')")
      const isolated = art.getArtProduction(1)
      assert.equal(isolated.release, null)
      assert.equal(isolated.source_files.length, 0)
      assert.equal(isolated.technical_ready, false)
    })
  } finally { other.close() }
  run("UPDATE art_versions SET filename='different-proof.png' WHERE id=1")
  assert.equal(art.getArtProduction(1).technical_ready, false, 'unrecorded proof changes cannot reuse the snapshot')
  run("UPDATE art_versions SET filename='proof-1.png' WHERE id=1")
  assert.equal(art.getArtProduction(1).technical_ready, true)
  run('DELETE FROM art_assets WHERE id=?', state.production_files[0].id)
  const missing = art.getArtProduction(1)
  assert.equal(missing.technical_ready, false)
  assert.equal(missing.release.production_manifest[0].filename, state.production_files[0].filename)
  assert.ok(missing.blocking_reasons.some(reason => reason.includes('production file manifest')))
}))

test('release binds production job specifications while schedule and display changes remain harmless', async () => fixture(() => {
  const original = {
    decoration: 'Screen printing', garment: 'Cotton tee, navy', sizes: '{"M":24}',
    line_sizes: '[{"garment":"Cotton tee, navy","sizes":{"M":24}}]', quantities: '24',
  }
  for (const [key, value] of Object.entries(original)) run(`UPDATE jobs SET ${key}=? WHERE id=1`, value)
  const state = ready()
  assert.deepEqual(state.release.proof_snapshot.job_specifications, { ...original, inherited_lines: null })
  run("UPDATE jobs SET title='New display title',due_date='2026-10-01',rush=1 WHERE id=1")
  assert.equal(art.getArtProduction(1).technical_ready, true)
  const changes = { decoration: 'Embroidery', garment: 'Polyester cap', sizes: '{"L":48}', line_sizes: '[]', quantities: '48' }
  for (const [key, value] of Object.entries(changes)) {
    run(`UPDATE jobs SET ${key}=? WHERE id=1`, value)
    const changed = art.getArtProduction(1)
    assert.equal(changed.required, true, key)
    assert.equal(changed.technical_ready, false, key + ' changed outside the normal writer still invalidates readiness')
    assert.ok(changed.blocking_reasons.some(reason => reason.includes('job specifications')))
    run(`UPDATE jobs SET ${key}=? WHERE id=1`, original[key])
    assert.equal(art.getArtProduction(1).technical_ready, true)
  }
  tx(() => {
    run("UPDATE jobs SET garment='New production garment' WHERE id=1")
    art.recordArtChange(1, reviewer, 'Production garment changed')
  })
  run('UPDATE jobs SET garment=? WHERE id=1', original.garment)
  const restored = art.getArtProduction(1)
  assert.equal(restored.required, true)
  assert.equal(restored.technical_ready, false, 'reverting the field cannot undo the recorded revocation')
  assert.equal(restored.release.revoked_reason, 'Production garment changed')
  assert.deepEqual(restored.release.proof_snapshot.job_specifications, { ...original, inherited_lines: null })
}))

test('migration adds no inferred release, changes no existing proof/task and remains idempotent', () => {
  const legacy = new DatabaseSync(':memory:')
  try {
    legacy.exec(SCHEMA)
    legacy.exec('ALTER TABLE jobs ADD COLUMN art_approved_at TEXT')
    legacy.exec("INSERT INTO contacts(id,name) VALUES(1,'Legacy'); INSERT INTO jobs(id,contact_id,job_number,status,stage,art_approved_at) VALUES(1,1,'OLD-1','active','production','2026-09-01 12:00:00'); INSERT INTO art_versions(id,job_id,version,filename,status,decided_by) VALUES(1,1,9,'old-proof.png','approved','Existing customer')")
    initProductionSchema(legacy)
    legacy.exec("INSERT INTO production_jobs(job_id,revision) VALUES(1,12); INSERT INTO production_tasks(job_id,title,department,stage,position,status) VALUES(1,'Keep this exact task','Existing department','qc',1,'done')")
    const oldJob = legacy.prepare('SELECT * FROM jobs WHERE id=1').get()
    const oldProof = legacy.prepare('SELECT * FROM art_versions WHERE id=1').get()
    const oldTasks = legacy.prepare('SELECT * FROM production_tasks').all()
    initDb(legacy); initDb(legacy)
    const migratedJob = legacy.prepare('SELECT * FROM jobs WHERE id=1').get()
    const migratedProof = legacy.prepare('SELECT * FROM art_versions WHERE id=1').get()
    for (const [key, value] of Object.entries(oldJob)) assert.deepEqual(migratedJob[key], value, 'job ' + key)
    for (const [key, value] of Object.entries(oldProof)) assert.deepEqual(migratedProof[key], value, 'proof ' + key)
    assert.deepEqual(legacy.prepare('SELECT * FROM production_tasks').all(), oldTasks)
    assert.equal(legacy.prepare('SELECT revision FROM production_jobs WHERE job_id=1').get().revision, 12)
    assert.equal(migratedJob.art_revision, 0)
    assert.equal(migratedJob.art_release_required, 0)
    assert.equal(migratedProof.purpose, 'legacy_proof')
    assert.equal(migratedProof.source_asset_id, null)
    assert.equal(migratedProof.composition_json, null)
    assert.equal(legacy.prepare('SELECT COUNT(*) n FROM art_releases').get().n, 0)
    tenantStore.run({ db: legacy }, () => { assert.equal(art.getArtProduction(1).required, false); assert.equal(art.getArtProduction(1).technical_ready, false) })
    assert.deepEqual(legacy.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { legacy.close() }
})
