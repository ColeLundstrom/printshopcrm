/**
 * Subscription billing — how PrintShopCRM makes money.
 *
 * This is the PLATFORM side: shops pay PrintShopCRM (us) a monthly subscription. It runs on our
 * own Stripe account (env PSC_PLATFORM_STRIPE_SECRET), separate from the per-shop Stripe used for
 * gang-sheet checkouts. Every shop starts on a free trial; when the trial ends they must pick a
 * plan to keep creating work. Checkout uses inline price_data so no Stripe dashboard setup is
 * needed — just drop in the secret key and it charges.
 *
 * Billing is "soft-gated": with no platform key set, everything runs in perpetual trial (so dev
 * and demos work), and the UI says billing isn't live yet. Set the key to start collecting.
 */

import crypto from 'node:crypto'

// The platform credentials. Set either by the owner in the in-app admin (stored in control.db and
// pushed here at boot) or by env. The secret key lives only server-side and is never sent to a browser.
let _platformSecret = ''
let _webhookSecret = ''
export function setPlatformCredentials({ secret, webhookSecret } = {}) {
  if (secret !== undefined) _platformSecret = secret || ''
  if (webhookSecret !== undefined) _webhookSecret = webhookSecret || ''
}
const PLATFORM_SK = () => _platformSecret || process.env.PSC_PLATFORM_STRIPE_SECRET || ''
// The platform key, shared with lib/connect.mjs (Stripe Connect uses the same account we bill on).
export const platformSecret = PLATFORM_SK
export const webhookSecret = () => _webhookSecret || process.env.PSC_STRIPE_WEBHOOK_SECRET || ''
export const billingLive = () => /^sk_(test|live)_/.test(PLATFORM_SK())
export const TRIAL_DAYS = 30
// A support payment may share our Stripe account/customer, but never this purpose.
export const HOSTING_PURPOSE = 'printshopcrm_hosting'

/**
 * The plan. Singular, on purpose (2026-08-21).
 *
 * `everything` is the product: every feature, unlimited seats, no locked module, no
 * "upgrade to unlock" anywhere in the app. The old starter/growth/pro and free/control/
 * control_auto ladders are kept below ONLY so existing tenant rows carrying those tier
 * strings still resolve to a name and price in the billing UI — nothing gates on them
 * any more (see planAllows/litePlanAllows).
 */
export const PLANS = {
  everything: {
    id: 'everything', name: 'Managed hosting', monthly: 149, annual: 1490, popular: true,
    tagline: 'We run the server and handle basic setup. The software is free and open source.',
    features: [
      'Quotes, proofs, production, invoices & payments',
      'Live margin at quote + measured profit per job',
      'Capacity & promise dates, shop-floor scanning',
      'Order-history import from your old system',
      'QuickBooks sync with a reconciliation queue',
      'Public REST API + webhooks',
      'AI receptionist, automations, gang sheets, DTF tools',
      'Unlimited seats — never priced per person',
    ],
    seats: Infinity,
  },
  starter: {
    id: 'starter', name: 'Starter', monthly: 99, annual: 990,
    tagline: 'Run the front office, paperless.',
    features: ['Unified inbox + CRM', 'Estimates, proofs & invoices', 'Production board & work tickets', 'Per-size pricing', 'Up to 3 seats'],
    seats: 3,
  },
  growth: {
    id: 'growth', name: 'Growth', monthly: 199, annual: 1990, popular: true,
    tagline: 'Know your margin and sell online.',
    features: ['Everything in Starter', 'Profit on every job (live margin)', 'Embeddable gang-sheet builder (your Stripe)', 'QuickBooks export', 'AI receptionist', 'Unlimited seats'],
    seats: Infinity,
  },
  pro: {
    id: 'pro', name: 'Pro', monthly: 399, annual: 3990,
    tagline: 'Wired into your suppliers and books.',
    features: ['Everything in Growth', 'S&S + SanMar live blank costs', 'Consolidated purchase orders', 'RIP-ready print packages', 'Bring-your-own payment processor', 'Priority support'],
    seats: Infinity,
  },
  // Print Shop Control (the lite edition's tiers). Free → $40 flagship → $99 automation.
  // Free has no monthly fee at all: the 4% on collected payments is the whole business model, so a
  // free shop is a real (never-locked) customer rather than a lapsed trial.
  free: {
    id: 'free', name: 'Free', productName: 'Print Shop Control Free', monthly: 0, annual: 0,
    tagline: 'Send invoices and get paid. No monthly fee, ever.',
    features: ['Estimates & invoices', 'Take card payments (4% per payment)', 'Your customer list', 'Email delivery + outbox'],
    seats: Infinity,
  },
  control: {
    id: 'control', name: 'Print Shop Control', productName: 'Print Shop Control', monthly: 40, annual: 360,
    tagline: 'Invoicing, payments, catalog, and artwork approval — everything to get paid.',
    features: ['Estimates & invoices', 'Take payments online', 'Industry product catalog', 'Preloaded, editable pricing', 'Saved products & customers', 'Artwork / mockup approval'],
    seats: Infinity,
  },
  control_auto: {
    id: 'control_auto', name: 'Print Shop Control Automation', productName: 'Print Shop Control Automation', monthly: 99, annual: 990, popular: true,
    tagline: 'Everything in Control, plus the follow-ups that get you paid faster.',
    features: ['Everything in Print Shop Control', 'Automatic invoice reminders', 'Payment follow-up', 'Artwork-approval reminders', 'Customer email follow-up'],
    seats: Infinity,
  },
}
// One plan means one entry. Legacy tier ids still resolve through PLANS for display only.
export const PLAN_ORDER = ['everything']
export const LITE_PLAN_ORDER = ['everything']
export const planRank = () => 0
/** Every tier string a tenant row might carry, mapped to the single real plan. */
export const CURRENT_PLAN = 'everything'

