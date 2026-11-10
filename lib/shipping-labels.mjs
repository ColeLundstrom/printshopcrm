/**
 * Shipping labels, bought on the shop's own label account.
 *
 * The shipment ledger (lib/shipping.mjs) records what a person typed. This puts a real label and
 * a real tracking number behind a record: rate a box, buy the label once, keep the label file,
 * and write the carrier and tracking number to the same ledger the manual flow writes to.
 *
 * The rule the whole file is arranged around: A LABEL IS BOUGHT AT MOST ONCE.
 *
 *  · One row per box. Buying claims the row ('rated' → 'buying') in a transaction before any
 *    request leaves the process, so two clicks cannot both be the buyer.
 *  · A buy whose answer was lost leaves the row 'buying'. The next attempt ASKS the provider
 *    whether the shipment was purchased before it does anything else, and finishes from that
 *    answer. It never buys on a guess.
 *  · A refused buy is read back the same way, because "refused" is also what a second purchase
 *    of an already-bought shipment looks like.
 *  · Test-mode labels are never written to the shipment ledger and never emailed to a customer.
 *
 * Buying a label, like recording a shipment by hand, does not move the job, complete a task or
 * message the customer. Emailing the tracking number is its own button.
 */
import { randomBytes } from 'node:crypto'
import { writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { all, get, run, tx, now, getDb, getSettings, setSetting } from './db.mjs'
import { shippingView, mutateShipment } from './shipping.mjs'
import { easypost, LabelProviderError } from './label-provider-easypost.mjs'

export const LABEL_PROVIDERS = { easypost }
const KEY_SETTING = { easypost: 'easypost_api_key' }
/** Settings this module owns. The API key is also listed in lib/db.mjs SECRET_KEYS. */
export const LABEL_SECRET_KEYS = Object.values(KEY_SETTING)

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shipping_labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL UNIQUE,
  box INTEGER NOT NULL DEFAULT 1,
  provider TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'test',
  provider_shipment_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'rated',
  parcel TEXT NOT NULL,
  to_address TEXT NOT NULL,
  from_address TEXT NOT NULL,
  rates TEXT NOT NULL DEFAULT '[]',
  messages TEXT NOT NULL DEFAULT '[]',
  rate_id TEXT NOT NULL DEFAULT '',
  carrier TEXT NOT NULL DEFAULT '',
  service TEXT NOT NULL DEFAULT '',
  price_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'USD',
  tracking_code TEXT NOT NULL DEFAULT '',
  tracking_url TEXT NOT NULL DEFAULT '',
  label_file TEXT NOT NULL DEFAULT '',
  refund_status TEXT NOT NULL DEFAULT '',
  shipment_id INTEGER,
  tracking TEXT,
  tracking_checked_at TEXT,
  notified_at TEXT,
  buy_claimed_at TEXT,
  error TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  bought_by TEXT NOT NULL DEFAULT '',
  bought_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS shipping_labels_job ON shipping_labels(job_id, id);`
const ready = new WeakSet()
const ensure = () => { const d = getDb(); if (!ready.has(d)) { d.exec(SCHEMA); ready.add(d) } }
// One buy at a time per label, per shop database, in this process.
const inflight = new WeakMap()
const flights = () => { const d = getDb(); let m = inflight.get(d); if (!m) { m = new Map(); inflight.set(d, m) } return m }

const fail = (message, status = 400, code = 'invalid_label') => { throw Object.assign(new Error(message), { status, code, expose: true }) }
const parse = (s, d) => { try { const v = JSON.parse(s); return v ?? d } catch { return d } }
const line = (v, max) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '')
const TRACK_STALE_MS = 30 * 60_000
/** "GroundAdvantage" / "FEDEX_2_DAY" as words, without repeating the carrier's own name. */
export const serviceName = (svc, carrier = '') => {
  const t = String(svc || '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b([A-Z])([A-Z]+)\b/g, (_m, x, y) => x + y.toLowerCase()).trim()
  return carrier && t.toLowerCase().startsWith(`${String(carrier).toLowerCase()} `) ? t.slice(String(carrier).length + 1) : t
}
const carrierService = (row) => [row.carrier, serviceName(row.service, row.carrier)].filter(Boolean).join(' ')
const BUY_SETTLE_MS = 3000

/* ---------------------------------------------------------------- addresses and parcels */

const COUNTRY = { US: 'US', USA: 'US', 'UNITED STATES': 'US', 'UNITED STATES OF AMERICA': 'US', CA: 'CA', CANADA: 'CA' }
const ADDRESS_FIELDS = ['name', 'company', 'street1', 'street2', 'city', 'state', 'zip', 'country', 'phone', 'email']

/**
 * The job's ship-to is free text the shop typed ("Lakeside High\n12 Elm St\nAustin, TX 78701").
 * A carrier needs its parts. This reads the common shapes and returns what it found — it is a
 * PREFILL for a form a person confirms, never something sent to a carrier unseen.
 */
export function parseShipTo(text, contact = {}) {
  const out = { name: line(contact.name, 80), company: line(contact.company, 80), street1: '', street2: '', city: '', state: '', zip: '', country: 'US', phone: line(contact.phone, 30), email: line(contact.email, 120) }
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return out
  let at = -1, m = null
  for (let i = lines.length - 1; i >= 0 && at < 0; i--) {
    m = /^(.+?)[,\s]+([A-Za-z]{2})\.?[,\s]+(\d{5}(?:-\d{4})?|[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d)$/.exec(lines[i])
    if (m) at = i
  }
  if (at < 0) { out.street1 = lines.find((l) => /^\d/.test(l)) || ''; return out }
  out.city = m[1].replace(/,$/, '').trim().slice(0, 60); out.state = m[2].toUpperCase(); out.zip = m[3].toUpperCase()
  if (/[A-Z]/.test(out.zip)) out.country = 'CA'
  const after = lines.slice(at + 1).map((l) => COUNTRY[l.toUpperCase().replace(/\./g, '')]).find(Boolean)
  if (after) out.country = after
  const before = lines.slice(0, at)
  const street = before.findIndex((l) => /^\d/.test(l) || /^p\.?\s*o\.?\s*box/i.test(l))
  if (street >= 0) {
    out.street1 = before[street].slice(0, 100)
    out.street2 = before.slice(street + 1).join(', ').slice(0, 100)
    const who = before.slice(0, street)
    if (who[0]) out.name = who[0].slice(0, 80)
    if (who[1]) out.company = who[1].slice(0, 80)
  } else if (before.length) {
    out.street1 = before[before.length - 1].slice(0, 100)
    if (before.length > 1) out.name = before[0].slice(0, 80)
  }
  return out
}

function addressIn(raw, label) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${label} is missing.`, 400, 'label_address')
  const a = Object.fromEntries(ADDRESS_FIELDS.map((k) => [k, line(raw[k], k === 'email' ? 120 : k === 'street1' || k === 'street2' ? 100 : 80)]))
  a.country = COUNTRY[(a.country || 'US').toUpperCase().replace(/\./g, '')] || (/^[A-Za-z]{2}$/.test(a.country) ? a.country.toUpperCase() : '')
  a.state = a.state.toUpperCase()
  const missing = [['street1', 'street address'], ['city', 'city'], ['state', 'state'], ['zip', 'ZIP / postal code'], ['country', 'country']].filter(([k]) => !a[k]).map(([, n]) => n)
  if (missing.length) fail(`${label} needs a ${missing.join(', ')}.`, 400, 'label_address')
  if (!a.name && !a.company) fail(`${label} needs a name or a company.`, 400, 'label_address')
  if (a.country === 'US' && !/^\d{5}(-\d{4})?$/.test(a.zip)) fail(`${label}: a US ZIP code is five digits.`, 400, 'label_address')
  if (a.country === 'US' && !/^[A-Z]{2}$/.test(a.state)) fail(`${label}: use the two-letter state, such as TX.`, 400, 'label_address')
  return a
}

