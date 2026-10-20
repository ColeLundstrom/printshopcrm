/**
 * Reports — the Printavo-style "how did we do" screen: what was invoiced, what came in, sales tax,
 * who bought, what kind of work sold, and who still owes. Money, so every route is manager-only.
 *
 * Definitions match the rest of the app so no two screens disagree about the same money:
 *  - Invoiced = invoices.amount_due of non-void invoices dated in the range (credits already reduce
 *    amount_due; voids are excluded, as on the dashboard and the A/R report).
 *  - Collected = SUM(payments.amount) dated in the range — every payment row, the way Revenue MTD
 *    counts it. Refunds/voids are appended as negative payment rows (lib/payment-reversals.mjs), so
 *    this is net of reversals without any extra work.
 *  - Sales tax uses the same "known tax" rule as lib/invoice-credits.mjs creditBase(): an invoice's
 *    tax is its estimate's tax only when estimate subtotal + tax equals what was invoiced (or the
 *    frozen credit_base says so). Unknown historical tax is never guessed; it reads as zero tax.
 *    Tax collected is each payment's share of its invoice's tax (amount × tax ÷ invoice total).
 *  - Open A/R and aging are the /api/reports/ar-aging rules: non-void, balance > 0.005, days past
 *    due_date (else the created date), buckets current / 1-30 / 31-60 / 61-90 / 90+.
 *  - Every date is the SHOP's calendar day (stored timestamps are UTC), via lib/shop-time.mjs.
 */
import { all, get, round2, todayIso, shopTimezoneSetting, lineAmount, getUpcharges } from './db.mjs'
import { isoInZone, addDaysIso } from './shop-time.mjs'
import { receivableInvoice } from './receivables-review.mjs'

const ISO = /^\d{4}-\d{2}-\d{2}$/
const MAX_DAYS = 3700
const cents = (n) => Math.round((Number(n) || 0) * 100)
const fromCents = (c) => round2(c / 100)

export class ReportRangeError extends Error {}

