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
  api.get=async path=>{calls.push(path);assert.equal(path,'/api/today');return d}
  await todayView(); assert.deepEqual(calls,['/api/today']); assert.match(node('#view').innerHTML,/Existing job/)
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
