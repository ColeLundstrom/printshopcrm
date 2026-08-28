/**
 * Paste-to-estimate.
 *
 * One entry point that turns a blob of free text — a forwarded email, a Slack message, a phone
 * note — into a real draft estimate against a real customer. This is the thing a shop actually
 * wants: paste what the customer said, get back a priced quote to review.
 *
 * It is deliberately separate from the Autopilot route. Autopilot narrates an animated 8-step
 * pipeline for the web UI and optionally commits (send, approve, invoice, deposit); this is the
 * quiet version other surfaces call — Slack today, email intake or an inbound webhook tomorrow —
 * and it stops at a DRAFT every time. Nothing here is ever customer-facing on its own.
 *
 * The AI layer is the shop's own key (lib/ai.mjs resolves it per tenant) and is strictly optional:
 * parseIntake falls back to the deterministic parser, so a shop with no key connected still gets a
 * usable quote. That fallback is the product working as designed, not a degraded mode.
 */
import { get, run, now, getSettings, getUpcharges, computeTotals, nextEstimateNumber, nextJobNumber, logActivity, sizeTotal, rollupSizes, garmentLines, sizeSummary, round2, addBusinessDays, businessDaysBetween, emitContactCreated } from './db.mjs'
import { parseIntake } from './ai.mjs'
import { quoteScreenPrint, RUSH_TIERS } from '../public/js/shared/pricing.js'
import { resolveBook, quoteService, AXIS } from './pricebook.mjs'

/** How fast "rush" means when the caller does not say. Matches the turnaround priceIntake books. */
const RUSH_DEFAULT_DAYS = 3
import { blankCost } from './suppliers.mjs'
import * as pipeline from './pipeline.mjs'

const money = (n) => `$${round2(n).toFixed(2)}`
const clean = (s) => String(s || '').trim()

/**
 * Find an existing customer or create one. Matching is by email first (the reliable key), then by
 * exact name — a shop that has "Riverside HS" in the book shouldn't get a second copy of them just
 * because the Slack message didn't carry an address.
 */
