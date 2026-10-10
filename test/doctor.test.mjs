import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { runDoctor, formatReport, probeDirectory, supportsNode, RUNTIME_DEPENDENCIES } from '../bin/doctor.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
function fixture(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'psc-doctor-test-'))
  fs.mkdirSync(join(dir, 'public'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  return dir
}
const ready = { nodeVersion: '22.13.0', env: {}, resolveDependency: name => `/installed/${name}` }
const check = (report, id) => report.checks.find(item => item.id === id)
function tree(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).map(entry => {
    const path = join(dir, entry.name)
    return [entry.name, entry.isDirectory() ? tree(path) : entry.isSymbolicLink() ? fs.readlinkSync(path) : fs.readFileSync(path).toString('hex')]
  })
}

test('doctor accepts supported stable Node releases and rejects unsupported or prerelease runtimes', () => {
  for (const version of ['22.13.0', '22.14.0', '23.0.0', '24.0.0', 'v24.1.2']) assert.equal(supportsNode(version), true, version)
  for (const version of ['22.12.9', '20.20.0', '21.9.0', '22.13.0-rc.1', 'unknown']) assert.equal(supportsNode(version), false, version)
})

test('doctor reports an old Node version without loading SQLite or touching storage', t => {
  const dir = fixture(t), before = tree(dir)
  const report = runDoctor({ ...ready, root: dir, cwd: dir, nodeVersion: '20.19.0', loadSqlite: () => { throw Error('must not load') } })
  assert.equal(report.exitCode, 1)
  assert.match(formatReport(report), /22\.13\.0/)
  assert.deepEqual(tree(dir), before)
})

test('doctor runs before npm ci and names missing runtime packages without importing them', t => {
  const dir = fixture(t), seen = []
  const report = runDoctor({ ...ready, root: dir, cwd: dir, resolveDependency: name => { seen.push(name); throw Error('sensitive dependency error') } })
  assert.deepEqual(seen, [...RUNTIME_DEPENDENCIES])
  assert.equal(check(report, 'dependencies').status, 'fail')
  assert.equal(report.exitCode, 1)
  assert.match(formatReport(report), /npm ci/)
  assert.doesNotMatch(formatReport(report), /sensitive dependency error/)
})

test('doctor opens only an in-memory SQLite database and closes it even if the query fails', t => {
  const dir = fixture(t), opened = [], closed = []
  class BrokenDatabase {
    constructor(path) { opened.push(path) }
    prepare() { throw Error('private sqlite detail') }
    close() { closed.push(true) }
  }
  const report = runDoctor({ ...ready, root: dir, cwd: dir, loadSqlite: () => ({ DatabaseSync: BrokenDatabase }) })
  assert.deepEqual(opened, [':memory:'])
  assert.deepEqual(closed, [true])
  assert.equal(check(report, 'sqlite').status, 'fail')
  assert.doesNotMatch(formatReport(report), /private sqlite detail/)
})

test('doctor reports unavailable built-in SQLite as a blocker', t => {
  const dir = fixture(t)
  const report = runDoctor({ ...ready, root: dir, cwd: dir, loadSqlite: () => { throw Error('node:sqlite unavailable') } })
  assert.equal(check(report, 'sqlite').status, 'fail')
  assert.match(formatReport(report), /official Node/)
  assert.equal(report.exitCode, 1)
})

test('first-run diagnostics leave no database, app directory, upload, or probe behind', t => {
  const dir = fixture(t), before = tree(dir)
  const report = runDoctor({ ...ready, root: dir, cwd: dir })
  assert.equal(report.exitCode, 0, formatReport(report))
  assert.equal(check(report, 'auth').status, 'warn')
  assert.equal(check(report, 'database-storage').status, 'pass')
  assert.deepEqual(tree(dir), before)
  assert.match(formatReport(report), /warning/i)
})

