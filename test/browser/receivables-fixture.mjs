/** Caller supplies only its newly created, disposable demo database. */
export function seedReceivablesReview(db) {
  db.exec("UPDATE automations SET enabled=0; UPDATE invoices SET status='void',payment_review='';")
  const customer = Number(db.prepare("INSERT INTO contacts(name,company) VALUES('Receivables sample customer','Synthetic receivables shop')").run().lastInsertRowid)
  const insert = db.prepare(`INSERT INTO invoices(contact_id,invoice_number,status,amount_due,amount_paid,due_date,payment_review,created_at)
    VALUES(?,?,?,?,?,?,?,'2026-01-01 12:00:00')`)
  const ids = {}
  for (const [number, status, due, paid, review] of [
    ['AR-BROWSER-OPEN', 'partial', 80.15, 20.05, 'Credit changed; review the remaining balance.'],
    ['AR-BROWSER-UNPAUSED', 'partial', 0.30, 0.20, ''],
    ['AR-BROWSER-CREDITED', 'paid', 0, 0, 'Fully credited. No payment should be requested.'],
    ['AR-BROWSER-OVERPAID', 'paid', 50, 75.25, 'Review the customer credit balance.'],
    ['AR-BROWSER-VOID', 'void', 999, 0, 'A void must stay excluded.'],
    ['AR-BROWSER-SETTLED', 'paid', 25, 25, ''],
  ]) {
    const id = Number(insert.run(customer, number, status, due, paid, number === 'AR-BROWSER-UNPAUSED' ? null : '2026-01-15', review).lastInsertRowid)
    ids[number] = id
    if (paid) db.prepare("INSERT INTO payments(invoice_id,amount,method,created_at) VALUES(?,?,'synthetic fixture','2026-01-02 12:00:00')").run(id, paid)
  }
  const credit = db.prepare(`INSERT INTO invoice_credits(reference,invoice_id,subtotal_cents,tax_cents,reason,currency,created_at,cancelled_at)
    VALUES(?,?,?,?,?,'USD','2026-01-03 12:00:00',?)`)
  credit.run('browser-ar-active-credit-001', ids['AR-BROWSER-OPEN'], 2000, 150, 'Synthetic allowance', null)
  credit.run('browser-ar-canceled-credit-001', ids['AR-BROWSER-OPEN'], 50000, 0, 'Canceled synthetic allowance', '2026-01-04 12:00:00')
  credit.run('browser-ar-full-credit-001', ids['AR-BROWSER-CREDITED'], 10000, 0, 'Synthetic full credit', null)
  credit.run('browser-ar-overpaid-credit-001', ids['AR-BROWSER-OVERPAID'], 5000, 0, 'Synthetic partial credit', null)
  const setBase = db.prepare('UPDATE invoices SET credit_base=? WHERE id=?')
  setBase.run(JSON.stringify({ amount_due: 101.65, subtotal: 100, tax: 1.65, tax_known: true, currency: 'USD' }), ids['AR-BROWSER-OPEN'])
  for (const number of ['AR-BROWSER-CREDITED', 'AR-BROWSER-OVERPAID']) setBase.run(JSON.stringify({ amount_due: 100, subtotal: 100, tax: 0, tax_known: true, currency: 'USD' }), ids[number])
  db.prepare("UPDATE settings SET value='USD' WHERE key='currency'").run()
  db.prepare("UPDATE settings SET value='en-US' WHERE key='locale'").run()
  return { customer, ids }
}

export function receivablesSnapshot(db) {
  return Object.fromEntries(['invoices', 'invoice_credits', 'payments'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
}
