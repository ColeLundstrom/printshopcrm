import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync,readFileSync,writeFileSync,readdirSync,rmSync,existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHttpTestServer } from './helpers/http-test-server.mjs'
import { initBillingRecipientSchema } from '../lib/billing-recipient-schema.mjs'

test('recipient migration preserves known history and new documents inherit once, with deliberate blanks',()=>{
  const db=new DatabaseSync(':memory:')
  try {
    db.exec(`CREATE TABLE schema_migrations(name TEXT PRIMARY KEY);
      CREATE TABLE contacts(id INTEGER PRIMARY KEY,name TEXT,email TEXT);
      CREATE TABLE estimates(id INTEGER PRIMARY KEY,contact_id INTEGER,total REAL);
      CREATE TABLE invoices(id INTEGER PRIMARY KEY,contact_id INTEGER,estimate_id INTEGER,amount_due REAL);
      CREATE TABLE email_log(id INTEGER PRIMARY KEY,contact_id INTEGER,invoice_id INTEGER,to_email TEXT,kind TEXT,delivered INTEGER,sending_at TEXT);
      CREATE TABLE messages(id INTEGER PRIMARY KEY);
      INSERT INTO contacts VALUES(1,'Buyer','buyer@example.test'); INSERT INTO estimates VALUES(1,1,100);
      INSERT INTO invoices VALUES(1,1,1,100); INSERT INTO email_log VALUES
      (1,1,1,'old@example.test','invoice',1,NULL),(2,1,1,'','invoice',0,NULL),
      (3,1,NULL,'old-buyer@example.test','estimate',0,NULL),(4,1,NULL,'reply@example.test','reply',0,NULL),
      (5,1,NULL,'delivered@example.test','estimate',1,NULL);`)
    initBillingRecipientSchema(db)
    const before=db.prepare('SELECT * FROM invoices WHERE id=1').get()
    assert.equal(JSON.parse(before.recipient_snapshot).billing_email,'buyer@example.test')
    assert.equal(before.recipient_source,'legacy_migration')
    assert.equal(db.prepare('SELECT to_email FROM email_log WHERE id=1').get().to_email,'old@example.test')
    assert.equal(db.prepare('SELECT recipient_stale FROM email_log WHERE id=2').get().recipient_stale,1)
    assert.deepEqual({...db.prepare('SELECT to_email,recipient_stale,estimate_id FROM email_log WHERE id=3').get()},{to_email:'old-buyer@example.test',recipient_stale:1,estimate_id:null})
    for(const id of [1,4,5])assert.equal(db.prepare('SELECT recipient_stale FROM email_log WHERE id=?').get(id).recipient_stale,0)
    db.exec("UPDATE contacts SET billing_mode='custom',billing_name='Payables',billing_email='ap@example.test'; INSERT INTO estimates(id,contact_id,total) VALUES(2,1,200)")
    db.exec("UPDATE contacts SET billing_email='later@example.test'; INSERT INTO invoices(id,contact_id,estimate_id,amount_due) VALUES(2,1,2,200)")
    assert.equal(JSON.parse(db.prepare('SELECT recipient_snapshot FROM invoices WHERE id=2').get().recipient_snapshot).billing_email,'ap@example.test')
    assert.deepEqual(db.prepare('SELECT * FROM invoices WHERE id=1').get(),before)
    db.exec("UPDATE contacts SET billing_mode='none'; INSERT INTO invoices(id,contact_id,amount_due) VALUES(3,1,50)")
    assert.equal(JSON.parse(db.prepare('SELECT recipient_snapshot FROM invoices WHERE id=3').get().recipient_snapshot).billing_email,'')
    initBillingRecipientSchema(db)
    assert.deepEqual(db.prepare('SELECT * FROM invoices WHERE id=1').get(),before)
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok')
  } finally {db.close()}
})

