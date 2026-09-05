import { createHash } from 'node:crypto'
import { get, run, tx } from './db.mjs'
import { recordArtChange } from './art-production.mjs'
import { MOCKUP_LIMITS } from '../public/js/shared/raster-header.js'

const fail = (message, status = 400, code = 'invalid_mockup_composition') => {
  throw Object.assign(new Error(message), { status, code, expose: status < 500 })
}
const object = value => value && typeof value === 'object' && !Array.isArray(value)
function text(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) fail(`Enter a valid ${label} (up to ${max} characters).`)
  return value.trim()
}
const finite = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
function keys(value, allowed, label) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(`The ${label} contains unsupported fields. Reload the composer and try again.`)
}
function header(value, label) {
  if (!object(value) || !['png', 'jpeg', 'webp'].includes(value.format) || value.mime !== `image/${value.format}` ||
      !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height) || value.width < 1 || value.height < 1 ||
      value.width > MOCKUP_LIMITS.inputEdge || value.height > MOCKUP_LIMITS.inputEdge || value.width * value.height > MOCKUP_LIMITS.combinedPixels ||
      !Number.isSafeInteger(value.orientation) || value.orientation < 1 || value.orientation > 8 || typeof value.animated !== 'boolean')
    fail(`The ${label} needs a verified still-image header with dimensions and orientation.`)
  if (value.animated) fail(`The ${label} is animated. Choose a still PNG, JPEG or WebP.`)
  const orientedWidth = value.orientation >= 5 ? value.height : value.width
  const orientedHeight = value.orientation >= 5 ? value.width : value.height
  if (value.orientedWidth !== orientedWidth || value.orientedHeight !== orientedHeight) fail(`The ${label} orientation and dimensions do not agree.`)
  return { format: value.format, mime: value.mime, width: value.width, height: value.height,
    orientation: value.orientation, orientedWidth, orientedHeight, animated: false }
}
function file(value, label, output = false) {
  if (!object(value)) fail(`Choose the ${label} before saving.`)
  const filename = text(value.filename, 'generated filename', 241)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename)) fail('Invalid generated image filename.')
  const original_name = text(value.original_name, 'original filename', 250)
  const inspected = header(value.header, label)
  if (value.mime !== inspected.mime) fail(`The ${label} content type does not match its inspected bytes.`)
  const max = output ? MOCKUP_LIMITS.outputBytes : MOCKUP_LIMITS.inputBytes
  if (!Number.isSafeInteger(value.size) || value.size < 1 || value.size > max) fail(`The ${label} must be at most ${output ? '16' : '10'} MiB.`)
  if (typeof value.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value.sha256)) fail(`The ${label} needs a verified SHA-256 digest.`)
  if (output && (inspected.format !== 'png' || inspected.orientation !== 1 || inspected.width > MOCKUP_LIMITS.outputEdge ||
      inspected.height > MOCKUP_LIMITS.outputEdge || inspected.width * inspected.height > MOCKUP_LIMITS.outputPixels))
    fail('Export a still PNG proof with normal orientation, at most 2000 pixels per edge and 4 million pixels.')
  return { filename, original_name, mime: value.mime, size: value.size, sha256: value.sha256.toLowerCase(), header: inspected }
}
function recipe(value, photo, proof) {
  keys(value, ['version', 'renderer', 'sizing_mode', 'canvas', 'placement', 'requested_print'], 'recipe')
  if (value.version !== 1 || value.renderer !== 'browser-canvas-v1' || value.sizing_mode !== 'visual') fail('This mockup recipe version is not supported. Reload the composer and try again.')
  keys(value.canvas, ['width', 'height'], 'canvas')
  const scale = Math.min(1, MOCKUP_LIMITS.outputEdge / Math.max(photo.header.orientedWidth, photo.header.orientedHeight))
  const canvas = { width: Math.max(1, Math.round(photo.header.orientedWidth * scale)), height: Math.max(1, Math.round(photo.header.orientedHeight * scale)) }
  if (value.canvas.width !== canvas.width || value.canvas.height !== canvas.height || proof.header.width !== canvas.width || proof.header.height !== canvas.height)
    fail('The exported proof size must match the oriented product photo and the composer canvas.')
  keys(value.placement, ['x', 'y', 'width', 'rotation'], 'placement')
  const p = value.placement
  if (!finite(p.x, 0, 1) || !finite(p.y, 0, 1) || !finite(p.width, 0.01, 2) || !finite(p.rotation, -180, 180)) fail('Keep artwork placement inside the canvas, its width between 1% and 200%, and rotation between -180 and 180 degrees.')
  const normalized = { version: 1, renderer: 'browser-canvas-v1', sizing_mode: 'visual', canvas,
    placement: { x: p.x, y: p.y, width: p.width, rotation: p.rotation } }
  if (value.requested_print !== undefined) {
    keys(value.requested_print, ['width', 'height', 'units'], 'requested print size')
    const requested = value.requested_print
    if (!finite(requested.width, Number.MIN_VALUE, 10000) || !finite(requested.height, Number.MIN_VALUE, 10000) || !['in', 'mm', 'cm'].includes(requested.units))
      fail('Requested print dimensions must be positive, at most 10,000, and use in, mm or cm. They are notes, not photo calibration.')
    normalized.requested_print = { width: requested.width, height: requested.height, units: requested.units }
  }
  return normalized
}
// This parameter is supplied ONLY by server-side ticket verification. It is never taken
// from recipe JSON. Expiry/token are deliberately absent: renewed tickets bind identical bytes.
function provenance(value, photo) {
  if (value === undefined || value === null) return null
  keys(value, ['supplier', 'sku', 'style_id', 'style', 'brand', 'color', 'color_code', 'size', 'view', 'source_url', 'sha256'], 'verified supplier identity')
  if (value.supplier !== 'ssactivewear' || !Number.isSafeInteger(value.style_id) || value.style_id < 1 || value.sha256 !== photo.sha256)
    fail('The verified supplier identity does not match this photo.', 409, 'mockup_provenance_mismatch')
  const verified = { supplier: 'ssactivewear', sku: text(value.sku, 'supplier SKU', 200), style_id: value.style_id,
    style: text(value.style, 'supplier style', 200), brand: text(value.brand, 'supplier brand', 200),
    color: text(value.color, 'supplier color', 200), color_code: value.color_code === null ? null : text(value.color_code, 'supplier color code', 200),
    size: text(value.size, 'supplier size', 100), view: text(value.view, 'supplier view', 100),
    source_url: text(value.source_url, 'supplier photo URL', 2048), sha256: photo.sha256 }
  try { if (new URL(verified.source_url).protocol !== 'https:') fail('Supplier photo URLs must use HTTPS.') } catch { fail('The verified supplier photo URL is invalid.') }
  return verified
}
const fingerprintFile = ({ filename, ...value }) => value
const assetRecipe = (id, value) => ({ asset_id: id, ...value })
function receiptAvailable(receipt, jobId) {
  if (receipt.proof_id === null) return false
  const proof = get('SELECT * FROM art_versions WHERE id=? AND job_id=?', receipt.proof_id, jobId)
  if (!proof || proof.filename !== receipt.proof_filename || proof.version !== receipt.proof_version ||
      proof.purpose !== 'appearance_mockup' || proof.composition_json !== receipt.composition_json) return false
  let composition
  try { composition = JSON.parse(receipt.composition_json) } catch { return false }
  if (!composition?.output || proof.original_name !== composition.output.original_name || proof.mime !== composition.output.mime ||
      proof.size !== composition.output.size || composition.output.sha256 !== receipt.proof_sha256 || proof.source_asset_id !== composition.artwork?.asset_id) return false
  for (const saved of [composition.photo, composition.artwork]) {
    if (!saved) return false
    const current = get("SELECT * FROM art_assets WHERE id=? AND job_id=? AND role='source'", saved.asset_id, jobId)
    if (!current || ['filename', 'original_name', 'mime', 'size', 'sha256'].some(key => current[key] !== saved[key])) return false
  }
  return true
}

