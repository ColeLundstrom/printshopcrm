/**
 * Capacity & promise-date engine — the thing no MIS on the market does.
 *
 * Every tool stores a due date. None of them know whether the shop can physically HIT it.
 * A shop with one press and forty open jobs is booked solid whether or not any single job
 * looks late; the software should say so before a date is promised, not after it's blown.
 *
 * This reuses the SAME press-time tables the costing engine uses (pressMinutes), so capacity
 * and cost tell one story: money can't drift, and now hours can't drift either. The load-bearing
 * input is the same `utilization` figure — presses image only ~24-33% of the paid clock — so a
 * day of "8 hours" is not 8 hours of throughput, and the schedule reflects that honestly.
 *
 * The scheduler is earliest-due-date greedy over a shared, finite daily capacity. EDD is the
 * classic optimum for minimizing maximum lateness on one machine; here it also models the real
 * shop-floor truth that committed, sooner-due work claims the press first and pushes the rest out.
 */
import { pressMinutes, sizeTotal } from '../public/js/shared/pricing.js'

const DAY = 864e5
/**
 * How far forward either scheduling loop will walk before giving up. Both consumed the job's
 * press minutes one business day at a time with no bound, so a piece count large enough to
 * outrun the shop's daily capacity became an infinite loop — 100% CPU on the single shared
 * process, every other tenant on the box blocked, no recovery without a restart. Worse when
 * persisted: a job saved with that count made the Capacity page do it again on every visit.
 * Five working years. Anything past this is not a schedule, and the shop is told so.
 */
const HORIZON_DAYS = 1825
const iso = (d) => d.toISOString().slice(0, 10)
const parseDay = (s) => new Date(`${String(s).slice(0, 10)}T12:00:00`)
const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6

/** The next business day strictly after `d` (a Date), skipping Sat/Sun. Mutates a copy. */
function nextBusinessDay(d) {
  const n = new Date(d)
  do { n.setDate(n.getDate() + 1) } while (isWeekend(n))
  return n
}
/** `d`, advanced to the same day if it's a weekday, else the next weekday. */
function onOrAfterBusinessDay(d) {
  const n = new Date(d)
  while (isWeekend(n)) n.setDate(n.getDate() + 1)
  return n
}
/** Business days from `from` to `to` (both YYYY-MM-DD); negative if `to` precedes `from`. */
export function businessDaysBetween(from, to) {
  // O(1) — see the twin in lib/db.mjs. Whole weeks give 5 business days each; walk only the
  // remainder. The old per-day loop was quadratic against the scheduler's ~1,800-day horizon.
  const a = parseDay(from), b = parseDay(to)
  const sign = b < a ? -1 : 1
  const [lo, hi] = b < a ? [b, a] : [a, b]
  const days = Math.round((hi - lo) / 86400000)
  if (days <= 0) return 0
  const weeks = Math.floor(days / 7)
  let n = weeks * 5
  let dow = lo.getDay()
  for (let i = 0; i < days - weeks * 7; i++) { dow = (dow + 1) % 7; if (dow !== 0 && dow !== 6) n++ }
  return n * sign
}

/* ---------- inputs ---------- */

/** Productive press-minutes the shop can actually deliver in one working day. Transparent on purpose. */
export function dailyCapacity(settings = {}) {
  const stations = Math.max(1, Number(settings.capacity_stations) || 1)
  const hours = Math.max(0.5, Number(settings.capacity_hours_per_day) || 8)
  const util = Math.min(1, Math.max(0.05, (Number(settings.utilization_pct) || 30) / 100))
  const minutes = Math.round(stations * hours * 60 * util)
  return { minutes, stations, hours, utilizationPct: Math.round(util * 100) }
}

/**
 * Number of colors/screens (press passes) a job carries.
 *
 * Order matters: a recorded separation is a measurement, the quote is a statement of intent, and
 * the setting is a guess. Falling straight from separation to the flat default meant any job that
 * was never separated scheduled as a 2-colour job — so a 6-colour run booked a third of the press
 * time it actually needs and the promised date was fiction. Reading the quote closes that gap.
 */
