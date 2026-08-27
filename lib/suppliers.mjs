/**
 * Garment catalog + wholesale distributor integration (S&S Activewear, SanMar, AlphaBroder).
 *
 * Real ROI needs real blank costs, so the catalog is the cost source. It ships seeded with
 * the styles a decorator actually runs and their ~2026 street costs; when a shop connects a
 * distributor account, the same lookups return LIVE cost + inventory + a PO write-path. The
 * integration is credential-gated (env or settings) and degrades to the seeded catalog when
 * not connected — never a blank screen, exactly like the AI layer.
 *
 *   S&S Activewear   REST  https://api.ssactivewear.com  (account number + API key, Basic auth)
 *   SanMar           PromoStandards SOAP + SanMar Web Services (customer number + user/pass)
 *   AlphaBroder      PromoStandards / SanMar-style feed (account + password)
 *
 * All three speak the PromoStandards Inventory + Product Pricing standard, so once a shop is
 * connected the shape returned here is uniform regardless of which distributor answered.
 */
import { all, get, run, now, tx } from './db.mjs'

/** The blanks a real shop runs, with ~2026 case/street costs — the ROI baseline. */
const SEED = [
  // Gildan
  { sku: 'G500', brand: 'Gildan', style: '5000', name: 'Heavy Cotton Tee', cost: 3.20, type: 'tee', supplier: 'catalog' },
  { sku: 'G640', brand: 'Gildan', style: '64000', name: 'Softstyle Tee', cost: 3.60, type: 'tee', supplier: 'catalog' },
  { sku: 'G185', brand: 'Gildan', style: '18500', name: 'Heavy Blend Hoodie', cost: 16.50, type: 'hoodie', supplier: 'catalog' },
  { sku: 'G180', brand: 'Gildan', style: '18000', name: 'Heavy Blend Crew', cost: 13.00, type: 'crew', supplier: 'catalog' },
  { sku: 'G200', brand: 'Gildan', style: '2000', name: 'Ultra Cotton Tee', cost: 3.85, type: 'tee', supplier: 'catalog' },
  { sku: 'G420', brand: 'Gildan', style: '42000', name: 'Performance Tee', cost: 4.50, type: 'tee', supplier: 'catalog' },
  { sku: 'G185F', brand: 'Gildan', style: '18600', name: 'Heavy Blend 1/4 Zip', cost: 18.00, type: 'crew', supplier: 'catalog' },
  // Bella+Canvas
  { sku: 'BC3001', brand: 'Bella+Canvas', style: '3001', name: 'Jersey Tee', cost: 4.10, type: 'tee', supplier: 'catalog' },
  { sku: 'BC3001CVC', brand: 'Bella+Canvas', style: '3001CVC', name: 'CVC Jersey Tee', cost: 5.20, type: 'tee', supplier: 'catalog' },
  { sku: 'BC3413', brand: 'Bella+Canvas', style: '3413', name: 'Tri-Blend Tee', cost: 6.40, type: 'tee', supplier: 'catalog' },
  { sku: 'BC8800', brand: 'Bella+Canvas', style: '8800', name: 'Flowy Tank', cost: 5.60, type: 'tank', supplier: 'catalog' },
  { sku: 'BC3945', brand: 'Bella+Canvas', style: '3945', name: 'Drop Shoulder Fleece', cost: 17.50, type: 'crew', supplier: 'catalog' },
  { sku: 'BC3719', brand: 'Bella+Canvas', style: '3719', name: 'Sponge Fleece Hoodie', cost: 21.00, type: 'hoodie', supplier: 'catalog' },
  { sku: 'BC6400', brand: 'Bella+Canvas', style: '6400', name: 'Womens Relaxed Tee', cost: 4.60, type: 'tee', supplier: 'catalog' },
  // Next Level
  { sku: 'NL3600', brand: 'Next Level', style: '3600', name: 'Cotton Tee', cost: 4.00, type: 'tee', supplier: 'catalog' },
  { sku: 'NL6210', brand: 'Next Level', style: '6210', name: 'CVC Tee', cost: 5.25, type: 'tee', supplier: 'catalog' },
  { sku: 'NL6010', brand: 'Next Level', style: '6010', name: 'Tri-Blend Tee', cost: 6.10, type: 'tee', supplier: 'catalog' },
  // Comfort Colors
  { sku: 'CC1717', brand: 'Comfort Colors', style: '1717', name: 'Garment-Dyed Tee', cost: 6.50, type: 'tee', supplier: 'catalog' },
  { sku: 'CC1580', brand: 'Comfort Colors', style: '1580', name: 'Garment-Dyed Crew', cost: 22.00, type: 'crew', supplier: 'catalog' },
  { sku: 'CC1567', brand: 'Comfort Colors', style: '1567', name: 'Garment-Dyed Hoodie', cost: 26.00, type: 'hoodie', supplier: 'catalog' },
  // Independent Trading
  { sku: 'SS4500', brand: 'Independent', style: 'SS4500', name: 'Midweight Hoodie', cost: 18.50, type: 'hoodie', supplier: 'catalog' },
  { sku: 'IND4000', brand: 'Independent', style: 'IND4000', name: 'Heavyweight Hoodie', cost: 24.00, type: 'hoodie', supplier: 'catalog' },
  { sku: 'PRM1500', brand: 'Independent', style: 'PRM1500', name: 'Womens Cropped Hoodie', cost: 22.00, type: 'hoodie', supplier: 'catalog' },
  // Port & Co / Port Authority / Sport-Tek (SanMar house)
  { sku: 'PC61', brand: 'Port & Company', style: 'PC61', name: 'Essential Tee', cost: 2.75, type: 'tee', supplier: 'catalog' },
  { sku: 'PC54', brand: 'Port & Company', style: 'PC54', name: 'Core Cotton Tee', cost: 2.95, type: 'tee', supplier: 'catalog' },
  { sku: 'PC78H', brand: 'Port & Company', style: 'PC78H', name: 'Core Fleece Hoodie', cost: 13.50, type: 'hoodie', supplier: 'catalog' },
  { sku: 'PA700', brand: 'Port Authority', style: 'A700', name: 'Full-Length Apron', cost: 11.00, type: 'apron', supplier: 'catalog' },
  { sku: 'PAK500', brand: 'Port Authority', style: 'K500', name: 'Silk Touch Polo', cost: 14.00, type: 'polo', supplier: 'catalog' },
  { sku: 'ST350', brand: 'Sport-Tek', style: 'ST350', name: 'PosiCharge Tee', cost: 5.75, type: 'tee', supplier: 'catalog' },
  { sku: 'ST650', brand: 'Sport-Tek', style: 'ST650', name: 'Micropique Polo', cost: 12.00, type: 'polo', supplier: 'catalog' },
  // District
  { sku: 'DT6000', brand: 'District', style: 'DT6000', name: 'Very Important Tee', cost: 3.40, type: 'tee', supplier: 'catalog' },
  { sku: 'DT8100', brand: 'District', style: 'DT8100', name: 'V.I.T. Fleece Hoodie', cost: 15.00, type: 'hoodie', supplier: 'catalog' },
  // Champion
  { sku: 'CS700', brand: 'Champion', style: 'S700', name: 'Powerblend Hoodie', cost: 18.00, type: 'hoodie', supplier: 'catalog' },
  { sku: 'CT105', brand: 'Champion', style: 'T105', name: 'Heritage Tee', cost: 7.00, type: 'tee', supplier: 'catalog' },
  // Headwear
  { sku: 'R112', brand: 'Richardson', style: '112', name: 'Trucker Cap', cost: 7.50, type: 'hat', supplier: 'catalog' },
  { sku: 'R115', brand: 'Richardson', style: '115', name: 'Low Pro Trucker', cost: 7.75, type: 'hat', supplier: 'catalog' },
  { sku: 'YP6006', brand: 'Yupoong', style: '6006', name: 'Five-Panel Trucker', cost: 6.25, type: 'hat', supplier: 'catalog' },
  { sku: 'FF6511', brand: 'Flexfit', style: '6511', name: 'Twill Trucker', cost: 6.90, type: 'hat', supplier: 'catalog' },
  { sku: 'CP90', brand: 'Port & Company', style: 'CP90', name: 'Knit Beanie', cost: 3.50, type: 'hat', supplier: 'catalog' },
  // Bags
  { sku: 'LB85R', brand: 'Liberty Bags', style: '8502', name: 'Cotton Canvas Tote', cost: 3.25, type: 'bag', supplier: 'catalog' },
  { sku: 'BE003', brand: 'BAGedge', style: 'BE003', name: 'Cotton Canvas Tote', cost: 2.80, type: 'bag', supplier: 'catalog' },
  // Youth / Performance
  { sku: 'G500B', brand: 'Gildan', style: '5000B', name: 'Youth Heavy Cotton Tee', cost: 3.00, type: 'tee', supplier: 'catalog' },
  { sku: 'BC3001Y', brand: 'Bella+Canvas', style: '3001Y', name: 'Youth Jersey Tee', cost: 3.90, type: 'tee', supplier: 'catalog' },
]

