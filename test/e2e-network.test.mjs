import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createE2eDirectory, e2eEnvironment, spawnE2e } from './helpers/e2e-process.mjs'

const cwd = new URL('..', import.meta.url)
const preload = new URL('./fixtures/e2e-network.mjs', import.meta.url).href
function sandbox(t) {
  const dir = createE2eDirectory('fixture')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
async function run(dir, source, overrides = {}) {
  const child = spawnE2e(process.execPath, ['--input-type=module', '-e', source], {
    cwd, env: e2eEnvironment({ PSC_DB: join(dir, 'printshop.db'), ...overrides }), stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { out += bytes })
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000)
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }).finally(() => clearTimeout(timer))
  assert.equal(code, 0, out)
  return out
}

test('E2E child environment never inherits shop configuration, provider credentials or Node preloads', () => {
  const env = e2eEnvironment({ PSC_SECRET: 'synthetic' }, {
    PATH: process.env.PATH, SystemRoot: 'test-os-root', PSC_DB: '/existing/shop.db', PSC_CONTROL_DB: '/existing/control.db',
    PSC_PLATFORM_STRIPE_SECRET: 'live-secret', SMTP_HOST: 'real-mail.test', OPENAI_API_KEY: 'live-key',
    NODE_OPTIONS: '--import=untrusted.mjs', NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://proxy.test', HOME: '/real-home',
  })
  assert.deepEqual(env, { PATH: process.env.PATH, SystemRoot: 'test-os-root', PSC_SECRET: 'synthetic' })
})

