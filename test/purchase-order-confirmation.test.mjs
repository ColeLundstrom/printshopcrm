import test from 'node:test'
import assert from 'node:assert/strict'

process.env.PSC_DB=':memory:'
const d=await import('../lib/db.mjs')
const p=await import('../lib/suppliers.mjs')
const db=d.getDb();p.initSuppliers(db)
const SS={ss_account:'fixture-account',ss_api_key:'fixture-key'}
const SM={sanmar_user:'fixture-user',sanmar_pass:'fixture-password',sanmar_cust:'12345'}
const job={id:900,job_number:'JOB-PO-900'}
const lines=[{description:'Gildan 5000 Tee — White',sizes:{M:10,L:20}}]
d.run("INSERT INTO contacts(id,name) VALUES(900,'Purchase fixture')")
d.run("INSERT INTO jobs(id,contact_id,job_number,title) VALUES(900,900,?,'Purchase fixture')",job.job_number)

test('catalog PO handoffs never submit style identifiers, including a single size',async()=>{
  const oldFetch=globalThis.fetch;let calls=0
  globalThis.fetch=async()=>{calls++;throw Error('No provider call allowed')}
  try {
    for(const settings of [SS,SM,{}])for(const grid of [{M:10},{M:10,L:20}]){
      const built=p.buildPurchaseOrder(job,grid,'Gildan 5000 Tee — White',settings)
      assert.equal(built.submission_ready,false);assert.equal(built.status,'manual_required')
      const result=await p.submitPurchaseOrder(built,settings)
      assert.equal(result.ok,false);assert.equal(result.code,'po_manual_required')
    }
    assert.equal(calls,0)
  } finally {globalThis.fetch=oldFetch}
})

test('manual acknowledgement requires current reviewed quantities and writes one immutable receipt atomically',()=>{
  const review=p.purchaseOrderReview(job,lines,SM)
  const body={confirmed:true,supplier:'SanMar',reference:'SM-TEST-001',review_key:review.review_key}
  assert.throws(()=>p.confirmManualPurchaseOrder(job,review,{...body,confirmed:false}),e=>e.code==='po_confirmation_required')
  assert.throws(()=>p.confirmManualPurchaseOrder(job,review,{...body,reference:''}),e=>e.code==='po_confirmation_reference')
  const changed=p.purchaseOrderReview(job,[{...lines[0],sizes:{M:999}}],SM)
  assert.throws(()=>p.confirmManualPurchaseOrder(job,changed,body),e=>e.code==='po_review_conflict')
  assert.equal(d.get('SELECT COUNT(*) n FROM purchase_orders WHERE job_id=900').n,0)
  const result=p.confirmManualPurchaseOrder(job,review,body,'Purchasing manager')
  assert.equal(result.ok,true);assert.equal(result.already,false)
  const po=result.purchase_order
  assert.equal(po.status,'placed_manually');assert.equal(po.placement_state,'confirmed_manual')
  assert.equal(po.received,0);assert.equal(po.ordered,30);assert.equal(po.order_id,null)
  assert.equal(po.manual_confirmation.recorded_by,'Purchasing manager')
  assert.equal(JSON.parse(po.manual_confirmation.manifest).lines.reduce((n,l)=>n+l.qty,0),30)
  const replay=p.confirmManualPurchaseOrder(job,p.purchaseOrderReview(job,lines,SM),body,'Another manager')
  assert.equal(replay.already,true);assert.equal(replay.purchase_order.manual_confirmation.recorded_by,'Purchasing manager')
  assert.throws(()=>p.confirmManualPurchaseOrder(job,p.purchaseOrderReview(job,lines,SM),{...body,reference:'DIFFERENT'}),e=>e.code==='po_confirmation_conflict')
  assert.throws(()=>d.run("UPDATE po_manual_confirmations SET reference='changed' WHERE po_id=?",po.id),/immutable/)
  // Once saved, the preview is the original PO, even if the production job is edited later.
  const later=p.purchaseOrderReview(job,[{...lines[0],sizes:{M:999}}],SM)
  assert.equal(later.review_key,review.review_key);assert.equal(later.total_units,30)
})

