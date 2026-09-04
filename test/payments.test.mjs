import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawn,spawnSync} from 'node:child_process'
import {createServer} from 'node:net'
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
  const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r))
  let server,d
  try {
    const r=spawnSync(process.execPath,['bin/demo.mjs',dest,String(port)],{cwd:root,encoding:'utf8',timeout:120000});assert.equal(r.status,0,r.error?.message || r.stderr)
    const env=JSON.parse(readFileSync(join(dest,'demo-env.json'),'utf8'));env.PSC_PAYMENT_FIXTURE=fixture
    writeFileSync(fixture,JSON.stringify({seq:0,sessions:{},transactions:{}}))
    let log=''
    server=spawn(process.execPath,['--no-warnings','--import','./bin/demo-network-guard.mjs','--import',new URL('./fixtures/payment-provider.mjs',import.meta.url).href,'server.mjs'],{cwd:dest,env,stdio:['ignore','pipe','pipe']})
    server.stdout.on('data',x=>log+=x);server.stderr.on('data',x=>log+=x)
    const base=`http://127.0.0.1:${port}`
    for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)break}catch{}await new Promise(r=>setTimeout(r,50))}
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
    const invoice=async()=>{
      const id=Number(d.prepare("INSERT INTO invoices(contact_id,invoice_number,amount_due,status) VALUES (1,?,100,'unpaid')").run('PAY-TEST-'+(++n)).lastInsertRowid)
      const inv=await json('/api/invoices/'+id,undefined,'GET')
      return {id,path:inv.pay_link.replace(/^https?:\/\/[^/]+/,'')}
    }
    const checkout=async inv=>{
      const u=new URL(inv.path,base);u.pathname+='/checkout'
      const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'kind=balance',redirect:'manual'})
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
    const bad=await invoice();await checkout(bad);cs=state().last.id
    const good={...state().sessions[cs]}
    for(const patch of [{currency:'usd'},{amount_total:1},{metadata:{...good.metadata,slug:'another-shop'}}]){
      mutate(s=>Object.assign(s.sessions[cs],good,patch));assert.equal((await stripeHook(cs)).status,503);assert.equal(paid(bad.id),0)
    }
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
    await config({payment_provider:'authorize_net',anet_environment:'live',anet_login_id:'fixture-login',anet_transaction_key:'fixture-key',anet_signature_key:anetKey,anet_currency:'CAD'})
    assert.equal((await json('/api/payments/test-authorize',{})).ok,true)
    const anetInv=await invoice(),hosted=await checkout(anetInv),ref=new URL(hosted).pathname.split('/').at(-1)
    const form=await fetch(hosted);assert.match(form.headers.get('content-security-policy'),/form-action 'self' https:\/\/accept.authorize.net/);assert.match(await form.text(),/name="token"/)
    assert.equal(state().hosted.transactionRequest.currencyCode,'CAD')
    let transaction=1000
    const trans=()=>String(++transaction)
    const anetHook=async(id,signature)=>{
      const body=JSON.stringify({eventType:'net.authorize.payment.authcapture.created',payload:{id}})
      return fetch(base+anetPath,{method:'POST',headers:{'Content-Type':'application/json','X-ANET-Signature':signature || 'sha512='+crypto.createHmac('sha512',Buffer.from(anetKey,'hex')).update(body).digest('hex')},body})
    }
    const id=trans();mutate(s=>s.transactions[id]={transId:id,transactionStatus:'capturedPendingSettlement',responseCode:1,settleAmount:'100.00',order:{invoiceNumber:ref}})
    assert.equal((await anetHook(id,'sha512=bad')).status,401);assert.equal(paid(anetInv.id),0)
    assert.equal((await anetHook(id)).status,200,log);assert.equal(paid(anetInv.id),100)
    assert.equal((await anetHook(id)).status,200);assert.equal(paid(anetInv.id),100)
    const double=trans();mutate(s=>s.transactions[double]={...s.transactions[id],transId:double})
    assert.equal((await anetHook(double)).status,503,'second transaction must require human review');assert.equal(paid(anetInv.id),100)
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
    d?.close();if(server){const end=new Promise(r=>server.once('exit',r));server.kill();await end}rmSync(tmp,{recursive:true,force:true,maxRetries:10,retryDelay:200})
  }
})
