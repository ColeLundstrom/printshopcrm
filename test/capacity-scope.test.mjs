import test from 'node:test'
import assert from 'node:assert/strict'
import { isScreenPrintMethod, screenPrintJobScope, unsupportedScreenPrintMethods } from '../public/js/shared/capacity-scope.js'
import { capacityReport, promise, schedule, jobMinutes, dailyCapacity } from '../lib/capacity.mjs'

const settings = { capacity_stations: 1, capacity_hours_per_day: 8, utilization_pct: 30 }
const job = extra => ({ id: 1, stage: 'new', status: 'active', decoration: 'Screen Print', sizes: '{"M":144}', colors: 3, ...extra })
const task = extra => ({ id: 1, stage: 'production', status: 'pending', position: 1, ...extra })

test('method scope requires exact screen-only evidence and inspects every sized garment line', () => {
  for (const method of ['Screen Print', 'screenprinting', 'Screen-printing']) assert(isScreenPrintMethod(method))
  for (const method of ['', 'DTF', 'Embroidery', 'Screen Print + Embroidery', 'Custom screen matrix', null]) assert(!isScreenPrintMethod(method))
  for (const decoration of ['', 'DTF Transfer', 'Embroidery', 'Screen Print + Embroidery']) assert.equal(screenPrintJobScope(job({ decoration })).state, 'unresolved')
  const items = [{ decoration: 'Screen Print', sizes: { M: 72 } }, { decoration: 'Embroidery', sizes: { L: 72 } }]
  assert.equal(screenPrintJobScope(job({ est_items: JSON.stringify(items) })).state, 'unresolved')
  assert.equal(screenPrintJobScope(job({ est_items: [{ sizes: { M: 144 } }] })).state, 'unresolved')
  assert.equal(screenPrintJobScope(job({ est_items: [{ decoration: 'Screen Print', matrix: { name: 'DTF' }, sizes: { M: 144 } }] })).state, 'unresolved')
  assert.equal(screenPrintJobScope(job({ line_sizes: [{ sizes: { M: 144 } }] })).state, 'modeled', 'historical quantity-only snapshots do not invent a method conflict')
  assert.equal(screenPrintJobScope(job({ line_sizes: [{ sizes: { M: 144 }, decoration: 'Laser' }] })).state, 'unresolved')
  assert.equal(screenPrintJobScope(job({ est_items: '{broken' })).state, 'unresolved')
  assert.equal(screenPrintJobScope(job({ est_items: [{ decoration: 'Screen Print', sizes: { M: 144 }, matrix: { name: 'My custom contract sheet', decoration: 'Screen Print' } }] })).state, 'modeled', 'an explicitly classified matrix may have a custom name')
  assert.equal(screenPrintJobScope(job({ est_items: [{ decoration: 'Screen Print', sizes: { M: 144 }, matrix: { name: 'Screen Print', decoration: 'DTF' } }] })).state, 'unresolved', 'a matrix title cannot override its actual method')
  assert.deepEqual(unsupportedScreenPrintMethods([{ decoration: 'Screen Print', sizes: { M: 144 } }, { description: 'Shipping', qty: 1 }, { description: 'Discount', qty: 1 }]), [])
  assert.deepEqual(unsupportedScreenPrintMethods(items), ['Embroidery'])
})

test('QC and shipping reserve no second press run, including finished workflow production', () => {
  const pending = job(), qc = job({ id: 2, stage: 'qc' }), shipping = job({ id: 3, stage: 'shipping' })
  const baseline = capacityReport([pending], settings)
  const result = capacityReport([pending, qc, shipping], settings)
  assert.equal(result.bookedHours, baseline.bookedHours)
  assert.deepEqual(result.timeline, baseline.timeline)
  assert.equal(result.modeled_count, 1); assert.equal(result.excluded_count, 2); assert.equal(result.scope_complete, true)
  for (const status of ['done', 'skipped']) {
    const closed = job({ workflow_enrolled: true, workflow_tasks: [task({ status }), task({ id: 2, stage: 'qc' })] })
    assert.equal(screenPrintJobScope(closed).state, 'finished')
    assert.equal(capacityReport([closed], settings).bookedHours, 0)
  }
  assert.equal(screenPrintJobScope(job({ status: 'complete', stage: 'new' })).state, 'finished')
})

