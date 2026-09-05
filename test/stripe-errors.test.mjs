import test from 'node:test'
import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import { createServer } from 'node:http'
import { setPlatformCredentials } from '../lib/billing.mjs'
import { requestStripe, createCheckout, retrieveSession, retrieveStripeRefund } from '../lib/stripe.mjs'
import { createExpressAccount, createAccountLink, getConnectAccount, createConnectedCheckout, retrieveConnectedSession } from '../lib/connect.mjs'

const secret = 'sk_test_ERROR_SENTINEL_NOT_A_REAL_KEY'
const settings = { stripe_secret: secret, currency: 'USD' }
const checkout = { lineItems: [{ name: 'Fixture shirt', amountCents: 1250, qty: 2 }], successUrl: 'https://shop.test/paid', cancelUrl: 'https://shop.test/invoice' }
const reply = (data, options) => new Response(JSON.stringify(data), options)
const calls = () => [
  () => createExpressAccount({ email: 'owner@example.test', shopName: 'Fixture', slug: 'fixture' }),
  () => createAccountLink({ accountId: 'acct_fixture', origin: 'https://shop.test' }),
  () => getConnectAccount({ accountId: 'acct_fixture' }),
  () => createConnectedCheckout({ accountId: 'acct_fixture', ...checkout }),
  () => retrieveConnectedSession({ sessionId: 'cs_fixture' }),
  () => createCheckout({ settings, ...checkout, idempotencyKey: 'fixture-attempt' }),
  () => retrieveSession({ settings, sessionId: 'cs_fixture' }),
  () => retrieveStripeRefund({ settings, id: 're_fixture' }),
]
const safe = (code, uncertain) => error => {
  assert.equal(error.code, code)
  assert.equal(error.stripeSafe, true)
  assert.equal(Object.hasOwn(error, 'cause'), false)
  if (uncertain !== undefined) assert.equal(error.outcome_uncertain, uncertain)
  assert.doesNotMatch(inspect(error, { depth: null }) + JSON.stringify(error), /ERROR_SENTINEL|PROVIDER_PRIVATE|Bearer|customer-private@example/)
  assert.match(error.message, /Stripe|Payment/)
  return true
}
async function withFetch(send, fn) {
  const previous = globalThis.fetch
  globalThis.fetch = send
  setPlatformCredentials({ secret })
  try { await fn() } finally { globalThis.fetch = previous; setPlatformCredentials({ secret: '' }) }
}

test('every Connect/shop checkout/read/refund path replaces echoed key and provider errors with safe actionable errors', async () => {
  for (const [status, code] of [[401,'stripe_authentication_failed'],[403,'stripe_authentication_failed'],[429,'stripe_rate_limited'],[400,'stripe_request_rejected'],[500,'stripe_unavailable']]) {
    await withFetch(async (_url, options) => {
      assert.equal(options.redirect, 'error')
      assert(options.signal instanceof AbortSignal)
      return reply({error:{message:`Invalid API Key provided: ${secret}`,code:'PROVIDER_PRIVATE',customer:'customer-private@example'}}, {status})
    }, async () => {
      for (const call of calls()) await assert.rejects(call(), safe(code))
    })
  }
  // The second refund request must use the same safe transport as the first.
  let count = 0
  await assert.rejects(retrieveStripeRefund({ settings, id: 're_fixture', send: async () => ++count === 1
    ? reply({id:'re_fixture',object:'refund',payment_intent:'pi_fixture'})
    : reply({error:{message:secret}}, {status:401}) }), safe('stripe_authentication_failed', false))
  assert.equal(count, 2)
})

test('network exceptions, malformed success JSON and fake safe markers never escape with raw messages or causes', async () => {
  for (const send of [
    async () => { throw Object.assign(new Error(secret, {cause:new Error('PROVIDER_PRIVATE')}), {stripeSafe:true,code:'stripe_unavailable'}) },
    async () => new Response('not JSON '+secret),
    async () => reply(null),
    async () => reply([secret]),
  ]) {
    await withFetch(send, async () => {
      for (const call of calls()) await assert.rejects(call(), error => {
        assert(['stripe_unavailable','stripe_response_invalid'].includes(error.code))
        return safe(error.code)(error)
      })
    })
  }
})

