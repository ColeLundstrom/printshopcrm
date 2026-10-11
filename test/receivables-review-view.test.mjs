import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../public/js/views/books.js', import.meta.url), 'utf8').replace(/^import[^\n]+\n/gm, '').replace(/export (async )?function /g, '$1function ')
const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const invoice = (extra = {}) => ({ id: 7, number: 'INV-REVIEW', contact_id: 3, company: 'Synthetic shop', contact_name: 'Customer', balance: 20, amount_due: 30, amount_paid: 10, credit_total: 5, payment_review: 'Credit changed; verify first', due_date: null, ...extra })
const data = () => ({ as_of: '2026-10-11', totals: { current: 20, d30: 0, d60: 0, d90: 0, d90p: 0, due: 20 }, customers: [], collection_review: { due: 20, unpaused_due: 0, count: 1, no_balance_count: 0, overpaid: 0, invoices: [invoice()] } })
function fixture() {
  let loading, html = '', get = async path => path.includes('ar-aging') ? data() : { forbidden: true }
  const view = { set innerHTML(value) { if (loading) loading.isConnected = false; html = value; loading = { isConnected: true, innerHTML: '' } }, get innerHTML() { return html } }
  const retry = {}, location = { hash: '#/books' }, window = { __me: { id: 1 } }
  const context = vm.createContext({ api: { get: (...args) => get(...args) }, $: selector => selector === '#view' ? view : selector === '#books-loading' ? loading : selector === '#books-retry' ? retry : null,
    esc: escape, money: n => '$' + Number(n).toFixed(2), setPage() {}, onOnce() {}, empty: (_icon, title, detail) => title + detail, toast() {}, location, window })
  vm.runInContext(source + '\nglobalThis.open=booksView;globalThis.render=render;', context)
  return { context, view, retry, location, window, setGet: fn => get = fn, loading: () => loading }
}

test('Books shows review balances and escaped reasons with read-only invoice links, including no-balance reviews', () => {
  const f = fixture(), report = data()
  report.collection_review.invoices.push(invoice({ id: 8, number: 'INV-ZERO', balance: 0, amount_due: 0, amount_paid: 0, credit_total: 100, payment_review: '<img src=x onerror=attack()>' }))
  report.collection_review.invoices.push(invoice({ id: 9, number: 'INV-OVERPAID', balance: -25, payment_review: 'Confirm overpayment' }))
  report.collection_review.count = 3; report.collection_review.no_balance_count = 2; report.collection_review.overpaid = 25
  f.context.render(report, { forbidden: true })
  assert.match(f.view.innerHTML, /Review before collecting/)
  assert.match(f.view.innerHTML, /href="#\/invoices\/7"/)
  assert.match(f.view.innerHTML, /No balance due/)
  assert.match(f.view.innerHTML, /Credit balance \$25\.00/)
  assert.match(f.view.innerHTML, /Active credits \$100\.00/)
  assert.match(f.view.innerHTML, /&lt;img/)
  assert(!f.view.innerHTML.includes('<img'))
  assert.match(f.view.innerHTML, /managers and owners/)
  assert(!f.view.innerHTML.includes('Every invoice is paid up'))
  assert.match(f.view.innerHTML, /No positive balances/)
  assert(!f.view.innerHTML.includes('data-clear-review'))
})

test('invoice drilldowns keep net invoice, recorded payments and credits distinct and show missing due dates', () => {
  const f = fixture(), report = data()
  report.customers = [{ contact_id: 3, name: '<Customer>', company: '', current: 20, d30: 0, d60: 0, d90: 0, d90p: 0, total: 20, invoices: [invoice()] }]
  f.context.render(report, { forbidden: true })
  assert.match(f.view.innerHTML, /<details/)
  assert.match(f.view.innerHTML, /Net invoice \$30\.00/)
  assert.match(f.view.innerHTML, /Recorded payments \$10\.00/)
  assert.match(f.view.innerHTML, /Active credits \$5\.00/)
  assert.match(f.view.innerHTML, /No due date saved/)
  assert.match(f.view.innerHTML, /Credits are already included in net invoice amounts/)
  assert.match(f.view.innerHTML, /overflow-x:auto/)
})

test('an older Books request, navigation or identity change cannot reveal a stale review report', async () => {
  for (const action of ['newer', 'navigate', 'identity', 'detach']) {
    const f = fixture(), old = deferred(), fresh = deferred(); let n = 0
    f.setGet(path => path.includes('ar-aging') ? (++n === 1 ? old.promise : fresh.promise) : Promise.resolve({ forbidden: true }))
    const pending = f.context.open()
    if (action === 'newer') { const next = f.context.open(); fresh.resolve({ ...data(), as_of: 'Fresh report' }); await next }
    if (action === 'navigate') f.location.hash = '#/contacts'
    if (action === 'identity') f.window.__me = { id: 2 }
    if (action === 'detach') f.view.innerHTML = 'Another page'
    const before = f.view.innerHTML
    old.resolve({ ...data(), as_of: 'Stale secret report' }); await pending
    assert.equal(f.view.innerHTML, before)
    assert(!f.view.innerHTML.includes('Stale secret report'))
  }
})

test('an active report failure has a retry and a stale failure leaves the current page untouched', async () => {
  const f = fixture()
  f.setGet(path => path.includes('ar-aging') ? Promise.reject(Error('Temporary report outage')) : Promise.resolve({ forbidden: true }))
  await f.context.open()
  assert.match(f.loading().innerHTML, /role="alert"/)
  assert.equal(typeof f.retry.onclick, 'function')
  f.setGet(async path => path.includes('ar-aging') ? data() : { forbidden: true })
  await f.retry.onclick()
  assert.match(f.view.innerHTML, /Review before collecting/)
  const late = deferred(); f.setGet(path => path.includes('ar-aging') ? late.promise : Promise.resolve({ forbidden: true }))
  const pending = f.context.open(); f.view.innerHTML = 'New page'
  late.reject(Error('Old error')); await pending
  assert.equal(f.view.innerHTML, 'New page')
})
