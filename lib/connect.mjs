/**
 * Stripe Connect (Express) — the platform's cut on shop payments (Print Shop Control edition).
 *
 * In the lite edition shops do NOT paste their own secret key. Instead each shop is onboarded onto
 * a Stripe Express account we create and manage. Customer payments are charged on OUR platform
 * account as destination charges: the full amount is captured, a 4% application fee stays with us
 * (covering card processing ~3% + ~1% profit), and the remaining 96% is transferred to the shop's
 * connected account. `on_behalf_of` makes the shop the merchant of record, so the charge shows the
 * shop's name on the customer's card statement.
 *
 * Every call uses the PLATFORM secret key (the same one billing.mjs uses) — never a per-shop key.
 * Account creation, onboarding links, checkout sessions and their retrieval are all platform-level
 * calls; destination charges live on the platform account, so no Stripe-Account header is needed.
 */

import { platformSecret } from './billing.mjs'

// The platform's take on every collected payment. 4% — ~3% covers Stripe processing, ~1% is ours.
export const FEE_PCT = Number(process.env.PSC_FEE_PCT || 0.04)

/** A shop can collect once it has a connected account that Stripe has enabled for charges. */
export const connectReady = (settings) => !!settings?.stripe_account_id && String(settings?.stripe_charges_enabled) === '1'

const form = (obj, prefix = '') => Object.entries(obj).flatMap(([k, v]) => {
  if (v === undefined) return []
  const key = prefix ? `${prefix}[${k}]` : k
  if (v && typeof v === 'object') return form(v, key)
  return `${encodeURIComponent(key)}=${encodeURIComponent(v)}`
}).join('&')

async function stripe(path, params = {}, method = 'POST') {
  const sk = platformSecret()
  if (!/^sk_(test|live)_/.test(sk)) throw new Error('Platform Stripe is not configured')
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    signal: AbortSignal.timeout(15000),
    method,
    headers: { Authorization: `Bearer ${sk}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: method === 'POST' ? form(params) : undefined,
  })
  /**
   * A body Stripe's edge served instead of Stripe.
   *
   * `await res.json()` unguarded throws a SyntaxError BEFORE the `if (!res.ok)` line that would
   * have said "Stripe 503" — and the pay route prints e.message straight onto the shop-branded
   * page a customer reached from an invoice email. Driven with an HTML 503 and an HTML 429: the
   * customer read "Unexpected token '<', \"<html><hea\"... is not valid JSON" under a heading
   * that said "Couldn't start checkout". Every other integration module in the tree already
   * guards this — quickbooks, gdrive, relay, notify and suppliers all do; these two, on the money
   * path, did not.
   */
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(data?.error?.message || `Stripe is not responding right now (HTTP ${res.status}). Try again in a minute.`)
  if (!data) throw new Error(`Stripe returned something that was not a reply (HTTP ${res.status}). Try again in a minute.`)
  return data
}

/** Create an Express connected account for a shop. Returns the acct_… id to store in settings. */
export async function createExpressAccount({ email, shopName, slug }) {
  const acct = await stripe('accounts', {
    type: 'express',
    email: email || undefined,
    business_profile: { name: shopName || undefined },
    capabilities: { card_payments: { requested: 'true' }, transfers: { requested: 'true' } },
    metadata: { slug: slug || '' },
  })
  return acct.id
}

/** A one-time hosted onboarding link the shop follows to finish Stripe setup. */
export async function createAccountLink({ accountId, origin }) {
  const link = await stripe('account_links', {
    account: accountId,
    refresh_url: `${origin}/stripe/connect/refresh`,
    return_url: `${origin}/stripe/connect/return`,
    type: 'account_onboarding',
  })
  return link.url
}

/** Current onboarding/charge state for a connected account. */
export async function getConnectAccount({ accountId }) {
  const a = await stripe(`accounts/${encodeURIComponent(accountId)}`, {}, 'GET')
  return {
    charges_enabled: !!a.charges_enabled,
    details_submitted: !!a.details_submitted,
    payouts_enabled: !!a.payouts_enabled,
  }
}

/**
 * Destination-charge Checkout Session on the platform account. The customer is charged the full
 * total; a 4% application fee stays with us and 96% transfers to the shop. `on_behalf_of` puts the
 * shop on the statement. Same lineItems shape as lib/stripe.mjs: {name, amountCents, qty}.
 */
export async function createConnectedCheckout({ accountId, lineItems, successUrl, cancelUrl, metadata = {}, customerEmail }) {
  if (!accountId) throw new Error('This shop has not connected Stripe yet')
  const total = lineItems.reduce((n, li) => n + Math.round(li.amountCents) * (li.qty || 1), 0)
  const fee = Math.round(total * FEE_PCT)
  const params = {
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    ...(customerEmail ? { customer_email: customerEmail } : {}),
    'payment_intent_data[application_fee_amount]': fee,
    'payment_intent_data[transfer_data][destination]': accountId,
    'payment_intent_data[on_behalf_of]': accountId,
  }
  lineItems.forEach((li, i) => {
    params[`line_items[${i}][quantity]`] = li.qty || 1
    params[`line_items[${i}][price_data][currency]`] = 'usd'
    params[`line_items[${i}][price_data][unit_amount]`] = Math.round(li.amountCents)
    params[`line_items[${i}][price_data][product_data][name]`] = li.name
  })
  Object.entries(metadata).forEach(([k, v]) => { params[`metadata[${k}]`] = String(v) })
  const s = await stripe('checkout/sessions', params)
  return { url: s.url, id: s.id }
}

/** Retrieve a destination-charge session from the platform account to confirm it actually paid. */
export async function retrieveConnectedSession({ sessionId }) {
  const d = await stripe(`checkout/sessions/${encodeURIComponent(sessionId)}`, {}, 'GET')
  return {
    paid: d.payment_status === 'paid',
    amountCents: Number(d.amount_total) || 0,
    email: d.customer_details?.email || d.customer_email || '',
    metadata: d.metadata || {},
  }
}