test('E2E fixture refuses normal startup and an existing non-synthetic data directory before entrypoint runs', t => {
  const dir = mkdtempSync(join(tmpdir(), 'psc-existing-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const database = join(dir, 'printshop.db'), sentinel = join(dir, 'entrypoint-ran')
  writeFileSync(database, 'existing data must not be opened')
  for (const env of [{}, { PSC_E2E_ROOT: dir, PSC_E2E_TOKEN: 'invented', PSC_DB: database }]) {
    const result = spawnSync(process.execPath, ['--import', preload, '-e', `require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'ran')`], {
      cwd, env: e2eEnvironment(env), encoding: 'utf8', timeout: 5000,
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /synthetic E2E/)
    assert.throws(() => readFileSync(sentinel), { code: 'ENOENT' })
    assert.equal(readFileSync(database, 'utf8'), 'existing data must not be opened')
  }
  assert.throws(() => spawnE2e(process.execPath, ['-e', ''], { env: { PSC_DB: database } }), /synthetic E2E/)
})

test('E2E fixture refuses escaped control databases and symlinked data', t => {
  const dir = sandbox(t), outside = mkdtempSync(join(tmpdir(), 'psc-existing-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  writeFileSync(join(outside, 'shop.db'), 'do not read')
  const call = env => spawnE2e(process.execPath, ['-e', ''], { env: e2eEnvironment({ PSC_DB: join(dir, 'printshop.db'), ...env }) })
  assert.throws(() => call({ PSC_CONTROL_DB: join(outside, 'shop.db') }), /synthetic E2E/)
  symlinkSync(outside, join(dir, 'tenants'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => call({}), /synthetic E2E/)
})

test('synthetic DNS leaves production public/private and rebinding checks intact without real lookups', async t => {
  const dir = sandbox(t)
  await run(dir, `
    import assert from 'node:assert/strict';
    import dns, {lookup as namedLookup} from 'node:dns/promises';
    import callbacks from 'node:dns';
    import {assertPublicUrl,pinnedLookupFor,deliverWebhook} from './lib/webhook.mjs';
    assert.deepEqual((await assertPublicUrl('https://webhook.public.test/hook')).ips,['203.0.113.10']);
    for(const host of ['webhook.private.test','webhook.mixed.test','127.0.0.1','10.0.0.2','169.254.169.254','[::1]'])
      await assert.rejects(assertPublicUrl('https://'+host+'/hook'),/private|not allowed/);
    await assert.rejects(dns.lookup('example.com'),{code:'PSC_E2E_DNS_BLOCKED'});
    await assert.rejects(namedLookup('example.com'),{code:'PSC_E2E_DNS_BLOCKED'});
    await assert.rejects(dns.resolve4('example.com'),{code:'PSC_E2E_DNS_BLOCKED'});
    await assert.rejects(new dns.Resolver().resolve4('example.com'),{code:'PSC_E2E_DNS_BLOCKED'});
    await new Promise(resolve=>callbacks.lookup('webhook.public.test',{all:true},(err,ips)=>{
      assert.equal(err,null);assert.deepEqual(ips,[{address:'203.0.113.10',family:4}]);resolve();
    }));
    const vetted=await assertPublicUrl('https://webhook.rebind.test');
    assert.deepEqual(vetted.ips,['203.0.113.10']);
    const pinned=pinnedLookupFor(vetted.ips[0]);
    await assert.rejects(assertPublicUrl('https://webhook.rebind.test'),/private/);
    pinned('webhook.rebind.test',{all:true},(err,ips)=>{
      assert.equal(err,null);assert.deepEqual(ips,[{address:'203.0.113.10',family:4}]);
    });
    const delivery=await deliverWebhook('https://webhook.public.test/hook',{synthetic:true});
    assert.equal(delivery.ok,false);assert.match(delivery.error,/synthetic E2E/);
  `)
})

test('E2E preloader blocks all outbound transports but permits only a named loopback fixture', async t => {
  const dir = sandbox(t)
  let requests = 0
  const server = createServer((req, res) => {
    requests++
    if (req.url === '/redirect') { res.writeHead(302, { Location: 'https://example.com' }); res.end(); return }
    res.end('local fixture')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const port = server.address().port
  await run(dir, `
    import assert from 'node:assert/strict';
    import net from 'node:net';import tls from 'node:tls';import http,{request as namedRequest} from 'node:http';import https from 'node:https';
    import {execFile} from 'node:child_process';
    const attempts=[()=>fetch('https://example.com'),()=>net.connect(80,'203.0.113.10'),
      ()=>net.createConnection({host:'127.0.0.1',port:${port + 1}}),
      ()=>new net.Socket().connect(25,'mail.test'),()=>tls.connect(443,'example.com'),
      ()=>http.get('http://example.com'),()=>namedRequest('http://example.com'),()=>https.request('https://webhook.public.test'),
      ()=>execFile(process.execPath,['-e','process.exit(0)']),
      ()=>http.request({socketPath:'/tmp/not-an-e2e-fixture'}),()=>net.connect('/tmp/not-an-e2e-fixture')];
    for(const attempt of attempts)await assert.rejects(async()=>attempt(),{code:'PSC_E2E_NETWORK_BLOCKED'});
    assert.equal(await (await fetch('http://127.0.0.1:${port}/')).text(),'local fixture');
    await assert.rejects(fetch('http://127.0.0.1:${port}/redirect'));
    assert.equal(await new Promise((resolve,reject)=>{
      const req=http.get('http://127.0.0.1:${port}/',res=>{let data='';res.on('data',x=>data+=x);res.on('end',()=>resolve(data))});req.on('error',reject);
    }),'local fixture');
  `, { PSC_E2E_LOOPBACK_PORTS: String(port) })
  assert.equal(requests, 3, 'external requests and redirect destinations never reach a fixture')
})

test('the actual pinned-lookup gate ignores ambient HTTP proxies and still rejects the broken callback shape', async t => {
  let proxyRequests = 0
  const proxy = createServer((_req, res) => { proxyRequests++; res.writeHead(502); res.end('wrong destination') })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => proxy.close(resolve)))
  // Run the real gate case, not a second implementation that could pass while the gate drifts.
  const gate = readFileSync(new URL('../bin/gate.mjs', import.meta.url), 'utf8')
  const start = gate.indexOf("await t('Node accepts what pinnedLookupFor returns, on a real socket'")
  const end = gate.indexOf("section('artwork never survives its estimate')", start)
  assert.ok(start > 0 && end > start)
  const child = spawn(process.execPath, ['--input-type=module', '-e', "import assert from 'node:assert/strict';const t=async(_name,fn)=>fn();\n" + gate.slice(start, end)], {
    cwd: new URL('../bin/', import.meta.url),
    env: e2eEnvironment({ NODE_USE_ENV_PROXY: '1', HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`, NO_PROXY: '' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output += bytes })
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000)
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }).finally(() => clearTimeout(timer))
  assert.equal(code, 0, output)
  assert.equal(proxyRequests, 0, 'the lookup under test must reach its controlled local socket directly')
})

test('optional LAN discovery reports denied enumeration without hiding unrelated errors', async () => {
  const { e2eLanAddress } = await import('./helpers/e2e-process.mjs')
  const denied = Object.assign(new Error('interface enumeration denied'), { code: 'ERR_SYSTEM_ERROR', info: { syscall: 'uv_interface_addresses', errno: 1 } })
  assert.deepEqual(e2eLanAddress(() => { throw denied }), { address: null, reason: 'network-interface discovery denied by this runner (errno 1)' })
  assert.deepEqual(e2eLanAddress(() => ({ lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] })), { address: null, reason: 'no non-loopback IPv4 interface on this runner' })
  assert.deepEqual(e2eLanAddress(() => ({ eth: [{ family: 'IPv4', address: '192.0.2.4', internal: false }] })), { address: '192.0.2.4', reason: null })
  assert.throws(() => e2eLanAddress(() => { throw new Error('unexpected bug') }), /unexpected bug/)
})
