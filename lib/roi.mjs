/**
 * Per-job ROI — "clear profit on every job."
 *
 * The research finding this whole product is built around: shops discover they underpriced
 * months later, never from a report, because no tool shows per-job margin. This is that
 * report. For every job it lays revenue against real cost — blank cost from the garment
 * catalog (live once S&S/SanMar is connected), labor at the shop's true press time and
 * utilization, screens and spoilage — and flags the money-losers.
 */
import { all, get, round2, getSettings } from './db.mjs'
import { sizeTotal, lineQty, lineAmount, pressMinutes, margin, marginVerdict } from '../public/js/shared/pricing.js'
import { costFor } from './suppliers.mjs'
import { colorsFromItems } from './capacity.mjs'

const parse = (s, f) => { try { return JSON.parse(s) } catch { return f } }

// Timestamps are stored UTC as "YYYY-MM-DD HH:MM:SS" — parse with an explicit Z or ages go negative.
const utcMs = (s) => new Date(`${String(s).replace(' ', 'T')}Z`).getTime()

// A single interval longer than one shift is not a press run — it's a job someone forgot to scan
// out on Friday. DISCARD it rather than clamping: a clamp still injects 10 invented hours of cost,
// and clamping per-interval means the invented total is unbounded.
const SHIFT_CAP_MIN = 600

/**
 * Measured production time from shop-floor SCANS: the summed wall-clock minutes the job spent in
 * the 'production' stage (scan in → scan out). This is what turns ROI from a formula into a
 * measurement — press operators never type anything; they scan a ticket.
 *
 * Only `source = 'scan'` rows count. Board drags write job_scans rows too (so the timeline is
 * complete), but a card dragged across a kanban column is not evidence a press ran: counting it
 * would silently turn "someone tidied the board on Monday" into hours of labor cost on the job.
 *
 * Returns { minutes, open, suspect } — `open` is time in an unclosed production interval (the job
 * is on the press right now), `suspect` counts discarded over-long intervals so the UI can say so.
 */
export function laborActualMinutes(jobId, { now = Date.now() } = {}) {
  const scans = all("SELECT from_stage, to_stage, created_at FROM job_scans WHERE job_id = ? AND source = 'scan' ORDER BY created_at, id", jobId)
  let enteredAt = null
  let minutes = 0
  let suspect = 0
  for (const s of scans) {
    if (s.to_stage === 'production') enteredAt = s.created_at
    else if (enteredAt && s.from_stage === 'production') {
      const mins = (utcMs(s.created_at) - utcMs(enteredAt)) / 60000
      if (mins > 0 && mins <= SHIFT_CAP_MIN) minutes += mins
      else if (mins > SHIFT_CAP_MIN) suspect += 1
      enteredAt = null
    }
  }
  // Still on the press: report it separately so a live job shows progress without booking cost.
  let open = 0
  if (enteredAt) {
    const mins = (now - utcMs(enteredAt)) / 60000
    if (mins > 0 && mins <= SHIFT_CAP_MIN) open = mins
    else if (mins > SHIFT_CAP_MIN) suspect += 1
  }
  return { minutes: Math.round(minutes), open: Math.round(open), suspect }
}

