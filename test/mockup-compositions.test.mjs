import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

process.env.PSC_DB = ':memory:'
const dbmod = await import('../lib/db.mjs')
const art = await import('../lib/art-production.mjs')
const { saveMockupComposition } = await import('../lib/mockup-compositions.mjs')
const { getDb, initDb, tenantStore, get, all, run } = dbmod
after(() => getDb().close())
const actor = { id: 4, name: 'Synthetic artist' }
let serial = 0
const inspected = (width, height, orientation = 1) => ({ format: 'png', mime: 'image/png', width, height, orientation,
  orientedWidth: orientation >= 5 ? height : width, orientedHeight: orientation >= 5 ? width : height, animated: false })
function image(name, width, height, digest, orientation = 1) {
  return { filename: `staged-${++serial}-${name}.png`, original_name: `${name}.png`, mime: 'image/png', size: 4096,
    sha256: digest.repeat(64), header: inspected(width, height, orientation) }
}
function input(revision = 0) {
  return { request_id: `request-${String(++serial).padStart(12, '0')}`, revision,
    photo: image('photo', 2400, 1800, 'a'), artwork: image('artwork', 400, 300, 'b'), proof: image('proof', 2000, 1500, 'c'),
    recipe: { version: 1, renderer: 'browser-canvas-v1', sizing_mode: 'visual', canvas: { width: 2000, height: 1500 },
      placement: { x: 0.5, y: 0.4, width: 0.3, rotation: 0 }, requested_print: { width: 10, height: 12, units: 'in' } } }
}
const retry = value => ({ ...structuredClone(value), photo: { ...value.photo, filename: `retry-${++serial}-photo.png` },
  artwork: { ...value.artwork, filename: `retry-${++serial}-art.png` }, proof: { ...value.proof, filename: `retry-${++serial}-proof.png` } })
async function fixture(fn) {
  const db = new DatabaseSync(':memory:'); initDb(db)
  try {
    return await tenantStore.run({ db }, async () => {
      run("INSERT INTO contacts(id,name) VALUES(1,'Synthetic customer')")
      for (const id of [1, 2]) {
        run("INSERT INTO jobs(id,contact_id,job_number,art_approved_at) VALUES(?,1,?,'2026-09-04 12:00:00')", id, `J-${id}`)
        run("INSERT INTO art_versions(id,job_id,version,filename,status) VALUES(?,?,1,?,'approved')", id, id, `old-proof-${id}.png`)
      }
      return await fn(db)
    })
  } finally { db.close() }
}
const counts = () => Object.fromEntries(['art_assets', 'art_versions', 'mockup_composition_receipts', 'production_events'].map(table => [table, get(`SELECT COUNT(*) n FROM ${table}`).n]))
const code = expected => error => error.code === expected && error.status === 409 && error.expose === true

test('save atomically retains two private originals and creates a held draft appearance proof with canonical recipe', async () => fixture(() => {
  run('INSERT INTO production_jobs(job_id) VALUES(1)')
  const productionRevision = get('SELECT revision FROM production_jobs WHERE job_id=1').revision
  const value = input(), originalProof = get('SELECT * FROM art_versions WHERE id=1')
  const saved = saveMockupComposition(1, value, actor)
  assert.deepEqual(saved, { proof_id: 3, version: 2, job_id: 1, revision: 1, replayed: false })
  assert.deepEqual(get('SELECT * FROM art_versions WHERE id=1'), originalProof, 'historical customer decision remains intact')
  const state = art.getArtProduction(1), proof = get('SELECT * FROM art_versions WHERE id=?', saved.proof_id)
  assert.equal(state.appearance.purpose, 'appearance_mockup')
  assert.equal(state.appearance.status, 'draft')
  assert.equal(state.appearance.approved, false)
  assert.equal(state.required, true)
  assert.equal(state.technical_ready, false)
  assert.equal(get('SELECT art_approved_at FROM jobs WHERE id=1').art_approved_at, null)
  assert.equal(state.source_files.length, 2)
  assert.equal(state.production_files.length, 0)
  assert.deepEqual(state.source_files.map(f => f.sha256), [value.photo.sha256, value.artwork.sha256])
  assert.equal(proof.source_asset_id, state.source_files[1].id)
  const recipe = JSON.parse(proof.composition_json)
  assert.deepEqual(recipe.placement, value.recipe.placement)
  assert.deepEqual(recipe.requested_print, value.recipe.requested_print)
  assert.equal(recipe.photo.asset_id, state.source_files[0].id)
  assert.equal(recipe.artwork.sha256, value.artwork.sha256)
  assert.equal(recipe.output.sha256, value.proof.sha256)
  assert.equal(recipe.provenance, null)
  assert.equal(get('SELECT revision FROM production_jobs WHERE job_id=1').revision, productionRevision + 1)
  assert.equal(get("SELECT COUNT(*) n FROM production_events WHERE action='art.changed'").n, 1)
  assert.throws(() => art.requireArtRelease(1, { revision: 1, required: false }, actor), code('art_release_required'))
}))

