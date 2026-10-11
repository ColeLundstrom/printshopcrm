import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHttpTestServer } from './helpers/http-test-server.mjs'

test('duplicate quote reuses one draft after a lost response and keeps the chosen customer isolated', { timeout: 120000 }, async t => {
  const temp=mkdtempSync(join(tmpdir(),'psc-duplicate-')), dest=join(temp,'demo'), server=await createHttpTestServer()
  let db, control
  try {
    const built=spawnSync(process.execPath,['bin/demo.mjs',dest,String(server.port)],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:90000})
    assert.equal(built.status,0,built.stderr)
    const env=JSON.parse(readFileSync(join(dest,'demo-env.json'),'utf8'));env.PSC_TICK_MS='3600000'
    db=new DatabaseSync(join(dest,'data/tenants',readdirSync(join(dest,'data/tenants'))[0],'printshop.db'))
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000')
    control=new DatabaseSync(join(dest,'data/control.db'))
    const owner=control.prepare('SELECT * FROM members LIMIT 1').get()
    const staff=Number(control.prepare("INSERT INTO members(tenant_id,name,email,password_hash,role,status) VALUES(?,'Fixture Staff','duplicate-staff@example.test',?,'staff','active')").run(owner.tenant_id,owner.password_hash).lastInsertRowid)
    const session=control.prepare("INSERT INTO sessions(token,tenant_id,member_id,expires_at) VALUES(?,?,?,datetime('now','+1 hour'))")
    session.run('duplicate-owner',owner.tenant_id,owner.id);session.run('duplicate-staff',owner.tenant_id,staff)
    const other=spawnSync(process.execPath,['--no-warnings','--import','./bin/demo-network-guard.mjs','--input-type=module','-e',`const t=await import('./lib/tenants.mjs');const shop=await t.createTenant({shop_name:'Duplicate Neighbor',owner_email:'duplicate-neighbor@example.test',password:'fixture-password-123'});t.createSession(shop.id,t.firstOwnerId(shop.id));`],{cwd:dest,env,encoding:'utf8',timeout:30000})
    assert.equal(other.status,0,other.stderr)
    const otherSession=control.prepare('SELECT token FROM sessions WHERE tenant_id!=? LIMIT 1').get(owner.tenant_id).token
    const start=()=>server.start({cwd:dest,env,args:['--no-warnings','--import','./bin/demo-network-guard.mjs','server.mjs']})
    await start()
    const req=async(path,body,token='duplicate-owner',method=body===undefined?'GET':'POST',headers={})=>{
      const r=await fetch(server.base+path,{method,headers:{'Content-Type':'application/json',...(token?{cookie:'psc_session='+token}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)})
      return {status:r.status,body:await r.json(),replayed:r.headers.get('Idempotency-Replayed')}
    }
    const create=async(path,body)=>{const r=await req(path,body);assert.equal(r.status,200,JSON.stringify(r.body));return r.body}
    const original=await create('/api/contacts',{name:'Original customer',email:'original@example.test',billing_address:'1 Original Street'})
    const destination=await create('/api/contacts',{name:'Wholesale buyer',email:'wholesale@example.test',tax_exempt:true,billing_address:'2 Buyer Road',shipping_address:'3 Delivery Road',billing_mode:'custom',billing_name:'Fixture AP',billing_email:'ap@example.test',payment_term:'net_30'})
    const source=await create('/api/estimates',{contact_id:original.id,items:[{description:'Reusable fixture tees',detail:'Two color front',decoration:'Screen Print',sizes:{M:12,XL:6,'2XL':2},unit_price:12.5,blank_cost:4.2,taxable:true}],tax_rate:8.25,notes:'Review original-specific note',rush_days:3})
    const path='/api/estimates/'+source.id+'/duplicate'
    const sourceBefore=JSON.stringify(db.prepare('SELECT * FROM estimates WHERE id=?').get(source.id))
    const businessBefore=JSON.stringify(['invoices','jobs','payments','email_log','estimate_approval_history'].map(t=>db.prepare('SELECT * FROM '+t+' ORDER BY id').all()))
    const counts=()=>['estimates','opportunities','activities','api_create_receipts','estimate_copy_identities'].map(t=>db.prepare('SELECT count(*) n FROM '+t).get().n)
    const sourceIdentity=(await req('/api/estimates/'+source.id)).body.source_identity
    assert.match(sourceIdentity,/^[a-f0-9]{32}$/)
    const body={contact_id:destination.id,commercial_revision:source.commercial_revision,source_identity:sourceIdentity,request_id:'duplicate-fixture-retry'}
    const first=await req(path,body);assert.equal(first.status,200,JSON.stringify(first.body))
    assert.deepEqual(Object.keys(first.body).sort(),['estimate_number','id','ok'],'Internal receipt identity is never returned')
    const afterFirst=counts()
    const retry=await req(path,body)
    assert.deepEqual(retry.body,first.body,'An uncertain response retry must return the original new draft')
    assert.equal(first.replayed,'false');assert.equal(retry.replayed,'true');assert.deepEqual(counts(),afterFirst)
    const copy=(await req('/api/estimates/'+first.body.id)).body
    assert.equal(copy.contact_id,destination.id);assert.equal(copy.tax_rate,0);assert.equal(copy.tax,0)
    assert.deepEqual(copy.items,source.items);assert.equal(copy.notes,source.notes);assert.equal(copy.rush_days,3)
    assert.equal(copy.billing_address,'2 Buyer Road');assert.equal(copy.shipping_address,'3 Delivery Road')
    const recipients=JSON.parse(copy.recipient_snapshot)
    assert.equal(recipients.buyer_email,'wholesale@example.test');assert.equal(recipients.billing_email,'ap@example.test')
    assert.equal(copy.customer_payment_term,'net_30');assert.equal(copy.status,'draft');assert.equal(copy.approved_at,null);assert.equal(copy.sent_at,null)
    assert.notEqual(copy.share_url,source.share_url);assert.equal(copy.commercial_revision,0)
    assert.equal(db.prepare('SELECT stage FROM opportunities WHERE estimate_id=?').get(copy.id).stage,'quoted')
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM estimates WHERE id=?').get(source.id)),sourceBefore)
    assert.equal(JSON.stringify(['invoices','jobs','payments','email_log','estimate_approval_history'].map(t=>db.prepare('SELECT * FROM '+t+' ORDER BY id').all())),businessBefore)
    assert.equal((await req(path,{...body,contact_id:original.id})).status,409)
    assert.equal((await req(path,{...body,request_id:'bad'})).status,400)
    assert.equal((await req(path,body,null)).status,401)
    assert.equal((await req(path,body,otherSession)).status,404)
    assert.equal((await req(path,{...body,request_id:'missing-customer',contact_id:99999999})).status,404)
    assert.equal((await req(path,{...body,request_id:'invalid-customer',contact_id:'not-a-customer'})).status,400)
    for (const [index,contact_id] of [true,[],{},-1,0,1.5].entries())
      assert.equal((await req(path,{...body,request_id:'invalid-shape-'+index,contact_id})).status,400)
    assert.deepEqual(counts(),afterFirst)
    const neighborSlug=control.prepare('SELECT slug FROM tenants WHERE id!=?').get(owner.tenant_id).slug
    const neighbor=new DatabaseSync(join(dest,'data/tenants',neighborSlug,'printshop.db'))
    try {
      neighbor.prepare("INSERT INTO contacts(id,name,email) VALUES(?,'Neighbor source','neighbor-source@example.test'),(?,'Neighbor destination','neighbor-destination@example.test')").run(original.id,destination.id)
      neighbor.prepare("INSERT INTO estimates(id,contact_id,estimate_number,items,status) VALUES(?,?,'NEIGHBOR-SOURCE',?,'draft')").run(source.id,original.id,JSON.stringify([{description:'Neighbor-only item',qty:2,unit_price:5}]))
      assert.equal((await req(path,body,otherSession)).status,409,'Another shop cannot match this source identity')
      const neighborIdentity=(await req('/api/estimates/'+source.id,undefined,otherSession)).body.source_identity
      const isolated=await req(path,{...body,source_identity:neighborIdentity},otherSession);assert.equal(isolated.status,200)
      const neighborCopy=(await req('/api/estimates/'+isolated.body.id,undefined,otherSession)).body
      assert.equal(neighborCopy.items[0].description,'Neighbor-only item');assert.equal(JSON.parse(neighborCopy.recipient_snapshot).buyer_email,'neighbor-destination@example.test')
      assert.deepEqual(counts(),afterFirst,'Same source/customer ids and retry key in another shop cannot change this shop')
    } finally {neighbor.close()}
    const headerBody={contact_id:original.id,commercial_revision:source.commercial_revision}
    const headerCopy=await req(path,headerBody,'duplicate-owner','POST',{'Idempotency-Key':'header-copy-fixture'})
    assert.equal(headerCopy.status,200);assert.equal(headerCopy.replayed,'false')
    assert.deepEqual((await req(path,headerBody,'duplicate-owner','POST',{'Idempotency-Key':'header-copy-fixture'})).body,headerCopy.body)
    assert.equal((await req(path,{...headerBody,request_id:'different-fixture'},'duplicate-owner','POST',{'Idempotency-Key':'header-copy-fixture'})).status,400)
    // Receipts resolve before source validation: a later revision cannot turn a retry into a new draft.
    await req('/api/estimates/'+source.id,{notes:'Changed after copying'},'duplicate-owner','PUT')
    assert.deepEqual((await req(path,body)).body,first.body)
    const stale=await req(path,{...body,request_id:'new-stale-copy'})
    assert.equal(stale.status,409);assert.equal(stale.body.code,'estimate_changed')
    const current=(await req('/api/estimates/'+source.id)).body
    const staffCopy=await req(path,{...body,commercial_revision:current.commercial_revision},'duplicate-staff')
    assert.equal(staffCopy.status,200);assert.notEqual(staffCopy.body.id,first.body.id,'Receipt scope includes the signed-in member')
    // Inject failures in every transaction participant. No orphan quote, deal, activity or receipt.
    for(const table of ['activities','opportunities','api_create_receipts','estimate_copy_identities']) {
      const before=counts(), attempt={...body,commercial_revision:current.commercial_revision,request_id:'rollback-'+table}
      db.exec(`CREATE TRIGGER fixture_duplicate_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'fixture duplicate rollback'); END`)
      assert.equal((await req(path,attempt)).status,500,table);assert.deepEqual(counts(),before,table)
      db.exec('DROP TRIGGER fixture_duplicate_failure')
      assert.equal((await req(path,attempt)).status,200,table+' recovers with the same request')
    }
    await server.stop();await start()
    assert.deepEqual((await req(path,body)).body,first.body,'Receipt survives process restart and changed source')
    const validItems=db.prepare('SELECT items FROM estimates WHERE id=?').get(source.id).items
    db.prepare('UPDATE estimates SET items=? WHERE id=?').run(JSON.stringify([{description:'Invalid imported discount',qty:1,unit_price:-100}]),source.id)
    const beforeNegative=counts(),negative=await req(path,{request_id:'negative-copy-fixture'})
    assert.equal(negative.status,400);assert.equal(negative.body.code,'negative_total');assert.deepEqual(counts(),beforeNegative)
    db.prepare('UPDATE estimates SET items=? WHERE id=?').run(validItems,source.id)
    const deleted=await req('/api/estimates/'+first.body.id,undefined,'duplicate-owner','DELETE');assert.equal(deleted.status,200)
    const afterDeletion=counts(),missing=await req(path,body)
    assert.equal(missing.status,409);assert.equal(missing.body.code,'duplicate_draft_missing');assert.deepEqual(counts(),afterDeletion)
    await t.test('deleted highest copy cannot replay into an unrelated replacement with the same id and number',async()=>{
      const retryBody={request_id:'reuse-target-fixture'},created=await req(path,retryBody)
      assert.equal(created.status,200)
      assert.equal((await req('/api/estimates/'+created.body.id,undefined,'duplicate-owner','DELETE')).status,200)
      const replacement=await create('/api/estimates',{contact_id:original.id,items:[{description:'Unrelated replacement',qty:1,unit_price:7}]})
      assert.equal(replacement.id,created.body.id);assert.equal(replacement.estimate_number,created.body.estimate_number)
      const before=counts(),replay=await req(path,retryBody)
      assert.equal(replay.status,409,'A reused id and number do not identify the original created quote')
      assert.equal(replay.body.code,'duplicate_draft_missing');assert.deepEqual(counts(),before)
    })
    await t.test('editing a created copy preserves its retry identity despite approval-link rotation',async()=>{
      const retryBody={request_id:'edited-copy-fixture'},created=await req(path,retryBody)
      assert.equal(created.status,200)
      const before=(await req('/api/estimates/'+created.body.id)).body
      assert.equal((await req('/api/estimates/'+created.body.id,{notes:'Legitimate later edit'},'duplicate-owner','PUT')).status,200)
      const after=(await req('/api/estimates/'+created.body.id)).body
      assert.notEqual(after.share_key,before.share_key)
      const replay=await req(path,retryBody);assert.equal(replay.status,200);assert.deepEqual(replay.body,created.body)
    })
    await t.test('an open source dialog cannot copy a replacement that reused its id and revision',async()=>{
      const latest=await create('/api/estimates',{contact_id:original.id,items:[{description:'Original dialog source',qty:1,unit_price:10}]})
      const viewed=(await req('/api/estimates/'+latest.id)).body
      const retryBody={request_id:'replaced-source-fixture',commercial_revision:viewed.commercial_revision,source_identity:viewed.source_identity || viewed.share_key}
      assert.equal((await req('/api/estimates/'+latest.id,undefined,'duplicate-owner','DELETE')).status,200)
      const replacement=await create('/api/estimates',{contact_id:destination.id,items:[{description:'Replacement must not be copied',qty:1,unit_price:20}]})
      assert.equal(replacement.id,latest.id);assert.equal(replacement.commercial_revision,viewed.commercial_revision)
      const before=counts(),replay=await req('/api/estimates/'+latest.id+'/duplicate',retryBody)
      assert.equal(replay.status,409);assert.equal(replay.body.code,'estimate_changed');assert.deepEqual(counts(),before)
    })
    await t.test('customer cascades remove creation identities and replacements cannot satisfy old receipts',async()=>{
      const temporaryCustomer=await create('/api/contacts',{name:'Cascade-only customer',email:'cascade-duplicate@example.test'})
      const retryBody={contact_id:temporaryCustomer.id,request_id:'cascade-copy-fixture'},created=await req(path,retryBody)
      assert.equal(created.status,200)
      const identity=db.prepare('SELECT identity FROM estimate_copy_identities WHERE estimate_id=?').get(created.body.id).identity
      db.prepare('DELETE FROM contacts WHERE id=?').run(temporaryCustomer.id)
      assert.equal(db.prepare('SELECT * FROM estimate_copy_identities WHERE estimate_id=?').get(created.body.id),undefined)
      const replacement=await create('/api/estimates',{contact_id:original.id,items:[{description:'After cascade replacement',qty:1,unit_price:7}]})
      assert.equal(replacement.id,created.body.id);assert.equal(replacement.estimate_number,created.body.estimate_number)
      assert.notEqual(db.prepare('SELECT identity FROM estimate_copy_identities WHERE estimate_id=?').get(replacement.id).identity,identity)
      const before=counts(),replay=await req(path,retryBody);assert.equal(replay.status,409);assert.deepEqual(counts(),before)
    })
    await t.test('older receipts without immutable identity fail closed and retain the receipt',async()=>{
      const retryBody={request_id:'legacy-copy-receipt'},created=await req(path,retryBody);assert.equal(created.status,200)
      const operation='estimate-duplicate:'+source.id
      const stored=db.prepare("SELECT response_json FROM api_create_receipts WHERE operation=? AND json_extract(response_json,'$.id')=?").get(operation,created.body.id)
      assert.match(JSON.parse(stored.response_json)._created_identity,/^[a-f0-9]{32}$/)
      db.prepare("UPDATE api_create_receipts SET response_json=json_remove(response_json,'$._created_identity') WHERE operation=? AND json_extract(response_json,'$.id')=?").run(operation,created.body.id)
      const before=counts(),replay=await req(path,retryBody);assert.equal(replay.status,409);assert.deepEqual(counts(),before)
      await server.stop();await start()
      assert.equal((await req(path,retryBody)).status,409,'Restart must not bless a legacy receipt using a potentially reused rowid')
    })
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok')
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[])
  } finally {await server.close();db?.close();control?.close();rmSync(temp,{recursive:true,force:true})}
})
