import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseCsv } from '../lib/csv.mjs'
import { createHttpTestServer } from './helpers/http-test-server.mjs'

test('customer tag filtering preserves records, authentication and tenant boundaries', { timeout: 120000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'psc-today-')), dest = join(temp, 'demo'), server = await createHttpTestServer()
  let db, control
  try {
    const built = spawnSync(process.execPath, ['bin/demo.mjs', dest, String(server.port)], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 90000,
    })
    assert.equal(built.status, 0, built.stderr)
    const env = JSON.parse(readFileSync(join(dest, 'demo-env.json'), 'utf8')); env.PSC_TICK_MS = '3600000'
    db = new DatabaseSync(join(dest, 'data/tenants', readdirSync(join(dest, 'data/tenants'))[0], 'printshop.db'))
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON')
    db.exec("INSERT INTO contacts(name,tags) VALUES('Filter Alpha','school,repeat'),('Filter Beta','school'),('Filter Gamma','repeat,overdue'),('Filter Untagged',''),('Filter Wildcard','100%,a_b')")
    control = new DatabaseSync(join(dest,'data/control.db')); control.exec('PRAGMA busy_timeout=5000')
    const owner = control.prepare('SELECT * FROM members LIMIT 1').get()
    const staff = Number(control.prepare("INSERT INTO members(tenant_id,name,email,password_hash,role,status) VALUES(?,'Staff','today-staff@example.test',?,'staff','active')").run(owner.tenant_id,owner.password_hash).lastInsertRowid)
    const cookie = 'psc_session=today-existing-owner', staffCookie = 'psc_session=today-existing-staff'
    const session = control.prepare("INSERT INTO sessions(token,tenant_id,member_id,expires_at) VALUES(?,?,?,datetime('now','+1 hour'))")
    session.run('today-existing-owner',owner.tenant_id,owner.id); session.run('today-existing-staff',owner.tenant_id,staff)
    const other = spawnSync(process.execPath,['--no-warnings','--input-type=module','-e',`const t=await import('./lib/tenants.mjs');const shop=await t.createTenant({shop_name:'Other shop',owner_email:'today-other@example.test',password:'fixture-password-123'});const member=t.firstOwnerId(shop.id);t.createSession(shop.id,member);`],{cwd:dest,env,encoding:'utf8',timeout:30000})
    assert.equal(other.status,0,other.stderr)
    const otherSession = control.prepare('SELECT token FROM sessions WHERE tenant_id!=? LIMIT 1').get(owner.tenant_id)
    const snapshot = () => JSON.stringify(['contacts','estimates','invoices','jobs','payments'].map(t => db.prepare('SELECT * FROM '+t+' ORDER BY id').all()))
    db.prepare("UPDATE contacts SET notes=?, company=? WHERE name='Filter Alpha'").run('=1+1','Print, \"Studio\"\nWest')
    const before = snapshot()
    await server.start({ cwd: dest, env, args: ['--no-warnings','--import','./bin/demo-network-guard.mjs','server.mjs'] })
    const request = async (query='', cookieValue=cookie) => {
      const r=await fetch(server.base+'/api/contacts?q=Filter&'+query,{headers:cookieValue?{cookie:cookieValue}:{},signal:AbortSignal.timeout(10000)})
      return {status:r.status,body:await r.json()}
    }
    const names=r=>r.body.contacts.map(c=>c.name)
    assert.equal((await request('',null)).status,401)
    assert.deepEqual(names(await request('tag=school&tag=repeat')),['Filter Alpha'])
    assert.deepEqual(names(await request('tag=school&tag=repeat&tag_mode=any&exclude_tag=overdue')),['Filter Alpha','Filter Beta'])
    assert.deepEqual(names(await request('tag=100%25')),['Filter Wildcard'])
    const all=await request('');assert.equal(all.status,200);assert.equal(all.body.contacts.length,5)
    assert(all.body.tags.includes('overdue'),'Available tags remain complete after filtering')
    const staffResult=await request('tag=school',staffCookie);assert.equal(staffResult.status,200);assert.deepEqual(names(staffResult),['Filter Alpha','Filter Beta'])
    const isolated=await request('tag=school','psc_session='+otherSession.token);assert.equal(isolated.status,200);assert.deepEqual(isolated.body.contacts,[]);assert.deepEqual(isolated.body.tags,[])
    assert.equal((await request('tag_mode=bad')).status,400)
    assert.equal((await request(Array(21).fill('tag=school').join('&'))).status,400)
    const csv = async (query, auth=cookie) => {
      const r=await fetch(server.base+'/api/export/contacts.csv'+(query===null?'':'?q=Filter&'+query),{headers:auth?{cookie:auth}:{},signal:AbortSignal.timeout(10000)})
      return {status:r.status,text:await r.text(),type:r.headers.get('content-type'),attachment:r.headers.get('content-disposition'),cache:r.headers.get('cache-control')}
    }
    for (const query of ['','tag=school&tag=repeat','tag=school&tag=repeat&tag_mode=any&exclude_tag=overdue','tag=100%25','tag=missing',"tag=%27%20OR%201%3D1--"]){
      const exported=await csv(query);assert.equal(exported.status,200);assert.match(exported.type,/text\/csv/);assert.match(exported.attachment,/attachment/);assert.equal(exported.cache,'private, no-store')
      const expected=(await request(query)).body.contacts.map(c=>c.id).sort((a,b)=>a-b)
      assert.deepEqual(parseCsv(exported.text).map(c=>Number(c.id)).sort((a,b)=>a-b),expected)
    }
    const alpha=parseCsv((await csv('tag=school&tag=repeat')).text)[0]
    assert.equal(alpha.notes,"'=1+1",'Formula text must stay literal');assert.equal(alpha.company,'Print, "Studio"\nWest')
    assert.equal((await csv('',staffCookie)).status,403);assert.equal((await csv('',null)).status,401)
    assert.equal((await csv('tag_mode=bad')).status,400);assert.equal((await csv('tag_mode=bad')).attachment,null)
    assert.equal((await csv(Array(21).fill('tag=school').join('&'))).status,400)
    assert.equal((await csv('','psc_session='+otherSession.token)).text,'','Another tenant cannot export these customers')
    assert.equal(parseCsv((await csv(null)).text).length,db.prepare('SELECT count(*) n FROM contacts').get().n,'Legacy full export preserved')
    assert.equal(snapshot(),before,'Filtering must never mutate customer or production records')

  } finally { await server.close(); db?.close(); control?.close(); rmSync(temp,{recursive:true,force:true}) }
})