test('exact retry precedes stale revision, ignores fresh staged names and never changes later proofs or decisions', async () => fixture(() => {
  const firstInput = input(), saved = saveMockupComposition(1, firstInput, actor)
  const before = counts(), retried = retry(firstInput)
  // Canonical ordering is independent of request object key ordering.
  retried.recipe.placement = { rotation: 0, width: 0.3, y: 0.4, x: 0.5 }
  assert.deepEqual(saveMockupComposition(1, retried, { name: 'Another staff member' }), { ...saved, replayed: true })
  assert.deepEqual(counts(), before)
  run("UPDATE art_versions SET status='approved',decided_by='Customer' WHERE id=?", saved.proof_id)
  run("UPDATE jobs SET art_approved_at='2026-09-05 00:00:00' WHERE id=1")
  const second = saveMockupComposition(1, input(1), actor)
  const afterSecond = counts(), current = art.getArtProduction(1)
  assert.equal(second.version, 3)
  assert.deepEqual(saveMockupComposition(1, retry(firstInput), actor), { ...saved, replayed: true })
  assert.deepEqual(counts(), afterSecond)
  assert.deepEqual(art.getArtProduction(1), current)
  assert.equal(get('SELECT status FROM art_versions WHERE id=?', saved.proof_id).status, 'approved')
  const stale = input(0)
  assert.throws(() => saveMockupComposition(1, stale, actor), code('art_revision_conflict'))
  for (const change of [value => { value.recipe.placement.x = 0.6 }, value => { value.proof.sha256 = 'd'.repeat(64) }, value => { value.revision = 2 }, value => { value.artwork.original_name = 'other.png' }]) {
    const changed = retry(firstInput); change(changed)
    assert.throws(() => saveMockupComposition(1, changed, actor), code('mockup_request_conflict'))
  }
  assert.deepEqual(counts(), afterSecond)
}))

test('deleted receipt proof or source cannot attach a retry to a reused row ID', async () => fixture(() => {
  const value = input(), saved = saveMockupComposition(1, value, actor)
  run('DELETE FROM art_versions WHERE id=?', saved.proof_id)
  assert.equal(get('SELECT proof_id FROM mockup_composition_receipts').proof_id, null)
  run("INSERT INTO art_versions(id,job_id,version,filename,status) VALUES(?,1,2,'unrelated-proof.png','draft')", saved.proof_id)
  const before = counts()
  assert.throws(() => saveMockupComposition(1, retry(value), actor), code('mockup_receipt_unavailable'))
  assert.deepEqual(counts(), before)
  const next = input(1), nextSaved = saveMockupComposition(1, next, actor)
  const proof = get('SELECT * FROM art_versions WHERE id=?', nextSaved.proof_id)
  const sourceId = JSON.parse(proof.composition_json).photo.asset_id
  run('DELETE FROM art_assets WHERE id=?', sourceId)
  assert.throws(() => saveMockupComposition(1, retry(next), actor), code('mockup_receipt_unavailable'))
  assert.throws(() => run("UPDATE mockup_composition_receipts SET request_hash='changed' WHERE request_id=?", next.request_id), /immutable/)
}))

