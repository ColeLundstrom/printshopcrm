#!/usr/bin/env node
/** Dependency-free diagnostics. Never import application modules: they open/migrate databases. */
import * as filesystem from 'node:fs'
import * as util from 'node:util'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
export const RUNTIME_DEPENDENCIES = Object.freeze(['express', 'fast-xml-parser', 'multer', 'nodemailer', 'qrcode', 'ws'])
const DEFAULT_SECRET = 'preview-secret-change-in-prod'

export function supportsNode(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) return false
  const [, major, minor] = match.map(Number)
  return major > 22 || (major === 22 && minor >= 13)
}

function reason(error) {
  if (['EACCES', 'EPERM'].includes(error?.code)) return 'This account does not have permission.'
  if (error?.code === 'EROFS') return 'The filesystem is read-only; check the persistent volume mount.'
  if (error?.code === 'ENOSPC' || error?.code === 'EDQUOT') return 'The disk or account quota is full.'
  if (error?.code === 'ENOTDIR') return 'Part of the path is a file instead of a directory.'
  if (error?.code === 'BROKEN_LINK') return 'A symbolic link points to a missing target.'
  if (error?.code === 'ELOOP') return 'A symbolic link loops back on itself.'
  return 'The path is unavailable, not a directory, or has a broken symbolic link.'
}

/** Probe the directory, or its nearest existing ancestor, without creating app directories. */
export function probeDirectory(directory, { fs = filesystem } = {}) {
  let current = resolve(directory), temporary, file, failure, cleanupFailed = false
  try {
    while (true) {
      try {
        // lstat first distinguishes a dangling link from a directory that does not exist yet.
        fs.lstatSync(current)
        if (!fs.statSync(current).isDirectory()) throw Object.assign(Error(), { code: 'ENOTDIR' })
        break
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        try { fs.lstatSync(current); throw Object.assign(Error(), { code: 'BROKEN_LINK' }) }
        catch (linkError) { if (linkError.code !== 'ENOENT') throw linkError }
        const parent = dirname(current)
        if (parent === current) throw error
        current = parent
      }
    }
    temporary = fs.mkdtempSync(join(current, '.psc-doctor-'))
    file = join(temporary, 'write-check')
    fs.writeFileSync(file, 'PrintShopCRM temporary storage check\n', { flag: 'wx', mode: 0o600 })
  } catch (error) { failure = reason(error) }
  finally {
    if (file) {
      try { fs.unlinkSync(file) }
      catch (error) { if (error.code !== 'ENOENT') cleanupFailed = true }
    }
    if (temporary) {
      // Never recursively remove: only our known file and empty, uniquely created directory.
      try { fs.rmdirSync(temporary) } catch { cleanupFailed = true }
    }
  }
  return { ok: !failure && !cleanupFailed, exists: current === resolve(directory), cleanupFailed,
    message: cleanupFailed ? 'A .psc-doctor-* temporary probe could not be removed. Check permissions and remove that probe before retrying.' : failure }
}

function inspectWritableFile(path, fs) {
  try {
    fs.lstatSync(path)
    if (!fs.statSync(path).isFile()) return 'The configured database or its SQLite sidecar is not a regular file.'
    fs.accessSync(path, filesystem.constants.R_OK | filesystem.constants.W_OK)
  } catch (error) {
    if (error.code === 'ENOENT') {
      try { fs.lstatSync(path); return 'A database path is a broken symbolic link.' }
      catch (missing) { if (missing.code === 'ENOENT') return null }
    }
    return reason(error)
  }
  return null
}

function contains(parent, path) {
  const rel = relative(parent, path)
  return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'))
}

function sameExistingDirectory(left, right, fs) {
  try { return fs.realpathSync(left) === fs.realpathSync(right) && fs.statSync(left).isDirectory() }
  catch { return false }
}

