/**
 * Reorder radar — the follow-up money shops leave on the table.
 *
 * A print shop's best lead is a customer who already bought. Spirit shirts, staff apparel, event
 * tees, uniform refreshes — most reorder on a rhythm, and nobody watches the rhythm. This learns
 * each customer's cadence from their own order history and surfaces the ones who are due (or
 * overdue) to buy again, ranked by how much they're worth, with their last order ready to clone.
 *
 * Deterministic — no model needed. It's arithmetic on dates the shop already has.
 */
import { all, getSettings, setSetting, round2, sizeSummary } from './db.mjs'

const DAY = 864e5
const iso = (d) => d.toISOString().slice(0, 10)
const parseDay = (s) => new Date(`${String(s).slice(0, 10)}T12:00:00`)
const daysBetween = (a, b) => Math.round((parseDay(b) - parseDay(a)) / DAY)

// A one-time customer has no cadence yet; assume a typical refresh window so they still resurface.
const DEFAULT_WINDOW = 120
// Don't nag anyone who ordered recently, no matter the math.
const QUIET_FLOOR = 40

/** Snoozed contacts: { contactId: untilISO }. Stored as one settings JSON so there's no new table. */
function snoozed() {
  try { const v = JSON.parse(getSettings().reorder_snooze || '{}'); return v && typeof v === 'object' ? v : {} } catch { return {} }
}
export function snoozeReorder(contactId, days = 30) {
  const map = snoozed()
  map[String(contactId)] = iso(new Date(Date.now() + days * DAY))
  setSetting('reorder_snooze', JSON.stringify(map))
}
export function unsnoozeReorder(contactId) {
  const map = snoozed(); delete map[String(contactId)]; setSetting('reorder_snooze', JSON.stringify(map))
}

/** Median is robust to one weird gap (a rush job, a one-off) that a mean would swing on. */
const median = (xs) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * Build the radar. Returns candidates worth a nudge today (due or overdue), plus a short watch
 * list coming up, plus headline stats. `today` is injected so the result is deterministic to test.
 */
