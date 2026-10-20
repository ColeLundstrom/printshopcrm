import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { isoInZone, canonicalTimezone, validTimezone, addDaysIso, effectiveTimezone } from '../lib/shop-time.mjs'

// 01:30 UTC on Oct 20 is 6:30pm on Oct 19 in California — the hour every UTC "today" was wrong.
const EVENING_PDT = '2026-10-20T01:30:00Z'

/** Run `code` in a fresh process with a frozen clock, an in-memory database and the given env. */
function child(code, { env = {}, clock = EVENING_PDT } = {}) {
  const prelude = `
    import assert from 'node:assert/strict';
    const RealDate=Date;const clock=${JSON.stringify(clock)};
    globalThis.Date=class extends RealDate {constructor(...a){super(...(a.length?a:[clock]))}static now(){return new RealDate(clock).valueOf()}};
    const lib=(f)=>import(new URL('../lib/'+f, ${JSON.stringify(import.meta.url)}).href);
  `
  const run = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', prelude + code], {
    env: { ...process.env, PSC_DB: ':memory:', PSC_TIMEZONE: '', TZ: 'UTC', ...env }, encoding: 'utf8', timeout: 20000,
  })
  assert.equal(run.status, 0, `${run.error?.code || ''}\n${run.stderr}\n${run.stdout}`)
}

test('shop-time resolves a civil date per IANA zone and refuses names it cannot use', () => {
  const at = new Date(EVENING_PDT)
  assert.equal(isoInZone('America/Los_Angeles', at), '2026-10-19')
  assert.equal(isoInZone('UTC', at), '2026-10-20')
  assert.equal(isoInZone('Pacific/Auckland', at), '2026-10-20')
  assert.equal(isoInZone('Pacific/Kiritimati', new Date('2026-10-19T10:30:00Z')), '2026-10-20')
  assert.equal(canonicalTimezone('america/los_angeles'), 'America/Los_Angeles')
  for (const bad of ['Mars/Olympus_Mons', '', '   ', 'x'.repeat(65), {}, null, 42, ['UTC']]) assert.equal(validTimezone(bad), false, String(bad))
  // A bad stored value can never break a page: it falls back to the server's zone.
  assert.equal(effectiveTimezone('Not/AZone'), effectiveTimezone(''))
  // Calendar arithmetic on dates, never instants: DST weekends and month ends do not shift.
  assert.equal(addDaysIso('2026-11-01', 1), '2026-11-02')
  assert.equal(addDaysIso('2026-03-08', -1), '2026-03-07')
  assert.equal(addDaysIso('2026-01-31', 30), '2026-03-02')
})

test("todayIso is the shop's date: due-today is not overdue, ship_date and terms land on the local day", () => child(`
  const db = await lib('db.mjs')
  // No setting and no PSC_TIMEZONE: the server's zone (UTC here) — the old behaviour, still right for a UTC shop.
  assert.equal(db.todayIso(), '2026-10-20')
  db.setSetting('timezone', 'America/Los_Angeles')
  assert.equal(db.todayIso(), '2026-10-19')
  assert.equal(db.isoDaysFrom(1), '2026-10-20')
  assert.equal(db.isoDaysFrom(-1), '2026-10-18')
  assert.equal(db.localDateOf('2026-10-20 01:30:00'), '2026-10-19')
  assert.equal(db.localDateOf('2026-10-19'), '2026-10-19')

  db.run("INSERT INTO contacts(id,name) VALUES(1,'Evening shop')")
  db.run("INSERT INTO invoices(id,contact_id,invoice_number,status,amount_due,amount_paid,due_date) VALUES(1,1,'INV-1','unpaid',100,0,'2026-10-19')")
  db.run("INSERT INTO invoices(id,contact_id,invoice_number,status,amount_due,amount_paid,due_date) VALUES(2,1,'INV-2','unpaid',100,0,'2026-10-18')")
  assert.equal(db.syncInvoiceStatus(1).status, 'unpaid', 'due today is not overdue at 6:30pm in California')
  assert.equal(db.syncInvoiceStatus(2).status, 'overdue')
  assert.deepEqual(db.all('SELECT i.invoice_number, ' + db.EFFECTIVE_STATUS_SQL + ' AS s FROM invoices i ORDER BY i.id', db.todayIso()).map((r) => r.s), ['unpaid', 'overdue'])

  db.run("INSERT INTO jobs(id,contact_id,job_number,title,stage,status) VALUES(1,1,'JOB-1','Shipped at 6pm','qc','active')")
  db.stampShipDate(db.get('SELECT * FROM jobs WHERE id=1'), 'shipping')
  assert.equal(db.get('SELECT ship_date FROM jobs WHERE id=1').ship_date, '2026-10-19')

  // A proof approved at 6:30pm local starts its turnaround on the local day, not tomorrow.
  const gated = { approval_gated: 1, turnaround_days: 1, art_approved_at: '2026-10-20 01:30:00', stage: 'prepress', due_date: null }
  assert.equal(db.scheduleFor(gated).approvedOn, '2026-10-19')
  assert.equal(db.scheduleFor(gated).due, '2026-10-20')
  const waiting = { approval_gated: 1, turnaround_days: 1, stage: 'art_approval', due_date: null }
  assert.equal(db.scheduleFor(waiting).due, '2026-10-20', 'projected from the local Monday, one business day')

  const { paymentDueDate } = await lib('payment-terms.mjs')
  assert.equal(paymentDueDate('net_30', db.todayIso()), '2026-11-18')
  const { customerStatement } = await lib('pdf.mjs')
  assert.ok(customerStatement({ contact: { name: 'Evening shop' }, settings: db.getSettings(), invoices: [] }).length > 0)
`))

