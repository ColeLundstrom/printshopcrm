import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { createHttpTestServer } from './helpers/http-test-server.mjs'

const ROOT = new URL('..', import.meta.url)

// The real server, the real routes, a local Stripe (test/fixtures/store-payment-provider.mjs).
async function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), 'psc-store-pay-')), dest = join(temp, 'demo'), stateFile = join(temp, 'provider.json')
  const server = await createHttpTestServer(); let db, logs = ''
  t.after(async () => { await server.close(); db?.close(); rmSync(temp, { recursive: true, force: true }) })
  const built = spawnSync(process.execPath, ['bin/demo.mjs', dest, String(server.port)], { cwd: ROOT, encoding: 'utf8', timeout: 120000 })
  assert.equal(built.status, 0, built.stderr)
  const env = JSON.parse(readFileSync(join(dest, 'demo-env.json'), 'utf8')); env.PSC_STORE_PAYMENT_FIXTURE = stateFile; env.PSC_TICK_MS = '3600000'
  writeFileSync(stateFile, JSON.stringify({ seq: 0, sessions: {}, idempotency: {}, posts: [], refunds: {},
    accounts: { sk_live_store_fixture: 'acct_store_primary', sk_live_other_fixture: 'acct_store_other', sk_test_store_fixture: 'acct_store_primary' } }))
  const start = () => server.start({ cwd: dest, env, args: ['--no-warnings', '--import', './bin/demo-network-guard.mjs', '--import', new URL('./fixtures/store-payment-provider.mjs', import.meta.url).href, 'server.mjs'], onOutput: (s) => { logs += s } })
  await start()
  const login = await fetch(server.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'dylan@example.test', password: readFileSync(join(dest, 'LOGIN.txt'), 'utf8').match(/Password: (.+)/)[1] }) })
  assert.equal(login.status, 200, logs)
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
  const slug = readdirSync(join(dest, 'data/tenants'))[0]
  db = new DatabaseSync(join(dest, 'data/tenants', slug, 'printshop.db')); db.exec('PRAGMA busy_timeout=5000;PRAGMA foreign_keys=ON')
  const f = { server, db, slug, base: server.base, log: () => logs, hookSecret: 'whsec_store_fixture' }
  f.state = () => JSON.parse(readFileSync(stateFile, 'utf8'))
  f.mutate = (fn) => { const s = f.state(); fn(s); writeFileSync(stateFile, JSON.stringify(s)) }
  f.request = async (path, { body, method = 'GET', auth = true } = {}) => {
    const r = await fetch(new URL(path, server.base), { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual', signal: AbortSignal.timeout(15000) })
    const text = await r.text(); let data; try { data = JSON.parse(text) } catch { /* html */ }
    return { status: r.status, text, data, location: r.headers.get('location') }
  }
  f.ok = async (path, body, method = 'POST') => { const r = await f.request(path, { body, method }); assert([200, 201].includes(r.status), r.text); return r.data }
  f.form = async (path, fields = {}) => {
    const r = await fetch(new URL(path, server.base), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString(), redirect: 'manual', signal: AbortSignal.timeout(15000) })
    return { status: r.status, html: await r.text(), location: r.headers.get('location') }
  }
  f.anon = async (path) => { const r = await fetch(new URL(path, server.base), { redirect: 'manual', signal: AbortSignal.timeout(15000) }); return { status: r.status, html: await r.text(), location: r.headers.get('location') } }
  f.pay = (id) => f.mutate((s) => { s.sessions[id].status = 'complete'; s.sessions[id].payment_status = 'paid' })
  f.lastSession = () => { const s = f.state(); return s.posts.at(-1) }
  f.returnUrl = (post) => post.success.replace('{CHECKOUT_SESSION_ID}', post.id)
  await f.ok('/api/settings', { payment_provider: 'stripe', stripe_secret: 'sk_live_store_fixture', stripe_webhook_secret: f.hookSecret, currency: 'USD', tax_rate: 8.25 }, 'PUT')
  const setup = await f.ok('/api/payments/setup', undefined, 'GET'); f.hookPath = new URL(setup.stripe_webhook_url).pathname
  f.hook = async (type, id) => {
    const body = JSON.stringify({ type, data: { object: { id } } }), time = Math.floor(Date.now() / 1000)
    const r = await fetch(server.base + f.hookPath, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${time},v1=${createHmac('sha256', f.hookSecret).update(time + '.' + body).digest('hex')}` }, body, signal: AbortSignal.timeout(15000) })
    return { status: r.status, text: await r.text() }
  }
  f.order = (id) => db.prepare('SELECT * FROM store_orders WHERE id=?').get(id)
  f.coach = await f.ok('/api/contacts', { name: 'Coach Paystore', company: 'Hawks FC', email: 'coach-pay@example.test' })
  f.products = [{ name: 'Team tee', price: 15, sizes: ['S', 'M', 'L'] }, { name: 'Hoodie', price: 35, sizes: ['M', 'L'] }]
  f.store = async (extra = {}) => {
    const s = await f.ok('/api/stores', { name: 'Hawks Gear ' + Math.random().toString(36).slice(2, 7), contact_id: f.coach.id, close_date: '2099-12-31', products: f.products, ...extra })
    return { ...s, path: s.share_url.slice(server.base.length), orderPath: s.share_url.slice(server.base.length).replace('?', '/order?') }
  }
  // A member's order through the public form. Returns the saved order id and where the page sent them.
  f.place = async (store, who, lines) => {
    const before = db.prepare('SELECT COALESCE(MAX(id),0) AS n FROM store_orders').get().n
    const r = await f.form(store.orderPath, { name: who, email: `${who.toLowerCase().replace(/\W+/g, '.')}@example.test`, ...lines })
    const row = db.prepare('SELECT * FROM store_orders WHERE id>? ORDER BY id DESC LIMIT 1').get(before)
    return { ...r, id: row?.id, row }
  }
  return f
}

test('team store payment: pay at checkout, pay later, refunds, and the money reaching one invoice exactly once', { timeout: 240000 }, async (t) => {
  const f = await fixture(t)
  const { db } = f

  await t.test('the switch is off by default and a store without it behaves exactly as before', async () => {
    const store = await f.store()
    assert.equal(store.take_payment, false); assert.equal(store.payments_ready, true)
    const [tee] = store.products
    const page = await f.anon(store.path)
    assert.match(page.html, /Place order/); assert.match(page.html, /No payment now/); assert.ok(!page.html.includes('Continue to payment'))
    const before = f.state().posts.length
    const placed = await f.place(store, 'Free Fiona', { [`q_${tee.id}_M`]: '2' })
    assert.equal(placed.status, 200); assert.match(placed.html, /Your order is in/); assert.match(placed.html, /No payment now/)
    assert.equal(placed.row.total, 30); assert.equal(placed.row.tax, null, 'an order that is not being charged is not taxed')
    assert.equal(f.state().posts.length, before, 'no checkout was opened')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payment_attempts WHERE store_order_id=?').get(placed.id).n, 0)
  })

  await t.test('a store cannot take payment when no processor is connected, and only a manager decides', async () => {
    await f.ok('/api/settings', { payment_provider: 'off' }, 'PUT')
    const refused = await f.request('/api/stores', { method: 'POST', body: { name: 'No processor', contact_id: f.coach.id, products: f.products, take_payment: true } })
    assert.equal(refused.status, 400); assert.match(refused.data.error, /Connect Stripe or Authorize\.net/)
    const off = await f.store()
    assert.equal(off.payments_ready, false)
    assert.equal((await f.request(`/api/stores/${off.id}`, { method: 'PUT', body: { take_payment: 'yes' } })).status, 400)
    await f.ok('/api/settings', { payment_provider: 'stripe' }, 'PUT')
  })

  let store, tee, hoodie
  await t.test('pay at order: saved first, charged the taxed total once, paid once on a replayed return and webhook', async () => {
    store = await f.store({ take_payment: true }); [tee, hoodie] = store.products
    assert.equal(store.take_payment, true); assert.equal(store.tax_rate, 8.25)
    const page = await f.anon(store.path)
    assert.match(page.html, /Continue to payment/); assert.match(page.html, /secure Stripe checkout/); assert.ok(!page.html.includes('No payment now'))
    const placed = await f.place(store, 'Paid Pat', { [`q_${tee.id}_M`]: '2', [`q_${hoodie.id}_L`]: '1' })
    assert.equal(placed.status, 303, placed.html); assert.match(placed.location, /^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_store_/)
    assert.equal(placed.row.total, 65); assert.equal(placed.row.tax, 5.36); assert.equal(placed.row.paid_at, null, 'saved before any money moved')
    const post = f.lastSession(), session = f.state().sessions[post.id]
    assert.equal(session.amount_total, 7036, 'the card is charged store price plus tax'); assert.equal(session.currency, 'usd')
    assert.equal(session.metadata.store_order, String(placed.id)); assert.equal(session.metadata.kind, 'store_order'); assert.equal(session.metadata.slug, f.slug)
    assert.equal(session.metadata.invoice, undefined); assert.equal(session.metadata.estimate, undefined)

    // Back from the card page before paying: nothing is recorded and the page offers to finish.
    const early = await f.anon(new URL(f.returnUrl(post)).pathname + new URL(f.returnUrl(post)).search)
    assert.equal(early.status, 303); const status = await f.anon(early.location)
    assert.equal(status.status, 200); assert.match(status.html, /payment is not finished/); assert.match(status.html, /Pay \$70\.36/)
    assert.equal(f.order(placed.id).paid_at, null)

    f.pay(post.id)
    assert.equal((await f.hook('checkout.session.completed', post.id)).status, 200, f.log())
    let o = f.order(placed.id)
    assert.ok(o.paid_at); assert.equal(o.paid_cents, 7036); assert.equal(o.pay_review, null)
    // Replays: the signed callback again, and the member's return URL twice.
    assert.equal((await f.hook('checkout.session.completed', post.id)).status, 200)
    for (let n = 0; n < 2; n++) { const r = await f.anon(new URL(f.returnUrl(post)).pathname + new URL(f.returnUrl(post)).search); assert.equal(r.status, 303) }
    o = f.order(placed.id); assert.equal(o.paid_cents, 7036, 'counted once')
    const attempts = db.prepare('SELECT * FROM payment_attempts WHERE store_order_id=?').all(placed.id)
    assert.equal(attempts.length, 1); assert.equal(attempts[0].status, 'paid'); assert.equal(attempts[0].invoice_id, null); assert.equal(attempts[0].kind, 'store_order')
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM payment_collection_receipts WHERE reference=? AND state='applied'").get(attempts[0].reference).n, 1)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM payments WHERE stripe_session LIKE 'cs_store_%'").get().n, 0, 'no invoice payment exists yet')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE title LIKE ?').get('%Hawks Gear%').n, 0, 'a paid member order does not open a job')
    const paidPage = await f.anon((await f.anon(new URL(f.returnUrl(post)).pathname + new URL(f.returnUrl(post)).search)).location)
    assert.match(paidPage.html, /Paid — thanks, Paid Pat/); assert.ok(!paidPage.html.includes('class="ms-pay"'), 'a paid order offers no pay button')
    // …and pressing Pay on a paid order goes nowhere near the processor.
    const posts = f.state().posts.length
    const payUrl = (await f.ok(`/api/stores/${store.id}`, undefined, 'GET')).orders.find((x) => x.id === placed.id).pay_url
    const again = await f.form(payUrl.slice(f.base.length).replace(`/order/${placed.id}?`, `/order/${placed.id}/pay?`))
    assert.equal(again.status, 303); assert.equal(f.state().posts.length, posts)
  })

  let later
  await t.test('abandoned, then paid later from the order link; a second checkout while one is open reuses it', async () => {
    later = await f.place(store, 'Later Lee', { [`q_${tee.id}_S`]: '1' })
    assert.equal(later.status, 303); assert.equal(later.row.tax, 1.24)
    const first = f.lastSession()
    const view = await f.ok(`/api/stores/${store.id}`, undefined, 'GET')
    const mine = view.orders.find((x) => x.id === later.id)
    assert.equal(mine.paid, false); assert.equal(mine.due, 16.24)
    assert.equal(view.payment.collected, 70.36); assert.equal(view.payment.outstanding, 16.24); assert.equal(view.payment.paid_orders, 1)
    const payPath = mine.pay_url.slice(f.base.length)
    assert.equal((await f.anon(payPath.replace(/t=[0-9a-f]+/, 't=0000000000000000'))).status, 404, 'a guessed token opens nothing')
    assert.equal((await f.anon(payPath.replace(`s=${f.slug}`, 's=nobody'))).status, 404, 'another shop slug opens nothing')
    const status = await f.anon(payPath)
    assert.match(status.html, /Pay \$16\.24/)
    // Press Pay twice while the first checkout is still open: the same checkout, not a second charge.
    const posts = f.state().posts.length
    const a = await f.form(payPath.replace(`/order/${later.id}?`, `/order/${later.id}/pay?`))
    const b = await f.form(payPath.replace(`/order/${later.id}?`, `/order/${later.id}/pay?`))
    assert.equal(a.status, 303); assert.equal(a.location, b.location); assert.match(a.location, new RegExp(first.id + '$'))
    assert.equal(f.state().posts.length, posts, 'no second checkout session was created')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payment_attempts WHERE store_order_id=?').get(later.id).n, 1)
    assert.equal(f.order(later.id).paid_at, null)
    // The provider expires the abandoned checkout; the next Pay opens a fresh one.
    f.mutate((s) => { s.sessions[first.id].status = 'expired' })
    const fresh = await f.form(payPath.replace(`/order/${later.id}?`, `/order/${later.id}/pay?`))
    assert.equal(fresh.status, 303, fresh.html); const second = f.lastSession()
    assert.notEqual(second.id, first.id); assert.match(fresh.location, new RegExp(second.id + '$'))
    f.pay(second.id)
    const back = await f.anon(new URL(f.returnUrl(second)).pathname + new URL(f.returnUrl(second)).search)
    assert.equal(back.status, 303)
    assert.equal(f.order(later.id).paid_cents, 1624)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM payment_attempts WHERE store_order_id=? AND status='paid'").get(later.id).n, 1)
  })

  await t.test('a session for another amount, account or shop is refused and records nothing', async () => {
    const victim = await f.place(store, 'Mismatch Mo', { [`q_${tee.id}_L`]: '1' })
    const post = f.lastSession()
    // The provider reports a different amount than the reserved checkout.
    f.mutate((s) => { s.sessions[post.id].amount_total = 100; s.sessions[post.id].status = 'complete'; s.sessions[post.id].payment_status = 'paid' })
    await f.hook('checkout.session.completed', post.id)
    assert.equal(f.order(victim.id).paid_at, null, 'a wrong amount never marks the order paid')
    assert.equal(db.prepare("SELECT state FROM payment_collection_receipts WHERE transaction_id=?").get(post.id).state, 'review', 'the money is held for review, not lost')
    // Another shop's slug on the session.
    const other = await f.place(store, 'Foreign Fay', { [`q_${tee.id}_L`]: '1' })
    const p2 = f.lastSession()
    f.mutate((s) => { s.sessions[p2.id].metadata.slug = 'another-shop'; s.sessions[p2.id].status = 'complete'; s.sessions[p2.id].payment_status = 'paid' })
    await f.hook('checkout.session.completed', p2.id)
    assert.equal(f.order(other.id).paid_at, null)
    // A different currency.
    const cur = await f.place(store, 'Currency Cy', { [`q_${tee.id}_L`]: '1' })
    const p3 = f.lastSession()
    f.mutate((s) => { s.sessions[p3.id].currency = 'cad'; s.sessions[p3.id].status = 'complete'; s.sessions[p3.id].payment_status = 'paid' })
    await f.hook('checkout.session.completed', p3.id)
    assert.equal(f.order(cur.id).paid_at, null)
    // Those three orders stay on the store as unpaid; the shop removes two and keeps one unpaid.
    for (const id of [victim.id, other.id]) db.prepare('DELETE FROM store_orders WHERE id=?').run(id)
    db.prepare("UPDATE payment_collections SET closed_at=COALESCE(closed_at,'2020-01-01 00:00:00') WHERE reference IN (SELECT reference FROM payment_attempts WHERE store_order_id=?)").run(cur.id)
  })

  await t.test('a paid order cannot be removed, and a store with unposted money cannot be deleted', async () => {
    const paid = db.prepare('SELECT id FROM store_orders WHERE store_id=? AND paid_cents>0 ORDER BY id LIMIT 1').get(store.id)
    const r = await f.request(`/api/stores/${store.id}/orders/${paid.id}`, { method: 'DELETE' })
    assert.equal(r.status, 409); assert.equal(r.data.code, 'order_paid')
    const d = await f.request(`/api/stores/${store.id}`, { method: 'DELETE' })
    assert.equal(d.status, 409); assert.equal(d.data.code, 'store_has_payments')
  })

  let invoiceId, estimateId
  await t.test('roll-up: one estimate bills what the orders add up to, and its invoice shows the prepaid money exactly once', async () => {
    const rolled = await f.ok(`/api/stores/${store.id}/estimate`, {})
    estimateId = rolled.estimate_id
    const orders = db.prepare('SELECT * FROM store_orders WHERE store_id=? ORDER BY id').all(store.id)
    assert.equal(orders.length, 3, 'two paid, one unpaid')
    assert.ok(orders.every((o) => o.tax != null), 'every order is taxed once any is')
    const owed = Math.round(orders.reduce((n, o) => n + o.total + o.tax, 0) * 100) / 100
    assert.equal(rolled.total, owed, 'the estimate bills exactly what members were (or will be) charged')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE estimate_id=?').get(estimateId).n, 0)
    const est = await f.ok(`/api/estimates/${estimateId}`, undefined, 'GET')
    const converted = await f.ok(`/api/estimates/${estimateId}/convert`, { commercial_revision: est.commercial_revision })
    invoiceId = converted.invoice_id
    const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(invoiceId)
    assert.equal(inv.amount_due, owed); assert.equal(inv.amount_paid, 86.6, 'both prepaid orders: 70.36 + 16.24'); assert.equal(inv.status, 'partial')
    const unpaid = orders.find((o) => !o.paid_at)
    assert.equal(Math.round((inv.amount_due - inv.amount_paid) * 100) / 100, Math.round((unpaid.total + unpaid.tax) * 100) / 100, 'the balance is the unpaid order')
    const rows = db.prepare('SELECT * FROM payments WHERE invoice_id=? ORDER BY id').all(invoiceId)
    assert.equal(rows.length, 2); assert.deepEqual(rows.map((r) => r.amount), [70.36, 16.24]); assert.ok(rows.every((r) => /Team store order #\d+ — .+ paid online \(Stripe\)/.test(r.note)))
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE estimate_id=?').get(estimateId).n, 1, 'ONE job for the store')
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM payment_attempts WHERE store_order_id IS NOT NULL AND status='paid' AND invoice_id=?").get(invoiceId).n, 2)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM store_orders WHERE store_id=? AND applied_invoice_id=?').get(store.id, invoiceId).n, 2)
    // Replays after posting change nothing.
    for (const a of db.prepare("SELECT session_id FROM payment_attempts WHERE invoice_id=? AND status='paid'").all(invoiceId)) assert.equal((await f.hook('checkout.session.completed', a.session_id)).status, 200)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payments WHERE invoice_id=?').get(invoiceId).n, 2)
    assert.equal(db.prepare('SELECT amount_paid FROM invoices WHERE id=?').get(invoiceId).amount_paid, 86.6)
    const view = await f.ok(`/api/stores/${store.id}`, undefined, 'GET')
    assert.equal(view.payment.collected, 86.6); assert.equal(view.estimate_id, estimateId)
  })

  await t.test('a store that has been rolled up takes no more orders or payments', async () => {
    const r = await f.form(store.orderPath, { name: 'Too Late', email: 'late@example.test', [`q_${tee.id}_M`]: '1' })
    assert.equal(r.status, 400); assert.match(r.html, /This store is closed/)
    const unpaid = db.prepare('SELECT * FROM store_orders WHERE store_id=? AND paid_at IS NULL').get(store.id)
    const view = await f.ok(`/api/stores/${store.id}`, undefined, 'GET')
    const payPath = view.orders.find((o) => o.id === unpaid.id).pay_url.slice(f.base.length)
    const page = await f.anon(payPath)
    assert.match(page.html, /This store has closed/); assert.ok(!page.html.includes('class="ms-pay"'))
    const posts = f.state().posts.length
    const pressed = await f.form(payPath.replace(`/order/${unpaid.id}?`, `/order/${unpaid.id}/pay?`))
    assert.equal(pressed.status, 303); assert.equal(f.state().posts.length, posts, 'no checkout opens on a closed store')
  })

  await t.test('a refund after posting follows the invoice path; a refund before posting flags the order and the store', async () => {
    // After posting: the ordinary reversal lands on the invoice.
    const posted = db.prepare("SELECT * FROM payment_attempts WHERE invoice_id=? AND status='paid' ORDER BY paid_at LIMIT 1").get(invoiceId)
    const pi = f.state().sessions[posted.session_id].payment_intent
    f.mutate((s) => { s.refunds.re_store_posted = { id: 're_store_posted', object: 'refund', payment_intent: pi, amount: posted.amount_cents, currency: 'usd', status: 'succeeded' } })
    assert.equal((await f.hook('refund.updated', 're_store_posted')).status, 200, f.log())
    const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(invoiceId)
    assert.equal(inv.amount_paid, Math.round((86.6 - posted.amount_cents / 100) * 100) / 100); assert.match(inv.payment_review, /refund/i)

    // Before posting: a fresh store, one paid order, refunded before any estimate exists.
    const s2 = await f.store({ take_payment: true })
    const placed = await f.place(s2, 'Refund Rae', { [`q_${s2.products[0].id}_M`]: '2' })
    const post = f.lastSession(); f.pay(post.id)
    assert.equal((await f.hook('checkout.session.completed', post.id)).status, 200)
    assert.equal(f.order(placed.id).paid_cents, 3248)
    f.mutate((s) => { s.refunds.re_store_early = { id: 're_store_early', object: 'refund', payment_intent: s.sessions[post.id].payment_intent, amount: 3248, currency: 'usd', status: 'succeeded' } })
    assert.equal((await f.hook('refund.updated', 're_store_early')).status, 200, f.log())
    assert.equal((await f.hook('refund.updated', 're_store_early')).status, 200, 'replayed')
    const o = f.order(placed.id)
    assert.equal(o.refunded_cents, 3248); assert.match(o.pay_review, /Stripe refund re_store_early is succeeded/)
    const view = await f.ok(`/api/stores/${s2.id}`, undefined, 'GET')
    assert.equal(view.payment.needs_review, 1); assert.equal(view.payment.collected, 0)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM payment_reversals WHERE provider_id='re_store_early'").get().n, 1)
    const page = await f.anon(view.orders[0].pay_url.slice(f.base.length))
    assert.match(page.html, /Payment updated/); assert.ok(!page.html.includes('class="ms-pay"'), 'a refunded order is not offered for payment again')
    // Rolled up and invoiced, the invoice carries both the payment and its refund, and is held for review.
    const rolled = await f.ok(`/api/stores/${s2.id}/estimate`, {})
    const est = await f.ok(`/api/estimates/${rolled.estimate_id}`, undefined, 'GET')
    const conv = await f.ok(`/api/estimates/${rolled.estimate_id}/convert`, { commercial_revision: est.commercial_revision })
    const inv2 = db.prepare('SELECT * FROM invoices WHERE id=?').get(conv.invoice_id)
    assert.equal(inv2.amount_paid, 0); assert.equal(inv2.amount_due, 32.48); assert.match(inv2.payment_review, /refunded at Stripe/)
    assert.deepEqual(db.prepare('SELECT amount FROM payments WHERE invoice_id=? ORDER BY id').all(conv.invoice_id).map((r) => r.amount), [32.48, -32.48])
  })

  await t.test('a member who pays after the invoice exists is posted to it straight away', async () => {
    const s3 = await f.store({ take_payment: true })
    const placed = await f.place(s3, 'Slow Sam', { [`q_${s3.products[0].id}_M`]: '1' })
    const post = f.lastSession()
    const rolled = await f.ok(`/api/stores/${s3.id}/estimate`, {})
    const est = await f.ok(`/api/estimates/${rolled.estimate_id}`, undefined, 'GET')
    const conv = await f.ok(`/api/estimates/${rolled.estimate_id}/convert`, { commercial_revision: est.commercial_revision })
    assert.equal(db.prepare('SELECT amount_paid FROM invoices WHERE id=?').get(conv.invoice_id).amount_paid, 0)
    // The checkout opened before the store closed is completed afterwards.
    f.pay(post.id)
    assert.equal((await f.hook('checkout.session.completed', post.id)).status, 200, f.log())
    const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(conv.invoice_id)
    assert.equal(inv.amount_paid, 16.24); assert.equal(inv.status, 'paid')
    assert.equal(f.order(placed.id).applied_invoice_id, conv.invoice_id)
    assert.equal((await f.hook('checkout.session.completed', post.id)).status, 200)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payments WHERE invoice_id=?').get(conv.invoice_id).n, 1)
  })

  await t.test('test-mode keys take no real money, and a tax-exempt customer is charged no tax', async () => {
    await f.ok('/api/settings', { stripe_secret: 'sk_test_store_fixture' }, 'PUT')
    const s4 = await f.store({ take_payment: true })
    const placed = await f.place(s4, 'Test Tia', { [`q_${s4.products[0].id}_M`]: '1' })
    const post = f.lastSession(); f.pay(post.id)
    await f.hook('checkout.session.completed', post.id)
    assert.equal(f.order(placed.id).paid_at, null, 'a test payment never marks an order paid')
    const view = await f.ok(`/api/stores/${s4.id}`, undefined, 'GET')
    assert.match((await f.anon(view.orders[0].pay_url.slice(f.base.length))).html, /Test payment complete/)
    await f.ok('/api/settings', { stripe_secret: 'sk_live_store_fixture' }, 'PUT')
    const exempt = await f.ok('/api/contacts', { name: 'Exempt School', email: 'exempt-school@example.test', tax_exempt: true, tax_exempt_id: 'EX-1' })
    const s5 = await f.ok('/api/stores', { name: 'Exempt store', contact_id: exempt.id, products: f.products, take_payment: true })
    assert.equal(s5.tax_rate, 0)
    const p5 = s5.share_url.slice(f.base.length)
    const r = await f.form(p5.replace('?', '/order?'), { name: 'No Tax Ned', email: 'ned@example.test', [`q_${s5.products[0].id}_M`]: '2' })
    assert.equal(r.status, 303)
    assert.equal(f.state().sessions[f.lastSession().id].amount_total, 3000)
  })
})
