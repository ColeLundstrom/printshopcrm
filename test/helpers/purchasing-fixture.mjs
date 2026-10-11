/** Synthetic records shared by the queue's HTTP and browser checks. No supplier is contacted. */
export function seedPurchasingFixture(db) {
  const contact = Number(db.prepare("INSERT INTO contacts(name) VALUES('Purchasing fixture customer')").run().lastInsertRowid)
  const job = db.prepare('INSERT INTO jobs(contact_id,job_number,title,due_date,status,rush,garment,sizes) VALUES(?,?,?,?,?,?,?,?)')
  const po = db.prepare('INSERT INTO purchase_orders(job_id,po_number,supplier,status,order_id,submitted_at) VALUES(?,?,?,?,?,?)')
  const line = db.prepare('INSERT INTO po_lines(po_id,style,color,size,qty_ordered,qty_received) VALUES(?,?,?,?,?,?)')
  const fixtures = [
    { key: 'PARTIAL', status: 'partial', received: 4, due: '2020-01-01', title: 'Synthetic <img src=x onerror=alert(1)> shirt run', rush: 1 },
    { key: 'MANUAL', status: 'manual_required', received: 0, due: '2030-01-01', confirmed: false },
    { key: 'SHORT', status: 'closed', received: 3, due: '2030-01-02' },
    { key: 'RECEIVED', status: 'received', received: 10, due: '2030-01-03' },
    { key: 'ORPHAN', status: 'submitted', received: 0, orphan: true },
    { key: 'EMPTY', status: 'submitted', empty: true }
  ]
  const result = {}
  for (const f of fixtures) {
    const jobId = f.orphan ? null : Number(job.run(contact, 'J-PURCHASING-' + f.key, f.title || 'Synthetic purchasing ' + f.key, f.due || '', 'active', f.rush || 0, 'Synthetic tee', '{"M":10}').lastInsertRowid)
    const id = Number(po.run(jobId, 'PO-PURCHASING-' + f.key, 'Synthetic & Supply', f.status, f.confirmed === false ? null : 'FIXTURE-REF', f.confirmed === false ? null : '2026-01-01 12:00:00').lastInsertRowid)
    if (!f.empty) line.run(id, 'Synthetic tee', 'White', 'M', 10, f.received)
    result[f.key.toLowerCase()] = { id, jobId }
  }
  return result
}