test('replay-only can recover an exact receipt but cannot create with a fresh or stale revision', async () => fixture(() => {
  const before = counts(), fresh = { ...input(), replay_only: true }
  assert.throws(() => saveMockupComposition(1, fresh, actor), code('mockup_receipt_unavailable'))
  assert.deepEqual(counts(), before)
  assert.equal(get('SELECT art_revision FROM jobs WHERE id=1').art_revision, 0)
  const value = input(), saved = saveMockupComposition(1, value, actor), after = counts()
  assert.deepEqual(saveMockupComposition(1, { ...retry(value), replay_only: true }, actor), { ...saved, replayed: true })
  assert.deepEqual(counts(), after)
  for (const revision of [0, 1]) assert.throws(() => saveMockupComposition(1, { ...input(revision), replay_only: true }, actor), code('mockup_receipt_unavailable'))
  const changed = { ...retry(value), replay_only: true }; changed.recipe.placement.x = 0.6
  assert.throws(() => saveMockupComposition(1, changed, actor), code('mockup_request_conflict'))
  assert.deepEqual(counts(), after)
  assert.equal(get('SELECT art_revision FROM jobs WHERE id=1').art_revision, 1)
}))

test('save invalidates an active technical release and late receipt errors roll every write back', async () => fixture(db => {
  run('INSERT INTO production_jobs(job_id) VALUES(1)')
  let state = art.addArtAsset(1, { revision: 0, role: 'production', filename: 'production.pdf', original_name: 'Production.pdf', mime: 'application/pdf', size: 5000, sha256: 'f'.repeat(64) }, actor)
  state = art.releaseArt(1, { revision: state.revision, proof_id: 1, production_asset_ids: [state.production_files[0].id],
    specs: { method: 'Screen printing', print_width: 10, print_height: 12, units: 'in' }, reviewed_confirmed: true }, actor)
  assert.equal(state.technical_ready, true)
  const beforeCounts = counts(), beforeJob = get('SELECT * FROM jobs WHERE id=1'), beforeProduction = get('SELECT * FROM production_jobs WHERE job_id=1')
  db.exec("CREATE TRIGGER fail_mockup_receipt BEFORE INSERT ON mockup_composition_receipts BEGIN SELECT RAISE(ABORT,'synthetic final receipt failure'); END")
  const value = input(state.revision)
  assert.throws(() => saveMockupComposition(1, value, actor), /synthetic final receipt failure/)
  assert.deepEqual(counts(), beforeCounts)
  assert.deepEqual(get('SELECT * FROM jobs WHERE id=1'), beforeJob)
  assert.deepEqual(get('SELECT * FROM production_jobs WHERE job_id=1'), beforeProduction)
  assert.deepEqual(art.getArtProduction(1), state)
  db.exec('DROP TRIGGER fail_mockup_receipt')
  saveMockupComposition(1, value, actor)
  const changed = art.getArtProduction(1)
  assert.equal(changed.revision, state.revision + 1)
  assert.equal(changed.technical_ready, false)
  assert.ok(changed.release.revoked_at)
  assert.equal(changed.required, true)
  assert.deepEqual(changed.release.production_manifest, state.release.production_manifest)
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
}))

