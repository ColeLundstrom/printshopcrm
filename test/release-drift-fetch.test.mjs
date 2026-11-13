import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, cpSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const source = new URL('../deploy/check-drift.sh', import.meta.url)

function fixture(fetchExit) {
  const temp = mkdtempSync(join(tmpdir(), 'psc-drift-fetch-'))
  const root = join(temp, 'repo')
  const remote = join(temp, 'remote.git')
  mkdirSync(root)
  mkdirSync(join(root, 'deploy'))
  cpSync(source, join(root, 'deploy/check-drift.sh'))
  const git = (...args) => {
    const run = spawnSync('git', args, { encoding: 'utf8' })
    assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`)
  }
  git('init', '-b', 'main', root)
  git('init', '--bare', remote)
  git('-C', root, 'add', 'deploy/check-drift.sh')
  git('-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-m', 'fixture')
  git('-C', root, 'remote', 'add', 'origin', remote)
  git('-C', root, 'push', '-u', 'origin', 'main')
  if (fetchExit) git('-C', root, 'remote', 'set-url', 'origin', join(temp, 'missing.git'))
  return { root, temp }
}

for (const [fetchExit, expectedCode, expectedText] of [
  [1, 1, 'could not refresh origin/main'],
  [0, 0, 'GitHub matches this working tree'],
]) {
  test(`release drift check reports fetch exit ${fetchExit}`, () => {
    const { root, temp } = fixture(fetchExit)
    try {
      const run = spawnSync('bash', ['deploy/check-drift.sh'], {
        cwd: root, env: { ...process.env, APP_HOST: '',
          SLACK_WEBHOOK: '', SLACK_TOKEN: '', SLACK_CHANNEL: '' }, encoding: 'utf8',
      })
      assert.equal(run.status, expectedCode, run.stderr + run.stdout)
      assert.match(run.stdout, new RegExp(expectedText))
      assert.doesNotMatch(run.stdout, /local HEAD    \?|origin\/main   \?|could not read git here/)
    } finally { rmSync(temp, { recursive: true, force: true }) }
  })
}
