import { appRequestAllowed, requestLabel } from './isolation.mjs'

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return{promise,resolve}}

/** Test-only single-response fault, layered above the existing context origin guard. */
export async function duplicateResponseFault(page,base,path,evidence) {
  if(!appRequestAllowed(base,base) || !/^\/api\/estimates\/[1-9]\d*\/duplicate$/.test(path)) throw Error('Expected an exact synthetic duplicate endpoint')
  const target=base+path, pending=new Set(), actions=new Set(), requests=[]
  let armed=null,closing=false
  const errors=evidence.fixtureErrors ||= []
  const record=error=>errors.push(requestLabel(target)+': '+String(error?.message || error))
  const handler=route=>{
    const task=(async()=>{
      let action
      try {
        const request=route.request(),url=request.url()
        if(!appRequestAllowed(url,base) || url!==target) {await route.abort('blockedbyclient');throw Error('Duplicate fault refused a non-fixture URL')}
        if(closing) {await route.abort('aborted');return}
        if(request.method()!=='POST') {await route.fallback();return}
        requests.push(request.postDataJSON())
        action=armed;armed=null
        if(!action) {await route.fallback();return}
        // One exact loopback POST; do not follow a redirect, including a redirected login.
        const response=await route.fetch({maxRedirects:0,timeout:15000})
        if(response.status()!==200) {await route.abort('failed');throw Error('Fixture duplicate did not commit successfully: '+response.status())}
        const body=await response.json()
        action.committed.resolve({body})
        if(action.mode==='delay')await action.release.promise
        if(closing)await route.abort('aborted')
        else if(action.mode==='lose')await route.abort('failed')
        else await route.fulfill({response})
      } catch(error) {
        record(error);action?.committed.resolve({error:String(error?.message||error)})
        try {await route.abort('failed')}catch(abortError){record(abortError)}
      } finally {action?.finished.resolve();if(action)actions.delete(action)}
    })()
    pending.add(task);void task.then(()=>pending.delete(task))
    return task
  }
  await page.route(target,handler)
  return {
    requests,
    arm(mode) {
      if(closing || armed || actions.size || !['lose','delay'].includes(mode))throw Error('Resolve the previous fixture action before arming another')
      const action={mode,committed:deferred(),release:deferred(),finished:deferred()}
      armed=action;actions.add(action)
      return {committed:action.committed.promise,finished:action.finished.promise,release:()=>action.release.resolve()}
    },
    async close() {
      closing=true
      if(armed) {armed.committed.resolve({error:'Fixture closed before request'});armed.finished.resolve();actions.delete(armed);armed=null}
      for(const action of actions)action.release.resolve()
      while(pending.size)await Promise.all([...pending])
      // Removing this test-only interceptor leaves the original context guard installed.
      await page.unroute(target,handler)
    },
  }
}
