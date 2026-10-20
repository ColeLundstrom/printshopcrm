import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
/** One top-level function's source, by name — the views are browser modules with DOM side effects. */
const fnSource = (src, name) => {
  const start = src.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `${name} exists`)
  return src.slice(start, src.indexOf('\n}\n', start) + 2)
}

test('boot hands the server this browser zone once, only for a manager of a shop with none', async () => {
  const src = fnSource(read('../public/js/app.js'), 'claimShopTimezone')
  const run = (settings, me) => {
    const puts = []
    const ctx = vm.createContext({ chromeSettings: settings, window: { __me: me }, Intl,
      api: { put: (url, body) => { puts.push([url, body]); return Promise.resolve({ ...settings, ...body }) } } })
    vm.runInContext(src + '\nclaimShopTimezone()', ctx)
    return JSON.parse(JSON.stringify(puts)) // the body object was built in the vm's realm
  }
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  assert.deepEqual(run({ timezone: '' }, { can_manage: true }), [['/api/settings', { timezone: zone }]])
  assert.deepEqual(run({ timezone: 'Europe/London' }, { can_manage: true }), [], 'a chosen zone is never overwritten')
  assert.deepEqual(run({ timezone: '' }, { can_manage: false }), [], 'staff cannot change settings')
  assert.deepEqual(run(null, { can_manage: true }), [], 'no settings loaded, nothing to claim')
  // A refusal must never surface — boot carries on.
  const ctx = vm.createContext({ chromeSettings: { timezone: '' }, window: { __me: {} }, Intl, api: { put: () => Promise.reject(new Error('403')) } })
  vm.runInContext(src + '\nclaimShopTimezone()', ctx)
  await new Promise((r) => setImmediate(r))
})

test('Settings → Shop offers a time zone, prefilled from the browser when the shop has none', () => {
  const misc = read('../public/js/views/misc.js')
  assert.match(misc, /<select class="input" id="fs-timezone" name="timezone">/)
  assert.match(misc, /const zone = String\(s\.timezone \|\| browserZone/)
  // Inside #shop, so the single Save button's formData picks it up.
  const shop = misc.slice(misc.indexOf('id="shop"'), misc.indexOf('id="costing"'))
  assert.ok(shop.includes('name="timezone"'))
})

test("the assistant's prefilled estimate reaches the new-estimate editor, exactly once", () => {
  const src = read('../public/js/views/assistant.js')
  const key = src.match(/ESTIMATE_PREFILL_KEY = '([^']+)'/)[1]
  const mem = new Map()
  const store = { get: (k) => mem.get(k) ?? null, set: (k, v) => mem.set(k, String(v)) }
  const ctx = vm.createContext({ store, ESTIMATE_PREFILL_KEY: key })
  vm.runInContext(fnSource(src, 'takeEstimatePrefill'), ctx)
  const take = (est) => vm.runInContext(`takeEstimatePrefill(${JSON.stringify(est)})`, ctx)
  const items = [{ description: 'Navy hoodies', sizes: { M: 24 }, unit_price: 28 }]
  store.set(key, JSON.stringify({ items, total: 672, contact_id: 7 }))
  assert.deepEqual(JSON.parse(JSON.stringify(take({ contact_id: 0 }))), { items, contact_id: 7 })
  assert.deepEqual(JSON.parse(JSON.stringify(take({ contact_id: 0 }))), {}, 'taken once — the next blank estimate is blank')
  store.set(key, JSON.stringify({ items, contact_id: 7 }))
  assert.equal(take({ contact_id: 3 }).contact_id, undefined, 'a customer already picked in the URL wins')
  for (const junk of ['not json', '[]', JSON.stringify({ items: 'x', contact_id: 'abc' })]) {
    store.set(key, junk)
    assert.deepEqual(JSON.parse(JSON.stringify(take({ contact_id: 0 }))), {})
  }
  // The card click stores it, and the editor reads it only for a NEW estimate.
  assert.match(src, /prefill && t\.dataset\.href === '\/estimates\/new'\) store\.set\(ESTIMATE_PREFILL_KEY/)
  assert.match(read('../public/js/views/estimates.js'), /if \(isNew\) Object\.assign\(est, takeEstimatePrefill\(est\)\)/)
})
