import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {DatabaseSync} from 'node:sqlite'
import {createHttpTestServer} from './helpers/http-test-server.mjs'

test('manual purchasing HTTP requires an explicit reviewed confirmation; retry, restart and legacy reads never fabricate placement',{timeout:120000},async()=>{
  const temp=mkdtempSync(join(tmpdir(),'psc-po-http-')),dest=join(temp,'demo')
  const server=await createHttpTestServer();let db,control
  try {
    const built=spawnSync(process.execPath,['bin/demo.mjs',dest,String(server.port)],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:90000})
    assert.equal(built.status,0,built.stderr)
    const env=JSON.parse(readFileSync(join(dest,'demo-env.json'),'utf8'));env.PSC_TICK_MS='3600000'
    const start=()=>server.start({cwd:dest,env,args:['--no-warnings','--import','./bin/demo-network-guard.mjs','server.mjs']})
    await start()
    const login=await fetch(server.base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'dylan@example.test',password:readFileSync(join(dest,'LOGIN.txt'),'utf8').match(/Password: (.+)/)[1]})})
    assert.equal(login.status,200)
    const owner=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')
    const request=async(path,body,method='POST',cookie=owner)=>{
      const r=await fetch(server.base+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})})
      return {status:r.status,json:await r.json()}
    }
    const ok=async(...args)=>{const r=await request(...args);assert.equal(r.status,200,JSON.stringify(r.json));return r.json}
    await ok('/api/settings',{sanmar_user:'fixture',sanmar_pass:'fixture',sanmar_cust:'123'},'PUT')
    const job=await ok('/api/jobs',{contact_id:1,title:'PO HTTP fixture',garment:'Gildan 5000 Tee — White',quantities:'10 M / 20 L'})
    const path='/api/jobs/'+job.id+'/po'
    let preview=await ok(path,undefined,'GET')
    assert.equal(preview.submission_ready,false);assert.equal(preview.placement_state,'manual_required')
    const confirmation={confirmed:true,supplier:'SanMar',reference:'SM-HTTP-001',review_key:preview.review_key}
    assert.equal((await request(path+'/manual',{...confirmation,confirmed:false})).status,400)
    assert.equal((await request(path+'/manual',{...confirmation,reference:''})).status,400)
    assert.equal((await ok('/api/jobs/'+job.id+'/purchase-orders',undefined,'GET')).purchase_orders.length,0)
    await ok('/api/jobs/'+job.id,{quantities:'11 M / 20 L'},'PUT')
    assert.equal((await request(path+'/manual',confirmation)).status,409)
    const attempts=await Promise.all([ok(path+'/submit',{}),ok(path+'/submit',{})])
    assert.ok(attempts.every(r=>r.ok===false && r.pending===true && r.purchase_order.status==='manual_required'))
    assert.equal((await ok('/api/jobs/'+job.id+'/purchase-orders',undefined,'GET')).purchase_orders.length,1)
    preview=await ok(path,undefined,'GET');confirmation.review_key=preview.review_key
    const slug=readdirSync(join(dest,'data/tenants'))[0]
    db=new DatabaseSync(join(dest,'data/tenants',slug,'printshop.db'));db.exec('PRAGMA busy_timeout=5000')
    control=new DatabaseSync(join(dest,'data/control.db'));control.exec('PRAGMA busy_timeout=5000')
    const member=control.prepare('SELECT * FROM members LIMIT 1').get()
    const staffId=Number(control.prepare('INSERT INTO members(tenant_id,name,email,password_hash,role,status) VALUES(?,?,?,?,?,?)').run(member.tenant_id,'PO staff','po-staff@example.test',member.password_hash,'staff','active').lastInsertRowid)
    control.prepare('INSERT INTO sessions(token,tenant_id,member_id,expires_at) VALUES(?,?,?,?)').run('fixture-po-staff',member.tenant_id,staffId,new Date(Date.now()+3600000).toISOString().replace('T',' ').slice(0,19))
    const staff=owner.replace(/=[^;]+/,'=fixture-po-staff')
    assert.equal((await request(path+'/manual',confirmation,'POST',staff)).status,403)
    const received=await Promise.all([ok(path+'/manual',confirmation),ok(path+'/manual',confirmation)])
    assert.equal(received.filter(r=>r.already===false).length,1)
    assert.equal(received.filter(r=>r.already===true).length,1)
    const po=received[0].purchase_order
    assert.equal(po.placement_state,'confirmed_manual');assert.equal(po.received,0)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM po_manual_confirmations WHERE po_id=?').get(po.id).n,1)
    assert.equal((await request(path+'/manual',{...confirmation,reference:'CHANGED'})).status,409)
    const known=await ok(path+'/submit',{})
    assert.equal(known.ok,true);assert.equal(known.already,true);assert.match(known.note,/Nothing new was submitted/)
    await server.stop();await start()
    assert.equal((await ok(path+'/manual',confirmation)).already,true)
    const legacy=await ok('/api/jobs',{contact_id:1,title:'Legacy PO fixture',garment:'Gildan 5000 Tee — White',quantities:'5 M'})
    const legacyPath='/api/jobs/'+legacy.id+'/po'
    const legacyPo=(await ok(legacyPath+'/submit',{})).purchase_order
    db.prepare("UPDATE purchase_orders SET status='placed_manually' WHERE id=?").run(legacyPo.id)
    const original={...db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(legacyPo.id)}
    for(let n=0;n<2;n++){
      const r=await ok(legacyPath+'/submit',{})
      assert.equal(r.ok,false);assert.equal(r.pending,true);assert.equal(r.code,'po_placement_unverified')
      assert.equal(r.purchase_order.placement_state,'unverified_legacy')
    }
    assert.deepEqual({...db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(legacyPo.id)},original)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM po_manual_confirmations WHERE po_id=?').get(legacyPo.id).n,0)
    const lp=await ok(legacyPath,undefined,'GET')
    assert.equal((await request(legacyPath+'/manual',confirmation)).status,409,'another job preview cannot be acknowledged')
    const recorded=await ok(legacyPath+'/manual',{confirmed:true,supplier:'SanMar',reference:'OLD-SM-001',review_key:lp.review_key})
    assert.equal(recorded.purchase_order.placement_state,'confirmed_manual')
    db.prepare("UPDATE purchase_orders SET status='submitting',updated_at='2000-01-01 00:00:00' WHERE id=?").run(legacyPo.id)
    // A separate historical request without any receipt remains uncertain across a retry.
    const pendingJob=await ok('/api/jobs',{contact_id:1,title:'Uncertain PO fixture',garment:'Gildan 5000 Tee — White',quantities:'5 M'})
    const pendingPath='/api/jobs/'+pendingJob.id+'/po'
    const pendingPo=(await ok(pendingPath+'/submit',{})).purchase_order
    db.prepare("UPDATE purchase_orders SET status='submitting',updated_at='2000-01-01 00:00:00' WHERE id=?").run(pendingPo.id)
    const pending=await ok(pendingPath+'/submit',{})
    assert.equal(pending.ok,false);assert.equal(pending.purchase_order.status,'submitting')
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok')
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[])
  } finally {await server.close();db?.close();control?.close();rmSync(temp,{recursive:true,force:true})}
})