/** Pounds and ounces in, ounces to the carrier. Dimensions are all three or none. */
function parcelIn(raw, n) {
  const num = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : 0 }
  const weight_oz = Math.round((num(raw?.weight_lb) * 16 + num(raw?.weight_oz)) * 10) / 10
  if (!(weight_oz > 0)) fail(`Box ${n} needs a weight.`, 400, 'label_parcel')
  if (weight_oz > 150 * 16) fail(`Box ${n} is over 150 lb, which parcel carriers do not take.`, 400, 'label_parcel')
  const dims = ['length', 'width', 'height'].map((k) => Math.round(num(raw?.[k]) * 10) / 10)
  const given = dims.filter((d) => d > 0).length
  if (given && given < 3) fail(`Box ${n} needs all three dimensions, or none.`, 400, 'label_parcel')
  if (dims.some((d) => d > 108)) fail(`Box ${n} has a side over 108 inches.`, 400, 'label_parcel')
  return { weight_oz, length: dims[0], width: dims[1], height: dims[2] }
}

/* ---------------------------------------------------------------- setup */

const provider = () => LABEL_PROVIDERS[getSettings().label_provider || 'easypost'] || easypost
const apiKey = (p = provider()) => getSettings()[KEY_SETTING[p.id]] || ''

function shipFrom(s = getSettings()) {
  const saved = parse(s.label_ship_from || '{}', {})
  return Object.fromEntries(ADDRESS_FIELDS.map((k) => [k, line(saved[k], 120) || (k === 'company' ? line(s.shop_name, 80) : k === 'phone' ? line(s.shop_phone, 30) : k === 'country' ? 'US' : '')]))
}
const parcelDefault = (s = getSettings()) => {
  const p = parse(s.label_parcel_default || '{}', {})
  return { weight_lb: Number(p.weight_lb) || 0, weight_oz: Number(p.weight_oz) || 0, length: Number(p.length) || 0, width: Number(p.width) || 0, height: Number(p.height) || 0 }
}

