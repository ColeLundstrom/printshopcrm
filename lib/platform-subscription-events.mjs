/**
 * Process only signature-verified events from the platform Stripe account. Customer IDs alone
 * are never a subscription binding: the same person may also sponsor this project or buy other
 * products. Tenant lookups and writes are synchronous; only provider reconciliation is async.
 */
import { HOSTING_PURPOSE, PLANS } from './billing.mjs'

const STATUSES = new Set(['active', 'trialing', 'past_due', 'canceled', 'unpaid', 'paused', 'incomplete', 'incomplete_expired'])
const TERMINAL = new Set(['canceled', 'incomplete_expired'])
const ignored = reason => ({ handled: false, reason })
const missing = value => value === undefined || value === null || value === ''
const id = (value, prefix) => {
  const raw = typeof value === 'object' && value !== null ? value.id : value
  return typeof raw === 'string' && !/\s/.test(raw) && new RegExp(`^${prefix}_[A-Za-z0-9_]{1,240}$`).test(raw) ? raw : null
}
const tenantId = value => {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const text = String(value)
  return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null
}
const knownPlan = value => typeof value === 'string' && Object.hasOwn(PLANS, value)
const otherPurpose = meta => !missing(meta?.purpose) && meta.purpose !== HOSTING_PURPOSE
const metadataMatches = (meta, tenant) => !otherPurpose(meta)
  && (missing(meta?.tenant_id) || tenantId(meta.tenant_id) === tenant.id)
const mappedStatus = status => status === 'trialing' ? 'active' : status
const retry = () => Object.assign(new Error('Hosting subscription verification is unavailable; Stripe should retry this event.'), {
  code: 'platform_subscription_unavailable', status: 503, retryable: true,
})

// Initial legacy sessions emitted both tenant_id and plan metadata. Their inline products had
// these exact names, verified against the 1.0 billing implementation. Never match by substring.
export function legacyProductMatches(subscription, plan) {
  const rows = subscription.items?.data
  if (!Array.isArray(rows)) throw retry()
  if (rows.length !== 1 || subscription.items.has_more) return false
  const price = rows[0]?.price, product = price?.product, definition = PLANS[plan]
  const names = [definition.productName || `PrintShopCRM ${definition.name}`]
  if (plan === 'everything') names.push('PrintShopCRM Everything')
  if (!product || typeof product !== 'object') throw retry()
  if (product.deleted || otherPurpose(product.metadata)) return false
  if (!missing(product.metadata?.plan) && product.metadata.plan !== plan) return false
  const interval = price.recurring?.interval
  return names.includes(product.name) && price.currency === 'usd' && rows[0].quantity === 1
    && (interval === 'month' || interval === 'year') && (price.recurring.interval_count ?? 1) === 1
    && price.unit_amount === Math.round((interval === 'year' ? definition.annual : definition.monthly) * 100)
}

/**
 * Callbacks: getTenantById(id), getTenantByStripeCustomer(customerId), setSubscription(id,patch)
 * and async retrieveSubscription(subscriptionId). Does not verify signatures or acknowledge HTTP.
 * Unrelated/mismatched events return handled:false. Provider failure throws a safe retryable error
 * so an actual checkout cannot be acknowledged while its hosting activation is silently lost.
 */