test('error bodies are canceled without parsing their content and no redirect response is accepted', async () => {
  let canceled = 0
  await assert.rejects(requestStripe('accounts', {secret, send: async () => ({
    ok:false,status:401,body:{cancel:async()=>{canceled++}},
    json:()=>{throw Error(secret)},
  })}), safe('stripe_authentication_failed', false))
  assert.equal(canceled, 1)
  for (const [url,redirected] of [['https://other.example/private',false],['https://api.stripe.com/v1/accounts',true]]) {
    await assert.rejects(requestStripe('accounts',{secret,send:async (_url,options)=>{
      assert.equal(_url,'https://api.stripe.com/v1/accounts');assert.equal(options.redirect,'error')
      return {ok:true,url,redirected,body:{cancel:async()=>{canceled++}}}
    }}),safe('stripe_response_invalid',false))
  }
  assert.equal(canceled, 3)
})

test('declared and streamed responses are bounded, canceled and released on overflow', async () => {
  let canceled = 0
  const declared = new Response(new ReadableStream({cancel(){canceled++}}),{headers:{'Content-Length':String(1024*1024+1)}})
  await assert.rejects(requestStripe('accounts',{secret,send:async()=>declared}),safe('stripe_response_too_large',false))
  assert.equal(canceled,1)
  let reads=0
  const streamed = new Response(new ReadableStream({
    pull(controller){reads++;controller.enqueue(new Uint8Array(600000))},
    cancel(){canceled++},
  }))
  await assert.rejects(requestStripe('accounts',{secret,send:async()=>streamed}),safe('stripe_response_too_large',false))
  assert.equal(canceled,2);assert.equal(streamed.body.locked,false);assert(reads<=4)
  // The accepted byte boundary is inclusive and does not require a Content-Length header.
  const json='{"ok":true,"padding":"'+'x'.repeat(1024*1024-24)+'"}'
  assert.equal(Buffer.byteLength(json),1024*1024)
  assert.equal((await requestStripe('accounts',{secret,send:async()=>new Response(json)})).ok,true)
})

test('the whole-request deadline covers stalled fetch and stalled bodies, with no automatic write retry', async () => {
  let requests=0, aborted=false
  await assert.rejects(requestStripe('checkout/sessions',{secret,method:'POST',timeoutMs:20,send:async (_url,{signal})=>{
    requests++
    return new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error(secret))},{once:true}))
  }}),safe('stripe_request_timeout',true))
  assert.equal(requests,1);assert.equal(aborted,true)
  let canceled=false
  const response=new Response(new ReadableStream({cancel(){canceled=true}}))
  await assert.rejects(requestStripe('accounts',{secret,timeoutMs:20,send:async()=>response}),safe('stripe_request_timeout',false))
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(canceled,true);assert.equal(response.body.locked,false)
  let finishFetch, lateCanceled=false
  const late=requestStripe('accounts',{secret,timeoutMs:20,send:()=>new Promise(resolve=>{finishFetch=resolve})})
  await assert.rejects(late,safe('stripe_request_timeout',false))
  finishFetch(new Response(new ReadableStream({cancel(){lateCanceled=true}})))
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(lateCanceled,true,'a fetch resolving after timeout cannot retain its response body')
  assert.deepEqual(await requestStripe('accounts',{secret,send:async()=>reply({recovered:true})}),{recovered:true})
})

test('real fetch refuses redirects before a fixture credential or POST body reaches another host', async () => {
  let redirectHits=0, targetHits=0
  const target=createServer((_req,res)=>{targetHits++;res.end('{}')})
  const redirect=createServer((_req,res)=>{redirectHits++;res.writeHead(307,{Location:`http://127.0.0.1:${target.address().port}/forwarded`});res.end()})
  await new Promise(resolve=>target.listen(0,'127.0.0.1',resolve))
  await new Promise(resolve=>redirect.listen(0,'127.0.0.1',resolve))
  try {
    await assert.rejects(requestStripe('checkout/sessions',{secret,method:'POST',body:'fixture='+secret,send:async(url,options)=>{
      assert.equal(url,'https://api.stripe.com/v1/checkout/sessions')
      // Map only this authorized URL to the local redirect fixture; never call a provider.
      return fetch(`http://127.0.0.1:${redirect.address().port}/fixture`,options)
    }}),safe('stripe_unavailable',true))
    assert.equal(redirectHits,1);assert.equal(targetHits,0)
  } finally {
    await Promise.all([new Promise(resolve=>redirect.close(resolve)),new Promise(resolve=>target.close(resolve))])
  }
})

