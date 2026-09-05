import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'

const strip=path=>readFileSync(new URL(path,import.meta.url),'utf8').replace(/^import[^\n]+\n/gm,'').replace(/export (async )?function /g,'$1function ')
const source=strip('../public/js/shared/payment-collections.js')+'\n'+strip('../public/js/views/payments.js')
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')
class Element{
  constructor(tag='div',attrs={},parent=null){this.tag=tag;this.attrs=attrs;this.parent=parent;this.children=[];this.isConnected=true;this.disabled='disabled' in attrs;this.value=attrs.value||'';this.textContent='';this.style={};this.dataset=Object.fromEntries(Object.entries(attrs).filter(([k])=>k.startsWith('data-')).map(([k,v])=>[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase()),v]))}
  addEventListener(event,fn){this['on'+event]=fn}
  get name(){return this.attrs.name}
  get type(){return this.attrs.type}
  get elements(){return this.querySelectorAll('input,select,textarea,button')}
  get innerHTML(){return this.html||''}
  set innerHTML(html){
    for(const old of this.all())old.isConnected=false
    this.html=html;this.children=[];const stack=[this]
    for(const match of html.matchAll(/<(\/?)([a-z][a-z0-9-]*)\b([^>]*)>/gi)){
      const[,closing,tag,raw]=match
      if(closing){let index=stack.findLastIndex(e=>e.tag===tag);if(index>0)stack.splice(index);continue}
      const attrs=Object.fromEntries([...raw.matchAll(/([\w-]+)(?:="([^"]*)"|='([^']*)'|=([^\s>]+))?/g)].map(m=>[m[1],m[2]??m[3]??m[4]??'']))
      const node=new Element(tag,attrs,stack.at(-1));stack.at(-1).children.push(node)
      if(!['input','br','hr','img','meta','link'].includes(tag))stack.push(node)
    }
  }
  all(){return this.children.flatMap(child=>[child,...child.all()])}
  querySelector(selector){return this.querySelectorAll(selector)[0]??null}
  querySelectorAll(selector){
    return this.all().filter(node=>selector.split(',').some(group=>{
      const parts=group.trim().split(/\s+/),last=parts.pop()
      const matches=(n,s)=>{
        if(s.startsWith('#'))return n.attrs.id===s.slice(1)
        const m=s.match(/^([a-z]+)?(?:\[([^=\]]+)(?:=["']?([^\]"']+)["']?)?\])?$/i)
        return !!m && (!m[1]||n.tag===m[1]) && (!m[2]||(m[2]in n.attrs && (m[3]===undefined||n.attrs[m[2]]===m[3])))
      }
      if(!matches(node,last))return false
      let parent=node.parent
      for(const part of parts.reverse()){while(parent && !matches(parent,part))parent=parent.parent;if(!parent)return false;parent=parent.parent}
      return true
    }))
  }
}
function fixture(){
  const document=new Element('document');document.innerHTML='<div id="view"></div>'
  const location={origin:'http://127.0.0.1:4588',hash:'#/payments'},window={__me:{id:1},__EDITION:'full'},calls=[],notices=[]
  let put=async()=>({ok:true}),post=async()=>({environment:'sandbox'}),collection=async()=>({collections:[],receipts:[]})
  const context=vm.createContext({URL,location,window,document,esc:escape,
    $:(s,r=document)=>r.querySelector(s),$$:(s,r=document)=>r.querySelectorAll(s),
    setPage:()=>{document.querySelector('#view').innerHTML=''},toast:(...args)=>notices.push(args),copyText:()=>{},confirmModal:async()=>false,modal:()=>{},closeModal:()=>{},
    FormData:class{constructor(form){this.rows=form.querySelectorAll('[name]').filter(n=>!n.disabled).map(n=>[n.name,n.value])}[Symbol.iterator](){return this.rows[Symbol.iterator]()}},
    api:{get:path=>path.startsWith('/api/payments/collections')?collection(path):Promise.resolve(path==='/api/settings'?{settings:{payment_provider:'stripe',anet_environment:'sandbox',anet_currency:'USD'}}:{currency:'USD',attempts:[],reversals:[]}),
      put:(...args)=>{calls.push({method:'PUT',args,who:window.__me.id});return put(...args)},post:(...args)=>{calls.push({method:'POST',args,who:window.__me.id});return post(...args)}}})
  vm.runInContext(source+'\nglobalThis.view=paymentsView;',context)
  return{document,context,location,window,calls,notices,get:id=>document.querySelector('#'+id),setPut:fn=>put=fn,setPost:fn=>post=fn,setCollection:fn=>collection=fn,
    async mount(){await context.view();await new Promise(resolve=>setImmediate(resolve))}}
}