export function jobColors(job, settings = {}) {
  try {
    const sep = job.separation ? JSON.parse(job.separation) : null
    if (sep && Number(sep.screens) > 0) return Math.min(12, Number(sep.screens))
    if (sep && Number(sep.colors) > 0) return Math.min(12, Number(sep.colors))
  } catch { /* fall through */ }
  if (Number(job.colors) > 0) return Math.min(12, Number(job.colors))
  return Math.max(1, Number(settings.capacity_default_colors) || 2)
}

/**
 * Ink colours a quote's line items imply — the press passes the shop actually sold.
 *
 * This has to read colour from where it ACTUALLY lives, which for every estimate this app has ever
 * written is not a structured field. The quote builder stores the colour count in two places: a
 * "screen setup" line whose qty IS the number of screens, and the garment line's description in
 * the trade's own "N/0" shorthand ("Tee — 3/0 Front + 1/0 Back"). It does not store a numeric
 * `colors` on the line. So reading only `it.colors`/`it.locations` returned 0 for every real job,
 * and the scheduler booked everything at the flat 2-colour default — a 6-colour run reserved a
 * third of the press time it needed and the promised date was fiction.
 *
 * Precedence, most reliable first: a structured field if a newer quote wrote one; the screen-setup
 * line's qty; the heaviest "N/0" or "N colour" the descriptions state. 0 only when truly nothing.
 */
export function colorsFromItems(items) {
  if (!Array.isArray(items)) return 0
  let structured = 0, setup = 0, parsed = 0
  for (const it of items) {
    // 1. Structured, if a future quote stores it.
    if (Array.isArray(it?.locations) && it.locations.length) {
      let n = 0
      for (const loc of it.locations) n += Math.max(0, Number(loc?.colors) || 0)
      structured = Math.max(structured, n)
    } else if (Number(it?.colors) > 0) {
      structured = Math.max(structured, Number(it.colors))
    }
    const desc = String(it?.description || '')
    // 2. The screen-setup line: its qty is the screen (colour) count. One setup line covers the
    //    whole job's worst case, so it is a total, not per-line.
    if (/screen/i.test(desc) && Number(it?.qty) > 0) setup = Math.max(setup, Number(it.qty))
    // 3. Trade shorthand in the description: "3/0", "3 color", "3-color". Sum across a line's
    //    locations ("3/0 Front + 1/0 Back" → 4 setups), take the heaviest line.
    let lineParsed = 0
    for (const m of desc.matchAll(/(\d{1,2})\s*\/\s*\d/g)) lineParsed += Number(m[1]) || 0
    if (!lineParsed) {
      const c = desc.match(/(\d{1,2})\s*(?:-|\s)?\s*colou?rs?\b/i)
      if (c) lineParsed = Number(c[1]) || 0
    }
    parsed = Math.max(parsed, lineParsed)
  }
  return Math.min(12, structured || setup || parsed || 0)
}

/** Pieces on a job — the size grid is authoritative, `quantities` is the fallback. */
export function jobPieces(job) {
  try { const g = job.sizes ? JSON.parse(job.sizes) : null; const t = sizeTotal(g); if (t > 0) return t } catch { /* noop */ }
  try {
    const q = job.quantities ? JSON.parse(job.quantities) : null
    if (Array.isArray(q)) return q.reduce((s, n) => s + (Number(n) || 0), 0)
    if (q && typeof q === 'object') return Object.values(q).reduce((s, n) => s + (Number(n) || 0), 0)
    if (Number(q) > 0) return Number(q)
  } catch { /* noop */ }
  return 0
}

/** Productive press-minutes one job consumes. Zero pieces → zero (and the caller flags it as unsized). */
export function jobMinutes(job, settings = {}) {
  const pieces = jobPieces(job)
  if (pieces <= 0) return 0
  const press = settings.press_type === 'manual' ? 'manual' : 'auto'
  return Math.round(pressMinutes(pieces, jobColors(job, settings), press))
}