test('global request capacity rejects without a provider call or a retained queue and recovers after errors', async () => {
  const releases=[]
  const pending=Array.from({length:16},()=>requestStripe('accounts',{secret,send:async()=>new Promise(resolve=>releases.push(resolve))}))
  assert.equal(releases.length,16)
  let extraCalls=0
  await assert.rejects(requestStripe('accounts',{secret,send:async()=>{extraCalls++;return reply({ok:true})}}),safe('stripe_busy',false))
  assert.equal(extraCalls,0)
  for(const release of releases)release(reply({ok:true}))
  assert.equal((await Promise.all(pending)).length,16)
  assert.deepEqual(await requestStripe('accounts',{secret,send:async()=>reply({ok:true})}),{ok:true})
})

test('successful account, checkout, session and refund contracts and idempotency headers are preserved', async () => {
  const requests=[]
  await withFetch(async(url,options)=>{
    requests.push({url,options})
    if(url.endsWith('/accounts'))return reply({id:'acct_fixture'})
    if(url.endsWith('/account_links'))return reply({url:'https://connect.stripe.com/setup/fixture'})
    if(url.endsWith('/accounts/acct_fixture'))return reply({charges_enabled:true,details_submitted:true,payouts_enabled:false})
    if(url.endsWith('/checkout/sessions')&&options.method==='POST')return reply({id:'cs_fixture',url:'https://checkout.stripe.com/c/pay/cs_fixture'})
    return reply({id:'cs_fixture',payment_status:'paid',amount_total:2500,currency:'usd',livemode:false,customer_details:{email:'customer@example.test'},metadata:{invoice:'5'},payment_intent:{id:'pi_fixture'}})
  },async()=>{
    assert.equal(await createExpressAccount({email:'owner@example.test'}),'acct_fixture')
    assert.equal(await createAccountLink({accountId:'acct_fixture',origin:'https://shop.test'}),'https://connect.stripe.com/setup/fixture')
    assert.deepEqual(await getConnectAccount({accountId:'acct_fixture'}),{charges_enabled:true,details_submitted:true,payouts_enabled:false})
    assert.deepEqual(await createConnectedCheckout({accountId:'acct_fixture',...checkout}),{id:'cs_fixture',url:'https://checkout.stripe.com/c/pay/cs_fixture'})
    assert.deepEqual(await createCheckout({settings,...checkout,idempotencyKey:'fixture-attempt'}),{id:'cs_fixture',url:'https://checkout.stripe.com/c/pay/cs_fixture'})
    assert.deepEqual(await retrieveSession({settings,sessionId:'cs_fixture'}),{paid:true,test:true,amountCents:2500,currency:'USD',id:'cs_fixture',paymentIntent:'pi_fixture',email:'customer@example.test',metadata:{invoice:'5'}})
    assert.deepEqual(await retrieveConnectedSession({sessionId:'cs_fixture'}),{paid:true,test:true,amountCents:2500,currency:'USD',email:'customer@example.test',metadata:{invoice:'5'}})
  })
  assert.equal(requests.filter(r=>r.options.headers['Idempotency-Key']==='fixture-attempt').length,1)
  const connect=requests.find(r=>r.url.endsWith('/checkout/sessions')&&!r.options.headers['Idempotency-Key'])
  const params=new URLSearchParams(connect.options.body)
  assert.equal(params.get('payment_intent_data[transfer_data][destination]'),'acct_fixture')
  assert.equal(params.get('payment_intent_data[application_fee_amount]'),'100')
  assert.equal(params.get('line_items[0][price_data][unit_amount]'),'1250')
  let n=0
  const refund=await retrieveStripeRefund({settings,id:'re_fixture',send:async()=>++n===1
    ?reply({id:'re_fixture',object:'refund',payment_intent:'pi_fixture',amount:500,currency:'usd',status:'succeeded'})
    :reply({has_more:false,data:[{id:'cs_fixture',payment_intent:'pi_fixture',payment_status:'paid',livemode:false,currency:'usd',amount_total:2500,metadata:{invoice:'5'}}]})})
  assert.equal(n,2);assert.equal(refund.appliedCents,500);assert.equal(refund.session.paymentIntent,'pi_fixture');assert.equal(refund.session.amountCents,2500)
})
