/**
 * SSRF-safe outbound webhook delivery. A webhook URL is shop-supplied, so the shop legitimately
 * points it at their own Zapier/Make/server — we cannot allowlist hosts. Instead: require http(s),
 * refuse embedded credentials, RESOLVE the hostname and reject any resolved address in a private /
 * loopback / link-local / carrier-NAT / cloud-metadata range (which also blocks DNS-rebinding), and
 * never follow a redirect. Kept in its own module so the guard is unit-testable.
 */
import dns from 'node:dns/promises'
import net from 'node:net'
import crypto from 'node:crypto'

/** True when an IP literal is in a range a webhook must never reach. */
export function isBlockedIp(ip) {
  const v = net.isIP(ip)
  if (!v) return true // not an IP at all → treat as blocked (caller resolves names first)
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number)
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 169 && b === 254) return true            // link-local incl. metadata 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true  // CGNAT 100.64/10
    return false
  }
  const lo = ip.toLowerCase()
  if (lo === '::1' || lo === '::') return true
  if (lo.startsWith('::ffff:')) return isBlockedIp(lo.slice(7)) // IPv4-mapped IPv6
  if (lo.startsWith('fc') || lo.startsWith('fd')) return true   // unique-local fc00::/7
  if (lo.startsWith('fe80')) return true                        // link-local
  return false
}

/** Validate + resolve a shop-supplied webhook URL; throws if it isn't a safe public endpoint. */
export async function assertPublicUrl(rawUrl, { resolver = dns } = {}) {
  let u
  try { u = new URL(rawUrl) } catch { throw new Error('Invalid webhook URL') }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Webhook URL must be http(s)')
  if (u.username || u.password) throw new Error('Webhook URL must not embed credentials')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost') throw new Error('Webhook host is not allowed')
  const ips = net.isIP(host) ? [host] : (await resolver.lookup(host, { all: true })).map((r) => r.address)
  if (!ips.length || ips.some(isBlockedIp)) throw new Error('Webhook host resolves to a private address')
  return u.toString()
}

/**
 * Sign a delivery body so the receiver can verify it came from us and hasn't been replayed.
 * Format matches the ecosystem convention (Stripe-style): `t=<unix>,v1=<hmac-sha256 hex>` over
 * `${t}.${body}`. Verification: recompute with your endpoint secret and compare constant-time.
 */
export function signWebhook(secret, body, t = Math.floor(Date.now() / 1000)) {
  const mac = crypto.createHmac('sha256', String(secret)).update(`${t}.${body}`).digest('hex')
  return `t=${t},v1=${mac}`
}

/** Receiver-side verify (also what the docs tell integrators to implement). */
export function verifyWebhookSignature(secret, body, header, { toleranceSec = 300, now = Math.floor(Date.now() / 1000) } = {}) {
  const m = /t=(\d+),v1=([0-9a-f]{64})/.exec(String(header || ''))
  if (!m) return false
  const t = Number(m[1])
  if (Math.abs(now - t) > toleranceSec) return false
  const expect = crypto.createHmac('sha256', String(secret)).update(`${t}.${body}`).digest('hex')
  try { return crypto.timingSafeEqual(Buffer.from(m[2], 'hex'), Buffer.from(expect, 'hex')) } catch { return false }
}

/** Deliver a JSON payload to a validated URL. Returns { ok, status?, error? }. Never throws. */
export async function deliverWebhook(rawUrl, payload, { timeoutMs = 10000, resolver = dns, secret = '', event = '' } = {}) {
  let safe
  try { safe = await assertPublicUrl(rawUrl, { resolver }) } catch (e) { return { ok: false, error: e.message } }
  try {
    const body = JSON.stringify(payload)
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'PrintShopCRM-Webhook/1' }
    if (secret) headers['X-PSC-Signature'] = signWebhook(secret, body)
    if (event) headers['X-PSC-Event'] = String(event)
    const res = await fetch(safe, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers,
      body,
    })
    const ok = res.status >= 200 && res.status < 400
    return { ok, status: res.status, url: safe, error: ok ? null : `HTTP ${res.status}` }
  } catch (e) { return { ok: false, url: safe, error: e.message } }
}
