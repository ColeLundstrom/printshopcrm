import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

test('credits preserve original tax and cash, roll back failures, and stop delayed collections',async()=>{
  process.env.PSC_DB=':memory:'
  const {run,get,all,getDb,setSetting,syncInvoiceStatus}=await import('../lib/db.mjs')
  const {addInvoiceCredit,cancelInvoiceCredit,invoiceCreditSummary}=await import('../lib/invoice-credits.mjs')
  const {initAutomations,fire,tick}=await import('../lib/automations.mjs')
  const db=getDb();initAutomations(db)
  try {
    run("INSERT INTO contacts(id,name,email) VALUES(1,'Credit customer','credit@example.test')")
    run("INSERT INTO estimates(id,contact_id,estimate_number,subtotal,tax,total,status) VALUES(1,1,'EST-1001',100,8,108,'invoiced')")
    run("INSERT INTO invoices(id,contact_id,estimate_id,invoice_number,amount_due,due_date) VALUES(1,1,1,'INV-1001',108,'2020-01-01')")
    run("INSERT INTO payments(invoice_id,amount) VALUES(1,54)");syncInvoiceStatus(1)
    const original=get('SELECT * FROM estimates WHERE id=1'),c={reference:crypto.randomUUID(),subtotal:50,tax:4,reason:'Half the order canceled'}
    const emails=[];const deps={queueEmail:o=>emails.push(o),queueSms:()=>assert.fail('Unexpected SMS')}
    run("INSERT INTO automations(id,name,trigger,actions) VALUES(1,'Follow up','invoice.overdue',?)",JSON.stringify([{key:'wait',config:{days:2}},{key:'email.customer',config:{subject:'Balance {{total}}',body:'Payment needed'}}]))
    fire('invoice.overdue',{invoice:get('SELECT * FROM invoices WHERE id=1'),contact:get('SELECT * FROM contacts WHERE id=1'),total:54},deps)
    assert.equal(get('SELECT count(*) AS n FROM automation_pending').n,1)
    db.exec("CREATE TRIGGER fail_credit BEFORE UPDATE OF amount_due ON invoices BEGIN SELECT RAISE(ABORT,'simulated failure'); END")
    assert.throws(()=>addInvoiceCredit(1,c),/simulated failure/)
    assert.equal(get('SELECT count(*) AS n FROM invoice_credits').n,0);assert.equal(get('SELECT credit_base FROM invoices WHERE id=1').credit_base,null)
    db.exec('DROP TRIGGER fail_credit')
    const result=addInvoiceCredit(1,c)
    assert.equal(result.invoice.amount_due,54);assert.equal(result.invoice.amount_paid,54)
    assert.deepEqual(get('SELECT * FROM estimates WHERE id=1'),original)
    assert.equal(all('SELECT * FROM payments').length,1)
    assert.equal(invoiceCreditSummary(result.invoice).credit_base.tax,8)
    assert.equal(addInvoiceCredit(1,c).duplicate,true)
    for(const patch of [{subtotal:51,tax:0},{subtotal:0,tax:5},{subtotal:0.001,tax:0},{subtotal:[1],tax:0}])assert.throws(()=>addInvoiceCredit(1,{...c,reference:crypto.randomUUID(),...patch}))
    setSetting('currency','CAD');assert.throws(()=>addInvoiceCredit(1,{...c,reference:crypto.randomUUID(),subtotal:1,tax:0}),/currency/);assert.throws(()=>cancelInvoiceCredit(1,c.reference,'Wrong currency'),/currency/);setSetting('currency','USD')
    run("UPDATE automation_pending SET due_at='2020-01-01'");tick(deps)
    assert.equal(emails.length,0);assert.equal(get('SELECT status FROM automation_pending').status,'payment_review')
    run("UPDATE invoices SET payment_review='' WHERE id=1")
    assert.equal(cancelInvoiceCredit(1,c.reference,'Canceled by mistake').invoice.amount_due,108)
    assert.equal(cancelInvoiceCredit(1,c.reference,'Retry').duplicate,true)
    assert.equal(all('SELECT * FROM payments').length,1)
    assert.deepEqual(get('SELECT * FROM estimates WHERE id=1'),original)
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok')
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0)
  } finally {db.close()}
})
