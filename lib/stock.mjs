/**
 * Live stock per size, for the line a shop is quoting right now.
 *
 * The distributor lookups already existed (lib/suppliers.mjs: lookupSS, sanmarInventory,
 * alphaInventory) and so did GET /api/suppliers/inventory — but that answered with the first 40
 * raw SKU rows of a style, every colour mixed together, and nothing in the product showed it
 * beside a size box. A shop quoted 60 XL, the customer approved, and the first anyone heard that
 * the distributor had 18 was the day the purchase order was placed.
 *
 * This module turns a quote line ("Gildan 5000 Tee — Black — 2/0 front") into one answer shaped
 * like the size grid: the colour it matched, and per size the quantity on hand and the exact
 * distributor SKU. Three rules it does not bend:
 *
 *   · It never blocks a quote. Every failure is a `state`, never a throw.
 *   · Stock is minutes old at most. Blank COST is cached for twelve hours (suppliers.mjs); a
 *     twelve-hour-old stock figure is a wrong one, so this keeps its own short-lived entry.
 *   · One shop cannot spend another's rate limit, and a shop cannot hammer a distributor: outbound
 *     lookups are counted per shop, and identical lookups in flight are shared.
 */
import { get, run, now, tenantStore } from './db.mjs'
import { supplierStatus, lookupSS, sanmarInventory, alphaInventory, parseGarmentText } from './suppliers.mjs'

export const STOCK_TTL_MS = 10 * 60 * 1000
export const STOCK_LOW = 24            // "low" below two dozen — a size most orders can still drain
const OUTBOUND_PER_MINUTE = 20
const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,39}$/
const SIZE_KEY = /^[0-9]{0,2}[A-Z]{1,4}$/

const norm = (v) => String(v || '').toLowerCase().replace(/\bgrey\b/g, 'gray').replace(/[^a-z0-9]+/g, ' ').trim()

/**
 * A distributor's size label → the key the size grid uses.
 *
 * S&S writes "S", "2XL", "XLT"; PromoStandards labelSize is the same family but turns up as
 * "XXL", "SM", "One Size" or "OSFA" depending on who filled the feed in. Anything that does not
 * reduce to a grid-shaped key is dropped rather than shown under the wrong box.
 */
export function stockSizeKey(label) {
  let s = String(label || '').toUpperCase().replace(/[.\s_-]+/g, '')
  if (!s) return null
  if (/^(OSFA|OSFM|ONESIZE|ONESIZEFITSALL|ONESIZEFITSMOST|OS|ADJ|ADJUSTABLE|NA|NONE)$/.test(s)) return 'OSFA'
  s = s.replace(/^YOUTH/, 'Y')
  const words = { XSMALL: 'XS', SMALL: 'S', SM: 'S', SML: 'S', MEDIUM: 'M', MED: 'M', MD: 'M', LARGE: 'L', LG: 'L', LRG: 'L', XLARGE: 'XL', XLG: 'XL' }
  const youth = s.startsWith('Y') && s.length > 1 && words[s.slice(1)] ? `Y${words[s.slice(1)]}` : null
  if (youth) return youth
  if (words[s]) return words[s]
  // XXL → 2XL, XXXL → 3XL, XXLT → 2XLT (never touches a lone XL or XS).
  const xs = /^(X{2,6})(L|LT)$/.exec(s)
  if (xs) s = `${xs[1].length}X${xs[2]}`
  return SIZE_KEY.test(s) ? s : null
}

/**
 * Which of the distributor's colours is this line talking about?
 *
 * The line is free text and the colour can sit anywhere in it, so match the distributor's OWN
 * colour names against the text — longest first, so "Heather Navy" wins over "Navy" and "Dark
 * Heather" over "Heather". Text inside parentheses is the ink spec ("(white ink)") and is never
 * read as the garment's colour; the same rule the purchase order follows —
 */
export function matchStockColor(text, colors) {
  // …except a bracket in the garment segment that does not mention ink: the guided estimate writes
  // "Gildan 5000 T-shirt (Black) — 1/0 Front", and that Black is the shirt.
  const [head, ...rest] = String(text || '').split('—')
  const keep = head.replace(/\([^)]*\b(?:ink|inks|thread|print|imprint)\b[^)]*\)/gi, ' ')
  const hay = ` ${norm([keep, ...rest.map((seg) => seg.replace(/\([^)]*\)/g, ' '))].join(' '))} `
  const named = [...new Set((colors || []).filter(Boolean))].sort((a, b) => norm(b).length - norm(a).length)
  for (const c of named) { const n = norm(c); if (n && hay.includes(` ${n} `)) return c }
  return null
}

/* ---------- per-shop outbound budget + shared in-flight lookups ---------- */

const hits = new Map()     // shop → [timestamps]
const flying = new Map()   // shop|key → Promise
const shopKey = () => tenantStore.getStore()?.slug || ''