/* ---------- feature access: there is only one product, and everyone has all of it ----------
 *
 * 2026-08-21 — tiering removed on purpose. Every incumbent in this category sells the same
 * software three or four times: Printavo puts purchase orders, scheduling, barcoding and the API
 * behind Premium; InkSoft charges an undisclosed fee on top of its top tier for API access;
 * DecoNetwork's API is $439/mo Enterprise. That gating is a documented reason shops leave them,
 * and it makes the product worse for everyone — a shop can't build a workflow on a feature it
 * might lose at renewal, and we can't design a coherent product around artificial holes.
 *
 * So: one edition, every feature, every shop. These functions stay (call sites across the app
 * expect them) but they always answer yes. Deleting them would be a bigger, riskier diff than
 * making them honest constants — and keeping them means a future gate has exactly one home,
 * where this comment can argue against it.
 */
export const LITE_FEATURE_MIN_PLAN = {}
export const FEATURE_MIN_PLAN = {}
export const litePlanAllows = () => true
export const planAllows = () => true

/** Is this a plan a shop can just switch on, with nothing to charge? */
export const isFreePlan = (plan) => plan === 'free' || plan === 'everything'

/* ---------- Stripe (platform account) ---------- */

const form = (obj, prefix = '') => Object.entries(obj).flatMap(([k, v]) => {
  const key = prefix ? `${prefix}[${k}]` : k
  if (v && typeof v === 'object') return form(v, key)
  return `${encodeURIComponent(key)}=${encodeURIComponent(v)}`
}).join('&')

const STRIPE_RESPONSE_BYTES = 1024 * 1024
async function stripeJson(response) {
  // Expanded subscriptions and provider errors are external input. Keep both the bytes and
  // chunk bookkeeping bounded; do not accumulate an array for arbitrarily many tiny chunks.
  const declared = response.headers.get('content-length')
  if (declared && /^\d+$/.test(declared) && Number(declared) > STRIPE_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {})
    throw new Error('Stripe response exceeds the limit')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Stripe response is missing')
  const bytes = Buffer.allocUnsafeSlow(STRIPE_RESPONSE_BYTES)
  let length = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength > STRIPE_RESPONSE_BYTES - length) throw new Error('Stripe response exceeds the limit')
      bytes.set(chunk.value, length)
      length += chunk.value.byteLength
    }
    return JSON.parse(bytes.toString('utf8', 0, length))
  } catch (error) {
    void reader.cancel().catch(() => {})
    throw error
  } finally { reader.releaseLock() }
}

