// Pure date-only planning. Timing never gates production task completion.
export const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T12:00:00Z')) && new Date(value + 'T12:00:00Z').toISOString().slice(0,10) === value
const fail = message => { throw Object.assign(new Error(message), { status: 400 }) }
export function offset(value) {
  if (value == null || value === '') return null
  if (!Number.isSafeInteger(value) || Math.abs(value) > 365) fail('Task timing must be a whole number from -365 to 365 days.')
  return value
}
export function timingConfig(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Invalid timing settings.')
  const enabled = value.enabled ?? false, turnaround = value.turnaround_days ?? 5, basis = value.day_basis ?? 'business'
  if (typeof enabled !== 'boolean') fail('Timing enabled must be true or false.')
  if (!Number.isSafeInteger(turnaround) || turnaround < 0 || turnaround > 365) fail('Turnaround must be 0–365 whole days.')
  if (!['business','calendar'].includes(basis)) fail('Choose working days or calendar days.')
  for (const key of ['start_date','production_date']) if (value[key] && !validDate(value[key])) fail('Enter a real date in YYYY-MM-DD format.')
  return { enabled, turnaround_days: turnaround, day_basis: basis, start_date: value.start_date || null, production_date: value.production_date || null }
}
export function shiftDate(date, count, basis = 'calendar') {
  if (!validDate(date) || !Number.isSafeInteger(count) || Math.abs(count) > 730) return null
  const d = new Date(date + 'T12:00:00Z'), direction = count < 0 ? -1 : 1
  for (let left = Math.abs(count); left > 0;) {
    d.setUTCDate(d.getUTCDate() + direction)
    if (basis !== 'business' || ![0,6].includes(d.getUTCDay())) left--
  }
  return d.toISOString().slice(0,10)
}
export function planDates(raw, tasks) {
  const timing = timingConfig(raw)
  const production_date = timing.enabled ? timing.production_date || shiftDate(timing.start_date, timing.turnaround_days, timing.day_basis) : null
  return { ...timing, planned_production_date: production_date,
    tasks: tasks.map(t => {
      const rule = JSON.parse(t.timing || '{}')
      return { ...t, due_offset: rule.due_offset ?? null, due_override: rule.due_date || null,
        planned_due_date: timing.enabled ? rule.due_date || (rule.due_offset != null ? shiftDate(production_date, rule.due_offset, timing.day_basis) : null) : null }
    }) }
}