test('PSC_TIMEZONE is the fallback for a shop with no zone; a shop setting overrides it', () => child(`
  const db = await lib('db.mjs')
  assert.equal(db.todayIso(), '2026-10-19')
  db.setSetting('timezone', 'Pacific/Auckland')
  assert.equal(db.todayIso(), '2026-10-20')
`, { env: { PSC_TIMEZONE: 'America/Los_Angeles' } }))

test('addBusinessDays keeps the civil date east of UTC+12', () => child(`
  const db = await lib('db.mjs')
  // Local noon in Auckland daylight time is 23:00 UTC the day before; toISOString moved every result back a day.
  assert.equal(db.addBusinessDays('2026-10-16', 1), '2026-10-19')
  assert.equal(db.addBusinessDays('2026-10-19', 5), '2026-10-26')
`, { env: { TZ: 'Pacific/Auckland' } }))

test('capacity reads the shop timezone from its settings', () => child(`
  const { capacityReport, promise } = await lib('capacity.mjs')
  const job = { id: 1, status: 'active', stage: 'new', decoration: 'Screen Print', sizes: '{"M":24}', colors: 1 }
  // Friday evening in California (Saturday in UTC) must still schedule on Friday.
  const shop = { capacity_stations: 1, capacity_hours_per_day: 8, utilization_pct: 30, timezone: 'America/Los_Angeles' }
  const report = capacityReport([job], shop)
  assert.equal(report.timeline[0].date, '2026-09-04')
  assert.equal(report.calendar_timezone, 'America/Los_Angeles')
  assert.equal(promise([], shop, { pieces: 24, colors: 1 }).earliestFinish, '2026-09-04')
  // The same instant for a shop with no zone, on a UTC server, is Saturday: Monday is the first day.
  assert.equal(capacityReport([job], { ...shop, timezone: '' }).timeline[0].date, '2026-09-07')
`, { clock: '2026-09-05T04:45:00Z' }))

