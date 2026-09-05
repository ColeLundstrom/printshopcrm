/**
 * Shared pricing/size logic — imported by BOTH the browser (as a module URL) and
 * server.mjs (as a file path). One source of truth: the total a customer sees in the
 * editor is computed by the same code that writes the invoice.
 */

// 6XL and the tall run are not exotic — workwear and corporate accounts order them every day, and
// until they were listed here the app had no way to hold them: the estimate deleted them, the v1
// API refused them, and the pick ticket printed a total that counted sizes it had not printed a row
// for. COMMON_SIZES still decides what the editor shows by default, so the long tail stays out of
// the way; these only become reachable through "Add size", an import, or the API.
// YXL sits with the youth sizes and not at the end. It was missing, and sizeKeys puts anything it
// does not recognise after everything it does — so a youth run of YS/YM/YL/YXL printed its biggest
// youth size LAST, beneath adult 4XL, on the pick ticket, the packing slip and the estimate. A
// picker reading top to bottom pulls it out of the adult rack.
export const SIZES = ['YXS', 'YS', 'YM', 'YL', 'YXL', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL', 'LT', 'XLT', '2XLT', '3XLT', '4XLT', 'OSFA']

/**
 * What a size grid key may look like. Digits then letters, nothing else — '6XL', 'LT', '2XLT',
 * 'OSFA' pass; anything carrying a quote, a bracket or an event handler does not.
 *
 * The rule this replaces was `SIZES.includes(k)`, and it was load-bearing for more than tidiness:
 * these keys are rendered through innerHTML on the estimate editor, the PDF, the public estimate
 * page and the pay page, so an unconstrained key is staff -> owner stored XSS. Widening the
 * vocabulary must not widen the character set, and this does not.
 */
export const SIZE_KEY = /^[0-9]{0,2}[A-Z]{1,4}$/

/**
 * Every size present on a grid: the ones we know, in canonical order, then anything else the shop
 * has legitimately stored.
 *
 * Callers used to write `SIZES.filter((s) => sizes[s] > 0)`, which ORDERS by SIZES and SILENTLY
 * DROPS anything outside it — while the totals printed beside those rows kept counting the dropped
 * pieces. One pick ticket listed rows summing to 70 under its own "SUBTOTAL 80", against a job of
 * 105. Order by SIZES; never filter by it.

/** Sizes a shop shows by default — the long tail stays available but out of the way. */
export const COMMON_SIZES = ['S', 'M', 'L', 'XL', '2XL', '3XL']

/** Standard extended-size upcharges. Shops charge more for big garments; this is per-piece. */
export const DEFAULT_UPCHARGES = { '2XL': 2, '3XL': 3, '4XL': 4, '5XL': 5 }

// The fallback existed because the `n + 'e2'` string trick returns NaN for very large or very
// small magnitudes — but `Math.round(Infinity * 100) / 100` is Infinity, so this money helper
// happily handed Infinity back to its callers. One opportunity created with value "1e400" put Inf
// in the column, and SUM() over it then blanked the WHOLE shop's Open Pipeline and Weighted KPIs —
// not just that card. A money helper must only ever return a finite number.
export const round2 = (n) => {
  n = Number(n) || 0
  const v = Number(Math.round(n + 'e2') + 'e-2')
  if (Number.isFinite(v)) return v
  const w = Math.round(n * 100) / 100
  return Number.isFinite(w) ? w : 0
}

export const upchargeFor = (size, upcharges) => Number((upcharges || DEFAULT_UPCHARGES)[size]) || 0

/**
 * The upcharge table a LINE was priced with.
 *
 * Line amounts are not stored — every renderer recomputes them — while the document's
 * subtotal/tax/total ARE stored, frozen at write time. So a shop raising its extended-size
 * upcharges, an ordinary documented setting, retroactively re-priced the LINES of every estimate
 * and invoice it had ever issued while their totals stayed put. Reproduced on a live instance: one
 * PUT /api/settings took an issued invoice's printed line from $1,006.00 to $1,032.00, sitting
 * above a printed Subtotal of $1,006.00 — $26.00 arriving from nowhere on a document the customer
 * was already holding, with the shop still only entitled to collect the stored figure.
 *
 * A document that has been written carries the table it was written with. Lines from before this
 * existed have no snapshot and fall back to the shop's live table, which is exactly the old
 * behaviour — nothing re-prices on upgrade.
 */
export const lineUpcharges = (item, upcharges) => (
  item && item.size_upcharges && typeof item.size_upcharges === 'object' && !Array.isArray(item.size_upcharges)
    ? item.size_upcharges : upcharges
)

/** Total pieces across the size grid. */
export function sizeTotal(sizes) {
  if (!sizes) return 0
  return Object.values(sizes).reduce((s, n) => s + (Number(n) || 0), 0)
}

export const sizeKeys = (sizes) => [
  ...SIZES.filter((s) => Number(sizes?.[s]) > 0),
  ...Object.keys(sizes || {}).filter((s) => !SIZES.includes(s) && Number(sizes[s]) > 0),
]

/** "40 S / 90 M / 110 L / 60 XL" — in size order, skipping zeros, dropping nothing. */
export function sizeSummary(sizes) {
  if (!sizes) return ''
  return sizeKeys(sizes).map((s) => `${sizes[s]} ${s}`).join(' / ')
}

/** Pieces per size, merged across every line of an order — what the press/packing table needs. */
export function rollupSizes(items) {
  const out = {}
  for (const it of items || []) {
    for (const [s, n] of Object.entries(it.sizes || {})) {
      if (Number(n) > 0) out[s] = (out[s] || 0) + Number(n)
    }
  }
  return out
}

/**
 * The sized lines of an order, one entry per garment, with their grids kept APART.
 *
 * rollupSizes() above answers "how many pieces in total" and is right for capacity and piece
 * counts. It is the wrong answer for anything that has to BUY or PICK the blanks: merging
 * tees {S20,M40,L30,XL10} with hoodies {M10,L20,XL20} into one {S20,M50,L50,XL30} loses which
 * style each piece belongs to, so the purchase order bought 150 tees and zero hoodies.
 * `garment` is the description up to the em-dash, which is where the style number lives
 * ("Gildan 18500 Heavy Blend Hoodie — Black — 2/0 Front").
 */
export function garmentLines(items) {
  return (items || [])
    .filter((i) => i && i.sizes && sizeTotal(i.sizes) > 0)
    .map((i) => ({
      description: String(i.description || ''),
      garment: String(i.description || '').split('—')[0].trim(),
      sizes: i.sizes,
    }))
}

/**
 * A line's quantity. Size-gridded lines derive it (so qty can never disagree with the
 * grid); flat lines like setup fees or artwork keep their own qty.
 */
/**
 * Pieces are never negative. The size-grid path already ignores qty <= 0; flat lines used to
 * accept -50 and produce a negative subtotal (and a negative invoice total) from one typo.
 * Discounts stay expressible — they belong in unit_price as a signed credit line, not in qty.
 */
const posQty = (n) => Math.max(0, Number(n) || 0)

export function lineQty(item) {
  // `quantity` is accepted as an alias for `qty` — an API caller using the natural name must
  // never get a silent $0 line on a customer-facing document.
  return item?.sizes && sizeTotal(item.sizes) > 0 ? sizeTotal(item.sizes) : posQty(item?.qty ?? item?.quantity)
}

/**
 * A line's extended amount, including per-size upcharges.
 * Base rate applies to every piece; 2XL+ add their upcharge on top.
 */
export function lineAmount(item, upcharges) {
  const price = Number(item?.unit_price) || 0
  if (item?.sizes && sizeTotal(item.sizes) > 0) {
    const up = lineUpcharges(item, upcharges)
    let total = 0
    for (const [s, n] of Object.entries(item.sizes)) {
      const qty = Number(n) || 0
      if (qty > 0) total += qty * (price + upchargeFor(s, up))
    }
    return round2(total)
  }
  return round2(posQty(item?.qty ?? item?.quantity) * price)
}

/** Sum of upcharges on a line — surfaced so the customer sees why the math isn't qty × rate. */
export function lineUpcharge(item, upcharges) {
  if (!item?.sizes) return 0
  const up = lineUpcharges(item, upcharges)
  let total = 0
  for (const [s, n] of Object.entries(item.sizes)) total += (Number(n) || 0) * upchargeFor(s, up)
  return round2(total)
}

/**
 * Document totals. `taxable === false` on a line exempts it (setup fees, labor in many states).
 *
 * The taxable base is floored at zero. A discount is an ordinary line with a negative amount, and
 * a non-taxable setup / digitizing / booth / rush line beside a negotiated discount is an ordinary
 * print-shop order — so the taxable subset alone could go negative while the document total stayed
 * healthily positive. $500 non-taxable digitizing + $240 of taxable caps − a $300 discount at
 * 8.25% produced {subtotal: 440, tax: -4.95, total: 435.05}: a document naming a POSITIVE tax rate
 * and a NEGATIVE tax amount. The two guards that exist for this — representableTotals and
 * nonNegativeTotals — both passed, because both look at the subtotal and the total, and the
 * authors closed a negative subtotal and a negative total and left the base between them open.
 *
 * It reached the customer: pdf.mjs was deliberately taught to PRINT a negative tax line rather
 * than hide one, so "Tax (8.25%) -$4.95" went onto the PDF, /p/estimate and the pay page, and
 * QuickBooks got a -$4.95 "Sales tax" line. The shop is short by the amount and its remittance
 * for the period is wrong.
 *
 * Whether a discount should instead be ALLOCATED pro-rata across taxable and non-taxable lines is
 * a jurisdictional question and is NOT decided here. Flooring at zero is correct everywhere: no
 * invoice may charge negative tax.
 */
export function computeTotals(items, taxRate, upcharges) {
  const subtotal = round2((items || []).reduce((s, i) => s + lineAmount(i, upcharges), 0))
  const taxable = Math.max(0, round2((items || []).reduce((s, i) => (i.taxable === false ? s : s + lineAmount(i, upcharges)), 0)))
  const tax = round2(taxable * (Number(taxRate) || 0) / 100)
  return { subtotal, tax, total: round2(subtotal + tax) }
}

/* ---------- quoting ---------- */

/**
 * Rush multipliers, from published shop cards (Raygun, US Colorworks): the surcharge is
 * tiered by how many days you get, not a flat bump. Absorbing a 1-day rush gives away
 * roughly the entire print margin.
 */
export const RUSH_TIERS = [
  { days: 0, label: 'Standard (10+ days)', mult: 1.0 },
  { days: 7, label: '7 day', mult: 1.25 },
  { days: 4, label: '4 day', mult: 1.35 },
  { days: 3, label: '3 day', mult: 1.5 },
  { days: 2, label: '2 day', mult: 1.75 },
  { days: 1, label: 'Next day', mult: 2.0 },
]

/**
 * Screen-print quoting the way shops actually price: garment cost marked up, plus an
 * imprint charge driven by piece count and colors-per-location, plus one-time screen fees.
 *
 * `darkGarment` adds an underbase to every location — a 1-color print on black is not a
 * 1-color job, and forgetting that is a documented way shops eat the difference.
 */
export function quoteScreenPrint({ garmentCost = 0, markup = 2.0, qty = 0, locations = [], screenFee = 25, rushMult = 1, darkGarment = false }) {
  const garment = round2(garmentCost * markup)
  const inkColors = (l) => (Number(l.colors) || 0) + (darkGarment ? 1 : 0) // underbase counts as a color
  const totalColors = locations.reduce((s, l) => s + inkColors(l), 0)
  const imprintPerPiece = round2(locations.reduce((s, l) => s + imprintRate(qty, inkColors(l)), 0))
  const base = round2(garment + imprintPerPiece)
  const mult = Number(rushMult) || 1
  const perPiece = round2(base * mult)
  const screens = round2(totalColors * screenFee)
  return {
    perPiece, garment, imprintPerPiece, screens, totalColors,
    underbase: !!darkGarment,
    subtotal: round2(perPiece * qty + screens),
    rushMult: mult,
    rushApplied: mult > 1,
  }
}

/**
 * Markup and margin are not the same number, and conflating them is why shops think they
 * make 50% and actually make 33%. Both are returned so the UI can show both.
 */
export function markupVsMargin(cost, price) {
  const c = Number(cost) || 0
  const p = Number(price) || 0
  return {
    markupPct: c > 0 ? Math.round(((p - c) / c) * 1000) / 10 : 0,
    marginPct: p > 0 ? Math.round(((p - c) / p) * 1000) / 10 : 0,
  }
}

/**
 * Value per hour = revenue ÷ productive hours. The metric that shows order size, not unit
 * price, is the real lever: 10 small orders can bill $480/hr while one big discounted run
 * bills $3,000/hr for the same hours.
 */
export function valuePerHour(revenue, minutes) {
  const h = (Number(minutes) || 0) / 60
  return h > 0 ? Math.round((Number(revenue) || 0) / h) : 0
}

/**
 * Imprint price per piece. Calibrated against published 2025 market sheets rather than
 * invented: US Colorworks contract (1-color: $2.20 @24, $1.41 @72, $0.93 @500) sets the
 * floor, and QRSTs retail (1-color white: $12.75 @24 → $9.65 @300 all-in) sets the ceiling
 * once a ~$3 blank and markup are backed out. These land between the two.
 */
export function imprintRate(qty, colors) {
  if (!colors) return 0
  const q = Number(qty) || 0
  const tier = q >= 500 ? 0 : q >= 250 ? 1 : q >= 144 ? 2 : q >= 72 ? 3 : q >= 48 ? 4 : q >= 24 ? 5 : 6
  //            500+   250+   144+   72+    48+    24+    1+
  const first = [1.05, 1.25, 1.45, 1.75, 2.15, 2.60, 3.75][tier]
  const extra = [0.28, 0.34, 0.42, 0.50, 0.62, 0.75, 0.95][tier]
  return round2(first + Math.max(0, colors - 1) * extra)
}

/** Price breaks to show next to a quote — "at 100 you'd pay X" is the best upsell in the shop. */
export function priceBreaks(input, tiers = [24, 48, 72, 144, 288, 500]) {
  return tiers.map((qty) => ({ qty, ...quoteScreenPrint({ ...input, qty }) }))
}

/* ---------- job costing ---------- */

/**
 * Real press times from Screen Printing Magazine's estimating tables, indexed by color
 * count (1–6). Setup is minutes for the whole job; run is minutes per garment.
 * This is why small runs lose money: a 6-color manual job burns 72 minutes before
 * shirt one, while each shirt only takes 0.86 min to print.
 */
export const PRESS_TIME = {
  manual: { setup: [12, 24, 36, 48, 60, 72], run: [0.50, 0.55, 0.60, 0.67, 0.75, 0.86] },
  auto: { setup: [12, 25, 40, 54, 70, 87], run: [0.15, 0.15, 0.15, 0.15, 0.15, 0.15] },
}

/**
 * How many screens a job's press time is costed against — the SUM across its print locations,
 * clamped the way lib/capacity.mjs clamps it.
 *
 * There were two answers to this in the product. lib/capacity.mjs's colorsFromItems sums across
 * locations, and the scheduler and the Profitability sweep both use it — that is the definition an
 * earlier round settled on. The Price Calculator, the third reader, was never brought along: it
 * took `Math.max(...locations)`, so a front-and-back job booked press time for the heavier print
 * only.
 *
 * Measured on a 300-piece 4/0 front + 2/0 back job: the calculator said the shop's cost was
 * $1,439.70 at 55.4% margin while Profitability said $1,577.20 at 51.1% — $137.50 apart, on the
 * screen where the shop decides what to charge. The PRICE is unaffected either way, because
 * quoteScreenPrint already sums the per-location imprint rates; it is the margin the shop is shown
 * while it picks a number that was wrong.
 *
 * A dark garment adds an underbase, which is a real screen on the press, so it counts per location.
 */
export const pressColors = (locations, darkGarment = false) => {
  const locs = Array.isArray(locations) && locations.length ? locations : [{ colors: 1 }]
  const n = locs.reduce((sum, l) => sum + (Number(l?.colors) || 1) + (darkGarment ? 1 : 0), 0)
  return Math.min(12, Math.max(1, n))
}

export const pressMinutes = (qty, colors, press = 'auto') => {
  const t = PRESS_TIME[press] || PRESS_TIME.auto
  const c = Math.max(1, Number(colors) || 1)
  const q = Number(qty) || 0
  if (c <= 6) { const i = c - 1; return round2(t.setup[i] + q * t.run[i]) }
  // 7–12 color jobs are real (esp. sim-process). Extrapolate past the 6-color table using the
  // last per-color step, instead of clamping to 6 (which underbooked press time and inflated margin).
  const setup = t.setup[5] + (t.setup[5] - t.setup[4]) * (c - 6)
  const run = t.run[5] + Math.max(0, t.run[5] - t.run[4]) * (c - 6)
  return round2(setup + q * run)
}

/**
 * What a job actually costs the shop.
 *
 * The load-bearing input is `utilization`. Presses only print 24–33% of the clock —
 * the rest is setup, breaks, approvals, packing. Costing at the raw hourly rate is the
 * classic way a shop "makes" 40% on paper and loses money in reality, so the effective
 * labor rate here is shopRate / utilization.
 */
export function jobCost({ qty = 0, colors = 1, garmentCost = 0, press = 'auto', shopRate = 75, utilization = 0.3, spoilage = 2, screenCost = 8, screens = 0 }) {
  const pieces = Number(qty) || 0
  const spoil = 1 + (Number(spoilage) || 0) / 100
  const garment = round2(pieces * garmentCost * spoil)
  const minutes = pressMinutes(pieces, colors, press)
  const effectiveRate = (Number(shopRate) || 0) / Math.max(0.05, Number(utilization) || 0.3)
  const labor = round2((minutes / 60) * effectiveRate)
  const screenMats = round2((screens || colors) * screenCost)
  const total = round2(garment + labor + screenMats)
  return { garment, labor, screenMats, minutes, effectiveRate: round2(effectiveRate), total, perPiece: pieces ? round2(total / pieces) : 0 }
}

/** Margin on a quote. `profit` is dollars kept; `margin` is the percentage owners quote at each other. */
export function margin(revenue, cost) {
  const r = Number(revenue) || 0
  const c = Number(cost) || 0
  const profit = round2(r - c)
  return { revenue: round2(r), cost: round2(c), profit, margin: r > 0 ? Math.round((profit / r) * 1000) / 10 : 0 }
}

/**
 * Decoration cost/price multipliers relative to a screen-print base — embroidery is stitch-heavy,
 * DTF/vinyl carry material, etc. Keeps the matrix honest across decoration types.
 */
export const DECO_MULT = { 'Screen Print': 1, 'DTF Transfer': 1.1, 'UV DTF': 1.15, Embroidery: 1.45, Vinyl: 1.2, Patch: 1.3, Laser: 1.25 }

/**
 * The pricing matrix — the "Print Life killer" feature. From the shop's own costing inputs
 * (garment cost, markup, screen fee, hourly rate, and the load-bearing utilization %), it
 * generates the full qty × color-count price grid AND the real margin of every cell, then
 * flags any cell that falls below the shop's target-margin FLOOR. This is what turns a pricing
 * spreadsheet into a guardrail: the shop can see, at a glance, exactly which small runs lose
 * money before a customer ever asks.
 */
export function pricingMatrix({
  garmentCost = 4, markup = 2, screenFee = 25, shopRate = 75, utilization = 0.3, spoilage = 2,
  press = 'auto', targetMargin = 45, decoration = 'Screen Print', decoMult = null,
  qtys = [12, 24, 48, 72, 144, 288, 500], colorCounts = [1, 2, 3, 4, 5, 6],
} = {}) {
  // decoMult lets a shop override the per-service multiplier with its own rule; fall back to the
  // shared default so existing callers (and unset services) are unchanged.
  const decoAdj = Number((decoMult && decoMult[decoration])) || DECO_MULT[decoration] || 1
  const rows = qtys.map((qty) => ({
    qty,
    cells: colorCounts.map((colors) => {
      const q = quoteScreenPrint({ garmentCost, markup, qty, locations: [{ name: 'Front', colors }], screenFee })
      const perPiece = round2(q.perPiece * decoAdj)
      // Full symmetric basis: the shop bills the screen setup as a separate line (q.screens = colors ×
      // screenFee), so revenue must include it AND cost must include the screen material + the setup
      // labor already in pressMinutes. Excluding only one side skewed the margin badly — counting
      // setup labor but not setup revenue read 12pc/3c as -51%; the honest number is ~-3.5%.
      const revenue = round2(perPiece * qty + q.screens)
      const cost = jobCost({ qty, colors, garmentCost, press, shopRate, utilization, spoilage, screens: colors })
      const m = margin(revenue, cost.total)
      return {
        colors, perPiece, revenue, cost: cost.total, margin: m.margin,
        verdict: marginVerdict(m.margin).level, label: marginVerdict(m.margin).label,
        belowFloor: m.margin < targetMargin,
      }
    }),
  }))
  return { qtys, colorCounts, rows, targetMargin, decoration }
}

/** Rough blank cost from a line's text — lets the estimate editor show a live margin without a
 *  round-trip. The server's catalog is authoritative; this is a fast, good-enough client guess. */
const GARMENT_COSTS = [
  [/gildan\s*18500|18500|heavy blend hood/i, 16.50], [/gildan\s*5000|g500\b|heavy cotton/i, 3.20],
  [/comfort colors|1717/i, 6.50], [/bella.*3001cvc|3001cvc/i, 5.20], [/bella.*3001|\b3001\b/i, 4.10],
  [/next level|6210|6010/i, 5.25], [/independent|hoodie|hood\b/i, 18.00], [/champion/i, 12.00],
  [/richardson|trucker|yupoong|flexfit|\bcap\b|\bhat\b/i, 7.50], [/polo/i, 14.00], [/apron/i, 11.00],
  [/tank/i, 5.60], [/crew|sweat/i, 13.00], [/tote|bag/i, 3.00], [/port|sport-?tek|district/i, 6.00],
  [/tee|t-?shirt|shirt/i, 3.60],
]
export function guessGarmentCost(text) { const t = String(text || ''); for (const [re, c] of GARMENT_COSTS) if (re.test(t)) return c; return 0 }

/**
 * The blank cost for one estimate line: prefer what the line KNOWS over what its text suggests.
 *
 * The Price Calculator stamps `garment_cost` on every line it hands to the estimate editor, and
 * lib/quickquote.mjs stamps `blank_cost` — often a live distributor price, which is the entire
 * point of having looked it up. Guessing from the description throws both away, and the
 * descriptions the calculator writes ("Garment — 2/0 Front", "DTF Transfer — 12×16″ print") match
 * nothing in GARMENT_COSTS, so the guess returned 0 and the blank was costed free.
 *
 * Only when the line carries no price of its own is its text worth reading. lib/roi.mjs has always
 * applied this rule; it lives here so the editor and the ROI page cannot drift apart again.
 */
export function lineBlankCost(it) {
  if(it?.matrix?.customerSupplied===true)return 0
  const stamped = Number(it?.garment_cost) > 0 ? Number(it.garment_cost)
    : Number(it?.blank_cost) > 0 ? Number(it.blank_cost)
    : 0
  return stamped > 0 ? stamped : guessGarmentCost(it?.description)
}
export function guessColors(text) {
  const t = String(text || '')
  const m = t.match(/(\d+)\s*(?:\/\s*\d+\s*)?colou?rs?/i) || t.match(/\b(\d)\s*\/\s*\d\b/)
  return Math.min(8, Math.max(1, Number(m && m[1]) || 1))
}

/** Industry read on a margin number: <25% is the danger zone, 45%+ is a good retail job. */
export function marginVerdict(pct) {
  if (pct < 0) return { level: 'bad', label: 'LOSING MONEY' }
  if (pct < 25) return { level: 'bad', label: 'Too thin' }
  if (pct < 40) return { level: 'warn', label: 'Tight' }
  if (pct < 55) return { level: 'good', label: 'Healthy' }
  return { level: 'good', label: 'Strong' }
}

/* ---------- embroidery + DTF price charts ---------- */

/**
 * Volume discount curve shared by the embroidery and DTF charts. A shop's decoration price per piece
 * drops as the run grows because the setup (hooping, weeding, sheet layout) amortizes — the blank and
 * the pressing do not. Expressed as a multiplier on the DECORATION portion only, so the garment cost
 * is never discounted away.
 *
 * Numbers follow published contract-decorator break cards: roughly full price under a dozen, ~15% off
 * by two dozen, ~30% by six dozen, ~40% at a gross and beyond.
 */
export const QTY_BREAKS = [
  { min: 1, factor: 1.00 },
  { min: 12, factor: 0.92 },
  { min: 24, factor: 0.85 },
  { min: 48, factor: 0.78 },
  { min: 72, factor: 0.70 },
  { min: 144, factor: 0.62 },
  { min: 288, factor: 0.58 },
]
export const qtyBreakFactor = (qty, breaks = QTY_BREAKS) =>
  [...breaks].reverse().find((b) => Number(qty) >= b.min)?.factor ?? 1

/**
 * Embroidery is sold by STITCH COUNT, not colors — thread is cheap, machine time is not. The trade
 * prices per 1,000 stitches per piece with a per-piece minimum, plus a one-time digitizing fee to
 * turn the artwork into a stitch file.
 *
 * Rows are quantity breaks, columns are stitch counts, exactly how a shop's price card reads.
 */
export function embroideryMatrix({
  garmentCost = 4, markup = 2, ratePer1k = 1, minCharge = 5, digitizingFee = 25,
  qtys = [6, 12, 24, 48, 72, 144, 288], stitchCounts = [4000, 6000, 8000, 10000, 12000, 15000],
} = {}) {
  const blank = round2(garmentCost * markup)
  const rows = qtys.map((qty) => {
    const f = qtyBreakFactor(qty)
    return {
      qty, factor: f,
      cells: stitchCounts.map((stitches) => {
        const run = Math.max(minCharge, (stitches / 1000) * ratePer1k) * f
        const perPiece = round2(blank + run)
        return {
          stitches, perPiece, decoration: round2(run), blank,
          // What the customer actually pays all-in on this run, digitizing included.
          runTotal: round2(perPiece * qty + digitizingFee),
        }
      }),
    }
  })
  return {
    kind: 'embroidery', rows, qtys, stitchCounts,
    inputs: { garmentCost, markup, ratePer1k, minCharge, digitizingFee }, blank,
  }
}

/**
 * DTF is sold by the SQUARE INCH of printed film, plus a per-piece pressing charge for the labor of
 * actually applying it. Rows are quantity breaks, columns are common print sizes in square inches.
 */
export function dtfMatrix({
  garmentCost = 4, markup = 2, pricePerSqIn = 0.035, pressFee = 1.25, minCharge = 1.5,
  qtys = [6, 12, 24, 48, 72, 144, 288],
  sizes = [
    { label: '4" × 4"', sqIn: 16 }, { label: '4" × 10"', sqIn: 40 }, { label: '8" × 10"', sqIn: 80 },
    { label: '10" × 12"', sqIn: 120 }, { label: '11" × 14"', sqIn: 154 }, { label: '12" × 16"', sqIn: 192 },
  ],
} = {}) {
  const blank = round2(garmentCost * markup)
  const rows = qtys.map((qty) => {
    const f = qtyBreakFactor(qty)
    return {
      qty, factor: f,
      cells: sizes.map((sz) => {
        // The film discounts with volume; pressing is per-piece labor and does not.
        const film = Math.max(minCharge, sz.sqIn * pricePerSqIn) * f
        const perPiece = round2(blank + film + pressFee)
        return { ...sz, perPiece, film: round2(film), press: round2(pressFee), blank, runTotal: round2(perPiece * qty) }
      }),
    }
  })
  return { kind: 'dtf', rows, qtys, sizes, inputs: { garmentCost, markup, pricePerSqIn, pressFee, minCharge }, blank }
}