export function createPlatformSubscriptionEventProcessor({ getTenantById, getTenantByStripeCustomer, setSubscription, retrieveSubscription, hostingCheckouts, maxConcurrent = 4 }) {
  for (const callback of [getTenantById, getTenantByStripeCustomer, setSubscription, retrieveSubscription]) {
    if (typeof callback !== 'function') throw new TypeError('Platform subscription callbacks are required')
  }
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16) throw new TypeError('Invalid hosting reconciliation limit')
  const inFlight = new Set()
  const reconcile = async (tenant, callback) => {
    // Reject for provider retry instead of retaining an unbounded webhook queue. Serializing
    // each shop's reads means an earlier slow response cannot overwrite a later Stripe state.
    if (inFlight.has(tenant.id) || inFlight.size >= maxConcurrent) throw retry()
    inFlight.add(tenant.id)
    try { return await callback() } finally { inFlight.delete(tenant.id) }
  }
  const readSubscription = async subscriptionId => {
    let subscription
    try { subscription = await retrieveSubscription(subscriptionId) } catch { throw retry() }
    if (!subscription || subscription.object !== 'subscription' || id(subscription.id, 'sub') !== subscriptionId
        || !id(subscription.customer, 'cus') || !STATUSES.has(subscription.status)) throw retry()
    return subscription
  }
  const customerMatches = (tenant, customerId) => {
    if (!tenant || !Number.isSafeInteger(tenant.id) || tenant.id < 1 || (tenant.stripe_customer_id && tenant.stripe_customer_id !== customerId)) return false
    const owner = getTenantByStripeCustomer(customerId)
    return !owner || owner.id === tenant.id
  }
  const apply = (tenant, patch) => {
    setSubscription(tenant.id, patch)
    return { handled: true, tenantId: tenant.id }
  }
  const unchanged = (original, customerId) => {
    const current = getTenantById(original.id)
    if (!customerMatches(current, customerId) || ['stripe_subscription_id', 'stripe_customer_id', 'subscription_status', 'plan_tier', 'hosting_revision']
      .some(key => current[key] !== original[key])) throw retry()
    return current
  }
  return async function processPlatformSubscriptionEvent(event) {
    if (event?.account) return ignored('connected_account')
    const obj = event?.data?.object
    if (!obj || typeof obj !== 'object') return ignored('missing_object')
    if (otherPurpose(obj.metadata)) return ignored('unrelated_purpose')
    if (['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type) && !missing(obj.metadata?.hosting_intent)) {
      if (!hostingCheckouts) throw retry()
      return hostingCheckouts.processCheckoutEvent(event)
    }
    const customerId = id(obj.customer, 'cus')
    if (!customerId) return ignored('missing_customer')

    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      if (obj.mode !== 'subscription' || obj.status !== 'complete') return ignored('not_subscription_checkout')
      const subscriptionId = id(obj.subscription, 'sub'), target = tenantId(obj.metadata?.tenant_id)
      if (!subscriptionId) return ignored('missing_subscription')
      // client_reference_id is reconciliation data, not authorization to change a tenant.
      if (!target || (!missing(obj.client_reference_id) && tenantId(obj.client_reference_id) !== target)) return ignored('tenant_mismatch')
      const original = { ...getTenantById(target) }
      if (!customerMatches(original, customerId)) return ignored('customer_mismatch')
      const plan = obj.metadata?.plan
      if (!knownPlan(plan)) return ignored('unknown_plan')
      return reconcile(original, async () => {
      const subscription = await readSubscription(subscriptionId)
      if (id(subscription.customer, 'cus') !== customerId || !metadataMatches(subscription.metadata, original)) return ignored('subscription_mismatch')
      const alreadyBound = original.stripe_subscription_id === subscriptionId
      // Previously bound subscriptions can predate purpose metadata. A new binding needs the
      // two server-created metadata sets, plus explicit purpose or an exact legacy product.
      if (!alreadyBound) {
        if (tenantId(subscription.metadata?.tenant_id) !== target || subscription.metadata?.plan !== plan) return ignored('subscription_mismatch')
        // Pending checkouts from before the durable-intent release can still complete, but
        // purpose metadata alone no longer authorizes a fresh binding without a receipt.
        if (!legacyProductMatches(subscription, plan)) return ignored('unverified_hosting_product')
      } else if (!missing(subscription.metadata?.plan) && subscription.metadata.plan !== plan) return ignored('plan_mismatch')

      if (original.stripe_subscription_id && !alreadyBound) {
        // Never let a delayed old Checkout replace a newer active subscription. A new hosting
        // subscription can replace only a provider-confirmed ended one for this same customer.
        const previousId = id(original.stripe_subscription_id, 'sub')
        if (!previousId) return ignored('invalid_binding')
        const previous = await readSubscription(previousId)
        if (id(previous.customer, 'cus') !== customerId || !metadataMatches(previous.metadata, original)) return ignored('subscription_mismatch')
        if (!TERMINAL.has(previous.status) || TERMINAL.has(subscription.status)) {
          hostingCheckouts?.recordLegacyAnomaly({ tenantId: original.id, session: obj, subscription, reason: 'existing_subscription' })
          return ignored('existing_subscription')
        }
      }
      // Provider I/O yields the request thread. Another checkout, cancellation or tenant change
      // must not be overwritten using a binding read before that I/O.
      const current = unchanged(original, customerId)
      return apply(current, { plan, status: mappedStatus(subscription.status), customerId, subscriptionId })
      })
    }

    let subscriptionId, metadata = [obj.metadata], status
    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      subscriptionId = id(obj.id, 'sub')
      status = event.type === 'customer.subscription.deleted' ? 'canceled' : obj.status
      if (!STATUSES.has(status)) return ignored('unknown_status')
    } else if (event.type === 'invoice.payment_failed') {
      const legacy = id(obj.subscription, 'sub')
      const parent = obj.parent?.type === 'subscription_details' ? obj.parent.subscription_details : null
      const modern = id(parent?.subscription, 'sub')
      if ((!missing(obj.subscription) && !legacy) || (parent && !modern) || (legacy && modern && legacy !== modern)) return ignored('subscription_mismatch')
      if (obj.parent && obj.parent.type !== 'subscription_details') return ignored('not_subscription_invoice')
      subscriptionId = modern || legacy
      metadata.push(parent?.metadata, obj.subscription_details?.metadata)
      status = 'past_due'
    } else return ignored('unhandled_event')
    if (!subscriptionId) return ignored('missing_subscription')
    const tenant = { ...getTenantByStripeCustomer(customerId) }
    if (!tenant || tenant.stripe_customer_id !== customerId || tenant.stripe_subscription_id !== subscriptionId) return ignored('unbound_subscription')
    if (!metadata.every(meta => metadataMatches(meta, tenant))) return ignored('tenant_or_purpose_mismatch')
    // A late invoice must not reopen a definitively ended subscription as past due.
    if (event.type === 'invoice.payment_failed' && TERMINAL.has(tenant.subscription_status)) return ignored('ended_subscription')
    return reconcile(tenant, async () => {
      // Stripe does not guarantee event delivery order. The event identifies the exact bound
      // subscription; its current provider state, rather than an old payload, is authoritative.
      const subscription = await readSubscription(subscriptionId)
      if (id(subscription.customer, 'cus') !== customerId || !metadataMatches(subscription.metadata, tenant)) return ignored('subscription_mismatch')
      const current = unchanged(tenant, customerId)
      const plan = knownPlan(subscription.metadata?.plan) ? subscription.metadata.plan : undefined
      return apply(current, { ...(plan ? { plan } : {}), status: mappedStatus(subscription.status) })
    })
  }
}