/* ---------- the scheduler ---------- */

/**
 * Forward-fill committed work onto a finite daily-capacity calendar in earliest-due order.
 * Returns each job's realistic finish day (spanning as many days as its minutes need) and a
 * per-day booked/free ledger. A job whose finish lands after its own due date is capacity-late —
 * distinct from the proof-approval slip the dashboard already surfaces.
 */
export function schedule(jobs, settings = {}, { from } = {}) {
  const capInfo = dailyCapacity(settings)
  const cap = capInfo.minutes
  // A single job runs on ONE press, so it cannot finish faster than one press can image it — no
  // matter how many presses the shop owns. Without this bound the pooled daily total let one big
  // job "use" every station at once: a 2,000-piece six-colour run that physically takes a week on
  // one press reported same-day on an eight-press shop, and the promise date over-committed by a
  // factor of the station count. Cap any single job's per-day consumption at one station's
  // throughput; parallelism across DIFFERENT jobs still uses the full pooled total below.
  const perJobPerDay = Math.max(1, Math.round(cap / Math.max(1, capInfo.stations)))
  const start = onOrAfterBusinessDay(from ? parseDay(from) : new Date())
  const ledger = new Map()               // 'YYYY-MM-DD' -> minutes booked
  const book = (key, m) => ledger.set(key, (ledger.get(key) || 0) + m)

  // A moving cursor of the first day that still has capacity, so we never rescan from day one.
  let cursor = new Date(start)
  const freeOn = (key) => cap - (ledger.get(key) || 0)

  const ordered = [...jobs].sort((a, b) => {
    const da = a.due || '9999-12-31', db = b.due || '9999-12-31'
    if (da !== db) return da < db ? -1 : 1
    return (b.rush ? 1 : 0) - (a.rush ? 1 : 0)
  })

  const scheduled = ordered.map((j0) => {
    // Accept a pre-costed job (from promise()) or compute press-minutes from the raw record.
    const minutes = j0.minutes != null ? j0.minutes : jobMinutes(j0, settings)
    const j = { ...j0, minutes }
    let remaining = minutes
    if (remaining <= 0) return { ...j, projectedFinish: null, daysLate: 0, unsized: true }
    // Advance the cursor past any fully-booked days, then consume from here forward.
    let day = new Date(cursor)
    while (freeOn(iso(day)) <= 0) day = nextBusinessDay(day)
    let last = new Date(day)
    let bookedTodayForThisJob = 0
    let dayKey = iso(day)
    let guard = 0
    while (remaining > 0 && guard++ < HORIZON_DAYS) {
      const key = iso(day)
      if (key !== dayKey) { dayKey = key; bookedTodayForThisJob = 0 }
      // This job can take at most one press's worth of minutes from any single day, on top of not
      // exceeding what the day has free across all jobs.
      const take = Math.min(remaining, freeOn(key), perJobPerDay - bookedTodayForThisJob)
      if (take > 0) { book(key, take); remaining -= take; bookedTodayForThisJob += take; last = new Date(day) }
      if (remaining > 0) day = nextBusinessDay(day)
    }
    // Nudge the shared cursor up to the first still-open day so later jobs start searching there.
    while (freeOn(iso(cursor)) <= 0) cursor = nextBusinessDay(cursor)
    // Past the horizon this is not a schedule, it is a hang. Say so instead of counting days one
    // at a time forever — the caller already renders a null projectedFinish as "unsized".
    if (remaining > 0) return { ...j, projectedFinish: null, daysLate: 0, unsized: true, beyondHorizon: true }
    const projectedFinish = iso(last)
    const daysLate = j.due ? Math.max(0, businessDaysBetween(j.due, projectedFinish)) : 0
    return { ...j, projectedFinish, daysLate, unsized: false }
  })

  return { capacityPerDay: cap, start: iso(start), ledger, jobs: scheduled }
}

/* ---------- the report the page renders ---------- */

