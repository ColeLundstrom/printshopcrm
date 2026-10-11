import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../public/js/views/purchasing.js', import.meta.url), 'utf8')
const esc = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;')
const data = () => ({ rows: [{ id: 1, job_id: 2, job_number: 'J2', title: '<img src=x onerror=alert(1)>', po_number: 'PO1', supplier: 'Fixture & Supply', status: 'partial', job_status: 'active', ordered: 10, received: 4, outstanding: 6, due_date: '2020-01-01', placement_state: 'unverified_legacy', placement_confirmed: false }], summary: { needs_attention: 1, outstanding_units: 6, needs_confirmation: 1, short_closed: 0 }, suppliers: ['Fixture & Supply'], q: '"unsafe', supplier: '', state: 'attention', page: 1, pages: 2, page_size: 25, total: 26 })
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b }); return { promise, resolve, reject } }
function fixture() {
  const nodes = new Map(), calls = []
  class Node {
    constructor(id, parent) { this.id=id; this.parent=parent; this.children=[]; this.connected=true; this.html='' }
    get isConnected() { return this.connected && (!this.parent || this.parent.isConnected) }
    get innerHTML() { return this.html }
    set innerHTML(html) {
      const detach = n => { n.connected=false; if(nodes.get(n.id)===n) nodes.delete(n.id); n.children.forEach(detach) }
      this.children.forEach(detach); this.children=[]; this.html=html
      for(const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) { const n=new Node(match[1],this);this.children.push(n);nodes.set(n.id,n) }
    }
  }
  const view=new Node('view'), actions=new Node('actions');nodes.set('view',view)
  const location={hash:'#/purchasing?q=fixture'},window={__me:{id:1,shop:'Fixture shop'}}
  const api={async get(path){calls.push(path); return api.read ? api.read() : data()}}
  const ctx=vm.createContext({api,$: selector=>nodes.get(selector.slice(1)),esc,fmtDate: value=>value,daysOut: ()=>-1,location,window,URLSearchParams,FormData: class {constructor(){return [['state','short_closed'],['supplier','Fixture & Supply'],['q','needle']] }},setPage(title,html){actions.innerHTML=html}})
  vm.runInContext(source.replace(/^import[^\n]+\n/gm,'').replace('export async function purchasingView','async function purchasingView')+'\nglobalThis.show=purchasingView',ctx)
  return {api,calls,view,location,window,node:id=>nodes.get(id),show:()=>ctx.show(),leave(){view.innerHTML='<p>Elsewhere</p>'}}
}

test('purchasing view uses read-only lookup, escaped records, separate evidence and existing receiving links', async()=>{
  const f=fixture();await f.show()
  assert.deepEqual(f.calls,['/api/purchasing?q=fixture'])
  assert.match(f.view.innerHTML,/26 purchase orders/)
  assert.match(f.view.innerHTML,/&lt;img src=x/)
  assert.doesNotMatch(f.view.innerHTML,/<img src=x/)
  assert.match(f.view.innerHTML,/value="&quot;unsafe"/)
  assert.match(f.view.innerHTML,/Placement unverified/)
  assert.match(f.view.innerHTML,/6 outstanding/)
  assert.match(f.view.innerHTML,/overdue with outstanding quantities/)
  assert.match(f.view.innerHTML,/#\/production\/jobs\/2\?receiving=1/)
  assert.match(f.view.innerHTML,/do not establish production readiness/)
  assert.match(f.view.innerHTML,/aria-label="Purchase order pages"/)
  assert.match(f.view.innerHTML,/page=2/)
  f.node('purchasing-filter').onsubmit({preventDefault(){},currentTarget:{}})
  assert.equal(f.location.hash,'#/purchasing?state=short_closed&supplier=Fixture+%26+Supply&q=needle&page_size=25')
})

test('short-closed and orphan records never claim received quantities or offer a fabricated job link',async()=>{
  const f=fixture(),d=data();d.rows[0]={...d.rows[0],status:'closed',job_id:null};f.api.read=()=>d
  await f.show()
  assert.match(f.view.innerHTML,/Closed short/)
  assert.match(f.view.innerHTML,/6 closed short/)
  assert.match(f.view.innerHTML,/No linked job/)
  assert.doesNotMatch(f.view.innerHTML,/#\/production\/jobs\//)
  assert.doesNotMatch(f.view.innerHTML,/overdue with outstanding/)
})

test('empty and failed reads explain the next step without leaving stale counts',async()=>{
  const f=fixture(),d=data();d.rows=[];d.total=0;d.pages=1;f.api.read=()=>d
  await f.show();assert.match(f.view.innerHTML,/No purchase orders in this view/)
  f.api.read=()=>{throw Error('Fixture read failed')};await f.show()
  assert.match(f.view.innerHTML,/Reading recorded/)
  assert.match(f.node('purchasing-loading').innerHTML,/role="alert"/)
  assert.match(f.node('purchasing-loading').innerHTML,/Fixture read failed/)
  assert.equal(f.node('purchasing-results'),undefined)
})

test('late success or failure cannot overwrite another route or a newer visit',async()=>{
  for(const outcome of ['resolve','reject']) {
    const f=fixture(),pending=deferred();f.api.read=()=>pending.promise
    const old=f.show();f.leave()
    pending[outcome](outcome==='resolve'?data():Error('Old error'));await old
    assert.equal(f.view.innerHTML,'<p>Elsewhere</p>')
  }
  const f=fixture(),pending=deferred();f.api.read=()=>pending.promise
  const old=f.show();f.api.read=()=>({...data(),total:99});await f.show()
  pending.resolve(data());await old
  assert.match(f.view.innerHTML,/99 purchase orders/)
})


test('connected purchasing loaders ignore late data and errors after route or identity changes',async()=>{
  for(const outcome of ['resolve','reject']) for(const changed of ['route','identity']) {
    const f=fixture(),pending=deferred();f.api.read=()=>pending.promise
    const old=f.show(),loading=f.node('purchasing-loading'),before=f.view.innerHTML
    if(changed==='route') f.location.hash='#/invoices'
    else f.window.__me={id:2,shop:'Different fixture shop'}
    assert.equal(loading.isConnected,true,'The next asynchronous route has not cleared the DOM yet')
    pending[outcome](outcome==='resolve'?data():Error('Late previous-shop error'));await old
    assert.equal(f.view.innerHTML,before,`${outcome} after ${changed} must not repaint a connected loader`)
    assert.equal(loading.innerHTML,'',`${outcome} after ${changed} must not show an old error`)
    assert.equal(f.node('purchasing-results'),undefined)
  }
})

test('purchasing controls have stable visible labels separate from their option text',async()=>{
  const f=fixture();await f.show()
  for(const [id,expected] of [['purchasing-state','View'],['purchasing-supplier','Supplier'],['purchasing-search','PO or job search']]) {
    const matches=[...f.view.innerHTML.matchAll(new RegExp(`<label\\b[^>]*\\bfor="${id}"[^>]*>([\\s\\S]*?)</label>`, 'g'))]
    assert.equal(matches.length,1,`One explicit visible label for ${id}`)
    assert.equal(matches[0][1].trim(),expected,'Labels must not include controls or changing option text')
    assert.match(f.view.innerHTML,new RegExp(`<(?:select|input)\\b[^>]*\\bid="${id}"`))
  }
})
