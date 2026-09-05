import test from 'node:test'
import assert from 'node:assert/strict'

test('self-hosted billing screen offers the free software without a paid-plan checkout', async () => {
  const nodes = new Map()
  const node = key => { if(!nodes.has(key)) nodes.set(key,{innerHTML:'',textContent:'',addEventListener(){},querySelector:()=>null}); return nodes.get(key) }
  globalThis.document = {querySelector:node}
  globalThis.location = {origin:'http://localhost'}
  const {api} = await import('../public/js/core.js')
  api.get = async path => path==='/api/billing' ? {live:false,plans:{everything:{name:'Everything',monthly:149,annual:1490,features:[]}},order:['everything'],state:{status:'active',subscribed:true}} : {is_admin:false}
  const {billingView} = await import('../public/js/views/billing.js')
  await billingView()
  assert.match(node('#view').innerHTML,/Free and open source/i)
  assert.doesNotMatch(node('#view').innerHTML,/data-plan=|free trial|\$149|Choose Everything/i)
})

test('hosting management stays usable after cancellation and absent on a self-hosted install with historical billing IDs', async () => {
  const nodes=new Map()
  const node=key=>{if(!nodes.has(key))nodes.set(key,{innerHTML:'',textContent:'',addEventListener(){},querySelector:()=>null});return nodes.get(key)}
  globalThis.document={querySelector:key=>key==='#manage'&&!node('#view').innerHTML.includes('id="manage"')?null:node(key)}
  globalThis.location={origin:'http://localhost'}
  const {api}=await import('../public/js/core.js')
  const {billingView}=await import('../public/js/views/billing.js')
  const plans={everything:{name:'Managed hosting',monthly:149,annual:1490,features:[]}}
  api.get=async path=>path==='/api/billing'?{live:true,plans,order:['everything'],has_subscription:true,state:{status:'canceled',subscribed:false,stripe_customer_id:'cus_fixture'}}:{is_admin:false}
  await billingView()
  assert.match(node('#view').innerHTML,/id="manage"/)
  assert.equal(typeof node('#manage').onclick,'function','canceled hosting still has a working management button')
  let posts=[];api.post=async path=>{posts.push(path);return {url:'https://billing.stripe.com/p/session/fixture'}}
  await node('#manage').onclick()
  assert.deepEqual(posts,['/api/billing/portal'])
  assert.equal(location.href,'https://billing.stripe.com/p/session/fixture')
  api.get=async path=>path==='/api/billing'?{live:false,plans,order:['everything'],has_subscription:true,state:{status:'active',subscribed:true,stripe_customer_id:'cus_fixture'}}:{is_admin:false}
  await assert.doesNotReject(billingView())
  assert.doesNotMatch(node('#view').innerHTML,/id="manage"|data-plan=/)
})

test('an unresolved hosting checkout exposes recovery and prevents starting another plan; employees see no owner actions', async () => {
  const nodes=new Map()
  const node=key=>{if(!nodes.has(key))nodes.set(key,{innerHTML:'',textContent:'',addEventListener(){},querySelector:()=>null});return nodes.get(key)}
  globalThis.document={querySelector:key=>key.startsWith('#hosting-')&&!node('#view').innerHTML.includes(`id="${key.slice(1)}"`)?null:node(key)}
  globalThis.location={origin:'http://localhost'}
  const {api}=await import('../public/js/core.js')
  const {billingView}=await import('../public/js/views/billing.js')
  const data={live:true,can_manage:true,plans:{everything:{name:'Managed hosting',monthly:149,annual:1490,features:[]}},order:['everything'],state:{status:'trial',trial_days_left:20},
    hosting_checkout:{intent:{id:'fixture',state:'unknown',plan:'everything',interval:'year',can_retry:false,can_expire:false},anomalies:[]}}
  api.get=async path=>path==='/api/billing'?data:{is_admin:false}
  await billingView()
  assert.match(node('#view').innerHTML,/Stripe has not confirmed|id="hosting-check"|id="hosting-recover"|Annual/)
  assert.doesNotMatch(node('#view').innerHTML,/data-plan=|id="hosting-resume"|id="hosting-expire"/)
  assert.equal(typeof node('#hosting-check').onclick,'function')
  data.hosting_checkout.intent={...data.hosting_checkout.intent,state:'open',can_retry:true,can_expire:true}
  await billingView()
  assert.match(node('#view').innerHTML,/id="hosting-resume"/)
  assert.match(node('#view').innerHTML,/id="hosting-expire"/)
  assert.doesNotMatch(node('#view').innerHTML,/data-plan=/)
  let posts=[]
  api.post=async(path,body)=>{posts.push({path,body});return{url:'https://checkout.stripe.com/c/pay/cs_fixture'}}
  await node('#hosting-resume').onclick()
  assert.deepEqual(posts,[{path:'/api/billing/checkout',body:{plan:'everything',interval:'year'}}])
  assert.equal(location.href,'https://checkout.stripe.com/c/pay/cs_fixture')
  data.can_manage=false;data.hosting_checkout=null;data.state.stripe_customer_id='cus_fixture'
  await billingView()
  assert.match(node('#view').innerHTML,/Your shop owner manages hosting/)
  assert.doesNotMatch(node('#view').innerHTML,/data-plan=|id="manage"|id="hosting-/)
})

test('a received payment awaiting verification blocks checkout without an intent and refreshes without creating a payment', async () => {
  const nodes=new Map()
  const node=key=>{if(!nodes.has(key))nodes.set(key,{innerHTML:'',textContent:'',addEventListener(){},querySelector:()=>null});return nodes.get(key)}
  globalThis.document={querySelector:key=>key.startsWith('#hosting-')&&!node('#view').innerHTML.includes(`id="${key.slice(1)}"`)?null:node(key)}
  globalThis.location={origin:'http://localhost'}
  const {api}=await import('../public/js/core.js')
  const {billingView}=await import('../public/js/views/billing.js')
  const data={live:true,can_manage:true,plans:{everything:{name:'Managed hosting',monthly:149,annual:1490,features:[]}},order:['everything'],state:{status:'trial',trial_days_left:20},
    hosting_checkout:{intent:null,anomalies:[],pending_verifications:[{id:'a'.repeat(64),session_id:'cs_fixture'}]}}
  const reads=[]
  api.get=async path=>{reads.push(path);return path==='/api/billing'?data:{is_admin:false}}
  api.post=async()=>assert.fail('Refreshing a pending receipt must not create or mutate a payment')
  await billingView()
  assert.match(node('#view').innerHTML,/received hosting payment is awaiting verification/)
  assert.doesNotMatch(node('#view').innerHTML,/data-plan=|id="hosting-check"|id="hosting-resume"/)
  assert.equal(typeof node('#hosting-refresh').onclick,'function')
  const refresh=node('#hosting-refresh').onclick
  data.hosting_checkout.pending_verifications=[]
  await refresh()
  assert.equal(reads.filter(path=>path==='/api/billing').length,2)
  assert.match(node('#view').innerHTML,/data-plan="everything"/)
})
