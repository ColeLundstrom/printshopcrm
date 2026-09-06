import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {createHttpTestServer} from './helpers/http-test-server.mjs'
import {locationPricing,normalizeLocationItem,quantityBands} from '../public/js/shared/location-pricing.js'
import {lineAmount,computeTotals,rollupSizes} from '../public/js/shared/pricing.js'
const garment=()=>({description:'Mixed-method hoodie',sizes:{M:22,'2XL':2},unit_price:999,taxable:true,size_upcharges:{'2XL':2},decoration_pricing:{version:1,garment_price:10,notes:'Navy hoodie',locations:[
 {location:'Left sleeve',method:'Screen Print',unit:'piece',price:2,matrix:{name:'Screen printing',row:'12–23',col:'1 color'},priced_qty:24,tiers:[{min:12,max:23,row:'12–23',price:3},{min:24,max:47,row:'24–47',price:2},{min:48,max:null,row:'48+',price:1.5}]},
 {location:'Front',method:'Embroidery',unit:'piece',price:4,matrix:{name:'Embroidery',row:'24–47',col:'8000 stitches'},priced_qty:24},
 {location:'Back',method:'DTF Transfer',unit:'piece',price:5,matrix:{name:'DTF',row:'24–47',col:'12 × 14'},priced_qty:24},
 {location:'Left sleeve setup',method:'Screen Print',unit:'flat',price:25},
]}})
test('one garment with screenprinted sleeve, embroidered front and DTF back bills every method once',()=>{
 const it=normalizeLocationItem(garment());assert.equal(it.unit_price,21);assert.equal(locationPricing(it).flat,25)
 assert.equal(lineAmount(it,{}),533);assert.deepEqual(computeTotals([it],10,{}),{subtotal:533,tax:53.3,total:586.3})
 assert.deepEqual(rollupSizes([it]),{M:22,'2XL':2});assert.match(it.detail,/Left sleeve: Screen Print/);assert.match(it.detail,/Front: Embroidery/);assert.match(it.detail,/Back: DTF Transfer/)
 const supplied=normalizeLocationItem({...it,decoration_pricing:{...it.decoration_pricing,customer_supplied:true,garment_price:0}})
 assert.equal(lineAmount(supplied,{'2XL':20}),289)
 const custom=garment();custom.decoration_pricing.locations.push({location:'Hood',method:'Laser engraving',unit:'piece',price:1.25});assert.equal(lineAmount(normalizeLocationItem(custom),{}),563)
})
test('saved tiers reprice quantities without changing old quotes; unpriced or custom changed bands fail closed',()=>{
 const it=garment();it.sizes={M:48};assert.throws(()=>normalizeLocationItem(it),/Front: quantity changed/)
 it.decoration_pricing.locations.splice(1,2);assert.equal(normalizeLocationItem(it).unit_price,11.5)
 it.sizes={M:5};assert.throws(()=>normalizeLocationItem(it),/no matrix price/)
 it.sizes={M:48};it.decoration_pricing.locations[0].tiers[2].price=null;assert.throws(()=>normalizeLocationItem(it),/no matrix price/)
 assert.deepEqual(quantityBands(['12','24','48']),[{min:12,max:23},{min:24,max:47},{min:48,max:null}]);assert.equal(quantityBands(['8k stitches','10k stitches']),null)
 for(const bad of [NaN,Infinity,-1,'4',true]){const x=garment();x.decoration_pricing.locations[0].price=bad;assert.throws(()=>normalizeLocationItem(x))}
 const overlap=garment();overlap.decoration_pricing.locations[0].tiers[1].min=20;assert.throws(()=>normalizeLocationItem(overlap),/overlap/)
 const legacy={sizes:{M:24},unit_price:12};assert.equal(lineAmount(legacy,{}),288);assert.equal(normalizeLocationItem(legacy),legacy)
})
test('real estimate save, revision, PDF, conversion and restart retain mixed-location money',{timeout:180000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'psc-locations-')),dest=join(dir,'demo'),server=await createHttpTestServer()
 try{
  const built=spawnSync(process.execPath,['bin/demo.mjs',dest,String(server.port)],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:90000});assert.equal(built.status,0,built.stderr)
  const env=JSON.parse(readFileSync(join(dest,'demo-env.json'))),start=()=>server.start({cwd:dest,env,args:['--no-warnings','--import','./bin/demo-network-guard.mjs','server.mjs']})
  await start();let cookie=''
  const req=(path,body,method=body===undefined?'GET':'POST')=>fetch(server.base+path,{method,headers:{'Content-Type':'application/json',Cookie:cookie},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)})
  const json=async(path,body,method)=>{const r=await req(path,body,method);assert.equal(r.status,200,await r.clone().text());return r.json()}
  const login=await req('/api/auth/login',{email:'dylan@example.test',password:readFileSync(join(dest,'LOGIN.txt'),'utf8').match(/Password: (.+)/)[1]});assert.equal(login.status,200);cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')
  const contact=await json('/api/contacts',{name:'Mixed method fixture',email:'mixed@example.test'})
  const created=await json('/api/estimates',{contact_id:contact.id,items:[garment()],tax_rate:10}),path='/api/estimates/'+created.id
  let saved=await json(path);assert.equal(saved.subtotal,533);assert.equal(saved.total,586.3);assert.equal(saved.items[0].unit_price,21);assert.equal(saved.items[0].decoration_pricing.locations.length,4)
  await json(path+'/approve',{commercial_revision:saved.commercial_revision})
  const changed=structuredClone(saved.items);changed[0].decoration_pricing.locations[1].location='Right chest'
  await json(path,{items:changed},'PUT');saved=await json(path);assert.equal(saved.status,'draft');assert.equal(saved.total,586.3)
  const invalid=structuredClone(saved.items);invalid[0].sizes={M:48};assert.equal((await req(path,{items:invalid},'PUT')).status,400);assert.equal((await json(path)).subtotal,533)
  const pdf=Buffer.from(await (await req(path+'/pdf')).arrayBuffer()).toString('latin1');assert.match(pdf,/Right chest/);assert.match(pdf,/DTF/)
  await json(path+'/approve',{commercial_revision:saved.commercial_revision});const converted=await json(path+'/convert',{commercial_revision:(await json(path)).commercial_revision})
  assert.equal((await json('/api/invoices/'+converted.invoice_id)).amount_due,586.3)
  const reorderResponse=await req('/api/contacts/'+contact.id+'/reorder',{});assert.equal(reorderResponse.status,201);const reorder=await reorderResponse.json();const repeated=await json('/api/estimates/'+reorder.estimate_id);assert.deepEqual(repeated.items[0].decoration_pricing,saved.items[0].decoration_pricing);assert.equal(repeated.subtotal,533)
  await server.stop();await start();assert.equal((await json(path)).subtotal,533);assert.equal((await json('/api/invoices/'+converted.invoice_id)).amount_due,586.3)
 }finally{await server.close()}
})
