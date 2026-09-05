import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'

const source=readFileSync(new URL('../public/js/shared/payment-collections.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/gm,'').replace(/export (async )?function /g,'$1function ')
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;')
const row=(extra={})=>({reference:'test_checkout_A',invoice_id:1,provider:'stripe',kind:'balance',currency:'USD',amount_cents:10000,state:'open',revision:3,actions:{resume:true,recheck:true,expire:true},...extra})
const data=(extra={})=>({collections:[row(extra)],receipts:[]})
class Root {
  isConnected=true;nodes=[];html=''
  set innerHTML(value){this.html=value;this.nodes=[];for(const tag of value.matchAll(/<(button|input)\b([^>]*)>/g)){
    const attrs=Object.fromEntries([...tag[2].matchAll(/([\w-]+)="([^"]*)"/g)].map(m=>[m[1],m[2]]))
    for(const match of tag[2].matchAll(/\s(data-[\w-]+)(?=\s|$)/g))attrs[match[1]]=''
    const n={attrs,dataset:Object.fromEntries(Object.entries(attrs).filter(([k])=>k.startsWith('data-')).map(([k,v])=>[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase()),v])),value:attrs.value||'',disabled:/\bdisabled\b/.test(tag[2]),addEventListener(event,fn){this['on'+event]=fn}}
    this.nodes.push(n)
  }}
  get innerHTML(){return this.html}
  querySelectorAll(selector){const attr=selector.match(/^\[([^\]]+)\]$/)?.[1];return this.nodes.filter(n=>attr in n.attrs)}
  querySelector(selector){return this.querySelectorAll(selector)[0]}
  action(name){return this.nodes.find(n=>n.dataset.collectionAction===name)}
}
function fixture(){
  let get=async()=>data(),post=async()=>({ok:true}),closed=0,dialog
  const calls=[],location={origin:'http://127.0.0.1:4588',hash:'#/payments'},window={__me:{id:1}}
  const context=vm.createContext({URL,location,window,esc:escape,api:{get:(...args)=>get(...args),post:(...args)=>{calls.push(args);return post(...args)}},modal:options=>{dialog=new Root();dialog.innerHTML=options.footer;options.onMount(dialog)},closeModal:()=>{closed++;dialog.isConnected=false}})
  vm.runInContext(source+'\nglobalThis.mount=mountCollections;globalThis.rows=collectionRows;globalThis.safe=safeCollectionUrl;',context)
  return{context,location,window,calls,setGet:fn=>get=fn,setPost:fn=>post=fn,dialog:()=>dialog,closed:()=>closed,mount:(r,o)=>context.mount(r,o)}
}

test('collection rendering escapes provider evidence and only links supported checkout destinations',()=>{
  const f=fixture(),html=f.context.rows({collections:[row({message:'<img onerror=x>',reference:'"<&',state:'unknown',actions:{}})],receipts:[row({transaction_id:'<script>',reason:'<bad>'})]})
  assert(!html.includes('<img'));assert(!html.includes('<script>'));assert(html.includes('&lt;bad&gt;'));assert(!html.includes('data-collection-action'))
  for(const value of ['',undefined,{},'javascript:alert(1)','https://evil.example/pay','https://user:secret@checkout.stripe.com/pay','https://checkout.stripe.com:444/pay','\nhttps://checkout.stripe.com/pay','https://checkout.stripe.com/pay\r\n','https://checkout.stripe.com/'+ 'a'.repeat(4096)])assert.equal(f.context.safe(value),'')
  assert.equal(f.context.safe('/p/checkout/saved'),'http://127.0.0.1:4588/p/checkout/saved')
  assert.equal(f.context.safe('https://checkout.stripe.com/c/pay/saved'),'https://checkout.stripe.com/c/pay/saved')
})

test('detached and older collection reads cannot replace a newly mounted view',async()=>{
  const f=fixture(),first=deferred(),second=deferred(),old=new Root(),fresh=new Root();let n=0
  f.setGet(()=>++n===1?first.promise:second.promise)
  const a=f.mount(old);old.isConnected=false;const b=f.mount(fresh)
  second.resolve(data({reference:'newest'}));await b;first.resolve(data({reference:'obsolete'}));await a
  assert(fresh.html.includes('newest'));assert(!fresh.html.includes('obsolete'))
})

test('one in-flight action survives leaving and returning without acting twice or repainting the old invoice',async()=>{
  const f=fixture(),root=new Root(),reply=deferred();let oldUpdates=0,newUpdates=0
  f.setPost(()=>reply.promise);await f.mount(root,{invoiceId:1,onChange:()=>oldUpdates++})
  const resume=root.action('resume'),recheck=root.action('recheck'),saving=resume.onclick();await recheck.onclick()
  assert.equal(f.calls.length,1);assert(root.action('resume').disabled);assert(root.action('expire').disabled)
  root.isConnected=false;const fresh=new Root();await f.mount(fresh,{invoiceId:1,onChange:()=>newUpdates++})
  assert(fresh.action('resume').disabled)
  reply.resolve({ok:true,url:'/p/checkout/saved'});await saving
  assert.equal(f.calls.length,1);assert.equal(oldUpdates,0);assert.equal(newUpdates,1);assert(fresh.html.includes('Open saved checkout'))
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0][1])),{revision:3})
})

