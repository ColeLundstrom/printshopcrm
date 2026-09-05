import test from 'node:test'
import assert from 'node:assert/strict'
test('machine costing uses snapshots, separates estimates and recorded output, and conserves allocations', async () => {
  process.env.PSC_DB = ':memory:'
  const { getDb, run, get, setSetting } = await import('../lib/db.mjs'),
    c = await import('../lib/costing.mjs'),
    { initSuppliers } = await import('../lib/suppliers.mjs')
  const db = getDb()
  initSuppliers(db)
  try {
    run("INSERT INTO contacts(id,name) VALUES(1,'Sample')")
    run(
      "INSERT INTO estimates(id,contact_id,estimate_number,subtotal,tax,total,items) VALUES(1,1,'EST-1',1000,80,1080,'[]')"
    )
    run(
      "INSERT INTO invoices(id,contact_id,estimate_id,invoice_number,amount_due) VALUES(1,1,1,'INV-1',1080)"
    )
    run(
      `INSERT INTO jobs(id,contact_id,estimate_id,invoice_id,job_number,title,stage,status,sizes) VALUES(1,1,1,1,'JOB-1','Sample','new','active','{"M":100}')`
    )
    const members = [{ id: 1, name: 'Operator', status: 'active' }]
    c.saveCostingConfig(
      {
        settings: { hours_day: 8, days_week: 5, productive_pct: 100, overhead_month: 400 },
        employees: [{ member_id: 1, hourly_cost: 20 }]
      },
      members
    )
    let machine = c.saveMachine(null, {
      name: 'Press 1',
      method: 'Screen printing',
      hourly_cost: 10,
      output_hour: 100,
      setup_minutes: 30,
      hours_week: 40
    })
    let d = c.saveJobCosts(
      1,
      { revision: 0, customer_supplied: true, material_cost: null, other_cost: 25 },
      'Owner'
    )
    assert.equal(d.revenue, 1000)
    assert.equal(d.breakdown.materials, 0)
    const b = {
      revision: d.revision,
      machine_id: machine.id,
      member_id: 1,
      units: 100,
      planned_minutes: null,
      actual_minutes: null,
      good_units: null,
      note: ''
    }
    d = c.saveOperation(1, null, b, 'Owner', members)
    assert.equal(d.operations[0].planned_minutes, 90)
    assert.equal(d.operations[0].basis, 'planned')
    assert.equal(d.operations[0].output_hour, null)
    assert.throws(() => c.saveOperation(1, null, b, 'Owner', members), /changed/)
    const snapshot = d.operations[0].machine_rate
    c.saveMachine(machine.id, { ...machine, hourly_cost: 999, output_hour: 999 })
    d = c.saveOperation(
      1,
      d.operations[0].id,
      {
        ...b,
        revision: d.revision,
        planned_minutes: 90,
        actual_minutes: 60,
        good_units: 95,
        note: 'Recorded finished run'
      },
      'Owner',
      members
    )
    assert.equal(d.operations[0].machine_rate, snapshot)
    assert.equal(d.operations[0].output_hour, 95)
    assert.equal(d.operations[0].basis, 'recorded')
    assert.equal(d.profit, Math.round((d.revenue - d.cost) * 100) / 100)
    const totals = c.costComparison()
    for (const k of ['machines', 'employees', 'methods'])
      assert.equal(
        totals[k].reduce((s, r) => s + r.allocated_profit, 0),
        d.profit
      )
    assert.throws(
      () =>
        c.saveOperation(
          1,
          d.operations[0].id,
          { ...b, revision: d.revision, actual_minutes: 0, good_units: 20, note: 'Impossible' },
          'Owner',
          members
        ),
      /elapsed time/
    )
    assert.throws(() => c.saveMachine(null, { ...machine, hourly_cost: Infinity }), /hourly_cost/)
    run(
      "INSERT INTO invoice_credits(reference,invoice_id,subtotal_cents,tax_cents,reason,currency,created_at) VALUES('test-credit',1,10000,800,'Sample','USD',CURRENT_TIMESTAMP)"
    )
    assert.equal(c.jobCosting(1).revenue, 900)
    const latest = c.jobCosting(1),
      op = latest.operations[0]
    const voided = c.voidOperation(
      1,
      op.id,
      { revision: latest.revision, reason: 'Duplicate run entered' },
      'Owner'
    )
    assert.equal(voided.operations.length, 0)
    assert(get('SELECT voided_at FROM costing_operations WHERE id=?', op.id).voided_at)
    assert.throws(
      () => c.saveOperation(1, op.id, { ...b, revision: voided.revision }, 'Owner', members),
      /not found/
    )
    const override = c.saveJobCosts(
      1,
      {
        revision: voided.revision,
        customer_supplied: true,
        material_cost: null,
        other_cost: 25,
        consumable_cost: 12.34
      },
      'Owner'
    )
    assert.equal(override.breakdown.consumables, 12.34)
    assert.throws(
      () =>
        c.saveJobCosts(
          1,
          {
            revision: override.revision,
            customer_supplied: true,
            material_cost: null,
            other_cost: 0,
            consumable_cost: -1
          },
          'Owner'
        ),
      /Decoration/
    )
    const mx = await import('../lib/matrices.mjs')
    const { lineBlankCost } = await import('../public/js/shared/pricing.js')
    for (const key of ['screen-print', 'dtf', 'embroidery']) {
      const matrix = mx.createFromTemplate('contract-' + key)
      assert.equal(matrix.customerSupplied, true)
      assert(matrix.decoration)
      const copy = mx.duplicateMatrix(matrix.id)
      assert.equal(copy.customerSupplied, true)
      assert.equal(
        lineBlankCost({ garment_cost: 10, matrix: { customerSupplied: matrix.customerSupplied } }),
        0
      )
      assert.equal(mx.updateMatrix(matrix.id, { name: 'Revised ' + key }).customerSupplied, true)
    }

    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  } finally {
    db.close()
  }
})
