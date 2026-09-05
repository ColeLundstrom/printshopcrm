import { randomBytes } from 'node:crypto'
import { all, get, run, now, inTransaction, lineQty, lineAmount, lineUpcharge, getUpcharges } from './db.mjs'

const text = value => String(value ?? '').replace(/\r\n?/g, '\n').trim()
const parsedItems = value => { if (Array.isArray(value)) return value; try { const items = JSON.parse(value || '[]'); return Array.isArray(items) ? items : [] } catch { return [] } }
const numeric = value => Number(value) || 0
const grid = value => Object.fromEntries(Object.entries(value || {}).filter(([, n]) => Number(n) > 0).sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => [k, Number(n)]))

export function estimateTermsIn(value, fallback) {
  if (value === undefined) return String(fallback ?? '')
  if (typeof value !== 'string' || value.length > 12000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))
    throw Object.assign(new Error('Estimate terms must be text, at most 12,000 characters, without control characters.'), { status: 400, expose: true, code: 'invalid_estimate_terms' })
  return value.replace(/\r\n?/g, '\n')
}

export function commercialEstimate(estimate) {
  const upcharges = getUpcharges()
  return {
    contact_id: numeric(estimate.contact_id),
    items: parsedItems(estimate.items).map(entry => { const item = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}; return {
      description: text(item.description), detail: text(item.detail), decoration: text(item.decoration),
      garment: text(item.garment), style: text(item.style), sku: text(item.sku), color: text(item.color), garment_color: text(item.garment_color),
      qty: lineQty(item), sizes: grid(item.sizes), unit_price: numeric(item.unit_price), taxable: item.taxable !== false,
      amount: lineAmount(item, upcharges), upcharge: lineUpcharge(item, upcharges),
    } }),
    subtotal: numeric(estimate.subtotal), tax: numeric(estimate.tax), total: numeric(estimate.total), tax_rate: numeric(estimate.tax_rate),
    notes: text(estimate.notes), rush_days: numeric(estimate.rush_days),
    billing_address: text(estimate.billing_address), shipping_address: text(estimate.shipping_address), terms_snapshot: text(estimate.terms_snapshot),
  }
}
export const commercialEstimateChanged = (before, next) => JSON.stringify(commercialEstimate(before)) !== JSON.stringify(commercialEstimate(next))

export function assertEstimateRevision(estimate, body) {
  const revision = estimate.commercial_revision || 0
  // Old integrations may omit the field only while the quote has never been revised.
  // Once any commercial content changes, an old {} approval cannot accept unseen content.
  if (body?.commercial_revision === undefined && revision === 0) return
  if (!Number.isSafeInteger(body?.commercial_revision) || body.commercial_revision !== revision)
    throw Object.assign(new Error('This quote changed. Reload it, review the current details, then approve or convert again.'), { status: 409, expose: true, code: 'estimate_changed' })
}

export function recordEstimateApproval(estimate, { source = 'legacy_record', actor = '' } = {}) {
  if (!inTransaction()) throw Error('Estimate approval history requires a transaction')
  const snapshot = { ...commercialEstimate(estimate), items: parsedItems(estimate.items),
    estimate_number: estimate.estimate_number, status: estimate.status, approved_at: estimate.approved_at,
    contact_name: get('SELECT name FROM contacts WHERE id=?',estimate.contact_id)?.name || '',
    terms_snapshot_source: estimate.terms_snapshot_source || 'legacy_migration', recipient_snapshot: estimate.recipient_snapshot || null }
  run(`INSERT OR IGNORE INTO estimate_approval_history(estimate_id,commercial_revision,approved_at,source,actor,snapshot)
    VALUES(?,?,?,?,?,?)`, estimate.id, estimate.commercial_revision || 0, estimate.approved_at || null, source, String(actor || '').slice(0, 200), JSON.stringify(snapshot))
}

export function invalidateEstimateApproval(before, next, { actor = '', force = false } = {}) {
  if (!inTransaction()) throw Error('Estimate approval invalidation requires a transaction')
  if (!force && !commercialEstimateChanged(before, next)) return false
  if (before.approved_at || ['approved', 'invoiced'].includes(before.status)) recordEstimateApproval(before)
  run('UPDATE estimate_approval_history SET revoked_at=COALESCE(revoked_at,?),revoked_by=COALESCE(revoked_by,?) WHERE estimate_id=? AND commercial_revision=?',
    now(), String(actor || '').slice(0, 200), before.id, before.commercial_revision || 0)
  run("UPDATE estimates SET status='draft',approved_at=NULL,sent_at=NULL,share_key=?,commercial_revision=commercial_revision+1 WHERE id=?",
    randomBytes(24).toString('hex'), before.id)
  return true
}

export const estimateApprovalHistory = id => all('SELECT * FROM estimate_approval_history WHERE estimate_id=? ORDER BY commercial_revision DESC,id DESC', id)
  .map(row => ({ ...row, snapshot: JSON.parse(row.snapshot) }))

export function latestAcceptedEstimate(contactId) {
  // Only accepted/completed commercial history. A newer draft is a proposal, not a reorder.
  return get(`SELECT * FROM (
    SELECT e.id,e.estimate_number,e.items,e.rush_days,e.commercial_revision FROM estimates e WHERE e.contact_id=? AND e.items!='[]'
      AND (e.status IN ('approved','invoiced') OR EXISTS(SELECT 1 FROM invoices i WHERE i.estimate_id=e.id AND i.status!='void')
        OR EXISTS(SELECT 1 FROM jobs j WHERE j.estimate_id=e.id AND j.status='complete' AND e.commercial_revision=0))
    UNION ALL
    SELECT h.estimate_id AS id,json_extract(h.snapshot,'$.estimate_number') AS estimate_number,
      json_extract(h.snapshot,'$.items') AS items,json_extract(h.snapshot,'$.rush_days') AS rush_days,h.commercial_revision
    FROM estimate_approval_history h WHERE h.estimate_id IS NOT NULL AND json_extract(h.snapshot,'$.contact_id')=?
      AND json_array_length(h.snapshot,'$.items')>0
    ) ORDER BY id DESC,commercial_revision DESC LIMIT 1`, contactId, contactId)
}
