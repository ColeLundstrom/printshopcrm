import test from 'node:test'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'

const root = new URL('..', import.meta.url)
test('isolated demo keeps private data safe and serves customer proofs from a hidden install directory', { timeout: 180000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'psc-demo-test-'))
  mkdirSync(join(tmp, '.evaluation'))
  const dest = join(tmp, '.evaluation', 'instance')
  const sentinel = join(tmp, 'real-shop.db'); writeFileSync(sentinel, 'existing customer data')
  const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r))
  const port = probe.address().port; await new Promise(r => probe.close(r))
  let server
  try {
    const args = ['bin/demo.mjs', dest, String(port)]
    const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, PSC_DB: sentinel, PSC_CONTROL_DB: sentinel, PSC_PLATFORM_STRIPE_SECRET: 'do-not-inherit' } })
    assert.equal(r.status, 0, r.error?.message || r.stderr)
    assert.equal(readFileSync(sentinel, 'utf8'), 'existing customer data')
    const config = JSON.parse(readFileSync(join(dest, 'demo-env.json'), 'utf8'))
    assert.equal(config.PSC_PLATFORM_STRIPE_SECRET, undefined)
    assert.equal(config.PSC_CONTROL_DB, undefined)
    assert.equal(JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8')).scripts.start, 'node start.mjs')
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
    const write = (path,body,method='POST',extra={}) => fetch(base+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json',...extra},body:JSON.stringify(body)})
    // AI-off remains an ordinary working shop; no external services are reachable in this demo.
    assert.equal(settings.ai_provider,'')
    const originalKey = await (await get('/api/developers')).json()
    if(originalKey.api_key_set) assert.equal((await write('/api/developers/key/revoke',{})).status,200)
    const keyReply=await write('/api/developers/key/create-readonly',{})
    assert.equal(keyReply.status,200)
    const {api_key}=await keyReply.json()
    assert.equal((await write('/api/developers/key/create-readonly',{})).status,409)
    const auth={Authorization:'Bearer '+api_key,Cookie:cookie}
    assert.equal((await fetch(base+'/api/v1/customers',{headers:auth})).status,200)
    assert.equal((await write('/api/v1/customers',{name:'Must not create'},'POST',auth)).status,403,'cookie does not bypass key access')
    assert.equal((await write('/api/settings',{api_access:'anything'},'PUT')).status,400)
    assert.equal((await write('/api/settings',{api_access:'full'},'PUT')).status,200)
    assert.equal((await write('/api/v1/customers',{name:'Manual API customer'},'POST',auth)).status,201)
    assert.equal((await write('/api/settings',{api_access:'read'},'PUT')).status,200)
    const history='customer,email,invoice #,date,status,total\nMigration,migration@example.test,OLD-01,2025-08-01,complete,100'
    const preview=await write('/api/import/orders',{text:history,preview:true,status_policy:'strict'})
    assert.equal(preview.status,200)
    assert.equal((await preview.json()).blocked,true)
    assert.equal((await write('/api/import/orders',{text:history,status_policy:'strict'})).status,400)
    const reviewed=await write('/api/import/orders',{text:history.replace(',complete,',',paid,'),preview:true,status_policy:'strict'})
    assert.equal((await reviewed.json()).blocked,false)
    // Signed incoming texts are accepted without a login or AI, and deduplicated durably.
    const sid='AC'+'1'.repeat(32), token='fixture-auth-token', from='+14155550188'
    assert.equal((await write('/api/settings',{twilio_sid:sid,twilio_token:token,twilio_from:from},'PUT')).status,200)
    const smsSetup=await (await get('/api/sms-setup')).json()
    assert.equal(smsSetup.public_https,false)
    const smsPath=new URL(smsSetup.url).pathname
    const params={AccountSid:sid,MessageSid:'SM'+'2'.repeat(32),From:'+14155550199',To:from,Body:'Please confirm my order manually.',NumMedia:'0'}
    const signed = async (fields,signature,extra={}) => {
      const payload=smsSetup.url+Object.keys(fields).sort().map(k=>k+fields[k]).join('')
      return fetch(base+smsPath,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Twilio-Signature':signature ?? crypto.createHmac('sha1',token).update(payload).digest('base64'),...extra},body:new URLSearchParams(fields)})
    }
    assert.equal((await signed(params,'forged')).status,401)
    assert.equal((await signed({...params,AccountSid:'AC'+'9'.repeat(32)})).status,403)
    assert.equal((await signed({...params,To:'+14155550222'})).status,403)
    assert.equal((await signed(params)).status,200)
    assert.equal((await signed(params)).status,200)
    const inboundContacts=await (await get('/api/contacts')).json()
    const received=inboundContacts.contacts.find(c=>c.phone===params.From)
    assert(received)
    const thread=await (await get('/api/conversations/'+received.id)).json()
    assert.equal(thread.messages.filter(m=>m.body===params.Body).length,1)
    assert.equal(thread.messages.filter(m=>m.direction==='out').length,0)
    assert.equal((await signed({...params,MessageSid:'bad'})).status,400)
    assert.equal((await write('/api/settings',{twilio_token:'rotated'},'PUT')).status,200)
    assert.equal((await signed({...params,MessageSid:'SM'+'3'.repeat(32)})).status,401)

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
    rmSync(tmp,{recursive:true,force:true,maxRetries:10,retryDelay:200})
  }
})
