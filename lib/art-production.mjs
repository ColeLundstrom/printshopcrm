import { all, get, run, tx, now, inTransaction, garmentLines } from './db.mjs'

const MAX_FILES = 100, MAX_BYTES = 40 * 1024 * 1024
const fail = (message, status = 400, code = 'invalid_art_production') => { throw Object.assign(new Error(message), { status, code, expose: status < 500 }) }
const actorInfo = actor => ({
  name: (typeof actor === 'string' ? actor : actor?.name || actor?.email || 'Staff').trim().slice(0, 200) || 'Staff',
  id: Number.isSafeInteger(actor?.id) && actor.id > 0 ? actor.id : null,
})
function text(value, label, max, optional = false) {
  if (optional && (value === undefined || value === null)) return ''
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail(`Enter ${label}${optional ? '' : ' before continuing'} (up to ${max} characters).`)
  return value.trim()
}
function job(jobId) {
  if (!Number.isSafeInteger(jobId) || jobId < 1) fail('Job not found.', 404, 'job_not_found')
  const value = get('SELECT j.*,e.items AS estimate_items FROM jobs j LEFT JOIN estimates e ON e.id=j.estimate_id WHERE j.id=?', jobId)
  if (!value) fail('Job not found.', 404, 'job_not_found')
  return value
}
function check(jobId, revision) {
  const value = job(jobId)
  if (!Number.isSafeInteger(revision) || revision !== value.art_revision) fail('Artwork changed. Refresh this job before continuing.', 409, 'art_revision_conflict')
  return value
}
const latestProof = jobId => get('SELECT * FROM art_versions WHERE job_id=? ORDER BY version DESC,id DESC LIMIT 1', jobId)
const parse = value => { try { return JSON.parse(value) } catch { return null } }
const assetSnapshot = asset => ({
  id: asset.id, job_id: asset.job_id, role: asset.role, filename: asset.filename,
  original_name: asset.original_name, mime: asset.mime, size: asset.size, sha256: asset.sha256,
  created_by: asset.created_by, created_by_id: asset.created_by_id, created_at: asset.created_at,
})
export function productionGarmentLines(items) {
  return garmentLines(Array.isArray(items) ? items : []).map(line => ({ ...line,
    sizes: Object.fromEntries(Object.entries(line.sizes || {}).map(([size, qty]) => [size, Number(qty)])
      .filter(([, qty]) => Number.isFinite(qty) && qty > 0).sort(([a], [b]) => a.localeCompare(b))),
  }))
}
function proofSnapshot(proof, j) {
  const storedLines = parse(j.line_sizes)
  const items = parse(j.estimate_items)
  const inheritedLines = Array.isArray(storedLines) && storedLines.length ? null : productionGarmentLines(items)
  return {
    id: proof.id, job_id: proof.job_id, version: proof.version, filename: proof.filename,
    original_name: proof.original_name, mime: proof.mime, size: proof.size, status: proof.status,
    purpose: proof.purpose || 'legacy_proof', notes: proof.notes, sent_at: proof.sent_at,
    decided_at: proof.decided_at, decided_by: proof.decided_by, created_at: proof.created_at,
    source_asset_id: proof.source_asset_id ?? null, composition_json: proof.composition_json ?? null,
    drive_file_id: proof.drive_file_id ?? null, drive_link: proof.drive_link ?? null,
    job_art_approved_at: j.art_approved_at,
    // Production files were reviewed for this exact job configuration. A writer that forgets
    // recordArtChange still cannot silently reuse the release for another garment or run size.
    // Scheduling, title and rush changes are deliberately outside this technical snapshot.
    job_specifications: {
      decoration: j.decoration ?? null, garment: j.garment ?? null, sizes: j.sizes ?? null,
      line_sizes: j.line_sizes ?? null, quantities: j.quantities ?? null,
      // Legacy/board jobs can inherit garment lines from a linked quote. Bind that effective
      // production input too, without making price or customer-note changes invalidate art.
      inherited_lines: inheritedLines,
    },
  }
}
const releaseView = value => value ? {
  ...value,
  proof_snapshot: parse(value.proof_snapshot), source_manifest: parse(value.source_manifest),
  production_manifest: parse(value.production_manifest), specs: parse(value.specs),
} : null