async function stripe(path, params, method = 'POST', { secret = PLATFORM_SK(), requestBody, idempotencyKey } = {}) {
  try {
    const res = await fetch(`https://api.stripe.com/v1/${path}`, {
      signal: AbortSignal.timeout(15000),
      method,
      redirect: 'error',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/x-www-form-urlencoded', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      body: method === 'POST' ? (requestBody ?? form(params)) : undefined,
    })
    const data = await stripeJson(res)
    if (!res.ok) throw new Error('Stripe rejected the billing request')
    return data
  } catch {
    // Stripe's invalid-key response can echo the secret. Never propagate raw bodies, network
    // messages or causes to route logs/browser errors; configuration validation stays above.
    throw Object.assign(new Error('Stripe billing is unavailable. Check the platform billing setup and try again.'), {
      code: 'platform_billing_unavailable', status: 503,
    })
  }
}

/**
 * Create a subscription Checkout Session on our platform account. `interval` is 'month' | 'year'.
 * Inline price_data means no pre-created Prices — the plan definitions here are the source of truth.
 */
function subscriptionCheckoutParams({ plan, interval = 'month', email, customerId, tenantId, origin }) {
  const p = Object.hasOwn(PLANS, plan) ? PLANS[plan] : null
  if (!p) throw new Error('Unknown plan')
  if (customerId && (typeof customerId !== 'string' || /\s/.test(customerId) || !/^cus_[A-Za-z0-9_]{1,240}$/.test(customerId))) throw new Error('Invalid billing customer')
  const yearly = interval === 'year'
  const amount = Math.round((yearly ? p.annual : p.monthly) * 100)
  return {
    mode: 'subscription',
    success_url: `${origin}/#/billing?upgraded=1`,
    cancel_url: `${origin}/#/billing`,
    ...(customerId ? { customer: customerId } : (email ? { customer_email: email } : {})),
    allow_promotion_codes: 'true',
    'line_items[0][quantity]': 1,
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': amount,
    'line_items[0][price_data][recurring][interval]': yearly ? 'year' : 'month',
    'line_items[0][price_data][product_data][name]': p.productName || `PrintShopCRM ${p.name}`,
    'line_items[0][price_data][product_data][description]': p.tagline,
    'line_items[0][price_data][product_data][metadata][purpose]': HOSTING_PURPOSE,
    'line_items[0][price_data][product_data][metadata][plan]': plan,
    'subscription_data[metadata][tenant_id]': String(tenantId),
    'subscription_data[metadata][plan]': plan,
    'subscription_data[metadata][purpose]': HOSTING_PURPOSE,
    'metadata[tenant_id]': String(tenantId),
    'metadata[plan]': plan,
    'metadata[purpose]': HOSTING_PURPOSE,
    'client_reference_id': String(tenantId),
  }
}

export async function createSubscriptionCheckout(options) {
  if (!billingLive()) throw new Error('Billing is not configured yet')
  const session = await stripe('checkout/sessions', subscriptionCheckoutParams(options))
  return { url: session.url, id: session.id }
}