test('a different signed-in user cannot receive an earlier checkout response',async()=>{
  const f=fixture(),old=new Root(),reply=deferred();f.setPost(()=>reply.promise);await f.mount(old)
  const saving=old.action('resume').onclick();old.isConnected=false;f.window.__me={id:2}
  const fresh=new Root();f.setGet(async()=>({collections:[],receipts:[]}));await f.mount(fresh)
  reply.resolve({url:'/p/checkout/private-old-user'});await saving
  assert(!fresh.html.includes('private-old-user'));assert(!fresh.html.includes('Open saved checkout'))
})

test('identity changes fence actions, in-flight reads and responses even before a replacement view mounts',async()=>{
  const f=fixture(),root=new Root();await f.mount(root)
  f.window.__me={id:2};await root.action('resume').onclick();assert.equal(f.calls.length,0)
  const waiting=fixture(),old=new Root(),reply=deferred();let changes=0
  waiting.setPost(()=>reply.promise);await waiting.mount(old,{onChange:()=>changes++})
  const action=old.action('resume').onclick();waiting.window.__me={id:2}
  reply.resolve({url:'/p/checkout/private-old-user'});await action
  assert(!old.html.includes('private-old-user'));assert.equal(changes,0)
  const reading=fixture(),view=new Root(),read=deferred();reading.setGet(()=>read.promise)
  const mounted=reading.mount(view);reading.window.__me={id:2};read.resolve(data({reference:'private-old-read'}));await mounted
  assert(!view.html.includes('private-old-read'))
})

test('Stripe recovery requests the exact session ID when the server requires one, with no invented ID',async()=>{
  const f=fixture(),root=new Root();f.setGet(async()=>data({requires_session_id:true,actions:{recheck:true}}));await f.mount(root)
  await root.action('recheck').onclick();assert.equal(f.calls.length,0)
  for(const invalid of ['other','cs_fixture\n','cs_has space']){
    const input=root.querySelector('[data-collection-session]');assert(input);input.value=invalid;input.oninput()
    await root.action('recheck').onclick();assert.equal(f.calls.length,0)
  }
  const input=root.querySelector('[data-collection-session]');input.value='cs_exactFixture';input.oninput()
  f.setPost(async()=>{throw Error('Provider temporarily unavailable')});await root.action('recheck').onclick()
  assert.equal(f.calls.length,1);assert.equal(f.calls[0][1].session_id,'cs_exactFixture');assert.equal(f.calls[0][1].revision,3)
  assert.equal(root.querySelector('[data-collection-session]').value,'cs_exactFixture')
})

test('Authorize recheck requires an ID, keeps it on failure, and includes the reviewed revision',async()=>{
  const f=fixture(),root=new Root();f.setGet(async()=>data({provider:'authorize_net',requires_transaction_id:true,actions:{recheck:true}}));await f.mount(root)
  await root.action('recheck').onclick();assert.equal(f.calls.length,0);assert(root.html.includes('Enter the transaction ID'))
  const input=root.querySelector('[data-collection-transaction]');input.value='987654321';input.oninput()
  f.setPost(async()=>{throw new Error('Provider unavailable')});await root.action('recheck').onclick()
  assert.equal(f.calls.length,1);assert.equal(f.calls[0][1].transaction_id,'987654321');assert.equal(f.calls[0][1].revision,3)
  assert.equal(root.querySelector('[data-collection-transaction]').value,'987654321');assert(root.html.includes('result could not be confirmed'))
})

test('refresh preserves transaction input typed while its request is pending',async()=>{
  const f=fixture(),root=new Root();f.setGet(async()=>data({provider:'authorize_net',requires_transaction_id:true}));await f.mount(root)
  const read=deferred();f.setGet(()=>read.promise);const refreshing=root.querySelector('[data-collection-refresh]').onclick()
  const input=root.querySelector('[data-collection-transaction]');input.value='555444333';input.oninput()
  read.resolve(data({provider:'authorize_net',requires_transaction_id:true,revision:4}));await refreshing
  assert.equal(root.querySelector('[data-collection-transaction]').value,'555444333')
})

test('closing a saved checkout requires the current review dialog and exact revision',async()=>{
  for(const stale of [false,true]){
    const f=fixture(),root=new Root();await f.mount(root);root.action('expire').onclick()
    assert.equal(f.calls.length,0);if(stale)f.location.hash='#/contacts/2'
    await f.dialog().querySelector('[data-close-checkout]').onclick()
    assert.equal(f.calls.length,stale?0:1)
    if(!stale){assert.match(f.calls[0][0],/\/expire$/);assert.equal(f.calls[0][1].revision,3);assert.equal(f.closed(),1)}
  }
})

test('an invoice panel excludes other invoices and hides a truly empty history',async()=>{
  const f=fixture(),root=new Root();f.setGet(async()=>({collections:[row({invoice_id:2})],receipts:[row({invoice_id:2,reason:'Private other invoice'})]}))
  await f.mount(root,{invoiceId:1,hideEmpty:true});assert.equal(root.html,'')
})
