import test from 'node:test'
import assert from 'node:assert/strict'
import {inspect} from 'node:util'
import {createStripeCollectionClient,normalizeStripeCollectionSession} from '../lib/stripe.mjs'
import {createConnectedCollectionClient} from '../lib/connect.mjs'
import {setPlatformCredentials} from '../lib/billing.mjs'
import {createAuthorizeCollectionClient,requestAuthorize,testAuthorize,createAuthorizeCheckout,retrieveAuthorizeTransaction} from '../lib/authorizenet.mjs'

const secret='sk_test_PROVIDER_SENTINEL',settings={stripe_secret:secret,currency:'USD'}
const anet={anet_login_id:'fixtureLogin',anet_transaction_key:'TRANSACTION_SENTINEL',anet_signature_key:'A'.repeat(128),anet_environment:'sandbox',anet_currency:'USD'}
const input={reference:'A'.repeat(20),amountCents:2500,currency:'USD',lineItems:[{name:'Fixture shirts',amountCents:1250,qty:2}],successUrl:'https://shop.example.test/return?session_id={CHECKOUT_SESSION_ID}',cancelUrl:'https://shop.example.test/cancel',customerEmail:'ap@example.test',metadata:{invoice:'5',reference:'A'.repeat(20)}}
const response=value=>new Response(JSON.stringify(value))
const session=patch=>({object:'checkout.session',id:'cs_fixture',mode:'payment',status:'open',payment_status:'unpaid',livemode:false,amount_total:2500,currency:'usd',url:'https://checkout.stripe.com/c/pay/cs_fixture',metadata:{...input.metadata},payment_intent:null,...patch})
const safe=(code,uncertain)=>error=>{
  assert.equal(error.code,code);assert.equal(error.outcome_uncertain,uncertain)
  assert.equal(Object.hasOwn(error,'cause'),false)
  assert.doesNotMatch(inspect(error,{depth:null})+JSON.stringify(error),/PROVIDER_SENTINEL|TRANSACTION_SENTINEL|PRIVATE_RESPONSE/)
  return true
}

test('shop collection retries reuse exact credential-free request bytes and stable key after a lost response',async()=>{
  const current={...settings},calls=[],stored=new Map();let creates=0,lose=true
  const send=async(url,options)=>{
    calls.push({url,...options})
    if(url.endsWith('/account'))return response({object:'account',id:'acct_same'})
    if(url.endsWith('/checkout/sessions')){
      const key=options.headers['Idempotency-Key']
      if(!stored.has(key)){stored.set(key,{body:options.body,result:session()});creates++}
      assert.equal(options.body,stored.get(key).body)
      if(lose){lose=false;throw new Error('PRIVATE_RESPONSE '+secret)}
      return response(stored.get(key).result)
    }
    throw Error('Unexpected endpoint')
  }
  const first=createStripeCollectionClient(current,{send})
  const body=first.buildRequest(input)
  assert.equal(first.buildRequest({...input,metadata:{reference:input.reference,invoice:'5'}}),body)
  assert.doesNotMatch(body,/PROVIDER_SENTINEL|Authorization/)
  const params=new URLSearchParams(body)
  assert.equal(params.get('line_items[0][price_data][unit_amount]'),'1250')
  assert.equal(params.get('success_url'),input.successUrl)
  assert.deepEqual(await first.account(),{account_id:'acct_same',is_test:true,destination:null})
  await assert.rejects(first.create({requestBody:body,idempotencyKey:'collection:fixture:1'}),safe('stripe_unavailable',true))
  current.stripe_secret='sk_test_ROTATED'
  assert.equal(first.matchesSettings(current),false)
  const afterRestart=createStripeCollectionClient(current,{send})
  assert.deepEqual(await afterRestart.account(),{account_id:'acct_same',is_test:true,destination:null})
  const recovered=await afterRestart.create({requestBody:body,idempotencyKey:'collection:fixture:1'})
  assert.equal(recovered.id,'cs_fixture');assert.equal(recovered.status,'open');assert.equal(creates,1)
  const posts=calls.filter(c=>c.method==='POST');assert.equal(posts.length,2)
  assert.equal(posts[0].body,posts[1].body);assert.equal(posts[0].headers.Authorization,'Bearer '+secret);assert.equal(posts[1].headers.Authorization,'Bearer sk_test_ROTATED')
  for(const key of ['', 'key\n','has space'])await assert.rejects(first.create({requestBody:body,idempotencyKey:key}),/idempotency key/)
  assert.equal(calls.filter(c=>c.method==='POST').length,2)
})