/** What a browser may know about the connection. Never the key. */
export function labelSetup(who = {}) {
  const s = getSettings(), p = provider(), key = apiKey(p), from = shipFrom(s)
  let from_ready = true
  try { addressIn(from, 'Ship-from address') } catch { from_ready = false }
  return {
    provider: p.id, provider_name: p.name, connected: !!key, key_mode: key ? p.keyMode(key) : '',
    ship_from: from, ship_from_ready: from_ready, parcel_default: parcelDefault(s),
    staff_can_buy: s.label_staff_buy === '1', manager: !!who.manager, signup_url: p.signup_url,
  }
}

export function saveLabelSetup(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Provide the shipping label settings.')
  const p = provider()
  // Everything is checked before anything is written, so a refused address cannot leave a new key
  // saved beside it with an error on screen.
  const writes = []
  if (body.api_key != null && body.api_key !== '') {
    const key = String(body.api_key).trim()
    if (!/^[A-Za-z0-9_-]{8,200}$/.test(key)) fail('That does not look like an EasyPost API key. Copy it again from easypost.com → Account → API keys.', 400, 'label_key_invalid')
    writes.push([KEY_SETTING[p.id], key], ['label_provider', p.id])
  }
  if (body.ship_from != null) writes.push(['label_ship_from', JSON.stringify(addressIn(body.ship_from, 'Ship-from address'))])
  if (body.parcel_default != null) {
    const d = body.parcel_default || {}
    const n = (v, max) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? Math.min(max, Math.round(x * 10) / 10) : 0 }
    writes.push(['label_parcel_default', JSON.stringify({ weight_lb: n(d.weight_lb, 150), weight_oz: n(d.weight_oz, 15.9), length: n(d.length, 108), width: n(d.width, 108), height: n(d.height, 108) })])
  }
  if (body.staff_can_buy != null) writes.push(['label_staff_buy', body.staff_can_buy === true ? '1' : '0'])
  for (const [k, v] of writes) setSetting(k, v)
}

/* ---------------------------------------------------------------- views */

function rateFlags(rates) {
  if (!rates.length) return []
  const cheapest = rates.reduce((a, b) => (b.price_cents < a.price_cents ? b : a))
  const timed = rates.filter((r) => Number.isInteger(r.days))
  const fastest = timed.length ? timed.reduce((a, b) => (b.days < a.days || (b.days === a.days && b.price_cents < a.price_cents) ? b : a)) : null
  return rates.map((r) => ({ ...r, cheapest: r.id === cheapest.id, fastest: !!fastest && r.id === fastest.id && fastest.id !== cheapest.id }))
}

function labelView(r) {
  const parcel = parse(r.parcel, {})
  return {
    id: r.id, job_id: r.job_id, box: r.box, provider: r.provider, test: r.mode !== 'production', status: r.status,
    parcel, to_address: parse(r.to_address, {}),
    rates: r.status === 'rated' || r.status === 'buying' ? rateFlags(parse(r.rates, [])) : [],
    messages: parse(r.messages, []), rate_id: r.rate_id,
    carrier: r.carrier, service: r.service, price_cents: r.price_cents, currency: r.currency,
    tracking_code: r.tracking_code, tracking_url: r.tracking_url, has_file: !!r.label_file,
    refund_status: r.refund_status, shipment_id: r.shipment_id, recorded: !!r.shipment_id,
    tracking: parse(r.tracking, null), tracking_checked_at: r.tracking_checked_at,
    tracking_stale: r.status === 'bought' && (!r.tracking_checked_at || Date.now() - Date.parse(`${r.tracking_checked_at.replace(' ', 'T')}Z`) > TRACK_STALE_MS),
    notified_at: r.notified_at, error: r.error, created_by: r.created_by, created_at: r.created_at, bought_by: r.bought_by, bought_at: r.bought_at,
  }
}

const jobOr404 = (id) => { const j = get('SELECT * FROM jobs WHERE id=?', Number(id)); if (!j) fail('Job not found.', 404, 'not_found'); return j }
const labelOr404 = (id) => { ensure(); const r = get('SELECT * FROM shipping_labels WHERE id=?', Number(id)); if (!r) fail('Label not found.', 404, 'not_found'); return r }

/** May this person spend the shop's postage on this job? The same test recording a shipment uses, plus the shop's own switch for staff. */
function buyAccess(job, who) {
  const scope = shippingView({ job_id: job.id }, who).scopes[0]
  if (!scope?.can_record) return { ok: false, reason: scope?.blocked || 'Shipping is not available on this job.', scope }
  if (!who.manager && getSettings().label_staff_buy !== '1') return { ok: false, reason: 'Only a manager can buy shipping labels in this shop.', scope }
  return { ok: true, reason: '', scope }
}

export function jobLabels(jobId, who) {
  ensure()
  const job = jobOr404(jobId), access = buyAccess(job, who)
  const contact = job.contact_id ? get('SELECT name, company, phone, email FROM contacts WHERE id=?', job.contact_id) : null
  return {
    setup: labelSetup(who), can_buy: access.ok, blocked: access.reason,
    ship_to: parseShipTo(job.shipping_address || '', contact || {}), ship_to_text: job.shipping_address || '',
    labels: all('SELECT * FROM shipping_labels WHERE job_id=? ORDER BY id', job.id).map(labelView),
  }
}

/* ---------------------------------------------------------------- rating */