test('legacy placement is not evidence; acknowledgement preserves receiving and rolls back on failure',()=>{
  const legacyJob={id:901,job_number:'JOB-PO-901'}
  d.run("INSERT INTO jobs(id,contact_id,job_number,title) VALUES(901,900,?,'Legacy fixture')",legacyJob.job_number)
  const built=p.purchaseOrderReview(legacyJob,lines,SM)
  const old=p.createPurchaseOrder(legacyJob,built,{status:'placed_manually'})
  p.initSuppliers(db)
  assert.equal(p.getPurchaseOrder(old.id).status,'placed_manually')
  assert.equal(p.getPurchaseOrder(old.id).placement_state,'unverified_legacy')
  assert.equal(p.getPurchaseOrder(old.id).manual_confirmation,null)
  d.run('UPDATE po_lines SET qty_received=3 WHERE id=?',old.lines[0].id)
  const review=p.purchaseOrderReview(legacyJob,lines,SM)
  const body={confirmed:true,supplier:'SanMar',reference:'OLD-001',review_key:review.review_key}
  db.exec("CREATE TRIGGER fixture_po_fail BEFORE UPDATE ON purchase_orders BEGIN SELECT RAISE(ABORT,'fixture failure'); END")
  assert.throws(()=>p.confirmManualPurchaseOrder(legacyJob,review,body,'Manager'),/fixture failure/)
  assert.equal(p.getPurchaseOrder(old.id).manual_confirmation,null)
  assert.equal(p.getPurchaseOrder(old.id).received,3)
  db.exec('DROP TRIGGER fixture_po_fail')
  const saved=p.confirmManualPurchaseOrder(legacyJob,review,body,'Manager')
  assert.equal(saved.purchase_order.received,3)
  assert.equal(saved.purchase_order.placement_state,'confirmed_manual')
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok')
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[])
})

test('expired and malformed submission claims remain fenced, not eligible for another order',()=>{
  for(const updated_at of [null,'bad date','2000-01-01 00:00:00'])assert.equal(p.poAlreadySent({status:'submitting',updated_at}),true)
  assert.equal(p.poAlreadySent({status:'submission_uncertain'}),true)
  assert.equal(p.poAlreadySent({status:'manual_required'}),false)
  assert.equal(p.purchaseOrderPlacement({status:'placed_manually'}),'unverified_legacy')
  assert.equal(p.purchaseOrderPlacement({status:'submitted',order_id:'SS-123',submitted_at:'2026-09-04'}),'confirmed_supplier')
})

test('provider rejection, timeout, missing identifiers and oversized responses expose only safe uncertainty',async()=>{
  const original=globalThis.fetch
  const po={job:'JOB-SUPPLIER-TEST',supplier:'S&S Activewear',lines:[{sku:'fixture-exact-part',color:'White',size:'M',qty:10}]}
  const secret='SENTINEL_SUPPLIER_CREDENTIAL_123'
  try {
    for(const response of [()=>{throw Error(secret)},()=>new Response(JSON.stringify({message:secret}),{status:401}),()=>new Response('<html>'+secret+'</html>'),()=>new Response('{}'),()=>new Response(JSON.stringify({orderId:{secret}})),()=>new Response('x'.repeat(1024*1024+1))]){
      globalThis.fetch=async(_url,options)=>{assert.equal(options.redirect,'error');assert.ok(options.signal);return response()}
      await assert.rejects(()=>p.submitPurchaseOrder(po,SS),error=>{
        assert.equal(error.code,'po_submission_uncertain');assert.doesNotMatch(error.message,new RegExp(secret));assert.doesNotMatch(error.message,/NOT placed/);assert.equal(error.cause,undefined);return true
      })
    }
    globalThis.fetch=async()=>new Response(JSON.stringify({orderNumber:'SS-123',message:secret}))
    const success=await p.submitPurchaseOrder(po,SS)
    assert.equal(success.order_id,'SS-123');assert.equal(success.ok,true);assert.ok(!JSON.stringify(success).includes(secret))
  } finally {globalThis.fetch=original}
})

test.after(()=>db.close())