/** Cost + revenue for one job. Uses its estimate's line items when present for accuracy. */
export function jobRoi(job, settings = getSettings(), garmentRows = null) {
  const shopRate = Number(settings.shop_hourly_rate) || 75
  const util = Math.max(0.05, (Number(settings.utilization_pct) || 30) / 100)
  const spoil = 1 + (Number(settings.spoilage_pct) || 2) / 100
  const screenCost = 8 // our cost to burn/reclaim a screen
  const press = settings.press_type === 'manual' ? 'manual' : 'auto'

  const est = job.estimate_id ? get('SELECT * FROM estimates WHERE id = ?', job.estimate_id) : null
  const inv = job.invoice_id ? get('SELECT * FROM invoices WHERE id = ?', job.invoice_id) : (job.estimate_id ? get('SELECT * FROM invoices WHERE estimate_id = ?', job.estimate_id) : null)
  const items = est ? parse(est.items, []) : []

  // Revenue is what the customer agreed to, BEFORE sales tax.
  //
  // This used to read invoices.amount_due (or estimates.total), both of which are tax-inclusive —
  // amount_due is copied straight off estimates.total at conversion. Sales tax is money the shop
  // collects and remits; counting it as revenue inflated every margin on the screen by roughly the
  // tax rate. At 7.75% a job with $1,000 of work and $600 of cost reported 44.3% margin when it
  // actually made 40.0%, and the target-margin flag called it healthy against a 45% floor it was
  // five points under. The estimate editor's own margin guard already uses the pre-tax subtotal,
  // so the quote screen and the ROI report were disagreeing about the same job.
  //
  // The estimate is authoritative when there is one: the invoice is locked to it, and an estimate
  // cannot be edited once converted. Fall back to amount_due only for an invoice with no estimate
  // behind it, where no tax split was ever recorded.
  const orderValue = round2(
    est ? (Number(est.subtotal) || Number(est.total) || 0) : inv ? Number(inv.amount_due) || 0 : 0,
  )

  // An order is worth what it is worth, ONCE.
  //
  // Revenue and cost both come off the ESTIMATE, and shopRoi() sums per JOB — so an order split
  // into two production runs was sold twice. That is not an edge case: the shipped seed does it
  // (JOB-1001, 300 spirit tees, and JOB-1008, the coach polos add-on, both claim EST-1001's
  // $2,726), so a brand-new shop's Profitability page opened on $17,823.50 of revenue against
  // $15,097.50 of real work — and the documented void → re-issue recovery adds another run to the
  // same estimate every time it is used, inflating it further each round.
  //
  // Each run carries its share of the order, by the pieces it actually makes. The highest-numbered
  // run absorbs the rounding remainder, so the split sums to the order to the cent rather than
  // leaving stray pennies on the shop's books.
  const runs = job.estimate_id ? all('SELECT id, sizes FROM jobs WHERE estimate_id = ? ORDER BY id', job.estimate_id) : []
  const runPieces = (j) => sizeTotal(parse(j.sizes, {}))
  let share = 1, revenue = orderValue
  if (runs.length > 1) {
    const totalPieces = runs.reduce((s, j) => s + runPieces(j), 0)
    // No size grid anywhere (a board-typed job, an old import) — an even split is the only
    // defensible answer, and it is still exactly right in total.
    const shareOf = (j) => (totalPieces > 0 ? runPieces(j) / totalPieces : 1 / runs.length)
    share = shareOf(job)
    const parts = runs.map((j) => round2(orderValue * shareOf(j)))
    revenue = runs[runs.length - 1].id === job.id
      ? round2(orderValue - parts.slice(0, -1).reduce((s, n) => s + n, 0))
      : parts[runs.findIndex((j) => j.id === job.id)]
  }

  let garment = 0, labor = 0, screensCost = 0, pieces = 0, colors = 0, matched = true
  const up = (() => { try { return JSON.parse(settings.size_upcharges) } catch { return {} } })()

  if (items.length) {
    // The screen-setup line states the job's worst-case colour count, so resolve it once up front
    // and let it stand in for any garment line whose own description is silent about colours.
    const jobColors = colorsFromItems(items)
    for (const it of items) {
      const qty = lineQty(it)
      if (it.sizes) {
        // A garment line: blank cost × qty (+ spoilage), plus press labor for its colors.
        const c = it.garment_cost ? { cost: it.garment_cost, matched: true } : costFor(it.description, garmentRows)
        if (!c) matched = false
        garment += round2(qty * (c?.cost || estimateBlank(it)) * spoil)
        const lineColors = colorsOf(it, jobColors)
        colors = Math.max(colors, lineColors)
        pieces += qty
        labor += (pressMinutes(qty, lineColors, press) / 60) * (shopRate / util)
      } else if (/screen|setup/i.test(it.description || '')) {
        // Screen-setup line: our material cost to make those screens.
        screensCost += round2((Number(it.qty) || 0) * screenCost)
      }
      // Fee/labor lines (booth, digitizing) are close to pass-through; leave them out of cost.
    }
  } else {
    // No estimate items — estimate from the job's own size grid.
    pieces = sizeTotal(parse(job.sizes, {}))
    const sep = parse(job.separation, null)
    colors = sep ? Math.max(1, sep.colors || 1) : 1
    const c = costFor(job.garment, garmentRows)
    if (!c) matched = false
    garment = round2(pieces * (c?.cost || 4) * spoil)
    labor = (pressMinutes(pieces, colors, press) / 60) * (shopRate / util)
    screensCost = round2((sep?.screens || colors) * screenCost)
  }

  // The costs above are the whole ORDER's, because they are derived from the estimate's items.
  // Give this run its share of them, the same share its revenue got, so margin is unchanged and
  // the totals stop double-counting. Measured labor below is already per-job and is NOT scaled.
  if (share !== 1) {
    garment = round2(garment * share)
    labor *= share
    screensCost = round2(screensCost * share)
    pieces = Math.round(pieces * share)
  }

  // Planned labor comes from the press-time formula. When the floor has actually scanned the job
  // through production, the MEASURED minutes replace it — but only when the measurement is
  // plausible: a scan pair covering under a quarter of the modelled press time is someone testing
  // the scanner, not a run, and substituting it would hand the job a fake 90% margin.
  //
  // The measured hour still carries the shop's overhead loading (shopRate / util), same as the
  // modelled one. Dropping the divisor was mixing two different dollars-per-hour in one total.
  const plannedLabor = labor
  const plannedMinutes = pressMinutes(pieces, colors || 1, press)
  const measured = laborActualMinutes(job.id)
  const credible = measured.minutes > 0 && (plannedMinutes <= 0 || measured.minutes >= plannedMinutes * 0.25)
  if (credible) labor = (measured.minutes / 60) * (shopRate / util)

  const cost = round2(garment + labor + screensCost)
  const m = margin(revenue, cost)
  const hours = round2(pressMinutes(pieces, colors || 1, press) / 60)
  return {
    job_id: job.id, job_number: job.job_number, title: job.title, stage: job.stage, status: job.status,
    pieces, colors, revenue, cost,
    breakdown: { garment: round2(garment), labor: round2(labor), screens: screensCost },
    labor_planned: round2(plannedLabor),
    labor_planned_minutes: Math.round(plannedMinutes),
    labor_actual_minutes: measured.minutes,
    labor_open_minutes: measured.open,
    labor_suspect_intervals: measured.suspect,
    labor_measured: credible,
    profit: m.profit, margin: m.margin, verdict: marginVerdict(m.margin),
    value_per_hour: hours > 0 ? Math.round(revenue / hours) : 0,
    blank_matched: matched,
  }
}

