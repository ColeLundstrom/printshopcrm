import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { writeFixtureJson } from './helpers/json-fixture.mjs'
import { createHttpTestServer } from './helpers/http-test-server.mjs'

// Full local provider objects and durable idempotency, not application-method stubs.
// The fixture never falls back to the real network, including on an unexpected URL.
const providerSource = String.raw`
import { readFileSync } from 'node:fs'
import { writeFixtureJson } from '${new URL('./helpers/json-fixture.mjs',import.meta.url).href}'
const file=process.env.PSC_COLLECTION_FIXTURE
if(!file || process.env.PSC_DEMO!=='1')throw Error('Isolated collection fixture required')
const read=()=>JSON.parse(readFileSync(file,'utf8')),write=s=>writeFixtureJson(file,s)
const reply=(d,status=200)=>new Response(JSON.stringify(d),{status,headers:{'content-type':'application/json'}})
const visible=s=>{const {_account,_destination,_fee,...out}=s;return {...out,payment_intent:{object:'payment_intent',id:s.payment_intent,transfer_data:_destination?{destination:_destination}:null,on_behalf_of:_destination||null,application_fee_amount:_fee??null}}}
globalThis.fetch=async(url,options={})=>{
 const u=new URL(url),s=read()
 if(u.origin==='https://api.stripe.com'){
  const secret=String(options.headers?.Authorization||'').replace(/^Bearer /,''),account=s.accounts[secret]
  if(!account)return reply({error:{message:'Fixture unrecognized credential'}},401)
  s.reads.push({path:u.pathname,method:options.method||'GET',account});write(s)
  if(u.pathname==='/v1/account')return reply({object:'account',id:account})
  if(options.method==='POST' && u.pathname==='/v1/checkout/sessions'){
   const body=String(options.body),p=new URLSearchParams(body),key=options.headers['Idempotency-Key'],identity=account+':'+key
   s.posts.push({account,key,body})
   if(key && s.idempotency[identity]){
    const prior=s.idempotency[identity];write(s)
    if(prior.body!==body)return reply({error:{message:'Fixture key reused with different body'}},400)
    return reply(visible(s.sessions[prior.id]))
   }
   const id='cs_fixture_'+(++s.seq),metadata={}
   for(const [k,v]of p)if(k.startsWith('metadata['))metadata[k.slice(9,-1)]=v
   const row={object:'checkout.session',id,url:'https://checkout.stripe.com/c/pay/'+id,mode:'payment',status:'open',payment_status:'unpaid',livemode:secret.startsWith('sk_live_'),amount_total:Number(p.get('line_items[0][price_data][unit_amount]')),currency:p.get('line_items[0][price_data][currency]'),metadata,payment_intent:'pi_fixture_'+s.seq,customer_email:p.get('customer_email'),expires_at:Math.floor(Date.now()/1000)+86400,_account:account,_destination:p.get('payment_intent_data[transfer_data][destination]'),_fee:p.has('payment_intent_data[application_fee_amount]')?Number(p.get('payment_intent_data[application_fee_amount]')):null}
   s.sessions[id]=row;if(key)s.idempotency[identity]={id,body};s.last={id,success:p.get('success_url')}
   const lose=s.lose_next,hold=s.hold_next;s.lose_next=false;s.hold_next=false;write(s)
   if(hold)for(let n=0;read().hold && n<500;n++){if(options.signal?.aborted)throw Error('Fixture interrupted');await new Promise(r=>setTimeout(r,10))}
   if(lose)throw Error('Fixture response lost after provider persisted checkout')
   return reply(visible(row))
  }
  const parts=u.pathname.split('/'),id=parts.at(-1)==='expire'?parts.at(-2):parts.at(-1),row=s.sessions[id]
  if(row && row._account===account){
   if(options.method==='POST' && parts.at(-1)==='expire'){
    s.expirations.push(id);if(row.status!=='open'){write(s);return reply({error:{message:'Fixture session is not open'}},400)}
    row.status='expired';write(s)
   }
   return reply(visible(row))
  }
  return reply({error:{message:'Fixture session not found for this account'}},404)
 }
 if(['https://api.authorize.net','https://apitest.authorize.net'].includes(u.origin)){
  const input=JSON.parse(options.body),method=Object.keys(input)[0],body=input[method],login=body.merchantAuthentication?.name
  s.anet_calls.push({method,login,environment:u.origin});write(s)
  const ok={messages:{resultCode:'Ok',message:[{code:'I00001',text:'Successful.'}]}}
  if(method==='authenticateTestRequest')return reply(ok)
  if(method==='getHostedPaymentPageRequest'){
   const token='fixture-token-'+(++s.anet_seq),reference=body.transactionRequest.order.invoiceNumber
   s.hosted.push({token,reference,request:body,_login:login,_environment:u.origin});s.last={token,reference};write(s)
   return reply({...ok,token})
  }
  if(method==='getTransactionDetailsRequest'){
   const row=s.transactions[body.transId]
   if(row && (!row._login || row._login===login)) {const {_login,...transaction}=row;return reply({...ok,transaction})}
  }
  return reply({messages:{resultCode:'Error',message:[{code:'E00040',text:'Fixture transaction not found'}]}})
 }
 throw Error('External request blocked by collection fixture: '+u.origin)
}
`

