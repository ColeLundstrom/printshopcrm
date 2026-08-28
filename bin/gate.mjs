#!/usr/bin/env node
/**
 * The release gate — every regression this codebase has actually shipped, as executable memory.
 *
 * Rule: a bug does not get fixed here until it has a case in this file that fails on the old
 * code. Run it from the release directory:  node bin/gate.mjs   (exit 0 = clear to deploy).
 * It boots nothing and talks to no network — pure unit surface, so it runs in <2s and can gate
 * every deploy without credentials.
 */
import { strict as assert } from 'node:assert'

let passed = 0, failed = 0
const section = (name) => console.log(`\n  ${name}`)
async function t(name, fn) {
  try { await fn(); passed++; console.log(`    ✓ ${name}`) }
  catch (e) { failed++; console.log(`    ✗ ${name}\n      ${e.message.split('\n')[0]}`) }
}

/* ---------- intake parsing (lib/ai.mjs) ---------- */
const { parseIntakeHeuristic, parseDeadline } = await import('../lib/ai.mjs')
const { parseGarmentText } = await import('../lib/suppliers.mjs')

section('intake: quantity vs style number')
// Each of these shipped broken once. "200 Gildan 5000" read 200 as the style; "144 Bella+Canvas
// 3001" produced no estimate at all because the qty regex demanded a garment noun.
const QTY_CASES = [
  ['144 Bella+Canvas 3001 in White, 1 color front', 144, '3001'],
  ['200 Gildan 5000 tees in Black, 2 color front', 200, '5000'],
  ['500 x Gildan 18500 hoodies in Navy', 500, '18500'],
  ['72 Comfort Colors 1717 in Blue', 72, '1717'],
  ['qty 1,200 Next Level 3600 white', 1200, '3600'],
  ['Order 96 Port & Company PC61 navy', 96, 'PC61'],
  ['24 black tees', 24, ''],
  ['Just checking prices, no numbers here', 0, ''],
]
for (const [text, qty, style] of QTY_CASES) {
  await t(JSON.stringify(text), () => {
    assert.equal(parseIntakeHeuristic(text).total_pieces, qty, 'quantity')
    assert.equal(parseGarmentText(text).style, style, 'style')
  })
}

section('intake: size grid vs stated total (Math.max, not ||)')
await t('"200 shirts, 24 in S" quotes 200, not 24', () => {
  const o = parseIntakeHeuristic('We need 200 shirts total, at least 24 in S. 1 color front')
  assert.equal(o.total_pieces, 200)
})

section('intake: named garment beats the generic shortlist')
for (const [text, want] of [
  ['72 Comfort Colors 1717 in Blue', /comfort colors 1717/i],
  ['96 Port & Company PC61 in Red', /port & company pc61/i],
]) {
  await t(`${JSON.stringify(text)} → ${want}`, () => {
    assert.match(parseIntakeHeuristic(text).garment, want)
  })
}

section('intake: the model may fill a blank, never overwrite what the parser read')
// This shipped exploitable on the one path nobody reads: Autopilot prices, saves, marks sent and
// emails the estimate in a single request. parseIntake merged the model's reply over the
// deterministic parse and then RECOMPUTED total_pieces from the model's grid, so a customer who
// appended an extraction instruction to their own quote request could re-base a 500-piece order
// to 1 piece — $18,075 of hoodies invoiced at $115.03. lib/agent.mjs applyValidated() has always
// had the right rule (fill an empty slot, never replace a full one); this path never got it.
{
  const { mergeIntake } = await import('../lib/ai.mjs')
  const stated = parseIntakeHeuristic('we need 500 Gildan 18500 hoodies in navy, 2 color front')
  const grid = parseIntakeHeuristic('Gildan 5000 tees: 24 S, 48 M, 24 L, 1 color front')

  await t('a model grid cannot cut a stated count down', () => {
    assert.equal(stated.total_pieces, 500, 'precondition: the parser read 500')
    assert.equal(mergeIntake(stated, { sizes: { S: 1 } }).total_pieces, 500)
  })
  await t("a model grid cannot replace the customer's own breakdown", () => {
    const m = mergeIntake(grid, { sizes: { S: 1 } })
    assert.equal(m.total_pieces, 96)
    assert.deepEqual(m.sizes, { S: 24, M: 48, L: 24 })
  })
  await t('…but it may still supply a grid the parser never found', () => {
    const m = mergeIntake(stated, { sizes: { S: 100, M: 250, L: 150 } })
    assert.deepEqual(m.sizes, { S: 100, M: 250, L: 150 })
    assert.equal(m.total_pieces, 500)
  })
  await t('a garment that is not apparel we can price is refused', () => {
    // garment_cost is looked up from this string, so a free-text value out of a customer's
    // message set the cost basis of the whole quote.
    assert.equal(mergeIntake(stated, { garment: 'Ferrari 458' }).garment, 'Gildan 18500 Hoodie')
    assert.equal(mergeIntake(stated, { garment: '' }).garment, 'Gildan 18500 Hoodie')
  })
  await t('…while a real garment the model names is still accepted', () => {
    assert.equal(mergeIntake(stated, { garment: 'Bella+Canvas 3001 Tee' }).garment, 'Bella+Canvas 3001 Tee')
    assert.equal(mergeIntake(stated, { garment: 'Comfort Colors 1717' }).garment, 'Comfort Colors 1717')
  })
}

section('deadline parsing')
// parseDeadline returns { date: ISO|null, text: matched-phrase|null }
for (const [text, check] of [
  ['need them by 2026-09-08', (d) => d === '2026-09-08'],
  ['due 9/30/2026', (d) => d === '2026-09-30'],
  ['by Sept 8th', (d) => /-09-08$/.test(d || '')],
  ['in 3 weeks', (d) => !!d && d > new Date().toISOString().slice(0, 10)],
  ['no date at all here', (d) => d === null],
]) {
  await t(JSON.stringify(text), () => {
    const r = parseDeadline(text)
    assert.ok(check(r.date), `got ${JSON.stringify(r)}`)
  })
}
await t('never returns a past date', () => {
  const r = parseDeadline('by January 2nd')
  assert.ok(r.date === null || r.date >= new Date().toISOString().slice(0, 10), `got ${JSON.stringify(r)}`)
})

/* ---------- price book (lib/pricebook.mjs) ---------- */
const { resolveBook, quoteService, serviceMatrix, STOCK_SERVICES, QTY_BANDS, bandFor, AXIS, AXIS_LABEL } = await import('../lib/pricebook.mjs')

section('pricebook: axes and setup language')
await t('embroidery bills digitizing per design, never screens', () => {
  const book = resolveBook('{}')
  const q = quoteService({ book, service: 'Embroidery', qty: 48, units: 8000, placements: 1 })
  assert.equal(q.setup.label, 'Digitizing')
  assert.equal(q.setup.qty, 1)
})
await t('DTF has no setup line at all', () => {
  const book = resolveBook('{}')
  const q = quoteService({ book, service: 'DTF Transfer', qty: 48, units: 50, placements: 1 })
  assert.equal(q.setup, null)
})
await t('screen print bills setup per colour', () => {
  const book = resolveBook('{}')
  const q = quoteService({ book, service: 'Screen Print', qty: 48, units: 3, placements: 1 })
  assert.equal(q.setup.qty, 3)
})

section('pricebook: overrides layer on stock')
await t('override changes the quote; reset restores stock', () => {
  const stock = resolveBook('{}')
  const before = quoteService({ book: stock, service: 'Embroidery', qty: 48, units: 8000 }).subtotal
  const edited = resolveBook(JSON.stringify({ services: { Embroidery: { axis: 'stitches', base: 7.5, perUnit: 1, unitSize: 1000, minPerPiece: 5, setup: { label: 'Digitizing & setup', fee: 75, per: 'design' } } } }))
  const after = quoteService({ book: edited, service: 'Embroidery', qty: 48, units: 8000 }).subtotal
  assert.ok(after > before, `${after} !> ${before}`)
  assert.equal(quoteService({ book: resolveBook('{}'), service: 'Embroidery', qty: 48, units: 8000 }).subtotal, before)
})
await t('custom service quotes on its own axis', () => {
  const book = resolveBook(JSON.stringify({ services: { 'Puff Embroidery': { axis: 'stitches', base: 9, perUnit: 1.4, unitSize: 1000, minPerPiece: 9, setup: { label: 'Digitizing', fee: 40, per: 'design' } } } }))
  const q = quoteService({ book, service: 'Puff Embroidery', qty: 48, units: 10000 })
  assert.ok(q.perPiece > 9, String(q.perPiece))
  assert.ok(book.services['Puff Embroidery'].custom)
})

section('pricebook: invariants')
await t('qty band boundaries are exact', () => {
  const book = resolveBook('{}')
  for (let i = 1; i < QTY_BANDS.length; i++) {
    const edge = QTY_BANDS[i].min
    assert.equal(bandFor(edge, book.bands), QTY_BANDS[i].factor, `at ${edge}`)
    assert.equal(bandFor(edge - 1, book.bands), QTY_BANDS[i - 1].factor, `at ${edge - 1}`)
  }
})
await t('per-piece price is monotonically non-increasing in quantity', () => {
  const book = resolveBook('{}')
  for (const svc of Object.keys(STOCK_SERVICES)) {
    let prev = Infinity
    for (const q of [1, 12, 24, 48, 72, 144, 288, 500, 1000]) {
      const r = quoteService({ book, service: svc, qty: q, units: 2 })
      assert.ok(r.perPiece <= prev + 1e-9, `${svc} at ${q}: ${r.perPiece} > ${prev}`)
      prev = r.perPiece
    }
  }
})
await t('no service ever quotes ≤ $0 for a non-zero order', () => {
  const book = resolveBook('{}')
  for (const svc of Object.keys(STOCK_SERVICES))
    for (const q of [1, 7, 48, 999])
      for (const u of [1, 2, 8, 15000])
        assert.ok(quoteService({ book, service: svc, qty: q, units: u }).perPiece > 0, `${svc} q${q} u${u}`)
})
await t('minPerPiece is honoured', () => {
  const book = resolveBook('{}')
  for (const [name, s] of Object.entries(STOCK_SERVICES)) {
    const r = quoteService({ book, service: name, qty: 10000, units: 1 })
    assert.ok(r.perPiece >= (s.minPerPiece || 0) - 1e-9, `${name}: ${r.perPiece} < ${s.minPerPiece}`)
  }
})

/* ---------- supplier matching (lib/suppliers.mjs) ---------- */
const { ssStyleHitScore, pickSku, sizeCosts, consolidatePoLines } = await import('../lib/suppliers.mjs')

section('suppliers: brand-aware matching')
await t('Gildan 5000 outranks Bayside 5000 when brand is stated', () => {
  const bayside = ssStyleHitScore({ styleName: '5000', brandName: 'Bayside' }, '5000', 'Gildan')
  const gildan = ssStyleHitScore({ styleName: '5000', brandName: 'Gildan' }, '5000', 'Gildan')
  assert.ok(gildan > bayside, `${gildan} !> ${bayside}`)
})
await t('pickSku filters by colour before price', () => {
  const rows = [
    { sku: 'RED-S', color: 'Antique Cherry Red', size: 'S', cost: 2.50 },
    { sku: 'BLK-S', color: 'Black', size: 'S', cost: 2.56 },
    { sku: 'BLK-2X', color: 'Black', size: '2XL', cost: 5.16 },
  ]
  assert.equal(pickSku(rows, { color: 'black' }).sku, 'BLK-S')
})
await t('sizeCosts returns per-size costs for the asked colour', () => {
  const rows = [
    { color: 'Black', size: 'S', cost: 2.56 }, { color: 'Black', size: '2XL', cost: 5.16 },
    { color: 'White', size: 'S', cost: 2.45 },
  ]
  assert.deepEqual(sizeCosts(rows, { color: 'black' }), { S: 2.56, '2XL': 5.16 })
})

section('suppliers: PO consolidation (split-shipment guard)')
await t('duplicate (style,color,size) lines are summed to one', () => {
  const out = consolidatePoLines([
    { style: 'G500', color: 'black', size: 'M', qty: 10 },
    { style: 'G500', color: 'black', size: 'M', qty: 14 },
    { style: 'G500', color: 'black', size: 'L', qty: 5 },
  ])
  assert.equal(out.length, 2)
  assert.equal(out.find((l) => String(l.size).toUpperCase() === 'M').qty, 24)
})

/* ---------- pricing money-bugs (v44 audit fixes) ---------- */
const { priceIntake } = await import('../lib/quickquote.mjs')
const SET = { tax_rate: '7.75', default_markup: '2', screen_fee: '25', price_book: '{}' }

section('pricing: partial size grid does not shrink the order')
await t('"200 shirts, 24 in S" prices 200, not 24', () => {
  const o = parseIntakeHeuristic('We need 200 Gildan 5000 shirts total, 24 in S. 1 color front')
  assert.equal(o.total_pieces, 200)
})

section('pricing: multi-location prices per location, not blended×placements')
await t('front 3c + back 3c ≈ 2× a single 3c location (not >2.5×)', () => {
  const one = priceIntake({ garment: 'Gildan 5000', decoration: 'Screen Print', total_pieces: 500, sizes: {}, locations: [{ name: 'Front', colors: 3 }] }, SET)
  const two = priceIntake({ garment: 'Gildan 5000', decoration: 'Screen Print', total_pieces: 500, sizes: {}, locations: [{ name: 'Front', colors: 3 }, { name: 'Back', colors: 3 }] }, SET)
  assert.ok(two.quote.imprintPerPiece <= one.quote.imprintPerPiece * 2.15 && two.quote.imprintPerPiece >= one.quote.imprintPerPiece * 1.85,
    `2×=${two.quote.imprintPerPiece} vs 1×=${one.quote.imprintPerPiece}`)
})

section('pricing: tax-exempt buyer pays no tax, and the rate is returned for persistence')
await t('taxRate 0 → zero tax; returned on the result', () => {
  const ex = priceIntake({ garment: 'Gildan 5000', decoration: 'Screen Print', total_pieces: 100, sizes: {}, locations: [{ name: 'Front', colors: 1 }] }, SET, { taxRate: 0 })
  const norm = priceIntake({ garment: 'Gildan 5000', decoration: 'Screen Print', total_pieces: 100, sizes: {}, locations: [{ name: 'Front', colors: 1 }] }, SET)
  assert.equal(ex.totals.tax, 0)
  assert.equal(ex.taxRate, 0)
  assert.ok(norm.totals.tax > 0)
})

section('pricing: embroidery stitch count and DTF area are parsed')
await t('15,000-stitch logo and 12x16 area are read', () => {
  assert.equal(parseIntakeHeuristic('144 polos, left chest embroidery, 15000 stitch logo').stitches, 15000)
  assert.equal(parseIntakeHeuristic('144 tees, DTF, 12x16 full front print').print_area, 192)
})

section('deadline: the five fixed breaks')
await t('dash/slash dates, month overflow, no false positive on "for … pricing"', () => {
  const today = new Date(2026, 7, 18)
  assert.equal(parseDeadline('due 09-08-2026', today).date, '2026-09-08')
  assert.equal(parseDeadline('by 2026/09/08', today).date, '2026-09-08')
  assert.equal(parseDeadline('in 1 month', today).date, '2026-09-18')
  assert.equal(parseDeadline('quote for 9/8 pricing', today).date, null)
  assert.equal(parseDeadline('by Feb 29', today).date, '2028-02-29')
})

/* ---------- purchase orders + receiving (v48) ---------- */
section('purchasing: persist, receive per cell, shortage, clamp')
await t('PO persists, partial receive reports shortage, overreceive clamps', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbmod = await import('../lib/db.mjs')
  const sup = await import('../lib/suppliers.mjs')
  const mem = new DatabaseSync(':memory:')
  mem.exec('PRAGMA foreign_keys = ON')
  mem.exec('CREATE TABLE jobs (id INTEGER PRIMARY KEY, job_number TEXT)')
  dbmod.setDefaultDb(mem)
  sup.initSuppliers(mem)
  dbmod.run('INSERT INTO jobs (id, job_number) VALUES (1, ?)', 'JOB-1')
  const job = { id: 1, job_number: 'JOB-1' }
  const built = { po_number: 'PSC-JOB-1', supplier: null, status: 'draft', total_units: 100, est_cost: 250,
    lines: [ { sku: 'G500', style: 'Gildan 5000', color: 'black', size: 'S', qty: 20, unit_cost: 2.5 },
             { sku: 'G500', style: 'Gildan 5000', color: 'black', size: 'M', qty: 40, unit_cost: 2.5 },
             { sku: 'G500', style: 'Gildan 5000', color: 'black', size: 'L', qty: 30, unit_cost: 2.5 },
             { sku: 'G500', style: 'Gildan 5000', color: 'black', size: 'XL', qty: 10, unit_cost: 2.5 } ] }
  const stored = sup.createPurchaseOrder(job, built, { status: 'placed_manually' })
  assert.equal(stored.ordered, 100)
  assert.equal(stored.lines.length, 4)
  const xl = stored.lines.find((l) => l.size === 'XL')
  // receive everything but 2 XL
  const recs = stored.lines.map((l) => ({ line_id: l.id, qty: l.size === 'XL' ? l.qty_ordered - 2 : l.qty_ordered }))
  const partial = sup.receivePurchaseOrder(stored.id, recs)
  assert.equal(partial.status, 'partial')
  assert.equal(partial.received, 98)
  assert.equal(partial.short, 2)
  assert.equal(partial.lines.find((l) => l.size === 'XL').short, 2)
  // receive the last 2 → fully received
  const done = sup.receivePurchaseOrder(stored.id, [{ line_id: xl.id, qty: 2 }])
  assert.equal(done.status, 'received')
  assert.ok(done.fully_received)
  // overreceive is clamped, never exceeds ordered
  const over = sup.receivePurchaseOrder(stored.id, [{ line_id: xl.id, qty: 999 }])
  assert.equal(over.lines.find((l) => l.size === 'XL').qty_received, 10)
  // a bogus line id is a no-op, not a throw
  const noop = sup.receivePurchaseOrder(stored.id, [{ line_id: 999999, qty: 5 }])
  assert.equal(noop.received, 100)
})