test('configured database, WAL, registry, tenant records and artwork are preserved byte for byte', t => {
  const dir = fixture(t), data = join(dir, 'live')
  fs.mkdirSync(join(data, 'tenants', 'shop'), { recursive: true })
  fs.mkdirSync(join(dir, 'public', 'uploads'))
  for (const file of ['printshop.db', 'printshop.db-wal', 'printshop.db-shm', 'control.db', 'usage.db', 'tenants/shop/printshop.db']) fs.writeFileSync(join(data, file), `existing records: ${file}`)
  fs.writeFileSync(join(dir, 'public', 'uploads', 'artwork.svg'), '<svg>existing artwork</svg>')
  const before = tree(dir)
  const report = runDoctor({ ...ready, root: dir, cwd: dir, env: { PSC_DB: join(data, 'printshop.db') } })
  assert.equal(report.exitCode, 0, formatReport(report))
  assert.deepEqual(tree(dir), before)
})

test('.env follows Node parsing and shell precedence without printing or evaluating secrets', t => {
  const dir = fixture(t)
  fs.writeFileSync(join(dir, '.env'), 'PSC_AUTH=1\nPSC_SECRET="file-secret#with-comment"\nPSC_DB=./chosen/shop.db\nPSC_PUBLIC_URL="https://user:private-password@example.test/?token=private-token"\nSMTP_PASS=never-print-this\nUNUSED=$(touch must-not-exist)\n')
  const before = tree(dir)
  const report = runDoctor({ ...ready, root: dir, cwd: dir, env: { PSC_AUTH: '0', PSC_SECRET: 'shell-secret' } })
  assert.equal(check(report, 'auth').status, 'warn', 'shell environment wins over .env')
  assert.equal(check(report, 'secret').status, 'pass')
  assert.equal(check(report, 'public-url').status, 'warn')
  assert.doesNotMatch(formatReport(report), /file-secret|private-password|private-token|never-print-this|shell-secret|must-not-exist/)
  assert.deepEqual(tree(dir), before)
})

test('unreadable .env is blocking instead of diagnosing the wrong default database', t => {
  const dir = fixture(t)
  fs.mkdirSync(join(dir, '.env'))
  const report = runDoctor({ ...ready, root: dir, cwd: dir })
  assert.equal(check(report, 'configuration').status, 'fail')
  assert.equal(check(report, 'database-storage'), undefined)
  assert.equal(report.exitCode, 1)
})

test('authentication blocks only the missing default secret that the server refuses', t => {
  const dir = fixture(t)
  for (const secret of ['', 'preview-secret-change-in-prod']) {
    const report = runDoctor({ ...ready, root: dir, cwd: dir, env: { PSC_AUTH: '1', PSC_SECRET: secret } })
    assert.equal(check(report, 'secret').status, 'fail')
    assert.equal(report.exitCode, 1)
  }
  const report = runDoctor({ ...ready, root: dir, cwd: dir, env: { PSC_AUTH: '1', PSC_SECRET: 'configured', PSC_PUBLIC_URL: 'https://shop.example.test', PSC_HOST: '127.0.0.1' } })
  assert.equal(check(report, 'auth').status, 'pass')
  assert.equal(check(report, 'public-url').status, 'pass')
  assert.equal(report.exitCode, 0, formatReport(report))
})

test('storage paths through files are actionable failures without modifying the file', t => {
  const dir = fixture(t)
  fs.writeFileSync(join(dir, 'blocked'), 'keep me')
  const report = runDoctor({ ...ready, root: dir, cwd: dir, env: { PSC_DB: join(dir, 'blocked', 'shop.db') } })
  assert.equal(check(report, 'database-storage').status, 'fail')
  assert.match(formatReport(report), /directory/)
  assert.equal(fs.readFileSync(join(dir, 'blocked'), 'utf8'), 'keep me')
})