export function resolveContact({ name, email, phone, notes, source = 'quote' }) {
  const em = clean(email), nm = clean(name)
  let contact = em ? get('SELECT * FROM contacts WHERE lower(email) = lower(?)', em) : null
  if (!contact && nm) contact = get('SELECT * FROM contacts WHERE lower(name) = lower(?)', nm)
  if (contact) return { contact, created: false }
  if (!em && !nm) {
    // Nothing identifies a customer. Reuse one holding record rather than breeding duplicates.
    const label = `Unassigned — from ${source === 'slack' ? 'Slack' : source}`
    const held = get('SELECT * FROM contacts WHERE lower(name) = lower(?)', label)
    if (held) return { contact: held, created: false, unassigned: true }
    const hid = Number(run('INSERT INTO contacts (name, email, phone, notes, tags, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      label, '', '', 'Quotes raised without a named customer land here until they are assigned.', source, now(), now()).lastInsertRowid)
    return { contact: get('SELECT * FROM contacts WHERE id = ?', hid), created: true, unassigned: true }
  }
  // A message that carries only an address still deserves a usable name in the customer list —
  // "Jamie" beats a book full of rows all called "New customer".
  const fromEmail = em ? em.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim() : ''
  const id = Number(run(
    'INSERT INTO contacts (name, email, phone, notes, tags, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
    nm || fromEmail || 'New customer', em, clean(phone), clean(notes), source, now(), now()).lastInsertRowid)
  const created = get('SELECT * FROM contacts WHERE id = ?', id)
  logActivity('contact', `Customer created from ${source} — ${created.name}`, { contact_id: id })
  // Fire the same new-lead signal the manual path does, so autopilot/quick-quote leads get nurtured.
  emitContactCreated(created)
  return { contact: created, created: true }
}

/**
 * Build the priced line items for a parsed order. Split out so the caller can preview a quote
 * without writing anything to the database (the Slack bot shows a price before it commits).
 */
/**
 * priceIntake + the live distributor lookup, in one await. Callers that already hold a blank
 * (or deliberately want no network) keep using priceIntake directly — it stays pure and sync,
 * which is what makes the pricing regressions testable.
 */
export async function priceIntakeLive(order, settings = getSettings(), { timeoutMs = 6000, taxRate = null } = {}) {
  let blank = null
  try {
    blank = await blankCost(order.garment, settings, { color: order.garment_color || order.color || '', timeoutMs })
  } catch { blank = null }   // a supplier outage must never fail an estimate
  return priceIntake(order, settings, { blank, taxRate })
}

export function priceIntake(order, settings = getSettings(), { blank = null, taxRate = null } = {}) {
  // A stated total and a partial size grid disagree constantly ("200 shirts, at least 24 in S").
  // The grid is a floor, never the order: taking it as the quantity silently priced 24 of 200 —
  // and at the wrong per-piece tier, since quantity drives the price break.
  const grid = sizeTotal(order.sizes)
  const stated = Number(order.total_pieces) || 0
  const pieces = Math.max(grid, stated)
  if (pieces <= 0) return null // nothing to price — the caller asks a follow-up question instead
  // `?? `-style semantics on the STORED value: only an absent/blank setting falls back. `|| 25`
  // read a real 0 as unset and re-added the fee.
  const num = (v, dflt) => (v === null || v === undefined || String(v).trim() === '' ? dflt : (Number(v) || 0))
  const screenFee = num(settings.screen_fee, 25)
  // An empty locations array is truthy, so `||` never fell back — that sold blanks with no print
  // charge. Same for a colors value the parser couldn't turn into a number.
  const locations = (Array.isArray(order.locations) && order.locations.length ? order.locations : [{ name: 'Front', colors: 1 }])
    .map((l) => ({ name: l?.name || 'Front', colors: Math.max(1, Number(l?.colors) || 1) }))
  // Every decoration method bills on its own axis. Pricing them all as screen printing put a
  // "Screen setup — 2 screens" line on embroidery quotes — screens don't exist in embroidery, and
  // the per-piece rate was computed from ink colours rather than stitch count.
  const book = resolveBook(settings.price_book)
  const svc = book.services[order.decoration] ? order.decoration : 'Screen Print'
  const svcAxis = book.services[svc].axis
  // Colours PER LOCATION (+ an underbase screen per location on dark garments). Kept as a list,
  // not a blended sum, because a colour-axis service must price each print location on its own
  // colour count — summing them into one number and then multiplying by the placement count
  // double-charged (front 3c + back 3c on 500pc was quoted at $8.89/pc instead of ~$6.00).
  const placementColors = locations.map((l) => Math.max(1, (Number(l.colors) || 1) + (order.dark_garment ? 1 : 0)))
  const totalColors = placementColors.reduce((n, c) => n + c, 0)
  const units = svcAxis === AXIS.STITCHES ? (Number(order.stitches) || 8000)
    : svcAxis === AXIS.AREA ? (Number(order.print_area) || 50)
    : totalColors
  let priced
  if (svcAxis === AXIS.COLORS && placementColors.length > 1) {
    // Price each location independently (placements: 1 each) and combine. Setup screens sum across
    // locations; the per-piece imprint is the sum of the per-location imprints.
    const parts = placementColors.map((c) => quoteService({ book, service: svc, qty: pieces, units: c, placements: 1 }))
    const perPiece = round2(parts.reduce((a, pt) => a + pt.perPiece, 0))
    const setupQty = parts.reduce((a, pt) => a + (pt.setup?.qty || 0), 0)
    const setupTotal = round2(parts.reduce((a, pt) => a + (pt.setup?.total || 0), 0))
    const s0 = parts[0]
    priced = {
      service: svc, axis: AXIS.COLORS, perPiece, qtyFactor: s0.qtyFactor,
      setup: s0.setup ? { label: s0.setup.label, qty: setupQty, unitPrice: s0.setup.unitPrice, total: setupTotal, note: s0.setup.note } : null,
      subtotal: round2(perPiece * pieces + setupTotal),
    }
  } else {
    priced = quoteService({ book, service: svc, qty: pieces, units, placements: locations.length || 1 })
  }
  // Blank cost, best source first: a live distributor lookup the caller already resolved, then
  // whatever the parser read off the request, then the shop's default. Quoting every shirt at a
  // hardcoded $3.20 was wrong for anyone not running Gildan 5000.
  const blankCostValue = Number(blank?.cost) > 0 ? Number(blank.cost)
    : Number(order.garment_cost) > 0 ? Number(order.garment_cost)
    : (Number(settings.default_garment_cost) > 0 ? Number(settings.default_garment_cost) : 3.2)
  const markup = num(settings.default_markup, 2) || 2
  const garment = Math.round(blankCostValue * markup * 100) / 100
  // Keep the legacy screen-print shape available so callers reading q.totalColors still work.
  // The rush surcharge, which every automated quoting path used to drop on the floor.
  //
  // priceIntake writes "RUSH." onto the customer-visible line and schedules the job three business
  // days out instead of ten (see the turnaround below) — and priced the piece exactly as if it were
  // a standard ten-day run. rush:true and rush:false returned byte-identical totals. On 300 tees at
  // $9.40 that is $2,870.00 quoted where the shop's own published 3-day tier makes it $4,280.00:
  // $1,410.00 given away per quote, and $2,820.00 on a next-day job. The tiers have always existed
  // and were wired only to the manual Quote screen, which applies them at views/quote.js:118.
  //
  // Multiplies the per-piece only. Setup and screen charges are one-off costs that do not scale
  // with how fast the run has to go, which is what quoteScreenPrint does too.
  const rushDays = Number(order.rush_days) || RUSH_DEFAULT_DAYS
  const rushMult = order.rush ? (RUSH_TIERS.find((t) => t.days === rushDays)?.mult ?? 1.5) : 1
  const q = { ...quoteScreenPrint({ garmentCost: blankCostValue, markup, qty: pieces, locations, screenFee, darkGarment: order.dark_garment }),
    perPiece: Math.round((garment + priced.perPiece) * rushMult * 100) / 100, imprintPerPiece: priced.perPiece, service: svc, setup: priced.setup,
    rushApplied: rushMult > 1, rushMult,
    blank: blank ? { ...blank, marked_up: garment } : { cost: blankCostValue, source: 'default', live: false, marked_up: garment } }
  const sizes = grid === pieces && grid > 0 ? order.sizes : { S: 0, M: pieces, L: 0, XL: 0 }
  const items = [{
    description: `${order.garment} — ${(order.locations || []).map((l) => `${l.colors}/0 ${l.name}`).join(' + ') || 'print'}`,
    detail: `${order.dark_garment ? 'Dark garment, underbase incl. ' : ''}${order.rush ? `RUSH +${Math.round((rushMult - 1) * 100)}%. ` : ''}${stated > grid && grid > 0 ? `Sizes given for ${grid} of ${pieces} — confirm the breakdown. ` : ''}`.trim(),
    decoration: order.decoration, sizes, unit_price: q.perPiece, taxable: true,
    // Store the colour count structurally, not only in the description shorthand, so the capacity
    // scheduler reads a number instead of parsing "3/0 Front". Older estimates fall back to parsing.
    colors: Math.max(0, Number(q.totalColors) || (order.locations || []).reduce((s, l) => s + (Number(l?.colors) || 0), 0)),
    blank_source: q.blank.source, blank_cost: q.blank.cost, blank_sku: q.blank.sku || null,
  }]
  // The setup line is written in the trade's own words for whichever service this is: "Screen
  // setup" for screen print, "Digitizing" for embroidery, nothing at all for DTF.
  if (q.setup && q.setup.total > 0) {
    items.push({ description: `${q.setup.label} — ${q.setup.qty} ${q.setup.qty === 1 ? (q.setup.label === 'Screen setup' ? 'screen' : 'design') : (q.setup.label === 'Screen setup' ? 'screens' : 'designs')}`,
      detail: q.setup.note || 'One-time', qty: q.setup.qty, unit_price: q.setup.unitPrice, taxable: false })
  }
  // Effective tax rate: a tax-exempt (resale) buyer is 0, else the shop's rate. Passed in by the
  // caller after it resolves the contact — the automated paths used to always charge the shop rate,
  // billing resale customers tax they don't owe.
  const effTaxRate = taxRate == null ? (num(settings.tax_rate, 0)) : (Number(taxRate) || 0)
  const totals = computeTotals(items, effTaxRate, getUpcharges())
  // rushDays travels with the price so the caller schedules the job on the SAME tier it billed.
  // Recomputing it downstream is how the two drifted apart in the first place.
  return { pieces, quote: q, items, totals, taxRate: effTaxRate, rushDays: order.rush ? rushDays : 0 }
}

/**
 * The whole job: text in, draft estimate out.
 *
 * Returns `{ ok: false, reason: 'no_quantity' }` rather than guessing when the message never says
 * how many pieces — a quote invented from nothing is worse than an honest follow-up question, and
 * quantity is the one field the price cannot be computed without.
 */
export async function quickQuote({ text, contact_name, contact_email, contact_phone, source = 'quote', createJob = false }) {
  const body = clean(text)
  if (body.length < 8) return { ok: false, reason: 'too_short' }

  const order = await parseIntake(body)          // shop's own AI key if set, deterministic parser otherwise
  const settings = getSettings()

  const { contact, created, unassigned } = resolveContact({
    name: contact_name, email: contact_email, phone: contact_phone,
    notes: order.notes || '', source,
  })

  const priced = await priceIntakeLive(order, settings, { taxRate: contact.tax_exempt ? 0 : null })
  if (!priced) return { ok: false, reason: 'no_quantity', order }

  const estNum = nextEstimateNumber()
  const estId = Number(run(
    'INSERT INTO estimates (contact_id, estimate_number, status, items, subtotal, tax, total, tax_rate, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    contact.id, estNum, 'draft', JSON.stringify(priced.items),
    priced.totals.subtotal, priced.totals.tax, priced.totals.total, priced.taxRate, order.notes || '', now()).lastInsertRowid)
  logActivity('estimate', `Estimate ${estNum} drafted from ${source} — ${money(priced.totals.total)}`, { contact_id: contact.id })
  try { pipeline.syncFromEstimate(get('SELECT * FROM estimates WHERE id = ?', estId), 'created') } catch (e) { console.error('pipeline sync:', e.message) }

  let job = null
  if (createJob) {
    // Same deadline rule as Autopilot: a date the customer actually stated beats the default
    // turnaround. due_hint arrives already normalised to ISO and never in the past.
    const today = new Date().toISOString().slice(0, 10)
    const hint = /^\d{4}-\d{2}-\d{2}$/.test(String(order.due_hint || '')) && String(order.due_hint) >= today ? order.due_hint : null
    const days = priced.rushDays || 10
    const dueDate = hint || addBusinessDays(today, days)
    const turnaround = hint ? Math.max(1, businessDaysBetween(today, dueDate)) : days
    const grid = rollupSizes(priced.items)
    const jobId = Number(run(
      'INSERT INTO jobs (contact_id, estimate_id, job_number, title, status, stage, decoration, garment, sizes, line_sizes, quantities, due_date, turnaround_days, approval_gated, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      contact.id, estId, nextJobNumber(), `${priced.pieces} ${order.garment}`, 'active', 'new',
      order.decoration, order.garment, JSON.stringify(grid), JSON.stringify(garmentLines(priced.items)), sizeSummary(grid),
      dueDate, turnaround, 0, order.notes || '', now(), now()).lastInsertRowid)
    job = get('SELECT * FROM jobs WHERE id = ?', jobId)
  }

  return {
    ok: true, order, contact, contact_created: created, unassigned: !!unassigned, job,
    estimate: get('SELECT * FROM estimates WHERE id = ?', estId),
    pieces: priced.pieces, total: priced.totals.total, per_piece: priced.quote.perPiece,
    ai: order.source === 'model' ? 'model' : 'parser',
  }
}
