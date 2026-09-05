import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import { createCatalogMedia, catalogMediaUrl, isPublicCatalogAddress, catalogHttpsTransport } from '../lib/catalog-media.mjs'

const SECRET='catalog-media-fixture-secret-only-32-bytes'
const settings={ss_account:'fixture-account',ss_api_key:'fixture-key'}
const sku='B00760004'
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ0YAAAAASUVORK5CYII=','base64')
const product={sku,styleID:39,brandName:'Gildan',styleName:'5000',colorName:'Navy',colorCode:'04',sizeName:'M',
  colorFrontImage:'Images/Color/17130_f_fm.png',colorBackImage:'https://cdn.ssactivewear.com/Images/Color/17130_b_fm.png'}
const response=(body,mime='application/json',status=200,headers={}) => ({status,headers:{'content-type':mime,...headers},body:Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))})
function fixture(options={}) {
  const calls=[],dnsCalls=[]
  let clock=Date.parse('2026-09-04T12:00:00Z')
  const transport=options.transport || (async request => {
    calls.push(request)
    return new URL(request.url).hostname === 'api.ssactivewear.com' ? response(options.rows || [product]) : response(png,'image/png')
  })
  const resolver=options.resolver || {lookup:async (host,args) => { dnsCalls.push({host,args}); return [{address:'8.8.8.8',family:4}] }}
  const service=createCatalogMedia({secret:SECRET,now:()=>clock,...options,transport,resolver})
  return {service,calls,dnsCalls,advance(ms) {clock+=ms},resolve(tenant='shop-a',code=sku) {return service.resolveProduct({tenant,sku:code,settings})}}
}
const errorCode=(code,status) => error => {
  assert.equal(error.code,code)
  if (status) assert.equal(error.status,status)
  assert.equal(error.expose,true); assert.equal(error.catalogSafe,true)
  assert.doesNotMatch(error.message,/fixture-key|fixture-account/)
  return true
}

test('exact SKU uses the published product path, carries actual identity, and downloads original bytes with stable signed provenance',async () => {
  const f=fixture(), selected=await f.resolve('shop-a',' b00760004 ')
  assert.equal(f.calls.length,1)
  assert.equal(f.calls[0].url,`https://api.ssactivewear.com/v2/products/${sku}`)
  assert.equal(f.calls[0].headers.Authorization,`Basic ${Buffer.from('fixture-account:fixture-key').toString('base64')}`)
  assert.equal(selected.sku,sku); assert.equal(selected.style_id,39); assert.equal(selected.brand,'Gildan')
  assert.equal(selected.style,'5000'); assert.equal(selected.color,'Navy'); assert.equal(selected.size,'M')
  assert.deepEqual(selected.views.map(v=>v.view),['front','back'])
  assert.doesNotMatch(JSON.stringify(selected),/https:|fixture-key|Authorization|source_url/)
  const media=await f.service.fetchMedia({tenant:'shop-a',media_id:selected.views[0].media_id})
  assert.deepEqual(media.bytes,png); assert.equal(media.mime,'image/png')
  assert.equal(media.sha256,crypto.createHash('sha256').update(png).digest('hex'))
  assert.equal(f.calls[1].url,'https://www.ssactivewear.com/Images/Color/17130_f_fm.png')
  assert.equal(f.calls[1].headers.Authorization,undefined); assert.equal(f.calls[1].headers.Cookie,undefined)
  assert.equal(f.calls[1].headers['Accept-Encoding'],'identity')
  assert.deepEqual(f.dnsCalls.map(x=>x.host),['api.ssactivewear.com','www.ssactivewear.com'])
  for (const call of f.calls) {
    assert.deepEqual(await new Promise((resolve,reject)=>call.lookup('rebinding-host',{all:true},(error,result)=>error?reject(error):resolve(result))),[{address:'8.8.8.8',family:4}])
    assert.equal(call.signal.aborted,false)
  }
  const verified=f.service.verifyTicket({tenant:'shop-a',ticket:media.ticket,sha256:media.sha256})
  assert.deepEqual(verified,media.provenance)
  assert.deepEqual(Object.keys(verified).sort(),['supplier','sku','style_id','style','brand','color','color_code','size','view','source_url','sha256'].sort())
  assert.equal(verified.view,'front'); assert.equal(verified.color,'Navy')
  f.advance(1000)
  const refreshed=await f.service.fetchMedia({tenant:'shop-a',media_id:selected.views[0].media_id})
  assert.notEqual(media.ticket,refreshed.ticket)
  assert.deepEqual(refreshed.provenance,media.provenance,'ticket refresh does not change the idempotency fingerprint')
  const again=await f.resolve()
  assert.deepEqual(again.views,selected.views,'repeated lookups reuse unexpired identical handles')
  assert.equal(f.service.stats('shop-a').handles,2)
})

