import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { startFakeSs } from './helpers/fake-ss.mjs'

const freePort = () => new Promise((resolve, reject) => { const s = createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })

test('live stock and the blank catalog over HTTP: roles, shops, and SKUs through to the purchase order', { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'psc-stock-http-'))
  const fake = await startFakeSs()
  const port = await freePort(), base = `http://127.0.0.1:${port}`
  const app = spawn(process.execPath, ['--no-warnings', 'server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PSC_DB: join(dir, 'printshop.db'), PSC_AUTH: '1', PSC_SECRET: 'stock-http-fixture', PORT: String(port), PSC_TICK_MS: '3600000',
      SSACTIVEWEAR_API_BASE: fake.base, SS_ACCOUNT: '', SS_API_KEY: '', SANMAR_USER: '', SANMAR_PASS: '', ALPHA_ACCOUNT: '', ALPHA_PASS: '', PSC_PUBLIC_URL: base },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''; app.stdout.on('data', (d) => { log += d }); app.stderr.on('data', (d) => { log += d })
  try {
    for (let i = 0; ; i++) {
      try { if ((await fetch(base + '/health')).ok) break } catch { /* not up yet */ }
      if (i > 150) throw new Error('server did not start:\n' + log)
      await new Promise((r) => setTimeout(r, 100))
    }
    const session = async (path, body) => {
      const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      assert.equal(r.status, 200, `${path}: ${await r.clone().text()}`)
      return r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
    }
    const call = async (cookie, path, body, method = body === undefined ? 'GET' : 'POST') => {
      const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      let json = null; try { json = await r.json() } catch { /* not JSON */ }
      return { status: r.status, json }
    }
    const stockUrl = (garment, extra = '') => `/api/stock?garment=${encodeURIComponent(garment)}${extra}`

    const owner = await session('/api/auth/signup', { shop_name: 'Stock Shop', owner_name: 'Olive Owner', owner_email: 'olive@example.test', password: 'fixture-pass-1' })
    assert.equal((await call(owner, '/api/members', { name: 'Sam Staff', email: 'sam@example.test', password: 'fixture-pass-2', role: 'staff' })).status, 200)
    const staff = await session('/api/auth/login', { email: 'sam@example.test', password: 'fixture-pass-2' })

    // Signed out: nothing. Not connected: a quiet state and no outbound call.
    assert.equal((await call('', stockUrl('Gildan 5000 Tee — Black'))).status, 401)
    let r = await call(owner, stockUrl('Gildan 5000 Tee — Black'))
    assert.equal(r.status, 200); assert.equal(r.json.state, 'not_connected'); assert.equal(fake.seen.length, 0)

    assert.equal((await call(owner, '/api/settings', { ss_account: '4242', ss_api_key: 'shop-one-key' }, 'PUT')).status, 200)
    r = await call(staff, stockUrl('Gildan 5000 Tee — Black — 2/0 Front'))
    assert.equal(r.json.state, 'ok', JSON.stringify(r.json)); assert.equal(r.json.color, 'Black'); assert.equal(r.json.source, 'S&S Activewear')
    assert.equal(r.json.sizes.M.qty, 18); assert.equal(r.json.sizes.L.qty, 0); assert.match(r.json.sizes.S.sku, /^B039000$/)
    assert.equal(JSON.stringify(r.json).includes('shop-one-key'), false, 'the credential never comes back')
    const lookups = fake.seen.length
    assert.equal((await call(staff, stockUrl('Gildan 5000 Tee — Navy'))).json.cached, true)
    assert.equal(fake.seen.length, lookups, 'the second colour came from the cache')
    assert.equal((await call(staff, stockUrl('Gildan 5000 Tee — Navy', '&refresh=1'))).json.cached, false)
    assert.equal((await call(owner, stockUrl('Gildan 5000 Tee'))).json.state, 'pick_color')
    assert.equal((await call(owner, stockUrl('Acme ZX9999 — Black'))).json.state, 'not_found')
    // Repeated query keys and junk never reach a 500.
    assert.equal((await call(owner, '/api/stock?garment=a&garment=b')).status, 200)
    assert.equal((await call(owner, '/api/stock')).json.state, 'no_style')

    // A second shop on the same server: its own (absent) credentials, never the first shop's.
    const other = await session('/api/auth/signup', { shop_name: 'Other Shop', owner_name: 'Otto', owner_email: 'otto@example.test', password: 'fixture-pass-3' })
    const before = fake.seen.length
    assert.equal((await call(other, stockUrl('Gildan 5000 Tee — Black'))).json.state, 'not_connected')
    assert.equal(fake.seen.length, before)
    assert.ok(fake.seen.every((s) => s.auth === 'Basic ' + Buffer.from('4242:shop-one-key').toString('base64')))

    // Blank catalog: managers write, staff read; built-in rows are corrected, not removed.
    const blank = { brand: 'Carhartt', style: 'K87', name: 'Workwear pocket tee', cost: 14.25, type: 'tee' }
    r = await call(staff, '/api/garments', blank); assert.equal(r.status, 403)
    r = await call(owner, '/api/garments', blank); assert.equal(r.status, 200, JSON.stringify(r.json))
    const mine = r.json.garment; assert.equal(mine.supplier, 'shop'); assert.equal(mine.sku, 'SHOP-CARHARTT-K87')
    assert.equal((await call(owner, '/api/garments', blank)).json.code, 'garment_exists')
    assert.equal((await call(owner, '/api/garments', { ...blank, style: 'K88', cost: -3 })).json.code, 'garment_cost_invalid')
    assert.equal((await call(other, `/api/garments/${mine.id}`, { cost: 1 }, 'PUT')).json?.garment?.sku === 'SHOP-CARHARTT-K87', false, 'another shop cannot reach this row')
    const products = (await call(staff, '/api/products')).json
    const g500 = products.garments.find((g) => g.sku === 'G500')
    assert.equal(products.removable[mine.id], true); assert.equal(products.removable[g500.id], undefined)
    assert.equal((await call(staff, `/api/garments/${g500.id}`, { cost: 2.65 }, 'PUT')).status, 403)
    r = await call(owner, `/api/garments/${g500.id}`, { cost: 2.65 }, 'PUT')
    assert.equal(r.json.garment.cost, 2.65); assert.equal(r.json.garment.supplier, 'shop'); assert.equal(r.json.garment.sku, 'G500')
    assert.equal((await call(owner, `/api/garments/${g500.id}`, undefined, 'DELETE')).json.code, 'garment_stock_row')
    assert.equal((await call(staff, `/api/garments/${mine.id}`, undefined, 'DELETE')).status, 403)

    // The quote stamps the exact SKUs; the estimate keeps only SKU-shaped ones; the PO orders them.
    const contact = (await call(owner, '/api/contacts', { name: 'Dana Coach', email: 'dana@example.test' })).json
    const stock = (await call(owner, stockUrl('Gildan 5000 Tee — Black'))).json
    const sizes = { S: 10, M: 30, XL: 8 }
    const skus = Object.fromEntries(Object.keys(sizes).map((k) => [k, stock.sizes[k].sku]))
    const est = await call(owner, '/api/estimates', { contact_id: contact.id, items: [
      { description: 'Gildan 5000 Tee — Black — 2/0 Front', decoration: 'Screen Print', sizes, unit_price: 9.5, skus: { ...skus, L: '<img src=x>' }, sku_color: 'Black', sku_source: 'S&S Activewear' },
      { description: 'Screen setup', qty: 2, unit_price: 25 }] })
    assert.equal(est.status, 200, JSON.stringify(est.json))
    assert.deepEqual(est.json.items[0].skus, skus); assert.equal(est.json.items[1].skus, undefined)
    const conv = await call(owner, `/api/estimates/${est.json.id}/convert`, {})
    assert.equal(conv.status, 200, JSON.stringify(conv.json))
    const po = (await call(owner, `/api/jobs/${conv.json.job_id}/po`)).json
    assert.deepEqual(po.lines.map((l) => [l.sku, l.color, l.size, l.qty]), [[skus.S, 'Black', 'S', 10], [skus.M, 'Black', 'M', 30], [skus.XL, 'Black', 'XL', 8]])
    assert.equal(po.exact_skus, true); assert.equal(po.submission_ready, false); assert.deepEqual(po.warnings, [])
    // Asking to submit still hands the order back to the shop: nothing is sent to the distributor.
    const posts = fake.seen.length
    const sub = await call(owner, `/api/jobs/${conv.json.job_id}/po/submit`, {})
    assert.equal(sub.json.ok, false); assert.equal(sub.json.pending, true)
    assert.equal(fake.seen.length, posts, 'no order request left the server')
    // Profitability says the blank cost is the shop's own corrected price.
    const roi = (await call(owner, `/api/roi/${conv.json.job_id}`)).json
    assert.equal(roi.blank_basis, 'yours')
  } finally {
    app.kill('SIGTERM')
    await new Promise((r) => { app.once('exit', r); setTimeout(r, 4000) })
    await fake.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
