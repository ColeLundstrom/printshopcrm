import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const source = new URL('../deploy/check-drift.sh', import.meta.url)

function fixture(fetchExit) {
  const root = mkdtempSync(join(tmpdir(), 'psc-drift-fetch-'))
  mkdirSync(join(root, 'deploy'))
  mkdirSync(join(root, 'bin'))
  cpSync(source, join(root, 'deploy/check-drift.sh'))
  writeFileSync(join(root, 'bin/git'), `#!/bin/sh
case "$1" in
  fetch) exit ${fetchExit} ;;
  rev-parse) case "$*" in *origin/main*) echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;; *) echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;; esac ;;
  status) exit 0 ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 })
  return root
}

for (const [fetchExit, expectedCode, expectedText] of [
  [1, 1, 'could not refresh origin/main'],
  [0, 0, 'GitHub matches this working tree'],
]) {
  test(`release drift check reports fetch exit ${fetchExit}`, () => {
    const root = fixture(fetchExit)
    try {
      const run = spawnSync('bash', ['deploy/check-drift.sh'], {
        cwd: root, env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, APP_HOST: '',
          SLACK_WEBHOOK: '', SLACK_TOKEN: '', SLACK_CHANNEL: '' }, encoding: 'utf8',
      })
      assert.equal(run.status, expectedCode, run.stderr + run.stdout)
      assert.match(run.stdout, new RegExp(expectedText))
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}
