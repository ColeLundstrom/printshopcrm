import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawn,spawnSync} from 'node:child_process'
import {createServer} from 'node:net'
import {DatabaseSync} from 'node:sqlite'
test('scoped agent API keeps cookie/shop boundaries, gates production and logs individual requests',{timeout:120000},async()=>{
  const tmp=mkdtempSync(join(tmpdir(),'psc-agent-http-')),dest=join(tmp,'demo'),probe=createServer()
  await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r))
  let child,db,control
  try{
    const built=spawnSync(process.execPath,['bin/demo.mjs',dest,String(port)],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:90000});assert.equal(built.status,0,built.stderr)
    const env=JSON.parse(readFileSync(join(dest,'demo-env.json'),'utf8'))
    let log='';child=spawn(process.execPath,['--no-warnings','--import','./bin/demo-network-guard.mjs','server.mjs'],{cwd:dest,env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x)
    for(let i=0;i<600&&child.exitCode===null&&!log.includes('(ws /ws live');i++)await new Promise(r=>setTimeout(r,50));assert.match(log,/ws \/ws live/)
    const base=`http://127.0.0.1:${port}`
    const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'dylan@example.test',password:readFileSync(join(dest,'LOGIN.txt'),'utf8').match(/Password: (.+)/)[1]})});assert.equal(login.status,200)
    const cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')
    const request=(path,method='GET',body,token,cookieValue=cookie,extraHeaders={})=>fetch(base+path,{method,headers:{'Content-Type':'application/json',Cookie:cookieValue,...extraHeaders,...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)})
    const create=async(name,scopes)=>{const r=await request('/api/developers/agents','POST',{name,scopes,expires_days:90});assert.equal(r.status,201,await r.clone().text());return r.json()}
    const read=await create('Read agent',['jobs:read']),production=await create('Production agent',['production:read','production:write']),quote=await create('Quote agent',['estimates:write'])
    const pricing=await create('Pricing reader',['pricing:read'])
    const pricingResponse=await request('/api/v1/pricing','GET',undefined,pricing.token);assert.equal(pricingResponse.status,200);const priceData=await pricingResponse.json();assert.ok(priceData.price_book.services['DTF Transfer']);assert.ok(!JSON.stringify(priceData).includes('api_key'))
    assert.equal((await request('/api/v1/pricing','GET',undefined,read.token)).status,403)
    const matrix=await request('/api/matrices','POST',{template:'dtf'});assert.equal(matrix.status,200);const matrixId=(await matrix.json()).matrix.id
    assert.equal((await request('/api/v1/matrices/'+matrixId,'GET',undefined,pricing.token)).status,200)
    const priceLookup=await request('/api/v1/matrices/'+matrixId+'/price?row=0&col=0&qty=24','GET',undefined,pricing.token);assert.equal(priceLookup.status,200);assert.equal(typeof (await priceLookup.json()).price,'number')
    assert.equal((await request('/api/v1/matrices/'+matrixId+'/price?qty=Infinity','GET',undefined,pricing.token)).status,400)
    const info=await request('/api/v1/me','GET',undefined,read.token);assert.equal(info.status,200);assert.deepEqual((await info.json()).agent.scopes,['jobs:read'])
    assert.equal((await request('/api/v1/jobs','GET',undefined,read.token)).status,200)
    assert.equal((await request('/api/v1/customers','GET',undefined,read.token)).status,403)
    assert.equal((await request('/api/v1/webhooks','GET',undefined,read.token)).status,403)
    assert.equal((await request('/api/settings','PUT',{shop_name:'Forbidden'},read.token)).status,403)
    assert.equal((await request('/api/v1/jobs/1/stage','POST',{stage:'complete'},read.token)).status,403)
    assert.equal((await request('/api/v1/estimates','POST',{customer:{name:'Forbidden contact'},items:[]},quote.token)).status,403)
    const slug=readdirSync(join(dest,'data/tenants'))[0];db=new DatabaseSync(join(dest,'data/tenants',slug,'printshop.db'));control=new DatabaseSync(join(dest,'data/control.db'));db.exec('PRAGMA busy_timeout=5000');control.exec('PRAGMA busy_timeout=5000')
    assert.equal(db.prepare("SELECT count(*) n FROM contacts WHERE name='Forbidden contact'").get().n,0)
    const templateResponse=await request('/api/production/templates','POST',{name:'Agent gate fixture',steps:[{title:'QC inspection',department:'QC',stage:'qc'}]})
    assert.equal(templateResponse.status,200,await templateResponse.clone().text());const template=await templateResponse.json()
    const jobResponse=await request('/api/jobs','POST',{contact_id:1,title:'Agent workflow test'});assert.equal(jobResponse.status,200);const job=await jobResponse.json()
    const applied=await request('/api/production/jobs/'+job.id+'/workflow','POST',{revision:0,template_ids:[template.id]})
    assert.equal(applied.status,200,await applied.clone().text())
    let workflowResponse=await request(`/api/v1/jobs/${job.id}/workflow`,'GET',undefined,production.token);assert.equal(workflowResponse.status,200);let w=await workflowResponse.json()
    assert.equal((await request('/api/v1/production/queue?department=QC','GET',undefined,production.token)).status,200)
    assert.equal((await request(`/api/v1/jobs/${job.id}/tasks/${w.tasks[0].id}/action`,'POST',{revision:w.revision,action:'complete'},read.token)).status,403)
    let action=await request(`/api/v1/jobs/${job.id}/tasks/${w.tasks[0].id}/action`,'POST',{revision:w.revision,action:'complete'},production.token)
    assert.equal(action.status,409);assert.match((await action.json()).error,/Artwork approval required/)
    db.prepare('UPDATE jobs SET art_approved_at=? WHERE id=?').run(new Date().toISOString(),job.id)
    action=await request(`/api/v1/jobs/${job.id}/tasks/${w.tasks[0].id}/action`,'POST',{revision:w.revision,action:'complete'},production.token);assert.equal(action.status,200,await action.clone().text())
    assert.equal((await request(`/api/v1/jobs/${job.id}/tasks/${w.tasks[0].id}/action`,'POST',{revision:w.revision,action:'complete'},production.token)).status,409)
    const neighbor=await request('/api/auth/signup','POST',{shop_name:'Agent neighbor',owner_name:'Neighbor',owner_email:'agent-neighbor@example.test',password:'Agent-neighbor-fixture-1'})
    assert.equal(neighbor.status,200,await neighbor.clone().text());const neighborCookie=neighbor.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')
    assert.equal((await request('/api/developers/agents/'+read.key.id,'DELETE',undefined,undefined,neighborCookie)).status,404)
    const withCookie=await request('/api/v1/jobs','GET',undefined,read.token,neighborCookie);assert.equal(withCookie.status,200);assert.ok((await withCookie.json()).data.some(j=>j.id===job.id))
    assert.equal((await request('/api/v1/jobs','GET',undefined,read.token+'bad',neighborCookie)).status,401)
    assert.equal((await request('/api/v1/private-customer-name-secret','GET',undefined,production.token)).status,403)
    const history=await request('/api/developers/agents/'+production.key.id+'/audit');assert.equal(history.status,200);const audit=(await history.json()).requests
    assert.ok(audit.some(r=>r.method==='POST'&&r.status===200));assert.ok(audit.some(r=>r.status===409));assert.ok(!JSON.stringify(audit).includes(production.token));assert.ok(!JSON.stringify(audit).includes('private-customer-name-secret'))
    const list=await request('/api/developers/agents');const listed=await list.text();assert.ok(!listed.includes(read.token));assert.ok(!listed.includes('token_hash'))
    assert.equal((await request('/api/developers/agents/'+read.key.id,'DELETE')).status,200)
    assert.equal((await request('/api/v1/jobs','GET',undefined,read.token)).status,401)
    assert.equal((await request('/api/v1/me','GET',undefined,production.token)).status,200)
    const writer=await create('Retry writer',['estimates:write','customers:write'])
    const payload={customer:{name:'Idempotent customer'},items:[{description:'Screen printing',quantity:24,unit_price:12}]}
    const retry=(body=payload,key='estimate-retry-fixture')=>request('/api/v1/estimates','POST',body,writer.token,cookie,{'Idempotency-Key':key})
    const created=await retry();assert.equal(created.status,201,await created.clone().text());const draft=await created.json();assert.equal(created.headers.get('idempotency-replayed'),'false')
    const replayed=await retry({items:payload.items,customer:payload.customer});assert.equal(replayed.status,201);assert.equal(replayed.headers.get('idempotency-replayed'),'true');assert.deepEqual(await replayed.json(),draft)
    assert.equal((await retry({...payload,items:[{...payload.items[0],quantity:48}]})).status,409)
    assert.equal(db.prepare("SELECT count(*) n FROM contacts WHERE name='Idempotent customer'").get().n,1)
    assert.equal(db.prepare('SELECT count(*) n FROM opportunities WHERE estimate_id=?').get(draft.id).n,1)
    const rejected=await retry({customer:{name:'Rejected customer'},items:[null]},'invalid-estimate-fixture');assert.equal(rejected.status,400)
    assert.equal(db.prepare("SELECT count(*) n FROM contacts WHERE name='Rejected customer'").get().n,0)
    assert.equal((await request('/api/v1/estimates','POST',{customer:{name:'Rejected no key'},items:[]},writer.token)).status,400)
    assert.equal(db.prepare("SELECT count(*) n FROM contacts WHERE name='Rejected no key'").get().n,0)
    const corrected=await retry({customer:{name:'Corrected customer'},items:payload.items},'invalid-estimate-fixture');assert.equal(corrected.status,201)
    const repeated=await Promise.all(Array.from({length:3},()=>retry({customer:{name:'Concurrent customer'},items:payload.items},'concurrent-estimate-fixture')))
    const ids=await Promise.all(repeated.map(async r=>{assert.equal(r.status,201);return (await r.json()).id}));assert.equal(new Set(ids).size,1)
    assert.equal(db.prepare("SELECT count(*) n FROM contacts WHERE name='Concurrent customer'").get().n,1)
    const beforeRollback={estimates:db.prepare('SELECT count(*) n FROM estimates').get().n,pipeline:db.prepare('SELECT count(*) n FROM opportunities').get().n}
    db.exec("CREATE TRIGGER receipt_failure BEFORE INSERT ON api_create_receipts BEGIN SELECT RAISE(ABORT, 'fixture disk write failure'); END")
    assert.equal((await retry({customer:{name:'Atomic retry customer'},items:payload.items},'atomic-retry-fixture')).status,500)
    assert.equal(db.prepare("SELECT count(*) n FROM contacts WHERE name='Atomic retry customer'").get().n,0)
    assert.equal(db.prepare('SELECT count(*) n FROM estimates').get().n,beforeRollback.estimates)
    assert.equal(db.prepare('SELECT count(*) n FROM opportunities').get().n,beforeRollback.pipeline)
    db.exec('DROP TRIGGER receipt_failure')
    assert.equal((await retry({customer:{name:'Atomic retry customer'},items:payload.items},'atomic-retry-fixture')).status,201)
    const customerBody={name:'Retry contact',email:'retry-contact@example.test'},customerHeaders={'Idempotency-Key':'customer-retry-fixture'}
    const customerA=await request('/api/v1/customers','POST',customerBody,writer.token,cookie,customerHeaders);assert.equal(customerA.status,201);const contactA=await customerA.json()
    const customerB=await request('/api/v1/customers','POST',customerBody,writer.token,cookie,customerHeaders);assert.equal(customerB.status,201);assert.deepEqual(await customerB.json(),contactA)
    assert.equal((await request('/api/developers/agents/'+writer.key.id,'DELETE')).status,200)
    assert.equal((await retry()).status,401)
    control.prepare("UPDATE members SET role='staff' WHERE id=?").run(production.key.member_id)
    assert.equal((await request('/api/v1/me','GET',undefined,production.token)).status,401)
    assert.equal((await request('/api/developers/agents','POST',{name:'Staff key',scopes:['jobs:read'],expires_days:90})).status,403)
  }finally{db?.close();control?.close();if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r))}rmSync(tmp,{recursive:true,force:true})}
})
