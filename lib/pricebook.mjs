/**
 * The price book — one place that answers "what does this job cost the customer?"
 *
 * Every decoration method bills on a different axis, and pricing them all as screen printing was
 * producing wrong quotes: an embroidery order came out with a "Screen setup — 2 screens" line on it,
 * which is not a thing that exists. Screens are a screen-printing concept; embroidery has a
 * digitizing fee, DTF has no per-design setup at all.
 *
 * SHAPE: every shop starts on the stock book below — real, defensible numbers, so a shop that
 * signed up a minute ago can quote. Every single number is then overridable per shop, and a shop can
 * add services the stock book has never heard of. Nothing here is a hard-coded price; the stock book
 * is a starting point, not a ceiling.
 */

/** How a service computes its per-piece imprint charge. */
export const AXIS = {
  COLORS: 'colors',   // screen print: price rises with ink colours
  STITCHES: 'stitches', // embroidery: price rises with stitch count
  AREA: 'area',       // DTF / UV DTF / vinyl: price rises with printed square inches
  FLAT: 'flat',       // patches, laser: a per-piece rate per placement
}

/**
 * The stock book. Rates are per-piece at the base quantity band and are scaled by qtyFactor().
 * `setup` describes the one-time charge a shop bills per design, in that trade's own language —
 * the label is customer-facing, so it has to be the words a print shop would actually write.
 */
export const STOCK_SERVICES = {
  'Screen Print': {
    axis: AXIS.COLORS, base: 2.10, perUnit: 0.85,
    setup: { label: 'Screen setup', fee: 25, per: 'color', note: 'One-time per colour, per design' },
    minPerPiece: 3.00,
  },
  Embroidery: {
    axis: AXIS.STITCHES, base: 4.25, perUnit: 1.00, unitSize: 1000,
    setup: { label: 'Digitizing', fee: 25, per: 'design', note: 'One-time per new design; re-orders skip it' },
    minPerPiece: 5.00,
  },
  'DTF Transfer': {
    axis: AXIS.AREA, base: 1.20, perUnit: 0.09,
    setup: { label: null, fee: 0, per: 'design', note: 'No setup fee — DTF prints on demand' },
    minPerPiece: 2.50, pressFee: 0.75,
  },
  'UV DTF': {
    axis: AXIS.AREA, base: 1.60, perUnit: 0.12,
    setup: { label: null, fee: 0, per: 'design', note: 'No setup fee' },
    minPerPiece: 3.00, pressFee: 0.75,
  },
  Vinyl: {
    axis: AXIS.AREA, base: 2.00, perUnit: 0.14,
    setup: { label: 'Cut file setup', fee: 15, per: 'design', note: 'One-time per design' },
    minPerPiece: 3.50,
  },
  Patch: {
    axis: AXIS.FLAT, base: 3.40, perUnit: 0,
    setup: { label: 'Patch mould', fee: 45, per: 'design', note: 'One-time per new patch design' },
    minPerPiece: 3.40,
  },
  Laser: {
    axis: AXIS.FLAT, base: 4.00, perUnit: 0,
    setup: { label: 'Laser file setup', fee: 20, per: 'design', note: 'One-time per design' },
    minPerPiece: 4.00,
  },
}

/** Quantity price breaks. Bigger runs amortise setup and press time, so the per-piece rate falls. */
export const QTY_BANDS = [
  { min: 1, factor: 1.85 }, { min: 12, factor: 1.40 }, { min: 24, factor: 1.15 },
  { min: 48, factor: 1.00 }, { min: 72, factor: 0.92 }, { min: 144, factor: 0.84 },
  { min: 288, factor: 0.76 }, { min: 500, factor: 0.70 },
]
/** The MINIMUM of the qty band a quantity falls in — the row key for an explicit price cell. */
export function bandMinFor(qty, bands = QTY_BANDS) {
  const n = Math.max(0, Number(qty) || 0)
  let min = bands[0]?.min ?? 1
  for (const b of [...bands].sort((a, b) => a.min - b.min)) { if (n >= b.min) min = b.min }
  return min
}

/** An explicit per-cell price the shop entered for (this qty band, this unit count), or null. */
export function matrixCell(service, qty, units, bands = QTY_BANDS) {
  const m = service && service.matrix
  if (!m) return null
  const key = `${bandMinFor(qty, bands)}|${Math.round(Number(units) || 0)}`
  const v = m[key]
  return (typeof v === 'number' && v > 0) ? v : null
}

export const bandFor = (qty, bands = QTY_BANDS) =>
  [...bands].sort((a, b) => a.min - b.min).reduce((f, b) => (Number(qty) >= b.min ? b.factor : f), bands[0].factor)

const num = (v, d) => (v === null || v === undefined || String(v).trim() === '' ? d : (Number(v) || 0))
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100

/**
 * The shop's effective book: stock, with the shop's own edits layered on top, plus any service it
 * invented. Stored in the `price_book` setting so it travels with the tenant's database.
 */
