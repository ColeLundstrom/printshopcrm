import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {DatabaseSync} from 'node:sqlite'

test('deleted shop identities and retained hosting history are never assigned to a new shop, including after restart',()=>{
  const root=mkdtempSync(join(tmpdir(),'psc-tenant-identity-'))
  const env={...process.env,PSC_DB:join(root,'printshop.db'),PSC_CONTROL_DB:join(root,'control.db')}
  const run=script=>{
    const result=spawnSync(process.execPath,['--no-warnings','--input-type=module','-e',script],{cwd:new URL('..',import.meta.url),env,encoding:'utf8',timeout:30000})
    assert.equal(result.status,0,result.stderr+'\n'+result.stdout)
  }
  try {
    run(`
      import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
      const t=await import('./lib/tenants.mjs');
      const first=await t.createTenant({shop_name:'First fixture',owner_email:'first@example.test',password:'fixture-password-123'});
      const control=new DatabaseSync(process.env.PSC_CONTROL_DB);
      control.prepare("INSERT INTO hosting_checkout_intents(id,tenant_id,account_scope,request_body,request_digest,idempotency_key,plan,interval,amount_cents,currency,state,session_id,created_at,updated_at) VALUES('old-intent',?,'acct_fixture:test','fixture','fixture','old-key','everything','month',14900,'usd','expired','cs_oldShop',1,1)").run(first.id);
      assert.equal(t.deleteTenantFully(first.id).dataRemoved,true);
      const second=await t.createTenant({shop_name:'Second fixture',owner_email:'second@example.test',password:'fixture-password-123'});
      assert.ok(second.id>first.id);assert.equal(t.hostingCheckouts.status(second.id).intent,null);
      assert.equal(t.hostingCheckouts.status(second.id).anomalies.length,0);
      assert.equal(control.prepare("SELECT session_id FROM hosting_checkout_intents WHERE tenant_id=?").get(first.id).session_id,'cs_oldShop');
      assert.equal(t.deleteTenantFully(second.id).dataRemoved,true);
      control.close();
    `)
    run(`
      import assert from 'node:assert/strict';const t=await import('./lib/tenants.mjs');
      const third=await t.createTenant({shop_name:'Restart fixture',owner_email:'third@example.test',password:'fixture-password-123'});
      assert.equal(third.id,3);assert.equal(t.hostingCheckouts.status(third.id).intent,null);
      t.deleteTenantFully(third.id);
    `)
    // Simulate the additive migration on a registry whose only high ID remains in old history.
    const db=new DatabaseSync(env.PSC_CONTROL_DB)
    db.exec('DROP TABLE tenant_identity_sequence')
    db.prepare("INSERT INTO hosting_checkout_anomalies(id,tenant_id,account_scope,code,created_at,updated_at) VALUES('orphan-history',70,'acct_fixture:test','unknown_intent',1,1)").run()
    db.close()
    run(`
      import assert from 'node:assert/strict';const t=await import('./lib/tenants.mjs');
      const next=await t.createTenant({shop_name:'Migrated fixture',owner_email:'migrated@example.test',password:'fixture-password-123'});
      assert.equal(next.id,71);assert.equal(t.hostingCheckouts.status(next.id).intent,null);assert.equal(t.hostingCheckouts.status(next.id).anomalies.length,0);
    `)
  } finally {rmSync(root,{recursive:true,force:true})}
})
