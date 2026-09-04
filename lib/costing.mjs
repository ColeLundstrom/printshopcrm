import { all, get, run, tx, getSettings, setSetting, round2, now } from './db.mjs'
import { jobRoi } from './roi.mjs'
const fail = (msg, status = 400) => {
  throw Object.assign(new Error(msg), { status })
}
const number = (n, label, max = 1e8) => {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > max)
    fail(`${label} must be between 0 and ${max}`)
  return n
}
const label = (v) => {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > 120) fail('Enter a name of 1–120 characters')
  return v.trim()
}
export function costingConfig() {
  const s = getSettings()
  const machines = all('SELECT * FROM costing_machines ORDER BY active DESC,name')
  const settings = {
    hours_day: Number(s.costing_hours_day ?? 8),
    days_week: Number(s.costing_days_week ?? 5),
    overhead_month: Number(s.costing_overhead_month ?? 0),
    productive_pct: Number(s.costing_productive_pct ?? 75)
  }
  const machineHours = machines.filter((m) => m.active).reduce((n, m) => n + m.hours_week, 0)
  return {
    machines,
    employees: all('SELECT * FROM costing_employees'),
    settings,
    overhead_rate:
      machineHours > 0
        ? settings.overhead_month / ((((machineHours * 52) / 12) * settings.productive_pct) / 100)
        : null
  }
}
export function saveCostingConfig(b, members) {
  return tx(() => {
    const s = b.settings
    if (!s || !Array.isArray(b.employees)) fail('Provide shop settings and employee rates')
    for (const [k, max] of [
      ['hours_day', 24],
      ['days_week', 7],
      ['overhead_month', 1e8],
      ['productive_pct', 100]
    ]) {
      number(s[k], k, max)
      if (k !== 'overhead_month' && s[k] <= 0) fail(`${k} must be greater than zero`)
    }
    for (const r of b.employees) {
      if (!members.some((m) => m.id === r.member_id && m.status === 'active'))
        fail('Choose an active shop employee')
      number(r.hourly_cost, 'Employee hourly cost', 10000)
    }
    for (const [k, v] of Object.entries(s))
      if (['hours_day', 'days_week', 'overhead_month', 'productive_pct'].includes(k))
        setSetting('costing_' + k, String(v))
    for (const r of b.employees)
      run(
        'INSERT INTO costing_employees(member_id,hourly_cost) VALUES(?,?) ON CONFLICT(member_id) DO UPDATE SET hourly_cost=excluded.hourly_cost',
        r.member_id,
        r.hourly_cost
      )
    return costingConfig()
  })
}
export function saveMachine(id, b) {
  return tx(() => {
    const name = label(b.name),
      method = label(b.method)
    for (const [k, max] of [
      ['hourly_cost', 10000],
      ['output_hour', 1e6],
      ['setup_minutes', 10080],
      ['hours_week', 168]
    ])
      number(b[k], k, max)
    if (!b.output_hour || !b.hours_week) fail('Output and scheduled hours must be greater than zero')
    if (id) {
      const old = get('SELECT * FROM costing_machines WHERE id=?', id)
      if (!old) fail('Machine not found', 404)
      if (old.revision !== b.revision) fail('Machine changed. Reload first.', 409)
      run(
        'UPDATE costing_machines SET name=?,method=?,hourly_cost=?,output_hour=?,setup_minutes=?,hours_week=?,active=?,revision=revision+1 WHERE id=?',
        name,
        method,
        b.hourly_cost,
        b.output_hour,
        b.setup_minutes,
        b.hours_week,
        b.active === false ? 0 : 1,
        id
      )
    } else
      id = Number(
        run(
          'INSERT INTO costing_machines(name,method,hourly_cost,output_hour,setup_minutes,hours_week) VALUES(?,?,?,?,?,?)',
          name,
          method,
          b.hourly_cost,
          b.output_hour,
          b.setup_minutes,
          b.hours_week
        ).lastInsertRowid
      )
    return get('SELECT * FROM costing_machines WHERE id=?', id)
  })
}
function jobRecord(id) {
  const j = get('SELECT * FROM jobs WHERE id=?', id)
  if (!j) fail('Job not found', 404)
  return j
}
function check(id, revision) {
  jobRecord(id)
  const r = get('SELECT * FROM costing_jobs WHERE job_id=?', id)
  if ((r?.revision || 0) !== revision) fail('Job costs changed. Reload first.', 409)
  if (!r) run('INSERT INTO costing_jobs(job_id) VALUES(?)', id)
}
function log(id, actor, detail) {
  run('UPDATE costing_jobs SET revision=revision+1 WHERE job_id=?', id)
  run('INSERT INTO costing_events(job_id,actor,detail) VALUES(?,?,?)', id, actor, JSON.stringify(detail))
}
export function saveJobCosts(id, b, actor) {
  return tx(() => {
    check(id, b.revision)
    if (typeof b.customer_supplied !== 'boolean') fail('Specify who supplies the garments')
    if (b.material_cost !== null) number(b.material_cost, 'Materials')
    const consumableCost =
      b.consumable_cost === undefined
        ? get('SELECT consumable_cost FROM costing_jobs WHERE job_id=?', id).consumable_cost
        : b.consumable_cost
    if (consumableCost !== null) number(consumableCost, 'Decoration supplies / outside decoration')
    number(b.other_cost, 'Other costs')
    run(
      'UPDATE costing_jobs SET customer_supplied=?,material_cost=?,other_cost=?,consumable_cost=? WHERE job_id=?',
      b.customer_supplied ? 1 : 0,
      b.material_cost,
      b.other_cost,
      consumableCost,
      id
    )
    log(id, actor, { action: 'costs', ...b })
    return jobCosting(id)
  })
}
export function saveOperation(jobId, id, b, actor, members) {
  return tx(() => {
    check(jobId, b.revision)
    let old = null
    if (id) {
      old = get('SELECT * FROM costing_operations WHERE id=? AND job_id=?', id, jobId)
      if (!old || old.voided_at) fail('Operation not found', 404)
    }
    const machine = get('SELECT * FROM costing_machines WHERE id=? AND active=1', b.machine_id),
      employee = members.find((m) => m.id === b.member_id && m.status === 'active')
    if (!machine || !employee) fail('Choose an active machine and employee')
    const rate = get('SELECT hourly_cost FROM costing_employees WHERE member_id=?', employee.id)
    if (!rate) fail('Set this employee’s loaded hourly cost in Cost settings first')
    if (!Number.isSafeInteger(b.units) || b.units < 1 || b.units > 1e8)
      fail('Units must be a positive whole number')
    const planned =
      b.planned_minutes === null
        ? machine.setup_minutes + (b.units / machine.output_hour) * 60
        : number(b.planned_minutes, 'Planned minutes', 1e6)
    if (!planned) fail('Planned minutes must be greater than zero')
    if (b.actual_minutes !== null) number(b.actual_minutes, 'Actual minutes', 10080)
    if (
      b.good_units !== null &&
      (!Number.isSafeInteger(b.good_units) || b.good_units < 0 || b.good_units > b.units)
    )
      fail('Good units must be a whole number within units run')
    if ((b.actual_minutes === null) !== (b.good_units === null))
      fail('Record actual minutes and good units together')
    if (b.actual_minutes === 0 && b.good_units > 0) fail('Production with good units needs elapsed time')
    const note = typeof b.note === 'string' ? b.note.trim() : ''
    if (note.length > 1000) fail('Note is too long')
    if (old && !note) fail('Add a note explaining the correction')
    const config = costingConfig(),
      snapshot = old && old.machine_id === machine.id && old.member_id === employee.id
    const values = [
      machine.id,
      employee.id,
      machine.name,
      employee.name,
      machine.method,
      b.units,
      planned,
      b.actual_minutes,
      b.good_units,
      snapshot ? old.machine_rate : machine.hourly_cost,
      snapshot ? old.labor_rate : rate.hourly_cost,
      snapshot ? old.overhead_rate : config.overhead_rate || 0,
      note
    ]
    if (id)
      run(
        'UPDATE costing_operations SET machine_id=?,member_id=?,machine_name=?,employee_name=?,method=?,units=?,planned_minutes=?,actual_minutes=?,good_units=?,machine_rate=?,labor_rate=?,overhead_rate=?,note=?,updated_at=? WHERE id=?',
        ...values,
        now(),
        id
      )
    else
      id = Number(
        run(
          'INSERT INTO costing_operations(job_id,machine_id,member_id,machine_name,employee_name,method,units,planned_minutes,actual_minutes,good_units,machine_rate,labor_rate,overhead_rate,note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          jobId,
          ...values
        ).lastInsertRowid
      )
    log(jobId, actor, {
      action: old ? 'operation.corrected' : 'operation.added',
      before: old,
      after: get('SELECT * FROM costing_operations WHERE id=?', id)
    })
    return jobCosting(jobId)
  })
}
export function jobCosting(id) {
  const job = jobRecord(id),
    legacy = jobRoi(job),
    r = get('SELECT * FROM costing_jobs WHERE job_id=?', id) || {
      revision: 0,
      customer_supplied: 0,
      material_cost: null,
      consumable_cost: null,
      other_cost: 0
    }
  const ops = all(
    'SELECT * FROM costing_operations WHERE job_id=? AND voided_at IS NULL ORDER BY id',
    id
  ).map((o) => {
    const minutes = o.actual_minutes ?? o.planned_minutes
    return {
      ...o,
      basis: o.actual_minutes === null ? 'planned' : 'recorded',
      cost: round2((minutes / 60) * (o.machine_rate + o.labor_rate + o.overhead_rate)),
      planned_cost: round2((o.planned_minutes / 60) * (o.machine_rate + o.labor_rate + o.overhead_rate)),
      output_hour: o.actual_minutes > 0 ? round2((o.good_units / o.actual_minutes) * 60) : null
    }
  })
  // Invoice credits reduce earned revenue; cash refunds alone do not erase an amount still owed.
  const inv = job.invoice_id
    ? get('SELECT * FROM invoices WHERE id=?', job.invoice_id)
    : job.estimate_id
      ? get('SELECT * FROM invoices WHERE estimate_id=? ORDER BY id LIMIT 1', job.estimate_id)
      : null
  const credits = inv
    ? get(
        'SELECT coalesce(sum(subtotal_cents),0)/100.0 AS amount FROM invoice_credits WHERE invoice_id=? AND cancelled_at IS NULL',
        inv.id
      )?.amount || 0
    : 0
  const runs = job.estimate_id
    ? all('SELECT id,sizes FROM jobs WHERE estimate_id=? ORDER BY id', job.estimate_id)
    : [job]
  const pieces = (j) => Object.values(JSON.parse(j.sizes || '{}')).reduce((s, n) => s + Number(n || 0), 0)
  const totalPieces = runs.reduce((s, j) => s + pieces(j), 0)
  const portions = runs.map((j) =>
    round2(credits * (totalPieces ? pieces(j) / totalPieces : 1 / runs.length))
  )
  const creditShare =
    runs.at(-1)?.id === job.id
      ? round2(credits - portions.slice(0, -1).reduce((s, n) => s + n, 0))
      : portions[runs.findIndex((j) => j.id === job.id)] || 0
  const revenue = round2(Math.max(0, (legacy?.revenue || 0) - creditShare))
  const materials = r.customer_supplied ? 0 : (r.material_cost ?? legacy?.breakdown.garment ?? 0)
  const operationCost = ops.length ? ops.reduce((s, o) => s + o.cost, 0) : legacy?.breakdown.labor || 0
  const consumables =
    r.consumable_cost ?? (legacy?.breakdown.screens || 0) + (legacy?.breakdown.decoration || 0)
  const cost = round2(materials + operationCost + consumables + r.other_cost),
    profit = round2(revenue - cost)
  return {
    job: { id: job.id, job_number: job.job_number, title: job.title, decoration: job.decoration },
    ...r,
    operations: ops,
    revenue,
    cost,
    profit,
    margin: revenue > 0 ? round2((profit / revenue) * 100) : null,
    breakdown: {
      materials: round2(materials),
      operations: round2(operationCost),
      consumables: round2(consumables),
      other: r.other_cost
    },
    basis: ops.length
      ? ops.every((o) => o.basis === 'recorded')
        ? 'Recorded operation time'
        : 'Mixed / planned operation time'
      : 'Legacy estimated labor',
    material_basis: r.customer_supplied
      ? 'Customer supplied'
      : r.material_cost !== null
        ? 'Entered total material cost'
        : 'Quote / catalog estimate',
    consumable_basis:
      r.consumable_cost === null
        ? 'Legacy decoration estimate; may include outside labor. Override with supplies-only cost when adding in-house operations.'
        : 'Entered decoration supplies / outside decoration',
    events: all(
      'SELECT actor,detail,created_at FROM costing_events WHERE job_id=? ORDER BY id DESC LIMIT 30',
      id
    )
  }
}
export function costComparison() {
  const rows = all('SELECT job_id FROM costing_jobs').map((j) => jobCosting(j.job_id))
  const result = { machines: [], employees: [], methods: [] }
  for (const [key, field, name] of [
    ['machines', 'machine_id', 'machine_name'],
    ['employees', 'member_id', 'employee_name'],
    ['methods', 'method', 'method']
  ]) {
    const groups = new Map()
    for (const j of rows) {
      const total = j.operations.reduce((s, o) => s + (o.actual_minutes ?? o.planned_minutes), 0)
      for (const o of j.operations) {
        const g = groups.get(o[field]) || {
          id: o[field],
          name: o[name],
          minutes: 0,
          recorded_minutes: 0,
          good_units: 0,
          cost: 0,
          allocated_revenue: 0,
          allocated_profit: 0,
          planned_operations: 0
        }
        const minutes = o.actual_minutes ?? o.planned_minutes
        g.minutes += minutes
        g.cost += o.cost
        g.allocated_revenue += total ? (j.revenue * minutes) / total : 0
        g.allocated_profit += total ? (j.profit * minutes) / total : 0
        if (o.actual_minutes !== null) {
          g.recorded_minutes += o.actual_minutes
          g.good_units += o.good_units
        } else g.planned_operations++
        groups.set(o[field], g)
      }
    }
    result[key] = [...groups.values()]
      .map((g) => ({
        ...g,
        cost: round2(g.cost),
        allocated_revenue: round2(g.allocated_revenue),
        allocated_profit: round2(g.allocated_profit),
        output_hour: g.recorded_minutes > 0 ? round2((g.good_units / g.recorded_minutes) * 60) : null
      }))
      .sort((a, b) => b.allocated_profit - a.allocated_profit)
  }
  return {
    ...result,
    jobs: rows,
    allocation:
      'Revenue and whole-job profit allocated by each operation’s share of job time. This is an allocation, not proof that an employee or machine caused the profit.',
    coverage:
      'Only jobs with saved costing records. Output uses recorded good units and recorded time; planned operations are counted separately.'
  }
}

export function voidOperation(jobId, id, b, actor) {
  return tx(() => {
    check(jobId, b.revision)
    const old = get('SELECT * FROM costing_operations WHERE id=? AND job_id=?', id, jobId)
    if (!old || old.voided_at) fail('Active operation not found', 404)
    const reason = label(b.reason)
    run('UPDATE costing_operations SET voided_at=?,note=? WHERE id=?', now(), reason, id)
    log(jobId, actor, { action: 'operation.voided', before: old, reason })
    return jobCosting(jobId)
  })
}
