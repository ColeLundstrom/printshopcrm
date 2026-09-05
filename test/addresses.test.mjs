import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { postalAddress, postalPatch, initAddressSchema } from '../lib/addresses.mjs'
import { createHttpTestServer } from './helpers/http-test-server.mjs'

function legacyDatabase() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE schema_migrations(name TEXT PRIMARY KEY);
    CREATE TABLE contacts(id INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE estimates(id INTEGER PRIMARY KEY,contact_id INTEGER,total REAL);
    CREATE TABLE invoices(id INTEGER PRIMARY KEY,contact_id INTEGER,estimate_id INTEGER,amount_due REAL);
    CREATE TABLE jobs(id INTEGER PRIMARY KEY,contact_id INTEGER,estimate_id INTEGER,invoice_id INTEGER);
    INSERT INTO contacts VALUES(1,'Original customer'); INSERT INTO contacts VALUES(2,'Other customer');
    INSERT INTO estimates VALUES(1,1,123.45); INSERT INTO invoices VALUES(1,1,1,123.45); INSERT INTO jobs VALUES(1,1,1,1);`)
  return db
}

test('postal migration preserves old documents, snapshots linked/new defaults and rolls back failed upgrades', () => {
  const db = legacyDatabase(), failed = legacyDatabase()
  try {
    failed.exec("CREATE TRIGGER refuse_migration BEFORE INSERT ON schema_migrations BEGIN SELECT RAISE(ABORT,'fixture failure'); END")
    assert.throws(() => initAddressSchema(failed), /fixture failure/)
    assert(!failed.prepare('PRAGMA table_info(contacts)').all().some(c => c.name === 'billing_address'))
    initAddressSchema(db)
    db.exec("UPDATE contacts SET billing_address='Billing original',shipping_address='Warehouse original' WHERE id=1; UPDATE contacts SET billing_address='Other customer billing' WHERE id=2")
    assert.deepEqual({ ...db.prepare('SELECT total,billing_address,shipping_address FROM estimates WHERE id=1').get() }, { total:123.45,billing_address:'',shipping_address:'' })
    db.exec('INSERT INTO estimates(id,contact_id,total) VALUES(2,1,234.56)')
    db.exec("UPDATE contacts SET billing_address='Billing moved',shipping_address='Warehouse moved' WHERE id=1")
    db.exec('INSERT INTO invoices(id,contact_id,estimate_id,amount_due) VALUES(2,1,2,234.56); INSERT INTO jobs(id,contact_id,estimate_id,invoice_id) VALUES(2,1,2,2)')
    assert.equal(db.prepare('SELECT shipping_address FROM jobs WHERE id=2').get().shipping_address,'Warehouse original')
    assert.equal(db.prepare('SELECT billing_address FROM invoices WHERE id=2').get().billing_address,'Billing original')
    db.exec('INSERT INTO invoices(id,contact_id,estimate_id,amount_due) VALUES(3,2,2,1)')
    assert.equal(db.prepare('SELECT billing_address FROM invoices WHERE id=3').get().billing_address,'Other customer billing', 'A mismatched contact cannot inherit somebody else’s address')
    db.exec("INSERT INTO estimates(id,contact_id,total,billing_address,shipping_address) VALUES(3,1,0,'','')")
    db.exec('INSERT INTO invoices(id,contact_id,estimate_id,amount_due) VALUES(4,1,3,0)')
    assert.equal(db.prepare('SELECT shipping_address FROM invoices WHERE id=4').get().shipping_address,'', 'Explicit blank cannot fall back to a customer default')
    const before = db.prepare('SELECT * FROM estimates ORDER BY id').all()
    initAddressSchema(db)
    assert.deepEqual(db.prepare('SELECT * FROM estimates ORDER BY id').all(),before, 'Repeat startup does not rewrite historical documents')
  } finally { db.close(); failed.close() }
})

test('postal validation retains multiline international text and rejects malformed inputs without truncation', () => {
  assert.equal(postalAddress('  20 Rue Exemple\r\n Montréal QC H2X 1Y4\r Canada  '),'20 Rue Exemple\nMontréal QC H2X 1Y4\nCanada')
  for (const bad of [null,{},23,Array(9).fill('line').join('\n'),'a'.repeat(601),'A\u0000B','A\tB']) assert.throws(() => postalAddress(bad), { code:'invalid_address',status:400 })
  assert.deepEqual(postalPatch({shipping_address:''},{billing_address:'Original',shipping_address:'Old'}),{billing_address:'Original',shipping_address:''})
})

test('postal HTTP lifecycle: customer defaults, order snapshots, edits, imports, exports and public documents agree', { timeout:120000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(),'psc-address-http-')), dest = join(tmp,'demo')
  const server = await createHttpTestServer()
  try {
    const built = spawnSync(process.execPath,['bin/demo.mjs',dest,String(server.port)],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:90000})
    assert.equal(built.status,0,built.stderr)
    const env=JSON.parse(readFileSync(join(dest,'demo-env.json'),'utf8'))
    await server.start({cwd:dest,env,args:['--no-warnings','--import','./bin/demo-network-guard.mjs','server.mjs']})
    const login=await fetch(server.base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'dylan@example.test',password:readFileSync(join(dest,'LOGIN.txt'),'utf8').match(/Password: (.+)/)[1]})})
    assert.equal(login.status,200)
    const cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')
    const req=(path,body,method=body===undefined?'GET':'POST')=>fetch(server.base+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)})
    const json=async(path,body,method)=>{const r=await req(path,body,method);assert.equal(r.status,200,await r.clone().text());return r.json()}
    const bill='100 Sample Street\nMontréal QC H2X 1Y4\nCanada', ship='Receiving <Dock>\n200 Sample Road\nAlbany NY 12207'
    const customer=await json('/api/contacts',{name:'Postal fixture',email:'postal@example.test',billing_address:bill,shipping_address:ship})
    assert.equal(customer.billing_address,bill)
    const estimate=await json('/api/estimates',{contact_id:customer.id,items:[{description:'Example tees',sizes:{M:12},unit_price:10}],tax_rate:0})
    assert.equal(estimate.shipping_address,ship)
    const detail=await json('/api/estimates/'+estimate.id)
    const share=new URL(detail.share_url,server.base); const publicPath=share.pathname+share.search
    const quotePage=await fetch(server.base+publicPath)
    const quoteHtml=await quotePage.text();assert.equal(quotePage.status,200)
    assert.match(quoteHtml,/Receiving &lt;Dock&gt;/);assert(quoteHtml.includes(bill));assert(!quoteHtml.includes('Receiving <Dock>'))
    const badDates=await req('/api/estimates/'+estimate.id+'/convert',{payment_due_date:'2027-02-30',production_due_date:'2027-02-12'})
    assert.equal(badDates.status,400)
    assert.equal((await json('/api/estimates/'+estimate.id)).invoice,undefined)
    const converted=await json('/api/estimates/'+estimate.id+'/convert',{payment_due_date:'2027-03-12',production_due_date:'2027-02-12'})
    const invoiceId=converted.invoice_id ?? converted.invoice?.id, jobId=converted.job_id ?? converted.job?.id
    assert(invoiceId && jobId,JSON.stringify(converted))
    assert.equal((await json('/api/invoices/'+invoiceId)).due_date,'2027-03-12')
    assert.equal((await json('/api/jobs/'+jobId)).due_date,'2027-02-12')
    await json('/api/contacts/'+customer.id,{billing_address:'New customer billing',shipping_address:'New customer shipping'},'PUT')
    assert.equal((await json('/api/estimates/'+estimate.id)).billing_address,bill)
    assert.equal((await json('/api/invoices/'+invoiceId)).shipping_address,ship)
    assert.equal((await json('/api/jobs/'+jobId)).shipping_address,ship)
    const invoiceBefore=await json('/api/invoices/'+invoiceId)
    const malformed=await req('/api/invoices/'+invoiceId,{billing_address:{bad:true},po_number:'SHOULD-NOT-SAVE'},'PUT')
    assert.equal(malformed.status,400)
    assert.match((await malformed.json()).error,/Billing address must be text/)
    assert.equal((await json('/api/invoices/'+invoiceId)).po_number,invoiceBefore.po_number)
    await json('/api/invoices/'+invoiceId,{billing_address:'Corrected billing',shipping_address:''},'PUT')
    assert.equal((await json('/api/jobs/'+jobId)).shipping_address,ship,'Invoice address edits do not silently reroute the shipment')
    await json('/api/jobs/'+jobId,{shipping_address:'Rush pickup location'},'PUT')
    await json('/api/jobs/'+jobId,{notes:'Address must survive unrelated edits'},'PUT')
    assert.equal((await json('/api/jobs/'+jobId)).shipping_address,'Rush pickup location')
    assert.equal((await json('/api/production/jobs/'+jobId)).job.shipping_address,'Rush pickup location')
    const paymentDetail=await json('/api/invoices/'+invoiceId), paymentUrl=new URL(paymentDetail.pay_link,server.base)
    const paymentHtml=await(await fetch(server.base+paymentUrl.pathname+paymentUrl.search)).text()
    assert.match(paymentHtml,/Corrected billing/);assert(!paymentHtml.includes('New customer billing'))
    const other=await json('/api/contacts',{name:'Another postal customer',billing_address:'Another billing'})
    const draft=await json('/api/estimates',{contact_id:customer.id,items:[],shipping_address:''})
    assert.equal(draft.shipping_address,'')
    const retargeted=await json('/api/estimates/'+draft.id,{contact_id:other.id},'PUT')
    assert.equal(retargeted.shipping_address,'Another billing')
    const csv='Name,Email,Billing Address 1,Billing Address 2,Billing City,Billing State,Billing Zip,Shipping Address\nCSV postal,csv-postal@example.test,1 Main St,Suite 2,Sampletown,CA,90210,"Dock 4\n2 Other St"'
    const preview=await json('/api/import/contacts',{text:csv,preview:true})
    assert.equal(preview.sample[0].billing_address,'1 Main St\nSuite 2\nSampletown, CA 90210')
    assert.equal(preview.sample[0].shipping_address,'Dock 4\n2 Other St')
    assert.equal((await json('/api/import/contacts',{text:csv})).created,1)
    const imported=(await json('/api/contacts')).contacts.find(c=>c.email==='csv-postal@example.test')
    assert.equal(imported.shipping_address,preview.sample[0].shipping_address)
    const exported=await(await req('/api/export/contacts.csv')).text()
    assert.match(exported,/billing_address,shipping_address/)
    assert(exported.includes('"Dock 4\n2 Other St"'))
    const beforeCount=(await json('/api/contacts')).contacts.length
    const bad=await req('/api/import/contacts',{text:'Name,Email,Address\nBad address,bad-postal@example.test,"'+Array(9).fill('line').join('\n')+'"'})
    assert.equal(bad.status,400)
    assert.match((await bad.json()).error,/8 lines and 600 characters/)
    assert.equal((await json('/api/contacts')).contacts.length,beforeCount)
    const {api_key}=await json('/api/developers/key/rotate',{})
    const api=async(path,body,expected=201)=>{
      const response=await fetch(server.base+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+api_key,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})})
      assert.equal(response.status,expected,await response.clone().text());return response.json()
    }
    const apiCustomer=await api('/customers',{name:'API postal',email:'api-postal@example.test',billing_address:'API billing',shipping_address:'API shipping'})
    assert.equal(apiCustomer.billing_address,'API billing')
    const apiEstimate=await api('/estimates',{customer_id:apiCustomer.id,shipping_address:'Order delivery override',items:[{description:'API tees',quantity:12,unit_price:10}]})
    assert.equal(apiEstimate.billing_address,'API billing');assert.equal(apiEstimate.shipping_address,'Order delivery override')
    assert.equal((await api('/customers/'+apiCustomer.id,undefined,200)).shipping_address,'API shipping')
    const nested=await api('/estimates',{customer:{name:'Nested API postal',email:'nested-postal@example.test',billing_address:'Nested billing'},items:[{description:'Sample',quantity:1,unit_price:10}]})
    assert.equal(nested.shipping_address,'Nested billing')
    const customersBeforeBadApi=(await json('/api/contacts')).contacts.length
    const apiError=await api('/estimates',{customer:{name:'Rejected API postal',email:'reject-postal@example.test',billing_address:{bad:true}},items:[{description:'Sample',quantity:1,unit_price:10}]},400)
    assert.equal(apiError.code,'invalid_address')
    assert.equal((await json('/api/contacts')).contacts.length,customersBeforeBadApi,'Rejected nested addresses cannot leave a customer behind')
  } finally { await server.close(); rmSync(tmp,{recursive:true,force:true}) }
})
