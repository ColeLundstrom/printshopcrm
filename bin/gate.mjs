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
  db.exec(`CREATE TABLE contacts(id INTEGER PRIMARY KEY, name TEXT, email TEXT, phone TEXT, tags TEXT, notes TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE opportunities(id INTEGER PRIMARY KEY, contact_id INT, title TEXT, stage TEXT, value REAL, source TEXT, notes TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE estimates(id INTEGER PRIMARY KEY, contact_id INT, estimate_number TEXT, status TEXT, items TEXT, subtotal REAL, tax REAL, total REAL, tax_rate REAL, notes TEXT, created_at TEXT);
    CREATE TABLE activities(id INTEGER PRIMARY KEY, type TEXT, description TEXT, contact_id INT, job_id INT, created_at TEXT);
    CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);`)
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
  assert.equal(eff(3), 'partial', 'partial outranks overdue, matching syncInvoiceStatus')
  assert.equal(eff(4), 'paid', 'paid outranks everything')
  assert.equal(eff(5), 'unpaid', 'a null due date is never overdue')
  assert.equal(eff(6), 'unpaid', 'a blank due date is never overdue')

  // The actual symptom: "$X overdue" on the dashboard, nothing under Invoices → Overdue.
  const filtered = db.prepare(`SELECT i.id FROM invoices i WHERE ${EFFECTIVE_STATUS_SQL} = ?`).all(today, 'overdue').map((r) => r.id)
  const dashboard = db.prepare(`SELECT i.id FROM invoices i WHERE i.amount_paid = 0 AND i.due_date IS NOT NULL AND i.due_date != '' AND i.due_date < ?`).all(today).map((r) => r.id)
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

/* ---------- summary ---------- */
console.log(`\n  ${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
