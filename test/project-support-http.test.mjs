import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createHttpTestServer } from './helpers/http-test-server.mjs'
import { createHmac } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

test('project support is read-only and signed unrelated Stripe events cannot change hosting', {timeout:180000}, async () => {
  const root=mkdtempSync(join(tmpdir(),'psc-support-http-')), demo=join(root,'demo')
  const httpServer=await createHttpTestServer(), port=httpServer.port
  let child, control
  try {
    const built=spawnSync(process.execPath,['bin/demo.mjs',demo,String(port)],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:90000})
    assert.equal(built.status,0,built.stderr)
    const env=JSON.parse(readFileSync(join(demo,'demo-env.json'),'utf8'))
    Object.assign(env,{PSC_TICK_MS:'3600000',PSC_STRIPE_WEBHOOK_SECRET:'whsec_fixture_only',PSC_PLATFORM_STRIPE_SECRET:'sk_test_fixture_only',
      PSC_PROJECT_SUPPORT_ONCE_URL:'https://buy.stripe.com/fixtureOnce',
      PSC_PROJECT_SUPPORT_MONTHLY_URL:'https://buy.stripe.com/fixtureMonthly',
      PSC_PROJECT_SUPPORT_MANAGE_URL:'https://billing.stripe.com/p/login/fixtureManage'})
    control=new DatabaseSync(join(demo,'data/control.db'))
    const tenantId=control.prepare('SELECT id FROM tenants LIMIT 1').get().id
    control.prepare("UPDATE tenants SET stripe_customer_id='cus_fixtureShop',stripe_subscription_id='sub_fixtureHosting',subscription_status='active',plan_tier='everything' WHERE id=?").run(tenantId)
    // Intercept exactly the fixture subscription read. The network guard still refuses every
    // real external destination; no provider key or account is used by this test.
    writeFileSync(join(demo,'fixture-platform-state.txt'),'unavailable')
    writeFileSync(join(demo,'fixture-platform-read.mjs'),`import{readFileSync}from'node:fs';const guardedFetch=globalThis.fetch;globalThis.fetch=async(input,options)=>{const url=String(input);if(url.startsWith('https://api.stripe.com/')){if(url!=='https://api.stripe.com/v1/subscriptions/sub_fixtureHosting?expand%5B%5D=items.data.price.product'||options?.method!=='GET'||options?.headers?.Authorization!=='Bearer sk_test_fixture_only')throw Error('Unexpected fixture Stripe request');console.log('FIXTURE_PLATFORM_SUBSCRIPTION_READ');if(readFileSync(new URL('./fixture-platform-state.txt',import.meta.url),'utf8')==='unavailable')return new Response(JSON.stringify({error:{message:'Fixture temporarily unavailable'}}),{status:503});return new Response(JSON.stringify({object:'subscription',id:'sub_fixtureHosting',customer:'cus_fixtureShop',status:'canceled',metadata:{tenant_id:'${tenantId}',plan:'everything',purpose:'printshopcrm_hosting'}}),{status:200,headers:{'Content-Type':'application/json'}})}return guardedFetch(input,options)};`)
    let logs=''
    await httpServer.start({cwd:demo,env,args:['--no-warnings','--import','./bin/demo-network-guard.mjs','--import','./fixture-platform-read.mjs','server.mjs'],onOutput:text=>{logs+=text}});child=httpServer.child
    for(let n=0;n<600&&child.exitCode===null&&!logs.includes('(ws /ws live');n++)await new Promise(resolve=>setTimeout(resolve,50))
    assert.match(logs,/ws \/ws live/,logs)
    const base=httpServer.base
    assert.equal((await fetch(base+'/api/project-support')).status,401)
    const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'dylan@example.test',password:readFileSync(join(demo,'LOGIN.txt'),'utf8').match(/Password: (.+)/)[1]})})
    assert.equal(login.status,200)
    const Cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')
    const hosting=()=>control.prepare('SELECT plan_tier,subscription_status,stripe_customer_id,stripe_subscription_id FROM tenants WHERE id=?').get(tenantId)
    const before=hosting()
    const support=await fetch(base+'/api/project-support',{headers:{Cookie}})
    assert.equal(support.status,200);assert.match(support.headers.get('cache-control'),/no-store/)
    const config=await support.json();assert.equal(config.enabled,true)
    assert.equal(config.one_time_url,env.PSC_PROJECT_SUPPORT_ONCE_URL);assert.equal(config.monthly_url,env.PSC_PROJECT_SUPPORT_MONTHLY_URL)
    assert.equal(config.manage_url,env.PSC_PROJECT_SUPPORT_MANAGE_URL);assert.equal(config.github_url,null)
    assert.doesNotMatch(JSON.stringify(config),/whsec_|psc_session|fixtureShop|fixtureHosting/)
    assert.deepEqual(hosting(),before)
    assert.equal((await fetch(base+'/api/project-support',{method:'POST',headers:{Cookie,'Content-Type':'application/json'},body:JSON.stringify({one_time_url:'https://example.invalid'})})).status,404)
    for(const plan of ['free','starter','growth','pro','control','control_auto','__proto__',null]) {
      const retired=await fetch(base+'/api/billing/checkout',{method:'POST',headers:{Cookie,'Content-Type':'application/json'},body:JSON.stringify({plan})})
      assert.equal(retired.status,400);assert.equal((await retired.json()).code,'hosting_plan_unavailable')
    }
    const duplicate=await fetch(base+'/api/billing/checkout',{method:'POST',headers:{Cookie,'Content-Type':'application/json'},body:JSON.stringify({plan:'everything'})})
    assert.equal(duplicate.status,409);assert.equal((await duplicate.json()).code,'hosting_subscription_exists')
    assert.deepEqual(hosting(),before)
    const webhook=async(type,object,{signature=true,account}={})=>{
      const body=JSON.stringify({id:'evt_fixture_'+type.replaceAll('.','_'),type,created:Math.floor(Date.now()/1000),...(account?{account}:{}),data:{object}}),timestamp=Math.floor(Date.now()/1000)
      const sig=createHmac('sha256',env.PSC_STRIPE_WEBHOOK_SECRET).update(timestamp+'.'+body).digest('hex')
      return fetch(base+'/webhooks/stripe',{method:'POST',headers:{'Content-Type':'application/json','Stripe-Signature':`t=${timestamp},v1=${signature?sig:'0'.repeat(64)}`},body})
    }
    for(const [type,object] of [
      ['customer.subscription.deleted',{id:'sub_fixtureDonation',customer:'cus_fixtureShop',status:'canceled'}],
      ['customer.subscription.updated',{id:'sub_fixtureDonation',customer:'cus_fixtureShop',status:'past_due',metadata:{purpose:'project_support'}}],
      ['invoice.payment_failed',{customer:'cus_fixtureShop',subscription:'sub_fixtureDonation'}],
      ['invoice.payment_failed',{customer:'cus_fixtureShop',parent:{type:'subscription_details',subscription_details:{subscription:'sub_fixtureDonation'}}}],
      ['invoice.payment_failed',{customer:'cus_fixtureShop'}],
      ['checkout.session.completed',{id:'cs_fixtureDonation',mode:'payment',status:'complete',customer:'cus_fixtureShop',client_reference_id:String(tenantId),metadata:{tenant_id:String(tenantId),plan:'everything'}}],
      ['customer.subscription.deleted',{id:'sub_fixtureHosting',customer:'cus_someoneElse',status:'canceled'}],
    ]) {
      const response=await webhook(type,object);assert.equal(response.status,200,await response.text());assert.deepEqual(hosting(),before,type+' changed hosting for an unrelated payment')
    }
    assert.equal((await webhook('customer.subscription.deleted',{id:'sub_fixtureHosting',customer:'cus_fixtureShop',status:'canceled'},{account:'acct_connectedFixture'})).status,200)
    assert.deepEqual(hosting(),before,'a Connect-account event is not a platform hosting event')
    assert.equal((await webhook('customer.subscription.deleted',{id:'sub_fixtureHosting',customer:'cus_fixtureShop',status:'canceled'},{signature:false})).status,400)
    assert.deepEqual(hosting(),before)
    assert.doesNotMatch(logs,/FIXTURE_PLATFORM_SUBSCRIPTION_READ/,'unrelated events never query a payment provider')
    const unavailable=await webhook('customer.subscription.deleted',{id:'sub_fixtureHosting',customer:'cus_fixtureShop',status:'canceled'})
    assert.equal(unavailable.status,503);assert.equal(unavailable.headers.get('retry-after'),'10');assert.deepEqual(hosting(),before,'a provider failure keeps hosting unchanged and requests event retry')
    writeFileSync(join(demo,'fixture-platform-state.txt'),'canceled')
    // A real, exactly bound cancellation reconciles the current fixture subscription.
    const canceled=await webhook('customer.subscription.deleted',{id:'sub_fixtureHosting',customer:'cus_fixtureShop',status:'canceled'})
    assert.equal(canceled.status,200,await canceled.text());assert.equal(hosting().subscription_status,'canceled')
    assert.equal(hosting().stripe_subscription_id,'sub_fixtureHosting')
    const stale=await webhook('customer.subscription.updated',{id:'sub_fixtureHosting',customer:'cus_fixtureShop',status:'active'})
    assert.equal(stale.status,200);assert.equal(hosting().subscription_status,'canceled','delayed active event cannot reopen a canceled current subscription')
    assert.equal(logs.match(/FIXTURE_PLATFORM_SUBSCRIPTION_READ/g)?.length,3)
    assert.doesNotMatch(logs,/external request blocked/i,'all provider I/O used the isolated fixture')
  } finally {
    control?.close()
    await httpServer.close()
    rmSync(root,{recursive:true,force:true})
  }
})
