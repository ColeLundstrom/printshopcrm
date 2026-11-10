/**
 * Merch stores: an online team / group store the shop opens for ONE customer.
 *
 * The coach (or the office manager) gets one link and shares it with the team. Every member opens
 * it, picks their item, size and quantity, types their name and email, and presses Place order.
 * Nobody signs in. When the store closes the shop presses "Turn into estimate" and gets ONE
 * estimate for the customer the store was opened for, with each product's size run already summed
 * — the same garment-line shape POST /api/estimates writes, so the editor, PDF, /p/estimate and
 * conversion to an invoice all treat it like any other quote.
 *
 * Payment (1.40): a store can take payment when members order. It is a per-store switch, off by
 * default, and only offered when the shop's own processor is connected — the money goes straight to
 * the shop's Stripe or Authorize.net account through the same durable checkout every invoice uses
 * (lib/payment-collections.mjs). An order is saved first and paid second, so a checkout that fails
 * or is abandoned is never a lost order; the member can pay later from the order's own link.
 *
 * What a member is charged is exactly what the store's estimate will bill for that order: the
 * store price plus sales tax at the rate of the customer the store was opened for, as shown on the
 * order page. Where per-order rounding leaves the orders a cent or two off the tax on the summed
 * goods, the estimate carries that difference as a stated "Sales tax adjustment" line.
 *
 * The money reaches the books when the store's ONE estimate becomes an invoice: every prepaid order
 * is posted to that invoice as its own payment row (applyPrepayments), once, and the invoice's
 * balance is whatever the members who have not paid still owe. Until then the store screen shows
 * who has paid, what was collected and what is outstanding. A paid member order never opens a
 * production job — production starts from the store's single estimate.
 *
 * Tenant safety: the public key is random (96 bits) and lives in the shop's OWN database. A public
 * link resolves its shop through ?s=<slug> exactly like the /p/ links (pPage), so the key is only
 * ever looked up inside the shop named in the link; replaying it with another shop's ?s= finds
 * nothing. On a multi-tenant install a link with no shop context is refused rather than read from
 * the default database.
 */
import crypto from 'node:crypto'
import express from 'express'
import {
  all, get, run, getDb, tenantStore, getSettings, getUpcharges, computeTotals, nextEstimateNumber, freezeUpcharges,
  logActivity, taxRateFor, shopFormat, todayIso, now, SIZES, tx, roundMoney, moneyDigits, syncInvoiceStatus,
} from './db.mjs'
import { estimateTermsIn } from './estimate-approvals.mjs'
import { postalDefaults } from './addresses.mjs'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS merch_stores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  message TEXT NOT NULL DEFAULT '',
  close_date TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  products TEXT NOT NULL DEFAULT '[]',
  estimate_id INTEGER,
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS store_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER NOT NULL REFERENCES merch_stores(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  items TEXT NOT NULL DEFAULT '[]',
  total REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS store_orders_store ON store_orders(store_id);
CREATE INDEX IF NOT EXISTS merch_stores_contact ON merch_stores(contact_id);
-- A deleted estimate must let go of its store: the bare integer survived the delete and, when the
-- row id was reused, attached the store to the next customer's quote.
CREATE TRIGGER IF NOT EXISTS trg_merch_store_estimate_delete AFTER DELETE ON estimates
  BEGIN UPDATE merch_stores SET estimate_id = NULL WHERE estimate_id = OLD.id; END;`
// Added in 1.40 for payment at checkout. `tax` is NULL until an order has been taxed (orders placed
// while the store took no payment are taxed when they are paid, or when the estimate is made).
const COLUMNS = [
  ['merch_stores', 'take_payment', 'INTEGER NOT NULL DEFAULT 0'],
  ['store_orders', 'tax', 'REAL'],
  ['store_orders', 'paid_at', 'TEXT'],
  ['store_orders', 'paid_cents', 'INTEGER NOT NULL DEFAULT 0'],
  ['store_orders', 'refunded_cents', 'INTEGER NOT NULL DEFAULT 0'],
  ['store_orders', 'pay_review', 'TEXT'],
  ['store_orders', 'applied_invoice_id', 'INTEGER'],
]
const ready = new WeakSet()
const ensure = () => {
  const d = getDb()
  if (ready.has(d)) return
  d.exec(SCHEMA)
  for (const [table, col, decl] of COLUMNS) {
    if (!d.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`)
  }
  ready.add(d)
}
const cents = (n) => Math.round((Number(n) || 0) * 100)

export const STORE_LIMITS = { products: 30, items: 50, qtyMin: 1, qtyMax: 500, price: 10000, name: 120, message: 2000, note: 300 }
const KEY_RE = /^[A-Za-z0-9_-]{16,40}$/
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const parse = (s, d) => { try { return JSON.parse(s) } catch { return d } }
const text = (v, max) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, max) : '')
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100
const bad = (res, error, code = 'invalid', status = 400) => res.status(status).json({ error, code })

/** A store is open for orders when it is marked open and its close date (inclusive) has not passed. */
export const storeIsOpen = (s, today = todayIso()) => s.status === 'open' && (!s.close_date || s.close_date >= today)

/**
 * Validate the product list a manager sent. Throws an Error with a customer-readable message.
 * Product ids are kept when given (so orders already placed keep pointing at their product after an
 * edit) and minted otherwise.
 */