export function reorderRadar(today = iso(new Date())) {
  const rows = all(`
    SELECT j.contact_id, j.created_at, j.title, j.decoration, j.sizes, j.job_number,
           c.name AS contact_name, c.company, c.email, c.phone
    FROM jobs j JOIN contacts c ON c.id = j.contact_id
    WHERE j.contact_id IS NOT NULL
    ORDER BY j.contact_id, j.created_at`)

  // Lifetime paid value per contact — the ranking weight (a $6k customer beats a $200 one).
  const ltv = {}
  for (const r of all(`SELECT contact_id, COALESCE(SUM(amount_paid),0) AS v FROM invoices WHERE contact_id IS NOT NULL GROUP BY contact_id`)) ltv[r.contact_id] = round2(r.v)

  const byContact = new Map()
  for (const r of rows) {
    if (!byContact.has(r.contact_id)) byContact.set(r.contact_id, [])
    byContact.get(r.contact_id).push(r)
  }

  const snz = snoozed()
  const candidates = []
  // NOT `snoozed` — that name is already the module-level settings reader called on the line
  // above, and shadowing it here puts `snoozed()` in its own temporal dead zone.
  const parked = []   // suppressed, and therefore owed a way back
  for (const [cid, orders] of byContact) {
    const last = orders[orders.length - 1]
    const lastDate = String(last.created_at).slice(0, 10)
    const daysSince = daysBetween(lastDate, today)
    if (daysSince < QUIET_FLOOR) continue // ordered recently — leave them alone

    const n = orders.length
    let cadence, confidence
    // Only gaps that look like an actual REORDER count toward cadence. A shop routinely splits one
    // buying event into several jobs on the same day or the same week (front, back, a reprint), and
    // those near-zero gaps are not evidence the customer reorders weekly. Median-ing them in, then
    // flooring at 21 days, turned an annual customer's cluster of same-day orders into a "21-day
    // cadence" — so a customer who last ordered 300 days ago was branded "279 days overdue" with
    // high confidence, and the nudge button emailed them about it. Keep gaps of a week or more.
    const REORDER_MIN_GAP = 7
    const gaps = []
    for (let i = 1; i < orders.length; i++) {
      const g = daysBetween(orders[i - 1].created_at, orders[i].created_at)
      if (g >= REORDER_MIN_GAP) gaps.push(g)
    }
    if (gaps.length >= 1) {
      cadence = Math.max(21, Math.round(median(gaps)))
      // Confidence tracks how many real reorder intervals we actually saw, not the raw order count.
      confidence = gaps.length >= 3 ? 'high' : gaps.length >= 2 ? 'medium' : 'low'
    } else {
      // No genuine reorder interval on record — clustered orders, or a single order. We do not know
      // this customer's cadence, so we do not get to claim they are overdue. Nudge on the neutral
      // default window at low confidence, and never mark an unknown-cadence customer "overdue".
      cadence = DEFAULT_WINDOW
      confidence = 'low'
    }
    const predicted = iso(new Date(parseDay(lastDate).getTime() + cadence * DAY))
    const dueIn = daysBetween(today, predicted) // negative = overdue
    let status
    if (dueIn < 0) status = 'overdue'
    else if (dueIn <= 14) status = 'due'
    else if (dueIn <= 35) status = 'upcoming'
    else continue // not due for a while — don't clutter
    // "Overdue" is a confident claim: we know their cadence and they have missed it. When we do NOT
    // know the cadence (a single order, or only clustered same-day orders), we have no standing to
    // say they are late — so the strongest we allow is a gentle "due", never the alarming overdue
    // that used to fire a real email at an annual customer we had simply guessed a 21-day cycle for.
    if (status === 'overdue' && confidence === 'low') status = 'due'

    const snoozeUntil = snz[String(cid)]
    // Parked, not deleted. Snooze is one ghost button away from Send nudge with no confirm on
    // either, and dropping the row here took the customer out of `candidates`, out of
    // stats.actionable and out of potential_value — so a mis-tap silently removed the shop's
    // biggest repeat account from the one screen that says to call them, and nothing the browser
    // received even named them. A queue a human cannot see is a queue they cannot fix.
    if (snoozeUntil && snoozeUntil > today) {
      parked.push({
        contact_id: cid, name: last.contact_name, company: last.company || '',
        until: snoozeUntil, lifetime_value: ltv[cid] || 0, status,
      })
      continue
    }

    candidates.push({
      contact_id: cid,
      name: last.contact_name, company: last.company || '', email: last.email || '', phone: last.phone || '',
      orders: n, last_date: lastDate, days_since: daysSince,
      cadence_days: cadence, predicted_date: predicted, due_in_days: dueIn, status, confidence,
      lifetime_value: ltv[cid] || 0,
      last_order: { title: last.title || '', job_number: last.job_number || '', decoration: last.decoration || '', sizes_summary: sizeSummary(safe(last.sizes)) },
    })
  }

  // Overdue first, then due, then upcoming; inside a tier, highest lifetime value first.
  const rank = { overdue: 0, due: 1, upcoming: 2 }
  candidates.sort((a, b) => (rank[a.status] - rank[b.status]) || (b.lifetime_value - a.lifetime_value) || (a.due_in_days - b.due_in_days))

  const actionable = candidates.filter((c) => c.status === 'overdue' || c.status === 'due')
  parked.sort((a, b) => (b.lifetime_value - a.lifetime_value) || String(a.until).localeCompare(String(b.until)))
  return {
    candidates,
    snoozed: parked,
    stats: {
      actionable: actionable.length,
      overdue: candidates.filter((c) => c.status === 'overdue').length,
      due: candidates.filter((c) => c.status === 'due').length,
      upcoming: candidates.filter((c) => c.status === 'upcoming').length,
      potential_value: round2(actionable.reduce((s, c) => s + (c.lifetime_value || 0), 0)),
    },
  }
}

const safe = (s) => { try { return JSON.parse(s) } catch { return {} } }
