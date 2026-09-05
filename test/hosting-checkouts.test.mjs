import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import { createHostingCheckouts } from '../lib/hosting-checkouts.mjs'
import { buildHostingCheckoutRequest, createPlatformBillingClient, setPlatformCredentials } from '../lib/billing.mjs'
import { createPlatformSubscriptionEventProcessor } from '../lib/platform-subscription-events.mjs'

const clone = value => structuredClone(value)
const origin = 'https://shop.example.test'
const options = { tenantId: 1, plan: 'everything', interval: 'month', origin }
const event = session => ({ type: 'checkout.session.completed', data: { object: clone(session) } })
const safeError = code => error => error?.hostingSafe === true && (!code || error.code === code)
function openDb(path = ':memory:') {
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=0;
    CREATE TABLE IF NOT EXISTS tenants(id INTEGER PRIMARY KEY,owner_email TEXT,plan TEXT DEFAULT 'trial',plan_tier TEXT DEFAULT '',subscription_status TEXT DEFAULT 'trialing',stripe_customer_id TEXT,stripe_subscription_id TEXT);
    INSERT OR IGNORE INTO tenants(id,owner_email) VALUES(1,'owner@example.test');`)
  return db
}
function sessionFromBody(body, id, clock) {
  const p = new URLSearchParams(body), metadata = {}
  for (const [key, value] of p) { const match = key.match(/^metadata\[(.+)\]$/); if (match) metadata[match[1]] = value }
  return { object: 'checkout.session', id, mode: 'subscription', status: 'open', livemode: false,
    metadata, client_reference_id: p.get('client_reference_id'), customer: p.get('customer'), subscription: null,
    success_url: p.get('success_url'), cancel_url: p.get('cancel_url'), allow_promotion_codes: true,
    expires_at: Math.floor(clock / 1000) + 86400, url: `https://checkout.stripe.com/c/pay/${id}`,
    amount_total: 100, line_items: { has_more: false, data: [{ quantity: 1, price: {
      currency: p.get('line_items[0][price_data][currency]'), unit_amount: Number(p.get('line_items[0][price_data][unit_amount]')),
      recurring: { interval: p.get('line_items[0][price_data][recurring][interval]'), interval_count: 1 },
      product: { name: p.get('line_items[0][price_data][product_data][name]'), metadata: { purpose: 'printshopcrm_hosting', plan: metadata.plan } },
    } }] } }
}
function fixture(db = openDb(), limits = {}) {
  const state = { clock: 1788566400000, account: 'acct_host', livemode: false, creates: [], reads: [], keys: new Map(), sessions: new Map(), subscriptions: new Map(), createHook: null, expireHook: null, subscriptionHook: null, accountHook: null }
  const createClient = () => {
    const captured = { accountId: state.account, livemode: state.livemode }
    const outside = () => { if (typeof db.isTransaction === 'boolean') assert.equal(db.isTransaction, false, 'no provider I/O inside a DB transaction') }
    return {
      account: async () => { outside(); if (state.accountHook) await state.accountHook(); return captured },
      createCheckout: async request => {
        outside(); state.creates.push(clone(request))
        let session = state.keys.get(request.idempotencyKey)
        if (session) assert.equal(session.body, request.requestBody, 'same key must keep identical provider bytes')
        else { session = { body: request.requestBody, data: sessionFromBody(request.requestBody, `cs_fixture${state.keys.size + 1}`, state.clock) }; state.keys.set(request.idempotencyKey, session); state.sessions.set(session.data.id, session.data) }
        if (state.createHook) await state.createHook(session.data)
        return clone(session.data)
      },
      retrieveCheckout: async id => { outside(); state.reads.push(id); if (!state.sessions.has(id)) throw Error('private-provider-error'); return clone(state.sessions.get(id)) },
      expireCheckout: async ({ sessionId }) => { outside(); const session = state.sessions.get(sessionId); if (state.expireHook) return state.expireHook(session); session.status = 'expired'; session.url = null; return clone(session) },
      retrieveSubscription: async id => { outside(); state.reads.push(id); if (state.subscriptionHook) return state.subscriptionHook(id); return clone(state.subscriptions.get(id)) },
    }
  }
  const manager = () => createHostingCheckouts(db, { createClient, now: () => state.clock, limits })
  const h = { db, state, manager, service: manager(), advance: ms => { state.clock += ms }, row: () => db.prepare('SELECT * FROM hosting_checkout_intents ORDER BY rowid DESC LIMIT 1').get(), tenant: () => db.prepare('SELECT * FROM tenants WHERE id=1').get() }
  h.complete = (sessionId = h.row().session_id, subId = 'sub_host') => {
    const session = state.sessions.get(sessionId)
    session.status = 'complete'; session.url = null; session.customer ||= 'cus_owner'; session.subscription = subId
    state.subscriptions.set(subId, { object: 'subscription', id: subId, customer: session.customer, status: 'active', livemode: session.livemode, metadata: clone(session.metadata) })
    return session
  }
  return h
}