export function initSuppliers(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS garments (
    id INTEGER PRIMARY KEY, sku TEXT UNIQUE, brand TEXT, style TEXT, name TEXT,
    cost REAL DEFAULT 0, type TEXT, supplier TEXT DEFAULT 'catalog',
    stock INTEGER, updated_at DATETIME );`)
  // 12-hour cache of live distributor lookups, so a 200-piece quote is one API call, not 200.
  db.exec(`CREATE TABLE IF NOT EXISTS blank_cache (
    key TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at DATETIME );`)
  // Purchase orders now PERSIST. Before, a PO was built in memory and thrown away the moment the
  // request returned — no record of what was ordered for a job, no way to receive against it. Five
  // of six competitors have receiving; this is the record that makes it possible.
  db.exec(`CREATE TABLE IF NOT EXISTS purchase_orders (
    id INTEGER PRIMARY KEY, job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
    po_number TEXT, supplier TEXT, status TEXT DEFAULT 'draft',
    total_units INTEGER DEFAULT 0, est_cost REAL DEFAULT 0,
    order_id TEXT, submitted_at DATETIME, expected_at DATETIME,
    notes TEXT DEFAULT '', created_at DATETIME, updated_at DATETIME );`)
  db.exec(`CREATE TABLE IF NOT EXISTS po_lines (
    id INTEGER PRIMARY KEY, po_id INTEGER REFERENCES purchase_orders(id) ON DELETE CASCADE,
    sku TEXT, style TEXT, color TEXT, size TEXT,
    qty_ordered INTEGER DEFAULT 0, qty_received INTEGER DEFAULT 0, unit_cost REAL );`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_po_job ON purchase_orders(job_id);`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_poline_po ON po_lines(po_id);`)
  // Backfill any newly-added seed styles on existing shops (idempotent by SKU).
  for (const g of SEED) {
    run(`INSERT INTO garments (sku, brand, style, name, cost, type, supplier, updated_at) VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(sku) DO NOTHING`,
      g.sku, g.brand, g.style, g.name, g.cost, g.type, g.supplier, now())
  }
}

export const listGarments = () => all('SELECT * FROM garments ORDER BY brand, style')

/**
 * Best blank-cost match for a free-text garment string ("Gildan 5000 — Athletic Gold").
 * The heart of ROI: turns whatever was typed on the estimate into a real cost.
 */
export function costFor(garmentText, preloadedRows = null) {
  const t = String(garmentText || '').toLowerCase()
  if (!t) return null
  // A bulk caller (shop-wide ROI over thousands of jobs) passes the catalog once instead of making
  // this re-scan the garments table per line item — the N+1 that projected to ~11s on a big shop.
  const rows = preloadedRows || all('SELECT * FROM garments')
  // Match on style number first (most specific), then brand+type, then type.
  let hit = rows.find((g) => g.style && t.includes(String(g.style).toLowerCase()))
  if (!hit) hit = rows.find((g) => t.includes(g.brand.toLowerCase()) && t.includes(g.type))
  if (!hit) hit = rows.find((g) => t.includes(g.type))
  return hit ? { cost: hit.cost, sku: hit.sku, name: `${hit.brand} ${hit.style}`, matched: true } : null
}

/* ---------- live distributor connections (credential-gated) ---------- */

/**
 * ⚠️ The SHOP's own credentials always win; env is only a single-tenant/self-host fallback.
 * With env first, one SS_ACCOUNT on the box would make every tenant quote off ONE distributor
 * account — ignoring the key they saved, and pricing their jobs off somebody else's negotiated
 * rate card. `customerPrice` is confidential per account, so that is a data leak, not a default.
 */
function creds(settings) {
  const pick = (own, envVar) => (String(own || '').trim() || process.env[envVar] || '')
  return {
    ss: { account: pick(settings?.ss_account, 'SS_ACCOUNT'), key: pick(settings?.ss_api_key, 'SS_API_KEY') },
    sanmar: { user: pick(settings?.sanmar_user, 'SANMAR_USER'), pass: pick(settings?.sanmar_pass, 'SANMAR_PASS'), cust: pick(settings?.sanmar_cust, 'SANMAR_CUST') },
    alpha: { account: pick(settings?.alpha_account, 'ALPHA_ACCOUNT'), pass: pick(settings?.alpha_pass, 'ALPHA_PASS') },
  }
}

export function supplierStatus(settings) {
  const c = creds(settings)
  const ss = !!(c.ss.account && c.ss.key)
  const sanmar = !!(c.sanmar.user && c.sanmar.pass)
  const alpha = !!(c.alpha.account && c.alpha.pass)
  return { ss, sanmar, alpha, connected: ss || sanmar || alpha, count: [ss, sanmar, alpha].filter(Boolean).length }
}

/* ==========================================================================================
 * LIVE BLANK COST — the real supplier pull.
 *
 * Two protocols, one shape out:
 *   S&S Activewear  REST v2, Basic auth. VERIFIED LIVE against api.ssactivewear.com.
 *   SanMar / Alpha  PromoStandards Pricing-and-Configuration v1.0.0 SOAP.
 *
 * ⚠️ The S&S lookup CANNOT be `/products/?style=5000` — that endpoint takes S&S's own internal
 * identifiers and answers a real style number with `404 "Requested item(s) were not found"`.
 * The path that works (and the one the Merch Troop portal uses in production) is two hops:
 *   GET /v2/styles/?search=<text>   → pick the best styleID
 *   GET /v2/products/?styleid=<id>  → every colour/size SKU, each with its OWN price
 * Per-size pricing is why this matters beyond accuracy: 2XL upcharges stop being a guessed
 * setting and become the distributor's actual number.
 * ========================================================================================== */

const SS_BASE = process.env.SSACTIVEWEAR_API_BASE || 'https://api.ssactivewear.com/v2'

function ssAuthHeader(c) { return `Basic ${Buffer.from(`${c.account}:${c.key}`).toString('base64')}` }

async function ssJson(pathAndQuery, c, { timeoutMs = 8000 } = {}) {
  const res = await fetch(`${SS_BASE}${pathAndQuery}`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Authorization: ssAuthHeader(c), Accept: 'application/json' },
  })
  const text = await res.text()
  let json; try { json = JSON.parse(text) } catch { json = null }
  if (!res.ok) {
    const msg = json?.errors?.[0]?.message || `${res.status}`
    throw new Error(`S&S ${res.status}: ${String(msg).slice(0, 160)}`)
  }
  return Array.isArray(json) ? json : []
}

const normCode = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
const normNum = (v) => { const c = normCode(v); return /^\d+$/.test(c) ? (c.replace(/^0+/, '') || '0') : c }
const normText = (v) => String(v || '').toLowerCase().replace(/\bgrey\b/g, 'gray').replace(/[^a-z0-9]+/g, ' ').trim()

/**
 * Score a styles-search hit. Style number alone is NOT enough to identify a garment: searching
 * "5000" on S&S returns Bayside 5000 before Gildan 5000, so quoting a Gildan job off a bare
 * number silently prices the wrong blank. Brand is therefore a heavily-weighted term, not a
 * tiebreak.
 */
export function ssStyleHitScore(hit = {}, wantStyle = '', wantBrand = '') {
  const wanted = normCode(wantStyle)
  if (!wanted) return 0
  const style = normCode(hit.styleName), part = normCode(hit.partNumber)
  let score = 0
  if (style && style === wanted) score = 300
  else if (/^\d+$/.test(wanted) && normNum(hit.styleName) === normNum(wantStyle)) score = 260
  else if (part && part === wanted) score = 220
  else if (/^\d+$/.test(wanted) && normNum(hit.partNumber) === normNum(wantStyle)) score = 180
  else if (style.startsWith(wanted) || wanted.startsWith(style)) score = 90
  if (!score) return 0
  const brand = normText(hit.brandName)
  if (wantBrand) {
    const wb = normText(wantBrand)
    if (brand === wb) score += 120
    else if (brand.includes(wb) || wb.includes(brand)) score += 80
    else score -= 90            // right number, wrong house — push it below any brand match
  }
  return score
}

/** Split "Gildan 5000 Heavy Cotton — Black" into the brand and style number a search needs. */
export function parseGarmentText(text) {
  const raw = String(text || '').trim()
  const BRANDS = ['bella+canvas', 'bella canvas', 'bella', 'gildan', 'next level', 'comfort colors', 'independent trading',
    'district', 'port & company', 'port authority', 'sport-tek', 'american apparel', 'champion', 'richardson',
    'yupoong', 'flexfit', 'liberty bags', 'bagedge', 'jerzees', 'hanes', 'alstyle', 'anvil', 'bayside', 'los angeles apparel']
  const lower = raw.toLowerCase()
  const brand = BRANDS.find((b) => lower.includes(b)) || ''
  // Style codes look like 5000 / 3001CVC / PC61 / 18500 — a run of digits, optionally lettered.
  // ⚠️ The leading number in real intake text is the QUANTITY, not a style: "200 Gildan 5000 in
  // Black" parsed to style 200 and would have quoted whatever S&S returns for "200". So scan
  // AFTER the brand when there is one, and otherwise strip a leading "<n> <garment-word>".
  const brandAt = brand ? lower.indexOf(brand) : -1
  const scanFrom = brandAt >= 0 ? raw.slice(brandAt + brand.length)
    : raw.replace(/^\s*\d[\d,]*\s*(?:x\s*)?(?=[a-z])/i, '')
  const QTY_WORD = /^(?:tee|tees|t-?shirt|t-?shirts|shirt|shirts|hoodie|hoodies|crew|crews|hat|hats|cap|caps|bag|bags|tank|tanks|piece|pieces|pcs|units?|of)\b/i
  // After a brand name a number IS the style, even when a garment word follows it
  // ("Gildan 18500 hoodies") — the quantity guard only applies to un-anchored text.
  const pick = (text, guardQty = true) => {
    for (const m of text.matchAll(/\b([A-Za-z]{0,3}\d{2,6}[A-Za-z]{0,4})\b/g)) {
      const code = m[1]
      if (/^(19|20)\d{2}$/.test(code)) continue                       // a year, not a style
      const after = text.slice(m.index + code.length).trimStart()
      if (guardQty && /^\d+$/.test(code) && QTY_WORD.test(after)) continue  // "150 tees" — that's a count
      return code
    }
    return ''
  }
  const style = pick(scanFrom, brandAt < 0) || (brandAt >= 0 ? pick(raw.replace(/^\s*\d[\d,]*\s*(?:x\s*)?(?=[a-z])/i, '')) : '')
  return { brand, style, raw }
}

/** Resolve free text to one S&S style. Returns null rather than guessing when nothing scores. */
export async function ssResolveStyle(text, c, { timeoutMs = 8000 } = {}) {
  const { brand, style } = parseGarmentText(text)
  const query = style || String(text || '').trim()
  if (!query) return null
  const hits = await ssJson(`/styles/?search=${encodeURIComponent(query)}&pageSize=25`, c, { timeoutMs })
  let best = null, bestScore = 0
  for (const h of hits) {
    const s = ssStyleHitScore(h, style || query, brand)
    if (s > bestScore) { best = h; bestScore = s }
  }
  return best ? { ...best, _score: bestScore } : null
}

/**
 * Live S&S lookup. Returns one row per colour/size SKU with that SKU's own cost and stock.
 * `customerPrice` is the shop's NEGOTIATED price, which is exactly why these credentials are
 * per-shop and never platform-wide — one shop must never quote off another's rate card.
 */
export async function lookupSS(styleText, settings, { timeoutMs = 8000 } = {}) {
  const c = creds(settings).ss
  if (!(c.account && c.key)) return null
  const style = await ssResolveStyle(styleText, c, { timeoutMs })
  if (!style) return []
  const rows = await ssJson(`/products/?styleid=${encodeURIComponent(style.styleID)}&pageSize=500`, c, { timeoutMs })
  return rows.map((r) => ({
    source: 'S&S Activewear', sku: r.sku, brand: r.brandName || style.brandName,
    style: style.styleName, name: style.title || r.styleName || style.styleName,
    color: r.colorName, size: r.sizeName,
    cost: Number(r.customerPrice ?? r.piecePrice) || null,
    casePrice: Number(r.casePrice) || null,
    msrp: Number(r.retailPrice) || null,
    stock: Number(r.qty) || 0,
    image: r.colorFrontImage ? `https://cdn.ssactivewear.com/${r.colorFrontImage}` : null,
  }))
}

