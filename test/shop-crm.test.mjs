import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
process.env.PSC_DB=':memory:'
const { initDb, tenantStore }=await import('../lib/db.mjs')
const {previewCrmImport,commitCrmImport}=await import('../lib/crm-import.mjs')
const {saveTask,taskList,communicationHold,releaseHold,setHold}=await import('../lib/shop-crm.mjs')
const db=()=>initDb(new DatabaseSync(':memory:'))
const manager={id:1,name:'Manager',manager:true}, staff={id:2,name:'Staff',manager:false}, other={id:3,name:'Other',manager:false}
const team=[1,2,3].map(id=>({id,name:'Member '+id,status:'active'}))
const bundle=()=>({version:1,provider:'ghl',locationId:'example-shop',contacts:[{id:'contact-1',name:'Example customer',email:'customer@example.test',dnd:true}],opportunities:[{id:'deal-1',contactId:'contact-1',name:'120 embroidered polos',status:'open',pipelineStageId:'quote',monetaryValue:1440}],tasks:[{id:'task-1',contactId:'contact-1',title:'Confirm thread colors',dueDate:'2026-10-01',completed:false}],stageMap:{quote:'quoted'}})
const withDb=fn=>{const d=db();try{return tenantStore.run({db:d},()=>fn(d))}finally{d.close()}}

test('migration preview is read-only; import is atomic, silent, held, retry-safe and preserves local edits',()=>withDb(d=>{
  const b=bundle(),p=previewCrmImport(b)
  assert.equal(d.prepare('SELECT count(*) n FROM contacts').get().n,0)
  const result=commitCrmImport(b,p.token,'Manager')
  assert.equal(result.contacts,1);assert.equal(result.tasks,1);assert.equal(result.opportunities,1)
  assert.match(communicationHold(1,'sms').reason,/do-not-contact/)
  for(const table of ['messages','email_log','invoices','payments','jobs'])assert.equal(d.prepare(`SELECT count(*) n FROM ${table}`).get().n,0)
  assert.equal(commitCrmImport(b,p.token,'Manager').replayed,true)
  d.prepare("UPDATE contacts SET name='Local correction' WHERE id=1").run()
  const again=previewCrmImport(b);assert.equal(again.summary.skipped,3)
  commitCrmImport(b,again.token,'Manager')
  assert.equal(d.prepare('SELECT name FROM contacts WHERE id=1').get().name,'Local correction')
  assert.equal(d.prepare('SELECT count(*) n FROM crm_tasks').get().n,1)
  b.contacts[0].name='Source changed';assert.throws(()=>previewCrmImport(b),/Reconcile/)
}))
test('migration rolls back contacts and holds when a later task insert fails',()=>withDb(d=>{
  d.exec("CREATE TRIGGER reject_task BEFORE INSERT ON crm_tasks BEGIN SELECT RAISE(ABORT,'disk fixture'); END")
  const b=bundle(),p=previewCrmImport(b)
  assert.throws(()=>commitCrmImport(b,p.token,'Manager'),/disk fixture/)
  for(const table of ['contacts','opportunities','crm_tasks','crm_contact_holds','crm_history','crm_import_refs','crm_import_receipts'])assert.equal(d.prepare(`SELECT count(*) n FROM ${table}`).get().n,0,table)
}))
test('stale previews, duplicates, missing links and invalid money/status/date fail before writes',()=>withDb(d=>{
  const b=bundle(),p=previewCrmImport(b)
  d.prepare('INSERT INTO contacts(name,email) VALUES(?,?)').run('Existing','customer@example.test')
  assert.throws(()=>commitCrmImport(b,p.token,'Manager'),/existing email/)
  b.contactMap={'contact-1':1};const linked=previewCrmImport(b);assert.equal(linked.summary.linked,1)
  commitCrmImport(b,linked.token,'Manager');assert.equal(d.prepare('SELECT name FROM contacts WHERE id=1').get().name,'Existing')
  const cases=[b=>b.opportunities[0].monetaryValue=-2,b=>b.opportunities[0].status='mystery',b=>b.stageMap={},b=>b.tasks[0].dueDate='2026-02-30',b=>b.tasks[0].contactId='missing',b=>b.contacts.push({...b.contacts[0]}),b=>b.contacts[0].email='x@example.test,y@example.test']
  for(const alter of cases){const copy=bundle();alter(copy);assert.throws(()=>previewCrmImport(copy))}
  assert.throws(()=>previewCrmImport({...bundle(),contacts:Array.from({length:251},(_,i)=>({id:String(i),name:'Name'}))}),/250/)
}))
test('new imports cannot see another shop and migrations preserve old records across repeated init',()=>{
  const a=db(),b=db()
  try{
    tenantStore.run({db:a},()=>{const x=bundle();commitCrmImport(x,previewCrmImport(x).token,'A')})
    tenantStore.run({db:b},()=>{assert.equal(communicationHold(1,'email'),undefined);assert.equal(taskList({actor:manager}).total,0);const x=bundle();assert.equal(previewCrmImport(x).summary.contacts,1)})
    const before=JSON.stringify(a.prepare('SELECT * FROM contacts').all());initDb(a);assert.equal(JSON.stringify(a.prepare('SELECT * FROM contacts').all()),before)
  }finally{a.close();b.close()}
})
test('tasks enforce staff ownership, valid members, contact boundaries and optimistic revisions',()=>withDb(d=>{
  let t=saveTask(null,{title:'Call buyer',assigned_id:2,due_date:'2026-10-01'},manager,team)
  assert.equal(taskList({actor:staff}).total,1);assert.equal(taskList({actor:other}).total,0)
  assert.throws(()=>saveTask(t.id,{...t,title:'Intrusion'},other,team),/assigned employee/)
  assert.throws(()=>saveTask(null,{title:'Other worker',assigned_id:3},staff,team),/manager/)
  t=saveTask(t.id,{...t,status:'done'},staff,team);assert.ok(t.completed_at)
  assert.throws(()=>saveTask(t.id,{revision:1,title:'Stale'},manager,team),/changed/)
  t=saveTask(t.id,{...t,status:'open'},manager,team);assert.equal(t.completed_at,null)
  assert.throws(()=>saveTask(null,{title:'No customer',contact_id:99},manager,team),/Customer not found/)
  assert.throws(()=>saveTask(null,{title:'No employee',assigned_id:99},manager,team),/active team/)
  assert.throws(()=>saveTask(null,{title:'Bad date',due_date:'2026-02-29'},manager,team),/valid due date/)
}))
test('releasing one communication channel needs current revision and an audit reason',()=>withDb(d=>{
  const b=bundle();commitCrmImport(b,previewCrmImport(b).token,'Manager')
  assert.throws(()=>releaseHold(1,'email',{revision:1,reason:''},'Manager'),/permission/)
  assert.throws(()=>releaseHold(1,'email',{revision:0,reason:'Fresh permission'},'Manager'),/changed/)
  releaseHold(1,'email',{revision:1,reason:'Customer requested this quote by email'},'Manager')
  assert.equal(communicationHold(1,'email'),undefined);assert.ok(communicationHold(1,'sms'))
  const p=previewCrmImport(b);commitCrmImport(b,p.token,'Manager');assert.equal(communicationHold(1,'email'),undefined)
  setHold(1,'email','New opt-out','Manager')
  assert.throws(()=>releaseHold(1,'email',{revision:1,reason:'Stale release'},'Manager'),/changed/)
  assert.throws(()=>saveTask(0,{title:'Invalid route'},manager,team),/Invalid task/)
  assert.match(d.prepare("SELECT detail FROM crm_history WHERE detail LIKE '%released%' ").get().detail,/Customer requested/)
}))