function takeOutbound(shop, at = Date.now()) {
  const list = (hits.get(shop) || []).filter((t) => at - t < 60_000)
  if (list.length >= OUTBOUND_PER_MINUTE) { hits.set(shop, list); return false }
  list.push(at); hits.set(shop, list)
  if (hits.size > 2000) hits.clear()
  return true
}
/** Test seam: forget every shop's budget and in-flight lookup. */
export function resetStockLimits() { hits.clear(); flying.clear() }

/* ---------- cache (its own short-lived entry in blank_cache) ---------- */

const cacheKey = (text) => `stock|${norm(text).slice(0, 110)}`

function cacheRead(key, maxAgeMs = STOCK_TTL_MS) {
  let row = null
  try { row = get('SELECT payload, updated_at FROM blank_cache WHERE key = ?', key) } catch { return null }
  if (!row) return null
  const at = new Date(String(row.updated_at).replace(' ', 'T') + 'Z').getTime()
  const age = Date.now() - at
  if (!(age >= 0) || age > maxAgeMs) return null
  try { return { ...JSON.parse(row.payload), at } } catch { return null }
}
function cacheWrite(key, payload) {
  try {
    run(`INSERT INTO blank_cache (key, payload, updated_at) VALUES (?,?,?)
         ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`, key, JSON.stringify(payload), now())
  } catch { /* a cache that cannot be written is a slower lookup, not an error */ }
}

/* ---------- the distributor round-trip, normalised ---------- */

/** One style, every colour and size: [{ color, size, sku, qty, cost }]. Never throws. */
async function fetchStyleStock(garmentText, settings, { timeoutMs = 6000 } = {}) {
  const st = supplierStatus(settings)
  const errors = []
  if (st.ss) {
    try {
      const r = await lookupSS(garmentText, settings, { timeoutMs })
      if (r?.length) {
        return { source: 'S&S Activewear', name: [r[0].brand, r[0].style].filter(Boolean).join(' ') || r[0].name || '', title: r[0].name || '',
          rows: r.map((x) => ({ color: x.color || '', size: x.size || '', sku: x.sku || null, qty: Math.max(0, Math.trunc(Number(x.stock) || 0)), cost: Number(x.cost) > 0 ? Number(x.cost) : null })) }
      }
    } catch (e) { errors.push(`S&S: ${String(e.message).slice(0, 160)}`) }
  }
  for (const [on, fn, source] of [[st.sanmar, sanmarInventory, 'SanMar'], [st.alpha, alphaInventory, 'AlphaBroder']]) {
    if (!on) continue
    try {
      const r = await fn(garmentText, settings, { timeoutMs })
      if (r?.length) {
        const { brand, style } = parseGarmentText(garmentText)
        return { source, name: [brand, style].filter(Boolean).join(' '), title: '',
          rows: r.map((x) => ({ color: x.color || '', size: x.size || '', sku: x.sku || x.partId || null, qty: Number.isFinite(Number(x.quantity)) ? Math.max(0, Math.trunc(Number(x.quantity))) : null, cost: null })) }
      }
      // These two swallow their own errors and answer null: unverified endpoints must never throw
      // into a quote. A null from a CONNECTED distributor is therefore "could not reach it".
      if (r === null) errors.push(`${source}: no answer`)
    } catch (e) { errors.push(`${source}: ${String(e.message).slice(0, 160)}`) }
  }
  return { source: null, rows: [], errors }
}

/**
 * Stock for one quote line.
 *
 * @returns {{
 *   state: 'ok'|'pick_color'|'not_connected'|'no_style'|'not_found'|'error'|'rate_limited',
 *   source?: string, name?: string, color?: string|null, colors?: string[],
 *   sizes?: Record<string,{qty:number|null, sku:string|null, cost:number|null}>,
 *   as_of?: string, cached?: boolean, message?: string }}
 */