/* ---------- PromoStandards (SanMar, AlphaBroder) ---------- */

// Defaults are SanMar's published PromoStandards endpoints; a shop can override either in
// settings when their account is provisioned on a different host.
const SANMAR_PPC = process.env.SANMAR_PPC_URL || 'https://ws.sanmar.com:8080/promostandards/PricingAndConfigurationServiceBinding'
const SANMAR_INV = process.env.SANMAR_INV_URL || 'https://ws.sanmar.com:8080/promostandards/InventoryServiceBindingV2final'

const xmlEsc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * One PromoStandards SOAP round-trip. Envelope shape, SOAPAction and the ErrorMessage contract
 * were verified live against S&S's PromoStandards host (which speaks the identical 1.0.0 spec):
 * a malformed field comes back as <ErrorMessage><code>125</code>… with HTTP 200, so a 200 is NOT
 * success and has to be inspected.
 */
// ⚠️ SSRF guard. `endpoint` can be shop-supplied (sanmar_ppc_url / alpha_ppc_url), so a trial
// account could otherwise point it at 127.0.0.1 or the cloud metadata IP and read the response
// back through the error/parts it returns. Require https, refuse credentials in the URL, and
// reject any host that is an IP literal or a name that isn't a known distributor domain. Hosts a
// real integration needs are all under these vendors; anything else is refused.
const PROMO_HOST_RE = /(^|\.)(sanmar\.com|sanmarcanada\.com|ssactivewear\.com|alphabroder\.com|appareldownload\.com|promostandards\.org)$/i
function assertSafePromoEndpoint(endpoint) {
  let u
  try { u = new URL(String(endpoint)) } catch { throw new Error('Invalid supplier endpoint URL') }
  if (u.protocol !== 'https:') throw new Error('Supplier endpoint must be https')
  if (u.username || u.password) throw new Error('Supplier endpoint must not embed credentials')
  const host = u.hostname.toLowerCase()
  // Block IP literals outright (covers loopback, private, link-local, metadata 169.254.169.254).
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host === 'localhost') {
    throw new Error('Supplier endpoint host is not allowed')
  }
  if (!PROMO_HOST_RE.test(host)) throw new Error('Supplier endpoint host is not an approved distributor')
  return u.toString()
}

