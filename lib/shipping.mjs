import { createHash } from 'node:crypto'
import { all, get, run, tx, now, inTransaction } from './db.mjs'
import { workflow, taskBlock } from './production.mjs'

const fail = (message, status = 400, code = 'invalid_shipment') => {
  throw Object.assign(new Error(message), { status, code, expose: true })
}
const text = (v, label, max, optional = true) => {
  if (typeof v !== 'string') fail(`${label} must be text.`)
  const out = v.trim()
  if ((!optional && !out) || out.length > max || /[\u0000-\u001f\u007f]/.test(out)) fail(`${label} must fit within ${max} characters without control characters.`)
  return out
}
export function shipmentFields(body) {
  const kind = body.kind ?? 'parcel'
  if (!['parcel','pickup','local_delivery','legacy_unspecified'].includes(kind)) fail('Choose parcel, customer pickup or local delivery.')
  const carrier = text(body.carrier ?? '', 'Carrier / method', 60, kind !== 'parcel')
  const tracking_number = text(body.tracking_number ?? '', 'Tracking / collection reference', 100, false)
  const note = text(body.note ?? '', 'Shipment note', 1000)
  const dispatched_on = text(body.dispatched_on ?? '', 'Dispatch date', 10)
  if (dispatched_on && (!/^\d{4}-\d{2}-\d{2}$/.test(dispatched_on) || !Number.isFinite(Date.parse(dispatched_on)) || new Date(dispatched_on + 'T00:00:00Z').toISOString().slice(0,10) !== dispatched_on)) fail('Dispatch date must be a real YYYY-MM-DD date.')
  return { kind, carrier, tracking_number, note, dispatched_on }
}
const actorKey = who => who.id == null ? 'local' : `member:${who.id}`
const atomic = fn => inTransaction() ? fn() : tx(fn)
const revision = scope => get('SELECT revision FROM shipping_scopes WHERE scope=?',scope)?.revision ?? 0

function targetFor(target, reading = false) {
  if (target.job_id != null) {
    const job = get('SELECT * FROM jobs WHERE id=?',target.job_id)
    if (!job) fail('Job not found.',404)
    const estimate = job.estimate_id == null ? null : get('SELECT * FROM estimates WHERE id=?',job.estimate_id)
    if (target.estimate_id != null && job.estimate_id !== target.estimate_id) fail('This job does not belong to this order.',409,'shipping_association_changed')
    const association_blocked = estimate && estimate.contact_id !== job.contact_id ? 'The job and order have different customers. A manager must correct the association first.' : ''
    if (association_blocked && !reading) fail(association_blocked,409,'shipping_association_changed')
    return { scope: `job:${job.id}`, job, estimate: association_blocked ? null : estimate, association_blocked }
  }
  const estimate = get('SELECT * FROM estimates WHERE id=?',target.estimate_id)
  if (!estimate) fail('Order not found.',404)
  return { scope: `estimate:${estimate.id}`, job: null, estimate }
}

export function shippingAvailability(target, who) {
  if (target.association_blocked) return {can_record:false,blocked:target.association_blocked,production_revision:null}
  if (!target.job) {
    if (get('SELECT 1 FROM jobs WHERE estimate_id=?',target.estimate.id))
      return { can_record: false, blocked: 'Choose the production job for this shipment.', production_revision: null }
    return { can_record: true, blocked: '', production_revision: null }
  }
  const w = workflow(target.job.id), task = w.tasks.find(t => t.status === 'pending')
  let blocked = ''
  if (!who.manager) {
    if (!task || task.stage !== 'shipping' || (task.assigned_id !== null && task.assigned_id !== who.id)) blocked = 'The current shipping task must be assigned to you or unassigned.'
    else blocked = taskBlock(target.job,task,w.tasks) || ''
    if (target.job.status !== 'active') blocked = 'This job is not active.'
  }
  return { can_record: !blocked, blocked, production_revision: w.revision }
}

