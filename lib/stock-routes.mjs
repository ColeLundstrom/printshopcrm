/**
 * Routes for live stock on a quote line and for a shop's own blank catalog.
 *
 *   GET    /api/stock?garment=…&color=…&refresh=1   any signed-in member; never a 5xx for a
 *                                                    distributor problem — see lib/stock.mjs
 *   POST   /api/garments                             manager: add a blank the shop buys
 *   PUT    /api/garments/:id                         manager: correct its cost, name or style
 *   DELETE /api/garments/:id                         manager: remove one the shop added
 *
 * The catalog routes exist because the blank catalog was read-only. Its only writer was the seed,
 * so a shop that prints Carhartt, Nike or anything else outside the stock list had no way to say
 * what those blanks cost — and profitability filled the gap with the nearest Gildan or Port
 * Authority row. A blank the shop enters is "your price": it outranks the stock row for the same
 * style, and a boot never overwrites it.
 */
import { get, run, now, getSettings } from './db.mjs'
import { lineStock } from './stock.mjs'
import { listGarments, supplierStatus, isStockCatalogSku } from './suppliers.mjs'

const TYPES = ['tee', 'hoodie', 'crew', 'polo', 'hat', 'tank', 'jacket', 'bag', 'apron', 'other']
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const refuse = (res, error, code, status = 400) => res.status(status).json({ error, code })

/** Validate a blank from a request body. Returns { value } or { error, code }. */
export function garmentInput(b, { partial = false } = {}) {
  const src = b && typeof b === 'object' && !Array.isArray(b) ? b : {}
  const out = {}
  const has = (k) => Object.hasOwn(src, k) && src[k] !== undefined
  if (!partial || has('brand')) { out.brand = clean(src.brand, 60); if (!out.brand) return { error: 'Add the brand (for example Gildan).', code: 'garment_brand_required' } }
  if (!partial || has('style')) { out.style = clean(src.style, 40); if (!out.style) return { error: 'Add the style number (for example 5000).', code: 'garment_style_required' } }
  if (!partial || has('name')) out.name = clean(src.name, 120) || (out.brand && out.style ? `${out.brand} ${out.style}` : '')
  if (!partial || has('cost')) {
    const n = typeof src.cost === 'string' && src.cost.trim() !== '' ? Number(src.cost) : src.cost
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 10000) return { error: 'Cost must be an amount from 0 to 10,000.', code: 'garment_cost_invalid' }
    out.cost = Math.round(n * 100) / 100
  }
  if (!partial || has('type')) { const t = clean(src.type, 20).toLowerCase(); out.type = TYPES.includes(t) ? t : 'other' }
  if (has('sku')) { const s = clean(src.sku, 40); if (s && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s)) return { error: 'A SKU can be letters, numbers, dots and dashes.', code: 'garment_sku_invalid' }; if (s) out.sku = s }
  return { value: out }
}

export function registerStockRoutes(app, { wrap, requireRole }) {
  app.get('/api/stock', wrap(async (req, res) => {
    const garment = String(req.query.garment ?? '').slice(0, 200)
    const color = String(req.query.color ?? '').slice(0, 60)
    const refresh = String(req.query.refresh ?? '') === '1'
    let out
    try { out = await lineStock(garment, getSettings(), { color, refresh }) }
    catch (e) { console.error('stock:', e?.message); out = { state: 'error', message: 'Stock could not be checked just now. The quote is unaffected.' } }
    res.json(out)
  }))

  app.post('/api/garments', requireRole('manager'), wrap((req, res) => {
    const v = garmentInput(req.body)
    if (v.error) return refuse(res, v.error, v.code)
    const g = v.value
    // A SKU the shop did not give is derived, and marked as the shop's own so it can never collide
    // with (or be mistaken for) a stock catalog code.
    const sku = g.sku || `SHOP-${`${g.brand}-${g.style}`.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30)}`
    if (get('SELECT 1 AS x FROM garments WHERE sku = ?', sku)) return refuse(res, `${sku} is already in your catalog. Edit that blank instead.`, 'garment_exists', 409)
    if (get("SELECT 1 AS x FROM garments WHERE supplier = 'shop' AND lower(brand) = lower(?) AND lower(style) = lower(?)", g.brand, g.style))
      return refuse(res, `${g.brand} ${g.style} is already in your catalog. Edit that blank instead.`, 'garment_exists', 409)
    const id = Number(run('INSERT INTO garments (sku, brand, style, name, cost, type, supplier, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      sku, g.brand, g.style, g.name, g.cost, g.type, 'shop', now()).lastInsertRowid)
    res.json({ garment: get('SELECT * FROM garments WHERE id = ?', id) })
  }))

  app.put('/api/garments/:id', requireRole('manager'), wrap((req, res) => {
    const cur = get('SELECT * FROM garments WHERE id = ?', +req.params.id)
    if (!cur) return refuse(res, 'That blank is no longer in the catalog.', 'garment_not_found', 404)
    const v = garmentInput(req.body, { partial: true })
    if (v.error) return refuse(res, v.error, v.code)
    const g = { ...cur, ...v.value }
    delete g.sku // the SKU is the row's identity; the boot-time seed is keyed on it
    // Editing a stock row makes it the shop's: `supplier` is what tells the seed's corrections, and
    // every cost label, that this number was typed by the shop and is not a catalog estimate.
    run("UPDATE garments SET brand=?, style=?, name=?, cost=?, type=?, supplier='shop', updated_at=? WHERE id=?",
      g.brand, g.style, g.name, g.cost, g.type, now(), cur.id)
    res.json({ garment: get('SELECT * FROM garments WHERE id = ?', cur.id) })
  }))

  app.delete('/api/garments/:id', requireRole('manager'), wrap((req, res) => {
    const cur = get('SELECT * FROM garments WHERE id = ?', +req.params.id)
    if (!cur) return res.json({ ok: true })
    // A stock row comes back at the next start (the seed backfills by SKU), so "deleting" one
    // would be a lie that lasts until the next deploy. It can be corrected instead.
    if (isStockCatalogSku(cur.sku)) return refuse(res, 'Built-in catalog styles can be corrected but not removed. Edit the cost instead.', 'garment_stock_row', 409)
    run('DELETE FROM garments WHERE id = ?', cur.id)
    res.json({ ok: true })
  }))

  // Kept beside the write routes so the list a screen reads says where each cost came from.
  app.get('/api/garments/catalog', wrap((_req, res) => res.json({
    garments: listGarments().map((g) => ({ ...g, basis: g.supplier === 'shop' ? 'yours' : 'catalog', removable: !isStockCatalogSku(g.sku) })),
    suppliers: supplierStatus(getSettings()), types: TYPES,
  })))
}
