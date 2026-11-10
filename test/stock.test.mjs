import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const root = new URL('..', import.meta.url)

/**
 * Run `code` in a fresh process against an in-memory shop database, with a FAKE distributor in
 * place of fetch. No test here can reach a real one: anything that is not the fake S&S or the fake
 * PromoStandards host throws.
 */
function child(code, env = {}) {
  const prelude = `
    import assert from 'node:assert/strict'
    const lib = (f) => import(new URL('lib/' + f, ${JSON.stringify(root.href)}).href)
    const calls = []
    const state = { mode: 'ok' }
    const SS = [
      ['B1', 'Black', 'S', 1240, 3.11], ['B2', 'Black', 'M', 18, 3.11], ['B3', 'Black', 'L', 0, 3.11], ['B4', 'Black', 'XL', 500, 3.11],
      ['B5', 'Black', '2XL', 77, 4.9], ['B6', 'Black', 'XXXL', 9, 5.4], ['B7', 'Black', 'XLT', 40, 6.1],
      ['N1', 'Navy', 'S', 300, 3.2], ['N2', 'Navy', 'M', 310, 3.2],
      ['H1', 'Heather Navy', 'M', 55, 3.6],
    ]
    globalThis.fetch = async (url, opts = {}) => {
      const u = new URL(String(url))
      calls.push({ host: u.host, path: u.pathname + u.search, auth: opts.headers?.Authorization || '', body: opts.body || '' })
      if (state.mode === 'timeout') { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e }
      if (u.host === 'api.ssactivewear.com') {
        if (state.mode === '401') return new Response(JSON.stringify({ errors: [{ message: 'Invalid credentials' }] }), { status: 401 })
        if (u.pathname === '/v2/styles/') {
          const q = u.searchParams.get('search')
          if (q === '5000') return Response.json([{ styleID: 39, styleName: '5000', brandName: 'Gildan', title: 'Heavy Cotton T-Shirt' }])
          if (q === '5000B') return Response.json([{ styleID: 40, styleName: '5000B', brandName: 'Gildan', title: 'Heavy Cotton Youth T-Shirt' }])
          if (q === '6245CM') return Response.json([{ styleID: 41, styleName: '6245CM', brandName: 'Yupoong', title: 'Dad Hat' }])
          return Response.json([])
        }
        if (u.pathname === '/v2/products/') {
          const id = u.searchParams.get('styleid')
          const rows = id === '39' ? SS : id === '40' ? [['Y1', 'Red', 'XS', 60, 2.9], ['Y2', 'Red', 'M', 12, 2.9]] : id === '41' ? [['C1', 'Khaki', 'Adjustable', 800, 5.6]] : []
          const out = rows.map(([sku, colorName, sizeName, qty, customerPrice]) => ({ sku, colorName, sizeName, qty, customerPrice, brandName: 'Gildan' }))
          return Response.json(state.mode === 'partial' ? out.map((r, i) => (i % 2 ? r : { ...r, qty: undefined, sizeName: i === 0 ? '' : r.sizeName })) : out)
        }
      }
      if (u.host === 'ws.sanmar.com:8080') {
        const part = (id, color, size, qty) => '<PartInventory><partId>' + id + '</partId><partColor>' + color + '</partColor><labelSize>' + size + '</labelSize><quantityAvailable><Quantity><uom>EA</uom><value>' + qty + '</value></Quantity></quantityAvailable></PartInventory>'
        return new Response('<Envelope><Body><GetInventoryLevelsResponse><Inventory><PartInventoryArray>' + part('PC61-BLK-M', 'Jet Black', 'M', 410) + part('PC61-BLK-XXL', 'Jet Black', 'XXL', 6) + part('PC61-RED-M', 'Red', 'M', 90) + '</PartInventoryArray></Inventory></GetInventoryLevelsResponse></Body></Envelope>', { status: 200, headers: { 'content-type': 'text/xml' } })
      }
      throw new Error('test reached a host that is not a fake distributor: ' + u.host)
    }
    const SS_SHOP = { ss_account: '111', ss_api_key: 'key-one' }
    { const s0 = await lib('suppliers.mjs'); const d0 = await lib('db.mjs'); s0.initSuppliers(d0.getDb()) } // the garments and blank_cache tables, as every shop database has
  `
  const run = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', prelude + code], {
    env: { ...process.env, PSC_DB: ':memory:', TZ: 'UTC', SS_ACCOUNT: '', SS_API_KEY: '', SANMAR_USER: '', SANMAR_PASS: '', ALPHA_ACCOUNT: '', ALPHA_PASS: '', SSACTIVEWEAR_API_BASE: '', SANMAR_INV_URL: '', ...env },
    encoding: 'utf8', timeout: 30000,
  })
  assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`)
  return run.stdout
}

test('a distributor size label becomes the size-grid key, or nothing', () => {
  child(`
    const { stockSizeKey } = await lib('stock.mjs')
    const want = { S: 'S', ' m ': 'M', XXL: '2XL', XXXL: '3XL', '2XL': '2XL', '3 XL': '3XL', XLT: 'XLT', XXLT: '2XLT', 'One Size': 'OSFA', OSFA: 'OSFA', Adjustable: 'OSFA',
      'Youth Medium': 'YM', YM: 'YM', 'Youth XL': 'YXL', SM: 'S', LG: 'L', XS: 'XS', XL: 'XL' }
    for (const [label, key] of Object.entries(want)) assert.equal(stockSizeKey(label), key, label)
    for (const bad of ['', null, '<img src=x>', '12345', 'ABCDEF']) assert.equal(stockSizeKey(bad), null, String(bad))
  `)
})

test('the garment colour is found in the line; the ink colour is not', () => {
  child(`
    const { matchStockColor } = await lib('stock.mjs')
    const colors = ['Navy', 'White', 'Heather Navy', 'Black', 'Dark Heather', 'Grey']
    assert.equal(matchStockColor('Gildan 5000 Tee — Heather Navy — 2/0 front', colors), 'Heather Navy', 'the longest colour name wins')
    assert.equal(matchStockColor('Gildan 5000 Tee — Navy (white ink)', colors), 'Navy', 'an ink spec in brackets is not the shirt')
    assert.equal(matchStockColor('Gildan 5000 T-shirt (Black) — 1/0 Front', colors), 'Black', 'the guided estimate writes the shirt colour in brackets')
    assert.equal(matchStockColor('Gildan 5000 Tee (black ink) — 1/0 Front', colors), null)
    assert.equal(matchStockColor('Gildan 5000 Tee — gray', colors), 'Grey', 'grey and gray are one colour')
    assert.equal(matchStockColor('Gildan 5000 Tee', colors), null)
  `)
})

test('stock for a quote line: per size, for the matched colour, with the exact SKU', () => {
  child(`
    const { lineStock, stockShortfalls, STOCK_TTL_MS } = await lib('stock.mjs')
    const r = await lineStock('Gildan 5000 Tee — Black — 2/0 Front (white ink)', SS_SHOP)
    assert.equal(r.state, 'ok'); assert.equal(r.source, 'S&S Activewear'); assert.equal(r.color, 'Black'); assert.equal(r.cached, false)
    assert.deepEqual(Object.keys(r.sizes).sort(), ['2XL', '3XL', 'L', 'M', 'S', 'XL', 'XLT'])
    assert.deepEqual(r.sizes.S, { qty: 1240, sku: 'B1', cost: 3.11 })
    assert.deepEqual(r.sizes['3XL'], { qty: 9, sku: 'B6', cost: 5.4 }, 'XXXL is the 3XL box')
    assert.equal(r.sizes.L.qty, 0); assert.equal(r.sizes.XLT.sku, 'B7')
    assert.ok(Date.now() - Date.parse(r.as_of) < 5000, 'as_of is when the distributor answered')
    assert.equal(calls[0].auth, 'Basic ' + Buffer.from('111:key-one').toString('base64'))
    assert.deepEqual(stockShortfalls({ S: 100, M: 24, L: 1, xl: 500, '4XL': 5 }, r.sizes),
      [{ size: 'M', ordered: 24, in_stock: 18, short: 6 }, { size: 'L', ordered: 1, in_stock: 0, short: 1 }], 'a size the distributor does not list is not flagged short')

    // Colour chosen explicitly, and a line that names none.
    assert.equal((await lineStock('Gildan 5000', SS_SHOP, { color: 'navy' })).color, 'Navy')
    const pick = await lineStock('Gildan 5000 Tee — 2/0 Front', SS_SHOP)
    assert.equal(pick.state, 'pick_color'); assert.equal(pick.sizes, undefined); assert.ok(pick.colors.includes('Heather Navy'))

    // Youth style: the distributor says XS/M, the grid says YXS/YM. One-size caps land in OSFA.
    assert.deepEqual(Object.keys((await lineStock('Gildan 5000B youth tee — Red', SS_SHOP)).sizes).sort(), ['YM', 'YXS'])
    const cap = await lineStock('Yupoong 6245CM dad hat', SS_SHOP)
    assert.equal(cap.color, 'Khaki', 'a single-colour style needs no colour on the line'); assert.deepEqual(cap.sizes.OSFA, { qty: 800, sku: 'C1', cost: 5.6 })
  `)
})

test('stock is cached for minutes, refreshed on demand, and never reused once stale', () => {
  child(`
    const { lineStock, STOCK_TTL_MS } = await lib('stock.mjs'); const db = await lib('db.mjs')
    assert.ok(STOCK_TTL_MS <= 15 * 60 * 1000, 'stock older than a quarter of an hour is not stock')
    await lineStock('Gildan 5000 Tee — Black', SS_SHOP)
    const first = calls.length; assert.equal(first, 2, 'one style search and one product pull')
    const again = await lineStock('Gildan 5000 Tee — Navy', SS_SHOP)
    assert.equal(calls.length, first, 'another colour of the same style is the same lookup'); assert.equal(again.cached, true); assert.equal(again.color, 'Navy')
    const forced = await lineStock('Gildan 5000 Tee — Black', SS_SHOP, { refresh: true })
    assert.equal(calls.length, first + 2); assert.equal(forced.cached, false)
    db.run("UPDATE blank_cache SET updated_at = datetime('now', '-11 minutes') WHERE key LIKE 'stock|%'")
    await lineStock('Gildan 5000 Tee — Black', SS_SHOP)
    assert.equal(calls.length, first + 4, 'an eleven-minute-old answer is asked for again')
    // The 12-hour blank COST cache is a different entry and is left alone.
    assert.equal(db.all("SELECT key FROM blank_cache WHERE key NOT LIKE 'stock|%'").length, 0)
  `)
})

test('a distributor problem is a quiet state, never an exception', () => {
  child(`
    const { lineStock, resetStockLimits } = await lib('stock.mjs')
    assert.equal((await lineStock('Gildan 5000 Tee — Black', {})).state, 'not_connected')
    assert.equal(calls.length, 0, 'an unconnected shop makes no outbound call')
    assert.equal((await lineStock('Screen setup', SS_SHOP)).state, 'no_style')
    assert.equal((await lineStock('', SS_SHOP)).state, 'no_style')
    assert.equal((await lineStock('Acme ZX9999 — Black', SS_SHOP)).state, 'not_found')
    state.mode = '401'
    const denied = await lineStock('Gildan 5000 Tee — Black', SS_SHOP)
    assert.equal(denied.state, 'error'); assert.match(denied.message, /quote is unaffected/); assert.doesNotMatch(denied.message, /key-one/)
    state.mode = 'timeout'
    assert.equal((await lineStock('Gildan 5000 Tee — Black', SS_SHOP)).state, 'error')
    state.mode = 'partial'
    const partial = await lineStock('Gildan 5000 Tee — Black', SS_SHOP)
    assert.equal(partial.state, 'ok'); assert.equal(partial.sizes.M.qty, 18)
    assert.equal(partial.sizes.L.qty, 0, 'a row with no quantity reads as none, not as a crash')
    assert.equal(partial.sizes.S, undefined, 'a row with no size label is not shown under any box')
  `)
})

test('outbound lookups are budgeted per shop, and identical lookups in flight are shared', () => {
  child(`
    const { lineStock, resetStockLimits } = await lib('stock.mjs'); const { tenantStore, getDb } = await lib('db.mjs')
    const as = (slug, fn) => tenantStore.run({ slug, db: getDb() }, fn)
    const both = await as('shop-a', () => Promise.all([lineStock('Gildan 5000 Tee — Black', SS_SHOP, { refresh: true }), lineStock('Gildan 5000 Tee — Navy', SS_SHOP, { refresh: true })]))
    assert.equal(calls.length, 2, 'two lines of one style asked together are one lookup'); assert.ok(both.every((r) => r.state === 'ok'))
    calls.length = 0
    let limited = 0
    for (let i = 0; i < 30; i++) { const r = await as('shop-a', () => lineStock('Acme ZX' + (7000 + i), SS_SHOP)); if (r.state === 'rate_limited') limited++ }
    assert.ok(limited >= 10, 'the 21st distinct lookup in a minute is refused, got ' + limited)
    assert.ok(calls.length <= 20, 'no more than the budget left the building: ' + calls.length)
    // A busy shop still sees the answer it already has…
    assert.equal((await as('shop-a', () => lineStock('Gildan 5000 Tee — Black', SS_SHOP))).state, 'ok')
    // …and another shop on the same server is not affected by its neighbour's budget.
    assert.equal((await as('shop-b', () => lineStock('Acme ZX11', SS_SHOP))).state, 'not_found')
  `)
})

test('each shop asks with its own credentials; PromoStandards inventory maps the same way', () => {
  child(`
    const { lineStock } = await lib('stock.mjs')
    await lineStock('Gildan 5000 Tee — Black', { ss_account: '222', ss_api_key: 'key-two' }, { refresh: true })
    assert.ok(calls.every((c) => c.auth === 'Basic ' + Buffer.from('222:key-two').toString('base64')))
    calls.length = 0
    const r = await lineStock('Port & Company PC61 tee — Jet Black', { sanmar_user: 'u', sanmar_pass: 'p' })
    assert.equal(r.state, 'ok'); assert.equal(r.source, 'SanMar'); assert.equal(r.color, 'Jet Black')
    assert.deepEqual(r.sizes, { M: { qty: 410, sku: 'PC61-BLK-M', cost: null }, '2XL': { qty: 6, sku: 'PC61-BLK-XXL', cost: null } })
    assert.equal(calls.length, 1); assert.equal(calls[0].host, 'ws.sanmar.com:8080'); assert.match(calls[0].body, /<[^>]*productId>PC61</)
  `)
})

test('SKUs on a quote line are SKU-shaped or they are dropped', () => {
  child(`
    const { sanitizeLineSkus } = await lib('stock.mjs')
    const a = sanitizeLineSkus({ skus: { m: 'B2', 'XL': 'B4', '<b>': 'X', L: '<img src=x onerror=1>', S: 'has space' }, sku_color: 'Black<script>', sku_source: 'S&S Activewear' })
    assert.deepEqual(a.skus, { M: 'B2', XL: 'B4' }); assert.equal(a.sku_color, 'Blackscript'); assert.equal(a.sku_source, 'S&S Activewear')
    const b = sanitizeLineSkus({ description: 'x', skus: { L: '"><x' }, sku_color: 'Red', sku_source: 'Somewhere else' })
    assert.deepEqual(b, { description: 'x' }, 'nothing usable leaves nothing behind')
    assert.deepEqual(sanitizeLineSkus({ skus: 'B2' }), {})
    assert.deepEqual(sanitizeLineSkus({ description: 'no skus', qty: 2 }), { description: 'no skus', qty: 2 })
  `)
})

test('exact SKUs ride from the quote line to the job and onto the purchase order', () => {
  child(`
    const { garmentLines } = await import(new URL('public/js/shared/pricing.js', ${JSON.stringify(root.href)}).href)
    const s = await lib('suppliers.mjs'); const db = await lib('db.mjs'); s.initSuppliers(db.getDb())
    const items = [
      { description: 'Gildan 5000 Tee — Black — 2/0 Front', sizes: { S: 10, M: 20, XL: 5 }, unit_price: 9, skus: { S: 'B1', M: 'B2', XL: 'B4' }, sku_color: 'Black', sku_source: 'S&S Activewear' },
      { description: 'Gildan 18500 Hoodie — Navy', sizes: { M: 4 }, unit_price: 30 },
      { description: 'Screen setup', qty: 2, unit_price: 25 },
    ]
    const lines = garmentLines(items)
    assert.deepEqual(lines[0].skus, { S: 'B1', M: 'B2', XL: 'B4' }); assert.equal(lines[0].sku_color, 'Black')
    assert.equal(Object.hasOwn(lines[1], 'skus'), false, 'a line with no SKUs keeps exactly the shape it always had')

    const one = s.buildJobPurchaseOrder({ job_number: 'JOB-1' }, [lines[0]], SS_SHOP)
    assert.deepEqual(one.lines.map((l) => [l.sku, l.color, l.size, l.qty]), [['B1', 'Black', 'S', 10], ['B2', 'Black', 'M', 20], ['B4', 'Black', 'XL', 5]])
    assert.equal(one.exact_skus, true); assert.equal(one.sku_source, 'S&S Activewear'); assert.deepEqual(one.warnings, [])
    assert.equal(one.submission_ready, false, 'knowing the SKUs does not make this software place the order')
    assert.match(one.submission_note, /does not place the order/)

    // A size added to the job after the quote resolved has no SKU: say so, and fall back to the style code.
    const short = s.buildJobPurchaseOrder({ job_number: 'JOB-1' }, [{ ...lines[0], sizes: { S: 10, '2XL': 3 } }], SS_SHOP)
    assert.equal(short.exact_skus, false); assert.ok(short.warnings.some((w) => /no distributor SKU yet/.test(w)))
    assert.deepEqual(short.lines.map((l) => l.sku), ['B1', 'G500'])

    // Two garments: both groups survive, and the PO is exact only if every line is.
    const two = s.buildJobPurchaseOrder({ job_number: 'JOB-2' }, lines, SS_SHOP)
    assert.equal(two.lines.length, 4); assert.equal(two.exact_skus, false); assert.equal(two.total_units, 39)

    // An older job (no SKUs anywhere) builds exactly the PO it always did.
    const old = s.buildJobPurchaseOrder({ job_number: 'JOB-3' }, [{ description: 'Gildan 5000 Tee — White', garment: 'Gildan 5000 Tee', sizes: { M: 10 } }], {})
    assert.deepEqual(old.lines, [{ sku: 'G500', style: 'Gildan 5000 Tee', color: 'white', size: 'M', qty: 10, unit_cost: 3.2 }]); assert.equal(old.exact_skus, false)
  `)
})

test('a blank the shop priced outranks the built-in row; a guess from another garment says so', () => {
  child(`
    const s = await lib('suppliers.mjs'); const db = await lib('db.mjs'); const { jobRoi } = await lib('roi.mjs'); s.initSuppliers(db.getDb())
    assert.deepEqual(s.costFor('Gildan 5000 tee'), { cost: 3.2, sku: 'G500', name: 'Gildan 5000', matched: true, basis: 'catalog' })
    const guess = s.costFor('Nike DV7299 Dri-FIT polo')
    assert.equal(guess.basis, 'approximate'); assert.equal(guess.sku, null); assert.equal(guess.matched, false)
    db.run("INSERT INTO garments (sku, brand, style, name, cost, type, supplier, updated_at) VALUES ('SHOP-NIKE-DV7299','Nike','DV7299','Dri-FIT polo',21.5,'polo','shop',datetime('now'))")
    assert.deepEqual(s.costFor('Nike DV7299 Dri-FIT polo'), { cost: 21.5, sku: 'SHOP-NIKE-DV7299', name: 'Nike DV7299', matched: true, basis: 'yours' })
    db.run("INSERT INTO garments (sku, brand, style, name, cost, type, supplier, updated_at) VALUES ('SHOP-GILDAN-5000','Gildan','5000','Heavy Cotton Tee',2.65,'tee','shop',datetime('now'))")
    assert.equal(s.costFor('Gildan 5000 tee').cost, 2.65, 'same style twice: the shop\\'s own price wins')
    assert.equal(s.costFor('Gildan 5000 tee').basis, 'yours')
    assert.ok(s.isStockCatalogSku('G500')); assert.ok(!s.isStockCatalogSku('SHOP-GILDAN-5000'))

    // Profitability carries the worst basis across the job's lines.
    db.run("INSERT INTO contacts (name, created_at, updated_at) VALUES ('A', datetime('now'), datetime('now'))")
    const job = (desc) => {
      const items = JSON.stringify([{ description: desc, decoration: 'Screen Print', sizes: { M: 24 }, unit_price: 12 }])
      const e = Number(db.run("INSERT INTO estimates (contact_id, estimate_number, status, items, subtotal, tax, total, created_at) VALUES (1,?, 'approved', ?, 288, 0, 288, datetime('now'))", 'E' + Math.random(), items).lastInsertRowid)
      const j = Number(db.run("INSERT INTO jobs (contact_id, estimate_id, job_number, title, status, stage, sizes, created_at, updated_at) VALUES (1,?,?,'t','active','new','{\\"M\\":24}',datetime('now'),datetime('now'))", e, 'J' + Math.random()).lastInsertRowid)
      return jobRoi(db.get('SELECT * FROM jobs WHERE id = ?', j))
    }
    assert.equal(job('Gildan 5000 tee — Black').blank_basis, 'yours')
    assert.equal(job('Bella+Canvas 3001 tee').blank_basis, 'catalog')
    const approx = job('Adidas A430 polo'); assert.equal(approx.blank_basis, 'approximate'); assert.equal(approx.blank_matched, true, 'the old flag could not tell these apart')
    assert.equal(job('Custom cut-and-sew garment').blank_basis, 'default')
  `)
})

test('catalog input is validated before it is stored', () => {
  child(`
    const { garmentInput } = await lib('stock-routes.mjs')
    assert.deepEqual(garmentInput({ brand: ' Carhartt ', style: 'K87', name: '', cost: '14.257', type: 'TEE' }).value, { brand: 'Carhartt', style: 'K87', name: 'Carhartt K87', cost: 14.26, type: 'tee' })
    assert.equal(garmentInput({ style: 'K87', cost: 1 }).code, 'garment_brand_required')
    assert.equal(garmentInput({ brand: 'C', cost: 1 }).code, 'garment_style_required')
    for (const cost of [-1, 10001, 'abc', null, NaN, {}]) assert.equal(garmentInput({ brand: 'C', style: 'K', cost }).code, 'garment_cost_invalid', String(cost))
    assert.equal(garmentInput({ brand: 'C', style: 'K', cost: 1, type: 'spaceship' }).value.type, 'other')
    assert.equal(garmentInput({ brand: 'C', style: 'K', cost: 1, sku: '<x>' }).code, 'garment_sku_invalid')
    assert.deepEqual(garmentInput({ cost: 4 }, { partial: true }).value, { cost: 4 }, 'an edit may change one field')
    assert.equal(garmentInput({ brand: 'Line\\nBreak', style: 'K', cost: 1 }).value.brand, 'Line Break')
  `)
})

test('SKUs belong to the line they were resolved for', () => {
  child(`
    const { sanitizeLineSkus, stockLineText } = await lib('stock.mjs')
    const line = { description: 'Gildan 5000 Tee — Black', detail: '2 colors front', sizes: { M: 5 }, skus: { M: 'B2' }, sku_color: 'Black', sku_source: 'S&S Activewear' }
    assert.equal(stockLineText(line), 'Gildan 5000 Tee — Black — 2 colors front')
    const same = sanitizeLineSkus({ ...line, sku_line: stockLineText(line) })
    assert.deepEqual(same.skus, { M: 'B2' }); assert.equal(same.sku_line, 'Gildan 5000 Tee — Black — 2 colors front')
    const edited = sanitizeLineSkus({ ...line, description: 'Gildan 18500 Hoodie — Navy', sku_line: stockLineText(line) })
    assert.equal(edited.skus, undefined, 'a line that now names another garment loses the old SKUs')
    assert.equal(edited.sku_color, undefined); assert.equal(edited.sku_line, undefined)
    assert.deepEqual(sanitizeLineSkus({ ...line }).skus, { M: 'B2' }, 'a caller that sends no sku_line is taken at its word')
  `)
})

test('the browser side: what a size box says, and when stamped SKUs are kept', async () => {
  const m = await import(new URL('public/js/shared/stock.js', root).href)
  const cell = (qty, ordered) => { const c = m.stockCell(qty == null ? null : { qty }, ordered); return `${c.text}/${c.cls}` }
  assert.deepEqual([cell(1240, 10), cell(18, 30), cell(0, 0), cell(0, 4), cell(9, 0), cell(24, 24), cell(null, 5)],
    ['1,240/ok', 'only 18/short', 'out/out', 'out/short', 'low: 9/low', '24/ok', '/'])
  const ok = { state: 'ok', source: 'S&S Activewear', color: 'Black', as_of: new Date().toISOString(), sizes: { S: { qty: 1240, sku: 'B1' }, M: { qty: 18, sku: 'B2' }, L: { qty: 0, sku: 'B3' }, XL: { qty: 5, sku: null } } }
  const it = { description: 'Gildan 5000 Tee — Black', sizes: { S: 10, M: 30, L: 0, XL: 2 } }
  m.stampSkus(it, ok)
  assert.deepEqual(it.skus, { S: 'B1', M: 'B2' }, 'only sizes being ordered, and only where the distributor gave a SKU')
  assert.equal(it.sku_line, 'Gildan 5000 Tee — Black'); assert.equal(it.sku_color, 'Black')
  for (const state of ['error', 'rate_limited', 'not_connected']) { m.stampSkus(it, { state }); assert.deepEqual(it.skus, { S: 'B1', M: 'B2' }, `${state} must not erase SKUs`) }
  it.sizes.M = 0; m.stampSkus(it, { state: 'error' }); assert.deepEqual(it.skus, { S: 'B1' }, 'a size no longer ordered drops its SKU')
  it.description = 'Gildan 18500 Hoodie — Navy'; m.stampSkus(it, { state: 'error' })
  assert.equal(it.skus, undefined, 'an edited line never keeps another garment\'s SKUs'); assert.equal(it.sku_line, undefined)
  const again = { description: 'Gildan 5000 Tee — Black', sizes: { S: 1 } }; m.stampSkus(again, ok); m.stampSkus(again, { state: 'not_found' })
  assert.equal(again.skus, undefined, 'a line the distributor does not recognise carries no SKUs')

  const text = (html) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
  assert.match(text(m.stockLineHtml(ok, { S: 10, M: 30 })), /^M is short at S&amp;S Activewear · Black · as of .+ Refresh$/)
  assert.match(text(m.stockLineHtml(ok, { S: 10 })), /^In stock at S&amp;S Activewear · Black · as of /)
  assert.match(m.stockLineHtml({ state: 'pick_color', colors: ['<b>x</b>', 'Navy'] }), /&lt;b&gt;x&lt;\/b&gt;, Navy/, 'distributor colour names are escaped')
  assert.match(m.stockLineHtml({ state: 'not_connected' }), /href="#\/settings"/)
  assert.equal(m.stockLineHtml({ state: 'no_style' }), ''); assert.equal(m.stockLineHtml(null), '')
  assert.match(text(m.stockLineHtml({ state: 'error', message: 'Could not reach <the> distributor' })), /Could not reach &lt;the&gt; distributor Refresh/)
})