async function legacyAnomalyFixture(t) {
  const h = fixture(); t.after(() => h.db.close())
  h.db.exec("UPDATE tenants SET stripe_customer_id='cus_owner',stripe_subscription_id='sub_current',subscription_status='active' WHERE id=1")
  const body = buildHostingCheckoutRequest({ ...options, email: 'owner@example.test', intentId: crypto.randomUUID() })
  const session = sessionFromBody(body, 'cs_legacy_extra', h.state.clock)
  delete session.metadata.purpose; delete session.metadata.hosting_intent
  h.state.sessions.set(session.id, session); h.complete(session.id, 'sub_legacy_extra')
  const sub = h.state.subscriptions.get('sub_legacy_extra')
  sub.items = clone(session.line_items)
  sub.items.data[0].price.product = { name: 'PrintShopCRM Everything', metadata: {} }
  h.state.subscriptions.set('sub_current', { ...clone(sub), id: 'sub_current' })
  const process = createPlatformSubscriptionEventProcessor({
    getTenantById: id => h.db.prepare('SELECT * FROM tenants WHERE id=?').get(id),
    getTenantByStripeCustomer: id => h.db.prepare('SELECT * FROM tenants WHERE stripe_customer_id=?').get(id),
    setSubscription: () => assert.fail('an extra legacy payment must never replace current hosting'),
    retrieveSubscription: async id => clone(h.state.subscriptions.get(id)), hostingCheckouts: h.service,
  })
  assert.equal((await process(event(session))).reason, 'existing_subscription')
  const anomaly = h.service.status(1).anomalies[0]
  assert.equal(anomaly.code, 'existing_subscription')
  sub.status = 'canceled'
  return { ...h, session, sub, anomaly }
}

test('parallel managers reserve one immutable intent and one Stripe session without transactions across I/O', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'psc-hosting-')), path = join(directory, 'control.db'), db = openDb(path), other = openDb(path)
  t.after(() => { db.close(); other.close(); rmSync(directory, { recursive: true, force: true }) })
  const h = fixture(db); let resume
  h.state.createHook = () => new Promise(resolve => { resume = resolve })
  const first = h.service.start(options)
  while (!resume) await new Promise(resolve => setImmediate(resolve))
  other.exec("INSERT INTO tenants(id,owner_email) VALUES(2,'other@example.test')")
  const peer = createHostingCheckouts(other, { createClient: () => ({ account: async () => ({ accountId: 'acct_host', livemode: false }) }), now: () => h.state.clock })
  await assert.rejects(peer.start(options), safeError('hosting_checkout_busy'))
  assert.equal(h.state.keys.size, 1); assert.equal(db.prepare('SELECT count(*) AS n FROM hosting_checkout_intents').get().n, 1)
  resume(); await first; h.state.createHook = null
  const replay = await h.manager().start(options)
  assert.equal(replay.intent.session_id, h.row().session_id); assert(replay.intent.can_expire)
  assert.equal(h.state.creates.length, 1, 'known open session is retrieved, never recreated')
  assert.throws(() => db.prepare('UPDATE hosting_checkout_intents SET request_body=?').run('changed'), /immutable/)
  await assert.rejects(h.service.start({ ...options, interval: 'year' }), safeError('hosting_checkout_parameters_changed'))
  assert.equal(h.state.creates.length, 1)
})