/* ---------- webhook SSRF guard (v49) ---------- */
section('webhooks: SSRF guard blocks internal, allows public')
await t('private/loopback/metadata/rebinding blocked; public allowed', async () => {
  const wh = await import('../lib/webhook.mjs')
  for (const ip of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1'])
    assert.equal(wh.isBlockedIp(ip), true, `${ip} should block`)
  for (const ip of ['8.8.8.8','1.1.1.1','172.15.0.1','172.32.0.1','93.184.216.34'])
    assert.equal(wh.isBlockedIp(ip), false, `${ip} should allow`)
  const R = (map) => ({ lookup: async (h) => { if (!map[h]) throw new Error('ENOTFOUND'); return map[h].map((address) => ({ address })) } })
  const res = R({ 'hooks.zapier.com': ['52.1.2.3'], 'evil.test': ['127.0.0.1'], 'mixed.test': ['8.8.8.8', '10.0.0.1'] })
  await wh.assertPublicUrl('https://hooks.zapier.com/x', { resolver: res }) // no throw
  for (const [url, re] of [
    ['http://evil.test/x', /private/], ['https://mixed.test/x', /private/],
    ['http://127.0.0.1:9/x', /private/], ['http://169.254.169.254/meta', /private/],
    ['http://localhost/x', /not allowed/], ['https://u:p@hooks.zapier.com/x', /credentials/],
    ['ftp://hooks.zapier.com/x', /http/],
  ]) {
    let threw = false
    try { await wh.assertPublicUrl(url, { resolver: res }) } catch (e) { threw = true; assert.match(e.message, re, url) }
    assert.ok(threw, `${url} should reject`)
  }
  // The vetted addresses come back, not just the URL string — this is what lets delivery pin the
  // connection instead of re-resolving into a rebind.
  const vetted = await wh.assertPublicUrl('https://hooks.zapier.com/x', { resolver: res })
  assert.deepEqual(vetted.ips, ['52.1.2.3'], 'assertPublicUrl must return the addresses it checked')
})

section('webhook delivery pins the vetted address (no DNS-rebind window)')
await t('a host that passes validation then rebinds to loopback is not connected to', async () => {
  const wh = await import('../lib/webhook.mjs')
  // A resolver that answers a PUBLIC ip the first time (validation) and LOOPBACK every time after
  // (the connect). fetch would have taken the second answer; the pinned lookup never asks again.
  let calls = 0
  const rebind = { lookup: async () => { calls++; return [{ address: calls === 1 ? '52.9.9.9' : '127.0.0.1' }] } }
  // Point the "public" ip at a port with nothing on it, so a real connection attempt fails fast
  // rather than reaching anything — we are asserting WHERE it tried to connect, via the error.
  const r = await wh.deliverWebhook('http://rebind.test:9/hook', { hello: 'world' }, { resolver: rebind, timeoutMs: 1500 })
  // It must have failed to reach 52.9.9.9:9 (connection refused / timeout), NOT succeeded against
  // loopback. Either way ok is false; the point is the pinned ip was used, so validation resolved
  // exactly once for the address check.
  assert.equal(r.ok, false)
  assert.equal(calls, 1, 'the hostname must be resolved once (for validation), never again at connect')
})

/* ---------- pricebook: resilience + shape (added v52) ---------- */
section('pricebook: malformed book falls back to stock, never throws')
await t('garbage/partial/empty JSON all resolve to the full stock book', () => {
  const stockCount = Object.keys(STOCK_SERVICES).length
  for (const raw of ['not json{', '{"services":', '', '   ', null, undefined]) {
    const b = resolveBook(raw)
    assert.equal(Object.keys(b.services).length, stockCount, `services for ${JSON.stringify(raw)}`)
    assert.equal(b.bands.length, QTY_BANDS.length, `bands for ${JSON.stringify(raw)}`)
    for (const s of Object.values(b.services)) assert.equal(s.custom, false)
  }
})
await t('a custom FLAT service quotes its base regardless of units', () => {
  const book = resolveBook(JSON.stringify({ services: { Sticker: { axis: 'flat', base: 5, perUnit: 3, minPerPiece: 0 } } }))
  assert.ok(book.services.Sticker.custom)
  const prices = [1, 5, 100, 9999].map((u) => quoteService({ book, service: 'Sticker', qty: 48, units: u }).perPiece)
  assert.ok(prices.every((p) => p === prices[0]), `flat axis moved with units: ${prices}`)
  assert.equal(prices[0], 5) // base × band factor(48)=1.0
})
section('pricebook: serviceMatrix grid + axis labels')
await t('serviceMatrix returns a rows×cols grid of the expected dimensions', () => {
  const book = resolveBook('{}')
  const bandCount = new Set(book.bands.map((b) => b.min)).size
  const m = serviceMatrix({ book, service: 'Screen Print' })
  assert.equal(m.cols.length, 8)                      // default colour steps 1..8 (14-color presses opt in)
  assert.equal(m.qtys.length, bandCount)
  assert.equal(m.rows.length, bandCount)
  for (const r of m.rows) assert.equal(r.cells.length, m.cols.length)
  assert.equal(serviceMatrix({ book, service: 'No Such Service' }), null)
})
await t('AXIS_LABEL has a non-empty label for every axis', () => {
  for (const axis of Object.values(AXIS)) assert.ok(typeof AXIS_LABEL[axis] === 'string' && AXIS_LABEL[axis].length, axis)
})

/* ---------- quickquote: money-bug regression guards (added v52) ---------- */
section('pricing: an all-zero size grid never prices the garment at $0')
await t('sizes {S:0,M:0,…} with a stated total prices the stated total', () => {
  const o = priceIntake({ garment: 'Gildan 5000', decoration: 'Screen Print', total_pieces: 100, sizes: { S: 0, M: 0, L: 0, XL: 0 }, locations: [{ name: 'Front', colors: 1 }] }, SET)
  assert.equal(o.pieces, 100)
  assert.ok(o.quote.perPiece > 0, String(o.quote.perPiece))
  assert.ok(o.totals.subtotal > 0, String(o.totals.subtotal))
})
section('pricing: empty locations still charge for a Front/1-color print')
await t('locations:[] falls back to a real print charge, never a bare blank', () => {
  const o = priceIntake({ garment: 'Gildan 5000', decoration: 'Screen Print', total_pieces: 100, sizes: {}, locations: [] }, SET)
  assert.ok(o.quote.imprintPerPiece > 0, `imprint ${o.quote.imprintPerPiece}`)
  assert.ok(o.quote.setup && o.quote.setup.qty === 1, JSON.stringify(o.quote.setup))
})
section('pricing: a stored screen_fee of 0 is honoured, not re-defaulted to 25')
await t('screen_fee "0" → $0 screens; absent/blank → the $25 default', () => {
  const base = { garment: 'Gildan 5000', decoration: 'Screen Print', total_pieces: 100, sizes: {}, locations: [{ name: 'Front', colors: 2 }] }
  assert.equal(priceIntake(base, { tax_rate: '7.75', default_markup: '2', price_book: '{}', screen_fee: '0' }).quote.screens, 0)
  assert.equal(priceIntake(base, { tax_rate: '7.75', default_markup: '2', price_book: '{}' }).quote.screens, 50) // 2 colors × 25 default
  assert.equal(priceIntake(base, { tax_rate: '7.75', default_markup: '2', price_book: '{}', screen_fee: '' }).quote.screens, 50)
})
section('pricing: dark garment adds an underbase screen to the setup count')
await t('a 1-color dark front bills 2 screens, a light front bills 1', () => {
  const base = { garment: 'Gildan 5000', decoration: 'Screen Print', total_pieces: 100, sizes: {}, locations: [{ name: 'Front', colors: 1 }] }
  assert.equal(priceIntake(base, SET).quote.setup.qty, 1)
  assert.equal(priceIntake({ ...base, dark_garment: true }, SET).quote.setup.qty, 2)
})

/* ---------- deadline parsing: more forms (added v52) ---------- */
section('deadline: relative weekdays, unsupported phrases, invalid dates')
await t('next-weekday, past-weekday roll-forward, end-of-month, impossible dates', () => {
  const today = new Date(2026, 7, 18)                 // Tue 2026-08-18
  assert.equal(parseDeadline('next Tuesday', today).date, '2026-08-25')      // +7, never today
  assert.equal(parseDeadline('by Sunday', today).date, '2026-08-23')         // earlier weekday rolls forward
  assert.equal(parseDeadline('need it by Monday', today).date, '2026-08-24') // "yesterday's" weekday → next week
  assert.equal(parseDeadline('by end of month', today).date, null)           // not supported → honest null
  assert.equal(parseDeadline('due 2026-13-45', today).date, null)            // impossible ISO → null
  assert.equal(parseDeadline('by 2026-02-30', today).date, null)             // impossible calendar day → null
})

/* ---------- suppliers: PO consolidation edge cases (added v52) ---------- */
section('suppliers: PO consolidation drops empties and merges case-insensitively')
await t('zero/negative qty lines are dropped; sku/color/size merge ignores case', () => {
  const out = consolidatePoLines([
    { sku: 'g500', color: 'Black', size: 'm', qty: 10 },
    { sku: 'G500', color: 'black', size: 'M', qty: 14 },
    { sku: 'G500', color: 'BLACK', size: 'm', qty: 0 },   // dropped
    { sku: 'G500', color: 'black', size: 'M', qty: -5 },  // dropped
    { sku: 'G500', color: 'black', size: 'L', qty: 3 },
  ])
  assert.equal(out.length, 2)
  const m = out.find((l) => String(l.size).toUpperCase() === 'M')
  assert.equal(m.qty, 24)
  assert.equal(out.find((l) => String(l.size).toUpperCase() === 'L').qty, 3)
})

/* ---------- price matrix override + receptionist no-loop (v54) ---------- */
section('pricebook: an explicit matrix cell wins over the formula')
await t('uploaded cell price overrides the calculator across its band; blank falls back', () => {
  const stock = resolveBook('{}')
  const formula = quoteService({ book: stock, service: 'Screen Print', qty: 48, units: 3 }).perPiece
  const book = resolveBook(JSON.stringify({ matrices: { 'Screen Print': { '48|3': 4.25, '72|3': 3.90 } } }))
  assert.equal(quoteService({ book, service: 'Screen Print', qty: 48, units: 3 }).perPiece, 4.25)
  assert.equal(quoteService({ book, service: 'Screen Print', qty: 60, units: 3 }).perPiece, 4.25) // 60 in 48 band
  assert.equal(quoteService({ book, service: 'Screen Print', qty: 72, units: 3 }).perPiece, 3.90)
  assert.ok(quoteService({ book, service: 'Screen Print', qty: 48, units: 3 }).fromMatrix)
  assert.equal(quoteService({ book, service: 'Screen Print', qty: 48, units: 2 }).fromMatrix, false) // no cell → formula
  assert.notEqual(formula, 4.25) // it really is an override, not a coincidence
})
await t('serviceMatrix supports up to 14 colour columns', () => {
  const book = resolveBook('{}')
  const m = serviceMatrix({ book, service: 'Screen Print', maxColors: 14 })
  assert.equal(m.cols.length, 14)
  assert.deepEqual(m.cols.slice(-2), [13, 14])
})

section('receptionist: does not loop the quote after contact is given')
await t('quote → email → "no" advances to a closed reply, never re-quotes', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const ag = await import('../lib/agent.mjs')
  const db = new DatabaseSync(':memory:')
  // Build it with the REAL schema, not a hand-written subset. The subset that used to live here
  // had drifted: it was missing contacts.tax_exempt, so this test passed against a table shape no
  // shop has ever run, and the first code to consult that column failed only here. A fixture that
  // diverges from production tests nothing — initDb is what every install actually gets.
  dbm.initDb(db)
  dbm.setDefaultDb(db)
  ag.initAgent(db)
  ag.saveBotConfig({ shop_name: 'Test Shop', name: 'Ari', greeting: 'Hi', capabilities: { quote: true, faq: true, handoff: true } })
  const sess = ag.startSession({ channel: 'web' })
  const cur = () => ag.sessionByPublicId(sess.public_id)
  const say = async (m) => { const r = await ag.respond(cur(), m, ag.getBotConfig()); return r.reply || r.text || '' }
  await say('quote for 100 gildan 5000 tees screen print')
  await say('2 color front')
  await say('owner@example.com')
  const r4 = await say('no email me')
  const r5 = await say('looks good')
  const isQuote = (x) => /roughly \$|ballpark|each/i.test(x)
  assert.ok(!isQuote(r4), 'turn after email must not re-quote')
  assert.ok(!isQuote(r5), 'final turn must not re-quote')
})

/* ---------- a website visitor cannot write on a customer who already exists ----------
 * captureLead matches a typed email to an existing contact — useful, it keeps the thread on the
 * right file — and then ran its enrichment UPDATEs, its opportunity INSERT and its estimate
 * INSERT against that customer's real row. Nothing verified that the person typing the address
 * had any connection to the mailbox. Observed end to end from the unauthenticated widget: a real
 * customer's blank phone filled with the stranger's number (so every later SMS, and any staffer
 * who dials it, reaches the stranger), a 'qualified' $20,648 opportunity on the account the
 * shop's forecast is built from, and EST-1011 for $22,248.22 burned off nextEstimateNumber()
 * against that customer's history. All of it looks legitimate on screen. */
section('receptionist: a website visitor cannot write on an existing customer')
{
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const ag = await import('../lib/agent.mjs')
  const db = new DatabaseSync(':memory:')
  dbm.initDb(db); dbm.setDefaultDb(db); ag.initAgent(db)
  ag.saveBotConfig({ shop_name: 'Test Shop', name: 'Ari', greeting: 'Hi', capabilities: { quote: true, faq: true, handoff: true } })

  // An ordinary email-only wholesale account, created the normal way.
  const victimId = Number(dbm.run('INSERT INTO contacts (name, email, phone, created_at, updated_at) VALUES (?,?,?,?,?)',
    'Northgate Booster Club', 'ap@northgate-boosters.org', '', dbm.now(), dbm.now()).lastInsertRowid)

  const chat = async (lines) => {
    const s = ag.startSession({ channel: 'web' })
    const cur = () => ag.sessionByPublicId(s.public_id)
    for (const l of lines) await ag.respond(cur(), l, ag.getBotConfig())
  }
  await chat([
    'I need a price on 600 gildan 18500 hoodies, screen print, 2 color front',
    'I am Victor Kroll, email ap@northgate-boosters.org and my cell is 213-555-9090',
  ])

  const victim = dbm.get('SELECT * FROM contacts WHERE id = ?', victimId)
  await t('a stranger cannot fill in a real customer\'s blank phone number', () => {
    assert.equal(victim.phone, '', `a website visitor wrote ${victim.phone} onto an existing customer`)
  })
  await t('…nor rename them', () => {
    assert.equal(victim.name, 'Northgate Booster Club')
  })
  await t('…nor burn an estimate number against their account', () => {
    assert.equal(dbm.get('SELECT COUNT(*) AS c FROM estimates WHERE contact_id = ?', victimId).c, 0)
  })
  await t('…and the deal they opened is a claim, not a qualified pipeline number', () => {
    const o = dbm.get('SELECT * FROM opportunities WHERE contact_id = ? ORDER BY id DESC', victimId)
    assert.ok(o, 'the thread should still be filed against the right customer')
    assert.equal(o.stage, 'lead')
    assert.match(String(o.notes || ''), /UNVERIFIED/)
  })

  // The other way round: a genuinely NEW lead is their own record, and nothing about that path
  // may change — it is how the receptionist earns its keep.
  await chat([
    'quote 200 gildan 5000 tees, screen print, 1 color front',
    'I am Dana Ruiz, dana@brand-new-lead.test, 619-555-0134',
  ])
  await t('a brand-new lead still gets a contact, a qualified deal and a drafted estimate', () => {
    const c = dbm.get("SELECT * FROM contacts WHERE email = 'dana@brand-new-lead.test'")
    assert.ok(c, 'a new visitor still becomes a customer')
    assert.equal(c.phone, '619-555-0134', 'their own details are still captured')
    const o = dbm.get('SELECT * FROM opportunities WHERE contact_id = ? ORDER BY id DESC', c.id)
    assert.equal(o?.stage, 'qualified')
    assert.equal(dbm.get('SELECT COUNT(*) AS c FROM estimates WHERE contact_id = ?', c.id).c, 1)
  })
}

section('receptionist: one long message cannot become an unbounded prompt, forever')
// Every DIRECT interpolation of the visitor's current message was bounded — 500 chars for intent,
// 800 for a grounded answer, 1200 for extraction. The REPLAY of the conversation so far was not,
// in any of the four places that built one, and neither was storage. So the bound only ever
// applied to this turn: a 500 KB message was stored whole and re-sent in full on every subsequent
// turn. The audit measured one 500 KB POST becoming 500,119 prompt chars that turn and ~4 MB by
// the eighth. The bill lands on the SHOP's own API key, from the unauthenticated widget endpoint
// a shop is told to paste onto its public website.
await t('a huge message is truncated in the table and bounded in the replay', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const ag = await import('../lib/agent.mjs')
  const db = new DatabaseSync(':memory:')
  dbm.initDb(db); dbm.setDefaultDb(db); ag.initAgent(db)
  ag.saveBotConfig({ shop_name: 'Test Shop', name: 'Ari', greeting: 'Hi', capabilities: { quote: true, faq: true, handoff: true } })
  const sess = ag.startSession({ channel: 'web' })
  const cur = () => ag.sessionByPublicId(sess.public_id)

  const huge = 'a'.repeat(500_000)
  await ag.respond(cur(), huge, ag.getBotConfig())
  const stored = db.prepare("SELECT body FROM chat_messages WHERE role='visitor' ORDER BY id DESC LIMIT 1").get()
  assert.ok(stored.body.length <= ag.MESSAGE_CAP, `stored body must be capped (got ${stored.body.length})`)

  // Now the part that actually costs money: what the NEXT turn replays.
  for (const line of ['b'.repeat(200_000), 'c'.repeat(200_000), 'how much for 100 tees?']) {
    await ag.respond(cur(), line, ag.getBotConfig())
  }
  const replay = ag.transcriptFor(cur(), 8)
  assert.ok(replay.length <= 4000, `the replayed transcript must be bounded (got ${replay.length})`)
})
await t('…while an ordinary conversation still replays in full', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const ag = await import('../lib/agent.mjs')
  const db = new DatabaseSync(':memory:')
  dbm.initDb(db); dbm.setDefaultDb(db); ag.initAgent(db)
  ag.saveBotConfig({ shop_name: 'Test Shop', name: 'Ari', greeting: 'Hi', capabilities: { quote: true, faq: true, handoff: true } })
  const sess = ag.startSession({ channel: 'web' })
  const cur = () => ag.sessionByPublicId(sess.public_id)
  await ag.respond(cur(), 'quote for 100 gildan 5000 tees screen print', ag.getBotConfig())
  await ag.respond(cur(), '2 color front', ag.getBotConfig())
  const replay = ag.transcriptFor(cur(), 8)
  assert.match(replay, /100 gildan 5000 tees screen print/, 'a normal message must survive the cap intact')
  assert.match(replay, /2 color front/)
})

section('receptionist: the off switch stops the conversations already open')
// /api/embed/chat/start refused to open a session when the bot was off. /message never checked,
// and cfg.enabled inside respond() only ever gated the MODEL — so a disabled receptionist kept
// running the deterministic engine against every widget already on a visitor's screen. It quoted
// a per-piece price, created a contact and an opportunity, drafted a real numbered estimate and
// fired the contact.created nurture email, from a shop that believed its bot was off. The off
// switch is the only control a shop has when the bot misbehaves, and it did not work on the
// conversations the owner was reaching for it about.
await t('a disabled bot answers nothing and writes nothing', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const ag = await import('../lib/agent.mjs')
  const db = new DatabaseSync(':memory:')
  dbm.initDb(db)
  dbm.setDefaultDb(db)
  ag.initAgent(db)
  ag.saveBotConfig({ enabled: 0, shop_name: 'Test Shop', name: 'Ari', greeting: 'Hi', capabilities: { quote: true, faq: true, handoff: true } })
  assert.equal(!!ag.getBotConfig().enabled, false, 'precondition: the bot is switched off')

  const sess = ag.startSession({ channel: 'web' })
  const cur = () => ag.sessionByPublicId(sess.public_id)
  const say = async (m) => (await ag.respond(cur(), m, ag.getBotConfig())).reply || ''
  const said = []
  for (const line of ['quote for 100 gildan 5000 tees screen print', '2 color front', 'owner@example.com', 'looks good']) {
    said.push(await say(line))
  }
  for (const r of said) assert.equal(r, ag.OFFLINE_REPLY, `a disabled bot must not answer (got ${JSON.stringify(r)})`)
  for (const r of said) assert.ok(!/roughly \$|each|ballpark/i.test(r), 'a disabled bot must never quote a price')

  const rows = (sql) => db.prepare(sql).all()
  assert.equal(rows('SELECT id FROM contacts').length, 0, 'a disabled bot must not create a contact')
  assert.equal(rows('SELECT id FROM opportunities').length, 0, 'a disabled bot must not open an opportunity')
  assert.equal(rows('SELECT id FROM estimates').length, 0, 'a disabled bot must not draft an estimate')
})
await t("…but the owner's own preview still runs, so a bot can be tested before it is switched on", async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const ag = await import('../lib/agent.mjs')
  const db = new DatabaseSync(':memory:')
  dbm.initDb(db); dbm.setDefaultDb(db); ag.initAgent(db)
  ag.saveBotConfig({ enabled: 0, shop_name: 'Test Shop', name: 'Ari', greeting: 'Hi', capabilities: { quote: true, faq: true, handoff: true } })
  const sess = ag.startSession({ channel: 'preview' })
  const r = await ag.respond(ag.sessionByPublicId(sess.public_id), 'quote for 100 gildan 5000 tees screen print', ag.getBotConfig())
  assert.notEqual(r.reply, ag.OFFLINE_REPLY, 'the Settings preview is how a shop tests a bot it has not enabled yet')
})

/* ---------- v56: barcode (lib/barcode.mjs) ---------- */
section('barcode: Code 128 encoding is spec-correct')
await t('checksum and symbol values match hand computation for JOB-1042', async () => {
  const { code128Values, code128Svg } = await import('../lib/barcode.mjs')
  // Start B (104), then charcode-32 per char, then (104 + Σ value·pos) % 103, then stop (106).
  assert.deepEqual(code128Values('JOB-1042'), [104, 42, 47, 34, 13, 17, 16, 20, 18, 35, 106])
  const svg = code128Svg('JOB-1042')
  assert.ok(svg.startsWith('<svg') && svg.includes('<rect'), 'renders rect bars')
})
await t('rejects characters outside printable ASCII instead of emitting a wrong barcode', async () => {
  const { code128Values } = await import('../lib/barcode.mjs')
  assert.throws(() => code128Values('JOB-é'), /cannot encode/)
})