export async function psSoap({ endpoint, action, xml, timeoutMs = 10000 }) {
  const safe = assertSafePromoEndpoint(endpoint)
  const res = await fetch(safe, {
    method: 'POST',
    redirect: 'manual',                 // never follow a redirect to an internal host
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: action },
    body: xml,
  })
  const text = await res.text()
  const code = text.match(/<(?:\w+:)?code>([^<]*)<\/(?:\w+:)?code>/i)
  // Do NOT reflect the remote <description> back to the caller — on a shop-supplied endpoint that
  // is an exfiltration channel. Surface only the PromoStandards error CODE (a small enum).
  if (code) throw new Error(`PromoStandards error ${code[1]}`)
  if (!res.ok) throw new Error(`PromoStandards HTTP ${res.status}`)
  return text
}

function ppcEnvelope({ user, pass, productId }) {
  return `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns="http://www.promostandards.org/WSDL/PricingAndConfiguration/1.0.0/" xmlns:shar="http://www.promostandards.org/WSDL/PricingAndConfiguration/1.0.0/SharedObjects/"><soapenv:Header/><soapenv:Body><ns:GetConfigurationAndPricingRequest><shar:wsVersion>1.0.0</shar:wsVersion><shar:id>${xmlEsc(user)}</shar:id><shar:password>${xmlEsc(pass)}</shar:password><shar:productId>${xmlEsc(productId)}</shar:productId><shar:currency>USD</shar:currency><shar:fobId>1</shar:fobId><shar:priceType>Net</shar:priceType><shar:localizationCountry>US</shar:localizationCountry><shar:localizationLanguage>en</shar:localizationLanguage><shar:configurationType>Blank</shar:configurationType></ns:GetConfigurationAndPricingRequest></soapenv:Body></soapenv:Envelope>`
}

/** Pull every <PartPrice> out of a PPC response and reduce to one row per part. */
export function parsePpcParts(xmlText) {
  const out = []
  const parts = String(xmlText || '').match(/<(?:\w+:)?Part>[\s\S]*?<\/(?:\w+:)?Part>/gi) || []
  for (const p of parts) {
    const one = (tag) => { const m = p.match(new RegExp(`<(?:\\w+:)?${tag}>([^<]*)</(?:\\w+:)?${tag}>`, 'i')); return m ? m[1].trim() : null }
    const prices = [...p.matchAll(/<(?:\w+:)?PartPrice>[\s\S]*?<\/(?:\w+:)?PartPrice>/gi)].map((m) => {
      const b = m[0]
      const g = (tag) => { const mm = b.match(new RegExp(`<(?:\\w+:)?${tag}>([^<]*)</(?:\\w+:)?${tag}>`, 'i')); return mm ? mm[1].trim() : null }
      return { minQty: Number(g('minQuantity')) || 1, price: Number(g('price')) || null }
    }).filter((x) => x.price != null).sort((a, b) => a.minQty - b.minQty)
    out.push({
      partId: one('partId'), description: one('partDescription'),
      color: one('ColorName') || one('colorName'), size: one('LabelSize') || one('labelSize'),
      breaks: prices, cost: prices.length ? prices[0].price : null,
    })
  }
  return out
}

/**
 * SanMar via PromoStandards. SanMar's productId is the style number ("PC61"), unlike S&S which
 * uses its own SKU space — that difference is the whole reason these are separate functions.
 */