test('a database path that names a directory is blocked before starting the app', t => {
  const dir = fixture(t)
  fs.mkdirSync(join(dir, 'not-a-database'))
  const report = runDoctor({ ...ready, root: dir, cwd: dir, env: { PSC_DB: join(dir, 'not-a-database') } })
  assert.equal(check(report, 'database-storage').status, 'fail')
})

test('directory probes clean up after failed writes and report cleanup failures', t => {
  const dir = fixture(t), before = tree(dir)
  const deniedWrite = { ...fs, writeFileSync() { throw Object.assign(Error('private path'), { code: 'EACCES' }) } }
  assert.equal(probeDirectory(dir, { fs: deniedWrite }).ok, false)
  assert.deepEqual(tree(dir), before)
  const deniedCleanup = { ...fs, rmdirSync() { throw Object.assign(Error('private path'), { code: 'EACCES' }) } }
  const result = probeDirectory(dir, { fs: deniedCleanup })
  assert.equal(result.ok, false)
  assert.equal(result.cleanupFailed, true)
  assert.equal(fs.readdirSync(dir).filter(name => name.startsWith('.psc-doctor-')).length, 1)
})

test('a linked uploads directory is probed without changing existing artwork or its link', { skip: process.platform === 'win32' }, t => {
  const dir = fixture(t), data = join(dir, 'persistent')
  fs.mkdirSync(join(data, 'uploads'), { recursive: true })
  fs.writeFileSync(join(data, 'uploads', 'proof.png'), 'saved proof')
  fs.symlinkSync(join(data, 'uploads'), join(dir, 'public', 'uploads'))
  const before = tree(dir)
  const report = runDoctor({ ...ready, root: dir, cwd: dir, env: { PSC_DB: join(data, 'printshop.db') } })
  assert.equal(check(report, 'uploads-storage').status, 'pass')
  assert.equal(check(report, 'backup-artwork').status, 'pass')
  assert.deepEqual(tree(dir), before)
})

test('dangling upload links are reported without creating their target', { skip: process.platform === 'win32' }, t => {
  const dir = fixture(t), target = join(dir, 'missing-uploads')
  fs.symlinkSync(target, join(dir, 'public', 'uploads'))
  const before = tree(dir)
  const report = runDoctor({ ...ready, root: dir, cwd: dir })
  assert.equal(check(report, 'uploads-storage').status, 'fail')
  assert.equal(fs.existsSync(target), false)
  assert.deepEqual(tree(dir), before)
})

test('backup cautions catch artwork outside the backup root and a custom control database', t => {
  const dir = fixture(t)
  const report = runDoctor({ ...ready, root: dir, cwd: dir, env: { PSC_CONTROL_DB: join(dir, 'elsewhere.db') } })
  assert.equal(check(report, 'backup-artwork').status, 'warn')
  assert.equal(check(report, 'backup-control').status, 'warn')
  assert.match(formatReport(report), /DATA_ROOT/)
  assert.match(formatReport(report), /snapshot/)
})

