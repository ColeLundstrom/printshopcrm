import test from 'node:test'
import assert from 'node:assert/strict'

test('customer filter responses cannot overwrite a newer selection or a different shop',async()=>{
 const nodes=new Map()
 const node=key=>{if(!nodes.has(key))nodes.set(key,{innerHTML:'',textContent:'',value:key==='#tag-mode'?'all':'',isConnected:true,addEventListener(){},contains(){return true}});return nodes.get(key)}
 globalThis.document={querySelector:node,activeElement:null}
 const {api}=await import('../public/js/core.js')
 globalThis.window={__me:{id:1},addEventListener(){}}
 globalThis.location={hash:'#/contacts'}
 const {contactsView}=await import('../public/js/views/contacts.js')
 api.get=async()=>({contacts:[],tags:['school','repeat']});await contactsView()
 const pending=[];api.get=path=>new Promise(resolve=>pending.push({path,resolve}))
 const first=node('#tag-mode').onchange();node('#tag-mode').value='any';const second=node('#tag-mode').onchange()
 assert.match(pending[1].path,/tag_mode=any/)
 const customer=name=>({contacts:[{id:1,name,tags:[],job_count:0,lifetime_value:0,balance:0}],tags:['school']})
 pending[1].resolve(customer('Current selection'));await second
 pending[0].resolve(customer('Stale selection'));await first
 assert.match(node('#list').innerHTML,/Current selection/);assert.doesNotMatch(node('#list').innerHTML,/Stale selection/)
 const next=node('#tag-mode').onchange();window.__me={id:2};pending[2].resolve(customer('Other shop'));await next
 assert.doesNotMatch(node('#list').innerHTML,/Other shop/)
 node('#list').isConnected=false;await node('#tag-mode').onchange();assert.equal(pending.length,3,'A delayed filter after leaving must not start another request')
})
