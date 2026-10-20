import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import nodemailer from 'nodemailer'

// Every env var this file touches, restored after each test so the cases cannot leak into each other.
const KEYS = ['PSC_AUTH', 'PSC_SMTP_ALLOW_PRIVATE', 'PSC_SMTP_TIMEOUT_MS', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_SECURE']
const withEnv = async (vars, fn) => {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  for (const k of KEYS) delete process.env[k]
  Object.assign(process.env, vars)
  try { return await fn() } finally { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } }
}
const notify = await import('../lib/notify.mjs')
const resolverFor = (...addresses) => ({ lookup: async () => addresses.map((address) => ({ address, family: net.isIP(address) })) })
const MULTI = { PSC_AUTH: '1' }

/** A TCP listener that answers like sshd, and counts who connected. Bound in the 4800-4899 range. */
async function bannerServer() {
  const seen = { connections: 0 }
  const sockets = new Set()
  const srv = net.createServer((sock) => { seen.connections++; sockets.add(sock); sock.on('error', () => {}); sock.write('SSH-2.0-OpenSSH_9.6 secret-build-string\r\n') })
  for (let port = 4800 + Math.floor(Math.random() * 90); ; port++) {
    if (port > 4899) throw new Error('no free port in 4800-4899')
    const ok = await new Promise((resolve) => { srv.once('error', () => resolve(false)); srv.listen(port, '127.0.0.1', () => resolve(true)) })
    if (ok) break
  }
  return { seen, port: srv.address().port, close: () => new Promise((r) => { for (const s of sockets) s.destroy(); srv.close(r) }) }
}
const shopSmtp = (host, port = 587) => ({ smtp_host: host, smtp_port: port, smtp_user: 'u', smtp_pass: 'p-' + Math.random(), smtp_from: 'orders@shop.test', smtp_secure: 'false' })

test('shop SMTP hosts in private, loopback, link-local and metadata ranges are refused', async () => {
  for (const host of ['127.0.0.1', '10.1.2.3', '192.168.0.10', '172.16.5.5', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '[::1]', '::ffff:127.0.0.1', 'fd00::1', 'localhost', 'mail.localhost']) {
    await assert.rejects(notify.vetSmtpHost(host), (e) => e.code === 'smtp_host_blocked', host)
  }
  // A public-looking name that resolves inside the network is refused too (DNS rebind / internal name).
  await assert.rejects(notify.vetSmtpHost('smtp.attacker.test', { resolver: resolverFor('203.0.113.9', '127.0.0.1') }), (e) => e.code === 'smtp_host_blocked')
  assert.equal(await notify.vetSmtpHost('smtp.shop.test', { resolver: resolverFor('198.51.100.7') }), '198.51.100.7')
})

test('settings-time check: multi-tenant refuses, single-tenant and the operator escape hatch allow', async () => {
  await withEnv(MULTI, async () => {
    assert.match(await notify.smtpHostProblem('127.0.0.1'), /private or internal network/)
    assert.match(await notify.smtpHostProblem('internal.shop.test', { resolver: resolverFor('10.0.0.8') }), /private or internal network/)
    assert.equal(await notify.smtpHostProblem('smtp.shop.test', { resolver: resolverFor('198.51.100.7') }), '')
    assert.equal(await notify.smtpHostProblem(''), '', 'clearing the host is always allowed')
    // A name that does not resolve right now must not block saving the rest of Settings.
    assert.equal(await notify.smtpHostProblem('gone.shop.test', { resolver: { lookup: async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }) } } }), '')
  })
  await withEnv({ ...MULTI, PSC_SMTP_ALLOW_PRIVATE: '1' }, async () => assert.equal(await notify.smtpHostProblem('192.168.1.20'), ''))
  await withEnv({}, async () => assert.equal(await notify.smtpHostProblem('192.168.1.20'), '', 'a single-shop self-host keeps its LAN relay'))
  await withEnv({ PSC_SMTP_ALLOW_PRIVATE: '0' }, async () => assert.match(await notify.smtpHostProblem('192.168.1.20'), /private/))
})

test('verify and real sends never open a socket to a blocked shop host on a multi-tenant install', async () => {
  const srv = await bannerServer()
  try {
    await withEnv(MULTI, async () => {
      const v = await notify.verifyEmail(shopSmtp('127.0.0.1', srv.port))
      assert.equal(v.ok, false)
      assert.match(v.error, /private or internal network/)
      const s = await notify.sendEmail({ to: 'customer@example.test', subject: 'x', body: 'y', settings: shopSmtp('127.0.0.1', srv.port) })
      assert.equal(s.delivered, false)
      assert.match(s.error, /private or internal network/)
    })
    // Only an env SMTP_HOST is trusted: with operator credentials but no operator host, the host in
    // the fallback set is still the shop's, and is still checked.
    await withEnv({ ...MULTI, SMTP_USER: 'op', SMTP_PASS: 'op-pass' }, async () => {
      const half = await notify.verifyEmail({ smtp_host: '127.0.0.1', smtp_port: srv.port })
      assert.equal(half.ok, false)
      assert.match(half.error, /private or internal network/)
    })
    assert.equal(srv.seen.connections, 0, 'the guard must refuse before connecting')
  } finally { await srv.close() }
})