test('CLI help and missing-dependency runs work in an install with no node_modules', t => {
  const dir = fixture(t)
  fs.mkdirSync(join(dir, 'bin'))
  fs.copyFileSync(join(root, 'bin', 'doctor.mjs'), join(dir, 'bin', 'doctor.mjs'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PSC_') && key !== 'NODE_OPTIONS' && key !== 'NODE_PATH'))
  env.PSC_SECRET = 'cli-secret-never-print'
  const help = spawnSync(process.execPath, ['bin/doctor.mjs', '--help'], { cwd: dir, env, encoding: 'utf8' })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /doctor/)
  const before = tree(dir)
  const run = spawnSync(process.execPath, ['--no-warnings', 'bin/doctor.mjs'], { cwd: dir, env, encoding: 'utf8' })
  assert.equal(run.status, 1, run.stderr)
  assert.match(run.stdout, /npm ci/)
  assert.doesNotMatch(run.stdout + run.stderr, /cli-secret-never-print|ERR_MODULE_NOT_FOUND/)
  assert.deepEqual(tree(dir), before)
})

test('checked dependency names stay aligned with the app runtime manifest', () => {
  const manifest = JSON.parse(fs.readFileSync(join(root, 'package.json'), 'utf8'))
  assert.deepEqual([...RUNTIME_DEPENDENCIES].sort(), Object.keys(manifest.dependencies).sort())
})

test('backup root guidance does not assume backup.sh loads DATA_ROOT from .env', t => {
  const dir = fixture(t)
  fs.writeFileSync(join(dir, '.env'), 'DATA_ROOT=./some-other-root\n')
  const report = runDoctor({ ...ready, root: dir, cwd: dir })
  assert.equal(check(report, 'backup-root').status, 'warn')
  assert.match(check(report, 'backup-root').next, /does not load DATA_ROOT from .env/)
  assert.equal(check(report, 'backup-database'), undefined, 'the .env-only DATA_ROOT is not used by backup.sh')
})

test('custom registry parent must exist because server startup does not create it', t => {
  const dir = fixture(t)
  const report = runDoctor({ ...ready, root: dir, cwd: dir, env: { PSC_CONTROL_DB: './not-created/control.db' } })
  assert.equal(check(report, 'control-storage').status, 'fail')
  assert.equal(fs.existsSync(join(dir, 'not-created')), false)
})

test('existing read-only database or WAL is a blocker and is never opened for writing', t => {
  const dir = fixture(t), path = join(dir, 'shop.db'), wal = path + '-wal'
  fs.writeFileSync(path, 'saved database')
  fs.writeFileSync(wal, 'saved WAL')
  const before = tree(dir)
  const blockedFs = { ...fs, accessSync(target, mode) {
    if (target === wal) throw Object.assign(Error('private failure text'), { code: 'EACCES' })
    return fs.accessSync(target, mode)
  } }
  const report = runDoctor({ ...ready, root: dir, cwd: dir, env: { PSC_DB: path }, fs: blockedFs })
  assert.equal(check(report, 'database-storage').status, 'fail')
  assert.doesNotMatch(formatReport(report), /private failure text/)
  assert.deepEqual(tree(dir), before)
})

test('cleanup failure is visible and the report does not claim all temporary files were removed', t => {
  const dir = fixture(t)
  const report = runDoctor({ ...ready, root: dir, cwd: dir, fs: { ...fs, rmdirSync() { throw Error('cleanup denied') } } })
  assert.equal(report.exitCode, 1)
  assert.match(formatReport(report), /could not be removed/)
  assert.doesNotMatch(formatReport(report), /probes are cleaned up/)
})

test('runtime options in .env are reported without executing preloads or printing their values', t => {
  const dir = fixture(t)
  fs.writeFileSync(join(dir, '.env'), 'NODE_OPTIONS=--import=private-preload-do-not-execute.mjs\n')
  const report = runDoctor({ ...ready, root: dir, cwd: dir })
  assert.equal(check(report, 'runtime-options').status, 'warn')
  assert.doesNotMatch(formatReport(report), /private-preload-do-not-execute/)
})

test('custom registry filenames outside the backup walkers extension are warned even inside DATA_ROOT', t => {
  const dir = fixture(t), data = join(dir, 'data')
  fs.mkdirSync(data)
  const report = runDoctor({ ...ready, root: dir, cwd: dir, env: {
    PSC_DB: './data/printshop.db', PSC_CONTROL_DB: './data/control.sqlite', DATA_ROOT: './data',
  } })
  assert.equal(check(report, 'control-storage').status, 'pass')
  assert.equal(check(report, 'backup-control'), undefined)
  assert.equal(check(report, 'backup-control-extension')?.status, 'warn')
  assert.match(check(report, 'backup-control-extension')?.message || '', /PSC_CONTROL_DB.*\.db/)
})
