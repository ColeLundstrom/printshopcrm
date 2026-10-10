// --import only on release-gate children. Production URL validation and delivery code stays real.
// This is a test fixture, not an OS security sandbox. It has no external-network fallback.
import dns from 'node:dns'
import promises from 'node:dns/promises'
import net from 'node:net'
import tls from 'node:tls'
import http from 'node:http'
import https from 'node:https'
import dgram from 'node:dgram'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { assertE2eScope } from '../helpers/e2e-process.mjs'

assertE2eScope(process.env)
const error = (code, what) => Object.assign(new Error(`${what} blocked by the synthetic E2E fixture`), { code })
const blocked = () => { throw error('PSC_E2E_NETWORK_BLOCKED', 'Outbound connection') }
const dnsError = () => error('PSC_E2E_DNS_BLOCKED', 'Unlisted DNS query')
const ports = new Set(String(process.env.PSC_E2E_LOOPBACK_PORTS || '').split(',').filter(Boolean).map(Number))
if ([...ports].some(port => !Number.isInteger(port) || port < 1 || port > 65535)) blocked()
const loopback = host => host === '127.0.0.1' || host === '::1' || host === '[::1]'
function check(host, port) {
  if (!loopback(host) || !ports.has(Number(port))) blocked()
}

let rebindQueries = 0
function lookup(host, options = {}) {
  const name = String(host).toLowerCase().replace(/\.$/, '')
  let addresses
  if (name === 'webhook.public.test') addresses = ['203.0.113.10']
  else if (name === 'webhook.private.test') addresses = ['127.0.0.1']
  else if (name === 'webhook.mixed.test') addresses = ['203.0.113.10', '10.0.0.2']
  else if (name === 'webhook.rebind.test') addresses = [rebindQueries++ === 0 ? '203.0.113.10' : '127.0.0.1']
  else if (net.isIP(name)) addresses = [name]
  else throw dnsError()
  const family = typeof options === 'number' ? options : options?.family
  const answer = addresses.map(address => ({ address, family: net.isIP(address) })).filter(row => !family || row.family === family)
  if (!answer.length) throw dnsError()
  return options?.all ? answer : answer[0]
}
promises.lookup = async (host, options) => lookup(host, options)
dns.lookup = (host, options, callback) => {
  if (typeof options === 'function') { callback = options; options = {} }
  queueMicrotask(() => {
    let answer
    try { answer = lookup(host, options) } catch (e) { callback(e); return }
    if (options?.all) callback(null, answer)
    else callback(null, answer.address, answer.family)
  })
}
for (const name of ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTlsa', 'resolveTxt', 'reverse', 'lookupService']) {
  const denyPromise = async () => { throw dnsError() }
  const denyCallback = (...args) => {
    const callback = args.at(-1)
    if (typeof callback !== 'function') throw dnsError()
    queueMicrotask(() => callback(dnsError()))
  }
  if (typeof promises[name] === 'function') promises[name] = denyPromise
  if (typeof dns[name] === 'function') dns[name] = denyCallback
  if (typeof promises.Resolver.prototype[name] === 'function') promises.Resolver.prototype[name] = denyPromise
  if (typeof dns.Resolver.prototype[name] === 'function') dns.Resolver.prototype[name] = denyCallback
}

function socketOptions(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0]
  if (first && typeof first === 'object') return first
  return { port: first, host: typeof args[1] === 'string' ? args[1] : undefined }
}
const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  const options = socketOptions(args)
  if (options.path || options.socket) blocked()
  check(options.host, options.port)
  return connect.apply(this, args)
}
const tlsConnect = tls.connect
tls.connect = function (...args) {
  const options = socketOptions(args)
  if (options.path || options.socket) blocked()
  check(options.host, options.port)
  return tlsConnect.apply(this, args)
}
for (const transport of [http, https]) {
  const request = transport.request
  transport.request = function (...args) {
    const first = args[0]
    const url = typeof first === 'string' || first instanceof URL ? new URL(first) : null
    const options = url ? { hostname: url.hostname, port: url.port, ...(typeof args[1] === 'object' ? args[1] : {}) } : first || {}
    if (options.socketPath || options.createConnection) blocked()
    check(options.hostname || options.host, options.port)
    return request.apply(this, args)
  }
  transport.get = function (...args) { const req = transport.request(...args); req.end(); return req }
}
const fetch = globalThis.fetch
globalThis.fetch = async (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input)
  check(url.hostname, url.port)
  return fetch(input, options)
}
dgram.Socket.prototype.connect = blocked
dgram.Socket.prototype.send = blocked
// The single-shop AI CLI is a network-capable provider too; it must not escape this process.
for (const name of ['exec', 'execFile', 'spawn', 'fork', 'execSync', 'execFileSync', 'spawnSync']) childProcess[name] = blocked
syncBuiltinESMExports()