/**
 * Ink colours one line runs — read through the SAME definition the scheduler uses.
 *
 * This read `it.locations` and `it.detail`, and no quote this app has ever written carries either
 * field, so every garment line fell through to 1 and every job on the profitability page was
 * costed at a single colour. The capacity engine had exactly this bug and it was fixed there
 * (colorsFromItems, lib/capacity.mjs) — but only there, so the two screens then disagreed about
 * the same job: a 300-piece 4/0-front + 2/0-back run booked 132 press-minutes on the schedule and
 * 57 in its cost, and the margin came out 78.3% on work that was nowhere near it. Cost and hours
 * have to tell one story, so colour now has one definition, the way tax does.
 *
 * Per line first, because a job can run a 6-colour front on tees and a 1-colour left chest on
 * caps and they do not cost the same. When the line's own description states nothing, the job-wide
 * count stands in — that is what the screen-setup line on the estimate was billed for.
 */
const colorsOf = (it, jobWide = 0) => colorsFromItems([it]) || jobWide || 1
// If we can't match a blank, assume our cost is ~40% of the per-piece sell price — conservative.
const estimateBlank = (it) => round2((Number(it.unit_price) || 0) * 0.4)

/** Shop-wide profitability across all jobs (optionally only completed). */
export function shopRoi({ completedOnly = false } = {}) {
  const settings = getSettings()
  const jobs = all(`SELECT * FROM jobs ${completedOnly ? "WHERE stage='complete'" : ''} ORDER BY id DESC`)
  const garmentRows = all('SELECT * FROM garments')   // load the catalog ONCE for the whole sweep
  const rows = jobs.map((j) => jobRoi(j, settings, garmentRows)).filter((r) => r.revenue > 0)
  const revenue = round2(rows.reduce((s, r) => s + r.revenue, 0))
  const cost = round2(rows.reduce((s, r) => s + r.cost, 0))
  const profit = round2(revenue - cost)
  const sorted = [...rows].sort((a, b) => b.margin - a.margin)
  // "Watch" means actual risk — below the shop's own target margin — not merely the lowest-ranked
  // of an otherwise-healthy list. A warning that flags a 49% job trains people to ignore warnings.
  const target = Number(settings.target_margin_pct) || 45
  const belowTarget = sorted.filter((r) => r.margin < target).sort((a, b) => a.margin - b.margin)
  return {
    jobs: rows,
    totals: {
      revenue, cost, profit,
      margin: revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : 0,
      count: rows.length,
      losers: rows.filter((r) => r.margin < 0).length,
      thin: rows.filter((r) => r.margin >= 0 && r.margin < 25).length,
      below_target: belowTarget.length,
      target,
    },
    best: sorted.slice(0, 3),
    worst: belowTarget.slice(0, 8), // only jobs genuinely under target — empty when everything's healthy
  }
}