async function fixture(t, { lite = false } = {}) {
  const temp=mkdtempSync(join(tmpdir(),'psc-collection-http-')),dest=join(temp,'demo'),stateFile=join(temp,'provider.json'),preload=join(temp,'provider.mjs')
  const server=await createHttpTestServer();let db,logs=''
  t.after(async()=>{await server.close();db?.close();rmSync(temp,{recursive:true,force:true})})
  const built=spawnSync(process.execPath,['bin/demo.mjs',dest,String(server.port)],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:120000})
  assert.equal(built.status,0,built.stderr)
  const env=JSON.parse(readFileSync(join(dest,'demo-env.json'),'utf8'));env.PSC_COLLECTION_FIXTURE=stateFile;env.PSC_TICK_MS='3600000'
  if(lite){env.PSC_EDITION='lite';env.PSC_PLATFORM_STRIPE_SECRET='sk_live_platform_fixture'}
  writeFileSync(preload,providerSource,{mode:0o600})
  writeFileSync(stateFile,JSON.stringify({seq:0,anet_seq:0,sessions:{},transactions:{},idempotency:{},posts:[],reads:[],expirations:[],hosted:[],anet_calls:[],accounts:{sk_live_collect_fixture:'acct_fixture_primary',sk_live_rotated_fixture:'acct_fixture_other',sk_test_collect_fixture:'acct_fixture_primary',sk_live_platform_fixture:'acct_fixture_platform'}}),{mode:0o600})
  const start=()=>server.start({cwd:dest,env,args:['--no-warnings','--import','./bin/demo-network-guard.mjs','--import',preload,'server.mjs'],onOutput:s=>{logs+=s}})
  await start()
  const login=await fetch(server.base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'dylan@example.test',password:readFileSync(join(dest,'LOGIN.txt'),'utf8').match(/Password: (.+)/)[1]})})
  assert.equal(login.status,200)
  const cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')
  db=new DatabaseSync(join(dest,'data/tenants',readdirSync(join(dest,'data/tenants'))[0],'printshop.db'));db.exec('PRAGMA busy_timeout=5000;PRAGMA foreign_keys=ON')
  const f={server,db,start,env,controlPath:join(dest,'data/control.db'),state:()=>JSON.parse(readFileSync(stateFile,'utf8')),log:()=>logs}
  f.mutate=fn=>{const s=f.state();fn(s);writeFixtureJson(stateFile,s)}
  f.request=async(path,{body,method='GET',auth=true}={})=>{
    const r=await fetch(new URL(path,server.base),{method,headers:{'Content-Type':'application/json',...(auth?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'manual',signal:AbortSignal.timeout(15000)})
    const text=await r.text();let data;try{data=JSON.parse(text)}catch{}
    return {status:r.status,text,data,location:r.headers.get('location')}
  }
  f.ok=async(path,body,method='POST')=>{const r=await f.request(path,{body,method});assert([200,201].includes(r.status),r.text);return r.data}
  f.config=s=>f.ok('/api/settings',s,'PUT')
  f.collections=()=>f.ok('/api/payments/collections',undefined,'GET')
  f.collection=async inv=>{const data=await f.collections();return data.collections.find(c=>c.invoice_id===inv.id)}
  // The operator DTO intentionally lists receipts needing review. Inspect all durable
  // receipt rows independently as well, including successful first captures.
  f.receipts=async inv=>db.prepare('SELECT * FROM payment_collection_receipts WHERE invoice_id=? ORDER BY created_at,id').all(inv.id)
  let serial=0
  f.invoice=async()=>{const id=Number(db.prepare("INSERT INTO invoices(contact_id,invoice_number,amount_due,status) VALUES(1,?,100,'unpaid')").run('COLLECTION-'+(++serial)).lastInsertRowid),document=await f.ok('/api/invoices/'+id,undefined,'GET');return{id,path:document.pay_link.replace(/^https?:\/\/[^/]+/,'')}}
  f.choice=async inv=>{const r=await f.request(inv.path,{auth:false});assert.equal(r.status,200,r.text);const token=r.text.match(/<input\b(?=[^>]*name=["']choice["'])[^>]*value=["']([^"']+)["']/)?.[1];assert(token,'Actual invoice page must issue its displayed payment choice token');return token.replaceAll('&amp;','&').replaceAll('&quot;','"')}
  f.checkout=async(inv,kind='balance',choice)=>{
    const u=new URL(inv.path,server.base);u.pathname+='/checkout'
    const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({kind,choice:choice??await f.choice(inv)}),redirect:'manual',signal:AbortSignal.timeout(15000)})
    return {status:r.status,text:await r.text(),location:r.headers.get('location')}
  }
  f.paid=inv=>db.prepare('SELECT amount_paid,payment_review,status FROM invoices WHERE id=?').get(inv.id)
  f.paymentRows=inv=>db.prepare('SELECT * FROM payments WHERE invoice_id=? ORDER BY id').all(inv.id)
  f.wait=async predicate=>{for(let n=0;n<500;n++){if(predicate())return;await new Promise(r=>setTimeout(r,10))}assert.fail('Fixture operation did not reach expected boundary')}
  f.restart=async()=>{await server.stop();await start()}
  f.stripeKey='whsec_collection_fixture';f.anetKey='AF'.repeat(64)
  await f.config({payment_provider:'stripe',stripe_secret:'sk_live_collect_fixture',stripe_webhook_secret:f.stripeKey,currency:'USD'})
  // These fields are deliberately not writable through generic Settings; seed only
  // the isolated fixture's already-completed Connect onboarding state.
  if(lite)for(const [key,value]of Object.entries({stripe_account_id:'acct_fixture_destination',stripe_charges_enabled:'1'}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,value)
  const setup=await f.ok('/api/payments/setup',undefined,'GET');f.stripePath=new URL(setup.stripe_webhook_url).pathname;f.anetPath=new URL(setup.authorize_webhook_url).pathname
  f.stripeHook=async(id,extra={})=>{
    const body=JSON.stringify({type:'checkout.session.completed',data:{object:{id,...extra}}}),time=Math.floor(Date.now()/1000)
    const r=await fetch(server.base+f.stripePath,{method:'POST',headers:{'Content-Type':'application/json','Stripe-Signature':`t=${time},v1=${createHmac('sha256',f.stripeKey).update(time+'.'+body).digest('hex')}`},body,signal:AbortSignal.timeout(15000)})
    return {status:r.status,text:await r.text()}
  }
  f.authorize=()=>f.config({payment_provider:'authorize_net',anet_environment:'live',anet_login_id:'fixture-login',anet_transaction_key:'fixture-key',anet_signature_key:f.anetKey,anet_currency:'USD'})
  f.anetHook=async(id,extra={})=>{
    const body=JSON.stringify({eventType:'net.authorize.payment.authcapture.created',payload:{id,...extra}})
    const r=await fetch(server.base+f.anetPath,{method:'POST',headers:{'Content-Type':'application/json','X-ANET-Signature':'sha512='+createHmac('sha512',Buffer.from(f.anetKey,'hex')).update(body).digest('hex')},body,signal:AbortSignal.timeout(15000)})
    return {status:r.status,text:await r.text()}
  }
  return f
}

test('actual public collection serializes payment choices and recovers a lost provider response after restart', {timeout:180000}, async t=>{
  const f=await fixture(t)
  await t.test('one unresolved collection fences concurrent same and different choices',async()=>{
    const inv=await f.invoice(),choice=await f.choice(inv),before=f.state().seq
    f.mutate(s=>{s.hold=true;s.hold_next=true})
    const first=f.checkout(inv,'deposit',choice)
    await f.wait(()=>f.state().seq===before+1)
    const overlap=await f.checkout(inv,'balance',choice)
    assert.equal(overlap.status,409);assert.equal(f.state().seq,before+1)
    f.mutate(s=>s.hold=false)
    const created=await first;assert.equal(created.status,303,created.text)
    const repeated=await f.checkout(inv,'deposit',choice)
    assert.equal(repeated.status,303,repeated.text);assert.equal(repeated.location,created.location);assert.equal(f.state().seq,before+1)
    assert.equal((await f.collections()).collections.filter(c=>c.invoice_id===inv.id).length,1)
    assert.equal(f.paid(inv).amount_paid,0);assert.equal(f.paymentRows(inv).length,0)
  })
  await t.test('lost response then process restart reuses the exact provider body and key',async()=>{
    const inv=await f.invoice(),choice=await f.choice(inv),before=f.state().seq
    f.mutate(s=>s.lose_next=true)
    const lost=await f.checkout(inv,'balance',choice);assert([502,503,504].includes(lost.status),lost.text)
    assert.equal(f.state().seq,before+1)
    const original=f.state().posts.at(-1),createdId=f.state().last.id
    assert(original.key)
    await f.restart()
    f.db.prepare('UPDATE payment_collections SET next_retry_at=0 WHERE reference=?').run((await f.collection(inv)).reference)
    const retry=await f.checkout(inv,'balance',choice);assert.equal(retry.status,303,retry.text)
    assert.equal(retry.location,'https://checkout.stripe.com/c/pay/'+createdId)
    assert.equal(f.state().seq,before+1)
    const retried=f.state().posts.at(-1);assert.equal(retried.key,original.key);assert.equal(retried.body,original.body)
    assert.equal((await f.collections()).collections.filter(c=>c.invoice_id===inv.id).length,1)
    assert.equal(f.paymentRows(inv).length,0)
  })
  await t.test('a stale displayed amount is refused before any provider create',async()=>{
    const inv=await f.invoice(),choice=await f.choice(inv),before=f.state().seq
    await f.ok('/api/invoices/'+inv.id+'/payments',{amount:25,method:'cash',note:'Fixture real cash already received'})
    const result=await f.checkout(inv,'balance',choice);assert.equal(result.status,409)
    assert.equal(f.state().seq,before);assert.equal(f.paid(inv).amount_paid,25)
    const job=await f.ok('/api/jobs/1',undefined,'GET'),ticket=await f.request(job.ticket_url,{auth:false})
    assert.equal(ticket.status,200,'The payment-choice guard must not run on signed production work tickets')
  })
  await t.test('money recorded while creation is in flight holds the returned checkout until verified expiration',async()=>{
    const inv=await f.invoice(),choice=await f.choice(inv),before=f.state().seq
    f.mutate(s=>{s.hold=true;s.hold_next=true})
    const pending=f.checkout(inv,'balance',choice);await f.wait(()=>f.state().seq===before+1)
    const id=f.state().last.id
    await f.ok('/api/invoices/'+inv.id+'/payments',{amount:25,method:'cash',note:'Fixture payment arrived during card setup'})
    assert(f.paid(inv).payment_review)
    f.mutate(s=>s.hold=false)
    const result=await pending;assert.equal(result.status,409,result.text)
    assert.equal(f.paid(inv).amount_paid,25);assert.equal(f.state().seq,before+1)
    let c=await f.collection(inv)
    f.db.prepare('UPDATE payment_collections SET next_retry_at=0 WHERE reference=?').run(c.reference)
    c=await f.collection(inv)
    await f.ok('/api/payments/collections/'+c.reference+'/expire',{revision:c.revision})
    assert.equal(f.state().sessions[id].status,'expired')
    assert.equal((await f.collection(inv)).state,'expired')
    await f.ok('/api/invoices/'+inv.id+'/payment-review',{note:'Verified original card session expired; cash payment remains recorded.'})
    const replacement=await f.checkout(inv);assert.equal(replacement.status,303,replacement.text)
    assert.equal(f.state().sessions[f.state().last.id].amount_total,7500)
    assert.equal(f.paid(inv).amount_paid,25)
  })
  await t.test('unknown Stripe creation after its retry window requires verified session recovery, then explicit closure',async()=>{
    const inv=await f.invoice(),choice=await f.choice(inv),before=f.state().seq
    f.mutate(s=>s.lose_next=true)
    assert([502,503,504].includes((await f.checkout(inv,'balance',choice)).status))
    const id=f.state().last.id,ref=(await f.collection(inv)).reference
    f.db.prepare('UPDATE payment_collections SET submitted_at=?,next_retry_at=0 WHERE reference=?').run(Date.now()-24*3600000,ref)
    const retry=await f.checkout(inv,'balance',choice);assert.equal(retry.status,409);assert.equal(f.state().seq,before+1)
    f.db.prepare('UPDATE payment_collections SET next_retry_at=0 WHERE reference=?').run(ref)
    let c=await f.collection(inv);assert.equal(c.requires_session_id,true);assert.equal(c.actions.recheck,true)
    f.mutate(s=>s.sessions[id].amount_total=20000)
    const wrong=await f.request('/api/payments/reconcile/'+ref,{method:'POST',body:{revision:c.revision,session_id:id}})
    assert.equal(wrong.status,409,wrong.text)
    assert.equal(f.db.prepare('SELECT session_id FROM payment_attempts WHERE reference=?').get(ref).session_id,null,'Wrong-amount open checkout must not become the canonical session')
    assert.equal(f.paymentRows(inv).length,0)
    f.mutate(s=>s.sessions[id].amount_total=10000)
    f.db.prepare('UPDATE payment_collections SET next_retry_at=0 WHERE reference=?').run(ref)
    c=await f.collection(inv)
    await f.ok('/api/payments/reconcile/'+ref,{revision:c.revision,session_id:id})
    assert.equal(f.db.prepare('SELECT session_id FROM payment_attempts WHERE reference=?').get(ref).session_id,id)
    c=await f.collection(inv);await f.ok('/api/payments/collections/'+ref+'/expire',{revision:c.revision})
    assert.equal(f.state().sessions[id].status,'expired');assert.equal(f.state().seq,before+1)
    assert.equal((await f.checkout(inv)).status,303);assert.equal(f.state().seq,before+2)
    assert.equal(f.paymentRows(inv).length,0)
  })
  await t.test('process death after provider persistence retains its lease and recovers one session after expiry',async()=>{
    const inv=await f.invoice(),choice=await f.choice(inv),before=f.state().seq
    f.mutate(s=>{s.hold=true;s.hold_next=true})
    const pending=f.checkout(inv,'balance',choice).then(value=>({value}),error=>({error}))
    await f.wait(()=>f.state().seq===before+1)
    const id=f.state().last.id,original=f.state().posts.at(-1),c=await f.collection(inv)
    f.server.child.kill('SIGKILL');await f.server.stop();assert((await pending).error,'HTTP outcome must be unknown when the app dies before responding')
    await f.start()
    const locked=await f.checkout(inv,'balance',choice);assert.equal(locked.status,409);assert.equal(f.state().seq,before+1)
    // Advance only the private fixture's durable lease deadline, not the runtime clock.
    f.db.prepare('UPDATE payment_collections SET claim_until=0,next_retry_at=0 WHERE reference=?').run(c.reference)
    const resumed=await f.checkout(inv,'balance',choice);assert.equal(resumed.status,303,resumed.text)
    assert.equal(resumed.location,'https://checkout.stripe.com/c/pay/'+id);assert.equal(f.state().seq,before+1)
    const retried=f.state().posts.at(-1);assert.equal(retried.key,original.key);assert.equal(retried.body,original.body)
    assert.equal(f.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(f.paymentRows(inv).length,0)
  })
})

test('verified additional Authorize.net captures retain their actual money and durable review across restart', {timeout:180000},async t=>{
  const f=await fixture(t);await f.authorize()
  const inv=await f.invoice(),checkout=await f.checkout(inv);assert.equal(checkout.status,303,checkout.text)
  const reference=(await f.collection(inv)).reference
  for(const id of ['91001','91002'])f.mutate(s=>s.transactions[id]={transId:id,transactionType:'authCaptureTransaction',authAmount:'100.00',transactionStatus:'capturedPendingSettlement',responseCode:1,settleAmount:'100.00',order:{invoiceNumber:reference},_login:'fixture-login'})
  assert.equal((await f.anetHook('91001',{authAmount:999999})).status,200)
  assert.equal(f.paid(inv).amount_paid,100,'Only the retrieved provider amount may become money')
  const second=await f.anetHook('91002');assert.equal(second.status,200,second.text)
  assert.equal(f.paid(inv).amount_paid,200);assert.equal(f.paymentRows(inv).length,2)
  assert(f.paid(inv).payment_review,'Second captured transaction must hold further collections for review')
  const receipts=await f.receipts(inv)
  assert.equal(receipts.filter(r=>['91001','91002'].includes(r.transaction_id)).length,2)
  assert.equal(receipts.find(r=>r.transaction_id==='91002').amount_cents,10000)
  assert(receipts.find(r=>r.transaction_id==='91002').reason)
  assert((await f.collections()).receipts.some(r=>r.transaction_id==='91002' && r.invoice_id===inv.id),'Operator can see the additional capture requiring review')
  const before=JSON.stringify(f.paymentRows(inv));await f.restart()
  assert.equal((await f.anetHook('91002')).status,200)
  assert.equal(JSON.stringify(f.paymentRows(inv)),before);assert.equal((await f.receipts(inv)).length,receipts.length)
  assert(f.paid(inv).payment_review)
  assert.equal((await f.request(inv.path,{auth:false})).status,409)
  assert.equal(f.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[])
})

test('Stripe collection never attributes another account or mode and ignores callback-supplied money', {timeout:180000},async t=>{
  const f=await fixture(t),inv=await f.invoice(),checkout=await f.checkout(inv)
  assert.equal(checkout.status,303,checkout.text)
  const id=f.state().last.id
  f.mutate(s=>{s.sessions[id].payment_status='paid';s.sessions[id].status='complete'})
  await f.config({stripe_secret:'sk_live_rotated_fixture'})
  await f.stripeHook(id)
  assert.equal(f.paid(inv).amount_paid,0);assert.equal(f.paymentRows(inv).length,0)
  assert.equal((await f.receipts(inv)).length,0,'Another account must not create a receipt attributed to this invoice')
  await f.config({stripe_secret:'sk_live_collect_fixture'})
  f.mutate(s=>s.sessions[id].livemode=false)
  await f.stripeHook(id)
  assert.equal(f.paid(inv).amount_paid,0);assert.equal(f.paymentRows(inv).length,0)
  assert.equal((await f.receipts(inv)).length,0)
  f.mutate(s=>{s.sessions[id].livemode=true;s.sessions[id].metadata.slug='not-this-shop'})
  await f.stripeHook(id)
  assert.equal(f.paid(inv).amount_paid,0);assert.equal(f.paymentRows(inv).length,0)
  assert.equal((await f.receipts(inv)).length,0)
  f.mutate(s=>s.sessions[id].metadata.slug='dylan-demo-shop')
  const actual=await f.stripeHook(id,{amount_total:999999,currency:'eur',payment_status:'paid'})
  assert.equal(actual.status,200,actual.text);assert.equal(f.paid(inv).amount_paid,100)
  assert.equal(f.paymentRows(inv).length,1)
  const receipt=(await f.receipts(inv)).find(r=>r.transaction_id===id || r.amount_cents===10000)
  assert(receipt);assert.equal(receipt.amount_cents,10000);assert.equal(receipt.currency,'USD')
  const before=JSON.stringify(f.paymentRows(inv));await f.restart();assert.equal((await f.stripeHook(id)).status,200)
  assert.equal(JSON.stringify(f.paymentRows(inv)),before)
})

test('Connect uses the same durable collection and verifies the paid destination before posting money', {timeout:180000},async t=>{
  const f=await fixture(t,{lite:true}),inv=await f.invoice(),choice=await f.choice(inv)
  const first=await f.checkout(inv,'balance',choice);assert.equal(first.status,303,first.text)
  const id=f.state().last.id,post=f.state().posts.at(-1),body=new URLSearchParams(post.body)
  assert.equal(post.account,'acct_fixture_platform');assert(post.key)
  assert.equal(body.get('payment_intent_data[transfer_data][destination]'),'acct_fixture_destination')
  assert.equal(body.get('payment_intent_data[on_behalf_of]'),'acct_fixture_destination')
  assert.equal((await f.collection(inv)).provider,'stripe_connect')
  await f.restart()
  const retry=await f.checkout(inv,'balance',choice);assert.equal(retry.status,303,retry.text);assert.equal(retry.location,first.location)
  assert.equal(f.state().seq,1)
  f.mutate(s=>{s.sessions[id].status='complete';s.sessions[id].payment_status='paid';s.sessions[id]._destination='acct_fixture_someone_else'})
  await f.stripeHook(id)
  assert.equal(f.paid(inv).amount_paid,0);assert.equal(f.paymentRows(inv).length,0,'A transfer to another merchant must not settle this invoice')
  f.mutate(s=>s.sessions[id]._destination='acct_fixture_destination')
  const paid=await f.stripeHook(id);assert.equal(paid.status,200,paid.text)
  assert.equal(f.paid(inv).amount_paid,100);assert.equal(f.paymentRows(inv).length,1)
  assert.equal((await f.receipts(inv)).length,1)
  assert.equal((await f.receipts(inv))[0].provider,'stripe_connect')
})

test('verified capture evidence survives a failed financial commit and later reconciles once after restart', {timeout:180000},async t=>{
  const f=await fixture(t),inv=await f.invoice(),checkout=await f.checkout(inv)
  assert.equal(checkout.status,303,checkout.text)
  const id=f.state().last.id
  f.mutate(s=>{s.sessions[id].payment_status='paid';s.sessions[id].status='complete'})
  f.db.exec("CREATE TRIGGER fixture_payment_failure BEFORE INSERT ON payments BEGIN SELECT RAISE(ABORT,'fixture failed financial write'); END")
  const failed=await f.stripeHook(id);assert.equal(failed.status,503)
  assert.equal(f.paymentRows(inv).length,0);assert.equal(f.paid(inv).amount_paid,0)
  let receipts=await f.receipts(inv);assert.equal(receipts.length,1);assert.equal(receipts[0].amount_cents,10000);assert.equal(receipts[0].state,'review')
  assert(f.paid(inv).payment_review);assert((await f.collections()).receipts.some(r=>r.id===receipts[0].id))
  await f.restart();f.db.exec('DROP TRIGGER fixture_payment_failure')
  const retry=await f.stripeHook(id);assert.equal(retry.status,200,retry.text)
  assert.equal(f.paymentRows(inv).length,1);assert.equal(f.paid(inv).amount_paid,100)
  receipts=await f.receipts(inv);assert.equal(receipts.length,1);assert.equal(receipts[0].state,'applied_review')
  const before=JSON.stringify(f.paymentRows(inv));assert.equal((await f.stripeHook(id)).status,200)
  assert.equal(JSON.stringify(f.paymentRows(inv)),before)
  assert.equal(f.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[])
})


test('checkout recovery and receipt reads require manager access', {timeout:180000},async t=>{
  const f=await fixture(t),inv=await f.invoice();assert.equal((await f.checkout(inv)).status,303)
  const c=await f.collection(inv),control=new DatabaseSync(f.controlPath)
  try {
    control.prepare("UPDATE members SET role='staff'").run()
    for(const path of ['/api/payments/collections','/api/payments/collections?invoice_id='+inv.id,'/api/payments/collections/'+c.reference]) {
      const r=await f.request(path);assert.equal(r.status,403,r.text);assert(!r.text.includes(c.reference))
    }
    for(const suffix of ['resume','expire'])assert.equal((await f.request('/api/payments/collections/'+c.reference+'/'+suffix,{method:'POST',body:{revision:c.revision}})).status,403)
    assert.equal((await f.request('/api/payments/reconcile/'+c.reference,{method:'POST',body:{revision:c.revision}})).status,403)
  } finally {control.prepare("UPDATE members SET role='owner'").run();control.close()}
  assert.equal((await f.request('/api/payments/collections/'+c.reference)).status,200)
})