export async function lookupSanMar(styleText, settings, { timeoutMs = 10000 } = {}) {
  const c = creds(settings).sanmar
  if (!(c.user && c.pass)) return null
  const { style } = parseGarmentText(styleText)
  const productId = style || String(styleText || '').trim()
  if (!productId) return []
  const endpoint = settings?.sanmar_ppc_url || SANMAR_PPC
  const xml = await psSoap({ endpoint, action: 'getConfigurationAndPricing', xml: ppcEnvelope({ user: c.user, pass: c.pass, productId }), timeoutMs })
  return parsePpcParts(xml).map((p) => ({
    source: 'SanMar', sku: p.partId, brand: 'SanMar', style: productId,
    name: p.description || productId, color: p.color, size: p.size,
    cost: p.cost, breaks: p.breaks, stock: null, image: null,
  }))
}

/** AlphaBroder speaks the same PPC spec on its own host. */
export async function lookupAlpha(styleText, settings, { timeoutMs = 10000 } = {}) {
  const c = creds(settings).alpha
  if (!(c.account && c.pass)) return null
  const endpoint = settings?.alpha_ppc_url || process.env.ALPHA_PPC_URL
  if (!endpoint) return null   // no guessed host — an unknown endpoint is not a connection
  const { style } = parseGarmentText(styleText)
  const productId = style || String(styleText || '').trim()
  const xml = await psSoap({ endpoint, action: 'getConfigurationAndPricing', xml: ppcEnvelope({ user: c.account, pass: c.pass, productId }), timeoutMs })
  return parsePpcParts(xml).map((p) => ({
    source: 'AlphaBroder', sku: p.partId, brand: 'AlphaBroder', style: productId,
    name: p.description || productId, color: p.color, size: p.size, cost: p.cost, breaks: p.breaks, stock: null, image: null,
  }))
}

/* ---------- PromoStandards Inventory Service v2.0.0 (live stock) ---------- */

/**
 * GetInventoryLevelsRequest envelope for PromoStandards Inventory Service v2.0.0.
 *
 * ⚠️ UNVERIFIED. The Pricing-and-Configuration path above is verified live against S&S's
 * PromoStandards host; this Inventory-v2 envelope follows the published PromoStandards 2.0.0
 * spec (namespaces, wsVersion 2.0.0, id/password/productId) but has NOT been exercised against a
 * live SanMar account — no SanMar credentials exist yet. It is written so that when an account is
 * provisioned it should work as-is, and until then every caller degrades to null/empty (see
 * sanmarInventory / liveInventory) rather than throwing into a quote.
 */
function invEnvelope({ user, pass, productId }) {
  return `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns="http://www.promostandards.org/WSDL/Inventory/2.0.0/" xmlns:shar="http://www.promostandards.org/WSDL/Inventory/2.0.0/SharedObjects/"><soapenv:Header/><soapenv:Body><ns:GetInventoryLevelsRequest><shar:wsVersion>2.0.0</shar:wsVersion><shar:id>${xmlEsc(user)}</shar:id><shar:password>${xmlEsc(pass)}</shar:password><shar:productId>${xmlEsc(productId)}</shar:productId></ns:GetInventoryLevelsRequest></soapenv:Body></soapenv:Envelope>`
}

/**
 * Walk a GetInventoryLevelsResponse into one row per <PartInventory>, namespace-agnostically
 * (mirrors parsePpcParts). Each part carries a rolled-up quantity plus, when present, the
 * per-<InventoryLocation> warehouse breakdown. The part-level quantityAvailable is read from the
 * section OUTSIDE the InventoryLocationArray so a warehouse figure is never mistaken for the total;
 * if the response omits a part-level total we sum the locations.
 */
export function parseInventoryLevels(xmlText) {
  const out = []
  const parts = String(xmlText || '').match(/<(?:\w+:)?PartInventory>[\s\S]*?<\/(?:\w+:)?PartInventory>/gi) || []
  for (const p of parts) {
    const one = (tag) => { const m = p.match(new RegExp(`<(?:\\w+:)?${tag}>([^<]*)</(?:\\w+:)?${tag}>`, 'i')); return m ? m[1].trim() : null }
    // Per-warehouse breakdown (optional).
    const warehouses = [...p.matchAll(/<(?:\w+:)?InventoryLocation>[\s\S]*?<\/(?:\w+:)?InventoryLocation>/gi)].map((m) => {
      const b = m[0]
      const g = (tag) => { const mm = b.match(new RegExp(`<(?:\\w+:)?${tag}>([^<]*)</(?:\\w+:)?${tag}>`, 'i')); return mm ? mm[1].trim() : null }
      const val = b.match(/<(?:\w+:)?value>([^<]*)<\/(?:\w+:)?value>/i)
      return { id: g('inventoryLocationId'), name: g('inventoryLocationName'), quantity: val ? Number(val[1]) : null }
    })
    // Part-level total = the quantityAvailable that sits outside any InventoryLocationArray.
    const partOnly = p.replace(/<(?:\w+:)?InventoryLocationArray>[\s\S]*?<\/(?:\w+:)?InventoryLocationArray>/gi, '')
    const totalM = partOnly.match(/<(?:\w+:)?quantityAvailable>[\s\S]*?<(?:\w+:)?value>([^<]*)<\/(?:\w+:)?value>[\s\S]*?<\/(?:\w+:)?quantityAvailable>/i)
    let quantity = totalM ? Number(totalM[1]) : null
    if (!Number.isFinite(quantity) && warehouses.length) quantity = warehouses.reduce((s, w) => s + (Number(w.quantity) || 0), 0)
    out.push({
      partId: one('partId'), sku: one('partId'),
      color: one('partColor') || one('ColorName') || one('colorName'),
      size: one('labelSize') || one('LabelSize'),
      quantity: Number.isFinite(quantity) ? quantity : null,
      warehouses: warehouses.length ? warehouses : undefined,
    })
  }
  return out
}

/** Shared PromoStandards Inventory-v2 round-trip. SanMar and AlphaBroder speak the identical spec. */
async function psInventoryLevels({ endpoint, user, pass, productId, source, timeoutMs = 10000 }) {
  const xml = await psSoap({ endpoint, action: 'getInventoryLevels', xml: invEnvelope({ user, pass, productId }), timeoutMs })
  return parseInventoryLevels(xml).map((r) => ({
    source, sku: r.sku || r.partId, partId: r.partId, style: productId,
    color: r.color, size: r.size, quantity: r.quantity, warehouses: r.warehouses,
  }))
}

/**
 * Live SanMar inventory via PromoStandards Inventory Service v2.0.0 getInventoryLevels.
 * Returns null when SanMar creds are absent, [] when there is nothing to ask about, and — because
 * SanMar is UNVERIFIED (no live credentials exist) — null on ANY error so a supplier hiccup can
 * never throw into a quote. productId is the style number, exactly as lookupSanMar does it.
 */