export function cleanProducts(raw) {
  if (!Array.isArray(raw)) throw new Error('Products must be a list.')
  if (!raw.length) throw new Error('Add at least one product.')
  if (raw.length > STORE_LIMITS.products) throw new Error(`A store can carry at most ${STORE_LIMITS.products} products.`)
  const seen = new Set()
  return raw.map((p, i) => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error(`Product ${i + 1} is not a product.`)
    const name = text(p.name, STORE_LIMITS.name)
    if (!name) throw new Error(`Product ${i + 1} needs a name.`)
    const price = typeof p.price === 'number' ? p.price : (typeof p.price === 'string' && p.price.trim() !== '' ? Number(p.price) : NaN)
    if (!Number.isFinite(price) || price < 0 || price > STORE_LIMITS.price) throw new Error(`${name}: price must be an amount from 0 to ${STORE_LIMITS.price}.`)
    if (!Array.isArray(p.sizes) || !p.sizes.length) throw new Error(`${name}: tick at least one size.`)
    const want = new Set(p.sizes.map((s) => String(s).trim().toUpperCase()))
    for (const s of want) if (!SIZES.includes(s)) throw new Error(`${name}: "${String(s).slice(0, 12)}" is not a size.`)
    const sizes = SIZES.filter((s) => want.has(s))
    let image_url = text(p.image_url, 500)
    if (image_url && !/^https:\/\/[^\s"'<>]+$/i.test(image_url)) throw new Error(`${name}: the picture must be an https:// link.`)
    let id = typeof p.id === 'string' && /^[a-z0-9]{4,16}$/.test(p.id) ? p.id : ''
    if (!id || seen.has(id)) id = crypto.randomBytes(4).toString('hex')
    seen.add(id)
    return { id, name, description: text(p.description, 500), price: round2(price), sizes, image_url }
  })
}

/** Orders folded into product × size totals, in the store's product and size order. */
export function storeSummary(store, orders) {
  const products = parse(store.products, [])
  const byId = new Map(products.map((p) => [p.id, { id: p.id, name: p.name, price: p.price, sizes: {}, units: 0, total: 0 }]))
  let units = 0, total = 0
  for (const o of orders) {
    for (const it of parse(o.items, [])) {
      let row = byId.get(it.product_id)
      // A product removed after people ordered it still has to be made: keep it under its old name.
      if (!row) { row = { id: it.product_id, name: it.name, price: it.price, sizes: {}, units: 0, total: 0 }; byId.set(it.product_id, row) }
      row.sizes[it.size] = (row.sizes[it.size] || 0) + it.qty
      row.units += it.qty
      row.total = round2(row.total + it.qty * it.price)
      units += it.qty
      total = round2(total + it.qty * it.price)
    }
  }
  const rows = [...byId.values()].filter((r) => r.units > 0)
  for (const r of rows) r.sizes = Object.fromEntries(SIZES.filter((s) => r.sizes[s]).map((s) => [s, r.sizes[s]]).concat(Object.entries(r.sizes).filter(([s]) => !SIZES.includes(s))))
  return { products: rows, units, total, orders: orders.length }
}

/**
 * Parse an order body: JSON {name,email,note,items:[{product_id,size,qty}]} or the public form's
 * urlencoded q_<productId>_<size>=<qty> fields. Returns { order } or { error }.
 */
export function readOrder(store, body) {
  const b = body && typeof body === 'object' ? body : {}
  const products = parse(store.products, [])
  const byId = new Map(products.map((p) => [p.id, p]))
  const raw = []
  if (Array.isArray(b.items)) {
    for (const it of b.items) raw.push({ product_id: it?.product_id, size: it?.size, qty: it?.qty, strict: true })
  } else if (b.items !== undefined) return { error: 'items must be a list.' }
  for (const [k, v] of Object.entries(b)) {
    const m = /^q_([a-z0-9]{4,16})_([0-9A-Z]{1,6})$/.exec(k)
    if (!m) continue
    if (String(v ?? '').trim() === '' || Number(v) === 0) continue // a box left at 0 is not an order line
    raw.push({ product_id: m[1], size: m[2], qty: v, strict: true })
  }
  if (raw.length > STORE_LIMITS.items) return { error: `An order can have at most ${STORE_LIMITS.items} lines.` }
  const merged = new Map()
  for (const r of raw) {
    const p = byId.get(String(r.product_id ?? ''))
    if (!p) return { error: 'One of those items is not in this store.' }
    const size = String(r.size ?? '').trim().toUpperCase()
    if (!p.sizes.includes(size)) return { error: `${p.name} does not come in size ${size.slice(0, 8) || '(none)'}.` }
    const qty = typeof r.qty === 'number' ? r.qty : (typeof r.qty === 'string' && /^\s*\d+\s*$/.test(r.qty) ? Number(r.qty) : NaN)
    if (!Number.isInteger(qty) || qty < STORE_LIMITS.qtyMin || qty > STORE_LIMITS.qtyMax) return { error: `Quantity for ${p.name} (${size}) must be a whole number from ${STORE_LIMITS.qtyMin} to ${STORE_LIMITS.qtyMax}.` }
    const key = `${p.id}|${size}`
    const prev = merged.get(key)
    const total = (prev?.qty || 0) + qty
    if (total > STORE_LIMITS.qtyMax) return { error: `Quantity for ${p.name} (${size}) must be at most ${STORE_LIMITS.qtyMax}.` }
    merged.set(key, { product_id: p.id, name: p.name, size, qty: total, price: p.price })
  }
  const items = [...merged.values()]
  const name = text(b.name, STORE_LIMITS.name)
  const email = text(b.email, 254)
  const note = text(b.note, STORE_LIMITS.note)
  if (!name) return { error: 'Please type your name.' }
  if (!email || !EMAIL_RE.test(email)) return { error: 'Please type a valid email address.' }
  if (!items.length) return { error: 'Pick a size and quantity for at least one item.' }
  const total = round2(items.reduce((s, i) => s + i.qty * i.price, 0))
  return { order: { name, email, note, items, total } }
}

export function registerMerchRoutes(app, { pPage, page, esc, logoImg, joinDot, publicOrigin, wrap, requireRole, orderLimit, authEnabled, syncPipeline, payments = null }) {
  const manager = requireRole('manager')
  const money = (n) => shopFormat().money(n)
  const slug = () => tenantStore.getStore()?.slug || ''
  const sharePath = (s) => `/store/${s.public_key}${slug() ? `?s=${encodeURIComponent(slug())}` : ''}`
  const day = (s) => {
    if (!s || !DATE_RE.test(String(s))) return ''
    try { return new Intl.DateTimeFormat(shopFormat().locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${s}T00:00:00Z`)) } catch { return String(s) }
  }
  /* ---------------- payment at checkout ---------------- */

  // The shop's own processor is connected and ready to take a card right now.
  const canCharge = () => { try { return !!payments?.ready(getSettings()) } catch { return false } }
  const storeRate = (st) => { try { return st.contact_id ? taxRateFor(st.contact_id) : Number(getSettings().tax_rate) || 0 } catch { return 0 } }
  const orderPath = (st, o) => `/store/${st.public_key}/order/${o.id}?t=${payments.token('storeorder', o.id)}${slug() ? `&s=${encodeURIComponent(slug())}` : ''}`
  const orderDue = (o) => roundMoney((Number(o.total) || 0) + (Number(o.tax) || 0))
  /**
   * Tax one order: the store price times the rate of the customer the store is for, rounded the
   * way the order page showed it to the member. What they saw is what they are charged. The
   * orders' tax can then differ from the estimate's tax on the summed goods by a cent or two; the
   * estimate states that difference as its own line (see POST /api/stores/:id/estimate).
   * Runs inside the caller's transaction.
   */
  const taxOrder = (st, o) => {
    if (o.tax != null) return o
    const tax = Math.max(0, roundMoney((Number(o.total) || 0) * storeRate(st) / 100))
    run('UPDATE store_orders SET tax = ? WHERE id = ?', tax, o.id)
    return { ...o, tax }
  }
  const orderView = (req, st, o) => ({
    ...o, items: parse(o.items, []), tax: o.tax ?? null, due: orderDue(o), paid: !!o.paid_at,
    paid_amount: round2((o.paid_cents || 0) / 100), refunded_amount: round2((o.refunded_cents || 0) / 100),
    ...(payments ? { pay_url: publicOrigin(req) + orderPath(st, o) } : {}),
  })
  const payTotals = (st) => {
    const a = get(`SELECT COALESCE(SUM(paid_cents - refunded_cents),0) AS paid, COUNT(paid_at) AS n_paid,
      COALESCE(SUM(CASE WHEN paid_at IS NULL THEN total + COALESCE(tax,0) ELSE 0 END),0) AS open,
      SUM(CASE WHEN pay_review IS NOT NULL THEN 1 ELSE 0 END) AS review FROM store_orders WHERE store_id = ?`, st.id)
    return { collected: round2((a.paid || 0) / 100), paid_orders: a.n_paid || 0, outstanding: round2(a.open || 0), needs_review: a.review || 0 }
  }
  /** Start (or resume) the hosted checkout for one order. Throws what startCheckout throws. */
  const beginCheckout = async (req, st, o) => {
    o = tx(() => taxOrder(st, get('SELECT * FROM store_orders WHERE id = ?', o.id)))
    const back = publicOrigin(req) + orderPath(st, o)
    const go = () => payments.startCheckout(getSettings(), {
      customerEmail: o.email || undefined,
      lineItems: [{ name: `${st.name} — order #${o.id} (${getSettings().shop_name})`.slice(0, 200), amountCents: cents(orderDue(o)), qty: 1 }],
      successUrl: back, cancelUrl: back,
      metadata: { store_order: String(o.id), kind: 'store_order' },
    })
    try { return await go() } catch (e) {
      // A checkout that expired at the provider is closed by the first look at it; the second
      // attempt then opens a fresh one. Anything else is the caller's to report.
      if (e?.code !== 'collection_review' || get('SELECT paid_at FROM store_orders WHERE id = ?', o.id)?.paid_at) throw e
      return go()
    }
  }

  /**
   * Post every prepaid, not-yet-posted order of the store behind this invoice to the invoice.
   * One payment row per order checkout, keyed by the provider's own id so it can never post
   * twice. Runs in the caller's transaction when there is one. Returns what it posted.
   */
  const applyPrepayments = (invoiceId, effects = []) => {
    const inv = get('SELECT * FROM invoices WHERE id = ?', Number(invoiceId) || 0)
    if (!inv?.estimate_id) return { applied: 0 }
    try { ensure() } catch { return { applied: 0 } }
    const st = get('SELECT * FROM merch_stores WHERE estimate_id = ?', inv.estimate_id)
    if (!st) return { applied: 0 }
    return tx(() => {
      let applied = 0, amount = 0, review = ''
      for (const o of all('SELECT * FROM store_orders WHERE store_id = ? AND paid_cents > 0 AND applied_invoice_id IS NULL ORDER BY id', st.id)) {
        for (const a of all("SELECT * FROM payment_attempts WHERE store_order_id = ? AND status = 'paid' AND invoice_id IS NULL AND is_test = 0 ORDER BY paid_at, reference", o.id)) {
          const label = a.provider === 'authorize_net' ? 'Authorize.net' : 'Stripe'
          const ledger = a.provider === 'authorize_net' ? `anet_${a.transaction_id}` : a.transaction_id
          if (!get('SELECT 1 FROM payments WHERE stripe_session = ?', ledger)) {
            run('INSERT INTO payments (invoice_id, amount, method, note, stripe_session, created_at) VALUES (?,?,?,?,?,?)',
              inv.id, round2(a.amount_cents / 100), 'card', `Team store order #${o.id} — ${o.name} paid online (${label})`, ledger, a.paid_at || now())
            amount += a.amount_cents
          }
          const back = get('SELECT COALESCE(SUM(applied_cents),0) AS n FROM payment_reversals WHERE attempt_ref = ? AND is_test = 0', a.reference).n
          if (back > 0 && !get('SELECT 1 FROM payments WHERE stripe_session = ?', `reversal:store:${a.reference}`)) {
            run('INSERT INTO payments (invoice_id, amount, method, note, stripe_session, created_at) VALUES (?,?,?,?,?,?)',
              inv.id, -round2(back / 100), 'card', `Team store order #${o.id} — ${o.name}: ${label} refund before invoicing`, `reversal:store:${a.reference}`, now())
            amount -= back
            review = `A team store payment on this invoice was refunded at ${label}. Review the balance before requesting more money.`
          }
          run('UPDATE payment_reversals SET invoice_id = ? WHERE attempt_ref = ? AND invoice_id IS NULL', inv.id, a.reference)
          run('UPDATE payment_attempts SET invoice_id = ? WHERE reference = ?', inv.id, a.reference)
          run('UPDATE payment_collection_receipts SET invoice_id = ? WHERE reference = ? AND invoice_id IS NULL', inv.id, a.reference)
        }
        if (o.pay_review) review = review || `Team store order #${o.id} needs payment review: ${o.pay_review}`
        run('UPDATE store_orders SET applied_invoice_id = ? WHERE id = ?', inv.id, o.id)
        applied++
      }
      if (!applied) return { applied: 0 }
      const fresh = syncInvoiceStatus(inv.id) || get('SELECT * FROM invoices WHERE id = ?', inv.id)
      const over = roundMoney((fresh.amount_paid || 0) - (fresh.amount_due || 0))
      if (over > 0.005) review = review || `Members prepaid ${money(over)} more than this invoice bills. Refund the difference or correct the invoice.`
      if (review || inv.status === 'void') run('UPDATE invoices SET payment_review = ? WHERE id = ? AND COALESCE(payment_review, \'\') = \'\'', review || 'Team store payments arrived on a voided invoice. Refund them at the processor.', inv.id)
      logActivity('payment', `${money(round2(amount / 100))} prepaid by ${applied} team store order${applied === 1 ? '' : 's'} posted to ${inv.invoice_number}`, { contact_id: inv.contact_id })
      try { payments?.invoicePaid?.(inv.id, effects) } catch (e) { console.error('store prepayment follow-up:', e.message) }
      return { applied, amount: round2(amount / 100), invoice_id: inv.id }
    })
  }

  /**
   * A verified payment for one order (called inside reconcileCheckout's transaction, after the
   * provider, account, amount and currency have been checked against the reserved checkout).
   * Records what ARRIVED. `extra` is a second, different payment against an order already paid.
   */
  const orderPaid = ({ attempt, session, extra, effects = [] }) => {
    ensure()
    const o = get('SELECT * FROM store_orders WHERE id = ?', attempt.store_order_id)
    if (!o) throw payments.collectionError('collection_changed')
    const st = get('SELECT * FROM merch_stores WHERE id = ?', o.store_id)
    let review = o.pay_review || null
    if (extra) review = 'A second payment arrived for this order. Refund one of them at the processor.'
    else if (session.amountCents !== cents(orderDue(o))) review = 'The amount paid differs from this order\'s total. Check the order before making the estimate.'
    run('UPDATE store_orders SET paid_at = COALESCE(paid_at, ?), paid_cents = paid_cents + ?, pay_review = ? WHERE id = ?', now(), session.amountCents, review, o.id)
    logActivity('payment', `${o.name} paid ${money(round2(session.amountCents / 100))} for team store “${st?.name || ''}” order #${o.id}${review ? ' — needs review' : ''}`, { contact_id: st?.contact_id || undefined })
    effects.push(() => payments.notify?.({ title: 'Team store order paid', body: `${o.name} · ${money(round2(session.amountCents / 100))} · ${st?.name || ''}` }))
    // The store's invoice already exists (a member finished paying after the estimate was
    // converted): the money goes straight onto it. completeAttempt has not run yet, so the caller
    // posts after it — see reconcileCheckout.
    const inv = st?.estimate_id ? get("SELECT id FROM invoices WHERE estimate_id = ? AND status != 'void' ORDER BY id DESC LIMIT 1", st.estimate_id) : null
    return { order_id: o.id, store_id: o.store_id, review, invoice_id: inv?.id || null }
  }

  /**
   * A verified refund or void of an order's payment that has NOT been posted to an invoice yet.
   * (Once posted, the attempt carries invoice_id and the ordinary invoice reversal path applies.)
   * The order and the store are flagged; nothing is silently dropped.
   */
  const orderReversal = ({ provider, id, kind, attempt, amountCents, status, appliedCents }) => {
    ensure()
    if (!['stripe', 'authorize_net'].includes(provider) || !/^[a-zA-Z0-9_-]{1,100}$/.test(String(id))) throw new Error('Invalid reversal identity')
    if (!['refund', 'void'].includes(kind) || !Number.isSafeInteger(amountCents) || amountCents <= 0 || !Number.isSafeInteger(appliedCents) || appliedCents < 0 || appliedCents > amountCents) throw new Error('Invalid reversal amount')
    if (amountCents > attempt.amount_cents) throw new Error('Reversal exceeds the original payment')
    const old = get('SELECT * FROM payment_reversals WHERE provider = ? AND provider_id = ?', provider, id)
    if (old && (old.attempt_ref !== attempt.reference || old.kind !== kind || old.amount_cents !== amountCents)) throw new Error('Reversal details changed; manual reconciliation required')
    if (old?.status === status && old.applied_cents === appliedCents) return { duplicate: true, store_order_id: attempt.store_order_id }
    const others = get('SELECT COALESCE(SUM(applied_cents),0) AS n FROM payment_reversals WHERE attempt_ref = ? AND NOT (provider = ? AND provider_id = ?)', attempt.reference, provider, id).n
    if (others + appliedCents > attempt.amount_cents) throw new Error('Combined reversals exceed the original payment')
    run(`INSERT INTO payment_reversals(provider,provider_id,kind,attempt_ref,invoice_id,amount_cents,status,applied_cents,is_test,revision,created_at,updated_at)
      VALUES (?,?,?,?,NULL,?,?,?,0,?,?,?) ON CONFLICT(provider,provider_id) DO UPDATE SET status=excluded.status,applied_cents=excluded.applied_cents,revision=excluded.revision,updated_at=excluded.updated_at`,
      provider, id, kind, attempt.reference, amountCents, status, appliedCents, (old?.revision || 0) + 1, now(), now())
    const o = get('SELECT * FROM store_orders WHERE id = ?', attempt.store_order_id)
    const label = provider === 'stripe' ? 'Stripe' : 'Authorize.net'
    if (o) {
      const back = get(`SELECT COALESCE(SUM(r.applied_cents),0) AS n FROM payment_reversals r JOIN payment_attempts a ON a.reference = r.attempt_ref WHERE a.store_order_id = ? AND r.is_test = 0`, o.id).n
      run('UPDATE store_orders SET refunded_cents = ?, pay_review = ? WHERE id = ?', back, `${label} ${kind} ${id} is ${status}: ${money(round2(appliedCents / 100))} returned. Decide whether this order still stands before making the estimate.`, o.id)
      const st = get('SELECT * FROM merch_stores WHERE id = ?', o.store_id)
      logActivity('payment', `${label} ${kind} on team store “${st?.name || ''}” order #${o.id} (${o.name}): ${status}, ${money(round2(appliedCents / 100))} returned — review the order`, { contact_id: st?.contact_id || undefined })
    }
    return { changed: true, store_order_id: attempt.store_order_id }
  }

  const view = (req, s, extra = {}) => {
    const c = s.contact_id ? get('SELECT id, name, company, email FROM contacts WHERE id = ?', s.contact_id) : null
    const agg = get('SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total FROM store_orders WHERE store_id = ?', s.id)
    return {
      take_payment: !!s.take_payment, payments_ready: canCharge(), payment: payTotals(s), tax_rate: storeRate(s),
      id: s.id, name: s.name, contact_id: s.contact_id, contact: c || null, message: s.message, close_date: s.close_date,
      status: s.status, is_open: storeIsOpen(s), products: parse(s.products, []), estimate_id: s.estimate_id && get('SELECT 1 FROM estimates WHERE id = ?', s.estimate_id) ? s.estimate_id : null,
      created_at: s.created_at, closed_at: s.closed_at, order_count: agg.n, order_total: round2(agg.total),
      share_url: publicOrigin(req) + sharePath(s), ...extra,
    }
  }
  const load = (req, res) => {
    ensure()
    const id = Number(req.params.id)
    const s = Number.isSafeInteger(id) && id > 0 ? get('SELECT * FROM merch_stores WHERE id = ?', id) : null
    if (!s) { bad(res, 'Store not found', 'not_found', 404); return null }
    return s
  }
  const fields = (b, current = {}) => {
    const out = {}
    if (b.name !== undefined || !current.id) {
      out.name = text(b.name, STORE_LIMITS.name)
      if (!out.name) throw new Error('Give the store a name.')
    }
    if (b.contact_id !== undefined || !current.id) {
      const cid = Number(b.contact_id)
      if (!Number.isSafeInteger(cid) || cid <= 0 || !get('SELECT 1 FROM contacts WHERE id = ?', cid)) throw new Error('Pick the customer this store is for.')
      out.contact_id = cid
    }
    if (b.message !== undefined) {
      if (b.message !== null && typeof b.message !== 'string') throw new Error('The message must be text.')
      out.message = String(b.message ?? '').trim().slice(0, STORE_LIMITS.message)
    }
    if (b.close_date !== undefined) {
      const d = b.close_date == null ? '' : String(b.close_date).trim()
      if (d && (!DATE_RE.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`)))) throw new Error('Close date must be a date.')
      out.close_date = d || null
    }
    if (b.products !== undefined || !current.id) out.products = JSON.stringify(cleanProducts(b.products))
    if (b.take_payment !== undefined) {
      if (typeof b.take_payment !== 'boolean') throw new Error('take_payment must be true or false.')
      // Only offerable when the shop's own processor can take a card. Switching it OFF is always allowed.
      if (b.take_payment && !canCharge()) throw new Error('Connect Stripe or Authorize.net in Payments before a store can take payment.')
      out.take_payment = b.take_payment ? 1 : 0
    }
    return out
  }

  /* ---------------- staff API ---------------- */

  app.get('/api/stores', wrap((req, res) => {
    ensure()
    res.json({ payments_ready: canCharge(), stores: all('SELECT * FROM merch_stores ORDER BY (status = \'open\') DESC, id DESC').map((s) => view(req, s)) })
  }))

  app.post('/api/stores', manager, wrap((req, res) => {
    ensure()
    let f
    try { f = fields(req.body || {}) } catch (e) { return bad(res, e.message) }
    const key = crypto.randomBytes(12).toString('base64url')
    const id = Number(run('INSERT INTO merch_stores (public_key, name, contact_id, message, close_date, products, take_payment, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      key, f.name, f.contact_id, f.message || '', f.close_date || null, f.products, f.take_payment || 0, now(), now()).lastInsertRowid)
    logActivity('store', `Team store “${f.name}” opened`, { contact_id: f.contact_id })
    res.json(view(req, get('SELECT * FROM merch_stores WHERE id = ?', id)))
  }))

  app.get('/api/stores/:id', wrap((req, res) => {
    const s = load(req, res); if (!s) return
    const orders = all('SELECT * FROM store_orders WHERE store_id = ? ORDER BY id DESC', s.id).map((o) => orderView(req, s, o))
    res.json(view(req, s, { orders, summary: storeSummary(s, orders.map((o) => ({ items: JSON.stringify(o.items) }))) }))
  }))

  app.get('/api/stores/:id/orders', wrap((req, res) => {
    const s = load(req, res); if (!s) return
    res.json({ orders: all('SELECT * FROM store_orders WHERE store_id = ? ORDER BY id DESC', s.id).map((o) => orderView(req, s, o)) })
  }))

  app.put('/api/stores/:id', manager, wrap((req, res) => {
    const s = load(req, res); if (!s) return
    const b = req.body || {}
    let f
    try { f = fields(b, s) } catch (e) { return bad(res, e.message) }
    if (b.status !== undefined) {
      if (!['open', 'closed'].includes(b.status)) return bad(res, 'Status must be open or closed.')
      f.status = b.status
      f.closed_at = b.status === 'closed' ? (s.closed_at || now()) : null
    }
    const keys = Object.keys(f)
    if (keys.length) run(`UPDATE merch_stores SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => f[k]), now(), s.id)
    res.json(view(req, get('SELECT * FROM merch_stores WHERE id = ?', s.id)))
  }))

  app.post('/api/stores/:id/close', manager, wrap((req, res) => {
    const s = load(req, res); if (!s) return
    if (s.status !== 'closed') {
      run("UPDATE merch_stores SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?", now(), now(), s.id)
      logActivity('store', `Team store “${s.name}” closed`, { contact_id: s.contact_id })
    }
    res.json(view(req, get('SELECT * FROM merch_stores WHERE id = ?', s.id)))
  }))

  app.delete('/api/stores/:id', manager, wrap((req, res) => {
    const s = load(req, res); if (!s) return
    // Money that has been taken and not yet put on an invoice exists nowhere else in the shop's
    // books. Deleting the store would orphan it.
    if (get('SELECT 1 FROM store_orders WHERE store_id = ? AND paid_cents > 0 AND applied_invoice_id IS NULL', s.id))
      return bad(res, 'Members have paid on this store. Make its estimate and invoice (or refund them) before deleting it.', 'store_has_payments', 409)
    run('DELETE FROM store_orders WHERE store_id = ?', s.id)
    run('DELETE FROM merch_stores WHERE id = ?', s.id)
    res.json({ ok: true })
  }))

  app.delete('/api/stores/:id/orders/:oid', manager, wrap((req, res) => {
    const s = load(req, res); if (!s) return
    const paidOrder = get('SELECT paid_cents, refunded_cents FROM store_orders WHERE id = ? AND store_id = ?', Number(req.params.oid) || 0, s.id)
    if (paidOrder && paidOrder.paid_cents - paidOrder.refunded_cents > 0) return bad(res, 'This order has been paid. Refund it at your payment processor first; then it can be removed.', 'order_paid', 409)
    if (paidOrder && get("SELECT 1 FROM payment_attempts a LEFT JOIN payment_collections c ON c.reference = a.reference WHERE a.store_order_id = ? AND ((c.reference IS NOT NULL AND c.closed_at IS NULL) OR (c.reference IS NULL AND a.status = 'pending'))", Number(req.params.oid)))
      return bad(res, 'A checkout is still open for this order. Wait for it to finish or expire before removing the order.', 'order_checkout_open', 409)
    const r = run('DELETE FROM store_orders WHERE id = ? AND store_id = ?', Number(req.params.oid) || 0, s.id)
    if (!r.changes) return bad(res, 'Order not found', 'not_found', 404)
    res.json({ ok: true })
  }))

  // ONE estimate for the store's customer: a garment line per product whose size grid is the sum of
  // every member's order. The store's per-piece price is what members were shown for every size, so
  // the line carries an empty upcharge table rather than the shop's 2XL+ table.
  app.post('/api/stores/:id/estimate', manager, wrap((req, res) => {
    const s = load(req, res); if (!s) return
    if (s.estimate_id && get('SELECT 1 FROM estimates WHERE id = ?', s.estimate_id)) return res.status(409).json({ error: 'This store already has an estimate.', code: 'already_estimated', estimate_id: s.estimate_id })
    const contact = s.contact_id ? get('SELECT * FROM contacts WHERE id = ?', s.contact_id) : null
    if (!contact) return bad(res, 'Pick the customer this store is for first — the one it was opened for has been deleted.', 'customer_not_found', 409)
    const orders = all('SELECT * FROM store_orders WHERE store_id = ? ORDER BY id', s.id)
    if (!orders.length) return bad(res, 'Nobody has ordered yet.', 'no_orders', 409)
    const sum = storeSummary(s, orders)
    const products = new Map(parse(s.products, []).map((p) => [p.id, p]))
    const items = freezeUpcharges(sum.products.map((r) => ({
      description: r.name,
      detail: [`${s.name} team store · ${orders.length} order${orders.length === 1 ? '' : 's'}`, products.get(r.id)?.description].filter(Boolean).join(' — '),
      sizes: r.sizes, unit_price: r.price, size_upcharges: {}, taxable: true,
    })))
    const roster = orders.map((o) => `${o.name} <${o.email}>: ${parse(o.items, []).map((i) => `${i.name} ${i.size} ×${i.qty}`).join(', ')}${o.note ? ` (${o.note})` : ''}`)
    let notes = `Team store “${s.name}” — who ordered what:\n${roster.join('\n')}`
    if (notes.length > 8000) notes = `${notes.slice(0, 7900)}\n… and more — see the store's order list.`
    const settings = getSettings()
    const rate = taxRateFor(contact.id)
    let t = computeTotals(items, rate, getUpcharges())
    // Members who paid were charged store price + tax. When any order has been taxed, every order
    // is (the ones that have not paid yet at today's rate), and the estimate must bill exactly what
    // the orders add up to. Per-order rounding (and a rate that changed mid-store) can leave a
    // difference; it is stated as its own line rather than silently billed or absorbed.
    if (orders.some((o) => o.tax != null)) {
      const owed = tx(() => roundMoney(orders.reduce((n, o) => { const x = taxOrder(s, get('SELECT * FROM store_orders WHERE id = ?', o.id)); return n + x.total + x.tax }, 0)))
      const gap = roundMoney(owed - t.total)
      if (Math.abs(gap) >= 0.005) {
        items.push({ description: 'Sales tax adjustment', detail: 'Matches the tax members were charged when they ordered', qty: 1, unit_price: gap, taxable: false })
        t = computeTotals(items, rate, getUpcharges())
      }
    }
    const num = nextEstimateNumber()
    const addr = postalDefaults(contact)
    const estId = Number(run('INSERT INTO estimates (contact_id, estimate_number, status, items, subtotal, tax, total, tax_rate, notes, created_at, billing_address, shipping_address, terms_snapshot, terms_snapshot_source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      contact.id, num, 'draft', JSON.stringify(items), t.subtotal, t.tax, t.total, rate, notes, now(), addr.billing_address, addr.shipping_address, estimateTermsIn(undefined, settings.estimate_terms), 'created').lastInsertRowid)
    run("UPDATE merch_stores SET estimate_id = ?, status = 'closed', closed_at = COALESCE(closed_at, ?), updated_at = ? WHERE id = ?", estId, now(), now(), s.id)
    logActivity('estimate', `Estimate ${num} created from team store “${s.name}” — ${money(t.total)}`, { contact_id: contact.id })
    try { syncPipeline?.(get('SELECT * FROM estimates WHERE id = ?', estId), 'created') } catch { /* pipeline is best-effort */ }
    res.json({ estimate_id: estId, estimate_number: num, total: t.total, store: view(req, get('SELECT * FROM merch_stores WHERE id = ?', s.id)) })
  }))

  /* ---------------- public store page ---------------- */

  // The shop the link names, or null. Multi-tenant installs never fall back to the default DB.
  const findStore = (req) => {
    const key = String(req.params.key || '')
    if (!KEY_RE.test(key)) return null
    if (authEnabled && !slug()) return null
    ensure()
    return get('SELECT * FROM merch_stores WHERE public_key = ?', key) || null
  }
  // pPage only catches what a handler throws before its first await.
  const safe = (fn) => async (req, res) => { try { await fn(req, res) } catch (e) { console.error('store page:', e); if (!res.headersSent) res.status(500).send('Error') } }
  const notFound = (res) => res.status(404).send(page('Store not found', '<div class="wrap"><div class="card"><h1>Store not found</h1><p>This link is not right, or the shop has taken the store down. Ask whoever sent it for a fresh link.</p></div></div>'))

  const head = (st) => {
    const s = getSettings()
    const closes = st.close_date ? `<span class="ms-chip">${storeIsOpen(st) ? 'Order by' : 'Closed'} ${esc(day(st.close_date))}</span>` : ''
    return `<div class="ms-head"><div>${logoImg(s)}<div class="shop">${esc(s.shop_name)}</div></div>${closes}</div>
      <h1 class="ms-title">${esc(st.name)}</h1>
      ${st.message ? `<p class="ms-msg">${esc(st.message)}</p>` : ''}`
  }
  const foot = () => { const s = getSettings(); return `<div class="foot">${joinDot(esc(s.shop_name), esc(s.shop_phone), esc(s.shop_email))}</div>` }

  const charging = (st) => !!st.take_payment && canCharge()
  const storeForm = (req, st, { error = '', values = {} } = {}) => {
    const products = parse(st.products, [])
    const pay = charging(st), rate = pay ? storeRate(st) : 0
    const action = sharePath(st).replace(`/store/${st.public_key}`, `/store/${st.public_key}/order`)
    const card = (p) => `<div class="ms-prod">
      ${p.image_url ? `<img class="ms-img" src="${esc(p.image_url)}" alt="" loading="lazy">` : `<div class="ms-img ms-ph" aria-hidden="true">${esc(p.name.charAt(0).toUpperCase())}</div>`}
      <div class="ms-pb">
        <div class="ms-pn"><strong>${esc(p.name)}</strong><span class="ms-price" data-price="${p.price}">${money(p.price)}</span></div>
        ${p.description ? `<p class="ms-pd">${esc(p.description)}</p>` : ''}
        <div class="ms-sizes" role="group" aria-label="${esc(p.name)} quantity by size">
          ${p.sizes.map((sz) => { const n = `q_${p.id}_${sz}`; return `<label class="ms-size"><span>${esc(sz)}</span><input type="number" inputmode="numeric" min="0" max="${STORE_LIMITS.qtyMax}" step="1" name="${n}" value="${esc(values[n] || '')}" placeholder="0" data-price="${p.price}" aria-label="${esc(p.name)} size ${esc(sz)} quantity"></label>` }).join('')}
        </div>
      </div></div>`
    return page(esc(st.name), `${STYLE}<div class="wrap ms"><div class="card">${head(st)}
      ${error ? `<div class="ms-err" role="alert">${esc(error)}</div>` : ''}
      <form method="POST" action="${esc(action)}" class="ms-form" id="ms-form">
        <h2 class="ms-h">1. Pick your sizes</h2>
        <p class="ms-hint">Type how many you want in each size. Leave the rest at 0.</p>
        <div class="ms-grid">${products.map(card).join('')}</div>
        <h2 class="ms-h">2. Your details</h2>
        <div class="ms-fields">
          <label class="ms-f"><span>Your name *</span><input name="name" required maxlength="${STORE_LIMITS.name}" autocomplete="name" value="${esc(values.name || '')}"></label>
          <label class="ms-f"><span>Email *</span><input name="email" type="email" required maxlength="254" autocomplete="email" value="${esc(values.email || '')}"></label>
          <label class="ms-f ms-wide"><span>Note for the shop <em>(optional — jersey number, name on back…)</em></span><input name="note" maxlength="${STORE_LIMITS.note}" value="${esc(values.note || '')}"></label>
        </div>
        <div class="ms-bar"><div><span class="ms-bl">Your total${pay && rate > 0 ? ' <span id="ms-tax"></span>' : ''}</span><strong id="ms-total">${money(0)}</strong></div><button class="btn ms-go" type="submit">${pay ? 'Continue to payment' : 'Place order'}</button></div>
        <p class="ms-hint center">${pay ? `You pay by card on the next page, through ${esc(getSettings().shop_name)}'s secure ${esc(payments.providerName(getSettings()))} checkout.` : 'No payment now. The shop will be in touch about payment.'}</p>
      </form></div>${foot()}</div>
      <script>(function(){var f=document.getElementById('ms-form'),t=document.getElementById('ms-total');if(!f||!t)return;var fmt;try{fmt=new Intl.NumberFormat(${JSON.stringify(shopFormat().locale || 'en-US')},{style:'currency',currency:${JSON.stringify(shopFormat().currency || 'USD')}})}catch(e){fmt=null}
      var rate=${JSON.stringify(rate)},digits=${JSON.stringify(moneyDigits())},tx=document.getElementById('ms-tax'),show=function(n){return fmt?fmt.format(n):n.toFixed(2)},p=Math.pow(10,digits)
      function upd(){var s=0;f.querySelectorAll('input[data-price]').forEach(function(i){var q=parseInt(i.value,10);if(q>0)s+=q*Number(i.dataset.price)});s=Math.round(s*p)/p;var x=rate>0?Math.round(s*rate/100*p+1e-9)/p:0;t.textContent=show(s+x);if(tx)tx.textContent=x>0?'· includes '+show(x)+' sales tax':''}f.addEventListener('input',upd);upd()})()</script>`)
  }

  const closedPage = (st) => page(esc(st.name), `${STYLE}<div class="wrap ms"><div class="card">${head(st)}
    <div class="ms-done"><div class="ms-badge" aria-hidden="true">✓</div><h2>This store is closed</h2><p>Orders are no longer being taken. Questions? Contact the shop below.</p></div></div>${foot()}</div>`)

  app.get('/store/:key', pPage((req, res) => {
    const st = findStore(req)
    if (!st) return notFound(res)
    if (!storeIsOpen(st)) return res.send(closedPage(st))
    res.send(storeForm(req, st))
  }))

  app.post('/store/:key/order', orderLimit, express.urlencoded({ extended: false, limit: '64kb', parameterLimit: 400 }), pPage(safe(async (req, res) => {
    const wantsJson = req.is('application/json')
    const st = findStore(req)
    if (!st) return wantsJson ? bad(res, 'Store not found', 'not_found', 404) : notFound(res)
    if (!storeIsOpen(st)) return wantsJson ? bad(res, 'This store is closed.', 'store_closed') : res.status(400).send(closedPage(st))
    const { order, error } = readOrder(st, req.body)
    if (error) {
      if (wantsJson) return bad(res, error)
      const values = Object.fromEntries(Object.entries(req.body || {}).filter(([k, v]) => typeof v === 'string' && (/^q_/.test(k) || ['name', 'email', 'note'].includes(k))))
      return res.status(400).send(storeForm(req, st, { error, values }))
    }
    const pay = charging(st)
    // Saved first, paid second: a checkout that cannot start, or that the member walks away from,
    // still leaves the shop an order and the member a link to pay it.
    const id = tx(() => {
      const oid = Number(run('INSERT INTO store_orders (store_id, name, email, note, items, total, created_at) VALUES (?,?,?,?,?,?,?)',
        st.id, order.name, order.email, order.note, JSON.stringify(order.items), order.total, now()).lastInsertRowid)
      if (pay) taxOrder(st, get('SELECT * FROM store_orders WHERE id = ?', oid))
      return oid
    })
    const saved = get('SELECT * FROM store_orders WHERE id = ?', id)
    if (pay) {
      let checkout = null
      try { checkout = await beginCheckout(req, st, saved) } catch (e) { console.error('store checkout:', e.message) }
      const pay_url = publicOrigin(req) + orderPath(st, saved)
      if (wantsJson) return res.json({ id, ...order, tax: saved.tax, due: orderDue(saved), paid: false, pay_url, checkout_url: checkout?.url || null })
      return res.redirect(303, checkout?.url || `${orderPath(st, saved)}&e=1`)
    }
    if (wantsJson) return res.json({ id, ...order })
    const payNote = /\bpa(y|id|ying|yment)\b/i.test(st.message || '') ? 'See the store note above about payment.' : 'No payment now — the shop will be in touch about payment.'
    res.send(orderPage(st, saved, `<div class="ms-done"><div class="ms-badge" aria-hidden="true">✓</div><h2>Thanks, ${esc(order.name)}! Your order is in.</h2>
      <p>${esc(payNote)}</p></div>`))
  })))

  /* ---- one order: its receipt, its payment state, and the way to pay it later ---- */

  const orderTable = (o) => {
    const items = parse(o.items, []), tax = Number(o.tax) || 0
    return `<table><thead><tr><th>Item</th><th>Size</th><th class="num">Qty</th><th class="num">Amount</th></tr></thead><tbody>
      ${items.map((i) => `<tr><td>${esc(i.name)}</td><td>${esc(i.size)}</td><td class="num">${i.qty}</td><td class="num">${money(i.qty * i.price)}</td></tr>`).join('')}
      </tbody></table>
      <div class="totals">${tax > 0 ? `<div><span>Subtotal</span><span>${money(o.total)}</span></div><div><span>Sales tax</span><span>${money(tax)}</span></div>` : ''}
        <div class="grand"><span>Total</span><span>${money(orderDue(o))}</span></div></div>
      ${o.note ? `<div class="notes"><strong>Your note</strong><p>${esc(o.note)}</p></div>` : ''}`
  }
  const orderPage = (st, o, lead, tail = '') => page(esc(st.name), `${STYLE}<div class="wrap ms"><div class="card">${head(st)}
      ${lead}
      ${orderTable(o)}
      ${tail}
      <p class="ms-hint center">Order #${o.id} for ${esc(o.email)}. Keep this page as your receipt. Need to change something? ${storeIsOpen(st) ? `<a href="${esc(sharePath(st))}">Place another order</a> or contact` : 'Contact'} the shop.</p>
      </div>${foot()}</div>`)

  const findOrder = (req) => {
    const st = findStore(req)
    const oid = Number(req.params.oid)
    if (!st || !payments || !Number.isSafeInteger(oid) || oid <= 0 || !payments.checkToken('storeorder', oid, req.query.t)) return {}
    const o = get('SELECT * FROM store_orders WHERE id = ? AND store_id = ?', oid, st.id)
    return o ? { st, o } : {}
  }

  app.get('/store/:key/order/:oid', pPage((req, res) => {
    const { st, o } = findOrder(req)
    if (!o) return notFound(res)
    res.setHeader('Cache-Control', 'no-store')
    const last = get('SELECT status, is_test FROM payment_attempts WHERE store_order_id = ? ORDER BY created_at DESC, reference DESC LIMIT 1', o.id)
    const open = get("SELECT 1 AS x FROM payment_attempts a LEFT JOIN payment_collections c ON c.reference = a.reference WHERE a.store_order_id = ? AND ((c.reference IS NOT NULL AND c.closed_at IS NULL) OR (c.reference IS NULL AND a.status = 'pending'))", o.id)
    const payForm = `<form method="POST" action="${esc(orderPath(st, o).replace(`/order/${o.id}?`, `/order/${o.id}/pay?`))}" class="ms-pay"><button class="btn ms-go" type="submit">Pay ${money(orderDue(o))}</button></form>`
    const shop = esc(getSettings().shop_name)
    if (o.paid_at && o.refunded_cents > 0) return res.send(orderPage(st, o, `<div class="ms-done"><div class="ms-badge ms-warn" aria-hidden="true">!</div><h2>Payment updated</h2>
      <p>A refund or payment change was recorded on this order. Do not pay again — contact ${shop} about your order.</p></div>`))
    if (o.paid_at) return res.send(orderPage(st, o, `<div class="ms-done"><div class="ms-badge" aria-hidden="true">✓</div><h2>Paid — thanks, ${esc(o.name)}!</h2>
      <p>${money(round2(o.paid_cents / 100))} received by ${shop}. Your order is in.</p></div>`))
    if (last?.status === 'test_paid') return res.send(orderPage(st, o, `<div class="ms-done"><div class="ms-badge ms-warn" aria-hidden="true">!</div><h2>Test payment complete</h2>
      <p>No real money was collected. This order is still unpaid.</p></div>`))
    // A checkout was started and its outcome is not known yet (the member has just come back, or
    // closed the card page). Paying again resumes the SAME checkout; it cannot charge twice.
    const lead = `<div class="ms-done"><div class="ms-badge ms-warn" aria-hidden="true">!</div><h2>${req.query.e ? 'Your order is saved — payment did not start' : open ? 'Your order is saved — payment is not finished' : 'Your order is saved — it has not been paid'}</h2>
      <p>${open ? 'If you already entered your card, give it a moment and refresh this page. Otherwise you can finish paying below.' : 'You can pay now, or come back to this page later to pay.'}</p></div>`
    if (!storeIsOpen(st)) return res.send(orderPage(st, o, `<div class="ms-done"><div class="ms-badge ms-warn" aria-hidden="true">!</div><h2>This store has closed</h2>
      <p>Your order is on file but was not paid online. Contact ${shop} to settle it.</p></div>`))
    if (!charging(st)) return res.send(orderPage(st, o, `<div class="ms-done"><div class="ms-badge" aria-hidden="true">✓</div><h2>Your order is in</h2><p>The shop will be in touch about payment.</p></div>`))
    res.send(orderPage(st, o, lead, `${payForm}${open ? '<p class="ms-hint center"><a href="">Refresh this page</a></p>' : ''}`))
  }))

  app.post('/store/:key/order/:oid/pay', orderLimit, pPage(safe(async (req, res) => {
    const { st, o } = findOrder(req)
    if (!o) return notFound(res)
    const back = orderPath(st, o)
    // Paid orders are never charged again, a closed store takes no more money, and the switch
    // being off (or the processor disconnected) means there is nothing to charge with.
    if (o.paid_at || !storeIsOpen(st) || !charging(st)) return res.redirect(303, back)
    try {
      const checkout = await beginCheckout(req, st, o)
      return res.redirect(303, checkout.url)
    } catch (e) {
      console.error('store checkout:', e.message)
      return res.redirect(303, `${back}&e=1`)
    }
  })))

  return { sharePath, applyPrepayments, orderPaid, orderReversal, orderReturnPath: (orderId) => { ensure(); const o = get('SELECT * FROM store_orders WHERE id = ?', orderId); const st = o && get('SELECT * FROM merch_stores WHERE id = ?', o.store_id); return o && st && payments ? orderPath(st, o) : null } }
}

// Store-page styles on top of public.css. Light, friendly, phone-first: a team member opens this on
// their phone from a group chat.
const STYLE = `<style>
.ms .card{padding:28px}
.ms-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:18px}
.ms-chip{display:inline-block;background:var(--doc-accent-glow);color:#1f2329;border:1px solid var(--doc-accent);border-radius:999px;padding:5px 12px;font-size:12.5px;font-weight:700;white-space:nowrap}
.ms-title{font-size:28px;letter-spacing:-.5px;line-height:1.2;margin-bottom:8px}
.ms-msg{color:#4b5563;white-space:pre-wrap;margin-bottom:6px}
.ms-h{font-size:16px;margin:26px 0 4px}
.ms-hint{font-size:13px;color:#79828f;margin-bottom:12px}
.ms-hint.center{text-align:center;margin-top:12px}
.ms-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px}
.ms-prod{border:1px solid #e6eaef;border-radius:12px;overflow:hidden;background:#fff;display:flex;flex-direction:column}
.ms-img{width:100%;aspect-ratio:4/3;object-fit:cover;background:#f4f6f8;display:block}
.ms-ph{display:grid;place-items:center;aspect-ratio:auto;height:64px;font-size:26px;font-weight:800;color:#b6bfcb;background:linear-gradient(135deg,#f4f6f8,#e9edf2)}
.ms-pb{padding:14px}
.ms-pn{display:flex;justify-content:space-between;gap:10px;align-items:baseline}
.ms-price{font-weight:700;font-variant-numeric:tabular-nums}
.ms-pd{font-size:13px;color:#79828f;margin-top:4px}
.ms-sizes{display:grid;grid-template-columns:repeat(auto-fill,minmax(58px,1fr));gap:8px;margin-top:12px}
.ms-size{display:grid;gap:3px;text-align:center;font-size:12px;font-weight:700;color:#4b5563}
.ms-size input,.ms-f input{width:100%;border:1.5px solid #d9dee5;border-radius:9px;padding:10px 8px;font:inherit;font-size:16px;background:#fff;color:#1f2329}
.ms-size input{text-align:center;font-variant-numeric:tabular-nums}
.ms-size input:focus,.ms-f input:focus{outline:0;border-color:var(--doc-accent);box-shadow:0 0 0 3px var(--doc-accent-glow)}
.ms-fields{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.ms-f{display:grid;gap:4px;font-size:13px;font-weight:600;color:#4b5563}
.ms-f em{font-weight:400;color:#8b95a3}
.ms-wide{grid-column:1/-1}
.ms form{margin-top:0;display:block}
.ms-bar{position:sticky;bottom:0;display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:22px;padding:14px 0;background:#fff;border-top:1px solid #e6eaef}
.ms-bl{display:block;font-size:12px;color:#79828f}
.ms-bar strong{font-size:22px;font-variant-numeric:tabular-nums}
.ms-go{font-size:16px;padding:14px 30px}
.ms-err{background:#fef2f2;color:#991b1b;border:1px solid #fecaca;border-radius:9px;padding:12px 14px;margin:8px 0 4px;font-weight:600}
.ms-done{text-align:center;padding:18px 0 8px}
.ms-done h2{font-size:21px;margin-bottom:6px}
.ms-done p{color:#4b5563}
.ms-badge{width:54px;height:54px;margin:0 auto 12px;border-radius:50%;display:grid;place-items:center;background:var(--doc-accent-glow);color:#0f766e;font-size:26px;font-weight:800}
.ms-badge.ms-warn{background:#fff4e0;color:#92400e}
.ms-pay{display:flex;justify-content:center;margin:18px 0 4px}
.ms-pay .btn{width:100%;max-width:420px}
#ms-tax{font-weight:400}
@media (max-width:560px){.ms .card{padding:20px}.ms-fields{grid-template-columns:1fr}.ms-title{font-size:23px}}
</style>`
