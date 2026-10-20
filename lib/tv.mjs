/**
 * Shop TV — the wallboard a shop mounts over the presses.
 *
 * One read-only snapshot of the floor: every active job by stage with its pieces and how late it
 * is, what has to leave today, what moved recently, and (for managers only) the money pulse. The
 * screen polls this and also repaints on the realtime 'board' event, so a card dragged on a laptop
 * shows up on the TV within a second.
 *
 * Money is opt-in by role, not by URL: a TV on the floor is usually signed in as a staff member,
 * and staff do not see revenue anywhere else in the app either. A manager can still hide it with
 * ?money=0 for a TV that faces customers.
 */
import { all, get, JOB_STAGES, sizeTotal, todayIso } from './db.mjs'

const parse = (s, fallback) => { try { const v = JSON.parse(s); return v == null ? fallback : v } catch { return fallback } }
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100
const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }

/** A card's lateness in whole days (positive = overdue), or null when it has no date. */
const lateBy = (due, today) => (due ? Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${due}T12:00:00Z`)) / 864e5) : null)

// Columns on the wall show the first few cards and a "+N more"; a TV cannot scroll.
const PER_COLUMN = 8

export function tvSnapshot({ includeMoney = false, today = todayIso() } = {}) {
  const jobs = all(`SELECT j.id, j.job_number, j.title, j.stage, j.due_date, j.rush, j.sizes, j.decoration, j.assigned_to,
        c.name AS contact_name, c.company
      FROM jobs j LEFT JOIN contacts c ON c.id = j.contact_id
      WHERE j.status = 'active'
      ORDER BY j.rush DESC, j.due_date IS NULL, j.due_date, j.sort_order, j.id`)
    .map((j) => ({
      id: j.id, job_number: j.job_number, title: j.title, stage: j.stage, due_date: j.due_date,
      rush: !!j.rush, decoration: j.decoration || '', assigned_to: j.assigned_to || '',
      customer: j.company || j.contact_name || '',
      pieces: sizeTotal(parse(j.sizes, {})),
      late: lateBy(j.due_date, today),
    }))

  // Complete is the column the floor is emptying INTO — it is shown as a count, not as cards.
  const floor = jobs.filter((j) => j.stage !== 'complete')
  const columns = JOB_STAGES.filter((s) => s.key !== 'complete').map((s) => {
    const list = floor.filter((j) => j.stage === s.key)
    return { key: s.key, label: s.label, count: list.length, pieces: list.reduce((t, j) => t + j.pieces, 0),
      late: list.filter((j) => j.late > 0).length, jobs: list.slice(0, PER_COLUMN), more: Math.max(0, list.length - PER_COLUMN) }
  })

  const dueToday = floor.filter((j) => j.due_date === today)
  // Shipping counts: a box still on the dock past its promise date is late to the customer.
  const overdue = floor.filter((j) => j.late > 0).sort((a, b) => b.late - a.late)

  // "Shipped this week" counts jobs that left by their ship date, which the shipping flow stamps.
  const weekAgo = addDays(today, -6)
  const shippedWeek = get(`SELECT COUNT(*) AS n FROM jobs WHERE ship_date >= ? AND ship_date <= ?`, weekAgo, today).n
  const completedWeek = all(`SELECT sizes FROM jobs WHERE stage = 'complete' AND substr(updated_at, 1, 10) >= ?`, weekAgo)
    .reduce((t, j) => t + sizeTotal(parse(j.sizes, {})), 0)

  const onTimeBase = floor.filter((j) => j.due_date && j.due_date <= addDays(today, 7))
  const snapshot = {
    today,
    generated_at: new Date().toISOString(),
    stats: {
      pieces_on_floor: floor.reduce((t, j) => t + j.pieces, 0),
      active_jobs: floor.length,
      due_today: dueToday.length,
      overdue: overdue.length,
      rush: floor.filter((j) => j.rush).length,
      proofs_out: floor.filter((j) => j.stage === 'art_approval').length,
      shipped_week: shippedWeek,
      pieces_completed_week: completedWeek,
      // Share of the next week's promised work that is not already late. A wallboard number the
      // whole floor can move, and one that is honest about an empty week (null, not 100%).
      on_track_pct: onTimeBase.length ? Math.round(100 * onTimeBase.filter((j) => !(j.late > 0)).length / onTimeBase.length) : null,
    },
    columns,
    due_today: dueToday.slice(0, 10),
    overdue: overdue.slice(0, 10),
    // Payment, invoice and estimate lines carry amounts, so they ride with the money permission.
    recent: all(`SELECT a.id, a.type, a.description, a.created_at FROM activities a
        WHERE a.type IN (${includeMoney ? "'stage','job','art','production','payment','estimate','invoice'" : "'stage','job','art','production'"})
        ORDER BY a.created_at DESC, a.id DESC LIMIT 12`),
    money: null,
  }

  if (includeMoney) {
    const monthStart = today.slice(0, 8) + '01'
    const from = addDays(today, -13)
    const byDay = new Map(all(`SELECT substr(created_at, 1, 10) AS d, SUM(amount) AS v FROM payments WHERE created_at >= ? GROUP BY d`, from)
      .map((r) => [r.d, round2(r.v)]))
    snapshot.money = {
      revenue_today: byDay.get(today) || 0,
      revenue_mtd: round2(get(`SELECT COALESCE(SUM(amount), 0) AS v FROM payments WHERE created_at >= ?`, monthStart).v),
      approved_today: round2(get(`SELECT COALESCE(SUM(COALESCE(subtotal, total)), 0) AS v FROM estimates WHERE status = 'approved' AND substr(approved_at, 1, 10) = ?`, today).v),
      // Fourteen points, oldest first, zero-filled — the sparkline needs every day, not just paid ones.
      daily: Array.from({ length: 14 }, (_, i) => { const d = addDays(from, i); return { date: d, amount: byDay.get(d) || 0 } }),
    }
  }
  return snapshot
}
