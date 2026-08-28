/**
 * Minimal PDF writer — text + rules only, no external deps.
 * Emits PDF 1.4 with the two base-14 Helvetica faces, which every reader has built in.
 */
import { sizeSummary, sizeTotal, lineQty, lineAmount, lineUpcharge, SIZES } from '../public/js/shared/pricing.js'

const PAGE_W = 612
const PAGE_H = 792
const MARGIN = 54

// Helvetica advance widths (per 1000 units) for the printable ASCII range, so
// right-aligned money columns and centered text actually land where intended.
const W_REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584]
const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584]

// WinAnsi covers latin-1, but the base-14 metrics here are ASCII-only, so fold the
// punctuation people actually paste (smart quotes, dashes) instead of dropping it.
const FOLD = { '—': '-', '–': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', '•': '-', '×': 'x', '→': '->', ' ': ' ' }
const fold = (s) => String(s ?? '').replace(/[—–‘’“”…•×→ ]/g, (c) => FOLD[c])

const textWidth = (s, size, bold) => {
  const t = bold ? W_BOLD : W_REG
  let w = 0
  for (const ch of fold(s)) {
    const c = ch.charCodeAt(0)
    w += c >= 32 && c <= 126 ? t[c - 32] : 556
  }
  return (w * size) / 1000
}

// Keep the characters the font can actually draw, substitute the ones it can't — never strip.
// The font is Helvetica with WinAnsiEncoding, and the buffer is emitted as latin1, so every code
// point in 0xA0–0xFF (é ñ ü á à ç ø å …) renders correctly by writing its own byte. The old code
// deleted everything outside 0x20–0x7E, so "José Muñoz" printed "Jos Muoz" and a name in a script
// the font has no glyph for — Chinese, Arabic, Cyrillic — left the whole BILL TO line blank. A
// blank name on an invoice is worse than a transliteration gap: substitute '?' so the line is
// never empty, and the shop can see something was there. Smart punctuation is already folded above.
const esc = (s) =>
  fold(s)
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, (c) => (c.trim() ? '?' : ' '))
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')

/** Greedy wrap to a pixel width. */
function wrap(text, size, bold, maxW) {
  const out = []
  for (const para of String(text ?? '').split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const test = line ? `${line} ${word}` : word
      if (textWidth(test, size, bold) > maxW && line) {
        out.push(line)
        line = word
      } else line = test
    }
    out.push(line)
  }
  return out
}

const clip = (s, size, bold, maxW) => {
  let t = String(s ?? '')
  if (textWidth(t, size, bold) <= maxW) return t
  while (t.length > 1 && textWidth(`${t}...`, size, bold) > maxW) t = t.slice(0, -1)
  return `${t}...`
}

class Page {
  constructor() { this.ops = [] }
  text(x, y, s, { size = 10, bold = false, color = [0.13, 0.14, 0.16], align = 'left', width = 0 } = {}) {
    let px = x
    if (align === 'right') px = x - textWidth(s, size, bold)
    else if (align === 'center') px = x + (width - textWidth(s, size, bold)) / 2
    this.ops.push(`BT ${color.join(' ')} rg /${bold ? 'F2' : 'F1'} ${size} Tf 1 0 0 1 ${px.toFixed(2)} ${(PAGE_H - y).toFixed(2)} Tm (${esc(s)}) Tj ET`)
  }
  rect(x, y, w, h, color) {
    this.ops.push(`${color.join(' ')} rg ${x.toFixed(2)} ${(PAGE_H - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`)
  }
  line(x1, y1, x2, y2, color = [0.85, 0.86, 0.88], w = 0.7) {
    this.ops.push(`${color.join(' ')} RG ${w} w ${x1.toFixed(2)} ${(PAGE_H - y1).toFixed(2)} m ${x2.toFixed(2)} ${(PAGE_H - y2).toFixed(2)} l S`)
  }
  toString() { return this.ops.join('\n') }
}