export function runDoctor({ root = ROOT, cwd = process.cwd(), env = process.env,
  nodeVersion = process.versions.node, resolveDependency, loadSqlite = () => require('node:sqlite'), fs = filesystem } = {}) {
  root = resolve(root)
  cwd = resolve(cwd)
  const checks = []
  const add = (id, status, message, next) => checks.push({ id, status, message, ...(next ? { next } : {}) })
  const report = () => ({ checks, exitCode: checks.some(check => check.status === 'fail') ? 1 : 0 })
  if (!supportsNode(nodeVersion)) {
    add('node', 'fail', 'Node.js 22.13.0 or newer (stable) is required.', 'Install a supported official Node.js release, reopen your terminal, and rerun node bin/doctor.mjs.')
    return report()
  }
  add('node', 'pass', `Node.js ${String(nodeVersion).replace(/^v/, '')} meets the minimum version.`)

  const resolvePackage = resolveDependency || createRequire(join(root, 'package.json')).resolve
  const missing = RUNTIME_DEPENDENCIES.filter(name => { try { resolvePackage(name); return false } catch { return true } })
  add('dependencies', missing.length ? 'fail' : 'pass', missing.length ? `Missing runtime dependencies: ${missing.join(', ')}.` : 'All runtime packages resolve from this checkout.',
    missing.length ? 'Run npm ci in the PrintShopCRM directory, then rerun this check.' : undefined)

  let database, sqliteFailure = false
  try {
    const { DatabaseSync } = loadSqlite()
    database = new DatabaseSync(':memory:')
    if (database.prepare('SELECT 1 AS ok').get()?.ok !== 1) sqliteFailure = true
  } catch { sqliteFailure = true }
  finally { if (database) { try { database.close() } catch { sqliteFailure = true } } }
  add('sqlite', sqliteFailure ? 'fail' : 'pass', sqliteFailure ? 'The built-in node:sqlite runtime could not complete an in-memory query.' : 'Built-in SQLite opened, queried and closed an in-memory database.',
    sqliteFailure ? 'Use an official Node.js build >=22.13.0 with SQLite enabled; check NODE_OPTIONS for a SQLite-disabling flag.' : undefined)

  let config, envStat
  try {
    const envPath = join(cwd, '.env')
    try {
      envStat = fs.lstatSync(envPath)
      if (!fs.statSync(envPath).isFile()) throw Error('not a file')
      config = util.parseEnv(fs.readFileSync(envPath, 'utf8'))
      envStat = fs.statSync(envPath)
      add('configuration', 'pass', 'Read .env in the working directory; existing process variables take precedence.')
    } catch (error) {
      if (error.code !== 'ENOENT' || envStat) throw error
      config = {}
      add('configuration', 'pass', 'No .env in the working directory; using process variables and application defaults.')
    }
    config = { ...config, ...Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) }
  } catch {
    add('configuration', 'fail', 'The working-directory .env could not be read or parsed.', 'Run from the same directory and account as the app. Check that .env is a readable file; no storage was probed because its settings are unknown.')
    return report()
  }
  if (envStat && process.platform !== 'win32' && (envStat.mode & 0o077)) {
    add('env-permissions', 'warn', '.env is accessible to other accounts by its file mode.', 'For the production layout in INSTALL.md, make it owned by the service account and chmod 600 .env.')
  }
  if (config.NODE_OPTIONS) {
    add('runtime-options', 'warn', 'NODE_OPTIONS is configured; flags read from .env are not applied to this running doctor process.', 'Review the app launch flags, including preloads and SQLite-disabling flags. This check does not execute configuration as code.')
  }

  const auth = config.PSC_AUTH === '1'
  add('auth', auth ? 'pass' : 'warn', auth ? 'PSC_AUTH=1 enables staff sign-in.' : 'PSC_AUTH is not 1: anyone who can reach the app has full access.',
    auth ? undefined : 'Keep evaluation private. Before exposing the app, configure PSC_AUTH=1 and PSC_SECRET, or a separate authentication layer. See INSTALL.md.')
  const secret = config.PSC_SECRET || DEFAULT_SECRET
  add('secret', secret === DEFAULT_SECRET ? (auth ? 'fail' : 'warn') : 'pass', secret === DEFAULT_SECRET ? (auth ? 'PSC_AUTH=1 cannot start with the built-in share-link secret.' : 'The built-in development share-link secret is still in use.') : 'PSC_SECRET is set to a non-default value; its strength was not assessed.',
    secret === DEFAULT_SECRET ? 'Generate a private random PSC_SECRET as described in INSTALL.md before using real customer data. The doctor never prints or generates credentials.' : undefined)

  const host = String(config.PSC_HOST || '').trim()
  if (!host || ['0.0.0.0', '::', '[::]'].includes(host)) {
    add('network', 'warn', 'The app is configured to listen on all network interfaces.', 'Use PSC_HOST=127.0.0.1 for a local preview or same-machine proxy. Containers may need all interfaces; verify their published ports and firewall.')
  } else add('network', 'pass', 'PSC_HOST selects a network interface; reachability and firewall rules were not tested.')

  const publicUrl = String(config.PSC_PUBLIC_URL || '').trim()
  let url
  try { url = new URL(publicUrl) } catch {}
  if (!publicUrl) {
    add('public-url', 'warn', 'PSC_PUBLIC_URL is unset; customer links fall back to the request host.', 'Before sharing customer links, set PSC_PUBLIC_URL to the address of this install (HTTPS for a public server).')
  } else if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    add('public-url', 'warn', 'PSC_PUBLIC_URL is not a plain HTTP(S) origin.', 'Use the install origin only, such as https://shop.example.com, without credentials, a path, query or fragment.')
  } else if (url.protocol !== 'https:' || url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname === '[::1]' || /^127\./.test(url.hostname)) {
    add('public-url', 'warn', 'PSC_PUBLIC_URL is local or does not use HTTPS.', 'This can be suitable for local evaluation. Use the externally reachable HTTPS origin for a public install.')
  } else add('public-url', 'pass', 'PSC_PUBLIC_URL is an HTTPS origin; DNS and TLS were not contacted or verified.')

  const memoryDb = config.PSC_DB === ':memory:'
  const dbPath = resolve(cwd, config.PSC_DB || join(root, 'data', 'printshop.db'))
  const dataRoot = memoryDb ? cwd : dirname(dbPath)
  const controlPath = resolve(cwd, config.PSC_CONTROL_DB || join(dataRoot, 'control.db'))
  const uploads = join(root, 'public', 'uploads')
  const storage = (id, label, directory, files = [], mustExist = false) => {
    const probe = probeDirectory(directory, { fs })
    const fileFailure = files.map(path => inspectWritableFile(path, fs)).find(Boolean)
    const failure = !probe.ok ? probe.message : fileFailure || (mustExist && !probe.exists ? 'Its separately configured parent directory must exist before the app starts.' : null)
    add(id, failure ? 'fail' : 'pass', failure ? `${label}: ${failure}` : `${label}: ${probe.exists ? 'directory is writable' : 'nearest existing parent is writable; the app directory was not created'}.`,
      failure ? 'Check the configured path, volume mount and ownership as the account that runs the app. Do not use seed or reset to repair an existing shop.' : undefined)
  }
  storage('database-storage', 'PSC_DB storage', dataRoot, memoryDb ? [] : [dbPath, dbPath + '-wal', dbPath + '-shm'])
  storage('tenant-storage', 'Tenant storage', join(dataRoot, 'tenants'))
  if (config.PSC_CONTROL_DB !== ':memory:') storage('control-storage', 'Registry storage (PSC_CONTROL_DB)', dirname(controlPath), [controlPath, controlPath + '-wal', controlPath + '-shm'], dirname(controlPath) !== dataRoot)
  storage('uploads-storage', 'Customer artwork (public/uploads)', uploads)
  if (memoryDb || config.PSC_CONTROL_DB === ':memory:') {
    add('persistent-data', 'warn', 'A database is configured as :memory: and will not survive a restart.', 'Use a persistent PSC_DB and registry for real work. Tenant data and uploads can still be written to disk even when a database uses :memory:.')
  } else if (contains(root, dataRoot)) {
    add('persistent-data', 'warn', 'Database storage is inside this application checkout.', 'This is convenient locally. Before replacing the checkout during upgrades, keep all databases and artwork in persistent storage and back them up. See INSTALL.md.')
  }

  // backup.sh archives DATA_ROOT/uploads, whereas the server writes ROOT/public/uploads.
  // backup.sh does not source .env for DATA_ROOT. Without an explicit shell value,
  // compare the intended data layout, and explain that the script needs that root.
  const backupRoot = resolve(cwd, env.DATA_ROOT || dataRoot)
  if (!env.DATA_ROOT) {
    add('backup-root', 'warn', 'Backup layout is compared with the directory containing PSC_DB; no shell DATA_ROOT was provided.', 'Set DATA_ROOT explicitly when running deploy/backup.sh; it defaults to /var/lib/printshopcrm and does not load DATA_ROOT from .env.')
  }
  const artworkIncluded = sameExistingDirectory(uploads, join(backupRoot, 'uploads'), fs)
  add('backup-artwork', artworkIncluded ? 'pass' : 'warn', artworkIncluded ? 'public/uploads resolves to the uploads directory beneath the selected backup data root.' : 'public/uploads does not resolve to DATA_ROOT/uploads; the Linux backup script may miss customer artwork.',
    artworkIncluded ? undefined : 'Use the persistent uploads layout in INSTALL.md, or back up public/uploads separately. Set DATA_ROOT explicitly when running deploy/backup.sh; its default is /var/lib/printshopcrm.')
  if (!memoryDb && !contains(backupRoot, dbPath)) {
    add('backup-database', 'warn', 'PSC_DB is outside the selected backup DATA_ROOT.', 'Include its containing data directory in your backup plan. The doctor does not run backups.')
  }
  if (config.PSC_CONTROL_DB !== ':memory:' && !contains(backupRoot, controlPath)) {
    add('backup-control', 'warn', 'PSC_CONTROL_DB is outside the selected backup DATA_ROOT.', 'Back up the registry too; tenant databases alone cannot restore staff sign-in. Review INSTALL.md before using snapshot or backup.sh.')
  }
  if (!memoryDb && !dbPath.endsWith('.db')) {
    add('backup-extension', 'warn', 'PSC_DB does not end in .db; the supplied backup walkers select .db files.', 'Use a .db filename when setting up a new install, or arrange explicit SQLite-aware backups of the existing database. Do not rename a live database.')
  }
  if (config.PSC_CONTROL_DB !== ':memory:' && !controlPath.endsWith('.db')) {
    add('backup-control-extension', 'warn', 'PSC_CONTROL_DB does not end in .db; the supplied backup walkers omit this registry file.', 'Arrange explicit SQLite-aware registry backups or use a .db filename for a new install. Never rename a live registry; staff sign-in depends on it.')
  }
  add('backup-plan', 'warn', 'Backup scheduling, off-machine copies and restore success cannot be verified by this check.', 'Follow INSTALL.md: snapshot every database, include artwork, keep an off-machine copy and test a restore separately. npm run snapshot takes an explicit data root and does not include artwork.')
  return report()
}

