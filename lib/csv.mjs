/**
 * CSV import — "your data is not the moat." Shops leave competitors because leaving means losing
 * their customer list; this makes coming IN just as easy. Parses a customer export from Printavo,
 * shopVOX, DecoNetwork, QuickBooks, a spreadsheet — whatever — and maps its columns onto contacts.
 *
 * The parser is RFC-4180-ish: quoted fields, embedded commas, embedded newlines, doubled quotes,
 * and CRLF. No dependency — it reads the bytes.
 */
import { shopFormat } from './db.mjs'

/** Parse CSV text into an array of row objects keyed by the (lowercased, trimmed) header. */
export function parseCsv(text) {
  const rows = parseRows(String(text || ''))
  if (!rows.length) return []
  const headers = rows[0].map((h) => String(h || '').trim().toLowerCase())
  return rows.slice(1)
    .filter((r) => r.some((c) => String(c).trim() !== '')) // drop blank lines
    .map((r) => { const o = {}; headers.forEach((h, i) => { if (h) o[h] = (r[i] ?? '').trim() }); return o })
}

/** Split raw CSV into a grid of cells, honoring quotes/escapes/newlines. */
function parseRows(text) {
  const rows = []
  let row = [], field = '', inQuotes = false
  const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inQuotes) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++ } else inQuotes = false }
      else field += ch
    } else if (ch === '"' && field === '') inQuotes = true // a quote only opens a field at its start
    else if (ch === '"') field += ch                       // mid-field quote (e.g. 5'6") is a literal
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else field += ch
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows
}

// Header synonyms across the common services. First match wins.
const COLS = {
  name: ['name', 'customer', 'customer name', 'contact', 'contact name', 'full name', 'client', 'client name'],
  first: ['first name', 'firstname', 'first', 'given name'],
  last: ['last name', 'lastname', 'last', 'surname', 'family name'],
  email: ['email', 'e-mail', 'email address', 'primary email', 'contact email'],
  phone: ['phone', 'phone number', 'telephone', 'mobile', 'cell', 'cell phone', 'primary phone', 'contact phone'],
  company: ['company', 'company name', 'organization', 'organisation', 'business', 'business name', 'account', 'account name'],
  notes: ['notes', 'note', 'description', 'comments'],
  tags: ['tags', 'tag', 'group', 'groups', 'labels', 'category', 'type'],
}
// Collapse embedded newlines/tabs/control chars to a single space. A name/company/phone never
// legitimately spans lines, so a multi-line value is a malformed-CSV artifact (e.g. a stray quote
// merged several rows) — flatten it so the damage stays bounded and visible in the import preview.
const clean = (v) => String(v ?? '').replace(/[\u0000-\u001F]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
const pick = (row, keys) => { for (const k of keys) if (row[k] != null && String(row[k]).trim() !== '') return clean(row[k]); return '' }

/**
 * Map one parsed row onto a contact. Combines First/Last when there's no single Name column, and
 * falls back to the company as the name (a B2B export often has only a business). Returns null when
 * there's nothing usable to name the record (contacts require a name).
 */
export function mapContactRow(row) {
  let name = pick(row, COLS.name)
  if (!name) {
    const fn = pick(row, COLS.first), ln = pick(row, COLS.last)
    name = `${fn} ${ln}`.trim()
  }
  const company = pick(row, COLS.company)
  if (!name) name = company // B2B export with only a business name
  if (!name) return null
  return {
    name: name.slice(0, 120),
    email: pick(row, COLS.email).slice(0, 160).toLowerCase(),
    phone: pick(row, COLS.phone).slice(0, 40),
    company: (company && company !== name) ? company.slice(0, 120) : '',
    notes: pick(row, COLS.notes).slice(0, 500),
    tags: pick(row, COLS.tags).replace(/[;|]/g, ',').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 6).join(','),
  }
}

/** Which of the recognized fields a header set actually provides — for the UI's column preview. */
export function detectColumns(headers) {
  const h = (headers || []).map((x) => String(x).toLowerCase().trim())
  const has = (keys) => keys.some((k) => h.includes(k))
  return {
    name: has(COLS.name) || (has(COLS.first) && has(COLS.last)) || has(COLS.first) || has(COLS.company),
    email: has(COLS.email), phone: has(COLS.phone), company: has(COLS.company),
    tags: has(COLS.tags), notes: has(COLS.notes),
  }
}