test('real sends use saved buyer/AP identities, stale outbox is held, revisions protect edits and money stays with buyer',{timeout:120000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'psc-recipients-')),dest=join(dir,'demo'),capture=join(dir,'smtp.jsonl'),hold=join(dir,'hold'),preload=join(dir,'smtp-fixture.mjs')
  const server=await createHttpTestServer();let db,control
  try {
    const built=spawnSync(process.execPath,['bin/demo.mjs',dest,String(server.port)],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:90000})
    assert.equal(built.status,0,built.stderr)
    const env=JSON.parse(readFileSync(join(dest,'demo-env.json'),'utf8'))
    writeFileSync(capture,'')
    // Replace only the final SMTP transport. The demo's complete network guard stays installed;
    // real sendEmail/template/queue/outbox code runs, without making even a loopback SMTP call.
    writeFileSync(preload,`import nodemailer from ${JSON.stringify(pathToFileURL(join(dest,'node_modules/nodemailer/lib/nodemailer.js')).href)};
      import {appendFileSync,existsSync} from 'node:fs';
      nodemailer.createTransport=()=>({close(){},async sendMail(message){appendFileSync(${JSON.stringify(capture)},JSON.stringify(message)+'\\n');
      while(existsSync(${JSON.stringify(hold)}))await new Promise(r=>setTimeout(r,10)); return {messageId:'fixture-only'};}});`)
    const start=()=>server.start({cwd:dest,env,args:['--no-warnings','--import','./bin/demo-network-guard.mjs','--import',pathToFileURL(preload).href,'server.mjs']})
    await start()
    const login=await fetch(server.base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'dylan@example.test',password:readFileSync(join(dest,'LOGIN.txt'),'utf8').match(/Password: (.+)/)[1]})})
    assert.equal(login.status,200)
    const cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')
    const request=(path,body,method=body===undefined?'GET':'POST',auth=cookie)=>fetch(new URL(path,server.base),{method,redirect:'manual',headers:{'Content-Type':'application/json',Cookie:auth},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)})
    const json=async(path,body,method)=>{const r=await request(path,body,method);assert.equal(r.status,200,await r.clone().text());return r.json()}
    const mails=()=>readFileSync(capture,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    const waitFor=async(fn)=>{for(let n=0;n<200;n++){if(fn())return;await new Promise(r=>setTimeout(r,10))}assert.fail('Fixture event did not arrive')}
    db=new DatabaseSync(join(dest,'data/tenants',readdirSync(join(dest,'data/tenants'))[0],'printshop.db'))
    db.exec('UPDATE automations SET enabled=0')
    await json('/api/settings',{smtp_host:'fixture.invalid',smtp_port:'587',smtp_user:'fixture',smtp_pass:'fixture',smtp_from:'shop@example.test',mode_followups:'manual'},'PUT')
    const buyer=await json('/api/contacts',{name:'Buyer Alice',email:'buyer@example.test',company:'Buyer Company',billing_mode:'custom',billing_name:'Pat Payables',billing_email:'ap@example.test'})
    const shared=await json('/api/contacts',{name:'Other buyer',email:'other@example.test',billing_mode:'custom',billing_email:'ap@example.test'})
    assert.notEqual(buyer.id,shared.id)
    for(const bad of [{billing_email:['bad@example.test']},{billing_email:'a@example.test,b@example.test'},{billing_email:'a@example.test\r\nBcc:x@example.test'},{billing_mode:'maybe'}])assert.equal((await request('/api/contacts/'+buyer.id,bad,'PUT')).status,400)
    const quote=await json('/api/estimates',{contact_id:buyer.id,items:[{description:'Fixture shirts',qty:1,unit_price:100}],tax_rate:0})
    const qpath='/api/estimates/'+quote.id
    await json('/api/contacts/'+buyer.id,{name:'Changed buyer',email:'changed@example.test',billing_email:'changed-ap@example.test'},'PUT')
    let sent=await json(qpath+'/send',{});assert.equal(sent.emailed_to,'buyer@example.test')
    await waitFor(()=>mails().length===1);assert.equal(mails()[0].to,'buyer@example.test');assert.match(mails()[0].text,/Hi Buyer,/)
    const converted=await json(qpath+'/convert',{}),ipath='/api/invoices/'+converted.invoice_id
    let invoice=await json(ipath)
    assert.equal(JSON.parse(invoice.recipient_snapshot).billing_email,'ap@example.test')
    sent=await json(ipath+'/send',{});assert.equal(sent.emailed_to,'ap@example.test')
    await waitFor(()=>mails().length===2);assert.match(mails()[1].text,/Hi Pat,/)
    await json(ipath+'/request-payment',{});await json(ipath+'/nudge',{})
    const drafts=db.prepare('SELECT * FROM email_log WHERE invoice_id=? AND via=\'draft\' ORDER BY id').all(invoice.id)
    assert.equal(drafts.length,2);assert(drafts.every(m=>m.to_email==='ap@example.test' && /Hi Pat,/.test(m.body)))
    await server.stop();await start()
    await json('/api/outbox/'+drafts[0].id+'/send',{})
    await waitFor(()=>mails().length===3);assert.equal(mails()[2].to,'ap@example.test')
    assert.equal((await request('/api/outbox/'+drafts[0].id+'/send',{})).status,409)
    invoice=await json(ipath)
    let edited=await json(ipath+'/recipients',{recipient_revision:invoice.recipient_revision,billing_mode:'custom',billing_name:'Casey Accounts',billing_email:'casey@example.test'},'PUT')
    assert.equal(edited.contact_id,buyer.id)
    assert.equal((await request('/api/outbox/'+drafts[1].id+'/send',{})).status,409)
    assert.equal((await request(ipath+'/recipients',{recipient_revision:invoice.recipient_revision,billing_email:'stale@example.test'},'PUT')).status,409)
    assert.equal((await request(ipath+'/send',{})).status,409,'An old screen cannot send to the newly edited recipient')
    assert.equal((await request(ipath+'/send',{recipient_revision:0})).status,409)
    await json(ipath+'/request-payment',{recipient_revision:edited.recipient_revision})
    const newest=db.prepare('SELECT * FROM email_log WHERE invoice_id=? ORDER BY id DESC LIMIT 1').get(invoice.id)
    assert.equal(newest.to_email,'casey@example.test');assert.match(newest.body,/Hi Casey,/)
    // Direct Send takes the same durable claim as the outbox; an independent DB sees it.
    writeFileSync(hold,'hold');const count=mails().length
    await json(ipath+'/send',{recipient_revision:edited.recipient_revision});await waitFor(()=>mails().length===count+1)
    assert.equal((await request(ipath+'/recipients',{recipient_revision:edited.recipient_revision,billing_mode:'none'},'PUT')).status,409)
    assert.throws(()=>db.prepare('UPDATE invoices SET recipient_snapshot=? WHERE id=?').run('{}',invoice.id),/delivery is in progress/)
    rmSync(hold);await waitFor(()=>!db.prepare('SELECT 1 FROM email_log WHERE invoice_id=? AND sending_at IS NOT NULL').get(invoice.id))
    edited=await json(ipath+'/recipients',{recipient_revision:edited.recipient_revision,billing_mode:'none'},'PUT')
    for(const action of ['send','request-payment','nudge'])assert.equal((await request(ipath+'/'+action,{recipient_revision:edited.recipient_revision})).status,400)
    await json('/api/contacts/'+buyer.id,{billing_mode:'buyer',email:'new-default@example.test'},'PUT')
    assert.equal(JSON.parse((await json(ipath)).recipient_snapshot).billing_mode,'none')
    edited=await json(ipath+'/recipients',{recipient_revision:edited.recipient_revision,billing_mode:'custom',billing_name:'Pat Again',billing_email:'ap@example.test'},'PUT')
    // Stock full-payment automation remains associated with the buyer, even with AP delivery.
    const delayed=[]
    for(const name of ['Stable recipient wait','Changed recipient wait'])delayed.push(await json('/api/automations',{name,trigger:'invoice.paid',actions:[{key:'wait',config:{days:1}},{key:'email.customer',config:{subject:name,body:'Hello {{first_name}} — {{invoice_number}}'}}]}))
    db.prepare("UPDATE automations SET enabled=1 WHERE trigger='invoice.paid'").run()
    await json(ipath+'/payments',{amount:25,method:'check',note:'First installment'})
    assert.equal(db.prepare("SELECT count(*) n FROM email_log WHERE invoice_id=? AND kind='automation'").get(invoice.id).n,0)
    await json(ipath+'/payments',{amount:75,method:'check',note:'Remainder'})
    const thank=db.prepare("SELECT * FROM email_log WHERE invoice_id=? AND kind='automation' ORDER BY id DESC LIMIT 1").get(invoice.id)
    assert.equal(thank.to_email,'ap@example.test');assert.equal(thank.contact_id,buyer.id);assert.match(thank.body,/Hi Pat,/)
    assert.equal((await json(ipath)).amount_paid,100)
    const thread=await json('/api/conversations/'+buyer.id)
    assert(thread.messages.some(m=>m.recipient_email==='ap@example.test'))
    const pdf=Buffer.from(await (await request(ipath+'/pdf')).arrayBuffer()).toString('latin1')
    assert.match(pdf,/Pat Again/);assert.match(pdf,/Buyer Alice/);assert.doesNotMatch(pdf,/new-default@example/)
    const pending=db.prepare('SELECT * FROM automation_pending WHERE automation_id IN (?,?) ORDER BY automation_id').all(...delayed.map(a=>a.id))
    assert.equal(pending.length,2)
    await json('/api/contacts/'+buyer.id,{billing_email:'later-unrelated@example.test'},'PUT')
    db.prepare("UPDATE automation_pending SET due_at=datetime('now','-1 minute') WHERE id=?").run(pending[0].id)
    await json('/api/automations/tick',{})
    const stable=db.prepare('SELECT * FROM email_log WHERE subject=? ORDER BY id DESC LIMIT 1').get('Stable recipient wait')
    assert.equal(stable.to_email,'ap@example.test');assert.match(stable.body,/Hello Pat/)
    edited=await json(ipath+'/recipients',{recipient_revision:edited.recipient_revision,billing_name:'Reviewed AP',billing_email:'reviewed-ap@example.test'},'PUT')
    db.prepare("UPDATE automation_pending SET due_at=datetime('now','-1 minute') WHERE id=?").run(pending[1].id)
    await json('/api/automations/tick',{})
    const held=db.prepare('SELECT * FROM automation_pending WHERE id=?').get(pending[1].id)
    assert.equal(held.status,'recipient_review');assert.match(held.note,/recipients changed/i)
    assert.equal(db.prepare('SELECT count(*) n FROM email_log WHERE subject=?').get('Changed recipient wait').n,0)
    assert.equal((await request('/api/automations/pending/'+held.id+'/resume',{})).status,409)
    const heldView=(await json('/api/automations')).pending.find(p=>p.id===held.id)
    assert.equal(heldView.invoice_id,invoice.id)
    await json('/api/automations/pending/'+held.id,undefined,'DELETE')
    // Upgrade-era pending contexts have no revision. Only a provably identical
    // captured recipient may proceed; a changed historical buyer must be held.
    const legacyQuote=await json('/api/estimates',{contact_id:buyer.id,items:[{description:'Legacy sequence fixture',qty:1,unit_price:5}],tax_rate:0})
    const legacyInvoice=await json('/api/estimates/'+legacyQuote.id+'/convert',{})
    await json('/api/invoices/'+legacyInvoice.invoice_id+'/payments',{amount:5,method:'cash'})
    const legacyPending=db.prepare('SELECT * FROM automation_pending WHERE automation_id IN (?,?) ORDER BY automation_id').all(...delayed.map(a=>a.id))
    assert.equal(legacyPending.length,2)
    for(let n=0;n<legacyPending.length;n++){
      const ctx=JSON.parse(legacyPending[n].ctx);delete ctx.invoice.recipient_revision
      assert.equal(JSON.parse(ctx.invoice.recipient_snapshot).billing_email,ctx.contact.email)
      if(n===1)ctx.contact.email='old-buyer-before-upgrade@example.test'
      db.prepare("UPDATE automation_pending SET ctx=?,due_at=datetime('now','-1 minute') WHERE id=?").run(JSON.stringify(ctx),legacyPending[n].id)
    }
    await json('/api/automations/tick',{})
    assert.equal(db.prepare('SELECT * FROM automation_pending WHERE id=?').get(legacyPending[0].id),undefined)
    const oldHeld=db.prepare('SELECT * FROM automation_pending WHERE id=?').get(legacyPending[1].id)
    assert.equal(oldHeld.status,'recipient_review');assert.match(oldHeld.note,/older sequence/i)
    assert.equal(db.prepare('SELECT count(*) n FROM email_log WHERE invoice_id=? AND subject=?').get(legacyInvoice.invoice_id,'Changed recipient wait').n,0)
    const legacySent=db.prepare('SELECT * FROM email_log WHERE invoice_id=? AND subject=?').get(legacyInvoice.invoice_id,'Stable recipient wait')
    assert.equal(legacySent.to_email,'new-default@example.test')
    const statement=Buffer.from(await (await request('/api/contacts/'+buyer.id+'/statement.pdf')).arrayBuffer()).toString('latin1')
    assert.match(statement,/Buyer Company/);assert.doesNotMatch(statement,/Other buyer/)
    // A quote recipient edit is an explicit revision, with old acceptance/link retained as history.
    const q2=await json('/api/estimates',{contact_id:buyer.id,items:[{description:'Second quote',qty:1,unit_price:12}],tax_rate:0})
    let q=await json('/api/estimates/'+q2.id),oldLink=q.share_url
    await json('/api/estimates/'+q.id+'/approve',{})
    const job=await json('/api/jobs',{contact_id:buyer.id,estimate_id:q.id,title:'AP edits preserve released artwork'})
    const upload=async(suffix,bytes,name,mime,fields={})=>{
      const form=new FormData();for(const [key,value]of Object.entries(fields))form.append(key,String(value));form.append('file',new Blob([bytes],{type:mime}),name)
      const r=await fetch(server.base+'/api/jobs/'+job.id+suffix,{method:'POST',headers:{Cookie:cookie},body:form});assert.equal(r.status,200,await r.clone().text());return r.json()
    }
    const art=await upload('/art','<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="navy"/></svg>','fixture.svg','image/svg+xml')
    await json('/api/art/'+art.id+'/decide',{decision:'approved',by:'Fixture buyer'})
    let production=await json('/api/jobs/'+job.id+'/art-production')
    production=await upload('/art-assets','%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 20 20\nnewpath 0 0 moveto 20 20 lineto stroke\nshowpage\n%%EOF\n','fixture.eps','application/postscript',{revision:production.revision,role:'production'})
    production=await json('/api/jobs/'+job.id+'/art-release',{revision:production.revision,proof_id:art.id,production_asset_ids:[production.production_files[0].id],source_asset_ids:[],specs:{method:'Screen Print',print_width:2,print_height:2,units:'in'},reviewed_confirmed:true})
    assert.equal(production.technical_ready,true)
    const approved=db.prepare('SELECT * FROM estimates WHERE id=?').get(q.id)
    q=await json('/api/estimates/'+q.id+'/recipients',{recipient_revision:q.recipient_revision,billing_mode:'custom',billing_name:'Quote AP',billing_email:'quote-ap@example.test'},'PUT')
    assert.equal(q.status,'approved');assert.equal(q.commercial_revision,approved.commercial_revision);assert.equal(q.share_key,approved.share_key)
    assert.deepEqual(await json('/api/jobs/'+job.id+'/art-production'),production)
    const beforeFailure=db.prepare('SELECT * FROM estimates WHERE id=?').get(q.id),oldHistory=db.prepare('SELECT * FROM document_recipient_history WHERE document_type=\'estimate\' AND document_id=?').all(q.id),oldApprovalHistory=db.prepare('SELECT * FROM estimate_approval_history WHERE estimate_id=?').all(q.id)
    db.exec("CREATE TRIGGER fixture_recipient_history_failure BEFORE INSERT ON document_recipient_history BEGIN SELECT RAISE(ABORT,'fixture history failure'); END")
    try {
      assert.equal((await request('/api/estimates/'+q.id+'/recipients',{recipient_revision:q.recipient_revision,buyer_email:'failed@example.test'},'PUT')).status,500)
      assert.deepEqual(db.prepare('SELECT * FROM estimates WHERE id=?').get(q.id),beforeFailure)
      assert.deepEqual(db.prepare('SELECT * FROM document_recipient_history WHERE document_type=\'estimate\' AND document_id=?').all(q.id),oldHistory)
      assert.deepEqual(db.prepare('SELECT * FROM estimate_approval_history WHERE estimate_id=?').all(q.id),oldApprovalHistory)
      assert.deepEqual(await json('/api/jobs/'+job.id+'/art-production'),production)
    } finally {db.exec('DROP TRIGGER fixture_recipient_history_failure')}
    q=await json('/api/estimates/'+q.id+'/recipients',{recipient_revision:q.recipient_revision,buyer_email:'reviewed@example.test'},'PUT')
    assert.equal(q.status,'draft');assert.equal(q.commercial_revision,1)
    assert.equal((await request(oldLink,undefined,'GET','')).status,403)
    assert.equal(db.prepare('SELECT count(*) n FROM estimate_approval_history WHERE estimate_id=?').get(q.id).n,1)
    assert.equal(db.prepare('SELECT stage FROM opportunities WHERE estimate_id=?').get(q.id).stage,'quoted')
    assert.equal((await request(ipath+'/recipients',{recipient_revision:edited.recipient_revision},'PUT','')).status,401)
    assert.equal((await request('/api/invoices/999999/recipients',{recipient_revision:0},'PUT')).status,404)
    control=new DatabaseSync(join(dest,'data/control.db'))
    const owner=control.prepare('SELECT * FROM members ORDER BY id LIMIT 1').get()
    const staff=Number(control.prepare("INSERT INTO members(tenant_id,name,email,password_hash,role,status) VALUES(?,?,?,?,?,?)").run(owner.tenant_id,'Recipient staff','staff-recipient@example.test',owner.password_hash,'staff','active').lastInsertRowid)
    control.prepare('INSERT INTO sessions(token,tenant_id,member_id,expires_at) VALUES(?,?,?,?)').run('recipient-staff-fixture',owner.tenant_id,staff,new Date(Date.now()+3600000).toISOString().replace('T',' ').slice(0,19))
    assert.equal((await request(ipath+'/recipients',{recipient_revision:edited.recipient_revision,billing_mode:'none'},'PUT','psc_session=recipient-staff-fixture')).status,403)
    const neighbor=await request('/api/auth/signup',{shop_name:'Recipient neighbor',owner_name:'Neighbor',owner_email:'recipient-neighbor@example.test',password:'Recipient-neighbor-password-1'})
    assert.equal(neighbor.status,200)
    const neighborCookie=neighbor.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')
    assert.equal((await request(ipath+'/recipients',{recipient_revision:edited.recipient_revision,billing_mode:'none'},'PUT',neighborCookie)).status,404)
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[])
    assert.equal(db.prepare('SELECT count(*) n FROM contacts WHERE id IN (?,?)').get(buyer.id,shared.id).n,2)
  } finally {
    if(existsSync(hold))rmSync(hold)
    await server.close();db?.close();control?.close();rmSync(dir,{recursive:true,force:true})
  }
})
