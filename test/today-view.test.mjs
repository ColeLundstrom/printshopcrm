import test from 'node:test'
import assert from 'node:assert/strict'

test('Today uses one summary request and never masks existing jobs with onboarding', async () => {
  const nodes=new Map()
  const node=key=>{if(!nodes.has(key))nodes.set(key,{innerHTML:'',textContent:''});return nodes.get(key)}
  globalThis.document={querySelector:node}
  const {api}=await import('../public/js/core.js')
  globalThis.window={__EDITION:'pro',__me:{shop_name:'Test shop'}}
  const {todayView}=await import('../public/js/views/today.js')
  const calls=[]
  const d={date:'2026-09-15',role:'owner',pulse:{money_at_risk:0,jobs_at_risk:0,approvals:20,due_week:22,overdue_jobs:1},counts:{contacts:1,estimates:1,invoices:0,jobs:1,open:0},actions:[{kind:'floor',title:'Existing job',sub:'Overdue',href:'#/jobs/1'}]}
  // The work queue is one request. The Shop pulse trends load after it, off the critical path, and
  // are the only other read Today may make.
  const ins={weeks:Array.from({length:12},(_,i)=>({start:'2026-07-'+String(1+i).padStart(2,'0'),collected:100*i,won:50*i})),collected_4w:4200,collected_change_pct:12,win_rate_90d:40,open_quotes_90d:3,margin_completed:47.5,margin_target:45,jobs_measured:9}
  api.get=async path=>{calls.push(path);assert.ok(['/api/today','/api/insights'].includes(path),path);return path==='/api/today'?d:ins}
  await todayView(); await new Promise(r=>setTimeout(r,0))
  assert.equal(calls[0],'/api/today'); assert.deepEqual([...new Set(calls)],['/api/today','/api/insights'])
  assert.match(node('#tdy-insights').innerHTML,/Shop pulse/); assert.match(node('#tdy-insights').innerHTML,/47\.5%/)
  assert.match(node('#view').innerHTML,/Existing job/)
  assert.doesNotMatch(node('#view').innerHTML,/Let's get your first job in/)
  assert.match(node('#view').innerHTML,/Due in 7 days.*1 overdue/)
  d.counts.jobs=0;d.actions=[]
  await todayView();assert.match(node('#view').innerHTML,/Let's get your first job in/)
  window.__EDITION='lite';d.counts={contacts:1500,estimates:10,invoices:10,open:2,jobs:0}
  await todayView();assert.match(node('#view').innerHTML,/>1500</);assert.doesNotMatch(node('#view').innerHTML,/href="#\/board"/)
  api.get=async()=>{throw Error('Server unavailable')}
  await assert.rejects(todayView(),/Server unavailable/)
  assert.doesNotMatch(node('#view').innerHTML,/caught up|first job/,'Failed reads must not manufacture an empty shop')
})
