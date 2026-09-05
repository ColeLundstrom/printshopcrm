import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { createHmac } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const SECRET = 'sk_test_hosting_http_secret_sentinel'
const WEBHOOK_SECRET = 'whsec_hosting_http_secret_sentinel'
const RAW_ERROR = 'raw-provider-secret-sentinel-do-not-expose'
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

// Written only into this test's private demo. The default outbound network guard loads first.
// Persist provider receipts before simulating a lost response, so restarting the actual app
// cannot turn a retry into a fresh provider session. This fixture never opens a network socket.
function installStripeFixture() {
  if (process.env.PSC_DEMO !== '1' || !process.env.PSC_HOSTING_HTTP_FIXTURE) throw new Error('Isolated hosting demo required')
  const path = process.env.PSC_HOSTING_HTTP_FIXTURE
  const guardedFetch = globalThis.fetch
  const read = () => JSON.parse(readFileSync(path, 'utf8'))
  const write = state => writeFileSync(path, JSON.stringify(state))
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input))
    if (url.origin !== 'https://api.stripe.com') return guardedFetch(input, options)
    const state = read(), method = options.method || 'GET', headers = new Headers(options.headers)
    if (headers.get('Authorization') !== 'Bearer ' + process.env.PSC_PLATFORM_STRIPE_SECRET) throw new Error('Wrong fixture account credential')
    const request = { method, path: url.pathname, query: url.search, key: headers.get('Idempotency-Key') }
    state.requests.push(request)
    if (method === 'GET' && url.pathname === '/v1/account') {
      write(state)
      return reply({ object: 'account', id: 'acct_hostingFixture', ignored_private_value: 'raw-provider-secret-sentinel-do-not-expose' })
    }
    if (method === 'POST' && url.pathname === '/v1/checkout/sessions') {
      const body = options.body
      if (typeof body !== 'string' || !request.key) throw new Error('Fixture requires immutable body and idempotency key')
      const previous = state.idempotency[request.key]
      if (previous && previous.body !== body) throw new Error('Fixture idempotency parameters changed')
      let session
      if (previous) session = state.sessions[previous.id]
      else {
        const p = new URLSearchParams(body), id = 'cs_hostingFixture_' + (++state.sequence)
        const metadata = {}, productMetadata = {}, subscriptionMetadata = {}
        for (const [key, value] of p) {
          if (key.startsWith('metadata[')) metadata[key.slice(9, -1)] = value
          if (key.startsWith('subscription_data[metadata][')) subscriptionMetadata[key.slice('subscription_data[metadata]['.length, -1)] = value
          if (key.startsWith('line_items[0][price_data][product_data][metadata][')) productMetadata[key.slice('line_items[0][price_data][product_data][metadata]['.length, -1)] = value
        }
        session = {
          object: 'checkout.session', id, mode: p.get('mode'), status: 'open', livemode: false,
          url: 'https://checkout.stripe.com/c/pay/' + id, customer: p.get('customer'), subscription: null,
          client_reference_id: p.get('client_reference_id'), metadata,
          success_url: p.get('success_url'), cancel_url: p.get('cancel_url'),
          allow_promotion_codes: p.get('allow_promotion_codes') === 'true', expires_at: Math.floor(Date.now() / 1000) + 3600,
          line_items: { has_more: false, data: [{ quantity: Number(p.get('line_items[0][quantity]')), price: {
            currency: p.get('line_items[0][price_data][currency]'), unit_amount: Number(p.get('line_items[0][price_data][unit_amount]')),
            recurring: { interval: p.get('line_items[0][price_data][recurring][interval]'), interval_count: 1 },
            product: { name: p.get('line_items[0][price_data][product_data][name]'), metadata: productMetadata },
          } }] },
        }
        state.sessions[id] = session
        state.subscriptionMetadata[id] = subscriptionMetadata
        state.idempotency[request.key] = { id, body }
      }
      state.creates.push({ key: request.key, body, id: session.id })
      const lose = state.loseNextCreate
      state.loseNextCreate = false
      write(state)
      await new Promise(resolve => setTimeout(resolve, 100))
      if (lose) throw new Error('raw-provider-secret-sentinel-do-not-expose')
      return reply(session)
    }
    const expire = url.pathname.match(/^\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)\/expire$/)
    if (method === 'POST' && expire && state.sessions[expire[1]]) {
      if (!request.key?.endsWith('_expire')) throw new Error('Fixture expiration requires its own idempotency key')
      const session = state.sessions[expire[1]]
      if (session.status !== 'open') { write(state); return reply({ error: { message: 'Session no longer open' } }, 400) }
      session.status = 'expired'; session.url = null; write(state)
      return reply(session)
    }
    const checkout = url.pathname.match(/^\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/)
    if (method === 'GET' && checkout && state.sessions[checkout[1]]) {
      if (url.searchParams.get('expand[]') !== 'line_items.data.price.product') throw new Error('Fixture requires checkout line expansion')
      write(state); return reply(state.sessions[checkout[1]])
    }
    const subscription = url.pathname.match(/^\/v1\/subscriptions\/(sub_[A-Za-z0-9_]+)$/)
    if (method === 'GET' && subscription && state.subscriptions[subscription[1]]) {
      if (url.searchParams.get('expand[]') !== 'items.data.price.product') throw new Error('Fixture requires subscription expansion')
      write(state); return reply(state.subscriptions[subscription[1]])
    }
    state.unexpected.push(request); write(state)
    throw new Error('Unexpected synthetic Stripe request')
  }
}