test('lost create response and restart reuse the exact persisted bytes and key', async t => {
  const h = fixture(); t.after(() => h.db.close())
  h.state.createHook = async () => { throw Error('SECRET_PROVIDER_MARKER') }
  await assert.rejects(h.service.start(options), error => safeError('hosting_checkout_unavailable')(error) && !String(error).includes('SECRET'))
  const first = h.row(); assert.equal(first.state, 'unknown'); assert.equal(first.session_id, null)
  h.advance(3000); h.state.createHook = null
  const result = await h.manager().start(options)
  assert.equal(result.intent.state, 'open'); assert.equal(h.row().id, first.id)
  assert.equal(h.state.keys.size, 1); assert.equal(h.state.creates.length, 2)
  assert.deepEqual(h.state.creates[0], h.state.creates[1])
})

test('a provider success before local persistence can recover after a database failure', async t => {
  const h = fixture(); t.after(() => h.db.close())
  h.db.exec("CREATE TRIGGER fail_session BEFORE UPDATE OF session_id ON hosting_checkout_intents WHEN OLD.session_id IS NULL BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END")
  await assert.rejects(h.service.start(options), safeError('hosting_checkout_unavailable'))
  assert.equal(h.row().session_id, null); assert.equal(h.state.keys.size, 1)
  h.db.exec('DROP TRIGGER fail_session'); h.advance(3000)
  assert.equal((await h.manager().reconcile({ tenantId: 1 })).intent.state, 'open')
  assert.equal(h.state.keys.size, 1); assert.deepEqual(h.state.creates[0], h.state.creates[1])
})

test('old unknown outcomes never recreate after key retention; a verified session ID can recover them', async t => {
  const h = fixture(); t.after(() => h.db.close())
  h.state.createHook = async () => { throw Error('timeout') }
  await assert.rejects(h.service.start(options), safeError())
  const id = [...h.state.sessions.keys()][0]
  h.advance(23 * 60 * 60 * 1000 + 1); h.state.createHook = null
  const held = await h.manager().reconcile({ tenantId: 1 })
  assert.equal(held.intent.state, 'held'); assert.equal(held.intent.diagnostic, 'key_window_elapsed')
  assert.equal(h.state.creates.length, 1)
  assert.equal((await h.service.reconcile({ tenantId: 1, sessionId: id })).intent.state, 'open')
  assert.equal(h.state.creates.length, 1)
})

test('same-account key rotation recovers; a different Stripe account or mode holds the old attempt', async t => {
  const h = fixture(); t.after(() => h.db.close())
  await h.service.start(options)
  h.state.account = 'acct_other'
  assert.equal((await h.service.reconcile({ tenantId: 1 })).intent.diagnostic, 'account_mismatch')
  assert.equal(h.state.creates.length, 1)
  h.state.account = 'acct_host'; h.state.livemode = true
  assert.equal((await h.service.start(options)).intent.state, 'held')
  h.state.livemode = false
  assert.equal((await h.service.reconcile({ tenantId: 1 })).intent.state, 'open')
  assert.equal(h.state.creates.length, 1)
})

test('explicit expiration is verified before new terms, including lost expiration responses', async t => {
  const h = fixture(); t.after(() => h.db.close())
  await h.service.start(options)
  h.state.expireHook = async session => { session.status = 'expired'; session.url = null; throw Error('lost response') }
  assert.equal((await h.service.expire({ tenantId: 1 })).intent.state, 'expired')
  h.state.expireHook = null
  assert.equal((await h.service.start({ ...options, interval: 'year' })).intent.interval, 'year')
  assert.equal(h.state.keys.size, 2)
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM hosting_checkout_intents').get().n, 2, 'the old receipt is retained')
})

test('payment winning expiration binds the paid subscription instead of making another checkout', async t => {
  const h = fixture(); t.after(() => h.db.close())
  await h.service.start(options)
  h.state.expireHook = async () => { h.complete(); throw Error('session already completed') }
  const result = await h.service.expire({ tenantId: 1 })
  assert.equal(result.intent.state, 'complete'); assert.equal(h.tenant().stripe_subscription_id, 'sub_host')
  await assert.rejects(h.service.start(options), safeError('hosting_subscription_exists'))
  assert.equal(h.state.keys.size, 1)
})

