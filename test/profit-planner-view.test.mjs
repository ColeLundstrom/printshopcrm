import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { moneyFormatter } from '../public/js/shared/format.js'
import { calculateProfitQuote, calculateBreakEven, quantityPriceBreaks } from '../public/js/shared/profit-planning.js'

const source = readFileSync(new URL('../public/js/views/profit-planner.js', import.meta.url), 'utf8')
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const config = () => ({ settings: { overhead_month: 520, productive_pct: 75 }, overhead_rate: 4,
  machines: [{ id: 7, name: 'Press <one>', active: 1, hourly_cost: 10, output_hour: 100, setup_minutes: 30, hours_week: 40 }],
  employees: [{ member_id: 2, hourly_cost: 25 }], members: [{ id: 2, name: 'Operator', status: 'active' }] })
function fixture({ currency } = {}) {
  const nodes = new Map(), calls = [], downloads = []
  class Node {
    constructor(id, parent) { this.id = id; this.parent = parent; this.children = []; this.connected = true; this.html = ''; this.value = ''; this.disabled = false; this.textContent = '' }
    get isConnected() { return this.connected && (!this.parent || this.parent.isConnected) }
    get innerHTML() { return this.html }
    set innerHTML(html) {
      const detach = n => { n.connected = false; if (nodes.get(n.id) === n) nodes.delete(n.id); n.children.forEach(detach) }
      this.children.forEach(detach); this.children = []; this.html = html
      for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
        const n = new Node(match[1], this); n.value = match[0].match(/\bvalue="([^"]*)"/)?.[1] || ''; this.children.push(n); nodes.set(n.id, n)
      }
    }
    click() { downloads.push(this.download) }
    remove() {}
  }
  const view = new Node('view'); nodes.set('view', view)
  const api = { async get(path) { calls.push(path); return api.read ? api.read() : config() } }
  const ctx = vm.createContext({ api, $: selector => nodes.get(selector.slice(1)), esc: value => String(value ?? '').replaceAll('<', '&lt;').replaceAll('"', '&quot;'), money: currency ? moneyFormatter({ currency, locale: 'en-US' }).money : value => value.toFixed(2), moneyModel: currency ? moneyFormatter({ currency, locale: 'en-US' }).moneyModel : value => value.toFixed(2), setPage() {}, calculateProfitQuote, calculateBreakEven, quantityPriceBreaks, Blob, URL, setTimeout: fn => fn(), document: { createElement: () => new Node('download'), body: { append() {} } } })
  vm.runInContext(source.replace(/^import[^\n]+\n/gm, '').replace('export async function profitPlannerView', 'async function profitPlannerView') + '\nglobalThis.renderView = profitPlannerView', ctx)
  return { api, calls, view, downloads, node: id => nodes.get(id), render: () => ctx.renderView(), input(id, value) { const n = nodes.get(id); n.value = value; nodes.get('profit-quote-form').oninput() }, leave() { view.innerHTML = '<p>Other view</p>' } }
}

test('planner is free, reads existing cost setup once, and never writes a customer price', async () => {
  const f = fixture(); await f.render()
  assert.deepEqual(f.calls, ['/api/costing/config'])
  assert.match(f.view.innerHTML, /Included in the free software/)
  assert.match(f.view.innerHTML, /not saved|not change/i)
  assert.doesNotMatch(f.view.innerHTML, /Press <one>/)
  assert.match(f.node('profit-quote-results').innerHTML, /Enter your costs/)
  f.node('profit-example').onclick()
  assert.match(f.node('profit-quote-results').innerHTML, /Minimum modeled price/)
  assert.equal(f.node('profit-export').disabled, false)
})

test('invalid and empty input remove stale profitable results and disable export', async () => {
  const f = fixture(); await f.render(); f.node('profit-example').onclick()
  f.input('profit-quantity', '0')
  assert.match(f.node('profit-quote-results').innerHTML, /role="alert"/)
  assert.doesNotMatch(f.node('profit-quote-results').innerHTML, /Minimum modeled price/)
  assert.equal(f.node('profit-export').disabled, true)
  f.input('profit-quantity', '100'); f.input('profit-garment_cost', '')
  assert.match(f.node('profit-quote-results').innerHTML, /Enter your costs/)
  assert.equal(f.node('profit-export').disabled, true)
})

