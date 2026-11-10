/**
 * Live distributor stock under the size boxes of a quote line.
 *
 * One module for both quote screens (the full editor and the guided estimate) so they cannot
 * disagree about what "low" means or how a failure reads. The server (lib/stock.mjs) never fails a
 * request over a distributor problem — it answers with a `state` — and this never blocks typing or
 * saving: every path that cannot show stock shows one quiet line, or nothing.
 */
import { api, esc } from '../core.js'

export const STOCK_LOW = 24
const FRESH_MS = 2 * 60 * 1000
const memo = new Map() // garment|color → { at, result, promise }

const keyOf = (garment, color) => `${String(garment || '').trim().toLowerCase()}|${String(color || '').trim().toLowerCase()}`

/** Cached result for this line, if one has arrived (no request is made). */
export function knownStock(garment, color = '') { return memo.get(keyOf(garment, color))?.result || null }

/** Fetch stock for a line. Resolves to the server's answer, or an `error` state — never rejects. */
export function fetchStock(garment, { color = '', refresh = false } = {}) {
  const text = String(garment || '').trim()
  if (text.length < 3) return Promise.resolve({ state: 'no_style' })
  const key = keyOf(text, color)
  const cur = memo.get(key)
  if (!refresh && cur && (cur.promise || Date.now() - cur.at < FRESH_MS)) return cur.promise || Promise.resolve(cur.result)
  const q = new URLSearchParams({ garment: text })
  if (color) q.set('color', color)
  if (refresh) q.set('refresh', '1')
  const promise = api.get(`/api/stock?${q}`)
    .catch(() => ({ state: 'error', message: 'Stock could not be checked just now. The quote is unaffected.' }))
    .then((result) => { memo.set(key, { at: Date.now(), result }); return result })
  memo.set(key, { at: cur?.at || 0, result: cur?.result || null, promise })
  if (memo.size > 200) memo.delete(memo.keys().next().value)
  return promise
}

const count = (n) => Number(n).toLocaleString()

/** The text and tone under one size box: { text, cls, title }. Empty text = show nothing. */
export function stockCell(entry, ordered = 0) {
  if (!entry || entry.qty == null) return { text: '', cls: '', title: '' }
  const have = Number(entry.qty) || 0, want = Math.max(0, Math.trunc(Number(ordered) || 0))
  if (want > have) return { text: have ? `only ${count(have)}` : 'out', cls: 'short', title: `You are quoting ${count(want)}; the distributor has ${count(have)}.` }
  if (have <= 0) return { text: 'out', cls: 'out', title: 'Out of stock at the distributor' }
  if (have < STOCK_LOW) return { text: `low: ${count(have)}`, cls: 'low', title: `${count(have)} in stock` }
  return { text: count(have), cls: 'ok', title: `${count(have)} in stock` }
}

const clock = (iso) => { try { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) } catch { return '' } }

/**
 * The one line under a size grid. `sizes` is the quote line's own grid, so the line can say how
 * many sizes are short. Returns '' when there is nothing worth a line.
 */
export function stockLineHtml(result, sizes = {}) {
  if (!result) return ''
  const refresh = '<button type="button" class="linkbtn stock-refresh" data-stock-refresh>Refresh</button>'
  switch (result.state) {
    case 'ok': {
      const short = Object.entries(sizes || {}).filter(([k, n]) => Number(n) > 0 && result.sizes?.[k]?.qty != null && Number(n) > result.sizes[k].qty)
      const head = short.length
        ? `<strong class="stock-warn">${short.length === 1 ? `${esc(short[0][0])} is` : `${short.length} sizes are`} short at ${esc(result.source)}</strong>`
        : `In stock at ${esc(result.source)}`
      return `${head} · ${esc(result.color || 'all colors')} · as of ${esc(clock(result.as_of))} ${refresh}`
    }
    case 'pick_color': {
      const some = (result.colors || []).slice(0, 4).map(esc).join(', ')
      return `Add the garment color to see stock per size${some ? ` — ${some}${result.colors.length > 4 ? '…' : ''}` : ''}`
    }
    case 'not_connected': return 'Live stock appears here once a supplier is connected. <a href="#/settings">Connect a supplier</a>'
    case 'not_found': return `${esc(result.message || 'No distributor style matched this line.')} ${refresh}`
    case 'rate_limited':
    case 'error': return `${esc(result.message || 'Stock could not be checked just now.')} ${refresh}`
    default: return '' // no_style: the line does not name a style yet — say nothing
  }
}

/** The text a line's stock (and its SKUs) is resolved from: the description, then the detail. */
export const stockLineText = (item) => [item?.description, item?.decoration_pricing ? '' : item?.detail].map((v) => String(v || '').trim()).filter(Boolean).join(' — ')

/**
 * Stamp the exact blanks onto a quote line, or clear them.
 *
 * `skus` (size → distributor SKU), `sku_color` and `sku_source` ride on the line to the job and the
 * purchase order, with `sku_line` — the text they were resolved for. They must describe THIS line:
 *   · stock resolved            → stamp what the distributor says now
 *   · the line names no such style, or no colour → whatever was stamped belongs to a different
 *     garment; remove it
 *   · the distributor could not be reached (or is not connected) → that says nothing about the
 *     line. Keep SKUs only if the line still reads exactly as it did when they were stamped; a
 *     dropped connection must not erase them, and an edited line must not keep another garment's.
 */
export function stampSkus(item, result) {
  if (!item) return item
  const text = stockLineText(item)
  if (result?.state === 'ok' && item.sizes) {
    const skus = {}
    for (const [k, n] of Object.entries(item.sizes)) if (Number(n) > 0 && result.sizes?.[k]?.sku) skus[k] = result.sizes[k].sku
    if (Object.keys(skus).length) { item.skus = skus; item.sku_color = result.color || ''; item.sku_source = result.source || ''; item.sku_line = text; return item }
  }
  const unknown = !result || ['error', 'rate_limited', 'not_connected'].includes(result.state)
  if (unknown && item.skus && item.sku_line === text) {
    // Sizes may have changed while the distributor was unreachable: a size with no SKU stays without.
    for (const k of Object.keys(item.skus)) if (!(Number(item.sizes?.[k]) > 0)) delete item.skus[k]
    if (Object.keys(item.skus).length) return item
  }
  delete item.skus; delete item.sku_color; delete item.sku_source; delete item.sku_line
  return item
}

/**
 * Paint stock into a rendered grid.
 *   grid      element containing `[data-st="<SIZE>"]` cells and one `[data-stockline]`
 *   result    the server's answer (or null to clear)
 *   sizes     the line's quantities
 */
export function paintStock(grid, result, sizes = {}) {
  if (!grid) return
  for (const cell of grid.querySelectorAll('[data-st]')) {
    const c = result?.state === 'ok' ? stockCell(result.sizes?.[cell.dataset.st], sizes?.[cell.dataset.st]) : { text: '', cls: '', title: '' }
    cell.textContent = c.text
    cell.className = `sz-stock${c.cls ? ` ${c.cls}` : ''}`
    if (c.title) cell.title = c.title; else cell.removeAttribute('title')
  }
  const line = grid.querySelector('[data-stockline]') || grid.parentElement?.querySelector('[data-stockline]')
  if (line) { const html = stockLineHtml(result, sizes); line.innerHTML = html; line.hidden = !html }
}
