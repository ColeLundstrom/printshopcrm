import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {createHttpTestServer} from './helpers/http-test-server.mjs'
import {DatabaseSync} from 'node:sqlite'
import {stripeUnits,stripeHundredths} from '../lib/payment-currency.mjs'
import {verifyAuthorizeWebhook,createAuthorizeCheckout,retrieveAuthorizeTransaction} from '../lib/authorizenet.mjs'

const root=new URL('..',import.meta.url)
test('currency conversion and Authorize.net reject ambiguous or mismatched payments',async()=>{
  for(const [currency,cents,units] of [['USD',1234,1234],['CAD',1234,1234],['JPY',1200,12],['ISK',1200,1200],['KWD',1234,12340]]) {
    assert.equal(stripeUnits(cents,currency),units);assert.equal(stripeHundredths(units,currency),cents)
  }
  assert.throws(()=>stripeUnits(1234,'JPY'));assert.throws(()=>stripeUnits(1234,'UGX'));assert.throws(()=>stripeHundredths(12345,'KWD'))
  const key='AF'.repeat(64),raw=Buffer.from('{"payload":{"id":"12"}}')
  const sig='sha512='+crypto.createHmac('sha512',Buffer.from(key,'hex')).update(raw).digest('hex')
  assert(verifyAuthorizeWebhook(raw,sig,key));assert(verifyAuthorizeWebhook(raw,'sha512='+crypto.createHmac('sha512',key).update(raw).digest('hex'),key));assert(!verifyAuthorizeWebhook(Buffer.from(raw+' '),sig,key));assert(!verifyAuthorizeWebhook(raw,sig,'BC'.repeat(64)))
  const settings={anet_login_id:'fixture',anet_transaction_key:'fixture',anet_currency:'USD'}
  await assert.rejects(createAuthorizeCheckout({settings,currency:'CAD',amountCents:100,reference:'A'.repeat(20)}),/currency/)
  let payload
  await createAuthorizeCheckout({settings,currency:'USD',amountCents:1234,reference:'A'.repeat(20),successUrl:'https://shop.test/return',cancelUrl:'https://shop.test/cancel',send:async(u,o)=>{payload=JSON.parse(o.body);assert.match(u,/apitest/);return new Response(JSON.stringify({token:'fixture',messages:{resultCode:'Ok'}}))}})
  assert.equal(payload.getHostedPaymentPageRequest.transactionRequest.amount,'12.34');assert.equal(payload.getHostedPaymentPageRequest.transactionRequest.currencyCode,'USD')
  for(const status of ['declined','authorizedPendingCapture','underReview','voided']) {
    const t=await retrieveAuthorizeTransaction({settings,transactionId:'123',send:async()=>new Response(JSON.stringify({messages:{resultCode:'Ok'},transaction:{transId:'123',transactionStatus:status,responseCode:1,authAmount:'12.34'}}))})
    assert.equal(t.paid,false)
  }
})

