import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { readFixtureJson, writeFixtureJson, readFixtureRecords } from './helpers/json-fixture.mjs'
import { createHttpTestServer } from './helpers/http-test-server.mjs'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { buildHostingCheckoutRequest, HOSTING_PURPOSE } from '../lib/billing.mjs'

const SECRET = 'sk_test_hosting_deletion_secret_sentinel'
const WEBHOOK_SECRET = 'whsec_hosting_deletion_secret_sentinel'
const RAW_ERROR = 'raw-hosting-deletion-provider-error-sentinel'
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

// This function is serialized into the private demo and loaded AFTER its default network guard.
// Only synthetic account/subscription/session reads exist; any mutation is a fixture failure.
function installDeletionProvider() {
  if (process.env.PSC_DEMO !== '1' || !process.env.PSC_HOSTING_DELETION_FIXTURE) throw new Error('Private deletion fixture required')
  const path = process.env.PSC_HOSTING_DELETION_FIXTURE, guardedFetch = globalThis.fetch
  const read = () => readFixtureJson(path)
  let sequence = readFixtureRecords(path + '.requests').length
  const record = request => writeFixtureJson(join(path + '.requests', String(++sequence).padStart(8, '0') + '.json'), request)
  const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input))
    if (url.origin !== 'https://api.stripe.com') return guardedFetch(input, options)
    const state = read(), method = options.method || 'GET', headers = new Headers(options.headers)
    if (headers.get('authorization') !== 'Bearer ' + process.env.PSC_PLATFORM_STRIPE_SECRET) throw new Error('Wrong synthetic account credential')
    const request = { method, path: url.pathname, query: url.search }
    request.unexpected = method !== 'GET' || (url.pathname !== '/v1/account' && !/^\/v1\/subscriptions\/sub_[A-Za-z0-9_]+$/.test(url.pathname) && !state.sessions[url.pathname.split('/').at(-1)])
    record(request)
    if (method !== 'GET') throw new Error('Deletion must never change a provider payment')
    if (url.pathname === '/v1/account') {
      return reply({ object: 'account', id: state.account_id, private_account_value: 'raw-hosting-deletion-provider-error-sentinel' })
    }
    const sub = url.pathname.match(/^\/v1\/subscriptions\/(sub_[A-Za-z0-9_]+)$/)
    if (sub) {
      if (url.searchParams.get('expand[]') !== 'items.data.price.product') throw new Error('Full subscription evidence required')
      const id = sub[1], result = state.subscriptions[id], failure = state.failures[id]
      if (state.defer_subscription === id) {
        const deadline = Date.now() + 5000
        while (!read().release_read) {
          if (Date.now() >= deadline) throw new Error('Synthetic provider barrier timed out')
          await new Promise(resolve => setTimeout(resolve, 10))
        }
      }
      if (failure === 'throw') throw new Error('raw-hosting-deletion-provider-error-sentinel')
      if (failure === 'http') return reply({ error: { message: 'raw-hosting-deletion-provider-error-sentinel' } }, 503)
      if (!result || failure === 'missing') return reply({ error: { message: 'raw-hosting-deletion-provider-error-sentinel' } }, 404)
      return reply(result)
    }
    const session = url.pathname.match(/^\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/)
    if (session && state.sessions[session[1]]) return reply(state.sessions[session[1]])
    throw new Error('Unexpected synthetic hosting deletion read')
  }
}

