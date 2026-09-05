import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlatformSubscriptionEventProcessor } from '../lib/platform-subscription-events.mjs'
import { HOSTING_PURPOSE, PLANS, createSubscriptionCheckout, createBillingPortal, retrievePlatformSubscription, setPlatformCredentials } from '../lib/billing.mjs'

const copy = value => value === undefined ? undefined : structuredClone(value)
const event = (type, object) => ({ type, data: { object } })
const metadata = (tenant = 1, plan = 'everything') => ({ tenant_id: String(tenant), plan, purpose: HOSTING_PURPOSE })
const subscription = (patch = {}) => ({ object: 'subscription', id: 'sub_host', customer: 'cus_shop', status: 'active', metadata: metadata(), ...patch })
const checkout = (patch = {}) => event('checkout.session.completed', {
  object: 'checkout.session', id: 'cs_host', status: 'complete', mode: 'subscription',
  customer: 'cus_shop', subscription: 'sub_host', metadata: metadata(), client_reference_id: '1', ...patch,
})
const row = (patch = {}) => ({ id: 1, stripe_customer_id: null, stripe_subscription_id: null, subscription_status: 'trial', plan_tier: '', ...patch })
const bound = (patch = {}) => row({ stripe_customer_id: 'cus_shop', stripe_subscription_id: 'sub_host', subscription_status: 'active', plan_tier: 'everything', ...patch })
const fixture = ({ tenants = [row()], subscriptions = [subscription()], retrieve, maxConcurrent } = {}) => {
  const rows = new Map(tenants.map(t => [t.id, copy(t)])), subs = new Map(subscriptions.map(s => [s.id, copy(s)]))
  const reads = [], writes = []
  const process = createPlatformSubscriptionEventProcessor({
    getTenantById: id => copy(rows.get(id)),
    getTenantByStripeCustomer: id => copy([...rows.values()].find(t => t.stripe_customer_id === id)),
    setSubscription: (id, patch) => {
      writes.push({ id, ...copy(patch) })
      const t = rows.get(id)
      if (patch.plan !== undefined) t.plan_tier = patch.plan
      if (patch.status !== undefined) t.subscription_status = patch.status
      if (patch.customerId !== undefined) t.stripe_customer_id = patch.customerId
      if (patch.subscriptionId !== undefined) t.stripe_subscription_id = patch.subscriptionId
    },
    retrieveSubscription: async id => { reads.push(id); return retrieve ? retrieve(id) : copy(subs.get(id)) },
    ...(maxConcurrent === undefined ? {} : { maxConcurrent }),
  })
  return { process, rows, subs, reads, writes }
}
const legacySubscription = (plan = 'everything') => {
  const definition = PLANS[plan]
  return subscription({ metadata: { tenant_id: '1', plan }, items: { has_more: false, data: [{ quantity: 1, price: {
    currency: 'usd', unit_amount: Math.round(definition.monthly * 100), recurring: { interval: 'month', interval_count: 1 },
    product: { id: 'prod_host', name: definition.productName || `PrintShopCRM ${definition.name}`, metadata: {} },
  } }] } })
}
const retryable = error => error?.retryable === true && error?.status === 503 && error?.code === 'platform_subscription_unavailable'

test('genuine checkout binds actual hosting and reconciles delivery before subscription updates', async () => {
  const f = fixture()
  assert.equal((await f.process(event('customer.subscription.updated', subscription()))).handled, false)
  assert.equal(f.reads.length, 0, 'an unbound subscription update cannot self-authorize')
  assert.equal((await f.process(checkout({ customer: { id: 'cus_shop' }, subscription: { id: 'sub_host' } }))).handled, true)
  assert.deepEqual(f.rows.get(1), bound())
  f.subs.get('sub_host').status = 'past_due'
  assert.equal((await f.process(checkout())).handled, true)
  assert.equal(f.rows.get(1).subscription_status, 'past_due', 'retry reads actual status instead of granting access again')
  f.subs.get('sub_host').status = 'trialing'
  assert.equal((await f.process({ ...checkout(), type: 'checkout.session.async_payment_succeeded' })).handled, true)
  assert.equal(f.rows.get(1).subscription_status, 'active')
})

