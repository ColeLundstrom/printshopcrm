import { currencyCode, stripeUnits, stripeHundredths } from './payment-currency.mjs'
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

const RESPONSE_BYTES = 1024 * 1024
const MAX_REQUESTS = 16
let activeRequests = 0
const SAFE_ERRORS = {
  stripe_authentication_failed: [503, 'The Stripe connection needs attention. Ask the shop owner or server operator to check the account credentials.'],
  stripe_rate_limited: [503, 'Stripe is temporarily limiting requests. Wait a minute, then check the payment status before trying again.'],
  stripe_request_rejected: [502, 'Stripe rejected this request. Check the Stripe account setup and payment details before retrying.'],
  stripe_unavailable: [503, 'Stripe is unavailable. Check the payment status before trying again.'],
  stripe_request_timeout: [504, 'Stripe did not respond in time. Check the payment status before trying again.'],
  stripe_response_invalid: [502, 'Stripe returned an invalid response. Check the payment status before trying again.'],
  stripe_response_too_large: [502, 'Stripe returned an oversized response. Ask the shop owner or server operator to check the Stripe connection.'],
  stripe_busy: [503, 'Payment verification is busy. Wait a moment and check the payment status before trying again.'],
}
class StripeRequestError extends Error {
  constructor(code, uncertain = false) {
    super(SAFE_ERRORS[code][1])
    this.code = code
    this.status = SAFE_ERRORS[code][0]
    this.stripeSafe = true
    this.outcome_uncertain = uncertain
  }
}
const stopBody = response => { try { void response?.body?.cancel().catch(() => {}) } catch {} }

/** Shared by shop payments and Connect. Never propagate provider text, bodies or causes. */
export async function requestStripe(path, { secret, method = 'GET', body, idempotencyKey, send = fetch, timeoutMs = 15000 } = {}) {
  if (activeRequests >= MAX_REQUESTS) throw new StripeRequestError('stripe_busy')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) throw new TypeError('Invalid Stripe request deadline')
  const controller = new AbortController(), write = method !== 'GET'
  let timer, timedOut = false
  activeRequests++
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      reject(new StripeRequestError('stripe_request_timeout', write))
    }, timeoutMs)
  })
  const perform = async () => {
    // A redirect can forward a POST body even when fetch strips Authorization. Refuse every
    // redirect, including one to another Stripe host; all authorized endpoints are fixed here.
    const response = await send(`https://api.stripe.com/v1/${path}`, {
      method, redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/x-www-form-urlencoded', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      ...(method === 'POST' ? { body } : {}),
    })
    if (timedOut) { stopBody(response); throw new StripeRequestError('stripe_request_timeout', write) }
    if (response.redirected || (response.url && new URL(response.url).origin !== 'https://api.stripe.com')) {
      stopBody(response)
      throw new StripeRequestError('stripe_response_invalid', write)
    }
    if (!response.ok) {
      // Error payloads are not needed for recovery and can echo a credential or customer data.
      stopBody(response)
      const code = [401,403].includes(response.status) ? 'stripe_authentication_failed'
        : response.status === 429 ? 'stripe_rate_limited'
        : response.status >= 400 && response.status < 500 ? 'stripe_request_rejected' : 'stripe_unavailable'
      throw new StripeRequestError(code, write && code === 'stripe_unavailable')
    }
    const declared = response.headers.get('content-length')
    if (declared && /^\d+$/.test(declared) && Number(declared) > RESPONSE_BYTES) {
      stopBody(response)
      throw new StripeRequestError('stripe_response_too_large', write)
    }
    const reader = response.body?.getReader()
    if (!reader) throw new StripeRequestError('stripe_response_invalid', write)
    const cancel = () => { try { void reader.cancel().catch(() => {}) } catch {} }
    controller.signal.addEventListener('abort', cancel, { once: true })
    const bytes = Buffer.allocUnsafeSlow(RESPONSE_BYTES)
    let length = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (timedOut) throw new StripeRequestError('stripe_request_timeout', write)
        if (chunk.done) break
        if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength > RESPONSE_BYTES - length) throw new StripeRequestError('stripe_response_too_large', write)
        bytes.set(chunk.value, length)
        length += chunk.value.byteLength
      }
      let data
      try { data = JSON.parse(bytes.toString('utf8', 0, length)) } catch { throw new StripeRequestError('stripe_response_invalid', write) }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new StripeRequestError('stripe_response_invalid', write)
      return data
    } catch (error) {
      cancel()
      throw error
    } finally {
      controller.signal.removeEventListener('abort', cancel)
      reader.releaseLock()
    }
  }
  try {
    return await Promise.race([perform(), deadline])
  } catch (error) {
    if (error instanceof StripeRequestError) throw error
    throw new StripeRequestError(timedOut ? 'stripe_request_timeout' : 'stripe_unavailable', write)
  } finally {
    clearTimeout(timer)
    activeRequests--
  }
}

