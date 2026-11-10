/**
 * EasyPost, as a label provider.
 *
 * A provider is five calls and nothing else, so a second one can be added beside this file
 * without touching lib/shipping-labels.mjs:
 *
 *   rates({ key, from, to, parcel, reference })  → { shipment_id, mode, rates[], messages[] }
 *   buy({ key, shipment_id, rate_id })           → purchase (see `purchase()` below)
 *   get({ key, shipment_id })                    → purchase, with `purchased: false` when not bought
 *   refund({ key, shipment_id })                 → { refund_status }
 *   downloadLabel(url)                           → { buffer, mime }
 *   check({ key })                               → { ok, mode }
 *
 * Why EasyPost: a Shipment object is bought AT MOST ONCE and can be read back by id, so after a
 * lost response the question "did that label get bought?" has an answer that costs nothing to ask.
 * That is the property the buy flow is built on. Test keys buy sample labels and never charge.
 *
 * Every request goes to one fixed host. Nothing a shop types can choose where this module
 * connects: the API host is a constant, redirects are refused, and a label file is fetched only
 * from EasyPost's own file hosts.
 *
 * Docs read 2026-11-09:
 *   https://docs.easypost.com/docs/authentication      (API key is the Basic username)
 *   https://docs.easypost.com/docs/shipments           (POST /shipments, POST /shipments/:id/buy, GET /shipments/:id)
 *   https://docs.easypost.com/docs/shipments/options   (label_format, label_size)
 *   https://docs.easypost.com/docs/shipments/shipping-refund (POST /shipments/:id/refund, refund_status)
 *   https://docs.easypost.com/docs/trackers            (tracker status, public_url)
 *   https://docs.easypost.com/docs/errors              ({ error: { code, message, errors } }, 401/402/422)
 */

const API = 'https://api.easypost.com/v2'
const TIMEOUT_MS = 20000
const LABEL_MAX_BYTES = 5 * 1024 * 1024
// postage_label.label_url in EasyPost's own examples: easypost-files.s3.us-west-2.amazonaws.com
const LABEL_HOST = /^(?:easypost-files\.s3[.-][a-z0-9-]+\.amazonaws\.com|easypost-files\.s3\.amazonaws\.com|(?:[a-z0-9-]+\.)*easypost\.com)$/

/** An error a shop can read. `uncertain` means the request may have been acted on. */
export class LabelProviderError extends Error {
  constructor(message, { code = 'label_provider_error', status = 502, uncertain = false, provider_code = '' } = {}) {
    super(message)
    this.code = code; this.status = status; this.uncertain = uncertain; this.provider_code = provider_code; this.expose = true
  }
}

const cents = (v) => { const n = Math.round(Number.parseFloat(v) * 100); return Number.isFinite(n) && n >= 0 ? n : null }
const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '')

function plain(status, body) {
  const e = body?.error || {}
  const code = str(e.code, 80), said = str(e.message, 300)
  const fields = Array.isArray(e.errors) ? e.errors.map((x) => (typeof x === 'string' ? x : [x?.field, x?.message].filter(Boolean).join(': '))).filter(Boolean).slice(0, 4).join('; ') : ''
  const detail = [said, fields && fields !== said ? fields : ''].filter(Boolean).join(' — ').slice(0, 400)
  if (status === 401 || status === 403) return new LabelProviderError('EasyPost did not accept this API key. Check the key in Shipping labels setup.', { code: 'label_key_rejected', status: 400, provider_code: code })
  if (status === 402) return new LabelProviderError('Your EasyPost account cannot pay for this label — add billing details or funds at easypost.com, then try again. Nothing was bought.', { code: 'label_funds', status: 402, provider_code: code })
  if (status === 429) return new LabelProviderError('EasyPost is rate-limiting this account. Wait a minute and try again.', { code: 'label_rate_limited', status: 429, provider_code: code })
  if (status === 404) return new LabelProviderError('EasyPost does not have this shipment under the connected API key. If it was made with your other key (test or live), switch back to that key; otherwise get fresh rates.', { code: 'label_not_found', status: 409, provider_code: code })
  if (status >= 500) return new LabelProviderError('EasyPost had a problem answering. Try again in a moment.', { code: 'label_provider_down', status: 502, uncertain: true, provider_code: code })
  if (/ADDRESS/i.test(code)) return new LabelProviderError(`EasyPost could not use that address${detail ? `: ${detail}` : '.'} Check the street, city, state and ZIP.`, { code: 'label_address', status: 400, provider_code: code })
  return new LabelProviderError(`EasyPost refused the request${detail ? `: ${detail}` : '.'}`, { code: 'label_refused', status: 400, provider_code: code })
}

