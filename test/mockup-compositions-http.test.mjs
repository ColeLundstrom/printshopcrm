import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { createHash, createHmac } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { deflateSync } from 'node:zlib'

function png(width,height,color=[20,70,110,255]) {
  const chunk = (type,data) => {
    const name = Buffer.from(type), body = Buffer.concat([name,data]), length = Buffer.alloc(4), crc = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    let value = 0xffffffff
    for (const byte of body) { value ^= byte; for(let n=0;n<8;n++) value = (value>>>1) ^ ((value&1)?0xedb88320:0) }
    crc.writeUInt32BE((value^0xffffffff)>>>0)
    return Buffer.concat([length,body,crc])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height,4); ihdr[8]=8; ihdr[9]=6
  const rows = Buffer.alloc((width*4+1)*height)
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) color.forEach((v,c)=>{rows[y*(width*4+1)+1+x*4+c]=v})
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))])
}
const photo = png(4,3), artwork = png(2,2,[220,80,40,150]), proof = png(4,3,[210,160,120,255])
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const recipe = {version:1,renderer:'browser-canvas-v1',sizing_mode:'visual',canvas:{width:4,height:3},placement:{x:0.5,y:0.5,width:0.5,rotation:0}}

test('browser mockup HTTP preserves originals, saves only drafts and safely retries without rendering or outbound providers', {timeout:180000}, async () => {
  // A supported installation may live under ~/.local or another hidden parent directory.
  const root = mkdtempSync(join(tmpdir(),'.psc-mockup-http-')), demo = join(root,'demo'), probe = createServer()
  await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve)); const port = probe.address().port
  await new Promise(resolve=>probe.close(resolve))
  let child
  try {
    const built = spawnSync(process.execPath,['bin/demo.mjs',demo,String(port)],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:90000})
    assert.equal(built.status,0,built.stderr)
    const env = JSON.parse(readFileSync(join(demo,'demo-env.json'),'utf8')); env.PSC_TICK_MS='3600000'
    let logs=''
    child=spawn(process.execPath,['--no-warnings','--import','./bin/demo-network-guard.mjs','server.mjs'],{cwd:demo,env,stdio:['ignore','pipe','pipe']})
    child.stdout.on('data',b=>{logs+=b}); child.stderr.on('data',b=>{logs+=b})
    for(let n=0;n<600 && child.exitCode===null && !logs.includes('(ws /ws live');n++) await new Promise(resolve=>setTimeout(resolve,50))
    assert.match(logs,/ws \/ws live/,logs)
    const base=`http://127.0.0.1:${port}`
    const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'dylan@example.test',password:readFileSync(join(demo,'LOGIN.txt'),'utf8').match(/Password: (.+)/)[1]})})
    assert.equal(login.status,200)
    const cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')
    const req=(path,body,method='POST',auth=cookie)=>fetch(base+path,{method,headers:{Cookie:auth,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})})
    const json=async(path,body,method='POST')=>{const r=await req(path,body,method);assert.equal(r.status,200,await r.clone().text());return r.json()}
    const upload=async(path,bytes,name,fields={})=>{
      const form=new FormData();for(const [k,v]of Object.entries(fields))form.append(k,String(v))
      form.append('file',new Blob([bytes],{type:'image/png'}),name)
      return fetch(base+path,{method:'POST',headers:{Cookie:cookie},body:form})
    }
    const job=await json('/api/jobs',{contact_id:1,title:'Browser mockup HTTP fixture',garment:'Exact fixture tee',decoration:'DTF',quantities:'12 M'})
    const oldUpload=await upload(`/api/jobs/${job.id}/art`,photo,'old-proof.png')
    assert.equal(oldUpload.status,200);const oldProof=await oldUpload.json()
    await json(`/api/art/${oldProof.id}/decide`,{decision:'approved',by:'Fixture customer'})
    const originalState=await json(`/api/jobs/${job.id}/art-production`,undefined,'GET')
    assert.equal(originalState.appearance.approved,true)
    const compose=async({request_id='fixture-request-001',revision=originalState.revision,settings=recipe,photoBytes=photo,artBytes=artwork,proofBytes=proof,ticket,auth=cookie,revisionField='revision',duplicateRevision=false}={})=>{
      const form=new FormData();form.append(revisionField,String(revision));form.append('request_id',request_id);form.append('recipe',JSON.stringify(settings))
      if(duplicateRevision)form.append('revision',String(revision))
      if(ticket)form.append('media_ticket',ticket)
      for(const [field,bytes]of [['photo',photoBytes],['artwork',artBytes],['proof',proofBytes]])form.append(field,new Blob([bytes],{type:'image/png'}),`${field}.png`)
      return fetch(base+`/api/jobs/${job.id}/mockup-compositions`,{method:'POST',headers:{Cookie:auth},body:form})
    }
    const files=()=>readdirSync(join(demo,'public/uploads')).sort()
    const before=files()
    for(const options of [{revisionField:'revision[4294967294]'},{duplicateRevision:true},{revision:'1e0'},{revision:'9007199254740992'}]) {
      const malformed=await compose(options);assert.equal(malformed.status,400,await malformed.clone().text())
      assert.deepEqual(files(),before,'malformed flat-form fields never retain staged uploads')
    }
    const saved=await compose();assert.equal(saved.status,200,await saved.clone().text());const receipt=await saved.json()
    assert.equal(receipt.job_id,job.id);assert.equal(receipt.replayed,false);assert.equal(receipt.version,2)
    let state=await json(`/api/jobs/${job.id}/art-production`,undefined,'GET')
    assert.equal(state.appearance.id,receipt.proof_id);assert.equal(state.appearance.status,'draft');assert.equal(state.appearance.purpose,'appearance_mockup')
    assert.equal(state.appearance.approved,false);assert.equal(state.required,true);assert.equal(state.technical_ready,false)
    assert.equal(state.source_files.length,2);assert.equal(state.production_files.length,0)
    assert.deepEqual(new Set(state.source_files.map(a=>a.sha256)),new Set([hash(photo),hash(artwork)]))
    assert.equal(files().length,before.length+3)
    const afterSave=files()
    for(const source of state.source_files) {
      const downloaded=await req(source.url,undefined,'GET');assert.equal(downloaded.status,200)
      assert.equal(hash(Buffer.from(await downloaded.arrayBuffer())),source.sha256)
      const bare=await fetch(base+'/uploads/'+source.filename,{headers:{Cookie:cookie}})
      assert.equal(bare.status,404,'source bytes never become a public proof upload')
      assert.ok([401,403].includes((await req(source.url,undefined,'GET','')).status),'staff source route requires authentication')
    }
    const retry=await compose();assert.equal(retry.status,200,await retry.clone().text());const repeated=await retry.json()
    assert.equal(repeated.proof_id,receipt.proof_id);assert.equal(repeated.replayed,true)
    assert.deepEqual(files(),afterSave,'exact retry removes its new unowned staged files')
    const changed=await compose({settings:{...recipe,placement:{...recipe.placement,x:0.6}}})
    assert.equal(changed.status,409);assert.deepEqual(files(),afterSave)
    const stale=await compose({request_id:'fixture-request-stale'});assert.equal(stale.status,409);assert.deepEqual(files(),afterSave)
    const wrongCanvas=await compose({request_id:'fixture-bad-canvas',revision:state.revision,settings:{...recipe,canvas:{width:3,height:4}}})
    assert.equal(wrongCanvas.status,400);assert.deepEqual(files(),afterSave)
    const invalidImage=await compose({request_id:'fixture-invalid-image',revision:state.revision,artBytes:Buffer.from('not a raster')})
    assert.equal(invalidImage.status,400);assert.deepEqual(files(),afterSave)
    // A forged ticket is checked after receiving all seven parts, then rejected with no records.
    const forged=await compose({request_id:'fixture-forged-ticket',revision:state.revision,ticket:'not-a-ticket'})
    assert.equal(forged.status,409,await forged.clone().text());assert.equal((await forged.json()).code,'catalog_ticket_invalid');assert.deepEqual(files(),afterSave)
    assert.equal((await json(`/api/jobs/${job.id}/art-production`,undefined,'GET')).revision,state.revision)
    const unavailable=await req('/api/catalog/ss/products/12345/media',undefined,'GET')
    assert.equal(unavailable.status,422);const missingCredentials=await unavailable.json();assert.equal(missingCredentials.code,'catalog_credentials_missing');assert.match(missingCredentials.error,/S&S|connect|account|credentials/i)
    const noHold=await req(`/api/jobs/${job.id}/art-production/require`,{revision:state.revision,required:false})
    assert.ok([400,409].includes(noHold.status))
    assert.equal((await req(`/api/jobs/${job.id}/stage`,{stage:'production'},'PATCH')).status,409)
    await json(`/api/art/${receipt.proof_id}/decide`,{decision:'approved',by:'Fixture customer'})
    state=await json(`/api/jobs/${job.id}/art-production`,undefined,'GET')
    assert.equal(state.appearance.approved,true);assert.equal(state.technical_ready,false)
    const pkg=await json(`/api/jobs/${job.id}/print-package`,undefined,'GET')
    assert.equal(pkg.ready,false);assert.equal(pkg.appearance_approved,true);assert.deepEqual(pkg.production_files,[])
    assert.equal((await req(`/api/jobs/${job.id}/art-release`,{revision:state.revision,proof_id:receipt.proof_id,production_asset_ids:[state.source_files[0].id],source_asset_ids:[],reviewed_confirmed:true,specs:{method:'DTF',print_width:12,print_height:14,units:'in'}})).status,400,'a photo/original source cannot become a prepared machine file')
    const deleted=await req(`/api/jobs/${job.id}/art/${receipt.proof_id}`,undefined,'DELETE');assert.equal(deleted.status,200)
    const afterDelete=files()
    const missing=await compose();assert.equal(missing.status,409)
    assert.equal((await missing.json()).code,'mockup_receipt_unavailable')
    assert.deepEqual(files(),afterDelete,'deleted proof receipt cannot create a replacement under its old request ID')
    // Fixture-sign the same catalog identity with live/expired dates: exercise HTTP replay
    // verification without a supplier call or changing the wall clock of other tests.
    const control=new DatabaseSync(join(demo,'data/control.db'),{readOnly:true})
    const tenant=String(control.prepare('SELECT id FROM tenants LIMIT 1').get().id);control.close()
    const signingKey=createHmac('sha256',env.PSC_SECRET).update('catalog-media-v1').digest('hex')
    const catalogTicket=expired=>{
      const payload={version:1,tenant,supplier:'ssactivewear',sku:'12345',style_id:123,style:'QA tee',brand:'Fixture',color:'Navy',color_code:null,size:'M',view:'front',source_url:'https://www.ssactivewear.com/Images/Color/fixture.png',sha256:hash(photo),fetched_at:Date.now()-7200000,expires_at:Date.now()+(expired?-1000:3600000)}
      const encoded=Buffer.from(JSON.stringify(payload)).toString('base64url')
      return encoded+'.'+createHmac('sha256',signingKey).update('psc-catalog-media-v1.'+encoded).digest('base64url')
    }
    state=await json(`/api/jobs/${job.id}/art-production`,undefined,'GET')
    const catalogRevision=state.revision, catalogRequest='fixture-catalog-receipt'
    const catalogSaved=await compose({request_id:catalogRequest,revision:catalogRevision,ticket:catalogTicket(false)})
    assert.equal(catalogSaved.status,200,await catalogSaved.clone().text());const catalogReceipt=await catalogSaved.json(),catalogFiles=files()
    const expiredReplay=await compose({request_id:catalogRequest,revision:catalogRevision,ticket:catalogTicket(true)})
    assert.equal(expiredReplay.status,200,await expiredReplay.clone().text());const expiredReceipt=await expiredReplay.json()
    assert.equal(expiredReceipt.proof_id,catalogReceipt.proof_id);assert.equal(expiredReceipt.replayed,true);assert.deepEqual(files(),catalogFiles)
    const expiredNew=await compose({request_id:'fixture-expired-new',revision:catalogReceipt.revision,ticket:catalogTicket(true)})
    assert.equal(expiredNew.status,409);assert.equal((await expiredNew.json()).code,'catalog_ticket_expired');assert.deepEqual(files(),catalogFiles)
    assert.doesNotMatch(logs,/external request blocked/i,'manual composition never needed an outbound provider')
  } finally {
    if(child && child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>{const timer=setTimeout(resolve,3000);child.once('exit',()=>{clearTimeout(timer);resolve()})});if(child.exitCode===null)child.kill('SIGKILL')}
    rmSync(root,{recursive:true,force:true})
  }
})