test('one-time support, recurring sponsorship, and other subscriptions cannot alter hosting', async () => {
  const f = fixture({ tenants: [bound()] })
  const events = [
    checkout({ mode: 'payment', subscription: null, metadata: { tenant_id: '1', plan: 'everything', purpose: 'project_support' } }),
    checkout({ subscription: 'sub_support', metadata: { ...metadata(), purpose: 'project_support' } }),
    event('customer.subscription.updated', subscription({ id: 'sub_support', status: 'past_due' })),
    event('customer.subscription.deleted', subscription({ id: 'sub_support', status: 'canceled' })),
    event('invoice.payment_failed', { customer: 'cus_shop', subscription: 'sub_support', metadata: metadata() }),
    event('invoice.payment_failed', { customer: 'cus_shop', metadata: metadata() }),
    event('invoice.payment_failed', { customer: 'cus_shop', parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_support' } } }),
    event('customer.subscription.updated', subscription({ metadata: { ...metadata(), purpose: 'project_support' } })),
    { ...event('customer.subscription.deleted', subscription()), account: 'acct_some_shop' },
  ]
  for (const e of events) assert.equal((await f.process(e)).handled, false)
  assert.deepEqual(f.rows.get(1), bound()); assert.equal(f.writes.length, 0); assert.equal(f.reads.length, 0)
})

test('checkout needs its own valid tenant metadata, customer, subscription, mode and known plan', async () => {
  for (const patch of [
    { metadata: {} }, { metadata: { plan: 'everything' } }, { client_reference_id: '2' },
    { metadata: { ...metadata(), tenant_id: '1.0' } }, { metadata: { ...metadata(), tenant_id: '1e0' } },
    { metadata: { ...metadata(), tenant_id: true } }, { metadata: metadata(404) },
    { metadata: { ...metadata(), plan: 'donation' } }, { metadata: { ...metadata(), plan: '__proto__' } },
    { subscription: null }, { subscription: '' }, { subscription: { status: 'active' } },
    { customer: null }, { customer: { id: 'cus_shop/../../' } }, { mode: 'payment' }, { mode: 'setup' }, { status: 'open' },
  ]) {
    const f = fixture()
    assert.equal((await f.process(checkout(patch))).handled, false, JSON.stringify(patch))
    assert.equal(f.reads.length, 0); assert.equal(f.writes.length, 0)
  }
})

test('tenant and customer bindings cannot be crossed by session, subscription, or customer metadata', async () => {
  for (const subPatch of [
    { customer: 'cus_other' }, { metadata: metadata(2) }, { metadata: { ...metadata(), plan: 'growth' } },
    { metadata: { ...metadata(), purpose: 'project_support' } }, { metadata: {} },
  ]) {
    const f = fixture({ subscriptions: [subscription(subPatch)] })
    assert.equal((await f.process(checkout())).handled, false)
    assert.equal(f.writes.length, 0)
  }
  for (const tenants of [[bound({ stripe_customer_id: 'cus_other' })], [row(), bound({ id: 2 })]]) {
    const f = fixture({ tenants })
    assert.equal((await f.process(checkout())).handled, false)
    assert.equal(f.reads.length, 0); assert.equal(f.writes.length, 0)
  }
  const f = fixture({ tenants: [bound()] })
  for (const obj of [subscription({ metadata: metadata(2) }), subscription({ customer: 'cus_other' }), subscription({ metadata: { ...metadata(), tenant_id: '1.0' } })]) {
    assert.equal((await f.process(event('customer.subscription.updated', obj))).handled, false)
  }
  assert.equal(f.reads.length, 0); assert.equal(f.writes.length, 0)
})

test('unpaid or ended actual subscriptions are recorded without inventing active hosting', async () => {
  for (const status of ['incomplete', 'incomplete_expired', 'past_due', 'unpaid', 'paused', 'canceled']) {
    const f = fixture({ subscriptions: [subscription({ status })] })
    assert.equal((await f.process(checkout())).handled, true)
    assert.equal(f.rows.get(1).stripe_subscription_id, 'sub_host')
    assert.equal(f.rows.get(1).subscription_status, status)
  }
})

test('legacy initial checkout requires exact original product, price, and matching metadata', async () => {
  for (const plan of Object.keys(PLANS)) {
    const sub = legacySubscription(plan)
    if (plan === 'everything') sub.items.data[0].price.product.name = 'PrintShopCRM Everything'
    const f = fixture({ subscriptions: [sub] })
    assert.equal((await f.process(checkout({ metadata: { tenant_id: '1', plan } }))).handled, true, plan)
    assert.equal(f.rows.get(1).plan_tier, plan)
  }
  const annual = legacySubscription()
  annual.items.data[0].price.recurring.interval = 'year'; annual.items.data[0].price.unit_amount = 149000
  assert.equal((await fixture({ subscriptions: [annual] }).process(checkout({ metadata: { tenant_id: '1', plan: 'everything' } }))).handled, true)
  for (const mutate of [
    s => { s.items.data[0].price.product.name = 'PrintShopCRM Everything sponsorship' },
    s => { s.items.data[0].price.unit_amount = 500 },
    s => { s.items.data[0].price.currency = 'cad' },
    s => { s.items.data[0].price.recurring.interval_count = 2 },
    s => { s.items.data[0].quantity = 2 },
    s => { s.items.has_more = true },
    s => { s.items.data[0].price.product.metadata.purpose = 'project_support' },
    s => { s.metadata.plan = 'growth' },
  ]) {
    const sub = legacySubscription(); mutate(sub)
    const f = fixture({ subscriptions: [sub] })
    assert.equal((await f.process(checkout({ metadata: { tenant_id: '1', plan: 'everything' } }))).handled, false)
    assert.equal(f.writes.length, 0)
  }
  const unexpanded = legacySubscription(); unexpanded.items.data[0].price.product = 'prod_host'
  const f = fixture({ subscriptions: [unexpanded] })
  await assert.rejects(f.process(checkout({ metadata: { tenant_id: '1', plan: 'everything' } })), retryable)
  assert.equal(f.writes.length, 0, 'unavailable expanded product must retry without losing a genuine legacy checkout')
})

test('provider failure or missing actual subscription is retryable and never activates a shop', async () => {
  for (const value of [null, {}, subscription({ id: 'sub_other' }), subscription({ status: 'mystery' }), subscription({ customer: null })]) {
    const f = fixture({ retrieve: async () => value })
    await assert.rejects(f.process(checkout()), retryable); assert.equal(f.writes.length, 0)
  }
  let fail = true
  const f = fixture({ retrieve: async () => { if (fail) throw new Error('private provider credential detail'); return subscription() } })
  await assert.rejects(f.process(checkout()), e => retryable(e) && !e.message.includes('credential'))
  assert.deepEqual(f.rows.get(1), row())
  fail = false; assert.equal((await f.process(checkout())).handled, true, 'failed reconciliation releases its concurrency lease')
})

test('existing v1 exact bindings work without purpose and use current status despite old event payloads', async () => {
  const f = fixture({ tenants: [bound()], subscriptions: [subscription({ status: 'canceled', metadata: {} })] })
  assert.equal((await f.process(event('customer.subscription.updated', subscription({ status: 'active', metadata: {} })))).handled, true)
  assert.equal(f.rows.get(1).subscription_status, 'canceled')
  const g = fixture({ tenants: [bound()], subscriptions: [subscription({ status: 'active', metadata: { plan: 'growth' } })] })
  assert.equal((await g.process(event('invoice.payment_failed', { customer: { id: 'cus_shop' }, subscription: { id: 'sub_host' } }))).handled, true)
  assert.equal(g.rows.get(1).subscription_status, 'active', 'an already recovered invoice must not move hosting back to past due')
  assert.equal(g.rows.get(1).plan_tier, 'growth', 'the current provider plan wins over old event metadata')
  const h = fixture({ tenants: [bound()], subscriptions: [subscription({ status: 'canceled', metadata: {} })] })
  assert.equal((await h.process(event('customer.subscription.deleted', subscription({ status: 'canceled', metadata: {} })))).handled, true)
  assert.equal(h.rows.get(1).subscription_status, 'canceled')
})

test('both Stripe invoice versions require the exact subscription and reject conflicting parent metadata', async () => {
  const f = fixture({ tenants: [bound()], subscriptions: [subscription({ status: 'past_due' })] })
  for (const obj of [
    { customer: 'cus_shop', subscription: 'sub_host', subscription_details: { metadata: { tenant_id: '1' } } },
    { customer: 'cus_shop', parent: { type: 'subscription_details', subscription_details: { subscription: { id: 'sub_host' }, metadata: metadata() } } },
  ]) assert.equal((await f.process(event('invoice.payment_failed', obj))).handled, true)
  assert.equal(f.rows.get(1).subscription_status, 'past_due')
  const before = f.reads.length
  for (const obj of [
    { subscription: 'sub_other', parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_host' } } },
    { subscription: 'sub_host', parent: { type: 'quote_details', quote_details: { quote: 'qt_fixture' } } },
    { subscription: 'sub_host', parent: { type: 'subscription_details', subscription_details: {} } },
    { subscription: 'sub_host', parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_host', metadata: metadata(2) } } },
    { subscription: 'sub_host', subscription_details: { metadata: { purpose: 'project_support' } } },
  ]) assert.equal((await f.process(event('invoice.payment_failed', { customer: 'cus_shop', ...obj }))).handled, false)
  assert.equal(f.reads.length, before)
  f.rows.get(1).subscription_status = 'canceled'
  assert.equal((await f.process(event('invoice.payment_failed', { customer: 'cus_shop', subscription: 'sub_host' }))).handled, false)
  assert.equal(f.rows.get(1).subscription_status, 'canceled')
})

test('a canceled subscription can be replaced, but delayed older checkout or events cannot undo it', async () => {
  const old = subscription({ id: 'sub_old', status: 'canceled' })
  const f = fixture({ tenants: [bound({ stripe_subscription_id: 'sub_old', subscription_status: 'canceled' })], subscriptions: [old, subscription()] })
  assert.equal((await f.process(checkout())).handled, true)
  assert.deepEqual(f.rows.get(1), bound())
  const before = f.reads.length
  for (const type of ['customer.subscription.updated', 'customer.subscription.deleted']) assert.equal((await f.process(event(type, old))).handled, false)
  assert.equal((await f.process(event('invoice.payment_failed', { customer: 'cus_shop', subscription: 'sub_old' }))).handled, false)
  assert.equal(f.reads.length, before)
  assert.equal((await f.process(checkout({ subscription: 'sub_old' }))).handled, false)
  assert.deepEqual(f.rows.get(1), bound())
  assert.equal(f.writes.length, 1)
})

test('active-to-active replacement and an ended new checkout are rejected', async () => {
  for (const [oldStatus, newStatus] of [['active', 'active'], ['past_due', 'active'], ['incomplete', 'active'], ['canceled', 'canceled']]) {
    const original = bound({ stripe_subscription_id: 'sub_old', subscription_status: oldStatus })
    const f = fixture({ tenants: [original], subscriptions: [subscription({ id: 'sub_old', status: oldStatus }), subscription({ status: newStatus })] })
    assert.equal((await f.process(checkout())).handled, false)
    assert.deepEqual(f.rows.get(1), original); assert.equal(f.writes.length, 0)
  }
})

test('same-shop provider reads serialize by retry, global work is capped without a queue', async () => {
  const pending = new Map()
  const f = fixture({
    tenants: [bound(), bound({ id: 2, stripe_customer_id: 'cus_two', stripe_subscription_id: 'sub_two' }), bound({ id: 3, stripe_customer_id: 'cus_three', stripe_subscription_id: 'sub_three' })],
    maxConcurrent: 2, retrieve: id => new Promise(resolve => pending.set(id, resolve)),
  })
  const first = f.process(event('customer.subscription.updated', subscription()))
  const second = f.process(event('customer.subscription.updated', subscription({ id: 'sub_two', customer: 'cus_two', metadata: metadata(2) })))
  await assert.rejects(f.process(event('customer.subscription.updated', subscription())), retryable)
  await assert.rejects(f.process(event('customer.subscription.updated', subscription({ id: 'sub_three', customer: 'cus_three', metadata: metadata(3) }))), retryable)
  assert.equal(f.reads.length, 2)
  assert.equal((await f.process(event('customer.subscription.deleted', subscription({ id: 'sub_donation' })))).handled, false, 'unrelated events need no capacity')
  pending.get('sub_host')(subscription({ status: 'past_due' })); pending.get('sub_two')(subscription({ id: 'sub_two', customer: 'cus_two', metadata: metadata(2) }))
  await Promise.all([first, second])
  const retryRequest = f.process(event('customer.subscription.updated', subscription({ status: 'past_due' })))
  pending.get('sub_host')(subscription({ status: 'active' })); await retryRequest
  assert.equal(f.rows.get(1).subscription_status, 'active', 'retried stale event reads fresh provider status')
})

test('a tenant binding changed during provider I/O cannot be overwritten', async () => {
  let release
  const f = fixture({ retrieve: () => new Promise(resolve => { release = resolve }) })
  const request = f.process(checkout())
  f.rows.get(1).stripe_customer_id = 'cus_other'; release(subscription())
  await assert.rejects(request, retryable)
  assert.equal(f.rows.get(1).stripe_customer_id, 'cus_other'); assert.equal(f.writes.length, 0)
})

test('checkout creation marks hosting at each Stripe level and reuses an existing customer', async t => {
  setPlatformCredentials({ secret: 'sk_test_isolated_fixture' }); t.after(() => setPlatformCredentials({ secret: '' }))
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options })
    assert.equal(new URL(url).origin, 'https://api.stripe.com')
    return Response.json({ id: 'cs_fixture', url: 'https://checkout.stripe.com/fixture' })
  })
  await createSubscriptionCheckout({ plan: 'everything', tenantId: 1, email: 'shop@example.test', customerId: 'cus_shop', origin: 'https://app.example.test' })
  const params = new URLSearchParams(calls[0].options.body)
  assert.equal(params.get('customer'), 'cus_shop'); assert.equal(params.has('customer_email'), false)
  for (const key of ['metadata[purpose]', 'subscription_data[metadata][purpose]', 'line_items[0][price_data][product_data][metadata][purpose]']) assert.equal(params.get(key), HOSTING_PURPOSE)
  assert.equal(params.get('metadata[tenant_id]'), '1'); assert.equal(params.get('subscription_data[metadata][tenant_id]'), '1')
  await createSubscriptionCheckout({ plan: 'everything', tenantId: 1, email: 'shop@example.test', origin: 'https://app.example.test' })
  assert.equal(new URLSearchParams(calls[1].options.body).get('customer_email'), 'shop@example.test')
  await assert.rejects(createSubscriptionCheckout({ plan: '__proto__' }), /Unknown plan/)
  await assert.rejects(createSubscriptionCheckout({ plan: 'everything', customerId: 'cus_shop/elsewhere' }), /Invalid billing customer/)
  assert.equal(calls.length, 2)
})