function recordsFor(target) {
  if (!target.job) return all('SELECT * FROM shipping_records WHERE estimate_id=? ORDER BY id',target.estimate.id)
  // Order-level legacy records remain visibly unassigned. They are not guessed onto a job.
  return all('SELECT * FROM shipping_records WHERE job_id=? OR (job_id IS NULL AND estimate_id=?) ORDER BY id',target.job.id,target.estimate?.id ?? null)
}
export function shippingView(ref, who) {
  const target = targetFor(ref,true)
  const jobs = target.job ? [target.job] : all('SELECT * FROM jobs WHERE estimate_id=? ORDER BY id',target.estimate.id)
  const candidates = target.job ? [target] : jobs.length ? jobs.map(job => ({ job, estimate: target.estimate, scope: `job:${job.id}` })) : [target]
  const scopes = candidates.map(t => {
    const mismatch = t.job && t.estimate && t.job.contact_id !== t.estimate.contact_id
    return { scope: t.scope, job_id: t.job?.id ?? null, title: t.job?.title || 'Order', shipping_revision: revision(t.scope),
      ...(mismatch ? { can_record:false, blocked:'Job and order customer differ. Correct their association first.', production_revision:null } : shippingAvailability(t,who)) }
  })
  const records = recordsFor(target)
  const events = target.job
    ? all('SELECT e.* FROM shipping_events e JOIN shipping_records r ON r.id=e.shipment_id WHERE r.job_id=? OR (r.job_id IS NULL AND r.estimate_id=?) ORDER BY e.id',target.job.id,target.estimate?.id ?? null)
    : all('SELECT e.* FROM shipping_events e JOIN shipping_records r ON r.id=e.shipment_id WHERE r.estimate_id=? ORDER BY e.id',target.estimate.id)
  return { scopes, records: records.map(r => ({ ...r, can_correct: !!who.manager,
    shipping_revision: revision(r.scope), history: events.filter(e => e.shipment_id === r.id).map(e => ({ ...e, before: e.before_json ? JSON.parse(e.before_json) : null, after: JSON.parse(e.after_json), before_json: undefined, after_json: undefined })) })), manager: !!who.manager }
}

// No async work or external effects inside this transaction. Receipts survive lost responses.
export function mutateShipment(ref, body, who, { action = 'record', shipment_id = null, legacy = false, dedupe = true } = {}) {
  if (!body || Array.isArray(body) || typeof body !== 'object') fail('Provide shipment details.')
  const fields = action === 'void' ? null : shipmentFields(body)
  const reason = action === 'record' ? '' : text(body.reason ?? '', 'Correction reason', 500, false)
  const request_id = body.request_id == null && legacy ? null : text(body.request_id ?? '', 'Request ID', 128, false)
  if (request_id && !/^[A-Za-z0-9._:-]{8,128}$/.test(request_id)) fail('Request ID must contain 8–128 letters, numbers, dots, colons, underscores or hyphens.')
  const fingerprint = createHash('sha256').update(JSON.stringify({ ref, action, shipment_id, fields, reason, shipping_revision:body.shipping_revision, production_revision:body.production_revision ?? body.revision, record_revision:body.record_revision })).digest('hex')
  return atomic(() => {
    const target = targetFor(ref)
    const previous = request_id ? get('SELECT * FROM shipping_requests WHERE actor_key=? AND request_id=?',actorKey(who),request_id) : null
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail('This request ID was already used for different shipment details.',409,'idempotency_conflict')
      return { ...JSON.parse(previous.result_json), replayed:true }
    }
    const availability = shippingAvailability(target,who)
    if (action !== 'record' && !who.manager) fail('Only a manager can correct or void a shipment.',403)
    if (action === 'record' && !availability.can_record) fail(availability.blocked,403)
    if ((!legacy || body.shipping_revision !== undefined) && (!Number.isSafeInteger(body.shipping_revision) || body.shipping_revision !== revision(target.scope))) fail('Shipment records changed. Refresh them before saving; your draft has not been saved.',409,'shipping_changed')
    if (target.job && (!Number.isSafeInteger(body.production_revision ?? body.revision) || (body.production_revision ?? body.revision) !== availability.production_revision)) fail('Job changed. Refresh it before saving the shipment.',409,'production_changed')
    run('INSERT OR IGNORE INTO shipping_scopes(scope) VALUES(?)',target.scope)
    let before = null, id = shipment_id
    if (action === 'record') {
      // Old clients lacked durable request IDs. Preserve their exact duplicate no-op behavior.
      const duplicate = legacy && dedupe ? get("SELECT * FROM shipping_records WHERE scope=? AND status='recorded' AND carrier=? AND tracking_number=? AND note=? AND dispatched_on=?",target.scope,fields.carrier,fields.tracking_number,fields.note,fields.dispatched_on) : null
      if (duplicate) return { id:duplicate.id, changed:false, replayed:false }
      id = Number(run(`INSERT INTO shipping_records(scope,estimate_id,job_id,kind,carrier,tracking_number,note,dispatched_on,shipping_address,created_by,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`,target.scope,target.estimate?.id ?? null,target.job?.id ?? null,fields.kind,fields.carrier,fields.tracking_number,fields.note,fields.dispatched_on,
        fields.dispatched_on ? target.job?.shipping_address ?? target.estimate?.shipping_address ?? '' : '',who.name,now()).lastInsertRowid)
    } else {
      before = get('SELECT * FROM shipping_records WHERE id=? AND scope=?',id,target.scope)
      if (!before) fail('Shipment does not belong to this job or order.',404)
      if (!Number.isSafeInteger(body.record_revision) || body.record_revision !== before.revision) fail('This shipment changed. Refresh before correcting it.',409,'shipping_changed')
      if (before.status === 'void') fail('This shipment was voided. Record a replacement if needed.',409)
      if (action === 'void') run("UPDATE shipping_records SET status='void',revision=revision+1,updated_by=?,updated_at=? WHERE id=?",who.name,now(),id)
      else run(`UPDATE shipping_records SET kind=?,carrier=?,tracking_number=?,note=?,dispatched_on=?,shipping_address=?,revision=revision+1,updated_by=?,updated_at=? WHERE id=?`,
        fields.kind,fields.carrier,fields.tracking_number,fields.note,fields.dispatched_on,
        fields.dispatched_on ? before.dispatched_on ? before.shipping_address : target.job?.shipping_address ?? target.estimate?.shipping_address ?? '' : '',who.name,now(),id)
    }
    const after = get('SELECT * FROM shipping_records WHERE id=?',id)
    run('INSERT INTO shipping_events(shipment_id,actor,action,reason,before_json,after_json) VALUES(?,?,?,?,?,?)',id,who.name,action,reason,before ? JSON.stringify(before) : null,JSON.stringify(after))
    run('UPDATE shipping_scopes SET revision=revision+1 WHERE scope=?',target.scope)
    if (target.job) {
      run('UPDATE production_jobs SET revision=revision+1 WHERE job_id=?',target.job.id)
      run('INSERT INTO production_events(job_id,actor,action,detail) VALUES(?,?,?,?)',target.job.id,who.name,`shipment.${action}`,JSON.stringify({ shipment_id:id,reason }))
    }
    // Keep the one old order field a projection of only its own legacy record.
    if (after.source_key === `order:${target.estimate?.id}`)
      run('UPDATE estimates SET carrier=?,tracking_number=? WHERE id=?',after.status === 'void' ? '' : after.carrier,after.status === 'void' ? '' : after.tracking_number,target.estimate.id)
    const result = { id, changed:true, replayed:false, shipping_revision:revision(target.scope) }
    if (request_id) run('INSERT INTO shipping_requests(actor_key,request_id,fingerprint,result_json) VALUES(?,?,?,?)',actorKey(who),request_id,fingerprint,JSON.stringify(result))
    return result
  })
}