function readiness(j, proof, assets, rawRelease) {
  const appearance = proof ? {
    id: proof.id, version: proof.version, status: proof.status,
    purpose: proof.purpose || 'legacy_proof', approved: proof.status === 'approved' && Boolean(j.art_approved_at),
  } : null
  const required = Boolean(j.art_release_required) || appearance?.purpose === 'appearance_mockup'
  const source_files = assets.filter(asset => asset.role === 'source')
  const production_files = assets.filter(asset => asset.role === 'production')
  const release = releaseView(rawRelease), blocking_reasons = []
  if (!appearance?.approved) blocking_reasons.push('The current customer proof needs approval.')
  if (!release) blocking_reasons.push('Staff have not recorded a technical production release.')
  else {
    if (release.revoked_at) blocking_reasons.push(`The technical release was revoked: ${release.revoked_reason || 'artwork changed'}.`)
    if (release.art_revision !== j.art_revision) blocking_reasons.push('Artwork changed after the technical release.')
    if (!proof || release.proof_id !== proof.id || JSON.stringify(release.proof_snapshot) !== JSON.stringify(proofSnapshot(proof, j))) blocking_reasons.push('The technical release does not match the current approved proof and job specifications.')
    const byId = new Map(assets.map(asset => [asset.id, asset]))
    for (const [manifest, role] of [[release.source_manifest, 'source'], [release.production_manifest, 'production']]) {
      if (!Array.isArray(manifest) || (role === 'production' && !manifest.length) || manifest.some(asset => {
        const current = byId.get(asset?.id)
        return !current || current.job_id !== j.id || current.role !== role || JSON.stringify(asset) !== JSON.stringify(assetSnapshot(current))
      })) blocking_reasons.push(`The released ${role} file manifest no longer matches this job.`)
    }
  }
  return {
    revision: j.art_revision, required, appearance, source_files, production_files,
    technical_ready: Boolean(release && !blocking_reasons.length), release, blocking_reasons,
  }
}

/** Four queries per bounded group, independent of job count. Always read current job flags. */
export function readinessForJobs(jobs) {
  const ids = [...new Set(jobs.map(j => typeof j === 'number' ? j : j.id).filter(id => Number.isSafeInteger(id) && id > 0))]
  const result = new Map()
  for (let i = 0; i < ids.length; i += 400) {
    const group = ids.slice(i, i + 400), placeholders = group.map(() => '?').join(',')
    const rows = all(`SELECT j.id,j.art_revision,j.art_release_required,j.art_approved_at,j.decoration,j.garment,j.sizes,j.line_sizes,j.quantities,e.items AS estimate_items FROM jobs j LEFT JOIN estimates e ON e.id=j.estimate_id WHERE j.id IN (${placeholders})`, ...group)
    const proofs = new Map(all(`SELECT a.* FROM art_versions a WHERE a.job_id IN (${placeholders}) AND NOT EXISTS(
      SELECT 1 FROM art_versions newer WHERE newer.job_id=a.job_id AND (newer.version>a.version OR (newer.version=a.version AND newer.id>a.id)))`, ...group).map(a => [a.job_id, a]))
    const releases = new Map(all(`SELECT a.* FROM art_releases a WHERE a.job_id IN (${placeholders}) AND NOT EXISTS(
      SELECT 1 FROM art_releases newer WHERE newer.job_id=a.job_id AND newer.id>a.id)`, ...group).map(a => [a.job_id, a]))
    const assets = new Map()
    for (const asset of all(`SELECT * FROM art_assets WHERE job_id IN (${placeholders}) ORDER BY id`, ...group)) {
      if (!assets.has(asset.job_id)) assets.set(asset.job_id, [])
      assets.get(asset.job_id).push(asset)
    }
    for (const j of rows) result.set(j.id, readiness(j, proofs.get(j.id), assets.get(j.id) || [], releases.get(j.id)))
  }
  return result
}

export function getArtProduction(jobId) {
  job(jobId)
  return readinessForJobs([jobId]).get(jobId)
}

/** Called INSIDE the proof mutation's transaction; deliberately never enrolls old jobs. */
export function recordArtChange(jobId, actor, reason) {
  // SAVEPOINT cannot prove transaction ownership. Requiring the runtime's transaction flag
  // prevents a caller from committing a proof but leaving its release/revision unchanged.
  if (!inTransaction()) fail('Artwork changes must be recorded inside their transaction.', 500, 'art_transaction_required')
  job(jobId)
  const by = actorInfo(actor), detail = text(reason, 'the artwork change reason', 2000)
  run('UPDATE jobs SET art_revision=art_revision+1 WHERE id=?', jobId)
  run('UPDATE art_releases SET revoked_at=?,revoked_reason=?,revoked_by=?,revoked_by_id=? WHERE job_id=? AND revoked_at IS NULL', now(), detail, by.name, by.id, jobId)
  if (get('SELECT 1 FROM production_jobs WHERE job_id=?', jobId)) {
    run('UPDATE production_jobs SET revision=revision+1 WHERE job_id=?', jobId)
    run("INSERT INTO production_events(job_id,actor,action,detail) VALUES(?,?,'art.changed',?)", jobId, by.name, detail)
  }
  return get('SELECT art_revision FROM jobs WHERE id=?', jobId).art_revision
}

