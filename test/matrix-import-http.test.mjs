import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHttpTestServer } from './helpers/http-test-server.mjs'

test('matrix imports are atomic, authorized, tenant-isolated and safely retryable after validation errors', {timeout:120000}, async () => {
  const temp=mkdtempSync(join(tmpdir(),'psc-import-')), dest=join(temp,'demo'), server=await createHttpTestServer()
  let db,control
  try {
    const built=spawnSync(process.execPath,['bin/demo.mjs',dest,String(server.port)],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:90000})
    assert.equal(built.status,0,built.stderr)
    const env=JSON.parse(readFileSync(join(dest,'demo-env.json'),'utf8'));env.PSC_TICK_MS='3600000'
    db=new DatabaseSync(join(dest,'data/tenants',readdirSync(join(dest,'data/tenants'))[0],'printshop.db'));db.exec('PRAGMA busy_timeout=5000')
    control=new DatabaseSync(join(dest,'data/control.db'));control.exec('PRAGMA busy_timeout=5000')
    const owner=control.prepare('SELECT * FROM members LIMIT 1').get()
    const session=control.prepare("INSERT INTO sessions(token,tenant_id,member_id,expires_at) VALUES(?,?,?,datetime('now','+1 hour'))")
    session.run('import-owner',owner.tenant_id,owner.id)
    for (const role of ['staff','manager']) {
      const member=control.prepare('INSERT INTO members(tenant_id,name,email,password_hash,role,status) VALUES(?,?,?,?,?,?)').run(owner.tenant_id,role,`import-${role}@example.test`,owner.password_hash,role,'active')
      session.run('import-'+role,owner.tenant_id,Number(member.lastInsertRowid))
    }
    const other=spawnSync(process.execPath,['--no-warnings','--input-type=module','-e',`const t=await import('./lib/tenants.mjs');const shop=await t.createTenant({shop_name:'Other shop',owner_email:'import-other@example.test',password:'fixture-password-123'});t.createSession(shop.id,t.firstOwnerId(shop.id));`],{cwd:dest,env,encoding:'utf8',timeout:30000})
    assert.equal(other.status,0,other.stderr)
    const otherToken=control.prepare('SELECT token FROM sessions WHERE tenant_id!=? LIMIT 1').get(owner.tenant_id).token
    await server.start({cwd:dest,env,args:['--no-warnings','--import','./bin/demo-network-guard.mjs','server.mjs']})
    const request=async(body,token='import-owner',path='/api/matrices/import',method='POST')=>{
      const headers=token?{cookie:'psc_session='+token}:{}
      if (!(body instanceof FormData)) headers['content-type']='application/json'
      const r=await fetch(server.base+path,{method,headers,body:body instanceof FormData?body:JSON.stringify(body),signal:AbortSignal.timeout(10000)})
      return {status:r.status,body:await r.json()}
    }
    const snapshot=()=>JSON.stringify(db.prepare('SELECT * FROM price_matrices ORDER BY id').all())
    const initial=snapshot(),text='Quantity,Small,Large\n1-11,0,\n12-23,4.25,5.50'
    assert.equal((await request({text},null)).status,401)
    assert.equal((await request({text},'import-staff')).status,403)
    assert.equal(snapshot(),initial)
    const body=new FormData();body.append('file',new Blob([text]),'prices.csv');body.append('name','Reliable prices')
    const created=await request(body,'import-manager');assert.equal(created.status,200)
    const id=created.body.matrix.id
    assert.deepEqual(created.body.matrix.cells,[[0,null],[4.25,5.5]])
    assert.equal(created.body.filled,3)
    const updated=await request({name:'Custom metadata',description:'Preserve this note',unit:'flat',colLabel:'Print option',decoration:'Laser',customerSupplied:true},'import-owner',`/api/matrices/${id}`,'PUT')
    assert.equal(updated.status,200)
    const before=snapshot()
    for (const replace of ['',null,0,-1,'oops','1.5',[]]) {
      assert.equal((await request({text,replace})).status,400)
      assert.equal(snapshot(),before,'Malformed replace must never create another matrix')
    }
    for (const bad of ['Qty,A,,B\nOne,1,2,3','Qty,A\nOne,bad','Qty,A,B\nOne,4']) {
      assert.equal((await request({text:bad,replace:id})).status,400)
      assert.equal(snapshot(),before,'Invalid sheets must preserve the entire saved matrix')
    }
    assert.equal((await request({text,replace:id},otherToken)).status,404)
    assert.equal(snapshot(),before,'A different tenant cannot replace this matrix')
    const replaced=await request({text:'Count\tFront\tBack\n1+\t6.5\t0',replace:id})
    assert.equal(replaced.status,200)
    assert.deepEqual(replaced.body.matrix.cells,[[6.5,0]])
    for (const key of ['name','description','unit','colLabel','decoration','customerSupplied','isDefault'])
      assert.equal(replaced.body.matrix[key],updated.body.matrix[key],key+' survives replacement')
    const beforeFailure=snapshot()
    db.exec("CREATE TRIGGER fixture_import_failure BEFORE INSERT ON activities BEGIN SELECT RAISE(ABORT,'fixture activity unavailable'); END")
    assert.equal((await request({text,name:'Must roll back'})).status,400)
    assert.equal(snapshot(),beforeFailure,'Failure after INSERT must roll back the whole import')
    db.exec('DROP TRIGGER fixture_import_failure')
    assert.equal((await request({text,name:'Retry succeeds'})).status,200)
  } finally {await server.close();db?.close();control?.close();rmSync(temp,{recursive:true,force:true})}
})