export function capacityReport(jobs, settings = {}, { days = 14 } = {}) {
  const cap = dailyCapacity(settings)
  const s = schedule(jobs, settings)
  const ledger = s.ledger

  // The horizon: last day carrying any booked work = "booked solid through".
  let bookedThrough = null
  for (const [key, m] of ledger) if (m > 0 && (!bookedThrough || key > bookedThrough)) bookedThrough = key

  // A rolling window of daily load vs capacity for the bar strip.
  const timeline = []
  let d = onOrAfterBusinessDay(new Date())
  for (let i = 0; i < days; i++) {
    const key = iso(d)
    const load = Math.round(ledger.get(key) || 0)
    timeline.push({ date: key, load, capacity: cap.minutes, pct: cap.minutes ? Math.round((load / cap.minutes) * 100) : 0 })
    d = nextBusinessDay(d)
  }

  const freeMinutesWindow = timeline.slice(0, 5).reduce((t, x) => t + Math.max(0, x.capacity - x.load), 0)
  const atRisk = s.jobs.filter((j) => j.daysLate > 0).sort((a, b) => b.daysLate - a.daysLate)
  const unsized = s.jobs.filter((j) => j.unsized)
  const totalMinutes = s.jobs.reduce((t, j) => t + (j.minutes || 0), 0)

  return {
    capacity: cap,
    timeline,
    bookedThrough,
    backlogDays: bookedThrough ? Math.max(0, businessDaysBetween(iso(onOrAfterBusinessDay(new Date())), bookedThrough)) : 0,
    freeHoursThisWeek: Math.round((freeMinutesWindow / 60) * 10) / 10,
    bookedHours: Math.round((totalMinutes / 60) * 10) / 10,
    atRiskCount: atRisk.length,
    jobs: s.jobs,
    atRisk,
    unsized,
  }
}

/**
 * "If we take this job now, when can we realistically ship it?" Schedules the existing committed
 * board first (it owns the press), then drops the prospective job into the earliest remaining gaps.
 * Answers the one question every front desk guesses at: can we promise this date?
 */
export function promise(jobs, settings, { pieces = 0, colors = 1, press, dueDate } = {}) {
  const cap = dailyCapacity(settings).minutes
  const p = press || (settings.press_type === 'manual' ? 'manual' : 'auto')
  const minutes = pieces > 0 ? Math.round(pressMinutes(pieces, Math.max(1, colors), p)) : 0
  const base = schedule(jobs, settings)
  const ledger = base.ledger
  const freeOn = (key) => cap - (ledger.get(key) || 0)

  let remaining = minutes
  let day = onOrAfterBusinessDay(new Date())
  let last = new Date(day)
  if (minutes <= 0) return { minutes: 0, earliestFinish: null, feasible: false, reason: 'Enter a piece count to check.' }
  while (freeOn(iso(day)) <= 0) day = nextBusinessDay(day)
  let guard = 0
  while (remaining > 0 && guard++ < HORIZON_DAYS) {
    const take = Math.min(remaining, freeOn(iso(day)))
    if (take > 0) { remaining -= take; last = new Date(day) }
    if (remaining > 0) day = nextBusinessDay(day)
  }
  if (remaining > 0) {
    return {
      minutes, hours: Math.round((minutes / 60) * 10) / 10, earliestFinish: null,
      capacityPerDay: cap, feasible: false, slackDays: null, workingDaysOut: null, beyondHorizon: true,
      reason: 'That is more press time than the shop has in the next five years — split it into smaller runs, or raise the capacity settings.',
    }
  }
  const earliestFinish = iso(last)
  const feasible = dueDate ? earliestFinish <= String(dueDate).slice(0, 10) : true
  const slackDays = dueDate ? businessDaysBetween(earliestFinish, dueDate) : null
  return {
    minutes,
    hours: Math.round((minutes / 60) * 10) / 10,
    earliestFinish,
    capacityPerDay: cap,
    feasible,
    slackDays,          // >0 = days of cushion; <0 = business days short
    workingDaysOut: businessDaysBetween(iso(onOrAfterBusinessDay(new Date())), earliestFinish),
  }
}
