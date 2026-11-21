import test from 'node:test'
import assert from 'node:assert/strict'

test('profit coverage counts jobs without a sale value without changing priced-job totals', async () => {
  process.env.PSC_DB = ':memory:'
  const { getDb, run } = await import('../lib/db.mjs')
  const { initSuppliers } = await import('../lib/suppliers.mjs')
  const { shopRoi } = await import('../lib/roi.mjs')
  const { shopInsights } = await import('../lib/insights.mjs')
  initSuppliers(getDb())
  run("INSERT INTO contacts(id,name) VALUES(1,'Synthetic customer')")
  run("INSERT INTO estimates(id,contact_id,estimate_number,subtotal,total,items) VALUES(1,1,'EST-1',100,100,'[]')")
  run("INSERT INTO jobs(id,contact_id,estimate_id,job_number,title,stage,status) VALUES(1,1,1,'JOB-1','Priced','complete','complete')")

  const before = shopRoi({ completedOnly: true }).totals
  assert.equal(before.count, 1)
  assert.equal(before.total_jobs, 1)
  assert.equal(before.excluded_jobs, 0)
  assert.equal(before.coverage_pct, 100)

  run("INSERT INTO jobs(id,contact_id,job_number,title,stage,status) VALUES(2,1,'JOB-2','Unpriced','complete','complete')")
  run("INSERT INTO jobs(id,contact_id,job_number,title,stage,status) VALUES(3,1,'JOB-3','Active','production','active')")
  const completed = shopRoi({ completedOnly: true }).totals
  assert.equal(completed.count, 1)
  assert.equal(completed.total_jobs, 2)
  assert.equal(completed.excluded_jobs, 1)
  assert.equal(completed.coverage_pct, 50)
  for (const key of ['revenue', 'cost', 'profit', 'margin']) assert.equal(completed[key], before[key], key)

  const all = shopRoi().totals
  assert.equal(all.total_jobs, 3)
  assert.equal(all.excluded_jobs, 2)
  assert.equal(all.coverage_pct, 33)
  const insights = shopInsights({ today: '2026-11-21' })
  assert.equal(insights.jobs_measured, 1)
  assert.equal(insights.jobs_completed_total, 2)
  assert.equal(insights.jobs_without_sale_value, 1)
})