test('stale local cancellation is reconciled before exposing any replacement checkout', async t => {
  const h = fixture(); t.after(() => h.db.close())
  h.db.exec("UPDATE tenants SET stripe_customer_id='cus_owner',stripe_subscription_id='sub_existing',subscription_status='canceled' WHERE id=1")
  h.state.subscriptions.set('sub_existing', { object: 'subscription', id: 'sub_existing', customer: 'cus_owner', status: 'active', livemode: false, metadata: { tenant_id: '1', purpose: 'printshopcrm_hosting' } })
  await assert.rejects(h.service.start(options), safeError('hosting_subscription_exists'))
  assert.equal(h.tenant().subscription_status, 'active'); assert.equal(h.state.creates.length, 0)
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM hosting_checkout_intents').get().n, 0)
})

test('a delayed replacement preflight cannot overwrite a newer ordinary subscription event', async t => {
  const h = fixture(); t.after(() => h.db.close())
  h.db.exec("UPDATE tenants SET stripe_customer_id='cus_owner',stripe_subscription_id='sub_existing',subscription_status='canceled' WHERE id=1")
  let release
  h.state.subscriptionHook = () => new Promise(resolve => { release = resolve })
  const pending = h.service.start(options)
  while (!release) await new Promise(resolve => setImmediate(resolve))
  h.db.exec("UPDATE tenants SET subscription_status='canceled',hosting_revision=hosting_revision+1 WHERE id=1")
  release({ object: 'subscription', id: 'sub_existing', customer: 'cus_owner', status: 'active', metadata: { tenant_id: '1' } })
  await assert.rejects(pending, safeError('hosting_checkout_unavailable'))
  assert.equal(h.tenant().subscription_status, 'canceled'); assert.equal(h.state.creates.length, 0)
})

test('completion and tenant binding commit together, and retry survives a failed binding write', async t => {
  const h = fixture(); t.after(() => h.db.close())
  await h.service.start(options); const session = h.complete()
  h.db.exec("CREATE TRIGGER fail_binding BEFORE UPDATE OF stripe_subscription_id ON tenants BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END")
  await assert.rejects(h.service.processCheckoutEvent(event(session)), safeError())
  assert.equal(h.tenant().stripe_subscription_id, null); assert.notEqual(h.row().state, 'complete')
  h.db.exec('DROP TRIGGER fail_binding'); h.advance(3000)
  assert.equal((await h.manager().processCheckoutEvent(event(session))).handled, true)
  assert.equal(h.tenant().stripe_subscription_id, 'sub_host'); assert.equal(h.row().state, 'complete')
  assert.equal(h.tenant().hosting_revision, 1)
})

test('extra paid hosting is retained as a review hold until verified operator resolution', async t => {
  const h = fixture(); t.after(() => h.db.close())
  await h.service.start(options); const session = h.complete()
  h.db.exec("UPDATE tenants SET stripe_customer_id='cus_owner',stripe_subscription_id='sub_other',subscription_status='active',hosting_revision=hosting_revision+1 WHERE id=1")
  assert.equal((await h.service.processCheckoutEvent(event(session))).handled, false)
  let result = h.service.status(1); assert.equal(result.intent.state, 'held'); assert.equal(result.anomalies.length, 1)
  await assert.rejects(h.service.start(options), safeError('hosting_checkout_review_required'))
  assert.throws(() => h.service.assertTenantDeletionAllowed(1), safeError('hosting_checkout_unresolved'))
  await assert.rejects(h.service.resolveAnomaly({ tenantId: 1, anomalyId: result.anomalies[0].id, note: 'Checked Stripe' }), safeError('hosting_checkout_payment_unresolved'))
  h.state.subscriptions.get('sub_host').status = 'canceled'
  result = await h.service.resolveAnomaly({ tenantId: 1, anomalyId: result.anomalies[0].id, note: 'Extra subscription canceled in Stripe by the operator.' })
  assert.equal(result.intent.state, 'closed'); assert.equal(result.anomalies.length, 0); assert.equal(result.resolved_anomalies.length, 1)
  assert.equal(h.tenant().stripe_subscription_id, 'sub_other', 'resolution never changes the current binding')
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM hosting_checkout_anomalies').get().n, 1)
  const evidence = JSON.parse(h.db.prepare('SELECT resolution_evidence FROM hosting_checkout_anomalies').get().resolution_evidence)
  assert.equal(evidence.kind, 'ended_subscription'); assert.equal(evidence.account_scope, 'acct_host:test')
  h.service.assertTenantDeletionAllowed(1)
  h.state.accountHook = () => { throw Error('closed review must not contact Stripe') }
  assert.equal((await h.service.reconcile({ tenantId: 1 })).intent.state, 'closed')
})