async function call(key, method, path, body) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,200}$/.test(key)) throw new LabelProviderError('Add your EasyPost API key in Shipping labels setup.', { code: 'label_not_connected', status: 400 })
  let res
  try {
    res = await globalThis.fetch(`${API}${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError'
    throw new LabelProviderError(timedOut ? 'EasyPost did not answer in time.' : 'Could not reach EasyPost.', { code: 'label_provider_unreachable', status: 502, uncertain: true })
  }
  let json = null
  try { json = await res.json() } catch { json = null }
  if (!res.ok) throw plain(res.status, json)
  if (!json || typeof json !== 'object') throw new LabelProviderError('EasyPost sent an answer this app could not read.', { code: 'label_provider_down', status: 502, uncertain: true })
  return json
}

const address = (a) => ({
  name: a.name || undefined, company: a.company || undefined, street1: a.street1, street2: a.street2 || undefined,
  city: a.city, state: a.state, zip: a.zip, country: a.country || 'US', phone: a.phone || undefined, email: a.email || undefined,
})

function rateView(r) {
  const price = cents(r?.rate)
  if (!r || typeof r.id !== 'string' || price === null) return null
  const days = Number.isInteger(r.delivery_days) ? r.delivery_days : Number.isInteger(r.est_delivery_days) ? r.est_delivery_days : null
  return { id: r.id, carrier: str(r.carrier, 40), service: str(r.service, 60), price_cents: price, currency: str(r.currency, 3) || 'USD', days }
}

/** What a shipment says about its own purchase. `purchased` is the one fact the buy flow trusts. */
function purchase(s) {
  const label = s?.postage_label, rate = s?.selected_rate, tracker = s?.tracker
  const purchased = !!(label && typeof label.label_url === 'string' && label.label_url)
  return {
    shipment_id: str(s?.id, 80), mode: s?.mode === 'production' ? 'production' : 'test', purchased,
    carrier: str(rate?.carrier, 40), service: str(rate?.service, 60), rate_id: str(rate?.id, 80),
    price_cents: cents(rate?.rate), currency: str(rate?.currency, 3) || 'USD',
    tracking_code: str(s?.tracking_code, 100), tracking_url: /^https:\/\//.test(tracker?.public_url || '') ? str(tracker.public_url, 300) : '',
    label_url: purchased ? label.label_url : '',
    refund_status: str(s?.refund_status, 30),
    tracker: tracker && typeof tracker === 'object' ? {
      status: str(tracker.status, 40), est_delivery_date: str(tracker.est_delivery_date, 40),
      events: (Array.isArray(tracker.tracking_details) ? tracker.tracking_details : []).slice(-8).map((d) => ({
        at: str(d?.datetime, 40), status: str(d?.status, 40), message: str(d?.message, 200),
        where: [d?.tracking_location?.city, d?.tracking_location?.state].filter((x) => typeof x === 'string' && x).join(', ').slice(0, 80),
      })),
    } : null,
  }
}

export const easypost = {
  id: 'easypost',
  name: 'EasyPost',
  signup_url: 'https://www.easypost.com/signup',
  /** A hint for the setup screen only. The mode a label was bought in comes from the shipment itself. */
  keyMode: (key) => (/^EZTK/.test(String(key || '')) ? 'test' : /^EZAK/.test(String(key || '')) ? 'production' : 'unknown'),

  /** Is the key accepted? Reads one shipment page; creates nothing and costs nothing. */
  async check({ key }) {
    const r = await call(key, 'GET', '/shipments?page_size=1')
    const first = Array.isArray(r.shipments) ? r.shipments[0] : null
    return { ok: true, mode: first?.mode === 'production' ? 'production' : first?.mode === 'test' ? 'test' : this.keyMode(key) }
  },

  /** Creating a Shipment rates it. Nothing is charged until buy. Weight is ounces, dimensions inches. */
  async rates({ key, from, to, parcel, reference }) {
    const dims = parcel.length && parcel.width && parcel.height ? { length: parcel.length, width: parcel.width, height: parcel.height } : {}
    const s = await call(key, 'POST', '/shipments', {
      shipment: { to_address: address(to), from_address: address(from), parcel: { weight: parcel.weight_oz, ...dims }, reference: str(reference, 60) || undefined,
        options: { label_format: 'PNG', label_size: '4x6' } },
    })
    const rates = (Array.isArray(s.rates) ? s.rates : []).map(rateView).filter(Boolean).sort((a, b) => a.price_cents - b.price_cents).slice(0, 40)
    const messages = (Array.isArray(s.messages) ? s.messages : []).map((m) => [str(m?.carrier, 40), str(m?.message, 200)].filter(Boolean).join(': ')).filter(Boolean).slice(0, 6)
    if (typeof s.id !== 'string' || !s.id) throw new LabelProviderError('EasyPost sent an answer this app could not read.', { code: 'label_provider_down', status: 502 })
    return { shipment_id: s.id, mode: s.mode === 'production' ? 'production' : 'test', rates, messages }
  },

  async buy({ key, shipment_id, rate_id }) {
    return purchase(await call(key, 'POST', `/shipments/${encodeURIComponent(shipment_id)}/buy`, { rate: { id: rate_id } }))
  },

  async get({ key, shipment_id }) {
    return purchase(await call(key, 'GET', `/shipments/${encodeURIComponent(shipment_id)}`))
  },

  async refund({ key, shipment_id }) {
    const s = await call(key, 'POST', `/shipments/${encodeURIComponent(shipment_id)}/refund`)
    return { refund_status: str(s.refund_status, 30) || 'submitted' }
  },

  /** The label image, from EasyPost's own file host only, checked to be the PNG it claims to be. */
  async downloadLabel(url) {
    let u
    try { u = new URL(url) } catch { throw new LabelProviderError('The label file address was not usable.', { code: 'label_file' }) }
    if (u.protocol !== 'https:' || u.username || u.password || !LABEL_HOST.test(u.hostname.toLowerCase())) throw new LabelProviderError('The label file is not on EasyPost’s file host, so it was not downloaded.', { code: 'label_file' })
    let res
    try { res = await globalThis.fetch(u.href, { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) }) } catch { throw new LabelProviderError('Could not download the label file yet.', { code: 'label_file', uncertain: true }) }
    if (!res.ok) throw new LabelProviderError('Could not download the label file yet.', { code: 'label_file', uncertain: true })
    const buffer = Buffer.from(await res.arrayBuffer())
    if (!buffer.length || buffer.length > LABEL_MAX_BYTES) throw new LabelProviderError('The label file was empty or too large.', { code: 'label_file' })
    const png = buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    if (!png) throw new LabelProviderError('The label file was not a PNG image.', { code: 'label_file' })
    return { buffer, mime: 'image/png' }
  },
}