test('credentials and explicit tenant are mandatory, with no shared environment credential fallback',async () => {
  const f=fixture()
  await assert.rejects(f.service.resolveProduct({tenant:'shop-a',sku,settings:{}}),errorCode('catalog_credentials_missing',422))
  await assert.rejects(f.service.resolveProduct({sku,settings}),errorCode('catalog_scope_required',400))
  await assert.rejects(f.service.resolveProduct({tenant:'shop-a',sku,settings:{ss_account:'acct:other',ss_api_key:'fixture-key'}}),errorCode('catalog_credentials_invalid'))
  assert.equal(f.calls.length,0)
  assert.throws(()=>createCatalogMedia({secret:'short'}),/at least 32/)
  assert.throws(()=>createCatalogMedia({secret:SECRET,limits:{mediaBytes:11*1024*1024}}),/Invalid catalog media limit/)
})

test('a SKU cannot become a style search, multi-product request, GTIN alias or substituted product',async () => {
  const f=fixture()
  for (const input of ['',`${sku},OTHER`,'Gildan 5000 Navy','../products','https://evil.example/','SKU?style=39','SKU%2cOTHER']) {
    await assert.rejects(f.resolve('shop-a',input),errorCode('catalog_exact_sku_required',400))
  }
  assert.equal(f.calls.length,0)
  for (const rows of [[],[{...product,sku:'OTHER'}],[product,{...product,sku:'OTHER'}],[product,product],{products:[product]}]) {
    const mismatch=fixture({rows})
    await assert.rejects(mismatch.resolve(),errorCode('catalog_sku_mismatch',404))
    assert.equal(mismatch.calls.length,1)
    assert.equal(mismatch.service.stats('shop-a').handles,0)
  }
  await assert.rejects(f.resolve('shop-a','00821780008137'),errorCode('catalog_sku_mismatch',404))
})

test('only exact color/view fields count: no generic style photo, swatch, fuzzy catalog or mediaAssets fallback',async () => {
  const generic={...product,colorFrontImage:'',colorBackImage:'',styleImage:'Images/Style/39_fm.jpg',colorSwatchImage:'Images/ColorSwatch/4_fm.jpg',mediaAssets:[{asset_type:'Style',image:'Images/Style/39_fm.jpg'}]}
  const f=fixture({rows:[generic]})
  await assert.rejects(f.resolve(),errorCode('catalog_views_missing',404))
  assert.equal(f.calls.length,1)
  for (const mutation of [{colorName:''},{styleName:''},{brandName:''},{sizeName:''},{styleID:0}]) {
    await assert.rejects(fixture({rows:[{...product,...mutation}]}).resolve(),errorCode('catalog_identity_missing',502))
  }
  const complete=await fixture({rows:[{...product,colorSideImage:'Images/Color/s.png',colorDirectSideImage:'Images/Color/d.png',colorOnModelFrontImage:'Images/ModelColor/mf.png',colorOnModelBackImage:'Images/ModelColor/mb.png',colorOnModelSideImage:'Images/ModelColor/ms.png'}]}).resolve()
  assert.deepEqual(complete.views.map(v=>v.view),['front','back','side','direct_side','model_front','model_back','model_side'])
  for (const colorCode of ['', '   ', null, undefined]) {
    const blank=fixture({rows:[{...product,colorCode}]})
    const selected=await blank.resolve()
    assert.equal(selected.color_code,null)
    const media=await blank.service.fetchMedia({tenant:'shop-a',media_id:selected.views[0].media_id})
    assert.equal(blank.service.verifyTicket({tenant:'shop-a',ticket:media.ticket,sha256:media.sha256}).color_code,null)
  }
})