function build(pages) {
  const objs = []
  const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ')
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'
  pages.forEach((p, i) => {
    const pageId = 5 + i * 2
    const contentId = pageId + 1
    objs[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`
    const body = p.toString()
    objs[contentId] = `<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`
  })

  let pdf = '%PDF-1.4\n'
  const offsets = []
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = Buffer.byteLength(pdf)
    pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`
  }
  const xrefAt = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objs.length}\n0000000000 65535 f \n`
  for (let i = 1; i < objs.length; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

// Negatives read as -$40.00, not $-40.00 — discount credits appear on the printed document.
const money = (n) => { const v = Number(n) || 0; return `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` }
const INK = [0.13, 0.14, 0.16]
const MUTED = [0.42, 0.45, 0.5]
const ACCENT = [0.02, 0.71, 0.51]

/**
 * Render an estimate or invoice.
 * @param {'ESTIMATE'|'INVOICE'} kind
 */
export function renderDocument(kind, { doc, contact, settings, items, payments = [], upcharges }) {
  const pages = []
  const COLS = { desc: MARGIN, qty: 372, price: 452, total: PAGE_W - MARGIN }
  const bodyW = PAGE_W - MARGIN * 2

  const newPage = (continued) => {
    const p = new Page()
    pages.push(p)
    p.rect(0, 0, PAGE_W, 6, ACCENT)
    p.text(MARGIN, 52, settings.shop_name, { size: 17, bold: true })
    p.text(MARGIN, 68, settings.shop_tagline, { size: 8.5, color: MUTED })
    p.text(PAGE_W - MARGIN, 46, kind + (continued ? ' (cont.)' : ''), { size: 20, bold: true, align: 'right', color: ACCENT })
    p.text(PAGE_W - MARGIN, 64, kind === 'ESTIMATE' ? doc.estimate_number : doc.invoice_number, { size: 10, align: 'right', color: MUTED })
    return p
  }

  let p = newPage(false)
  let y = 96

  // Shop block / bill-to block
  for (const [i, ln] of [settings.shop_address, settings.shop_phone, settings.shop_email].filter(Boolean).entries()) {
    p.text(MARGIN, y + i * 12, ln, { size: 8.5, color: MUTED })
  }

  p.text(340, y, 'BILL TO', { size: 8, bold: true, color: MUTED })
  p.text(340, y + 15, contact?.name || '—', { size: 11, bold: true })
  const billLines = [contact?.company, contact?.email, contact?.phone].filter(Boolean)
  billLines.forEach((ln, i) => p.text(340, y + 29 + i * 11.5, ln, { size: 8.5, color: MUTED }))

  y += 62

  // Meta strip
  p.rect(MARGIN, y, bodyW, 30, [0.96, 0.97, 0.98])
  const meta = [['Date', (doc.created_at || '').slice(0, 10)]]
  if (kind === 'INVOICE') meta.push(['Due', doc.due_date || '—'], ['Status', String(doc.status || '').toUpperCase()])
  else meta.push(['Status', String(doc.status || '').toUpperCase()], ['Valid', '30 days'])
  meta.forEach(([k, v], i) => {
    const x = MARGIN + 14 + i * 160
    p.text(x, y + 12, k.toUpperCase(), { size: 7, bold: true, color: MUTED })
    p.text(x, y + 23, v, { size: 9 })
  })
  y += 52

  // Table header
  const header = () => {
    p.text(COLS.desc, y, 'DESCRIPTION', { size: 7.5, bold: true, color: MUTED })
    p.text(COLS.qty, y, 'QTY', { size: 7.5, bold: true, color: MUTED, align: 'right' })
    p.text(COLS.price, y, 'RATE', { size: 7.5, bold: true, color: MUTED, align: 'right' })
    p.text(COLS.total, y, 'AMOUNT', { size: 7.5, bold: true, color: MUTED, align: 'right' })
    y += 6
    p.line(MARGIN, y, PAGE_W - MARGIN, y, [0.8, 0.82, 0.85])
    y += 16
  }
  header()

  for (const it of items) {
    const detailLines = it.detail ? wrap(it.detail, 8, false, 300) : []
    // The size run is the part the customer checks hardest — print it, don't summarize it.
    const sizeLines = it.sizes ? wrap(sizeSummary(it.sizes), 8, false, 300) : []
    const extra = lineUpcharge(it, upcharges)
    const rowH = 16 + detailLines.length * 10 + sizeLines.length * 10
    if (y + rowH > PAGE_H - 130) {
      p = newPage(true)
      y = 96
      header()
    }
    p.text(COLS.desc, y, clip(it.description || 'Item', 9.5, true, 300), { size: 9.5, bold: true })
    let dy = y + 11
    detailLines.forEach((ln) => { p.text(COLS.desc, dy, ln, { size: 8, color: MUTED }); dy += 10 })
    sizeLines.forEach((ln) => { p.text(COLS.desc, dy, ln, { size: 8, color: ACCENT }); dy += 10 })
    p.text(COLS.qty, y, String(lineQty(it) || ''), { size: 9.5, align: 'right' })
    p.text(COLS.price, y, money(it.unit_price), { size: 9.5, align: 'right' })
    if (extra) p.text(COLS.price, y + 10, `+${money(extra)} sizes`, { size: 7, align: 'right', color: MUTED })
    p.text(COLS.total, y, money(lineAmount(it, upcharges)), { size: 9.5, align: 'right', bold: true })
    y += rowH
    p.line(MARGIN, y - 6, PAGE_W - MARGIN, y - 6, [0.92, 0.93, 0.94], 0.5)
  }

  // Totals
  if (y > PAGE_H - 200) { p = newPage(true); y = 96 }
  y += 8
  const tx = PAGE_W - MARGIN
  const rows = [['Subtotal', money(doc.subtotal ?? doc.amount_due)]]
  // Show the tax line whenever there is tax (both estimates and invoices), so Subtotal + Tax = Total.
  // The rate stored on the document, not the shop's current setting — a rate change must not
  // retroactively relabel the tax line on quotes that were already sent.
  if (Number(doc.tax) > 0) rows.push([`Tax (${doc.tax_rate ?? settings.tax_rate}%)`, money(doc.tax)])
  rows.push(['TOTAL', money(kind === 'ESTIMATE' ? doc.total : doc.amount_due)])
  if (kind === 'INVOICE') {
    for (const pay of payments) rows.push([`Payment — ${pay.method} ${(pay.created_at || '').slice(0, 10)}`, `-${money(pay.amount)}`])
    rows.push(['BALANCE DUE', money((doc.amount_due || 0) - (doc.amount_paid || 0))])
  }
  rows.forEach(([k, v], i) => {
    const strong = k === 'TOTAL' || k === 'BALANCE DUE'
    if (strong) { p.line(tx - 230, y - 5, tx, y - 5, [0.8, 0.82, 0.85]); y += 4 }
    p.text(tx - 230, y, k, { size: strong ? 10.5 : 9, bold: strong, color: strong ? INK : MUTED })
    p.text(tx, y, v, { size: strong ? 11.5 : 9, bold: strong, align: 'right', color: strong && k === 'BALANCE DUE' ? ACCENT : INK })
    y += strong ? 18 : 14
  })

  // Terms + notes pinned to the last page
  const terms = kind === 'ESTIMATE' ? settings.estimate_terms : settings.invoice_terms
  let ty = PAGE_H - 118
  if (doc.notes) {
    p.text(MARGIN, ty, 'NOTES', { size: 7.5, bold: true, color: MUTED })
    wrap(doc.notes, 8.5, false, bodyW).slice(0, 3).forEach((ln, i) => p.text(MARGIN, ty + 12 + i * 10, ln, { size: 8.5 }))
    ty += 48
  }
  p.text(MARGIN, ty, 'TERMS', { size: 7.5, bold: true, color: MUTED })
  wrap(terms, 8, false, bodyW).slice(0, 3).forEach((ln, i) => p.text(MARGIN, ty + 11 + i * 9.5, ln, { size: 8, color: MUTED }))

  pages.forEach((pg, i) => {
    pg.line(MARGIN, PAGE_H - 44, PAGE_W - MARGIN, PAGE_H - 44, [0.9, 0.91, 0.92])
    pg.text(MARGIN, PAGE_H - 32, `${settings.shop_name}${settings.shop_phone ? ` — ${settings.shop_phone}` : ''}`, { size: 7.5, color: MUTED })
    pg.text(PAGE_W - MARGIN, PAGE_H - 32, `Page ${i + 1} of ${pages.length}`, { size: 7.5, color: MUTED, align: 'right' })
  })

  return build(pages)
}

/**
 * A single-page fulfillment header: accent bar, shop name/tagline, and a big title.
 * Shared by the packing slip and pick ticket so they read as one document family.
 */
function fulfillmentHeader(p, settings, title, ref) {
  p.rect(0, 0, PAGE_W, 6, ACCENT)
  p.text(MARGIN, 52, settings.shop_name, { size: 17, bold: true })
  if (settings.shop_tagline) p.text(MARGIN, 68, settings.shop_tagline, { size: 8.5, color: MUTED })
  p.text(PAGE_W - MARGIN, 46, title, { size: 20, bold: true, align: 'right', color: ACCENT })
  if (ref) p.text(PAGE_W - MARGIN, 64, ref, { size: 10, align: 'right', color: MUTED })
}

/**
 * Draw a size-breakdown grid (sizes across the top, quantities beneath) starting at y.
 * Only sizes with a quantity are shown; the last column is TOTAL. Returns the new y.
 * When `check` is set each size gets a boxed ✓ cell for hand-marking on the floor.
 */
function sizeGrid(p, x, y, sizes, { check = false } = {}) {
  const present = SIZES.filter((s) => Number(sizes?.[s]) > 0)
  if (!present.length) { p.text(x, y + 14, 'No sizes on file', { size: 9, color: MUTED }); return y + 26 }
  const cols = [...present, 'TOTAL']
  const cw = 46
  const rowH = check ? 30 : 22
  const gridW = cols.length * cw
  // Header band
  p.rect(x, y, gridW, 18, [0.96, 0.97, 0.98])
  cols.forEach((s, i) => p.text(x + i * cw, y + 12, s, { size: 8.5, bold: true, color: s === 'TOTAL' ? INK : MUTED, align: 'center', width: cw }))
  y += 18
  // Quantity row
  const total = sizeTotal(sizes)
  cols.forEach((s, i) => {
    const v = s === 'TOTAL' ? total : sizes[s]
    p.text(x + i * cw, y + 15, String(v), { size: s === 'TOTAL' ? 11 : 10.5, bold: s === 'TOTAL', color: INK, align: 'center', width: cw })
  })
  if (check) {
    // A boxed cell under each size for the picker to tick as they pull it.
    present.forEach((s, i) => p.rect(x + i * cw + cw / 2 - 6, y + 20, 12, 12, [0.9, 0.91, 0.92]))
    present.forEach((s, i) => p.rect(x + i * cw + cw / 2 - 5.2, y + 20.8, 10.4, 10.4, [1, 1, 1]))
  }
  y += rowH
  // Column rules + outer frame
  for (let i = 0; i <= cols.length; i++) p.line(x + i * cw, y - rowH - 18, x + i * cw, y, [0.88, 0.89, 0.91], 0.5)
  p.line(x, y - rowH - 18, x + gridW, y - rowH - 18, [0.8, 0.82, 0.85])
  p.line(x, y, x + gridW, y, [0.8, 0.82, 0.85])
  return y
}

/**
 * Packing slip — what's in the box, no money. Printavo ships one on every tier.
 * @param {{ job:object, contact:object, settings:object, items:Array }} args
 */
export function packingSlip({ job, contact, settings, items = [] }) {
  const p = new Page()
  const ref = job?.job_number ? `Job ${job.job_number}` : ''
  fulfillmentHeader(p, settings, 'PACKING SLIP', ref)

  let y = 96
  // Shop block
  for (const [i, ln] of [settings.shop_address, settings.shop_phone, settings.shop_email].filter(Boolean).entries()) {
    p.text(MARGIN, y + i * 12, ln, { size: 8.5, color: MUTED })
  }

  // Ship-to block
  p.text(340, y, 'SHIP TO', { size: 8, bold: true, color: MUTED })
  p.text(340, y + 15, contact?.name || '—', { size: 11, bold: true })
  const shipLines = [contact?.company, contact?.address, contact?.email, contact?.phone].filter(Boolean)
  shipLines.forEach((ln, i) => p.text(340, y + 29 + i * 11.5, ln, { size: 8.5, color: MUTED }))

  y += 62

  // Meta strip: job / order ref / date
  const bodyW = PAGE_W - MARGIN * 2
  p.rect(MARGIN, y, bodyW, 30, [0.96, 0.97, 0.98])
  const meta = [
    ['Job', job?.job_number || '—'],
    ['PO / Ref', job?.po_number || job?.order_ref || job?.reference || '—'],
    ['Date', (job?.shipped_at || job?.created_at || new Date().toISOString()).slice(0, 10)],
  ]
  meta.forEach(([k, v], i) => {
    const x = MARGIN + 14 + i * 160
    p.text(x, y + 12, k.toUpperCase(), { size: 7, bold: true, color: MUTED })
    p.text(x, y + 23, v, { size: 9 })
  })
  y += 52

  // Contents — one block per garment: description + its size grid. No prices.
  p.text(MARGIN, y, 'CONTENTS', { size: 7.5, bold: true, color: MUTED })
  y += 6
  p.line(MARGIN, y, PAGE_W - MARGIN, y, [0.8, 0.82, 0.85])
  y += 18

  let grand = 0
  for (const it of items) {
    if (y > PAGE_H - 150) break // single page by design; overflow is rare on a slip
    p.text(MARGIN, y, clip(it.description || 'Item', 10.5, true, bodyW), { size: 10.5, bold: true })
    y += 4
    if (it.detail) { wrap(it.detail, 8, false, bodyW).slice(0, 2).forEach((ln, i) => p.text(MARGIN, y + 9 + i * 10, ln, { size: 8, color: MUTED })); y += 9 + Math.min(2, wrap(it.detail, 8, false, bodyW).length) * 10 }
    else y += 8
    y = sizeGrid(p, MARGIN, y, it.sizes)
    grand += sizeTotal(it.sizes)
    y += 18
  }

  // Total units
  if (y < PAGE_H - 150) {
    p.line(PAGE_W - MARGIN - 200, y, PAGE_W - MARGIN, y, [0.8, 0.82, 0.85])
    y += 4
    p.text(PAGE_W - MARGIN - 200, y + 12, 'TOTAL UNITS', { size: 9, bold: true, color: MUTED })
    p.text(PAGE_W - MARGIN, y + 12, String(grand), { size: 12, bold: true, align: 'right' })
    y += 30
  }

  // Received-by / date line, pinned near the footer
  let ry = PAGE_H - 96
  p.text(MARGIN, ry, 'RECEIVED BY', { size: 7.5, bold: true, color: MUTED })
  p.line(MARGIN + 78, ry + 2, MARGIN + 300, ry + 2, [0.6, 0.62, 0.65])
  p.text(MARGIN + 320, ry, 'DATE', { size: 7.5, bold: true, color: MUTED })
  p.line(MARGIN + 352, ry + 2, PAGE_W - MARGIN, ry + 2, [0.6, 0.62, 0.65])

  // Footer
  p.line(MARGIN, PAGE_H - 44, PAGE_W - MARGIN, PAGE_H - 44, [0.9, 0.91, 0.92])
  p.text(MARGIN, PAGE_H - 32, `${settings.shop_name}${settings.shop_phone ? ` — ${settings.shop_phone}` : ''}`, { size: 7.5, color: MUTED })
  p.text(PAGE_W - MARGIN, PAGE_H - 32, 'Packing slip — no charge', { size: 7.5, color: MUTED, align: 'right' })

  return build([p])
}

/**
 * Pick ticket — a floor sheet: giant job number, a checkable size pick list, decoration + due.
 *
 * `lines` is the job's per-garment grids ([{ description, garment, sizes }]); one PICK LIST block
 * is emitted per garment with its own subtotal, then a grand total. A merged grid cannot be
 * picked from when an order has two styles — "50 L" told the warehouse to pull 50 large when only
 * 30 of those were tees and 20 were hoodies. `sizes` stays supported for callers that only have
 * the flat grid.
 * @param {{ job:object, settings:object, sizes?:object, lines?:Array }} args
 */
export function pickTicket({ job, settings, sizes = {}, lines = null }) {
  const blocks = (Array.isArray(lines) && lines.length ? lines : [{ garment: job?.garment || '', sizes }])
    .filter((b) => b && SIZES.some((s) => Number(b.sizes?.[s]) > 0))
  const grand = blocks.reduce((s, b) => s + sizeTotal(b.sizes), 0)
  return pickTicketPage({ job, settings, blocks, grand })
}

function pickTicketPage({ job, settings, blocks, grand }) {
  const p = new Page()
  fulfillmentHeader(p, settings, 'PICK TICKET', '')

  let y = 100
  // Big job number so it reads across the shop floor.
  p.text(MARGIN, y, 'JOB', { size: 9, bold: true, color: MUTED })
  p.text(MARGIN, y + 34, job?.job_number || '—', { size: 34, bold: true })
  y += 60

  // Meta strip: decoration + due date
  const bodyW = PAGE_W - MARGIN * 2
  p.rect(MARGIN, y, bodyW, 30, [0.96, 0.97, 0.98])
  const meta = [
    ['Decoration', job?.decoration || job?.print_method || '—'],
    ['Due', (job?.due_date || '—')],
    ['Units', String(grand)],
  ]
  meta.forEach(([k, v], i) => {
    const x = MARGIN + 14 + i * 170
    p.text(x, y + 12, k.toUpperCase(), { size: 7, bold: true, color: MUTED })
    p.text(x, y + 23, clip(v, 9, false, 150), { size: 9 })
  })
  y += 56

  // Pick list — Size | Qty | ✓ picked, one row per size, big touch-friendly checkbox.
  p.text(MARGIN, y, 'PICK LIST', { size: 7.5, bold: true, color: MUTED })
  y += 8
  const c = { size: MARGIN, qty: MARGIN + 140, chk: PAGE_W - MARGIN - 40 }
  p.text(c.size, y, 'SIZE', { size: 7.5, bold: true, color: MUTED })
  p.text(c.qty, y, 'QTY', { size: 7.5, bold: true, color: MUTED })
  p.text(c.chk, y, 'PICKED', { size: 7.5, bold: true, color: MUTED })
  y += 6
  p.line(MARGIN, y, PAGE_W - MARGIN, y, [0.8, 0.82, 0.85])
  y += 4

  if (!blocks.length) {
    p.text(MARGIN, y + 20, 'No sizes on file', { size: 10, color: MUTED })
    y += 30
  } else {
    for (const b of blocks) {
      // Name the garment above its own grid. Without it a picker holding a two-style ticket has
      // no way to know which rack a row belongs to.
      if (blocks.length > 1 || b.garment || b.description) {
        p.text(MARGIN, y + 12, clip(b.description || b.garment || '—', 10, true, PAGE_W - MARGIN * 2), { size: 10, bold: true })
        y += 20
      }
      for (const s of SIZES.filter((s) => Number(b.sizes?.[s]) > 0)) {
        const rowH = 30
        p.text(c.size, y + 20, s, { size: 13, bold: true })
        p.text(c.qty, y + 20, String(b.sizes[s]), { size: 13 })
        // Checkbox: outer rule + white fill so it prints as a clean box to tick.
        p.rect(c.chk, y + 8, 16, 16, [0.6, 0.62, 0.65])
        p.rect(c.chk + 1, y + 9, 14, 14, [1, 1, 1])
        y += rowH
        p.line(MARGIN, y, PAGE_W - MARGIN, y, [0.92, 0.93, 0.94], 0.5)
      }
      if (blocks.length > 1) {
        y += 4
        p.text(c.size, y + 12, 'SUBTOTAL', { size: 9, bold: true, color: MUTED })
        p.text(c.qty, y + 12, String(sizeTotal(b.sizes)), { size: 11, bold: true })
        y += 24
      }
    }
    // Grand total row
    y += 4
    p.line(MARGIN, y, PAGE_W - MARGIN, y, [0.8, 0.82, 0.85])
    y += 6
    p.text(c.size, y + 12, 'TOTAL', { size: 11, bold: true, color: MUTED })
    p.text(c.qty, y + 12, String(grand), { size: 13, bold: true })
    y += 26
  }

  // Picked-by / date line near the footer
  const ry = PAGE_H - 96
  p.text(MARGIN, ry, 'PICKED BY', { size: 7.5, bold: true, color: MUTED })
  p.line(MARGIN + 68, ry + 2, MARGIN + 290, ry + 2, [0.6, 0.62, 0.65])
  p.text(MARGIN + 320, ry, 'DATE', { size: 7.5, bold: true, color: MUTED })
  p.line(MARGIN + 352, ry + 2, PAGE_W - MARGIN, ry + 2, [0.6, 0.62, 0.65])

  // Footer
  p.line(MARGIN, PAGE_H - 44, PAGE_W - MARGIN, PAGE_H - 44, [0.9, 0.91, 0.92])
  p.text(MARGIN, PAGE_H - 32, `${settings.shop_name}${settings.shop_phone ? ` — ${settings.shop_phone}` : ''}`, { size: 7.5, color: MUTED })
  p.text(PAGE_W - MARGIN, PAGE_H - 32, job?.job_number ? `Pick ticket — ${job.job_number}` : 'Pick ticket', { size: 7.5, color: MUTED, align: 'right' })

  return build([p])
}

/**
 * Customer statement — every open (and recent) invoice on one document, with an aging strip.
 * The document a bookkeeper actually asks for: InkSoft's users report they "can't generate an
 * accurate AR aging report"; here it's one click from the customer record.
 *
 * @param {{ contact:object, settings:object, invoices:Array, asOf?:string }} args
 *   invoices rows must carry invoice_number, created_at, due_date, status, amount_due, amount_paid.
 */
export function customerStatement({ contact, settings, invoices = [], asOf = new Date().toISOString().slice(0, 10) }) {
  const pages = []
  const bal = (i) => Math.round(((Number(i.amount_due) || 0) - (Number(i.amount_paid) || 0)) * 100) / 100
  const daysPast = (i) => {
    const ref = i.due_date || String(i.created_at || '').slice(0, 10)
    if (!ref) return 0
    return Math.floor((new Date(`${asOf}T00:00:00Z`) - new Date(`${ref}T00:00:00Z`)) / 864e5)
  }
  const buckets = { current: 0, d30: 0, d60: 0, d90: 0, d90p: 0 }
  for (const i of invoices) {
    const b = bal(i)
    if (b <= 0) continue
    const d = daysPast(i)
    if (d <= 0) buckets.current += b
    else if (d <= 30) buckets.d30 += b
    else if (d <= 60) buckets.d60 += b
    else if (d <= 90) buckets.d90 += b
    else buckets.d90p += b
  }
  const totalDue = Math.round((buckets.current + buckets.d30 + buckets.d60 + buckets.d90 + buckets.d90p) * 100) / 100

  const COLS = { date: MARGIN, num: MARGIN + 78, due: MARGIN + 190, status: MARGIN + 268, total: 420, paid: 480, bal: PAGE_W - MARGIN }
  let p
  let y
  const newPage = (continued) => {
    p = new Page()
    pages.push(p)
    fulfillmentHeader(p, settings, 'STATEMENT', `as of ${asOf}${continued ? ' (cont.)' : ''}`)
    y = 96
    if (!continued) {
      p.text(MARGIN, y, 'FOR', { size: 8, bold: true, color: MUTED })
      p.text(MARGIN, y + 15, contact?.company || contact?.name || 'Customer', { size: 11.5, bold: true })
      if (contact?.company && contact?.name) p.text(MARGIN, y + 29, contact.name, { size: 9, color: MUTED })
      if (contact?.email) p.text(MARGIN, y + 42, contact.email, { size: 9, color: MUTED })
      p.text(PAGE_W - MARGIN, y, 'TOTAL DUE', { size: 8, bold: true, color: MUTED, align: 'right' })
      p.text(PAGE_W - MARGIN, y + 22, money(totalDue), { size: 19, bold: true, align: 'right', color: totalDue > 0 ? INK : ACCENT })
      y += 62
      // Aging strip
      const cells = [['CURRENT', buckets.current], ['1-30 DAYS', buckets.d30], ['31-60', buckets.d60], ['61-90', buckets.d90], ['90+', buckets.d90p]]
      const cw = (PAGE_W - MARGIN * 2) / cells.length
      p.rect(MARGIN, y, PAGE_W - MARGIN * 2, 34, [0.96, 0.97, 0.98])
      cells.forEach(([label, v], i) => {
        const late = i >= 3 && v > 0
        p.text(MARGIN + i * cw, y + 13, label, { size: 7.5, bold: true, color: MUTED, align: 'center', width: cw })
        p.text(MARGIN + i * cw, y + 27, money(v), { size: 10, bold: v > 0, color: late ? [0.8, 0.25, 0.2] : INK, align: 'center', width: cw })
      })
      y += 48
    }
    // Table head
    p.text(COLS.date, y, 'DATE', { size: 8, bold: true, color: MUTED })
    p.text(COLS.num, y, 'INVOICE', { size: 8, bold: true, color: MUTED })
    p.text(COLS.due, y, 'DUE', { size: 8, bold: true, color: MUTED })
    p.text(COLS.status, y, 'STATUS', { size: 8, bold: true, color: MUTED })
    p.text(COLS.total, y, 'TOTAL', { size: 8, bold: true, color: MUTED, align: 'right' })
    p.text(COLS.paid, y, 'PAID', { size: 8, bold: true, color: MUTED, align: 'right' })
    p.text(COLS.bal, y, 'BALANCE', { size: 8, bold: true, color: MUTED, align: 'right' })
    y += 6
    p.line(MARGIN, y, PAGE_W - MARGIN, y, [0.8, 0.82, 0.85])
    y += 14
  }
  newPage(false)

  for (const i of invoices) {
    if (y > PAGE_H - 120) newPage(true)
    const b = bal(i)
    const late = b > 0 && daysPast(i) > 0
    p.text(COLS.date, y, String(i.created_at || '').slice(0, 10), { size: 9 })
    p.text(COLS.num, y, String(i.invoice_number || ''), { size: 9, bold: true })
    p.text(COLS.due, y, i.due_date || '—', { size: 9, color: late ? [0.8, 0.25, 0.2] : INK })
    p.text(COLS.status, y, String(i.status || '').toUpperCase(), { size: 8, color: b > 0 ? (late ? [0.8, 0.25, 0.2] : MUTED) : ACCENT })
    p.text(COLS.total, y, money(i.amount_due), { size: 9, align: 'right' })
    p.text(COLS.paid, y, money(i.amount_paid), { size: 9, align: 'right', color: MUTED })
    p.text(COLS.bal, y, money(b), { size: 9, bold: b > 0, align: 'right', color: b > 0 ? INK : MUTED })
    y += 16
  }
  if (!invoices.length) p.text(MARGIN, y, 'No invoices on file.', { size: 9.5, color: MUTED })

  // Footer on every page
  pages.forEach((pg, i) => {
    pg.line(MARGIN, PAGE_H - 44, PAGE_W - MARGIN, PAGE_H - 44, [0.9, 0.91, 0.92])
    pg.text(MARGIN, PAGE_H - 32, `${settings.shop_name}${settings.shop_phone ? ` — ${settings.shop_phone}` : ''}`, { size: 7.5, color: MUTED })
    pg.text(PAGE_W - MARGIN, PAGE_H - 32, `Statement — page ${i + 1} of ${pages.length}`, { size: 7.5, color: MUTED, align: 'right' })
  })

  return build(pages)
}
