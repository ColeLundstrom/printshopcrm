// A stand-in for api.easypost.com, for tests and for walking the label screens locally.
//
//   in-process:   import { installFakeEasyPost } from './fixtures/fake-easypost.mjs'
//   as a preload: node --import ./test/fixtures/fake-easypost.mjs server.mjs
//                 (FAKE_EASYPOST_CTL=/path/to/ctl.json switches behaviours while it runs,
//                  FAKE_EASYPOST_LOG=/path/to/log.jsonl records every call it answered)
//
// It answers only EasyPost's API host and label-file host; everything else goes to the fetch that
// was there before (in the HTTP tests, the demo network guard). Shapes follow the EasyPost docs
// read on 2026-11-09 — they are this project's reading of those docs, not a recording.
import { readFileSync, appendFileSync } from 'node:fs'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const FILE_HOST = 'easypost-files.s3.us-west-2.amazonaws.com'
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
const err = (status, code, message, errors = []) => json({ error: { code, message, errors } }, status)
const timeout = () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; return e }

export function installFakeEasyPost(opts = {}) {
  const prior = globalThis.fetch
  const state = { shipments: new Map(), calls: [], ctl: { ...opts }, n: 0, buys: 0, refunds: 0, restore: () => { globalThis.fetch = prior } }
  const ctl = () => {
    if (!process.env.FAKE_EASYPOST_CTL) return state.ctl
    try { return { ...state.ctl, ...JSON.parse(readFileSync(process.env.FAKE_EASYPOST_CTL, 'utf8')) } } catch { return state.ctl }
  }
  const log = (entry) => {
    state.calls.push(entry)
    if (process.env.FAKE_EASYPOST_LOG) { try { appendFileSync(process.env.FAKE_EASYPOST_LOG, JSON.stringify(entry) + '\n') } catch { /* best effort */ } }
  }
  const view = (s) => ({
    id: s.id, object: 'Shipment', mode: s.mode, reference: s.reference, status: 'unknown', messages: s.messages,
    to_address: s.to, from_address: s.from, parcel: s.parcel, rates: s.rates, refund_status: s.refund_status,
    selected_rate: s.bought ? s.rates.find((r) => r.id === s.bought) : null,
    tracking_code: s.bought ? s.tracking : null,
    postage_label: s.bought ? { object: 'PostageLabel', label_file_type: 'image/png', label_size: '4x6', label_url: `https://${FILE_HOST}/files/postage_label/${s.id}.png` } : null,
    tracker: s.bought ? { id: `trk_${s.id.slice(4)}`, object: 'Tracker', mode: s.mode, tracking_code: s.tracking, status: s.tracker_status || 'pre_transit', est_delivery_date: '2026-11-13T00:00:00Z',
      public_url: `https://track.easypost.com/${s.id}`, tracking_details: [{ object: 'TrackingDetail', message: 'Shipping label created', status: 'pre_transit', datetime: '2026-11-09T20:00:00Z', tracking_location: { city: 'AUSTIN', state: 'TX' } }] } : null,
  })

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    if (url.hostname === FILE_HOST) {
      log({ kind: 'file', path: url.pathname })
      if (ctl().file === 'fail') return new Response('nope', { status: 503 })
      if (ctl().file === 'html') return new Response('<html>not a label</html>', { status: 200, headers: { 'content-type': 'text/html' } })
      return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })
    }
    if (url.hostname !== 'api.easypost.com') return prior(input, init)
    const method = (init.method || 'GET').toUpperCase(), path = url.pathname.replace(/^\/v2/, '')
    const key = Buffer.from(String(init.headers?.Authorization || '').replace(/^Basic /, ''), 'base64').toString().replace(/:$/, '')
    const body = init.body ? JSON.parse(init.body) : null
    const c = ctl()
    log({ kind: 'api', method, path, key: key.slice(0, 6), body })
    if (c.all === 'timeout') throw timeout()
    if (!key || c.key === 'reject' || /REJECT/.test(key)) return err(401, 'UNAUTHORIZED', 'This api key is no longer active.')
    const mode = /^EZAK/.test(key) ? 'production' : 'test'

    if (method === 'GET' && path === '/shipments') return json({ shipments: [...state.shipments.values()].filter((s) => s.key === key).slice(-1).map(view), has_more: false })
    if (method === 'POST' && path === '/shipments') {
      const sh = body?.shipment || {}
      if (c.rates === 'timeout') throw timeout()
      if (sh.to_address?.zip === '00000') return err(422, 'ADDRESS.VERIFY.FAILURE', 'Unable to verify address.', [{ field: 'address', message: 'Address not found' }])
      const id = `shp_${String(++state.n).padStart(6, '0')}${Math.random().toString(16).slice(2, 10)}`
      const rate = (i, carrier, service, price, days) => ({ id: `rate_${id.slice(4)}_${i}`, object: 'Rate', mode, carrier, service, rate: price, currency: 'USD', delivery_days: days, est_delivery_days: days, shipment_id: id })
      const heavy = Number(sh.parcel?.weight) > 160 ? 6 : 0
      const rates = c.rates === 'none' ? [] : [
        rate(1, 'USPS', 'Priority', (11.2 + heavy).toFixed(2), 2), rate(2, 'USPS', 'GroundAdvantage', (8.45 + heavy).toFixed(2), 3),
        rate(3, 'UPS', 'Ground', (12.9 + heavy).toFixed(2), 4), rate(4, 'FedEx', 'FEDEX_2_DAY', (24.1 + heavy).toFixed(2), 2), rate(5, 'USPS', 'Express', (38.5 + heavy).toFixed(2), 1),
      ]
      const s = { id, key, mode, reference: sh.reference || null, to: sh.to_address, from: sh.from_address, parcel: sh.parcel, rates, bought: null, tracking: null, refund_status: null,
        messages: c.rates === 'none' ? [{ carrier: 'USPS', type: 'rate_error', message: 'No rates for this destination.' }] : [] }
      state.shipments.set(id, s)
      return json(view(s), 201)
    }
    const m = /^\/shipments\/([^/]+)(?:\/(buy|refund))?$/.exec(path)
    const s = m ? state.shipments.get(decodeURIComponent(m[1])) : null
    if (m && (!s || s.key !== key)) return err(404, 'NOT_FOUND', 'The requested resource could not be found.')
    if (m && method === 'GET' && !m[2]) { if (c.get === 'timeout') throw timeout(); return json(view(s)) }
    if (m && method === 'POST' && m[2] === 'buy') {
      if (c.buy === 'timeout') throw timeout()                       // never reached the carrier
      if (c.buy === 'funds') return err(402, 'PAYMENT_REQUIRED', 'Insufficient funds.')
      if (c.buy === 'refuse') return err(422, 'SHIPMENT.POSTAGE.FAILURE', 'The carrier refused this shipment.')
      if (s.bought) return err(422, 'SHIPMENT.POSTAGE.EXISTS', 'Postage already exists for this shipment.')
      if (!s.rates.some((r) => r.id === body?.rate?.id)) return err(422, 'SHIPMENT.RATE.INVALID', 'Rate not found for this shipment.')
      if (c.buy_delay_ms) await new Promise((r) => setTimeout(r, Number(c.buy_delay_ms)))
      s.bought = body.rate.id; s.tracking = `${mode === 'test' ? 'EZ' : '94'}${String(1000000000 + state.n * 7 + state.buys)}`
      state.buys++
      log({ kind: 'purchase', shipment: s.id })
      if (c.buy === 'lost') throw timeout()                          // bought, but the answer never arrived
      return json(view(s))
    }
    if (m && method === 'POST' && m[2] === 'refund') {
      if (!s.bought) return err(422, 'SHIPMENT.REFUND.UNAVAILABLE', 'Shipment has not been purchased.')
      s.refund_status = c.refund === 'rejected' ? 'rejected' : 'submitted'
      state.refunds++
      return json(view(s))
    }
    return err(404, 'NOT_FOUND', 'The requested resource could not be found.')
  }
  return state
}

// Loaded with --import: install with whatever FAKE_EASYPOST_CTL says.
if (process.env.FAKE_EASYPOST_PRELOAD !== '0' && import.meta.url !== `file://${process.argv[1]}` && process.execArgv.some((a) => a.includes('fake-easypost'))) installFakeEasyPost()
