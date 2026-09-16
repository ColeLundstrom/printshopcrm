import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {DatabaseSync} from 'node:sqlite'
import {createHttpTestServer} from './helpers/http-test-server.mjs'
test('CRM HTTP permissions, stale edits, held sends, imports, export and restart preserve existing login',{timeout:120000},async()=>{
  const tmp=mkdtempSync(join(tmpdir(),'psc-shop-crm-')),dest=join(tmp,'demo'),server=await createHttpTestServer()
  let db,control
  try {
    const built=spawnSync(process.execPath,['bin/demo.mjs',dest,String(server.port)],{encoding:'utf8',timeout:90000});assert.equal(built.status,0,built.stderr)
    const env=JSON.parse(readFileSync(join(dest,'demo-env.json'),'utf8'))
    const options={cwd:dest,env,args:['--no-warnings','--import','./bin/demo-network-guard.mjs','server.mjs']}
    await server.start(options)
    const password=readFileSync(join(dest,'LOGIN.txt'),'utf8').match(/Password: (.+)/)[1]
    const login=async email=>{const r=await fetch(server.base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});assert.equal(r.status,200,await r.clone().text());return r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')}
    const owner=await login('dylan@example.test')
    const request=(path,method='GET',body,cookie=owner)=>fetch(server.base+path,{method,headers:{'Content-Type':'application/json',Cookie:cookie},body:body===undefined?undefined:JSON.stringify(body)})
    const slug=readdirSync(join(dest,'data/tenants'))[0]
    db=new DatabaseSync(join(dest,'data/tenants',slug,'printshop.db'));control=new DatabaseSync(join(dest,'data/control.db'))
    db.exec('PRAGMA busy_timeout=5000');control.exec('PRAGMA busy_timeout=5000')
    control.prepare("INSERT INTO members(tenant_id,email,password_hash,name,role,status) SELECT tenant_id,'crm-worker@example.test',password_hash,'CRM Worker','staff','active' FROM members WHERE email='dylan@example.test'").run()
    const worker=await login('crm-worker@example.test'),workerId=control.prepare("SELECT id FROM members WHERE email='crm-worker@example.test'").get().id
    const baseline={invoices:db.prepare('SELECT * FROM invoices ORDER BY id').all(),payments:db.prepare('SELECT * FROM payments ORDER BY id').all(),jobs:db.prepare('SELECT * FROM jobs ORDER BY id').all()}
    for(const path of ['/api/crm/tasks','/api/crm/holds'])assert.equal((await request(path,'GET',undefined,'')).status,401)
    assert.equal((await request('/api/crm/holds','GET',undefined,worker)).status,403)
    assert.equal((await request('/api/crm/import/preview','POST',{},worker)).status,403)
    const task=await request('/api/crm/tasks','POST',{title:'Review screen print quote',assigned_id:workerId,due_date:'2026-10-01'})
    assert.equal(task.status,201);let t=await task.json()
    assert.equal((await (await request('/api/crm/tasks','GET',undefined,worker)).json()).total,1)
    assert.equal((await request('/api/crm/tasks/'+t.id,'PUT',{...t,status:'done'},worker)).status,200)
    assert.equal((await request('/api/crm/tasks/'+t.id,'PUT',{...t,status:'cancelled'})).status,409)
    assert.equal((await request('/api/crm/tasks/0','PUT',{title:'Bad route'})).status,400)
    const bundle={version:1,provider:'ghl',locationId:'fictional-shop',contacts:[{id:'c-1',name:'Migration customer',email:'migration@example.test',phone:'+17145550123',dnd:true}],opportunities:[{id:'o-1',contactId:'c-1',name:'Shirts',monetaryValue:480,status:'open',pipelineStageId:'new'}],stageMap:{new:'lead'}}
    const preview=await request('/api/crm/import/preview','POST',{bundle});assert.equal(preview.status,200);const p=await preview.json()
    const saved=await request('/api/crm/import/commit','POST',{bundle,token:p.token});assert.equal(saved.status,200,await saved.clone().text())
    assert.equal((await (await request('/api/crm/import/commit','POST',{bundle,token:p.token})).json()).replayed,true)
    const contactId=db.prepare("SELECT id FROM contacts WHERE email='migration@example.test'").get().id
    for(const channel of ['email','sms'])assert.equal((await request('/api/conversations/'+contactId+'/reply','POST',{channel,body:'This must remain blocked.'})).status,409)
    const outboxId=Number(db.prepare("INSERT INTO email_log(contact_id,to_email,subject,body,kind,via) VALUES(?,?,'Draft','Do not send','reply','draft')").run(contactId,'migration@example.test').lastInsertRowid)
    assert.equal((await request('/api/outbox/'+outboxId+'/send','POST',{})).status,409)
    assert.equal(db.prepare('SELECT delivered FROM email_log WHERE id=?').get(outboxId).delivered,0)
    const holds=(await (await request('/api/crm/holds')).json()).holds
    const h=holds.find(h=>h.contact_id===contactId && h.channel==='email')
    assert.equal((await request('/api/crm/holds/'+contactId+'/email/release','POST',{revision:h.revision,reason:'Approved fixture'},worker)).status,403)
    assert.equal((await request('/api/crm/holds/'+contactId+'/email/release','POST',{revision:h.revision,reason:'Customer requested quote'})).status,200)
    assert.equal((await request('/api/conversations/'+contactId+'/reply','POST',{channel:'sms',body:'Still blocked'})).status,409)
    const exp=await (await request('/api/export/all.json')).json();assert.ok(exp.tables.crm_tasks);assert.ok(exp.tables.crm_import_refs);assert.ok(exp.tables.crm_contact_holds)
    for(const table of Object.keys(baseline))assert.deepEqual(db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),baseline[table],table+' unchanged')
    await server.stop();await server.start(options)
    assert.equal((await request('/api/crm/tasks')).status,200,'existing owner session survives')
    assert.equal((await request('/api/crm/tasks','GET',undefined,worker)).status,200,'existing employee session survives')
    assert.equal((await request('/api/crm/holds')).status,200)
  } finally {await server.close();db?.close();control?.close();rmSync(tmp,{recursive:true,force:true})}
})