export function legacyOrderTracking(estimate_id, body, who) {
  const target = targetFor({ estimate_id })
  const carrier = text(body.carrier ?? '', 'Carrier',60)
  const tracking_number = text(body.tracking_number ?? '', 'Tracking number',100)
  if (carrier === (target.estimate.carrier || '') && tracking_number === (target.estimate.tracking_number || '')) return { ok:true, carrier, tracking_number, changed:false }
  // A legacy order has no job selection. Never use it to bypass a linked production queue.
  if (get('SELECT 1 FROM jobs WHERE estimate_id=?',estimate_id)) fail('Use this order’s shipment list and select its production job.',409,'shipping_job_required')
  return atomic(() => {
    const old = get('SELECT * FROM shipping_records WHERE source_key=?',`order:${estimate_id}`)
    let result
    if (old && old.status !== 'void') {
      result = mutateShipment({estimate_id}, { ...body,kind:'legacy_unspecified',carrier,tracking_number,
        shipping_revision:revision(target.scope),record_revision:old.revision,reason:'Legacy tracking field updated' },who,
      { action:tracking_number ? 'correct' : 'void',shipment_id:old.id,legacy:true })
    } else if (tracking_number) {
      result = mutateShipment({estimate_id},{ ...body,kind:'legacy_unspecified',carrier,tracking_number },who,{legacy:true,dedupe:false})
      // Retain earlier void history; make the current adapter target explicit.
      if (old) run('UPDATE shipping_records SET source_key=? WHERE id=?',`order:${estimate_id}:void:${old.id}`,old.id)
      run('UPDATE shipping_records SET source_key=? WHERE id=?',`order:${estimate_id}`,result.id)
    } else result = { changed:false }
    run('UPDATE estimates SET carrier=?,tracking_number=? WHERE id=?',carrier,tracking_number,estimate_id)
    return { ok:true,carrier,tracking_number,...result }
  })
}
