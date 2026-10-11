import test from 'node:test'
import assert from 'node:assert/strict'

process.env.PSC_DB = ':memory:'
const d = await import('../lib/db.mjs')
const { initSuppliers, purchaseOrderPlacement } = await import('../lib/suppliers.mjs')
const { purchasingQueue } = await import('../lib/purchasing-queue.mjs')
const db = d.getDb()
initSuppliers(db)
d.run("INSERT INTO contacts(id,name) VALUES(1,'Synthetic shop')")
const add = (id, { status = 'submitted', ordered = 10, received = 0, due = '2026-10-20', supplier = 'Fixture Supply', confirmed = true, jobStatus = 'active', orphan = false, rush = 0 } = {}) => {
  if (!orphan) d.run('INSERT INTO jobs(id,contact_id,job_number,title,due_date,status,rush) VALUES(?,1,?,?,?,?,?)', id, `J${id}`, `Fixture ${id}`, due, jobStatus, rush)
  d.run('INSERT INTO purchase_orders(id,job_id,po_number,supplier,status,order_id,submitted_at) VALUES(?,?,?,?,?,?,?)', id, orphan ? null : id, `PO${id}`, supplier, status, confirmed ? `REF${id}` : null, confirmed ? '2026-10-01 12:00:00' : null)
  if (ordered !== null) d.run('INSERT INTO po_lines(po_id,style,color,size,qty_ordered,qty_received,unit_cost) VALUES(?,\'Synthetic tee\',\'White\',\'M\',?,?,4)', id, ordered, received)
}

test('purchasing queue separates unresolved quantities, placement evidence and recorded short closes', () => {
  add(1)
  add(2, { received: 4, due: '2026-10-12' })
  add(3, { status: 'manual_required', confirmed: false, due: '2026-10-11' })
  add(4, { status: 'closed', received: 3 })
  add(5, { status: 'received', received: 10 })
  add(6, { status: 'cancelled' })
  add(7, { confirmed: false, status: 'placed_manually', received: 10 })
  add(8, { ordered: null })
  add(9, { jobStatus: 'complete' })
  add(10, { orphan: true, supplier: 'Other Supply' })
  add(11, { status: 'partial', received: 2, supplier: '100% _ Supply', due: '' })
  add(12, { confirmed: false, status: 'placed_manually' })
  d.run("INSERT INTO po_manual_confirmations(po_id,supplier,reference,manifest,recorded_by,confirmed_at) VALUES(12,'Fixture Supply','MANUAL','{}','Fixture manager','2026-10-01 12:00:00')")
  const q = purchasingQueue()
  assert.equal(q.total, 9)
  assert.deepEqual(q.rows.slice(0,2).map(r => r.id), [3,2], 'Earliest due jobs first')
  assert.equal(q.rows.find(r => r.id === 3).placement_state, 'manual_required')
  assert.equal(q.rows.find(r => r.id === 7).placement_state, 'unverified_legacy', 'Received totals do not prove placement')
  assert.equal(q.rows.find(r => r.id === 8).ordered, 0)
  assert.equal(q.rows.find(r => r.id === 9).job_status, 'complete', 'Completed jobs cannot hide open POs')
  assert.equal(q.rows.find(r => r.id === 10).job_id, null)
  assert.equal(q.rows.find(r => r.id === 12).placement_state, 'confirmed_manual')
  assert.equal(q.summary.outstanding_units, 64)
  assert.equal(q.summary.short_closed, 1)
  assert.equal(q.summary.needs_confirmation, 2)
  assert.equal(q.summary.needs_attention, 9)
  assert(!q.rows.some(r => [4,5,6].includes(r.id)))
  assert.deepEqual(purchasingQueue({ state: 'short_closed' }).rows.map(r => r.id), [4])
  assert.equal(purchasingQueue({ state: 'short_closed' }).rows[0].outstanding, 7)
  assert.deepEqual(purchasingQueue({ state: 'confirmation' }).rows.map(r => r.id).sort((a,b) => a-b), [3,7])
  assert.deepEqual(purchasingQueue({ state: 'received' }).rows.map(r => r.id).sort((a,b) => a-b), [5,7])
  assert.equal(purchasingQueue({ state: 'all' }).total, 12)
  const raw = d.all('SELECT p.*,c.po_id AS manual_confirmation FROM purchase_orders p LEFT JOIN po_manual_confirmations c ON c.po_id=p.id')
  for (const row of purchasingQueue({ state: 'all' }).rows) assert.equal(row.placement_state, purchaseOrderPlacement(raw.find(r => r.id === row.id)))
  for (const row of q.rows) for (const field of ['est_cost', 'unit_cost', 'notes', 'order_id', 'manual_confirmation']) assert(!(field in row), `Do not expose ${field}`)
})

