import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'

test('replacement proofs revoke old release, obsolete links cannot decide, and decisions commit atomically',{timeout:120000},async()=>{
 const temp=mkdtempSync(join(tmpdir(),'psc-proofs-')),dest=join(temp,'demo'),probe=createServer()
 await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r))
 let child,db
 try {
  const built=spawnSync(process.execPath,['bin/demo.mjs',dest,String(port)],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:90000});assert.equal(built.status,0,built.stderr)
  const env=JSON.parse(readFileSync(join(dest,'demo-env.json'),'utf8'));let log=''
  child=spawn(process.execPath,['--no-warnings','--import','./bin/demo-network-guard.mjs','server.mjs'],{cwd:dest,env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x)
  for(let i=0;i<600&&child.exitCode===null&&!log.includes('(ws /ws live');i++)await new Promise(r=>setTimeout(r,50));assert.match(log,/ws \/ws live/)
  const base=`http://127.0.0.1:${port}`
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'dylan@example.test',password:readFileSync(join(dest,'LOGIN.txt'),'utf8').match(/Password: (.+)/)[1]})});assert.equal(login.status,200)
  const cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')
  const request=(path,body,method='POST')=>fetch(base+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)})
  const json=async(path,body,method='POST')=>{const r=await request(path,body,method);assert.equal(r.status,200,await r.clone().text());return r.json()}
  const upload=async(path,name)=>{const f=new FormData();f.append('file',new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="navy"/></svg>'],{type:'image/svg+xml'}),name);const r=await fetch(base+path,{method:'POST',headers:{Cookie:cookie},body:f});assert.equal(r.status,200,await r.clone().text());return r.json()}
  const job=await json('/api/jobs',{contact_id:1,title:'Proof version safety',approval_gated:true})
  const art=()=>json('/api/jobs/'+job.id,undefined,'GET'),pkg=()=>json('/api/jobs/'+job.id+'/print-package',undefined,'GET')
  const first=await upload('/api/jobs/'+job.id+'/art','first.svg')
  const firstLink=(await art()).art.find(a=>a.id===first.id).share_url
  await json('/api/art/'+first.id+'/decide',{decision:'approved',by:'Fixture customer'})
  assert.equal((await pkg()).appearance_approved,true)
  const second=await upload('/api/jobs/'+job.id+'/art','second.svg')
  assert.equal((await art()).art_approved_at,null);assert.equal((await pkg()).ready,false);assert.equal((await pkg()).approved_art,null)
  const oldPage=await fetch(base+firstLink);const html=await oldPage.text();assert.match(html,/replaced by a newer version/);assert.ok(!html.includes('Approve proof</button>'))
  const oldDecision=await fetch(base+firstLink.replace('?', '/decide?'),{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'decision=approved'});assert.equal(oldDecision.status,409)
  assert.equal((await request('/api/art/'+first.id+'/send',{})).status,409)
  const artQueue=await json('/api/art',undefined,'GET');assert.ok(!artQueue.some(a=>a.id===first.id));assert.ok(artQueue.some(a=>a.id===second.id))
  assert.equal((await art()).art.length,2,'history remains on the job')
  assert.equal((await request('/api/art/'+second.id+'/decide',{decision:'typo'})).status,400)
  await json('/api/art/'+second.id+'/decide',{decision:'approved'})
  await json('/api/jobs/'+job.id+'/art/'+first.id,undefined,'DELETE');assert.equal((await pkg()).appearance_approved,true)
  const third=await upload('/api/jobs/'+job.id+'/art','third.svg')
  await json('/api/jobs/'+job.id+'/art/'+third.id,undefined,'DELETE');assert.equal((await pkg()).ready,false,'deletion must not reactivate an older approval')
  const fourth=await upload('/api/jobs/'+job.id+'/art','fourth.svg'),fifth=await upload('/api/jobs/'+job.id+'/art','fifth.svg')
  const obsolete=await request('/api/art/'+fourth.id+'/decide',{decision:'approved'});assert.equal(obsolete.status,409);assert.equal((await obsolete.json()).code,'proof_superseded')
  const slug=readdirSync(join(dest,'data/tenants'))[0];db=new DatabaseSync(join(dest,'data/tenants',slug,'printshop.db'));db.exec('PRAGMA busy_timeout=5000')
  db.prepare("UPDATE jobs SET art_approved_at='2026-01-01 12:00:00' WHERE id=?").run(job.id)
  const template=await json('/api/production/templates',{name:'Proof QC',steps:[{title:'Quality check',department:'Proof QC',stage:'qc'}]})
  const workflow=await json('/api/production/jobs/'+job.id+'/workflow',{revision:0,template_ids:[template.id]})
  const done=await request('/api/production/jobs/'+job.id+'/tasks/'+workflow.tasks[0].id+'/action',{revision:workflow.revision,action:'complete'});assert.equal(done.status,409);assert.match((await done.json()).error,/Artwork approval required/)
  assert.equal((await pkg()).ready,false,'legacy stale approval stamp does not select obsolete art')
  db.exec("CREATE TRIGGER fail_proof_release BEFORE UPDATE ON jobs WHEN NEW.id="+job.id+" BEGIN SELECT RAISE(ABORT, 'fixture release failure'); END")
  assert.equal((await request('/api/art/'+fifth.id+'/decide',{decision:'approved'})).status,500)
  assert.equal(db.prepare('SELECT status FROM art_versions WHERE id=?').get(fifth.id).status,'draft')
  db.exec('DROP TRIGGER fail_proof_release')
  await json('/api/art/'+fifth.id+'/decide',{decision:'approved'})
  assert.equal((await pkg()).appearance_approved,true)
  const staleTask=await request('/api/production/jobs/'+job.id+'/tasks/'+workflow.tasks[0].id+'/action',{revision:workflow.revision,action:'complete'});assert.equal(staleTask.status,409);assert.match((await staleTask.json()).error,/changed/);
  const refreshed=await json('/api/v1/jobs/'+job.id+'/workflow',undefined,'GET');assert.ok(refreshed.revision>workflow.revision)
  await json('/api/production/jobs/'+job.id+'/tasks/'+workflow.tasks[0].id+'/action',{revision:refreshed.revision,action:'complete'})
  const mock1=await upload('/api/estimates/1/mockups','mock1.svg'),mock2=await upload('/api/estimates/1/mockups','mock2.svg')
  assert.equal((await request('/api/art/'+mock1.id+'/decide',{decision:'approved'})).status,409)
  assert.equal((await request('/api/mockups/'+mock1.id+'/send',{})).status,409)
  await json('/api/art/'+mock2.id+'/decide',{decision:'approved'})
 } finally {db?.close();if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r))}rmSync(temp,{recursive:true,force:true})}
})