/**
 * Create a Checkout Session on the shop's Stripe. `lineItems` are {name, amountCents, qty}.
 * Returns { url } to redirect the customer to Stripe's hosted checkout.
 */
export async function createCheckout({ settings, lineItems, successUrl, cancelUrl, metadata = {}, customerEmail, idempotencyKey }) {
  const sk = String(settings?.stripe_secret || '')
  if (!/^sk_(test|live)_/.test(sk)) throw new Error('This shop has not connected Stripe yet')

  const currency=currencyCode(settings.currency)
  const params = {
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    ...(customerEmail ? { customer_email: customerEmail } : {}),
  }
  lineItems.forEach((li, i) => {
    params[`line_items[${i}][quantity]`] = li.qty || 1
    params[`line_items[${i}][price_data][currency]`] = currency.toLowerCase()
    params[`line_items[${i}][price_data][unit_amount]`] = stripeUnits(Math.round(li.amountCents), currency)
    params[`line_items[${i}][price_data][product_data][name]`] = li.name
  })
  Object.entries(metadata).forEach(([k, v]) => { params[`metadata[${k}]`] = String(v) })

  const data = await requestStripe('checkout/sessions', { secret: sk, method: 'POST', body: form(params), idempotencyKey })
  if (!data.id || !data.url || !String(data.url).startsWith('https://')) throw new Error('Stripe did not return a checkout link')
  return { url: data.url, id: data.id }
}

/**
 * Retrieve a Checkout Session from the shop's Stripe to confirm it actually paid before we record
 * anything. Returns { paid, amountCents, email, metadata } — never trusts the browser's word for it.
 */
export async function retrieveSession({ settings, sessionId }) {
  const sk = String(settings?.stripe_secret || '')
  if (!/^sk_(test|live)_/.test(sk)) throw new Error('This shop has not connected Stripe')
  const d = await requestStripe(`checkout/sessions/${encodeURIComponent(sessionId)}`, { secret: sk })
  return {
    paid: d.payment_status === 'paid',
    test: d.livemode === false,
    amountCents: stripeHundredths(Number(d.amount_total) || 0, d.currency || 'USD'),
    currency: currencyCode(d.currency),
    id: d.id,
    paymentIntent: typeof d.payment_intent === 'string' ? d.payment_intent : d.payment_intent?.id,
    email: d.customer_details?.email || d.customer_email || '',
    metadata: d.metadata || {},
  }
}


async function stripeRead(settings,path,send=fetch) {
  if(!stripeConfigured(settings)) throw new Error('Connect the original Stripe account before reconciling a refund')
  return requestStripe(path,{secret:settings.stripe_secret,send})
}
export async function retrieveStripeRefund({settings,id,send=fetch}) {
  if(!/^re_[A-Za-z0-9_]{1,96}$/.test(String(id))) throw new Error('Invalid Stripe refund ID')
  const refund=await stripeRead(settings,'refunds/'+encodeURIComponent(id),send)
  if(refund.id!==id || refund.object!=='refund') throw new Error('Stripe returned another refund')
  const pi=typeof refund.payment_intent==='string'?refund.payment_intent:refund.payment_intent?.id
  if(!pi || !/^pi_[A-Za-z0-9_]+$/.test(pi)) throw new Error('Refund has no verifiable payment intent')
  const sessions=await stripeRead(settings,'checkout/sessions?payment_intent='+encodeURIComponent(pi)+'&limit=2',send)
  const matches=(sessions.data || []).filter(s=>(typeof s.payment_intent==='string'?s.payment_intent:s.payment_intent?.id)===pi)
  if(!matches.length) return {unrelated:true} // A charge taken outside this app.
  if(matches.length!==1 || sessions.has_more) throw new Error('Refund belongs to an ambiguous checkout')
  const s=matches[0]
  const amountCents=stripeHundredths(refund.amount,refund.currency)
  if(!amountCents || !['pending','requires_action','succeeded','failed','canceled'].includes(refund.status)) throw new Error('Unrecognized Stripe refund state')
  return {id,kind:'refund',amountCents,status:refund.status,appliedCents:refund.status==='succeeded'?amountCents:0,
    session:{id:s.id,paid:s.payment_status==='paid',test:s.livemode===false,currency:currencyCode(s.currency),amountCents:stripeHundredths(s.amount_total,s.currency),metadata:s.metadata || {},paymentIntent:pi},
    currency:currencyCode(refund.currency)}
}
