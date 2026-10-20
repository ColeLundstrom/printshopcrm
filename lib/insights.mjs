/**
 * Shop pulse — the trend lines under Today.
 *
 * Today answers "what do I do next"; this answers "how is the shop doing": what came in each week
 * for the last twelve, what was quoted against what was won, and the margin the finished work
 * actually kept. Money, so the route is manager-only.
 *
 * Weeks are Monday-based and computed from the shop's calendar day (todayIso), and every week is
 * present — a chart with gaps where nothing was paid reads as missing data, not a slow week.
 */
import { all, get, todayIso } from './db.mjs'
import { shopRoi } from './roi.mjs'

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100
const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const mondayOf = (iso) => { const dow = new Date(`${iso}T12:00:00Z`).getUTCDay(); return addDays(iso, -((dow + 6) % 7)) }

export const WEEKS = 12

export function shopInsights({ today = todayIso() } = {}) {
  const thisMonday = mondayOf(today)
  const first = addDays(thisMonday, -7 * (WEEKS - 1))
  const weeks = Array.from({ length: WEEKS }, (_, i) => ({ start: addDays(first, 7 * i), collected: 0, quoted: 0, won: 0 }))
  const slot = (iso) => { const i = Math.floor((Date.parse(`${mondayOf(iso)}T12:00:00Z`) - Date.parse(`${first}T12:00:00Z`)) / (7 * 864e5)); return weeks[i] }

  for (const r of all(`SELECT substr(created_at, 1, 10) AS d, SUM(amount) AS v FROM payments WHERE created_at >= ? GROUP BY d`, first)) {
    const w = slot(r.d); if (w) w.collected = round2(w.collected + r.v)
  }
  // Quoted and won are measured before tax (subtotal), like every pipeline figure in the app.
  for (const r of all(`SELECT substr(created_at, 1, 10) AS d, SUM(COALESCE(subtotal, total)) AS v FROM estimates
      WHERE created_at >= ? AND status != 'draft' GROUP BY d`, first)) {
    const w = slot(r.d); if (w) w.quoted = round2(w.quoted + r.v)
  }
  for (const r of all(`SELECT substr(approved_at, 1, 10) AS d, SUM(COALESCE(subtotal, total)) AS v FROM estimates
      WHERE approved_at >= ? AND status = 'approved' GROUP BY d`, first)) {
    const w = slot(r.d); if (w) w.won = round2(w.won + r.v)
  }

  const since = addDays(today, -90)
  const decided = get(`SELECT
      SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS won,
      SUM(CASE WHEN status IN ('approved','declined') THEN 1 ELSE 0 END) AS decided,
      SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS open
    FROM estimates WHERE created_at >= ?`, since)
  const roi = shopRoi({ completedOnly: true }).totals

  const last4 = weeks.slice(-4).reduce((t, w) => t + w.collected, 0)
  const prior4 = weeks.slice(-8, -4).reduce((t, w) => t + w.collected, 0)
  return {
    today, weeks,
    collected_4w: round2(last4),
    // Null rather than +∞% when the earlier month had nothing to compare against.
    collected_change_pct: prior4 > 0 ? Math.round(((last4 - prior4) / prior4) * 100) : null,
    win_rate_90d: decided.decided ? Math.round((100 * decided.won) / decided.decided) : null,
    open_quotes_90d: decided.open || 0,
    margin_completed: roi.count ? roi.margin : null,
    margin_target: roi.target,
    jobs_measured: roi.count,
  }
}