test('a connect failure never echoes the remote banner back to the shop', async () => {
  const srv = await bannerServer()
  try {
    await withEnv({ ...MULTI, PSC_SMTP_ALLOW_PRIVATE: '1', PSC_SMTP_TIMEOUT_MS: '1500' }, async () => {
      const v = await notify.verifyEmail(shopSmtp('127.0.0.1', srv.port))
      assert.equal(v.ok, false)
      assert.ok(srv.seen.connections >= 1, 'the escape hatch lets an operator reach a LAN relay')
      assert.doesNotMatch(v.error, /SSH|OpenSSH|secret-build-string/)
      assert.match(v.error, /^Could not connect to the SMTP server/)
      const s = await notify.sendEmail({ to: 'customer@example.test', subject: 'x', body: 'y', settings: shopSmtp('127.0.0.1', srv.port) })
      assert.equal(s.delivered, false)
      assert.doesNotMatch(s.error, /SSH|OpenSSH|secret-build-string/)
    })
  } finally { await srv.close() }
  assert.equal(notify.smtpFailure({ code: 'EAUTH', message: '535 5.7.8 go away, banner text' }), 'The SMTP server rejected the username or password (EAUTH).')
})

test('the connection is pinned to the vetted address while TLS keeps the real host name', async () => {
  const real = nodemailer.createTransport
  const made = []
  nodemailer.createTransport = (opts) => { made.push(opts); return { verify: async () => true, sendMail: async () => ({ messageId: 'm' }), close() {} } }
  try {
    await withEnv(MULTI, async () => {
      const ok = await notify.verifyEmail(shopSmtp('smtp.pinned.test'), { resolver: resolverFor('198.51.100.7') })
      assert.deepEqual(ok, { ok: true })
      assert.equal(made.at(-1).host, '198.51.100.7')
      assert.equal(made.at(-1).servername, 'smtp.pinned.test')
      assert.equal(made.at(-1).tls.servername, 'smtp.pinned.test')
      // Same host, now answering with an internal address: refused, and no transport is built.
      const before = made.length
      const rebound = await notify.verifyEmail(shopSmtp('smtp.pinned.test'), { resolver: resolverFor('10.0.0.5') })
      assert.equal(rebound.ok, false)
      assert.equal(made.length, before)
    })
  } finally { nodemailer.createTransport = real }
})

test('the operator relay sends From the operator address, with the shop address as Reply-To', async () => {
  const real = nodemailer.createTransport
  const sent = []
  nodemailer.createTransport = () => ({ verify: async () => true, sendMail: async (m) => { sent.push(m); return { messageId: 'm' } }, close() {} })
  const shop = { shop_name: 'Alpha "Tees" <x>', shop_email: 'owner@alpha.test', smtp_from: 'ceo@bank.test' }
  const OP = { SMTP_HOST: 'relay.operator.test', SMTP_USER: 'relay@operator.test', SMTP_PASS: 'op-pass' }
  try {
    await withEnv({ ...MULTI, ...OP }, async () => {
      const r = await notify.sendEmail({ to: 'customer@example.test', subject: 's', body: 'b', settings: shop })
      assert.equal(r.delivered, true, r.error)
      assert.match(sent.at(-1).from, /<relay@operator\.test>$/)
      assert.doesNotMatch(sent.at(-1).from, /bank\.test|alpha\.test/)
      assert.equal((sent.at(-1).from.match(/</g) || []).length, 1, 'the display name cannot smuggle a second address')
      assert.equal(sent.at(-1).replyTo, 'ceo@bank.test')
      assert.equal(notify.notifyStatus(shop).email_from, 'relay@operator.test')
    })
    await withEnv({ ...MULTI, ...OP, SMTP_FROM: 'noreply@operator.test' }, async () => {
      await notify.sendEmail({ to: 'customer@example.test', subject: 's', body: 'b', settings: shop })
      assert.match(sent.at(-1).from, /<noreply@operator\.test>$/)
      assert.equal(sent.at(-1).replyTo, 'ceo@bank.test')
    })
    // A shop with its own complete SMTP still sends as itself, with no Reply-To rewrite.
    await withEnv({ ...MULTI, ...OP }, async () => {
      await notify.sendEmail({ to: 'customer@example.test', subject: 's', body: 'b', settings: { ...shop, smtp_host: '198.51.100.7', smtp_user: 'u', smtp_pass: 'p', smtp_from: 'orders@alpha.test' } })
      assert.match(sent.at(-1).from, /<orders@alpha\.test>$/)
      assert.equal(sent.at(-1).replyTo, undefined)
    })
    // A single-shop self-host is its own operator: its Settings address keeps working.
    await withEnv(OP, async () => {
      await notify.sendEmail({ to: 'customer@example.test', subject: 's', body: 'b', settings: shop })
      assert.match(sent.at(-1).from, /<ceo@bank\.test>$/)
    })
  } finally { nodemailer.createTransport = real }
})