// ─── Order / estimate history import ────────────────────────────────────────
// Printavo, YoPrint, shopVOX, DecoNetwork, Printful, a spreadsheet — same idea as contacts, but
// the record is an order line. "Your data is not the moat": a shop can bring its whole quote/order
// history in, so switching TO us costs nothing. These are PURE — they parse + normalize only; the
// caller does the DB inserts (preview first, then commit).

// Header synonyms for order columns. Each list is ordered MOST AUTHORITATIVE FIRST, and that
// order is what decides when one file carries two headers that both resolve to the same field.
//
// It used to be decided by the order of the COLUMNS in the file, which is not something the shop
// exporting the file knows it is choosing. `subtotal` and `total` are both synonyms for `total`,
// and a Printavo / shopVOX / QuickBooks export writes `Subtotal, Sales Tax, Total` in that order
// — so the pre-tax figure won, and a $3,003.94 order was imported as a $3,003.94-less-tax
// invoice of $2,775.00, raised unpaid, chased by A/R aging, the customer statement, the
// Outstanding KPI, the dunning email and the QuickBooks export. Reordering the same three columns
// imported the same order at the right number. A shop migrating a year of open receivables at
// 8.25% brought in $60,000 of A/R as $55,427 and had no screen that would ever ask for the rest,
// and no undo but a hand re-import. `unit_price` and `customer_name` had the same latency.
const ORDER_COLS = {
  customer_name: ['customer', 'customer name', 'client', 'client name', 'contact', 'contact name', 'company', 'company name', 'account', 'account name', 'name', 'bill to'],
  customer_email: ['email', 'e-mail', 'email address', 'customer email', 'contact email', 'client email'],
  order_number: ['order #', 'order number', 'order no', 'order', 'invoice #', 'invoice number', 'invoice no', 'invoice', 'nickname', 'quote #', 'quote number', 'quote', 'estimate #', 'estimate number', 'so #', 'job #', 'job number', 'job', 'id', '#'],
  date: ['date', 'order date', 'created', 'created date', 'created at', 'invoice date', 'quote date', 'estimate date', 'issued', 'issue date'],
  status: ['status', 'order status', 'stage', 'state', 'production status', 'workflow', 'workflow status'],
  garment: ['product', 'style', 'garment', 'item', 'style number', 'style #', 'style name', 'description', 'line item', 'product name'],
  quantity: ['qty', 'quantity', 'total qty', 'total quantity', 'pieces', 'units'],
  unit_price: ['unit price', 'price', 'unit cost', 'price each', 'each', 'rate', 'unit'],
  total: ['total', 'amount', 'order total', 'invoice total', 'grand total', 'line total', 'subtotal', 'total price', 'total amount', 'value'],
  decoration: ['decoration', 'imprint', 'print type', 'method', 'process', 'service', 'print method', 'decoration type'],
  due_date: ['due', 'due date', 'due on', 'in hands', 'in-hands', 'in hand date', 'ship date', 'delivery date', 'needed by', 'deadline'],
  notes: ['notes', 'note', 'comments', 'memo', 'internal notes', 'details'],
}

// Size columns. Header (lowercased) → canonical size key. Covers the common apparel run.
const SIZE_ALIASES = {
  xs: 'XS', s: 'S', sm: 'S', small: 'S', m: 'M', md: 'M', medium: 'M', l: 'L', lg: 'L', large: 'L',
  xl: 'XL', 'x-large': 'XL', 'xlarge': 'XL',
  '2xl': '2XL', xxl: '2XL', '2x': '2XL', '2xlarge': '2XL',
  '3xl': '3XL', xxxl: '3XL', '3x': '3XL',
  '4xl': '4XL', xxxxl: '4XL', '4x': '4XL',
  '5xl': '5XL', '5x': '5XL', '6xl': '6XL', '6x': '6XL',
  ost: 'OSFA', osfa: 'OSFA', 'one size': 'OSFA',
}

