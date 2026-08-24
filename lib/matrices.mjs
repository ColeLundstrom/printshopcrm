/**
 * Custom price matrices — a shop's own price sheets, in whatever shape its trade actually uses.
 *
 * WHY THIS EXISTS SEPARATELY FROM lib/pricebook.mjs
 * The price book is a *calculator*: it knows what a screen is, what a stitch count is, and it
 * derives a price from a formula. That is the right tool when the shop sells the four or five
 * decoration methods it has heard of. It is the wrong tool the moment a shop sells something the
 * calculator has never modelled — mug printing, laser engraving on cutting boards, rush fees by
 * hour, banner pricing by square foot. Those shops do not want a formula. They already have a
 * price sheet, on paper or in a spreadsheet, and they want the software to hold it.
 *
 * So a matrix here has NO opinion about what it prices. It is a named grid:
 *
 *     name        "Mug Printing"        — anything the shop wants to call it
 *     row_label   "Quantity"            — what the rows mean
 *     col_label   "Mug size"            — what the columns mean
 *     rows        ["1–5", "6–11", …]    — any labels at all
 *     cols        ["11 oz", "15 oz", …] — any labels at all
 *     cells       [[18, 20], [15, 17]]  — the prices, dense, null = "no price set"
 *
 * The only intelligence is optional and additive: if the row labels happen to read like quantity
 * bands ("1-11", "48–71", "500+"), rowIndexForQty can pre-select the right row from a line's
 * quantity so a quote fills itself in. A matrix whose rows are "Small / Medium / Large" simply
 * doesn't get that, and works fine without it.
 *
 * Everything below the DB helpers is pure and side-effect free, so the release gate can test the
 * grid maths without a database.
 */
import { all, get, run, now, logActivity } from './db.mjs'

/* ── limits ───────────────────────────────────────────────────────────────────
   Generous enough for any real price sheet, small enough that a matrix always fits in one JSON
   column and one screen. A 60×40 grid is 2,400 prices — larger than any sheet a shop has ever
   handed us, and still only ~20 KB of JSON. */
export const LIMITS = { rows: 60, cols: 40, name: 60, header: 48, label: 40, description: 200 }

/** How a cell's number is read when it lands on a quote. */
export const UNITS = {
  piece: { key: 'piece', label: 'Per piece', hint: 'The cell is the price of ONE piece. Quote = price × quantity.' },
  flat: { key: 'flat', label: 'Flat charge', hint: 'The cell is the whole charge for the line, whatever the quantity.' },
}

const clampStr = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100

/** A cell value, or null. Blank / non-numeric / negative all mean "no price here". */
export function cellValue(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null
  const n = Number(String(v).replace(/[$,\s]/g, ''))
  return Number.isFinite(n) && n >= 0 ? round2(n) : null
}

/* ── quantity-aware rows (optional) ──────────────────────────────────────────── */

/**
 * Read a row label as a quantity band, if it looks like one.
 * Understands "12-24", "12–24" (en/em dash), "12 to 24", "500+", "500 or more", "up to 24", "48".
 * A label that carries no digits at all ("Large", "Front & Back") returns null, which is the
 * normal case for a matrix that isn't priced by quantity.
 */
export function parseQtyRange(label) {
  const s = String(label ?? '').trim()
  if (!s || !/\d/.test(s)) return null
  const n = (x) => Number(String(x).replace(/,/g, ''))

  let m = s.match(/^\D*(\d[\d,]*)\s*(?:\+|plus\b|or more\b|and up\b|\bup\b)/i)
  if (m) return { min: n(m[1]), max: Infinity, exact: false }

  m = s.match(/^\D*(\d[\d,]*)\s*(?:-|–|—|to|thru|through)\s*(\d[\d,]*)/i)
  if (m) return { min: n(m[1]), max: n(m[2]), exact: false }

  m = s.match(/^\s*(?:up to|under|below|max|<=?)\s*(\d[\d,]*)/i)
  if (m) return { min: 0, max: n(m[1]), exact: false }

  m = s.match(/(\d[\d,]*)/)
  // A bare number is ambiguous: shops write both "48" meaning "48 exactly" and "48" meaning "48
  // and up" as the head of a band list. Marked exact, and rowIndexForQty falls back to treating a
  // whole column of bare numbers as band minimums — which is what a price sheet always means.
  return m ? { min: n(m[1]), max: n(m[1]), exact: true } : null
}

