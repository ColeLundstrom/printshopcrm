import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

for (const [name, result, expected] of [
  ['timeout', { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT', message: 'spawnSync node ETIMEDOUT' }, stdout: '', stderr: '' }, /ETIMEDOUT.*SIGTERM/],
  ['termination', { status: null, signal: 'SIGKILL', stdout: '', stderr: '' }, /SIGKILL/],
  ['nonzero exit', { status: 17, signal: null, stdout: 'fixture startup detail', stderr: 'fixture database failure' }, /exit 17/],
]) {
  test(`demo preparation reports the failed stage and ${name} without leaking environment secrets`, { timeout: 30000 }, () => {
    const temp = mkdtempSync(join(tmpdir(), 'psc-demo-failure-')), dest = join(temp, 'demo'), preload = join(temp, 'failure.mjs')
    try {
      // Reproduce spawnSync's failure result at the real CLI boundary. Nothing runs
      // inside the demo and no application or provider method is replaced.
      writeFileSync(preload, `import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
childProcess.spawnSync=()=>(${JSON.stringify(result)});
syncBuiltinESMExports();\n`)
      const run = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, 'bin/demo.mjs', dest], {
        cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 25000,
        env: { ...process.env, PSC_SECRET: 'fixture-secret-must-not-appear', PSC_PLATFORM_STRIPE_SECRET: 'fixture-private-provider-key' },
      })
      assert.equal(run.status, 1, run.error?.message || run.stderr)
      assert.match(run.stderr, /Demo preparation failed during shop creation/)
      assert.match(run.stderr, expected)
      if (result.stdout) assert.ok(run.stderr.includes(result.stdout))
      if (result.stderr) assert.ok(run.stderr.includes(result.stderr))
      assert.doesNotMatch(run.stdout + run.stderr, /fixture-secret-must-not-appear|fixture-private-provider-key/)
    } finally { rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
  })
}