test('literal search, supplier filters and paging keep the same totals without writes', () => {
  const before = db.prepare('SELECT total_changes() AS n').get().n
  const q = purchasingQueue({ state: 'all', q: 'PO', supplier: 'Fixture Supply', pageSize: 3 })
  assert.equal(q.total, 10)
  assert.equal(q.pages, 4)
  assert.equal(q.rows.length, 3)
  assert.equal(q.summary.outstanding_units, 46)
  assert.deepEqual(q.summary, purchasingQueue({ state: 'all', supplier: 'Fixture Supply', q: 'PO', pageSize: 3, page: 2 }).summary)
  assert.deepEqual(purchasingQueue({ q: '100% _' }).rows.map(r => r.id), [11])
  assert.equal(purchasingQueue({ q: "' OR 1=1 --" }).total, 0)
  assert.deepEqual(purchasingQueue({ page: 1000 }).rows, [])
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before)
  for (const input of [{ state: 'bogus' }, { q: 'a'.repeat(121) }, { supplier: 'a'.repeat(101) }, { page: 0 }, { pageSize: 101 }]) assert.throws(() => purchasingQueue(input), error => error.status === 400)
})

test('per-line shortages cannot be offset by excess receipts on another size', () => {
  d.run('INSERT INTO po_lines(po_id,size,qty_ordered,qty_received) VALUES(1,\'L\',5,10)')
  const row = purchasingQueue({ q: 'PO1' }).rows.find(r => r.id === 1)
  assert.equal(row.ordered, 15)
  assert.equal(row.received, 10)
  assert.equal(row.outstanding, 10)
})

test('large queues have bounded result rows and a constant number of read queries', () => {
  db.exec('BEGIN')
  for (let id = 100; id < 1600; id++) add(id, { supplier: 'Scale Supply', due: '' })
  db.exec('COMMIT')
  const prepare = db.prepare.bind(db)
  let reads = 0
  db.prepare = sql => { if (/^\s*(SELECT|WITH)/i.test(sql)) reads++; return prepare(sql) }
  try {
    const first = purchasingQueue({ supplier: 'Scale Supply', pageSize: 25 })
    assert.equal(first.total, 1500)
    assert.equal(first.rows.length, 25)
    assert.equal(first.pages, 60)
    assert.equal(first.summary.outstanding_units, 15000)
    assert(reads <= 4, `Expected bounded queries, got ${reads}`)
    const second = purchasingQueue({ supplier: 'Scale Supply', pageSize: 25, page: 2 })
    assert(!second.rows.some(r => first.rows.some(x => x.id === r.id)))
    assert.equal(purchasingQueue({ supplier: 'Scale Supply', pageSize: 25, page: 60 }).rows.length, 25)
  } finally { db.prepare = prepare }
})

test('the authorized tenant handle isolates purchasing rows, totals and supplier choices', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const tenant = new DatabaseSync(':memory:')
  try {
    d.initDb(tenant)
    d.tenantStore.run({ db: tenant }, () => {
      initSuppliers(tenant)
      const empty = purchasingQueue({ state: 'all' })
      assert.equal(empty.total, 0)
      assert.deepEqual(empty.suppliers, [])
      assert.equal(empty.summary.recorded, 0)
      d.run("INSERT INTO purchase_orders(po_number,supplier,status) VALUES('ONLY-OTHER-SHOP','Other tenant supplier','manual_required')")
      assert.equal(purchasingQueue().rows[0].po_number, 'ONLY-OTHER-SHOP')
      assert.equal(purchasingQueue().total, 1)
    })
    assert.equal(purchasingQueue({ q: 'ONLY-OTHER-SHOP' }).total, 0)
    assert(!purchasingQueue().suppliers.includes('Other tenant supplier'))
  } finally { tenant.close() }
})