/**
 * Which row a quantity belongs in, or -1 if the rows aren't quantities at all.
 * Explicit ranges win; a grid of bare numbers is read as ascending band minimums.
 */
export function rowIndexForQty(rows, qty) {
  const n = Math.max(0, Number(qty) || 0)
  if (!n || !Array.isArray(rows) || !rows.length) return -1
  const parsed = rows.map(parseQtyRange)
  if (!parsed.some(Boolean)) return -1

  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i]
    if (p && !p.exact && n >= p.min && n <= p.max) return i
  }
  // Band-minimum fallback: the highest row whose number is <= the quantity.
  let best = -1, bestMin = -1
  parsed.forEach((p, i) => { if (p && p.min <= n && p.min >= bestMin) { bestMin = p.min; best = i } })
  return best
}

/* ── the grid ─────────────────────────────────────────────────────────────────── */

/**
 * Force a cell array to exactly nRows × nCols, keeping every value that still has a home.
 * This is what makes "add a column" and "delete a row" safe: the grid is dense and positional, so
 * a resize is an array operation, not a key migration that can silently drop a shop's prices.
 */
export function resizeGrid(cells, nRows, nCols) {
  const src = Array.isArray(cells) ? cells : []
  return Array.from({ length: nRows }, (_, r) =>
    Array.from({ length: nCols }, (_, c) => cellValue(Array.isArray(src[r]) ? src[r][c] : null)))
}

/** Insert a blank row/column at `index` (or append when index is out of range). */
export function insertRow(m, index) {
  const at = Math.min(Math.max(0, Number(index) ?? m.rows.length), m.rows.length)
  const rows = [...m.rows]; rows.splice(at, 0, '')
  const cells = [...m.cells]; cells.splice(at, 0, m.cols.map(() => null))
  return { ...m, rows, cells }
}
export function insertCol(m, index) {
  const at = Math.min(Math.max(0, Number(index) ?? m.cols.length), m.cols.length)
  const cols = [...m.cols]; cols.splice(at, 0, '')
  const cells = m.cells.map((row) => { const r = [...row]; r.splice(at, 0, null); return r })
  return { ...m, cols, cells }
}
export function removeRow(m, index) {
  if (m.rows.length <= 1) return m
  const rows = m.rows.filter((_, i) => i !== index)
  const cells = m.cells.filter((_, i) => i !== index)
  return { ...m, rows, cells }
}
export function removeCol(m, index) {
  if (m.cols.length <= 1) return m
  const cols = m.cols.filter((_, i) => i !== index)
  const cells = m.cells.map((row) => row.filter((_, i) => i !== index))
  return { ...m, cols, cells }
}

/**
 * Look a price up. `row` / `col` may be an index or a header label — the UI sends indexes, the
 * public API and the AI surfaces send labels, and both have to land on the same number.
 * Returns null when the cell is empty, so a caller can tell "no price set" from "free".
 */
export function lookupPrice(matrix, { row, col, qty } = {}) {
  if (!matrix) return null
  const ri = resolveIndex(matrix.rows, row, () => rowIndexForQty(matrix.rows, qty))
  const ci = resolveIndex(matrix.cols, col, () => (matrix.cols.length === 1 ? 0 : -1))
  if (ri < 0 || ci < 0) return null
  const price = cellValue(matrix.cells?.[ri]?.[ci])
  if (price === null) return null
  return {
    price, rowIndex: ri, colIndex: ci,
    row: matrix.rows[ri], col: matrix.cols[ci],
    unit: matrix.unit,
    // What the line is worth once quantity is applied — 'flat' ignores quantity by definition.
    amount: matrix.unit === 'flat' ? price : round2(price * Math.max(0, Number(qty) || 0)),
  }
}

/** Index from an index, an exact label, or a case-insensitive label; else the fallback. */
function resolveIndex(headers, value, fallback) {
  const list = Array.isArray(headers) ? headers : []
  if (value !== null && value !== undefined && String(value).trim() !== '') {
    const asNum = Number(value)
    if (Number.isInteger(asNum) && String(value).trim() === String(asNum) && asNum >= 0 && asNum < list.length) return asNum
    const exact = list.indexOf(String(value))
    if (exact >= 0) return exact
    const ci = list.findIndex((h) => String(h).trim().toLowerCase() === String(value).trim().toLowerCase())
    if (ci >= 0) return ci
  }
  return fallback ? fallback() : -1
}