test('a verified pre-purpose legacy duplicate can be resolved after its exact subscription ends', async t => {
  const h = await legacyAnomalyFixture(t)
  const result = await h.service.resolveAnomaly({ tenantId: 1, anomalyId: h.anomaly.id, note: 'Legacy extra subscription canceled in Stripe.' })
  assert.equal(result.anomalies.length, 0); assert.equal(result.resolved_anomalies.length, 1)
  assert.equal(h.tenant().stripe_subscription_id, 'sub_current'); assert.equal(h.tenant().subscription_status, 'active')
  const evidence = JSON.parse(h.db.prepare('SELECT resolution_evidence FROM hosting_checkout_anomalies').get().resolution_evidence)
  assert.equal(evidence.subscription_id, 'sub_legacy_extra'); assert.equal(evidence.account_scope, 'acct_host:test')
})

test('legacy resolution rejects donations, incorrect product terms and mismatched provider identities', async t => {
  for (const mutate of [
    h => { h.session.metadata.purpose = 'project_support' },
    h => { h.sub.metadata.purpose = 'project_support' },
    h => { h.sub.items.data[0].price.product.metadata.purpose = 'project_support' },
    h => { h.sub.items.data[0].price.product.name = 'PrintShopCRM Everything sponsorship' },
    h => { h.sub.items.data[0].price.unit_amount = 100 },
    h => { h.sub.metadata.plan = 'growth' },
    h => { h.sub.metadata.tenant_id = '2' },
    h => { h.sub.customer = 'cus_foreign' },
    h => { h.session.subscription = 'sub_different' },
    h => { h.sub.livemode = true },
  ]) {
    const h = await legacyAnomalyFixture(t); mutate(h)
    await assert.rejects(h.service.resolveAnomaly({ tenantId: 1, anomalyId: h.anomaly.id, note: 'Attempted review.' }), safeError('hosting_checkout_mismatch'))
    assert.equal(h.service.status(1).anomalies.length, 1)
    assert.equal(h.tenant().stripe_subscription_id, 'sub_current')
  }
})

test('a genuine unknown paid intent raises a persistent hold instead of authorizing another checkout', async t => {
  const h = fixture(); t.after(() => h.db.close())
  const body = buildHostingCheckoutRequest({ ...options, email: 'owner@example.test', intentId: crypto.randomUUID() })
  const session = sessionFromBody(body, 'cs_unknown', h.state.clock); h.state.sessions.set(session.id, session)
  h.complete(session.id, 'sub_unknown')
  assert.equal((await h.service.processCheckoutEvent(event(session))).handled, false)
  assert.equal(h.service.status(1).anomalies[0].code, 'unknown_intent')
  await assert.rejects(h.service.start(options), safeError('hosting_checkout_review_required'))
  assert.equal(h.state.creates.length, 0); assert.equal(h.tenant().stripe_subscription_id, null)
})

test('tenant deletion during unknown-checkout verification cannot create an orphan review hold', async t => {
  const h = fixture(); t.after(() => h.db.close())
  const body = buildHostingCheckoutRequest({ ...options, email: 'owner@example.test', intentId: crypto.randomUUID() })
  const session = sessionFromBody(body, 'cs_unknown_deleted', h.state.clock); h.state.sessions.set(session.id, session)
  h.complete(session.id, 'sub_unknown_deleted')
  h.state.accountHook = () => { h.db.exec('DELETE FROM tenants WHERE id=1') }
  assert.equal((await h.service.processCheckoutEvent(event(session))).handled, false)
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM hosting_checkout_anomalies').get().n, 0)
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM hosting_checkout_intents').get().n, 0)
})

test('interleaved ordinary webhooks cannot be overwritten by an older ledger response, even with unchanged status', async t => {
  for (const next of ['canceled', 'active']) {
    const h = fixture(); t.after(() => h.db.close())
    await h.service.start(options); await h.service.processCheckoutEvent(event(h.complete()))
    let release
    h.state.subscriptionHook = async () => new Promise(resolve => { release = resolve })
    const pending = h.service.reconcile({ tenantId: 1 })
    while (!release) await new Promise(resolve => setImmediate(resolve))
    h.db.prepare('UPDATE tenants SET subscription_status=?,hosting_revision=hosting_revision+1 WHERE id=1').run(next)
    release({ ...h.state.subscriptions.get('sub_host'), status: 'past_due' })
    await assert.rejects(pending, safeError('hosting_checkout_unavailable'))
    assert.equal(h.tenant().subscription_status, next)
  }
})