test('signed callbacks reconcile both gateways atomically without the customer returning', {timeout:180000},async()=>{
  const tmp=mkdtempSync(join(tmpdir(),'psc-payments-')),dest=join(tmp,'demo'),fixture=join(tmp,'fixture.json')
  const server=await createHttpTestServer(),{port,base}=server
  let d
  try {
    const r=spawnSync(process.execPath,['bin/demo.mjs',dest,String(port)],{cwd:root,encoding:'utf8',timeout:120000});assert.equal(r.status,0,r.error?.message || r.stderr)
    const env=JSON.parse(readFileSync(join(dest,'demo-env.json'),'utf8'));env.PSC_PAYMENT_FIXTURE=fixture
    writeFileSync(fixture,JSON.stringify({seq:0,sessions:{},transactions:{}}))
    let log=''
    await server.start({cwd:dest,env,args:['--no-warnings','--import','./bin/demo-network-guard.mjs','--import',new URL('./fixtures/payment-provider.mjs',import.meta.url).href,'server.mjs'],onOutput:text=>{log+=text}})
    const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'dylan@example.test',password:readFileSync(join(dest,'LOGIN.txt'),'utf8').match(/Password: (.+)/)[1]})});assert.equal(login.status,200,log)
    const cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')
    const req=(path,body,method='POST')=>fetch(base+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})})
    const json=async(path,body,method='POST')=>{const r=await req(path,body,method);assert.equal(r.status,200,await r.clone().text());return r.json()}
    const config=async s=>json('/api/settings',s,'PUT')
    const state=()=>JSON.parse(readFileSync(fixture,'utf8'))
    const mutate=fn=>{const s=state();fn(s);writeFileSync(fixture,JSON.stringify(s))}
    const slug=readdirSync(join(dest,'data','tenants'))[0]
    d=new DatabaseSync(join(dest,'data','tenants',slug,'printshop.db'))
    let n=0
    const invoice=async(contactId=1)=>{
      const id=Number(d.prepare("INSERT INTO invoices(contact_id,invoice_number,amount_due,status) VALUES (?,?,100,'unpaid')").run(contactId,'PAY-TEST-'+(++n)).lastInsertRowid)
      const inv=await json('/api/invoices/'+id,undefined,'GET')
      return {id,path:inv.pay_link.replace(/^https?:\/\/[^/]+/,'')}
    }
    const checkout=async inv=>{
      const page=await fetch(new URL(inv.path,base))
      assert.equal(page.status,200,await page.clone().text())
      const html=await page.text(),input=html.match(/<input\b[^>]*\bname=["']choice["'][^>]*>/)?.[0]
      const choice=input?.match(/\bvalue=["']([^"']+)["']/)?.[1]
      assert(choice,'the visible payment page supplies its signed amount choice')
      const u=new URL(inv.path,base);u.pathname+='/checkout'
      const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({kind:'balance',choice}),redirect:'manual'})
      assert.equal(r.status,303,await r.text());return r.headers.get('location')
    }
    const paid=id=>d.prepare('SELECT amount_paid FROM invoices WHERE id=?').get(id).amount_paid
    const hookSecret='whsec_fixture',anetKey='AF'.repeat(64)
    await config({payment_provider:'stripe',stripe_secret:'sk_live_fixture',currency:'CAD'})
    assert.equal((await json('/api/payments/setup',undefined,'GET')).ready,false)
    await config({stripe_webhook_secret:hookSecret})
    const setup=await json('/api/payments/setup',undefined,'GET'),stripePath=new URL(setup.stripe_webhook_url).pathname,anetPath=new URL(setup.authorize_webhook_url).pathname
    const stripeHook=async(id,signature)=>{
      const body=JSON.stringify({type:'checkout.session.completed',data:{object:{id}}}),t=Math.floor(Date.now()/1000)
      return fetch(base+stripePath,{method:'POST',headers:{'Content-Type':'application/json','Stripe-Signature':signature || `t=${t},v1=${crypto.createHmac('sha256',hookSecret).update(t+'.'+body).digest('hex')}`},body})
    }
    const first=await invoice();await checkout(first);let cs=state().last.id
    assert.equal(state().sessions[cs].currency,'cad');assert(state().last.idempotency)
    assert.equal((await stripeHook(cs,'t=1,v1=bad')).status,401);assert.equal(paid(first.id),0)
    assert.equal((await stripeHook(cs)).status,200,log);assert.equal(paid(first.id),100)
    assert.equal((await stripeHook(cs)).status,200);assert.equal(paid(first.id),100)
    const ret=state().last.success.replace('{CHECKOUT_SESSION_ID}',cs)
    assert.match(await (await fetch(ret)).text(),/Payment received/);assert.equal(paid(first.id),100)
    // A verified refund is appended to the ledger and pauses collections, never double-posts.
    const firstCs=cs
    const refundHook=async(id)=>{
      const body=JSON.stringify({type:'refund.updated',data:{object:{id}}}),t=Math.floor(Date.now()/1000)
      return fetch(base+stripePath,{method:'POST',headers:{'Content-Type':'application/json','Stripe-Signature':`t=${t},v1=${crypto.createHmac('sha256',hookSecret).update(t+'.'+body).digest('hex')}`},body})
    }
    const refund=(id,sessionId,amount=2500,status='succeeded')=>mutate(s=>{s.refunds ||= {};s.refunds[id]={id,object:'refund',payment_intent:s.sessions[sessionId].payment_intent,amount,currency:'cad',status}})
    await json('/api/invoices/'+first.id+'/send',{})
    const oldDraft=d.prepare('SELECT id FROM email_log WHERE invoice_id=? ORDER BY id DESC LIMIT 1').get(first.id).id
    refund('re_fixture_one',firstCs)
    let reversed=await refundHook('re_fixture_one');assert.equal(reversed.status,200,await reversed.text());assert.equal(paid(first.id),75)
    assert(d.prepare('SELECT payment_review FROM invoices WHERE id=?').get(first.id).payment_review)
    assert.equal((await req('/api/invoices/'+first.id+'/request-payment',{})).status,409)
    assert.equal((await fetch(base+first.path)).status,409)
    assert.match(await (await fetch(ret)).text(),/Payment updated/)
    assert.equal((await req('/api/outbox/'+oldDraft+'/send',{})).status,409)
    const entries=d.prepare('SELECT count(*) AS n FROM payments WHERE invoice_id=?').get(first.id).n
    assert.equal((await refundHook('re_fixture_one')).status,200);assert.equal(d.prepare('SELECT count(*) AS n FROM payments WHERE invoice_id=?').get(first.id).n,entries)
    await json('/api/invoices/'+first.id+'/payment-review',{note:'Verified: remaining balance will be collected by another method.'})
    assert.equal((await refundHook('re_fixture_one')).status,200);assert.equal(d.prepare('SELECT payment_review FROM invoices WHERE id=?').get(first.id).payment_review,'','an unchanged callback does not reopen a completed review')
    assert.equal((await req('/api/outbox/'+oldDraft+'/send',{})).status,409,'old drafts remain blocked after review')
    // Provider status changes append compensation; history remains intact.
    refund('re_fixture_one',firstCs,2500,'failed');assert.equal((await refundHook('re_fixture_one')).status,200);assert.equal(paid(first.id),100)
    refund('re_fixture_pending',firstCs,1000,'pending');assert.equal((await refundHook('re_fixture_pending')).status,200);assert.equal(paid(first.id),100)
    assert.equal((await req('/api/invoices/'+first.id+'/payment-review',{note:'Reviewed'})).status,409)
    refund('re_fixture_pending',firstCs,1000,'succeeded');assert.equal((await refundHook('re_fixture_pending')).status,200);assert.equal(paid(first.id),90)
    // A refund can arrive first: original payment and reversal commit together, with no receipt automation.
    const refundCustomer=Number(d.prepare("INSERT INTO contacts(name,email) VALUES('Refunded fixture','refund@example.test')").run().lastInsertRowid)
    const beforeRefund=await invoice(refundCustomer);await checkout(beforeRefund);const earlyCs=state().last.id
    refund('re_fixture_early',earlyCs,10000)
    const emails=d.prepare('SELECT count(*) AS n FROM email_log').get().n
    d.exec("CREATE TRIGGER fail_reversal_commit BEFORE INSERT ON payment_reversals BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END")
    assert.equal((await refundHook('re_fixture_early')).status,503);assert.equal(paid(beforeRefund.id),0)
    assert.equal(d.prepare('SELECT count(*) AS n FROM payments WHERE invoice_id=?').get(beforeRefund.id).n,0)
    d.exec('DROP TRIGGER fail_reversal_commit')
    assert.equal((await refundHook('re_fixture_early')).status,200);assert.equal(paid(beforeRefund.id),0)
    assert.equal(d.prepare('SELECT count(*) AS n FROM payments WHERE invoice_id=?').get(beforeRefund.id).n,2)
    assert.equal(d.prepare('SELECT count(*) AS n FROM email_log').get().n,emails)
    await json('/api/invoices/'+beforeRefund.id+'/void',{})
    assert.equal((await req('/api/contacts/'+refundCustomer,undefined,'DELETE')).status,409,'zero net receipts do not erase refund history')
    assert.equal(d.prepare('SELECT count(*) AS n FROM payments WHERE invoice_id=?').get(beforeRefund.id).n,2)
    const creditCustomer=Number(d.prepare("INSERT INTO contacts(name,email) VALUES('Credit fixture','credit@example.test')").run().lastInsertRowid),creditOnly=await invoice(creditCustomer)
    await json('/api/invoices/'+creditOnly.id+'/credits',{reference:crypto.randomUUID(),subtotal:20,reason:'Canceled work'})
    await json('/api/invoices/'+creditOnly.id+'/void',{})
    assert.equal((await req('/api/contacts/'+creditCustomer,undefined,'DELETE')).status,409,'voiding does not make credit history deletable')
    assert.equal(d.prepare('SELECT count(*) AS n FROM invoice_credits WHERE invoice_id=?').get(creditOnly.id).n,1)
    const verified=d.prepare('SELECT id FROM payments WHERE invoice_id=? LIMIT 1').get(first.id).id
    assert.equal((await req('/api/payments/'+verified,undefined,'DELETE')).status,409)
    // A credit adjusts the debt without inventing cash or replacing the original invoice.
    const creditRef=await json('/api/invoices/'+first.id+'/credit-reference',undefined,'GET');assert.match(creditRef.reference,/^[a-f0-9]{32}$/)
    const credit={reference:creditRef.reference,subtotal:'10.00',tax:'0',reason:'Canceled printing'}
    const credited=await json('/api/invoices/'+first.id+'/credits',credit)
    assert.equal(credited.invoice.amount_due,90);assert.equal(credited.invoice.amount_paid,90)
    assert.equal((await json('/api/invoices/'+first.id+'/credits',credit)).duplicate,true)
    assert.equal((await req('/api/invoices/'+first.id+'/credits',{...credit,subtotal:'11'})).status,400)
    assert.equal((await req('/api/invoices/'+first.id+'/credits',{...credit,reference:crypto.randomUUID(),subtotal:true})).status,400)
    assert.equal((await req('/api/invoices/'+first.id+'/credits',{...credit,reference:crypto.randomUUID(),subtotal:'1000'})).status,400)
    assert.equal((await req('/api/invoices/'+first.id+'/credits',{...credit,reference:crypto.randomUUID(),tax:'1'})).status,400,'unknown original tax is not guessed')
    assert.equal((await req('/api/invoices/'+first.id+'/payment-review',{})).status,400)
    await json('/api/invoices/'+first.id+'/payment-review',{note:'Credited canceled work; net received equals adjusted total.'})
    assert.match(await (await fetch(base+first.path)).text(),/settled, including credit adjustments/)
    const current=await json('/api/invoices/'+first.id,undefined,'GET');assert.equal(current.credit_base.amount_due,100);assert.equal(current.credits.length,1)
    assert.equal((await req('/api/invoices/'+first.id+'/pdf',undefined,'GET')).status,200)
    await json('/api/invoices/'+first.id+'/credits/'+credit.reference+'/cancel',{reason:'Customer restored this item'})
    assert.equal(d.prepare('SELECT amount_due FROM invoices WHERE id=?').get(first.id).amount_due,100)
    assert.equal((await json('/api/invoices/'+first.id+'/credits/'+credit.reference+'/cancel',{reason:'Retry'})).duplicate,true)
    // Too many refunds and remapped refund identities never mutate the ledger.
    refund('re_fixture_over',firstCs,10000);assert.equal((await refundHook('re_fixture_over')).status,503);assert.equal(paid(first.id),90)
    refund('re_fixture_pending',earlyCs,1000);assert.equal((await refundHook('re_fixture_pending')).status,503);assert.equal(paid(first.id),90)
    // Each conflicting provider transaction has its own identity. A verified transaction's
    // captured amount/currency cannot later be rewritten to make the same receipt look valid.
    for(const patch of [()=>({currency:'usd'}),()=>({amount_total:1}),s=>({metadata:{...s.metadata,slug:'another-shop'}})]){
      const invalid=await invoice();await checkout(invalid);const invalidCs=state().last.id
      mutate(s=>Object.assign(s.sessions[invalidCs],patch(s.sessions[invalidCs])))
      assert.equal((await stripeHook(invalidCs)).status,503);assert.equal(paid(invalid.id),0)
    }
    const bad=await invoice();await checkout(bad);cs=state().last.id
    const good={...state().sessions[cs]}
    mutate(s=>Object.assign(s.sessions[cs],good,{payment_status:'unpaid'}));assert.equal((await stripeHook(cs)).status,200);assert.equal(paid(bad.id),0)
    mutate(s=>Object.assign(s.sessions[cs],good))
    // A failure between payment insertion and attempt completion rolls back every financial write.
    d.exec("CREATE TRIGGER fail_payment_commit BEFORE UPDATE ON payment_attempts WHEN NEW.status='paid' BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END")
    assert.equal((await stripeHook(cs)).status,503);assert.equal(paid(bad.id),0);assert.equal(d.prepare('SELECT count(*) AS n FROM payments WHERE invoice_id=?').get(bad.id).n,0)
    d.exec('DROP TRIGGER fail_payment_commit');assert.equal((await stripeHook(cs)).status,200);assert.equal(paid(bad.id),100)
    await config({stripe_secret:'sk_test_fixture'})
    const sandbox=await invoice();await checkout(sandbox);cs=state().last.id
    assert.equal((await stripeHook(cs)).status,200);assert.equal(paid(sandbox.id),0)
    assert.match(await (await fetch(state().last.success.replace('{CHECKOUT_SESSION_ID}',cs))).text(),/Test payment complete/)
    refund('re_fixture_sandbox',cs,10000);assert.equal((await refundHook('re_fixture_sandbox')).status,200);assert.equal(paid(sandbox.id),0);assert.equal(d.prepare('SELECT payment_review FROM invoices WHERE id=?').get(sandbox.id).payment_review,'')
    await config({payment_provider:'authorize_net',anet_environment:'live',anet_login_id:'fixture-login',anet_transaction_key:'fixture-key',anet_signature_key:anetKey,anet_currency:'CAD'})
    assert.equal((await json('/api/payments/test-authorize',{})).ok,true)
    const anetInv=await invoice(),hosted=await checkout(anetInv),ref=new URL(hosted).pathname.split('/').at(-1)
    const form=await fetch(hosted);assert.match(form.headers.get('content-security-policy'),/form-action 'self' https:\/\/accept.authorize.net/);assert.match(await form.text(),/name="token"/)
    assert.equal(state().hosted.transactionRequest.currencyCode,'CAD')
    let transaction=1000
    const trans=()=>String(++transaction)
    const anetHook=async(id,signature,eventType='net.authorize.payment.authcapture.created')=>{
      const body=JSON.stringify({eventType,payload:{id}})
      return fetch(base+anetPath,{method:'POST',headers:{'Content-Type':'application/json','X-ANET-Signature':signature || 'sha512='+crypto.createHmac('sha512',Buffer.from(anetKey,'hex')).update(body).digest('hex')},body})
    }
    const id=trans();mutate(s=>s.transactions[id]={transId:id,transactionType:'authCaptureTransaction',authAmount:'100.00',transactionStatus:'capturedPendingSettlement',responseCode:1,settleAmount:'100.00',order:{invoiceNumber:ref}})
    assert.equal((await anetHook(id,'sha512=bad')).status,401);assert.equal(paid(anetInv.id),0)
    assert.equal((await anetHook(id)).status,200,log);assert.equal(paid(anetInv.id),100)
    assert.equal((await anetHook(id)).status,200);assert.equal(paid(anetInv.id),100)
    const double=trans();mutate(s=>s.transactions[double]={...s.transactions[id],transId:double})
    assert.equal((await anetHook(double)).status,200,'retain and acknowledge the second verified capture');assert.equal(paid(anetInv.id),200)
    assert(d.prepare('SELECT payment_review FROM invoices WHERE id=?').get(anetInv.id).payment_review)
    assert.equal(d.prepare('SELECT count(*) AS n FROM payments WHERE invoice_id=?').get(anetInv.id).n,2)
    assert.equal((await anetHook(double)).status,200);assert.equal(paid(anetInv.id),200,'the same transaction is still idempotent')
    // Authorize.net refunds are matched through the original transaction, not refund invoice text.
    const refundId=trans(),refundEvent='net.authorize.payment.refund.created',voidEvent='net.authorize.payment.void.created'
    mutate(s=>s.transactions[refundId]={transId:refundId,transactionType:'refundTransaction',transactionStatus:'refundPendingSettlement',responseCode:1,authAmount:'25.00',settleAmount:'25.00',refTransId:id,order:{invoiceNumber:'untrusted-refund-reference'}})
    assert.equal((await anetHook(refundId,undefined,refundEvent)).status,200);assert.equal(paid(anetInv.id),175)
    assert.equal((await anetHook(refundId,undefined,refundEvent)).status,200);assert.equal(paid(anetInv.id),175)
    assert.equal((await req('/api/invoices/'+anetInv.id+'/payment-review',{note:'Pending'})).status,409)
    mutate(s=>s.transactions[refundId].transactionStatus='refundSettledSuccessfully')
    assert.equal((await json('/api/payments/reversals/authorize_net/'+refundId+'/recheck',{})).ok,true);assert.equal(paid(anetInv.id),175)
    // Voiding a refund restores the returned amount; it does not void the original charge.
    mutate(s=>{s.transactions[refundId].transactionStatus='voided';s.transactions[refundId].settleAmount='0.00'})
    assert.equal((await anetHook(refundId,undefined,voidEvent)).status,200);assert.equal(paid(anetInv.id),200)
    // Original capture void before its payment callback: one atomic pair, zero net money.
    const preVoid=await invoice(),preVoidRef=new URL(await checkout(preVoid)).pathname.split('/').at(-1),preVoidId=trans()
    mutate(s=>s.transactions[preVoidId]={...s.transactions[id],transId:preVoidId,transactionStatus:'voided',settleAmount:'0.00',authAmount:'100.00',order:{invoiceNumber:preVoidRef}})
    assert.equal((await anetHook(preVoidId,undefined,voidEvent)).status,200);assert.equal(paid(preVoid.id),0)
    assert.equal(d.prepare('SELECT count(*) AS n FROM payments WHERE invoice_id=?').get(preVoid.id).n,2)
    assert.equal((await anetHook(preVoidId,undefined,voidEvent)).status,200);assert.equal(paid(preVoid.id),0)
    // A delayed payment on a voided invoice remains visible without reviving the invoice.
    const voidInv=await invoice(),voidRef=new URL(await checkout(voidInv)).pathname.split('/').at(-1),voidId=trans()
    await json('/api/invoices/'+voidInv.id+'/void',{})
    mutate(s=>s.transactions[voidId]={...s.transactions[id],transId:voidId,order:{invoiceNumber:voidRef}})
    assert.equal((await anetHook(voidId)).status,200);assert.equal(paid(voidInv.id),100)
    assert.equal(d.prepare('SELECT status FROM invoices WHERE id=?').get(voidInv.id).status,'void')
    await config({anet_environment:'sandbox'})
    const testInv=await invoice(),testRef=new URL(await checkout(testInv)).pathname.split('/').at(-1),testId=trans()
    mutate(s=>s.transactions[testId]={...s.transactions[id],transId:testId,order:{invoiceNumber:testRef}})
    assert.equal((await anetHook(testId)).status,200);assert.equal(paid(testInv.id),0)
    await config({payment_provider:'off'})
    const offline=await invoice();assert.match(await (await fetch(base+offline.path)).text(),/How to pay/)
    const publicS=(await json('/api/settings',undefined,'GET')).settings
    for(const key of ['stripe_secret','stripe_webhook_secret','anet_transaction_key','anet_signature_key']) assert.equal(publicS[key],'')
    assert.equal((await req('/api/settings',{payment_provider:'unknown'},'PUT')).status,400)
  } finally {
    d?.close();await server.close();rmSync(tmp,{recursive:true,force:true,maxRetries:10,retryDelay:200})
  }
})
