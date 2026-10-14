import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createE2eDirectory, e2eEnvironment, spawnE2e } from './helpers/e2e-process.mjs'

const repo = resolve(import.meta.dirname, '..')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const linkType = process.platform === 'win32' ? 'junction' : 'dir'

async function availablePort() {
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  return port
}

test('a disposable self-host shop survives a release switch and a code/data rollback', { timeout: 120_000 }, async () => {
  const data = createE2eDirectory('release-rehearsal')
  const install = mkdtempSync(join(tmpdir(), 'psc-release-rehearsal-'))
  const uploads = join(data, 'uploads')
  const releases = join(install, 'releases')
  const current = join(install, 'current')
  const backup = join(data, 'backups', 'before-update')
  const port = await availablePort()
  const base = `http://127.0.0.1:${port}`
  const password = 'SyntheticOnly-123456'
  let child
  let log = ''

  const stop = async () => {
    if (!child) return
    const running = child
    child = null
    if (running.exitCode === null) {
      const exited = once(running, 'exit')
      running.kill('SIGTERM')
      await exited
    }
  }
  const activate = name => {
    if (existsSync(current)) rmSync(current)
    symlinkSync(join(releases, name), current, linkType)
    assert.equal(realpathSync(current), realpathSync(join(releases, name)))
  }
  const request = async (method, path, { body, cookie } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    let json
    try { json = await response.json() } catch { json = null }
    return { status: response.status, json, cookie: response.headers.getSetCookie?.()[0]?.split(';')[0] }
  }
  const boot = async () => {
    log = ''
    child = spawnE2e(process.execPath, ['--no-warnings', join(current, 'server.mjs')], {
      cwd: current,
      env: e2eEnvironment({
        PSC_DB: join(data, 'printshop.db'), PSC_AUTH: '1', PSC_SECRET: 'synthetic-release-secret',
        PSC_HOST: '127.0.0.1', PSC_PUBLIC_URL: base, PORT: String(port),
        PSC_E2E_LOOPBACK_PORTS: String(port),
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', chunk => { log += chunk })
    child.stderr.on('data', chunk => { log += chunk })
    for (let attempt = 0; attempt < 120; attempt++) {
      if (child.exitCode !== null) throw Error(`synthetic server exited ${child.exitCode}: ${log.slice(-1500)}`)
      try {
        const health = await request('GET', '/health?strict=1')
        if (health.status === 200 && health.json?.ok) return
      } catch { /* server is starting */ }
      await pause(250)
    }
    throw Error(`synthetic server did not start: ${log.slice(-1500)}`)
  }
  const login = async () => {
    const response = await request('POST', '/api/auth/login', {
      body: { email: 'owner@release-rehearsal.test', password },
    })
    assert.equal(response.status, 200)
    assert.ok(response.cookie?.startsWith('psc_session='))
    return response.cookie
  }

  try {
    mkdirSync(uploads)
    mkdirSync(releases)
    // Both directories contain the same candidate. This rehearses storage and rollback layout,
    // not compatibility between two different application versions.
    for (const name of ['candidate-a', 'candidate-b']) {
      const release = join(releases, name)
      mkdirSync(release)
      for (const file of ['server.mjs', 'package.json']) cpSync(join(repo, file), join(release, file))
      for (const dir of ['lib', 'bin', 'public']) cpSync(join(repo, dir), join(release, dir), { recursive: true })
      rmSync(join(release, 'public', 'uploads'), { recursive: true, force: true })
      symlinkSync(uploads, join(release, 'public', 'uploads'), linkType)
      symlinkSync(join(repo, 'node_modules'), join(release, 'node_modules'), linkType)
    }

    activate('candidate-a')
    await boot()
    assert.equal((await request('GET', '/api/contacts')).status, 401)
    const signup = await request('POST', '/api/auth/signup', {
      body: { shop_name: 'Release Rehearsal', owner_name: 'Fixture Owner',
        owner_email: 'owner@release-rehearsal.test', password },
    })
    assert.equal(signup.status, 200)
    const firstCookie = signup.cookie || await login()
    const first = await request('POST', '/api/contacts', { cookie: firstCookie,
      body: { name: 'Before Update', email: 'first@release-rehearsal.test' } })
    assert.equal(first.status, 200)
    writeFileSync(join(uploads, 'proof.txt'), 'art before update')

    const snapshot = spawnSync(process.execPath,
      ['--no-warnings', join(current, 'bin', 'snapshot.mjs'), data, backup], { encoding: 'utf8' })
    assert.equal(snapshot.status, 0, snapshot.stderr)
    cpSync(uploads, join(backup, 'uploads'), { recursive: true })
    assert.ok(existsSync(join(backup, 'control.db')))
    assert.ok(readdirSync(backup).some(name => /^tenants__.+__printshop\.db$/.test(name)),
      'the snapshot must include the tenant database, not only the registry')

    await stop()
    activate('candidate-b')
    await boot()
    const secondCookie = await login()
    let contacts = await request('GET', '/api/contacts', { cookie: secondCookie })
    assert.deepEqual(contacts.json?.contacts?.map(contact => contact.name), ['Before Update'])
    assert.equal(readFileSync(join(current, 'public', 'uploads', 'proof.txt'), 'utf8'), 'art before update')
    const second = await request('POST', '/api/contacts', { cookie: secondCookie,
      body: { name: 'After Update', email: 'second@release-rehearsal.test' } })
    assert.equal(second.status, 200)
    writeFileSync(join(uploads, 'proof.txt'), 'art after update')

    await stop()
    activate('candidate-a')
    const preview = spawnSync(process.execPath,
      ['--no-warnings', join(current, 'bin', 'restore.mjs'), backup, '--data-root', data], { encoding: 'utf8' })
    assert.equal(preview.status, 0, preview.stderr)
    assert.equal(readFileSync(join(uploads, 'proof.txt'), 'utf8'), 'art after update')
    const restore = spawnSync(process.execPath,
      ['--no-warnings', join(current, 'bin', 'restore.mjs'), backup, '--data-root', data, '--yes'], { encoding: 'utf8' })
    assert.equal(restore.status, 0, restore.stderr)
    await boot()
    assert.equal((await request('GET', '/api/contacts')).status, 401)
    const restoredCookie = await login()
    contacts = await request('GET', '/api/contacts', { cookie: restoredCookie })
    assert.deepEqual(contacts.json?.contacts?.map(contact => contact.name), ['Before Update'])
    assert.equal(readFileSync(join(current, 'public', 'uploads', 'proof.txt'), 'utf8'), 'art before update')
  } finally {
    await stop()
    rmSync(install, { recursive: true, force: true })
    rmSync(data, { recursive: true, force: true })
  }
})