test('ignored inserts cannot create false receipts or attach deals to a prior customer',()=>withDb(d=>{
  d.exec("INSERT INTO contacts(name,email) VALUES('Existing','existing@example.test'); CREATE TRIGGER ignore_import BEFORE INSERT ON contacts BEGIN SELECT RAISE(IGNORE); END")
  const b=bundle(),p=previewCrmImport(b)
  assert.throws(()=>commitCrmImport(b,p.token,'Manager'),/not saved/)
  assert.equal(d.prepare('SELECT count(*) n FROM crm_import_refs').get().n,0)
  assert.equal(d.prepare('SELECT count(*) n FROM opportunities').get().n,0)
  assert.equal(d.prepare('SELECT count(*) n FROM crm_contact_holds').get().n,0)
}))
test('reviewed identity changes and mixed GHL locations require a fresh review',()=>withDb(d=>{
  d.exec("INSERT INTO contacts(name,email) VALUES('Existing','customer@example.test')")
  const b=bundle();b.contactMap={'contact-1':1};const p=previewCrmImport(b)
  d.exec("UPDATE contacts SET name='Different identity' WHERE id=1")
  assert.throws(()=>commitCrmImport(b,p.token,'Manager'),/preview changed/)
  b.contacts[0].locationId='another-shop';assert.throws(()=>previewCrmImport(b),/different GHL location/)
}))
