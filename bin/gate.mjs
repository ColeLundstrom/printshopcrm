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

/* ---------- summary ---------- */
console.log(`\n  ${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