export async function sanmarInventory(styleText, settings, { timeoutMs = 10000 } = {}) {
  try {
    const c = creds(settings).sanmar
    if (!(c.user && c.pass)) return null
    const { style } = parseGarmentText(styleText)
    const productId = style || String(styleText || '').trim()
    if (!productId) return []
    const endpoint = settings?.sanmar_inv_url || SANMAR_INV
    return await psInventoryLevels({ endpoint, user: c.user, pass: c.pass, productId, source: 'SanMar', timeoutMs })
  } catch { return null }   // unverified endpoint — degrade to nothing, never throw
}

/** AlphaBroder speaks the same Inventory-v2 spec on its own host. No guessed host — see lookupAlpha. */
export async function alphaInventory(styleText, settings, { timeoutMs = 10000 } = {}) {
  try {
    const c = creds(settings).alpha
    if (!(c.account && c.pass)) return null
    const endpoint = settings?.alpha_inv_url || process.env.ALPHA_INV_URL
    if (!endpoint) return null   // an unknown endpoint is not a connection
    const { style } = parseGarmentText(styleText)
    const productId = style || String(styleText || '').trim()
    if (!productId) return []
    return await psInventoryLevels({ endpoint, user: c.account, pass: c.pass, productId, source: 'AlphaBroder', timeoutMs })
  } catch { return null }
}

/**
 * Unified live inventory: try every connected distributor for on-hand stock, in the same order and
 * shape as lookupLive. S&S already returns stock through lookupSS (REST) — its behavior is left
 * untouched and simply mapped into the { source, sku, color, size, quantity } inventory shape;
 * SanMar / AlphaBroder answer via PromoStandards Inventory v2. Always resolves (never rejects): an
 * unconnected or erroring supplier yields empty rows so a quote is never blocked on stock.
 */
export async function liveInventory(style, settings, { timeoutMs = 8000, limit = 40 } = {}) {
  const st = supplierStatus(settings)
  const errors = []
  if (st.ss) {
    try {
      const r = await lookupSS(style, settings, { timeoutMs })
      if (r?.length) {
        const rows = r.map((x) => ({ source: 'S&S Activewear', sku: x.sku, color: x.color, size: x.size, quantity: Number(x.stock) || 0 }))
        return { source: 'S&S Activewear', live: true, rows: limit > 0 ? rows.slice(0, limit) : rows }
      }
    } catch (e) { errors.push(`S&S: ${e.message}`) }
  }
  if (st.sanmar) {
    try { const r = await sanmarInventory(style, settings, { timeoutMs }); if (r?.length) return { source: 'SanMar', live: true, rows: limit > 0 ? r.slice(0, limit) : r } }
    catch (e) { errors.push(`SanMar: ${e.message}`) }
  }
  if (st.alpha) {
    try { const r = await alphaInventory(style, settings, { timeoutMs }); if (r?.length) return { source: 'AlphaBroder', live: true, rows: limit > 0 ? r.slice(0, limit) : r } }
    catch (e) { errors.push(`AlphaBroder: ${e.message}`) }
  }
  return { source: null, live: false, rows: [], errors: errors.length ? errors : undefined }
}

/**
 * Unified lookup: try every connected distributor, fall back to the local catalog. Always
 * returns { source, products[] } so the UI never sees a blank screen.
 */
export async function lookupLive(style, settings, { timeoutMs = 8000, limit = 40 } = {}) {
  const st = supplierStatus(settings)
  const errors = []
  if (st.ss) {
    try { const r = await lookupSS(style, settings, { timeoutMs }); if (r?.length) return { source: 'S&S Activewear', live: true, products: limit > 0 ? r.slice(0, limit) : r } }
    catch (e) { errors.push(`S&S: ${e.message}`) }
  }
  if (st.sanmar) {
    try { const r = await lookupSanMar(style, settings, { timeoutMs }); if (r?.length) return { source: 'SanMar', live: true, products: limit > 0 ? r.slice(0, limit) : r } }
    catch (e) { errors.push(`SanMar: ${e.message}`) }
  }
  if (st.alpha) {
    try { const r = await lookupAlpha(style, settings, { timeoutMs }); if (r?.length) return { source: 'AlphaBroder', live: true, products: limit > 0 ? r.slice(0, limit) : r } }
    catch (e) { errors.push(`AlphaBroder: ${e.message}`) }
  }
  const q = String(style || '').toLowerCase()
  const rows = all('SELECT * FROM garments WHERE lower(style) LIKE ? OR lower(name) LIKE ? OR lower(brand) LIKE ? OR lower(sku) LIKE ?',
    `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`)
  return { source: 'catalog', live: false, products: rows, errors: errors.length ? errors : undefined }
}

const PO_COLORS = ['black', 'white', 'navy', 'heather', 'charcoal', 'red', 'royal', 'forest', 'maroon', 'sand', 'gold', 'orange', 'green', 'blue', 'purple', 'pink', 'gray', 'grey', 'ash', 'natural', 'kelly', 'cardinal', 'brown', 'teal']
const colorFrom = (text) => { const t = String(text || '').toLowerCase(); return PO_COLORS.find((c) => new RegExp(`\\b${c}\\b`).test(t)) || '' }

/**
 * THE split-shipment safeguard. Verbatim from SanMar's spec: "Submitting multiple lines for the
 * same product can result in inventory being sourced from a warehouse with insufficient stock."
 * So before any PO leaves the building, collapse to exactly one line per (sku|style, color, size)
 * with the quantities summed. This function is the single place that guarantee lives — pure and
 * unit-testable so it can never silently regress.
 */
export function consolidatePoLines(lines) {
  const map = new Map()
  for (const l of lines || []) {
    const qty = Number(l.qty) || 0
    if (qty <= 0) continue
    const key = `${String(l.sku || l.style || '').toUpperCase()}|${String(l.color || '').toLowerCase()}|${String(l.size || '').toUpperCase()}`
    const cur = map.get(key)
    if (cur) cur.qty += qty
    else map.set(key, { sku: l.sku || null, style: l.style || '', color: l.color || '', size: l.size || '', qty, unit_cost: l.unit_cost ?? null })
  }
  return [...map.values()]
}

/**
 * Emit a supplier PO for a job's garments — consolidated by (style,color,size) so it can't
 * split-ship. When no account is connected we return the PO document for the shop to place manually.
 */
