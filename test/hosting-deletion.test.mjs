import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import { createHostingCheckouts } from '../lib/hosting-checkouts.mjs'
import { createHostingDeletion } from '../lib/hosting-deletion.mjs'
import { createPlatformSubscriptionEventProcessor } from '../lib/platform-subscription-events.mjs'

const clone = value => structuredClone(value)
const matches = code => error => error?.hostingSafe && error.code === code
function fixture(t, { path = ':memory:', limits } = {}) {
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=0;
    CREATE TABLE IF NOT EXISTS tenants(id INTEGER PRIMARY KEY,slug TEXT,owner_email TEXT,plan TEXT,plan_tier TEXT,subscription_status TEXT,stripe_customer_id TEXT,stripe_subscription_id TEXT,hosting_revision INTEGER DEFAULT 0);
    INSERT OR IGNORE INTO tenants VALUES(1,'fixture','owner@example.test','trial','everything','trialing',NULL,NULL,0);`)
  t.after(() => db.close())
  const state = { clock: 1788566400000, reads: [], account: { accountId: 'acct_fixture', livemode: false }, subs: new Map(), sessions: new Map(), subHook: null }
  const noTransaction = () => { if (typeof db.isTransaction === 'boolean') assert.equal(db.isTransaction, false) }
  const createClient = () => ({
    account: async () => { noTransaction(); state.reads.push('account'); return clone(state.account) },
    retrieveSubscription: async id => { noTransaction(); state.reads.push(id); if (state.subHook) return state.subHook(id); if (!state.subs.has(id)) throw Error('PRIVATE_PROVIDER_MARKER'); return clone(state.subs.get(id)) },
    retrieveCheckout: async id => { noTransaction(); state.reads.push(id); if (!state.sessions.has(id)) throw Error('PRIVATE_PROVIDER_MARKER'); return clone(state.sessions.get(id)) },
  })
  const checkouts = createHostingCheckouts(db, { createClient, now: () => state.clock })
  let manager
  const final = (tenantId, token, evidence) => {
    db.exec('BEGIN IMMEDIATE')
    try { manager.authorizeCommit(tenantId, token, evidence); db.prepare('DELETE FROM tenants WHERE id=?').run(tenantId); db.exec('COMMIT') }
    catch (error) { db.exec('ROLLBACK'); throw error }
    const result = { ok: true, slug: 'fixture', dataRemoved: true, path: '/synthetic-only', error: '' }
    manager.recordResult(tenantId, result)
    return result
  }
  manager = createHostingDeletion(db, { checkouts, finalize: final, createClient, now: () => state.clock, limits })
  const seed = (localStatus = 'active', providerStatus = 'canceled', modern = true) => {
    db.prepare("UPDATE tenants SET plan='paid',stripe_customer_id='cus_fixture',stripe_subscription_id='sub_fixture',subscription_status=? WHERE id=1").run(localStatus)
    const intentId = crypto.randomUUID()
    const sub = { object: 'subscription', id: 'sub_fixture', customer: 'cus_fixture', status: providerStatus, livemode: false,
      metadata: { tenant_id: '1', plan: 'everything', ...(modern ? { purpose: 'printshopcrm_hosting', hosting_intent: intentId } : {}) },
      items: { has_more: false, data: [{ quantity: 1, price: { unit_amount: 14900, currency: 'usd', recurring: { interval: 'month', interval_count: 1 }, product: { name: 'PrintShopCRM Everything', metadata: {} } } }] } }
    state.subs.set(sub.id, sub)
    if (modern) db.prepare(`INSERT INTO hosting_checkout_intents(id,tenant_id,account_scope,request_body,request_digest,idempotency_key,plan,interval,amount_cents,currency,state,session_id,subscription_id,created_at,updated_at)
      VALUES(?,1,'acct_fixture:test','fixture','fixture',?,'everything','month',14900,'usd','complete','cs_fixture','sub_fixture',1,1)`).run(intentId, `key_${intentId}`)
    return sub
  }
  const preserved = () => { assert(db.prepare('SELECT 1 FROM tenants WHERE id=1').get()); assert.notEqual(db.prepare('SELECT state FROM hosting_tenant_deletions WHERE tenant_id=1').get()?.state, 'deleted') }
  return { db, manager, checkouts, state, seed, final, preserved, createClient }
}

test('both active and stale-canceled local hosting remain intact while provider is nonterminal', async t => {
  for (const local of ['active','canceled']) for (const actual of ['active','trialing','past_due','paused','unpaid','incomplete']) {
    const h = fixture(t); const sub = h.seed(local, actual); sub.cancel_at_period_end = true
    await assert.rejects(h.manager.remove(1), matches('hosting_deletion_active')); h.preserved()
    assert.equal(sub.status, actual); assert.equal(h.db.prepare('SELECT count(*) AS n FROM hosting_checkout_intents').get().n, 1)
  }
})

test('modern and pre-purpose legacy terminal subscriptions authorize once and persist retry outcomes', async t => {
  for (const modern of [true,false]) for (const status of ['canceled','incomplete_expired']) {
    const h = fixture(t); h.seed('active', status, modern)
    assert.throws(() => h.final(1), matches('hosting_deletion_verification_required'))
    const result = await h.manager.remove(1); assert.equal(result.ok, true)
    const reads = h.state.reads.length
    assert.deepEqual(await h.manager.remove(1), result); assert.equal(h.state.reads.length, reads)
    const tombstone = h.db.prepare('SELECT * FROM hosting_tenant_deletions WHERE tenant_id=1').get()
    assert.equal(tombstone.lease_token, null); assert.equal(JSON.parse(tombstone.evidence_json)[0].subscription_id, 'sub_fixture')
  }
})

test('provider identity, provenance, missing data and safe error handling fail closed', async t => {
  for (const [modern, mutate, code = 'hosting_deletion_review'] of [
    [true, h => { h.state.account.accountId = 'acct_foreign' }],
    [true, h => { h.state.account.livemode = true }],
    [true, h => { h.state.subs.get('sub_fixture').customer = 'cus_foreign' }],
    [true, h => { h.state.subs.get('sub_fixture').metadata.tenant_id = '2' }],
    [true, h => { h.state.subs.get('sub_fixture').metadata.purpose = 'project_support' }],
    [true, h => { delete h.state.subs.get('sub_fixture').metadata.hosting_intent }],
    [true, h => { h.state.subs.get('sub_fixture').metadata.plan = 'growth' }],
    [false, h => { h.state.subs.get('sub_fixture').items.data[0].price.product.name += ' sponsorship' }],
    [false, h => { h.state.subs.get('sub_fixture').items.data[0].price.unit_amount = 1 }],
    [false, h => { h.state.subs.get('sub_fixture').items.data[0].price.product.metadata.purpose = 'project_support' }],
    [true, h => { h.state.subs.clear() }, 'hosting_deletion_unavailable'],
    [true, h => { h.db.exec("UPDATE tenants SET stripe_customer_id=NULL WHERE id=1") }],
  ]) {
    const h = fixture(t); h.seed('canceled','canceled',modern); mutate(h)
    await assert.rejects(h.manager.remove(1), error => matches(code)(error) && !String(error).includes('PRIVATE_PROVIDER_MARKER'))
    h.preserved()
  }
})

test('every recorded extra subscription remains a liability even after a review was resolved', async t => {
  const h = fixture(t); h.seed()
  const extra = clone(h.state.subs.get('sub_fixture')); extra.id = 'sub_extra'; extra.status = 'active'; delete extra.metadata.hosting_intent
  h.state.subs.set(extra.id, extra)
  h.state.sessions.set('cs_extra', { object: 'checkout.session', id: 'cs_extra', mode: 'subscription', status: 'complete', livemode: false,
    metadata: { tenant_id: '1', plan: 'everything', purpose: 'printshopcrm_hosting' }, customer: 'cus_fixture', subscription: extra.id })
  h.db.prepare(`INSERT INTO hosting_checkout_anomalies(id,tenant_id,account_scope,session_id,subscription_id,code,created_at,updated_at,resolved_at,resolution_evidence)
    VALUES('extra',1,'legacy-platform','cs_extra','sub_extra','existing_subscription',1,1,2,?)`).run(JSON.stringify({kind:'bound_subscription'}))
  await assert.rejects(h.manager.remove(1), matches('hosting_deletion_active')); h.preserved()
  extra.status = 'canceled'
  assert.equal((await h.manager.remove(1)).ok, true)
  const evidence = JSON.parse(h.db.prepare('SELECT evidence_json FROM hosting_tenant_deletions WHERE tenant_id=1').get().evidence_json)
  assert.deepEqual(evidence.map(x => x.subscription_id).sort(), ['sub_extra','sub_fixture'])
})

test('a second handle can write during verification, but changed revisions and parallel deletion cannot pass', async t => {
  const directory = mkdtempSync(join(tmpdir(),'psc-deletion-unit-'))
  const path = join(directory,'control.db'), h = fixture(t,{path}), other = new DatabaseSync(path)
  // after hooks run in registration order: fixture closes its handle first, then this
  // handle closes before Windows is asked to unlink the database and its WAL files.
  t.after(() => { other.close(); rmSync(directory,{recursive:true,force:true}) })
  h.seed(); let release
  h.state.subHook = () => new Promise(resolve => { release = resolve })
  const pending = h.manager.remove(1)
  while (!release) await new Promise(resolve => setImmediate(resolve))
  other.exec("INSERT INTO tenants(id,slug) VALUES(2,'unrelated')")
  const peerCheckouts = createHostingCheckouts(other, { now: () => h.state.clock })
  const peer = createHostingDeletion(other, { checkouts: peerCheckouts, finalize: () => assert.fail('parallel deletion'), now: () => h.state.clock })
  await assert.rejects(peer.remove(1), matches('hosting_deletion_busy'))
  await assert.rejects(peerCheckouts.start({tenantId:1,plan:'everything'}), matches('hosting_deletion_busy'))
  other.exec('UPDATE tenants SET hosting_revision=hosting_revision+1 WHERE id=1')
  release(clone(h.state.subs.get('sub_fixture')))
  await assert.rejects(pending, matches('hosting_deletion_changed')); h.preserved()
})

test('expired/dead leases need fresh verification and provider limits do not grant partial approval', async t => {
  const h = fixture(t); h.seed(); let release
  h.state.subHook = () => new Promise(resolve => { release = resolve })
  const pending = h.manager.remove(1)
  while (!release) await new Promise(resolve => setImmediate(resolve))
  h.state.clock += 121000; release(clone(h.state.subs.get('sub_fixture')))
  await assert.rejects(pending, matches('hosting_deletion_unavailable')); h.preserved()
  h.state.subHook = null
  assert.equal((await h.manager.remove(1)).ok,true)
  const limited = fixture(t,{limits:{maxReads:1}}); limited.seed()
  await assert.rejects(limited.manager.remove(1),matches('hosting_deletion_review')); limited.preserved()
})

test('admitted legacy verification is a durable deletion fence before it discovers a paid subscription', async t => {
  const h = fixture(t)
  const sub = { object:'subscription', id:'sub_legacy', customer:'cus_legacy', status:'active', livemode:false, metadata:{tenant_id:'1',plan:'everything'},
    items:{data:[{quantity:1,price:{currency:'usd',unit_amount:14900,recurring:{interval:'month'},product:{name:'PrintShopCRM Everything'}}}]} }
  let release
  const process = createPlatformSubscriptionEventProcessor({
    getTenantById: id => h.db.prepare('SELECT * FROM tenants WHERE id=?').get(id), getTenantByStripeCustomer: id => h.db.prepare('SELECT * FROM tenants WHERE stripe_customer_id=?').get(id),
    retrieveSubscription: async () => new Promise(resolve => { release = resolve }), hostingCheckouts:h.checkouts,
    setSubscription: (id,patch) => h.db.prepare('UPDATE tenants SET stripe_customer_id=?,stripe_subscription_id=?,hosting_revision=hosting_revision+1 WHERE id=?').run(patch.customerId,patch.subscriptionId,id),
  })
  const pending = process({type:'checkout.session.completed',data:{object:{id:'cs_legacy',mode:'subscription',status:'complete',customer:'cus_legacy',subscription:'sub_legacy',metadata:{tenant_id:'1',plan:'everything'}}}})
  while (!release) await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM hosting_billing_operations').get().n,1)
  await assert.rejects(h.manager.remove(1),matches('hosting_deletion_busy')); h.preserved()
  assert.throws(() => h.final(1),matches('hosting_deletion_busy'))
  release(sub); assert.equal((await pending).handled,true)
  assert.equal(h.db.prepare('SELECT stripe_subscription_id FROM tenants WHERE id=1').get().stripe_subscription_id,'sub_legacy')
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM hosting_billing_operations').get().n,0)
})

test('failed legacy admission survives lease cleanup and exposes read-only operator recovery', async t => {
  const h=fixture(t), sub={object:'subscription',id:'sub_extra',customer:'cus_extra',status:'active',livemode:false,metadata:{tenant_id:'1',plan:'everything'},
    items:{data:[{quantity:1,price:{currency:'usd',unit_amount:14900,recurring:{interval:'month'},product:{name:'PrintShopCRM Everything'}}}]}}
  const session={object:'checkout.session',id:'cs_extra',mode:'subscription',status:'complete',livemode:false,customer:sub.customer,subscription:sub.id,metadata:clone(sub.metadata)}
  h.state.subs.set(sub.id,sub);h.state.sessions.set(session.id,session)
  let fail=true
  const process=createPlatformSubscriptionEventProcessor({
    getTenantById:id=>h.db.prepare('SELECT * FROM tenants WHERE id=?').get(id),getTenantByStripeCustomer:id=>h.db.prepare('SELECT * FROM tenants WHERE stripe_customer_id=?').get(id),
    retrieveSubscription:async()=>{if(fail)throw Error('PRIVATE_PROVIDER_MARKER');return clone(sub)},hostingCheckouts:h.checkouts,
    setSubscription:(id,patch)=>h.db.prepare('UPDATE tenants SET stripe_customer_id=?,stripe_subscription_id=?,hosting_revision=hosting_revision+1 WHERE id=?').run(patch.customerId,patch.subscriptionId,id),
  })
  await assert.rejects(process({type:'checkout.session.completed',data:{object:session}}),error=>error.status===503)
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM hosting_billing_operations').get().n,0)
  const pending=h.checkouts.status(1).pending_verifications;assert.equal(pending.length,1)
  assert.throws(()=>h.final(1),matches('hosting_deletion_verification_required'))
  await assert.rejects(h.checkouts.start({tenantId:1,plan:'everything'}),matches('hosting_checkout_review_required'))
  await assert.rejects(h.manager.remove(1),matches('hosting_deletion_active'));h.preserved()
  fail=false
  assert.equal((await h.checkouts.reconcileVerification({tenantId:1,verificationId:pending[0].id},process)).pending_verifications.length,0)
  assert.equal(h.db.prepare('SELECT stripe_subscription_id FROM tenants WHERE id=1').get().stripe_subscription_id,'sub_extra')
  const reads=h.state.reads.length
  await h.checkouts.reconcileVerification({tenantId:1,verificationId:pending[0].id},()=>assert.fail('cleared receipt replay'))
  assert.equal(h.state.reads.length,reads)
})

test('failed unknown paid session is verified as an extra liability even when the current binding ended', async t=>{
  const h=fixture(t);h.seed('canceled','canceled')
  const intent=crypto.randomUUID(),session={object:'checkout.session',id:'cs_unknown',mode:'subscription',status:'complete',livemode:false,customer:'cus_fixture',subscription:'sub_unknown',
    metadata:{tenant_id:'1',plan:'everything',purpose:'printshopcrm_hosting',hosting_intent:intent}}
  await assert.rejects(h.checkouts.processCheckoutEvent({type:'checkout.session.completed',data:{object:session}}),error=>error.status===503)
  assert.equal(h.checkouts.status(1).pending_verifications.length,1)
  h.state.sessions.set(session.id,session)
  const sub=clone(h.state.subs.get('sub_fixture'));sub.id=session.subscription;sub.metadata=clone(session.metadata);sub.status='active';h.state.subs.set(sub.id,sub)
  await assert.rejects(h.manager.remove(1),matches('hosting_deletion_active'));h.preserved()
  sub.status='canceled';assert.equal((await h.manager.remove(1)).ok,true)
  assert.equal(h.db.prepare("SELECT count(*) AS n FROM hosting_billing_verifications WHERE state='pending'").get().n,0)
})

test('unbound historical payments and expired-only reviews recover through exact recorded sessions',async t=>{
  for(const expired of [false,true]){
    const h=fixture(t),session={object:'checkout.session',id:'cs_history',mode:'subscription',status:expired?'expired':'complete',livemode:false,customer:expired?null:'cus_history',subscription:expired?null:'sub_history',metadata:{tenant_id:'1',plan:'everything'}}
    const product={data:[{quantity:1,price:{currency:'usd',unit_amount:14900,recurring:{interval:'month'},product:{name:'PrintShopCRM Everything'}}}]}
    session.line_items=clone(product);h.state.sessions.set(session.id,session)
    if(!expired)h.state.subs.set('sub_history',{object:'subscription',id:'sub_history',customer:'cus_history',status:'canceled',livemode:false,metadata:clone(session.metadata),items:clone(product)})
    h.db.prepare("INSERT INTO hosting_checkout_anomalies(id,tenant_id,account_scope,session_id,subscription_id,code,created_at,updated_at,resolved_at) VALUES('old',1,'legacy-platform','cs_history',?,'existing_subscription',1,1,2)").run(session.subscription)
    assert.equal((await h.manager.remove(1)).ok,true)
    const evidence=JSON.parse(h.db.prepare('SELECT evidence_json FROM hosting_tenant_deletions WHERE tenant_id=1').get().evidence_json)
    assert.equal(evidence[0].status,expired?'expired':'canceled')
  }
})

test('modern pending recovery can delegate with a single logical work slot',async t=>{
  const h=fixture(t), limited=createHostingCheckouts(h.db,{createClient:h.createClient,now:()=>h.state.clock,limits:{maxConcurrent:1}})
  const session={object:'checkout.session',id:'cs_single',mode:'subscription',status:'complete',livemode:false,customer:'cus_single',subscription:'sub_single',
    metadata:{tenant_id:'1',plan:'everything',purpose:'printshopcrm_hosting',hosting_intent:crypto.randomUUID()}}
  await assert.rejects(limited.processCheckoutEvent({type:'checkout.session.completed',data:{object:session}}),error=>error.status===503)
  h.state.sessions.set(session.id,session);h.state.subs.set('sub_single',{object:'subscription',id:'sub_single',customer:'cus_single',status:'active',livemode:false,metadata:clone(session.metadata)})
  const result=await limited.reconcileVerification({tenantId:1,verificationId:limited.status(1).pending_verifications[0].id},event=>limited.processCheckoutEvent(event))
  assert.equal(result.pending_verifications.length,0);assert.equal(result.anomalies.length,1)
})

test('a malformed successful provider response cannot clear a received paid-session liability',async t=>{
  const h=fixture(t), session={object:'checkout.session',id:'cs_malformed',mode:'subscription',status:'complete',livemode:false,customer:'cus_fixture',subscription:'sub_extra',
    metadata:{tenant_id:'1',plan:'everything',purpose:'printshopcrm_hosting',hosting_intent:crypto.randomUUID()}}
  h.state.sessions.set(session.id,{})
  await assert.rejects(h.checkouts.processCheckoutEvent({type:'checkout.session.completed',data:{object:session}}),error=>error.status===503)
  assert.equal(h.checkouts.status(1).pending_verifications.length,1)
  assert.throws(()=>h.final(1),matches('hosting_deletion_verification_required'))
  await assert.rejects(h.manager.remove(1),matches('hosting_deletion_review'));h.preserved()
})

test('actual tenant module preserves billed data and verifies terminal hosting before deleting and retrying', () => {
  const directory = mkdtempSync(join(tmpdir(),'psc-deletion-real-'))
  try {
    const script = `
      import assert from 'node:assert/strict'; import {existsSync} from 'node:fs'; import {join} from 'node:path'; import {DatabaseSync} from 'node:sqlite';
      const started=Date.now(), phase=label=>console.log('deletion-fixture '+label+' '+(Date.now()-started)+'ms');
      phase('started');
      let actual='active', calls=0;
      globalThis.fetch=async url=>{calls++; const path=new URL(url).pathname; assert.ok(path==='/v1/account'||path==='/v1/subscriptions/sub_fixture');
        const body=path==='/v1/account'?{id:'acct_fixture',object:'account'}:{id:'sub_fixture',object:'subscription',customer:'cus_fixture',status:actual,livemode:false,metadata:{tenant_id:'1',plan:'everything'},items:{data:[{quantity:1,price:{currency:'usd',unit_amount:14900,recurring:{interval:'month'},product:{name:'PrintShopCRM Everything'}}}]}};
        return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});};
      phase('importing-tenants');const t=await import('./lib/tenants.mjs');phase('tenants-imported'); const billing=await import('./lib/billing.mjs');billing.setPlatformCredentials({secret:'sk_test_fake_only'});
      const shop=await t.createTenant({shop_name:'Synthetic delete',owner_email:'delete@example.test',password:'fixture-password-123'});
      phase('billed-shop-created');t.setSubscription(shop.id,{plan:'everything',status:'canceled',customerId:'cus_fixture',subscriptionId:'sub_fixture'});
      const token=t.createSession(shop.id), path=join(${JSON.stringify(directory)},'tenants',shop.slug,'printshop.db');assert.ok(existsSync(path));
      assert.throws(()=>t.deleteTenantFully(shop.id),e=>e.code==='hosting_deletion_verification_required');
      await assert.rejects(t.deleteTenantWithHostingCheck(shop.id),e=>e.code==='hosting_deletion_active');assert.ok(existsSync(path));assert.ok(t.getSession(token));assert.ok(t.getTenantById(shop.id));
      phase('active-deletion-refused');actual='canceled';const result=await t.deleteTenantWithHostingCheck(shop.id);assert.equal(result.dataRemoved,true);assert.equal(existsSync(path),false);assert.equal(t.getTenantById(shop.id),undefined);
      phase('terminal-deletion-complete');const before=calls;assert.deepEqual(await t.deleteTenantWithHostingCheck(shop.id),result);assert.equal(calls,before);
      phase('retry-verified');const other=await t.createTenant({shop_name:'Never billed',owner_email:'unbilled@example.test',password:'fixture-password-123'});assert.equal(t.deleteTenantFully(other.id).dataRemoved,true);assert.equal(calls,before);phase('all-assertions-complete');
    `
    const child = spawnSync(process.execPath,['--no-warnings','--input-type=module','-e',script],{cwd:new URL('..',import.meta.url),env:{...process.env,PSC_DB:join(directory,'printshop.db'),PSC_CONTROL_DB:join(directory,'control.db'),PSC_AUTH:'1',PSC_DEMO:'1'},encoding:'utf8',timeout:30000})
    assert.equal(child.status,0,`Subprocess status=${child.status} signal=${child.signal} error=${child.error?.code || 'none'}\n${child.stderr}\n${child.stdout}`)
  } finally { rmSync(directory,{recursive:true,force:true}) }
})
