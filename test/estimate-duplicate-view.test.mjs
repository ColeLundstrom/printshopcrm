import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source=readFileSync(new URL('../public/js/shared/estimate-duplicate.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/gm,'').replace('export function ','function ')
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
const tick=()=>new Promise(resolve=>setImmediate(resolve))
function fixture() {
  let root,opener={isConnected:true},load=deferred(),write=deferred(),seq=0,closed=0
  const requests=[],notices=[],navigations=[],loads=[]
  const context=vm.createContext({window:{__me:{member_id:1}},location:{hash:'#/estimates/7'},Uint8Array,
    crypto:{randomUUID:()=>`quote-test-reference-${++seq}`},esc:s=>String(s??'').replaceAll('<','&lt;').replaceAll('"','&quot;'),
    api:{get:async(...args)=>{loads.push(args);return load.promise},post:async(...args)=>{requests.push(args);return write.promise}},
    $:(selector,container)=>(container||{elements:{'#dup':opener}}).elements[selector],
    modal:options=>{if(root)root.isConnected=false;root={isConnected:true,elements:{},body:options.body,closeFocused:false,querySelector:()=>({focus:()=>{root.closeFocused=true}})};for(const id of ['duplicate-customer','duplicate-create','duplicate-feedback','duplicate-reload'])root.elements['#'+id]={disabled:false,hidden:false,style:{},setAttribute(k,v){this[k]=v}};options.onMount(root)},
    closeModal:()=>{closed++;root.isConnected=false},toast:(...args)=>notices.push(args),go:path=>navigations.push(path)})
  vm.runInContext(source+'\nglobalThis.open=duplicateEstimateModal;',context)
  const estimate={id:7,estimate_number:'EST-7',contact_id:1,contact_name:'Source buyer',commercial_revision:3,source_identity:'a'.repeat(32)}
  const contacts=[{id:1,name:'Source buyer'},{id:2,name:'Other <Buyer>',company:'Target company',email:'other@example.test'}]
  return {context,requests,notices,navigations,loads,contacts,estimate,open:()=>context.open(estimate,opener),root:()=>root,el:id=>root.elements['#duplicate-'+id],
    load:()=>load,write:()=>write,setWrite:()=>write=deferred(),setLoad:()=>load=deferred(),closed:()=>closed,
    replaceOpener:()=>{opener.isConnected=false;opener={isConnected:true}}}
}
async function loaded() {const f=fixture();f.open();f.load().resolve({contacts:f.contacts});await tick();return f}

test('loading customers places focus inside the modal without permitting creation',()=>{
  const f=fixture();f.open()
  assert.equal(f.root().closeFocused,true,'A disabled first select must not leave focus behind the modal')
  assert.equal(f.el('create').disabled,true,'A placeholder customer never enables a write before loading')
})

test('duplicate review exposes the destination and keeps one immutable request for uncertain retries',async()=>{
  const f=await loaded()
  assert.match(f.root().body,/for="duplicate-customer"/);assert.match(f.root().body,/customer-specific notes/)
  assert.match(f.el('customer').innerHTML,/Other &lt;Buyer>/);assert.equal(f.el('customer').value,'1')
  f.el('customer').value='2';f.el('customer').onchange()
  const pending=f.el('create').onclick();await f.el('create').onclick()
  assert.equal(f.requests.length,1);assert.equal(f.el('customer').disabled,true);assert.equal(f.el('create').disabled,true)
  const body=f.requests[0][1];assert.equal(body.contact_id,2);assert.equal(body.commercial_revision,3)
  assert.equal(body.source_identity,f.estimate.source_identity)
  f.write().reject(new Error('Network disconnected'));await pending
  assert.equal(f.el('create').textContent,'Retry same copy');assert.equal(f.el('customer').disabled,true)
  assert.match(f.el('feedback').textContent,/uncertain/);assert.equal(f.navigations.length,0)
  const next=f.setWrite(),retry=f.el('create').onclick();next.resolve({id:88,estimate_number:'EST-88'});await retry
  assert.equal(f.requests[1][1],body,'Retry must send the exact original payload and reference')
  assert.deepEqual(f.navigations,['/estimates/88/edit']);assert.equal(f.closed(),1)
})

test('closing and reopening an in-flight duplicate never starts a second copy or redirects an old visit',async()=>{
  const f=await loaded(),pending=f.el('create').onclick()
  f.root().isConnected=false;f.replaceOpener();f.open()
  assert.equal(f.root().closeFocused,true,'Reopening a pending action also starts keyboard focus inside the modal')
  assert.equal(f.el('create').disabled,true);await f.el('create').onclick();assert.equal(f.requests.length,1)
  f.write().resolve({id:90,estimate_number:'EST-90'});await pending
  assert.equal(f.closed(),0);assert.deepEqual(f.navigations,[]);assert.equal(f.el('create').textContent,'Open EST-90')
  const again=f.setWrite(),verify=f.el('create').onclick()
  assert.equal(f.requests.length,2);assert.equal(f.requests[1][1],f.requests[0][1]);assert.deepEqual(f.navigations,[])
  again.resolve({id:90,estimate_number:'EST-90'});await verify
  assert.deepEqual(f.navigations,['/estimates/90/edit'])
})

test('an offscreen result rechecks its receipt before opening and cannot open a deleted replacement',async()=>{
  const f=await loaded(),pending=f.el('create').onclick()
  f.root().isConnected=false;f.replaceOpener();f.open()
  f.write().resolve({id:92,estimate_number:'EST-92'});await pending
  const again=f.setWrite(),verify=f.el('create').onclick()
  assert.equal(f.requests.length,2);assert.equal(f.requests[1][1],f.requests[0][1]);assert.deepEqual(f.navigations,[])
  again.reject(Object.assign(new Error('The previously created quote is no longer available.'),{status:409,data:{code:'duplicate_draft_missing'}}));await verify
  assert.deepEqual(f.navigations,[]);assert.equal(f.closed(),0);assert.match(f.el('feedback').textContent,/no longer available/)
  assert.equal(f.el('create').textContent,'Create draft & edit')
})

test('late duplicate and customer-load replies respect Close, newer navigation and account changes',async()=>{
  for(const action of ['close','navigate','account'])for(const outcome of ['success','error']) {
    const f=await loaded(),pending=f.el('create').onclick(),feedback=f.el('feedback').textContent
    if(action==='close')f.root().isConnected=false
    if(action==='navigate')f.context.location.hash='#/contacts/2'
    if(action==='account')f.context.window.__me={member_id:2}
    if(outcome==='success')f.write().resolve({id:91,estimate_number:'EST-91'});else f.write().reject(new Error('Late error'))
    await pending
    assert.equal(f.closed(),0);assert.deepEqual(f.navigations,[]);assert.deepEqual(f.notices,[]);assert.equal(f.el('feedback').textContent,feedback)
  }
  const f=fixture();f.open();const old=f.root();old.isConnected=false;f.replaceOpener();f.setLoad();f.open()
  const current=f.root();f.load().resolve({contacts:f.contacts});await tick()
  assert.equal(current.elements['#duplicate-customer'].disabled,false)
  assert.doesNotMatch(old.elements['#duplicate-customer'].innerHTML,/Other &lt;Buyer>/,'A late customer list never renders into the older dialog')
})

test('refused copies keep the destination editable; source changes require review and secure references never silently downgrade',async()=>{
  const f=await loaded(),pending=f.el('create').onclick()
  f.write().reject(Object.assign(new Error('This quote changed. Reload it.'),{status:409}));await pending
  assert.equal(f.el('customer').disabled,false);assert.equal(f.el('create').textContent,'Create draft & edit')
  assert.match(f.el('feedback').textContent,/quote changed/)
  delete f.context.crypto.randomUUID
  await f.el('create').onclick();assert.equal(f.requests.length,1);assert.match(f.el('feedback').textContent,/secure retry reference/)
})

test('customer loading failure can be retried without creating a quote',async()=>{
  const f=fixture();f.open();f.load().reject(new Error('Customers unavailable'));await tick()
  assert.equal(f.el('create').disabled,true);assert.equal(f.el('reload').hidden,false)
  const next=f.setLoad(),retry=f.el('reload').onclick();next.resolve({contacts:f.contacts});await retry
  assert.equal(f.el('create').disabled,false);assert.equal(f.requests.length,0)
})

test('the quote destination has a stable visible label separate from customer options',async()=>{
  const f=await loaded()
  const labels=[...f.root().body.matchAll(/<label\b[^>]*\bfor="duplicate-customer"[^>]*>([\s\S]*?)<\/label>/g)]
  assert.equal(labels.length,1)
  assert.equal(labels[0][1].trim(),'Customer for the new quote','Customer choices must not become part of the field label')
  assert.match(f.root().body,/<select\b[^>]*\bid="duplicate-customer"[^>]*\baria-describedby="duplicate-review"/)
  assert.match(f.el('customer').innerHTML,/Other &lt;Buyer>/)
})
