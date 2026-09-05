import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
const source=readFileSync(new URL('../public/js/shared/billing-recipients.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/gm,'').replaceAll('export function ','function ')
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
function fixture(){
  const edit={isConnected:true},save={},defaults={},mode={value:'custom',disabled:false},email={disabled:false},locked={disabled:true},fields={},root={isConnected:true,querySelectorAll:()=>[mode,email,locked]},sent=[],notices=[]
  let after=0,closed=0,call=deferred()
  const context=vm.createContext({api:{put:async(...args)=>{sent.push(args);return call.promise}},location:{hash:'#/invoices/1'},
    $:selector=>({'#edit-recipients':edit,'#recipient-save':save,'#recipient-defaults':defaults,'#billing-mode':mode,'[data-ap-fields]':fields})[selector],
    esc:String,formData:()=>({billing_mode:'custom',billing_name:'Saved AP',billing_email:'saved@example.test'}),toast:(...args)=>notices.push(args),
    modal:options=>options.onMount(root),closeModal:()=>{closed++;root.isConnected=false}})
  vm.runInContext(source+'\nglobalThis.bind=bindRecipientEditor;',context)
  context.bind({id:1,recipient_revision:2,recipient_snapshot:'{}'},'invoice',()=>{after++});edit.onclick()
  return{root,save,defaults,mode,email,locked,sent,notices,context,call,setCall:c=>call=c,after:()=>after,closed:()=>closed}
}
test('recipient editor uses one shared in-flight action and retains its draft after failure',async()=>{
  const f=fixture(),pending=f.save.onclick();await f.defaults.onclick()
  assert.equal(f.sent.length,1);assert.equal(f.save.disabled,true);assert.equal(f.defaults.disabled,true)
  assert.equal(f.mode.disabled,true);assert.equal(f.email.disabled,true);assert.equal(f.locked.disabled,true)
  f.call.reject(new Error('Reload to review current recipients'));await pending
  assert.equal(f.closed(),0);assert.equal(f.after(),0);assert.equal(f.save.disabled,false);assert.equal(f.defaults.disabled,false)
  assert.equal(f.mode.disabled,false);assert.equal(f.email.disabled,false);assert.equal(f.locked.disabled,true)
  assert.equal(f.notices[0][0],'Reload to review current recipients')
  const next=deferred();f.setCall(next);const retry=f.save.onclick();next.resolve({});await retry
  assert.equal(f.sent.length,2);assert.equal(f.sent[1][1].billing_email,'saved@example.test');assert.equal(f.closed(),1);assert.equal(f.after(),1)
})
test('recipient save finishing after modal close or navigation cannot close another modal or repaint an old document',async()=>{
  for(const action of ['close','navigate'])for(const outcome of ['success','error']){
    const f=fixture(),pending=f.defaults.onclick()
    if(action==='close')f.root.isConnected=false;else f.context.location.hash='#/contacts/2'
    if(outcome==='success')f.call.resolve({});else f.call.reject(new Error('Detached failure'))
    await pending
    assert.equal(f.closed(),0);assert.equal(f.after(),0);assert.equal(f.notices.length,0)
  }
})
