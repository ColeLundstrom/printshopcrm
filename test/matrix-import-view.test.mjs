import test from 'node:test'
import assert from 'node:assert/strict'

test('file imports clear the chooser for retry, suppress duplicates and ignore replies after account or screen changes', async () => {
  const nodes=new Map()
  const node=key=>{if(!nodes.has(key))nodes.set(key,{innerHTML:'',textContent:'',isConnected:true,disabled:false,addEventListener(){}});return nodes.get(key)}
  globalThis.document={querySelector:node}
  const {api}=await import('../public/js/core.js')
  globalThis.window={__me:{id:1},addEventListener(){}}
  globalThis.location={hash:'#/matrices'}
  const {matricesView}=await import('../public/js/views/matrices.js')
  api.get=async()=>({matrices:[],templates:[]})
  await matricesView()
  const input=node('#mx-import-new'),note=node('#mx-import-note'),file=new File(['Qty,A\nOne,1'],'same.csv')
  let calls=0,finish
  api.req=async()=>{calls++;return await new Promise(resolve=>finish=resolve)}
  input.files=[file];input.value='same.csv'
  const first=input.onchange({target:input})
  assert.equal(input.value,'');assert.equal(input.disabled,true)
  await input.onchange({target:input});assert.equal(calls,1,'Only one request may be in flight')
  window.__me={id:2};finish({matrix:{id:9},filled:1});await first
  assert.equal(location.hash,'#/matrices','Late replies cannot navigate a different account')
  assert.equal(input.disabled,false)
  await matricesView()
  api.req=async()=>{calls++;throw Object.assign(Error('Invalid price'),{status:400})}
  await input.onchange({target:input});assert.match(note.textContent,/Invalid price/)
  await input.onchange({target:input});assert.equal(calls,3,'The same file can be retried after a rejected upload')
  api.req=async()=>new Promise(resolve=>finish=resolve)
  const pending=input.onchange({target:input});node('#mx-list').isConnected=false
  finish({matrix:{id:10},filled:1});await pending
  assert.equal(location.hash,'#/matrices','Detached screens must not navigate on completion')
})
