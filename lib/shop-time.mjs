/**
 * The shop's calendar: what date it is WHERE THE SHOP IS.
 *
 * "Today" used to be `new Date().toISOString().slice(0, 10)` — the UTC date. For a California shop
 * that rolls over at 5pm (4pm in winter): an invoice due today read overdue in the evening, net-30
 * terms landed a day late, a job shipped at 6pm stamped tomorrow's ship_date, and the Today header
 * showed tomorrow. Every "today" now comes through here, keyed by the shop's `timezone` setting
 * (an IANA zone; blank = the server's zone, PSC_TIMEZONE or the process TZ).
 *
 * Pure — no database — so lib/capacity.mjs (which must not import lib/db.mjs) and the browser-free
 * unit tests can use it. lib/db.mjs wraps it with the settings read as `todayIso()`.
 */

// Intl.DateTimeFormat construction is the expensive part (tens of microseconds, and todayIso is
// called per row in a few loops), so one formatter per zone, built once. A zone that is in this
// map is by construction a valid one.
const formatters = new Map()

import { AsyncLocalStorage } from 'node:async_hooks'
/* The zone the viewer's browser is in, for this request only (X-PSC-Timezone). A shop that has not
 * saved a zone yet sees its own day from the first page view, without the app writing anything on
 * a page load; the saved setting always wins, and background work (no request) uses the server's. */
export const requestZone = new AsyncLocalStorage()
export const requestZoneHint = () => requestZone.getStore() || ''

function formatterFor(zone) {
  let f = formatters.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
    formatters.set(zone, f)
  }
  return f
}

/** The canonical IANA name for `tz`, or null when this runtime cannot use it. */
export function canonicalTimezone(tz) {
  if (typeof tz !== 'string') return null
  const t = tz.trim()
  // An IANA zone name is short; a long string here is a mistake or an attack on the cache.
  if (!t || t.length > 64) return null
  try { return new Intl.DateTimeFormat('en-US', { timeZone: t }).resolvedOptions().timeZone } catch { return null }
}

export const validTimezone = (tz) => canonicalTimezone(tz) !== null

/** The zone a shop with no `timezone` setting runs on: PSC_TIMEZONE, else the process zone. */
export function serverTimezone() {
  const env = canonicalTimezone(process.env.PSC_TIMEZONE || '')
  return env || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/** The zone actually used for a stored setting value: the setting if usable, else the server's. */
export function effectiveTimezone(tz) {
  if (tz && formatters.has(tz)) return tz
  return canonicalTimezone(tz) || serverTimezone()
}

/** YYYY-MM-DD of the instant `at` on the civil calendar of `tz` (blank = server zone). */
export function isoInZone(tz, at = new Date()) {
  const parts = formatterFor(effectiveTimezone(tz)).formatToParts(at)
  const pick = (type) => parts.find((p) => p.type === type).value
  return `${pick('year')}-${pick('month')}-${pick('day')}`
}

/** `iso` (YYYY-MM-DD) moved by `n` calendar days. Noon UTC, so no DST edge can move the date. */
export function addDaysIso(iso, n) {
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + Number(n || 0))
  return d.toISOString().slice(0, 10)
}

/**
 * The stored-UTC timestamp ('YYYY-MM-DD HH:MM:SS') of 00:00 on the civil date `iso` in `tz`.
 * Payments and estimates are stamped in UTC; "this month" is a shop-calendar idea. Comparing a UTC
 * stamp to a bare local date put a 7pm Oct 31 payment in November on the dashboard and in October
 * on Reports. Bind this instead and both agree, and the comparison still uses the index.
 */
const wallFormatters = new Map()
export function utcStampOfLocalMidnight(tz, iso) {
  const zone = effectiveTimezone(tz)
  let f = wallFormatters.get(zone)
  if (!f) { f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); wallFormatters.set(zone, f) }
  const target = Date.parse(`${iso}T00:00:00Z`)
  if (!Number.isFinite(target)) return `${String(iso).slice(0, 10)} 00:00:00`
  const wall = (t) => { const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value])); return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) }
  let t = target
  for (let i = 0; i < 3; i++) t = target - (wall(t) - t)
  return new Date(t).toISOString().slice(0, 19).replace('T', ' ')
}