export async function lineStock(garmentText, settings, { color = '', refresh = false, timeoutMs = 6000 } = {}) {
  const text = String(garmentText || '').trim().slice(0, 200)
  const st = supplierStatus(settings)
  if (!st.connected) return { state: 'not_connected', message: 'Connect S&S, SanMar or alphabroder in Setup to see live stock here.' }
  // The first segment is where the estimate writes the style ("Gildan 5000 Tee — Black — 2/0
  // Front"); the rest of the line is only read for the colour.
  const garment = text.split('—')[0].trim()
  const { style } = parseGarmentText(garment)
  if (!style) return { state: 'no_style', message: 'Add the style number to the line (for example "Gildan 5000") to see stock.' }

  const key = cacheKey(garment)
  const shop = shopKey()
  let hit = refresh ? null : cacheRead(key)
  let cached = !!hit
  if (!hit) {
    const fkey = `${shop}|${key}`
    let p = flying.get(fkey)
    if (!p) {
      if (!takeOutbound(shop)) {
        const stale = cacheRead(key, 24 * 60 * 60 * 1000)
        if (stale) { hit = stale; cached = true }
        else return { state: 'rate_limited', message: 'Too many stock checks in a minute. Try again shortly.' }
      } else {
        p = fetchStyleStock(garment, settings, { timeoutMs }).finally(() => flying.delete(fkey))
        flying.set(fkey, p)
      }
    }
    if (!hit && p) {
      const got = await p
      if (!got.rows.length) {
        return got.errors?.length
          ? { state: 'error', message: `Could not reach the distributor just now (${got.errors[0]}). Stock is not shown; the quote is unaffected.` }
          : { state: 'not_found', message: `No distributor style matched "${garment.slice(0, 60)}".` }
      }
      const payload = { source: got.source, name: got.name, title: got.title, rows: got.rows }
      cacheWrite(key, payload)
      hit = { ...payload, at: Date.now() }
    }
  }

  const colors = [...new Set(hit.rows.map((r) => r.color).filter(Boolean))]
  const base = { source: hit.source, name: hit.name, colors: colors.slice(0, 120), as_of: new Date(hit.at).toISOString(), cached }
  const want = String(color || '').trim()
  let matched = want ? (colors.find((c) => norm(c) === norm(want)) || matchStockColor(want, colors)) : null
  if (!matched) matched = matchStockColor(text, colors)
  if (!matched && colors.length === 1) matched = colors[0]
  if (!matched && colors.length) {
    return { ...base, state: 'pick_color', color: null, message: 'Add the garment color to the line to see stock per size.' }
  }

  // Youth styles are their own style at the distributor, sized XS–XL, while the grid writes YS, YM…
  const youthStyle = /\byouth\b|\bkids?\b|\btoddler\b/i.test(`${hit.title || ''} ${hit.name || ''} ${garment}`)
  const sizes = {}
  for (const r of hit.rows) {
    if (matched && r.color !== matched) continue
    let k = stockSizeKey(r.size)
    if (!k) continue
    if (youthStyle && /^(XS|S|M|L|XL)$/.test(k)) k = `Y${k}`
    const cur = sizes[k]
    // Two SKUs can reduce to one grid key (a feed that lists both "2XL" and "XXL"): keep the one
    // with stock, and never add them — they may be the same shelf described twice.
    if (!cur || (Number(r.qty) || 0) > (Number(cur.qty) || 0)) sizes[k] = { qty: r.qty == null ? null : Number(r.qty), sku: SKU_RE.test(String(r.sku || '')) ? String(r.sku) : null, cost: r.cost ?? null }
  }
  if (!Object.keys(sizes).length) return { ...base, state: 'not_found', color: matched, message: 'The distributor lists this style but no sizes this grid understands.' }
  return { ...base, state: 'ok', color: matched || null, sizes }
}

/** Sizes where the quote asks for more than the distributor has. Pure. */
export function stockShortfalls(ordered, sizes) {
  const out = []
  for (const [k, n] of Object.entries(ordered || {})) {
    const want = Math.trunc(Number(n) || 0)
    const have = sizes?.[String(k).toUpperCase()]?.qty
    if (want > 0 && have != null && want > have) out.push({ size: String(k).toUpperCase(), ordered: want, in_stock: have, short: want - have })
  }
  return out
}

/** The text a line's stock and SKUs are resolved from — the same rule public/js/shared/stock.js applies. */
export const stockLineText = (item) => [item?.description, item?.decoration_pricing ? '' : item?.detail].map((v) => String(v || '').trim()).filter(Boolean).join(' — ')

/**
 * What a quote line may carry about the exact blanks to buy: `skus` (size → distributor SKU),
 * `sku_color` and `sku_source`. Written by the editor when stock resolves; read by the purchase
 * order. Lines reach the server from the editor, the API and imports alike, and a SKU is printed
 * on the PO and sent to a distributor, so anything that is not SKU-shaped is dropped here.
 */
export function sanitizeLineSkus(item) {
  if (!item || typeof item !== 'object') return item
  // `sku_line` is the text the SKUs were resolved for. A line whose wording has moved on since —
  // an API edit of the description, a changed colour — is describing a different blank, and the
  // SKUs of the old one must not reach a purchase order.
  if (item.skus != null && item.sku_line != null && String(item.sku_line).trim() !== stockLineText(item)) { delete item.skus }
  if (item.sku_line != null) item.sku_line = String(item.sku_line).slice(0, 400)
  if (item.skus != null) {
    const out = {}
    if (typeof item.skus === 'object' && !Array.isArray(item.skus)) {
      for (const [k, v] of Object.entries(item.skus).slice(0, 60)) {
        const key = String(k).trim().toUpperCase(), sku = String(v ?? '').trim()
        if (SIZE_KEY.test(key) && SKU_RE.test(sku)) out[key] = sku
      }
    }
    if (Object.keys(out).length) item.skus = out
    else { delete item.skus }
  }
  if (item.sku_color != null) item.sku_color = String(item.sku_color).replace(/[\u0000-\u001f<>"'`&]/g, '').trim().slice(0, 60)
  if (item.sku_source != null) item.sku_source = ['S&S Activewear', 'SanMar', 'AlphaBroder'].includes(item.sku_source) ? item.sku_source : undefined
  if (item.sku_source === undefined) delete item.sku_source
  if (!item.skus) { delete item.sku_color; delete item.sku_source; delete item.sku_line }
  return item
}