test('timed automations cut off on the shop-local date; flag_rush reaches workflow jobs', () => child(`
  const db = await lib('db.mjs')
  const { initAutomations, tick } = await lib('automations.mjs')
  const { initSuppliers } = await lib('suppliers.mjs')
  const p = await lib('production.mjs')
  initAutomations(db.getDb()); initSuppliers(db.getDb())
  db.setSetting('timezone', 'America/Los_Angeles')   // local today = 2026-10-19
  db.run("INSERT INTO contacts(id,name) VALUES(1,'Timed shop')")
  db.run("INSERT INTO invoices(id,contact_id,invoice_number,status,amount_due,amount_paid,due_date) VALUES(1,1,'INV-TODAY','unpaid',100,0,'2026-10-19')")
  db.run("INSERT INTO invoices(id,contact_id,invoice_number,status,amount_due,amount_paid,due_date) VALUES(2,1,'INV-LATE','unpaid',100,0,'2026-10-18')")
  db.run("INSERT INTO jobs(id,contact_id,job_number,title,decoration,stage,status,due_date) VALUES(1,1,'JOB-TODAY','Due today','Screen Print','production','active','2026-10-19')")
  db.run("INSERT INTO jobs(id,contact_id,job_number,title,decoration,stage,status,due_date) VALUES(2,1,'JOB-PAST','Due yesterday','Screen Print','production','active','2026-10-18')")
  db.initDb(db.getDb())
  const t = p.templates()[0]
  p.applyWorkflow(1, { revision: 0, template_ids: [t.id] }, 'Manager')
  const rule = (name, trigger, params, actions) => db.run('INSERT INTO automations(name,enabled,trigger,params,conditions,actions,created_at) VALUES(?,1,?,?,?,?,?)', name, trigger, JSON.stringify(params), '[]', JSON.stringify(actions), db.now())
  rule('Chase', 'invoice.overdue', { days: 1 }, [{ key: 'note.log', config: { body: 'chased' } }])
  rule('Soon', 'job.due_soon', { days: 2 }, [{ key: 'job.flag_rush', config: {} }])
  const fired = tick({})
  assert.deepEqual(fired.filter((f) => f.startsWith('invoice.overdue')), ['invoice.overdue INV-LATE'], 'days=1 does not fire on the due date')
  assert.deepEqual(fired.filter((f) => f.startsWith('job.due_soon')), ['job.due_soon JOB-TODAY'], "today's job is still due soon in the evening")
  assert.equal(db.get('SELECT rush FROM jobs WHERE id=1').rush, 1, 'flag_rush is not blocked by the job workflow')
  assert.equal(db.get("SELECT status FROM automation_runs WHERE trigger='job.due_soon'").status, 'ran')
`))

test('a stage change from lib/ emits once, after commit, and never for a rolled-back move', () => child(`
  const db = await lib('db.mjs')
  const seen = []
  db.onJobStage((e) => seen.push(e.to + ':' + db.get('SELECT stage FROM jobs WHERE id=1').stage))
  db.run("INSERT INTO contacts(id,name) VALUES(1,'Hook shop')")
  db.run("INSERT INTO jobs(id,contact_id,job_number,title,stage,status) VALUES(1,1,'JOB-1','Hook','new','active')")
  db.emitJobStage({ job_id: 1, from: 'new', to: 'new' })
  assert.deepEqual(seen, [], 'no-op moves are not announced')
  db.tx(() => {
    db.run("UPDATE jobs SET stage='prepress' WHERE id=1")
    db.emitJobStage({ job_id: 1, from: 'new', to: 'prepress' })
    assert.deepEqual(seen, [], 'deferred while the transaction is open')
  })
  await null
  assert.deepEqual(seen, ['prepress:prepress'])
  // A move that rolls back is re-read by the listener and found not to have happened.
  const hooked = []
  db.onJobStage((e) => { if (db.get('SELECT stage FROM jobs WHERE id=?', e.job_id).stage === e.to) hooked.push(e.to) })
  assert.throws(() => db.tx(() => {
    db.run("UPDATE jobs SET stage='qc' WHERE id=1")
    db.emitJobStage({ job_id: 1, from: 'prepress', to: 'qc' })
    throw new Error('rolled back')
  }), /rolled back/)
  await null
  assert.deepEqual(hooked, [])
  // Nested tx is a savepoint: the inner unit rolls back alone, the outer commits.
  db.tx(() => {
    db.run("UPDATE jobs SET title='outer' WHERE id=1")
    assert.throws(() => db.tx(() => { db.run("UPDATE jobs SET title='inner' WHERE id=1"); throw new Error('inner fails') }), /inner fails/)
  })
  assert.equal(db.get('SELECT title FROM jobs WHERE id=1').title, 'outer')
`))

test('CSV dates: no day 31 in a 30-day month, and a named date is not shifted by the server zone', () => child(`
  const { coerceDate } = await lib('csv.mjs')
  assert.equal(coerceDate('2026-02-30'), null)
  assert.equal(coerceDate('04/31/2026'), null)
  assert.equal(coerceDate('2026-02-29'), null)
  assert.equal(coerceDate('02/29/2028'), '2028-02-29')
  assert.equal(coerceDate('12/31/2026'), '2026-12-31')
  assert.equal(coerceDate('Jan 5, 2026'), '2026-01-05')
  assert.equal(coerceDate('5 January 2026'), '2026-01-05')
`, { env: { TZ: 'Asia/Tokyo' } }))