test('hosting HTTP keeps one recoverable checkout, exact subscription ownership and private responses', { timeout: 180000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'psc-hosting-http-')), demo = join(root, 'demo'), probe = createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  let child, control, logs = '', responseBodies = '', env, ownerCookie, annual, neighborCookie, neighborId
  const roleCookies = {}
  const fixture = join(root, 'provider.json'), base = `http://127.0.0.1:${port}`
  const state = () => JSON.parse(readFileSync(fixture, 'utf8'))
  const mutate = callback => { const current = state(); callback(current); writeFileSync(fixture, JSON.stringify(current)) }
  const stop = async () => {
    if (!child || child.exitCode !== null) return
    const exited = new Promise(resolve => child.once('exit', resolve))
    child.kill('SIGTERM')
    await Promise.race([exited, pause(3000)])
    if (child.exitCode === null) { child.kill('SIGKILL'); await exited }
  }
  const start = async () => {
    let boot = ''
    child = spawn(process.execPath, ['--no-warnings', '--import', './bin/demo-network-guard.mjs', '--import', './hosting-provider-fixture.mjs', 'server.mjs'], { cwd: demo, env, stdio: ['ignore', 'pipe', 'pipe'] })
    for (const output of [child.stdout, child.stderr]) output.on('data', bytes => { boot += bytes; logs += bytes })
    for (let n = 0; n < 600 && child.exitCode === null && !boot.includes('(ws /ws live'); n++) await pause(50)
    assert.match(boot, /ws \/ws live/, 'isolated hosting server failed to start')
  }
  const request = async (path, { body, cookie = ownerCookie, method = body === undefined ? 'GET' : 'POST' } = {}) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const text = await response.text()
    responseBodies += text + '\n'
    if (path.startsWith('/api/billing') || path.startsWith('/api/admin')) {
      assert.match(response.headers.get('cache-control') || '', /private/)
      assert.match(response.headers.get('cache-control') || '', /no-store/)
      assert.doesNotMatch(text, /"(?:request_body|request_digest|idempotency_key|account_scope|lease_token|lease_until)"/)
    }
    return { status: response.status, headers: response.headers, json: text ? JSON.parse(text) : null }
  }
  const ok = async (path, options) => { const result = await request(path, options); assert.equal(result.status, 200, JSON.stringify(result.json)); return result.json }
  const startCheckout = (interval = 'month', cookie = ownerCookie) => request('/api/billing/checkout', { cookie, body: { plan: 'everything', interval } })
  const webhook = async (type, object, { valid = true, account } = {}) => {
    const timestamp = Math.floor(Date.now() / 1000)
    const body = JSON.stringify({ id: 'evt_hostingFixture_' + type.replaceAll('.', '_'), type, ...(account ? { account } : {}), data: { object } })
    const signature = createHmac('sha256', WEBHOOK_SECRET).update(timestamp + '.' + body).digest('hex')
    const response = await fetch(base + '/webhooks/stripe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${timestamp},v1=${valid ? signature : '0'.repeat(64)}` }, body })
    responseBodies += await response.text()
    return response.status
  }
  const cookieFrom = response => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  try {
    const built = spawnSync(process.execPath, ['bin/demo.mjs', demo, String(port)], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 90000 })
    assert.equal(built.status, 0, built.stderr)
    env = JSON.parse(readFileSync(join(demo, 'demo-env.json'), 'utf8'))
    Object.assign(env, { PSC_TICK_MS: '3600000', PSC_PLATFORM_STRIPE_SECRET: SECRET, PSC_STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, PSC_HOSTING_HTTP_FIXTURE: fixture, PSC_ADMIN_EMAIL: 'dylan@example.test' })
    writeFileSync(fixture, JSON.stringify({ sequence: 0, requests: [], creates: [], sessions: {}, subscriptions: {}, subscriptionMetadata: {}, idempotency: {}, unexpected: [], loseNextCreate: false }))
    writeFileSync(join(demo, 'hosting-provider-fixture.mjs'), "import {readFileSync,writeFileSync} from 'node:fs';\n(" + installStripeFixture.toString() + ')();\n')
    control = new DatabaseSync(join(demo, 'data', 'control.db'))
    control.exec('PRAGMA busy_timeout=5000')
    const owner = control.prepare('SELECT * FROM members LIMIT 1').get(), tenantId = owner.tenant_id
    const tenant = () => control.prepare('SELECT plan_tier,subscription_status,stripe_customer_id,stripe_subscription_id FROM tenants WHERE id=?').get(tenantId)
    const intents = id => control.prepare('SELECT * FROM hosting_checkout_intents WHERE tenant_id=? ORDER BY rowid').all(id)
    await start()
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'dylan@example.test', password: readFileSync(join(demo, 'LOGIN.txt'), 'utf8').match(/Password: (.+)/)[1] }) })
    assert.equal(login.status, 200)
    ownerCookie = cookieFrom(login)

    await t.test('authentication, owner-only actions and private status do not reveal saved payment parameters', async () => {
      for (const path of ['/api/billing', '/api/billing/checkout', '/api/billing/checkout/reconcile', '/api/billing/checkout/expire']) {
        const response = await request(path, { cookie: '', ...(path === '/api/billing' ? {} : { body: { plan: 'everything' } }) })
        assert.equal(response.status, 401)
      }
      for (const role of ['manager', 'staff']) {
        const id = Number(control.prepare('INSERT INTO members(tenant_id,name,email,password_hash,role,status) VALUES(?,?,?,?,?,?)').run(tenantId, role + ' fixture', role + '@hosting.example.test', owner.password_hash, role, 'active').lastInsertRowid)
        const token = 'hosting-http-' + role
        control.prepare('INSERT INTO sessions(token,tenant_id,member_id,expires_at) VALUES(?,?,?,?)').run(token, tenantId, id, new Date(Date.now() + 3600000).toISOString().replace('T', ' ').slice(0, 19))
        const cookie = ownerCookie.replace(/=[^;]+/, '=' + token)
        roleCookies[role] = cookie
        const billing = await ok('/api/billing', { cookie })
        assert.equal(billing.can_manage, false); assert.equal(billing.hosting_checkout, null)
        for (const path of ['/api/billing/checkout', '/api/billing/checkout/reconcile', '/api/billing/checkout/expire']) {
          assert.equal((await request(path, { cookie, body: { plan: 'everything' } })).status, 403)
        }
      }
      const initial = await ok('/api/billing')
      assert.equal(initial.can_manage, true); assert.equal(initial.hosting_checkout.intent, null)
      assert.equal((await request('/api/billing/checkout', { body: { plan: 'pro' } })).json.code, 'hosting_plan_unavailable')
      assert.equal((await request('/api/billing/checkout', { body: { plan: 'everything', interval: 'weekly' } })).json.code, 'hosting_interval_invalid')
      assert.equal((await request('/api/billing/checkout/reconcile', { body: { session_id: ['cs_other'] } })).json.code, 'hosting_session_invalid')
      assert.equal(intents(tenantId).length, 0); assert.equal(state().requests.length, 0)
    })

    await t.test('parallel starts create one session, changed details wait for verified expiration', async () => {
      const responses = await Promise.all([startCheckout(), startCheckout()])
      assert.equal(responses.filter(response => response.status === 200).length, 1)
      const busy = responses.find(response => response.status !== 200)
      assert.equal(busy.status, 503); assert.equal(busy.json.code, 'hosting_checkout_busy'); assert.equal(busy.headers.get('retry-after'), '10')
      const first = responses.find(response => response.status === 200).json
      assert.equal(first.intent.state, 'open'); assert.equal(first.url, first.intent.url)
      assert.equal(intents(tenantId).length, 1); assert.equal(state().creates.length, 1)
      const replay = await startCheckout()
      assert.equal(replay.status, 200); assert.equal(replay.json.intent.id, first.intent.id); assert.equal(replay.json.intent.session_id, first.intent.session_id)
      assert.equal(state().creates.length, 1, 'known session is retrieved, never recreated')
      const changed = await startCheckout('year')
      assert.equal(changed.status, 409); assert.equal(changed.json.code, 'hosting_checkout_parameters_changed')
      assert.equal(intents(tenantId).length, 1); assert.equal(state().creates.length, 1)
      const expired = await ok('/api/billing/checkout/expire', { body: {} })
      assert.equal(expired.intent.state, 'expired'); assert.equal(expired.url, null)
      assert.equal(state().sessions[first.intent.session_id].status, 'expired')
      const expiration = state().requests.find(row => row.path.endsWith('/expire'))
      assert.equal(expiration.key, state().creates[0].key + '_expire')
      const next = await startCheckout('year')
      assert.equal(next.status, 200, JSON.stringify(next.json)); annual = next.json.intent
      assert.notEqual(annual.id, first.intent.id); assert.notEqual(annual.session_id, first.intent.session_id)
      assert.equal(annual.interval, 'year'); assert.equal(intents(tenantId).length, 2)
      assert.notEqual(state().creates[0].key, state().creates[1].key)
      assert.equal(new URLSearchParams(state().creates[1].body).get('line_items[0][price_data][recurring][interval]'), 'year')
    })

    await t.test('signed completion retrieves the exact subscription and donation or replay cannot replace it', async () => {
      assert.ok(annual, 'annual checkout must exist')
      const before = tenant(), subId = 'sub_hostingFixture_annual', customerId = 'cus_hostingFixture_owner'
      mutate(current => {
        const session = current.sessions[annual.session_id]
        Object.assign(session, { status: 'complete', payment_status: 'paid', customer: customerId, subscription: subId, url: null, amount_total: 100 })
        current.subscriptions[subId] = { object: 'subscription', id: subId, customer: customerId, status: 'active', livemode: false, metadata: current.subscriptionMetadata[annual.session_id], items: session.line_items }
      })
      const completed = state().sessions[annual.session_id]
      assert.equal((await webhook('checkout.session.completed', completed, { valid: false })), 400)
      assert.deepEqual(tenant(), before)
      assert.equal(await webhook('checkout.session.completed', completed), 200)
      const active = tenant()
      assert.equal(active.stripe_subscription_id, subId); assert.equal(active.stripe_customer_id, customerId); assert.equal(active.subscription_status, 'active')
      assert.equal(intents(tenantId)[1].state, 'complete')
      assert.equal((await ok('/api/billing')).hosting_checkout.intent.url, null)
      assert.equal(await webhook('checkout.session.completed', completed), 200)
      assert.deepEqual(tenant(), active); assert.equal(intents(tenantId).length, 2)
      const reads = state().requests.length
      for (const [type, object] of [
        ['checkout.session.completed', { id: 'cs_fixtureDonation', mode: 'subscription', status: 'complete', customer: customerId, subscription: 'sub_fixtureDonation', client_reference_id: String(tenantId), metadata: { purpose: 'project_support', tenant_id: String(tenantId) } }],
        ['customer.subscription.deleted', { id: 'sub_fixtureDonation', customer: customerId, status: 'canceled' }],
        ['invoice.payment_failed', { customer: customerId, subscription: 'sub_fixtureDonation' }],
      ]) { assert.equal(await webhook(type, object), 200); assert.deepEqual(tenant(), active) }
      assert.equal(await webhook('customer.subscription.deleted', { id: subId, customer: customerId, status: 'canceled' }, { account: 'acct_connectedFixture' }), 200)
      assert.deepEqual(tenant(), active); assert.equal(state().requests.length, reads, 'unrelated support/Connect events never query hosting')
      const existing = await startCheckout()
      assert.equal(existing.status, 409); assert.equal(existing.json.code, 'hosting_subscription_exists')
      assert.equal(control.prepare('SELECT count(*) AS n FROM hosting_checkout_anomalies WHERE tenant_id=?').get(tenantId).n, 0)
    })

    await t.test('lost create response survives restart and reuses the exact request, key and provider session', async () => {
      const signup = await fetch(base + '/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shop_name: 'Hosting recovery fixture', owner_name: 'Recovery fixture', owner_email: 'hosting-recovery@example.test', password: 'Hosting-recovery-fixture-password-1' }) })
      assert.equal(signup.status, 200, await signup.clone().text())
      neighborCookie = cookieFrom(signup)
      neighborId = control.prepare("SELECT id FROM tenants WHERE owner_email='hosting-recovery@example.test'").get().id
      mutate(current => { current.loseNextCreate = true })
      const failed = await startCheckout('month', neighborCookie)
      assert.equal(failed.status, 503); assert.equal(failed.json.code, 'hosting_checkout_unavailable')
      const saved = intents(neighborId)[0], created = state().creates.at(-1)
      assert.equal(saved.state, 'unknown'); assert.equal(saved.session_id, null); assert.equal(saved.idempotency_key, created.key)
      const status = await ok('/api/billing', { cookie: neighborCookie })
      assert.equal(status.hosting_checkout.intent.state, 'unknown'); assert.equal(status.hosting_checkout.intent.url, null)
      assert.equal(status.hosting_checkout.intent.can_retry, false)
      await stop(); await start()
      const delay = Math.max(0, saved.retry_at - Date.now() + 50)
      assert.ok(delay < 5000, 'fixture recovery backoff is bounded'); await pause(delay)
      const wrongSession = await request('/api/billing/checkout/reconcile', { cookie: neighborCookie, body: { session_id: annual.session_id } })
      assert.equal(wrongSession.status, 409); assert.equal(wrongSession.json.code, 'hosting_checkout_mismatch')
      assert.equal(intents(neighborId)[0].session_id, null, 'another tenant session cannot attach to the pending receipt')
      const recovered = await ok('/api/billing/checkout/reconcile', { cookie: neighborCookie, body: {} })
      assert.equal(recovered.intent.state, 'open'); assert.equal(recovered.intent.id, saved.id); assert.equal(recovered.intent.session_id, created.id)
      const attempts = state().creates.filter(row => row.key === created.key)
      assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1])
      assert.equal(intents(neighborId).length, 1); assert.equal(intents(neighborId)[0].request_body, saved.request_body)
      assert.equal(intents(neighborId)[0].idempotency_key, saved.idempotency_key)
      assert.equal(Object.values(state().idempotency).filter(row => row.id === created.id).length, 1)
      const refreshed = await startCheckout('month', neighborCookie)
      assert.equal(refreshed.status, 200); assert.equal(refreshed.json.intent.session_id, created.id)
      assert.equal(state().creates.filter(row => row.key === created.key).length, 2)
    })

    await t.test('only the platform owner can resolve a review after provider-confirmed termination', async () => {
      assert.ok(neighborCookie && neighborId, 'ordinary shop owner must exist independently from the platform admin')
      const pending = intents(neighborId)[0], customerId = 'cus_hostingFixture_neighbor'
      const extraId = 'sub_hostingFixture_extra', currentId = 'sub_hostingFixture_current'
      // Represent another genuine subscription winning the binding while this known checkout
      // was payable. Only synthetic provider/control data is changed, never a live account.
      control.prepare("UPDATE tenants SET stripe_customer_id=?,stripe_subscription_id=?,subscription_status='active',plan_tier='everything',plan='paid' WHERE id=?").run(customerId, currentId, neighborId)
      const binding = () => control.prepare('SELECT stripe_customer_id,stripe_subscription_id,subscription_status FROM tenants WHERE id=?').get(neighborId)
      const current = binding()
      mutate(provider => {
        const session = provider.sessions[pending.session_id]
        Object.assign(session, { status: 'complete', payment_status: 'paid', customer: customerId, subscription: extraId, url: null })
        provider.subscriptions[extraId] = { object: 'subscription', id: extraId, customer: customerId, status: 'active', livemode: false, metadata: provider.subscriptionMetadata[pending.session_id], items: session.line_items }
      })
      const completed = state().sessions[pending.session_id]
      assert.equal(await webhook('checkout.session.completed', completed), 200)
      assert.deepEqual(binding(), current, 'the extra paid subscription cannot replace the current binding')
      const reviewPath = `/api/admin/shops/${neighborId}/hosting`, resolvePath = '/api/admin/hosting-checkout/resolve'
      const review = await ok(reviewPath)
      assert.equal(review.intent.state, 'held'); assert.equal(review.intent.url, null); assert.equal(review.anomalies.length, 1)
      const anomalyId = review.anomalies[0].id, body = { tenant_id: neighborId, anomaly_id: anomalyId, note: 'Checked the extra subscription in the synthetic account.' }
      const requestCount = state().requests.length
      for (const cookie of ['', neighborCookie, roleCookies.manager, roleCookies.staff]) {
        const expected = cookie ? 403 : 401
        assert.equal((await request(reviewPath, { cookie })).status, expected)
        assert.equal((await request(resolvePath, { cookie, body })).status, expected)
      }
      assert.equal(state().requests.length, requestCount, 'forbidden callers never inspect the provider')
      for (const patch of [{ note: '' }, { note: true }, { note: 'x'.repeat(1001) }, { tenant_id: String(neighborId) }, { anomaly_id: '../review' }]) {
        const rejected = await request(resolvePath, { body: { ...body, ...patch } })
        assert.equal(rejected.status, 400); assert.equal(rejected.json.code, 'hosting_review_invalid')
      }
      assert.equal(state().requests.length, requestCount, 'invalid resolution input never inspects the provider')
      const misplaced = await request(resolvePath, { body: { ...body, tenant_id: tenantId } })
      assert.equal(misplaced.status, 404, 'an anomaly is looked up within the selected tenant')
      const active = await request(resolvePath, { body })
      assert.equal(active.status, 409); assert.equal(active.json.code, 'hosting_checkout_payment_unresolved')
      assert.equal(control.prepare('SELECT resolved_at FROM hosting_checkout_anomalies WHERE id=?').get(anomalyId).resolved_at, null)
      assert.deepEqual(binding(), current)
      const postsBefore = state().requests.filter(row => row.method === 'POST').length
      mutate(provider => { provider.subscriptions[extraId].status = 'canceled' })
      const note = 'Confirmed the extra subscription ended; the current subscription is unchanged.'
      const resolved = await ok(resolvePath, { body: { ...body, note } })
      assert.equal(resolved.anomalies.length, 0); assert.equal(resolved.intent.state, 'closed'); assert.equal(resolved.intent.url, null)
      assert.equal(resolved.resolved_anomalies[0].id, anomalyId); assert.equal(resolved.resolved_anomalies[0].resolution_note, note)
      const recorded = control.prepare('SELECT * FROM hosting_checkout_anomalies WHERE id=?').get(anomalyId)
      assert.ok(recorded.resolved_at); assert.equal(JSON.parse(recorded.resolution_evidence).kind, 'ended_subscription')
      assert.equal(JSON.parse(recorded.resolution_evidence).subscription_id, extraId)
      assert.equal(intents(neighborId).length, 1, 'resolution retains the immutable checkout record')
      assert.ok(intents(neighborId)[0].resolved_at); assert.deepEqual(binding(), current)
      assert.equal(state().requests.filter(row => row.method === 'POST').length, postsBefore, 'review resolution never cancels, refunds or creates a provider payment')
      const after = state().requests.length
      const repeated = await ok(resolvePath, { body: { ...body, note: 'Retry must retain the original resolution.' } })
      assert.equal(repeated.resolved_anomalies[0].resolution_note, note)
      assert.equal(await webhook('checkout.session.completed', completed), 200)
      assert.equal(state().requests.length, after, 'resolved review and closed-intent replays need no provider write or read')
      assert.equal((await ok(reviewPath)).anomalies.length, 0); assert.deepEqual(binding(), current)
    })
    for (const secret of [SECRET, WEBHOOK_SECRET, RAW_ERROR, ownerCookie]) {
      assert.ok(!responseBodies.includes(secret), 'billing responses must not expose secrets or raw provider errors')
      assert.ok(!logs.includes(secret), 'server logs must not expose secrets or raw provider errors')
    }
    assert.deepEqual(state().unexpected, [], 'every synthetic provider request matches an explicit fixture endpoint')
    assert.doesNotMatch(logs, /External request blocked|External services are disabled/i, 'no provider request escaped the fixture into the outbound guard')
  } finally {
    await stop()
    control?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