export function resolveBook(raw) {
  let saved = {}
  try { saved = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {}) } catch { saved = {} }
  const out = {}
  for (const [name, stock] of Object.entries(STOCK_SERVICES)) {
    const o = saved.services?.[name] || {}
    out[name] = {
      ...stock, ...o,
      setup: { ...stock.setup, ...(o.setup || {}) },
      custom: false,
      // A service the shop has overridden in ANY way is edited — including with an imported price
      // sheet, which writes `saved.matrices` and never touches `saved.services`. This read only the
      // services half, so a shop that had just overwritten its whole Screen Print grid with the
      // wrong CSV was shown a "stock" pill and offered no "Reset to stock" button, which is the one
      // control in the product that undoes an import. DELETE /api/pricebook/:name has cleared both
      // halves since it was written; the recovery worked and the button that calls it was hidden.
      edited: Object.keys(o).length > 0 || Object.keys(saved.matrices?.[name] || {}).length > 0,
    }
  }
  // Services the shop added itself — anything from "Puff embroidery" to "Sublimation".
  for (const [name, o] of Object.entries(saved.services || {})) {
    if (out[name]) continue
    out[name] = {
      axis: o.axis || AXIS.FLAT, base: num(o.base, 3), perUnit: num(o.perUnit, 0),
      unitSize: num(o.unitSize, 1000), minPerPiece: num(o.minPerPiece, 0), pressFee: num(o.pressFee, 0),
      setup: { label: o.setup?.label ?? 'Setup', fee: num(o.setup?.fee, 0), per: o.setup?.per || 'design', note: o.setup?.note || '' },
      custom: true, edited: true,
    }
  }
  // Explicit per-cell price overrides — a shop's OWN price sheet. Keyed `${bandMin}|${units}`; when a
  // cell exists it wins over the computed formula, even if it doesn't match. This is the "upload your
  // own matrix" feature: the shop's number is the shop's number.
  const matrices = (saved.matrices && typeof saved.matrices === 'object') ? saved.matrices : {}
  for (const name of Object.keys(out)) out[name].matrix = (matrices[name] && typeof matrices[name] === 'object') ? matrices[name] : {}
  return { services: out, bands: Array.isArray(saved.bands) && saved.bands.length ? saved.bands : QTY_BANDS, matrices }
}

export const serviceNames = (book) => Object.keys(book.services)

/**
 * Price one line of work.
 *
 * `units` is read against the service's own axis: ink colours, stitch count, square inches, or
 * ignored for flat-rate services. Returns the per-piece charge AND the setup line in that trade's
 * own words, so the caller never has to know what a "screen" is.
 */
export function quoteService({ book, service, qty = 0, units = 1, placements = 1 }) {
  const s = book.services[service] || book.services['Screen Print']
  if (!s) return null
  const n = Math.max(0, Number(qty) || 0)
  const factor = bandFor(n, book.bands)

  // A shop's explicit cell price wins over the formula — the whole point of an uploaded matrix. When
  // present it is the per-piece for one imprint at this qty+units; only placements multiply it (no
  // band factor, press fee, or minimum re-applied — the number is final).
  const cell = matrixCell(s, n, units, book.bands)
  let per, fromMatrix = false
  if (cell != null) {
    per = cell * Math.max(1, Number(placements) || 1)
    fromMatrix = true
  } else {
    if (s.axis === AXIS.COLORS)        per = s.base + s.perUnit * Math.max(0, (Number(units) || 1) - 1)
    else if (s.axis === AXIS.STITCHES) per = s.base + s.perUnit * (Math.max(0, Number(units) || 0) / (s.unitSize || 1000))
    else if (s.axis === AXIS.AREA)     per = s.base + s.perUnit * Math.max(0, Number(units) || 0)
    else                               per = s.base
    per = (per * factor + num(s.pressFee, 0)) * Math.max(1, Number(placements) || 1)
    per = Math.max(per, num(s.minPerPiece, 0))
  }

  // How many setup units to bill: per colour (screens) vs per design (digitizing, moulds, cut files).
  const setupUnits = s.setup.fee > 0
    ? (s.setup.per === 'color' ? Math.max(1, Number(units) || 1) : Math.max(1, Number(placements) || 1))
    : 0
  return {
    service, axis: s.axis, perPiece: round2(per), qtyFactor: factor, fromMatrix,
    setup: s.setup.fee > 0 && s.setup.label
      ? { label: s.setup.label, qty: setupUnits, unitPrice: round2(s.setup.fee), total: round2(s.setup.fee * setupUnits), note: s.setup.note }
      : null,
    subtotal: round2(per * n + (s.setup.fee > 0 ? s.setup.fee * setupUnits : 0)),
  }
}

/** The grid a shop sees on the Pricing screen: one row per qty band, one column per axis step. */
export function serviceMatrix({ book, service, steps, maxColors }) {
  const s = book.services[service]
  if (!s) return null
  // Screen-print shops run presses up to 14 colours — the grid must go that wide, not stop at 6.
  const nColors = Math.min(14, Math.max(1, Math.round(Number(maxColors) || 8)))
  const cols = steps || (s.axis === AXIS.COLORS ? Array.from({ length: nColors }, (_, i) => i + 1)
    : s.axis === AXIS.STITCHES ? [4000, 6000, 8000, 10000, 12000, 15000]
    : s.axis === AXIS.AREA ? [4, 9, 16, 25, 50, 100]
    : [1])
  const qtys = [...new Set(book.bands.map((b) => b.min))].sort((a, b) => a - b)
  return {
    service, axis: s.axis, cols, qtys, edited: !!s.edited, custom: !!s.custom,
    setup: s.setup.fee > 0 && s.setup.label ? s.setup : null,
    rows: qtys.map((q) => ({ qty: q, cells: cols.map((u) => quoteService({ book, service, qty: q, units: u }).perPiece), custom: cols.map((u) => matrixCell(s, q, u, book.bands) != null) })),
  }
}

/** Axis labels, in the words a print shop uses. */
export const AXIS_LABEL = {
  [AXIS.COLORS]: 'Ink colours', [AXIS.STITCHES]: 'Stitch count',
  [AXIS.AREA]: 'Print area (sq in)', [AXIS.FLAT]: 'Flat rate',
}