export function addArtAsset(jobId, input, actor) {
  return tx(() => {
    check(jobId, input?.revision)
    if (!['source', 'production'].includes(input.role)) fail('Choose a source or production file role.')
    const filename = text(input.filename, 'a generated file name', 241)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename)) fail('Invalid generated artwork filename.')
    const original = text(input.original_name, 'the original file name', 250)
    const mime = text(input.mime, 'the file content type', 120)
    if (!/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(mime)) fail('Invalid artwork content type.')
    if (!Number.isSafeInteger(input.size) || input.size < 1 || input.size > MAX_BYTES) fail('Artwork files must be between 1 byte and 40 MiB.')
    if (typeof input.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(input.sha256)) fail('A verified SHA-256 file digest is required.')
    if (get('SELECT COUNT(*) n FROM art_assets WHERE job_id=?', jobId).n >= MAX_FILES) fail('This job already has 100 source and production files.', 409, 'art_asset_limit')
    if (get('SELECT 1 FROM art_assets WHERE filename=?', filename)) fail('This generated artwork filename is already in use.', 409, 'art_asset_exists')
    const by = actorInfo(actor)
    run('INSERT INTO art_assets(job_id,role,filename,original_name,mime,size,sha256,created_by,created_by_id) VALUES(?,?,?,?,?,?,?,?,?)',
      jobId, input.role, filename, original, mime, input.size, input.sha256.toLowerCase(), by.name, by.id)
    recordArtChange(jobId, by, `${input.role === 'source' ? 'Source' : 'Production'} file uploaded: ${original}`)
    return getArtProduction(jobId)
  })
}

function selectedAssets(jobId, ids, role, optional = false) {
  if (optional && ids === undefined) ids = []
  if (!Array.isArray(ids) || ids.length > 20 || (!optional && !ids.length) || ids.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length) fail(`Choose ${optional ? 'up to' : '1–'}20 different ${role} files from this job.`)
  return ids.map(id => {
    const asset = get('SELECT * FROM art_assets WHERE id=? AND job_id=? AND role=?', id, jobId, role)
    if (!asset) fail(`Choose ${role} files belonging to this job.`, 400, 'art_asset_mismatch')
    return assetSnapshot(asset)
  })
}

function specifications(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Record the production specifications.')
  const method = text(value.method, 'the decoration method', 80)
  for (const key of ['print_width', 'print_height']) if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] <= 0 || value[key] > 10000) fail('Record a positive print width and height (up to 10,000 units).')
  if (!['in', 'mm', 'cm'].includes(value.units)) fail('Choose inches, millimeters or centimeters for the production size.')
  return { method, print_width: value.print_width, print_height: value.print_height, units: value.units,
    ink_notes: text(value.ink_notes, 'ink or thread notes', 4000, true), machine_profile: text(value.machine_profile, 'the machine profile', 500, true) }
}

export function releaseArt(jobId, input, actor) {
  return tx(() => {
    const j = check(jobId, input?.revision), proof = latestProof(jobId)
    if (input.reviewed_confirmed !== true) fail('Confirm that staff reviewed the selected production files and specifications.')
    if (!proof || !Number.isSafeInteger(input.proof_id) || proof.id !== input.proof_id || proof.status !== 'approved' || !j.art_approved_at) fail('Approve the current customer proof before recording a technical release.', 409, 'art_proof_not_approved')
    const production = selectedAssets(jobId, input.production_asset_ids, 'production')
    const source = selectedAssets(jobId, input.source_asset_ids, 'source', true)
    const specs = specifications(input.specs), notes = text(input.notes, 'release notes', 4000, true), by = actorInfo(actor)
    const revision = recordArtChange(jobId, by, 'Staff recorded a new technical production release')
    run('UPDATE jobs SET art_release_required=1 WHERE id=?', jobId)
    run('INSERT INTO art_releases(job_id,art_revision,proof_id,proof_snapshot,source_manifest,production_manifest,specs,notes,reviewed_by,reviewed_by_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
      jobId, revision, proof.id, JSON.stringify(proofSnapshot(proof, j)), JSON.stringify(source), JSON.stringify(production), JSON.stringify(specs), notes, by.name, by.id)
    return getArtProduction(jobId)
  })
}

export function requireArtRelease(jobId, input, actor) {
  return tx(() => {
    const j = check(jobId, input?.revision)
    if (typeof input.required !== 'boolean') fail('Choose whether a technical release is required.')
    if (!input.required && latestProof(jobId)?.purpose === 'appearance_mockup') fail('An appearance mockup needs a separate technical production release.', 409, 'art_release_required')
    if (Boolean(j.art_release_required) === input.required) return getArtProduction(jobId)
    recordArtChange(jobId, actor, input.required ? 'Technical production release required for this job' : 'Staff removed the technical production release requirement')
    run('UPDATE jobs SET art_release_required=? WHERE id=?', input.required ? 1 : 0, jobId)
    return getArtProduction(jobId)
  })
}

export function revokeArtRelease(jobId, input, actor) {
  return tx(() => {
    check(jobId, input?.revision)
    const note = text(input.note, 'the release revocation reason', 2000)
    if (!get('SELECT 1 FROM art_releases WHERE job_id=? AND revoked_at IS NULL', jobId)) fail('There is no active technical release to revoke.', 409, 'art_release_missing')
    recordArtChange(jobId, actor, note)
    return getArtProduction(jobId)
  })
}
