/**
 * Stripe checkout — on the SHOP's account, never ours.
 *
 * Each shop configures its OWN Stripe secret key in Settings; gang-sheet checkouts create a
 * Checkout Session directly against that key, so money lands in the shop's Stripe and we are
 * not the merchant of record (no platform cut, no Connect). When a shop hasn't added a key,
 * the builder falls back to submitting the order as a quote — never a dead end.
 *
 * Real Stripe REST call, form-encoded. Test it with the shop's own test key (sk_test_…).
 */

export const stripeConfigured = (settings) => /^sk_(test|live)_/.test(String(settings?.stripe_secret || ''))

const form = (obj, prefix = '') => Object.entries(obj).flatMap(([k, v]) => {
  const key = prefix ? `${prefix}[${k}]` : k
  if (v && typeof v === 'object') return form(v, key)
  return `${encodeURIComponent(key)}=${encodeURIComponent(v)}`
}).join('&')

/**
 * Create a Checkout Session on the shop's Stripe. `lineItems` are {name, amountCents, qty}.
 * Returns { url } to redirect the customer to Stripe's hosted checkout.
 */
export async function createCheckout({ settings, lineItems, successUrl, cancelUrl, metadata = {}, customerEmail }) {
  const sk = String(settings?.stripe_secret || '')
  if (!/^sk_(test|live)_/.test(sk)) throw new Error('This shop has not connected Stripe yet')

  const params = {
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    ...(customerEmail ? { customer_email: customerEmail } : {}),
  }
  lineItems.forEach((li, i) => {
    params[`line_items[${i}][quantity]`] = li.qty || 1
    params[`line_items[${i}][price_data][currency]`] = 'usd'
    params[`line_items[${i}][price_data][unit_amount]`] = Math.round(li.amountCents)
    params[`line_items[${i}][price_data][product_data][name]`] = li.name
  })
  Object.entries(metadata).forEach(([k, v]) => { params[`metadata[${k}]`] = String(v) })

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    signal: AbortSignal.timeout(15000),
    method: 'POST',
    headers: { Authorization: `Bearer ${sk}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form(params),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data?.error?.message || `Stripe ${res.status}`)
  return { url: data.url, id: data.id }
}

/**
 * Retrieve a Checkout Session from the shop's Stripe to confirm it actually paid before we record
 * anything. Returns { paid, amountCents, email, metadata } — never trusts the browser's word for it.
 */
export async function retrieveSession({ settings, sessionId }) {
  const sk = String(settings?.stripe_secret || '')
  if (!/^sk_(test|live)_/.test(sk)) throw new Error('This shop has not connected Stripe')
  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${sk}` },
  })
  const d = await res.json()
  if (!res.ok) throw new Error(d?.error?.message || `Stripe ${res.status}`)
  return {
    paid: d.payment_status === 'paid',
    amountCents: Number(d.amount_total) || 0,
    email: d.customer_details?.email || d.customer_email || '',
    metadata: d.metadata || {},
  }
}