test('collection refresh preserves the adjacent unsaved payment settings and credential nodes',async()=>{
  const f=fixture();await f.mount()
  const key=f.get('pay-stripe_secret'),form=f.get('payment-form');key.value='sk_test_UNSAVED'
  const reply=deferred();f.setCollection(()=>reply.promise)
  const refreshing=f.get('payment-collections').querySelector('[data-collection-refresh]').onclick()
  key.value='sk_test_NEWER_DRAFT';reply.resolve({collections:[],receipts:[]});await refreshing
  assert.equal(f.get('payment-form'),form);assert.equal(f.get('pay-stripe_secret'),key);assert.equal(key.value,'sk_test_NEWER_DRAFT');assert.equal(f.calls.length,0)
})

test('settings Save and Save-and-test share one flight, freeze submitted fields, and retain failed drafts',async()=>{
  const f=fixture();await f.mount();const waiting=deferred();f.setPut(()=>waiting.promise)
  const key=f.get('pay-stripe_secret'),form=f.get('payment-form');key.value='sk_test_SUBMITTED'
  const saving=form.onsubmit({preventDefault(){}})
  await f.get('test-anet').onclick()
  assert.equal(f.calls.filter(c=>c.method==='PUT').length,1);assert.equal(f.calls.filter(c=>c.method==='POST').length,0)
  assert.equal(key.disabled,true);assert.equal(f.calls[0].args[1].stripe_secret,'sk_test_SUBMITTED')
  waiting.reject(new Error('Fixture save unavailable'));await saving
  assert.equal(key.disabled,false);assert.equal(key.value,'sk_test_SUBMITTED');assert(f.notices.length || f.get('pay-result').textContent.includes('Fixture save unavailable'))
  f.setPut(async()=>({ok:true}));await f.get('test-anet').onclick()
  assert.equal(f.calls.filter(c=>c.method==='PUT').length,2);assert.equal(f.calls.filter(c=>c.method==='POST').length,1)
  assert.equal(key.value,'');assert.match(f.get('anet-result').textContent,/accepted.*sandbox/)
})

test('detached or changed-identity settings completions cannot test providers, clear drafts or write into another screen',async()=>{
  for(const action of ['save','test'])for(const change of ['navigation','identity'])for(const result of ['success','failure']){
    const f=fixture();await f.mount();const waiting=deferred();f.setPut(()=>waiting.promise)
    const key=f.get('pay-stripe_secret');key.value='sk_test_ORIGINAL_DRAFT'
    const pending=action==='test'?f.get('test-anet').onclick():f.get('payment-form').onsubmit({preventDefault(){}})
    if(change==='identity')f.window.__me={id:2};else f.location.hash='#/contacts/7'
    f.get('view').innerHTML='<div id="pay-result"></div><div id="anet-result"></div><input id="pay-stripe_secret" type="password" value="new-screen-draft">'
    if(result==='success')waiting.resolve({ok:true});else waiting.reject(Error('Old screen failure'))
    await pending
    assert.equal(f.calls.filter(c=>c.method==='POST').length,0,`${action}/${change}/${result} cannot start a new provider test`)
    assert.equal(f.get('pay-result').textContent,'');assert.equal(f.get('anet-result').textContent,'')
    assert.equal(f.get('pay-stripe_secret').value,'new-screen-draft');assert.equal(key.value,'sk_test_ORIGINAL_DRAFT')
    assert.equal(f.notices.length,0)
  }
})
