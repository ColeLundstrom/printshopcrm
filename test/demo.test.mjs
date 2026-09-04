import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'

const root = new URL('..', import.meta.url)
test('isolated demo keeps private data safe and serves customer proofs from a hidden install directory', { timeout: 30000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'psc-demo-test-'))
  mkdirSync(join(tmp, '.evaluation'))
  const dest = join(tmp, '.evaluation', 'instance')
  const sentinel = join(tmp, 'real-shop.db'); writeFileSync(sentinel, 'existing customer data')
  const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r))
  const port = probe.address().port; await new Promise(r => probe.close(r))
  let server
  try {
    const args = ['bin/demo.mjs', dest, String(port)]
    const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, PSC_DB: sentinel, PSC_CONTROL_DB: sentinel, PSC_PLATFORM_STRIPE_SECRET: 'do-not-inherit' } })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readFileSync(sentinel, 'utf8'), 'existing customer data')
    const config = JSON.parse(readFileSync(join(dest, 'demo-env.json'), 'utf8'))
    assert.equal(config.PSC_PLATFORM_STRIPE_SECRET, undefined)
    assert.equal(config.PSC_CONTROL_DB, undefined)
    const login = readFileSync(join(dest, 'LOGIN.txt'), 'utf8')
    assert.doesNotMatch(r.stdout, new RegExp(login.match(/Password: (.+)/)[1]))
    const again = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' })
    assert.notEqual(again.status, 0, 'never reseed an existing demo')
    assert.equal(readFileSync(join(dest, 'LOGIN.txt'), 'utf8'), login)
    let log = ''
    server = spawn(process.execPath, ['--no-warnings', '--import', './bin/demo-network-guard.mjs', 'server.mjs'], { cwd: dest, env: config, stdio: ['ignore', 'pipe', 'pipe'] })
    server.stdout.on('data', d => log += d); server.stderr.on('data', d => log += d)
    const base = `http://127.0.0.1:${port}`
    let ready = false
    for (let i=0;i<100;i++) {
      try { const h=await fetch(base+'/health'); if(h.ok){ready=true;break} } catch {}
      await new Promise(r=>setTimeout(r,50))
    }
    assert(ready, log)
    const res = await fetch(base+'/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({email:'dylan@example.test',password:login.match(/Password: (.+)/)[1]}) })
    assert.equal(res.status, 200, await res.clone().text())
    const cookie=res.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')
    const get = path => fetch(base+path, {headers:{Cookie:cookie}})
    const {settings} = await (await get('/api/settings')).json()
    assert.match(settings.brand_tagline, /Sample data.*External services disabled/)
    const {contacts} = await (await get('/api/contacts')).json()
    assert.equal(contacts.length,8)
    assert(contacts.every(c => c.email.endsWith('@example.test')))
    const invoices = await (await get('/api/invoices')).json()
    for(const status of ['unpaid','partial','paid']) assert(invoices.some(i=>i.status===status), `missing ${status} invoice`)
    const {columns} = await (await get('/api/board')).json()
    const jobs = columns.flatMap(c=>c.jobs)
    assert(jobs.length >= 5)
    const form = new FormData(); form.append('file',new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><!--DEMO-PROOF--></svg>'],{type:'image/svg+xml'}),'proof.svg')
    const artRes=await fetch(base+`/api/jobs/${jobs[0].id}/art`,{method:'POST',headers:{Cookie:cookie},body:form})
    assert.equal(artRes.status,200);const art=await artRes.json()
    const image=await get('/uploads/'+art.filename)
    assert.equal(image.status,200,'owner must see an uploaded proof even when app lives under .evaluation')
    assert.match(await image.text(),/DEMO-PROOF/)
    assert.equal((await fetch(base+'/uploads/'+art.filename)).status,404,'anonymous file access stays blocked')
  } finally {
    if(server && server.exitCode===null){server.kill('SIGTERM');await new Promise(r=>server.once('exit',r))}
    rmSync(tmp,{recursive:true,force:true})
  }
})