test('provider-supplied media URLs cannot select arbitrary hosts, paths, ports, protocols, credentials or redirect endpoints',async () => {
  const attacks=[
    'http://www.ssactivewear.com/Images/Color/f.png','https://user:password@www.ssactivewear.com/Images/Color/f.png',
    'https://www.ssactivewear.com:444/Images/Color/f.png','https://ssactivewear.com.evil.example/Images/Color/f.png',
    'https://unapproved.ssactivewear.com/Images/Color/f.png','https://127.0.0.1/Images/Color/f.png',
    'file:///Images/Color/f.png','data:image/png;base64,AAAA','https://cdn.ssactivewear.com/Images/Color/f.png?url=http://127.0.0.1',
    'https://cdn.ssactivewear.com/Images/Color/f.png#anything','Images/Color/%2e%2e/Style/f.png',
    'Images/Color/../../Images/Color/f.png','Images\\Color\\f.png','Images/Style/39_fm.jpg','Images/ColorSwatch/4_fm.jpg',
    'Images/Color/f.svg','https://api.ssactivewear.com/Images/Color/f.png','Images/Color/a\nb.png',
  ]
  for (const bad of attacks) {
    assert.throws(()=>catalogMediaUrl(bad),errorCode('catalog_media_url_invalid',502),bad)
    const f=fixture({rows:[{...product,colorFrontImage:bad}]})
    await assert.rejects(f.resolve(),errorCode('catalog_media_url_invalid',502))
    assert.equal(f.calls.length,1,'no image transport is attempted for a bad URL')
    assert.equal(f.service.stats('shop-a').handles,0,'invalid URL does not leave partial handles')
  }
  assert.equal(catalogMediaUrl('/Images/Color/F_FM.JPG'),'https://www.ssactivewear.com/Images/Color/F_FM.JPG')
})