test('lease recovery and history/attempt limits keep uncertainty bounded without minting new keys', async t => {
  const h = fixture(undefined, { maxAttempts: 2, maxHistory: 1 }); t.after(() => h.db.close())
  h.state.createHook = async () => { throw Error('cached provider 500') }
  await assert.rejects(h.service.start(options), safeError())
  h.db.prepare('UPDATE hosting_checkout_intents SET lease_token=?,lease_until=?').run('dead-process', h.state.clock + 120000)
  await assert.rejects(h.manager().start(options), safeError('hosting_checkout_busy'))
  h.advance(120001); await assert.rejects(h.manager().start(options), safeError())
  h.advance(5000)
  assert.equal((await h.manager().start(options)).intent.diagnostic, 'attempt_limit')
  assert.equal(h.state.creates.length, 2); assert.equal(h.state.keys.size, 1)
  h.state.createHook = null
  await h.service.reconcile({ tenantId: 1, sessionId: [...h.state.sessions.keys()][0] }); await h.service.expire({ tenantId: 1 })
  await assert.rejects(h.service.start(options), safeError('hosting_checkout_history_full'))
  assert.equal(h.state.keys.size, 1)
})

test('completed history ignores deleted shops and an active reconciliation lease blocks deletion', async t => {
  const h = fixture(); t.after(() => h.db.close())
  await h.service.start(options); const session = h.complete()
  await h.service.processCheckoutEvent(event(session))
  let release
  h.state.subscriptionHook = () => new Promise(resolve => { release = resolve })
  const pending = h.service.reconcile({ tenantId: 1 })
  while (!release) await new Promise(resolve => setImmediate(resolve))
  assert.throws(() => h.service.assertTenantDeletionAllowed(1), safeError('hosting_checkout_unresolved'))
  release(clone(h.state.subscriptions.get('sub_host'))); await pending
  h.service.assertTenantDeletionAllowed(1)
  h.db.exec('DELETE FROM tenants WHERE id=1')
  const reads = h.state.reads.length
  h.state.accountHook = () => { throw Error('deleted shops must not query Stripe') }
  assert.deepEqual(await h.service.processCheckoutEvent(event(session)), { handled: false, reason: 'deleted_tenant' })
  assert.equal(h.state.reads.length, reads)
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM hosting_checkout_anomalies').get().n, 0)
})

test('captured provider client preserves account identity and exact keyed bytes across credential rotation', async t => {
  setPlatformCredentials({ secret: 'sk_test_first' }); t.after(() => setPlatformCredentials({ secret: '' }))
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, ...options })
    if (url.endsWith('/account')) return Response.json({ object: 'account', id: 'acct_host', private: 'ignored' })
    return Response.json({ object: 'checkout.session', id: 'cs_test_fixture', status: 'open' })
  })
  const client = createPlatformBillingClient()
  setPlatformCredentials({ secret: 'sk_live_rotated_fixture' })
  assert.deepEqual(await client.account(), { accountId: 'acct_host', livemode: false })
  const body = buildHostingCheckoutRequest({ ...options, email: 'owner@example.test', intentId: crypto.randomUUID() })
  await client.createCheckout({ requestBody: body, idempotencyKey: 'psc_fixture_stable_key' })
  await client.expireCheckout({ sessionId: 'cs_test_fixture', idempotencyKey: 'psc_fixture_stable_key_expire' })
  assert(calls.every(call => call.headers.Authorization === 'Bearer sk_test_first' && call.redirect === 'error'))
  assert.equal(calls[1].body, body); assert.equal(calls[1].headers['Idempotency-Key'], 'psc_fixture_stable_key')
  assert.equal(calls[2].method, 'POST'); assert(calls[2].url.endsWith('/cs_test_fixture/expire'))
  assert(!JSON.stringify(client).includes('sk_test_first'))
  for (const id of ['cs_test_fixture\n', 'cs_test_fixture/elsewhere']) assert.throws(() => client.retrieveCheckout(id), /Invalid hosting session/)
})
