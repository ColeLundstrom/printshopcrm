import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {createHttpTestServer} from './helpers/http-test-server.mjs'

test('usage HTTP requires platform owner; browser work counts, support and scripted checks do not',{timeout:120000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'psc-usage-http-')),dest=join(root,'demo'),http=await createHttpTestServer()
  try {
    const built=spawnSync(process.execPath,['bin/demo.mjs',dest,String(http.port)],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:90000});assert.equal(built.status,0,built.stderr)
    const env=JSON.parse(readFileSync(join(dest,'demo-env.json')));env.PSC_ADMIN_EMAIL='dylan@example.test'
    let log='';await http.start({cwd:dest,env,args:['--no-warnings','--import','./bin/demo-network-guard.mjs','server.mjs'],onOutput:s=>log+=s})
    for(let i=0;i<600&&!log.includes('(ws /ws live');i++)await new Promise(r=>setTimeout(r,50));assert.match(log,/ws \/ws live/)
    const request=(path,method='GET',body,cookie='',browser=false)=>fetch(http.base+path,{method,headers:{'Content-Type':'application/json',Cookie:cookie,...(browser?{'sec-fetch-site':'same-origin'}:{})},body:body===undefined?undefined:JSON.stringify(body)})
    const login=await request('/api/auth/login','POST',{email:'dylan@example.test',password:readFileSync(join(dest,'LOGIN.txt'),'utf8').match(/Password: (.+)/)[1]})
    assert.equal(login.status,200);const cookie=login.headers.getSetCookie()[0].split(';')[0]
    const report=async()=>{const r=await request('/api/admin/usage','GET',undefined,cookie);assert.equal(r.status,200);return r.json()}
    const initial=await report();assert.equal(initial.available,true);assert.equal(initial.customers_active7,0)
    const id=initial.shops[0].id
    assert.equal((await request(`/api/admin/shops/${id}/classification`,'POST',{kind:'customer'},cookie)).status,200)
    assert.equal((await request('/api/contacts','POST',{name:'Synthetic no browser'},cookie)).status,200)
    assert.equal((await report()).customers_active7,0)
    assert.equal((await request('/api/contacts','POST',{name:'Browser work'},cookie,true)).status,200)
    assert.equal((await report()).customers_active7,1)
    const signup=await request('/api/auth/signup','POST',{shop_name:'Other fixture',owner_name:'Other',owner_email:'other-usage@example.test',password:'fixture-password-123'})
    assert.equal(signup.status,200);const other=signup.headers.getSetCookie()[0].split(';')[0]
    assert.equal((await request('/api/admin/usage','GET',undefined,other)).status,403)
    assert.equal((await request(`/api/admin/shops/${id}/classification`,'POST',{kind:'test'},other)).status,403)
    const all=await report(),otherId=all.shops.find(s=>s.id!==id).id
    const support=await request(`/api/admin/shops/${otherId}/signin`,'POST',{},cookie);assert.equal(support.status,200)
    const supportCookie=support.headers.getSetCookie()[0].split(';')[0]
    assert.equal((await request('/api/contacts','POST',{name:'Support work'},supportCookie,true)).status,200)
    // Re-authenticate owner; impersonation intentionally ends the preceding session.
    const again=await request('/api/auth/login','POST',{email:'dylan@example.test',password:readFileSync(join(dest,'LOGIN.txt'),'utf8').match(/Password: (.+)/)[1]})
    const final=await (await request('/api/admin/usage','GET',undefined,again.headers.getSetCookie()[0].split(';')[0])).json()
    assert.equal(final.shops.find(s=>s.id===otherId).actions30,0)
    assert.equal(final.shops.find(s=>s.id===otherId).uncertain_actions30,0)
  } finally {await http.close()}
})
