import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

test('demo blocks fetch, SMTP sockets and HTTP integrations before they connect', () => {
  const r = spawnSync(process.execPath, ['--import', './bin/demo-network-guard.mjs', '--input-type=module', '-e', `
    import net from 'node:net'; import tls from 'node:tls'; import http from 'node:http'; import https from 'node:https';
    import assert from 'node:assert/strict';
    for (const attempt of [() => fetch('https://example.com'), () => net.connect(25, 'example.com'),
      () => new net.Socket().connect(25, 'example.com'), () => tls.connect(465, 'example.com'),
      () => http.get('http://example.com'), () => https.request('https://example.com')]) {
      await assert.rejects(async () => attempt(), { code: 'PSC_DEMO_NETWORK_BLOCKED' });
    }
    const s = http.createServer((_q,r) => r.end('ok'));
    await new Promise(r => s.listen(0, '127.0.0.1', r));
    assert(s.address().port > 0); await new Promise(r => s.close(r));
  `], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 10000 })
  assert.equal(r.status, 0, r.stderr)
})