/* ── import ───────────────────────────────────────────────────────────────────── */

/**
 * Turn a pasted or uploaded grid into a matrix shape. Unlike the old service-bound importer, the
 * headers are kept as TEXT: "11 oz Mug" and "Both Sides" survive, because a shop's column headers
 * are not always numbers and mangling them into numbers is what made the old import useless for
 * anything but screen printing.
 *
 * Layout: first row = column headers (its first cell is the corner label and may be blank);
 * every later row = a row header followed by its prices. Comma or tab separated.
 */
export function parseSheet(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length < 2) throw new Error('Need a header row of column names and at least one price row.')
  const split = (l) => splitDelimited(l, l.includes('\t') ? '\t' : ',')
  const head = split(lines[0])
  const cols = head.slice(1).map((h) => clampStr(h, LIMITS.header)).filter((h, i, a) => i < LIMITS.cols && (h || a.length === 1))
  if (!cols.length) throw new Error('The first row needs at least one column name after the corner cell.')

  const rows = [], cells = []
  for (const line of lines.slice(1, LIMITS.rows + 1)) {
    const parts = split(line)
    const label = clampStr(parts[0], LIMITS.header)
    if (!label) continue
    rows.push(label)
    cells.push(cols.map((_, i) => cellValue(parts[i + 1])))
  }
  if (!rows.length) throw new Error('No price rows found. Each row needs a label in the first column.')
  const filled = cells.flat().filter((v) => v !== null).length
  if (!filled) throw new Error('No prices found. Use plain numbers like 4.25.')
  return { cols, rows, cells, filled, cornerLabel: clampStr(head[0], LIMITS.label) }
}

/** CSV-aware split: respects "quoted, fields" so a header like "Front, Back" survives. */
function splitDelimited(line, delim) {
  const out = []
  let cur = '', quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++ } else quoted = !quoted
    } else if (ch === delim && !quoted) { out.push(cur); cur = '' } else cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

/* ── starter templates ────────────────────────────────────────────────────────
   Real, defensible numbers so a shop can quote the day it installs — and every one of them is
   editable to the last cell. These are a starting point, never a rule; a shop that imports
   "Screen Printing" and rewrites all 48 cells is using the feature exactly as intended. */
