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
import http from 'node:http'
import https from 'node:https'

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

/**
 * Validate + resolve a shop-supplied webhook URL; throws if it isn't a safe public endpoint.
 *
 * Returns the parsed URL AND the exact vetted IPs — because returning only the string was the
 * whole vulnerability. The caller then re-resolved the hostname at connect time, and a DNS-rebind
 * server answers a public IP here and 127.0.0.1 a moment later. Handing back the addresses we
 * actually checked lets delivery connect to one of them and skip the second, attacker-controlled
 * lookup entirely.
 */
export async function assertPublicUrl(rawUrl, { resolver = dns } = {}) {
  let u
  try { u = new URL(rawUrl) } catch { throw new Error('Invalid webhook URL') }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Webhook URL must be http(s)')
  if (u.username || u.password) throw new Error('Webhook URL must not embed credentials')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost') throw new Error('Webhook host is not allowed')
  const ips = net.isIP(host) ? [host] : (await resolver.lookup(host, { all: true })).map((r) => r.address)
  if (!ips.length || ips.some(isBlockedIp)) throw new Error('Webhook host resolves to a private address')
  return { url: u, ips }
}

/**
 * The lookup a DNS rebind can't move: whatever hostname the stack tries to resolve, it gets the
 * address assertPublicUrl already vetted, re-checked against the block list.
 *
 * It MUST honour `options.all`. Node has defaulted autoSelectFamily to true since v20, so
 * net.connect calls a custom lookup with `{ all: true }` and expects an ARRAY of
 * `{ address, family }`. This returned the bare-string 3-argument form, which is only valid when
 * `all` is false — so every delivery died with "Invalid IP address: undefined" before a packet
 * left the box. package.json requires node >=22, which means the webhook feature reached no
 * endpoint on any install: the SSRF fix that introduced this pinning silently disabled delivery.
 *
 * Exported so the gate can drive it through a real socket, which is the only way this shows up.
 */
export function pinnedLookupFor(ip) {
  return (_hostname, options, cb) => {
    // Node also permits lookup(hostname, cb) with the options argument omitted.
    const done = typeof options === 'function' ? options : cb
    const opts = typeof options === 'function' ? {} : (options || {})
    if (isBlockedIp(ip)) { done(new Error('blocked address')); return }
    const family = net.isIP(ip) || 4
    if (opts.all) { done(null, [{ address: ip, family }]); return }
    done(null, ip, family)
  }
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

/**
 * Deliver a JSON payload to a validated URL. Returns { ok, status?, error? }. Never throws.
 *
 * Uses node:http(s) rather than fetch specifically so the connection can be PINNED to an address
 * that assertPublicUrl already vetted, via the `lookup` option. fetch re-resolves the hostname
 * itself with no way to intervene, which is exactly the DNS-rebind window this closes: the guard
 * saw a public IP, and fetch would then connect to whatever the second lookup returned. Here the
 * lookup can only ever return the vetted address. TLS still uses the real hostname for SNI and
 * certificate validation, so a pinned https endpoint is verified as itself.
 */
export async function deliverWebhook(rawUrl, payload, { timeoutMs = 10000, resolver = dns, secret = '', event = '' } = {}) {
  let vetted
  try { vetted = await assertPublicUrl(rawUrl, { resolver }) } catch (e) { return { ok: false, error: e.message } }
  const { url: u, ips } = vetted
  const safe = u.toString()
  const pinnedIp = ips[0]
  const pinnedLookup = pinnedLookupFor(pinnedIp)
  try {
    const body = JSON.stringify(payload)
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'PrintShopCRM-Webhook/1', 'Content-Length': Buffer.byteLength(body) }
    if (secret) headers['X-PSC-Signature'] = signWebhook(secret, body)
    if (event) headers['X-PSC-Event'] = String(event)
    const lib = u.protocol === 'https:' ? https : http
    return await new Promise((resolve) => {
      const req = lib.request(
        {
          protocol: u.protocol,
          hostname: u.hostname.replace(/^\[|\]$/g, ''),
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: `${u.pathname}${u.search}`,
          method: 'POST',
          headers,
          lookup: pinnedLookup,
          timeout: timeoutMs,
        },
        (res) => {
          // redirect: manual — we do not follow. A 3xx is just its status; following it would
          // re-open the SSRF via a Location the guard never saw.
          res.resume() // drain so the socket can close
          const ok = res.statusCode >= 200 && res.statusCode < 400
          resolve({ ok, status: res.statusCode, url: safe, error: ok ? null : `HTTP ${res.statusCode}` })
        },
      )
      req.on('timeout', () => { req.destroy(new Error(`timed out after ${timeoutMs}ms`)) })
      req.on('error', (e) => resolve({ ok: false, url: safe, error: e.message }))
      req.write(body)
      req.end()
    })
  } catch (e) { return { ok: false, url: safe, error: e.message } }
}