test('strict geometry, byte/pixel/file limits and inspected metadata are enforced before any write', async () => fixture(() => {
  const original = counts()
  const mutations = [
    value => { value.photo.filename = '../source.png' }, value => { value.artwork.filename = value.photo.filename },
    value => { value.photo.size = 10485761 }, value => { value.proof.size = 16777217 },
    value => { value.photo.sha256 = 'bad' }, value => { value.photo.mime = 'image/jpeg' },
    value => { value.artwork.header.animated = true }, value => { value.photo.header.orientation = 6 },
    value => { value.artwork.header = inspected(2000, 2000) }, value => { value.proof.header = inspected(2001, 1500) },
    value => { value.recipe.canvas.width = 1999 }, value => { value.recipe.placement.x = 1.1 },
    value => { value.recipe.placement.y = '0.5' }, value => { value.recipe.placement.width = 0.001 },
    value => { value.recipe.placement.rotation = Infinity }, value => { value.recipe.placement.height = 0.5 },
    value => { value.recipe.requested_print.units = 'px' }, value => { value.recipe.requested_print.width = 0 },
    value => { value.recipe.photo = { asset_id: 1 } }, value => { value.recipe.version = 2 },
    value => { value.request_id = 'short' }, value => { value.revision = '0' },
  ]
  for (const mutate of mutations) {
    const value = input(); mutate(value)
    assert.throws(() => saveMockupComposition(1, value, actor), error => error.status >= 400 && error.status < 500 && error.expose === true)
    assert.deepEqual(counts(), original)
    assert.equal(get('SELECT art_revision FROM jobs WHERE id=1').art_revision, 0)
  }
  for (let i = 0; i < 99; i++) run("INSERT INTO art_assets(job_id,role,filename,original_name,mime,size,sha256,created_by) VALUES(1,'source',?,'Existing.png','image/png',1,?,'Fixture')", `existing-${i}.png`, 'a'.repeat(64))
  assert.throws(() => saveMockupComposition(1, input(), actor), code('art_asset_limit'))
  run('DELETE FROM art_assets WHERE id=99')
  saveMockupComposition(1, input(), actor)
  assert.equal(get('SELECT COUNT(*) n FROM art_assets WHERE job_id=1').n, 100)
}))

test('oriented photo canvas is deterministic and supplier identity only comes from verified server input', async () => fixture(() => {
  const value = input()
  value.photo.header = inspected(1800, 2400, 6)
  value.provenance = { supplier: 'ssactivewear', sku: 'EXACT-123', style_id: 123, style: 'G500', brand: 'Gildan', color: 'Navy', color_code: null,
    size: 'M', view: 'front', source_url: 'https://www.ssactivewear.com/Images/Style/fixture.jpg', sha256: value.photo.sha256 }
  const saved = saveMockupComposition(1, value, actor)
  const recipe = JSON.parse(get('SELECT composition_json FROM art_versions WHERE id=?', saved.proof_id).composition_json)
  assert.deepEqual(recipe.provenance, value.provenance)
  assert.deepEqual(recipe.canvas, { width: 2000, height: 1500 })
  assert.equal(recipe.photo.header.orientation, 6)
  assert.deepEqual(saveMockupComposition(1, retry(value), actor), { ...saved, replayed: true })
  const wrong = input(1); wrong.provenance = { ...value.provenance, sha256: '0'.repeat(64) }
  assert.throws(() => saveMockupComposition(1, wrong, actor), code('mockup_provenance_mismatch'))
  const forged = input(1); forged.recipe.provenance = value.provenance
  assert.throws(() => saveMockupComposition(1, forged, actor), /unsupported fields/)
}))

test('job and tenant isolation applies to receipt IDs, source files and revisions', async () => fixture(async () => {
  const value = input(), saved = saveMockupComposition(1, value, actor)
  const secondJob = saveMockupComposition(2, retry(value), actor)
  assert.equal(secondJob.job_id, 2)
  assert.notEqual(secondJob.proof_id, saved.proof_id)
  assert.equal(get('SELECT COUNT(*) n FROM mockup_composition_receipts').n, 2)
  assert.throws(() => saveMockupComposition(999, input(), actor), error => error.status === 404)
  const otherDb = new DatabaseSync(':memory:'); initDb(otherDb)
  try {
    tenantStore.run({ db: otherDb }, () => {
      run("INSERT INTO contacts(id,name) VALUES(1,'Other tenant')")
      run("INSERT INTO jobs(id,contact_id,job_number) VALUES(1,1,'OTHER')")
      const other = saveMockupComposition(1, retry(value), actor)
      assert.equal(other.replayed, false)
      assert.equal(other.version, 1)
      assert.equal(get('SELECT COUNT(*) n FROM art_assets').n, 2)
      run('DELETE FROM jobs WHERE id=1')
      assert.equal(get('SELECT COUNT(*) n FROM mockup_composition_receipts').n, 0)
    })
  } finally { otherDb.close() }
  assert.equal(all('SELECT * FROM mockup_composition_receipts').length, 2)
}))
