import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { writeFixtureJson, readFixtureRecords } from './helpers/json-fixture.mjs'

test('concurrent fixture config publication preserves complete JSON and every provider request', { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'psc-json-fixture-')), config = join(root, 'provider.json'), records = join(root, 'requests')
  mkdirSync(records); writeFixtureJson(config, { revision: 0, payload: '0'.repeat(131072) })
  const helper = new URL('./helpers/json-fixture.mjs', import.meta.url).href
  const script = `
    import assert from 'node:assert/strict';import {join} from 'node:path';
    import {readFixtureJson,writeFixtureJson} from ${JSON.stringify(helper)};
    process.send('ready');
    await new Promise(resolve=>process.once('message',resolve));
    for(let i=0;i<32;i++) {
      const value=readFixtureJson(${JSON.stringify(config)});
      assert.equal(value.payload,String(value.revision).repeat(131072));
      writeFixtureJson(join(${JSON.stringify(records)},String(i).padStart(4,'0')+'.json'),{id:i,revision:value.revision});
      await new Promise(resolve=>setTimeout(resolve,1));
    }
    process.disconnect();
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], timeout: 10000 })
  let output = ''; child.stdout.on('data', text => { output += text }); child.stderr.on('data', text => { output += text })
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })) })
  closed.catch(() => {})
  try {
    await Promise.race([new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject) }), closed.then(() => { throw new Error('Fixture child exited before its ready signal: ' + output) })])
    child.send('start')
    for (let revision = 1; revision <= 32; revision++) {
      writeFixtureJson(config, { revision, payload: String(revision).repeat(131072) })
      for (const record of readFixtureRecords(records)) assert(Number.isInteger(record.revision))
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    const result = await closed
    assert.equal(result.code, 0, output)
    assert.deepEqual(readFixtureRecords(records).map(record => record.id), Array.from({ length: 32 }, (_, i) => i))
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await closed.catch(() => {})
    rmSync(root, { recursive: true, force: true })
  }
})