export function buildPurchaseOrder(job, sizes, garmentText, settings) {
  const match = costFor(garmentText)
  const color = colorFrom(garmentText)
  const style = (String(garmentText || '').split('—')[0].trim()) || match?.name || ''
  const raw = Object.entries(sizes || {}).filter(([, q]) => Number(q) > 0)
    .map(([size, qty]) => ({ sku: match?.sku || null, style, color, size, qty: Number(qty), unit_cost: match?.cost ?? null }))
  const lines = consolidatePoLines(raw) // one row per (sku,color,size); summed — never split-ships
  const total = lines.reduce((s, l) => s + l.qty * (l.unit_cost || 0), 0)
  const st = supplierStatus(settings)
  const warnings = []
  if (!match) warnings.push('No catalog SKU matched — set the exact style before submitting.')
  if (!color) warnings.push('No garment color detected — confirm the color on the order.')
  return {
    job: job.job_number, garment: garmentText, color: color || null,
    lines,
    total_units: lines.reduce((s, l) => s + l.qty, 0),
    est_cost: Math.round(total * 100) / 100,
    supplier: st.ss ? 'S&S Activewear' : st.sanmar ? 'SanMar' : st.alpha ? 'AlphaBroder' : null,
    status: st.connected ? 'ready-to-submit' : 'manual',
    warnings,
  }
}

/**
 * Submit a PO to the connected distributor. S&S Activewear has a real REST write path
 * (POST /v2/orders/); SanMar (SubmitPO) and AlphaBroder are PromoStandards SOAP and stay a
 * documented connect-time seam. `dryRun` validates + consolidates without sending, so the UI
 * can preview exactly what would be ordered. Never sends unconsolidated lines.
 */
/**
 * Has this purchase order already gone out to the distributor?
 *
 * Submitting places a REAL, chargeable order, so the resubmit guard has to ask this question and
 * not "is the status exactly 'submitted'?". That narrower test let two real double-orders through:
 *
 *   · status is only written AFTER the awaited submit, so two clicks a second apart both read
 *     'draft' and both sent. The guard could not stop the case it was written for.
 *   · receivePurchaseOrder overwrites status with 'partial' or 'received' — which is exactly when
 *     a manager hits Submit again to chase a short delivery, silently re-ordering the whole run.
 *
 * 'draft' and 'failed' are retryable: nothing reached the distributor. 'submitting' is the
 * synchronous claim taken before the await; it counts as sent, but only for a while — a row stuck
 * there means the process died mid-send, and a shop must never be left holding a PO it can neither
 * place nor clear.
 */
export function poAlreadySent(po, { now = Date.now(), staleMs = 5 * 60 * 1000 } = {}) {
  const status = String(po?.status || '')
  if (status === 'submitting') {
    const claimedAt = Date.parse(`${String(po.updated_at || '').replace(' ', 'T')}Z`)
    if (!Number.isFinite(claimedAt) || now - claimedAt > staleMs) return false // stale claim — let it go again
    return true
  }
  return ['submitted', 'placed_manually', 'partial', 'received', 'closed'].includes(status)
}