test('Connect captures platform identity and immutable fee/destination while full reads report actual returned destination',async()=>{
  setPlatformCredentials({secret})
  const current={stripe_account_id:'acct_shop',stripe_charges_enabled:'1'},calls=[]
  const send=async(url,options)=>{
    calls.push({url,...options})
    if(url.endsWith('/account'))return response({object:'account',id:'acct_platform'})
    if(options.method==='POST')return response(session())
    assert.equal(new URL(url).searchParams.get('expand[]'),'payment_intent')
    return response(session({status:'complete',payment_status:'paid',url:null,payment_intent:{object:'payment_intent',id:'pi_paid',transfer_data:{destination:'acct_actual'},on_behalf_of:'acct_actual',application_fee_amount:100}}))
  }
  try{
    const client=createConnectedCollectionClient(current,{send}),body=client.buildRequest(input),params=new URLSearchParams(body)
    assert.equal(client.provider,'stripe_connect');assert.equal(params.get('payment_intent_data[transfer_data][destination]'),'acct_shop')
    assert.equal(params.get('payment_intent_data[on_behalf_of]'),'acct_shop');assert.equal(params.get('payment_intent_data[application_fee_amount]'),'100')
    assert.deepEqual(await client.account(),{account_id:'acct_platform',is_test:true,destination:'acct_shop'})
    setPlatformCredentials({secret:'sk_test_CHANGED_PLATFORM'})
    assert.equal(client.matchesSettings(current),false)
    const created=await client.create({requestBody:body,idempotencyKey:'connected-fixture'})
    assert.equal(created.destination,null,'an open session with no PI cannot prove its eventual destination')
    const paid=await client.retrieve('cs_fixture')
    assert.equal(paid.destination,'acct_actual');assert.equal(paid.onBehalfOf,'acct_actual');assert.equal(paid.applicationFeeCents,100);assert.equal(paid.paid,true)
    assert(calls.every(c=>c.headers.Authorization==='Bearer '+secret && !Object.hasOwn(c.headers,'Stripe-Account')))
    assert.equal(calls.find(c=>c.method==='POST').headers['Idempotency-Key'],'connected-fixture')
  }finally{setPlatformCredentials({secret:''})}
})

test('strict session state rejects malformed or changed identity and expiration must be positively confirmed',async()=>{
  for(const patch of [{id:'cs_other'},{id:'cs_fixture\n'},{mode:'subscription'},{livemode:undefined},{amount_total:2.5},{currency:'usd\n'},{status:'expired',payment_status:'paid'},{url:'https://attacker.example/pay'},{url:'https://checkout.stripe.com@attacker.example/pay'},{metadata:[]},{payment_intent:'pi_fixture\n'}]){
    assert.throws(()=>normalizeStripeCollectionSession(session(patch),'cs_fixture'),safe('stripe_response_invalid',false))
  }
  let status='open',malformed=false,posts=0,reads=0
  const client=createStripeCollectionClient(settings,{send:async(url,options)=>{
    if(options.method==='GET'){reads++;return response(session({status,url:status==='open'?session().url:null}))}
    assert.match(url,/\/cs_fixture\/expire$/);assert.equal(options.headers['Idempotency-Key'],'expire-fixture');posts++
    if(malformed)return response({})
    status='expired';return response(session({status,url:null}))
  }})
  malformed=true
  await assert.rejects(client.expire({sessionId:'cs_fixture',idempotencyKey:'expire-fixture'}),safe('stripe_response_invalid',true))
  malformed=false
  assert.equal((await client.expire({sessionId:'cs_fixture',idempotencyKey:'expire-fixture'})).status,'expired')
  assert.equal((await client.expire({sessionId:'cs_fixture',idempotencyKey:'expire-fixture'})).status,'expired')
  assert.equal(posts,2);assert.equal(reads,3,'already closed session is verified and never posted again')
  await assert.rejects(client.retrieve('cs_fixture\n'),/Invalid Stripe checkout ID/)
  const wrongAccount=createStripeCollectionClient(settings,{send:async()=>response({object:'account',id:'acct_fixture\n'})})
  await assert.rejects(wrongAccount.account(),safe('stripe_response_invalid',false))
})

test('Authorize.net snapshots authenticated configured identity and injects secrets only in transport without claiming token closure',async()=>{
  const current={...anet},calls=[]
  const send=async(url,options)=>{
    calls.push({url,...options});assert.equal(options.redirect,'error')
    const parsed=JSON.parse(options.body)
    if(parsed.authenticateTestRequest)return response({messages:{resultCode:'Ok'}})
    if(parsed.getTransactionDetailsRequest)return response({messages:{resultCode:'Ok'},transaction:{transId:'12345',transactionStatus:'settledSuccessfully',responseCode:1,settleAmount:'25.00',order:{invoiceNumber:input.reference}}})
    return response({messages:{resultCode:'Ok'},token:'fixture-token'})
  }
  const client=createAuthorizeCollectionClient(current,{send}),body=client.buildRequest(input)
  assert.doesNotMatch(body,/TRANSACTION_SENTINEL|fixtureLogin|merchantAuthentication/)
  const account=await client.account();assert.match(account.account_id,/^anet_login_[a-f0-9]{64}$/);assert.equal(account.is_test,true)
  current.anet_transaction_key='rotated-key';assert.equal(client.matchesSettings(current),false)
  assert.deepEqual(await createAuthorizeCollectionClient(current,{send}).account(),account)
  assert.notEqual((await createAuthorizeCollectionClient({...current,anet_login_id:'differentLogin'},{send}).account()).account_id,account.account_id)
  const created=await client.create({requestBody:body,idempotencyKey:'ignored-no-provider-guarantee'})
  assert.equal(created.id,input.reference);assert.equal(created.token,'fixture-token');assert.equal(created.amountCents,2500);assert.equal(created.amountVerified,false)
  assert.equal(created.status,'open');assert.equal(created.paid,false);assert.equal(client.supportsIdempotency,false);assert.equal(client.supportsExpiration,false);assert.equal(client.expire,undefined)
  const post=JSON.parse(calls.find(c=>c.body.includes('getHostedPaymentPageRequest')).body).getHostedPaymentPageRequest
  assert.equal(post.merchantAuthentication.transactionKey,anet.anet_transaction_key)
  const {merchantAuthentication,...nonsecret}=post;assert.equal(JSON.stringify(nonsecret),body)
  assert.equal(post.transactionRequest.order.invoiceNumber,input.reference)
  const transaction=await client.retrieveTransaction('12345');assert.equal(transaction.paid,true);assert.equal(transaction.amountCents,2500);assert.equal(transaction.reference,input.reference)
  await assert.rejects(client.create({requestBody:JSON.stringify({...JSON.parse(body),merchantAuthentication:{name:'attacker'}})}),/Invalid saved Authorize.net request/)
  const count=calls.length
  await assert.rejects(client.create({requestBody:' '.repeat(65537)}),/Invalid saved Authorize.net checkout request/)
  assert.equal(calls.length,count)
})