export const TEMPLATES = [
  {
    key: 'screen-print',
    name: 'Screen Printing',
    description: 'Print-only pricing by ink colour. Add the garment as its own line.',
    rowLabel: 'Quantity', colLabel: 'Ink colours', unit: 'piece',
    rows: ['1–11', '12–23', '24–47', '48–71', '72–143', '144–287', '288–499', '500+'],
    cols: ['1 colour', '2 colours', '3 colours', '4 colours', '5 colours', '6 colours'],
    cells: [
      [8.00, 9.50, 11.00, 12.50, 14.00, 15.50],
      [5.50, 6.75, 8.00, 9.25, 10.50, 11.75],
      [4.00, 4.85, 5.70, 6.55, 7.40, 8.25],
      [3.00, 3.70, 4.40, 5.10, 5.80, 6.50],
      [2.55, 3.15, 3.75, 4.35, 4.95, 5.55],
      [2.10, 2.60, 3.10, 3.60, 4.10, 4.60],
      [1.80, 2.25, 2.70, 3.15, 3.60, 4.05],
      [1.55, 1.95, 2.35, 2.75, 3.15, 3.55],
    ],
  },
  {
    key: 'dtf',
    name: 'DTF Transfers',
    description: 'Printed and pressed, priced by the size of the transfer.',
    rowLabel: 'Quantity', colLabel: 'Transfer size', unit: 'piece',
    rows: ['1–11', '12–23', '24–47', '48–71', '72–143', '144–287', '288–499', '500+'],
    cols: ['3" × 3"', '4" × 4"', '8" × 10"', '11" × 14"', '12" × 18"'],
    cells: [
      [4.00, 4.75, 8.50, 12.00, 15.00],
      [3.25, 3.90, 7.00, 10.00, 12.50],
      [2.75, 3.30, 6.00, 8.50, 10.75],
      [2.40, 2.90, 5.25, 7.50, 9.50],
      [2.15, 2.60, 4.75, 6.75, 8.50],
      [1.90, 2.30, 4.25, 6.00, 7.60],
      [1.70, 2.05, 3.80, 5.40, 6.85],
      [1.50, 1.85, 3.40, 4.85, 6.15],
    ],
  },
  {
    key: 'embroidery',
    name: 'Embroidery',
    description: 'Priced by stitch count. Digitizing is a separate one-time line.',
    rowLabel: 'Quantity', colLabel: 'Stitch count', unit: 'piece',
    rows: ['1–11', '12–23', '24–47', '48–71', '72–143', '144–287', '288–499', '500+'],
    cols: ['Up to 5,000', 'Up to 8,000', 'Up to 10,000', 'Up to 12,000', 'Up to 15,000'],
    cells: [
      [9.00, 11.50, 13.50, 15.50, 18.50],
      [7.00, 9.00, 10.50, 12.00, 14.50],
      [5.75, 7.25, 8.50, 9.75, 11.75],
      [5.00, 6.25, 7.25, 8.25, 10.00],
      [4.50, 5.60, 6.50, 7.40, 9.00],
      [4.10, 5.10, 5.90, 6.70, 8.15],
      [3.80, 4.70, 5.45, 6.20, 7.50],
      [3.50, 4.35, 5.05, 5.75, 7.00],
    ],
  },
  {
    key: 'heat-press',
    name: 'Heat Press & Vinyl',
    description: 'Cut vinyl and heat-applied graphics, including names and numbers.',
    rowLabel: 'Quantity', colLabel: 'Job type', unit: 'piece',
    rows: ['1–11', '12–23', '24–47', '48–71', '72–143', '144+'],
    cols: ['1 colour', '2 colours', '3 colours', 'Names & numbers'],
    cells: [
      [7.00, 10.00, 13.00, 12.00],
      [5.50, 8.00, 10.50, 9.50],
      [4.50, 6.50, 8.50, 8.00],
      [3.90, 5.60, 7.30, 7.00],
      [3.50, 5.00, 6.50, 6.25],
      [3.10, 4.40, 5.75, 5.50],
    ],
  },
  {
    key: 'drinkware',
    name: 'Mugs & Drinkware',
    description: 'All-in per-piece pricing — the blank and the decoration together.',
    rowLabel: 'Quantity', colLabel: 'Drinkware', unit: 'piece',
    rows: ['1–5', '6–11', '12–23', '24–47', '48–95', '96+'],
    cols: ['11 oz mug', '15 oz mug', '20 oz tumbler', '30 oz tumbler', 'Water bottle'],
    cells: [
      [18.00, 20.00, 26.00, 32.00, 28.00],
      [15.00, 17.00, 23.00, 28.00, 25.00],
      [13.00, 14.50, 20.00, 25.00, 22.00],
      [11.50, 13.00, 18.00, 22.50, 20.00],
      [10.25, 11.50, 16.50, 20.50, 18.25],
      [9.00, 10.25, 15.00, 18.50, 16.50],
    ],
  },
  {
    key: 'patches',
    name: 'Custom Patches',
    description: 'Embroidered patches by finished size. Mould or setup billed separately.',
    rowLabel: 'Quantity', colLabel: 'Patch size', unit: 'piece',
    rows: ['1–24', '25–49', '50–99', '100–249', '250–499', '500–999', '1000+'],
    cols: ['2"', '2.5"', '3"', '3.5"', '4"'],
    cells: [
      [4.50, 5.25, 6.00, 6.90, 7.80],
      [3.40, 3.95, 4.55, 5.20, 5.90],
      [2.60, 3.05, 3.50, 4.00, 4.55],
      [2.05, 2.40, 2.75, 3.15, 3.60],
      [1.65, 1.90, 2.20, 2.50, 2.85],
      [1.35, 1.55, 1.80, 2.05, 2.35],
      [1.10, 1.30, 1.50, 1.70, 1.95],
    ],
  },
  {
    key: 'laser',
    name: 'Laser Engraving',
    description: 'Engraving time by engraved area. Add the blank as its own line.',
    rowLabel: 'Quantity', colLabel: 'Engraved area', unit: 'piece',
    rows: ['1–11', '12–23', '24–47', '48–99', '100+'],
    cols: ['Small (≤2 sq in)', 'Medium (≤6 sq in)', 'Large (≤12 sq in)'],
    cells: [
      [8.00, 12.00, 18.00],
      [6.50, 9.75, 14.50],
      [5.50, 8.25, 12.25],
      [4.75, 7.10, 10.50],
      [4.10, 6.15, 9.10],
    ],
  },
  {
    key: 'blank',
    name: 'New price matrix',
    description: 'An empty grid. Name the rows and columns whatever your shop actually sells.',
    rowLabel: 'Quantity', colLabel: 'Option', unit: 'piece',
    rows: ['1–11', '12–23', '24–47', '48+'],
    cols: ['Option A', 'Option B', 'Option C'],
    cells: [[null, null, null], [null, null, null], [null, null, null], [null, null, null]],
  },
]