export async function submitPurchaseOrder(po, settings, { dryRun = false, poNumber } = {}) {
  const lines = consolidatePoLines(po.lines) // re-consolidate defensively — the guarantee, again
  if (!lines.length) throw new Error('Nothing to order')
  if (lines.some((l) => !l.sku)) throw new Error('Every line needs a distributor SKU — match the exact style first')
  const st = supplierStatus(settings)

  if (dryRun) return { ok: true, dry_run: true, supplier: po.supplier, lines, total_units: lines.reduce((s, l) => s + l.qty, 0) }

  if (st.ss) {
    const c = creds(settings).ss
    const auth = Buffer.from(`${c.account}:${c.key}`).toString('base64')
    const body = {
      // S&S order shape: one line per SKU with total qty — consolidation already guarantees that.
      poNumber: poNumber || po.job || `PSC-${Date.now()}`,
      shippingAddress: { customerNumber: c.account },
      lines: lines.map((l) => ({ identifier: l.sku, qty: l.qty })),
    }
    // SS_BASE, not a hardcoded host: every read path in this file already honours
    // SSACTIVEWEAR_API_BASE, so a self-hoster pointing it at a sandbox to rehearse the flow got
    // sandbox reads — and a real, chargeable order on submit. The one call that spends money was
    // the one call that ignored the setting.
    //
    // And a timeout, for the same reason the reads have one. Node's fetch has no default, so a
    // stalled connection left POST /api/jobs/:id/po/submit hanging forever. The manager reloads,
    // clicks Submit again, and if the first request had already landed at S&S that is two
    // shipments of the same blanks, billed.
    const res = await fetch(`${SS_BASE}/orders/`, {
      method: 'POST',
      signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data?.message || data?.error || `S&S order failed (${res.status})`)
    return { ok: true, supplier: 'S&S Activewear', order_id: data.orderNumber || data.orderId || data.id || null, lines, raw: data }
  }

  // SanMar SubmitPO / AlphaBroder are SOAP — surface a clear, honest state rather than a fake success.
  if (st.sanmar || st.alpha) {
    return { ok: false, pending: true, supplier: st.sanmar ? 'SanMar' : 'AlphaBroder', lines,
      note: `${st.sanmar ? 'SanMar' : 'AlphaBroder'} uses a PromoStandards SOAP submit that is provisioned per account. The consolidated PO is ready — place it in the distributor portal, or finish the SOAP hookup with your customer number.` }
  }
  throw new Error('No distributor connected — add an account in Settings, or download the PO to place manually.')
}

/* ==========================================================================================
 * blankCost — the one function quoting calls.
 *
 * Order: fresh cache → live distributor → seeded catalog → the shop's default. Every layer
 * returns the SAME shape with a `source`, so an estimate can always say where its cost came
 * from instead of presenting a guess as a fact.
 *
 * Two design constraints drove this:
 *  1. A quote must not wait on a distributor. The live call is capped hard, and any timeout or
 *     error falls through to the catalog rather than failing the estimate.
 *  2. A 200-piece order must not make 200 API calls. Results are cached per style for 12 hours,
 *     which also means the second quote of the day for a house blank is instant.
 * ========================================================================================== */

const BLANK_TTL_MS = 12 * 60 * 60 * 1000

function cacheKey(text) { return normText(text).slice(0, 120) }

function cacheRead(key) {
  const row = get('SELECT payload, updated_at FROM blank_cache WHERE key = ?', key)
  if (!row) return null
  const age = Date.now() - new Date(row.updated_at + 'Z').getTime()
  if (!(age >= 0) || age > BLANK_TTL_MS) return null
  try { return JSON.parse(row.payload) } catch { return null }
}

function cacheWrite(key, rows) {
  run(`INSERT INTO blank_cache (key, payload, updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
    key, JSON.stringify(rows), now())
}

/** Pick the SKU matching the wanted colour/size, else the cheapest base-size row. */
export function pickSku(rows, { color, size } = {}) {
  if (!rows?.length) return null
  const wantC = normText(color), wantS = normText(size)
  const priced = rows.filter((r) => Number(r.cost) > 0)
  if (!priced.length) return null
  let pool = priced
  if (wantC) { const m = pool.filter((r) => normText(r.color) === wantC); if (m.length) pool = m
    else { const p = pool.filter((r) => normText(r.color).includes(wantC)); if (p.length) pool = p } }
  if (wantS) { const m = pool.filter((r) => normText(r.size) === wantS); if (m.length) return m[0] }
  // No size asked for: quote the base size, which is the cheapest — never an accidental 4XL.
  return pool.slice().sort((a, b) => a.cost - b.cost)[0]
}

/** Per-size costs for one style, so size upcharges come from the distributor, not a setting. */
export function sizeCosts(rows, { color } = {}) {
  const out = {}
  const wantC = normText(color)
  for (const r of rows || []) {
    if (!(Number(r.cost) > 0) || !r.size) continue
    if (wantC && normText(r.color) !== wantC) continue
    const k = String(r.size).toUpperCase()
    if (out[k] == null || r.cost < out[k]) out[k] = r.cost
  }
  return out
}

/**
 * Resolve a blank cost for free text like "200 Gildan 5000 in Black".
 * Never throws — a supplier outage degrades the source, not the quote.
 */
export async function blankCost(garmentText, settings, { color = '', size = '', timeoutMs = 6000, allowLive = true } = {}) {
  const fallback = Number(settings?.default_garment_cost) > 0 ? Number(settings.default_garment_cost) : 3.2
  const key = cacheKey(garmentText)
  const parsed = parseGarmentText(garmentText)
  let rows = null, source = null, live = false, error = null

  if (key) {
    const cached = cacheRead(key)
    if (cached?.rows?.length) { rows = cached.rows; source = cached.source; live = true }
  }

  if (!rows && allowLive && key && supplierStatus(settings).connected) {
    try {
      const r = await lookupLive(garmentText, settings, { timeoutMs, limit: 0 })
      if (r?.live && r.products?.length) {
        rows = r.products; source = r.source; live = true
        cacheWrite(key, { source: r.source, rows })
      }
    } catch (e) { error = e.message }
  }

  if (rows?.length) {
    const hit = pickSku(rows, { color, size })
    if (hit) {
      return { cost: Number(hit.cost), source, live: true, sku: hit.sku, stock: hit.stock,
        name: [hit.brand, hit.style].filter(Boolean).join(' ') || hit.name, color: hit.color, size: hit.size,
        image: hit.image || null, sizeCosts: sizeCosts(rows, { color }), matched: true, error }
    }
  }

  const cat = costFor(garmentText)
  if (cat) return { cost: cat.cost, source: 'catalog', live: false, sku: cat.sku, name: cat.name, matched: true, error }

  return { cost: fallback, source: 'default', live: false, sku: null,
    name: [parsed.brand, parsed.style].filter(Boolean).join(' ') || null, matched: false, error }
}

/** Human line for an estimate: "Gildan 5000 · $3.42 live from S&S Activewear · 1,035 in stock". */
export function blankCostLabel(b) {
  if (!b) return ''
  const bits = [b.name || 'Blank', `$${Number(b.cost).toFixed(2)}`]
  if (b.live) bits.push(`live from ${b.source}`)
  else if (b.source === 'catalog') bits.push('catalog cost')
  else bits.push('your default — connect a supplier for live cost')
  if (b.stock > 0) bits.push(`${b.stock.toLocaleString()} in stock`)
  return bits.join(' · ')
}


/* ==========================================================================================
 * PO persistence + receiving. A built PO (from buildPurchaseOrder) becomes a real record with
 * lines; goods are received per size cell; shortages fall out of ordered − received.
 * ========================================================================================== */

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100

/** Persist a built PO (and its consolidated lines) as one atomic record. Returns the stored PO. */
export function createPurchaseOrder(job, po, { status } = {}) {
  return tx(() => {
    const poId = Number(run(
      `INSERT INTO purchase_orders (job_id, po_number, supplier, status, total_units, est_cost, notes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      job?.id ?? null, po.po_number || `PO-${job?.job_number || 'X'}`, po.supplier || null,
      status || po.status || 'draft', po.total_units || 0, r2(po.est_cost), '', now(), now()).lastInsertRowid)
    for (const l of po.lines || []) {
      run(`INSERT INTO po_lines (po_id, sku, style, color, size, qty_ordered, qty_received, unit_cost)
           VALUES (?,?,?,?,?,?,?,?)`,
        poId, l.sku || null, l.style || null, l.color || null, l.size || null,
        Number(l.qty) || 0, 0, l.unit_cost ?? null)
    }
    return getPurchaseOrder(poId)
  })
}

/** One PO with its lines and per-line shortage, plus a rolled-up receiving state. */
export function getPurchaseOrder(poId) {
  const po = get('SELECT * FROM purchase_orders WHERE id = ?', poId)
  if (!po) return null
  const lines = all('SELECT * FROM po_lines WHERE po_id = ? ORDER BY id', poId).map((l) => ({
    ...l, short: Math.max(0, (l.qty_ordered || 0) - (l.qty_received || 0)),
  }))
  const ordered = lines.reduce((a, l) => a + (l.qty_ordered || 0), 0)
  const received = lines.reduce((a, l) => a + (l.qty_received || 0), 0)
  return { ...po, lines, ordered, received, short: Math.max(0, ordered - received),
    fully_received: ordered > 0 && received >= ordered }
}

/** All POs for a job (newest first), each rolled up. */
export function purchaseOrdersForJob(jobId) {
  return all('SELECT id FROM purchase_orders WHERE job_id = ? ORDER BY id DESC', jobId)
    .map((r) => getPurchaseOrder(r.id))
}

/**
 * Receive quantities against a PO. `receipts` is [{ line_id, qty }]. Clamps each line so received
 * never exceeds ordered (a mis-scan can't create negative shortage), recomputes PO status
 * (draft/submitted → partial → received), and returns the updated PO.
 */
export function receivePurchaseOrder(poId, receipts, { by } = {}) {
  const po = get('SELECT * FROM purchase_orders WHERE id = ?', poId)
  if (!po) return null
  tx(() => {
    for (const r of receipts || []) {
      const line = get('SELECT * FROM po_lines WHERE id = ? AND po_id = ?', Number(r.line_id), poId)
      if (!line) continue
      const add = Number(r.qty) || 0
      if (!add) continue
      const capped = Math.max(0, Math.min((line.qty_ordered || 0), (line.qty_received || 0) + add))
      run('UPDATE po_lines SET qty_received = ? WHERE id = ?', capped, line.id)
    }
    const rolled = getPurchaseOrder(poId)
    const status = rolled.fully_received ? 'received' : rolled.received > 0 ? 'partial' : po.status
    run('UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ?', status, now(), poId)
  })
  return getPurchaseOrder(poId)
}
