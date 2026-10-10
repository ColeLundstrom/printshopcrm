// Private release-gate plumbing. Never imported by the application or its production launcher.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, realpathSync, lstatSync } from 'node:fs'
import { tmpdir, networkInterfaces } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const directories = new Map()
const marker = '.psc-synthetic-e2e.json'
const preload = new URL('../fixtures/e2e-network.mjs', import.meta.url).href
const refusal = () => { throw Error('This fixture requires a fresh synthetic E2E data directory; no application data was opened.') }

export function createE2eDirectory(label = 'shop') {
  if (!/^[a-z0-9-]+$/.test(label)) refusal()
  const root = realpathSync(mkdtempSync(join(tmpdir(), `psc-e2e-${label}-`)))
  const token = randomUUID()
  writeFileSync(join(root, marker), JSON.stringify({ kind: 'synthetic-e2e-v1', token }), { flag: 'wx', mode: 0o600 })
  directories.set(root, token)
  return root
}

// An allowlist is intentional: adding a new production integration must not silently give
// this test credentials, a real control database, a proxy, or an inherited Node preload.
export function e2eEnvironment(overrides = {}, inherited = process.env) {
  const env = {}
  for (const [key, value] of Object.entries(inherited)) {
    if (/^(path|systemroot|windir|comspec|pathext|temp|tmp|tmpdir|ld_library_path)$/i.test(key)) env[key] = value
  }
  return { ...env, ...overrides }
}

export function assertE2eScope(env) {
  try {
    const root = env.PSC_E2E_ROOT
    if (!root || !env.PSC_E2E_TOKEN || !env.PSC_DB) refusal()
    if (root !== realpathSync(root) || dirname(root) !== realpathSync(tmpdir()) || !basename(root).startsWith('psc-e2e-')) refusal()
    const visit = path => {
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) refusal()
      if (stat.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name))
    }
    visit(root)
    const proof = JSON.parse(readFileSync(join(root, marker), 'utf8'))
    if (proof.kind !== 'synthetic-e2e-v1' || proof.token !== env.PSC_E2E_TOKEN) refusal()
    for (const path of [env.PSC_DB, env.PSC_CONTROL_DB].filter(Boolean)) {
      if (dirname(resolve(path)) !== root) refusal()
    }
    return root
  } catch { refusal() }
}

export function spawnE2e(command, args, options) {
  if (command !== process.execPath) refusal()
  const root = dirname(resolve(options.env?.PSC_DB || '.'))
  const token = directories.get(root)
  if (!token) refusal()
  const env = { ...options.env, PSC_E2E_ROOT: root, PSC_E2E_TOKEN: token }
  assertE2eScope(env)
  // Only fixtures explicitly configured by the suite may accept outbound connections.
  const ports = new Set(String(env.PSC_E2E_LOOPBACK_PORTS || '').split(',').filter(Boolean))
  if (env.GHL_BASE) {
    const url = new URL(env.GHL_BASE)
    if (url.hostname !== '127.0.0.1' || !url.port) refusal()
    ports.add(url.port)
  }
  if (env.SMTP_HOST) {
    if (env.SMTP_HOST !== '127.0.0.1' || !env.SMTP_PORT) refusal()
    ports.add(env.SMTP_PORT)
  }
  env.PSC_E2E_LOOPBACK_PORTS = [...ports].join(',')
  return spawn(command, ['--import', preload, ...args], { ...options, env })
}

// The optional off-loopback check cannot run when a container denies interface enumeration.
// Report that one missing capability; unexpected errors must still fail the release gate.
export function e2eLanAddress(read = networkInterfaces) {
  let interfaces
  try { interfaces = read() }
  catch (error) {
    if (error.code !== 'ERR_SYSTEM_ERROR' || error.info?.syscall !== 'uv_interface_addresses' || ![1, 13].includes(Math.abs(error.info?.errno))) throw error
    return { address: null, reason: `network-interface discovery denied by this runner (errno ${error.info.errno})` }
  }
  const address = Object.values(interfaces).flat().find(item => item && item.family === 'IPv4' && !item.internal)?.address
  return { address: address || null, reason: address ? null : 'no non-loopback IPv4 interface on this runner' }
}