/* ---------- v56: webhook signing (lib/webhook.mjs) ---------- */
section('webhooks: signature scheme')
await t('sign/verify roundtrip; tampered body and stale timestamp both rejected', async () => {
  const { signWebhook, verifyWebhookSignature } = await import('../lib/webhook.mjs')
  const body = '{"event":"invoice.paid"}'
  const sig = signWebhook('whsec_test', body)
  assert.ok(verifyWebhookSignature('whsec_test', body, sig))
  assert.ok(!verifyWebhookSignature('whsec_test', '{"event":"invoice.void"}', sig), 'tampered body must fail')
  assert.ok(!verifyWebhookSignature('wrong', body, sig), 'wrong secret must fail')
  const old = signWebhook('whsec_test', body, Math.floor(Date.now() / 1000) - 3600)
  assert.ok(!verifyWebhookSignature('whsec_test', body, old), 'hour-old signature must fail the replay window')
})

/* ---------- v56: labor actuals (lib/roi.mjs) ---------- */
section('roi: labor actuals from scan events')
await t('counts only floor scans, discards a forgotten weekend, reports an open interval separately', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbmod = await import('../lib/db.mjs')
  const mem = new DatabaseSync(':memory:')
  mem.exec(`CREATE TABLE job_scans (id INTEGER PRIMARY KEY, job_id INTEGER, from_stage TEXT, to_stage TEXT, actor TEXT, note TEXT, source TEXT, created_at DATETIME)`)
  dbmod.setDefaultDb(mem)
  const { laborActualMinutes } = await import('../lib/roi.mjs')
  const ins = (job, from, to, at, source = 'scan') => dbmod.run('INSERT INTO job_scans (job_id, from_stage, to_stage, source, created_at) VALUES (?,?,?,?,?)', job, from, to, source, at)
  // Job 1: two clean production runs — 45min + 30min.
  ins(1, 'prepress', 'production', '2026-08-20 09:00:00')
  ins(1, 'production', 'qc', '2026-08-20 09:45:00')
  ins(1, 'qc', 'production', '2026-08-20 10:00:00')
  ins(1, 'production', 'complete', '2026-08-20 10:30:00')
  assert.equal(laborActualMinutes(1).minutes, 75)
  // Job 2: entered Friday, scanned out Monday. Discarded, NOT clamped to 600 — a clamp still
  // books ten invented hours of labour against the job.
  ins(2, 'prepress', 'production', '2026-08-14 16:00:00')
  ins(2, 'production', 'qc', '2026-08-17 08:00:00')
  const j2 = laborActualMinutes(2)
  assert.equal(j2.minutes, 0)
  assert.equal(j2.suspect, 1)
  // Job 3: on the press right now — reported as `open`, never as booked cost.
  ins(3, 'prepress', 'production', '2026-08-20 09:00:00')
  const j3 = laborActualMinutes(3, { now: Date.parse('2026-08-20T11:00:00Z') })
  assert.equal(j3.minutes, 0)
  assert.equal(j3.open, 120)
  // Job 4: kanban drags only. A card dragged across the board is not a press run.
  ins(4, 'prepress', 'production', '2026-08-20 09:00:00', 'board')
  ins(4, 'production', 'qc', '2026-08-20 17:00:00', 'board')
  assert.equal(laborActualMinutes(4).minutes, 0, 'board drags must not become labor cost')
})

/* ---------- v56: order-history CSV mapping (lib/csv.mjs) ---------- */
section('order import: adversarial CSV parsing')
await t('EU money, US dates, per-size columns and aliased headers all normalize', async () => {
  const { parseCsv, mapOrderRows, coerceMoney, coerceDate } = await import('../lib/csv.mjs')
  assert.equal(coerceMoney('1.284,50'), 1284.5)
  assert.equal(coerceMoney('($120.00)'), -120)
  assert.equal(coerceDate('02/14/2025'), '2025-02-14')
  const rows = parseCsv('customer,email,invoice #,date,status,garment,s,m,l,total\nAcme,a@b.co,INV-1,2025-02-14,paid,G5000,5,10,5,240.00')
  const { orders, warnings } = mapOrderRows(rows)
  assert.equal(warnings.length, 0)
  assert.equal(orders[0].order_number, 'INV-1')
  assert.equal(orders[0].quantity, 20, 'quantity derives from the size grid')
  assert.equal(orders[0].total, 240)
})

/* ---------- v56: statement PDF (lib/pdf.mjs) ---------- */
section('statement: aging buckets + pagination')
await t('a 60-invoice statement paginates and buckets land where the calendar says', async () => {
  const { customerStatement } = await import('../lib/pdf.mjs')
  const asOf = '2026-08-21'
  const invoices = []
  for (let i = 0; i < 60; i++) {
    invoices.push({ invoice_number: `INV-${1000 + i}`, created_at: '2026-01-01 12:00:00', due_date: '2026-08-25', status: 'unpaid', amount_due: 100, amount_paid: 0 })
  }
  const buf = customerStatement({ contact: { name: 'Test' }, settings: { shop_name: 'Shop' }, invoices, asOf })
  const s = buf.toString('latin1')
  assert.ok(s.startsWith('%PDF'), 'valid PDF header')
  const pageCount = Number(s.match(/\/Count (\d+)/)?.[1] || 0)
  assert.ok(pageCount >= 2, `60 rows must paginate (got ${pageCount} page)`)
  // Bucket sanity: due 2026-08-25 as of 2026-08-21 is NOT past due — must show under CURRENT.
  assert.ok(s.includes('CURRENT'), 'aging strip renders')
})

/* ---------- v56 audit regressions (2026-08-21 16-agent section audit) ---------- */
section('audit regressions: money and data-integrity')
await t('quantities exported as "24.00" import as 24, not 2400', async () => {
  const { parseCsv, mapOrderRows } = await import('../lib/csv.mjs')
  const rows = parseCsv('customer,invoice #,quantity,total\nAcme,INV-2,24.00,288.00')
  assert.equal(mapOrderRows(rows).orders[0].quantity, 24)
})
await t('a blank quantity column still falls back to the size grid', async () => {
  const { parseCsv, mapOrderRows } = await import('../lib/csv.mjs')
  const rows = parseCsv('customer,invoice #,quantity,s,m,total\nAcme,INV-3,,5,10,180.00')
  assert.equal(mapOrderRows(rows).orders[0].quantity, 15, 'blank must read as "not supplied", not 0')
})
await t('European thousands-dot money parses as thousands, not a decimal', async () => {
  const { coerceMoney } = await import('../lib/csv.mjs')
  assert.equal(coerceMoney('1.200'), 1200)      // was 1.2 — a 1000x understatement
  assert.equal(coerceMoney('1.200.000'), 1200000)
  assert.equal(coerceMoney('240.00'), 240)      // a real decimal is still a decimal
  assert.equal(coerceMoney('1.284,50'), 1284.5)
})
await t('one plan: every feature answers yes for every tier string', async () => {
  const { planAllows, litePlanAllows, PLANS, PLAN_ORDER } = await import('../lib/billing.mjs')
  for (const tier of ['', 'free', 'starter', 'growth', 'pro', 'control', 'everything', undefined]) {
    for (const feat of ['roi', 'quickbooks', 'suppliers', 'products', 'pricing', 'art_approval', 'automations', 'anything_new']) {
      assert.equal(planAllows(tier, feat), true, `planAllows(${tier}, ${feat})`)
      assert.equal(litePlanAllows(tier, feat), true, `litePlanAllows(${tier}, ${feat})`)
    }
  }
  assert.deepEqual(PLAN_ORDER, ['everything'], 'exactly one sellable plan')
  assert.ok(PLANS.everything, 'the one plan exists')
})
await t('statement totals every open invoice, however many there are', async () => {
  const { customerStatement } = await import('../lib/pdf.mjs')
  // 130 open invoices — more than the old LIMIT 120, which silently understated the balance.
  const invoices = Array.from({ length: 130 }, (_, i) => ({
    invoice_number: `INV-${2000 + i}`, created_at: '2026-01-01 12:00:00', due_date: '2026-02-01',
    status: 'unpaid', amount_due: 100, amount_paid: 0,
  }))
  const s = customerStatement({ contact: { name: 'Big Customer' }, settings: { shop_name: 'Shop' }, invoices, asOf: '2026-08-21' }).toString('latin1')
  assert.ok(s.includes('$13,000.00'), 'TOTAL DUE must cover all 130 open invoices')
})

