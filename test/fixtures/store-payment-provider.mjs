// Loaded AFTER the demo network guard. A local Stripe with real session state: a checkout is
// created OPEN and unpaid, and stays that way until the test marks it paid — so "the member walked
// away" and "the member paid later" are both observable. Synthetic only; no network fallback.
import { readFileSync, writeFileSync } from 'node:fs'
const path = process.env.PSC_STORE_PAYMENT_FIXTURE
if (!path || process.env.PSC_DEMO !== '1') throw new Error('Store payment fixture requires an isolated demo')
const read = () => JSON.parse(readFileSync(path, 'utf8'))
const write = (s) => writeFileSync(path, JSON.stringify(s))
const reply = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } })
const visible = (s) => ({ ...s, payment_intent: s.payment_status === 'paid' ? s.payment_intent : null, url: s.status === 'open' ? s.url : null })
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url), state = read()
  if (u.origin !== 'https://api.stripe.com') throw new Error('External request blocked by store payment fixture: ' + u.origin)
  const secret = String(opts.headers?.Authorization || '').replace(/^Bearer /, ''), account = state.accounts[secret]
  if (!account) return reply({ error: { message: 'Fixture unrecognized credential' } }, 401)
  if (u.pathname === '/v1/account') return reply({ object: 'account', id: account })
  if (opts.method === 'POST' && u.pathname === '/v1/checkout/sessions') {
    const body = String(opts.body), p = new URLSearchParams(body), key = opts.headers['Idempotency-Key']
    if (key && state.idempotency[key]) return reply(visible(state.sessions[state.idempotency[key]]))
    const id = 'cs_store_' + (++state.seq), metadata = {}
    for (const [k, v] of p) if (k.startsWith('metadata[')) metadata[k.slice(9, -1)] = v
    state.sessions[id] = { id, object: 'checkout.session', mode: 'payment', status: 'open', payment_status: 'unpaid', livemode: !secret.startsWith('sk_test_'),
      amount_total: Number(p.get('line_items[0][price_data][unit_amount]')), currency: p.get('line_items[0][price_data][currency]'), metadata,
      payment_intent: 'pi_store_' + state.seq, url: 'https://checkout.stripe.com/c/pay/' + id, _account: account }
    if (key) state.idempotency[key] = id
    state.posts.push({ id, key, success: p.get('success_url'), cancel: p.get('cancel_url') }); write(state)
    return reply(visible(state.sessions[id]))
  }
  if (u.pathname === '/v1/checkout/sessions' && u.searchParams.has('payment_intent'))
    return reply({ data: Object.values(state.sessions).filter((s) => s._account === account && s.payment_intent === u.searchParams.get('payment_intent')), has_more: false })
  const parts = u.pathname.split('/'), id = parts.at(-1)
  if (u.pathname.startsWith('/v1/refunds/') && state.refunds[id]) return reply(state.refunds[id])
  const row = state.sessions[parts.at(-1) === 'expire' ? parts.at(-2) : id]
  if (row && row._account === account) {
    if (opts.method === 'POST' && parts.at(-1) === 'expire') { row.status = 'expired'; write(state) }
    return reply(visible(row))
  }
  return reply({ error: { message: 'Fixture object not found' } }, 404)
}