export const templateSummaries = () => TEMPLATES.map((t) => ({
  key: t.key, name: t.name, description: t.description,
  rowLabel: t.rowLabel, colLabel: t.colLabel, unit: t.unit,
  rows: t.rows.length, cols: t.cols.length,
  sample: t.cells.flat().filter((v) => v !== null).length ? { row: t.rows[0], col: t.cols[0], price: t.cells[0][0] } : null,
}))

/* ── persistence ──────────────────────────────────────────────────────────────── */

const parseJson = (v, d) => { try { const x = JSON.parse(v); return x ?? d } catch { return d } }

/** A DB row → the shape everything else in the app works with. */
export function hydrate(row) {
  if (!row) return null
  const rows = parseJson(row.grid_rows, [])
  const cols = parseJson(row.grid_cols, [])
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    rowLabel: row.row_label || 'Quantity',
    colLabel: row.col_label || 'Option',
    unit: row.unit === 'flat' ? 'flat' : 'piece',
    isDefault: !!row.is_default,
    rows, cols,
    cells: resizeGrid(parseJson(row.cells, []), rows.length, cols.length),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Clean whatever the client sent into a storable matrix. Throws on anything unusable. */
export function sanitize(input = {}, base = null) {
  const name = clampStr(input.name ?? base?.name, LIMITS.name)
  if (!name) throw new Error('Give the matrix a name.')

  let rows = Array.isArray(input.rows) ? input.rows : base?.rows
  let cols = Array.isArray(input.cols) ? input.cols : base?.cols
  rows = (rows || []).slice(0, LIMITS.rows).map((r, i) => clampStr(r, LIMITS.header) || `Row ${i + 1}`)
  cols = (cols || []).slice(0, LIMITS.cols).map((c, i) => clampStr(c, LIMITS.header) || `Column ${i + 1}`)
  if (!rows.length) throw new Error('A matrix needs at least one row.')
  if (!cols.length) throw new Error('A matrix needs at least one column.')
  // Duplicate headers would make label-based lookup ambiguous for the API and the AI surfaces.
  rows = dedupe(rows)
  cols = dedupe(cols)

  const cells = resizeGrid(input.cells ?? base?.cells, rows.length, cols.length)
  return {
    name, rows, cols, cells,
    description: clampStr(input.description ?? base?.description ?? '', LIMITS.description),
    rowLabel: clampStr(input.rowLabel ?? base?.rowLabel ?? 'Quantity', LIMITS.label) || 'Quantity',
    colLabel: clampStr(input.colLabel ?? base?.colLabel ?? 'Option', LIMITS.label) || 'Option',
    unit: (input.unit ?? base?.unit) === 'flat' ? 'flat' : 'piece',
  }
}

const dedupe = (list) => {
  const seen = new Map()
  return list.map((h) => {
    const k = h.toLowerCase()
    if (!seen.has(k)) { seen.set(k, 1); return h }
    const n = seen.get(k) + 1; seen.set(k, n)
    return clampStr(`${h} (${n})`, LIMITS.header)
  })
}

export function listMatrices() {
  return all('SELECT * FROM price_matrices ORDER BY is_default DESC, lower(name) ASC').map(hydrate)
}

export function getMatrix(id) {
  return hydrate(get('SELECT * FROM price_matrices WHERE id = ?', Number(id) || 0))
}

/** The matrix a new quote should reach for: the shop's default, else the first one it made. */
export function defaultMatrix() {
  return hydrate(get('SELECT * FROM price_matrices WHERE is_default = 1')
    || get('SELECT * FROM price_matrices ORDER BY id ASC LIMIT 1'))
}

export function createMatrix(input) {
  const m = sanitize(input)
  const first = !get('SELECT id FROM price_matrices LIMIT 1')
  const ts = now()
  const r = run(
    `INSERT INTO price_matrices (name, description, row_label, col_label, unit, grid_rows, grid_cols, cells, is_default, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    m.name, m.description, m.rowLabel, m.colLabel, m.unit,
    JSON.stringify(m.rows), JSON.stringify(m.cols), JSON.stringify(m.cells),
    // The very first matrix a shop makes becomes the default, so quoting works without a second
    // decision. Everything after that is an explicit choice.
    first || input.isDefault ? 1 : 0, ts, ts)
  const id = Number(r.lastInsertRowid)
  if (input.isDefault && !first) setDefaultMatrix(id)
  logActivity('note', `Price matrix created — ${m.name} (${m.rows.length} × ${m.cols.length})`)
  return getMatrix(id)
}

export function updateMatrix(id, input) {
  const existing = getMatrix(id)
  if (!existing) return null
  const m = sanitize(input, existing)
  run(`UPDATE price_matrices SET name=?, description=?, row_label=?, col_label=?, unit=?, grid_rows=?, grid_cols=?, cells=?, updated_at=? WHERE id=?`,
    m.name, m.description, m.rowLabel, m.colLabel, m.unit,
    JSON.stringify(m.rows), JSON.stringify(m.cols), JSON.stringify(m.cells), now(), existing.id)
  if (input.isDefault) setDefaultMatrix(existing.id)
  return getMatrix(existing.id)
}

/** A copy, named so the shop can tell them apart without renaming anything first. */
export function duplicateMatrix(id, name) {
  const src = getMatrix(id)
  if (!src) return null
  const copy = createMatrix({ ...src, name: name || uniqueName(`${src.name} (copy)`), isDefault: false })
  return copy
}

function uniqueName(base) {
  const taken = new Set(all('SELECT name FROM price_matrices').map((r) => String(r.name).toLowerCase()))
  if (!taken.has(base.toLowerCase())) return clampStr(base, LIMITS.name)
  for (let n = 2; n < 100; n++) {
    const candidate = clampStr(base.replace(/\)$/, ` ${n})`), LIMITS.name)
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return clampStr(base, LIMITS.name)
}

export function deleteMatrix(id) {
  const m = getMatrix(id)
  if (!m) return false
  run('DELETE FROM price_matrices WHERE id = ?', m.id)
  // Deleting the default must not leave the shop without one, or the quote picker opens empty.
  if (m.isDefault) {
    const next = get('SELECT id FROM price_matrices ORDER BY id ASC LIMIT 1')
    if (next) run('UPDATE price_matrices SET is_default = 1 WHERE id = ?', next.id)
  }
  logActivity('note', `Price matrix deleted — ${m.name}`)
  return true
}

export function setDefaultMatrix(id) {
  const m = getMatrix(id)
  if (!m) return null
  run('UPDATE price_matrices SET is_default = 0 WHERE is_default = 1')
  run('UPDATE price_matrices SET is_default = 1, updated_at = ? WHERE id = ?', now(), m.id)
  return getMatrix(m.id)
}

/** Install a starter template as a new matrix. */
export function createFromTemplate(key, overrides = {}) {
  const t = TEMPLATES.find((x) => x.key === key)
  if (!t) throw new Error('No such template.')
  return createMatrix({ ...t, name: uniqueName(overrides.name || t.name), ...overrides })
}

/** A list-screen summary — enough to choose one, without shipping every price to the browser. */
export const summary = (m) => ({
  id: m.id, name: m.name, description: m.description, unit: m.unit,
  rowLabel: m.rowLabel, colLabel: m.colLabel,
  rows: m.rows.length, cols: m.cols.length,
  filled: m.cells.flat().filter((v) => v !== null).length,
  isDefault: m.isDefault, updatedAt: m.updatedAt,
})
