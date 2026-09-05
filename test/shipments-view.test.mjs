import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source=readFileSync(new URL('../public/js/shared/shipments.js',import.meta.url),'utf8')
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}
const tick=()=>new Promise(r=>setImmediate(r))
const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')
const decode=v=>v.replaceAll('&quot;','"').replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&')
const data=(id=1,revision=0)=>({records:[],scopes:[{scope:`job:${id}`,job_id:id,title:`Job ${id}`,shipping_revision:revision,production_revision:revision+1,can_record:true,blocked:''}],manager:true})

// A DOM boundary only: execute the shipped module and inspect its real submitted payloads.
function fixture() {
  class Element {
    constructor(){this.isConnected=true;this.html='';this.controls=new Map();this.buttons=new Map()}
    set innerHTML(html){
      this.html=html;this.controls=new Map();this.buttons=new Map();this.form=null
      if(html.includes('data-shipment-form'))this.form={controls:this.controls}
      for(const m of html.matchAll(/<input\b([^>]+)>/g)) {
        const name=m[1].match(/name="([^"]+)"/)?.[1];if(!name)continue
        this.controls.set(name,{name,value:decode(m[1].match(/value="([^"]*)"/)?.[1]||''),checked:/\bchecked\b/.test(m[1]),type:m[1].match(/type="([^"]+)"/)?.[1]||'text',focus(){this.focused=true}})
      }
      for(const m of html.matchAll(/<select\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
        const opts=[...m[2].matchAll(/<option\b([^>]*)>/g)],selected=opts.find(o=>/\bselected\b/.test(o[1]))||opts[0]
        this.controls.set(m[1],{name:m[1],value:decode(selected?.[1].match(/value="([^"]*)"/)?.[1]||'')})
      }
      this.fieldsDisabled=/<fieldset disabled>/.test(html)
      if(this.form)this.form.fieldsDisabled=this.fieldsDisabled
      for(const m of html.matchAll(/<button\b([^>]+)>/g)) {
        const attr=m[1].match(/\b(data-[\w-]+)(?:="([^"]*)")?/);if(!attr)continue
        const b={disabled:/\bdisabled\b/.test(m[1]),dataset:{},addEventListener:(event,fn)=>{b['on'+event]=fn}}
        if(attr[1]==='data-correct-shipment')b.dataset.correctShipment=attr[2]
        this.buttons.set(attr[1]+(attr[2]?':'+attr[2]:''),b)
      }
    }
    get innerHTML(){return this.html}
    querySelector(s){if(s==='[data-shipment-form]')return this.form;const name=s.match(/^\[name="([^"]+)"\]$/)?.[1];if(name)return this.controls.get(name);return this.buttons.get(s.slice(1,-1))||null}
    querySelectorAll(s){return [...this.buttons].filter(([k])=>k.startsWith(s.slice(1,-1))).map(([,v])=>v)}
  }
  let id=0;const posts=[],api={post:async(url,body)=>{posts.push({url,body:structuredClone(body)});return api.override?.(url,body)||{}}}
  // Native FormData is iterable; disabled fieldsets omit their fields.
  const ctx=vm.createContext({api,esc,crypto:{randomUUID:()=>`request-fixture-${++id}`},window:{__me:{}},
    FormData:class {constructor(form){this.entries=form.fieldsDisabled?[]:[...form.controls].filter(([,c])=>c.type!=='checkbox'||c.checked).map(([k,c])=>[k,c.type==='checkbox'?'on':c.value])}[Symbol.iterator](){return this.entries[Symbol.iterator]()}}})
  vm.runInContext(source.replace(/^import[^\n]+\n/gm,'').replaceAll('export function ','function ').replaceAll('export async function ','async function ')+'\nglobalThis.mount=mountShipments;globalThis.rows=shipmentRows;',ctx)
  const element=new Element(),f={ctx,api,posts,element,Element,current:data(),load:async()=>structuredClone(f.current)}
  f.mount=(job=1,el=element,initial=true)=>ctx.mount(el,{key:`job:${job}`,endpoint:`/api/production/jobs/${job}/shipments`,load:()=>f.load(),...(initial?{initial:structuredClone(f.current)}:{})})
  f.type=(name,value,el=element)=>{assert(!el.fieldsDisabled,'User cannot edit a disabled pending save');el.controls.get(name).value=value;el.form.oninput()}
  f.submit=(el=element)=>el.form.onsubmit({preventDefault(){}})
  return f
}

test('shipment rows escape customer text and distinguish recorded, dispatched, legacy and void history',()=>{
  const f=fixture(),r={id:1,kind:'parcel',carrier:'<UPS>',tracking_number:'<script>',note:'A & B',created_at:'2026-09-04',created_by:'Sam',status:'recorded',dispatched_on:'',history:[]}
  const html=f.ctx.rows({records:[r]});assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.match(html,/Reference recorded/);assert.doesNotMatch(html,/Dispatch recorded/)
  assert.match(f.ctx.rows({records:[{...r,dispatched_on:'2026-09-04'}]}),/Dispatch recorded/)
  assert.match(f.ctx.rows({records:[{...r,status:'void',dispatched_on:'2026-09-04'}]}),/Voided/)
  assert.match(f.ctx.rows({records:[{...r,kind:'legacy_unspecified',created_at:null}]}),/original date unknown/)
})

test('shipment drafts stay with each job and are cleared on a different sign-in',async()=>{
  const f=fixture();await f.mount();f.type('tracking_number','Job one private reference')
  f.current=data(2);await f.mount(2);assert.equal(f.element.controls.get('tracking_number').value,'');f.type('tracking_number','Job two')
  f.current=data(1);await f.mount();assert.equal(f.element.controls.get('tracking_number').value,'Job one private reference')
  f.ctx.window.__me={};await f.mount();assert.equal(f.element.controls.get('tracking_number').value,'')
})

test('unknown save outcome retries exactly once per click with the same immutable request, across remount',async()=>{
  const f=fixture();await f.mount();f.type('carrier','UPS');f.type('tracking_number','ONE');f.api.override=()=>{throw new Error('Response lost')}
  await f.submit();assert.equal(f.posts.length,1);assert.match(f.element.innerHTML,/Retry same save/);assert(f.element.fieldsDisabled)
  await f.mount();f.api.override=()=>({});await f.submit();assert.equal(f.posts.length,2);assert.deepEqual(f.posts[0],f.posts[1]);assert.equal(f.element.controls.get('tracking_number').value,'')
})

test('pending save remains singular after leaving and returning; completion updates the replacement component',async()=>{
  const f=fixture();await f.mount();f.type('carrier','UPS');f.type('tracking_number','ONE');const wait=deferred();f.api.override=()=>wait.promise
  const first=f.submit();await f.submit();assert.equal(f.posts.length,1)
  f.element.isConnected=false;const replacement=new f.Element();await f.mount(1,replacement);assert.match(replacement.innerHTML,/Saving…/)
  wait.resolve({});await first;assert.equal(f.posts.length,1);assert.doesNotMatch(replacement.innerHTML,/Saving…/);assert.equal(replacement.controls.get('tracking_number').value,'')
})

test('stale revision keeps draft and refreshes metadata without resubmitting or losing newer typing',async()=>{
  const f=fixture();await f.mount();f.type('tracking_number','KEEP');f.api.override=()=>{throw Object.assign(new Error('Shipment changed'),{status:409})}
  await f.submit();assert.equal(f.element.controls.get('tracking_number').value,'KEEP');assert(!f.element.fieldsDisabled)
  const wait=deferred();f.load=()=>wait.promise;const refreshing=f.element.buttons.get('data-refresh-shipping').onclick();await tick();f.type('tracking_number','NEWER')
  wait.resolve(data(1,5));await refreshing;assert.equal(f.element.controls.get('tracking_number').value,'NEWER');assert.equal(f.posts.length,1)
  f.api.override=()=>({});f.load=async()=>data(1,6);await f.submit();assert.equal(f.posts[1].body.shipping_revision,5);assert.equal(f.posts[1].body.tracking_number,'NEWER');assert.notEqual(f.posts[1].body.request_id,f.posts[0].body.request_id)
})

test('out-of-order loads cannot replace newer shipment records or a detached screen',async()=>{
  const f=fixture();await f.mount();const first=deferred(),second=deferred();let count=0;f.load=()=>++count===1?first.promise:second.promise
  const a=f.element.buttons.get('data-refresh-shipping').onclick(),b=f.element.buttons.get('data-refresh-shipping').onclick();second.resolve(data(1,8));await b;first.resolve(data(1,2));await a
  f.type('tracking_number','LATEST');f.load=async()=>data(1,9);await f.submit();assert.equal(f.posts[0].body.shipping_revision,8)
  const late=deferred();f.load=()=>late.promise;const c=f.element.buttons.get('data-refresh-shipping').onclick();f.element.isConnected=false;f.element.innerHTML='Another screen';late.resolve(data());await c;assert.equal(f.element.innerHTML,'Another screen')
})

test('LAN browsers without randomUUID use secure random bytes; missing crypto preserves the draft with an error',async()=>{
  const f=fixture();f.ctx.crypto={getRandomValues:bytes=>{bytes.fill(31);return bytes}}
  await f.mount();f.type('tracking_number','LAN-ONE');await f.submit();assert.match(f.posts[0].body.request_id,/^shipment-(1f){24}$/)
  f.ctx.crypto=undefined;f.type('tracking_number','KEEP-WITHOUT-CRYPTO');await f.submit();assert.equal(f.posts.length,1)
  assert.match(f.element.innerHTML,/cannot create a secure save reference/);assert.equal(f.element.controls.get('tracking_number').value,'KEEP-WITHOUT-CRYPTO')
})

test('manager can void a legacy record with no tracking value without inventing a reference',async()=>{
  const f=fixture();f.current.records=[{id:4,scope:'estimate:1',kind:'legacy_unspecified',carrier:'Old carrier',tracking_number:'',note:'',dispatched_on:'',status:'recorded',revision:1,shipping_revision:0,can_correct:true,history:[]}]
  await f.mount();f.element.buttons.get('data-correct-shipment:4').onclick();f.type('reason','Duplicate legacy entry')
  const checkbox=f.element.controls.get('void');checkbox.checked=true;f.element.form.onchange({target:checkbox})
  assert.doesNotMatch(f.element.innerHTML.match(/<input\b[^>]*name="tracking_number"[^>]*>/)[0],/\brequired\b/)
  assert.equal(f.element.controls.get('void').focused,true)
  await f.submit();assert.equal(f.posts[0].url,'/api/shipping/4/void');assert.equal(f.posts[0].body.tracking_number,'');assert.equal(f.posts[0].body.reason,'Duplicate legacy entry')
})