test('admin HTTP deletion verifies recorded hosting before removing any shop data', { timeout: 180000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'psc-hosting-deletion-http-')), demo = join(root, 'demo'), server = await createHttpTestServer()
  const {port,base} = server, fixture = join(root, 'provider.json')
  let control, ownerCookie, env, logs = '', deletionResponses = '', shopNumber = 0
  const provider = () => { const requests = readFixtureRecords(fixture + '.requests'); return { ...readFixtureJson(fixture), requests, unexpected: requests.filter(row => row.unexpected) } }
  const mutateProvider = callback => { const state = readFixtureJson(fixture); callback(state); writeFixtureJson(fixture, state) }
  const cookies = response => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const request = async (path, { method = 'GET', body, cookie = ownerCookie } = {}) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const text = await response.text(), json = text ? JSON.parse(text) : null
    if (path.startsWith('/api/admin') || path.startsWith('/api/billing')) {
      assert.match(response.headers.get('cache-control') || '', /private/)
      assert.match(response.headers.get('cache-control') || '', /no-store/)
      assert.doesNotMatch(text, /"(?:authorization_token|lease_token|request_body|request_digest|account_scope|idempotency_key|identity_json)"/)
    }
    deletionResponses += text + '\n'
    if (method === 'DELETE') {
      assert.doesNotMatch(text, /"(?:authorization_token|lease_token|request_body|request_digest|account_scope|idempotency_key)"/)
    }
    return { status: response.status, headers: response.headers, json }
  }
  const webhook = async object => {
    const timestamp = Math.floor(Date.now() / 1000)
    const body = JSON.stringify({ id: 'evt_deletionFixture_' + randomUUID().replaceAll('-', ''), type: 'checkout.session.completed', data: { object } })
    const signature = createHmac('sha256', WEBHOOK_SECRET).update(timestamp + '.' + body).digest('hex')
    const response = await fetch(base + '/webhooks/stripe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${timestamp},v1=${signature}` }, body })
    deletionResponses += await response.text()
    return response.status
  }
  const remove = (id, cookie = ownerCookie) => request(`/api/admin/shops/${id}`, { method: 'DELETE', cookie })
  const makeShop = async () => {
    const number = ++shopNumber, email = `deletion-${number}@example.test`, password = `Deletion-fixture-password-${number}`
    const created = await request('/api/admin/shops', { method: 'POST', body: { shop_name: `Deletion fixture ${number}`, owner_name: 'Deletion fixture', owner_email: email, password } })
    assert.equal(created.status, 200, JSON.stringify(created.json))
    const shop = created.json.shop, dir = join(demo, 'data', 'tenants', shop.slug)
    assert.ok(existsSync(join(dir, 'printshop.db')))
    const marker = `Retain artwork for shop ${shop.id}`
    writeFileSync(join(dir, 'deletion-artwork-fixture.txt'), marker)
    const db = new DatabaseSync(join(dir, 'printshop.db'))
    try { db.prepare('INSERT INTO contacts(name,email) VALUES(?,?)').run(`Keep customer ${shop.id}`, `customer-${shop.id}@example.test`) } finally { db.close() }
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })
    assert.equal(login.status, 200)
    return { ...shop, dir, marker, cookie: cookies(login) }
  }
  const snapshot = shop => {
    assert.ok(existsSync(join(shop.dir, 'printshop.db')), 'the protected database must still exist before opening it')
    const db = new DatabaseSync(join(shop.dir, 'printshop.db'), { readOnly: true })
    try {
      return {
        tenant: control.prepare('SELECT id,slug,status,plan_tier,subscription_status,stripe_customer_id,stripe_subscription_id,hosting_revision FROM tenants WHERE id=?').get(shop.id),
        members: control.prepare('SELECT id,name,email,role,status FROM members WHERE tenant_id=? ORDER BY id').all(shop.id),
        sessions: control.prepare('SELECT token,member_id,expires_at FROM sessions WHERE tenant_id=? ORDER BY token').all(shop.id),
        contacts: db.prepare('SELECT id,name,email FROM contacts ORDER BY id').all(),
        history: control.prepare('SELECT id,state,session_id,subscription_id,request_digest FROM hosting_checkout_intents WHERE tenant_id=? ORDER BY id').all(shop.id),
        artwork: readFileSync(join(shop.dir, 'deletion-artwork-fixture.txt'), 'utf8'),
      }
    } finally { db.close() }
  }
  const seedHosting = (shop, { localStatus = 'active', providerStatus = 'active', scheduledCancellation = false } = {}) => {
    const intentId = randomUUID(), customerId = `cus_deletionFixture_${shop.id}`, subscriptionId = `sub_deletionFixture_${shop.id}`, sessionId = `cs_deletionFixture_${shop.id}`
    const body = buildHostingCheckoutRequest({ plan: 'everything', interval: 'month', tenantId: shop.id, intentId, origin: base, email: shop.owner_email, customerId })
    const p = new URLSearchParams(body), stamp = Date.now()
    control.prepare("UPDATE tenants SET plan_tier='everything',plan='paid',subscription_status=?,stripe_customer_id=?,stripe_subscription_id=?,hosting_revision=hosting_revision+1 WHERE id=?").run(localStatus, customerId, subscriptionId, shop.id)
    control.prepare(`INSERT INTO hosting_checkout_intents(id,tenant_id,account_scope,request_body,request_digest,idempotency_key,expected_customer_id,expected_subscription_id,plan,interval,amount_cents,currency,state,session_id,subscription_id,expires_at,created_at,updated_at,first_attempt_at,attempts)
      VALUES(?,?,?,?,?,?,?,NULL,'everything','month',?,'usd','complete',?,?,?,?,?,?,1)`).run(intentId, shop.id, 'acct_deletionFixture:test', body, createHash('sha256').update(body).digest('hex'), 'psc_host_' + randomUUID(), customerId, Number(p.get('line_items[0][price_data][unit_amount]')), sessionId, subscriptionId, stamp + 3600000, stamp, stamp, stamp)
    const metadata = { purpose: HOSTING_PURPOSE, tenant_id: String(shop.id), plan: 'everything', hosting_intent: intentId }
    const items = { has_more: false, data: [{ quantity: 1, price: { currency: 'usd', unit_amount: Number(p.get('line_items[0][price_data][unit_amount]')), recurring: { interval: 'month', interval_count: 1 }, product: { name: p.get('line_items[0][price_data][product_data][name]'), metadata: { purpose: HOSTING_PURPOSE, plan: 'everything' } } } }] }
    mutateProvider(state => {
      state.subscriptions[subscriptionId] = { object: 'subscription', id: subscriptionId, customer: customerId, status: providerStatus, livemode: false, metadata, items, cancel_at_period_end: scheduledCancellation }
      state.sessions[sessionId] = { object: 'checkout.session', id: sessionId, mode: 'subscription', status: 'complete', livemode: false, customer: customerId, subscription: subscriptionId, metadata, line_items: items, client_reference_id: String(shop.id), success_url: p.get('success_url'), cancel_url: p.get('cancel_url'), allow_promotion_codes: true, expires_at: Math.floor(stamp / 1000) + 3600, url: null }
    })
    return { intentId, customerId, subscriptionId, sessionId }
  }
  const assertGone = shop => {
    assert.equal(control.prepare('SELECT id FROM tenants WHERE id=?').get(shop.id), undefined)
    assert.equal(control.prepare('SELECT count(*) AS n FROM members WHERE tenant_id=?').get(shop.id).n, 0)
    assert.equal(control.prepare('SELECT count(*) AS n FROM sessions WHERE tenant_id=?').get(shop.id).n, 0)
    assert.equal(existsSync(shop.dir), false)
  }
  const seedLegacyCheckout = shop => {
    const customerId = `cus_legacyDeletionFixture_${shop.id}`, subscriptionId = `sub_legacyDeletionFixture_${shop.id}`, sessionId = `cs_legacyDeletionFixture_${shop.id}`
    const p = new URLSearchParams(buildHostingCheckoutRequest({ plan: 'everything', interval: 'month', tenantId: shop.id, intentId: randomUUID(), origin: base, email: shop.owner_email }))
    // Genuine pre-intent shape: no local intent, no existing binding, and no hosting_intent
    // or purpose metadata. Admission must verify the exact legacy product and recurring price.
    const metadata = { tenant_id: String(shop.id), plan: 'everything' }
    const items = { has_more: false, data: [{ quantity: 1, price: { currency: 'usd', unit_amount: Number(p.get('line_items[0][price_data][unit_amount]')), recurring: { interval: 'month', interval_count: 1 }, product: { name: 'PrintShopCRM Everything', metadata: {} } } }] }
    const session = { object: 'checkout.session', id: sessionId, mode: 'subscription', status: 'complete', livemode: false, customer: customerId, subscription: subscriptionId, metadata, line_items: items, client_reference_id: String(shop.id), url: null }
    mutateProvider(state => {
      state.subscriptions[subscriptionId] = { object: 'subscription', id: subscriptionId, customer: customerId, status: 'active', livemode: false, metadata, items }
      state.sessions[sessionId] = session
    })
    return { session, customerId, subscriptionId, sessionId }
  }
  try {
    const built = spawnSync(process.execPath, ['bin/demo.mjs', demo, String(port)], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 90000 })
    assert.equal(built.status, 0, built.stderr)
    env = JSON.parse(readFileSync(join(demo, 'demo-env.json'), 'utf8'))
    Object.assign(env, { PSC_TICK_MS: '3600000', PSC_PLATFORM_STRIPE_SECRET: SECRET, PSC_STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, PSC_ADMIN_EMAIL: 'dylan@example.test', PSC_HOSTING_DELETION_FIXTURE: fixture })
    mkdirSync(fixture + '.requests')
    writeFixtureJson(fixture, { account_id: 'acct_deletionFixture', subscriptions: {}, sessions: {}, failures: {}, defer_subscription: null, release_read: false })
    writeFileSync(join(demo, 'hosting-json-fixture.mjs'), readFileSync(new URL('./helpers/json-fixture.mjs', import.meta.url)))
    writeFileSync(join(demo, 'hosting-deletion-provider.mjs'), "import {join} from 'node:path';\nimport {readFixtureJson,writeFixtureJson,readFixtureRecords} from './hosting-json-fixture.mjs';\n(" + installDeletionProvider.toString() + ')();\n')
    control = new DatabaseSync(join(demo, 'data', 'control.db')); control.exec('PRAGMA busy_timeout=5000')
    await server.start({cwd:demo,env,args:['--no-warnings','--import','./bin/demo-network-guard.mjs','--import','./hosting-deletion-provider.mjs','server.mjs'],onOutput:text=>{logs+=text}})
    await server.assertPortOwned()
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'dylan@example.test', password: readFileSync(join(demo, 'LOGIN.txt'), 'utf8').match(/Password: (.+)/)[1] }) })
    assert.equal(login.status, 200); ownerCookie = cookies(login)
    const owner = control.prepare("SELECT * FROM members WHERE email='dylan@example.test'").get()

    await t.test('admin-only deletion keeps self-deletion blocked and unbilled deletion compatible', async () => {
      const shop = await makeShop(), before = snapshot(shop)
      assert.equal((await remove(shop.id, '')).status, 401)
      assert.equal((await remove(shop.id, shop.cookie)).status, 403)
      for (const role of ['staff', 'manager']) {
        const memberId = Number(control.prepare('INSERT INTO members(tenant_id,name,email,password_hash,role,status) VALUES(?,?,?,?,?,?)').run(owner.tenant_id, role, `deletion-${role}@example.test`, owner.password_hash, role, 'active').lastInsertRowid)
        const token = 'deletion-http-' + role
        control.prepare('INSERT INTO sessions(token,tenant_id,member_id,expires_at) VALUES(?,?,?,?)').run(token, owner.tenant_id, memberId, new Date(Date.now() + 3600000).toISOString().replace('T', ' ').slice(0, 19))
        assert.equal((await remove(shop.id, ownerCookie.replace(/=[^;]+/, '=' + token))).status, 403)
      }
      assert.equal((await remove(owner.tenant_id)).status, 400)
      for (const id of ['0', '-1', '1junk', '9007199254740992']) assert.equal((await remove(id)).status, 400)
      assert.deepEqual(snapshot(shop), before); assert.equal(provider().requests.length, 0)
      const removed = await remove(shop.id)
      assert.equal(removed.status, 200, JSON.stringify(removed.json)); assert.equal(removed.json.ok, true); assert.equal(removed.json.dataRemoved, true)
      assertGone(shop); assert.equal(provider().requests.length, 0, 'never-billed deletion does not need a provider')
      assert.equal((await request('/api/auth/me', { cookie: shop.cookie })).json.authed, false)
      assert.equal((await request('/api/contacts', { cookie: shop.cookie })).status, 401)
    })

    await t.test('local active and stale canceled flags cannot delete provider-active subscriptions', async () => {
      for (const localStatus of ['active', 'canceled']) {
        const shop = await makeShop(), ids = seedHosting(shop, { localStatus, providerStatus: 'active', scheduledCancellation: localStatus === 'canceled' }), before = snapshot(shop)
        const reads = provider().requests.length, result = await remove(shop.id)
        assert.equal(result.status, 409, JSON.stringify(result.json)); assert.equal(result.json.code, 'hosting_deletion_active')
        assert.deepEqual(snapshot(shop), before, localStatus + ' refusal must preserve registry, access, data, artwork and history')
        assert.ok(provider().requests.slice(reads).some(row => row.path === '/v1/account'))
        assert.ok(provider().requests.slice(reads).some(row => row.path === '/v1/subscriptions/' + ids.subscriptionId))
        assert.equal(provider().subscriptions[ids.subscriptionId].status, 'active')
        assert.equal((await request('/api/auth/me', { cookie: shop.cookie })).json.authed, true)
      }
    })

    await t.test('verified terminal subscriptions allow deletion and preserve billing history on retry', async () => {
      for (const providerStatus of ['canceled', 'incomplete_expired']) {
        const shop = await makeShop(), ids = seedHosting(shop, { localStatus: 'active', providerStatus }), history = snapshot(shop).history
        const result = await remove(shop.id)
        assert.equal(result.status, 200, JSON.stringify(result.json)); assert.equal(result.json.ok, true); assert.equal(result.json.dataRemoved, true)
        assertGone(shop)
        assert.deepEqual(control.prepare('SELECT id,state,session_id,subscription_id,request_digest FROM hosting_checkout_intents WHERE tenant_id=? ORDER BY id').all(shop.id), history)
        assert.equal(provider().subscriptions[ids.subscriptionId].status, providerStatus)
        const reads = provider().requests.length, repeated = await remove(shop.id)
        assert.equal(repeated.status, 200, JSON.stringify(repeated.json)); assert.equal(repeated.json.ok, true); assert.equal(repeated.json.dataRemoved, true)
        assert.equal(provider().requests.length, reads, 'a persisted successful deletion replays without new provider work')
      }
    })

    await t.test('provider errors and missing subscriptions fail safely without leaving deletion approval', async () => {
      const shop = await makeShop(), ids = seedHosting(shop, { localStatus: 'canceled', providerStatus: 'canceled' }), before = snapshot(shop)
      for (const failure of ['http', 'throw', 'missing']) {
        mutateProvider(state => { state.failures[ids.subscriptionId] = failure })
        const result = await remove(shop.id)
        assert.equal(result.status, 503, JSON.stringify(result.json)); assert.equal(result.json.code, 'hosting_deletion_unavailable'); assert.equal(result.headers.get('retry-after'), '10')
        assert.deepEqual(snapshot(shop), before)
      }
      mutateProvider(state => { delete state.failures[ids.subscriptionId]; state.subscriptions[ids.subscriptionId].status = 'active' })
      const changed = await remove(shop.id)
      assert.equal(changed.status, 409); assert.equal(changed.json.code, 'hosting_deletion_active')
      assert.deepEqual(snapshot(shop), before, 'an earlier failed verification cannot authorize a now-active subscription')
      mutateProvider(state => { state.subscriptions[ids.subscriptionId].status = 'canceled' })
      const recovered = await remove(shop.id)
      assert.equal(recovered.status, 200, JSON.stringify(recovered.json)); assertGone(shop)
    })

    await t.test('revision changes during provider I/O preserve the shop and require fresh verification', async () => {
      const shop = await makeShop(), ids = seedHosting(shop, { providerStatus: 'canceled' })
      mutateProvider(state => { state.defer_subscription = ids.subscriptionId; state.release_read = false })
      const pending = remove(shop.id)
      // Attach rejection handling immediately, even if a barrier/assertion below fails first.
      pending.catch(() => {})
      try {
        for (let n = 0; n < 300 && !provider().requests.some(row => row.path === '/v1/subscriptions/' + ids.subscriptionId); n++) await pause(10)
        assert.ok(provider().requests.some(row => row.path === '/v1/subscriptions/' + ids.subscriptionId), 'deletion reached the deferred provider read')
        // This independent SQLite connection must remain writable while the app awaits Stripe.
        // The displayed binding stays identical, so only the monotonic revision catches it.
        control.prepare('UPDATE tenants SET hosting_revision=hosting_revision+1 WHERE id=?').run(shop.id)
        const before = snapshot(shop)
        mutateProvider(state => { state.release_read = true })
        const result = await pending
        assert.equal(result.status, 409, JSON.stringify(result.json)); assert.equal(result.json.code, 'hosting_deletion_changed')
        assert.deepEqual(snapshot(shop), before)
      } finally {
        try { mutateProvider(state => { state.release_read = true; state.defer_subscription = null }) }
        finally { await pending.catch(() => {}) }
      }
      const retried = await remove(shop.id)
      assert.equal(retried.status, 200, JSON.stringify(retried.json)); assertGone(shop)
    })

    await t.test('admin recovers a failed signed legacy checkout callback from its durable visible receipt', async () => {
      const shop = await makeShop(), ids = seedLegacyCheckout(shop), before = snapshot(shop)
      const route = '/api/admin/hosting-verification/reconcile'
      mutateProvider(state => { state.failures[ids.subscriptionId] = 'http' })
      assert.equal(await webhook(ids.session), 503, 'a failed real provider read must request a signed webhook retry')
      assert.deepEqual(snapshot(shop), before, 'a failed callback cannot invent a local paid binding')
      const receipt = control.prepare("SELECT * FROM hosting_billing_verifications WHERE tenant_id=? AND state='pending'").get(shop.id)
      assert.ok(receipt); assert.match(receipt.id, /^[a-f0-9]{64}$/); assert.equal(receipt.session_id, ids.sessionId)
      assert.equal(control.prepare('SELECT count(*) AS n FROM hosting_billing_operations WHERE tenant_id=?').get(shop.id).n, 0)
      const body = { tenant_id: shop.id, verification_id: receipt.id }
      const ownerStatus = await request('/api/billing', { cookie: shop.cookie })
      const adminStatus = await request(`/api/admin/shops/${shop.id}/hosting`)
      assert.equal(ownerStatus.status, 200); assert.equal(adminStatus.status, 200)
      for (const visible of [ownerStatus.json.hosting_checkout.pending_verifications, adminStatus.json.pending_verifications]) {
        assert.equal(visible.length, 1)
        assert.deepEqual(Object.keys(visible[0]).sort(), ['created_at', 'id', 'session_id', 'subscription_id'])
        assert.equal(visible[0].id, receipt.id); assert.equal(visible[0].subscription_id, ids.subscriptionId)
        assert.equal(visible[0].session_id, ids.sessionId); assert.ok(Number.isSafeInteger(visible[0].created_at))
      }
      const reads = provider().requests.length
      assert.equal((await request(route, { method: 'POST', body, cookie: '' })).status, 401)
      assert.equal((await request(route, { method: 'POST', body, cookie: shop.cookie })).status, 403)
      for (const role of ['staff', 'manager']) {
        assert.equal((await request(route, { method: 'POST', body, cookie: ownerCookie.replace(/=[^;]+/, '=deletion-http-' + role) })).status, 403)
      }
      for (const invalid of [
        {}, { tenant_id: '1', verification_id: receipt.id }, { tenant_id: 0, verification_id: receipt.id },
        { tenant_id: 9007199254740992, verification_id: receipt.id },
        { tenant_id: shop.id, verification_id: [receipt.id] },
        { tenant_id: shop.id, verification_id: receipt.id + '\n' },
        { tenant_id: shop.id, verification_id: 'F'.repeat(64) },
      ]) assert.equal((await request(route, { method: 'POST', body: invalid })).status, 400)
      assert.equal((await request(route, { method: 'POST', body: { tenant_id: owner.tenant_id, verification_id: receipt.id } })).status, 404, 'a receipt cannot be reconciled against another shop')
      assert.equal(provider().requests.length, reads, 'authorization and shape failures must not contact a provider')
      const failed = await request(route, { method: 'POST', body })
      assert.equal(failed.status, 503); assert.equal(failed.headers.get('retry-after'), '10')
      assert.equal(control.prepare('SELECT state FROM hosting_billing_verifications WHERE id=?').get(receipt.id).state, 'pending')
      assert.deepEqual(snapshot(shop), before)
      mutateProvider(state => { delete state.failures[ids.subscriptionId]; state.subscriptions[ids.subscriptionId].status = 'past_due' })
      const recoveryReads = provider().requests.length, recovered = await request(route, { method: 'POST', body })
      assert.equal(recovered.status, 200, JSON.stringify(recovered.json)); assert.deepEqual(recovered.json.pending_verifications, [])
      const binding = control.prepare('SELECT stripe_customer_id,stripe_subscription_id,subscription_status,plan_tier FROM tenants WHERE id=?').get(shop.id)
      assert.deepEqual({ ...binding }, { stripe_customer_id: ids.customerId, stripe_subscription_id: ids.subscriptionId, subscription_status: 'past_due', plan_tier: 'everything' })
      const cleared = control.prepare('SELECT state,cleared_at FROM hosting_billing_verifications WHERE id=?').get(receipt.id)
      assert.equal(cleared.state, 'cleared'); assert.ok(Number.isSafeInteger(cleared.cleared_at))
      assert.ok(provider().requests.slice(recoveryReads).some(row => row.path === '/v1/checkout/sessions/' + ids.sessionId))
      assert.ok(provider().requests.slice(recoveryReads).some(row => row.path === '/v1/subscriptions/' + ids.subscriptionId))
      assert.deepEqual((await request('/api/billing', { cookie: shop.cookie })).json.hosting_checkout.pending_verifications, [])
      const replayReads = provider().requests.length, replay = await request(route, { method: 'POST', body })
      assert.equal(replay.status, 200); assert.deepEqual(replay.json.pending_verifications, [])
      assert.equal(provider().requests.length, replayReads, 'a cleared receipt replay must not start another provider action')
      assert.equal(control.prepare('SELECT count(*) AS n FROM hosting_billing_verifications WHERE tenant_id=?').get(shop.id).n, 1, 'recovery retains one audit receipt')
      assert.equal(readFileSync(join(shop.dir, 'deletion-artwork-fixture.txt'), 'utf8'), shop.marker)
      const denied = await remove(shop.id)
      assert.equal(denied.status, 409); assert.equal(denied.json.code, 'hosting_deletion_active', 'recovered nonterminal hosting still protects the shop')
      assert.deepEqual(control.prepare('SELECT stripe_customer_id,stripe_subscription_id,subscription_status,plan_tier FROM tenants WHERE id=?').get(shop.id), binding)
    })

    assert.deepEqual(provider().unexpected, [])
    assert.ok(provider().requests.every(row => row.method === 'GET'), 'deletion must not cancel, refund, expire or create Stripe objects')
    for (const secret of [SECRET, WEBHOOK_SECRET, RAW_ERROR, ownerCookie]) {
      assert.ok(!deletionResponses.includes(secret), 'deletion HTTP responses must not reveal credentials, cookies or raw provider text')
      assert.ok(!logs.includes(secret), 'deletion logs must not reveal credentials, cookies or raw provider text')
    }
    assert.doesNotMatch(logs, /External services are disabled|External request blocked/i, 'all provider reads stayed inside the synthetic fixture')
  } finally {
    await server.close()
    control?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