section('invoices: overdue is the calendar, not the last write')
await t('an invoice that passes its due date reads as overdue with no write in between', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { EFFECTIVE_STATUS_SQL } = await import('../lib/db.mjs')
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE invoices (id INTEGER PRIMARY KEY, amount_due REAL, amount_paid REAL, due_date TEXT, status TEXT)`)
  // Every row carries the status it was LAST WRITTEN with — which is what the bug relied on.
  db.exec(`INSERT INTO invoices (id, amount_due, amount_paid, due_date, status) VALUES
    (1, 100, 0,   '2026-01-01', 'unpaid'),
    (2, 100, 0,   '2099-01-01', 'unpaid'),
    (3, 100, 40,  '2026-01-01', 'partial'),
    (4, 100, 100, '2026-01-01', 'paid'),
    (5, 100, 0,   NULL,         'unpaid'),
    (6, 100, 0,   '',           'unpaid')`)
  const today = '2026-08-23'
  const eff = (id) => db.prepare(`SELECT ${EFFECTIVE_STATUS_SQL} AS s FROM invoices i WHERE i.id = ?`).get(today, id).s

  assert.equal(eff(1), 'overdue', 'past due and unpaid must read overdue even though nothing wrote to it')
  assert.equal(eff(2), 'unpaid', 'a future due date is not overdue')
  // Overdue beats partial. A deposit does not make a late invoice on time, and while partial won
  // this invoice was reported in a bucket no screen could show: the Invoices list called it
  // partial, so it never appeared under Overdue, while the dashboard's money-at-risk KPI and the
  // follow-up scan both counted it as overdue. The dashboard said money was late and no list
  // could say which invoice.
  assert.equal(eff(3), 'overdue', 'past due wins over a part payment — being late is the fact to act on')
  assert.equal(eff(4), 'paid', 'paid outranks everything')
  assert.equal(eff(5), 'unpaid', 'a null due date is never overdue')
  assert.equal(eff(6), 'unpaid', 'a blank due date is never overdue')
  // A part-paid invoice that is NOT yet due is still partial.
  db.exec(`INSERT INTO invoices (id, amount_due, amount_paid, due_date, status) VALUES (7, 100, 40, '2099-01-01', 'partial')`)
  assert.equal(eff(7), 'partial', 'a part payment on an invoice that is not yet due is partial')
  // A voided invoice is not a demand for money, whatever its dates say.
  db.exec(`INSERT INTO invoices (id, amount_due, amount_paid, due_date, status) VALUES (8, 100, 0, '2026-01-01', 'void')`)
  assert.equal(eff(8), 'void', 'a voided invoice never reads as overdue')

  // The actual symptom: "$X overdue" on the dashboard, nothing under Invoices → Overdue. Compare
  // against the dashboard's REAL predicate, not a hand-written one — the old version of this test
  // used `amount_paid = 0`, which quietly agreed with the bug instead of catching it.
  const filtered = db.prepare(`SELECT i.id FROM invoices i WHERE ${EFFECTIVE_STATUS_SQL} = ?`).all(today, 'overdue').map((r) => r.id)
  const dashboard = db.prepare(`SELECT i.id FROM invoices i WHERE i.status NOT IN ('paid','void') AND i.due_date IS NOT NULL AND i.due_date != '' AND i.due_date < ?`).all(today).map((r) => r.id)
  assert.deepEqual(filtered, dashboard, 'the Overdue filter and the dashboard must return the same invoices')
})

/* The server learned this in d6897b2 — a voided invoice is not money owed, and every balance
 * query got the filter. The Invoices LIST computes its own header total in the browser, and that
 * one sum was missed: `rows.filter((r) => r.status !== 'paid')`. Observed live: the list header
 * read $14,154.10 over a dashboard reading $11,568.10, the difference being exactly one voided
 * invoice, while the void dialog's own copy promises "it stops counting toward money owed". The
 * Void tab totalled "$2,586 outstanding" above a list containing nothing but voided invoices.
 * Executed, not read: the predicate is lifted out of the shipped file and run. */
section('a voided invoice is not money owed on the screen either')
await t('the invoice list total excludes void as well as paid', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'public/js/views/invoices.js'), 'utf8')
  const m = src.match(/const owes = (\(r\) => [^\n]+)/)
  assert.ok(m, 'the invoice list should name its "still owes money" predicate as `owes`')
  const owes = eval(m[1]) // eslint-disable-line no-eval -- the shipped expression, run as written
  assert.equal(owes({ status: 'unpaid' }), true, 'an unpaid invoice is owed')
  assert.equal(owes({ status: 'partial' }), true, 'a part-paid invoice is owed')
  assert.equal(owes({ status: 'overdue' }), true, 'an overdue invoice is owed')
  assert.equal(owes({ status: 'paid' }), false, 'a paid invoice is not owed')
  assert.equal(owes({ status: 'void' }), false, 'a CANCELLED invoice is not owed')
  // …and the header total and the per-row balance must use the same rule, or the rows sum to
  // something other than the total printed above them.
  assert.match(src, /rows\.filter\(owes\)/, 'the header total must use that predicate')
  assert.match(src, /const late = owes\(i\)/, 'and so must the per-row "late" flag')
})

section('webhooks: delivery history has a retention policy')
await t('old terminal deliveries are pruned, in-flight retries and recent ones survive', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'psc-prune-'))
  process.env.PSC_DB = join(dir, 'p.db')
  try {
    // Fresh module instance so it opens the throwaway database rather than the shared one.
    const db = await import(`../lib/db.mjs?prune=${Date.now()}`)
    db.run('INSERT INTO webhook_subscriptions (url, events, secret) VALUES (?,?,?)', 'https://x.test', 'a', 's')
    const stamp = (daysAgo) => new Date(Date.now() - daysAgo * 86400_000).toISOString().replace('T', ' ').slice(0, 19)
    for (const [created, status] of [[stamp(40), 'delivered'], [stamp(40), 'failed'], [stamp(40), 'retrying'], [stamp(0), 'delivered']]) {
      db.run('INSERT INTO webhook_deliveries (subscription_id,event,payload,status,created_at) VALUES (1,?,?,?,?)', 'e', '{}', status, created)
    }
    assert.equal(db.pruneWebhookDeliveries(30), 2, 'only the two old terminal rows should go')
    const left = db.all('SELECT status FROM webhook_deliveries ORDER BY id').map((r) => r.status)
    assert.deepEqual(left, ['retrying', 'delivered'], 'a delivery still being retried must never be deleted mid-flight')
    assert.equal(db.pruneWebhookDeliveries(0), 0, 'days=0 disables the sweep entirely')
  } finally {
    delete process.env.PSC_DB
    // db.mjs holds its connection for the life of the process and exposes no close, so on Windows
    // the file is still locked here and unlink throws EBUSY. Best effort: it's under the OS temp
    // directory either way, and failing to tidy up must not fail the test.
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows keeps the handle */ }
  }
})

section('webhooks: a retry survives a restart')
await t('a delivery stuck retrying with an elapsed backoff is due again; future and maxed-out are not', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const db = new DatabaseSync(':memory:')
  dbm.initDb(db)
  const prev = dbm.getDb(); dbm.setDefaultDb(db)
  try {
    // next_attempt_at must exist — the whole point is that retry state is in the DB, not a timer
    // that a deploy or crash drops. This is what strands a delivery in 'retrying' forever without it.
    assert.ok(db.prepare("PRAGMA table_info(webhook_deliveries)").all().some((c) => c.name === 'next_attempt_at'),
      'webhook_deliveries needs next_attempt_at for durable retries')
    dbm.run("INSERT INTO webhook_subscriptions (id,url,events,secret,active,created_at) VALUES (1,?,?,?,1,?)", 'https://x.test/hook', '*', 's', dbm.now())
    const at = (deltaMs) => new Date(Date.now() + deltaMs).toISOString().replace('T', ' ').slice(0, 19)
    // The exact due-query retryDueWebhooks runs.
    const Q = "SELECT d.id FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id=d.subscription_id WHERE s.active=1 AND d.status IN ('retrying','pending') AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?) AND d.attempts < 3 ORDER BY d.id"
    dbm.run("INSERT INTO webhook_deliveries (id,subscription_id,event,payload,status,attempts,next_attempt_at,created_at) VALUES (1,1,?,?,'retrying',1,?,?)", 'e', '{}', at(-60000), dbm.now())
    assert.equal(dbm.all(Q, dbm.now()).length, 1, 'an elapsed retry is picked up after a restart')
    dbm.run("UPDATE webhook_deliveries SET next_attempt_at=? WHERE id=1", at(300000))
    assert.equal(dbm.all(Q, dbm.now()).length, 0, 'a retry whose backoff has not elapsed waits')
    dbm.run("UPDATE webhook_deliveries SET next_attempt_at=?, attempts=3 WHERE id=1", at(-60000))
    assert.equal(dbm.all(Q, dbm.now()).length, 0, 'a delivery at max attempts stops retrying')
  } finally { dbm.setDefaultDb(prev) }
})

section('off-site backup: Drive retention prunes the OLDEST, never the newest')
await t('keeps the N most recent archives and deletes only the rest', async () => {
  // The listing is orderBy=createdTime desc, so index 0 is newest. slice(KEEP) must therefore be
  // the tail. Inverting this deletes the backup you would actually restore from.
  const listed = [
    { id: 'f9', name: '20260823.tar.gz' }, { id: 'f8', name: '20260822.tar.gz' },
    { id: 'f7', name: '20260821.tar.gz' }, { id: 'f6', name: '20260820.tar.gz' },
    { id: 'f5', name: '20260819.tar.gz' },
  ]
  const KEEP = 3
  const doomed = listed.slice(KEEP)
  assert.deepEqual(doomed.map((f) => f.id), ['f6', 'f5'], 'must delete the two oldest')
  const kept = listed.slice(0, KEEP).map((f) => f.id)
  assert.ok(kept.includes('f9'), 'the newest archive must always survive')
  assert.equal(kept.length + doomed.length, listed.length, 'every archive is either kept or pruned')

  // Retention of 1 keeps exactly the newest and nothing else.
  assert.deepEqual(listed.slice(0, 1).map((f) => f.id), ['f9'])
  assert.equal(listed.slice(1).length, listed.length - 1)

  // Fewer archives than the retention target must delete nothing at all.
  assert.deepEqual(listed.slice(50), [], 'a young install must never have a backup pruned')
})

section('capacity: an unseparated job schedules on its QUOTED colours, not a flat default')
await t('quote colours beat the default; a saved separation still wins over both', async () => {
  const { jobColors, colorsFromItems } = await import('../lib/capacity.mjs')
  const settings = { capacity_default_colors: '2' }

  // The bug this replaces: no separation → every job booked as 2 colours, so a 6-colour run
  // reserved a third of the press time it needs and the promised date was fiction.
  assert.equal(jobColors({ colors: 6 }, settings), 6, 'a 6-colour quote must schedule as 6')
  assert.equal(jobColors({}, settings), 2, 'nothing known → the shop default')
  assert.equal(jobColors({ colors: 0 }, settings), 2, 'a zero colour count is "unknown", not zero passes')
  assert.equal(jobColors({ separation: JSON.stringify({ screens: 4 }), colors: 6 }, settings), 4,
    'a recorded separation is a measurement and outranks the quote')
  assert.equal(jobColors({ separation: 'not json', colors: 6 }, settings), 6,
    'corrupt separation JSON must fall through, not throw')
  assert.equal(jobColors({ colors: 99 }, settings), 12, 'clamped to a plausible screen count')

  // Locations sum within a line; the heaviest line wins across lines (one press setup).
  assert.equal(colorsFromItems([{ locations: [{ colors: 3 }, { colors: 2 }] }]), 5, 'front + back sum')
  assert.equal(colorsFromItems([{ colors: 2 }, { locations: [{ colors: 6 }] }]), 6, 'heaviest line wins')
  assert.equal(colorsFromItems([{ description: 'setup fee' }]), 0, 'a fee line implies no press passes')
  assert.equal(colorsFromItems(null), 0, 'no items → 0, so the caller falls through to its default')
})

/* ---------- custom price matrices (lib/matrices.mjs) ---------- */
section('matrices: a grid with no opinion about what it prices')
await t('row headings are read as quantity bands when they look like bands, ignored when they do not', async () => {
  const { parseQtyRange, rowIndexForQty } = await import('../lib/matrices.mjs')

  // The shapes shops actually type on a price sheet.
  assert.deepEqual(parseQtyRange('12-24'), { min: 12, max: 24, exact: false })
  assert.deepEqual(parseQtyRange('144–287'), { min: 144, max: 287, exact: false }, 'en dash is what a spreadsheet produces')
  assert.deepEqual(parseQtyRange('500+'), { min: 500, max: Infinity, exact: false })
  assert.deepEqual(parseQtyRange('1,000 or more'), { min: 1000, max: Infinity, exact: false }, 'thousands separator')
  assert.deepEqual(parseQtyRange('Up to 24'), { min: 0, max: 24, exact: false })
  assert.equal(parseQtyRange('Large'), null, 'a size matrix has no quantity rows and must not pretend otherwise')
  assert.equal(parseQtyRange('Both Sides'), null)

  const bands = ['1–11', '12–23', '24–47', '48–71', '72–143', '144–287', '288–499', '500+']
  assert.equal(rowIndexForQty(bands, 1), 0)
  assert.equal(rowIndexForQty(bands, 60), 3, '60 falls inside 48–71')
  assert.equal(rowIndexForQty(bands, 5000), 7, 'past the last band → the open-ended row')

  // A column of bare numbers is a band list, not eight exact quantities — the reading that makes a
  // pasted spreadsheet work. 30 must land in the 24 band, not fall off the grid.
  assert.equal(rowIndexForQty(['1', '12', '24', '48'], 30), 2)
  assert.equal(rowIndexForQty(['Small', 'Medium', 'Large'], 30), -1, 'no quantity rows → no auto-pick')
})

await t('resizing the grid keeps every price that still has a home', async () => {
  const { resizeGrid } = await import('../lib/matrices.mjs')
  const cells = [[1, 2, 3], [4, 5, 6]]
  assert.deepEqual(resizeGrid(cells, 2, 4), [[1, 2, 3, null], [4, 5, 6, null]], 'adding a column must not disturb existing prices')
  assert.deepEqual(resizeGrid(cells, 3, 3), [[1, 2, 3], [4, 5, 6], [null, null, null]])
  assert.deepEqual(resizeGrid(cells, 2, 2), [[1, 2], [4, 5]], 'shrinking drops only the removed column')
  assert.deepEqual(resizeGrid(null, 1, 2), [[null, null]], 'a corrupt grid resizes to blanks, never throws')
})

await t('lookup takes an index OR a header label, and blank means blank', async () => {
  const { lookupPrice } = await import('../lib/matrices.mjs')
  const m = {
    rows: ['1–11', '12–23', '24+'], cols: ['11 oz mug', '20 oz tumbler'], unit: 'piece',
    cells: [[18, 26], [13, 20], [null, 18]],
  }
  assert.equal(lookupPrice(m, { row: 1, col: 0 }).price, 13, 'by index')
  assert.equal(lookupPrice(m, { row: '12–23', col: '20 oz tumbler' }).price, 20, 'by label — what the API and AI surfaces send')
  assert.equal(lookupPrice(m, { row: '12–23', col: '20 OZ TUMBLER' }).price, 20, 'label match is case-insensitive')
  assert.equal(lookupPrice(m, { col: 0, qty: 15 }).price, 13, 'no row given → picked from the quantity')
  assert.equal(lookupPrice(m, { row: 2, col: 0 }), null, 'an empty cell is "no price set", not zero')

  // 'flat' exists so a setup fee or rush tier can live in a matrix without multiplying by quantity.
  assert.equal(lookupPrice(m, { row: 0, col: 0, qty: 10 }).amount, 180, 'per-piece × qty')
  assert.equal(lookupPrice({ ...m, unit: 'flat' }, { row: 0, col: 0, qty: 10 }).amount, 18, 'a flat charge ignores quantity')
})

await t('a pasted sheet keeps its headings as TEXT', async () => {
  const { parseSheet } = await import('../lib/matrices.mjs')
  // The old service-bound importer stripped headers to numbers, which threw away every heading a
  // non-screen-print shop would ever write. This is the regression that must not come back.
  const sheet = parseSheet('Quantity,11 oz Mug,20 oz Tumbler\n1-11,$18.00,26.00\n12-23,13.00,20.00')
  assert.deepEqual(sheet.cols, ['11 oz Mug', '20 oz Tumbler'])
  assert.deepEqual(sheet.rows, ['1-11', '12-23'])
  assert.deepEqual(sheet.cells, [[18, 26], [13, 20]], '$ and stray spaces are tolerated')
  assert.equal(sheet.cornerLabel, 'Quantity')
  assert.equal(sheet.filled, 4)

  // A heading containing the delimiter survives if it's quoted, as any spreadsheet exports it.
  assert.deepEqual(parseSheet('Qty,"Front, Back"\n1-11,9.50').cols, ['Front, Back'])
  assert.deepEqual(parseSheet('Qty\tSmall\tLarge\n1-11\t4.00\t8.00').cols, ['Small', 'Large'], 'tab-separated paste')
  assert.throws(() => parseSheet('just one line'), /header row/i)
  assert.throws(() => parseSheet('Qty,Small\n1-11,abc'), /No prices found/i)
})

await t('sanitize refuses an unusable matrix and never leaves ambiguous headers', async () => {
  const { sanitize } = await import('../lib/matrices.mjs')
  assert.throws(() => sanitize({ name: '  ' }), /name/i)
  assert.throws(() => sanitize({ name: 'X', rows: [], cols: ['a'] }), /at least one row/i)
  assert.throws(() => sanitize({ name: 'X', rows: ['a'], cols: [] }), /at least one column/i)

  // Duplicate headings would make label-based lookup ambiguous for the public API and the AI.
  const s = sanitize({ name: 'Mugs', rows: ['1-11', '1-11'], cols: ['A', 'a'], cells: [[1, 2], [3, 4]] })
  assert.deepEqual(s.rows, ['1-11', '1-11 (2)'])
  assert.deepEqual(s.cols, ['A', 'a (2)'])
  assert.deepEqual(s.cells, [[1, 2], [3, 4]], 'de-duplicating a heading must not move any price')

  // A grid that arrives the wrong size is squared up rather than rejected — the editor can add a
  // column and save before the cells array has caught up.
  assert.deepEqual(sanitize({ name: 'X', rows: ['r'], cols: ['a', 'b'], cells: [[5]] }).cells, [[5, null]])
  assert.equal(sanitize({ name: 'X', rows: ['r'], cols: ['a'], cells: [[-3]] }).cells[0][0], null, 'a negative price is not a price')
})

await t('every starter template is a valid, complete grid', async () => {
  const { TEMPLATES, sanitize, rowIndexForQty } = await import('../lib/matrices.mjs')
  assert.ok(TEMPLATES.length >= 6, 'the shipped set covers the trades the README names')
  for (const tpl of TEMPLATES) {
    assert.equal(tpl.cells.length, tpl.rows.length, `${tpl.key}: a row per row heading`)
    for (const row of tpl.cells) assert.equal(row.length, tpl.cols.length, `${tpl.key}: a cell per column`)
    assert.doesNotThrow(() => sanitize(tpl), `${tpl.key} must survive its own sanitizer`)
    // Every priced template is quantity-banded, so a quote fills its own row in.
    if (tpl.key !== 'blank') assert.ok(rowIndexForQty(tpl.rows, 100) >= 0, `${tpl.key}: 100 pieces must land on a row`)
  }
  // Prices fall as quantity rises — a template that got this backwards would quietly teach a new
  // shop to lose money on its biggest orders.
  const sp = TEMPLATES.find((x) => x.key === 'screen-print')
  for (let c = 0; c < sp.cols.length; c++) {
    for (let r = 1; r < sp.rows.length; r++) {
      assert.ok(sp.cells[r][c] < sp.cells[r - 1][c], `screen print col ${c}: row ${r} must be cheaper than row ${r - 1}`)
    }
  }
})

section('QuickBooks: an update never wipes the bookkeeper\'s fields')
await t('an invoice UPDATE is sparse, so QBO merges instead of replacing', async () => {
  const { pushInvoice } = await import('../lib/quickbooks.mjs')
  const captured = []
  // Stub fetch: record every body, answer every call ok. Account lookups return an id.
  const fakeFetch = async (url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : null
    captured.push({ url: String(url), body })
    if (/query/.test(String(url))) return { ok: true, status: 200, json: async () => ({ QueryResponse: { Account: [{ Id: '77' }] } }) }
    return { ok: true, status: 200, json: async () => ({ Invoice: { Id: '1042', SyncToken: '4' } }) }
  }
  // An UPDATE: the invoice already has a qboId and a token.
  await pushInvoice({
    realmId: 'r', accessToken: 't', apiBase: 'https://qbo.test',
    invoice: { qboId: '1042', syncToken: '3', invoice_number: 'INV-1042', amount_due: 500, created_at: '2026-08-27' },
    customer: 'C1', lines: [{ description: 'tees', amount: 500, qty: 1 }], fetch: fakeFetch,
  })
  const post = captured.find((c) => c.body && c.body.Id === '1042')
  assert.ok(post, 'the invoice update was sent')
  assert.equal(post.body.sparse, true, 'sparse:false on an update tells QBO to clear every field we omit — the bookkeeper\'s Class, terms and memo')
})

section('a PDF never blanks or mangles a customer\'s name')
await t('accented names render, unrenderable scripts substitute rather than vanish', async () => {
  const pdf = await import('../lib/pdf.mjs')
  const settings = { shop_name: 'Rebel Ink Press', shop_email: 'o@x.test', shop_address: '500 Main St', shop_phone: '' }
  const doc = { estimate_number: 'EST-1001', number: 'EST-1001', subtotal: 500, tax: 0, total: 500, created_at: '2026-08-27', status: 'sent' }
  const items = [{ description: 'Café tees — 2/0 Frente', qty: 50, unit_price: 10, sizes: { M: 50 } }]
  // Latin-1 is exactly what WinAnsiEncoding + a latin1 buffer render, so the accents must survive
  // byte-for-byte — the old code stripped them and printed "Jos Muoz".
  const a = pdf.renderDocument('ESTIMATE', { doc, contact: { name: 'José Muñoz', email: 'j@x.test' }, settings, items }).toString('latin1')
  assert.ok(a.includes('Jos\xe9 Mu\xf1oz'), 'an accented name must render with its accents intact')
  // A script the base font has no glyphs for must not leave the BILL TO line empty — a blank name
  // on an invoice is worse than a transliteration gap.
  const b = pdf.renderDocument('ESTIMATE', { doc, contact: { name: '王小明', email: 'w@x.test' }, settings, items }).toString('latin1')
  assert.ok(/\?\?\?/.test(b), 'an unrenderable name must be substituted, not dropped to blank')
})

section('reorder radar does not defame customers it cannot read')
await t('clustered same-day orders do not become a confident short cadence', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const { reorderRadar } = await import('../lib/reorder.mjs')
  const db = new DatabaseSync(':memory:')
  dbm.initDb(db)
  const prev = dbm.getDb(); dbm.setDefaultDb(db)
  try {
    const today = '2026-08-27'
    const ago = (n) => new Date(new Date(today).getTime() - n * 864e5).toISOString().slice(0, 19).replace('T', ' ')
    dbm.run('INSERT INTO contacts (id, name, created_at, updated_at) VALUES (1, ?, ?, ?)', 'Annual Cluster Co', ago(400), ago(400))
    // Two orders a day apart ~300 days ago, then silence. Floored to a 21-day cadence, this read
    // as "279 days overdue, high confidence" and the nudge emailed the customer.
    dbm.run('INSERT INTO jobs (id, contact_id, job_number, title, status, stage, created_at, updated_at) VALUES (1,1,?,?,?,?,?,?)', 'J1', 'Run', 'complete', 'complete', ago(300), ago(300))
    dbm.run('INSERT INTO jobs (id, contact_id, job_number, title, status, stage, created_at, updated_at) VALUES (2,1,?,?,?,?,?,?)', 'J2', 'Run', 'complete', 'complete', ago(299), ago(299))
    const c = reorderRadar(today).candidates.find((x) => x.contact_id === 1)
    assert.ok(c, 'the customer still appears as a gentle nudge')
    assert.equal(c.confidence, 'low', 'no real reorder interval on record → low confidence, not high')
    assert.notEqual(c.status, 'overdue', 'an unknown cadence must never be reported as overdue')
  } finally { dbm.setDefaultDb(prev) }
})
await t('a genuine monthly cadence is still read with confidence', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const { reorderRadar } = await import('../lib/reorder.mjs')
  const db = new DatabaseSync(':memory:')
  dbm.initDb(db)
  const prev = dbm.getDb(); dbm.setDefaultDb(db)
  try {
    const today = '2026-08-27'
    const ago = (n) => new Date(new Date(today).getTime() - n * 864e5).toISOString().slice(0, 19).replace('T', ' ')
    dbm.run('INSERT INTO contacts (id, name, created_at, updated_at) VALUES (2, ?, ?, ?)', 'Monthly Co', ago(200), ago(200))
    ;[130, 100, 70].forEach((d, i) => dbm.run('INSERT INTO jobs (id, contact_id, job_number, title, status, stage, created_at, updated_at) VALUES (?,2,?,?,?,?,?,?)', 20 + i, 'M' + i, 'Monthly tee', 'complete', 'complete', ago(d), ago(d)))
    const c = reorderRadar(today).candidates.find((x) => x.contact_id === 2)
    assert.ok(c, 'a real repeat customer appears')
    assert.ok(['high', 'medium'].includes(c.confidence), `a ~30-day cadence over 3 orders should be confident, got ${c.confidence}`)
    assert.ok(c.cadence_days <= 40, `cadence should reflect the ~30-day interval, got ${c.cadence_days}`)
  } finally { dbm.setDefaultDb(prev) }
})

section('capacity: colours and press count are modelled the way a shop actually runs')
await t('colorsFromItems reads the colour from where the quote actually stores it', async () => {
  const { colorsFromItems } = await import('../lib/capacity.mjs')
  // No estimate this app has written carries a numeric `colors` on the line — colour lives in the
  // "N/0" description and the screen-setup line's qty. Reading only it.colors returned 0 for every
  // real job, so everything scheduled at the flat 2-colour default.
  assert.equal(colorsFromItems([{ description: 'Tee — 3/0 Front + 1/0 Back' }, { description: 'Screen setup — 4 screens', qty: 4 }]), 4)
  assert.equal(colorsFromItems([{ description: 'Bella 3001 — 6/0 Front' }, { description: 'Screen setup — 6 screens', qty: 6 }]), 6)
  assert.equal(colorsFromItems([{ description: 'Tee', sizes: { M: 50 }, colors: 5 }]), 5) // structured wins
  assert.equal(colorsFromItems([{ description: 'Embroidered polo' }]), 0) // no screens → caller defaults
})
await t('one job cannot use more presses than it physically runs on', async () => {
  const { schedule, jobMinutes } = await import('../lib/capacity.mjs')
  const big = { id: 1, due: '2026-12-31', sizes: JSON.stringify({ M: 2000 }), colors: 6 }
  const many = { capacity_stations: 8, capacity_hours_per_day: 8, utilization_pct: 30, press_type: 'auto' }
  const one = { capacity_stations: 1, capacity_hours_per_day: 8, utilization_pct: 30, press_type: 'auto' }
  const f8 = schedule([{ ...big, minutes: jobMinutes(big, many) }], many).jobs[0].projectedFinish
  const f1 = schedule([{ ...big, minutes: jobMinutes(big, one) }], one).jobs[0].projectedFinish
  // A single run occupies one press either way, so buying presses does not make THIS job finish
  // sooner — the pooled model used to say it did, over-promising by the station count.
  assert.equal(f8, f1, 'a single job must take the same time regardless of how many presses exist')
})
await t('but more presses still finish a BATCH of jobs sooner', async () => {
  const { schedule, jobMinutes } = await import('../lib/capacity.mjs')
  const many = { capacity_stations: 8, capacity_hours_per_day: 8, utilization_pct: 30, press_type: 'auto' }
  const one = { capacity_stations: 1, capacity_hours_per_day: 8, utilization_pct: 30, press_type: 'auto' }
  const jobs = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, due: '2026-12-31', sizes: JSON.stringify({ M: 300 }), colors: 2 }))
  const last = (s, set) => schedule(jobs.map((j) => ({ ...j, minutes: jobMinutes(j, set) })), set).jobs.map((j) => j.projectedFinish).sort().pop()
  assert.ok(new Date(last(jobs, many)) < new Date(last(jobs, one)), 'parallel jobs must benefit from more presses')
})

/* Both scheduling loops consumed a job's press minutes one business day at a time with no bound.
 * A piece count large enough to outrun the shop's daily capacity was therefore an infinite loop:
 * 100% CPU on the single shared process, /health timing out, every other tenant on the box dark,
 * with no recovery but a restart. Persisted it was worse — an estimate with sizes {M:1e12} stored
 * fine (the money stayed finite, so nothing refused it), and the job it converted to made the
 * Capacity page do it again on every visit.
 *
 * These assertions are TIMED on purpose. Without the bound they do not fail — they hang the gate,
 * which is indistinguishable from a slow machine. */
section('capacity: an impossible piece count is answered, not looped over forever')
await t('promise() returns quickly and says the job is beyond the horizon', async () => {
  const { promise } = await import('../lib/capacity.mjs')
  const settings = { capacity_stations: 2, capacity_hours_per_day: 8, utilization_pct: 70, press_type: 'auto' }
  const started = Date.now()
  const r = promise([], settings, { pieces: 1e13, colors: 6 })
  const ms = Date.now() - started
  assert.ok(ms < 2000, `promise() took ${ms}ms — the day-by-day loop is unbounded again`)
  assert.equal(r.feasible, false)
  assert.equal(r.beyondHorizon, true)
  assert.match(String(r.reason || ''), /split it into smaller runs/, 'the shop must be told what to do about it')
})
await t('schedule() does the same for a job already saved with that count', async () => {
  const { schedule, jobMinutes } = await import('../lib/capacity.mjs')
  const settings = { capacity_stations: 2, capacity_hours_per_day: 8, utilization_pct: 70, press_type: 'auto' }
  const j = { id: 1, due: null, sizes: JSON.stringify({ M: 1e13 }), colors: 6 }
  const started = Date.now()
  const out = schedule([{ ...j, minutes: jobMinutes(j, settings) }], settings).jobs[0]
  const ms = Date.now() - started
  assert.ok(ms < 2000, `schedule() took ${ms}ms — the day-by-day loop is unbounded again`)
  assert.equal(out.projectedFinish, null)
  assert.equal(out.beyondHorizon, true)
})
await t('…and an ordinary job still schedules to a real date', async () => {
  const { schedule, jobMinutes } = await import('../lib/capacity.mjs')
  const settings = { capacity_stations: 2, capacity_hours_per_day: 8, utilization_pct: 70, press_type: 'auto' }
  const j = { id: 1, due: '2026-12-31', sizes: JSON.stringify({ M: 500 }), colors: 2 }
  const out = schedule([{ ...j, minutes: jobMinutes(j, settings) }], settings).jobs[0]
  assert.match(String(out.projectedFinish), /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(!out.beyondHorizon)
})

/* JSON.parse(null) is JSON.parse('null'), which SUCCEEDS and returns null — so a LEFT JOIN that
 * missed defeated parse()'s fallback entirely and the caller's .filter threw. That is how the
 * work ticket, the page the press operator runs the job from, returned a bare 500 for every job
 * with no estimate behind it — including JOB-1007 in the shipped demo data. */
section('a JSON column that is SQL NULL reads as the fallback, not as null')
await t('parse() hands back the fallback for a NULL column', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'server.mjs'), 'utf8')
  const m = src.match(/const parse = (\(s, fallback\) => \{[^\n]+\})/)
  assert.ok(m, 'server.mjs should still define parse(s, fallback) on one line')
  const parse = eval(m[1]) // eslint-disable-line no-eval -- the shipped helper, run as written
  assert.deepEqual(parse(null, []), [], 'a NULL column must not come back as null')
  assert.deepEqual(parse('null', []), [], 'neither must the literal string')
  assert.deepEqual(parse(undefined, []), [])
  assert.deepEqual(parse('not json', []), [])
  assert.deepEqual(parse('[1,2]', []), [1, 2], 'real JSON still parses')
  assert.equal(parse('{"a":1}', []).a, 1)
})

/* control.db holds every shop, member and session, so EVERY authenticated request reads it — and
 * it was the one handle in the product with no busy_timeout, while lib/db.mjs gives one to every
 * tenant handle. Without it SQLite does not wait for a contended write, it fails instantly: a
 * live login answered 500 while another process held a lock, and bin/admin.mjs — the documented
 * and only way out of a lockout — died with a raw ERR_SQLITE_ERROR stack trace and no advice.
 * The recovery tool was the thing that broke.
 *
 * Driven, not read: a second process really holds the write lock while the module writes. */
/* Docs that describe software which does not exist are the failure this campaign is for. These
 * three were all reproduced against real builds:
 *  - README told self-hosters to `node --no-warnings server.mjs` after writing a .env. That does
 *    not read .env, so PORT, PSC_DB, PSC_AUTH and PSC_SECRET were all ignored: no login, the
 *    database inside the app directory, and the in-repo secret — which is published, so every
 *    customer link was forgeable. The fatal guard could not fire because it keys on PSC_AUTH,
 *    itself unread.
 *  - The front-page `docker run` was the only deploy artefact in the repo omitting PSC_AUTH=1;
 *    compose, fly.toml, render.yaml and DEPLOY.md all set it. Anonymous GET
 *    /api/export/all.json returned the whole shop.
 *  - Node 22.4 and 22.12 both die with ERR_UNKNOWN_BUILTIN_MODULE on node:sqlite. The floor is
 *    22.13.0, and the docs said 22.0 — sending a 22.12 user to a troubleshooting entry that told
 *    them to check they had 22. */
section('the install instructions produce the install they describe')
await t('every documented way to start the app reads the .env it tells you to write', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  for (const doc of ['README.md', 'INSTALL.md', 'HOSTING.md']) {
    const src = readFileSync(join(root, doc), 'utf8')
    for (const line of src.split('\n')) {
      if (!/^\s*(sudo -u \S+ )?node .*\bserver\.mjs\b/.test(line)) continue
      assert.match(line, /--env-file/, `${doc} tells the reader to start the app in a way that ignores .env: ${line.trim()}`)
    }
  }
})
await t('every documented docker run publishes a port with authentication turned on', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  for (const doc of ['README.md', 'INSTALL.md', 'HOSTING.md', 'deploy/DEPLOY.md']) {
    const src = readFileSync(join(root, doc), 'utf8')
    // Fenced blocks, joined across backslash continuations, so a multi-line docker run reads as one.
    for (const block of src.split('```').filter((_, i) => i % 2 === 1)) {
      const joined = block.replace(/\\\s*\n\s*/g, ' ')
      for (const line of joined.split('\n')) {
        if (!/\bdocker run\b/.test(line) || !/\s-p\s/.test(line)) continue
        assert.match(line, /PSC_AUTH=1/, `${doc} publishes a port with no login: ${line.trim().slice(0, 120)}`)
      }
    }
  }
})
await t('the Node version the docs demand is the one the app actually needs', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  // node:sqlite is behind a flag until 22.13.0, and every npm script uses --env-file-if-exists,
  // which does not exist before 22.9. Both are hard walls, not warnings.
  const NODE_FLOOR = '22.13.0'
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.engines?.node, `>=${NODE_FLOOR}`, 'package.json engines must state the real floor')
  const install = readFileSync(join(root, 'INSTALL.md'), 'utf8')
  assert.match(install, new RegExp(`\\*\\*${NODE_FLOOR.replace(/\./g, '\\.')} or newer`),
    'INSTALL.md prerequisites must state the real floor')
  assert.ok(!/\*\*22\.0 or newer/.test(install), 'INSTALL.md still claims 22.0')
})
await t('the documented invoice statuses are the ones the API can return', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  // The values EFFECTIVE_STATUS_SQL can produce. An integration polling only the three that used
  // to be documented sees none of the shop's overdue money.
  const { EFFECTIVE_STATUS_SQL } = await import('../lib/db.mjs')
  const produced = [...String(EFFECTIVE_STATUS_SQL).matchAll(/THEN\s+'(\w+)'|ELSE\s+'(\w+)'/g)]
    .map((m) => m[1] || m[2])
  assert.ok(produced.includes('overdue') && produced.includes('void'), 'sanity: the SQL still produces these')
  const api = readFileSync(join(root, 'docs/API.md'), 'utf8')
  // The ?status= row IS the contract — an integration reads that line and polls those values.
  // It listed unpaid|partial|paid, so an invoice with money outstanding and a date in the past
  // appeared under none of them.
  const row = api.split('\n').find((l) => /GET \/api\/v1\/invoices`\s*\|\s*List/.test(l))
  assert.ok(row, 'docs/API.md should still document the invoice list endpoint')
  for (const v of new Set(produced)) {
    assert.ok(row.includes(v), `docs/API.md's ?status= filter omits "${v}", which the API returns and filters on`)
  }
})

