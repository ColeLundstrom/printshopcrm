import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {createAgentAccess,requiredAgentScope} from '../lib/agent-access.mjs'
test('agent keys store hashes, expire, revoke independently and follow current shop/member state',()=>{
  const db=new DatabaseSync(':memory:');db.exec("PRAGMA foreign_keys=ON; CREATE TABLE tenants(id INTEGER PRIMARY KEY,status TEXT); CREATE TABLE members(id INTEGER PRIMARY KEY,tenant_id INTEGER,status TEXT,role TEXT,name TEXT); INSERT INTO tenants VALUES(1,'active'),(2,'active'); INSERT INTO members VALUES(1,1,'active','owner','Owner'),(2,2,'active','owner','Neighbor')")
  const api=createAgentAccess(db),body={name:'Assistant',expires_days:90,scopes:['jobs:read']}
  const a=api.create(1,1,body),b=api.create(1,1,{...body,name:'Other assistant'})
  assert.equal(api.resolve(a.token).tenant.id,1)
  assert.equal(api.resolve(a.token).member.id,1)
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM agent_keys').all()).includes(a.token))
  assert.ok(!JSON.stringify(api.list(1)).includes('token_hash'))
  assert.throws(()=>api.create(1,2,body),/active owner/)
  assert.throws(()=>api.create(1,1,{...body,scopes:['settings:write']}),/supported permission/)
  assert.throws(()=>api.create(1,1,{...body,expires_days:0}),/Expiry/)
  assert.throws(()=>api.revoke(2,a.key.id),/not found/)
  assert.throws(()=>api.audit(2,a.key.id),/not found/)
  api.record(a.key.id,'GET','/api/v1/jobs',200);assert.equal(api.audit(1,a.key.id)[0].status,200)
  api.revoke(1,a.key.id);assert.equal(api.resolve(a.token),null);assert.ok(api.resolve(b.token))
  db.prepare("UPDATE members SET role='staff' WHERE id=1").run();assert.equal(api.resolve(b.token),null)
  db.prepare("UPDATE members SET role='owner' WHERE id=1").run()
  db.prepare("UPDATE tenants SET status='suspended' WHERE id=1").run();assert.equal(api.resolve(b.token),null)
  db.prepare("UPDATE tenants SET status='active' WHERE id=1").run()
  db.prepare("UPDATE agent_keys SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(b.key.id);assert.equal(api.resolve(b.token),null)
  assert.equal(requiredAgentScope('GET','/API/v1/jobs/12/'),'jobs:read')
  assert.equal(requiredAgentScope('POST','/api/v1/jobs/12/tasks/2/action'),'production:write')
  assert.equal(requiredAgentScope('GET','/api/v1/webhooks'),null)
  assert.equal(requiredAgentScope('DELETE','/api/v1/jobs/12'),null)
  assert.equal(requiredAgentScope('POST','/api/v1/estimates/12/send'),null)
  db.close()
})