/** Coerce a money string ("$1,234.56", "(1,200.00)", "1.200,50") to a Number, or null. */
export function coerceMoney(v) {
  if (v == null) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  let s = String(v).trim()
  if (s === '') return null
  const negative = /^\(.*\)$/.test(s) || /-/.test(s) // (1,200) or -1,200 → negative
  s = s.replace(/[^0-9.,]/g, '') // strip currency symbols, spaces, parens, minus
  if (s === '') return null
  // Decide the decimal separator. If both present, the last one is the decimal.
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.')
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.') // 1.200,50 → 1200.50
    else s = s.replace(/,/g, '') // 1,200.50 → 1200.50
  } else if (lastComma > -1) {
    // Only commas: decimal if it looks like a cents group — a single comma with exactly two
    // digits after it. The integer part is NOT bounded at three: a thousands group is always
    // exactly three digits, so ",\d\d" at the end of the string can never be one, whatever comes
    // before it. Requiring \d{1,3} meant "1234,56" — an ordinary four-figure European total —
    // had its comma stripped and imported as $123,456.00, a hundred times the real number.
    if (/^\d+,\d{2}$/.test(s)) s = s.replace(',', '.')
    else s = s.replace(/,/g, '')
  } else if (lastDot > -1) {
    // Only dots. A European thousands group ("1.200" = twelve hundred, "1.200.000") has 3-digit
    // groups; anything else is a decimal point. Without this, 1.200 imported as $1.20.
    //
    // But nobody writes a thousands group with a leading zero, so "0.750" — how a three-decimal
    // unit price comes out of plenty of exports — is seventy-five cents and never seven hundred
    // and fifty dollars. It was importing as the latter: a thousandfold error on a per-piece
    // price, multiplied by the quantity on every line it touched.
    if (/^[1-9]\d{0,2}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '')
  }
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  return negative ? -Math.abs(n) : n
}

/** Coerce a date string to ISO "YYYY-MM-DD", or null if it can't be understood. */
export function coerceDate(v) {
  if (v == null) return null
  const s = String(v).trim()
  if (s === '') return null
  // Already ISO (optionally with time) — take the date part.
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) return isoOrNull(+m[1], +m[2], +m[3])
  // MM/DD/YYYY or MM-DD-YYYY or M/D/YY (US-first, the dominant format in these exports).
  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/)
  if (m) {
    let [, mo, da, yr] = m.map(Number)
    if (yr < 100) yr += yr < 70 ? 2000 : 1900
    // If the first field can't be a month but the second can, it's D/M/Y.
    if (mo > 12 && da <= 12) [mo, da] = [da, mo]
    return isoOrNull(yr, mo, da)
  }
  // "Jan 5, 2026" / "5 January 2026" and similar — lean on Date, but keep it UTC-stable.
  const t = Date.parse(s)
  if (!Number.isNaN(t)) {
    const d = new Date(t)
    return isoOrNull(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
  }
  return null
}
function isoOrNull(y, mo, da) {
  if (!(y >= 1000 && y <= 9999 && mo >= 1 && mo <= 12 && da >= 1 && da <= 31)) return null
  return `${y}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`
}

/**
 * Whole-number quantity. Must parse as a NUMBER first and then round: stripping the punctuation
 * turned "24.00" — the way QuickBooks, Printavo and Excel all export a quantity — into 2400, so a
 * 24-piece order imported as a 2,400-piece order.
 */
const coerceInt = (v) => {
  const cleaned = String(v ?? '').replace(/[^0-9.\-]/g, '')
  // An absent/blank cell must stay null, NOT 0 — callers use null to mean "not supplied" and fall
  // back to the size grid. Number('') is 0, which silently defeated that.
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? Math.round(n) : null
}

// Build a lookup from a header list → resolved field, honoring caller-supplied aliases first.
function resolveOrderHeaders(headers, headerAliases) {
  const norm = (x) => String(x ?? '').trim().toLowerCase()
  const overrides = {}
  for (const [header, field] of Object.entries(headerAliases || {})) overrides[norm(header)] = field
  const fieldOf = {}, sizeOf = {}
  for (const raw of headers) {
    const h = norm(raw)
    if (!h) continue
    // rank -1: a caller-supplied alias is an explicit instruction and outranks every synonym.
    if (overrides[h]) { fieldOf[h] = { field: overrides[h], rank: -1 }; continue }
    if (SIZE_ALIASES[h]) { sizeOf[h] = SIZE_ALIASES[h]; continue }
    for (const [field, syns] of Object.entries(ORDER_COLS)) {
      const rank = syns.indexOf(h)
      if (rank >= 0) { fieldOf[h] = { field, rank }; break }
    }
  }
  return { fieldOf, sizeOf }
}

/**
 * Map parsed rows (from parseCsv) onto normalized order objects. Tolerant of column-name variants
 * and messy cells — NEVER throws; malformed rows are skipped and described in `warnings`.
 *
 * @param {Array<Object>} rows - row objects keyed by lowercased header (parseCsv output).
 * @param {{ headerAliases?: Object }} [opts] - map of exact header → field name to force a mapping.
 * @returns {{ orders: Array, warnings: Array<{row:number, message:string}> }}
 */