test('DNS checks all answers, rejects special-use IPv4 and IPv6, and pins the checked public address',async () => {
  const blocked=['0.0.0.0','10.1.2.3','100.64.0.1','127.0.0.1','169.254.169.254','172.31.255.255','192.168.1.1','192.0.0.1','192.0.2.1','192.88.99.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255','::1','::','::ffff:127.0.0.1','::ffff:7f00:1','fc00::1','fe80::1','ff02::1','2001:db8::1','2001::1','2002:7f00:1::','3fff::1','not-an-ip']
  for (const ip of blocked) {
    assert.equal(isPublicCatalogAddress(ip),false,ip)
    const f=fixture({resolver:{lookup:async()=>[{address:'8.8.8.8'},{address:ip}]}})
    await assert.rejects(f.resolve(),errorCode('catalog_media_address',502))
    assert.equal(f.calls.length,0)
  }
  for (const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111','2001:4860:4860::8888']) assert.equal(isPublicCatalogAddress(ip),true,ip)
  let answers=0
  const f=fixture({resolver:{lookup:async()=>[{address:++answers===1?'8.8.8.8':'127.0.0.1'}]}})
  const selection=await f.resolve()
  await assert.rejects(f.service.fetchMedia({tenant:'shop-a',media_id:selection.views[0].media_id}),errorCode('catalog_media_address',502))
  assert.equal(f.calls.length,1,'media host is resolved and checked separately before any image request')
})

test('redirects and upstream errors fail closed without returning provider bodies or secrets',async () => {
  for (const [status,code] of [[301,'catalog_redirect_refused'],[302,'catalog_redirect_refused'],[307,'catalog_redirect_refused'],[401,'catalog_credentials_rejected'],[403,'catalog_credentials_rejected'],[404,'catalog_not_found'],[500,'catalog_upstream_error']]) {
    let calls=0
    const f=fixture({transport:async()=>{calls++;return response('fixture-key at https://internal','application/json',status,{location:'https://127.0.0.1/private'})}})
    await assert.rejects(f.resolve(),errorCode(code))
    assert.equal(calls,1)
  }
  let calls=0
  const f=fixture({transport:async()=>++calls===1?response([product]):response(png,'image/png',302,{location:'https://cdn.ssactivewear.com/Images/Color/other.png'})})
  const chosen=await f.resolve()
  await assert.rejects(f.service.fetchMedia({tenant:'shop-a',media_id:chosen.views[0].media_id}),errorCode('catalog_redirect_refused',502))
  assert.equal(calls,2,'even allowlisted redirects are not followed')
  const broken=fixture({transport:async()=>{throw new Error('fixture-key at internal provider endpoint')}})
  await assert.rejects(broken.resolve(),errorCode('catalog_unavailable',502))
})

test('both declared and streamed response sizes are bounded; compression and incomplete bytes are refused',async () => {
  for (const make of [()=>response([product],'application/json',200,{'content-length':'1025'}),()=>({...response([]),body:(async function*(){yield Buffer.alloc(600);yield Buffer.alloc(600)})()})]) {
    const f=fixture({limits:{jsonBytes:1024},transport:async()=>make()})
    await assert.rejects(f.resolve(),errorCode('catalog_response_too_large',413))
    assert.equal(f.service.stats('shop-a').active,0)
  }
  for (const bodyResponse of [response(png,'image/png',200,{'content-length':'129'}),{...response(png,'image/png'),body:(async function*(){yield Buffer.alloc(100);yield Buffer.alloc(100)})()}]) {
    let calls=0
    const f=fixture({limits:{mediaBytes:128},transport:async()=>++calls===1?response([product]):bodyResponse})
    const selected=await f.resolve()
    await assert.rejects(f.service.fetchMedia({tenant:'shop-a',media_id:selected.views[0].media_id}),errorCode('catalog_response_too_large',413))
  }
  for (const [headers,code] of [[{'content-encoding':'gzip'},'catalog_response_encoding'],[{'content-length':'900'},'catalog_response_incomplete'],[{'content-length':'bogus'},'catalog_response_too_large']]) {
    const f=fixture({transport:async()=>response([product],'application/json',200,headers)})
    await assert.rejects(f.resolve(),errorCode(code))
  }
})

test('media requires matching raster MIME and valid bounded still-image headers',async () => {
  const huge=Buffer.from(png); huge.writeUInt32BE(4097,16)
  const animation=Buffer.alloc(20); animation.writeUInt32BE(8,0); animation.write('acTL',4); animation.writeUInt32BE(1,8)
  const animated=Buffer.concat([png.subarray(0,33),animation,png.subarray(33)])
  for (const [bytes,mime,code] of [[Buffer.from('<svg/>'),'image/png','catalog_media_format'],[png,'text/html','catalog_media_format'],[png.subarray(0,25),'image/png','catalog_media_format'],[huge,'image/png','catalog_media_format'],[animated,'image/png','catalog_media_dimensions']]) {
    let calls=0
    const f=fixture({transport:async()=>++calls===1?response([product]):response(bytes,mime)})
    const selected=await f.resolve()
    await assert.rejects(f.service.fetchMedia({tenant:'shop-a',media_id:selected.views[0].media_id}),errorCode(code))
  }
})

test('many tiny or empty chunks use a bounded collector and preserve the exact photo digest',async () => {
  let calls=0
  const f=fixture({transport:async()=>++calls===1?response([product]):{
    ...response(png,'image/png'),
    body:(async function*(){ for (const byte of png) { yield Buffer.alloc(0); yield Uint8Array.of(byte) } })(),
  }})
  const selected=await f.resolve()
  const media=await f.service.fetchMedia({tenant:'shop-a',media_id:selected.views[0].media_id})
  assert.deepEqual(media.bytes,png)
  assert.equal(media.sha256,crypto.createHash('sha256').update(png).digest('hex'))
  assert.equal(media.bytes.buffer.byteLength,png.length,'retained photo backing is exactly its byte count, without the collector or a shared slab')
  assert.equal(media.bytes.byteOffset,0)
})

test('opaque handles and signed provenance are tenant-bound, expire, and reject altered photo bytes or signatures',async () => {
  const f=fixture({limits:{handleTtlMs:1000,ticketTtlMs:2000}}), selected=await f.resolve()
  const media=await f.service.fetchMedia({tenant:'shop-a',media_id:selected.views[0].media_id})
  const before=f.calls.length
  await assert.rejects(f.service.fetchMedia({tenant:'shop-b',media_id:selected.views[0].media_id}),errorCode('catalog_handle_expired',404))
  await assert.rejects(f.service.fetchMedia({tenant:'shop-a',media_id:'https://127.0.0.1/private'}),errorCode('catalog_handle_expired',404))
  assert.equal(f.calls.length,before)
  assert.throws(()=>f.service.verifyTicket({tenant:'shop-b',ticket:media.ticket,sha256:media.sha256}),errorCode('catalog_ticket_invalid',409))
  assert.throws(()=>f.service.verifyTicket({tenant:'shop-a',ticket:media.ticket,sha256:'0'.repeat(64)}),errorCode('catalog_ticket_digest_mismatch',409))
  const [body,sig]=media.ticket.split('.')
  const tampered=`${body}.${sig[0]==='a'?'b':'a'}${sig.slice(1)}`
  assert.throws(()=>f.service.verifyTicket({tenant:'shop-a',ticket:tampered,sha256:media.sha256}),errorCode('catalog_ticket_invalid',409))
  for (const ticket of ['', 'invalid', 'a'.repeat(5000)]) assert.throws(()=>f.service.verifyTicket({tenant:'shop-a',ticket,sha256:media.sha256}),errorCode('catalog_ticket_invalid',409))
  const rotated=createCatalogMedia({secret:SECRET+'rotated'})
  assert.throws(()=>rotated.verifyTicket({tenant:'shop-a',ticket:media.ticket,sha256:media.sha256}),errorCode('catalog_ticket_invalid',409))
  f.advance(1000)
  await assert.rejects(f.service.fetchMedia({tenant:'shop-a',media_id:selected.views[0].media_id}),errorCode('catalog_handle_expired',404))
  assert.deepEqual(f.service.verifyTicket({tenant:'shop-a',ticket:media.ticket,sha256:media.sha256}),media.provenance,'signed digest may outlive the lookup handle')
  f.advance(1000)
  assert.throws(()=>f.service.verifyTicket({tenant:'shop-a',ticket:media.ticket,sha256:media.sha256}),errorCode('catalog_ticket_expired',409))
  assert.deepEqual(f.service.verifyTicket({tenant:'shop-a',ticket:media.ticket,sha256:media.sha256,allowExpired:true}),media.provenance,'explicit receipt replay returns exactly the original stable provenance')
  for (const allowExpired of [false,'true',1]) assert.throws(()=>f.service.verifyTicket({tenant:'shop-a',ticket:media.ticket,sha256:media.sha256,allowExpired}),errorCode('catalog_ticket_expired',409))
  assert.throws(()=>f.service.verifyTicket({tenant:'shop-b',ticket:media.ticket,sha256:media.sha256,allowExpired:true}),errorCode('catalog_ticket_invalid',409))
  assert.throws(()=>f.service.verifyTicket({tenant:'shop-a',ticket:tampered,sha256:media.sha256,allowExpired:true}),errorCode('catalog_ticket_invalid',409))
  assert.throws(()=>f.service.verifyTicket({tenant:'shop-a',ticket:media.ticket,sha256:'0'.repeat(64),allowExpired:true}),errorCode('catalog_ticket_digest_mismatch',409))
  assert.throws(()=>f.service.verifyTicket({tenant:'shop-a',ticket:media.ticket,sha256:'invalid',allowExpired:true}),errorCode('catalog_ticket_digest_mismatch',409))
  f.advance(-3000)
  assert.throws(()=>f.service.verifyTicket({tenant:'shop-a',ticket:media.ticket,sha256:media.sha256,allowExpired:true}),errorCode('catalog_ticket_expired',409),'future-issued tickets remain invalid even in receipt replay mode')
  f.advance(3000)
  assert.equal(f.service.stats('shop-a').handles,0)
})

test('handle count and metadata byte budgets are atomic, per-tenant and global, and expired handles reclaim capacity',async () => {
  const f=fixture({limits:{handles:4,tenantHandles:2,handleTtlMs:1000}})
  const a=await f.resolve(),b=await f.resolve('shop-b')
  assert.notEqual(a.views[0].media_id,b.views[0].media_id)
  await assert.rejects(f.resolve('shop-c'),errorCode('catalog_handle_limit',429))
  assert.equal(f.service.stats('shop-c').handles,4)
  assert.equal(f.service.stats('shop-c').tenantHandles,0)
  f.service.clearTenant('shop-a')
  assert.equal(f.service.stats('shop-a').handles,2)
  await f.resolve('shop-c')
  f.advance(1000)
  await f.resolve('shop-d')
  assert.equal(f.service.stats('shop-d').handles,2)
  for (const limits of [{tenantHandles:1},{handles:1},{tenantHandleBytes:200},{handleBytes:200}]) {
    const limited=fixture({limits})
    await assert.rejects(limited.resolve(),errorCode('catalog_handle_limit',429))
    assert.equal(limited.service.stats('shop-a').handles,0,'no partial product views remain after a budget refusal')
  }
})

test('global and per-shop concurrency bounds reject excess work without queuing',async () => {
  const pending=[]
  let calls=0
  const f=fixture({limits:{concurrency:2,tenantConcurrency:1},transport:()=>{calls++;return new Promise(resolve=>pending.push(resolve))}})
  const first=f.resolve()
  await new Promise(resolve=>setImmediate(resolve))
  await assert.rejects(f.resolve(),errorCode('catalog_busy',429))
  const second=f.resolve('shop-b')
  await new Promise(resolve=>setImmediate(resolve))
  await assert.rejects(f.resolve('shop-c'),errorCode('catalog_busy',429))
  assert.equal(calls,2); assert.equal(f.service.stats('shop-a').active,2)
  pending.forEach(resolve=>resolve(response([product])))
  await Promise.all([first,second])
  assert.equal(f.service.stats('shop-a').active,0)
})

test('one wall-clock deadline covers DNS, transport and streamed body; late DNS cannot initiate a connection',async () => {
  let resolveDns
  const late=fixture({limits:{timeoutMs:20},resolver:{lookup:()=>new Promise(resolve=>{resolveDns=resolve})}})
  await assert.rejects(late.resolve(),errorCode('catalog_timeout',504))
  resolveDns([{address:'8.8.8.8'}])
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(late.calls.length,0)
  let signal
  const hung=fixture({limits:{timeoutMs:20},transport:request=>{signal=request.signal;return new Promise(()=>{})}})
  await assert.rejects(hung.resolve(),errorCode('catalog_timeout',504))
  assert.equal(signal.aborted,true)
  let destroyed=false
  const body={async *[Symbol.asyncIterator](){yield Buffer.from('[');await new Promise(()=>{})},destroy(){destroyed=true}}
  const streaming=fixture({limits:{timeoutMs:20},transport:async()=>({...response([]),body})})
  await assert.rejects(streaming.resolve(),errorCode('catalog_timeout',504))
  assert.equal(destroyed,true)
})

test('default HTTPS transport keeps the original host for TLS and uses only the supplied pinned lookup',async t => {
  let observed
  t.mock.method(https,'request',(url,options,callback)=>{
    observed={url,options}
    const request=new EventEmitter()
    request.end=()=>callback({statusCode:200,headers:{'content-type':'image/png'},[Symbol.asyncIterator]:async function*(){yield png}})
    return request
  })
  const lookup=()=>{},signal=new AbortController().signal
  const result=await catalogHttpsTransport({url:'https://cdn.ssactivewear.com/Images/Color/f.png',headers:{Accept:'image/png'},lookup,signal})
  assert.equal(observed.url,'https://cdn.ssactivewear.com/Images/Color/f.png')
  assert.equal(observed.options.lookup,lookup); assert.equal(observed.options.signal,signal)
  assert.equal(observed.options.method,'GET'); assert.equal(observed.options.agent,false)
  assert.equal(observed.options.maxHeaderSize,16*1024)
  assert.equal(observed.options.rejectUnauthorized,undefined,'Node default certificate and hostname validation remains enabled')
  assert.equal(result.status,200)
})
