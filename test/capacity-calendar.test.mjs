import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const cases = [
  ['America/Los_Angeles', [
    ['2026-09-05T04:45:00Z', '2026-09-04'], // Friday evening must remain Friday.
    ['2026-09-06T04:45:00Z', '2026-09-07'], // Local Saturday skips to Monday.
    ['2026-11-01T08:30:00Z', '2026-11-02'], // Fall DST weekend.
  ]],
  ['Pacific/Auckland', [
    ['2026-09-06T12:45:00Z', '2026-09-07'], // Monday morning must remain Monday.
    ['2026-09-05T12:45:00Z', '2026-09-07'], // Sunday skips to Monday.
    ['2026-09-26T12:45:00Z', '2026-09-28'], // Spring DST weekend.
  ]],
  ['UTC', [['2026-09-04T21:45:00Z', '2026-09-04']]],
]
for (const [timezone, examples] of cases) test(`capacity uses one civil calendar in ${timezone}, including weekends and DST`, () => {
  const code = `
    import assert from 'node:assert/strict';
    const RealDate=Date;let clock;
    globalThis.Date=class extends RealDate {constructor(...args){super(...(args.length?args:[clock]))}static now(){return new RealDate(clock).valueOf()}};
    const {capacityReport,promise,schedule,businessDaysBetween}=await import(${JSON.stringify(new URL('../lib/capacity.mjs', import.meta.url).href)});
    const settings={capacity_stations:1,capacity_hours_per_day:8,utilization_pct:30};
    const job={id:1,status:'active',stage:'new',decoration:'Screen Print',sizes:'{"M":24}',colors:1};
    for(const [instant,expected] of ${JSON.stringify(examples)}) {
      clock=instant;
      const report=capacityReport([job],settings),checked=promise([],settings,{pieces:24,colors:1,dueDate:expected});
      assert.equal(report.jobs[0].projectedFinish,expected);
      assert.equal(report.bookedThrough,expected);
      assert.equal(report.timeline[0].date,expected);
      assert.equal(checked.earliestFinish,expected);
      assert.equal(checked.feasible,true);assert.equal(checked.slackDays,0);assert.equal(checked.workingDaysOut,0);
      assert.equal(report.calendar_timezone,${JSON.stringify(timezone)});assert.equal(checked.calendar_timezone,${JSON.stringify(timezone)});
      for(const day of report.timeline)assert(![0,6].includes(new RealDate(day.date+'T12:00:00').getDay()),day.date);
    }
    // Local noon during NZ daylight saving is on the prior UTC day; explicit start dates must
    // not shift either. Two full press days starting Friday finish Monday in every timezone.
    assert.equal(schedule([{id:2,minutes:288}],settings,{from:'2026-10-02'}).jobs[0].projectedFinish,'2026-10-05');
    assert.equal(businessDaysBetween('2026-10-30','2026-11-02'),1);
    assert.equal(businessDaysBetween('2026-09-25','2026-09-28'),1);
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TZ: timezone }, encoding: 'utf8', timeout: 10000 })
  assert.equal(child.status, 0, `${child.error?.code || ''}\n${child.stderr}\n${child.stdout}`)
})