export function mapOrderRows(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows : []
  const warnings = []
  const orders = []
  if (!list.length) return { orders, warnings }
  const headers = Object.keys(list[0] || {})
  const { fieldOf, sizeOf } = resolveOrderHeaders(headers, opts.headerAliases)
  const hasSizeCols = Object.keys(sizeOf).length > 0

  list.forEach((row, i) => {
    try {
      // Skip fully-empty rows.
      if (!row || !Object.values(row).some((v) => String(v ?? '').trim() !== '')) return
      const vals = {}       // field → the value from its best-ranked header
      const ranks = {}      // field → the synonym rank that value came from
      const sizes = {}
      let sizeQty = 0
      for (const [h, cell] of Object.entries(row)) {
        const val = clean(cell)
        if (sizeOf[h]) {
          const n = coerceInt(cell)
          if (n && n > 0) { sizes[sizeOf[h]] = (sizes[sizeOf[h]] || 0) + n; sizeQty += n }
          continue
        }
        // Best synonym wins, not leftmost column. `Total` (rank 0) beats `Subtotal` (rank 6)
        // wherever both appear, whichever way round the file lists them.
        const f = fieldOf[h]
        if (f && val !== '' && (ranks[f.field] === undefined || f.rank < ranks[f.field])) {
          vals[f.field] = val
          ranks[f.field] = f.rank
        }
      }

      const total = coerceMoney(vals.total)
      const unit_price = coerceMoney(vals.unit_price)
      let quantity = coerceInt(vals.quantity)
      if (quantity == null && hasSizeCols && sizeQty > 0) quantity = sizeQty // derive qty from sizes

      const order = {
        customer_name: (vals.customer_name || '').slice(0, 160) || null,
        customer_email: (vals.customer_email || '').toLowerCase().slice(0, 200) || null,
        order_number: (vals.order_number || '').slice(0, 80) || null,
        date: coerceDate(vals.date),
        status: (vals.status || '').slice(0, 60) || null,
        garment: (vals.garment || '').slice(0, 200) || null,
        sizes,
        quantity,
        unit_price,
        total,
        decoration: (vals.decoration || '').slice(0, 120) || null,
        due_date: coerceDate(vals.due_date),
        notes: (vals.notes || '').slice(0, 1000) || null,
      }

      // A usable order needs SOMETHING identifying — a customer, an order number, or money/qty.
      if (!order.customer_name && !order.customer_email && !order.order_number && order.total == null && order.quantity == null && !order.garment) {
        warnings.push({ row: i + 1, message: 'no recognizable order fields; skipped' })
        return
      }
      if (vals.total != null && total == null) warnings.push({ row: i + 1, message: `unparseable total "${vals.total}"` })
      if (vals.date != null && order.date == null) warnings.push({ row: i + 1, message: `unparseable date "${vals.date}"` })
      orders.push(order)
    } catch (err) {
      warnings.push({ row: i + 1, message: `row failed: ${err && err.message ? err.message : String(err)}` })
    }
  })

  return { orders, warnings }
}

/**
 * Pre-import preview stats over the output of mapOrderRows (accepts the {orders,warnings} result or
 * a bare orders array). Pure — no side effects.
 * @returns {{ orders:number, customers:number, totalValue:number, skipped:number, warnings:Array }}
 */
export function summarizeImport(mapped) {
  const orders = Array.isArray(mapped) ? mapped : (mapped && mapped.orders) || []
  const warnings = (mapped && !Array.isArray(mapped) && mapped.warnings) || []
  const customers = new Set()
  let totalValue = 0
  for (const o of orders) {
    const key = (o.customer_email && o.customer_email.trim()) || (o.customer_name && o.customer_name.trim().toLowerCase())
    if (key) customers.add(key)
    if (typeof o.total === 'number' && Number.isFinite(o.total)) totalValue += o.total
  }
  return {
    orders: orders.length,
    customers: customers.size,
    totalValue: Math.round(totalValue * 100) / 100,
    skipped: warnings.filter((w) => /skipped/.test(w.message)).length,
    warnings,
  }
}

/**
 * What to tell a shop whose import stopped part-way through.
 *
 * Both CSV importers commit in batches on purpose — 200 orders and 500 contacts at a time, with a
 * yield between them so /health answers and other shops keep loading while a big file lands.
 * server.mjs says so in as many words: "Whole-file atomicity is what we give up." Neither loop
 * caught a failing batch, so a write failure walked up to the terminal error handler, which is
 * written for single-statement routes and answers with a fixed sentence: "…so nothing was saved."
 *
 * Measured on a volume filled mid-run: the shop is told nothing was saved while 11,609 orders and
 * $2,927,727.03 of payment history sit committed and durable on its books.
 *
 * The damage is what the shop does next. They are migrating off their old system, they believe the
 * sentence, and they re-export "to be safe". The orders importer dedupes on
 * `csv:<sha1 of the whole file>:<row>` — so a fresh export one byte different is a different file,
 * every order imports again, and DELETE /api/contacts/:id then refuses every one of those
 * customers with has_financials. There is no way back out.
 *
 * The importer knows what it wrote; the generic handler cannot. So the count is reported from
 * here, with the cause, and with the caller's own resume instruction — which differs by route and
 * must not be guessed at: an orders file is recognised on re-upload, a customer list is recognised
 * only for rows that carry an email address.
 */