/** Build once and persist this exact body before a provider request can be attempted. */
export function buildHostingCheckoutRequest(options) {
  const { tenantId, intentId, plan, interval, email, origin } = options || {}
  if (!Number.isSafeInteger(tenantId) || tenantId < 1 || typeof intentId !== 'string' || /\s/.test(intentId) || !/^[a-f0-9-]{36}$/.test(intentId)) throw new Error('Invalid hosting checkout identity')
  if (!PLAN_ORDER.includes(plan) || !['month', 'year'].includes(interval)) throw new Error('Choose the current hosting plan and billing interval')
  if (email != null && (typeof email !== 'string' || email.length > 254 || /[\r\n\0]/.test(email))) throw new Error('Invalid hosting email')
  let parsed
  try { parsed = new URL(origin) } catch { throw new Error('Invalid hosting return address') }
  if (parsed.origin !== origin || !['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Invalid hosting return address')
  const params = subscriptionCheckoutParams(options)
  params['metadata[hosting_intent]'] = intentId
  params['subscription_data[metadata][hosting_intent]'] = intentId
  params['expand[0]'] = 'line_items.data.price.product'
  return form(params)
}

/** Capture the credential for an entire account-verified operation, including rotations. */
export function createPlatformBillingClient() {
  const secret = PLATFORM_SK()
  if (!/^sk_(test|live)_/.test(secret)) throw new Error('Billing is not configured yet')
  const call = (path, params, method = 'GET', extra = {}) => stripe(path, params, method, { ...extra, secret })
  const sessionId = value => {
    if (typeof value !== 'string' || /\s/.test(value) || !/^cs_[A-Za-z0-9_]{1,240}$/.test(value)) throw new Error('Invalid hosting session')
    return value
  }
  const key = value => {
    if (typeof value !== 'string' || /\s/.test(value) || !/^[A-Za-z0-9_-]{16,200}$/.test(value)) throw new Error('Invalid hosting operation identity')
    return value
  }
  return Object.freeze({
    async account() {
      const account = await call('account', {})
      if (account?.object !== 'account' || typeof account.id !== 'string' || !/^acct_[A-Za-z0-9_]{1,240}$/.test(account.id) || /\s/.test(account.id)) throw new Error('Stripe account could not be verified')
      return { accountId: account.id, livemode: secret.startsWith('sk_live_') }
    },
    createCheckout({ requestBody, idempotencyKey }) {
      if (typeof requestBody !== 'string' || Buffer.byteLength(requestBody) > 16384) throw new Error('Invalid saved hosting request')
      return call('checkout/sessions', {}, 'POST', { requestBody, idempotencyKey: key(idempotencyKey) })
    },
    retrieveCheckout(value) {
      return call(`checkout/sessions/${sessionId(value)}?expand%5B%5D=line_items.data.price.product`, {})
    },
    expireCheckout({ sessionId: value, idempotencyKey }) {
      return call(`checkout/sessions/${sessionId(value)}/expire`, {}, 'POST', { idempotencyKey: key(idempotencyKey) })
    },
    retrieveSubscription(value) {
      if (typeof value !== 'string' || /\s/.test(value) || !/^sub_[A-Za-z0-9_]{1,240}$/.test(value)) throw new Error('Invalid billing subscription')
      return call(`subscriptions/${value}?expand%5B%5D=items.data.price.product`, {})
    },
  })
}

/** Read the actual hosting subscription; expansion also identifies pre-purpose legacy products. */
export async function retrievePlatformSubscription(subscriptionId) {
  if (!billingLive()) throw new Error('Billing is not configured yet')
  if (typeof subscriptionId !== 'string' || !/^sub_[A-Za-z0-9_]{1,240}$/.test(subscriptionId)) throw new Error('Invalid billing subscription')
  return stripe(`subscriptions/${encodeURIComponent(subscriptionId)}?expand%5B%5D=items.data.price.product`, {}, 'GET')
}

/** A link to Stripe's hosted billing portal so a shop can manage/cancel their subscription. */
export async function createBillingPortal({ customerId, origin }) {
  if (!billingLive()) throw new Error('Billing is not configured yet')
  const s = await stripe('billing_portal/sessions', { customer: customerId, return_url: `${origin}/#/billing` })
  return { url: s.url }
}

/** Stripe's standard replay window. A signature stays valid forever without it. */
const WEBHOOK_TOLERANCE_S = 300

/** Verify a Stripe webhook signature (t=…,v1=…) against the raw body. */
export function verifyWebhook(rawBody, sigHeader, secret) {
  // No secret configured → REJECT. Accepting unsigned events would let anyone forge subscription
  // state (mark a shop paid, cancel a rival). Set PSC_STRIPE_WEBHOOK_SECRET to enable the webhook.
  if (!secret) return false
  try {
    const parts = Object.fromEntries(String(sigHeader || '').split(',').map((kv) => kv.split('=')))
    // The timestamp is inside the signed payload, so an attacker cannot move it — but a body +
    // header captured from a log stays replayable (re-cancel a shop, re-activate a lapsed one)
    // until it is checked against the clock.
    const ts = Number(parts.t)
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > WEBHOOK_TOLERANCE_S) return false
    const signed = `${parts.t}.${rawBody}`
    const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex')
    const a = Buffer.from(expected); const b = Buffer.from(parts.v1 || '')
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  } catch { return false }
}