test('remaining custom production work cannot disappear behind a QC or shipping board stage', () => {
  for (const stage of ['qc', 'shipping']) {
    const pending = job({ stage, workflow_enrolled: true, workflow_tasks: [task(), task({ id: 2, stage: 'qc' })] })
    assert.equal(screenPrintJobScope(pending).state, 'modeled')
    assert(capacityReport([pending], settings).bookedHours > 0)
    for (const status of ['pending', 'done', 'skipped']) {
      const repeat = job({ stage, workflow_enrolled: true, workflow_tasks: [task({ status }), task({ id: 2, position: 5 })] })
      assert.equal(screenPrintJobScope(repeat).code, 'multiple_production_steps')
      const date = promise([repeat], settings, { pieces: 24, colors: 1 })
      assert.equal(date.earliestFinish, null); assert.equal(date.feasible, null)
    }
  }
  for (const tasks of [[], [task({ stage: 'qc' })], [task({ status: 'unknown' })]])
    assert.equal(screenPrintJobScope(job({ workflow_enrolled: true, workflow_tasks: tasks })).state, 'unresolved')
})

test('unknown methods, stages and quantities block date verdicts while preserving an honest partial load', () => {
  for (const uncertain of [job({ id: 2, decoration: 'DTF' }), job({ id: 2, stage: 'unknown' }), job({ id: 2, sizes: '{}' })]) {
    const result = capacityReport([job(), uncertain], settings)
    assert.equal(result.scope_complete, false); assert.equal(result.modeled_count, 1); assert.equal(result.unresolved_count, 1)
    assert.equal(result.jobs.length, 2); assert.equal(result.unresolved[0].id, 2)
    const check = promise([job(), uncertain], settings, { pieces: 24, colors: 1, dueDate: '2099-01-01' })
    assert.equal(check.earliestFinish, null); assert.equal(check.feasible, null); assert.match(check.reason, /manual capacity review/)
  }
})

test('prospective unsupported methods never acquire a positive date, including explicit blank and conflicts', () => {
  for (const proposed of [{ decoration: '' }, { decoration: 'Embroidery' }, { method: 'Laser' }, { decoration: 'Screen Print', method: 'DTF' }]) {
    const result = promise([], settings, { pieces: 24, colors: 1, ...proposed })
    assert.equal(result.feasible, null); assert.equal(result.earliestFinish, null); assert.equal(result.scope_complete, false)
  }
  for (const proposed of [{}, { decoration: 'Screen Print' }, { method: 'screen_print' }]) {
    const result = promise([], settings, { pieces: 24, colors: 1, ...proposed })
    assert.equal(result.feasible, true); assert.equal(result.scope, 'screen_print'); assert.equal(result.scope_complete, true)
    assert.match(result.earliestFinish, /^\d{4}-\d{2}-\d{2}$/)
  }
})

test('one job still uses one press; separate jobs can share the pooled presses', () => {
  const big = job({ sizes: '{"M":2000}', colors: 6 })
  const many = { ...settings, capacity_stations: 8 }
  const one = schedule([big], settings), eight = schedule([big], many)
  assert.equal(one.jobs[0].projectedFinish, eight.jobs[0].projectedFinish)
  const p1 = promise([], settings, { pieces: 2000, colors: 6 }), p8 = promise([], many, { pieces: 2000, colors: 6 })
  assert.equal(p1.earliestFinish, p8.earliestFinish); assert.equal(p1.earliestFinish, one.jobs[0].projectedFinish)
  const jobs = Array.from({ length: 8 }, (_, id) => ({ ...big, id }))
  assert(schedule(jobs, many).jobs.at(-1).projectedFinish < schedule(jobs, settings).jobs.at(-1).projectedFinish)
  assert.equal(dailyCapacity(settings).minutes, 144)
  assert.equal(jobMinutes(job(), settings), jobMinutes(job({ sizes: { M: 144 } }), settings))
})

test('numeric horizon remains bounded and a too-large queued job blocks later date promises', () => {
  const start = performance.now()
  const result = promise([], settings, { pieces: 1e13, colors: 6 })
  assert(performance.now() - start < 2000)
  assert.equal(result.beyondHorizon, true); assert.equal(result.feasible, false); assert.equal(result.earliestFinish, null)
  assert.match(result.reason, /split it into smaller runs/)
  const enormous = job({ sizes: '{"M":10000000000000}' })
  const report = capacityReport([enormous], settings)
  assert.equal(report.scope_complete, false); assert.equal(report.unresolved[0].scope_code, 'beyond_horizon')
  assert.equal(promise([enormous], settings, { pieces: 24 }).earliestFinish, null)
})
