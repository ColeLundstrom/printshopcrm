import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'

test('an online upgrade never serves stale app code and offline storage excludes private routes',async()=>{
 const listeners={},cache=new Map(),origin='https://shop.test'
 let online=true,status=200,calls=0,cacheFailures=false
 const key=r=>typeof r==='string'?r:r.url
 const context={URL,Response,location:{origin},self:{addEventListener:(type,fn)=>listeners[type]=fn},
   caches:{match:async r=>cache.get(key(r))?.clone(),open:async()=>({put:async(r,res)=>{if(cacheFailures)throw new Error('storage full');cache.set(key(r),res)}})},
   fetch:async()=>{calls++;if(!online)throw new Error('offline');return new Response('current release',{status})}}
 vm.runInNewContext(readFileSync(new URL('../public/sw.js',import.meta.url),'utf8'),context)
 const request=async(path,method='GET')=>{let response;listeners.fetch({request:{url:origin+path,method},respondWith:p=>response=p});return response?await response:null}
 for(const path of ['/', '/js/views/setup.js','/css/app.css?v=new']) {
   cache.set(origin+path,new Response('old release'))
   const r=await request(path);assert.equal(await r.text(),'current release')
 }
 online=false;assert.equal(await (await request('/js/views/setup.js')).text(),'current release')
 assert.equal((await request('/js/not-yet-cached.js')).status,503)
 const before=calls
 for(const path of ['/api/invoices','/API/INVOICES','/p/pay/1','/uploads/proof.svg','/login','/api/auth/login','/webhooks/payments/key/stripe','/new-private-route']) assert.equal(await request(path),null)
 assert.equal(await request('/', 'POST'),null);assert.equal(calls,before)
 online=true;status=503;assert.equal((await request('/css/app.css?v=new')).status,503,'server errors must not silently load another release')
 status=200;cacheFailures=true;assert.equal(await (await request('/css/app.css?v=new')).text(),'current release','full browser storage does not hide a good network response')
})
