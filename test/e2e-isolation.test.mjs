import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {spawn} from 'node:child_process'

test('the E2E harness refuses an occupied port before sending any requests',{timeout:10000},async()=>{
  let requests=0
  const existing=createServer((req,res)=>{requests++;res.end('{"ok":true}')})
  await new Promise(r=>existing.listen(0,'127.0.0.1',r))
  const child=spawn(process.execPath,['bin/gate-e2e.mjs',String(existing.address().port)],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','pipe']})
  let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x)
  try {
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)})
    assert.notEqual(code,0);assert.match(output,/Port .* is occupied/);assert.equal(requests,0)
  } finally {child.kill();await new Promise(r=>existing.close(r))}
})
