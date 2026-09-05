import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, createConnection } from 'node:net'
import { once } from 'node:events'
import { createHttpTestServer } from './helpers/http-test-server.mjs'

// A tiny real HTTP process exercises only the test helper. The adjacent hosting suites
// independently run the unchanged application and its guarded synthetic Stripe provider.
const app = `import http from 'node:http';
const server=http.createServer((req,res)=>{res.writeHead(503,{'Content-Type':'text/plain'});res.end('actual-upstream-unready:'+process.pid)});
process.on('SIGTERM',()=>{console.log('(ws /ws live shutdown log must not restore routing');if(!process.env.IGNORE_TERM)server.close(()=>process.exit(0))});
server.listen(process.env.PORT,process.env.PSC_HOST,()=>console.log('(ws /ws live'));
`
async function fixture(t, code=app) {
  const cwd=mkdtempSync(join(tmpdir(),'psc-http-helper-'))
  writeFileSync(join(cwd,'server.mjs'),code)
  const server=await createHttpTestServer()
  t.after(async()=>{await server.close();rmSync(cwd,{recursive:true,force:true})})
  return {server,start:extra=>server.start({cwd,env:{...process.env,PSC_DEMO:'1',...extra}})}
}
async function rivalListener(t,port) {
  let routed=0
  const rival=createServer(socket=>{routed++;socket.end('HTTP/1.1 200 OK\r\nContent-Length:16\r\nConnection:close\r\n\r\nforeign-listener')})
  await new Promise((resolve,reject)=>{rival.once('error',reject);rival.listen(port,'127.0.0.1',resolve)})
  t.after(()=>new Promise(resolve=>rival.close(resolve)))
  return ()=>routed
}
async function noForwardedBytes(server) {
  const socket=createConnection({host:'127.0.0.1',port:server.port})
  const bytes=[]
  socket.on('data',data=>bytes.push(data))
  socket.on('error',error=>assert.ok(['ECONNRESET','EPIPE'].includes(error.code),error.message))
  const closed=new Promise(resolve=>socket.once('close',resolve))
  socket.once('connect',()=>socket.write('GET /health HTTP/1.1\r\nHost:127.0.0.1\r\nConnection:close\r\n\r\n'))
  await closed
  assert.equal(Buffer.concat(bytes).length,0,'an unavailable upstream never receives a synthetic healthy response')
}

test('gateway owns its port, forwards the real health failure and releases its listener on teardown',{timeout:15000},async t=>{
  const {server,start}=await fixture(t),child=await start()
  assert.ok(child.port>0);assert.notEqual(child.port,server.port)
  await server.assertPortOwned()
  const response=await fetch(server.base+'/health')
  assert.equal(response.status,503);assert.equal(await response.text(),'actual-upstream-unready:'+child.pid)
  await server.close()
  const replacement=createServer()
  await new Promise((resolve,reject)=>{replacement.once('error',reject);replacement.listen(server.port,'127.0.0.1',resolve)})
  await new Promise(resolve=>replacement.close(resolve))
})

test('shutdown logs cannot forward to a rival on the old backend and restart keeps the public origin',{timeout:15000},async t=>{
  const {server,start}=await fixture(t),first=await start(),base=server.base
  assert.equal((await fetch(base+'/health')).status,503)
  const stopped=await server.stop();assert.equal(stopped.pid,first.pid)
  if(process.platform==='win32')assert.equal(stopped.signal,'SIGTERM')
  else assert.equal(stopped.code,0)
  const routed=await rivalListener(t,first.port)
  await server.assertPortOwned();await noForwardedBytes(server);assert.equal(routed(),0)
  const second=await start()
  assert.notEqual(second.pid,first.pid);assert.notEqual(second.port,first.port,'the occupied old backend cannot collide with PORT=0')
  assert.equal(server.base,base)
  const response=await fetch(base+'/health')
  assert.equal(response.status,503);assert.equal(await response.text(),'actual-upstream-unready:'+second.pid)
  assert.equal(routed(),0)
})

test('unexpected child death immediately disconnects forwarding before a rival occupies its old port',{timeout:15000},async t=>{
  const {server,start}=await fixture(t),first=await start(),child=server.child
  await (await fetch(server.base+'/health')).text()
  const closed=once(child,'close');child.kill('SIGKILL');await closed
  const routed=await rivalListener(t,first.port)
  await noForwardedBytes(server);assert.equal(routed(),0)
  const stopped=await server.stop();assert.equal(stopped.signal,'SIGKILL')
  const second=await start();assert.notEqual(second.pid,first.pid)
  assert.equal((await fetch(server.base+'/health')).status,503);assert.equal(routed(),0)
})

test('a startup banner without a real listener cannot pass readiness and cleanup waits for child close',{timeout:15000},async t=>{
  const {server,start}=await fixture(t,"console.log('(ws /ws live');process.exit(17)\n")
  await assert.rejects(start(),/closed before startup/)
  assert.equal(server.child,null)
  await server.assertPortOwned();await noForwardedBytes(server)
})

test('stop fully closes a child even when graceful termination is unavailable',{timeout:15000},async t=>{
  const {server,start}=await fixture(t),first=await start({IGNORE_TERM:'1'})
  const stopped=await server.stop()
  // Node's Windows signal emulation terminates immediately; POSIX must escalate the
  // deliberately ignored SIGTERM. Both paths must report the actual child close.
  // https://nodejs.org/api/process.html#signal-events
  assert.equal(stopped.pid,first.pid);assert.equal(stopped.signal,process.platform==='win32'?'SIGTERM':'SIGKILL')
  assert.equal(server.child,null);await server.assertPortOwned();await noForwardedBytes(server)
})

test('inherited test preloads leave real worker threads and their own listeners untouched',{timeout:15000},async t=>{
  const workerCode="import http from 'node:http';import {parentPort} from 'node:worker_threads';const s=http.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>parentPort.postMessage(p))})"
  const code="import {Worker} from 'node:worker_threads';const w=new Worker(new URL('data:text/javascript,'+encodeURIComponent("+JSON.stringify(workerCode)+")));await new Promise((resolve,reject)=>{w.once('error',reject);w.once('message',port=>port>0?resolve():reject(Error('worker did not bind')))});\n"+app
  const {server,start}=await fixture(t,code),child=await start()
  const response=await fetch(server.base+'/health')
  assert.equal(response.status,503);assert.equal(await response.text(),'actual-upstream-unready:'+child.pid)
})
