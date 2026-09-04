import test from 'node:test'
import assert from 'node:assert/strict'

test('large shop queues stay bounded, retain task gates and count every job in cost totals', async () => {
  process.env.PSC_DB = ':memory:'
  const d = await import('../lib/db.mjs'),
    c = await import('../lib/costing.mjs'),
    p = await import('../lib/production.mjs')
  const { initSuppliers } = await import('../lib/suppliers.mjs')
  const db = d.getDb()
  initSuppliers(db)
  const prepare = db.prepare.bind(db)
  try {
    d.run("INSERT INTO contacts(id,name) VALUES(1,'Scale shop')")
    d.setSetting('production_auto', '1')
    const est = prepare(
      "INSERT INTO estimates(id,contact_id,estimate_number,subtotal,tax,total,items) VALUES(?,1,?,100,8,108,'[]')"
    )
    const inv = prepare(
      'INSERT INTO invoices(id,contact_id,estimate_id,invoice_number,amount_due) VALUES(?,1,?,?,108)'
    )
    const job = prepare(
      `INSERT INTO jobs(id,contact_id,estimate_id,invoice_id,job_number,title,decoration,stage,status,sizes) VALUES(?,1,?,?,?,'Scale job','Screen Print','new','active','{"M":10}')`
    )
    const cost = prepare('INSERT INTO costing_jobs(job_id,material_cost,consumable_cost) VALUES(?,20,2)')
    const op = prepare(
      "INSERT INTO costing_operations(job_id,machine_id,member_id,machine_name,employee_name,method,units,planned_minutes,actual_minutes,good_units,machine_rate,labor_rate,overhead_rate) VALUES(?,1,1,'Press','Printer','Screen print',10,15,15,10,10,20,5)"
    )
    const credit = prepare(
      "INSERT INTO invoice_credits(reference,invoice_id,subtotal_cents,tax_cents,reason,currency,created_at) VALUES(?,?,1000,80,'Fixture','USD',CURRENT_TIMESTAMP)"
    )
    const n = 1500
    db.exec('BEGIN')
    for (let id = 1; id <= n; id++) {
      est.run(id, 'E' + id)
      inv.run(id, id, 'I' + id)
      job.run(id, id, id, 'J' + id)
      cost.run(id)
      op.run(id)
      if (id % 10 === 0) credit.run('credit-' + id, id)
    }
    db.exec('COMMIT')
    let reads = 0
    db.prepare = (sql) => {
      if (/^\s*(SELECT|WITH)/i.test(sql)) reads++
      return prepare(sql)
    }
    const first = c.costComparison({ pageSize: 25 })
    assert(reads <= 12, `Cost comparison repeated ${reads} reads`)
    assert.equal(first.pagination.total, n)
    assert.equal(first.pagination.pages, 60)
    assert.equal(first.jobs.length, 25)
    for (const key of ['machines', 'employees', 'methods']) {
      assert.equal(first[key][0].allocated_profit, n * 69.25 - (n / 10) * 10)
      assert.equal(first[key][0].cost, n * 8.75)
      assert.equal(first[key][0].output_hour, 40)
    }
    for (const row of first.jobs.slice(0, 5)) {
      const single = c.jobCosting(row.job.id)
      for (const field of ['revenue', 'cost', 'profit', 'margin']) assert.equal(row[field], single[field])
    }
    const second = c.costComparison({ page: 2, pageSize: 25 }),
      last = c.costComparison({ page: 60, pageSize: 25 })
    assert.equal(last.jobs.at(-1).job.id, 1)
    assert(!second.jobs.some((j) => first.jobs.some((x) => x.job.id === j.job.id)))
    assert.deepEqual(first.machines, second.machines)
    assert.throws(() => c.costComparison({ page: 0 }), /positive page/)
    assert.throws(() => p.productionQueue({ pageSize: 10000 }), /page size/)

    // Different real gate conditions, including manual counts, shortages, approvals and payment review.
    d.run("INSERT INTO production_counts(job_id,counts,counted_by) VALUES(1,'{\"M\":10}','Receiver')")
    d.run("INSERT INTO purchase_orders(id,job_id,status) VALUES(1,2,'submitted')")
    d.run('INSERT INTO po_lines(po_id,qty_ordered,qty_received) VALUES(1,10,9)')
    d.run("INSERT INTO purchase_orders(id,job_id,status) VALUES(2,3,'closed')")
    d.run("UPDATE invoices SET payment_review='Review refund' WHERE id=4")
    d.run("UPDATE production_tasks SET status='done' WHERE job_id=5 AND position<3")
    d.run('UPDATE jobs SET approval_gated=1 WHERE id=5')
    d.run('UPDATE production_tasks SET assigned_id=7 WHERE job_id=1')
    reads = 0
    const queue = p.productionQueue({ pageSize: 100 })
    assert(reads <= 6, `Production queue repeated ${reads} reads`)
    assert.equal(queue.total, n * 6 - 3)
    assert.equal(queue.ready, 2)
    assert.equal(queue.rows.length, 100)
    assert.equal(queue.rows[0].blocked, '')
    assert.equal(queue.rows[1].blocked, '')
    assert(queue.rows[2].blocked)
    const assigned = p.productionQueue({ mine: true, memberId: 7 })
    assert.equal(assigned.total, 6)
    assert(assigned.rows.every((r) => r.job_id === 1))
    const department = p.productionQueue({ department: 'QC' })
    assert.equal(department.total, n)
    assert(department.rows.every((r) => r.task.department === 'QC'))
    for (const row of queue.rows) {
      const job = d.get('SELECT * FROM jobs WHERE id=?', row.job_id)
      assert.equal(row.blocked, p.taskBlock(job, row.task, p.workflow(row.job_id).tasks))
    }
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0)
  } finally {
    db.prepare = prepare
    db.close()
  }
})