export async function rateBoxes(jobId, body, who) {
  ensure()
  const job = jobOr404(jobId)
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Provide the address and at least one box.')
  const requestId = line(body.request_id, 128)
  if (!/^[A-Za-z0-9._:-]{8,100}$/.test(requestId)) fail('Request ID must contain 8–100 letters, numbers, dots, colons, underscores or hyphens.')
  const access = buyAccess(job, who)
  if (!access.ok) fail(access.reason, 403, 'forbidden')
  const p = provider(), key = apiKey(p)
  if (!key) fail('Connect a shipping label account first.', 400, 'label_not_connected')
  const from = addressIn(shipFrom(), 'Ship-from address')
  const to = addressIn(body.to, 'Ship-to address')
  const boxes = Array.isArray(body.boxes) ? body.boxes : []
  if (!boxes.length) fail('Add at least one box.', 400, 'label_parcel')
  if (boxes.length > 10) fail('Rate up to 10 boxes at a time.', 400, 'label_parcel')
  const parcels = boxes.map((b, i) => parcelIn(b, i + 1))
  const made = []
  for (const [i, parcel] of parcels.entries()) {
    const rid = `${requestId}:${i + 1}`
    // A repeat of the same request (double click, lost response) answers with the rows it made.
    const prior = get('SELECT * FROM shipping_labels WHERE request_id=?', rid)
    if (prior) { if (prior.job_id !== job.id) fail('This request ID was already used for another job.', 409, 'idempotency_conflict'); made.push(prior.id); continue }
    const rated = await p.rates({ key, from, to, parcel, reference: `${job.job_number || `job-${job.id}`}-${i + 1}` })
    const stamp = now()
    const info = run(`INSERT OR IGNORE INTO shipping_labels (job_id,request_id,box,provider,mode,provider_shipment_id,status,parcel,to_address,from_address,rates,messages,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, job.id, rid, i + 1, p.id, rated.mode, rated.shipment_id, 'rated', JSON.stringify(parcel), JSON.stringify(to), JSON.stringify(from),
      JSON.stringify(rated.rates), JSON.stringify(rated.messages), who.name, stamp, stamp)
    made.push(Number(info.lastInsertRowid) || get('SELECT id FROM shipping_labels WHERE request_id=?', rid).id)
  }
  // What was typed becomes the default for the next box of this shop.
  const first = boxes[0] || {}
  try { saveLabelSetup({ parcel_default: first }) } catch { /* a default is a convenience */ }
  return { ...jobLabels(job.id, who), rated: made }
}

export function discardLabel(id, who) {
  const r = labelOr404(id)
  if (r.status !== 'rated') fail('Only rates that were never bought can be cleared.', 409, 'label_state')
  const access = buyAccess(jobOr404(r.job_id), who)
  if (!access.ok) fail(access.reason, 403, 'forbidden')
  run("DELETE FROM shipping_labels WHERE id=? AND status='rated'", r.id)
  return jobLabels(r.job_id, who)
}

/* ---------------------------------------------------------------- buying */

function storeLabelFile(row, file, uploads) {
  const name = `label-${randomBytes(18).toString('hex')}.png`
  writeFileSync(join(uploads, name), file.buffer, { flag: 'wx', mode: 0o600 })
  run('UPDATE shipping_labels SET label_file=?, updated_at=? WHERE id=?', name, now(), row.id)
  return name
}

/** Write the bought label to the shipment ledger — once, and never for a test label. */
function recordInLedger(row, who, deps) {
  if (row.shipment_id || row.mode !== 'production' || !row.tracking_code) return null
  const scope = shippingView({ job_id: row.job_id }, who).scopes[0]
  const paid = row.price_cents != null ? ` · ${deps.money(row.price_cents / 100)}` : ''
  const mutation = mutateShipment({ job_id: row.job_id }, {
    kind: 'parcel', carrier: carrierService(row).slice(0, 60) || 'Carrier', tracking_number: row.tracking_code.slice(0, 100),
    note: `Label bought through ${LABEL_PROVIDERS[row.provider]?.name || row.provider}${paid}${row.box > 1 ? ` · box ${row.box}` : ''}`, dispatched_on: '',
    request_id: `label-${row.id}-${row.provider_shipment_id}`.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 128),
    shipping_revision: scope.shipping_revision, production_revision: scope.production_revision,
  }, who)
  run('UPDATE shipping_labels SET shipment_id=?, updated_at=? WHERE id=? AND shipment_id IS NULL', mutation.id, now(), row.id)
  if (mutation.changed && !mutation.replayed) deps.rtBroadcast?.('production', { job_id: row.job_id })
  return mutation
}

/** The purchase is a fact at the provider. Make this database agree with it, then do the follow-ups. */
async function settle(row, bought, who, deps) {
  tx(() => {
    run(`UPDATE shipping_labels SET status='bought', mode=?, rate_id=COALESCE(NULLIF(?,''),rate_id), carrier=?, service=?, price_cents=COALESCE(?,price_cents), currency=?,
      tracking_code=?, tracking_url=?, refund_status=?, error='', bought_at=COALESCE(bought_at,?), bought_by=CASE WHEN bought_by='' THEN ? ELSE bought_by END, updated_at=? WHERE id=?`,
      bought.mode, bought.rate_id, bought.carrier || row.carrier, bought.service || row.service, bought.price_cents, bought.currency || row.currency,
      bought.tracking_code, bought.tracking_url, bought.refund_status || '', now(), who.name, now(), row.id)
  })
  let fresh = get('SELECT * FROM shipping_labels WHERE id=?', row.id)
  deps.logActivity?.('note', `Shipping label bought${fresh.mode !== 'production' ? ' (TEST)' : ''} — ${carrierService(fresh)}${fresh.price_cents != null ? `, ${deps.money(fresh.price_cents / 100)}` : ''}${fresh.tracking_code ? `, tracking ${fresh.tracking_code}` : ''}`, { job_id: fresh.job_id })
  // Follow-ups never undo the purchase. A file that will not download, or a ledger that moved,
  // is reported on the row and retried from the label's own buttons.
  const problems = []
  if (!fresh.label_file && bought.label_url) {
    try { storeLabelFile(fresh, await LABEL_PROVIDERS[fresh.provider].downloadLabel(bought.label_url), deps.uploads) } catch (e) { problems.push(`The label was bought, but its file could not be saved yet: ${e.message}`) }
  }
  fresh = get('SELECT * FROM shipping_labels WHERE id=?', row.id)
  try { recordInLedger(fresh, who, deps) } catch (e) { problems.push(`The label was bought, but it was not added to this job’s shipments: ${e.message}`) }
  run('UPDATE shipping_labels SET error=?, updated_at=? WHERE id=?', problems.join(' ').slice(0, 600), now(), row.id)
  return get('SELECT * FROM shipping_labels WHERE id=?', row.id)
}

async function buyOnce(id, body, who, deps) {
  let row = labelOr404(id)
  const job = jobOr404(row.job_id)
  if (row.status === 'bought') return { label: labelView(row), replayed: true }
  if (row.status === 'void_requested' || row.status === 'voided') fail('This label was voided. Get new rates for a replacement.', 409, 'label_state')
  const access = buyAccess(job, who)
  if (!access.ok) fail(access.reason, 403, 'forbidden')
  const p = LABEL_PROVIDERS[row.provider] || fail('This label’s provider is no longer available.', 409, 'label_state')
  const key = apiKey(p)
  if (!key) fail('Connect a shipping label account first.', 400, 'label_not_connected')
  const rate = parse(row.rates, []).find((r) => r.id === body?.rate_id)
  if (!rate) fail('Choose one of the rates shown. If they are old, get fresh rates.', 400, 'label_rate')
  if (!Number.isSafeInteger(body?.confirm_price_cents) || body.confirm_price_cents !== rate.price_cents) fail('The price on screen is not the price of that rate. Refresh and confirm again.', 409, 'label_price_changed')

  // Claim before anything leaves the process. Whoever flips 'rated' → 'buying' is the buyer.
  const claimed = tx(() => {
    const cur = get('SELECT * FROM shipping_labels WHERE id=?', row.id)
    if (cur.status !== 'rated') return { row: cur, fresh: false }
    run("UPDATE shipping_labels SET status='buying', rate_id=?, carrier=?, service=?, price_cents=?, currency=?, buy_claimed_at=?, bought_by=?, error='', updated_at=? WHERE id=?",
      rate.id, rate.carrier, rate.service, rate.price_cents, rate.currency, now(), who.name, now(), row.id)
    return { row: get('SELECT * FROM shipping_labels WHERE id=?', row.id), fresh: true }
  })
  row = claimed.row
  if (row.status === 'bought') return { label: labelView(row), replayed: true }
  if (row.status !== 'buying') fail('This label changed. Refresh and try again.', 409, 'label_state')

  if (!claimed.fresh) {
    // An earlier attempt never heard back. Ask what happened before doing anything that costs money.
    const seen = await p.get({ key, shipment_id: row.provider_shipment_id })
    if (seen.purchased) return { label: labelView(await settle(row, seen, who, deps)), recovered: true }
    if (row.rate_id !== rate.id) run('UPDATE shipping_labels SET rate_id=?, carrier=?, service=?, price_cents=?, currency=?, updated_at=? WHERE id=?', rate.id, rate.carrier, rate.service, rate.price_cents, rate.currency, now(), row.id)
    run('UPDATE shipping_labels SET buy_claimed_at=?, updated_at=? WHERE id=?', now(), now(), row.id)
  }

  let bought
  try {
    bought = await p.buy({ key, shipment_id: row.provider_shipment_id, rate_id: rate.id })
  } catch (e) {
    if (!(e instanceof LabelProviderError)) throw e
    // "Refused" is also what buying an already-bought shipment looks like, and "no answer" says
    // nothing at all. Either way the provider is asked what it has before this row is believed.
    let seen = null
    try { seen = await p.get({ key, shipment_id: row.provider_shipment_id }) } catch { seen = null }
    if (seen?.purchased) return { label: labelView(await settle(row, seen, who, deps)), recovered: true }
    if (e.uncertain || !seen) {
      run('UPDATE shipping_labels SET error=?, updated_at=? WHERE id=?', 'The last attempt to buy this label got no clear answer.', now(), row.id)
      throw Object.assign(new Error(`${e.message} We could not confirm whether the label was bought. Press “Check purchase” — you will not be charged twice.`), { status: 502, code: 'label_buy_unconfirmed', expose: true })
    }
    // Refused, and the provider confirms nothing was bought: the box is back to its rates.
    run("UPDATE shipping_labels SET status='rated', buy_claimed_at=NULL, bought_by='', error=?, updated_at=? WHERE id=? AND status='buying'", e.message.slice(0, 400), now(), row.id)
    throw e
  }
  if (!bought.purchased) {
    run('UPDATE shipping_labels SET error=?, updated_at=? WHERE id=?', 'The provider answered without a label.', now(), row.id)
    fail('EasyPost answered without a label. Press “Check purchase” before trying anything else — you will not be charged twice.', 502, 'label_buy_unconfirmed')
  }
  return { label: labelView(await settle(row, bought, who, deps)) }
}

/** Buy one label. Concurrent calls for the same label share one attempt. */
export function buyLabel(id, body, who, deps) {
  const map = flights(), key = Number(id)
  const running = map.get(key)
  if (running) return running.then((r) => ({ ...r, replayed: true }))
  const attempt = buyOnce(id, body, who, deps).finally(() => { if (map.get(key) === attempt) map.delete(key) })
  map.set(key, attempt)
  return attempt
}

/** For a row stuck at 'buying': ask the provider, and either finish it or hand the rates back. */
export async function checkPurchase(id, who, deps) {
  const row = labelOr404(id)
  if (row.status !== 'buying') return { label: labelView(row) }
  if (flights().has(row.id)) fail('This label is being bought right now. Give it a moment.', 409, 'label_busy')
  const access = buyAccess(jobOr404(row.job_id), who)
  if (!access.ok) fail(access.reason, 403, 'forbidden')
  const p = LABEL_PROVIDERS[row.provider], key = apiKey(p)
  const seen = await p.get({ key, shipment_id: row.provider_shipment_id })
  if (seen.purchased) return { label: labelView(await settle(row, seen, who, deps)), recovered: true }
  // Not bought. Only release it once the attempt is old enough that it cannot still be landing.
  const age = Date.now() - Date.parse(`${String(row.buy_claimed_at || row.updated_at).replace(' ', 'T')}Z`)
  if (age < BUY_SETTLE_MS) fail('Still waiting on the carrier. Check again in a few seconds.', 409, 'label_busy')
  run("UPDATE shipping_labels SET status='rated', buy_claimed_at=NULL, bought_by='', error='', updated_at=? WHERE id=? AND status='buying'", now(), row.id)
  return { label: labelView(get('SELECT * FROM shipping_labels WHERE id=?', row.id)), released: true }
}

/* ---------------------------------------------------------------- after the purchase */

export async function refreshLabel(id, who, deps) {
  let row = labelOr404(id)
  if (!['bought', 'void_requested'].includes(row.status)) return { label: labelView(row) }
  const p = LABEL_PROVIDERS[row.provider], key = apiKey(p)
  if (!key) return { label: labelView(row) }
  const seen = await p.get({ key, shipment_id: row.provider_shipment_id })
  const status = row.status === 'void_requested' && seen.refund_status === 'refunded' ? 'voided' : row.status
  run('UPDATE shipping_labels SET tracking=?, tracking_checked_at=?, tracking_url=COALESCE(NULLIF(?,\'\'),tracking_url), refund_status=COALESCE(NULLIF(?,\'\'),refund_status), status=?, updated_at=? WHERE id=?',
    seen.tracker ? JSON.stringify(seen.tracker) : row.tracking, now(), seen.tracking_url, seen.refund_status, status, now(), row.id)
  row = get('SELECT * FROM shipping_labels WHERE id=?', row.id)
  const problems = []
  if (row.status === 'bought' && !row.label_file && seen.label_url) {
    try { storeLabelFile(row, await p.downloadLabel(seen.label_url), deps.uploads) } catch (e) { problems.push(`The label file could not be saved yet: ${e.message}`) }
  }
  if (row.status === 'bought' && !row.shipment_id && row.mode === 'production') {
    try { recordInLedger(get('SELECT * FROM shipping_labels WHERE id=?', row.id), who, deps) } catch (e) { problems.push(`Not added to this job’s shipments: ${e.message}`) }
  }
  run('UPDATE shipping_labels SET error=?, updated_at=? WHERE id=?', problems.join(' ').slice(0, 600), now(), row.id)
  return { label: labelView(get('SELECT * FROM shipping_labels WHERE id=?', row.id)) }
}

export async function voidLabel(id, body, who, deps) {
  const row = labelOr404(id)
  if (!who.manager) fail('Only a manager can void a label.', 403, 'forbidden')
  if (row.status === 'void_requested' || row.status === 'voided') return { label: labelView(row), replayed: true }
  if (row.status !== 'bought') fail('Only a bought label can be voided.', 409, 'label_state')
  const reason = line(body?.reason, 300)
  if (!reason) fail('Say why this label is being voided.', 400, 'label_reason')
  const p = LABEL_PROVIDERS[row.provider], key = apiKey(p)
  if (!key) fail('Connect a shipping label account first.', 400, 'label_not_connected')
  const r = await p.refund({ key, shipment_id: row.provider_shipment_id })
  const accepted = r.refund_status === 'submitted' || r.refund_status === 'refunded'
  run('UPDATE shipping_labels SET refund_status=?, status=?, error=?, updated_at=? WHERE id=?', r.refund_status,
    r.refund_status === 'refunded' ? 'voided' : accepted ? 'void_requested' : 'bought',
    accepted ? '' : `The carrier did not accept a refund for this label (${r.refund_status || 'no status'}). It is still valid postage.`, now(), row.id)
  deps.logActivity?.('note', `Shipping label void ${accepted ? 'requested' : 'refused'}${row.tracking_code ? ` — ${row.tracking_code}` : ''}: ${reason}`, { job_id: row.job_id })
  let ledger = ''
  if (accepted && row.shipment_id) {
    // The ledger entry this label wrote is voided with it; its history stays, as with any correction.
    try {
      const record = get('SELECT * FROM shipping_records WHERE id=?', row.shipment_id)
      if (record && record.status !== 'void') {
        const scope = shippingView({ job_id: row.job_id }, who).scopes[0]
        const m = mutateShipment({ job_id: row.job_id }, { reason: `Label voided: ${reason}`.slice(0, 500), record_revision: record.revision,
          request_id: `label-void-${row.id}-${row.provider_shipment_id}`.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 128),
          shipping_revision: scope.shipping_revision, production_revision: scope.production_revision }, who, { action: 'void', shipment_id: record.id })
        if (m.changed && !m.replayed) deps.rtBroadcast?.('production', { job_id: row.job_id })
      }
    } catch (e) { ledger = ` The shipment record could not be voided automatically (${e.message}); correct it under Shipments.` }
    if (ledger) run('UPDATE shipping_labels SET error=?, updated_at=? WHERE id=?', ledger.trim(), now(), row.id)
  }
  return { label: labelView(get('SELECT * FROM shipping_labels WHERE id=?', row.id)), accepted }
}

const TRACKING_EMAIL = 'Hi {{first_name}},\n\n{{job_title}} is on its way with {{carrier}}.\n\nTracking number: {{tracking_number}}\n{{link}}\n\n— {{shop_name}}'

export function emailTracking(id, who, deps) {
  const row = labelOr404(id)
  if (row.status !== 'bought') fail('Only a bought label has tracking to send.', 409, 'label_state')
  if (row.mode !== 'production') fail('This is a TEST label. Its tracking number is not real, so it is not sent to customers.', 409, 'label_test')
  if (!row.tracking_code) fail('This label has no tracking number yet.', 409, 'label_state')
  if (row.notified_at) return { label: labelView(row), replayed: true }
  const access = buyAccess(jobOr404(row.job_id), who)
  if (!access.ok) fail(access.reason, 403, 'forbidden')
  const job = jobOr404(row.job_id)
  const contact = job.contact_id ? get('SELECT * FROM contacts WHERE id=?', job.contact_id) : null
  if (!contact?.email) fail('This customer has no email address on file.', 400, 'no_email')
  const s = getSettings()
  // Claimed first, so a double click cannot send two.
  const claimed = run('UPDATE shipping_labels SET notified_at=?, updated_at=? WHERE id=? AND notified_at IS NULL', now(), now(), row.id)
  if (!Number(claimed?.changes)) return { label: labelView(get('SELECT * FROM shipping_labels WHERE id=?', row.id)), replayed: true }
  try {
    deps.queueEmail({ contact, kind: 'shipping', subject: `Your order from ${s.shop_name} has shipped`, template: TRACKING_EMAIL,
      vars: { job_title: job.title || 'Your order', carrier: carrierService(row) || 'the carrier', tracking_number: row.tracking_code, link: row.tracking_url || '', shop_name: s.shop_name } })
  } catch (e) { run('UPDATE shipping_labels SET notified_at=NULL WHERE id=?', row.id); throw e }
  deps.logActivity?.('note', `Tracking ${row.tracking_code} emailed to ${contact.name || contact.email}`, { contact_id: contact.id, job_id: job.id })
  return { label: labelView(get('SELECT * FROM shipping_labels WHERE id=?', row.id)) }
}

/* ---------------------------------------------------------------- routes */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/**
 * deps: { wrap, requireRole, shippingActor, uploads, queueEmail, outboundLimit, rtBroadcast, logActivity, money }
 * Every route runs inside the signed-in shop's database (the gate put it there), so a label id
 * or a label file name from another shop simply does not exist here.
 */
export function registerShippingLabelRoutes(app, deps) {
  const { requireRole, shippingActor } = deps
  // Refusals here are sentences for the person at the packing bench, including the 502s ("EasyPost
  // did not answer in time") that the app's own error handler would replace with a generic line.
  const wrap = (fn) => deps.wrap(async (req, res, next) => {
    try { return await fn(req, res, next) } catch (e) {
      if (e?.expose && e.message && !res.headersSent) return res.status(Number(e.status) || 400).json({ error: String(e.message).slice(0, 500), code: e.code || 'label_error' })
      throw e
    }
  })
  const who = (req) => shippingActor(req)
  const limit = deps.outboundLimit || ((_req, _res, next) => next())

  app.get('/api/shipping/labels/setup', wrap((req, res) => res.json(labelSetup(who(req)))))
  app.put('/api/shipping/labels/setup', requireRole('manager'), wrap((req, res) => { saveLabelSetup(req.body); res.json(labelSetup(who(req))) }))
  app.post('/api/shipping/labels/setup/test', requireRole('manager'), wrap(async (req, res) => {
    const p = provider(), key = apiKey(p)
    if (!key) return res.status(400).json({ error: 'Save an API key first.', code: 'label_not_connected' })
    const r = await p.check({ key })
    res.json({ ok: true, mode: r.mode, message: r.mode === 'production' ? 'Connected. This is a live key: labels cost real postage.' : 'Connected with a TEST key: labels are samples and cost nothing.' })
  }))
  app.post('/api/shipping/labels/setup/disconnect', requireRole('manager'), wrap((req, res) => {
    for (const k of LABEL_SECRET_KEYS) setSetting(k, '')
    deps.logActivity?.('note', 'Shipping labels disconnected — the API key was removed', {})
    res.json(labelSetup(who(req)))
  }))

  app.get('/api/production/jobs/:id/labels', wrap((req, res) => res.json(jobLabels(req.params.id, who(req)))))
  app.post('/api/production/jobs/:id/labels/rates', wrap(async (req, res) => res.json(await rateBoxes(req.params.id, req.body, who(req)))))
  app.post('/api/shipping/labels/:id/buy', wrap(async (req, res) => res.json(await buyLabel(req.params.id, req.body, who(req), deps))))
  app.post('/api/shipping/labels/:id/check', wrap(async (req, res) => res.json(await checkPurchase(req.params.id, who(req), deps))))
  app.post('/api/shipping/labels/:id/discard', wrap((req, res) => res.json(discardLabel(req.params.id, who(req)))))
  app.post('/api/shipping/labels/:id/track', wrap(async (req, res) => res.json(await refreshLabel(req.params.id, who(req), deps))))
  app.post('/api/shipping/labels/:id/void', requireRole('manager'), wrap(async (req, res) => res.json(await voidLabel(req.params.id, req.body, who(req), deps))))
  app.post('/api/shipping/labels/:id/notify', limit, wrap((req, res) => res.json(emailTracking(req.params.id, who(req), deps))))

  const fileOf = (req, res) => {
    const row = labelOr404(req.params.id)
    if (!row.label_file || !/^label-[a-f0-9]{36}\.png$/.test(row.label_file) || !existsSync(join(deps.uploads, row.label_file))) { res.status(404).json({ error: 'This label has no saved file yet. Refresh the label to fetch it.', code: 'label_file' }); return null }
    return row
  }
  app.get('/api/shipping/labels/:id/file', wrap((req, res) => {
    const row = fileOf(req, res); if (!row) return
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Content-Disposition', `inline; filename="${row.mode !== 'production' ? 'TEST-' : ''}label-${row.id}.png"`)
    res.type('image/png').sendFile(row.label_file, { root: deps.uploads, dotfiles: 'deny' })
  }))
  // A page that prints as one 4×6 label. A test label says so across the label itself.
  app.get('/api/shipping/labels/:id/print', wrap((req, res) => {
    const row = fileOf(req, res); if (!row) return
    const test = row.mode !== 'production'
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'")
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${test ? 'TEST label' : 'Shipping label'} — ${esc(row.tracking_code || `#${row.id}`)}</title>
<style>@page{size:4in 6in;margin:0}html,body{margin:0;background:#fff;color:#111;font:14px system-ui,sans-serif}
.sheet{position:relative;width:4in;height:6in;margin:0 auto;overflow:hidden}.sheet img{width:4in;height:6in;object-fit:contain;display:block}
.test{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
.test span{transform:rotate(-32deg);font:800 30px system-ui,sans-serif;letter-spacing:.06em;color:#b42318;border:5px solid #b42318;padding:8px 16px;background:rgba(255,255,255,.82);text-align:center}
.hint{max-width:4in;margin:10px auto;color:#555;text-align:center}@media print{.hint{display:none}}</style></head>
<body><div class="sheet"><img src="/api/shipping/labels/${row.id}/file" alt="Shipping label ${esc(row.tracking_code)}">${test ? '<div class="test"><span>TEST LABEL<br>NOT VALID POSTAGE</span></div>' : ''}</div>
<p class="hint">${test ? 'This is a TEST label. It cannot be used to ship. ' : ''}Print this page (Ctrl/⌘ + P) on a 4 × 6 label, or at actual size on plain paper.</p></body></html>`)
  }))
}

/** Remove the saved file of a label (used by tests and by a future retention sweep). */
export function removeLabelFile(row, uploads) {
  if (row?.label_file && /^label-[a-f0-9]{36}\.png$/.test(row.label_file)) { try { unlinkSync(join(uploads, row.label_file)) } catch { /* already gone */ } }
}