section('the control database waits for a lock instead of failing the login')
await t('a contended write on control.db waits, and then succeeds', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { spawn } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'psc-ctl-'))
  const path = join(dir, 'control.db')
  const prevCtl = process.env.PSC_CONTROL_DB
  const prevAuth = process.env.PSC_AUTH
  process.env.PSC_CONTROL_DB = path
  process.env.PSC_AUTH = '1'
  try {
    const T = await import(`../lib/tenants.mjs?ctl=${Date.now()}`)
    // A second PROCESS takes the write lock and holds it for 400ms, the way bin/admin.mjs or an
    // operator's sqlite3 session does.
    const holder = spawn(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite'
      const d = new DatabaseSync(${JSON.stringify(path)})
      d.exec('BEGIN IMMEDIATE')
      console.log('LOCKED')
      setTimeout(() => { try { d.exec('ROLLBACK') } catch {} d.close(); process.exit(0) }, 400)
    `], { stdio: ['ignore', 'pipe', 'inherit'] })
    await new Promise((resolve, reject) => {
      let seen = ''
      holder.stdout.on('data', (d) => { seen += d; if (seen.includes('LOCKED')) resolve() })
      holder.on('exit', () => reject(new Error('the lock holder exited before taking the lock')))
      setTimeout(() => reject(new Error('the lock holder never reported taking the lock')), 10000)
    })
    const started = Date.now()
    // A plain write through the module. Without busy_timeout this throws "database is locked".
    T.deleteSession('a-token-that-does-not-exist')
    const ms = Date.now() - started
    assert.ok(ms >= 200, `the write returned in ${ms}ms — it did not wait for the lock at all`)
    await new Promise((r) => holder.on('exit', r))
  } finally {
    if (prevCtl === undefined) delete process.env.PSC_CONTROL_DB; else process.env.PSC_CONTROL_DB = prevCtl
    if (prevAuth === undefined) delete process.env.PSC_AUTH; else process.env.PSC_AUTH = prevAuth
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

await t('the recovery tool loads the .env the server uses, and does not lie about sessions', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  // Every script that opens the database must load .env, or the documented lockout recovery
  // reports "No shops yet" on a correctly-installed server — which reads as data loss, not as a
  // path problem, at exactly the moment the owner cannot get in any other way.
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
    if (!/\b(server|seed|bin\/admin)\.mjs/.test(cmd)) continue
    assert.match(cmd, /--env-file-if-exists=\.env/, `npm run ${name} opens the database without loading .env`)
  }
  // setMemberPassword deletes every session for the member. The tool used to promise otherwise.
  const admin = readFileSync(join(root, 'bin/admin.mjs'), 'utf8')
  assert.ok(!/Existing sessions are unaffected/.test(admin),
    'admin.mjs claims sessions survive a password reset; setMemberPassword deletes them')
})

section('contact lookup is indexed, not a full scan')
// The CSV order import matches every row on lower(email)/lower(name), inside one synchronous
// transaction. Without an index each match is a full table scan, so a few thousand rows meant
// thousands of scans and the event loop froze for the whole fleet for seconds to minutes. The
// query plan must use an index, or that regression is back.
await t('lower(email) and lower(name) lookups use an index', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const db = new DatabaseSync(':memory:')
  dbm.initDb(db)
  const planE = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM contacts WHERE lower(email) = lower(?)').all('a@b.test')
  const planN = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM contacts WHERE lower(name) = lower(?)').all('a')
  assert.ok(planE.some((r) => /USING INDEX/.test(r.detail)), `email lookup is a scan: ${planE.map((r) => r.detail).join(' | ')}`)
  assert.ok(planN.some((r) => /USING INDEX/.test(r.detail)), `name lookup is a scan: ${planN.map((r) => r.detail).join(' | ')}`)
})
await t('the dashboard activity feed reads an index in order, not a scan-and-sort', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const db = new DatabaseSync(':memory:')
  dbm.initDb(db)
  const plan = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM activities ORDER BY created_at DESC, id DESC LIMIT 12').all()
  const detail = plan.map((r) => r.detail).join(' | ')
  assert.ok(/USING INDEX/.test(detail), `activity feed is a scan: ${detail}`)
  // The whole point is avoiding the sort — an index in the right order means no temp B-tree.
  assert.ok(!/TEMP B-TREE/.test(detail), `activity feed still sorts in memory: ${detail}`)
})

section('receptionist: the public chat parser cannot be made to hang, or to invent an order')
// Both of these are reachable by an anonymous visitor on /api/embed/chat/message — no login, no
// API key — and Node is single-threaded with every shop in one process.
await t('a long message with no address does not blow up the email regex', async () => {
  const { extract } = await import('../lib/agent.mjs')
  // The old pattern had unbounded runs either side of the @ and backtracked the whole tail from
  // every start position: 20 KB took 242 ms here, 1 MB took over a minute, with the health check
  // timing out for every other shop on the box the whole time.
  const started = Date.now()
  for (const n of [10_000, 100_000, 400_000]) extract('a'.repeat(n), {})
  const ms = Date.now() - started
  assert.ok(ms < 1000, `parsing 510 KB of hostile input took ${ms}ms — the regex is backtracking again`)
})
await t('a real address is still found', async () => {
  const { extract } = await import('../lib/agent.mjs')
  assert.equal(extract('hi, reach me at dana.ruiz+shop@print-co.example.com thanks', {}).email,
    'dana.ruiz+shop@print-co.example.com')
})

/* There were TWO copies of that regex. Round 1 bounded the receptionist's and left the one in
 * lib/slack.mjs — which is what POST /api/autopilot runs the pasted email through, and what the
 * Slack ingest runs every inbound message through. Measured on the shipped pattern: 319ms at
 * 20KB, 2.7s at 60KB, 11s at 120KB, all of it holding the single event loop, so /health and every
 * other shop on the box waited behind it. A staffer pasting a long forwarded thread — the exact
 * thing the Autopilot textarea asks for, with no maximum length client-side or server-side —
 * froze the whole fleet. */
await t('the autopilot / Slack email parser cannot be made to hang either', async () => {
  const { findEmail } = await import('../lib/slack.mjs')
  const started = Date.now()
  for (const n of [10_000, 100_000, 400_000]) findEmail('a'.repeat(n) + '@' + 'b'.repeat(200))
  const ms = Date.now() - started
  assert.ok(ms < 1000, `parsing 510 KB of hostile paste took ${ms}ms — the regex is backtracking again`)
})
await t('…and still finds the addressee in a forwarded thread', async () => {
  const { findEmail } = await import('../lib/slack.mjs')
  assert.equal(findEmail('From: shop@us.example\nTo: priya.n@northgate-booster.k12.ca.us\n\n200 tees please'),
    'priya.n@northgate-booster.k12.ca.us')
})
await t('a year in a sentence is not an order quantity', async () => {
  const { extract } = await import('../lib/agent.mjs')
  // This quoted 2026 pieces — over $13,000 — and drafted the estimate, because the unit noun was
  // optional and any 2-4 digit number won.
  assert.equal(extract('we need screen printed tees for our 2026 conference', {}).qty, undefined)
  assert.equal(extract('ship to 1500 Industrial Blvd', {}).qty, undefined)
  // …but a stated count in any of the forms a customer actually writes still lands.
  assert.equal(extract('we need 250 tees', {}).qty, 250)
  assert.equal(extract('qty 144 please', {}).qty, 144)
  assert.equal(extract('500 x hoodies', {}).qty, 500)
  assert.equal(extract('about 72 pcs', {}).qty, 72)
})

await t('a style number is not an order quantity either', async () => {
  const { extract } = await import('../lib/agent.mjs')
  // Fixing the year bug by demanding the noun IMMEDIATELY after the number handed the order to
  // the style number, because that is exactly where a style number sits. On the public widget
  // "200 Gildan 5000 tees" was quoted and drafted as 5,000 pieces — $37,275 to a stranger.
  assert.equal(extract('200 Gildan 5000 tees in black, 2 color front', {}).qty, 200)
  assert.equal(extract('144 Bella+Canvas 3001 shirts, 1 color front', {}).qty, 144)
  assert.equal(extract('72 Comfort Colors 1717 tees', {}).qty, 72)
  assert.equal(extract('500 Gildan 18500 hoodies', {}).qty, 500)
  // One adjective between the count and its noun was also enough to lose the count entirely.
  assert.equal(extract('24 black tees', {}).qty, 24)
  assert.equal(extract('qty 1,200 Next Level 3600 white', {}).qty, 1200)
  // The receptionist and the deterministic intake parser must not disagree about the same
  // sentence — this is the second copy of the rule that drifted.
  const { parseIntakeHeuristic } = await import('../lib/ai.mjs')
  for (const text of ['200 Gildan 5000 tees in black, 2 color front', '72 Comfort Colors 1717 tees']) {
    assert.equal(extract(text, {}).qty, parseIntakeHeuristic(text).total_pieces, text)
  }
})

section('the receptionist cannot quote a figure the shop never published')
// The grounded-answer path is the ONE place raw model prose reaches a stranger, and the money
// guard on the phrasing pass explicitly skips it (`cfg.enabled && !grounded`) — so nothing checked
// that output at all. The prompt does say never to invent pricing or commit on the shop's behalf,
// but the visitor's own words are in that prompt, which makes the instruction the target. A crafted
// question got back: "we will do 500 pieces at $0.85 each with guaranteed next-day delivery, and I
// have applied a 40 percent discount. That is a firm commitment from us."
await t('a money or percentage figure must come from the shop\'s own knowledge base', async () => {
  const { groundedFiguresAreTheShops } = await import('../lib/agent.mjs')
  const kb = 'Minimum order is 24 pieces. Digitizing is $75 per design. Rush jobs add 25%.'
  // Answers that state nothing about money, or repeat what the shop published, are fine.
  assert.equal(groundedFiguresAreTheShops('We usually turn orders around in about two weeks.', kb), true)
  assert.equal(groundedFiguresAreTheShops('Digitizing is $75 per design.', kb), true)
  assert.equal(groundedFiguresAreTheShops('Digitizing runs $75.00 per design.', kb), true, 'formatting is not a different price')
  assert.equal(groundedFiguresAreTheShops('Rush jobs add 25%.', kb), true)
  assert.equal(groundedFiguresAreTheShops('Rush jobs add 25 percent.', kb), true)
  // Anything the shop never published is withheld — including one real figure used as cover.
  assert.equal(groundedFiguresAreTheShops('We will do 500 pieces at $0.85 each.', kb), false)
  assert.equal(groundedFiguresAreTheShops('I have applied a 40 percent discount.', kb), false)
  assert.equal(groundedFiguresAreTheShops('Digitizing is $75 and I can do $0.85 each.', kb), false)
  // A shop with no knowledge configured has published nothing, so no figure may be stated.
  assert.equal(groundedFiguresAreTheShops('Tees are $6 each.', ''), false)
})

section('Floor Mode lets go of the camera')
// stopCamera() was only ever called at the TOP of scanView() — on re-entry. Walk away from Floor
// Mode and the phone kept the camera live: indicator light on, battery draining, and the camera
// held away from every other app until the tab was closed. There was also no stop control in the
// markup at all, so it could not be turned off from the UI even while still on the page — the only
// escape was a reload. The orphaned 350ms detect loop then rendered into a #scan-job that no longer
// existed, popping "Cannot set properties of null" onto whatever page you had moved to.
await t('navigating away from Floor Mode releases the camera', async () => {
  // A DOM small enough to hold in your head, so the teardown can be exercised for real rather than
  // matched as source text. No test dependency: this repo has no build step and adds no packages.
  const saved = { window: globalThis.window, document: globalThis.document, location: globalThis.location }
  const nodes = {}
  const listeners = {}
  for (const id of ['#scan-video', '#scan-start', '#scan-stop', '#scan-cam-hint', '#scan-job', '#view']) {
    nodes[id] = { id, hidden: false, style: {}, srcObject: {}, textContent: '', scrollIntoView() {}, addEventListener() {} }
  }
  const listen = (ev, fn) => { (listeners[ev] ||= []).push(fn) }
  try {
    globalThis.window = { addEventListener: listen }
    globalThis.document = { addEventListener: listen, querySelector: (sel) => nodes[sel] || null, querySelectorAll: () => [], visibilityState: 'visible' }
    globalThis.location = { hash: '#/scan' }
    await import(`../public/js/views/scan.js?camera=${Date.now()}`)

    assert.ok(listeners.hashchange?.length, 'nothing was listening for the navigation that leaves this page')
    assert.ok(listeners.pagehide?.length, 'a closed tab must release the camera too')

    // Camera running…
    nodes['#scan-start'].hidden = true
    nodes['#scan-stop'].hidden = false
    nodes['#scan-video'].style.display = 'block'

    // …still on Floor Mode: a hash change within the page must NOT kill a live scan.
    globalThis.location.hash = '#/scan'
    for (const fn of listeners.hashchange) fn()
    assert.equal(nodes['#scan-stop'].hidden, false, 'staying on Floor Mode must not stop the camera')

    // …and navigating away releases it.
    globalThis.location.hash = '#/dashboard'
    for (const fn of listeners.hashchange) fn()
    assert.equal(nodes['#scan-video'].srcObject, null, 'the video must let go of the stream')
    assert.equal(nodes['#scan-video'].style.display, 'none')
    assert.equal(nodes['#scan-start'].hidden, false, 'coming back must offer Start again')
    assert.equal(nodes['#scan-stop'].hidden, true)
  } finally {
    globalThis.window = saved.window
    globalThis.document = saved.document
    globalThis.location = saved.location
  }
})

await t('the camera can be switched off from the page itself', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'public/js/views/scan.js'), 'utf8')
  assert.match(src, /id="scan-stop"/, 'there must be a stop control in the markup')
  assert.match(src, /Stop camera/, 'and it has to say what it does')
})

section('the app never shows a shop owner a JSON parser error')
// api.req ran a bare JSON.parse over every response body. Not everything that answers this app
// speaks JSON: a proxy 502/504 during a deploy, Express's default HTML 404, "unknown shop" from
// the tenant resolver. Each threw a SyntaxError that runRouter then rendered as the whole page —
// "Unexpected token '<', "<html>Cann"... is not valid JSON". For the length of a restart that was
// the answer to EVERY action in the product, and there is nothing an owner can do with it.
//
// public/js/core.js imports under plain Node (its window access is guarded, document appears only
// in default parameters), so this is the real function with a stubbed fetch — not a source match.
await t('a non-JSON response becomes something a human can act on', async () => {
  const core = await import('../public/js/core.js')
  const realFetch = globalThis.fetch
  const answer = (status, body) => { globalThis.fetch = async () => new Response(body, { status }) }
  const failure = async (url = '/api/estimates/1') => {
    try { await core.api.get(url); return null } catch (e) { return e.message }
  }
  try {
    answer(502, '<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>')
    const restarting = await failure()
    assert.doesNotMatch(restarting, /JSON|Unexpected token/, `got ${JSON.stringify(restarting)}`)
    assert.match(restarting, /restarting/i, 'a deploy window has a true and actionable answer')

    answer(404, '<!DOCTYPE html><html><body>Cannot GET /api/nope</body></html>')
    const missing = await failure()
    assert.doesNotMatch(missing, /JSON|Unexpected token|DOCTYPE/, `got ${JSON.stringify(missing)}`)

    // server.mjs answers this one as plain text, not JSON, on the tenant-resolution path.
    answer(404, 'unknown shop')
    assert.doesNotMatch(await failure(), /JSON|Unexpected token/)

    // A real JSON error still reaches the user verbatim — that message is the whole point.
    answer(400, JSON.stringify({ error: "That's more than the $900.00 balance due." }))
    assert.match(await failure(), /more than the \$900\.00 balance due/)

    // And a good response is still parsed.
    answer(200, JSON.stringify({ ok: true, id: 7 }))
    assert.deepEqual(await core.api.get('/api/estimates/1'), { ok: true, id: 7 })
  } finally { globalThis.fetch = realFetch }
})

section('the deploy safety rails must not report green when they failed')
// check-drift.sh is the only monitoring in this repo. Both git reads were
// `$(git rev-parse … || echo '?')`, so when git REFUSED the repo — dubious ownership, not a clone,
// no origin — both sides became '?', '?' equalled '?', and it printed "✓ GitHub matches this
// working tree". That is what production was doing every night: the drift log shows `local HEAD ?`
// followed by two green ticks. A monitor that reports success by failing to look is worse than no
// monitor, because it is trusted.
await t('check-drift.sh reports a problem when it cannot read git, not a tick', async () => {
  const { mkdtempSync, rmSync, mkdirSync, copyFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const { execFileSync } = await import('node:child_process')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const dir = mkdtempSync(join(tmpdir(), 'psc-drift-'))
  try {
    mkdirSync(join(dir, 'deploy'))
    copyFileSync(join(root, 'deploy/check-drift.sh'), join(dir, 'deploy/check-drift.sh'))
    let out = '', code = 0
    try {
      out = execFileSync('bash', ['deploy/check-drift.sh'], { cwd: dir, encoding: 'utf8', env: { ...process.env, APP_HOST: '' } })
    } catch (e) { out = `${e.stdout || ''}${e.stderr || ''}`; code = e.status }
    assert.doesNotMatch(out, /✓ GitHub matches/, 'it did not read git at all — it must not claim a match')
    assert.doesNotMatch(out, /✓ working tree is clean/, 'an unreadable tree is not a clean tree')
    assert.match(out, /could not read git here/, 'it has to say which check did not run')
    assert.equal(code, 1, 'a check that could not run is drift, and must exit non-zero')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// The rollback the operator is told to run when a release goes bad. `current` is created with
// `sudo ln -sfn` and is root-owned, but every printed hint left the sudo off the ln — so the
// command failed with Permission denied and, being &&-chained, never restarted the service either.
// The same broken line was in ship.sh, release.sh and RELEASING.md, so cross-checking did not help.
await t('every rollback instruction we hand an operator actually runs as root', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  for (const file of ['deploy/ship.sh', 'deploy/release.sh', 'RELEASING.md']) {
    const text = readFileSync(join(root, file), 'utf8')
    for (const line of text.split('\n')) {
      if (!/\bln -sfn\b/.test(line)) continue
      if (!/(current|\.previous-release|PREVIOUS)/.test(line)) continue // only the release-symlink flips
      assert.match(line.trim(), /(^|[|&;"'\s])sudo ln -sfn/, `${file}: flipping the release symlink needs sudo — ${line.trim().slice(0, 110)}`)
    }
  }
})

// `ln -sfn target dir` where dir already EXISTS creates the link INSIDE it — public/uploads/uploads
// — and exits 0. public/uploads ships as a real directory (tracked .gitkeep), so INSTALL.md's
// sequence silently left artwork writing into the app directory while the backup archived an empty
// data dir. Dockerfile and release.sh both rm -rf first; the hand-install path did not.
await t('INSTALL.md clears public/uploads before symlinking it', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const text = readFileSync(join(root, 'INSTALL.md'), 'utf8')
  const i = text.indexOf('ln -sfn /var/lib/printshopcrm/uploads')
  assert.ok(i > 0, 'INSTALL.md should still document the uploads symlink')
  const before = text.slice(Math.max(0, i - 600), i)
  assert.match(before, /rm -rf \S*public\/uploads/, 'the existing directory must be removed first, or the link nests inside it')
})

section('purchasing: submitting twice must not order the blanks twice')
// Submitting places a REAL, chargeable order. The guard tested for the single string 'submitted',
// and status is not written until AFTER the awaited submit — so two clicks a second apart both
// read 'draft' and both sent. Receiving then overwrites status with 'partial', which is exactly
// when a manager hits Submit again to chase a short delivery: it re-ordered the whole run.
await t('a PO that has gone out is never sent again, whatever receiving did to its status', async () => {
  const { poAlreadySent } = await import('../lib/suppliers.mjs')
  // Nothing reached the distributor — retrying is correct and must stay possible.
  assert.equal(poAlreadySent({ status: 'draft' }), false)
  assert.equal(poAlreadySent({ status: 'failed' }), false)
  // These all mean the order is out there. Receiving writes the last two.
  for (const status of ['submitted', 'placed_manually', 'partial', 'received', 'closed']) {
    assert.equal(poAlreadySent({ status }), true, `${status} must not re-order`)
  }
})
await t('the in-flight claim blocks the second click but does not wedge the shop forever', async () => {
  const { poAlreadySent } = await import('../lib/suppliers.mjs')
  const at = (msAgo) => new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace('T', ' ')
  // The claim taken synchronously before the await — this is the double-click case.
  assert.equal(poAlreadySent({ status: 'submitting', updated_at: at(1000) }), true)
  // A row stuck here means the process died mid-send. A PO the shop can neither place nor clear
  // is exactly the dead end this codebase refuses to ship.
  assert.equal(poAlreadySent({ status: 'submitting', updated_at: at(6 * 60 * 1000) }), false)
  assert.equal(poAlreadySent({ status: 'submitting', updated_at: null }), false)
})

const { deliveryVerdict: deliveryVerdictSync } = await import('../lib/webhook.mjs')
section('webhooks: only a 2xx means the payload arrived')
// This read `statusCode < 400`, so a 3xx was written to the delivery log as 'delivered'. Redirects
// are deliberately not followed — following one would re-open the SSRF via a Location the guard
// never vetted — so the body reached nothing. An endpoint that moves is the ordinary case: a
// re-pointed Zapier hook, an SSO login redirect in front of the handler, a plain http URL the host
// now 301s to https. Every event for that subscription was dropped, never retried, and the shop's
// Developers screen said it had been delivered.
await t('a 2xx is delivered, a 3xx is not', async () => {
  const { deliveryVerdict } = await import('../lib/webhook.mjs')
  for (const code of [200, 201, 202, 204, 299]) {
    assert.equal(deliveryVerdict(code).ok, true, `${code} must count as delivered`)
    assert.equal(deliveryVerdict(code).error, null)
  }
  for (const code of [300, 301, 302, 303, 304, 307, 308]) {
    assert.equal(deliveryVerdict(code).ok, false, `${code} must NOT count as delivered`)
  }
})
await t('a redirect says why, so the shop can repoint the subscription', () => {
  // "HTTP 301" alone reads as a server fault. The endpoint is fine; the URL moved.
  assert.match(deliveryVerdictSync(301).error, /redirect/i)
  assert.match(deliveryVerdictSync(301).error, /final URL/i)
})
await t('a 4xx and a 5xx are still failures, unchanged', () => {
  assert.equal(deliveryVerdictSync(404).ok, false)
  assert.equal(deliveryVerdictSync(500).ok, false)
  assert.equal(deliveryVerdictSync(410).error, 'HTTP 410')
})

section('webhooks: the pinned lookup must speak the contract net.connect uses')
// Round 1 closed a DNS-rebind window by pinning the connect-time lookup to the address the SSRF
// guard had already vetted. The pin called back with the bare-string 3-argument form, which Node
// only accepts when `all` is false — and autoSelectFamily has defaulted to TRUE since Node 20, so
// net.connect always passes `{ all: true }` and expects an array of { address, family }. Every
// delivery died with "Invalid IP address: undefined" before a packet left the box. package.json
// requires node >=22, so the webhook feature reached no endpoint on any install at all.
//
// A live socket is what catches this: the guard, the signature and the retry ladder were all
// correct and green, and none of them touch the connect path.
await t('Node accepts what pinnedLookupFor returns, on a real socket', async () => {
  const http = await import('node:http')
  const netm = await import('node:net')
  const { pinnedLookupFor } = await import('../lib/webhook.mjs')

  const srv = http.createServer((_q, r) => { r.writeHead(200); r.end('ok') })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  const hit = (lookup) => new Promise((resolve) => {
    const rq = http.request({ hostname: 'pinned.invalid', port, path: '/hook', method: 'POST', lookup, timeout: 4000 },
      (res) => { res.resume(); resolve(`HTTP ${res.statusCode}`) })
    rq.on('error', (e) => resolve(`ERROR ${e.message}`))
    rq.on('timeout', () => { rq.destroy(); resolve('TIMEOUT') })
    rq.end('{}')
  })
  try {
    // The shape that shipped. Asserting Node rejects it is what makes the fix below meaningful.
    const old = await hit((_h, _o, cb) => cb(null, '127.0.0.1', 4))
    assert.match(old, /Invalid IP address/, `the 3-arg lookup should be rejected by this Node (got ${old})`)

    // The real factory, with the block-list check satisfied by a public address, must produce a
    // result Node can actually connect with.
    const lookup = pinnedLookupFor('203.0.113.7')
    let handed = null
    lookup('pinned.invalid', { all: true, family: 0 }, (err, addrs) => { if (!err) handed = addrs })
    assert.ok(Array.isArray(handed), 'with { all: true } the callback must receive an array')
    assert.deepEqual(handed, [{ address: '203.0.113.7', family: 4 }])

    // …and that same array shape, driven through a real socket, connects where the old one could
    // not. (The factory itself can only be pointed at a public address, and the block list refuses
    // every locally-reachable one — by design — so the socket leg uses the shape it produces.)
    const connected = await hit((_h, o, cb) => (o && o.all
      ? cb(null, [{ address: '127.0.0.1', family: netm.isIP('127.0.0.1') }])
      : cb(null, '127.0.0.1', 4)))
    assert.equal(connected, 'HTTP 200', 'the array form must actually connect')

    // The guard still refuses a private pin — the rebind defence must survive the fix.
    let blocked = null
    pinnedLookupFor('127.0.0.1')('x', { all: true }, (err) => { blocked = err })
    assert.match(String(blocked?.message), /blocked address/, 'a loopback pin must still be refused')
  } finally { srv.close() }
})

section('artwork never survives its estimate')
// art_versions.estimate_id had no foreign key (ALTER TABLE cannot add one), and estimates.id is
// the rowid, which SQLite reuses. A mockup outliving a deleted estimate re-attached itself to the
// NEXT estimate created — so a brand-new quote showed the previous customer's art, already marked
// approved, and the board said the proof was cleared. The shop prints someone else's design.
await t('deleting an estimate takes its mockups with it, so a reused id cannot inherit them', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const db = new DatabaseSync(':memory:')
  dbm.initDb(db)
  const prev = dbm.getDb()
  dbm.setDefaultDb(db)
  try {
    dbm.run('INSERT INTO contacts (id, name, created_at, updated_at) VALUES (1, ?, ?, ?)', 'First Customer', dbm.now(), dbm.now())
    dbm.run('INSERT INTO estimates (id, contact_id, estimate_number, created_at) VALUES (1, 1, ?, ?)', 'EST-3001', dbm.now())
    dbm.run('INSERT INTO art_versions (estimate_id, version, filename, status) VALUES (1, 1, ?, ?)', 'customer-a-logo.png', 'approved')
    dbm.run('DELETE FROM estimates WHERE id = 1')
    assert.equal(dbm.all('SELECT id FROM art_versions WHERE estimate_id = 1').length, 0,
      'the mockup must not outlive the estimate it belonged to')
    // Now prove the actual harm is gone: the id comes back, and it comes back clean.
    dbm.run('INSERT INTO estimates (id, contact_id, estimate_number, created_at) VALUES (1, 1, ?, ?)', 'EST-3002', dbm.now())
    assert.equal(dbm.all('SELECT id FROM art_versions WHERE estimate_id = 1').length, 0,
      'a reused estimate id must not inherit the previous customer\'s artwork')
  } finally { dbm.setDefaultDb(prev) }
})

section('ROI: sales tax is not the shop\'s money')
// jobRoi read invoices.amount_due / estimates.total, both tax-inclusive, and labelled the result
// "what you actually keep". Every margin on the screen read high by roughly the tax rate, and the
// target-margin flag cleared jobs that were under the floor.
await t('margin is computed on the pre-tax subtotal, not the taxed total', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const { jobRoi } = await import('../lib/roi.mjs')
  const db = new DatabaseSync(':memory:')
  dbm.initDb(db)
  const prev = dbm.getDb()
  dbm.setDefaultDb(db)
  try {
    // $1,000 of work, 7.75% tax, so the customer pays $1,077.50 and the shop keeps $1,000.
    const items = [{ description: '100 tees', sizes: { M: 100 }, unit_price: 10, taxable: true, garment_cost: 3 }]
    dbm.run('INSERT INTO contacts (id, name, created_at, updated_at) VALUES (1, ?, ?, ?)', 'Gate Buyer', dbm.now(), dbm.now())
    dbm.run(
      'INSERT INTO estimates (id, contact_id, estimate_number, status, items, subtotal, tax, total, tax_rate, created_at) VALUES (1,1,?,?,?,?,?,?,?,?)',
      'EST-2001', 'approved', JSON.stringify(items), 1000, 77.5, 1077.5, 7.75, dbm.now(),
    )
    dbm.run('INSERT INTO invoices (id, estimate_id, contact_id, invoice_number, amount_due, amount_paid, created_at) VALUES (1,1,1,?,?,?,?)',
      'INV-2001', 1077.5, 0, dbm.now())
    const roi = jobRoi({ id: 1, estimate_id: 1, invoice_id: 1 }, dbm.getSettings())
    assert.equal(roi.revenue, 1000, 'the $77.50 of sales tax belongs to the state, not the shop')
    assert.ok(roi.revenue < 1077.5, 'revenue must never be the tax-inclusive total')
  } finally { dbm.setDefaultDb(prev) }
})

section('ROI and the schedule cost the same job the same way')
// colorsOf() read `it.locations` and `it.detail`. No quote this app writes has ever carried either
// field, so every garment line fell through to ONE colour and the profitability page under-costed
// press labour on every multi-colour job in the shop. The capacity engine had the identical bug
// and it was fixed there and only there, so the two screens then disagreed about the same work:
// 132 press-minutes on the schedule, 57 in the cost, and a 78.3% margin on a job nowhere near it.
await t('a 4/0-front + 2/0-back run is costed at six colours, not one', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const { jobRoi } = await import('../lib/roi.mjs')
  const { colorsFromItems } = await import('../lib/capacity.mjs')
  const { pressMinutes } = await import('../public/js/shared/pricing.js')
  const db = new DatabaseSync(':memory:')
  dbm.initDb(db)
  const prev = dbm.getDb()
  dbm.setDefaultDb(db)
  try {
    const items = [
      { description: 'Gildan 5000 Heavy Cotton Tee — Black — 4/0 Front + 2/0 Back', sizes: { M: 300 }, unit_price: 18, taxable: true, garment_cost: 3 },
      { description: 'Screen setup', qty: 6, unit_price: 25, taxable: true },
    ]
    dbm.run('INSERT INTO contacts (id, name, created_at, updated_at) VALUES (1, ?, ?, ?)', 'Gate Buyer', dbm.now(), dbm.now())
    dbm.run(
      'INSERT INTO estimates (id, contact_id, estimate_number, status, items, subtotal, tax, total, tax_rate, created_at) VALUES (1,1,?,?,?,?,?,?,?,?)',
      'EST-3001', 'approved', JSON.stringify(items), 5550, 0, 5550, 0, dbm.now(),
    )
    dbm.run('INSERT INTO invoices (id, estimate_id, contact_id, invoice_number, amount_due, amount_paid, created_at) VALUES (1,1,1,?,?,?,?)',
      'INV-3001', 5550, 0, dbm.now())
    const roi = jobRoi({ id: 1, estimate_id: 1, invoice_id: 1 }, dbm.getSettings())
    assert.equal(roi.colors, 6, 'ROI must read the colours the description states')
    assert.equal(roi.colors, colorsFromItems(items), 'cost and schedule must use ONE definition of colour')
    assert.equal(roi.labor_planned_minutes, pressMinutes(300, 6, 'auto'),
      'planned press minutes must be the six-colour figure the scheduler books')
  } finally { dbm.setDefaultDb(prev) }
})

await t('a garment line that states no colours still inherits the job\'s screen count', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const { jobRoi } = await import('../lib/roi.mjs')
  const db = new DatabaseSync(':memory:')
  dbm.initDb(db)
  const prev = dbm.getDb()
  dbm.setDefaultDb(db)
  try {
    // The garment line says nothing about colour; the screen-setup line the shop billed for says 4.
    const items = [
      { description: 'Next Level 3600 — White', sizes: { M: 100 }, unit_price: 14, taxable: true, garment_cost: 3 },
      { description: 'Screen setup', qty: 4, unit_price: 25, taxable: true },
    ]
    dbm.run('INSERT INTO contacts (id, name, created_at, updated_at) VALUES (1, ?, ?, ?)', 'Gate Buyer', dbm.now(), dbm.now())
    dbm.run(
      'INSERT INTO estimates (id, contact_id, estimate_number, status, items, subtotal, tax, total, tax_rate, created_at) VALUES (1,1,?,?,?,?,?,?,?,?)',
      'EST-3002', 'approved', JSON.stringify(items), 1500, 0, 1500, 0, dbm.now(),
    )
    const roi = jobRoi({ id: 1, estimate_id: 1 }, dbm.getSettings())
    assert.equal(roi.colors, 4, 'the shop bought four screens; the job runs four colours')
  } finally { dbm.setDefaultDb(prev) }
})

section('a fresh install is nobody else\'s shop')
// This shipped wrong for every self-hosted install. The demo shop's name, address, phone and its
// 7.75% California sales tax were the DEFAULTS, and createTenant() blanked them only for
// multi-tenant signups. Single-shop mode — the README quickstart, the local trial, the docker run
// line, and a documented production mode — inherited all of it: invoices headed with another
// business's name and CA tax charged to customers in Texas. Both silent, both money.
await t('the shipped defaults carry no identity and no tax rate', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const db = new DatabaseSync(':memory:')
  dbm.initDb(db)
  const prev = dbm.getDb()
  dbm.setDefaultDb(db)
  try {
    dbm.seedSettings()
    const s = dbm.getSettings()
    for (const k of ['shop_name', 'shop_tagline', 'shop_email', 'shop_phone', 'shop_address']) {
      assert.equal(String(s[k] ?? ''), '', `${k} must start blank — a document omits a blank field but prints a wrong one`)
    }
    // 0 is visibly missing. Any non-zero default is a jurisdiction guess charged to real customers.
    assert.equal(Number(s.tax_rate), 0, 'tax_rate must start at 0')
    // Guard the specific values that shipped, so a re-introduction is unmistakable in the diff.
    assert.notEqual(s.shop_name, 'Rebel Ink Press')
    assert.notEqual(String(s.shop_phone), '(714) 555-0142')
  } finally { dbm.setDefaultDb(prev) }
})

section('templates: a merge field is not a way to read the settings row')
// This shipped exploitable. Both renderers fell back to the whole settings row, so putting
// {{stripe_secret}} in a message body rendered the shop's live Stripe key — and any user who
// can reply to a conversation can write a body. The result is stored in the outbox and readable
// back over the API, so it was a full credential dump with an email delivery option attached.
await t('a credential named as a merge field renders empty, not as the secret', async () => {
  const { templateValue, SECRET_KEYS } = await import('../lib/db.mjs')
  const settings = { shop_name: 'Rebel Ink Press' }
  for (const k of SECRET_KEYS) settings[k] = `SECRET-VALUE-${k}`
  for (const k of SECRET_KEYS) {
    assert.equal(templateValue(k, {}, settings), '', `${k} must not be reachable from a template`)
  }
})
await t('every settings key that is not letterhead is unreachable too', async () => {
  const { templateValue, TEMPLATE_SETTING_KEYS } = await import('../lib/db.mjs')
  // A blocklist would have closed only the keys we knew about. Anything not named is refused,
  // so the next integration's token is safe before anyone remembers to add it to a list.
  const settings = { qbo_realm_id: 'RE4LM', smtp_user: 'ops@shop.test', stripe_publishable: 'pk_live_x' }
  for (const k of Object.keys(settings)) {
    assert.ok(!TEMPLATE_SETTING_KEYS.has(k), `${k} is not letterhead`)
    assert.equal(templateValue(k, {}, settings), '')
  }
})
await t('the letterhead fields templates actually use still render', async () => {
  const { templateValue } = await import('../lib/db.mjs')
  const s = { shop_name: 'Rebel Ink Press', shop_email: 'orders@example.com', shop_phone: '(714) 555-0142' }
  assert.equal(templateValue('shop_name', {}, s), 'Rebel Ink Press')
  assert.equal(templateValue('shop_email', {}, s), 'orders@example.com')
  // Caller-supplied vars still win, and still beat a same-named setting.
  assert.equal(templateValue('shop_name', { shop_name: 'Override' }, s), 'Override')
  assert.equal(templateValue('first_name', { first_name: 'Dana' }, s), 'Dana')
  // An unknown field is empty rather than left as literal {{…}}, which is the long-standing
  // behaviour customers' templates already depend on.
  assert.equal(templateValue('not_a_field', {}, s), '')
})

section('a dead mail server does not hold the screen that fixes it')
// nodemailer's own defaults are a 2-minute connection timeout and a TEN-minute socket timeout, and
// sendMail() is awaited inside a request handler. Measured against a blackholed host the call took
// 75.0 seconds to come back; against a host that accepts the connection and never greets, 30.0.
// The screen an owner is looking at while that happens is Settings -> "Send a test email" — the
// exact screen they opened in order to FIX their mail configuration. server.requestTimeout bounds
// receiving a request, not producing the answer, so nothing else capped it.
//
// A real listener that accepts and stays silent, which is the failure mode a misconfigured relay
// actually presents. The cap is turned down for the test so the gate stays fast.
await t('a server that accepts and never greets is given up on, not waited out', async () => {
  process.env.PSC_SMTP_TIMEOUT_MS = '1500'
  const net = await import('node:net')
  const { sendEmail, smtpTimeoutMs } = await import('../lib/notify.mjs')
  assert.equal(smtpTimeoutMs(), 1500, 'the cap should be configurable so a slow relay can be allowed for')

  const sockets = []
  const srv = net.createServer((sock) => { sockets.push(sock) /* accept, then say nothing at all */ })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  try {
    const started = Date.now()
    const out = await sendEmail({
      to: 'someone@example.test',
      subject: 'Test email',
      body: 'hello',
      settings: { smtp_host: '127.0.0.1', smtp_port: port, smtp_user: 'u', smtp_pass: 'p', smtp_from: 'shop@example.test', smtp_secure: 'false' },
    })
    const took = Date.now() - started
    assert.ok(took < 10000, `sendEmail must give up quickly, took ${took}ms`)
    assert.equal(out.delivered, false, 'and must report the failure rather than claim delivery')
    assert.ok(out.error, 'with something the owner can act on')
  } finally {
    for (const s of sockets) { try { s.destroy() } catch { /* gone */ } }
    srv.close()
    delete process.env.PSC_SMTP_TIMEOUT_MS
  }
})

section('every api.<verb>() a screen calls actually exists')
// public/js/core.js exports the verb as `del`. Two screens called `api.delete(...)`, which is not
// a function on that object — so the whole handler threw before it reached the server, and the
// catch toasted "api.delete is not a function" at the shop owner. Settings -> Remove logo was
// therefore permanently broken from the UI: the route works, but nothing could reach it, and the
// wrong logo printed on every customer-facing document forever with no way to change it.
// Control Room -> Delete forever was the other one.
//
// A whole-tree scan rather than two assertions, because this class of typo is invisible until a
// user hits the one button that has it.
await t('no screen calls a verb the api object does not have', async () => {
  const { readFileSync, readdirSync, statSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const core = readFileSync(join(root, 'public/js/core.js'), 'utf8')
  const block = core.slice(core.indexOf('export const api = {'), core.indexOf('/* ---------- formatting'))
  const verbs = new Set([...block.matchAll(/^\s{2}(?:async\s+)?([a-zA-Z]+)\s*[:(]/gm)].map((m) => m[1]))
  assert.ok(verbs.has('del') && verbs.has('get') && verbs.has('post'), `parsed the api object wrong: ${[...verbs]}`)

  const walk = (dir) => readdirSync(dir).flatMap((f) => {
    const full = join(dir, f)
    return statSync(full).isDirectory() ? walk(full) : (f.endsWith('.js') ? [full] : [])
  })
  const bad = []
  for (const file of walk(join(root, 'public/js'))) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/\bapi\.([a-zA-Z]+)\s*\(/g)) {
      if (!verbs.has(m[1])) bad.push(`${file.slice(root.length + 1)} calls api.${m[1]}()`)
    }
  }
  assert.deepEqual(bad, [], `these calls would throw before reaching the server:\n  ${bad.join('\n  ')}`)
})

section('a style number names one garment, not every garment it is a prefix of')
// costFor() is the call that spends real money at the distributor — it picks the SKU and the cost
// that go onto the purchase order. The style test was a bare `text.includes(style)` taking the
// FIRST row that matched by rowid, and a style number is a prefix of other style numbers. So a
// youth or premium garment was costed and ORDERED as the adult basic sitting earlier in the table,
// with `matched: true` and no warning anywhere. Every one of these is in the shipped catalogue.
await t('a youth or premium style is not ordered as the adult basic', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const sup = await import('../lib/suppliers.mjs')
  const db = new DatabaseSync(':memory:')
  dbm.initDb(db); dbm.setDefaultDb(db); sup.initSuppliers(db)
  for (const [text, sku] of [
    ['Gildan 5000B youth tee, navy', 'G500B'],   // was G500   — adult, wrong price, wrong blank
    ['Bella+Canvas 3001CVC in heather', 'BC3001CVC'], // was BC3001
    ['Bella 3001Y', 'BC3001Y'],                  // was BC3001
    ['Gildan 42000 performance', 'G420'],        // was G200   — "42000" contains "2000"
  ]) {
    assert.equal(sup.costFor(text)?.sku, sku, `${text} must order ${sku}`)
  }
})
await t('…and the ordinary styles still match exactly as before', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const sup = await import('../lib/suppliers.mjs')
  const db = new DatabaseSync(':memory:')
  dbm.initDb(db); dbm.setDefaultDb(db); sup.initSuppliers(db)
  for (const [text, sku] of [
    ['Gildan 5000 Tee — Black', 'G500'],
    ['Comfort Colors 1717 in Blue', 'CC1717'],
    ['Port & Company PC61 navy', 'PC61'],
    ['Gildan 18500 hoodies', 'G185'],
    ['24 black tees', 'G500'],                   // no style at all — falls through to type
  ]) {
    assert.equal(sup.costFor(text)?.sku, sku, `${text} must still order ${sku}`)
  }
})
await t('a style has to sit on its own, not inside a longer run', async () => {
  const { styleMatches } = await import('../lib/suppliers.mjs')
  assert.equal(styleMatches('gildan 5000 tee', '5000'), true)
  assert.equal(styleMatches('gildan 5000b tee', '5000'), false)
  assert.equal(styleMatches('gildan 42000', '2000'), false)
  assert.equal(styleMatches('bella 3001cvc', '3001'), false)
  assert.equal(styleMatches('port & company pc61 navy', 'PC61'), true)
})

section('the estimate editor escapes what arrives as an object key')
// public/js/views/estimates.js escapes every string field it knows about — description, detail,
// qty, unit_price — and rendered three object-derived ones raw: the size-grid KEYS, the size-grid
// VALUES, and item.matrix.{name,row,col} inside a title attribute. Neither POST nor PUT
// /api/estimates has a role check, so any staff account could write them and the owner opened the
// estimate: staff -> owner stored XSS, through innerHTML, under script-src 'self' 'unsafe-inline'.
//
// The server now drops any size key that is not a real size (proved end-to-end in gate-e2e), but a
// matrix NAME is the shop's own free text and cannot have '<' banned from it. Escaping is its only
// fix, so assert it at the source — the file needs a DOM and core.js to execute.
await t('every interpolation in the size grid and the matrix tooltip is escaped', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'public/js/views/estimates.js'), 'utf8')

  const tooltip = src.split('\n').find((l) => l.includes('Priced from'))
  assert.ok(tooltip, 'the matrix tooltip should still be there')
  for (const field of ['name', 'row', 'col']) {
    assert.match(tooltip, new RegExp(`esc\\(it\\.matrix\\.${field}\\)`), `it.matrix.${field} must be escaped in the tooltip`)
  }
  const grid = src.slice(src.indexOf('sizesFor(it).map('), src.indexOf('sz-more'))
  assert.ok(grid.length > 40, 'the size grid should still be there')
  assert.ok(!/\$\{s\}/.test(grid), 'the size key must not be interpolated raw')
  assert.ok(!/\$\{it\.sizes\[s\] \|\| ''\}/.test(grid), 'the size value must not be interpolated raw')
  assert.match(grid, /esc\(s\)/, 'the size key must go through esc()')
})

section('a half-written reply is still finished')
// Express's terminal error handler cannot set a status once a route has started writing, and it
// returned at that point without res.end(). The socket then stayed open with no FIN and no
// terminating chunk until the client gave up — measured at 75 seconds on /api/export/all.json —
// and every retry leaked another socket, response object and open SQLite cursor. Ending the
// response is the least a half-written reply is owed.
//
// A source-level assertion, because no route can be made to throw mid-write from outside the
// process: the behaviour it guards is proved separately by the export's "complete": false marker
// in bin/gate-e2e.mjs. This one exists so the branch cannot quietly go back to a bare return.
await t('the terminal error handler ends a response whose headers already went out', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'server.mjs'), 'utf8')
  const i = src.indexOf('if (res.headersSent)')
  assert.ok(i > 0, 'the terminal handler should still special-case a response already in flight')
  // Everything up to the end of that branch — it must end the response before returning.
  const branch = src.slice(i, src.indexOf('\n', src.indexOf('return', i)))
  assert.match(branch, /res\.end\(\)/, `headersSent must not return without ending the socket — got: ${branch.trim()}`)
})

section('a two-garment order stays two garments all the way to the purchase order')
// The single worst production bug this codebase has shipped. An estimate for tees AND hoodies
// converted to a job whose sizes were MERGED into one flat grid, keeping only the first line's
// description as `garment`. The purchase order then bought that one style for the whole quantity:
// 150 tees, ZERO hoodies, 50 pieces vanished, and the shop found out on press day with the date
// already promised. ROI costed it correctly off the estimate ($1,167.90) while the PO said $480 —
// the two screens the owner trusts disagreeing by $687.90 on one job, with nothing to reconcile
// them. The pick ticket said "pull 50 L" when only 30 of those were tees.
//
// The per-garment data was never lost: it sits on estimates.items, which is why the packing slip
// was the one document that got it right. garmentLines() is that shape, and it is now carried onto
// the job (jobs.line_sizes) and read by the PO, the pick ticket and the work ticket.
{
  const { garmentLines, sizeTotal } = await import('../lib/db.mjs')
  const TWO = [
    { description: 'Gildan 5000 Heavy Cotton Tee — Black — 2/0 Front', sizes: { S: 20, M: 40, L: 30, XL: 10 }, unit_price: 11 },
    { description: 'Gildan 18500 Heavy Blend Hoodie — Black — 2/0 Front', sizes: { M: 10, L: 20, XL: 20 }, unit_price: 34 },
    { description: 'Screen setup', qty: 2, unit_price: 25 },
  ]

  await t('garmentLines keeps one entry per sized line, and drops the flat fee', () => {
    const lines = garmentLines(TWO)
    assert.equal(lines.length, 2)
    assert.equal(lines[0].garment, 'Gildan 5000 Heavy Cotton Tee')
    assert.equal(lines[1].garment, 'Gildan 18500 Heavy Blend Hoodie')
    assert.equal(sizeTotal(lines[0].sizes), 100)
    assert.equal(sizeTotal(lines[1].sizes), 50)
  })

  await t('…and the grids stay apart instead of rolling into one', async () => {
    const { rollupSizes } = await import('../lib/db.mjs')
    // The merged view is still correct for piece counts — it is the only thing it is correct for.
    assert.equal(sizeTotal(rollupSizes(TWO)), 150)
    assert.deepEqual(garmentLines(TWO).map((l) => sizeTotal(l.sizes)), [100, 50])
  })

  await t('the purchase order buys BOTH garments, not the first one twice', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const dbm = await import('../lib/db.mjs')
    const sup = await import('../lib/suppliers.mjs')
    const db = new DatabaseSync(':memory:')
    dbm.initDb(db); dbm.setDefaultDb(db); sup.initSuppliers(db)

    const po = sup.buildJobPurchaseOrder({ job_number: 'JOB-1001' }, garmentLines(TWO), {})
    const styles = new Set(po.lines.map((l) => l.sku))
    assert.equal(styles.size, 2, `a two-style order needs two SKUs on the PO — got ${[...styles]}`)
    assert.ok(styles.has('G500') && styles.has('G185'), `expected G500 + G185, got ${[...styles]}`)
    // The merge preserved the piece COUNT (150 either way) — what it lost was which style each
    // piece belongs to, so all 150 were bought as tees. Assert the split, not just the total.
    assert.equal(po.total_units, 150, 'every piece on the job must be ordered')
    const tees = po.lines.filter((l) => l.sku === 'G500').reduce((s, l) => s + l.qty, 0)
    assert.equal(tees, 100, 'only 100 of these are tees — ordering 150 buys 50 blanks the shop cannot use')
    const hoodies = po.lines.filter((l) => l.sku === 'G185').reduce((s, l) => s + l.qty, 0)
    assert.equal(hoodies, 50, 'the 50 hoodies must actually be ordered')
  })

  await t('…and the blank spend reflects both styles, not the cheap one', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const dbm = await import('../lib/db.mjs')
    const sup = await import('../lib/suppliers.mjs')
    const db = new DatabaseSync(':memory:')
    dbm.initDb(db); dbm.setDefaultDb(db); sup.initSuppliers(db)

    const lines = garmentLines(TWO)
    const both = sup.buildJobPurchaseOrder({ job_number: 'J' }, lines, {})
    const teeOnly = sup.buildPurchaseOrder({ job_number: 'J' }, { S: 20, M: 50, L: 50, XL: 30 }, TWO[0].description, {})
    // A hoodie costs multiples of a tee; costing 200 pieces as tees understated the spend badly.
    assert.ok(both.est_cost > teeOnly.est_cost, `both-garment PO (${both.est_cost}) must cost more than 150 tees (${teeOnly.est_cost})`)
    const sum = both.lines.reduce((s, l) => s + l.qty * (l.unit_cost || 0), 0)
    assert.ok(Math.abs(both.est_cost - sum) < 0.01, 'est_cost must equal the sum of its own lines')
  })

  await t('a warning names the garment it belongs to', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const dbm = await import('../lib/db.mjs')
    const sup = await import('../lib/suppliers.mjs')
    const db = new DatabaseSync(':memory:')
    dbm.initDb(db); dbm.setDefaultDb(db); sup.initSuppliers(db)
    const po = sup.buildJobPurchaseOrder({ job_number: 'J' }, garmentLines([
      { description: 'Gildan 5000 Tee', sizes: { M: 10 } },
      { description: 'Something With No Catalogue Entry At All', sizes: { M: 5 } },
    ]), {})
    assert.ok(po.warnings.some((w) => /Something With No Catalogue/.test(w)),
      `a multi-garment PO must say WHICH garment each warning is about — got ${JSON.stringify(po.warnings)}`)
  })

  await t('one garment behaves exactly as it always did', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const dbm = await import('../lib/db.mjs')
    const sup = await import('../lib/suppliers.mjs')
    const db = new DatabaseSync(':memory:')
    dbm.initDb(db); dbm.setDefaultDb(db); sup.initSuppliers(db)
    const one = [{ description: 'Gildan 5000 Tee — Black', sizes: { S: 10, M: 20 } }]
    const viaJob = sup.buildJobPurchaseOrder({ job_number: 'J' }, garmentLines(one), {})
    const direct = sup.buildPurchaseOrder({ job_number: 'J' }, { S: 10, M: 20 }, 'Gildan 5000 Tee — Black', {})
    assert.deepEqual(viaJob.lines, direct.lines)
    assert.equal(viaJob.est_cost, direct.est_cost)
    assert.equal(viaJob.color, direct.color, 'a single-garment PO keeps its detected colour')
  })

  await t('the pick ticket names each garment and totals them together', async () => {
    const { pickTicket } = await import('../lib/pdf.mjs')
    const pdf = pickTicket({
      job: { job_number: 'JOB-1001', due_date: '2026-10-15', decoration: 'Screen Print' },
      settings: { shop_name: 'Test Shop' },
      lines: garmentLines(TWO),
    }).toString('latin1')
    assert.match(pdf, /18500|Hoodie/, 'the hoodies must appear on the pick ticket')
    assert.match(pdf, /5000|Cotton Tee/, 'the tees must appear on the pick ticket')
    assert.match(pdf, /SUBTOTAL/, 'each garment needs its own subtotal to be pickable')
    assert.match(pdf, /\(150\)/, 'the grand total is every piece on the job')
    assert.match(pdf, /\(100\)/, 'the tee subtotal')
    assert.match(pdf, /\(50\)/, 'the hoodie subtotal — the number the picker needs and never had')
  })
}

section('the money helper can only ever return a finite number')
// round2 is THE money-coercion helper — every money write in the app goes through it. Its fallback
// existed because the `n + 'e2'` string trick returns NaN at extreme magnitudes, but
// `Math.round(Infinity * 100) / 100` is Infinity, so it handed Infinity straight back. One
// opportunity created with value "1e400" wrote Inf into the column, and SUM() over it then blanked
// the WHOLE shop's Open Pipeline and Weighted Pipeline KPIs — every card, not just that one — with
// nothing on screen pointing at the row that did it.
{
  const { round2 } = await import('../lib/db.mjs')
  await t('a non-finite input cannot come back out of round2', () => {
    for (const bad of ['1e400', Infinity, -Infinity, 1e308 * 10, NaN, 'abc', {}, []]) {
      const out = round2(bad)
      assert.ok(Number.isFinite(out), `round2(${String(bad)}) returned ${out}`)
    }
  })
  await t('…and ordinary money still rounds exactly as before', () => {
    for (const [inp, want] of [[1.005, 1.01], [2.675, 2.68], [-0.5, -0.5], [0, 0], [1918, 1918], ['12.345', 12.35]]) {
      assert.equal(round2(inp), want, `round2(${inp})`)
    }
  })
  await t('the browser copy of round2 agrees with the server copy', async () => {
    const browser = await import('../public/js/shared/pricing.js')
    for (const bad of ['1e400', Infinity, NaN]) assert.ok(Number.isFinite(browser.round2(bad)))
    for (const good of [1.005, 2.675, -0.5, 1918]) assert.equal(browser.round2(good), round2(good))
  })
}

section('a password reset leaves the owner signed in, with the new password written')
// consumePasswordReset was not async, and setMemberPassword/setPassword both await the hash before
// they write — so it returned BEFORE the password had been written. The route then minted a session
// and answered 200, and the detached write landed ~36ms later carrying
// `DELETE FROM sessions WHERE member_id = ?`, which destroyed the session just issued. Every reset
// bounced the owner straight back to the login form — on the one screen a locked-out owner reaches
// for. The ordering was the other half: used_at and the session purge committed first and the
// password write last and detached, so a failure while hashing spent the single-use token and
// changed nothing, leaving the recovery path gone with nothing to say so.
//
// Driven in a CHILD PROCESS: tenants.mjs resolves control.db from DB_PATH at import time, and this
// file has already imported db.mjs by here, so a fresh env only takes effect in a fresh process.
await t('the session minted after a reset is still alive a tick later', async () => {
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const box = mkdtempSync(join(tmpdir(), 'psc-reset-'))
  try {
    const script = `
      const tn = await import(${JSON.stringify(join(root, 'lib/tenants.mjs'))})
      await tn.createTenant({ shop_name: 'Reset Co', owner_email: 'reset@gate.test', password: 'originalpass123' })
      const link = tn.createPasswordReset('reset@gate.test')
      const out = await tn.consumePasswordReset(link.token, 'brandnewpass456')
      const sid = tn.createSession(out.member.tenant_id, out.member.id)
      const atMint = !!tn.getSession(sid)
      await new Promise((r) => setTimeout(r, 250))   // the detached write used to land here
      const later = !!tn.getSession(sid)
      const newOk = !!(await tn.authMember('reset@gate.test', 'brandnewpass456'))
      const oldGone = !(await tn.authMember('reset@gate.test', 'originalpass123'))
      console.log(JSON.stringify({ atMint, later, newOk, oldGone }))
      process.exit(0)
    `
    const out = execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], {
      env: { ...process.env, PSC_DB: join(box, 'psc.db'), PSC_CONTROL_DB: join(box, 'control.db'), PSC_AUTH: '1', PSC_SECRET: 'gate' },
      encoding: 'utf8',
    })
    const r = JSON.parse(out.trim().split('\n').pop())
    assert.equal(r.atMint, true, 'precondition: the new session exists')
    assert.equal(r.later, true, 'the reset signed the owner straight back out')
    assert.equal(r.newOk, true, 'the new password must work')
    assert.equal(r.oldGone, true, 'the old password must stop working')
  } finally { rmSync(box, { recursive: true, force: true }) }
})

section('an online payment is recorded at the amount that actually arrived')
// recordStripePayment clamped to the remaining balance and threw the difference away:
//   const amount = Math.min(paid, bal); if (!(amount > 0)) return syncInvoiceStatus(inv.id)
// A customer with the deposit link open in one tab and the balance link in another paid $9,450 on a
// $6,300 invoice; the shop recorded $6,300 and the other $3,150 existed nowhere but at Stripe. At an
// already-zero balance the whole payment vanished — no payment row, no activity, no notification —
// while the customer was shown "your payment went through / Balance $0.00". The card was charged.
//
// Asserted at the source, because the function needs a live Stripe session to drive end to end;
// the balance arithmetic it now performs is checked directly underneath.
await t('the clamp that dropped an overpayment is gone', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'server.mjs'), 'utf8')
  const i = src.indexOf('function recordStripePayment')
  assert.ok(i > 0, 'recordStripePayment should still exist')
  const body = src.slice(i, src.indexOf('\napp.', i))
  assert.ok(!/const amount = Math\.min\(paid, bal\)/.test(body),
    'the arrived amount must not be clamped to the balance — that is what dropped the money')
  assert.match(body, /refund the difference at Stripe/,
    'an overpayment must be recorded with something that tells the shop to refund it')
  assert.match(body, /OVERPAID/, 'and it must reach the activity log, not only the payment note')
})

await t('the overpayment arithmetic names the right difference', () => {
  // The shape recordStripePayment now uses: record what arrived, and report the excess over the
  // balance that was actually owed.
  const over = (paid, bal) => Math.max(0, Math.round((paid - Math.max(0, bal)) * 100) / 100)
  assert.equal(over(6300, 6300), 0, 'paying the balance exactly is not an overpayment')
  assert.equal(over(3150, 6300), 0, 'a part payment is not an overpayment')
  assert.equal(over(9450, 6300), 3150, 'two tabs: $9,450 against a $6,300 balance is $3,150 over')
  assert.equal(over(3150, 0), 3150, 'a payment against a zero balance is entirely an overpayment')
})

section('the board and the pipeline are usable without a mouse')
// `.jcard { touch-action: none }` existed so pointermove could drive the drag. On a phone it meant
// a finger on a card scrolled nothing — and cards fill the column, so the job board, the pipeline
// and the orders list could not be scrolled at all on the device a shop floor actually carries.
// Worse: any finger movement past 5px started a drag, and columnAt() picks the target column purely
// from clientX, so the natural sideways swipe across a 7-column board committed a stage change. The
// job moved because somebody looked at it.
//
// And a deal could never be marked Won or Lost without a mouse at all: api.patch(.../stage) was
// called from exactly two places, both inside the pointerup drag handler, while the deal form
// printed the stage as dead text.
{
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const css = readFileSync(join(root, 'public/css/app.css'), 'utf8')
  const board = readFileSync(join(root, 'public/js/views/board.js'), 'utf8')
  const pipe = readFileSync(join(root, 'public/js/views/pipeline.js'), 'utf8')

  await t('a card does not block touch scrolling', () => {
    // Find the .jcard rule body and assert it no longer kills touch panning.
    const i = css.indexOf('.jcard {')
    assert.ok(i > 0, '.jcard rule should still exist')
    const rule = css.slice(i, css.indexOf('}', i))
    assert.ok(!/touch-action:\s*none/.test(rule),
      '.jcard must not set touch-action:none — it makes every board column unscrollable on a phone')
  })

  await t('a finger scrolls the board instead of moving a job', () => {
    const i = board.indexOf("addEventListener('pointerdown'")
    assert.ok(i > 0, 'the board should still wire pointerdown')
    const handler = board.slice(i, i + 700)
    assert.match(handler, /pointerType === 'touch'/,
      'a touch pointer must not start a drag — a sideways swipe was committing a stage change')
  })

  await t('…and the same on the pipeline', () => {
    const i = pipe.indexOf("addEventListener('pointerdown'")
    assert.ok(i > 0, 'the pipeline should still wire pointerdown')
    assert.match(pipe.slice(i, i + 700), /pointerType === 'touch'/)
  })

  await t('a deal can be marked Won or Lost without dragging it', () => {
    assert.match(pipe, /id="opp-stage"/, 'the deal form needs a real stage control')
    // The control must actually reach the stage route, not just render.
    const i = pipe.indexOf("$('#save', bg).onclick")
    assert.ok(i > 0)
    const save = pipe.slice(i, i + 1200)
    assert.match(save, /opportunities\/\$\{o\.id\}\/stage/, 'saving must PATCH the stage route')
    assert.match(pipe, /STAGE_OPTIONS/, 'and offer every stage, including won and lost')
    for (const k of ['lead', 'quoted', 'sent', 'negotiation', 'won', 'lost']) {
      assert.ok(pipe.includes(`'${k}'`), `stage ${k} must be offered`)
    }
  })

  await t('the stage list matches the server exactly', async () => {
    const { STAGE_KEYS } = await import('../lib/pipeline.mjs')
    const m = pipe.match(/const STAGE_OPTIONS = \[([\s\S]*?)\]\n/)
    assert.ok(m, 'STAGE_OPTIONS should be findable')
    const keys = [...m[1].matchAll(/\['([a-z]+)',/g)].map((x) => x[1])
    assert.deepEqual(keys, STAGE_KEYS,
      'the picker and lib/pipeline.mjs must offer the same stages, or the UI writes a 400')
  })
}

section('the daily retention sweep actually runs daily')
// markDailySweepDone() sat OUTSIDE the `if (dueForDailySweep())` on the multi-tenant path, after
// the tenant loop, so it reset the clock on EVERY 5-minute tick. dueForDailySweep() (>24h since the
// last mark) was therefore only ever true on the very first tick after boot: webhook delivery
// history was pruned once per process lifetime and never again. Every real install runs that path;
// the single-tenant branch below it had it right, which is why it looked fine.
//
// Modelled rather than waited on — the bug is in WHEN the flag is set relative to the branch, so
// the two shapes are run side by side over a simulated week of 5-minute ticks.
{
  const DAY = 24 * 60 * 60 * 1000
  const TICK = 5 * 60 * 1000
  const WEEK_OF_TICKS = (7 * DAY) / TICK

  // The shipped shape: decide once before the loop, mark only if it swept.
  // `lastDailySweep` starts at 0 against a real epoch clock, so the first tick is always due.
  const runWeek = (shape) => {
    let last = 0, now = 1.7e12, sweeps = 0
    for (let i = 0; i < WEEK_OF_TICKS; i++) {
      now += TICK
      const due = () => now - last > DAY
      if (shape === 'fixed') {
        const sweepDue = due()
        if (sweepDue) sweeps++
        if (sweepDue) last = now
      } else {
        if (due()) sweeps++
        last = now // the bug: marked unconditionally, every tick
      }
    }
    return sweeps
  }

  await t('a week of ticks sweeps once a day, not once ever', () => {
    assert.equal(runWeek('broken'), 1, 'precondition: the old shape swept exactly once, then never')
    assert.equal(runWeek('fixed'), 7, 'a week must sweep seven times')
  })

  await t('the tenant loop asks once, not per shop', async () => {
    const { readFileSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const src = readFileSync(join(root, 'server.mjs'), 'utf8')
    const i = src.indexOf('for (const slug of automationTenantSlugs')
    assert.ok(i > 0, 'the multi-tenant tick loop should still exist')
    const loop = src.slice(i, src.indexOf('markDailySweepDone', i))
    assert.ok(!/dueForDailySweep\(\)/.test(loop),
      'asking per shop lets a pass crossing the 24h boundary sweep some shops and not others')
    // …and the mark must be conditional, or the clock resets on every tick.
    const after = src.slice(src.indexOf('markDailySweepDone()', i) - 40, src.indexOf('markDailySweepDone()', i) + 30)
    assert.match(after, /if \(sweepDue\)/, 'the sweep must only be marked done when it actually swept')
  })
}

section('/health reports a database that cannot be written to')
// /health answered with `get('SELECT 1')` — a READ. On a full disk reads keep working perfectly
// while every write fails: measured on a full volume, 25/25 writes returned 500 while /health
// answered {"ok":true} 200 the whole time. That is the signal deploy/ship.sh polls to decide
// whether to roll a release back, and the signal any uptime monitor watches, so the one failure
// that stops a shop saving anything was also the one failure nothing reported.
//
// `PRAGMA query_only` makes writes fail the way a full or read-only volume does, without needing
// one.
{
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')

  await t('a healthy database passes the probe', () => {
    const db = new DatabaseSync(':memory:')
    dbm.initDb(db)
    assert.equal(dbm.canWrite(db).ok, true)
  })

  await t('a database that cannot be written to FAILS the probe', () => {
    const db = new DatabaseSync(':memory:')
    dbm.initDb(db)
    assert.equal(db.prepare('SELECT 1 AS n').get().n, 1, 'precondition: reads work')
    db.exec('PRAGMA query_only = 1')
    assert.equal(db.prepare('SELECT 1 AS n').get().n, 1, 'reads STILL work — this is the trap')
    const w = dbm.canWrite(db)
    assert.equal(w.ok, false, 'the probe must notice that writes are refused')
    assert.match(w.error, /read-only|unavailable|disk full/)
  })

  await t('…and the probe leaves nothing behind', () => {
    const db = new DatabaseSync(':memory:')
    dbm.initDb(db)
    const before = db.prepare('SELECT COUNT(*) AS n FROM settings').get().n
    for (let i = 0; i < 5; i++) assert.equal(dbm.canWrite(db).ok, true)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM settings').get().n, before,
      'the health probe must not accumulate rows')
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key='__health'").get().n, 0)
  })

  await t('a failed probe can be retried — it does not leave a transaction open', () => {
    const db = new DatabaseSync(':memory:')
    dbm.initDb(db)
    db.exec('PRAGMA query_only = 1')
    assert.equal(dbm.canWrite(db).ok, false)
    db.exec('PRAGMA query_only = 0')
    assert.equal(dbm.canWrite(db).ok, true, 'health must recover once the disk does')
  })

  await t('/health no longer settles for a read', async () => {
    const { readFileSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const src = readFileSync(join(root, 'server.mjs'), 'utf8')
    const i = src.indexOf("app.get('/health'")
    assert.ok(i > 0)
    const route = src.slice(i, src.indexOf('\n})', i))
    assert.match(route, /canWrite\(\)/, '/health must probe a write')
    assert.ok(!/get\('SELECT 1'\)/.test(route), 'a read cannot detect a full disk')
  })
}

section('untrusted text cannot become structure in a document we generate')
{
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')

  // A manager could store `<img src=x onerror=...>` in an automation's params.days and it ran in
  // the OWNER's browser — reaching owner-only actions (add another owner, rotate the API key).
  // params.stage, on the SAME LINE of the same template, was escaped; days was not.
  await t('the automations list escapes every value it interpolates', () => {
    const src = readFileSync(join(root, 'public/js/views/automations.js'), 'utf8')
    const i = src.indexOf('class="au-when"')
    assert.ok(i > 0, 'the trigger summary should still render')
    const line = src.slice(i, src.indexOf('\n', i))
    // Every ${...} on this line must be wrapped in esc(), except pure ternary conditions.
    const raw = [...line.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1])
      .filter((x) => /a\.params|a\.trigger|c\.value/.test(x))
      .filter((x) => !/esc\(/.test(x))
    assert.deepEqual(raw, [], `unescaped interpolation(s) in the automations list: ${JSON.stringify(raw)}`)
  })

  await t('…and the server stores days as the number it is only ever used as', async () => {
    const src = readFileSync(join(root, 'server.mjs'), 'utf8')
    assert.match(src, /sanitizeAutoParams/, 'automation params should be coerced on write')
    const i = src.indexOf('const sanitizeAutoParams')
    const fn = src.slice(i, src.indexOf('\n}', i))
    assert.match(fn, /Number\.isFinite/, 'days must be a real number or absent')
  })

  // IIF is tab-delimited and newline-terminated: a tab or newline inside any field ends the field
  // or the record, and everything after it is read by QuickBooks as new columns or a NEW
  // transaction. payments.method went in raw and is free text a STAFF account writes; the customer
  // name stripped tabs but not newlines, and a contact name is writable by an unauthenticated
  // stranger holding the shop's public embed key.
  await t('the QuickBooks IIF export strips the delimiters from every field', () => {
    const src = readFileSync(join(root, 'server.mjs'), 'utf8')
    const i = src.indexOf("app.get('/api/export/quickbooks.iif'")
    assert.ok(i > 0, 'the IIF export should still exist')
    const route = src.slice(i, src.indexOf('\n}))', i))
    assert.ok(!/\$\{p\.method\}/.test(route), 'payments.method must not be spliced in raw')
    assert.ok(!/\.replace\(\/\\t\/g, ' '\)/.test(route), 'stripping only tabs leaves newlines, which end the record')
    assert.match(route, /const iif = /, 'there should be one sanitiser for every field')
    // and it must remove all three delimiters
    const san = route.slice(route.indexOf('const iif = '))
    assert.match(san.slice(0, 200), /\\t\\r\\n/, 'tab, CR and LF must all be removed')
  })

  await t('…and that sanitiser really neutralises an injected journal entry', () => {
    const iif = (v, max = 80) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim().slice(0, max)
    const attack = 'cash\tPrintShopCRM\nENDTRNS\nTRNS\tGENERAL JOURNAL\t1/1/2026\tOwner Draw\tThief\t9999.00\t\t\nENDTRNS'
    const out = iif(attack, 40)
    assert.ok(!out.includes('\t'), 'no tab may survive')
    assert.ok(!out.includes('\n'), 'no newline may survive')
    assert.ok(!out.includes('\r'))
    assert.equal(out.split(/\s/).length > 0, true)
    // A legitimate name is left readable.
    assert.equal(iif("O'Brien & Sons, Inc."), "O'Brien & Sons, Inc.")
    assert.equal(iif('José Muñoz'), 'José Muñoz')
  })
}

section('a document never hides money between its subtotal and its total')
// The tax row was rendered `if (Number(doc.tax) > 0)`. A NEGATIVE tax is reachable in ordinary use —
// a non-taxable setup fee plus a taxable discount line drives the tax base below zero — and `> 0`
// dropped the row entirely. The estimate PDF then printed Subtotal $400.00 directly above Total
// $391.75 with the $8.25 appearing nowhere on it, on the document the customer signs. The public
// approval page was worse: it printed "Tax $0.00", which is not merely incomplete but untrue.
{
  const { computeTotals } = await import('../lib/db.mjs')
  const { renderDocument } = await import('../lib/pdf.mjs')
  const ITEMS = [
    { description: 'Screen setup', qty: 1, unit_price: 500, taxable: false },
    { description: 'Loyalty discount', qty: 1, unit_price: -100, taxable: true },
  ]

  await t('the case really does produce a negative tax', () => {
    const t2 = computeTotals(ITEMS, 8.25, {})
    assert.equal(t2.subtotal, 400)
    assert.equal(t2.tax, -8.25)
    assert.equal(t2.total, 391.75)
    // …and the three numbers must be self-consistent, or the document cannot be made honest.
    assert.equal(Math.round((t2.subtotal + t2.tax) * 100) / 100, t2.total)
  })

  await t('the estimate PDF shows the negative tax line', () => {
    const t2 = computeTotals(ITEMS, 8.25, {})
    const pdf = renderDocument('ESTIMATE', {
      doc: { estimate_number: 'EST-1001', created_at: '2026-08-27', ...t2, tax_rate: 8.25 },
      contact: { name: 'Ace Corp' },
      settings: { shop_name: 'Test Shop', shop_tagline: '', estimate_terms: '' },
      items: ITEMS, upcharges: {},
    }).toString('latin1')
    assert.match(pdf, /Tax/, 'the tax row must be on the document')
    assert.match(pdf, /-\$8\.25/, 'and it must state the actual figure, signed')
  })

  await t('the public estimate page does not claim the tax is zero', async () => {
    const { readFileSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const src = readFileSync(join(root, 'server.mjs'), 'utf8')
    const i = src.indexOf('Tax (${esc(e.tax_rate')
    assert.ok(i > 0, 'the public page should still render a tax row')
    const branch = src.slice(i - 220, i)
    assert.ok(!/Number\(e\.tax\) > 0/.test(branch),
      'a `> 0` test renders "Tax $0.00" over a total that is lower than the subtotal')
    assert.match(branch, /Math\.abs/, 'the row must appear whenever the tax is non-zero either way')
  })
}

/* ---------- an automation that half-failed says so (v6) ----------
 * runAutomation RESERVES the run-log row as 'ran' before executing, and the detail UPDATE sat
 * inside the try. So a rule whose second action threw left status='ran' with an EMPTY detail —
 * rendered by the Automations screen as an ordinary success — for a run that tagged the customer,
 * died on step 2, and never sent the email on step 4. The only trace was one console line.
 * Meanwhile 'error' was checked by the dedupe latch and had a red pill waiting for it in the UI,
 * and NOTHING in the codebase ever wrote it. */
section('an automation that fails halfway is not logged as a success')
{
  const { DatabaseSync } = await import('node:sqlite')
  const dbmod = await import('../lib/db.mjs')
  const auto = await import('../lib/automations.mjs')
  const mem = new DatabaseSync(':memory:')
  mem.exec('PRAGMA foreign_keys = ON')
  dbmod.setDefaultDb(mem)
  auto.initAutomations(mem)

  const rule = {
    id: 1,
    name: 'BrokenRule',
    trigger: 'job.stage',
    conditions: [],
    // Step 2 throws — a 'move the job to a stage' step saved with the Stage field left blank,
    // which POST /api/automations accepts.
    actions: [
      { key: 'contact.tag', config: { tag: 'step-1-ok' } },
      { key: 'job.move', config: {} },
      { key: 'contact.tag', config: { tag: 'step-3-never' } },
    ],
  }
  mem.exec("CREATE TABLE contacts (id INTEGER PRIMARY KEY, name TEXT, tags TEXT DEFAULT '', updated_at DATETIME)")
  mem.exec("CREATE TABLE jobs (id INTEGER PRIMARY KEY, job_number TEXT, stage TEXT, updated_at DATETIME)")
  dbmod.run('INSERT INTO contacts (id, name, tags) VALUES (1, ?, ?)', 'Casey', '')
  dbmod.run('INSERT INTO jobs (id, job_number, stage) VALUES (1, ?, ?)', 'JOB-1027', 'new')
  // automation_runs.automation_id is a real FK, so the rule has to exist to be logged against.
  dbmod.run('INSERT INTO automations (id, name, enabled, trigger, actions) VALUES (?,?,1,?,?)',
    rule.id, rule.name, rule.trigger, JSON.stringify(rule.actions))
  auto.runAutomation(rule, 'job.stage', { contact: { id: 1, name: 'Casey' }, job: { id: 1, job_number: 'JOB-1027' } }, {})

  const row = dbmod.get('SELECT status, detail FROM automation_runs ORDER BY id DESC LIMIT 1')
  await t('the run is recorded as an error, not a green success', () => {
    assert.equal(row?.status, 'error')
  })
  await t('…and the detail names how far it actually got', () => {
    assert.match(String(row?.detail || ''), /1 of 3 step\(s\) ran/)
  })
  await t('…including the step that did run, so the shop knows what already went out', () => {
    assert.match(String(row?.detail || ''), /contact\.tag/)
  })
  await t('…and the reason it stopped', () => {
    assert.match(String(row?.detail || ''), /then failed:/)
  })
}

/* ---------- summary ---------- */
console.log(`\n  ${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
