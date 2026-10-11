import test from 'node:test'
import assert from 'node:assert/strict'
import { duplicateResponseFault } from './browser/duplicate-response-fault.mjs'

const base='http://127.0.0.1:4380',path='/api/estimates/7/duplicate'
function fixture() {
  let handler,removed=false
  const page={route:async(url,fn)=>{assert.equal(url,base+path);handler=fn},unroute:async(url,fn)=>{assert.equal(url,base+path);assert.equal(fn,handler);removed=true}}
  const evidence={},calls=[]
  const route=(options={})=>({request:()=>({url:()=>options.url||base+path,method:()=>options.method||'POST',postDataJSON:()=>({request_id:'synthetic-fixture'})}),
    fallback:async()=>calls.push('fallback'),fetch:async settings=>{calls.push(['fetch',settings]);if(options.failFetch)throw Error('Fixture transport failed');return{status:()=>options.status||200,json:async()=>({id:9,estimate_number:'EST-9'})}},
    abort:async reason=>{calls.push(['abort',reason]);if(options.failAbort)throw Error('Fixture abort failed')},fulfill:async()=>{calls.push('fulfill');if(options.failFulfill)throw Error('Fixture fulfill failed')}})
  return{page,evidence,calls,route,run:r=>handler(r),removed:()=>removed}
}
test('a lost synthetic duplicate response commits once then aborts; later retry falls through to the base guard',async()=>{
  const f=fixture(),fault=await duplicateResponseFault(f.page,base,path,f.evidence),action=fault.arm('lose')
  await f.run(f.route());assert.deepEqual(await action.committed,{body:{id:9,estimate_number:'EST-9'}});await action.finished
  assert.deepEqual(f.calls,[['fetch',{maxRedirects:0,timeout:15000}],['abort','failed']])
  await f.run(f.route());assert.equal(f.calls.at(-1),'fallback');assert.equal(fault.requests.length,2)
  await fault.close();assert(f.removed());assert.deepEqual(f.evidence.fixtureErrors,[])
})
test('delayed responses release or drain on close without removing the context guard',async()=>{
  for(const close of [false,true]) {
    const f=fixture(),fault=await duplicateResponseFault(f.page,base,path,f.evidence),action=fault.arm('delay'),running=f.run(f.route())
    await action.committed;assert.equal(f.calls.length,1)
    if(close)await fault.close();else{action.release();await action.finished;await fault.close()}
    await running;assert.deepEqual(f.calls.at(-1),close?['abort','aborted']:'fulfill');assert.deepEqual(f.evidence.fixtureErrors,[])
  }
})
test('fault fixtures reject non-loopback destinations, other routes and redirects without following them',async()=>{
  const f=fixture()
  await assert.rejects(duplicateResponseFault(f.page,'https://example.test',path,f.evidence),/exact synthetic/)
  await assert.rejects(duplicateResponseFault(f.page,base,'/api/payments',f.evidence),/exact synthetic/)
  const fault=await duplicateResponseFault(f.page,base,path,f.evidence)
  await f.run(f.route({url:'https://example.test/api/estimates/7/duplicate'}))
  assert(!f.calls.some(c=>Array.isArray(c)&&c[0]==='fetch'))
  const action=fault.arm('lose');await f.run(f.route({status:302}));assert.match((await action.committed).error,/302/)
  assert.equal(f.calls.filter(c=>Array.isArray(c)&&c[0]==='fetch').length,1);await fault.close()
  assert.equal(f.evidence.fixtureErrors.length,2)
})
test('fault callbacks record and drain fetch, fulfill and abort errors instead of escaping rejection',async()=>{
  for(const options of [{failFetch:true},{failFulfill:true},{failAbort:true}]) {
    const f=fixture(),fault=await duplicateResponseFault(f.page,base,path,f.evidence),action=fault.arm(options.failAbort?'lose':'delay')
    action.release();await assert.doesNotReject(f.run(f.route(options)));await action.finished;await fault.close()
    assert(f.evidence.fixtureErrors.length>0)
  }
})
