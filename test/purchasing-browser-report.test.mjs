import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { redact } from './browser/isolation.mjs'

test('purchasing browser report redacts secrets from every serialized field, including isolation errors', () => {
  const source = readFileSync(new URL('./browser/purchasing-smoke.mjs', import.meta.url), 'utf8')
  const finalWrite = source.split('\n').find(line => line.trimStart().startsWith("writeFileSync(join(artifacts, 'purchasing-report.json'),"))
  assert(finalWrite, 'Exercise the actual final report write, not a separate serializer')
  const secrets = ['SYNTHETIC-PASSWORD-123', 'SYNTHETIC-COOKIE-456', 'SYNTHETIC-SECRET-789']
  const report = { error: 'Already redacted [redacted]', scenarios: [{
    networkErrors: ['route error with ' + secrets[0]], blockedRequests: ['request with ' + secrets[1]],
    unexpectedWrites: ['nested fixture ' + secrets[2]], checks: [{ error: secrets.join(' ') }]
  }] }
  let saved
  vm.runInNewContext(finalWrite, { report, secrets, redact, artifacts: '/synthetic', join: (...values) => values.join('/'), writeFileSync: (path, body) => { assert.equal(path, '/synthetic/purchasing-report.json'); saved=body } })
  for(const secret of secrets) assert(!saved.includes(secret), 'No fixture secret may remain in the report')
  const parsed=JSON.parse(saved)
  assert.equal(parsed.scenarios[0].networkErrors[0], 'route error with [redacted]')
  assert.equal(parsed.scenarios[0].checks[0].error, '[redacted] [redacted] [redacted]')
})

test('purchasing browser checks isolation errors recorded during teardown before declaring success', async () => {
  const source = readFileSync(new URL('./browser/purchasing-smoke.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('      await isolation.waitForIdle()')
  const end = source.indexOf('\n  assert.equal(snapshot()', start)
  assert(start > 0 && end > start, 'Exercise the actual scenario verification and teardown tail')
  const context = vm.createContext({ assert })
  vm.runInContext(`
    var scenario={consoleErrors:[],pageErrors:[],blockedRequests:[],networkErrors:[],unexpectedWrites:[]};
    var isolation={async waitForIdle(){},async close(){scenario.networkErrors.push('Synthetic teardown error')}};
    var context={async close(){}};
  `, context)
  const result = vm.runInContext('(async()=>{for(let viewport=0;viewport<1;viewport++){try{\n' + source.slice(start,end) + '\n})()', context)
  await assert.rejects(result, /networkErrors/)
})
