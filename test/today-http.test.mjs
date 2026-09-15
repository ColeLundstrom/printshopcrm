import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHttpTestServer } from './helpers/http-test-server.mjs'

test('Today reports complete tenant counts and truthful overdue work without changing records', { timeout: 120000 }, async () => {
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
    db.exec("UPDATE jobs SET status='complete'; UPDATE invoices SET status='void'")
    const today = new Date().toISOString().slice(0,10)
    const date = n => new Date(Date.parse(today + 'T12:00:00Z') + n * 86400000).toISOString().slice(0,10)
    const job = db.prepare("INSERT INTO jobs(job_number,title,stage,status,due_date,approval_gated) VALUES(?,?,'production','active',?,0)")
    job.run('TODAY-LATE', 'Late job', date(-3)); job.run('TODAY-NOW', 'Current job', today)
    job.run('TODAY-NEXT', 'Next job', date(1)); job.run('TODAY-LATER', 'Later job', date(8))
    const proof = db.prepare("INSERT INTO jobs(job_number,title,stage,status,due_date,approval_gated) VALUES(?,'Proof fixture','art_approval','active',?,0)")
    for(let i=0;i<20;i++) proof.run('TODAY-PROOF-'+i,date(6))
    const invoice = db.prepare('INSERT INTO invoices(invoice_number,status,amount_due,amount_paid,due_date) VALUES(?,?,?,?,?)')
    invoice.run('TODAY-OWED','unpaid',100,25,date(-1))
    invoice.run('TODAY-CREDIT','unpaid',100,120,date(-1))
    invoice.run('TODAY-ZERO','unpaid',100,100,date(-1))
    invoice.run('TODAY-VOID','void',800,0,date(-1))
    invoice.run('TODAY-FUTURE','unpaid',50,0,date(2))
    const contact = db.prepare('INSERT INTO contacts(name) VALUES(?)')
    db.exec('BEGIN'); for(let i=0;i<1500;i++)contact.run('Large shop customer '+i); db.exec('COMMIT')
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
    const before = snapshot()
    await server.start({ cwd: dest, env, args: ['--no-warnings','--import','./bin/demo-network-guard.mjs','server.mjs'] })
    const request = async cookie => {
      const r = await fetch(server.base+'/api/today',{headers:cookie?{cookie}:{},signal:AbortSignal.timeout(10000)})
      return {status:r.status,body:await r.json()}
    }
    assert.equal((await request()).status,401)
    const response = await request(cookie); assert.equal(response.status,200)
    const d = response.body
    assert.equal(d.pulse.money_at_risk,75); assert.equal(d.pulse.approvals,20)
    assert.equal(d.pulse.due_week,22); assert.equal(d.pulse.overdue_jobs,1)
    assert.equal(d.counts.open,2)
    for(const table of ['contacts','estimates','invoices','jobs'])assert.equal(d.counts[table],db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n)
    assert.equal(d.actions.filter(a=>a.kind==='collect').length,1)
    assert.match(d.actions.find(a=>a.title.startsWith('Late job')).title,/overdue since/)
    assert.match(d.actions.find(a=>a.title.startsWith('Current job')).title,/due today/)
    assert.match(d.actions.find(a=>a.title.startsWith('Next job')).title,/due tomorrow/)
    assert(d.actions.length<=12); assert(JSON.stringify(d).length<12000,'Large customer lists must not enter the Today payload')
    const floor = await request(staffCookie); assert.equal(floor.status,200); assert.equal(floor.body.role,'staff'); assert.equal(floor.body.actions[0].kind,'floor')
    const isolated = await request('psc_session='+otherSession.token)
    assert.equal(isolated.status,200); assert.equal(isolated.body.counts.contacts,0); assert.equal(isolated.body.counts.jobs,0)
    assert.equal(isolated.body.pulse.money_at_risk,0); assert.equal(isolated.body.actions.length,0)
    assert.equal(snapshot(),before,'Today reads must preserve customer and production records')
  } finally { await server.close(); db?.close(); control?.close(); rmSync(temp,{recursive:true,force:true}) }
})