/** True when `s` is a real calendar date in YYYY-MM-DD form (2026-02-30 is not). */
export const validIsoDate = (s) => typeof s === 'string' && ISO.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`)) && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s

/** {from, to} from a query string; defaults to this month to date on the shop's calendar. */
export function reportRange(query = {}, today = todayIso()) {
  const pick = (k) => (query[k] === undefined || query[k] === '' ? null : query[k])
  let from = pick('from'), to = pick('to')
  for (const [k, v] of [['from', from], ['to', to]]) if (v !== null && !validIsoDate(v)) throw new ReportRangeError(`${k} must be a date like 2026-01-31`)
  to = to || (from && from > today ? from : today)
  from = from || `${to.slice(0, 8)}01`
  if (from > to) throw new ReportRangeError('from must be on or before to')
  if ((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 864e5 > MAX_DAYS) throw new ReportRangeError('Pick a range of ten years or less')
  return { from, to }
}

const monthStart = (iso) => `${iso.slice(0, 8)}01`
const addMonths = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7) }
const monthsBetween = (fromYm, toYm) => { const out = []; for (let m = fromYm; m <= toYm; m = addMonths(m, 1)) out.push(m); return out }

/** Stored UTC timestamp → the shop's calendar date. A bare date is already a calendar date. */
function localDater() {
  const tz = shopTimezoneSetting()
  return (ts) => {
    const s = String(ts || '')
    if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) return s.slice(0, 10)
    const at = new Date(s.replace(' ', 'T') + (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? '' : 'Z'))
    return Number.isFinite(at.getTime()) ? isoInZone(tz, at) : s.slice(0, 10)
  }
}

const INVOICE_COLS = `i.id, i.invoice_number, i.contact_id, i.status, i.amount_due, i.amount_paid, i.credit_base, i.created_at, i.due_date,
  e.subtotal AS est_subtotal, e.tax AS est_tax, e.items AS est_items, c.name AS contact_name, c.company`
const INVOICE_JOIN = 'invoices i LEFT JOIN estimates e ON e.id = i.estimate_id LEFT JOIN contacts c ON c.id = i.contact_id'

function parseJson(s, fallback) { try { const v = JSON.parse(s); return v ?? fallback } catch { return fallback } }

/**
 * Money facts for one invoice: total, tax, pre-tax sales, the taxable part, and how the pre-tax
 * sales split across decoration types (allocated by the estimate's line amounts so it reconciles).
 */
function invoiceFacts(row, credits, upcharges) {
  const total = cents(row.amount_due)
  const credit = credits.get(row.id) || { sub: 0, tax: 0 }
  let baseTax = 0, known = false
  const frozen = row.credit_base ? parseJson(row.credit_base, null) : null
  if (frozen) { known = frozen.tax_known !== false; baseTax = cents(frozen.tax) }
  else if (row.est_subtotal != null) {
    known = cents(row.est_subtotal) + cents(row.est_tax) === total
    baseTax = cents(row.est_tax)
  }
  const tax = known ? Math.max(0, baseTax - (frozen ? credit.tax : 0)) : 0
  const sales = total - tax
  const parsed = parseJson(row.est_items || '[]', [])
  const items = Array.isArray(parsed) ? parsed : []
  const weights = new Map(); let weightSum = 0, taxableWeight = 0
  for (const it of items) {
    const amt = Number(lineAmount(it, upcharges)) || 0
    if (amt <= 0) continue
    const deco = String(it?.decoration || '').trim() || 'Other'
    weights.set(deco, (weights.get(deco) || 0) + amt)
    weightSum += amt
    if (it?.taxable !== false) taxableWeight += amt
  }
  const decorations = new Map()
  if (weightSum > 0) {
    let left = sales, i = 0
    for (const [deco, w] of weights) { const share = ++i === weights.size ? left : Math.round(sales * (w / weightSum)); decorations.set(deco, share); left -= share }
  } else decorations.set(items.length ? 'Other' : 'Not itemized', sales)
  const taxable = tax > 0 ? (weightSum > 0 ? Math.round(sales * (taxableWeight / weightSum)) : sales) : 0
  return { total, tax, sales, taxable, decorations }
}

function creditTotals() {
  const m = new Map()
  for (const r of all(`SELECT invoice_id, SUM(subtotal_cents) AS sub, SUM(tax_cents) AS tax FROM invoice_credits WHERE COALESCE(cancelled_at, '') = '' GROUP BY invoice_id`)) m.set(r.invoice_id, { sub: r.sub || 0, tax: r.tax || 0 })
  return m
}

/** A/R aging as of today — the same rules and numbers as GET /api/reports/ar-aging. */
export function arAging(today = todayIso()) {
  const open = all(`SELECT i.*, c.name AS contact_name, c.company FROM invoices i LEFT JOIN contacts c ON c.id = i.contact_id
    WHERE i.status != 'void' AND (i.amount_due - i.amount_paid) > 0.005 ORDER BY i.due_date IS NULL, i.due_date, i.id`)
  const credit = new Map(all(`SELECT invoice_id, SUM(subtotal_cents + tax_cents) AS cents FROM invoice_credits WHERE COALESCE(cancelled_at, '') = '' GROUP BY invoice_id`).map((c) => [c.invoice_id, c.cents]))
  const BUCKETS = [['current', 'Current'], ['d30', '1-30 days'], ['d60', '31-60 days'], ['d90', '61-90 days'], ['d90p', '90+ days']]
  const buckets = BUCKETS.map(([key, label]) => ({ key, label, total: 0, count: 0, invoices: [] }))
  const at = Date.parse(`${today}T00:00:00Z`)
  let due = 0
  for (const i of open) {
    const ref = i.due_date || String(i.created_at || '').slice(0, 10)
    const days = ref ? Math.floor((at - Date.parse(`${ref}T00:00:00Z`)) / 864e5) || 0 : 0
    const idx = days <= 0 ? 0 : days <= 30 ? 1 : days <= 60 ? 2 : days <= 90 ? 3 : 4
    const d = receivableInvoice(i, credit)
    const b = buckets[idx]
    b.invoices.push({ id: d.id, number: d.number, contact_id: d.contact_id, customer: d.contact_name, company: d.company, due_date: d.due_date, days_past: Math.max(0, days), amount_due: d.amount_due, amount_paid: d.amount_paid, balance: d.balance })
    b.total += cents(d.balance); b.count++; due += cents(d.balance)
  }
  for (const b of buckets) b.total = fromCents(b.total)
  return { as_of: today, total: fromCents(due), buckets }
}

/** The whole report for one date range. Pure reads; nothing is written. */
export function buildReport({ from, to }, today = todayIso()) {
  const local = localDater()
  const credits = creditTotals()
  const upcharges = getUpcharges()
  const chartFirst = addMonths(to.slice(0, 7), -11)
  const loadFrom = addDaysIso(`${(chartFirst + '-01') < from ? chartFirst + '-01' : from}`, -1)
  const loadTo = addDaysIso(to, 2)
  const inRange = (d) => d >= from && d <= to

  const months = new Map(monthsBetween(chartFirst, to.slice(0, 7)).map((m) => [m, { month: m, invoiced: 0, sales: 0, tax: 0, collected: 0, invoices: 0 }]))
  const taxMonths = new Map(monthsBetween(from.slice(0, 7), to.slice(0, 7)).map((m) => [m, { month: m, sales: 0, taxable_sales: 0, exempt_sales: 0, tax: 0, tax_collected: 0 }]))
  const customers = new Map()
  const decos = new Map()
  const cust = (r) => {
    const key = r.contact_id || 0
    if (!customers.has(key)) customers.set(key, { contact_id: r.contact_id || null, name: r.contact_name || 'Unknown', company: r.company || '', invoices: 0, invoiced: 0, collected: 0 })
    return customers.get(key)
  }

  let invoiced = 0, sales = 0, tax = 0, count = 0
  const invoices = all(`SELECT ${INVOICE_COLS} FROM ${INVOICE_JOIN} WHERE i.status != 'void' AND i.created_at >= ? AND i.created_at < ?`, loadFrom, loadTo)
  for (const r of invoices) {
    const day = local(r.created_at)
    const inChart = months.get(day.slice(0, 7))
    const f = (inChart || inRange(day)) ? invoiceFacts(r, credits, upcharges) : null
    if (!f) continue
    if (inChart && day >= `${chartFirst}-01` && day <= to) { inChart.invoiced += f.total; inChart.sales += f.sales; inChart.tax += f.tax; inChart.invoices++ }
    if (!inRange(day)) continue
    invoiced += f.total; sales += f.sales; tax += f.tax; count++
    const c = cust(r); c.invoices++; c.invoiced += f.total
    for (const [d, v] of f.decorations) decos.set(d, (decos.get(d) || 0) + v)
    const tm = taxMonths.get(day.slice(0, 7))
    if (tm) { tm.sales += f.sales; tm.taxable_sales += f.taxable; tm.exempt_sales += f.sales - f.taxable; tm.tax += f.tax }
  }

  let collected = 0, taxCollected = 0
  for (const r of all(`SELECT p.amount, p.created_at AS paid_on, ${INVOICE_COLS} FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id
      LEFT JOIN estimates e ON e.id = i.estimate_id LEFT JOIN contacts c ON c.id = i.contact_id WHERE p.created_at >= ? AND p.created_at < ?`, loadFrom, loadTo)) {
    const day = local(r.paid_on)
    const amt = cents(r.amount)
    const m = months.get(day.slice(0, 7))
    if (m && day >= `${chartFirst}-01` && day <= to) m.collected += amt
    if (!inRange(day)) continue
    collected += amt
    let share = 0
    if (r.id != null) {
      const f = invoiceFacts(r, credits, upcharges)
      share = f.total > 0 && f.tax > 0 ? Math.round(amt * (f.tax / f.total)) : 0
      cust(r).collected += amt
    }
    taxCollected += share
    const tm = taxMonths.get(day.slice(0, 7)); if (tm) tm.tax_collected += share
  }

  const est = all(`SELECT status, COALESCE(sent_at, created_at) AS sent_on, approved_at, COALESCE(subtotal, total) AS value FROM estimates
    WHERE status != 'draft' AND (COALESCE(sent_at, created_at) >= ? OR approved_at >= ?)`, addDaysIso(from, -1), addDaysIso(from, -1))
  let sent = 0, won = 0, wonValue = 0, decidedWon = 0, decided = 0
  for (const e of est) {
    const isWon = ['approved', 'invoiced'].includes(e.status)
    if (inRange(local(e.sent_on))) {
      sent++
      if (isWon) { decidedWon++; decided++ } else if (e.status === 'declined') decided++
    }
    if (isWon && e.approved_at && inRange(local(e.approved_at))) { won++; wonValue += cents(e.value) }
  }
  let jobsCompleted = 0
  for (const j of all(`SELECT ship_date, updated_at FROM jobs WHERE status = 'complete' AND (ship_date >= ? OR updated_at >= ?)`, addDaysIso(from, -1), addDaysIso(from, -1))) {
    if (inRange(j.ship_date ? String(j.ship_date).slice(0, 10) : local(j.updated_at))) jobsCompleted++
  }

  const aging = arAging(today)
  const decoTotal = [...decos.values()].reduce((a, b) => a + b, 0)
  const customerRows = [...customers.values()].map((c) => ({ ...c, invoiced: fromCents(c.invoiced), collected: fromCents(c.collected) }))
    .filter((c) => c.invoices || c.collected).sort((a, b) => b.invoiced - a.invoiced || b.collected - a.collected || a.name.localeCompare(b.name))

  return {
    from, to, today,
    summary: {
      invoiced: fromCents(invoiced), invoices: count, sales_pre_tax: fromCents(sales), collected: fromCents(collected),
      sales_tax_invoiced: fromCents(tax), sales_tax_collected: fromCents(taxCollected),
      open_ar: aging.total, overdue_ar: round2(aging.total - aging.buckets[0].total),
      estimates_sent: sent, estimates_won: won, estimates_won_value: fromCents(wonValue),
      win_rate: decided ? Math.round((100 * decidedWon) / decided) : null,
      avg_order_value: count ? fromCents(Math.round(invoiced / count)) : 0,
      jobs_completed: jobsCompleted,
    },
    sales_by_month: [...months.values()].map((m) => ({ ...m, invoiced: fromCents(m.invoiced), sales: fromCents(m.sales), tax: fromCents(m.tax), collected: fromCents(m.collected) })),
    sales_by_customer: customerRows,
    sales_by_decoration: [...decos.entries()].map(([decoration, v]) => ({ decoration, sales: fromCents(v), share: decoTotal > 0 ? Math.round((1000 * v) / decoTotal) / 10 : 0 }))
      .sort((a, b) => b.sales - a.sales),
    ar_aging: aging,
    sales_tax: [...taxMonths.values()].map((m) => ({ month: m.month, sales: fromCents(m.sales), taxable_sales: fromCents(m.taxable_sales), exempt_sales: fromCents(m.exempt_sales), tax: fromCents(m.tax), tax_collected: fromCents(m.tax_collected) })),
  }
}

// Same rules as server.mjs csvCell: neutralize formula injection, keep plain negative numbers numeric,
// quote commas, quotes and both line endings.
const CSV_NUMBER = /^-\d+(\.\d+)?([eE][-+]?\d+)?$/
export function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s) && !CSV_NUMBER.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const toCsv = (header, rows) => [header.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n') + '\n'

export const CSV_KINDS = {
  'sales-by-month': (r) => toCsv(['Month', 'Invoices', 'Invoiced', 'Sales before tax', 'Sales tax', 'Collected'],
    r.sales_by_month.map((m) => [m.month, m.invoices, m.invoiced, m.sales, m.tax, m.collected])),
  'sales-by-customer': (r) => toCsv(['Customer', 'Company', 'Invoices', 'Invoiced', 'Collected'],
    r.sales_by_customer.map((c) => [c.name, c.company, c.invoices, c.invoiced, c.collected])),
  'sales-by-decoration': (r) => toCsv(['Decoration', 'Sales before tax', 'Share %'],
    r.sales_by_decoration.map((d) => [d.decoration, d.sales, d.share])),
  'ar-aging': (r) => toCsv(['Bucket', 'Invoice', 'Customer', 'Company', 'Due date', 'Days past due', 'Invoice total', 'Paid', 'Balance'],
    r.ar_aging.buckets.flatMap((b) => b.invoices.map((i) => [b.label, i.number, i.customer, i.company, i.due_date || '', i.days_past, i.amount_due, i.amount_paid, i.balance]))),
  'sales-tax': (r) => toCsv(['Month', 'Sales before tax', 'Taxable sales', 'Exempt sales', 'Sales tax invoiced', 'Sales tax collected'],
    r.sales_tax.map((m) => [m.month, m.sales, m.taxable_sales, m.exempt_sales, m.tax, m.tax_collected])),
}

export function registerReportRoutes(app, { requireRole, wrap }) {
  const ranged = (req, res) => {
    try { return reportRange(req.query) } catch (e) {
      if (e instanceof ReportRangeError) { res.status(400).json({ error: e.message, code: 'bad_range' }); return null }
      throw e
    }
  }
  app.get('/api/reports', requireRole('manager'), wrap((req, res) => {
    const range = ranged(req, res); if (!range) return
    const r = buildReport(range)
    res.setHeader('Cache-Control', 'private, no-store')
    res.json({ ...r, sales_by_customer: r.sales_by_customer.slice(0, 25), customers_total: r.sales_by_customer.length })
  }))
  app.get('/api/reports/:kind.csv', requireRole('manager'), wrap((req, res) => {
    const make = Object.hasOwn(CSV_KINDS, req.params.kind) ? CSV_KINDS[req.params.kind] : null
    if (!make) return res.status(404).json({ error: `No report called "${req.params.kind}"` })
    const range = ranged(req, res); if (!range) return
    const body = make(buildReport(range))
    res.setHeader('Cache-Control', 'private, no-store')
    res.type('text/csv').setHeader('Content-Disposition', `attachment; filename="printshopcrm-${req.params.kind}-${range.from}-to-${range.to}.csv"`)
    res.send(body)
  }))
}