/** Save already-inspected, privately staged files. No filesystem operations or rendering.
 * Exact retries precede stale revision checks and return the original save's revision, even
 * if a subsequent proof is now current. Callers delete only newly staged files not owned by
 * committed art_assets/art_versions rows. Every write, including the receipt, is one tx.
 */
export function saveMockupComposition(jobId, input, actor) {
  if (!Number.isSafeInteger(jobId) || jobId < 1) fail('Job not found.', 404, 'job_not_found')
  if (!object(input)) fail('Enter a mockup composition to save.')
  const requestId = text(input.request_id, 'save request ID', 100)
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{15,99}$/.test(requestId)) fail('A stable save request ID of 16–100 letters, numbers, dashes or underscores is required.')
  if (input.replay_only !== undefined && typeof input.replay_only !== 'boolean') fail('The save replay control must be a boolean.')
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) fail('A valid artwork revision is required.')
  const photo = file(input.photo, 'product photo'), artwork = file(input.artwork, 'original artwork'), proof = file(input.proof, 'proof', true)
  if (photo.header.width * photo.header.height + artwork.header.width * artwork.header.height > MOCKUP_LIMITS.combinedPixels)
    fail('The photo and artwork together exceed 8 million pixels. Resize an input image before saving.')
  const normalized = recipe(input.recipe, photo, proof), verified = provenance(input.provenance, photo)
  const requestHash = createHash('sha256').update(JSON.stringify({ job_id: jobId, revision: input.revision, recipe: normalized,
    photo: fingerprintFile(photo), artwork: fingerprintFile(artwork), proof: fingerprintFile(proof), provenance: verified })).digest('hex')
  const by = { name: text(typeof actor === 'string' ? actor : actor?.name || 'Staff', 'staff name', 200),
    id: Number.isSafeInteger(actor?.id) && actor.id > 0 ? actor.id : null }
  return tx(() => {
    const j = get('SELECT id,art_revision FROM jobs WHERE id=?', jobId)
    if (!j) fail('Job not found.', 404, 'job_not_found')
    const receipt = get('SELECT * FROM mockup_composition_receipts WHERE job_id=? AND request_id=?', jobId, requestId)
    if (receipt) {
      if (receipt.request_hash !== requestHash) fail('This save ID was already used with different content. Keep the draft and create a new save request.', 409, 'mockup_request_conflict')
      if (!receiptAvailable(receipt, jobId)) fail('This saved mockup or one of its original files was removed or changed. Reload the job before creating a new draft.', 409, 'mockup_receipt_unavailable')
      return { proof_id: receipt.proof_id, version: receipt.proof_version, job_id: jobId, revision: receipt.revision, replayed: true }
    }
    // A verified-but-expired catalog ticket may recover a committed response only. It must
    // never authorize fresh files/proofs, even when this request has the current revision.
    if (input.replay_only === true) fail('No matching saved mockup receipt exists. Select the supplier photo again before creating a new draft.', 409, 'mockup_receipt_unavailable')
    if (j.art_revision !== input.revision) fail('Artwork changed. Refresh this job before saving your draft.', 409, 'art_revision_conflict')
    if (get('SELECT COUNT(*) n FROM art_assets WHERE job_id=?', jobId).n > 98) fail('This job needs room for two source files; it can hold at most 100 source and production files.', 409, 'art_asset_limit')
    const filenames = [photo.filename, artwork.filename, proof.filename]
    if (new Set(filenames).size !== 3 || filenames.some(filename => get('SELECT 1 FROM art_assets WHERE filename=?', filename) || get('SELECT 1 FROM art_versions WHERE filename=?', filename)))
      fail('A generated image filename is already in use. Stage fresh files before retrying.', 409, 'art_asset_exists')
    const add = value => Number(run("INSERT INTO art_assets(job_id,role,filename,original_name,mime,size,sha256,created_by,created_by_id) VALUES(?,'source',?,?,?,?,?,?,?)",
      jobId, value.filename, value.original_name, value.mime, value.size, value.sha256, by.name, by.id).lastInsertRowid)
    const photoId = add(photo), artworkId = add(artwork)
    const composition = { ...normalized, photo: assetRecipe(photoId, photo), artwork: assetRecipe(artworkId, artwork),
      output: fingerprintFile(proof), provenance: verified }
    const compositionJson = JSON.stringify(composition)
    const version = get('SELECT COALESCE(MAX(version),0)+1 n FROM art_versions WHERE job_id=?', jobId).n
    const proofId = Number(run("INSERT INTO art_versions(job_id,version,filename,original_name,mime,size,status,notes,purpose,source_asset_id,composition_json) VALUES(?,?,?,?,?,?,'draft',?,'appearance_mockup',?,?)",
      jobId, version, proof.filename, proof.original_name, proof.mime, proof.size,
      'Visual placement mockup. Physical dimensions are uncalibrated; separate staff production release is required.', artworkId, compositionJson).lastInsertRowid)
    run('UPDATE jobs SET art_approved_at=NULL,art_release_required=1 WHERE id=?', jobId)
    const revision = recordArtChange(jobId, by, 'Draft appearance mockup saved with original photo and artwork')
    run('INSERT INTO mockup_composition_receipts(job_id,request_id,request_hash,proof_id,proof_filename,proof_sha256,proof_version,revision,composition_json) VALUES(?,?,?,?,?,?,?,?,?)',
      jobId, requestId, requestHash, proofId, proof.filename, proof.sha256, version, revision, compositionJson)
    return { proof_id: proofId, version, job_id: jobId, revision, replayed: false }
  })
}