test('platform retriever performs only a bounded read on an exact subscription path', async t => {
  setPlatformCredentials({ secret: 'sk_test_isolated_fixture' }); t.after(() => setPlatformCredentials({ secret: '' }))
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => { calls.push({ url, options }); return Response.json(subscription()) })
  assert.equal((await retrievePlatformSubscription('sub_host')).id, 'sub_host')
  const { url, options } = calls[0], parsed = new URL(url)
  assert.equal(parsed.origin, 'https://api.stripe.com'); assert.equal(parsed.pathname, '/v1/subscriptions/sub_host')
  assert.deepEqual(parsed.searchParams.getAll('expand[]'), ['items.data.price.product'])
  assert.equal(options.method, 'GET'); assert.equal(options.body, undefined); assert(options.signal)
  for (const id of ['sub_host/../customers', 'https://example.test', null, 'sub_host?x=1']) await assert.rejects(retrievePlatformSubscription(id), /Invalid billing subscription/)
  assert.equal(calls.length, 1)
})

test('provider and network errors never expose an echoed Stripe key through checkout, portal or retrieval', async t => {
  const marker = 'sk_test_PRIVATE_BILLING_SENTINEL'
  setPlatformCredentials({ secret: marker }); t.after(() => setPlatformCredentials({ secret: '' }))
  let mode = 'provider'
  t.mock.method(globalThis, 'fetch', async () => {
    if (mode === 'network') throw new Error(`Authorization failed: Bearer ${marker}`)
    if (mode === 'invalid_json') return new Response(`Invalid API Key provided: ${marker}`, { status: 401 })
    return Response.json({ error: { message: `Invalid API Key provided: ${marker}` } }, { status: 401 })
  })
  for (mode of ['provider', 'network', 'invalid_json']) {
    for (const request of [
      () => createSubscriptionCheckout({ plan: 'everything', tenantId: 1, origin: 'https://app.example.test' }),
      () => createBillingPortal({ customerId: 'cus_shop', origin: 'https://app.example.test' }),
      () => retrievePlatformSubscription('sub_host'),
    ]) await assert.rejects(request(), error => {
      assert.equal(error.code, 'platform_billing_unavailable'); assert.equal(error.status, 503)
      assert(!String(error).includes(marker)); assert(!error.stack.includes(marker)); assert(!JSON.stringify(error).includes(marker))
      assert.equal(error.cause, undefined)
      return true
    })
  }
})