export function interruptedImportReport({ written = 0, total = 0, noun = 'row', resume = '', err } = {}) {
  const msg = String(err?.message || '')
  const full = err?.errcode === 13 || err?.code === 'ENOSPC' || /disk is full|database or disk is full|no space/i.test(msg)
  const readOnly = err?.errcode === 8 || err?.code === 'EROFS' || err?.code === 'EACCES'
    || /readonly database|read-only file system/i.test(msg)
  const cause = full
    ? ' because the disk holding this shop’s data filled up — old files under data/backups are the usual cause'
    : readOnly
      ? ' because this shop’s data directory became read-only — check that it still belongs to the account the service runs as'
      : ` — ${msg.slice(0, 160)}`
  const n = (c) => `${shopFormat().number(c)} ${noun}${c === 1 ? '' : 's'}`
  const landed = written > 0
    ? `The ${n(written)} already written ${written === 1 ? 'is' : 'are'} on the books — nothing has been lost.`
    : 'Nothing was written.'
  return {
    code: full ? 'import_stopped_disk_full' : readOnly ? 'import_stopped_readonly' : 'import_interrupted',
    imported: written,
    of: total,
    error: `The import stopped after ${n(written)} of ${shopFormat().number(total)}${cause}. ${landed}${resume ? ` ${resume}` : ''}`,
  }
}

/** Strict migration mode never treats production completion or a blank status as payment. */
export function strictImportStatus(value) {
  const s=String(value || '').trim().toLowerCase()
  if (/partial/.test(s)) return null // balance and payment allocation need an explicit migration
  if (/unpaid|invoiced|awaiting payment|balance|overdue/.test(s)) return 'unpaid'
  if (/quote|estimate|draft|pending approval/.test(s)) return 'quote'
  if (/^(paid|fully paid|settled|payment received)$/.test(s)) return 'paid'
  return null
}


/** Describe editable field → source-column mappings without writing any records. */
export function importMapping(rows, kind, supplied) {
  const synonyms = kind === 'contacts' ? COLS : ORDER_COLS
  const headers = Object.keys(rows[0] || {})
  let mapping = supplied
  if (typeof mapping === 'string') {
    try { mapping = JSON.parse(mapping) } catch { throw new Error('Column mapping must be valid JSON.') }
  }
  if (mapping != null && (typeof mapping !== 'object' || Array.isArray(mapping))) throw new Error('Column mapping must be an object.')
  for (const [field, header] of Object.entries(mapping || {})) {
    if (!Object.hasOwn(synonyms, field)) throw new Error('Unknown import field: ' + field)
    if (header !== null && (typeof header !== 'string' || !headers.includes(header))) throw new Error('Mapped column is missing: ' + field)
  }
  const resolved = Object.fromEntries(Object.entries(synonyms).map(([field, aliases]) => [field,
    mapping && Object.hasOwn(mapping, field) ? mapping[field] : aliases.find(h => headers.includes(h)) ?? null
  ]))
  return { headers, fields: Object.keys(synonyms), mapping: resolved,
    examples: Object.fromEntries(headers.map(h => [h, String(rows[0]?.[h] || '').slice(0, 100)])) }
}

/** Explicit selections suppress synonyms, including a deliberate “Do not import”. */
export function applyImportMapping(rows, kind, supplied) {
  if (supplied == null) return rows // Preserve established automatic fallback behavior for API callers.
  const { mapping } = importMapping(rows, kind, supplied)
  const synonyms = kind === 'contacts' ? COLS : ORDER_COLS
  return rows.map(row => {
    const out = Object.create(null)
    // Keep recognized apparel-size columns when mapping order fields.
    if (kind === 'orders') for (const h of Object.keys(row)) if (Object.hasOwn(SIZE_ALIASES, h)) out[h] = row[h]
    for (const [field, header] of Object.entries(mapping)) if (header !== null) out[synonyms[field][0]] = row[header]
    return out
  })
}