test('all Authorize.net paths redact provider and network secrets and mark uncertain writes without retries',async()=>{
  const invoke=[send=>testAuthorize(anet,send),send=>createAuthorizeCheckout({settings:anet,...input,send}),send=>retrieveAuthorizeTransaction({settings:anet,transactionId:'12345',send}),send=>createAuthorizeCollectionClient(anet,{send}).account(),send=>{const c=createAuthorizeCollectionClient(anet,{send});return c.create({requestBody:c.buildRequest(input)})}]
  for(const send of [async()=>response({messages:{resultCode:'Error',message:[{text:'TRANSACTION_SENTINEL PRIVATE_RESPONSE'}]}}),async()=>{throw Object.assign(new Error('TRANSACTION_SENTINEL',{cause:'PRIVATE_RESPONSE'}),{authorizeSafe:true})}]){
    for(const fn of invoke)await assert.rejects(fn(send),error=>{assert.equal(error.authorizeSafe,true);assert.doesNotMatch(inspect(error,{depth:null}),/TRANSACTION_SENTINEL|PRIVATE_RESPONSE/);assert.equal(Object.hasOwn(error,'cause'),false);return true})
  }
  let calls=0
  const client=createAuthorizeCollectionClient(anet,{send:async()=>{calls++;return response({messages:{resultCode:'Ok'}})}})
  await assert.rejects(client.create({requestBody:client.buildRequest(input)}),safe('authorize_invalid',true));assert.equal(calls,1)
})

test('Authorize.net bounds response bytes, refuses redirects, and includes body consumption in its deadline',async()=>{
  let canceled=0
  for(const reply of [new Response(new ReadableStream({cancel(){canceled++}}),{headers:{'Content-Length':String(1024*1024+1)}}),new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(600000))},cancel(){canceled++}}))]){
    await assert.rejects(requestAuthorize(anet,'authenticateTestRequest',{},async()=>reply),safe('authorize_too_large',false));assert.equal(reply.body.locked,false)
  }
  assert.equal(canceled,2)
  await assert.rejects(requestAuthorize(anet,'authenticateTestRequest',{},async()=>({ok:true,redirected:true,url:'https://attacker.example',body:{cancel:async()=>{canceled++}}})),safe('authorize_invalid',false))
  assert.equal(canceled,3)
  let calls=0,aborted=false
  await assert.rejects(requestAuthorize(anet,'getHostedPaymentPageRequest',{},async(_url,{signal})=>{calls++;return new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('PRIVATE_RESPONSE'))},{once:true}))},20),safe('authorize_timeout',true))
  assert.equal(calls,1);assert.equal(aborted,true)
  const stalled=new Response(new ReadableStream({cancel(){canceled++}}))
  await assert.rejects(requestAuthorize(anet,'authenticateTestRequest',{},async()=>stalled,20),safe('authorize_timeout',false))
  await new Promise(resolve=>setImmediate(resolve));assert.equal(stalled.body.locked,false);assert.equal(canceled,4)
  const pending=[],releases=[]
  for(let i=0;i<16;i++)pending.push(requestAuthorize(anet,'authenticateTestRequest',{},()=>new Promise(resolve=>releases.push(resolve))))
  await assert.rejects(requestAuthorize(anet,'authenticateTestRequest',{},async()=>{assert.fail('Capacity overflow must not dispatch')}),safe('authorize_busy',false))
  for(const release of releases)release(response({messages:{resultCode:'Ok'}}))
  await Promise.all(pending)
  assert.equal((await requestAuthorize(anet,'authenticateTestRequest',{},async()=>response({messages:{resultCode:'Ok'}}))).messages.resultCode,'Ok')
})