test('Stripe JSON reads cap declared and streamed response bytes and cancel oversize bodies', async t => {
  setPlatformCredentials({ secret: 'sk_test_isolated_fixture' }); t.after(() => setPlatformCredentials({ secret: '' }))
  let mode = 'declared', canceled = 0, pulls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    if (mode === 'small') {
      const bytes = Buffer.from(JSON.stringify(subscription())); let i = 0
      return new Response(new ReadableStream({ pull(controller) {
        if (i === bytes.length) controller.close()
        else controller.enqueue(bytes.subarray(i, ++i))
      } }))
    }
    return new Response(new ReadableStream({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(262144)) },
      cancel() { canceled++ },
    }), { headers: mode === 'declared' ? { 'Content-Length': String(1024 * 1024 + 1) } : {} })
  })
  await assert.rejects(retrievePlatformSubscription('sub_host'), { code: 'platform_billing_unavailable' })
  assert.equal(canceled, 1); assert(pulls <= 1, 'an oversized declared body is rejected before collection')
  mode = 'streamed'; pulls = 0
  await assert.rejects(retrievePlatformSubscription('sub_host'), { code: 'platform_billing_unavailable' })
  assert.equal(canceled, 2); assert(pulls <= 6, 'collection stops at the byte ceiling, allowing only stream prefetch')
  mode = 'small'
  assert.equal((await retrievePlatformSubscription('sub_host')).id, 'sub_host', 'one-byte chunks parse without per-chunk retention')
})