test('machine and employee selections update model rates while preserving the quantity', async () => {
  const f = fixture(); await f.render(); f.node('profit-example').onclick(); f.input('profit-quantity', '240')
  f.node('profit-machine').value = '7'; f.node('profit-machine').onchange()
  f.node('profit-employee').value = '2'; f.node('profit-employee').onchange()
  assert.equal(f.node('profit-quantity').value, '240')
  assert.equal(Number(f.node('profit-output_hour').value), 100)
  assert.equal(Number(f.node('profit-labor_rate').value), 25)
  assert.equal(Number(f.node('profit-overhead_rate').value), 4)
})

test('monthly forecast handles losses honestly and rejects impossible contribution margins', async () => {
  const f = fixture(); await f.render()
  for (const [key, value] of Object.entries({ fixed_cost_month: 10000, variable_cost_pct: 50, target_profit_month: 5000, forecast_revenue: 1000, productive_hours_month: 100 })) f.node('profit-month-' + key).value = String(value)
  f.node('profit-month-form').oninput()
  assert.match(f.node('profit-month-results').innerHTML, /-9500.00/)
  assert.match(f.node('profit-month-results').innerHTML, /30000.00/)
  f.node('profit-month-variable_cost_pct').value = '100'; f.node('profit-month-form').oninput()
  assert.match(f.node('profit-month-results').innerHTML, /role="alert"/)
  assert.doesNotMatch(f.node('profit-month-results').innerHTML, /30000.00/)
})

test('late setup reads cannot repaint another route or a newer planner visit', async () => {
  const f = fixture(), old = deferred(); f.api.read = () => old.promise
  const pending = f.render(); f.leave(); old.resolve(config()); await pending
  assert.equal(f.view.innerHTML, '<p>Other view</p>')
  const delayed = deferred(); f.api.read = () => delayed.promise; const first = f.render()
  f.api.read = () => ({ ...config(), machines: [] }); await f.render(); delayed.resolve(config()); await first
  assert.doesNotMatch(f.view.innerHTML, /Press &lt;one>/)
})

test('setup failures have a retry and quantity-sheet downloads contain only model numbers', async () => {
  const f = fixture(); f.api.read = () => { throw Error('Connection interrupted') }; await f.render()
  assert.match(f.node('profit-loading').innerHTML, /Connection interrupted/)
  f.api.read = () => config(); await f.node('profit-retry').onclick(); f.node('profit-example').onclick()
  f.node('profit-export').onclick()
  assert.deepEqual(f.downloads, ['printshopcrm-modeled-price-breaks.csv'])
})


test('a zero-value quote displays undefined margin honestly without breaking price export', async () => {
  const f = fixture(); await f.render(); f.node('profit-example').onclick()
  for (const key of ['garment_cost', 'consumable_cost', 'machine_rate', 'labor_rate', 'overhead_rate', 'other_cost', 'payment_flat']) f.input('profit-' + key, '0')
  assert.match(f.node('profit-quote-results').innerHTML, /N\/A/)
  assert.doesNotMatch(f.node('profit-quote-results').innerHTML, /role="alert"/)
  assert.equal(f.node('profit-export').disabled, false)
})


test('model price floors keep decimal precision in zero-minor-unit currency displays', async () => {
  const f = fixture({ currency: 'JPY' }); await f.render(); f.node('profit-example').onclick()
  for (const key of ['consumable_cost', 'machine_rate', 'labor_rate', 'overhead_rate', 'other_cost', 'payment_flat', 'payment_pct', 'spoilage_pct']) f.input('profit-' + key, '0')
  f.input('profit-quantity', '100'); f.input('profit-garment_cost', '10'); f.input('profit-target_margin_pct', '3')
  assert.match(f.node('profit-quote-results').innerHTML, /10\.31/)
  assert.doesNotMatch(f.node('profit-quote-results').innerHTML, /role="alert"/)
  assert.match(f.node('profit-breaks').innerHTML, /10\.31/)
})