export function formatReport(report) {
  const failures = report.checks.filter(check => check.status === 'fail').length
  const warnings = report.checks.filter(check => check.status === 'warn').length
  return ['PrintShopCRM self-host check',
    'No app databases opened or migrated; no external requests. Storage checks use temporary write probes.', '',
    ...report.checks.map(check => `${check.status.toUpperCase()}  ${check.message}${check.next ? `\n      Next: ${check.next}` : ''}`), '',
    `${failures} blocking issue(s), ${warnings} warning(s). ${failures ? 'Fix the blocking issues, then rerun this check.' : 'Basic checks passed. Review warnings before using real data or exposing the app.'}`,
    'This is a preflight check, not a security audit or a database integrity/backup test.',
  ].join('\n')
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  const args = process.argv.slice(2)
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Usage: node bin/doctor.mjs\nRun from the app directory, as the account that runs PrintShopCRM.\nReads .env with process variables taking precedence; never starts the app.\nExit 0: no blocking issues (warnings may remain). Exit 1: fix a blocking issue.\nSee docs/SELF-HOST-CHECK.md for checks and backup limitations.')
  } else if (args.length) {
    console.error('Usage: node bin/doctor.mjs [--help]')
    process.exitCode = 1
  } else {
    try {
      const report = runDoctor()
      console.log(formatReport(report))
      process.exitCode = report.exitCode
    } catch {
      console.error('The self-host check could not complete. Check the working directory and file permissions; no error details or configuration values were printed.')
      process.exitCode = 1
    }
  }
}
