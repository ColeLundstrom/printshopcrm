import test from 'node:test'
import assert from 'node:assert/strict'

test('self-hosted billing screen offers the free software without a paid-plan checkout', async () => {
  const nodes = new Map()
  const node = key => { if(!nodes.has(key)) nodes.set(key,{innerHTML:'',textContent:'',addEventListener(){},querySelector:()=>null}); return nodes.get(key) }
  globalThis.document = {querySelector:node}
  globalThis.location = {origin:'http://localhost'}
  const {api} = await import('../public/js/core.js')
  api.get = async path => path==='/api/billing' ? {live:false,plans:{everything:{name:'Everything',monthly:149,annual:1490,features:[]}},order:['everything'],state:{status:'active',subscribed:true}} : {is_admin:false}
  const {billingView} = await import('../public/js/views/billing.js')
  await billingView()
  assert.match(node('#view').innerHTML,/Free and open source/i)
  assert.doesNotMatch(node('#view').innerHTML,/data-plan=|free trial|\$149|Choose Everything/i)
})
