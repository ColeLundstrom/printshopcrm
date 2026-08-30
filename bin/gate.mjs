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
  // The gap this pattern allows between a count and its unit noun is exactly the width of the
  // rest of a phone number, and of the second half of a date pair. "call us at 714-555-1234
  // about 48 tees" quoted 714 pieces — $4,159.75 against $435.40 — and on /api/autopilot in Full
  // Auto nothing holds it, because the deterministic parser and the model AGREE: the estimate is
  // mailed to the customer and a job is booked for 714 shirts. The style-number scrub for this
  // same class of bug landed; the contact-detail scrub never did.
  // …and the style scan read the same digits: style "714" is the number a supplier lookup would
  // then have been sent for the blanks.
  ['Hi, call us at 714-555-1234 about 48 tees for the team.', 48, ''],
  ['Hi — reach me at 949.555.0117, we need 24 hoodies.', 24, ''],
  ['need them by 2026-09-08 2026-10-12 for 200 tees', 200, ''],
  ['we need 200 shirts by 9/15', 200, ''],
]
for (const [text, qty, style] of QTY_CASES) {
  await t(JSON.stringify(text), () => {
    assert.equal(parseIntakeHeuristic(text).total_pieces, qty, 'quantity')
    assert.equal(parseGarmentText(text).style, style, 'style')
  })
}

/* ---------- the receptionist carries a second copy of the same parser ----------
 * …and it is the one that talks to anonymous strangers on the public widget and drafts a
 * numbered estimate at whatever it decides the order is. */
section('the receptionist does not read a phone number as the order quantity')
{
  const { extract } = await import('../lib/agent.mjs')
  const { phoneCandidate } = await import('../lib/ai.mjs')

  await t('a phone number in the message is not the piece count', () => {
    assert.equal(extract('call us at 714-555-1234 about 48 tees', {}).qty, 48)
    assert.equal(extract('reach me at 949.555.0117, we need 24 hoodies', {}).qty, 24)
    assert.equal(extract('need them by 2026-09-08 2026-10-12 for 200 tees', {}).qty, 200)
  })

  await t('…and it is still read as the phone number', () => {
    assert.equal(extract('call us at 714-555-1234 about 48 tees', {}).phone, '714-555-1234')
    assert.equal(extract('call me on (714) 555-1234', {}).phone, '(714) 555-1234')
    // E.164, because refusing a real number is the other way to lose a lead.
    assert.equal(extract('my number is +44 20 7946 0958', {}).phone, '+44 20 7946 0958')
    assert.equal(phoneCandidate('+1 (714) 555-1234'), '+1 (714) 555-1234')
  })

  await t('a size run and a pair of dates are not a phone number', () => {
    // Both were stored on contacts.phone, and because nextQuoteGoal treats a phone as "we can
    // reach them" the bot skipped the contact ask entirely: the shop got a captured lead, a
    // quoted opportunity and a draft estimate for somebody it has no way to contact, and the
    // transcript told them the bot had collected the details.
    assert.equal(extract('sizes are 24 12 36 48 60 72 in tees', {}).phone, undefined)
    assert.equal(extract('need them by 2026-09-08 2026-10-12 for 200 tees', {}).phone, undefined)
    assert.equal(phoneCandidate('24 12 36 48 60'), null, 'five two-digit groups is not a number')
    assert.equal(phoneCandidate('2026-09-08 14:30'), null, 'nor is a date and a time')
  })

  await t('the counts that already worked still work', () => {
    assert.equal(extract('200 Gildan 5000 tees', {}).qty, 200, 'the style number is not the count')
    assert.equal(extract('24 black tees', {}).qty, 24, 'an adjective between them is fine')
    assert.equal(extract('qty: 1,200 white polos', {}).qty, 1200)
    assert.equal(extract('we need screen printed tees for our 2026 conference', {}).qty, undefined,
      'a year is still not an order')
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
  await t('…while a real garment the model names is still accepted, where the text named none', () => {
    // AMENDED, not deleted. This case used to run against `stated`, whose text DOES name a
    // garment — so it asserted the exact overwrite that turned out to be the injection. The
    // property worth keeping is the other half of the rule: where the parser had nothing but its
    // GARMENTS[last] fallback, the model naming a real garment is an improvement and is accepted.
    const blank = parseIntakeHeuristic('we need 500 pieces, 2 color front')
    assert.equal(blank.evidence.garment, false, 'precondition: the text named no garment')
    assert.equal(mergeIntake(blank, { garment: 'Bella+Canvas 3001 Tee' }).garment, 'Bella+Canvas 3001 Tee')
    assert.equal(mergeIntake(blank, { garment: 'Comfort Colors 1717' }).garment, 'Comfort Colors 1717')
  })
}

section('intake: the customer writes the email, so the model may not re-price it')
// The message a model reads on this path is written by the person who benefits from a lower
// number, and on Full Auto the estimate it produces is priced, saved, marked sent and emailed in
// one request with nobody reading it. mergeIntake protected exactly one field — `sizes` — and
// took garment, decoration, locations, dark_garment, rush and due_hint from the model verbatim.
// Measured end to end with the real parser and the real pricer on a 500-hoodie embroidery order:
//   clean $40,574.78  ->  injected $6,001.68   (85.2% under, $34,573.10 given away)
// Per field, each on its own: garment -$21,496.13, rush -$13,506.47, locations -$6,953.33,
// decoration -$6,245.63. `rush` became the second-most valuable channel when v1.18.0 wired the
// rush multiplier into priceIntake — the fix made the injection worth MORE, not less.
// The rule is now the one `sizes` always had: fill a blank, never overwrite what the text said.
{
  const { mergeIntake } = await import('../lib/ai.mjs')
  const { priceIntake } = await import('../lib/quickquote.mjs')
  const SET = { screen_fee: '25', default_markup: '2', tax_rate: '7.75', price_book: '{}' }
  const email = 'We need 500 Gildan 18500 hoodies in navy for our staff. Embroidered left chest,\n11 colors in the logo, plus a 3 color back. We are in a rush, need them by 9/15/2026.'
  const clean = parseIntakeHeuristic(email)
  const INJECTION = { garment: 'Gildan 5000 Tee', decoration: 'DTF Transfer', locations: [{ name: 'Front', colors: 1 }], dark_garment: false, rush: false, due_hint: '2027-04-01', sizes: {}, notes: 'team order' }

  await t('the parser reports which fields the TEXT supplied, not which have a default', () => {
    assert.deepEqual(clean.evidence, { garment: true, decoration: true, locations: true, dark_garment: true, rush: true, due_hint: true })
    // The distinction is the whole fix: these three come back populated either way.
    const bare = parseIntakeHeuristic('please quote 500 pieces')
    assert.equal(bare.garment, 'Gildan 5000 Tee')
    assert.equal(bare.decoration, 'Screen Print')
    assert.deepEqual(bare.locations, [{ name: 'Front', colors: 1 }])
    assert.deepEqual(bare.evidence, { garment: false, decoration: false, locations: false, dark_garment: false, rush: false, due_hint: false })
  })

  await t('a garment stated in the email cannot be swapped for a cheaper blank', () => {
    const m = mergeIntake(clean, { garment: 'Gildan 5000 Tee' })
    assert.equal(m.garment, 'Gildan 18500 Hoodie')
    assert.equal(m.garment_cost, 16.50, 'garment_cost is looked up FROM the garment string')
  })
  await t('a decoration stated in the email cannot be downgraded', () => {
    assert.equal(mergeIntake(clean, { decoration: 'DTF Transfer' }).decoration, 'Embroidery')
  })
  await t('print locations stated in the email cannot be dropped', () => {
    assert.deepEqual(mergeIntake(clean, { locations: [{ name: 'Front', colors: 1 }] }).locations, clean.locations)
  })
  await t('a rush the customer stated cannot be cleared — rush is a price AND a promise', () => {
    assert.equal(clean.rush, true)
    assert.equal(mergeIntake(clean, { rush: false }).rush, true)
  })
  await t('…but a rush the text never stated may still be raised by the model', () => {
    const noRush = parseIntakeHeuristic('please quote 500 Gildan 5000 tees, 1 color front')
    assert.equal(noRush.rush, false)
    assert.equal(mergeIntake(noRush, { rush: true }).rush, true)
  })
  await t('a deadline stated in the email cannot be pushed out or pulled in', () => {
    assert.equal(mergeIntake(clean, { due_hint: '2027-04-01' }).due_hint, '2026-09-15')
  })
  await t('…but a deadline the text never stated may still be supplied', () => {
    const noDate = parseIntakeHeuristic('please quote 500 Gildan 5000 tees, 1 color front')
    assert.equal(noDate.due_hint, null)
    const future = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10)
    assert.equal(mergeIntake(noDate, { due_hint: future }).due_hint, future)
  })

  await t('the whole injection is worth $0.00 — this is the assertion that matters', () => {
    const before = priceIntake(clean, SET, {}).totals.total
    const after = priceIntake(mergeIntake(clean, INJECTION), SET, {}).totals.total
    assert.equal(before, 40574.78, 'precondition: the honest quote')
    assert.equal(after, before, `injection moved the quote to ${after}`)
  })
  await t('every field on its own is worth $0.00 too', () => {
    const before = priceIntake(clean, SET, {}).totals.total
    for (const f of ['garment', 'decoration', 'locations', 'dark_garment', 'rush', 'due_hint']) {
      const after = priceIntake(mergeIntake(clean, { [f]: INJECTION[f] }), SET, {}).totals.total
      assert.equal(after, before, `${f} alone moved the quote to ${after}`)
    }
  })

  await t('a refused overwrite is reported, not silently dropped', () => {
    const m = mergeIntake(clean, INJECTION)
    assert.deepEqual(m.needs_review.slice().sort(), ['dark_garment', 'decoration', 'due_hint', 'garment', 'locations', 'rush'])
    assert.match(m.ai_note, /differently from the message/)
  })
  await t('Full Auto stands down on a contested quote, and the screen says why', async () => {
    // The merge refuses the overwrite either way; this is the second half — a disagreement on a
    // priced field is the one thing on this path nobody else looks at, so it must not be sent
    // unread. Asserted against the source because reaching it end to end needs a live model key.
    const fs = await import('node:fs')
    const srv = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
    assert.match(srv, /const held = order\.needs_review \|\| \[\]/, 'autopilot must read needs_review')
    assert.match(srv, /req\.body\?\.mode === 'auto' && !held\.length/, "Full Auto must not fire on a contested order")
    const view = fs.readFileSync(new URL('../public/js/views/autopilot.js', import.meta.url), 'utf8')
    assert.match(view, /held_for_review/, 'the review screen must say it was held, and on what')
  })
  await t('an agreeing model raises nothing — Full Auto must stay usable', () => {
    const m = mergeIntake(clean, { garment: 'gildan 18500 hoodie', decoration: 'Embroidery', rush: true, due_hint: '2026-09-15', dark_garment: true, locations: clean.locations })
    assert.deepEqual(m.needs_review, [])
    assert.equal(m.ai_note, '')
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

/* ---------- a size the app has not heard of is never silently dropped ----------
 * Two halves of one defect. Every display site wrote `SIZES.filter((s) => sizes[s] > 0)`, which
 * ORDERS by SIZES and SILENTLY DROPS anything outside it — while the SUBTOTAL printed beside those
 * rows summed every key on the grid. One real workwear job printed a pick ticket whose rows summed
 * to 70 under its own "SUBTOTAL 80", against a job of 105 and a PO that ordered all 105: four
 * different piece counts for one job, the same minute. And 6XL and the tall run were not in SIZES
 * at all, so the estimate deleted them outright — a 45-piece order came back a 35-piece $640 quote
 * where $820 was ordered, with a 200 and no warning, while the JOB it converted to carried the
 * sizes its own estimate had thrown away. */
{
  const { SIZES, SIZE_KEY, sizeKeys, sizeSummary, sizeTotal } = await import('../public/js/shared/pricing.js')

  section('sizes: the trade sizes shops actually sell exist')
  for (const s of ['6XL', 'LT', 'XLT', '2XLT', '3XLT', '4XLT']) {
    await t(`${s} is a size the app can hold`, () => assert.ok(SIZES.includes(s), `${s} missing from SIZES`))
  }

  section('sizes: order by SIZES, never filter by it')
  const GRID = { S: 12, M: 24, L: 24, XL: 6, '2XL': 4, '6XL': 4, LT: 6 }
  await t('every size on the grid gets a row', () => {
    assert.deepEqual(sizeKeys(GRID), ['S', 'M', 'L', 'XL', '2XL', '6XL', 'LT'])
  })
  await t('…so the rows sum to the total printed beside them', () => {
    const rowSum = sizeKeys(GRID).reduce((a, s) => a + GRID[s], 0)
    assert.equal(rowSum, sizeTotal(GRID), 'rows must sum to sizeTotal')
    assert.equal(rowSum, 80)
  })
  await t('…and the summary string on the board counts them too', () => {
    const sum = sizeSummary(GRID)
    assert.match(sum, /4 6XL/)
    assert.match(sum, /6 LT/)
    assert.equal(sum.split(' / ').reduce((a, p) => a + Number(p.split(' ')[0]), 0), 80)
  })
  await t('a size we still do not know is listed rather than vanishing', () => {
    // Canonical ones keep their order; the stranger goes last instead of being deleted.
    assert.deepEqual(sizeKeys({ M: 2, ZZZ: 3, S: 1 }), ['S', 'M', 'ZZZ'])
  })

  section('sizes: widening the vocabulary did not widen the character set')
  // These keys are rendered through innerHTML on the editor, the PDF, the public estimate page and
  // the pay page. The rule that replaced `SIZES.includes(k)` has to keep that door shut.
  for (const ok of ['S', '2XL', '6XL', 'LT', '2XLT', 'OSFA', 'YXS']) {
    await t(`${JSON.stringify(ok)} is accepted`, () => assert.ok(SIZE_KEY.test(ok)))
  }
  for (const bad of ['a"onerror=alert(1)', '<script>', 'One Size', 'M;', '"', 'S/M', '', 'TOOMANYLETTERS']) {
    await t(`${JSON.stringify(bad)} is refused`, () => assert.ok(!SIZE_KEY.test(bad), `${bad} slipped through`))
  }
}

/* ---------- "Off — no AI model" really is off ----------
 * aiConfig() read `(provider === 'cli' || !provider) && !MULTI_TENANT`, so a BLANK provider — which
 * is exactly what the Settings dropdown's "Off — no AI model" option writes — fell through to the
 * locally installed claude CLI. MULTI_TENANT is PSC_AUTH === '1', and PSC_AUTH is unset on the
 * default install (the server prints a boot warning about that very thing), so on the ordinary
 * self-hosted install with the binary present the off switch did nothing: every AI feature kept
 * calling a model, on the platform's OAuth login rather than the key the shop is supposed to bring,
 * while the card beside the switch read "Off — deterministic parser only". */
{
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const prevBin = process.env.CLAUDE_BIN
  const prevAuth = process.env.PSC_AUTH
  // Point CLAUDE_BIN at a file that certainly exists, so existsSync() is true — that is the
  // condition the fallback turned on. process.execPath is never executed by these cases.
  process.env.CLAUDE_BIN = process.execPath
  delete process.env.PSC_AUTH
  const db = new DatabaseSync(':memory:')
  dbm.initDb(db)
  dbm.setDefaultDb(db)
  dbm.seedSettings()
  const ai = await import('../lib/ai.mjs?offswitch')  // fresh module: CLAUDE_BIN is read at import

  section('ai: the off switch turns AI off')
  await t('a blank provider — the dropdown\'s "Off" — connects no model', () => {
    dbm.setSetting('ai_provider', '')
    assert.equal(ai.aiConfig(), null, 'Off must mean off, even where a claude CLI is installed')
  })
  await t('…and the shop is told so, not told a model is available', async () => {
    dbm.setSetting('ai_provider', '')
    const st = await ai.aiStatus(true)
    assert.equal(st.available, false)
  })
  await t('the CLI still works when it is actually CHOSEN', () => {
    dbm.setSetting('ai_provider', 'cli')
    assert.equal(ai.aiConfig()?.provider, 'cli')
  })
  await t('…and choosing it is possible, because it is offered', () => {
    // Before, the CLI was reachable only by NOT choosing anything — which is how the off switch
    // came to turn it on. It has to be in the list for "explicit choice" to mean anything.
    assert.ok(ai.AI_PROVIDERS.some((p) => p.id === 'cli'), 'single-tenant installs must be able to pick the CLI')
  })
  await t('a real key still connects', () => {
    dbm.setSetting('ai_provider', 'anthropic')
    dbm.setSetting('ai_api_key', 'sk-ant-test')
    assert.equal(ai.aiConfig()?.provider, 'anthropic')
  })
  if (prevBin === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = prevBin
  if (prevAuth !== undefined) process.env.PSC_AUTH = prevAuth
}

/* ---------- an open dialog holds the keyboard ----------
 * confirmModal is how the product asks "are you sure" before deleting a customer, a quote, a job
 * or a proof. It trapped nothing: `modal()` focused the first input in `.modal-b`, and a confirm's
 * body is a `<p>`, so focus STAYED on the trigger behind the overlay. Tab walked into the sidebar,
 * and Enter re-fired the button that opened the dialog — on a destructive action, with the dialog
 * still on screen. There was no role="dialog", no aria-modal, and the close button's only
 * accessible name was the times character. Escape and focus-restore were already correct. */
section('a modal is a dialog, and the keyboard cannot leave it')
{
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const core = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public/js/core.js'), 'utf8')

  await t('it announces itself as a dialog, with a name', () => {
    assert.match(core, /role="dialog"/, 'a screen reader has no other way to know the page is blocked')
    assert.match(core, /aria-modal="true"/)
    assert.match(core, /aria-labelledby="\$\{titleId\}"/, 'the dialog must be named by its own heading')
    assert.match(core, /class="x" data-close aria-label="Close"/, 'the × needs a name that is not "times"')
  })
  await t('Tab is trapped inside it', () => {
    assert.match(core, /e\.key !== 'Tab'/, 'modal() must handle Tab')
    assert.match(core, /e\.shiftKey && \(document\.activeElement === first/, 'and wrap backwards as well as forwards')
  })
  await t('…and focus lands inside it even when there is nothing to type in', () => {
    // The exact confirmModal case: body is a <p>, so the input query finds nothing.
    assert.match(core, /\$\('\.modal-b input, \.modal-b select, \.modal-b textarea', bg\) \|\| focusable\(bg\)\[0\]/,
      'a dialog with no form control must still take focus off the trigger behind it')
  })
}

/* ---------- a button that says it copied must have copied ----------
 * `navigator.clipboard?.writeText(x); toast('Link copied')` — no await, no catch, and an optional
 * chain that evaluates to `undefined` and toasts success anyway. `navigator.clipboard` does not
 * exist outside a secure context, and INSTALL.md documents `http://192.168.x.x` as a supported
 * private-network deploy, so on that install the estimate share button and the mockup approval
 * link said "Link copied" and copied nothing, every time. It is not a cosmetic lie: with no SMTP
 * connected the app TELLS the shop to copy the link and send it themselves, so this is the only
 * delivery path the customer has. */
section('the share buttons do not claim to have copied when they have not')
{
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const read = (f) => readFileSync(join(root, f), 'utf8')

  await t('core.js offers one copy helper, and it awaits and falls back', () => {
    const core = read('public/js/core.js')
    assert.match(core, /export async function copyText/, 'the helper must be async — the API returns a promise')
    assert.match(core, /await navigator\.clipboard\.writeText/, 'and it must await it, or the toast races the copy')
    assert.match(core, /execCommand\('copy'\)/, 'with a fallback for a page served over http')
    assert.match(core, /Copy this link/, 'and, failing that, it must SHOW the text so a human can copy it')
  })

  await t('no screen fires a copy and toasts success without waiting for it', async () => {
    // The rule was written against the exact broken shape — an OPTIONAL-CHAINED writeText — so
    // three sites that spelled it `navigator.clipboard.writeText` inside a try/catch survived it,
    // toasting success outside both branches and discarding execCommand's return value. On the
    // http://192.168.x.x deploy INSTALL.md documents, `navigator.clipboard` is undefined, the
    // TypeError lands in the catch, and the button still says "copied". No screen may reach for
    // the clipboard directly; copyText() is the one place that knows how to fail honestly.
    const fs = await import('node:fs')
    for (const n of fs.readdirSync(join(root, 'public/js/views'))) {
      assert.doesNotMatch(read(`public/js/views/${n}`), /navigator\.clipboard/,
        `public/js/views/${n} reaches for the clipboard directly — it must go through copyText()`)
    }
  })

  await t('…and the two links a shop actually hands a customer go through it', () => {
    const est = read('public/js/views/estimates.js')
    assert.match(est, /copyText\(location\.origin \+ e\.share_url/, 'the estimate share button')
    assert.match(est, /copyText\(location\.origin \+ t\.dataset\.url/, 'the mockup approval link')
    assert.match(read('public/js/views/invoices.js'), /copyText\(url/, 'the pay link')
  })
}

/* ---------- `npm run reset` must not delete somebody's shop ----------
 * package.json's `reset` was the ONE script that did not pass --env-file-if-exists=.env. So
 * bin/reset.mjs resolved PSC_DB from a bare environment and deleted ./data/printshop.db — usually
 * nothing, reported as success — while the `&& npm run seed` half DID read .env and wiped whatever
 * PSC_DB really pointed at. Two halves of one documented command ("wipe and reseed", INSTALL.md),
 * aimed at two different databases. seed.mjs then runs unguarded DELETE FROM over contacts,
 * estimates, invoices, jobs, payments, messages and settings, and writes back "Rebel Ink Press"
 * with a 7.75% California tax rate. No prompt, no path printed, no undo. */
section('reset/seed: a demo script may not overwrite a real shop')
{
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync, rmSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')

  await t('both halves of `npm run reset` read the same .env, so they aim at the same database', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const envFlag = /--env-file-if-exists=\.env/
    assert.match(pkg.scripts.reset, envFlag, 'bin/reset.mjs must resolve PSC_DB the way seed does')
    assert.match(pkg.scripts.seed, envFlag, 'precondition: seed reads .env')
  })

  const seedInto = (dbPath, env = {}) => {
    try {
      const out = execFileSync(process.execPath, ['--no-warnings', join(root, 'seed.mjs')],
        { cwd: root, env: { ...process.env, PSC_DB: dbPath, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { code: 0, out }
    } catch (e) { return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` } }
  }
  const countIn = (dbPath) => {
    const out = execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
      const { DatabaseSync } = await import('node:sqlite')
      const d = new DatabaseSync(${JSON.stringify('DBPATH')})
      process.stdout.write(String(d.prepare('SELECT COUNT(*) AS n FROM contacts').get().n))
    `.replace(JSON.stringify('DBPATH'), JSON.stringify(dbPath))], { encoding: 'utf8' })
    return Number(out)
  }

  const tmp = mkdtempSync(join(tmpdir(), 'psc-seed-'))
  try {
    const dbPath = join(tmp, 'shop.db')
    await t('a fresh database seeds, and says which file it is writing to', () => {
      const r = seedInto(dbPath)
      assert.equal(r.code, 0, r.out)
      assert.match(r.out, new RegExp(`seeding ${dbPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'it must print the path it is about to wipe')
      assert.ok(countIn(dbPath) > 0, 'the demo shop should exist')
    })
    await t('…and re-seeding the demo shop still works, because that is what the script is for', () => {
      assert.equal(seedInto(dbPath).code, 0)
    })

    await t('…but a shop that has named itself and has records is refused', () => {
      execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
        const { DatabaseSync } = await import('node:sqlite')
        const d = new DatabaseSync(${JSON.stringify(dbPath)})
        d.prepare("INSERT INTO settings (key,value) VALUES ('shop_name','Northgate Print Co') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run()
      `], { encoding: 'utf8' })
      const before = countIn(dbPath)
      const r = seedInto(dbPath)
      assert.equal(r.code, 1, 'seeding a real shop must fail, loudly')
      assert.match(r.out, /Refusing to seed/)
      assert.match(r.out, /Northgate Print Co/, 'it must name the shop it just protected')
      assert.equal(countIn(dbPath), before, 'and it must not have deleted a single row')
    })
    await t('…and the refusal names a way through, so it is not a dead end', () => {
      const r = seedInto(dbPath)
      assert.match(r.out, /PSC_SEED_FORCE=1/)
      assert.equal(seedInto(dbPath, { PSC_SEED_FORCE: '1' }).code, 0, 'the escape it prints must work')
    })
  } finally { rmSync(tmp, { recursive: true, force: true }) }
}

/* ---------- an issued document keeps adding up after the shop changes its rates ----------
 * Line amounts are never stored — every renderer recomputes them — while subtotal/tax/total ARE
 * stored, frozen at write time. So one PUT /api/settings raising the extended-size upcharges, an
 * ordinary documented setting, retroactively re-priced the LINES of every estimate and invoice the
 * shop had ever issued while their totals stayed put. Measured on a live instance: an issued
 * invoice's printed line went $1,006.00 -> $1,032.00 above a printed Subtotal of $1,006.00. The
 * customer is holding that document; the shop can only collect the stored figure. */
{
  const { lineAmount, lineUpcharge, computeTotals } = await import('../public/js/shared/pricing.js')
  const LINE = { description: 'Tees', unit_price: 8.75, sizes: { M: 100, '2XL': 10, '3XL': 2 } }
  const WHEN_WRITTEN = { '2XL': 2, '3XL': 3 }
  const TODAY = { '2XL': 4, '3XL': 6 }

  section('pricing: a line carries the upcharge table it was priced with')
  await t('the line is quoted at the rates of the day it was written', () => {
    // 100 x 8.75 + 10 x (8.75+2) + 2 x (8.75+3)
    assert.equal(lineAmount({ ...LINE }, WHEN_WRITTEN), 1006)
  })
  await t('…and a frozen table beats the shop\'s live one', () => {
    const frozen = { ...LINE, size_upcharges: WHEN_WRITTEN }
    assert.equal(lineAmount(frozen, TODAY), 1006, 'the live table must not reach a written line')
    assert.equal(lineUpcharge(frozen, TODAY), 26)
  })
  await t('…so the lines still sum to the subtotal that was stored with them', () => {
    const frozen = { ...LINE, size_upcharges: WHEN_WRITTEN }
    const doc = computeTotals([frozen], 0, TODAY)
    assert.equal(doc.subtotal, 1006)
    assert.equal(doc.subtotal, lineAmount(frozen, TODAY), 'subtotal and line must agree')
  })
  await t('a line written BEFORE the freeze existed still uses the live table', () => {
    // No re-pricing on upgrade: this is exactly the old behaviour for old rows.
    assert.equal(lineAmount({ ...LINE }, TODAY), 1032)
  })
  await t('…and a new quote written today is priced at today\'s rates', () => {
    const fresh = { ...LINE, size_upcharges: TODAY }
    assert.equal(lineAmount(fresh, TODAY), 1032)
  })
  await t('a junk snapshot is ignored rather than zeroing the line', () => {
    for (const junk of [[], 'nope', 7, null]) {
      assert.equal(lineAmount({ ...LINE, size_upcharges: junk }, WHEN_WRITTEN), 1006, `size_upcharges=${JSON.stringify(junk)}`)
    }
  })

  section('pricing: EVERY writer of an estimate stamps that table, not just the editor')
  // The freeze shipped inside sanitizeEstimateItems, which guards the two hand-edited routes.
  // Nine other writers stored bare lines: reorder, duplicate, autopilot, the CSV order import, the
  // v1 API, gang sheets, quick quote, the receptionist and the assistant. A 300-tee autopilot
  // quote printed lines summing $3,499.00 under its own stored "Subtotal $3,369.00" after one
  // upcharge change — and lines that disagree with the invoice total permanently park the
  // QuickBooks push behind "refusing to push: lines total X but the invoice is Y", which is
  // unresolvable from any screen because the number that moved is not written on the invoice.
  {
    const { freezeUpcharges } = await import('../lib/db.mjs')
    await t('a line with a size grid comes back carrying the table it was priced with', () => {
      const [out] = freezeUpcharges([{ ...LINE }], WHEN_WRITTEN)
      assert.deepEqual(out.size_upcharges, WHEN_WRITTEN)
      assert.equal(lineAmount(out, TODAY), 1006, 'and the live table can no longer reach it')
    })
    await t('…and it only ever fills a blank, so a re-save does not re-price', () => {
      const already = { ...LINE, size_upcharges: WHEN_WRITTEN }
      assert.deepEqual(freezeUpcharges([already], TODAY)[0].size_upcharges, WHEN_WRITTEN)
    })
    await t('…a line with no size grid is left exactly as it was', () => {
      const flat = { description: 'Screen setup', qty: 2, unit_price: 25 }
      assert.deepEqual(freezeUpcharges([flat], WHEN_WRITTEN)[0], flat)
      assert.deepEqual(freezeUpcharges([{ ...LINE, sizes: {} }], WHEN_WRITTEN)[0].size_upcharges, undefined)
    })
    await t('…and a caller cannot post junk into the table its own line is priced by', () => {
      for (const junk of [[], 'nope', 7]) {
        assert.equal(freezeUpcharges([{ ...LINE, size_upcharges: junk }], WHEN_WRITTEN)[0].size_upcharges, undefined)
      }
    })
    await t('…and zero, non-numeric and non-size entries never enter a snapshot', () => {
      const [out] = freezeUpcharges([{ ...LINE }], { '2XL': 2, '3XL': 0, 'not a size': 9, '4XL': 'x' })
      assert.deepEqual(out.size_upcharges, { '2XL': 2 })
    })

    await t('no route can write an estimate without stamping it — every INSERT is covered', async () => {
      // Structural, deliberately: the defect was nine writers that each looked fine on its own.
      // The next one cannot ship unguarded without this failing.
      const fs = await import('node:fs')
      const path = await import('node:path')
      const root = new URL('../', import.meta.url)
      const files = ['server.mjs', ...fs.readdirSync(new URL('lib', root)).filter((f) => f.endsWith('.mjs')).map((f) => `lib/${f}`)]
      const unguarded = []
      let sites = 0
      for (const f of files) {
        const lines = fs.readFileSync(new URL(f, root), 'utf8').split('\n')
        lines.forEach((l, i) => {
          if (!l.includes('INSERT INTO estimates')) return
          sites++
          const window = lines.slice(Math.max(0, i - 45), i + 1).join('\n')
          if (!/freezeUpcharges|sanitizeEstimateItems/.test(window)) unguarded.push(`${f}:${i + 1}`)
        })
      }
      assert.ok(sites >= 9, `expected to find the estimate writers, found ${sites}`)
      assert.deepEqual(unguarded, [], `these write an estimate without freezing its upcharge table: ${unguarded.join(', ')}`)
      void path
    })
  }
}

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

section('pricing: a rush job is priced as a rush job, not just scheduled as one')
/* Every automated quoting path — Slack quick-quote, Autopilot, email intake, the agent — dropped
 * the rush surcharge on the floor. priceIntake wrote "RUSH." onto the customer-visible line and
 * booked the job three business days out instead of ten, and priced the piece exactly as if it
 * were a standard ten-day run: rush:true and rush:false returned byte-identical totals. The tiers
 * have always existed (RUSH_TIERS) and were wired only to the manual Quote screen. On 300 tees
 * that is $2,870.00 quoted where the shop's own 3-day tier makes it $4,280.00. */
await t('rush costs more than standard, by the shop\'s own published tier', async () => {
  const { RUSH_TIERS } = await import('../public/js/shared/pricing.js')
  const base = { garment: 'Gildan 5000', decoration: 'Screen Print', total_pieces: 300, sizes: {}, locations: [{ name: 'Front', colors: 2 }] }
  const std = priceIntake({ ...base }, SET)
  const rush = priceIntake({ ...base, rush: true }, SET)
  assert.ok(rush.totals.total > std.totals.total,
    `rush ${rush.totals.total} must exceed standard ${std.totals.total}`)

  // The default rush is the 3-day tier, which is what the turnaround it books is too.
  const three = RUSH_TIERS.find((t) => t.days === 3).mult
  assert.equal(rush.quote.perPiece, Math.round(std.quote.perPiece * three * 100) / 100, 'per-piece carries the 3-day multiplier')
  assert.equal(rush.rushDays, 3, 'and the price agrees with the turnaround it hands the scheduler')

  // A faster tier costs more again — next day is 2.0x, not another 1.5x.
  const next = priceIntake({ ...base, rush: true, rush_days: 1 }, SET)
  const nextMult = RUSH_TIERS.find((t) => t.days === 1).mult
  assert.equal(next.quote.perPiece, Math.round(std.quote.perPiece * nextMult * 100) / 100)
  assert.equal(next.rushDays, 1, 'and it is booked as fast as it was billed')

  // Setup and screens are one-off costs; going faster does not make a screen cost more.
  assert.equal(rush.quote.screens, std.quote.screens, 'screen charges do not scale with speed')

  // The customer-facing line has to say what they are paying for.
  const line = rush.items.find((i) => /RUSH/.test(String(i.detail || '')))
  assert.ok(line, 'the rush line names itself')
  assert.match(line.detail, /RUSH \+\d+%/, 'and says how much the rush added')
  assert.ok(!std.items.some((i) => /RUSH/.test(String(i.detail || ''))), 'a standard quote says nothing about rush')
  assert.equal(std.rushDays, 0, 'and hands the scheduler no rush at all')
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

section('the queries on the first screen after login seek, they do not scan')
/* node:sqlite is SYNCHRONOUS: a slow query blocks the event loop for EVERY shop on the box, not
 * just the one that asked. So a full table scan on a hot path is a fleet-wide outage in slow
 * motion, and the tables these run over are all append-only — they only get worse.
 *
 * EXPLAIN QUERY PLAN is the assertion because it is the thing that actually regresses: a later
 * edit that wraps a column in a function (date(), upper(), lower()) silently makes the index
 * unusable again while the query still returns the right answer. Revenue MTD was exactly that —
 * `WHERE date(p.created_at) >= ?` scanned every payment the shop had ever taken. */
await t('no hot dashboard query falls back to a table scan', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const auto = await import('../lib/automations.mjs')
  const db = new DatabaseSync(':memory:')
  dbm.initDb(db)
  auto.initAutomations(db) // automation_runs and its indexes live in the automations module
  const plan = (sql, ...p) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...p).map((r) => r.detail).join(' | ')
  const seeks = (label, sql, ...p) => {
    const d = plan(sql, ...p)
    assert.doesNotMatch(d, /SCAN (?!.*USING (COVERING )?INDEX)/, `${label} — ${d}`)
  }
  // Revenue MTD, /api/dashboard. The `date()` wrapper is the regression this guards.
  seeks('revenue MTD', `SELECT COALESCE(SUM(p.amount), 0) AS v FROM payments p WHERE p.created_at >= ?`, '2026-08-01')
  // Floor Mode barcode scan, GET /api/scan/:code. upper() defeats the UNIQUE index on job_number,
  // so this only seeks if an index on the same EXPRESSION exists.
  seeks('barcode scan', `SELECT * FROM jobs WHERE upper(job_number) = ?`, 'JOB-1001')
  // Stripe webhook idempotency — "have I already recorded this session?"
  seeks('stripe session lookup', `SELECT 1 FROM payments WHERE stripe_session = ?`, 'cs_test_x')
  // The unread badge, on /api/dashboard AND /api/today.
  seeks('unread messages', `SELECT COUNT(*) AS n FROM messages WHERE direction = 'in' AND read = 0`)
  // Automations fired this week, on /api/dashboard AND /api/automations.
  seeks('automation runs this week', `SELECT COUNT(*) AS n FROM automation_runs WHERE status = 'ran' AND created_at >= ?`, '2026-08-21')
  // GET /uploads/:file — the tenant-ownership check v1.19.0 added, on the one route that serves
  // bytes. `filename` had no index, so every proof, mockup and logo request was a full SCAN of
  // art_versions: measured 1.838ms per lookup at 40k rows, against 0.0018ms with the index. The
  // Art & Prepress page renders one <img> per version, so ONE visit to a 40k-version shop was
  // 73.5 seconds of blocked event loop — shared by every tenant, because node:sqlite is
  // synchronous. And on a default self-host (PSC_AUTH unset) that route needs no session at all.
  seeks('uploads ownership check', `SELECT 1 AS x FROM art_versions WHERE filename = ? LIMIT 1`, 'proof.png')
})

await t('a list route may hand its own share_key in, and the token does not change', async () => {
  // /api/art selects `a.*` — which INCLUDES share_key — and then called shareUrl(), whose token()
  // re-SELECTed share_key once per row. 39,906 hidden single-row lookups for a column already in
  // memory: 214ms of pure redundancy inside a 700ms synchronous block that stops every tenant on
  // the box. The only thing that matters about the fix is that the token is unchanged, because
  // every one of those URLs is already in a customer's inbox. Reproduced here against the real
  // HMAC rather than against the route, which needs a live server.
  const crypto = await import('node:crypto')
  const mk = (kind, id, slug, k) => crypto.createHmac('sha256', 'gate-secret').update(`${kind}:${id}:${slug}${k ? `:${k}` : ''}`).digest('hex').slice(0, 16)
  for (const k of ['abc123', '', null]) {
    assert.equal(mk('art', 7, 'shop', k), mk('art', 7, 'shop', String(k ?? '')),
      'passing the key in must produce the same token the lookup produced')
  }
  assert.notEqual(mk('art', 7, 'shop', 'abc123'), mk('art', 7, 'shop', ''), 'precondition: the key is really in the token')
  // …and the route must actually pass it, or the N+1 is still there.
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs'), 'utf8')
  assert.match(src, /shareUrl\('art', a\.id, a\.share_key\)/, '/api/art must hand shareUrl the share_key it already selected')
  // The Art & Prepress page renders one <img> per version with no paging, so they must not all
  // fetch at once — that is 40k tenant-scoped requests on a shared synchronous event loop.
  const misc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public/js/views/misc.js'), 'utf8')
  assert.match(misc, /class="art-thumb"[^>]*loading="lazy"/, 'art thumbnails must be lazy')
})

await t('…and Revenue MTD still answers the same number without date()', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const db = new DatabaseSync(':memory:')
  dbm.initDb(db); dbm.setDefaultDb(db)
  dbm.run("INSERT INTO contacts (name, email) VALUES ('C', 'c@x.test')")
  dbm.run("INSERT INTO invoices (contact_id, invoice_number, status, amount_due, amount_paid) VALUES (1, 'INV-1', 'unpaid', 100, 0)")
  // One payment on the last second of last month, one on the first, one mid-month.
  for (const [amt, at] of [[10, '2026-07-31 23:59:59'], [20, '2026-08-01 00:00:00'], [30, '2026-08-15 12:00:00']]) {
    dbm.run('INSERT INTO payments (invoice_id, amount, method, note, created_at) VALUES (?,?,?,?,?)', 1, amt, 'check', '', at)
  }
  const sum = (sql) => Number(db.prepare(sql).get('2026-08-01').v)
  const oldWay = sum(`SELECT COALESCE(SUM(p.amount), 0) AS v FROM payments p WHERE date(p.created_at) >= ?`)
  const newWay = sum(`SELECT COALESCE(SUM(p.amount), 0) AS v FROM payments p WHERE p.created_at >= ?`)
  assert.equal(newWay, 50, 'August only — the boundary payment counts, the July one does not')
  assert.equal(newWay, oldWay, 'the faster form must not change the number the shop reads')
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

  /* And the guard must not be switchable by the visitor.
   *
   * It read `session.channel === 'web'`, so ANY other value counted as verified — while the
   * public /api/embed/chat/start took that value straight out of the request body. One extra
   * JSON field, {"channel":"sms"}, and the whole block above turned off: reproduced end to end
   * against a real instance, an anonymous visitor holding only the shop's published embed key
   * wrote 555-999-8888 onto a real customer, drafted EST-1006 for $840 on that customer's
   * account, and filed the deal as qualified with the ⚠ UNVERIFIED note stripped. It now fails
   * closed: only a channel the shop itself originated is trusted. */
  const forgedId = Number(dbm.run('INSERT INTO contacts (name, email, phone, created_at, updated_at) VALUES (?,?,?,?,?)',
    'Harbor City Brewfest', 'ap@harborcity.test', '', dbm.now(), dbm.now()).lastInsertRowid)
  {
    const s = ag.startSession({ channel: 'sms' })   // any value that is not 'web'
    const cur = () => ag.sessionByPublicId(s.public_id)
    for (const l of [
      'I need a price on 600 gildan 18500 hoodies, screen print, 2 color front',
      'I am Victor Kroll, email ap@harborcity.test and my cell is 555-999-8888',
    ]) await ag.respond(cur(), l, ag.getBotConfig())
  }
  await t('claiming a different channel does not make a stranger verified', () => {
    const v = dbm.get('SELECT * FROM contacts WHERE id = ?', forgedId)
    assert.equal(v.phone, '', `channel forgery let a visitor write ${v.phone} onto an existing customer`)
    assert.equal(dbm.get('SELECT COUNT(*) AS c FROM estimates WHERE contact_id = ?', forgedId).c, 0,
      'nor burn an estimate number on their account')
    const o = dbm.get('SELECT * FROM opportunities WHERE contact_id = ? ORDER BY id DESC', forgedId)
    assert.equal(o?.stage, 'lead')
    assert.match(String(o?.notes || ''), /UNVERIFIED/, 'the one signal a human would catch it by must survive')
  })

  // The other way round: a genuinely NEW lead is their own record, and nothing about that path
  // may change — it is how the receptionist earns its keep.
  await chat([
    'quote 200 gildan 5000 tees, screen print, 1 color front',
    'I am Dana Ruiz, dana@brand-new-lead.test, 619-555-0134',
  ])
  await t('a brand-new lead still gets a contact, a deal in a real column, and a drafted estimate', () => {
    const c = dbm.get("SELECT * FROM contacts WHERE email = 'dana@brand-new-lead.test'")
    assert.ok(c, 'a new visitor still becomes a customer')
    assert.equal(c.phone, '619-555-0134', 'their own details are still captured')
    const o = dbm.get('SELECT * FROM opportunities WHERE contact_id = ? ORDER BY id DESC', c.id)
    // v11 pinned 'qualified' here. 'qualified' is in no STAGE_KEYS, so pipelineBoard() drew this
    // card in NO column — the shop could see it counted and could not touch it. 'quoted' is the
    // stage syncFromEstimate already uses for a priced enquiry that has not been sent.
    assert.equal(o?.stage, 'quoted')
    assert.equal(dbm.get('SELECT COUNT(*) AS c FROM estimates WHERE contact_id = ?', c.id).c, 1)
  })
}

/* ---------- a switch the owner set is a switch the app obeys ----------
 * Settings → Automation Modes reads, in the card body: "Manual mode drafts and waits for a
 * person. You can flip any of them anytime — nothing is ever taken out of your hands."
 *
 * Of the five switches on that card, ONE was honoured. `mode_agent` was read at exactly one place
 * that could never fire — `row.mode || s.mode_agent` where bot_config.mode is TEXT DEFAULT 'ai'
 * and initAgent() always inserts the row, so the left side is never empty. `mode_estimates`,
 * `mode_intake` and `mode_art` were read nowhere in the codebase at all. Reproduced: an owner set
 * both "Website receptionist" and "Estimate drafting" to Ask me first, and an anonymous stranger
 * on the public widget was still quoted $34.75/pc autonomously and still had EST-1015 for $4,195
 * written onto the shop's books. Nobody was asked. */
section('receptionist: "Ask me first" is a switch, not a decoration')
{
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const ag = await import('../lib/agent.mjs')
  const db = new DatabaseSync(':memory:')
  dbm.initDb(db); dbm.setDefaultDb(db); ag.initAgent(db)
  ag.saveBotConfig({ shop_name: 'Manual Mode Shop', name: 'Ari', greeting: 'Hi', capabilities: { quote: true, faq: true, handoff: true } })

  // Distinct phone per visitor: captureLead matches on phone as well as email, so reusing one
  // number would make the second caller a MATCH on the first — a different code path entirely
  // (the one 91d6024 guards) and not what is being tested here.
  const quoteChat = async (email, phone) => {
    const sess = ag.startSession({ channel: 'web' })
    const cur = () => ag.sessionByPublicId(sess.public_id)
    for (const l of [
      'I need a price on 120 gildan 18500 hoodies, screen print, 2 color front',
      `I am Dana Ruiz, ${email}, ${phone}`,
    ]) await ag.respond(cur(), l, ag.getBotConfig())
  }

  await t('with the switch on AI, the receptionist answers on its own — that is the feature', async () => {
    dbm.setSetting('mode_agent', 'ai'); dbm.setSetting('mode_estimates', 'ai')
    assert.equal(ag.getBotConfig().mode, 'ai')
    await quoteChat('auto@newlead.test', '619-555-0134')
    const c = dbm.get("SELECT * FROM contacts WHERE email = 'auto@newlead.test'")
    assert.ok(c, 'the lead is captured')
    assert.equal(dbm.get('SELECT COUNT(*) AS c FROM estimates WHERE contact_id = ?', c.id).c, 1, 'and the estimate is drafted')
  })

  await t('"Ask me first" actually reaches the receptionist', () => {
    dbm.setSetting('mode_agent', 'manual')
    assert.equal(ag.getBotConfig().mode, 'assist', 'the Settings switch was dead code — row.mode is never empty')
  })

  await t('…and no estimate is written on the shop\'s books behind the owner\'s back', async () => {
    dbm.setSetting('mode_estimates', 'manual')
    const before = dbm.get('SELECT COUNT(*) AS c FROM estimates').c
    await quoteChat('asked@newlead.test', '619-555-7788')
    assert.equal(dbm.get('SELECT COUNT(*) AS c FROM estimates').c, before, 'a stranger drafted a numbered estimate with the switch off')
  })

  await t('…while the lead itself is still captured, so the shop loses nothing', () => {
    const c = dbm.get("SELECT * FROM contacts WHERE email = 'asked@newlead.test'")
    assert.ok(c, 'the customer, the conversation and the deal are the point — only the document waits')
    assert.ok(dbm.get('SELECT * FROM opportunities WHERE contact_id = ? ORDER BY id DESC', c.id), 'the deal is still filed')
  })

  await t('flipping it back turns the bot loose again', () => {
    dbm.setSetting('mode_agent', 'ai')
    assert.equal(ag.getBotConfig().mode, 'ai')
  })
}

// The other half of the same switch: the in-app assistant. "Estimate drafting: Ask me first" names
// both the assistant and the receptionist, and neither read it.
await t('the assistant hands back the draft instead of saving it when asked to ask first', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const asst = await import('../lib/assistant.mjs')
  const db = new DatabaseSync(':memory:')
  dbm.initDb(db); dbm.setDefaultDb(db)
  dbm.run('INSERT INTO contacts (name, email, created_at, updated_at) VALUES (?,?,?,?)', 'Northgate', 'ap@northgate.test', dbm.now(), dbm.now())

  dbm.setSetting('mode_estimates', 'manual')
  const held = await asst.ask('quote 200 gildan 5000 tees, 1 color front, for Northgate')
  assert.equal(dbm.get('SELECT COUNT(*) AS c FROM estimates').c, 0, 'nothing may be written to the books')
  assert.match(String(held?.reply || ''), /Ask me first|haven't saved/i, 'and the assistant has to say why')
  assert.ok(held?.prefill?.items?.length, 'the work it already did must not be thrown away')

  dbm.setSetting('mode_estimates', 'ai')
  await asst.ask('quote 200 gildan 5000 tees, 1 color front, for Northgate')
  assert.equal(dbm.get('SELECT COUNT(*) AS c FROM estimates').c, 1, 'and with the switch on AI it still saves')
})

// Every switch on that card must be a switch the app reads. Two of them were read nowhere at all,
// so the card offered a choice the product does not have.
await t('the Automation Modes card offers no switch the app ignores', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const card = readFileSync(join(root, 'public/js/views/misc.js'), 'utf8')
  const offered = [...card.matchAll(/\$\{mode\('(mode_[a-z]+)'/g)].map((m) => m[1])
  assert.ok(offered.length >= 3, 'the card should still offer the modes that work')
  const wired = ['server.mjs', 'lib/agent.mjs', 'lib/assistant.mjs', 'lib/nurture.mjs', 'lib/automations.mjs']
    .map((f) => { try { return readFileSync(join(root, f), 'utf8') } catch { return '' } }).join('\n')
  for (const key of offered) {
    assert.ok(new RegExp(`${key}\\s*(!==|===)`).test(wired), `Settings offers "${key}" and nothing in the app reads it`)
  }
})

/* ---------- …and the switch reaches the buttons, not only the robot (v20) ----------
 * The rule above asks whether ANYTHING reads each mode key, and mode_followups passes it because
 * three other callers do: the automation engine's injected deps, POST /api/reorders/:id/nudge
 * (whose docstring is literally "respects the shop's follow-up mode (drafts in Manual)") and POST
 * /api/invoices/:id/request-payment. The two Follow-ups buttons were the only customer-mail paths
 * in server.mjs that did not, so they took queueEmail's `deliver = true` default: a shop that had
 * set Follow-ups to Manual still had a live customer email leave the building from a 24px button
 * in a table row, with no confirm, no undo, and — because the click handler never awaited the post
 * — a "Follow-up sent" toast even when the send had failed. */
await t('the two Follow-ups buttons obey the same switch the automation engine does', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'server.mjs'), 'utf8')
  for (const [route, what] of [["app.post('/api/estimates/:id/nudge'", 'the quote nudge'], ["app.post('/api/invoices/:id/nudge'", 'the payment reminder']]) {
    const i = src.indexOf(route)
    assert.ok(i > 0, `${route} should still be there`)
    const body = src.slice(i, src.indexOf('\n}))', i))
    assert.match(body, /const deliver = s\.mode_followups !== 'manual'/, `${what} ignores the shop's Manual follow-up mode`)
    assert.match(body, /vars: \{[^}]*\}, deliver \}\)/, `${what} computes deliver and then does not pass it`)
    assert.match(body, /delivered: deliver/, `${what} must tell the screen which of the two things happened`)
    assert.match(body, /\$\{deliver \? 'sent' : 'drafted'\}/, '…and the customer timeline must not say "sent" for a draft')
  }
})
await t('…and the button asks first, and reports what actually happened', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const fu = readFileSync(join(root, 'public/js/views/followups.js'), 'utf8')
  assert.match(fu, /confirmModal\(title,/, 'both buttons mail a live customer with no confirm and no undo')
  assert.match(fu, /There is no way to unsend it/, '…and the copy has to say so')
  // The un-awaited post is the half that made the toast a lie.
  assert.doesNotMatch(fu, /await api\.post\(`\/api\/estimates\/\$\{t\.dataset\.nudgeEst\}\/nudge`\)\n\s*toast\('Follow-up sent/,
    'a rejected send became an unhandled rejection while the toast said it had gone')
  assert.match(fu, /catch \(err\) \{ toast\(err\.message, true\); t\.disabled = false \}/, 'a failure has to be shown and the button given back')
  assert.match(fu, /r\.delivered === false \? `Drafted to the Outbox/, 'in Manual mode the toast must not claim a send')
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

/* ---------- a data restatement runs once, not on every restart ----------
 * applyMigrations() runs on every process start, against every tenant database. An additive
 * schema change is idempotent by construction; an UPDATE that rewrites somebody's DATA is not.
 * The deal-value restatement guarded itself with "does this still equal the total it was written
 * from?", which is not a latch — a person is perfectly entitled to type the tax-inclusive figure,
 * because that is what the customer is going to pay and it is the number on the quote in front of
 * them. So $2,931.45 was rewritten to $2,726.00 at the next restart, and again at the one after
 * they retyped it, forever, from no screen and with nothing on the record to say why. */
/* The builder rendered the stage dropdown from the browser's default selection while
 * `state.params` went to the server empty — so the owner read "new" off the screen and saved a
 * rule that fired on every column. The server refusal (proved in gate-e2e) makes the shape
 * unstorable; this keeps the SCREEN honest, so the common path never has to hit that refusal. */
/* Google Drive was the only integration in the product with a way out. The rest were write-only:
 * a secret field renders blank, blanking it is a deliberate no-op, and there was no route that
 * removed one. A shop whose Slack admin or bookkeeper just left could not take that connection
 * out of the app from any screen. This keeps the next integration from shipping without an exit. */
/* Autopilot stopped marking the estimate approved, raising the invoice and taking the deposit in
 * v1.10.0 — doing any of that fabricated a consent the customer had never given. The SERVER was
 * fixed; the screen went on ticking "Send & approve", "Collect the deposit" and "Onto the floor"
 * green and printing "$3,240 quoted & approved / $0.00 deposit collected" over a database holding
 * a sent estimate, approved_at NULL, no invoice, no payment and a job still at stage 'new'. */
/* The routes were always open; two template conditions on the art card closed them. A customer
 * who asked for changes and then rang back to say "actually v1 is fine" left the shop with a job
 * stuck in art_approval and no button anywhere that could move it. */
section('a rejected proof has a way back')
await t('the art card offers a re-send and a recorded approval on a rejected proof', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'public/js/views/board.js'), 'utf8')
  const i = src.indexOf('data-delart=')
  assert.ok(i > 0, 'the art card action row should still be there')
  const row = src.slice(src.lastIndexOf('wrap-row', i), i)
  assert.match(row, /a\.status === 'draft' \|\| a\.status === 'rejected'/,
    'Send must be reachable on a rejected proof, not only a draft')
  assert.match(row, /data-decide=/, 'and an approval that arrived by phone must have somewhere to be recorded')
  assert.match(src, /decision: 'approved'/, 'with a handler behind it')
})

section('the Autopilot finish screen reports what actually happened')
await t('it does not claim an approval, a deposit or a job on the floor unless they exist', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'public/js/views/autopilot.js'), 'utf8')
  const i = src.indexOf('function doneReveal(')
  assert.ok(i > 0, 'the finish screen should still be there')
  const reveal = src.slice(i, src.indexOf('\n}', i))
  assert.ok(!/quoted &amp; approved<\/em>/.test(reveal),
    'the total must not be labelled approved unconditionally — the server no longer approves anything')
  assert.match(reveal, /r\.estimate\?\.status === 'approved'/, 'the label has to be read off the estimate')
  assert.match(reveal, /r\.invoice \?/, 'and a deposit figure must only appear when an invoice exists')
  // The steps the screen narrates must be steps the server actually marks.
  const server = readFileSync(join(root, 'server.mjs'), 'utf8')
  const commit = server.slice(server.indexOf('function commitAutopilot('), server.indexOf('app.post(\'/api/autopilot/commit\''))
  const marked = new Set([...commit.matchAll(/mark\('([a-z_]+)'/g)].map((m) => m[1]))
  const phase2 = [...src.matchAll(/\{ key: '([a-z_]+)'[^}]*phase: 2/g)].map((m) => m[1])
  assert.ok(phase2.length > 0, 'there should still be a phase-2 step')
  for (const k of phase2) {
    assert.ok(marked.has(k), `the screen narrates a "${k}" step the server never marks — that is how it came to tick three green boxes for work nobody did`)
  }
})

/* ---------- "Run another" is a different customer (v20) ----------
 * uploadedArt is module scope, so it outlives the render — and "Run another" IS autopilotView(),
 * as is navigating away and coming back. It was written on pick and drop and cleared nowhere, while
 * the drop zone repainted to its neutral placeholder. The screen said no file was attached; run()
 * still preferred `uploadedArt` over synthArt(), so the next customer's proof, mockup and job art
 * carried the PREVIOUS customer's logo, uploaded under the new job's number, and the step list
 * reported "Pulled from the attachment" for an attachment that customer never sent.
 * Same shape as the two module-level Maps this codebase has already shipped and had to fix. */
section('"Run another" is a different customer')
await t('the previous customer\'s artwork does not follow the next one onto their job', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'public/js/views/autopilot.js'), 'utf8')
  const i = src.indexOf('export async function autopilotView()')
  assert.ok(i > 0, 'the view function should still be there')
  // Everything from the entry point down to the first `$('#view').innerHTML` — the render is the
  // point of no return, because after it the drop zone is showing the neutral placeholder again.
  const head = src.slice(i, src.indexOf("$('#view').innerHTML", i))
  assert.match(head, /releaseArt\(\)/,
    'autopilotView() must drop the held attachment before it repaints the drop zone empty')
  const rel = src.slice(src.indexOf('function releaseArt()'), src.indexOf('let mode ='))
  assert.match(rel, /uploadedArt = null/, 'releasing has to actually clear the variable run() reads')
  assert.match(rel, /revokeObjectURL/, '…and hand the blob back, or a long shift leaks every file picked')
  // Both the file picker and the drop handler write it; neither may leak the one it replaces.
  const writes = [...src.matchAll(/uploadedArt = URL\.createObjectURL/g)]
  assert.equal(writes.length, 2, 'the picker and the drop zone are the only two writers')
  for (const w of writes) {
    assert.match(src.slice(Math.max(0, w.index - 60), w.index), /releaseArt\(\)/,
      'every write must release the URL it is replacing')
  }
})

section('every stored credential has a way out')
await t('every secret setting belongs to an integration that can be disconnected', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const { SECRET_KEYS } = await import('../lib/db.mjs')
  const src = readFileSync(join(root, 'server.mjs'), 'utf8')
  const i = src.indexOf('const DISCONNECT_GROUPS = {')
  assert.ok(i > 0, 'the grouped disconnect route should still be there')
  const map = src.slice(i, src.indexOf('\n}', i))
  const covered = new Set([...map.matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]))
  // Drive has its own route with its own semantics (it also clears gdrive_connected).
  const driveOwn = (k) => k.startsWith('gdrive_')
  const orphans = SECRET_KEYS.filter((k) => !covered.has(k) && !driveOwn(k))
  assert.deepEqual(orphans, [],
    `these credentials can be set and never removed: ${orphans.join(', ')} — add them to DISCONNECT_GROUPS`)
})
await t('…and the settings form has one value that means erase, distinct from unchanged', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const { CLEAR_SECRET } = await import('../lib/db.mjs')
  assert.ok(CLEAR_SECRET && CLEAR_SECRET !== '', 'blank has to keep meaning "unchanged" — erase needs its own spelling')
  const misc = readFileSync(join(root, 'public/js/views/misc.js'), 'utf8')
  assert.match(misc, /data-disconnect/, 'and the screen has to offer it, not just the API')
})

section('the automation builder saves the trigger it is showing')
await t('an untouched trigger parameter is seeded from its default, not left empty', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'public/js/views/automations.js'), 'utf8')
  const i = src.indexOf('const drawTrigger = () => {')
  assert.ok(i > 0, 'drawTrigger should still be there')
  const head = src.slice(i, src.indexOf('innerHTML', i))
  assert.match(head, /state\.params\[t\.param\.key\] == null/,
    'the builder must seed the parameter it is about to display, or the screen and the saved rule disagree')
  assert.match(src, /needs_setup/, 'and a rule that names no stage has to be visible on the list')
})

section('a migration that rewrites data runs once, ever')
await t('the restatement still fixes a value that was never touched by a person', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbmod = await import('../lib/db.mjs')
  const mem = new DatabaseSync(':memory:')
  dbmod.initDb(mem)
  mem.exec('DELETE FROM schema_migrations')   // a database from before the latch existed
  mem.exec(`INSERT INTO estimates (id, estimate_number, status, items, subtotal, tax, total)
              VALUES (1, 'EST-1', 'sent', '[]', 2726.00, 205.45, 2931.45);
            INSERT INTO opportunities (id, estimate_id, title, value, stage)
              VALUES (1, 1, 'Spirit wear', 2931.45, 'quoted');`)
  dbmod.initDb(mem)
  assert.equal(mem.prepare('SELECT value AS v FROM opportunities WHERE id = 1').get().v, 2726,
    'a deal value nobody has typed must still be corrected to exclude sales tax')
  mem.close()
})
await t('…and never rewrites the figure a person typed afterwards', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbmod = await import('../lib/db.mjs')
  const mem = new DatabaseSync(':memory:')
  dbmod.initDb(mem)
  mem.exec(`INSERT INTO estimates (id, estimate_number, status, items, subtotal, tax, total)
              VALUES (1, 'EST-1', 'sent', '[]', 2726.00, 205.45, 2931.45);`)
  // The owner types what the customer is actually going to pay. It happens to equal the total.
  mem.exec(`INSERT INTO opportunities (id, estimate_id, title, value, stage)
              VALUES (1, 1, 'Spirit wear', 2931.45, 'quoted');`)
  for (let restart = 0; restart < 3; restart++) dbmod.initDb(mem)
  assert.equal(mem.prepare('SELECT value AS v FROM opportunities WHERE id = 1').get().v, 2931.45,
    'three restarts must not touch a number a person put there')
  mem.close()
})
await t('…and the latch is recorded where a human can see it', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbmod = await import('../lib/db.mjs')
  const mem = new DatabaseSync(':memory:')
  dbmod.initDb(mem)
  const row = mem.prepare("SELECT name, applied_at FROM schema_migrations WHERE name = 'opportunity_value_excludes_tax'").get()
  assert.ok(row, 'the one-shot restatement should record that it ran')
  assert.ok(row.applied_at, 'and when')
  mem.close()
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
/* The column order of the file decided which of two synonyms won, and the shop exporting the file
 * has no idea it is choosing. Every real order export writes `Subtotal, Sales Tax, Total` in that
 * order, and `subtotal` and `total` are both synonyms for `total` — so the PRE-TAX figure won and
 * the invoice was raised, unpaid, at the wrong number, then chased at that number by A/R aging,
 * the customer statement, the Outstanding KPI, the dunning email and the QuickBooks export. A
 * shop migrating a year of open receivables at 8.25% imported $60,000 of A/R as $55,427. There is
 * no undo on the importer, so the only repair was a hand re-import. */
await t('a Subtotal column does not outrank Total, whichever order the file lists them in', async () => {
  const { parseCsv, mapOrderRows } = await import('../lib/csv.mjs')
  const read = (csv) => mapOrderRows(parseCsv(csv)).orders[0]
  // The layout every real export actually uses.
  const a = read('order #,customer,qty,subtotal,sales tax,total\n5001,Harbor City,300,2775.00,228.94,3003.94')
  assert.equal(a.total, 3003.94, 'the pre-tax subtotal was imported as the amount due — $228.94 of a real balance dropped')
  // The same order, columns the other way round. It must not change the money.
  const b = read('order #,customer,qty,total,sales tax,subtotal\n5001,Harbor City,300,3003.94,228.94,2775.00')
  assert.equal(b.total, a.total, 'column order must not change what the customer owes')
  // A file that carries ONLY a subtotal column is unchanged — that is still the best figure it has.
  assert.equal(read('order #,customer,qty,subtotal\n5001,Harbor City,300,2775.00').total, 2775)
  // Same defect, same fix, on the other two fields where one synonym list holds two live names.
  // `company` is ranked above a bare `name` on purpose — `Name` alone could be a product name —
  // and the point here is that the ranking, not the file's column order, is what decides.
  const c1 = read('order #,company,name,qty,total\n5001,Harbor City LLC,Dana Reyes,300,3003.94')
  const c2 = read('order #,name,company,qty,total\n5001,Dana Reyes,Harbor City LLC,300,3003.94')
  assert.equal(c1.customer_name, 'Harbor City LLC', 'the ranked synonym must win')
  assert.equal(c2.customer_name, c1.customer_name, 'column order must not change who the customer is')
  const d = read('order #,customer,qty,rate,unit price,total\n5001,Harbor City,300,1.00,9.25,3003.94')
  assert.equal(d.unit_price, 9.25, '`unit price` outranks `rate`, whatever order the columns come in')
  // A caller-supplied header alias is an explicit instruction and still beats every synonym.
  const e = mapOrderRows(parseCsv('order #,customer,qty,widget total,total\n5001,Harbor City,300,111.00,3003.94'),
    { headerAliases: { 'widget total': 'total' } }).orders[0]
  assert.equal(e.total, 111, 'an explicit headerAlias must outrank the built-in synonyms')
})
await t('European thousands-dot money parses as thousands, not a decimal', async () => {
  const { coerceMoney } = await import('../lib/csv.mjs')
  assert.equal(coerceMoney('1.200'), 1200)      // was 1.2 — a 1000x understatement
  assert.equal(coerceMoney('1.200.000'), 1200000)
  assert.equal(coerceMoney('240.00'), 240)      // a real decimal is still a decimal
  assert.equal(coerceMoney('1.284,50'), 1284.5)
})
// …but the thousands reading must not eat an ordinary three-decimal price, and the cents reading
// must not stop at three figures. Both were wrong by a factor of a thousand and a hundred.
await t('a three-decimal unit price is not read as thousands', async () => {
  const { coerceMoney } = await import('../lib/csv.mjs')
  // Nobody writes a thousands group with a leading zero. "0.750" is how three-decimal unit prices
  // come out of plenty of exports, and it was importing as $750.00 — then multiplied by the line
  // quantity, on every row it touched.
  assert.equal(coerceMoney('0.750'), 0.75)
  assert.equal(coerceMoney('0.005'), 0.005)
  assert.equal(coerceMoney('1.200'), 1200, 'and the European thousands case still reads as thousands')
})
await t('a four-figure European total keeps its cents', async () => {
  const { coerceMoney } = await import('../lib/csv.mjs')
  // A thousands group is always exactly three digits, so ",dd" at the end of the string can never
  // be one — whatever precedes it. Bounding the integer part at three digits stripped the comma
  // out of "1234,56" and imported it as $123,456.00.
  assert.equal(coerceMoney('1234,56'), 1234.56)
  assert.equal(coerceMoney('12345,99'), 12345.99)
  assert.equal(coerceMoney('12,50'), 12.5)
  assert.equal(coerceMoney('1,200'), 1200, 'and a US thousands group is still a thousands group')
  assert.equal(coerceMoney('1,200.50'), 1200.5)
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

await t('a wrong-typed field is refused, not silently applied to the shop\'s prices', async () => {
  const { sanitize, TEMPLATES } = await import('../lib/matrices.mjs')
  const tpl = TEMPLATES.find((x) => x.key !== 'blank')
  const base = sanitize(tpl)
  const priced = base.cells[0][0]
  assert.ok(priced > 0, 'precondition: the template starts with real prices')

  // `cells` used to be taken as `input.cells ?? base.cells` and handed to resizeGrid(), which
  // answers a grid of NULLS for anything that is not an array of arrays. So a client that
  // stringified the grid — a CSV paste, a spreadsheet cell, a Zapier field mapping — sent
  // {"cells":"18,20,26"} and got a 200 with every price in the sheet erased. Nothing in the
  // response said so; the shop found out when a quote came back blank.
  for (const bad of ['18,20,26', 5, {}, '', true]) {
    assert.throws(() => sanitize({ ...tpl, cells: bad }, base), /cells must be an array/i,
      `cells: ${JSON.stringify(bad)} must be refused`)
  }
  // null and omitted still mean "leave the prices alone" — the documented behaviour.
  assert.equal(sanitize({ ...tpl, cells: null }, base).cells[0][0], priced)
  const { cells: _drop, ...noCells } = tpl
  assert.equal(sanitize(noCells, base).cells[0][0], priced)

  // rows/cols were the quieter half: silently ignored, so a rename that never happened said "saved".
  assert.throws(() => sanitize({ ...tpl, rows: 'a,b' }, base), /rows must be an array/i)
  assert.throws(() => sanitize({ ...tpl, cols: {} }, base), /cols must be an array/i)

  // `unit` decides whether a cell is multiplied by the order quantity or charged once. Any value
  // that was not exactly lowercase 'flat' became 'piece' with a 200, so a setup-fee sheet saved
  // from a select whose option label reads "Flat" started multiplying a one-off charge by the run.
  const flat = sanitize({ ...tpl, unit: 'flat' }, base)
  assert.equal(flat.unit, 'flat')
  assert.equal(sanitize({ ...tpl, unit: 'Flat' }, flat).unit, 'flat', 'a select label is still the same unit')
  assert.equal(sanitize({ ...tpl, unit: 'FLAT ' }, flat).unit, 'flat')
  assert.throws(() => sanitize({ ...tpl, unit: 'bananas' }, flat), /unit must be/i)
  assert.throws(() => sanitize({ ...tpl, unit: 'per-piece' }, flat), /unit must be/i)
  assert.equal(sanitize({ ...tpl, unit: undefined }, flat).unit, 'flat', 'omitting unit keeps it')
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
/* on() attaches a listener; it does not replace one. #view is repainted and never replaced, so
 * every binding made during a render stacked, and the same click ran the handler once more each
 * time. This has been fixed three times in three different screens now (84ee9ad was the last)
 * because it is invisible at the call site — the code reads correctly and only misbehaves the
 * second time you open the page. Measured at HEAD with the real core.js:
 *   Books   — retry click 1 fired 1 QuickBooks retry, click 2 fired 2, click 3 fired 4, then 8, 16
 *   Matrices— one click of Duplicate made 2 copies, then 4, then 32, with no cap and no bulk delete
 *   Matrix editor — ONE click of a row's × deleted TWO rows of prices, with no confirm and no undo
 *   Developers — three visits, then one click rotated the API key 3 times, so the owner copies a
 *                key that is already dead
 * onOnce() is keyed on (root, event, selector), so the fourth instance of this cannot ship. */
/* lib/db.mjs stores UTC as 'YYYY-MM-DD HH:MM:SS' — no T, no Z — and new Date() parses that shape
 * as LOCAL time. fmtDate() handed it straight over; relTime(), five lines below, appends the Z.
 * So the same stored value rendered two different days on the same screen: an invoice created at
 * 9:05pm Pacific showed "Aug 28" in the Created column while relTime beside it said "just now".
 * Every date the app printed for a stored timestamp was a day wrong west of UTC after ~5pm, and
 * a day wrong the other way east of it late at night. today() was UTC too, and it feeds the
 * board's overdue colouring and the convert dialog's due date — which is POSTed and stored
 * verbatim on invoices.due_date and jobs.due_date. Run in a child process because TZ has to be
 * set before the first Date use in the process. */
section('the app prints the day a timestamp actually happened')
for (const [tz, stored, want, why] of [
  ['America/Los_Angeles', '2026-08-28 04:05:20', 'Aug 27', '9:05pm Pacific is still the 27th'],
  ['America/Los_Angeles', '2026-08-28', 'Aug 28', 'a bare date is a calendar day and must not move'],
  ['Europe/Berlin', '2026-08-27 23:30:00', 'Aug 28', '23:30 UTC is already the 28th in Berlin'],
  ['UTC', '2026-08-28 04:05:20', 'Aug 28', 'UTC is unchanged'],
]) {
  await t(`${tz}: ${stored} prints ${want} — ${why}`, async () => {
    const { execFileSync } = await import('node:child_process')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const m = await import(${JSON.stringify(join(root, 'public/js/core.js'))})
      process.stdout.write(m.fmtDate(${JSON.stringify(stored)}))
    `], { env: { ...process.env, TZ: tz }, encoding: 'utf8' })
    assert.equal(out.trim(), want)
  })
}
/* ---------- Floor Mode is the one screen that never adopted the date helpers ----------
 * The scan log under every job printed `String(s.created_at).slice(5, 16)` — a raw chop of the
 * UTC text lib/db.mjs stores. Measured on a scratch install: a scan taken at 03:59 PDT rendered as
 * "08-29 10:59" on the tablet, seven hours out. The same card, two lines above, prints the correct
 * server-computed "N min measured in production" — so it contradicted itself, and those timestamps
 * are the labor actuals the shop's own profitability report is built on. The due date beside it
 * was printed as a bare ISO string for the same reason. core.js has compensated for this since
 * 629f4dc; scan.js just never imported it. */
/* ---------- a formatter may not emit markup ----------
 * fmtDate() ended `if (isNaN(dt)) return String(d)` — it handed an unparseable value straight
 * back — and a dozen render sites treat fmtDate() as safe and omit esc(): contacts.js:241,
 * followups.js:56/72, dashboard.js:49/50, capacity.js:135/136, board.js:323/327. jobs.due_date
 * was free text on POST and PUT /api/jobs, so a `staff` account could plant a payload that ran as
 * the owner on five ordinary screens. relTime() falls through to fmtDate, so it inherited it. */
/* ---------- a shop's customer mail goes out on the shop's own account ----------
 * smtpCreds() read `process.env.SMTP_HOST || s?.smtp_host` — the operator's environment FIRST —
 * which inverts both its own docstring ("Credentials live in the shop's own settings (never
 * ours)") and .env.example, where the server-wide values are documented as "a fallback". On a
 * multi-tenant box one SMTP_HOST in the operator's .env sent EVERY shop's customer mail through
 * the operator's server, as the operator's address, including shops that had wired their own
 * domain in Settings and could see it there listed as connected. Measured with two SMTP catchers:
 * the shop's own server received nothing. lib/suppliers.mjs:178 already makes this argument for
 * distributor accounts, where env-first would price a shop's jobs off somebody else's rate card. */
/* ---------- the documented production install can actually complete ----------
 * deploy/printshopcrm.service has always shipped `User=printshopcrm`, and NOTHING in the repo ever
 * created that account — no useradd, no adduser, no DynamicUser, anywhere. On a stock Ubuntu box
 * INSTALL.md's `systemctl enable --now printshopcrm` therefore fails with
 * "Failed to determine user credentials: No such process" / status=217/USER, and Restart=always
 * retries it forever. The second half compounded it: the two chown lines handed /opt/printshopcrm
 * and /var/lib/printshopcrm to "$USER", the INTERACTIVE account — so even an operator who worked
 * the account out for themselves got "could not create its data directory" or "attempt to write a
 * readonly database". The rule was stated only in Troubleshooting, after the failure. */
/* ---------- a control a screen reader can only call "times" ----------
 * The accessible name of a <button> is taken from its CONTENT before its title (accname 4.3.2:
 * step 2F precedes 2I), so a button whose text is `&times;` is announced "times, button" and a
 * title="Remove" on the same element is never used for the name. Twelve of them, including delete
 * a recorded payment, remove a team member and delete an automation — every one destructive.
 * matrices.js already shipped the correct pattern; the rule below is written over every view so
 * the thirteenth is caught when it is written rather than in a later audit. */
/* ---------- a screen does not throw away work nobody asked it to throw away ----------
 * Round 15 closed the half-written REPLY. Three more of the same shape were left, on the two
 * screens where a shop types the most before it saves once. */
section('the app does not discard what the shop has typed')
{
  const readFile = async (f) => {
    const fs = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    return fs.readFileSync(join(join(dirname(fileURLToPath(import.meta.url)), '..'), f), 'utf8')
  }

  /** Source with comments removed — these rules are about what the code DOES. */
  const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  await t('saving one price-book service does not throw away the other services (v20)', async () => {
    const pb = code(await readFile('public/js/views/pricing.js'))
    // The price book is a stack of one card per service with six number fields each, and going
    // down the page retyping rates is exactly how a shop uses it. Saving the first card fired
    // `setTimeout(() => loadBook(), 700)`, and loadBook() does `#view`.innerHTML — so every number
    // typed into every OTHER card reverted 700 ms later, under a green "Saved".
    const save = pb.slice(pb.indexOf("'.pb-save'"), pb.indexOf("'.pb-reset'"))
    assert.ok(save.length > 40, 'the save handler should still be there')
    assert.doesNotMatch(save, /loadBook\(\)/, 'saving one service must not repaint the whole screen over the others')
    assert.match(save, /card\.outerHTML = serviceCard\(/, '…it refreshes the one card it saved')
    // The matrix redraw is the same shape: a 600 ms rebuild landing on a shop still typing the
    // next cell of an 8 × 14 grid, reverting it silently and destroying focus.
    assert.doesNotMatch(pb, /setTimeout\(\(\) => loadMatrix\(\), 600\)/, 'the unguarded matrix redraw is back')
    const guard = pb.slice(pb.indexOf('function reloadMatrixUnlessTyping'), pb.indexOf('let bookBound'))
    assert.match(guard, /closest\?\.\('\.pm-editable'\)/, 'the redraw has to stand down while the grid is being typed in')
  })

  await t('Settings is one form with one Save, and nothing on it silently repaints', async () => {
    const misc = code(await readFile('public/js/views/misc.js'))
    // Five controls on the settings page used to re-render it from the STORED values with no
    // prompt: a logo upload, a logo removal, returning from Stripe Connect, and both Disconnect
    // buttons — the last two via location.reload(), which also drops the hash route. An owner who
    // pasted their SMTP password, Stripe keys and costing numbers and then uploaded their logo
    // got "Logo saved" and an empty form.
    assert.doesNotMatch(misc, /location\.reload\(\)/, 'Settings must not hard-reload over an unsaved form')
    assert.match(misc, /let settingsDirty = false/, 'it has to know whether anything is unsaved')
    assert.match(misc, /const repaint = \(\)/, 'and go through one guarded repaint')
    assert.doesNotMatch(misc, /toast\('Logo saved'\)\s*\n\s*settingsView\(\)/, 'a logo upload must not repaint over typed settings')
    assert.match(misc, /beforeunload/, 'and the tab-close path needs the same promise the matrix editor makes')
  })

  await t('answering a website chat does not wipe the knowledge base being written', async () => {
    const agent = code(await readFile('public/js/views/agent.js'))
    // The receptionist screen holds the bot name, greeting, persona, capability switches, a 160px
    // knowledge-base textarea and every FAQ row — none of it on the server until Save is pressed.
    assert.doesNotMatch(agent, /toast\('Reply sent'\); agentView\(\)/, 'a takeover reply must not rebuild the page')
    assert.match(agent, /renderSessions\(fresh\.sessions\)/, 'it should refresh only the chats list')
    assert.match(agent, /window\.__pscAgentDirty/, 'and publish whether the form is dirty')
  })

  await t('…and neither does a colleague answering one from their own desk', async () => {
    const app = code(await readFile('public/js/app.js'))
    // server.mjs rtBroadcast('chat') on every takeover reply goes to the WHOLE shop room.
    assert.doesNotMatch(app, /path\.startsWith\('\/conversations'\) \|\| path\.startsWith\('\/receptionist'\)\) runRouter\(\)/,
      'a realtime chat event must not blow away a half-written knowledge base')
    assert.match(app, /__pscAgentDirty\?\.\(\)/, 'the realtime handler has to ask first')
  })

  await t('the setup wizard does not say "done" when the prices did not save', async () => {
    const ob = code(await readFile('public/js/views/onboarding.js'))
    // `.catch(() => {})` on the service-pricing PUT, then markStep('done') and advance(). A 400, a
    // 403 from requireRole, a 500 or the restart window all ended with the wizard sliding to the
    // next screen — and every quote the shop writes priced off the defaults.
    assert.doesNotMatch(ob, /service-pricing[^\n]*\.catch\(\(\) => \{\}\)/,
      'the wizard must not swallow a failed price save and advance anyway')
    assert.doesNotMatch(ob, /onboarding\/step[^\n]*\.catch\(\(\) => \{\}\)/,
      'a checklist tick that did not record must say so')
  })

  /* ---------- the estimate editor, the LAST screen with no guard at all ----------
   * The price-matrix grid and the settings form both grew one. The estimate editor — a customer,
   * a tax rate, N garment lines with a size grid each, a parsed email, a calculated quote line
   * and a customer-facing notes block, none of it on the server until Save — had zero: no
   * `dirty`, no beforeunload, no confirm. Cancel, a sidebar click, `g e`, the browser's Back
   * button and a tab close every one of them discarded the whole quote in silence.
   *
   * The router had no way to refuse a hash change either, which is why the fix is a state
   * machine and not an `if`: putting the URL back fires hashchange AGAIN, and that second event
   * would re-run the router and repaint the editor — destroying exactly what is being saved. */
  await t('a hash change can be refused, and putting the URL back does not repaint the screen', async () => {
    // The shipped module, imported and run — not a copy of it.
    const { createNavGuard } = await import('../public/js/shared/navguard.js')
    const put = []
    const g = createNavGuard((h) => put.push(h))

    assert.equal(g.accept('#/estimates/5/edit'), true, 'the first navigation is never guarded')
    assert.equal(g.armed(), false, 'and it arrives with nothing armed')

    let dirty = true
    g.register(() => !dirty)
    assert.equal(g.armed(), true, 'the editor arms the guard')

    assert.equal(g.accept('#/dashboard'), false, 'a dirty editor refuses the navigation')
    assert.deepEqual(put, ['#/estimates/5/edit'], 'and the URL is put back to where the shop still is')
    assert.equal(g.accept('#/estimates/5/edit'), false,
      'the revert\'s own hashchange must NOT repaint — that repaint is the data loss')
    assert.equal(g.armed(), true, 'the guard survives its own revert; the work is still unsaved')

    dirty = false // "Discard changes"
    assert.equal(g.accept('#/dashboard'), true, 'once discarded, the navigation goes through')
    assert.equal(g.armed(), false, 'and the guard is disarmed for the screen being drawn')
    assert.equal(g.accept('#/invoices'), true, 'so the next screen is not guarded by the last one')
    assert.deepEqual(put, ['#/estimates/5/edit'], 'nothing else was ever reverted')

    // A guard that throws must not wedge the shop on one screen forever.
    const t2 = createNavGuard(() => {})
    t2.accept('#/a'); t2.register(() => { throw new Error('boom') })
    assert.equal(t2.accept('#/b'), true, 'a broken guard is ignored, never a trap')
  })

  await t('the estimate editor arms that guard, and knows when it is dirty', async () => {
    const est = code(await readFile('public/js/views/estimates.js'))
    assert.match(est, /guardLeave\(/, 'the editor must register a leave guard')
    assert.match(est, /let editorDirty = false/, 'and track whether anything is unsaved')
    assert.match(est, /beforeunload/, 'the tab-close path needs the same promise the matrix editor makes')
    assert.match(est, /confirmModal\('Leave without saving\?'/, 'and the shop gets asked, not told')
    // Typing anywhere in the editor counts.
    assert.match(est, /onOnce\(\$\('#view'\), 'input, select, textarea', markEditorDirty, 'input'\)/, 'every typed character')
    assert.match(est, /onOnce\(\$\('#view'\), 'input, select, textarea', markEditorDirty, 'change'\)/, '…and every picker')
    // So do the mutations that emit no input event at all: adding a line, pricing off a matrix,
    // the calculator, a parsed email, adding a size, deleting a line. All of these were the
    // expensive ones — ten minutes of work that never touched a keystroke the DOM reported.
    assert.equal((est.match(/markEditorDirty\(\)/g) || []).length >= 7, true,
      'the structural edits (add line, matrix, calculator, parsed email, add size, delete line) must mark it too')
    // Saving must not then ask on the way out.
    assert.match(est, /editorDirty = false[^\n]*\n\s*toast\(isNew \? `Estimate/, 'a saved estimate leaves without a prompt')
  })

  await t('every hash change in the app goes through that one choke point', async () => {
    const app = code(await readFile('public/js/app.js'))
    const core = code(await readFile('public/js/core.js'))
    assert.match(app, /if \(!acceptRoute\(location\.hash \|\| '#\/'\)\) return/,
      'navigate() must ask before it repaints, and bail when refused')
    // The bail has to come BEFORE the router runs, or the guard is decoration.
    assert.ok(app.indexOf('acceptRoute(') < app.indexOf('await runRouter()'),
      'the guard has to be asked before runRouter(), not after')
    assert.match(core, /export const guardLeave = \(fn\) => navGuard\.register\(fn\)/, 'views arm it through core')
    assert.match(core, /export const acceptRoute = \(target\) => navGuard\.accept\(target\)/, 'and the router asks through core')
  })
}

/* ---------- the starter automations stay deleted ----------
 * seedAutomations() guarded on "are there any rows?" rather than "have we ever done this?", and
 * bootstrapDb calls it on every tenant-database open — the first request for each shop after
 * every restart and every deploy. A shop that switched the starter rules off by deleting them had
 * all eleven back, enabled, at the next deploy. Seven of them send something to a real customer,
 * and one of those is SMS on the shop's own Twilio token. */
/* ---------- editing a job does not silently rewrite what it is ----------
 * jobs.decoration is not limited to board.js's eight built-ins: convert writes the price-matrix
 * NAME when a line was priced off one of the shop's own sheets, because estimates.js deliberately
 * blanks that line's decoration. The edit form's select listed only the eight, so the browser
 * selected the first option, the field read "Screen Print", and formData() sent it on every save.
 * Changing a due date rewrote what the job IS — on the work ticket, the pick ticket, the packing
 * slip and Floor Mode — with no warning and no undo. */
/* ---------- one click, one record ----------
 * estimates.js's Create has been guarded since round 14 ("two clicks made two estimates, with two
 * estimate numbers, and the shop then has to work out which one the customer was sent"), and four
 * controls with exactly that shape never got it. */
/* ---------- no screen may end in a state with no control on it ---------- */
section('a failed Autopilot run is not a dead end')
await t('the error branch puts the Run button back and keeps the pasted email', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'public/js/views/autopilot.js'), 'utf8')

  // run() replaces #ap-stage.innerHTML at the top, and the only Run button in the product lives
  // in the block it replaces. The catch used to APPEND an error line, leaving the screen the
  // product is named for with no control at all: "Run another" exists only on the two success
  // paths, and the sidebar's Autopilot link sets the hash it is already on, which fires no
  // hashchange and repaints nothing. The one escape was F5 — which re-runs autopilotView() and
  // draws #ap-text empty, taking the customer's pasted email with it.
  const catchBlock = src.slice(src.indexOf('} catch (e) {', src.indexOf('async function run()')), src.indexOf('/** Review mode'))
  assert.ok(catchBlock.length > 40, 'found run()\'s catch')
  assert.doesNotMatch(catchBlock, /innerHTML \+=/, 'appending an error leaves a screen with no control on it')
  assert.match(catchBlock, /id="ap-run"/, 'the error state has to carry a Run button')
  assert.match(catchBlock, /\$\('#ap-run'\)\.onclick = run/, '…and it has to be bound')
  assert.doesNotMatch(catchBlock, /\$\('#ap-text'\)/, 'and it must not touch the paste')
  assert.match(catchBlock, /role="alert"/, 'the message is announced, not just drawn')
  // The paste really does live outside the block run() replaces, or none of the above helps.
  const stage = src.slice(src.indexOf('id="ap-stage"'), src.indexOf('id="ap-run"'))
  assert.doesNotMatch(stage, /ap-text/, '#ap-text must not be inside #ap-stage')
})

section('a second click does not make a second record')
{
  await t('the shared guard really runs its handler once', async () => {
    const { readFileSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const core = readFileSync(join(root, 'public/js/core.js'), 'utf8')
    const body = core.slice(core.indexOf('export function onceClick('), core.indexOf('export function formData('))
    assert.ok(body.length > 60, 'core.js must export the guard')
    const onceClick = new Function(`${body.replace('export function', 'function')}; return onceClick`)()

    // A fake button, and a request that has not come back yet.
    const btn = { disabled: false, textContent: 'Create Job', onclick: null }
    let calls = 0
    let settle
    onceClick(btn, 'Creating…', () => { calls++; return new Promise((r) => { settle = r }) })
    btn.onclick(); btn.onclick(); btn.onclick()
    assert.equal(calls, 1, 'three clicks on shop wifi must make one record')
    assert.equal(btn.disabled, true, 'and the button says so')
    assert.equal(btn.textContent, 'Creating…', '…and shows progress, which is why it was clicked twice')
    settle()
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(btn.disabled, false, 'a refused save must still be editable')
    assert.equal(btn.textContent, 'Create Job', 'and the label the shop was reading comes back')

    // A handler that throws must not leave the button dead — that is a dead end with no way out.
    const b2 = { disabled: false, textContent: 'Send', onclick: null }
    onceClick(b2, 'Sending…', async () => { throw new Error('smtp refused') })
    await b2.onclick().catch(() => {})
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(b2.disabled, false, 'a thrown handler re-enables the button')
    assert.equal(b2.textContent, 'Send')
    assert.equal(onceClick(null, 'x', () => {}), null, 'a control that is not rendered is not an error')
  })

  await t('…and the four controls that create or send are wired to it', async () => {
    const { readFileSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const read = (f) => readFileSync(join(root, f), 'utf8')
    // A second job number means a second purchase order, print package, work ticket and capacity
    // claim, with nothing on the board saying they are the same order.
    assert.match(read('public/js/views/board.js'), /onceClick\(\$\('#save', bg\)/, 'New Job')
    // A second customer splits that customer's job history, lifetime value and A/R balance across
    // two rows, and there is no merge anywhere in the product.
    assert.match(read('public/js/views/contacts.js'), /onceClick\(\$\('#save', bg\)/, 'New Customer')
    // These two mail a live customer.
    assert.match(read('public/js/views/invoices.js'), /onceClick\(\$\('#send'\)/, 'Send Invoice')
    assert.match(read('public/js/views/estimates.js'), /onceClick\(\$\('#send'\)/, 'Send Estimate')
  })
}

section('the job form does not lie about what a job is')
await t('a decoration outside the eight built-ins survives an edit', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'public/js/views/board.js'), 'utf8')

  // Run the shipped helper, not a copy of it.
  const body = src.slice(src.indexOf('const decoOptions = (cur) =>'), src.indexOf('\nconst boardState'))
  assert.ok(body.length > 40, 'the job form must build its options through a helper')
  const DECORATIONS = ['Screen Print', 'DTF Transfer', 'Embroidery', 'UV DTF', 'Vinyl', 'Patch', 'Laser', 'Promo']
  const decoOptions = new Function('DECORATIONS', 'esc', `${body}; return decoOptions`)(
    DECORATIONS, (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])))

  // What convert actually stores for a matrix-priced job.
  const mug = decoOptions('Mug Printing')
  assert.match(mug, /<option selected>Mug Printing<\/option>/, 'the stored value has to be an option, and the selected one')
  assert.equal((mug.match(/selected/g) || []).length, 1, 'exactly one option is selected')
  // The eight are all still offered, so the shop can still change it.
  for (const d of DECORATIONS) assert.ok(mug.includes(`>${d}</option>`), `${d} is still offered`)

  // The ordinary cases are unchanged.
  assert.match(decoOptions('Embroidery'), /<option selected>Embroidery<\/option>/)
  assert.match(decoOptions(''), /<option selected>Screen Print<\/option>/, 'a new job still defaults')
  assert.match(decoOptions(undefined), /<option selected>Screen Print<\/option>/)
  // A matrix name is shop-typed text on a screen that renders with innerHTML.
  assert.ok(!decoOptions('<img src=x onerror=alert(1)>').includes('<img'), 'the stored value is escaped')

  // And the form really uses it.
  assert.match(src, /name="decoration">\s*\$\{decoOptions\(job\?\.decoration\)\}/,
    'the select must be built from the helper')
})

section('a rule the shop deleted does not come back on the next deploy')
{
  const setupShop = async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const dbm = await import('../lib/db.mjs')
    const au = await import('../lib/automations.mjs')
    const db = new DatabaseSync(':memory:')
    dbm.initDb(db); dbm.setDefaultDb(db); au.initAutomations(db)
    return { dbm, au }
  }

  await t('a brand-new shop is still seeded with the starter rules', async () => {
    const { dbm, au } = await setupShop()
    assert.equal(au.seedAutomations(), 11, 'eleven rules on a fresh shop')
    assert.equal(dbm.get('SELECT COUNT(*) AS c FROM automations').c, 11)
  })

  await t('…and once deleted they stay deleted, restart after restart', async () => {
    const { dbm, au } = await setupShop()
    au.seedAutomations()
    // Seven of the eleven mail or text a live customer. Name them, so a future edit to
    // STARTER_AUTOMATIONS that adds an eighth is measured against the same standard.
    const billable = dbm.all("SELECT name FROM automations WHERE actions LIKE '%sms.customer%' OR actions LIKE '%email.customer%'")
    assert.ok(billable.length >= 5, 'the starter set really does send to customers')
    dbm.run('DELETE FROM automations')
    assert.equal(au.seedAutomations(), 0, 'a restart must not re-seed')
    assert.equal(au.seedAutomations(), 0, 'nor a deploy after it')
    assert.equal(dbm.get('SELECT COUNT(*) AS c FROM automations').c, 0, 'the shop\'s decision holds')
    assert.equal(dbm.get('SELECT COUNT(*) AS c FROM automations WHERE enabled = 1').c, 0,
      'and nothing came back switched on')
  })

  await t('an existing install upgrading is latched without being re-seeded', async () => {
    // Two shapes, both of which must be left exactly as they are: rules intact, and rules the
    // shop had already deleted before this latch existed.
    const withRules = await setupShop()
    withRules.dbm.run("INSERT INTO automations (name, enabled, trigger, params, conditions, actions) VALUES ('mine',1,'job.stage','{}','[]','[]')")
    assert.equal(withRules.au.seedAutomations(), 0)
    assert.equal(withRules.dbm.get('SELECT COUNT(*) AS c FROM automations').c, 1, 'their one rule, untouched')

    const emptied = await setupShop()
    emptied.dbm.run("INSERT INTO contacts (name, email) VALUES ('C','c@x.test')")
    assert.equal(emptied.au.seedAutomations(), 0, 'a shop that has customers and no rules chose that')
    assert.equal(emptied.dbm.get('SELECT COUNT(*) AS c FROM automations').c, 0)
  })

  await t('the seed and its latch land together', async () => {
    const { dbm, au } = await setupShop()
    au.seedAutomations()
    assert.ok(dbm.get("SELECT 1 AS x FROM schema_migrations WHERE name = 'seed_starter_automations'"),
      'a half-seeded shop must not be able to seed again on top of itself')
  })
}

section('every destructive control says what it destroys')
await t('no glyph-only button is left for a screen reader to guess at', async () => {
  const fs = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const files = fs.readdirSync(join(root, 'public/js/views')).map((n) => `public/js/views/${n}`)
    .concat(['public/js/keys.js', 'public/js/core.js', 'public/js/app.js'])
  // The rule caught the five glyphs that were in the file when it was written. Two more had been
  // added since and were announced as "plus, button": the estimate size grid renders one PER LINE
  // ITEM, so a five-line quote reads out as five identical "plus" controls with no clue which line
  // each belongs to, and the gang-sheet duplicate is the same. Widen it so the eighth is caught
  // when it is written rather than in a later audit — a minus, an ellipsis and a dash are the next
  // obvious ones, and none of them names anything either.
  const GLYPH = /<button(?![^>]*aria-label)[^>]*>\s*(?:&times;|×|✕|↑|↓|＋|\+|−|–|—|⋯|…)\s*<\/button>/
  for (const f of files) {
    const src = fs.readFileSync(join(root, f), 'utf8')
    assert.doesNotMatch(src, GLYPH, `${f} has a glyph-only button with no aria-label — a screen reader calls it "times"`)
  }
})
await t('a refused field says so where the field is, not only in a silent div', async () => {
  const fs = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const read = (f) => fs.readFileSync(join(root, f), 'utf8')
  // Every inline validation message was written into a plain styled <div>: no role, no aria-live,
  // no announce(), and there was no aria-invalid or aria-describedby anywhere in public/ at all.
  for (const [f, id] of [
    ['public/js/views/estimates.js', 'nc-err'],
    ['public/js/views/matrices.js', 'mx-n-err'],
    ['public/js/views/matrices.js', 'mx-paste-err'],
    ['public/js/views/admin.js', 'ns-err'],
  ]) {
    assert.match(read(f), new RegExp(`id="${id}"[^>]*role="alert"`), `${f}: #${id} must be a live region`)
  }
  assert.match(read('public/js/views/estimates.js'), /aria-invalid/, 'the field the message is about must be marked invalid')
  assert.match(read('public/js/views/estimates.js'), /aria-describedby/, '…and pointed at the message')
})
/* ---------- the screen the whole product prices from talks to nobody (v20) ----------
 * matrices.js labels every cell of its grid `aria-label="${row}, ${col}"`. pricing.js renders the
 * identical grid — up to 8 quantity bands × 14 colour counts, 112 real sell prices the app quotes
 * from, "your number beats the calculator" — and labelled none of them, so every one reads out as
 * "edit text, blank" with no way to tell the 24-piece 3-colour price from the 500-piece 1-colour.
 * The same screen reported Save, and the server's REJECTION of a save, into silent <span>s. */
await t('every cell of the price matrix says which price it is', async () => {
  const fs = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const pb = fs.readFileSync(join(root, 'public/js/views/pricing.js'), 'utf8')
  const grid = pb.slice(pb.indexOf('function renderMatrix('), pb.indexOf('card.innerHTML', pb.indexOf('function renderMatrix(')))
  assert.match(grid, /class="pm-in"[\s\S]{0,220}aria-label=/, 'the editable price cells carry no name at all')
  assert.match(grid, /pieces, \$\{esc\(colName/, 'the name has to say which quantity band and which column')
  assert.match(grid, /<th scope="col">/, 'and the header row has to be a header row')
  assert.match(grid, /class="pm-qty" scope="row"/, '…as does the quantity column')
})
await t('…and it says out loud whether the shop\'s prices were saved', async () => {
  const fs = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const pb = fs.readFileSync(join(root, 'public/js/views/pricing.js'), 'utf8')
  assert.match(pb, /class="dim pb-note" role="status" aria-live="polite"/, 'the per-service note was a silent span')
  assert.match(pb, /id="mx-note"[^>]*aria-live="polite"/, 'and so was the matrix note')
  // A live region is not enough where the node itself is replaced by the re-render — and it is
  // never enough for an error the shop has to act on, which needs to interrupt.
  assert.equal((pb.match(/announce\(/g) || []).length, 6,
    'three outcomes, each with its success and its failure, must all be spoken')
  assert.match(pb, /announce\(`\$\{name\} was not saved\. \$\{err\.message\}`, true\)/,
    "the server's rejection is the one thing the shop most needs to hear, and it must interrupt")
})

await t('the one screen that gives a verdict says it out loud', async () => {
  const fs = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const cap = fs.readFileSync(join(root, 'public/js/views/capacity.js'), 'utf8')
  assert.match(cap, /id="promise-out"[^>]*aria-live="polite"/, '"can we promise this date?" answered into a silent div')
  assert.match(cap, /announce\(`\$\{verdict\}/, 'and the settled answer must be spoken')
})
await t('the only delivery path a shop has without SMTP is reachable from the keyboard', async () => {
  const core = await import('../public/js/core.js')
  // "Marked sent. No email connected yet, copy the customer link to send it" — the app tells the
  // owner this box IS the delivery path, and it was a bare <div> with cursor:pointer.
  assert.match(core.CLICKABLE_ROWS, /\.copy/, 'the share-link box must be in the keyboard upgrade list')
  const node = { tagName: 'DIV', attrs: {}, hasAttribute: (a) => a in node.attrs, setAttribute: (a, v) => { node.attrs[a] = v }, addEventListener: () => {} }
  core.upgradeClickableRows({ querySelectorAll: () => [node], matches: () => false })
  assert.equal(node.attrs.tabindex, '0', 'it needs to be focusable')
  assert.equal(node.attrs.role, 'button', 'and to announce as the control it behaves like')
})
/* ---------- a repaint the shop did not ask for keeps the keyboard's place (v20) ----------
 * The Job Board is the shared screen, and a busy floor produces a stream of moves from other
 * people's tablets. Every realtime 'board' event re-runs boardView(), which is an
 * `#view`.innerHTML — so a keyboard user tabbing across job cards, or sitting on the assignee
 * select they had just used, was thrown back to the top of the document every time anyone anywhere
 * in the shop dragged a card. The same happened on every filter chip click, which destroys the
 * chip that was pressed. And the repaint was silent, so there was no reason given for it either. */
await t('a board repaint puts the keyboard back where it was, and says why it moved', async () => {
  const fs = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const b = fs.readFileSync(join(root, 'public/js/views/board.js'), 'utf8')
  const view = b.slice(b.indexOf('export async function boardView()'), b.indexOf('async function jobForm'))
  assert.ok(view.length > 200, 'boardView should still be there')
  assert.match(view, /const a = document\.activeElement/, 'the repaint has to note what had focus BEFORE it destroys it')
  assert.ok(view.indexOf('document.activeElement') < view.indexOf("$('#view').innerHTML"),
    '…and note it before the innerHTML, not after — by then it is already on <body>')
  assert.match(view, /back\.focus\?\.\(\)/, 'and hand focus back')
  assert.match(view, /\.jcard\[data-id=/, 'a job card is identified by its data-id')
  assert.match(view, /\[data-f="\$\{a\.dataset\.f\}"\]/, '…and a filter chip by its data-f')
  const app = fs.readFileSync(join(root, 'public/js/app.js'), 'utf8')
  assert.match(app, /runRouter\(\); announce\('The job board was updated\.'\)/,
    'a screen that repaints itself under a screen-reader user has to say why')
})

/* ---------- Floor Mode confirms a scan out loud (v20) ----------
 * Every tap on this page stamps a labour timestamp the profitability report is built from, with no
 * undo. It confirmed by swapping innerHTML — visible if you can see it, and completely silent
 * otherwise: no announce, no aria-live and no focus() anywhere in the file. A press operator using
 * VoiceOver taps "Advance to Production" and hears nothing at all, so the safe move is to tap it
 * again. The same innerHTML also destroys the button that was pressed, dropping focus on <body>. */
await t('a scan says what it did, and leaves the thumb on the next control', async () => {
  const fs = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const sc = fs.readFileSync(join(root, 'public/js/views/scan.js'), 'utf8')
  const rj = sc.slice(sc.indexOf('function renderJob('), sc.indexOf('function stopCamera('))
  assert.ok(rj.length > 200, 'renderJob should still be there')
  assert.match(rj, /class="scan-done-wrap" role="status" aria-live="polite"/, 'the confirmation was a silent div')
  assert.match(rj, /announce\(note/, '…and the settled result has to be spoken, not only written')
  assert.match(rj, /\.focus\?\.\(\)/, 'the innerHTML destroys the button that was pressed and put focus nowhere')
  assert.match(rj, /'\.scan-advance', host/, '…and it belongs on the control that does the next thing')
})
await t('Floor Mode\'s stage buttons are a size a thumb can hit', async () => {
  const fs = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const css = fs.readFileSync(join(join(dirname(fileURLToPath(import.meta.url)), '..'), 'public/css/app.css'), 'utf8')
  const rule = (css.match(/^\.scan-stage \{[^}]*\}/m) || [''])[0]
  // These advance a job and stamp a labour timestamp the profitability report is built from, with
  // no undo. They were ~32px tall with 6px between them, and the 44px block in the sheet cannot
  // reach them: .scan-stage carries none of its selectors, this rule is declared after it, and
  // that block is gated at max-width 900px while a floor tablet is 1024.
  assert.match(rule, /min-height:\s*var\(--tap|min-height:\s*44px/, `.scan-stage was: ${rule}`)
  assert.match(css, /\.scan-stages \{[^}]*gap:\s*(?:1[0-9]|[2-9][0-9])px/, 'and the pills need spacing between them')
})

await t('a compose install still answers after the operator changes PORT', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8')
  // `ports: "${PORT:-3333}:3333"` + `env_file: .env` and no PORT in `environment:` — so PORT bled
  // into the container. Setting PORT=8080 in .env, exactly as .env.example invites, made the app
  // bind 8080 inside while compose published host 8080 -> container 3333: nothing answers, and the
  // healthcheck (hardcoded 3333) fails forever. The file already pins PSC_DB and PSC_TRUST_PROXY
  // against this same bleed-through and simply missed PORT. `docker run -e PORT=…` is fine,
  // because the Dockerfile's HEALTHCHECK uses ${PORT} — only the compose path was broken.
  const mapping = compose.match(/-\s*"\$\{PORT[^}]*\}:(\d+)"/)
  assert.ok(mapping, 'the compose file should publish ${PORT} to a fixed container port')
  const inside = mapping[1]
  assert.match(compose, new RegExp(`^\\s*PORT:\\s*${inside}\\s*$`, 'm'),
    `the container side of the mapping is ${inside}, so environment: must pin PORT: ${inside}`)
  const health = compose.match(/127\.0\.0\.1:(\d+)\/health/)
  assert.equal(health && health[1], inside, 'and the healthcheck has to check the port it listens on')
})

section('the install the docs describe can be followed to the end')
await t('the account the unit runs as is one the docs tell you to create', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const unit = readFileSync(join(root, 'deploy/printshopcrm.service'), 'utf8')
  const install = readFileSync(join(root, 'INSTALL.md'), 'utf8')

  const user = (unit.match(/^User=(\S+)/m) || [])[1]
  assert.ok(user, 'the unit must name the account it runs as')
  if (user === 'root' || user.startsWith('%')) return   // nothing to create

  const made = install.indexOf(`useradd`)
  assert.ok(made > 0 && install.slice(made, made + 200).includes(user),
    `INSTALL.md never creates ${user}, so systemctl enable --now fails 217/USER on a fresh box`)
  const enabled = install.indexOf('systemctl enable --now printshopcrm')
  assert.ok(enabled > made, 'the account has to be created BEFORE the unit is enabled')

  // …and the directories the service writes to have to belong to it, not to whoever ran the
  // install. Both of these were `chown "$USER"`.
  for (const dir of ['/opt/printshopcrm', '/var/lib/printshopcrm']) {
    const chowns = [...install.matchAll(new RegExp(`^\\s*sudo chown[^\\n]*${dir}\\b`, 'gm'))].map((m) => m[0])
    assert.ok(chowns.length, `INSTALL.md must say who owns ${dir}`)
    for (const line of chowns) {
      assert.ok(line.includes(user), `${dir} is chowned to ${JSON.stringify(line.trim())}, not to ${user}`)
      assert.ok(!line.includes('$USER'), `${dir} must not be handed to the interactive account`)
    }
  }
  // The unit file is the thing an operator reads when the service will not start.
  assert.ok(unit.includes('useradd'), 'the unit should name the command that creates its own account')
})
await t('…and its numbered steps are numbered once each', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const install = readFileSync(join(join(dirname(fileURLToPath(import.meta.url)), '..'), 'INSTALL.md'), 'utf8')
  const nums = [...install.matchAll(/^### (\d+)\. /gm)].map((m) => Number(m[1]))
  assert.deepEqual(nums, nums.map((_, i) => i + 1), `production install steps run ${nums.join(',')}`)
})

section('the shop\'s own mail credentials are the shop\'s own')
{
  const { smtpCreds, twilioCreds } = await import('../lib/notify.mjs')
  const OPERATOR = { SMTP_HOST: 'operator.example', SMTP_PORT: '2525', SMTP_USER: 'operator', SMTP_PASS: 'operatorpass', SMTP_FROM: 'noreply@operator.example', TWILIO_SID: 'ACoperator', TWILIO_TOKEN: 'optoken', TWILIO_FROM: '+15550000000' }
  const withEnv = (fn) => {
    const saved = {}
    for (const [k, v] of Object.entries(OPERATOR)) { saved[k] = process.env[k]; process.env[k] = v }
    try { return fn() } finally { for (const k of Object.keys(OPERATOR)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } }
  }
  const SHOP = { smtp_host: 'mail.theshop.test', smtp_port: 587, smtp_user: 'shop', smtp_pass: 'shoppass', smtp_from: 'orders@theshop.test',
    twilio_sid: 'ACshop', twilio_token: 'shoptoken', twilio_from: '+15551112222' }

  await t('a shop that wired its own SMTP sends through its own server', () => {
    const c = withEnv(() => smtpCreds(SHOP))
    assert.equal(c.host, 'mail.theshop.test')
    assert.equal(c.user, 'shop')
    assert.equal(c.pass, 'shoppass')
    assert.equal(c.from, 'orders@theshop.test')
  })
  await t('…and its own Twilio account is the one that gets billed', () => {
    const c = withEnv(() => twilioCreds(SHOP))
    assert.deepEqual(c, { sid: 'ACshop', token: 'shoptoken', from: '+15551112222' })
  })
  await t('…and a credential set is never mixed with the operator\'s', () => {
    // The shop's host with the operator's password authenticates the wrong account against the
    // wrong server, which is a worse failure than either alone.
    const c = withEnv(() => smtpCreds(SHOP))
    assert.ok(!Object.values(c).some((v) => String(v).includes('operator')), JSON.stringify(c))
  })
  await t('a shop that wired nothing still falls back to the server-wide values', () => {
    // What a single-tenant self-host relies on, and what .env.example promises.
    const c = withEnv(() => smtpCreds({}))
    assert.equal(c.host, 'operator.example')
    assert.equal(c.from, 'noreply@operator.example')
    assert.equal(withEnv(() => twilioCreds({})).sid, 'ACoperator')
  })
  await t('…as does one that only got halfway through wiring its own', () => {
    const c = withEnv(() => smtpCreds({ smtp_host: 'mail.theshop.test', smtp_user: 'shop' })) // no password
    assert.equal(c.pass, 'operatorpass', 'an incomplete set is not a configured shop')
  })
}

/* ---------- a display name is a display name, not a second address ----------
 * `${settings?.shop_name} <${c.from}>` was raw interpolation of a field any manager can PUT. Set
 * shop_name to `Alpha Tees <ceo@beta-prints.test>` and the header became
 * `Alpha Tees <ceo@beta-prints.test> <orders@alpha.test>` — the parser takes the FIRST angle-addr,
 * so the envelope sender captured off the wire was `MAIL FROM:<ceo@beta-prints.test>` and the
 * shop's own configured address was demoted into the display name. On a shared operator relay
 * that is one shop sending as another; on the shop's own server it is mail leaving with the
 * shop's SPF alignment for a domain nobody checked. lib/relay.mjs:59 has always quoted and
 * stripped correctly; this path never did.
 *
 * Asserted off the wire, against a real SMTP conversation, because the header is only half of it
 * — the envelope sender is what a receiving server actually checks. */
section('the shop\'s name cannot rewrite the address its mail comes from')
{
  const net = await import('node:net')
  const { sendEmail } = await import('../lib/notify.mjs')

  /** A minimal SMTP sink: enough of the conversation for nodemailer, and it keeps what it heard. */
  const catcher = async () => {
    const seen = { mailFrom: '', headers: '' }
    const srv = net.createServer((sock) => {
      let buf = '', inData = false
      sock.write('220 gate ESMTP\r\n')
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8')
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n')
          if (end < 0) return
          seen.headers += buf.slice(0, end)
          buf = ''; inData = false
          sock.write('250 2.0.0 Ok: queued\r\n')
          return
        }
        let i
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 2)
          if (/^EHLO|^HELO/i.test(line)) sock.write('250-gate\r\n250 AUTH PLAIN LOGIN\r\n')
          else if (/^AUTH/i.test(line)) sock.write('235 2.7.0 Accepted\r\n')
          else if (/^MAIL FROM:/i.test(line)) { seen.mailFrom = line.replace(/^MAIL FROM:\s*/i, '').split(' ')[0]; sock.write('250 Ok\r\n') }
          else if (/^RCPT TO:/i.test(line)) sock.write('250 Ok\r\n')
          else if (/^DATA/i.test(line)) { inData = true; sock.write('354 End data with <CR><LF>.<CR><LF>\r\n'); break }
          else if (/^QUIT/i.test(line)) { sock.write('221 Bye\r\n'); sock.end() }
          else sock.write('250 Ok\r\n')
        }
      })
      sock.on('error', () => { /* the client hanging up is not our problem */ })
    })
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    return { seen, port: srv.address().port, close: () => srv.close() }
  }

  const send = async (shopName) => {
    const c = await catcher()
    try {
      const out = await sendEmail({
        to: 'customer@example.test', subject: 'Your proof', body: 'hello',
        settings: { shop_name: shopName, smtp_host: '127.0.0.1', smtp_port: c.port, smtp_user: 'u', smtp_pass: 'p', smtp_from: 'orders@theshop.test', smtp_secure: 'false' },
      })
      return { ...c.seen, delivered: out.delivered, error: out.error }
    } finally { c.close() }
  }

  const SPOOF = 'Alpha Tees <ceo@beta-prints.test>'
  const spoofed = await send(SPOOF)
  await t('the mail is accepted by the shop\'s own server', () => {
    assert.equal(spoofed.delivered, true, spoofed.error || 'not delivered')
  })
  await t('…and the envelope sender is the address the shop configured', () => {
    assert.equal(spoofed.mailFrom, '<orders@theshop.test>')
  })
  await t('…and the From: header names exactly one address, the shop\'s own', () => {
    const from = spoofed.headers.split('\r\n').find((l) => /^From:/i.test(l)) || ''
    // The smuggled address may survive as TEXT inside the quoted display name — any display name
    // can claim anything — but it must not be an addr-spec. One '<', and it is the shop's.
    assert.equal((from.match(/</g) || []).length, 1, `From: was ${JSON.stringify(from)}`)
    assert.match(from, /<orders@theshop\.test>\s*$/, `From: was ${JSON.stringify(from)}`)
    assert.doesNotMatch(from, /<ceo@beta-prints\.test>/)
  })
  await t('…and a name with a newline in it cannot add a header', async () => {
    const injected = await send('Alpha\r\nBcc: everyone@example.test')
    assert.ok(!/^Bcc:/mi.test(injected.headers), 'a display name must not be able to add a header')
  })
  await t('an ordinary shop name still names the sender', async () => {
    const plain = await send('Rebel Ink Press')
    assert.match(plain.headers, /^From: .*Rebel Ink Press.*<orders@theshop\.test>/mi)
    assert.equal(plain.mailFrom, '<orders@theshop.test>')
  })
}

section('a date formatter cannot become a script tag')
await t('an unparseable date comes back escaped, not verbatim', async () => {
  const core = await import('../public/js/core.js')
  for (const payload of ['<img src=x onerror=alert(1)>', '"><script>alert(1)</script>', "' onmouseover='x"]) {
    for (const fn of ['fmtDate', 'relTime']) {
      const out = core[fn](payload)
      assert.ok(!/[<>]/.test(out), `${fn}(${JSON.stringify(payload)}) returned ${JSON.stringify(out)}`)
      assert.notEqual(out, payload)
    }
  }
})
await t('…while real dates are unchanged', async () => {
  const core = await import('../public/js/core.js')
  assert.equal(core.fmtDate('2026-08-28'), 'Aug 28')
  assert.match(core.relTime(new Date(Date.now() - 60000).toISOString().slice(0, 19).replace('T', ' ')), /m ago$/)
})

section('the shop floor is told the time the shop is actually in')
for (const tz of ['America/Los_Angeles', 'Asia/Tokyo', 'UTC']) {
  await t(`${tz}: a scan a minute ago reads as a minute ago, not as a UTC clock time`, async () => {
    const { execFileSync } = await import('node:child_process')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const m = await import(${JSON.stringify(join(root, 'public/js/core.js'))})
      // The shape lib/db.mjs writes: CURRENT_TIMESTAMP, UTC, no T and no Z.
      const stored = new Date(Date.now() - 120000).toISOString().slice(0, 19).replace('T', ' ')
      process.stdout.write(JSON.stringify([m.relTime(stored), stored.slice(5, 16)]))
    `], { env: { ...process.env, TZ: tz }, encoding: 'utf8' })
    const [rel, raw] = JSON.parse(out)
    assert.match(rel, /^[12]m ago$/, `relTime said ${JSON.stringify(rel)}`)
    assert.notEqual(rel, raw, 'the raw slice is what the floor was being shown')
  })
}
await t('…and Floor Mode really goes through the helpers', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'public/js/views/scan.js'), 'utf8')
  assert.doesNotMatch(src, /created_at\)\.slice\(/,
    'slicing a stored UTC timestamp into a clock time shows the wrong hour everywhere but UTC')
  assert.match(src, /relTime\(s\.created_at\)/, 'the scan log must go through relTime')
  assert.match(src, /fmtDate\(d\.due_date\)/, 'and the due date through fmtDate')
})

/* ---------- the Orders board can show which orders are late ----------
 * Two defects on one line, hiding each other.
 *
 * The tag was rendered as `class="tag red"` and there has never been a `.tag.red` rule in the
 * stylesheet — only `.pill.red` — so an overdue card's tag was byte-identically the style of an
 * on-time one, with identical text ("$450.00 due"), on a board that has no other lateness signal:
 * no due-date row, no warning glyph, no ordering by date.
 *
 * And the lateness was wrong anyway. `new Date('2026-08-28') < new Date()` compares midnight UTC
 * to now, so an order due TODAY read as overdue from the first second of the day, in every
 * timezone including UTC. This was the last raw date comparison left in public/js — 629f4dc fixed
 * core.js and every view that imports from it, and missed this one because it did its own
 * arithmetic. Fixing only the CSS would therefore have lit the warning on every order due today,
 * which is why both had to land together. */
section('the Orders board can tell the shop which orders are late')
for (const tz of ['America/Los_Angeles', 'America/New_York', 'Europe/Berlin', 'Asia/Tokyo', 'UTC']) {
  await t(`${tz}: an order due today is not overdue, and yesterday's is`, async () => {
    const { execFileSync } = await import('node:child_process')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const m = await import(${JSON.stringify(join(root, 'public/js/core.js'))})
      const t = m.today()
      const day = (n) => { const d = new Date(\`\${t}T12:00:00\`); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10) }
      // The predicate orders.js uses, evaluated the way orders.js evaluates it.
      process.stdout.write(JSON.stringify([m.daysOut(day(0)) < 0, m.daysOut(day(-1)) < 0, m.daysOut(day(1)) < 0]))
    `], { env: { ...process.env, TZ: tz }, encoding: 'utf8' })
    assert.deepEqual(JSON.parse(out), [false, true, false], `due today must not be late in ${tz}`)
  })
}
await t('…and the board really uses that predicate, not a raw date comparison', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'public/js/views/orders.js'), 'utf8')
  assert.doesNotMatch(src, /new Date\(c\.due_date\) < new Date\(\)/,
    "new Date('YYYY-MM-DD') is midnight UTC — an order due today read as overdue all day long")
  assert.match(src, /daysOut\(c\.due_date\) < 0/, "lateness has to be the shop's own calendar day")
  assert.match(src, /overdue/, 'and it has to say so in words — colour is never the only cue')
})
await t('…and every tag colour the board emits has a rule behind it', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const css = readFileSync(join(root, 'public/css/app.css'), 'utf8')
  const emitted = new Set()
  for (const f of ['public/js/views/orders.js', 'public/js/views/board.js']) {
    const src = readFileSync(join(root, f), 'utf8')
    for (const m of src.matchAll(/class="tag (green|amber|red)"/g)) emitted.add(m[1])
    for (const m of src.matchAll(/class="tag \$\{[^}]*'(green|amber|red)'/g)) emitted.add(m[1])
  }
  assert.ok(emitted.size > 0, 'the board should still be colouring its tags')
  for (const tone of emitted) {
    assert.match(css, new RegExp(`\\.tag\\.${tone}\\s*\\{`), `.tag.${tone} is rendered with no rule behind it, so it looks like every other tag`)
  }
})

await t('fmtDate and relTime never disagree about which day a value falls on', async () => {
  const { execFileSync } = await import('node:child_process')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  // relTime is the one that was already right; fmtDate must land on the same instant.
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const m = await import(${JSON.stringify(join(root, 'public/js/core.js'))})
    const stored = '2026-08-28 04:05:20'
    const asRelTime = new Date(stored.replace(' ', 'T') + 'Z')
    process.stdout.write(JSON.stringify({
      fmt: m.fmtDate(stored),
      same: m.fmtDate(stored) === asRelTime.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    }))
  `], { env: { ...process.env, TZ: 'America/Los_Angeles' }, encoding: 'utf8' })
  assert.equal(JSON.parse(out).same, true, `fmtDate said ${JSON.parse(out).fmt}, relTime's instant says otherwise`)
})
await t('a date the app STORES is the shop\'s calendar day, not UTC\'s', async () => {
  const { execFileSync } = await import('node:child_process')
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  // 17:00 Pacific on the 27th is 00:00 UTC on the 28th: today() must still say the 27th.
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const m = await import(${JSON.stringify(join(root, 'public/js/core.js'))})
    process.stdout.write(m.localDay(new Date('2026-08-28T00:30:00Z')))
  `], { env: { ...process.env, TZ: 'America/Los_Angeles' }, encoding: 'utf8' })
  assert.equal(out.trim(), '2026-08-27')
  // And no view may go back to building a stored date out of UTC.
  for (const f of ['public/js/views/estimates.js', 'public/js/views/capacity.js']) {
    assert.ok(!/toISOString\(\)\.slice\(0, 10\)/.test(readFileSync(join(root, f), 'utf8')),
      `${f} builds a stored date from UTC — use localDay()`)
  }
})

section('a delegated handler on a persistent root is bound once, not once per render')
await t('no view binds on() to the shared #view', async () => {
  const { readFileSync, readdirSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const dir = join(root, 'public/js/views')
  const offenders = []
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const src = readFileSync(join(dir, f), 'utf8')
    src.split('\n').forEach((line, i) => {
      // The persistent roots: #view itself, and the `root` const the matrices screens take from it.
      if (/\bon\(\s*\$\('#view'\)/.test(line) || /^\s*on\(root,/.test(line)) offenders.push(`${f}:${i + 1}`)
    })
  }
  assert.deepEqual(offenders, [], `these bind on() to a root that outlives the render — use onOnce(): ${offenders.join(', ')}`)
})
await t('onOnce really binds once, however many times the view is re-entered', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'public/js/core.js'), 'utf8')
  assert.match(src, /export function onOnce/, 'core.js must provide the bind-once helper')
  // Drive the real helper against a minimal root that behaves like #view: listeners accumulate,
  // the element itself is never replaced.
  const listeners = []
  const fakeRoot = {
    addEventListener: (evt, fn) => listeners.push({ evt, fn }),
    contains: () => true,
  }
  const mod = await import(`../public/js/core.js?once=${Date.now()}`)
  let fired = 0
  for (let i = 0; i < 5; i++) mod.onOnce(fakeRoot, '[data-x]', () => { fired++ })
  assert.equal(listeners.length, 1, 'five renders must leave one listener, not five')
  const target = { closest: () => target }
  for (const l of listeners) l.fn({ target })
  assert.equal(fired, 1, 'one click must run the handler once')
  // A different selector on the same root is a different binding and must still attach.
  mod.onOnce(fakeRoot, '[data-y]', () => {})
  assert.equal(listeners.length, 2)
})

await t('the import dialog does not promise more than the code delivers', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  // "Duplicate order numbers are skipped, so re-running an export is safe" was false for any
  // export without an order-number column — which is most of them — and the shop reads that
  // sentence at the exact moment it is deciding whether to click Import a second time.
  const js = readFileSync(join(root, 'public/js/views/contacts.js'), 'utf8')
  assert.ok(!/Duplicate order numbers are skipped, so re-running an export is safe/.test(js),
    'the import dialog promises idempotency it only has when the export carries order numbers')
  const src = readFileSync(join(root, 'server.mjs'), 'utf8')
  assert.match(src, /const fileTag = crypto\.createHash\('sha1'\)\.update\(text\)/,
    'every imported order needs a stable source_ref, order number or not')
})

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
  // The Dockerfile is on this list because it carries its own `docker run` in the header, and it
  // is the file somebody building the image actually reads. Every .md was fixed once and that one
  // survived, publishing port 3333 with no login and the fallback share-link secret.
  for (const doc of ['README.md', 'INSTALL.md', 'HOSTING.md', 'deploy/DEPLOY.md', 'Dockerfile']) {
    const src = readFileSync(join(root, doc), 'utf8')
    // Fenced blocks, joined across backslash continuations, so a multi-line docker run reads as one.
    // A Dockerfile has no fences — its runnable examples live in `#` comments, so take it whole.
    const blocks = doc === 'Dockerfile' ? [src] : src.split('```').filter((_, i) => i % 2 === 1)
    for (const block of blocks) {
      const joined = block.replace(/\\\s*\n\s*/g, ' ')
      for (const line of joined.split('\n')) {
        if (!/\bdocker run\b/.test(line) || !/\s-p\s/.test(line)) continue
        assert.match(line, /PSC_AUTH=1/, `${doc} publishes a port with no login: ${line.trim().slice(0, 120)}`)
        assert.match(line, /PSC_SECRET/, `${doc} publishes a port with the fallback share-link secret: ${line.trim().slice(0, 120)}`)
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
    // The gates themselves are the exception, deliberately: they must run against a throwaway
    // database with no shop's configuration anywhere near them.
    if (/bin\/gate(-e2e)?\.mjs/.test(cmd)) continue
    if (!/\b(server|seed)\.mjs|\bbin\/[\w-]+\.mjs/.test(cmd)) continue
    assert.match(cmd, /--env-file-if-exists=\.env/, `npm run ${name} opens the database without loading .env`)
  }
  // …and the same rule for the DOCS. INSTALL.md told the operator to put their Google credentials
  // in .env and then run `node bin/backup-drive.mjs connect`, which reads none of them: it answers
  // "Set PSC_BACKUP_GDRIVE_CLIENT_ID and PSC_BACKUP_GDRIVE_CLIENT_SECRET first" on a correctly
  // configured install. So the documented off-site backup could not be set up at all — upstream of
  // the known problem that the cron never sources the token, because there was no token to source.
  for (const doc of ['INSTALL.md', 'README.md', '.env.example', 'deploy/backup.sh', 'deploy/DEPLOY.md', 'HOSTING.md']) {
    let text = ''
    try { text = readFileSync(join(root, doc), 'utf8') } catch { continue }
    for (const line of text.split('\n')) {
      const m = line.match(/(?:^|[`\s])((?:sudo -u \S+ )?node\s+(?:--\S+\s+)*bin\/([\w-]+\.mjs)\b)/)
      if (!m) continue
      // Only scripts that read the shop's own PSC_ configuration. The gates are excluded by name
      // — they must run against a throwaway database with no shop's config near them — and
      // bin/snapshot.mjs takes its paths as arguments rather than from .env.
      if (/^gate(-e2e)?\.mjs$/.test(m[2])) continue
      let script = ''
      try { script = readFileSync(join(root, 'bin', m[2]), 'utf8') } catch { continue }
      if (!/process\.env\.PSC_/.test(script)) continue
      assert.match(m[1], /--env-file/,
        `${doc} tells the operator to run ${JSON.stringify(m[1])}, which reads none of the .env the same doc says to write`)
    }
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

// The pre-migration backup, and the check that decides whether a release stays.
//
// release.sh is what INSTALL.md tells self-hosters to run. It backed up "$DATA_ROOT/printshop.db"
// and nothing else — the DEFAULT handle, which lib/db.mjs says in as many words is never touched
// for a shop's data. Every real install is multi-tenant: the shops are in control.db and
// tenants/<slug>/printshop.db. So the snapshot taken immediately before migrations run against
// real customer data held no invoices, no customers and no way to sign in.
//
// And it then decided the release was good on `systemctl is-active`, which on a Type=simple unit
// goes true the moment the process forks — before the port is bound and before one database is
// opened. ship.sh got a real /health probe in v1.14.0; this script did not.
//
// This runs the actual script against a fake install with every external command stubbed, because
// asserting on the text of a deploy script is not the same as watching it deploy.
const rehearseRelease = async ({ healthy, first = false, gnu = false, seedBackups = false }) => {
  const { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, chmodSync, existsSync, readlinkSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const { execFileSync } = await import('node:child_process')
  const { DatabaseSync } = await import('node:sqlite')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const dir = mkdtempSync(join(tmpdir(), 'psc-release-'))
  const APP_ROOT = join(dir, 'app'), DATA_ROOT = join(dir, 'data'), BIN = join(dir, 'bin'), SRC = join(dir, 'src')
  const stub = (name, body) => { writeFileSync(join(BIN, name), `#!/bin/sh\n${body}\n`); chmodSync(join(BIN, name), 0o755) }
  try {
    for (const d of [APP_ROOT, DATA_ROOT, BIN, SRC, join(SRC, 'bin'), join(SRC, 'deploy'), join(APP_ROOT, 'releases', 'v0.0.1')]) mkdirSync(d, { recursive: true })
    // The install as it really is: an empty default handle, the registry, and two shops.
    for (const rel of ['printshop.db', 'control.db', 'tenants/acme/printshop.db', 'tenants/bobs/printshop.db']) {
      mkdirSync(dirname(join(DATA_ROOT, rel)), { recursive: true })
      const d = new DatabaseSync(join(DATA_ROOT, rel))
      d.exec('CREATE TABLE invoices (id INTEGER PRIMARY KEY, total REAL)')
      if (rel !== 'printshop.db') d.exec("INSERT INTO invoices (total) VALUES (4200.00)")
      d.close()
    }
    writeFileSync(join(APP_ROOT, '.env'), 'PSC_SECRET=x\nPORT=39777\n')
    // An install with a history: six old deploy snapshots (so the keep-five prune has work to do)
    // and one restore safety copy, which is where bin/restore.mjs MOVED the shop's previous
    // artwork. That directory is the only copy of those files.
    if (seedBackups) {
      // `ls -1dt` sorts by mtime, so the ages are the whole point: the restore safety copy is the
      // OLDEST thing in here — a shop restores once and then deploys for weeks — which is exactly
      // why keep-the-five-newest reached it.
      const { utimesSync } = await import('node:fs')
      const age = (p, daysAgo) => utimesSync(p, new Date(Date.now() - daysAgo * 864e5), new Date(Date.now() - daysAgo * 864e5))
      const safety = join(DATA_ROOT, 'backups', 'pre-restore-20260102030405')
      mkdirSync(join(safety, 'uploads-previous'), { recursive: true })
      writeFileSync(join(safety, 'uploads-previous', 'proof-abc123.png'), 'ART')
      writeFileSync(join(safety, 'control.db'), 'x')
      age(safety, 60)
      for (let i = 1; i <= 6; i++) {
        for (const name of [`predeploy-v1.0.${i}-2026010${i}000000`, `pre-v0.9.${i}-2025010${i}000000`]) {
          const d = join(DATA_ROOT, 'backups', name)
          mkdirSync(d, { recursive: true })
          writeFileSync(join(d, 'control.db'), 'x')
          age(d, 7 - i)   // all newer than the safety copy
        }
      }
    }
    // A release is already live, so the rollback below has somewhere to go back to — EXCEPT when
    // rehearsing the very first deploy, which is the case this harness always skipped past.
    if (!first) execFileSync('ln', ['-sfn', join(APP_ROOT, 'releases', 'v0.0.1'), join(APP_ROOT, 'current')])
    writeFileSync(join(SRC, 'bin', 'gate.mjs'), '')
    execFileSync('cp', [join(root, 'deploy', 'release.sh'), join(SRC, 'deploy', 'release.sh')])
    // Every external the script shells out to. `node` too: release.sh runs the gate against the
    // new release, and this IS the gate.
    stub('sudo', 'exec "$@"')
    stub('systemctl', 'exit 0')
    stub('rsync', 'for a in "$@"; do last="$a"; done; mkdir -p "$last/public" "$last/bin"; exit 0')
    stub('npm', 'exit 0')
    stub('node', 'exit 0')
    stub('journalctl', 'exit 0')
    stub('curl', healthy ? 'exit 0' : 'exit 7')
    // GNU coreutils `readlink -f` requires all but the LAST component of a path to exist: it prints
    // the canonical path and exits 0 when the final component is missing. BSD readlink (macOS,
    // which is where this gate is usually run) exits 1 on the same input — which is exactly why no
    // local run and no CI run ever saw what this does on the Ubuntu box INSTALL.md targets.
    if (gnu) {
      stub('readlink', `
if [ "$1" = "-f" ]; then
  p="$2"; d=$(dirname "$p"); b=$(basename "$p")
  [ -d "$d" ] || exit 1
  if [ -L "$d/$b" ]; then t=$(/usr/bin/readlink "$d/$b"); case "$t" in /*) echo "$t";; *) echo "$(cd "$d" && pwd -P)/$t";; esac
  else echo "$(cd "$d" && pwd -P)/$b"; fi
  exit 0
fi
exec /usr/bin/readlink "$@"`)
    }
    let out = '', code = 0
    try {
      out = execFileSync('bash', [join(SRC, 'deploy', 'release.sh'), 'v9.9.9'], {
        cwd: SRC, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, APP_ROOT, DATA_ROOT, SRC, SERVICE: 'psc-test', PSC_HEALTH_TRIES: '1' },
      })
    } catch (e) { out = `${e.stdout || ''}${e.stderr || ''}`; code = e.status }
    const backups = join(DATA_ROOT, 'backups')
    const snap = existsSync(backups) ? readdirSync(backups).map((n) => join(backups, n)) : []
    const { statSync } = await import('node:fs')
    // Read the sizes here: the sandbox is deleted in the finally below, so the caller only ever
    // sees what this function captured while it still existed.
    const captured = []
    const walk = (d) => { for (const n of readdirSync(d, { withFileTypes: true })) { const f = join(d, n.name); n.isDirectory() ? walk(f) : captured.push({ name: f.slice(f.indexOf('/backups/')), size: statSync(f).size }) } }
    // A snapshot may be a directory of databases or — as it was before this was fixed — one lone
    // file. Handle both, so a regression fails on the assertion rather than on a scandir error.
    for (const sdir of snap) { if (statSync(sdir).isDirectory()) walk(sdir); else captured.push({ name: sdir.slice(sdir.indexOf('/backups/')), size: statSync(sdir).size }) }
    // readlinkSync, not existsSync-then-readlink: existsSync FOLLOWS the link, so a link to itself
    // answers false and the interesting case reads back as "there is no link" instead of naming it.
    const current = (() => { try { return readlinkSync(join(APP_ROOT, 'current')) } catch { return '' } })()
    // Is `current` actually usable, or is it a link to itself? existsSync() follows the link and
    // answers false on an ELOOP, so ask lstat separately from "can anything be read through it".
    const { lstatSync } = await import('node:fs')
    const linkExists = (() => { try { return lstatSync(join(APP_ROOT, 'current')).isSymbolicLink() } catch { return false } })()
    const readable = (() => { try { readdirSync(join(APP_ROOT, 'current')); return true } catch { return false } })()
    const prevFile = existsSync(join(APP_ROOT, '.previous-release'))
      ? readFileSync(join(APP_ROOT, '.previous-release'), 'utf8').trim() : null
    return { out, code, captured, current, DATA_ROOT, linkExists, readable, prevFile }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

await t('a deploy does not delete the artwork a restore set aside', async () => {
  // release.sh pruned `$DATA_ROOT/backups/pre-*` to the five newest. bin/restore.mjs writes its
  // safety copy to `$DATA_ROOT/backups/pre-restore-<stamp>` in that same directory — and puts the
  // shop's live artwork inside it with renameSync, a MOVE, so after a restore that directory holds
  // the only copy of every proof, mockup and logo the shop had. `pre-*` matched both. Five ordinary
  // deploys later the safety copy was rm -rf'd: exit 0, nothing printed, and restore.mjs's own
  // closing line still saying "this is undoable" and "delete it when the shop looks right".
  const r = await rehearseRelease({ healthy: true, seedBackups: true })
  assert.equal(r.code, 0, `a healthy release should succeed:\n${r.out}`)
  const names = r.captured.map((f) => f.name)
  assert.ok(names.some((n) => n.endsWith('/pre-restore-20260102030405/uploads-previous/proof-abc123.png')),
    `the restore's safety copy of the artwork must survive a deploy. Backups dir held: ${names.join(', ')}`)
  // …while the prune still does its job on the snapshots this script owns, old prefix and new.
  const dirsOf = (pfx) => new Set(names.filter((n) => n.includes(`/backups/${pfx}`)).map((n) => n.split('/')[2]))
  assert.ok(dirsOf('predeploy-').size <= 5, `keep-five must still prune deploy snapshots, kept ${dirsOf('predeploy-').size}`)
  assert.ok(dirsOf('pre-v').size <= 5, `and snapshots written under the old prefix, kept ${dirsOf('pre-v').size}`)
})

await t('the pre-migration backup contains the shops, not an empty default handle', async () => {
  const r = await rehearseRelease({ healthy: true })
  assert.equal(r.code, 0, `a healthy release should succeed:\n${r.out}`)
  const names = r.captured.map((f) => f.name)
  assert.ok(names.some((n) => n.endsWith('/control.db')), `control.db holds the registry and every login — it must be in the backup. Got: ${names.join(', ')}`)
  assert.ok(names.some((n) => /tenants\/acme\/printshop\.db$/.test(n)), `a shop's own database must be in the backup. Got: ${names.join(', ')}`)
  assert.ok(names.some((n) => /tenants\/bobs\/printshop\.db$/.test(n)), 'every shop, not just the first')
  // And it has to be a real snapshot, not a zero-byte file.
  for (const f of r.captured) assert.ok(f.size > 0, `${f.name} is empty — that is not a backup`)
  assert.match(r.out, /database\(s\) backed up/, 'and it must say what it captured')
})

await t('a release that will not answer /health is rolled back, not announced as live', async () => {
  const r = await rehearseRelease({ healthy: false })
  assert.notEqual(r.code, 0, `a release nobody can reach must exit non-zero:\n${r.out}`)
  assert.doesNotMatch(r.out, /✓ v9\.9\.9 is live/, 'is-active is not proof that anything is being served')
  assert.match(r.out, /not answering \/health/, 'it has to say what actually failed')
  assert.match(r.out, /rolled back/, 'and it has to put the previous release back')
  assert.match(r.current, /releases\/v0\.0\.1$/, `current must point back at the previous release, got ${r.current}`)
})

// ship.sh had the /health probe but fell back to `systemctl is-active` whenever it could not work
// out the port — and the SHIPPED unit file carries no Environment=PORT at all, it uses an
// EnvironmentFile. So on a stock install the gate silently degraded into the exact check it was
// written to replace, and printed "Shipped" over a release where every shop was dark.
/* An install's very FIRST deploy, on the platform INSTALL.md actually targets.
 *
 * GNU `readlink -f` only requires all but the last component of a path to exist — it prints the
 * canonical path and exits 0 when the final component is missing. So on a first deploy, where
 * $APP_ROOT/current does not exist yet, PREVIOUS came back as the very link the script was about
 * to replace. The healthy path then printed "roll back with: ln -sfn <current> <current>", and the
 * FAILING path ran it: `current` became a symlink to itself, ELOOP, WorkingDirectory unresolvable,
 * Restart=always looping forever — printed under the word "rolled back", with .previous-release
 * recording the self-link as the way home.
 *
 * BSD readlink exits 1 on the same input, which is why every local run and every gate run to date
 * was green. The `else` branch below it — "first release on this install" — was unreachable on
 * Linux for the same reason: PREVIOUS was never empty. */
await t('a failed FIRST deploy does not leave `current` pointing at itself', async () => {
  const r = await rehearseRelease({ healthy: false, first: true, gnu: true })
  assert.notEqual(r.code, 0, `a release nobody can reach must exit non-zero:\n${r.out}`)
  assert.ok(r.linkExists, 'current should still be a symlink')
  assert.ok(r.readable, `current must be readable, not a link to itself — points at ${r.current}\n${r.out}`)
  assert.doesNotMatch(r.current, /\/current$/, `current must never point at current, got ${r.current}`)
  assert.match(r.current, /releases\/v9\.9\.9$/, `nothing to go back to, so the new release stays where an operator can see it — got ${r.current}`)
  assert.doesNotMatch(r.out, /rolled back to \S*\/current\b/, 'it must not claim it rolled back to the link it just wrote')
  assert.ok(!r.prevFile || !/\/current$/.test(r.prevFile), `.previous-release must not record a self-link, got ${r.prevFile}`)
})

await t('…and a healthy FIRST deploy does not hand out a self-referential rollback command', async () => {
  const r = await rehearseRelease({ healthy: true, first: true, gnu: true })
  assert.equal(r.code, 0, `a healthy first deploy must succeed:\n${r.out}`)
  assert.match(r.out, /nothing to roll back to yet/, `the first release has no way back, and must say so:\n${r.out}`)
  for (const line of r.out.split('\n')) {
    if (!/ln -sfn/.test(line)) continue
    const m = line.match(/ln -sfn\s+(\S+)\s+(\S+)/)
    if (m) assert.notEqual(m[1], m[2], `an instruction that links current to itself: ${line.trim()}`)
  }
})

await t('…while a deploy that DOES have a previous release still rolls back to it', async () => {
  // The guard must not cost the case it exists to protect.
  const r = await rehearseRelease({ healthy: false, gnu: true })
  assert.match(r.current, /releases\/v0\.0\.1$/, `current must go back to the previous release, got ${r.current}`)
  assert.match(r.out, /rolled back/, 'and say that it did')
})

// ship.sh runs its half over ssh, so it cannot be rehearsed here the way release.sh can. What can
// be held is the shape: a bare `readlink -f` on `current` is the defect, and both scripts have to
// prove the link resolves to a real directory before treating it as the way home.
await t('neither deploy script trusts a bare readlink for the way back', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  for (const file of ['deploy/ship.sh', 'deploy/release.sh']) {
    const text = readFileSync(join(root, file), 'utf8')
    for (const line of text.split('\n')) {
      if (/^\s*#/.test(line)) continue
      if (!/readlink -f/.test(line) || !/current/.test(line)) continue
      const i = text.indexOf(line)
      const around = text.slice(Math.max(0, i - 400), i + 400)
      assert.match(around, /\[ -L /, `${file}: guard the readlink with a -L test — GNU readlink -f exits 0 on a 'current' that does not exist yet: ${line.trim().slice(0, 90)}`)
      // ship.sh's half is a heredoc-ish remote script, so its quoting is escaped — match the test
      // itself rather than trying to spell every layer of backslashes.
      assert.match(around, /-d [^\n]*\bPREV/, `${file}: a previous release has to be a directory that is really there`)
    }
  }
})

await t('neither deploy script can fall back to the check it was written to replace', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  for (const file of ['deploy/ship.sh', 'deploy/release.sh']) {
    const text = readFileSync(join(root, file), 'utf8')
    assert.match(text, /curl [^\n]*\/health/, `${file}: the release gate has to ask the app, not the supervisor`)
    for (const line of text.split('\n')) {
      if (/^\s*#/.test(line)) continue // the comment explaining why is welcome
      assert.doesNotMatch(line, /is-active[^\n]*HEALTHY=1/, `${file}: is-active must never be able to set the release healthy — ${line.trim().slice(0, 100)}`)
    }
    assert.match(text, /PORT=3333/, `${file}: an unset PORT is 3333 (server.mjs), not "unknown" — do not degrade the check`)
  }
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

/* ---------- a QuickBooks push never survives its invoice (v20) ----------
 * qbo_sync.entity_id was the last parent pointer in the schema with no foreign key — and being
 * polymorphic ('invoice' + a rowid) it can never have one. invoices.contact_id cascades, and
 * DELETE /api/contacts/:id lets a customer go when their only invoice is VOIDED, which is the
 * supported way to retract one raised in error. SQLite then hands the freed rowid to the next
 * invoice, and the dead push row latches onto it. The queue screen relabels the old failure with
 * the new customer's invoice number, "Retry" pushes an invoice nobody asked to push — and worst,
 * enqueueQbo() skips an invoice that already has an open row, so the NEW invoice is never queued
 * at all. The money moves, QuickBooks never hears about it, and nothing anywhere says so. */
/* ---------- the pipeline follows the quote it was opened from (v20) ----------
 * Create, send and approve all called syncPipeline. Edit and delete never did.
 *   - edit $8,000 -> $4,000 and the deal keeps $8,000. ONE /api/dashboard response then carries
 *     open_estimates 4,670 beside pipeline.open_value 8,670, side by side on the login screen.
 *   - opportunities.estimate_id is ON DELETE SET NULL, not CASCADE, so deleting the quote left the
 *     deal behind with a null pointer: still 'quoted', still $8,000 of Open Pipeline and Weighted
 *     Forecast, no longer findable by oppForEstimate — so it could never be re-valued, and a
 *     re-created quote for that customer minted a SECOND deal beside it. */
/* ---------- a shadow spelling never reaches the static mount (v20) ----------
 * The e2e proves this by fetching /UPLOADS/probe, which only 200s on a case-INsensitive
 * filesystem — so on the ubuntu CI job that assertion passes whether the guard is there or not,
 * and deleting the guard would go green on Linux and ship a cross-tenant artwork leak plus an
 * AGPL §13 breach to every macOS and Windows self-hoster. This is the platform-independent half:
 * the guard exists, it refuses, and it sits AFTER the handlers that answer the canonical
 * spellings and BEFORE the static mount. Order is the whole fix. */
/* ---------- the rate limiter's own memory is bounded (v20) ----------
 * rateLimit() builds its key from the caller's request body and retains it for 15 minutes, and
 * recordLoginFail() retains a second copy. Neither the length of the string nor the NUMBER of
 * keys was bounded, on a route that needs no session. Measured: 400 logins carrying a 900 KB
 * `email` (under the 1 MB JSON cap, so accepted) took the process from 81 MB to 516 MB of RSS in
 * under four seconds, and every one answered 401 — a fresh email is a fresh bucket, so `max: 12`
 * never binds and nothing is ever rate limited. fly.toml sizes the reference VM at 512 MB.
 * The e2e proves the truncation behaviourally; this is the key-COUNT ceiling, which no test can
 * reach at its real value without 50,000 requests. */
/* ---------- liveness and the deploy gate are different questions (v20) ----------
 * brokenTenants → /health 503 was built so a release that bricks one shop's database rolls back,
 * and ship.sh polls exactly that. But Dockerfile's HEALTHCHECK, fly.toml's [[http_service.checks]]
 * and render.yaml's healthCheckPath poll the SAME URL to decide whether the CONTAINER is dead — so
 * one shop's lost file took every other shop on the box out of the load balancer. On Fly with
 * min_machines_running = 1 that is a total outage for shops whose data is perfectly fine; on
 * Render it is a restart loop into the same state, forever; and ship.sh's own rollback poll then
 * refuses to ship the release that would have fixed it.
 * The e2e proves the two answers. This pins WHO ASKS WHICH, which is the half a config edit can
 * silently undo. */
/* ---------- the three overlays that never went through modal() (v20) ----------
 * modal() has had a dialog role, a focus trap and focus restore since v11. Three overlays are
 * hand-rolled and got none of it: the ⌘K palette (offered as the app's front door), the keyboard
 * shortcuts help (written FOR the keyboard user, and the one they were most stranded inside) and
 * the Assistant. Tab walked out of all three into the sidebar behind a dimmed backdrop, where
 * Enter fired whatever it landed on; closing dropped focus on <body>; and a screen reader was
 * never told the palette had opened at all — it announced "edit text, blank" and its results were
 * plain <div>s, so arrowing through them spoke nothing.
 * The Assistant had a fourth: it was missing from keys.js's dialogOpen(), so with focus on a chip
 * every global single key fired through the open panel — `n` navigated the page out from under it,
 * `t` flipped the theme mid-conversation. And its result cards, which the module's own docstring
 * calls the point of the answer, were `<a>` with no href: not links, not focusable, not reachable
 * by Tab or Enter at all. */
section('the three overlays that never went through modal()')
{
  const readSrc = async (f) => {
    const { readFileSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    return readFileSync(join(join(dirname(fileURLToPath(import.meta.url)), '..'), f), 'utf8')
  }

  await t('core publishes the trap and the focus-keeper, so an overlay reuses them rather than copying', async () => {
    const core = await readSrc('public/js/core.js')
    assert.match(core, /export function trapTab\(/, 'the Tab rule has to be reachable from a hand-rolled overlay')
    assert.match(core, /export function focusKeeper\(/, '…and so does focus restore')
    // …and modal() must be on the SAME one, or there are two rules that can drift apart.
    const m = core.slice(core.indexOf('export function modal('), core.indexOf('const escClose'))
    assert.match(m, /trapTab\(bg, e\)/, 'modal() must use the shared trap, not its own copy')
  })

  for (const [file, what, root] of [
    ['public/js/views/search.js', 'the ⌘K palette', 'box'],
    ['public/js/keys.js', 'the shortcuts help', 'ov'],
  ]) {
    await t(`${what} announces itself, keeps Tab, and gives focus back`, async () => {
      const src = await readSrc(file)
      assert.match(src, /role="dialog"/, `${what} never told a screen reader the page behind was blocked`)
      assert.match(src, /aria-modal="true"/, '…nor that it is modal')
      assert.match(src, /aria-label(ledby)?=/, '…nor what it is called')
      assert.match(src, new RegExp(`trapTab\\(${root}, e\\)`), `Tab walked out of ${what} into the sidebar behind it`)
      assert.match(src, /focusKeeper\(\)/, `closing ${what} dropped focus on <body>`)
    })
  }

  await t('…and the palette speaks the row the arrow keys are on', async () => {
    const src = await readSrc('public/js/views/search.js')
    assert.match(src, /role="listbox"/, 'the results were a plain div, so they were not a list of anything')
    assert.match(src, /role="option" id="cmd-i-\$\{i\}"/, '…and the rows were not options')
    assert.match(src, /aria-selected="\$\{i === cursor\}"/, 'the highlight is drawn with a class a screen reader cannot see')
    assert.match(src, /aria-activedescendant/, '…so arrowing has to point the combobox at the row')
  })

  await t('the Assistant is a dialog, and the global single-key shortcuts stop at its edge', async () => {
    const a = await readSrc('public/js/views/assistant.js')
    assert.match(a, /class="asst" role="dialog" aria-label=/, 'a screen reader was never told a panel had opened')
    assert.match(a, /focusKeeper\(\)/, 'closing it dropped focus on <body>')
    assert.match(a, /if \(e\.key === 'Escape'\) \{ e\.stopPropagation\(\); closeAssistant\(\) \}/,
      'Escape only worked from the textarea, not from a chip or a card')
    const keys = await readSrc('public/js/keys.js')
    const dlg = keys.split('\n').find((l) => l.startsWith('const dialogOpen ='))
    assert.ok(dlg && dlg.includes("$('.asst')"),
      "with focus on an Assistant chip, `n` navigated the page out from under the open panel and `t` flipped the theme")
  })

  await t("…and the Assistant's answer can be reached with a keyboard and heard with a screen reader", async () => {
    const a = await readSrc('public/js/views/assistant.js')
    // The cards ARE the answer — "every result links into the app so the human can take over".
    assert.doesNotMatch(a, /<a class="asst-card" data-href=/,
      'an <a> with no href is not a link: not focusable, not Tab-reachable, not Enter-activatable')
    assert.match(a, /<a class="asst-card" href="#\$\{esc\(c\.href\)\}"/, 'give the card a real href')
    assert.match(a, /id="asst-log"[^>]*aria-live="polite"/, 'the log was silent — the answer was never spoken')
    assert.match(a, /announce\(thinking\.reply/, '…and render() rewrites the whole list, so the reply must be said once')
    // A real link picks up the browser's underline and link colour; the card must still look
    // like a card, or this fix is a visual regression on every answer.
    const css = await readSrc('public/css/app.css')
    const rule = (css.match(/^\.asst-card \{[^}]*\}/m) || [''])[0]
    assert.match(rule, /text-decoration:\s*none/, 'the card is an <a> now and would be underlined')
    assert.match(rule, /color:\s*inherit/, '…and rendered in the link colour')
  })
}

section('liveness and the deploy gate are different questions')
await t('ship.sh asks the strict question and the platform probes ask the plain one', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const read = (f) => readFileSync(join(root, f), 'utf8')

  // Only the lines that actually FETCH it — the file also mentions /health in prose.
  const polls = read('deploy/ship.sh').split('\n')
    .filter((l) => l.includes('curl') && l.includes('/health'))
    .map((l) => (/\/health[^"\s\\]*/.exec(l) || [''])[0])
  assert.ok(polls.length >= 2, 'ship.sh should still poll /health — both the loop and the diagnostic')
  for (const u of polls) {
    assert.ok(u.includes('strict=1'),
      `ship.sh polls ${u} — the deploy gate must ask the strict question, or a release that bricks a shop ships green`)
  }

  // The platform probes must NOT. Answering 503 there de-routes every healthy shop on the box.
  for (const f of ['Dockerfile', 'docker-compose.yml', 'deploy/fly.toml', 'deploy/render.yaml']) {
    for (const u of [...read(f).matchAll(/\/health[^"'\s]*/g)].map((m) => m[0])) {
      assert.ok(!u.includes('strict'),
        `${f} probes ${u} — a liveness probe that fails on one dark shop takes every other shop out of the load balancer`)
    }
  }

  // And the endpoint itself has to honour the split, both directions.
  const src = read('server.mjs')
  const h = src.slice(src.indexOf("app.get('/health'"), src.indexOf("app.get('/health'") + 3000)
  assert.match(h, /req\.query\.strict/, '/health no longer distinguishes the two callers')
  assert.match(h, /degraded: true/, 'a dark shop must still be reported on the plain answer, not hidden')
  assert.match(h, /shops: broken\.slice/, '…and named on both')
})

section('the rate limiter\'s own memory is bounded')
await t('neither the key nor the number of keys can be grown without limit by a caller', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'server.mjs'), 'utf8')
  const cap = /const RL_EMAIL_MAX = (\d+)/.exec(src)
  assert.ok(cap, 'the key has to have a length bound')
  assert.ok(Number(cap[1]) >= 254 && Number(cap[1]) <= 320,
    'RFC 5321 caps a real address at 254 octets — shorter truncates a legitimate one, longer is just slack')
  // Both retainers, not one. The limiter key and the account-backoff key are separate maps.
  const keyLine = src.split('\n').find((l) => l.includes('const key = keyFn ?'))
  assert.ok(keyLine && /slice\(0, RL_EMAIL_MAX\)/.test(keyLine), 'the rate-limit key still holds the whole submitted email')
  const acct = src.split('\n').find((l) => l.startsWith('const acctKey ='))
  assert.ok(acct && /slice\(0, RL_EMAIL_MAX\)/.test(acct), 'acctKey still holds the whole submitted email')
  // …and a bounded key length is not enough on its own: unbounded KEYS are the same leak slower.
  const keys = /const RL_MAX_KEYS = ([\d_]+)/.exec(src)
  assert.ok(keys, 'the number of live buckets has to have a ceiling too')
  const n = Number(keys[1].replace(/_/g, ''))
  assert.ok(n >= 10_000, 'a ceiling below ten thousand could bind on a real install')
  assert.ok(n <= 200_000, 'a ceiling this high is not a ceiling')
  assert.match(src, /if \(!e && rlHits\.size >= RL_MAX_KEYS\)/, 'rlHits must refuse a NEW key past the ceiling')
  assert.match(src, /if \(!loginFails\.has\(k\) && loginFails\.size >= RL_MAX_KEYS\) return/, 'loginFails must too')
})

section('a shadow spelling never reaches the static mount')
await t('the guard exists, refuses, and sits between the handlers and express.static', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'server.mjs'), 'utf8')
  const guard = src.indexOf('const SHADOWED_BY_A_ROUTE')
  assert.ok(guard > 0, 'the shadow-spelling guard is gone — /UPLOADS/f serves another shop\'s art off disk')
  const rendered = src.indexOf("app.get(['/index.html', '/auth.html']")
  const owned = src.indexOf("app.get('/uploads/:file'")
  const stat = src.indexOf('app.use(express.static(PUBLIC')
  assert.ok(owned > 0 && rendered > 0 && stat > 0, 'the three landmarks should still be there')
  assert.ok(guard > rendered && guard > owned, 'the guard must come AFTER the handlers, or it 404s the real pages')
  assert.ok(guard < stat, 'and BEFORE the static mount, or it never runs')
  // The regex has to be case-insensitive — that IS the bug — and cover both families.
  const re = /const SHADOWED_BY_A_ROUTE = (\/.*\/[a-z]*)/.exec(src)
  assert.ok(re, 'the guard must be a literal regex the gate can read')
  assert.ok(re[1].endsWith('i'), 'a case-SENSITIVE guard is the bug it was written to fix')
  // eslint-disable-next-line no-new-func — the gate reads the shipped literal rather than a copy.
  const rx = new Function(`return ${re[1]}`)()
  for (const p of ['/UPLOADS/f.png', '/Uploads/f.png', '/uploadS/f.png', '/uploads/f.png', '/Index.html', '/AUTH.HTML', '/auth.html']) {
    assert.ok(rx.test(p), `${p} must be recognised as shadowing a handler`)
  }
  // …and it must not swallow the rest of public/, which has no handler and must still be served.
  for (const p of ['/css/app.css', '/js/core.js', '/docs-api.html', '/manifest.json', '/embed/gangsheet.js', '/icon.svg', '/sw.js']) {
    assert.ok(!rx.test(p), `${p} has no handler above the static mount — refusing it takes the app down`)
  }
})

/* ---------- every deal is in a column the shop can drag it out of (v20) ----------
 * lib/agent.mjs filed the receptionist's happy-path deals under stage 'qualified', which is in no
 * STAGE_KEYS and never has been. pipelineBoard() builds its columns from STAGES, so the card was
 * drawn in NO column at all: it could not be opened, edited, dragged or corrected from any screen.
 * And the two readers disagreed about whether to count it — pipelineStats() uses an allowlist,
 * pipelineBoard() used a denylist — so ONE unknown value made the Dashboard KPI and the Pipeline
 * board's own header report different open pipeline out of the same table. Measured: one $8,400
 * receptionist deal beside one $670 quote read as $670 on the Dashboard and $9,070 on the board,
 * with the $8,400 card visible nowhere. */
/* ---------- a document is a demand for money, never the other way round (v20) ----------
 * A Discount is a first-class line in the estimate editor, entered as a negative unit_price, and
 * nothing anywhere floored the result. Typing -1200 for -120 stored a negative estimate, which
 * converted to an invoice with a negative amount_due — and the two receivables readers then
 * disagree BY CONSTRUCTION: the dashboard's Outstanding KPI sums the balances with no sign filter,
 * so the negative is SUBTRACTED from every other customer's, while the A/R aging report filters
 * `> 0.005` and cannot show it at all. */
/* ---------- the Orders board answers a finger (v20) ----------
 * This is the lite edition's whiteboard, and its own docstring says it uses pointer events "so it
 * works on the tablet or phone that actually lives on a shop floor". A later round added
 * `if (e.pointerType === 'touch') return` to stop a sideways scroll committing a stage change —
 * correct — but that return happens BEFORE `st` is assigned, and the only call site of openCard()
 * was inside the pointerup handler behind `if (!st) return`. A browser fires compatibility MOUSE
 * events after a touch, not a second pointerdown, and this file bound nothing to 'click'. So on
 * the device the file was written for the board was completely inert: no drag, no tap, no modal.
 * The two sibling boards carry the identical guard and BOTH pair it with a delegated click.
 * And even reaching the modal did not help — it had Carrier, Tracking, Close, Open estimate, Open
 * invoice and Save, and no stage control at all, while board.js and pipeline.js both have one. So
 * Shipped was a one-way door: PUT /api/orders/:id/stage takes either direction and returns 200,
 * and clearing the tracking number does NOT walk the card back (advanceOrder is forward-only and a
 * blank number skips it entirely). */
/* ---------- a nonce is not an identity (v20) ----------
 * qbo_oauth_state and gdrive_oauth_state were written into the ordinary settings row, and
 * publicSettings() only blanks SECRET_KEYS — so GET /api/settings, which has no requireRole (only
 * its `members` array is gated), handed the live OAuth state to every signed-in account of any
 * role. That state was the ONLY check on /api/qbo/callback and /api/gdrive/callback, neither of
 * which had a role gate at all. A staff account could therefore read the state, consent to the
 * shop's own Intuit app against their OWN QuickBooks company, and repoint the shop's books. The
 * Drive half is worse: once gdrive_refresh_token is theirs, POST /api/jobs/:id/art uploads every
 * subsequent customer proof into their Drive, shares it, and deletes the local copy.
 * The state also never expires and is cleared only on SUCCESS, so one manager who starts a connect
 * and closes the tab leaves a permanently valid nonce in a payload every staff member can read. */
/* ---------- a website visitor cannot write over the shop's biggest deal (v20) ----------
 * chat_sessions.state carries the session's opportunity rowid as JSON, and captureLead() re-read
 * it and blind-UPDATEd `WHERE id = ?` on every later turn. opportunities.id is a reused rowid and
 * DELETE /api/opportunities/:id has no guard, so:
 *   1. a visitor chats on the public widget; captureLead opens deal 57 and stores it in the state;
 *   2. the manager tidies the pipeline and deletes 57 — exactly the junk-bot-lead row this path
 *      produces;
 *   3. the shop writes its next real quote, and syncFromEstimate lands it on rowid 57;
 *   4. the visitor's widget session is still live, they type one more message, and the $18,400
 *      school-district deal is retitled, revalued to $1,240, and has a stranger's transcript,
 *      email and phone in its notes. Nothing logs it and no screen shows the old value, while Open
 *      Pipeline and the Weighted Forecast both move.
 * Same shape as automation_pending.ctx and art_versions.estimate_id, on the one table nobody had
 * covered — and reached by an ANONYMOUS caller, which is why it gets a write-site check too. */
section('a website visitor cannot write over the shop\'s biggest deal')
await t('deleting a deal clears the chat session that was pointing at it', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const ag = await import('../lib/agent.mjs')
  const db = new DatabaseSync(':memory:')
  dbm.initDb(db)
  const prev = dbm.getDb()
  dbm.setDefaultDb(db); ag.initAgent(db)
  try {
    dbm.run("INSERT INTO contacts (id, name) VALUES (1, 'Website Visitor')")
    dbm.run("INSERT INTO opportunities (id, contact_id, title, stage, value, source) VALUES (57, 1, 'Junk lead', 'lead', 0, 'ai-receptionist')")
    dbm.run("INSERT INTO chat_sessions (id, public_id, contact_id, state) VALUES (1, 'pub-1', 1, ?)", JSON.stringify({ _oppId: 57, name: 'Stranger', qty: 300 }))
    // A row whose state is somehow not JSON must not make deleting a deal throw — a malformed chat
    // row cannot be allowed to make a pipeline card undeletable.
    dbm.run("INSERT INTO chat_sessions (id, public_id, contact_id, state) VALUES (2, 'pub-2', 1, 'not json')")
    dbm.run('DELETE FROM opportunities WHERE id = 57')
    const st = JSON.parse(dbm.get('SELECT state FROM chat_sessions WHERE id = 1').state)
    assert.equal(st._oppId, undefined, "the session still points at a rowid the next quote will be handed")
    assert.equal(st.name, 'Stranger', '…and the rest of the session is untouched')
    assert.equal(dbm.get('SELECT state FROM chat_sessions WHERE id = 2').state, 'not json', 'a malformed row survives the delete')
    // The estimate half of the same state, same rule.
    dbm.run("INSERT INTO estimates (id, contact_id, estimate_number, status, items, subtotal, tax, total) VALUES (9, 1, 'EST-9', 'draft', '[]', 100, 0, 100)")
    dbm.run("UPDATE chat_sessions SET state = ? WHERE id = 1", JSON.stringify({ _estId: 9 }))
    dbm.run('DELETE FROM estimates WHERE id = 9')
    assert.equal(JSON.parse(dbm.get('SELECT state FROM chat_sessions WHERE id = 1').state)._estId, undefined,
      'a deleted quote leaves the session pointing at the next quote number')
  } finally { dbm.setDefaultDb(prev) }
})
await t('…and the visitor\'s own turn refuses to write on a deal that is not theirs', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'lib/agent.mjs'), 'utf8')
  const cap = src.slice(src.indexOf('// One opportunity per session.'), src.indexOf('// Draft an estimate once'))
  assert.ok(cap.length > 100, 'captureLead should still be there')
  assert.doesNotMatch(cap, /UPDATE opportunities SET title=\?, value=\?, notes=\?, updated_at=\? WHERE id=\?'/,
    'a bare WHERE id = ? is driven straight off a value an anonymous visitor controls')
  assert.match(cap, /WHERE id=\? AND contact_id=\? AND source=\?/, 'scope the write to a deal this session actually opened')
  assert.match(cap, /if \(!hit\.changes\) \{ oppId = null; state\._oppId = null \}/,
    'and when it matches nothing of ours, open a fresh deal rather than writing on a stranger\'s')
})

/* ---------- three small ones with big blast radius (v20) ---------- */
section('three small ones with big blast radius')
await t('every credential in the product comes from the CSPRNG, including the one an admin hands over', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'server.mjs'), 'utf8')
  const i = src.indexOf("app.post('/api/admin/shops'")
  assert.ok(i > 0, 'the admin shop-create route should still be there')
  // Comments stripped: this rule is about what the code DOES, and the comment explaining the fix
  // naturally names the thing it removed.
  const body = src.slice(i, src.indexOf('\n}))', i)).replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(body, /Math\.random/, 'a shop OWNER password minted from Math.random is predictable from a few observed draws')
  assert.match(body, /crypto\.randomBytes\(\d+\)\.toString\('base64url'\)/, '…and base64url is a fixed length, where toString(36) drops trailing zeros')
  // The length bug: two short draws put the password under MIN_PASSWORD and createTenant then
  // 400'd the operator for a password they never typed.
  const { MIN_PASSWORD } = await import('../lib/tenants.mjs')
  const crypto = await import('node:crypto')
  for (let n = 0; n < 200; n++) {
    const pw = `${crypto.randomBytes(4).toString('base64url')}-${crypto.randomBytes(6).toString('base64url')}`
    assert.ok(pw.length >= (MIN_PASSWORD || 8), `minted a ${pw.length}-character password against a ${MIN_PASSWORD} minimum`)
  }
})
await t('the handler that catches every unexpected throw logs a stack, like its three siblings', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'server.mjs'), 'utf8')
  const line = src.split('\n').find((l) => l.includes("console.error('unhandled:'"))
  assert.ok(line, 'the terminal error handler should still log something')
  assert.match(line, /err\.stack/, 'every 500 in production was one unattributable line')
  assert.match(line, /err\?\.code/, '…and this handler branches on err.code eleven lines later')
  // The three that always got it right, so the rule is "all four" rather than "this one".
  for (const other of ['unhandledRejection:', 'uncaughtException:']) {
    const l = src.split('\n').find((x) => x.includes(`console.error('${other}`))
    assert.match(l || '', /\.stack/, `${other} must keep its stack too`)
  }
})
await t('cp .env.example .env does not switch webhook retention to forever', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  // `??` only falls back on undefined/null. A bare `KEY=` line sets the EMPTY STRING, Number('')
  // is 0, and 0 is the documented "keep everything" switch — so every install that followed the
  // docs kept every webhook payload forever, on a table that grows with every delivery.
  const env = readFileSync(join(root, '.env.example'), 'utf8')
  assert.doesNotMatch(env, /^PSC_WEBHOOK_RETENTION_DAYS=[ \t]*$/m, 'a bare KEY= line is not "unset", it is the empty string')
  const dbm = await import('../lib/db.mjs')
  const prev = process.env.PSC_WEBHOOK_RETENTION_DAYS
  try {
    // The default expression has to survive a blank as well as an absent variable.
    for (const v of ['', '   ', undefined]) {
      if (v === undefined) delete process.env.PSC_WEBHOOK_RETENTION_DAYS
      else process.env.PSC_WEBHOOK_RETENTION_DAYS = v
      const days = Number(String(process.env.PSC_WEBHOOK_RETENTION_DAYS ?? '').trim() || 30)
      assert.equal(days, 30, `PSC_WEBHOOK_RETENTION_DAYS=${JSON.stringify(v)} must mean the 30-day default, not "forever"`)
    }
    // …and the documented escape hatch still works.
    process.env.PSC_WEBHOOK_RETENTION_DAYS = '0'
    assert.equal(Number(String(process.env.PSC_WEBHOOK_RETENTION_DAYS ?? '').trim() || 30), 0, 'an explicit 0 still means keep everything')
    const src = readFileSync(join(root, 'lib/db.mjs'), 'utf8')
    assert.match(src, /days = Number\(String\(process\.env\.PSC_WEBHOOK_RETENTION_DAYS \?\? ''\)\.trim\(\) \|\| 30\)/,
      'the shipped default has to be the one this test just proved')
    assert.equal(typeof dbm.pruneWebhookDeliveries, 'function', 'the sweep should still exist')
  } finally {
    if (prev === undefined) delete process.env.PSC_WEBHOOK_RETENTION_DAYS
    else process.env.PSC_WEBHOOK_RETENTION_DAYS = prev
  }
})

section('a nonce is not an identity')
await t('the OAuth state is never handed to a client', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const db = new DatabaseSync(':memory:')
  dbm.initDb(db)
  const prev = dbm.getDb()
  dbm.setDefaultDb(db)
  try {
    dbm.setSetting('qbo_oauth_state', 'nonce-abc')
    dbm.setSetting('gdrive_oauth_state', 'nonce-def')
    dbm.setSetting('shop_name', 'Alpha Ink')
    const pub = dbm.publicSettings()
    assert.equal('qbo_oauth_state' in pub, false, 'the QuickBooks state is the only lock on its callback')
    assert.equal('gdrive_oauth_state' in pub, false, 'and the Drive one on its')
    assert.equal(pub.shop_name, 'Alpha Ink', 'the rest of the settings still have to come through')
    // …and a secret is still blanked-with-a-flag rather than deleted, because the form needs to
    // know whether one is set. These are two different rules and both have to keep holding.
    dbm.setSetting('smtp_pass', 'hunter2')
    const p2 = dbm.publicSettings()
    assert.equal(p2.smtp_pass, '', 'a stored credential is never sent')
    assert.equal(p2.smtp_pass_set, true, '…but the form has to know it is there')
  } finally { dbm.setDefaultDb(prev) }
})
await t('…and finishing a connection takes the same role as starting one', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'server.mjs'), 'utf8')
  for (const [route, what] of [['/api/qbo/callback', 'QuickBooks'], ['/api/gdrive/callback', 'Google Drive']]) {
    const i = src.indexOf(`app.get('${route}'`)
    assert.ok(i > 0, `${route} should still be there`)
    const body = src.slice(i, src.indexOf('\n}))', i))
    assert.match(body, /hasRole\(req, 'manager'\)/,
      `${what}: the state nonce proves a flow was started, never who is finishing it`)
    // Plain text, not requireRole's JSON — this response is read by a human in an address bar.
    assert.match(body, /res\.status\(403\)\.send\(/, `${what}: a browser redirect lands here, so the refusal has to be readable`)
    // And the check has to come FIRST, before the state comparison tells a prober anything.
    assert.ok(body.indexOf('hasRole') < body.indexOf('oauth_state'), `${what}: gate before you compare`)
  }
  // The routes it mirrors, which have always been gated.
  assert.match(src, /app\.get\('\/api\/qbo\/connect', requireRole\('manager'\)/, 'the connect route keeps its gate')
  assert.match(src, /app\.get\('\/api\/gdrive\/connect', requireRole\('manager'\)/, 'and so does the Drive one')
})

section('the Orders board answers a finger')
await t('a tap opens a card, on the touch screen this board was written for', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const o = readFileSync(join(root, 'public/js/views/orders.js'), 'utf8')
  // The touch guard stays — a sideways swipe must not commit a stage change.
  assert.match(o, /if \(e\.pointerType === 'touch'\) return/, 'a finger must still not drag a card')
  // …but the tap has to be answered somewhere a finger actually reaches. core.js `on()` is a
  // DELEGATED CLICK, which is what a tap fires.
  assert.match(o, /on\(\$\('#board'\), '\.jcard'/, 'nothing on this board answers a tap')
  assert.match(o, /openCard\(byId\(t\.dataset\.id\)/, '…and the tap has to open the card')
  // …and the pointerup path must not ALSO open it, or a mouse click opens the modal twice.
  const up = o.slice(o.indexOf("window.addEventListener('pointerup'"), o.indexOf('function openCard('))
  assert.doesNotMatch(up, /openCard\(/, 'the click delegate owns tapping now — two openers is two modals')
  assert.match(up, /dragEndedAt = Date\.now\(\)/, 'and a real drop must suppress the click a mouse fires after it')
  assert.match(o, /Date\.now\(\) - dragEndedAt < 250/, '…which the click delegate has to honour')
})
await t('…and the card it opens can move the order in either direction', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const o = readFileSync(join(root, 'public/js/views/orders.js'), 'utf8')
  const card = o.slice(o.indexOf('function openCard('))
  assert.match(card, /<select class="input" id="ob-stage" name="stage">/,
    'with drag gone on touch, the modal is the ONLY way to change a stage — and it had no stage control')
  assert.match(card, /api\.put\(`\/api\/orders\/\$\{c\.id\}\/stage`, \{ stage \}\)/, 'and it has to actually send it')
  // Order matters: /tracking calls advanceOrder afterwards and advanceOrder is forward-only, so a
  // stage set second would be clobbered by a tracking number still sitting in the box.
  assert.ok(card.indexOf('/stage`, { stage })') < card.indexOf('/tracking`, f)'),
    'the stage has to be sent BEFORE the tracking number, or a walk-back is silently undone')
  // The screen used to promise that clearing the tracking number moves the card back. It does not.
  assert.doesNotMatch(card, /Adding a tracking number moves this card to Shipped\.<\/div>/,
    'the copy has to say that tracking only ever moves a card FORWARD')
})

section('a document is a demand for money, never the other way round')
await t('a mistyped discount is refused rather than stored as a negative quote', async () => {
  const { computeTotals } = await import('../public/js/shared/pricing.js')
  // 100 tees at $8.75, three screens at $25 non-taxable, and a discount typed as -1200 for -120.
  const t2 = computeTotals([
    { description: 'Tee', sizes: { M: 100 }, unit_price: 8.75, taxable: true },
    { description: 'Screen setup', qty: 3, unit_price: 25, taxable: false },
    { description: 'Discount', qty: 1, unit_price: -1200, taxable: true },
  ], 7.75, {})
  assert.deepEqual([t2.subtotal, t2.tax, t2.total], [-250, -25.19, -275.19], 'the arithmetic this is about')
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'server.mjs'), 'utf8')
  const m = /const nonNegativeTotals = (\(t\) => [^\n]+)/.exec(src)
  assert.ok(m, 'nothing floors a document total at zero')
  // eslint-disable-next-line no-new-func — read the shipped predicate, not a copy of it.
  const guard = new Function(`return ${m[1]}`)()
  assert.equal(guard(t2), false, 'a negative total has to be refused')
  assert.equal(guard({ subtotal: 0, tax: 0, total: 0 }), true, 'a $0 quote — a comp, a sample — is legitimate')
  assert.equal(guard({ subtotal: 875, tax: 67.81, total: 942.81 }), true, 'and an ordinary one obviously is')
  // Every door the app's own screens post through. (The v1 API refuses a negative unit_price
  // outright at server.mjs, so a discount can never reach it.)
  assert.equal((src.match(/if \(!nonNegativeTotals\(t\)\) return res\.status\(400\)\.json\(NEGATIVE_TOTAL\)/g) || []).length, 4,
    'create, edit, duplicate and reorder all write estimate totals — all four need the guard')
})
await t('…and the two receivables screens cannot report different money', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const db = new DatabaseSync(':memory:')
  dbm.initDb(db)
  const prev = dbm.getDb()
  dbm.setDefaultDb(db)
  try {
    dbm.run("INSERT INTO contacts (id, name) VALUES (1, 'A')")
    dbm.run("INSERT INTO invoices (contact_id, invoice_number, status, amount_due, amount_paid) VALUES (1,'INV-1',   'unpaid', 1000, 0)")
    dbm.run("INSERT INTO invoices (contact_id, invoice_number, status, amount_due, amount_paid) VALUES (1,'INV-2',   'unpaid', -275.19, 0)")
    // Run the SHIPPED SQL, read out of server.mjs, against both readers — a hand-copied query
    // here would pass whatever the app actually does.
    const { readFileSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(join(join(dirname(fileURLToPath(import.meta.url)), '..'), 'server.mjs'), 'utf8')
    const kpiSql = /const outstanding = round2\(get\(\s*`([^`]+)`/.exec(src)
    assert.ok(kpiSql, 'the Outstanding KPI query should still be readable')
    const agingSql = /const open = all\(`(SELECT \* FROM invoices[^`]+)`/.exec(src)
    assert.ok(agingSql, "the A/R aging report's own query should still be readable")
    const kpi = dbm.get(kpiSql[1]).v
    const aging = dbm.all(agingSql[1].replace(/contact_id = \?/, 'contact_id = 1').replace(/ORDER BY[\s\S]*$/, ''))
      .reduce((n, r) => n + (r.amount_due - r.amount_paid), 0)
    assert.equal(kpi, aging, 'Outstanding on the dashboard and the A/R aging report read the same invoices')
    assert.equal(kpi, 1000, '…and "Outstanding" means money customers owe the shop, not netted against a credit')
  } finally { dbm.setDefaultDb(prev) }
})

section('every deal is in a column the shop can drag it out of')
await t('the Dashboard and the Pipeline board cannot disagree about open value', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const P = await import('../lib/pipeline.mjs')
  const db = new DatabaseSync(':memory:')
  dbm.initDb(db)
  const prev = dbm.getDb()
  dbm.setDefaultDb(db)
  try {
    dbm.run("INSERT INTO contacts (id, name) VALUES (1, 'Website Visitor')")
    for (const k of P.STAGE_KEYS) dbm.run("INSERT INTO opportunities (contact_id, title, stage, value, source) VALUES (1, ?, ?, 100, 'manual')", k, k)
    dbm.run("INSERT INTO opportunities (contact_id, title, stage, value, source) VALUES (1, 'Website inquiry', 'qualified', 8400, 'ai-receptionist')")
    const s = P.pipelineStats(), b = P.pipelineBoard()
    assert.equal(s.open_value, b.stats.open_value, 'the Dashboard KPI and the board header read the same table')
    assert.equal(s.open_count, b.stats.open_count, '…and must count the same rows')
    // …and the invariant that actually matters to the shop: every deal is SOMEWHERE it can be
    // reached from. A card in no column is a record no screen in the product can correct.
    const drawn = b.columns.reduce((n, c) => n + c.opps.length, 0)
    const total = dbm.get('SELECT COUNT(*) AS c FROM opportunities').c
    assert.equal(drawn, total, 'a deal drawn in no column can never be opened, edited or dragged')
  } finally { dbm.setDefaultDb(prev) }
})
await t('…and a database already carrying one is rescued on the next boot', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const P = await import('../lib/pipeline.mjs')
  const db = new DatabaseSync(':memory:')
  dbm.initDb(db)
  const prev = dbm.getDb()
  dbm.setDefaultDb(db)
  try {
    dbm.run("INSERT INTO contacts (id, name) VALUES (1, 'Website Visitor')")
    dbm.run("INSERT INTO opportunities (contact_id, title, stage, value, source) VALUES (1, 'Website inquiry', 'qualified', 8400, 'ai-receptionist')")
    dbm.run("DELETE FROM schema_migrations WHERE name = 'opportunity_stage_is_a_real_stage'")
    dbm.initDb(db)   // the upgrade
    assert.equal(dbm.get('SELECT stage FROM opportunities WHERE id = 1').stage, 'lead',
      'the card was in no column, so nothing in the product could move it')
    assert.equal(P.pipelineBoard().columns.reduce((n, c) => n + c.opps.length, 0), 1, 'and now it is drawable')
    // Latched: a stage a person has typed since is theirs.
    dbm.run("UPDATE opportunities SET stage = 'negotiation' WHERE id = 1")
    dbm.initDb(db)
    assert.equal(dbm.get('SELECT stage FROM opportunities WHERE id = 1').stage, 'negotiation', 'the sweep must not re-run')
  } finally { dbm.setDefaultDb(prev) }
})
await t('and nothing can write a stage the board has no column for', async () => {
  const P = await import('../lib/pipeline.mjs')
  assert.equal(typeof P.normStage, 'function', 'the vocabulary needs one place that closes it')
  assert.equal(P.normStage('qualified'), 'lead')
  assert.equal(P.normStage('quoted'), 'quoted')
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  // Every INSERT into opportunities, anywhere, must go through a guard. POST /api/opportunities
  // has always had one inline; the receptionist never did.
  const ag = readFileSync(join(root, 'lib/agent.mjs'), 'utf8')
  assert.match(ag, /normStage\(stage\)/, 'the receptionist writes the stage straight in')
  assert.doesNotMatch(ag, /\? 'lead' : 'qualified'/, "'qualified' is not a stage this app has")
  const srv = readFileSync(join(root, 'server.mjs'), 'utf8')
  assert.match(srv, /pipeline\.STAGE_KEYS\.includes\(b\.stage\)/, 'the manual route must keep its guard too')
})

section('the pipeline follows the quote it was opened from')
await t('editing a quote down re-prices the deal, and deleting it takes the deal with it', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const P = await import('../lib/pipeline.mjs')
  const db = new DatabaseSync(':memory:')
  dbm.initDb(db)
  const prev = dbm.getDb()
  dbm.setDefaultDb(db)
  try {
    dbm.run("INSERT INTO contacts (id, name) VALUES (1, 'Northgate High')")
    dbm.run("INSERT INTO estimates (id, contact_id, estimate_number, status, items, subtotal, tax, total) VALUES (1,1,'EST-1','draft','[]',8000,0,8000)")
    dbm.run("INSERT INTO estimates (id, contact_id, estimate_number, status, items, subtotal, tax, total) VALUES (2,1,'EST-2','draft','[]',670,0,670)")
    P.syncFromEstimate(dbm.get('SELECT * FROM estimates WHERE id = 1'), 'created')
    P.syncFromEstimate(dbm.get('SELECT * FROM estimates WHERE id = 2'), 'created')
    // The dashboard's own KPI, beside the pipeline's, out of one payload. For a shop whose only
    // deals came from estimates these two must never disagree — that is the whole invariant.
    const kpi = () => dbm.get("SELECT COALESCE(SUM(COALESCE(subtotal, total)), 0) AS v FROM estimates WHERE status IN ('draft','sent')").v
    assert.equal(kpi(), 8670, 'precondition')
    assert.equal(P.pipelineStats().open_value, 8670, 'precondition')

    // PUT /api/estimates/:id — the UPDATE, then the sync the three sibling routes always had.
    dbm.run('UPDATE estimates SET subtotal=?, tax=?, total=? WHERE id=?', 4000, 0, 4000, 1)
    P.syncFromEstimate(dbm.get('SELECT * FROM estimates WHERE id = 1'), 'updated')
    assert.equal(kpi(), 4670)
    assert.equal(P.pipelineStats().open_value, 4670, 'the deal kept the value the quote no longer has')
    assert.equal(P.pipelineStats().weighted_value, 1401, 'and carried it into the weighted forecast')

    // DELETE /api/estimates/:id — the route's own transaction, verbatim.
    dbm.tx(() => {
      dbm.run('DELETE FROM art_versions WHERE estimate_id = ?', 1)
      dbm.run("DELETE FROM opportunities WHERE estimate_id = ? AND source = 'estimate'", 1)
      dbm.run('DELETE FROM estimates WHERE id = ?', 1)
    })
    assert.equal(kpi(), 670)
    assert.equal(P.pipelineStats().open_value, 670, 'a deleted quote left its value in Open Pipeline forever')
    assert.equal(dbm.all("SELECT id FROM opportunities WHERE estimate_id IS NULL AND source = 'estimate'").length, 0,
      'and left an orphan oppForEstimate could never find again')
  } finally { dbm.setDefaultDb(prev) }
})
await t('…and the schema holds the same rule for any other path that deletes a quote', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const P = await import('../lib/pipeline.mjs')
  const db = new DatabaseSync(':memory:')
  dbm.initDb(db)
  const prev = dbm.getDb()
  dbm.setDefaultDb(db)
  try {
    dbm.run("INSERT INTO contacts (id, name) VALUES (1, 'Northgate High')")
    dbm.run("INSERT INTO estimates (id, contact_id, estimate_number, status, items, subtotal, tax, total) VALUES (1,1,'EST-1','draft','[]',8000,0,8000)")
    P.syncFromEstimate(dbm.get('SELECT * FROM estimates WHERE id = 1'), 'created')
    // A hand-typed deal the shop attached to the same customer is NOT the app's to bin.
    dbm.run("INSERT INTO opportunities (contact_id, estimate_id, title, stage, value, source) VALUES (1, 1, 'Spring reorder', 'negotiation', 2500, 'manual')")
    dbm.run('DELETE FROM estimates WHERE id = 1')   // no route, just the raw delete
    const left = dbm.all('SELECT source, value FROM opportunities').map((o) => `${o.source}:${o.value}`)
    assert.deepEqual(left, ['manual:2500'],
      "the quote's own deal goes; a deal a person typed stays")
  } finally { dbm.setDefaultDb(prev) }
})

section('a QuickBooks push never survives its invoice')
await t('deleting the customer takes the dead push row with the invoice', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const db = new DatabaseSync(':memory:')
  dbm.initDb(db)
  const prev = dbm.getDb()
  dbm.setDefaultDb(db)
  try {
    dbm.run('INSERT INTO contacts (id, name, created_at, updated_at) VALUES (1, ?, ?, ?)', 'Raised In Error', dbm.now(), dbm.now())
    dbm.run('INSERT INTO contacts (id, name, created_at, updated_at) VALUES (2, ?, ?, ?)', 'Real Customer', dbm.now(), dbm.now())
    dbm.run("INSERT INTO invoices (contact_id, invoice_number, status, amount_due) VALUES (1, 'INV-1001', 'void', 800)")
    const dead = dbm.get("SELECT id FROM invoices WHERE invoice_number = 'INV-1001'").id
    dbm.run("INSERT INTO qbo_sync (entity, entity_id, status, error) VALUES ('invoice', ?, 'pending', ?)", dead, 'QuickBooks was down')

    // The route's own path: a voided invoice does not block, so the cascade fires.
    dbm.run('DELETE FROM contacts WHERE id = 1')
    assert.equal(dbm.all('SELECT id FROM invoices').length, 0, 'precondition: the invoice cascaded away')
    assert.equal(dbm.all("SELECT id FROM qbo_sync WHERE entity = 'invoice'").length, 0,
      'the push row must not outlive the invoice it was raised against')

    // Now the real harm: the freed rowid comes back on the next customer's invoice.
    dbm.run("INSERT INTO invoices (contact_id, invoice_number, status, amount_due) VALUES (2, 'INV-1002', 'unpaid', 4200)")
    const live = dbm.get("SELECT id FROM invoices WHERE invoice_number = 'INV-1002'").id
    assert.equal(live, dead, 'precondition: SQLite reissued the rowid')
    const shown = dbm.all(`SELECT q.status, q.error, i.invoice_number FROM qbo_sync q
      LEFT JOIN invoices i ON i.id = q.entity_id WHERE q.entity = 'invoice'`)
    assert.deepEqual(shown, [], "the new customer's invoice must not inherit the old failure")
    // enqueueQbo()'s idempotence check is the silent one: an open row for this id skips the queue.
    assert.equal(dbm.all("SELECT id FROM qbo_sync WHERE entity = 'invoice' AND entity_id = ? AND status IN ('pending','retrying','syncing')", live).length, 0,
      'a stale open row would make enqueueQbo skip a real invoice, forever and silently')
  } finally { dbm.setDefaultDb(prev) }
})
await t('…and a database that is already carrying an orphan is swept on the next boot', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const db = new DatabaseSync(':memory:')
  dbm.initDb(db)
  // Drop the trigger to recreate the pre-fix state, then orphan a row the way an old build did.
  db.exec('DROP TRIGGER IF EXISTS trg_qbo_sync_invoice_delete')
  const prev = dbm.getDb()
  dbm.setDefaultDb(db)
  try {
    dbm.run('INSERT INTO contacts (id, name, created_at, updated_at) VALUES (1, ?, ?, ?)', 'Gone', dbm.now(), dbm.now())
    dbm.run("INSERT INTO invoices (contact_id, invoice_number, status, amount_due) VALUES (1, 'INV-9001', 'void', 500)")
    const dead = dbm.get("SELECT id FROM invoices WHERE invoice_number = 'INV-9001'").id
    dbm.run("INSERT INTO qbo_sync (entity, entity_id, status) VALUES ('invoice', ?, 'retrying')", dead)
    dbm.run('DELETE FROM contacts WHERE id = 1')
    assert.equal(dbm.all('SELECT id FROM qbo_sync').length, 1, 'precondition: the old build left the orphan behind')
    dbm.initDb(db)   // the upgrade
    assert.equal(dbm.all('SELECT id FROM qbo_sync').length, 0, 'the upgrade must clear an orphan already on disk')
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

section('a locked-out owner is refused only when the server really cannot mail')
// POST /api/auth/forgot gated on platformEmailConfigured(), which asks one question: is
// GoHighLevel wired up? sendEmail({platform:true}) will use server-wide SMTP first, then GHL, then
// the Postmark/Resend relay — so an install configured exactly the way .env.example documents
// (SMTP_HOST / SMTP_USER / SMTP_PASS) was told "this install has no email configured, so a reset
// link cannot be sent", 503, and its locked-out owner was sent to a shell command on a server that
// would have delivered the reset. Two of the three supported arrangements were invisible to the one
// check that decides whether anybody can get back in.
await t('server-wide SMTP counts as being able to send a password reset', async () => {
  const OLD = { ...process.env }
  try {
    for (const k of ['GHL_PIT', 'GHL_LOCATION_ID', 'GHL_EMAIL_FROM', 'PSC_POSTMARK_TOKEN', 'PSC_RESEND_KEY']) delete process.env[k]
    process.env.SMTP_HOST = 'smtp.example.com'
    process.env.SMTP_USER = 'shop@example.com'
    process.env.SMTP_PASS = 'hunter2hunter2'
    const n = await import('../lib/notify.mjs')
    assert.ok(n.emailConfigured({}), 'sanity: this is the branch sendEmail({platform:true}) would take')
    assert.equal(n.platformEmailConfigured(), false, 'sanity: and the GHL relay is deliberately not configured')
    assert.ok(n.platformEmailDeliverable(), 'the reset route must not refuse an install whose SMTP would have sent it')
  } finally { process.env = OLD }
})

await t('…as does the Postmark/Resend relay', async () => {
  const OLD = { ...process.env }
  try {
    for (const k of ['GHL_PIT', 'GHL_LOCATION_ID', 'GHL_EMAIL_FROM', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']) delete process.env[k]
    process.env.PSC_POSTMARK_TOKEN = 'pm-token'
    const n = await import('../lib/notify.mjs')
    assert.ok(n.platformEmailDeliverable(), 'the relay is a documented way to configure platform mail')
  } finally { process.env = OLD }
})

await t('…and an install with genuinely no mail is still refused honestly', async () => {
  const OLD = { ...process.env }
  try {
    for (const k of ['GHL_PIT', 'GHL_LOCATION_ID', 'GHL_EMAIL_FROM', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'PSC_POSTMARK_TOKEN', 'PSC_RESEND_KEY']) delete process.env[k]
    const n = await import('../lib/notify.mjs')
    assert.equal(n.platformEmailDeliverable(), false, 'promising a link nothing will deliver is the worse failure')
  } finally { process.env = OLD }
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
  ]) {
    assert.equal(sup.costFor(text)?.sku, sku, `${text} must still order ${sku}`)
  }
})

/* The style match names THIS garment. The brand+type and bare-type fallbacks underneath it do not
 * — they find something vaguely like it — and they were returning a real SKU with matched:true.
 * So every brand outside the shipped 43-row catalogue was quietly ordered as a Gildan or Bella
 * basic at that basic's price. Observed: "Nike DV7299 Dri-FIT Tee" produced a PO of 300 × G500 at
 * $3.20 with warnings:[], the submit went through to the distributor as four lines of "G500", and
 * ROI reported an 84.9% margin on it. Round 5 fixed the same shape one layer up (a job TITLE being
 * read as a garment) and wrote that trading a visible dead end for an invisible wrong order is
 * strictly worse. This is the other half of that: the fallbacks keep the cost as a planning
 * ballpark and lose the SKU, so the PO warns and the submit refuses.
 *
 * Shipped in the same release as the Garment field on the job form — the honest refusal is only
 * an improvement if there is somewhere to answer it. */
await t('a brand outside the catalogue is not ordered as a Gildan', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const sup = await import('../lib/suppliers.mjs')
  const db = new DatabaseSync(':memory:')
  dbm.initDb(db); dbm.setDefaultDb(db); sup.initSuppliers(db)
  for (const text of [
    'Nike DV7299 Dri-FIT Tee — Black',
    'Carhartt K87 Pocket Tee — Heather Grey',
    'Adidas A430 Hoodie — Black',
    'Under Armour 1376843 Performance Polo — Navy',
    'American Apparel 2001 Fine Jersey Tee',
    'Custom cut-and-sew heavyweight hoodie',
    '24 black tees', // names no garment at all
  ]) {
    const m = sup.costFor(text)
    assert.equal(m?.sku ?? null, null, `${text} must not hand back a SKU to order`)
    assert.equal(m?.matched, false, `${text} must not report itself as matched`)
  }
})
await t('…but it is still costed, so the quote is not blank', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const sup = await import('../lib/suppliers.mjs')
  const db = new DatabaseSync(':memory:')
  dbm.initDb(db); dbm.setDefaultDb(db); sup.initSuppliers(db)
  const m = sup.costFor('Nike DV7299 Dri-FIT Tee — Black')
  assert.ok(Number(m?.cost) > 0, 'an off-catalogue blank still gets a planning cost')
  assert.equal(m?.approximate, true, 'and says that cost is approximate')
})
await t('…and the purchase order says so instead of ordering it anyway', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const sup = await import('../lib/suppliers.mjs')
  const db = new DatabaseSync(':memory:')
  dbm.initDb(db); dbm.setDefaultDb(db); sup.initSuppliers(db)
  const po = sup.buildPurchaseOrder({ job_number: 'JOB-1' }, { S: 50, M: 100 }, 'Nike DV7299 Dri-FIT Tee — Black', {})
  assert.equal(po.lines[0].sku, null, 'no SKU reaches the distributor')
  assert.match(po.warnings.join(' '), /No catalog SKU matched/, 'the shop is warned before it orders')
})
await t('a style has to sit on its own, not inside a longer run', async () => {
  const { styleMatches } = await import('../lib/suppliers.mjs')
  assert.equal(styleMatches('gildan 5000 tee', '5000'), true)
  assert.equal(styleMatches('gildan 5000b tee', '5000'), false)
  assert.equal(styleMatches('gildan 42000', '2000'), false)
  assert.equal(styleMatches('bella 3001cvc', '3001'), false)
  assert.equal(styleMatches('port & company pc61 navy', 'PC61'), true)
})

/* The garment colour on a purchase order was read out of the INK.
 *
 * `colorFrom` walked a hard-coded PO_COLORS array and returned the first entry that appeared
 * ANYWHERE in the garment text — array order, not text order — and the estimate writes the
 * imprint on the same line as the blank. So the ink spec won, and a shop ordered the wrong
 * colour of shirt with no warning at all, because a colour *was* found:
 *
 *   "Gildan 5000 Tee — White — 3/0 Front (black, red, navy ink)"  ordered BLACK
 *   "Gildan 5000 Tee — Navy (white ink)"                          ordered WHITE
 *   "Comfort Colors 1717 — Sand — 1/0 left chest (black ink)"     ordered BLACK
 *   "Gildan 18500 Hoodie — Red — front (white/black ink)"          ordered BLACK
 *
 * Four of those five are a whole run of blanks in the wrong colour, discovered on press day.
 * Two rules fix it and both are about where the colour lives, not which colours exist:
 * parentheses are an ink spec and never the blank, and the garment's colour sits in the
 * "Style — Colour" segment the estimate writes, so scan that first. Within the scope the
 * EARLIEST colour in the text wins, not the earliest in the array. */
section('the purchase order orders the shirt colour, not the ink colour')
{
  const poColor = async (text) => {
    const { DatabaseSync } = await import('node:sqlite')
    const dbm = await import('../lib/db.mjs')
    const sup = await import('../lib/suppliers.mjs')
    const db = new DatabaseSync(':memory:')
    dbm.initDb(db); dbm.setDefaultDb(db); sup.initSuppliers(db)
    return sup.buildPurchaseOrder({ job_number: 'JOB-1' }, { S: 50, M: 80 }, text, {}).color
  }
  for (const [text, want] of [
    ['Gildan 5000 Tee — White — 3/0 Front (black, red, navy ink)', 'white'],
    ['Gildan 5000 Tee — Navy (white ink)', 'navy'],
    ['Comfort Colors 1717 — Sand — 1/0 left chest (black ink)', 'sand'],
    ['Gildan 18500 Hoodie — Red — front (white/black ink)', 'red'],
    ['Gildan 5000 — Black', 'black'],                       // unchanged
    ['200 Gildan 5000 in Black (white ink)', 'black'],      // no dash: whole string, ink still ignored
  ]) {
    await t(`${JSON.stringify(text)} → ${want}`, async () => {
      assert.equal(await poColor(text), want)
    })
  }
  await t('a colour ahead of the dash is still found when the segment has none', async () => {
    // Don't trade a wrong order for a missing one: if the colour segment names no colour,
    // fall back to the whole string rather than warning on a garment that did say Black.
    assert.equal(await poColor('Black Gildan 5000 — 3/0 front'), 'black')
  })
  await t('…and a garment with no colour at all still warns', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const dbm = await import('../lib/db.mjs')
    const sup = await import('../lib/suppliers.mjs')
    const db = new DatabaseSync(':memory:')
    dbm.initDb(db); dbm.setDefaultDb(db); sup.initSuppliers(db)
    const po = sup.buildPurchaseOrder({ job_number: 'J' }, { S: 10 }, 'Gildan 5000 Tee', {})
    assert.equal(po.color, null)
    assert.match(po.warnings.join(' '), /No garment color detected/)
  })
}

/* The S&S order body dropped size and colour entirely.
 *
 * consolidatePoLines keys on (sku|style, colour, size), so a size run correctly stays four rows —
 * but every one of those rows carries the SAME sku, because the catalogue is style-level (G500 is
 * "Gildan 5000", not "Gildan 5000 White M"). The wire body was `lines.map(l => ({identifier:
 * l.sku, qty: l.qty}))`, so a 226-piece run of S/M/L/XL left the building as four identical
 * lines of "G500" — 226 pieces of one unknown size, charged, with the local PO record still
 * showing a correct size grid so nothing looked wrong until the boxes arrived.
 *
 * The honest answer is to refuse. A per-size distributor SKU only exists on a live lookup, and
 * this project's own rule (round 5, restated when the brand fallbacks lost their SKUs) is that a
 * visible dead end is recoverable and a confidently wrong order is not. The PO document itself is
 * unaffected — it has always carried size and colour per line — so the shop can still download it
 * and place the order by hand, which is what the refusal tells them to do. */
section('a purchase order cannot leave with size and colour dropped')
{
  const SS = { ss_account: '12345', ss_key: 'k' }
  await t('four sizes on one style-level SKU is refused, not sent as four identical lines', async () => {
    const sup = await import('../lib/suppliers.mjs')
    const po = { supplier: 'S&S Activewear', job: 'JOB-1', lines: [
      { sku: 'G500', style: 'Gildan 5000', color: 'white', size: 'S', qty: 50 },
      { sku: 'G500', style: 'Gildan 5000', color: 'white', size: 'M', qty: 80 },
      { sku: 'G500', style: 'Gildan 5000', color: 'white', size: 'L', qty: 60 },
      { sku: 'G500', style: 'Gildan 5000', color: 'white', size: 'XL', qty: 36 },
    ] }
    await assert.rejects(() => sup.submitPurchaseOrder(po, SS), /one SKU per size and colour/i)
  })
  await t('…and the dry run refuses it too, so the preview never shows a clean order', async () => {
    const sup = await import('../lib/suppliers.mjs')
    const po = { supplier: 'S&S Activewear', job: 'JOB-1', lines: [
      { sku: 'G500', color: 'white', size: 'S', qty: 50 },
      { sku: 'G500', color: 'white', size: 'M', qty: 80 },
    ] }
    await assert.rejects(() => sup.submitPurchaseOrder(po, SS, { dryRun: true }), /one SKU per size and colour/i)
  })
  await t('one SKU per size still submits — the guard is about collisions, not about sizes', async () => {
    const sup = await import('../lib/suppliers.mjs')
    const po = { supplier: 'S&S Activewear', job: 'JOB-1', lines: [
      { sku: 'G500-WHT-S', color: 'white', size: 'S', qty: 50 },
      { sku: 'G500-WHT-M', color: 'white', size: 'M', qty: 80 },
    ] }
    const out = await sup.submitPurchaseOrder(po, SS, { dryRun: true })
    assert.equal(out.ok, true)
    assert.equal(out.total_units, 130)
  })
  await t('a single-cell PO on a style-level SKU is fine — there is nothing to confuse', async () => {
    const sup = await import('../lib/suppliers.mjs')
    const po = { supplier: 'S&S Activewear', job: 'JOB-1', lines: [{ sku: 'G500', color: 'white', size: 'M', qty: 80 }] }
    const out = await sup.submitPurchaseOrder(po, SS, { dryRun: true })
    assert.equal(out.ok, true)
  })
  await t('the refusal names the SKU, so the shop knows which line to fix', async () => {
    const sup = await import('../lib/suppliers.mjs')
    const po = { supplier: 'S&S Activewear', job: 'JOB-1', lines: [
      { sku: 'BC3001', color: 'navy', size: 'S', qty: 12 },
      { sku: 'BC3001', color: 'navy', size: 'L', qty: 12 },
    ] }
    await assert.rejects(() => sup.submitPurchaseOrder(po, SS, { dryRun: true }), /BC3001/)
  })
}

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

  await t('…and it can be picked from for a cap order, whose sizes are not SIZES', async () => {
    // SIZES is the canonical apparel run and does not contain the names caps and bags are really
    // ordered in — 'SM' and 'LXL' on a fitted cap, 'OS' on a tote. Every write path accepts them:
    // SIZE_KEY passes them, sizeTotal counts them, sizeKeys renders them. pickTicket's own block
    // filter asked SIZES.some() instead, so a 120-cap order bought 120 on the PO, listed 120 on
    // the packing slip and 120 on the work ticket — and printed "UNITS 0 / No sizes on file" on
    // the ONE document the warehouse picks from.
    const { pickTicket } = await import('../lib/pdf.mjs')
    const { sizeTotal: st, SIZE_KEY: sk } = await import('../public/js/shared/pricing.js')
    const caps = { SM: 60, LXL: 60 }
    assert.ok(Object.keys(caps).every((k) => sk.test(k)), 'precondition: every write path accepts these')
    assert.equal(st(caps), 120, 'precondition: they are counted everywhere else')
    const pdf = pickTicket({
      job: { job_number: 'JOB-1042', due_date: '2026-09-10', decoration: 'Embroidery' },
      settings: { shop_name: 'Test Shop' },
      lines: [{ description: 'Richardson 112 Trucker — Black', garment: 'Richardson 112 Trucker', sizes: caps }],
    }).toString('latin1')
    assert.ok(!/No sizes on file/.test(pdf), 'the picker was handed a blank ticket for a real order')
    assert.match(pdf, /\(SM\)/, 'the SM row has to be on the ticket')
    assert.match(pdf, /\(LXL\)/, 'and the LXL row')
    assert.match(pdf, /\(120\)/, 'and the unit count must not be 0')
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

  // The orders board was NAMED in the comment above and left out of the test — and it is the one
  // screen written for a phone. Its PUT is not forward-only either, so a sideways swipe moved an
  // order BACKWARDS, with no confirm, no undo and an activity row saying staff did it.
  await t('…and the same on the orders board, which is the one built for a phone', () => {
    const orders = readFileSync(join(root, 'public/js/views/orders.js'), 'utf8')
    const i = orders.indexOf("addEventListener('pointerdown'")
    assert.ok(i > 0, 'the orders board should still wire pointerdown')
    // Bound by the END of the handler rather than a character count: the guard carries a long
    // comment (it is the reason the board needed a delegated click), and a fixed window pushed the
    // assertion off the code it is about the moment that comment grew.
    assert.match(orders.slice(i, orders.indexOf('\n  })', i)), /pointerType === 'touch'/,
      'a touch pointer must not start a drag — a sideways swipe moves an order, and PUT /api/orders/:id/stage goes backwards as happily as forwards')
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

/* ---------- a migration does not email the customer base of the tool they just left ----------
 *
 * lib/automations.mjs says, three lines above the scan loop:
 *
 *   "Imported history is excluded from every timed scan (`imported_at IS NULL`). Migrating a shop
 *    means loading years of quotes and invoices from the tool they just left — without this, the
 *    first tick after an import emails their entire customer base about 2024 paperwork."
 *
 * Two of the four scans carried the predicate. `job.due_soon` and `job.at_risk` did not — and the
 * CSV importer writes jobs.imported_at, so the column exists and is populated on exactly these
 * rows. A shop that imports its open work on a Monday has real customer email going out on the
 * first tick, about jobs the new system has never touched, over a due date it inherited.
 *
 * This is the worst possible first five minutes for a shop that has just switched, and it is the
 * one the comment was written to prevent. */

/* ---------- the assistant answers with the same numbers the screens do (v18) ----------
 *
 * Two of the assistant's money answers disagree with every other surface in the product, and both
 * have the correction already written elsewhere in the codebase:
 *
 *  · "Who is Acme Co" summed `amount_due - amount_paid` over ALL invoices with no status filter,
 *    so a VOIDED invoice was reported as money owed. doOverdue() four functions up filters
 *    `status NOT IN ('paid','void')`; the contact record, the contact list, A/R aging, the
 *    statement and the dashboard all read the void as $0.
 *
 *  · "quotes not yet approved" summed `total`, which includes sales tax. server.mjs fixed exactly
 *    this on the dashboard KPI it mirrors, with the comment still sitting beside it: "SUM(total)
 *    counted sales tax as quoted revenue. What the shop is chasing is what it keeps."
 *
 * A number the shop reads out of the assistant and then acts on has to be the number on the
 * screen. */

/* ---------- the pick ticket fits on the paper it is printed on (v18) ----------
 *
 * pickTicketPage() writes 30pt per size row onto a 792pt sheet and ends with `build([p])` — one
 * page, no pagination, unlike renderDocument() and customerStatement() in the same file, which
 * both call newPage() when they run out of room.
 *
 * On a real 506-piece, 4-style school order (tees, hoodies, ladies tees, caps) 21 of the 76 text
 * operations render at PDF y = 2 down to −316 — that is at and below the bottom edge of the sheet.
 * The entire fourth garment and the grand TOTAL are invisible, and the PICKED BY rule overprints
 * whatever garment name was still on the page. The warehouse picks 254 of 506 with nothing on the
 * paper to say a page is missing.
 *
 * It breaks far earlier than that: two garments at eight sizes already loses the TOTAL.
 *
 * The assertion reads the generated PDF's own text-positioning operators. Page space runs from
 * y = 0 at the bottom, so anything at or below the footer band never reached the paper. */

/* ---------- the packing slip lists the whole shipment (v18) ----------
 *
 * `if (y > PAGE_H - 150) break // single page by design; overflow is rare on a slip`
 *
 * It is not rare — a school, a team store or a corporate order is routinely seven or eight styles
 * — and "single page by design" means the slip silently stops listing at six garment blocks. Two
 * things then go wrong on the document the CUSTOMER SIGNS "RECEIVED BY":
 *
 *  · the missing styles appear nowhere, with no "continued" and no other clue, and
 *  · `grand` only ever counted the blocks that were drawn, so TOTAL UNITS understates the box —
 *    and once y crosses the same threshold the `if (y < PAGE_H - 150)` gate drops TOTAL UNITS
 *    altogether, so from the sixth block on the slip has no check figure at all.
 *
 * Separately, the grid's columns are a fixed 46pt with no width check, so a full youth+adult run
 * pushes the TOTAL column clean off the right edge of a 612pt sheet.
 *
 * A shipping document that omits part of the shipment is worse than no document: the customer
 * signs for what is listed. */

/* ---------- three small things a real shop actually hits (v18) ---------- */

/* A self-hoster who sets SMTP_PORT=465 sends nothing.
 *
 * Both branches of smtpCreds() derive implicit TLS from the port, and the operator branch derives
 * it from the WRONG port: `Number(s?.smtp_port) === 465` reads the SHOP's setting while the port it
 * actually connects on came from `process.env.SMTP_PORT`. So the documented env config for the
 * commonest implicit-TLS port yields secure:false, nodemailer opens a plaintext socket against a
 * TLS-only listener, and every send burns the connection timeout and fails. The shop branch three
 * lines up gets this right on its own port. */
section('a self-hoster on SMTP port 465 gets implicit TLS')
{
  const notify = await import('../lib/notify.mjs')
  const withEnv = (env, fn) => {
    const saved = {}
    for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v }
    try { return fn() } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
  }
  const base = { SMTP_HOST: 'mail.example.com', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_SECURE: undefined, SMTP_FROM: 'a@b.test' }

  await t('SMTP_PORT=465 with no SMTP_SECURE is still implicit TLS', () => {
    const c = withEnv({ ...base, SMTP_PORT: '465' }, () => notify.smtpCreds({}))
    assert.equal(c.port, 465)
    assert.equal(c.secure, true, 'a plaintext socket against a TLS-only listener sends nothing')
  })
  await t('…and 587 still uses STARTTLS, as it must', () => {
    const c = withEnv({ ...base, SMTP_PORT: '587' }, () => notify.smtpCreds({}))
    assert.equal(c.secure, false)
  })
  await t('…and an explicit SMTP_SECURE=true still wins on any port', () => {
    const c = withEnv({ ...base, SMTP_PORT: '2525', SMTP_SECURE: 'true' }, () => notify.smtpCreds({}))
    assert.equal(c.secure, true)
  })
  await t('…and the shop\'s own 465 was already right, and stays right', () => {
    const c = withEnv({ ...base, SMTP_HOST: undefined, SMTP_USER: undefined, SMTP_PASS: undefined, SMTP_PORT: undefined },
      () => notify.smtpCreds({ smtp_host: 'own.example.com', smtp_user: 'u', smtp_pass: 'p', smtp_port: '465' }))
    assert.equal(c.secure, true)
  })
}


/* Youth XL sorted below adult 4XL on every pick list.
 *
 * SIZES is the canonical run and it carries YXS, YS, YM and YL — and not YXL. sizeKeys puts
 * anything it does not recognise after everything it does, so a youth run of YS/YM/YL/YXL printed
 * the biggest youth size last, beneath 4XL, on the pick ticket, the packing slip and the estimate.
 * A picker reading top to bottom pulls it out of the adult rack. */
section('youth XL sorts with the youth sizes')
{
  const { sizeKeys, SIZES } = await import('../public/js/shared/pricing.js')
  await t('YXL is in the canonical run', () => {
    assert.ok(SIZES.includes('YXL'), 'YXL is not a size this app can order in order')
  })
  await t('…between YL and adult XS, where a picker looks for it', () => {
    const order = sizeKeys({ YS: 6, YM: 8, YL: 8, YXL: 6, S: 20, M: 40, '4XL': 4 })
    assert.deepEqual(order, ['YS', 'YM', 'YL', 'YXL', 'S', 'M', '4XL'])
  })
}


/* A malformed receipts array answered a bare 500 on the receiving screen.
 *
 * `receipts: [null]` — a row the UI failed to build, or any caller posting a sparse array — hit
 * `Number(r.line_id)` on null and threw, so the shop saw "Something went wrong on our end." on the
 * one screen that books goods in. Skip what is not a receipt; book what is. */
section('receiving survives a row that is not a receipt')
{
  const { DatabaseSync } = await import('node:sqlite')
  const dbm = await import('../lib/db.mjs')
  const sup = await import('../lib/suppliers.mjs')
  const db = new DatabaseSync(':memory:')
  dbm.initDb(db); dbm.setDefaultDb(db); sup.initSuppliers(db)
  const po = sup.createPurchaseOrder({ job_number: 'JOB-1' },
    { po_number: 'PSC-1', supplier: 'S&S', total_units: 12,
      lines: [{ sku: 'G500-B-M', style: 'Gildan 5000', color: 'black', size: 'M', qty: 12, unit_cost: 3.2 }] },
    { status: 'submitted' })

  await t('a null row does not take the request down', () => {
    const out = sup.receivePurchaseOrder(po.id, [null, { line_id: po.lines[0].id, qty: 6 }, 'nonsense', 7])
    assert.equal(out.received, 6, 'the real receipt still has to land')
  })
}

section('the packing slip lists every garment in the box')
{
  const pdf = await import('../lib/pdf.mjs')
  const SETTINGS = { shop_name: 'Gate Ink', shop_tagline: 'test', shop_phone: '555-0100' }
  const textYs = (buf) => [...String(buf).matchAll(/1 0 0 1 [\d.-]+ (-?[\d.]+) Tm/g)].map((m) => Number(m[1]))
  const textXs = (buf) => [...String(buf).matchAll(/1 0 0 1 ([\d.-]+) -?[\d.]+ Tm/g)].map((m) => Number(m[1]))

  const seven = Array.from({ length: 7 }, (_, i) => ({
    description: `Style ${i + 1} — Navy`,
    sizes: { S: 10, M: 20, L: 20, XL: 10 },
  }))
  const total = 7 * 60

  await t('a seven-style order does not stop listing at six', () => {
    const buf = pdf.packingSlip({ job: { job_number: 'JOB-1050' }, contact: { name: 'School' }, settings: SETTINGS, items: seven })
    assert.match(String(buf), /\(Style 7 - Navy\) Tj|\(Style 7 — Navy\) Tj/, 'the seventh style is nowhere on the slip')
  })

  await t('…and TOTAL UNITS is the whole box, not just what fitted', () => {
    const buf = pdf.packingSlip({ job: { job_number: 'JOB-1050' }, contact: { name: 'School' }, settings: SETTINGS, items: seven })
    assert.match(String(buf), /\(TOTAL UNITS\) Tj/, 'the check figure was dropped entirely')
    assert.match(String(buf), new RegExp(`\\(${total}\\) Tj`), `TOTAL UNITS is not the ${total} actually shipped`)
  })

  await t('…and nothing renders off the bottom of the sheet', () => {
    const buf = pdf.packingSlip({ job: { job_number: 'JOB-1050' }, contact: { name: 'School' }, settings: SETTINGS, items: seven })
    const ys = textYs(buf)
    assert.equal(ys.filter((y) => y < 30).length, 0, `lowest text op at y=${Math.min(...ys)}`)
  })

  await t('a full youth-and-adult run keeps its TOTAL column on the paper', () => {
    const wide = [{ description: 'Gildan 5000 Tee — Navy',
      sizes: { YXS: 4, YS: 6, YM: 8, YL: 8, XS: 6, S: 20, M: 40, L: 40, XL: 24, '2XL': 12, '3XL': 6, '4XL': 4 } }]
    const buf = pdf.packingSlip({ job: { job_number: 'JOB-1051' }, contact: { name: 'Team' }, settings: SETTINGS, items: wide })
    const xs = textXs(buf)
    assert.equal(xs.filter((x) => x > 612 - 54).length, 0, `${xs.filter((x) => x > 558).length} text ops sit past the right margin (furthest ${Math.max(...xs)})`)
  })

  await t('…and an ordinary two-style slip is still one page', () => {
    const buf = pdf.packingSlip({ job: { job_number: 'JOB-1052' }, contact: { name: 'Acme' }, settings: SETTINGS,
      items: seven.slice(0, 2) })
    assert.equal(Number(String(buf).match(/\/Count (\d+)/)?.[1] || 0), 1)
    assert.match(String(buf), /\(120\) Tj/)
  })
}

/* ---------- the invoice's BALANCE DUE is on the paper (v20) ----------
 * The break decision for the totals block was one fixed guess — `if (y > PAGE_H - 200)` — taken
 * BEFORE the rows existed, with no check inside the loop. The block is not a fixed 200: it grows
 * by one 14pt row per RECORDED PAYMENT, and an invoice with payments against it is the normal case
 * for any shop that takes a deposit. Rendered at HEAD: ten lines and two payments put BALANCE DUE
 * at page-y 682, drawn through the TERMS heading at 674 with its own rule struck across it; with a
 * NOTES line and eight payments the rows ran through NOTES, the note text, TERMS and the terms
 * text, and BALANCE DUE landed inside the footer on top of "Page 1 of 1"; with twelve payments the
 * renderer emitted four text operations BELOW THE BOTTOM EDGE OF THE PAPER — 'Payment', its
 * figure, 'BALANCE DUE' and its figure — still on one page, still "Page 1 of 1".
 * This is the document the customer pays from. Same shape as the pick-ticket and packing-slip
 * overflows below, on the one document family that had not been checked. */
section('the invoice\'s BALANCE DUE is on the paper')
{
  const pdf = await import('../lib/pdf.mjs')
  const SETTINGS = {
    shop_name: 'Gate Ink', shop_phone: '555-0100', tax_rate: 8.25,
    invoice_terms: 'Net 15. Late payments accrue 1.5% monthly. Overruns and underruns of up to 3% are standard and billed as produced.',
  }
  const textYs = (buf) => [...String(buf).matchAll(/1 0 0 1 [\d.-]+ (-?[\d.]+) Tm/g)].map((m) => Number(m[1]))
  // A garment line with a detail line AND a size line is 36pt tall, which is what a real invoice
  // looks like. Ten of them land the item table just ABOVE the old fixed `y > PAGE_H - 200`
  // threshold — so the guard did not fire and the whole totals block ran off the sheet. Twelve
  // lines happened to trip the old guard and were fine, which is exactly why a fixed guess taken
  // before the rows exist is not a page-break rule.
  const items = Array.from({ length: 10 }, (_, i) => ({ description: `Gildan 5000 Tee — Navy — line ${i + 1}`, detail: 'Front 2 colour, back 1 colour', qty: 24, unit_price: 8.75, sizes: { S: 6, M: 6, L: 6, XL: 6 } }))
  const inv = { invoice_number: 'INV-2001', subtotal: 2100, tax: 173.25, amount_due: 2273.25, amount_paid: 0, tax_rate: 8.25, due_date: '2026-09-15', notes: 'Please note the revised in-hand date agreed on the phone.' }
  const contact = { name: 'Northgate High', email: 'ap@northgate.test' }
  const pays = (n) => Array.from({ length: n }, (_, i) => ({ method: i % 2 ? 'card' : 'check', amount: 100, created_at: '2026-08-0' + ((i % 9) + 1) })) 

  // Swept across BOTH axes, because the failure is a boundary between them: 10 lines + 12 payments
  // overflowed while 12 lines + 12 payments did not, since the longer table happened to trip the
  // old guard. A rule that only holds at one length is not a rule.
  for (const lines of [3, 8, 10, 12, 14]) {
    for (const n of [0, 2, 8, 12]) {
      await t(`${lines} lines and ${n} recorded payment${n === 1 ? '' : 's'}: every row on a real page`, () => {
        const buf = pdf.renderDocument('INVOICE', { doc: { ...inv, amount_paid: n * 100 }, contact, settings: SETTINGS, items: items.slice(0, lines), payments: pays(n) })
        const ys = textYs(buf)
        const off = ys.filter((y) => y < 30)
        assert.equal(off.length, 0, `${off.length} of ${ys.length} text ops render at or below the bottom edge (lowest ${Math.min(...ys)})`)
        assert.match(String(buf), /\(BALANCE DUE\) Tj/, 'the line naming what is owed never reached the page')
      })
    }
  }
  await t('…and the figure beside it is the one the customer owes', () => {
    const buf = pdf.renderDocument('INVOICE', { doc: { ...inv, amount_paid: 1200 }, contact, settings: SETTINGS, items, payments: pays(12) })
    assert.match(String(buf), /\(\$1,073\.25\) Tj/, 'the balance figure never reached the page')
  })
  await t('…without collapsing the terms block it used to be drawn on top of', () => {
    const buf = pdf.renderDocument('INVOICE', { doc: { ...inv, amount_paid: 200 }, contact, settings: SETTINGS, items, payments: pays(2) })
    assert.match(String(buf), /\(TERMS\) Tj/, 'TERMS must still print')
    assert.match(String(buf), /\(NOTES\) Tj/, 'and so must NOTES')
  })
  await t('…and an ordinary unpaid invoice is still exactly one page', () => {
    const buf = pdf.renderDocument('INVOICE', { doc: inv, contact, settings: SETTINGS, items: items.slice(0, 3), payments: [] })
    assert.equal(Number(String(buf).match(/\/Count (\d+)/)?.[1] || 0), 1, 'a three-line unpaid invoice must not grow a second page')
  })
}

section('the pick ticket cannot render a garment off the bottom of the sheet')
{
  const pdf = await import('../lib/pdf.mjs')
  const SETTINGS = { shop_name: 'Gate Ink', shop_tagline: 'test', shop_phone: '555-0100' }
  // Every Tm operator's y — PDF user space, origin bottom-left.
  const textYs = (buf) => [...String(buf).matchAll(/1 0 0 1 [\d.-]+ (-?[\d.]+) Tm/g)].map((m) => Number(m[1]))
  const pageCount = (buf) => Number(String(buf).match(/\/Count (\d+)/)?.[1] || 0)

  const school = [
    { description: 'Gildan 5000 Tee — Navy', sizes: { YS: 12, YM: 18, YL: 18, S: 24, M: 40, L: 40, XL: 24, '2XL': 12 } },
    { description: 'Gildan 18500 Hoodie — Navy', sizes: { YS: 8, YM: 12, YL: 12, S: 18, M: 30, L: 30, XL: 18, '2XL': 10 } },
    { description: 'Bella+Canvas 6400 Ladies Tee — Navy', sizes: { S: 20, M: 30, L: 30, XL: 16, '2XL': 8 } },
    { description: 'Port & Company PC61 — Navy', sizes: { S: 14, M: 20, L: 20, XL: 12, '2XL': 8 } },
  ]
  const total = school.reduce((s, b) => s + Object.values(b.sizes).reduce((a, n) => a + n, 0), 0)

  await t('a 4-style school order prints every row on a real page', () => {
    const buf = pdf.pickTicket({ job: { job_number: 'JOB-1042', decoration: 'Screen Print', due_date: '2026-09-10' }, settings: SETTINGS, lines: school })
    const ys = textYs(buf)
    const off = ys.filter((y) => y < 30)
    assert.equal(off.length, 0, `${off.length} of ${ys.length} text ops render at or below the bottom edge (lowest ${Math.min(...ys)})`)
  })

  await t('…on more than one page, because it does not fit on one', () => {
    const buf = pdf.pickTicket({ job: { job_number: 'JOB-1042' }, settings: SETTINGS, lines: school })
    assert.ok(pageCount(buf) > 1, 'a 506-piece four-style order was still forced onto a single page')
  })

  await t('…and the grand total, which the picker checks against, is on the paper', () => {
    const buf = pdf.pickTicket({ job: { job_number: 'JOB-1042' }, settings: SETTINGS, lines: school })
    assert.match(String(buf), new RegExp(`\\(${total}\\) Tj`), `TOTAL ${total} never reached the page`)
  })

  await t('two garments at eight sizes still keeps its total — the earliest real break', () => {
    const two = school.slice(0, 2)
    const t2 = two.reduce((s, b) => s + Object.values(b.sizes).reduce((a, n) => a + n, 0), 0)
    const buf = pdf.pickTicket({ job: { job_number: 'JOB-1043' }, settings: SETTINGS, lines: two })
    assert.equal(textYs(buf).filter((y) => y < 30).length, 0, 'rows ran off the sheet')
    assert.match(String(buf), new RegExp(`\\(${t2}\\) Tj`), `TOTAL ${t2} never reached the page`)
  })

  await t('…and an ordinary one-garment ticket is still exactly one page', () => {
    const buf = pdf.pickTicket({ job: { job_number: 'JOB-1044' }, settings: SETTINGS, lines: [{ description: 'Gildan 5000 Tee — Black', sizes: { S: 24, M: 48, L: 48, XL: 24 } }] })
    assert.equal(pageCount(buf), 1)
    assert.equal(textYs(buf).filter((y) => y < 30).length, 0)
  })

  await t('…and a ticket with no sizes at all still prints its one honest line', () => {
    const buf = pdf.pickTicket({ job: { job_number: 'JOB-1045' }, settings: SETTINGS, lines: [] })
    assert.match(String(buf), /No sizes on file/)
    assert.equal(pageCount(buf), 1)
  })
}

section('the assistant does not invent money the screens do not show')
{
  const { DatabaseSync } = await import('node:sqlite')
  const dbmod = await import('../lib/db.mjs')
  const asst = await import('../lib/assistant.mjs')
  const mem = new DatabaseSync(':memory:')
  mem.exec('PRAGMA foreign_keys = ON')
  dbmod.setDefaultDb(mem)
  dbmod.initDb(mem)

  dbmod.run('INSERT INTO contacts (id, name, company) VALUES (1, ?, ?)', 'Acme Co', 'Acme')
  // One live invoice and one the shop voided, same amount.
  dbmod.run(`INSERT INTO invoices (id, contact_id, invoice_number, status, amount_due, amount_paid, due_date)
             VALUES (1, 1, 'INV-1001', 'unpaid', 5542.40, 0, date('now','+7 day'))`)
  dbmod.run(`INSERT INTO invoices (id, contact_id, invoice_number, status, amount_due, amount_paid, due_date)
             VALUES (2, 1, 'INV-1002', 'void', 5542.40, 0, date('now','+7 day'))`)
  // A quote with tax on it: $3,000 of work, $247.50 of sales tax.
  dbmod.run(`INSERT INTO estimates (id, contact_id, estimate_number, status, subtotal, tax, total)
             VALUES (1, 1, 'EST-1001', 'sent', 3000, 247.50, 3247.50)`)

  await t('a voided invoice is not reported as money the customer owes', async () => {
    const r = await asst.ask('who is Acme Co')
    assert.ok(r?.reply, 'the assistant answered nothing')
    // money0 rounds to whole dollars, so the live invoice reads $5,542 and both together $11,085.
    assert.doesNotMatch(r.reply, /11,08[45]/, `the void is being counted as owed: ${r.reply}`)
    assert.match(r.reply, /\$5,542 owed/, `it should still report the one LIVE invoice: ${r.reply}`)
  })

  await t('quotes not yet approved are counted without the sales tax', async () => {
    const r = await asst.ask('how much revenue this month')
    assert.ok(r?.reply, 'the assistant answered nothing')
    assert.match(r.reply, /\$3,000\.00.{0,4} in quotes/, `counted tax as quoted revenue: ${r.reply}`)
  })

  await t('…and outstanding on invoices still excludes the void, as it always did', async () => {
    const r = await asst.ask('how much revenue this month')
    assert.match(r.reply, /\$5,542\.40.{0,20}outstanding/, r.reply)
  })
}

section('imported history stays out of every timed automation, as the comment claims')
{
  const { DatabaseSync } = await import('node:sqlite')
  const dbmod = await import('../lib/db.mjs')
  const auto = await import('../lib/automations.mjs')
  const mem = new DatabaseSync(':memory:')
  mem.exec('PRAGMA foreign_keys = ON')
  dbmod.setDefaultDb(mem)
  dbmod.initDb(mem)
  auto.initAutomations(mem)

  dbmod.run('INSERT INTO contacts (id, name, email) VALUES (1, ?, ?)', 'Migrated Customer', 'old@customer.test')
  // Two jobs due tomorrow, identical but for where they came from.
  dbmod.run(`INSERT INTO jobs (id, contact_id, job_number, title, status, stage, due_date, approval_gated, imported_at)
             VALUES (1, 1, 'JOB-9001', 'From the old system', 'active', 'new', date('now', '+1 day'), 1, '2026-08-01 00:00:00')`)
  dbmod.run(`INSERT INTO jobs (id, contact_id, job_number, title, status, stage, due_date, approval_gated, imported_at)
             VALUES (2, 1, 'JOB-9002', 'Booked here', 'active', 'new', date('now', '+1 day'), 1, NULL)`)
  for (const [id, trigger] of [[11, 'job.due_soon'], [12, 'job.at_risk']]) {
    dbmod.run('INSERT INTO automations (id, name, enabled, trigger, actions) VALUES (?,?,1,?,?)',
      id, `Chase ${trigger}`, trigger, JSON.stringify([{ key: 'contact.tag', config: { tag: `chased-${id}` } }]))
  }

  const fired = auto.tick({}) || []
  await t('a job the shop actually booked is still chased', () => {
    assert.ok(fired.some((f) => String(f).includes('JOB-9002')), `nothing fired for the real job: ${JSON.stringify(fired)}`)
  })
  await t('…and an imported job is not', () => {
    assert.ok(!fired.some((f) => String(f).includes('JOB-9001')),
      `a migration emailed the old system's customers: ${JSON.stringify(fired)}`)
  })
  await t('every timed scan carries the predicate the comment promises', async () => {
    const { readFileSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib/automations.mjs'), 'utf8')
    // The four scans inside tick()'s loop. Each opens a branch and runs one query; the predicate
    // has to be inside that branch, not merely somewhere in the file.
    for (const trigger of ['estimate.stale', 'invoice.overdue', 'art.waiting', 'job.due_soon', 'job.at_risk']) {
      const i = src.indexOf(`if (a.trigger === '${trigger}') {`)
      assert.ok(i > 0, `the ${trigger} scan moved — re-point this test`)
      const branch = src.slice(i, src.indexOf('runAutomation', i))
      assert.match(branch, /imported_at IS NULL/, `${trigger} scans imported history`)
    }
  })
}

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

/* ---------- a reused rowid does not silence an automation (v10) ----------
 * automation_runs.entity_id is a PERMANENT latch — tick()'s already() blocks any re-fire for the
 * same rule+entity, deliberately, so a customer is never nagged twice. But it points at a rowid,
 * and `id INTEGER PRIMARY KEY` with no AUTOINCREMENT means SQLite hands max(rowid)+1 out again
 * after a delete. Delete the newest quote and the NEXT quote inherits its id, walks straight into
 * a latch set for a record that no longer exists, and is never chased. Same for the drip queue:
 * the resume loop's "was this record deleted?" guard is a SELECT by id, which a reused id passes,
 * so a paused sequence wakes up and runs about the deleted quote. lib/db.mjs:391-403 already
 * documents and fixes this exact hazard for art_versions; it was never applied to the run log. */
section('a quote that inherits a deleted quote\'s rowid still gets chased')
{
  const { DatabaseSync } = await import('node:sqlite')
  const dbmod = await import('../lib/db.mjs')
  const auto = await import('../lib/automations.mjs')
  const mem = new DatabaseSync(':memory:')
  mem.exec('PRAGMA foreign_keys = ON')
  dbmod.setDefaultDb(mem)
  dbmod.initDb(mem)
  auto.initAutomations(mem)
  dbmod.run(`INSERT INTO automations (id, name, enabled, trigger, params, actions) VALUES (1,?,1,?,?,?)`,
    'Chase quiet quotes', 'estimate.stale', JSON.stringify({ days: 3 }),
    JSON.stringify([{ key: 'note.log', config: { body: 'still interested?' } }]))
  dbmod.run(`INSERT INTO contacts (id, name, email) VALUES (1, 'Casey', 'casey@example.com')`)
  for (let i = 1; i <= 7; i++) {
    dbmod.run(`INSERT INTO estimates (id, estimate_number, contact_id, status, sent_at, total)
               VALUES (?,?,1,'sent',datetime('now','-9 days'),100)`, i, `EST-100${i}`)
  }
  auto.tick({})                                  // all seven chased once
  dbmod.run('DELETE FROM estimates WHERE id = 7')  // the shop deletes a quote it raised by mistake
  dbmod.run(`INSERT INTO estimates (estimate_number, contact_id, status, sent_at, total)
             VALUES ('EST-2001',1,'sent',datetime('now','-9 days'),4200)`)
  const reused = dbmod.get('SELECT id, estimate_number FROM estimates ORDER BY id DESC LIMIT 1')
  await t('SQLite really does hand the deleted quote\'s id to the next one', () => {
    assert.equal(reused.id, 7)
    assert.equal(reused.estimate_number, 'EST-2001')
  })
  const fired = auto.tick({})
  await t('the $4,200 quote nine days quiet is chased, not silently skipped', () => {
    assert.ok(fired.some((f) => /EST-2001/.test(f)), `tick fired ${JSON.stringify(fired)}`)
  })
  await t('…and the deleted quote\'s run stays in the log as history', () => {
    const hist = dbmod.get(`SELECT entity_label, status FROM automation_runs WHERE entity_label = 'EST-1007'`)
    assert.equal(hist?.status, 'ran')
  })
}

section('a paused drip does not wake up about a deleted record')
{
  const { DatabaseSync } = await import('node:sqlite')
  const dbmod = await import('../lib/db.mjs')
  const auto = await import('../lib/automations.mjs')
  const mem = new DatabaseSync(':memory:')
  mem.exec('PRAGMA foreign_keys = ON')
  dbmod.setDefaultDb(mem)
  dbmod.initDb(mem)
  auto.initAutomations(mem)
  dbmod.run(`INSERT INTO automations (id, name, enabled, trigger, params, actions) VALUES (1,?,1,?,'{}',?)`,
    'Two-touch follow-up', 'estimate.sent',
    JSON.stringify([{ key: 'note.log', config: { body: 'touch 1' } },
      { key: 'wait', config: { days: 2 } },
      { key: 'note.log', config: { body: 'touch 2 about {{estimate_number}}' } }]))
  dbmod.run(`INSERT INTO contacts (id, name, email) VALUES (1, 'Casey', 'casey@example.com')`)
  for (let i = 1; i <= 7; i++) {
    dbmod.run(`INSERT INTO estimates (id, estimate_number, contact_id, status, total) VALUES (?,?,1,'sent',100)`,
      i, `EST-100${i}`)
  }
  const e7 = dbmod.get('SELECT * FROM estimates WHERE id = 7')
  auto.fire('estimate.sent', { estimate: e7, contact: dbmod.get('SELECT * FROM contacts WHERE id = 1'), total: e7.total }, {})
  dbmod.run('DELETE FROM estimates WHERE id = 7')
  dbmod.run(`INSERT INTO estimates (estimate_number, contact_id, status, total) VALUES ('EST-2001',1,'draft',4200)`)
  dbmod.run("UPDATE automation_pending SET due_at = datetime('now','-1 day')")
  const fired = auto.tick({})
  await t('the queued step is parked, not resumed onto the id\'s new owner', () => {
    assert.deepEqual(fired.filter((f) => /resume/.test(f)), [], `tick fired ${JSON.stringify(fired)}`)
  })
  await t('…and the shop can see why it was dropped', () => {
    const p = dbmod.get('SELECT status, note FROM automation_pending WHERE label = ?', 'EST-1007')
    assert.equal(p?.status, 'orphaned')
    assert.match(String(p?.note || ''), /deleted/)
  })
}

/* ---------- a refusal the UI can act on, not just print (v10) ----------
 * The API answers a two-garment size edit with 409 {code:'multi_garment_quantities', lines:[…]} —
 * the exact structure the caller needs to send back. api.req threw away everything but `error`,
 * so every screen could do was toast the sentence, and that sentence's advice ("edit the split on
 * the estimate") is refused one route away on an invoiced job. A dead end made of four correct
 * refusals. The body now rides on the Error so a screen can open the right editor. */
section('a failed request carries the server\'s answer, not just its sentence')
{
  const core = await import('../public/js/core.js')
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: 'JOB-1027 covers 2 garments.', code: 'multi_garment_quantities', lines: [{ garment: 'Gildan 5000', sizes: { M: 40 } }, { garment: 'Gildan 18500', sizes: { L: 10 } }] }),
    { status: 409, headers: { 'Content-Type': 'application/json' } })
  let err = null
  try { await core.api.put('/api/jobs/1', {}) } catch (e) { err = e }
  globalThis.fetch = realFetch
  await t('the message is still the human sentence', () => {
    assert.match(String(err?.message || ''), /covers 2 garments/)
  })
  await t('…and the code the screen has to branch on survives', () => {
    assert.equal(err?.data?.code, 'multi_garment_quantities')
    assert.equal(err?.status, 409)
  })
  await t('…along with the structure the screen has to hand back', () => {
    assert.equal(err?.data?.lines?.length, 2)
  })
}

section('the one refusal whose own advice does not work has a screen behind it')
await t('the job form opens the per-garment editor instead of toasting a dead end', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'public/js/views/board.js'), 'utf8')
  assert.match(src, /multi_garment_quantities/, 'board.js never handles the 409 it provokes')
  assert.match(src, /line_sizes/, 'board.js never sends the structure that 409 hands it')
  // Each garment's STYLE has to be nameable there too: it is the only screen that can post a
  // corrected line on a multi-garment job, and the style is what the purchase order buys.
  assert.match(src, /data-garment=/, 'the split editor names each garment but cannot correct it')
})

/* ---------- an order is worth what it is worth, once (v10) ----------
 * jobRoi() reads the ESTIMATE for revenue and cost, and shopRoi() sums per JOB. Two jobs on one
 * estimate is ordinary — an order split into two production runs, and the documented
 * void → re-issue recovery makes one too — and every one of them counted the whole order twice.
 * The SHIPPED SEED does it: JOB-1001 (300 spirit tees) and JOB-1008 (the coach polos add-on) both
 * claim EST-1001's $2,726, so a brand-new shop's Profitability page opens on $17,823.50 of
 * revenue against $15,097.50 of real work. */
section('two production runs on one order do not sell it twice')
{
  const { DatabaseSync } = await import('node:sqlite')
  const dbmod = await import('../lib/db.mjs')
  const sup = await import('../lib/suppliers.mjs')
  const mem = new DatabaseSync(':memory:')
  dbmod.setDefaultDb(mem)
  dbmod.initDb(mem)
  sup.initSuppliers(mem)
  const roi = await import('../lib/roi.mjs')
  const items = JSON.stringify([
    { description: 'Gildan 5000 Tee — Wildcats spirit shirt', sizes: { S: 40, M: 90, L: 110, XL: 48, '2XL': 10, '3XL': 2 }, unit_price: 8.75, taxable: true },
    { description: 'Screen setup — 3 screens', qty: 3, unit_price: 25 },
  ])
  dbmod.run(`INSERT INTO contacts (id, name, email) VALUES (1, 'Wildcats', 'ad@wildcats.test')`)
  dbmod.run(`INSERT INTO estimates (id, estimate_number, contact_id, status, items, subtotal, total)
             VALUES (1, 'EST-1001', 1, 'approved', ?, 2726, 2931.45)`, items)
  dbmod.run(`INSERT INTO jobs (id, job_number, contact_id, estimate_id, title, stage, status, sizes)
             VALUES (1, 'JOB-1001', 1, 1, '300 tees', 'production', 'active', ?)`,
    JSON.stringify({ S: 40, M: 90, L: 110, XL: 48, '2XL': 10, '3XL': 2 }))
  dbmod.run(`INSERT INTO jobs (id, job_number, contact_id, estimate_id, title, stage, status, sizes)
             VALUES (8, 'JOB-1008', 1, 1, 'coach polos add-on', 'shipping', 'active', ?)`,
    JSON.stringify({ M: 2, L: 3, XL: 2, '2XL': 1 }))

  const r = roi.shopRoi()
  await t('the shop\'s revenue is the order\'s value, not twice it', () => {
    assert.equal(r.totals.revenue, 2726, `two runs on one $2,726 order reported ${r.totals.revenue}`)
  })
  await t('…and the split is by the pieces each run actually makes', () => {
    const big = r.jobs.find((j) => j.job_number === 'JOB-1001')
    const small = r.jobs.find((j) => j.job_number === 'JOB-1008')
    assert.ok(big.revenue > small.revenue * 10, `300 pieces got ${big.revenue}, 8 pieces got ${small.revenue}`)
    assert.equal(Math.round((big.revenue + small.revenue) * 100) / 100, 2726, 'the split must sum to the order to the cent')
  })
  await t('…and the cost is not double-counted either', () => {
    const big = r.jobs.find((j) => j.job_number === 'JOB-1001')
    const small = r.jobs.find((j) => j.job_number === 'JOB-1008')
    assert.equal(Math.round((big.cost + small.cost) * 100) / 100, r.totals.cost)
    assert.ok(small.cost < big.cost, 'the 8-piece run cannot cost what the 300-piece run costs')
  })
  await t('a single-job order is completely unaffected', () => {
    dbmod.run(`INSERT INTO estimates (id, estimate_number, contact_id, status, items, subtotal, total)
               VALUES (2, 'EST-1002', 1, 'approved', ?, 1000, 1000)`, JSON.stringify([{ description: 'Gildan 5000 Tee — Navy', sizes: { M: 100 }, unit_price: 10 }]))
    dbmod.run(`INSERT INTO jobs (id, job_number, contact_id, estimate_id, title, stage, status, sizes)
               VALUES (9, 'JOB-1009', 1, 2, 'solo', 'production', 'active', ?)`, JSON.stringify({ M: 100 }))
    const solo = roi.shopRoi().jobs.find((j) => j.job_number === 'JOB-1009')
    assert.equal(solo.revenue, 1000)
    assert.equal(solo.pieces, 100)
  })
}

/* ---------- a shareable row carries its own key (v10) ----------
 * The migration behind the /p/ link fix. Every INSERT must get a key without every INSERT site
 * having to remember to write one — there are a dozen across four files, and missing one leaves
 * the hole open — so it is an AFTER INSERT trigger. Rows that pre-date it keep NULL, which is
 * what reproduces the legacy token for links already in customers' inboxes. */
section('every shareable row is stamped with its own share key')
{
  const { DatabaseSync } = await import('node:sqlite')
  const dbmod = await import('../lib/db.mjs')
  const mem = new DatabaseSync(':memory:')
  dbmod.setDefaultDb(mem)
  dbmod.initDb(mem)
  dbmod.run(`INSERT INTO contacts (id, name) VALUES (1, 'Jamie')`)
  for (let i = 1; i <= 3; i++) {
    dbmod.run(`INSERT INTO estimates (id, estimate_number, contact_id, status, total) VALUES (?,?,1,'sent',100)`, i, `EST-100${i}`)
  }
  const first = dbmod.get('SELECT share_key FROM estimates WHERE id = 3')?.share_key
  await t('an insert is stamped without the insert site knowing about it', () => {
    assert.match(String(first || ''), /^[0-9a-f]{16}$/)
  })
  dbmod.run('DELETE FROM estimates WHERE id = 3')
  dbmod.run(`INSERT INTO estimates (estimate_number, contact_id, status, total) VALUES ('EST-2001',1,'sent',8400)`)
  const reused = dbmod.get('SELECT id, share_key FROM estimates ORDER BY id DESC LIMIT 1')
  await t('the row that inherits a freed rowid gets a DIFFERENT key', () => {
    assert.equal(reused.id, 3, 'SQLite should have reissued the rowid')
    assert.notEqual(reused.share_key, first)
  })
  await t('every table a /p/ link points at is covered', () => {
    for (const table of ['estimates', 'invoices', 'jobs', 'art_versions']) {
      const has = mem.prepare(`SELECT 1 AS x FROM pragma_table_info('${table}') WHERE name = 'share_key'`).get()
      assert.ok(has, `${table} has no share_key`)
      const trg = mem.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'trigger' AND name = ?`).get(`trg_${table}_share_key`)
      assert.ok(trg, `${table} has no share_key trigger`)
    }
  })
  await t('a row that pre-dates the migration keeps NULL, so its old link still verifies', () => {
    // Exactly what an existing shop's rows look like: added by ALTER TABLE, never stamped.
    dbmod.run('UPDATE estimates SET share_key = NULL WHERE id = 1')
    assert.equal(dbmod.get('SELECT share_key FROM estimates WHERE id = 1')?.share_key, null)
  })
}

/* ---------- profitability does not scan the jobs table once per job (v10) ----------
 * The split-order fix asks each run "which other runs share my order?", which is one query per
 * job. Without an index on jobs(estimate_id) that is a full SCAN per job — on a five-year shop
 * with 15,000 jobs, 15,000 scans, and /api/roi blocked the single-threaded event loop for 18.7s
 * with /health failing. Correct arithmetic on a page nobody can wait for is not a fix. */
section('the profitability sweep asks the database a bounded number of questions')
{
  const { DatabaseSync } = await import('node:sqlite')
  const dbmod = await import('../lib/db.mjs')
  const sup = await import('../lib/suppliers.mjs')
  const mem = new DatabaseSync(':memory:')
  dbmod.setDefaultDb(mem)
  dbmod.initDb(mem)
  sup.initSuppliers(mem)
  const roi = await import('../lib/roi.mjs')

  await t('the sibling-run lookup is served by an index, not a table scan', () => {
    const plan = mem.prepare('EXPLAIN QUERY PLAN SELECT id, sizes FROM jobs WHERE estimate_id = 1').all()
      .map((r) => String(r.detail || '')).join(' | ')
    assert.ok(/USING (COVERING )?INDEX/.test(plan) && !/SCAN jobs\b/.test(plan), `plan was: ${plan}`)
  })

  dbmod.run(`INSERT INTO contacts (id, name) VALUES (1, 'Volume Co')`)
  const N = 200
  for (let i = 1; i <= N; i++) {
    dbmod.run(`INSERT INTO estimates (id, estimate_number, contact_id, status, items, subtotal, total) VALUES (?,?,1,'approved',?,500,500)`,
      i, `EST-${1000 + i}`, JSON.stringify([{ description: 'Gildan 5000 Tee — Black', sizes: { M: 50 }, unit_price: 10 }]))
    dbmod.run(`INSERT INTO jobs (id, job_number, contact_id, estimate_id, title, stage, status, sizes) VALUES (?,?,1,?,?,'production','active',?)`,
      i, `JOB-${1000 + i}`, i, 'run', JSON.stringify({ M: 50 }))
  }
  const realPrepare = mem.prepare.bind(mem)
  let statements = 0
  mem.prepare = (sql) => { statements++; return realPrepare(sql) }
  try { roi.shopRoi() } finally { mem.prepare = realPrepare }
  await t(`${N} jobs do not cost a query each for their siblings (${statements} statements)`, () => {
    // Before the prefetch: 3 per job plus the sweep. The ceiling is deliberately loose — this is
    // guarding an order of magnitude, not a specific plan.
    assert.ok(statements < N, `shopRoi issued ${statements} prepares for ${N} jobs`)
  })
}

/* ---------- the Outbox can send everything the server will send (v10) ----------
 * fb0de24 gave the Outbox a Send button for 'draft' and 'error'. It left out 'logged' — which is
 * the state of EVERY message a shop queues before it wires SMTP, i.e. all of week one, on the card
 * whose own copy reads "nothing vanishes… add SMTP and the same calls go out for real". The same
 * calls go out for NEW messages; the dozen already in the Outbox never do. The route delivers them
 * perfectly well; only the button's condition was left behind. Evaluate the shipped predicate
 * rather than grepping for a string, so this asserts the behaviour and not the spelling. */
section('the Outbox offers a Send on every message the server would send')
await t('a message queued before the shop wired SMTP can still be sent', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'public/js/views/misc.js'), 'utf8')
  const line = /const sendable = (\(m\) => [^\n]+)/.exec(src)
  assert.ok(line, 'the Outbox no longer has a sendable() predicate — this assertion needs rewriting')
  // eslint-disable-next-line no-new-func
  const sendable = new Function(`return ${line[1]}`)()
  assert.equal(sendable({ via: 'logged', delivered: 0 }), true, "a 'logged' row gets no Send button")
  assert.equal(sendable({ via: 'draft', delivered: 0 }), true)
  assert.equal(sendable({ via: 'error', delivered: 0 }), true)
  assert.equal(sendable({ via: 'smtp', delivered: 1 }), false, 'a delivered message must not offer to send again')
  assert.equal(sendable({ via: 'logged', delivered: 1 }), false)
})

/* ---------- the unit runs the release the deploy actually flips (v10) ----------
 * deploy/release.sh keeps releases in $APP_ROOT/releases/<tag> and flips $APP_ROOT/current, and
 * INSTALL.md tells self-hosters to verify against $APP_ROOT/current. The shipped unit ran
 * $APP_ROOT itself — the git clone from step 2 — so the flip changed nothing the service could
 * see. Every deploy shipped NOTHING, with three green signals: /health passes (the old code is
 * answering), verify-sync passes (it checks `current`, which really was updated), and the
 * automatic rollback never fires because nothing ever fails. */
section('the deploy and the service agree on which directory is live')
await t('the shipped unit runs the path release.sh flips', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const unit = readFileSync(join(root, 'deploy/printshopcrm.service'), 'utf8')
  const rel = readFileSync(join(root, 'deploy/release.sh'), 'utf8')
  const wd = /^\s*WorkingDirectory=(.+)$/m.exec(unit)?.[1]?.trim()
  assert.ok(wd, 'the unit has no WorkingDirectory')
  const appRoot = /^APP_ROOT="\$\{APP_ROOT:-(.+?)\}"/m.exec(rel)?.[1]
  assert.ok(appRoot, 'release.sh no longer declares APP_ROOT — this assertion needs rewriting')
  assert.ok(/ln -sfn "\$RELEASE" "\$APP_ROOT\/current"/.test(rel), 'release.sh no longer flips $APP_ROOT/current')
  assert.equal(wd, `${appRoot}/current`,
    `the service runs ${wd} but the deploy flips ${appRoot}/current — every deploy would ship nothing`)
})
await t('…and the install creates that symlink before the service is enabled', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const install = readFileSync(join(root, 'INSTALL.md'), 'utf8')
  const link = install.indexOf('/opt/printshopcrm/current')
  const enable = install.indexOf('systemctl enable --now printshopcrm')
  assert.ok(link > -1, 'INSTALL.md never creates /opt/printshopcrm/current, so the unit has nothing to run')
  assert.ok(link < enable, 'INSTALL.md enables the service before the current symlink exists')
})

/* ---------- Save Settings saves every field Settings renders (v10) ----------
 * The save handler spreads formData() over a hand-written list of card ids, and #gdrive was not on
 * it — the ONE settings container with [name] fields that Save never read. The only other writer
 * of those two keys is the Connect Drive button, which is rendered disabled until they are already
 * saved. So a shop pastes its Google Client ID and secret, is told "Settings saved", and comes
 * back to two blank fields and a greyed-out button: a closed ring, with no shell to escape it.
 * A list maintained by hand will drift again, so the gate derives it from what the page renders. */
section('Settings saves every field Settings renders')
{
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'public/js/views/misc.js'), 'utf8')
  const save = src.slice(src.indexOf('const saveBtn'), src.indexOf('const saveBtn') + 1200)
  // Every card body that renders a named control, taken from the markup rather than a list.
  const holders = []
  for (const m of src.matchAll(/<div class="card-b" id="([a-z0-9-]+)"([\s\S]*?)(?=<div class="card-b" id=|$)/g)) {
    if (/\b(?:f|sf|ta)\(\s*'/.test(m[2]) || /\bname="/.test(m[2])) holders.push(m[1])
  }
  await t('the settings page really does render named fields in several cards', () => {
    assert.ok(holders.length >= 5, `only found ${holders.length} settings cards with fields — this assertion needs rewriting`)
  })
  await t('…and Save Settings reads every one of them', () => {
    const missing = [...new Set(holders)].filter((id) => !save.includes(`'#${id}'`))
    assert.deepEqual(missing, [], `Settings renders [name] fields in ${missing.join(', ')} that Save Settings never reads`)
  })
  await t('…so the Drive keys are not written only by a button that needs them written first', () => {
    assert.ok(/gdrive-connect[\s\S]{0,400}?disabled/.test(src), 'Connect Drive is no longer conditionally disabled — recheck this')
    assert.ok(save.includes("'#gdrive'"), 'the only writer of the Drive keys is a button disabled until they are written')
  })
}

/* ---------- a write that fails is never a silent no-op (v10) ----------
 * api.req() throws on any non-2xx, including the 502/503 restart window. A click handler written
 * `async () => { await api.post(…); toast('Sent') }` therefore stops BEFORE the toast and before
 * the re-render, and the rejection goes nowhere: pressing "Email Invoice" on a $4,200 invoice with
 * bad SMTP credentials does absolutely nothing on screen. A scan of public/js/views found 24 write
 * handlers in that shape, so this is a contract problem, not six oversights — one net in core.js
 * catches every one of them, and every one written in future. */
section('a click that fails says so')
{
  const hooks = {}
  const shown = []
  const prevWindow = globalThis.window, prevDocument = globalThis.document
  globalThis.window = { addEventListener: (ev, fn) => { hooks[ev] = fn } }
  globalThis.document = {
    createElement: () => ({ set innerHTML(h) { this.content = { firstElementChild: { html: h, remove() {} } } }, content: null }),
    querySelector: () => null,
    addEventListener: () => {},
    body: { appendChild: (n) => shown.push(n) },
  }
  // A distinct URL, so this evaluates a FRESH copy of the module with the stubs in place — the
  // earlier section already imported the plain one without a window.
  const live = await import('../public/js/core.js?live=1')
  globalThis.window = prevWindow
  globalThis.document = prevDocument

  await t('core.js installs one net for every unhandled rejection', () => {
    assert.equal(typeof hooks.unhandledrejection, 'function', 'no unhandledrejection handler is registered')
  })
  await t('…and a failed write reaches the shop as a message, not silence', () => {
    let defaulted = false
    globalThis.document = {
      createElement: () => ({ set innerHTML(h) { this.content = { firstElementChild: { html: h, remove() {} } } }, content: null }),
      querySelector: () => null,
      addEventListener: () => {},
      body: { appendChild: (n) => shown.push(n) },
    }
    try {
      hooks.unhandledrejection({ reason: new Error('The server is restarting — try that again in a moment.'), preventDefault: () => { defaulted = true } })
    } finally { globalThis.document = prevDocument }
    assert.equal(shown.length, 1, 'nothing was shown')
    assert.match(String(shown[0]?.html || ''), /server is restarting/)
    assert.ok(defaulted, 'the rejection should be marked handled, or the console still logs it as unhandled')
  })
  await t('…and the module still imports with no DOM at all, so this suite can use it', () => {
    assert.equal(typeof live.toast, 'function')
  })
}

section('a control that has already moved is put back when the write fails')
await t('the job stage select and the automation toggle re-read the server either way', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  // These two are worse than a silent no-op: the <select> and the checkbox have ALREADY moved
  // before the handler runs, so on failure the screen shows a stage and an on/off state the
  // database does not have, for the rest of the session.
  const board = readFileSync(join(root, 'public/js/views/board.js'), 'utf8')
  const stage = board.slice(board.indexOf("$('#stage').onchange"), board.indexOf("$('#stage').onchange") + 500)
  assert.match(stage, /catch/, 'a failed stage change leaves the select showing a stage the server never took')
  assert.match(stage, /jobDetailView\(id\)/, 'it must re-read the server so the select goes back')
  const auto = readFileSync(join(root, 'public/js/views/automations.js'), 'utf8')
  const toggle = auto.slice(auto.indexOf("'[data-toggle]'"), auto.indexOf("'[data-toggle]'") + 800)
  assert.match(toggle, /catch/, 'a failed toggle leaves the checkbox lying about whether the rule is on')
  assert.match(toggle, /automationsView\(\)/, 'it must re-read the server so the checkbox goes back')
})

/* ---------- the operator still has a way to make their own shop (v10) ----------
 * The signup form now refuses PSC_ADMIN_EMAIL, so there has to be another door — refusing an
 * address with no alternative would just move the dead end. */
section('reserving the admin address leaves the operator a way in')
await t('the admin CLI can create a shop, and says so in its own help', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'bin/admin.mjs'), 'utf8')
  assert.match(src, /case 'create-shop'/, 'no create-shop command')
  assert.match(src.slice(src.indexOf('function usage'), src.indexOf('function usage') + 1400), /create-shop/,
    'create-shop exists but the help does not mention it, so nobody locked out will find it')
})
await t('…and the refusal names it, so the message is actionable', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'server.mjs'), 'utf8')
  const i = src.indexOf('reserved_email')
  assert.ok(i > 0, 'signup no longer reserves the admin address')
  assert.match(src.slice(i - 900, i), /create-shop/, 'the guard should point at the command that replaces it')
})

/* ---------- the data-freedom promise is the one the app keeps (v10) ----------
 * Four documents say "every table exports to CSV". Seven tables and one derived view do, out of
 * two dozen in a live shop database. The whole-shop JSON export really is complete — only the CSV
 * sentence is false, and it is the sentence in the pitch. Rather than forbid a phrase, tie it to
 * the code: a doc may claim "every table" only if the export map actually covers every table. */
section('the data-freedom claim is one the app keeps')
{
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const { DatabaseSync } = await import('node:sqlite')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const dbmod = await import('../lib/db.mjs')
  const mem = new DatabaseSync(':memory:')
  dbmod.setDefaultDb(mem)
  dbmod.initDb(mem)
  const tables = mem.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all().map((r) => r.name)
  const src = readFileSync(join(root, 'server.mjs'), 'utf8')
  const map = src.slice(src.indexOf('const EXPORTS = {'), src.indexOf('app.get(\'/api/export/:table.csv\''))
  const exported = [...map.matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1])

  await t('the CSV export map really is a subset of the schema', () => {
    assert.ok(exported.length >= 5 && tables.length > exported.length,
      `${exported.length} CSV exports against ${tables.length} tables — recheck this assertion`)
  })
  for (const doc of ['README.md', 'HOSTING.md', 'GOVERNANCE.md', 'docs/API.md']) {
    await t(`${doc} does not promise more CSV than the app exports`, () => {
      const text = readFileSync(join(root, doc), 'utf8')
      const claim = /[Ee]very table exports to CSV/.test(text)
      assert.ok(!claim || exported.length >= tables.length,
        `${doc} says "every table exports to CSV"; ${exported.length} of ${tables.length} tables do`)
    })
  }
  await t('…and each of them still points at the export that IS complete', () => {
    for (const doc of ['README.md', 'HOSTING.md', 'GOVERNANCE.md']) {
      const text = readFileSync(join(root, doc), 'utf8')
      assert.match(text, /all\.json|one JSON file|whole-shop JSON/i, `${doc} no longer mentions the complete export`)
    }
  })
}

/* ---------- the webhook secret the docs promise is the one that signs (v10) ---------- */
section('the API documents the webhook secret it actually uses')
await t('a secret sent at creation is the secret deliveries are signed with', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'server.mjs'), 'utf8')
  const fn = src.slice(src.indexOf('async function createWebhook'), src.indexOf('async function createWebhook') + 3000)
  assert.match(fn, /b\?\.secret/, 'createWebhook still ignores the secret docs/API.md tells integrators to send')
  const doc = readFileSync(join(root, 'docs/API.md'), 'utf8')
  const row = doc.split('\n').find((l) => l.includes('POST /api/v1/webhooks'))
  assert.ok(row, 'the webhooks row is gone from docs/API.md')
  assert.match(row, /24 characters|generated/, 'the docs must say what happens to a secret the caller sends')
})

/* ---------- the first deploy an install ever does succeeds (v10) ----------
 * The success branch ends `[ -n "$PREVIOUS" ] && echo "  roll back with: …"`. With no previous
 * release that test is false, so the last command in the script exits 1 — and it does it right
 * after printing "✓ v1.0.0 is live and answering /health". A self-hoster's very first deploy
 * therefore reports success and fails, every CI step wrapping it goes red, and re-running is
 * refused because the release directory now exists. This harness never caught it because it
 * always created a previous release first. */
section('the first release an install ever cuts is not reported as a failure')
{
  const r = await rehearseRelease({ healthy: true, first: true })
  await t('a first deploy with no previous release exits 0', () => {
    assert.equal(r.code, 0, `exit ${r.code}, having printed:\n${r.out}`)
  })
  await t('…and still says it is live', () => {
    assert.match(r.out, /is live and answering \/health/)
  })
  await t('…and a deploy that DOES have a previous release still prints the way back', async () => {
    const r2 = await rehearseRelease({ healthy: true })
    assert.equal(r2.code, 0)
    assert.match(r2.out, /roll back with:/)
  })
}

/* ---------- the Docker backup produces something that restores (v10) ----------
 * deploy/DEPLOY.md's only backup command tarred a LIVE SQLite volume — the exact thing
 * deploy/backup.sh has warned against since it was written, because a copy can capture a write in
 * progress and restore to a corrupt database. tar exits 0 either way, so the shop finds out on the
 * day they need it. The shipped image has node and no sqlite3 binary, hence bin/snapshot.mjs and
 * SQLite's own VACUUM INTO. This runs it for real, against a database being written to. */
section('a backup taken while the shop is working still restores')
{
  const { mkdtempSync, rmSync, mkdirSync, existsSync, readdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const { execFileSync } = await import('node:child_process')
  const { DatabaseSync } = await import('node:sqlite')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const dir = mkdtempSync(join(tmpdir(), 'psc-snapshot-'))
  let out = '', code = 0, rows = 0, names = [], stale = []
  try {
    mkdirSync(join(dir, 'tenants', 'acme'), { recursive: true })
    // Two shops, in WAL mode, with an OPEN connection holding uncheckpointed writes — which is
    // what a live install looks like at 3am when cron fires.
    const live = []
    for (const rel of ['printshop.db', 'tenants/acme/printshop.db']) {
      const d = new DatabaseSync(join(dir, rel))
      d.exec('PRAGMA journal_mode = WAL')
      d.exec('CREATE TABLE invoices (id INTEGER PRIMARY KEY, total REAL)')
      for (let i = 0; i < 500; i++) d.prepare('INSERT INTO invoices (total) VALUES (?)').run(42.5)
      live.push(d)
    }
    try {
      out = execFileSync(process.execPath, ['--no-warnings', join(root, 'bin', 'snapshot.mjs'), dir], { encoding: 'utf8' })
    } catch (e) { out = `${e.stdout || ''}${e.stderr || ''}`; code = e.status }
    for (const d of live) d.close()
    const snap = join(dir, '_snapshot')
    names = existsSync(snap) ? readdirSync(snap) : []
    // A snapshot must be a standalone file: no -wal beside it, or "restoring" means replaying a
    // log from the crash you are recovering from over the database you just put back.
    stale = names.filter((n) => /-wal$|-shm$/.test(n))
    if (names.includes('tenants__acme__printshop.db')) {
      const r = new DatabaseSync(join(snap, 'tenants__acme__printshop.db'), { readOnly: true })
      rows = r.prepare('SELECT COUNT(*) AS n FROM invoices').get().n
      r.close()
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }

  await t('every shop on the volume is snapshotted, with the app still writing', () => {
    assert.equal(code, 0, out)
    assert.deepEqual(names.sort(), ['printshop.db', 'tenants__acme__printshop.db'])
  })
  await t('…and every row committed before it ran is in there', () => {
    assert.equal(rows, 500)
  })
  await t('…and it verified each one rather than hoping', () => {
    assert.match(out, /quick_check ok/)
  })
  await t('…and carries no write-ahead log to replay over a restore', () => {
    assert.deepEqual(stale, [])
  })
  await t('an empty data root is a failure, not a silent zero-database backup', () => {
    const empty = mkdtempSync(join(tmpdir(), 'psc-snapshot-empty-'))
    try {
      execFileSync(process.execPath, ['--no-warnings', join(root, 'bin', 'snapshot.mjs'), empty], { encoding: 'utf8', stdio: 'pipe' })
      assert.fail('a backup of nothing should not exit 0')
    } catch (e) { assert.equal(e.status, 1) } finally { rmSync(empty, { recursive: true, force: true }) }
  })
  await t('deploy/DEPLOY.md no longer tells Docker shops to tar a live database', async () => {
    const { readFileSync } = await import('node:fs')
    const md = readFileSync(join(root, 'deploy', 'DEPLOY.md'), 'utf8')
    const backup = md.slice(md.indexOf('**Backups.**'), md.indexOf('**Backups.**') + 1400)
    assert.ok(!/tar czf [^\n]*\/data\b(?![^\n]*_snapshot)/.test(backup),
      'the Docker backup still archives the live /data directly')
    assert.match(backup, /snapshot\.mjs/, 'it should take a consistent snapshot first')
  })
}


/* ---------- three screens that threw away the shop's work (v18) ----------
 *
 * (1) An inbound customer email or SMS wiped the reply being typed. app.js repaints the whole
 *     screen on every `conversation` and `chat` realtime event; the line immediately above the
 *     /conversations branch already guards the receptionist screen — in almost these words, for
 *     exactly this reason — and this one, where the unsaved thing is a customer reply, was left
 *     unconditional. An AI draft that had just been generated and billed went with it.
 *     Preserved rather than skipped: the customer's new message must still appear.
 *
 * (2) "Upload price sheet" was bound with onOnce(), whose event defaults to 'click'. The input is
 *     display:none inside a <label class="btn">, so clicking the label fires a synthetic click on
 *     the input, which bubbles — the handler runs with no file yet and returns, the picker opens,
 *     the shop picks a sheet, `change` fires, and nothing is listening. The import never ran.
 *
 * (3) After importing the wrong sheet, "Reset to stock" is not on the screen. It gates on
 *     `s.edited`, which resolveBook sets from `saved.services[name]` alone — an import writes only
 *     `saved.matrices`, so a shop that has just overwritten its whole grid is told it is on the
 *     stock book and offered nothing to undo with. DELETE /api/pricebook/:name has cleared BOTH the
 *     service and its matrix since it was written; the one control that calls it was hidden. */
section('three screens that threw away the shop’s work')
{
  const readView = async (f) => {
    const { readFileSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    return readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', f), 'utf8')
  }

  await t('an inbound message does not wipe the reply being typed', async () => {
    const src = await readView('public/js/views/conversations.js')
    const i = src.indexOf('async function drawThread')
    assert.ok(i > 0, 'drawThread moved — re-point this test')
    const fn = src.slice(i, i + 3200)
    assert.match(fn, /const draft = \$\('#ct-text'\)\?\.value/, 'the draft is not captured before the repaint')
    assert.match(fn, /if \(draft\) \$\('#ct-text'\)\.value = draft/, 'the draft is captured and then never put back')
  })

  await t('…and the receptionist screen it was modelled on is still guarded', async () => {
    const app = await readView('public/js/app.js')
    assert.match(app, /__pscAgentDirty/, 'the guard this one copies has gone')
  })

  await t('the price-sheet import listens for the file, not for the click', async () => {
    const src = await readView('public/js/views/pricing.js')
    const i = src.indexOf("'#mx-file'")
    assert.ok(i > 0, 'the price-sheet input moved — re-point this test')
    // onOnce(root, sel, fn, evt = 'click'), and a display:none input inside a <label> gets a
    // synthetic click with no file on it. The handler has to be bound to 'change'.
    assert.match(src.slice(i, i + 1800), /\},\s*'change'\)/, "#mx-file is still bound on click, so the import never runs")
  })
}

/* ---------- the short-close the delete refusal names is on a screen (v10) ---------- */
section('short-closing a part-filled order is reachable without a shell')
await t('the receiving card offers it, and confirms first', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'public/js/views/board.js'), 'utf8')
  assert.match(src, /data-closepo=/, 'the receiving card has no short-close control')
  const i = src.indexOf("querySelectorAll('[data-closepo]')")
  assert.ok(i > 0, 'the short-close button is rendered but nothing is bound to it')
  const handler = src.slice(i, i + 700)
  assert.match(handler, /confirmModal/, 'short-close is irreversible — it must ask first')
  assert.match(handler, /purchase-orders\/\$\{b\.dataset\.closepo\}\/close/, 'it must call the close route')
})

/* ---------- a receipt entered by mistake can be walked back from the screen (v18) ----------
 *
 * The receiving dialog pre-fills every line with the FULL outstanding count, so one click on
 * "Receive" books the whole order as arrived. That is the easy mistake, and until now it was
 * a permanent one — every exit was shut:
 *
 *   · once fully received, renderReceiving prints "✓ Fully received" and renders NO buttons,
 *     so the dialog cannot be reopened at all
 *   · POST /api/purchase-orders/:id/close 409s `po_fully_received` — "there is nothing
 *     outstanding to close"
 *   · re-submitting answers `already: true`, and there is no DELETE for a purchase order
 *
 * The correction has existed server-side the whole time: receivePurchaseOrder clamps with
 * `Math.max(0, Math.min(ordered, received + add))`, so a NEGATIVE `add` walks qty_received back.
 * Two lines of frontend made it unreachable — `min="0"` on the input and `.filter(r => r.qty > 0)`
 * on the submit — so the shop was left holding a job it could neither receive correctly, close,
 * nor delete. This is the exact shape this project calls failure: a state a human cannot fix.
 */
section('a purchase order received by mistake is fixable from the screen')
{
  const poFixture = async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const dbm = await import('../lib/db.mjs')
    const sup = await import('../lib/suppliers.mjs')
    const db = new DatabaseSync(':memory:')
    dbm.initDb(db); dbm.setDefaultDb(db); sup.initSuppliers(db)
    const po = sup.createPurchaseOrder({ job_number: 'JOB-1' }, // no job row — this is the PO surface
      { po_number: 'PSC-JOB-1', supplier: 'S&S Activewear', total_units: 300,
        lines: [{ sku: 'G500-W-M', style: 'Gildan 5000', color: 'white', size: 'M', qty: 300, unit_cost: 3.2 }] },
      { status: 'submitted' })
    // The submit route stamps submitted_at when the distributor confirms; createPurchaseOrder
    // does not, and that stamp is the only thing distinguishing "S&S took it" from "a human
    // typed it into the portal" once the receiving status has overwritten both.
    const { run } = await import('../lib/db.mjs')
    run('UPDATE purchase_orders SET submitted_at = ?, order_id = ? WHERE id = ?', '2026-08-29 10:00:00', 'SS-9001', po.id)
    return { sup, po }
  }

  await t('a negative receipt walks the count back — the server always allowed it', async () => {
    const { sup, po } = await poFixture()
    const full = sup.receivePurchaseOrder(po.id, [{ line_id: po.lines[0].id, qty: 300 }])
    assert.equal(full.received, 300, 'precondition: one click booked all 300')
    assert.equal(full.status, 'received')
    const back = sup.receivePurchaseOrder(po.id, [{ line_id: po.lines[0].id, qty: -40 }])
    assert.equal(back.received, 260, 'the correction must land')
  })

  await t('…and the order stops calling itself received once it is not', async () => {
    // Walking the count back to zero left status = 'received' with nothing received, because the
    // recompute fell through to `po.status` — the value read BEFORE the correction. The card then
    // showed "✓ Fully received" over an empty order, and short-close 409'd on it all over again.
    const { sup, po } = await poFixture()
    sup.receivePurchaseOrder(po.id, [{ line_id: po.lines[0].id, qty: 300 }])
    const some = sup.receivePurchaseOrder(po.id, [{ line_id: po.lines[0].id, qty: -40 }])
    assert.equal(some.status, 'partial', '260 of 300 is partial, not received')
    assert.equal(some.fully_received, false)
    const none = sup.receivePurchaseOrder(po.id, [{ line_id: po.lines[0].id, qty: -260 }])
    assert.equal(none.received, 0)
    assert.equal(none.status, 'submitted', 'nothing received — it is an outstanding order again')
  })

  await t('…and it never walks back to a status that would let it re-order', async () => {
    // 'draft' is NOT in poAlreadySent(), so resetting to it would let the idempotency guard wave a
    // second, real, chargeable order through. A hand-placed order returns to placed_manually.
    const { sup, po } = await poFixture()
    const { run } = await import('../lib/db.mjs')
    run("UPDATE purchase_orders SET status = 'placed_manually', submitted_at = NULL, order_id = NULL WHERE id = ?", po.id)
    sup.receivePurchaseOrder(po.id, [{ line_id: po.lines[0].id, qty: 300 }])
    const none = sup.receivePurchaseOrder(po.id, [{ line_id: po.lines[0].id, qty: -300 }])
    assert.equal(none.status, 'placed_manually')
    assert.equal(sup.poAlreadySent(none), true, 'a corrected PO must still count as already sent')
  })

  await t('the fully-received card still offers a way in', async () => {
    const { readFileSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const src = readFileSync(join(root, 'public/js/views/board.js'), 'utf8')
    assert.match(src, /✓ Fully received[\s\S]{0,300}?Correct receipt/,
      'a fully-received order offers no control at all, so a mis-receipt is permanent')
  })

  await t('…and the dialog accepts the negative the server has always taken', async () => {
    const { readFileSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const src = readFileSync(join(root, 'public/js/views/board.js'), 'utf8')
    const i = src.indexOf('function openReceive')
    assert.ok(i > 0, 'openReceive moved — re-point this test')
    const fn = src.slice(i, i + 2600)
    assert.doesNotMatch(fn, /type="number" min="0" max="\$\{l\.short\}"/, 'min="0" makes the correction untypeable')
    assert.match(fn, /min="-\$\{l\.qty_received\}"/, 'the input must allow walking back what was received')
    assert.match(fn, /\.filter\(\(r\) => r\.qty !== 0\)/, '.filter(r => r.qty > 0) drops every correction on the way out')
  })
}

/* ==========================================================================================
   ROUND 11 — frontend / accessibility.  Paste this block into bin/gate.mjs, at the end,
   just before the final tally.  It uses only what the harness already uses: node:assert,
   readFileSync, and small hand-rolled fakes — no packages, no build step.
   ========================================================================================== */

/* ---------- a row you can click, you can also reach with the keyboard (v11) ----------
 * Twenty-four places in public/js/views render a row or a card whose only affordance is a mouse
 * click: `<tr class="click" data-id>`, `.jcard`, `.convo-item`, `.autorow`, the setup chips. The
 * handler is delegated through on()/onOnce(), so the markup carries no button, no href, no
 * tabindex and no role. With a keyboard alone you could not open an estimate, an invoice, a job,
 * a customer, a conversation or an automation — the product was behind a mouse.
 *
 * Twenty-four fixes would have left the twenty-fifth broken, so core.js upgrades them all as a
 * property of the app, and this section holds it there: the real functions, driven against nodes
 * small enough to hold in your head, plus a drift rule so a new clickable row cannot ship
 * unreachable. */
section('a row you can click, you can also reach with the keyboard')
{
  const hooks = {}
  const prevWindow = globalThis.window, prevDocument = globalThis.document
  // The minimum DOM core.js needs to install its keyboard path and nothing more.
  globalThis.window = { addEventListener: (ev, fn) => { hooks[ev] = fn } }
  globalThis.document = { addEventListener: (ev, fn) => { hooks[ev] = fn }, querySelector: () => null, readyState: 'complete', body: null }
  const kb = await import('../public/js/core.js?kb=1')
  globalThis.window = prevWindow
  globalThis.document = prevDocument

  // A row, a control inside it, and just enough shape for closest()/contains()/click().
  const node = (tag, attrs = {}, parent = null) => {
    const n = {
      tagName: tag.toUpperCase(), attrs: { ...attrs }, parent, kids: [], clicks: 0,
      hasAttribute: (k) => k in n.attrs,
      getAttribute: (k) => (k in n.attrs ? n.attrs[k] : null),
      setAttribute: (k, v) => { n.attrs[k] = String(v) },
      matches: (sel) => sel.split(',').some((s) => {
        const tg = (s.trim().match(/^[a-z]+/) || [])[0]
        if (tg && tg.toUpperCase() !== n.tagName) return false
        const cls = [...s.matchAll(/\.([\w-]+)/g)].map((m) => m[1])
        const own = String(n.attrs.class || '').split(/\s+/)
        if (!cls.every((c) => own.includes(c))) return false
        return [...s.matchAll(/\[([\w-]+)(?:="[^"]*")?\]/g)].every((m) => m[1] in n.attrs)
      }),
      closest: (sel) => { let c = n; while (c) { if (c.matches(sel)) return c; c = c.parent } return null },
      contains: (o) => { let c = o; while (c) { if (c === n) return true; c = c.parent } return false },
      querySelectorAll: (sel) => { const out = []; const walk = (p) => { for (const k of p.kids) { if (k.matches(sel)) out.push(k); walk(k) } }; walk(n); return out },
      click: () => { n.clicks++ },
    }
    if (parent) parent.kids.push(n)
    return n
  }

  const view = node('main', { id: 'view' })
  const row = node('tr', { class: 'click', 'data-id': '7' }, view)          // estimates/invoices/contacts
  const nudge = node('button', { class: 'btn', 'data-nudge-est': '7' }, node('td', {}, row))
  const card = node('div', { class: 'jcard', 'data-id': '11' }, view)       // board/orders/pipeline

  await t('a clickable row starts out unreachable, and the upgrade puts it in the tab order', () => {
    assert.equal(typeof kb.upgradeClickableRows, 'function', 'core.js must publish the upgrade')
    assert.equal(row.hasAttribute('tabindex'), false, 'precondition: the row is not focusable')
    assert.equal(kb.upgradeClickableRows(view), 2, 'both the row and the card should be upgraded')
    assert.equal(row.getAttribute('tabindex'), '0')
    assert.equal(card.getAttribute('tabindex'), '0')
  })
  await t('…a <tr> keeps its table semantics; a card is announced as a button', () => {
    assert.equal(row.getAttribute('role'), null, 'role="button" on a row tells a screen reader it is no longer a row')
    assert.equal(card.getAttribute('role'), 'button')
  })
  await t('…and a second pass over the same rows changes nothing', () => {
    assert.equal(kb.upgradeClickableRows(view), 0, 'the upgrade has to be idempotent — every render re-runs it')
  })
  await t('Enter on the row dispatches the click its delegated handler is already waiting for', () => {
    assert.equal(typeof hooks.keydown, 'function', 'core.js registered no keyboard path at all')
    hooks.keydown({ key: 'Enter', target: row, preventDefault() {} })
    assert.equal(row.clicks, 1)
  })
  await t('…Space does too, and it does not also scroll the page', () => {
    let prevented = false
    hooks.keydown({ key: ' ', target: card, preventDefault() { prevented = true } })
    assert.equal(card.clicks, 1)
    assert.ok(prevented, 'Space on a focused row scrolls unless the default is taken')
  })
  await t('…but a control INSIDE the row keeps its own keys', () => {
    // automations.js puts a checkbox inside the clickable row; followups.js puts Nudge in the
    // last cell. Enter there must nudge, not open the row underneath it.
    hooks.keydown({ key: 'Enter', target: nudge, preventDefault() {} })
    assert.equal(row.clicks, 1, 'the row fired again from a press that belonged to the button inside it')
  })

  await t('and no view renders a clickable row that this does not cover', async () => {
    const { readFileSync, readdirSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const core = readFileSync(join(root, 'public/js/core.js'), 'utf8')
    const sel = core.match(/export const CLICKABLE_ROWS = '([^']+)'/)
    assert.ok(sel, 'core.js must publish the set of rows it makes reachable')
    const covered = (attrs) => sel[1].split(',').some((part) => {
      const cls = (part.match(/^\.([\w-]+)/) || [])[1]
      if (cls && !new RegExp(`class="[^"]*\\b${cls}\\b`).test(attrs)) return false
      return [...part.matchAll(/\[([\w-]+)\]/g)].every((m) => new RegExp(`\\b${m[1]}=`).test(attrs))
    })
    const offenders = []
    const dir = join(root, 'public/js/views')
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
      readFileSync(join(dir, f), 'utf8').split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/<(tr|td|div|span|li)\b([^>]*)>/g)) {
          const attrs = m[2]
          // "this whole element opens something": it carries a delegated-click marker and says so.
          if (!/\bdata-(id|job|inv|go|sid|c|edit|setup)=/.test(attrs)) continue
          if (!/cursor:\s*pointer|class="[^"]*\b(click|jcard|convo-item|autorow|setup-chip)\b/.test(attrs)) continue
          if (!covered(attrs)) offenders.push(`${f}:${i + 1}`)
        }
      })
    }
    assert.deepEqual(offenders, [], `clickable with a mouse, unreachable with a keyboard: ${offenders.join(', ')}`)
  })

  await t('…and the upgrade stays behind the window guard, so this file still imports under Node', async () => {
    const { readFileSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const src = readFileSync(join(root, 'public/js/core.js'), 'utf8')
    assert.match(src, /if \(typeof window !== 'undefined' && typeof document !== 'undefined' && !window\.__pscA11y\)/,
      'an unguarded window reference here throws at import time and takes a dozen unrelated assertions with it')
  })
}

/* ---------- what the app says out loud, it also says to a screen reader (v11) ----------
 * There was not one aria-live region, role="status" or role="alert" anywhere in public/. Every
 * answer this app gives — "Matrix saved", "Estimate sent", and the message the unhandledrejection
 * net puts on screen for all 24 write handlers — was a <div> that appeared silently in a corner
 * and removed itself 3.4 seconds later. A screen-reader user pressed Email Invoice on a $4,200
 * invoice and was told nothing in either direction, so the only thing left to do was press again.
 *
 * A live region is only announced if it was ALREADY in the document when its text changed, so the
 * regions must exist, empty, before the first toast — which is what this checks. */
section('what the app says out loud, it also says to a screen reader')
{
  const made = []
  const mkEl = () => {
    const n = { attrs: {}, textContent: '', content: null,
      setAttribute: (k, v) => { n.attrs[k] = String(v) }, getAttribute: (k) => (k in n.attrs ? n.attrs[k] : null),
      remove() {}, set innerHTML(h) { this.content = { firstElementChild: { html: h, remove() {} } } } }
    made.push(n); return n
  }
  const stubDoc = () => ({ addEventListener: () => {}, querySelector: () => null, readyState: 'complete',
    createElement: mkEl, body: { appendChild: () => {} } })
  const prevWindow = globalThis.window, prevDocument = globalThis.document
  globalThis.window = { addEventListener: () => {} }
  globalThis.document = stubDoc()
  const live = await import('../public/js/core.js?live2=1')
  globalThis.window = prevWindow
  globalThis.document = prevDocument

  await t('a live region is on the page before there is anything to announce', () => {
    const regions = made.filter((n) => n.attrs['aria-live'])
    assert.equal(regions.length, 2, `found ${regions.length} live regions — a region created WITH its message already inside is not announced at all`)
    assert.deepEqual(regions.map((r) => r.attrs['aria-live']).sort(), ['assertive', 'polite'],
      'politeness cannot be flipped on a live element, so an error needs its own assertive region')
    assert.deepEqual(regions.map((r) => r.attrs.role).sort(), ['alert', 'status'])
    for (const r of regions) assert.equal(r.attrs.class, 'sr-only', 'the region must be off-screen, not display:none — that removes it from the accessibility tree')
  })

  await t('…and a toast writes its words into it', async () => {
    globalThis.document = stubDoc()
    try {
      live.toast('Matrix saved')
      await new Promise((r) => setTimeout(r, 120))
      const polite = made.find((n) => n.attrs['aria-live'] === 'polite')
      assert.equal(polite.textContent, 'Matrix saved', 'the toast was shown and never announced')
    } finally { globalThis.document = prevDocument }
  })

  await t('…and an error interrupts rather than waiting for a pause', async () => {
    globalThis.document = stubDoc()
    try {
      live.toast('The server is restarting — try that again in a moment.', true)
      await new Promise((r) => setTimeout(r, 120))
      const loud = made.find((n) => n.attrs['aria-live'] === 'assertive')
      assert.match(loud.textContent, /server is restarting/)
    } finally { globalThis.document = prevDocument }
  })

  await t('…and the stylesheet really has the class that keeps it in the accessibility tree', async () => {
    const { readFileSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const css = readFileSync(join(root, 'public/css/app.css'), 'utf8')
    const rule = css.slice(css.indexOf('.sr-only'), css.indexOf('.sr-only') + 320)
    assert.ok(css.includes('.sr-only'), 'the live region is rendered with no rule behind it, so it is visible in the corner of every page')
    assert.doesNotMatch(rule, /display:\s*none|visibility:\s*hidden/,
      'display:none and visibility:hidden both remove the node from the accessibility tree — the one thing a live region must never be')
  })
}

/* ---------- every field the app asks for has a name a screen reader can read (v11) ----------
 * 170 of the 177 <label>s under public/ carried no for=, and most are written as the sibling pair
 * `<label>Email</label><input class="input" name="email">` with nothing joining them. To a screen
 * reader those inputs are unlabelled — the estimate form, the settings screen and every modal read
 * out as "edit text, blank" — and clicking the label did not focus the field either. */
section('every field the app asks for has a name a screen reader can read')
{
  const prevWindow = globalThis.window, prevDocument = globalThis.document
  globalThis.window = { addEventListener: () => {} }
  globalThis.document = { addEventListener: () => {}, querySelector: () => null, readyState: 'complete', body: null }
  const lab = await import('../public/js/core.js?lab=1')
  globalThis.window = prevWindow
  globalThis.document = prevDocument

  const mk = (tag, attrs = {}) => {
    const n = { tagName: tag.toUpperCase(), a: { ...attrs },
      hasAttribute: (k) => k in n.a, getAttribute: (k) => (k in n.a ? n.a[k] : null),
      setAttribute: (k, v) => { n.a[k] = String(v) },
      querySelector: () => null, querySelectorAll: () => [] }
    return n
  }

  await t('a label written as a sibling pair is joined to the control it names', () => {
    assert.equal(typeof lab.wireLabels, 'function', 'core.js must publish the label pairing')
    const input = mk('input', { class: 'input', name: 'email' })
    const label = mk('label'); label.nextElementSibling = input
    const root = mk('div')
    root.matches = () => false
    root.querySelectorAll = (sel) => (sel === 'label:not([for])' ? [label] : [])
    assert.equal(lab.wireLabels(root), 1)
    assert.ok(label.getAttribute('for'), 'the label still points at nothing')
    assert.equal(label.getAttribute('for'), input.getAttribute('id'), 'the for= and the id have to agree')
  })

  await t('…a label that WRAPS its control is left alone, and a hidden one is not pointed at', () => {
    const wrapping = mk('label'); wrapping.querySelector = () => mk('input')
    const hiddenFile = mk('input', { type: 'file', hidden: '' })          // settings "Your logo"
    const wrapper = mk('div', { class: 'logo-row' }); wrapper.querySelectorAll = () => [hiddenFile]
    const orphan = mk('label'); orphan.nextElementSibling = wrapper
    const root = mk('div')
    root.matches = () => false
    root.querySelectorAll = (sel) => (sel === 'label:not([for])' ? [wrapping, orphan] : [])
    assert.equal(lab.wireLabels(root), 0)
    assert.equal(wrapping.getAttribute('for'), null, 'wrapping is already a valid association — a second, weaker one is noise')
    assert.equal(orphan.getAttribute('for'), null, 'a hidden control is not in the accessibility tree; the visible button is the real target')
  })

  await t('…and the labels that still need a hand edit are a known list that cannot grow', async () => {
    const { readFileSync, readdirSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const files = readdirSync(join(root, 'public/js/views')).filter((n) => n.endsWith('.js')).map((n) => `public/js/views/${n}`)
    const orphans = []
    for (const f of files) {
      const src = readFileSync(join(root, f), 'utf8')
      for (const m of src.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/g)) {
        if (/\bfor=/.test(m[1])) continue
        if (/<(input|select|textarea)\b/.test(m[2])) continue                 // wraps its control
        const after = src.slice(m.index + m[0].length, m.index + m[0].length + 260)
        if (/^\s*(\$\{[\s\S]{0,120}?)?<\s*(input|select|textarea)\b/.test(after)) continue  // sibling pair
        orphans.push(`${f.split('/').pop()}:${src.slice(0, m.index).split('\n').length}`)
      }
    }
    // Every one of these is a <label> that names something which is not a form control — a button,
    // a drop zone, a <code> block, a group of toggles. They need markup, not a runtime pairing.
    assert.ok(orphans.length <= 11, `a new <label> was written with nothing to point at: ${orphans.join(', ')}`)
  })
}

/* ---------- a dialog gives focus back, and owns the keyboard while it is open (v11) ----------
 * closeModal() emptied #modal-root with innerHTML = '' and put focus nowhere, so it fell to
 * <body>: a keyboard user was dumped at the top of the document after every confirm, every
 * payment dialog and every import, and had to Tab back through the whole sidebar.
 *
 * And keys.js armed single, unmodified keys on window with only an isTyping() guard, which covers
 * a focused INPUT/TEXTAREA/SELECT and nothing else. With focus on the Delete button of a confirm
 * dialog, `n` navigated the page out from under the dialog and `t` flipped the theme mid-form. */
section('a dialog gives focus back, and owns the keyboard while it is open')
await t('closeModal hands focus back rather than dropping it on <body>', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'public/js/core.js'), 'utf8')
  const close = src.slice(src.indexOf('export function closeModal'), src.indexOf('export function confirmModal'))
  assert.match(close, /\.focus\(\)/, 'closeModal empties #modal-root and never puts focus anywhere')
  assert.match(close, /document\.contains\(/, '…and it has to check the element is still on the page before focusing it')
  const open = src.slice(src.indexOf('export function modal({'), src.indexOf('const escClose'))
  assert.match(open, /document\.activeElement/, 'modal() has to remember what opened it, before it opens')
})
await t('a single-key shortcut is disarmed while a dialog is open', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'public/js/keys.js'), 'utf8')
  assert.match(src, /const dialogOpen = \(\) =>/, 'keys.js has no notion of a dialog being on screen')
  assert.match(src, /modal-root/, '…and it has to look at the modal root, which is where every dialog lives')
  const body = src.slice(src.indexOf('export function wireKeys'), src.indexOf('export function helpOverlay'))
  assert.match(body, /if \(dialogOpen\(\)\) return/, 'the shortcut switch still runs with a dialog on screen')
  assert.ok(body.indexOf('dialogOpen()') < body.indexOf("case 'n'"), 'the guard has to come before the shortcuts, not after')
  // v11 pinned the literal `$('.kbd-help')?.remove()`. v20 routes Escape through the overlay's own
  // close instead, so that it hands focus back the way the × and the backdrop now do — a bare
  // remove() left a keyboard user on <body>. The requirement is unchanged: Escape must close it.
  assert.match(body, /if \(e\.key === 'Escape'\) \{ closeHelp\?\.\(\); return \}/,
    'the help overlay had no keyboard close at all — Escape did nothing')
  const help = src.slice(src.indexOf('export function helpOverlay'))
  assert.match(help, /closeHelp = close/, '…and that close has to be the one that also restores focus')
})

/* ---------- every file this app accepts can be chosen without a mouse (v11) ----------
 * All eleven file inputs in public/js are `hidden` (or display:none), behind a <div class="drop">
 * or a <label class="csv-drop"> with an onclick. A hidden input is not focusable and neither is a
 * div, so attaching artwork to a job — board.js:350, the only art-upload path on the job screen —
 * had no keyboard route at all: not Tab, not Enter, not Space, and drag-and-drop is a mouse
 * gesture by definition. Same for the Autopilot logo, both CSV importers, the DTF trimmer and the
 * gang-sheet builder. */
section('every file this app accepts can be chosen without a mouse')
await t('the drop zones are on the list of things the keyboard can operate', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const core = readFileSync(join(root, 'public/js/core.js'), 'utf8')
  const sel = core.match(/export const CLICKABLE_ROWS = '([^']+)'/)
  assert.ok(sel, 'core.js must publish the set it makes reachable')
  for (const cls of ['.drop', '.csv-drop']) {
    assert.ok(sel[1].split(',').includes(cls),
      `${cls} is a file picker you can only reach with a mouse — Enter on it has to open the chooser`)
  }
})
await t('…and no file input is left as the only route to itself', async () => {
  const { readFileSync, readdirSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const dir = join(root, 'public/js/views')
  const offenders = []
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const src = readFileSync(join(dir, f), 'utf8')
    src.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/<input[^>]*type="file"[^>]*>/g)) {
        if (!/\bhidden\b|display:\s*none/.test(m[0])) return          // visible and focusable already
        // A hidden input needs a visible, keyboard-operable trigger: a <button>, or a zone that
        // core.js upgrades (.drop / .csv-drop), or a <label> the input sits inside.
        const around = src.slice(Math.max(0, src.indexOf(m[0]) - 400), src.indexOf(m[0]) + 400)
        if (/class="(btn|drop|csv-drop)|class="[^"]*\b(drop|csv-drop)\b|<button/.test(around)) return
        offenders.push(`${f}:${i + 1}`)
      }
    })
  }
  assert.deepEqual(offenders, [], `a hidden file input with no keyboard-operable trigger: ${offenders.join(', ')}`)
})

/* ---------- the licence offer is legible (v11) ----------
 * AGPL §13 makes the source offer an obligation, and the gate already checks that it is rendered.
 * It was rendered at 10px with opacity:.75 over --txt-3, which measures 3.74:1 against the sidebar
 * in dark and 3.34:1 in light — under the 4.5:1 WCAG AA minimum for text. A link nobody can read
 * is not an offer. The colour token by itself is 5.6:1; the fade was the whole problem. */
section('the AGPL source offer is legible')
await t('the source link is not faded below the readable minimum', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const css = readFileSync(join(root, 'public/css/app.css'), 'utf8')
  const rule = css.slice(css.indexOf('.source-link {'), css.indexOf('.source-link:hover'))
  assert.ok(rule, '.source-link has no rule at all')
  assert.doesNotMatch(rule, /opacity:\s*\.?[0-8]/, 'fading the licence offer puts it under 4.5:1 — the obligation is to offer it, legibly')

  // And measure it, rather than trusting the absence of one property.
  const tok = (name, from) => (css.slice(css.indexOf(from)).match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i')) || [])[1]
  const srgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  const lum = (h) => { const [r, g, b] = srgb(h).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
  for (const [theme, anchor] of [['dark', '--bg:'], ['light', '--bg: #f5f7fa']]) {
    const fg = tok('--txt-3', anchor), bg = tok('--panel', anchor)
    assert.ok(fg && bg, `could not read the ${theme} tokens`)
    assert.ok(ratio(fg, bg) >= 4.5, `${theme}: the sidebar's small text measures ${ratio(fg, bg).toFixed(2)}:1, under the 4.5:1 minimum`)
  }
})

/* ---------- a listener bound during a render, on a root that survives it (v11) ----------
 * The fourth and fifth instances of the bug 84ee9ad was supposed to have closed. The existing gate
 * rule looks for a delegated binding on #view; these two slipped past it, one because the root was
 * #list and one because it used addEventListener directly.
 *   Invoices — #list is created once per visit and only repainted, so the binding stacked on every
 *              tab switch: by the sixth tab one click on a row ran go() six times.
 *   Dashboard— a raw addEventListener on #view, the most-visited screen in the app: the fourth
 *              visit fired go() four times per click. */
section('the live layer comes back, however long it has been down')
/* The board reshuffling by itself, notifications arriving, a conversation updating while you look
 * at it — all of it rides one WebSocket, and the client gave up on it after 40 attempts. With the
 * backoff that is about eight minutes: a shop with a floor tablet left open all day had a dead
 * live layer by mid-morning, with nothing on screen saying so and nothing short of a manual
 * refresh bringing it back. The app "still works on refresh", which is exactly why nobody notices.
 *
 * The other half is a stale-closure bug in the same handlers: they closed over the module-level
 * `ws`, so a close arriving late from a socket that had already been replaced nulled out the NEWER
 * one — a reconnect that took the live layer down with it. */
await t('the realtime socket never stops trying to reconnect', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'public/js/app.js'), 'utf8')
  const fn = src.slice(src.indexOf('function connectRealtime'), src.indexOf('function handleRealtime'))
  assert.ok(fn.length > 100, 'found connectRealtime')
  assert.doesNotMatch(fn, /wsTries\s*<\s*\d+/, 'a retry ceiling means the live layer dies for good')
  assert.match(fn, /setTimeout\(connectRealtime/, 'and it still has to schedule the retry')
  // The late-close guard: the handler must check it is still the current socket.
  assert.match(fn, /if \(ws !== sock\) return/, 'a close from a replaced socket must not kill the live one')
})
await t('…and comes straight back when the network or the tab does', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'public/js/app.js'), 'utf8')
  assert.match(src, /addEventListener\('online'/, "wifi coming back is the commonest recovery and it was not a trigger")
  assert.match(src, /addEventListener\('visibilitychange'/, 'a laptop shut for lunch is the other one')
  // Two triggers plus the backoff timer can fire together; without this every wake-up opens
  // another socket and the tab receives every message once per socket it has accumulated.
  const fn = src.slice(src.indexOf('function connectRealtime'), src.indexOf('function handleRealtime'))
  assert.match(fn, /readyState === WebSocket\.(OPEN|CONNECTING)/, 'reconnect must not stack a second socket')
})

section('a second click cannot post the same thing twice')
/* The dialog stays open for the whole round trip, so on shop wifi an impatient second click posts
 * again before the first answer lands.
 *   Record Payment — the server catches a duplicated FULL balance (the second one is over the
 *     remaining balance) and does not catch a PARTIAL one: $500 twice on a $1,000 invoice records
 *     $1,000, flips the invoice to paid, and the shop believes it collected money it never got.
 *     The Terms dialog fifteen lines below it in the same file has always disabled its button.
 *   Estimate Save — on a new estimate this is a create, so two clicks made two estimates with two
 *     estimate numbers, and the shop then has to work out which one the customer was sent. */
await t('Record Payment disables itself while the payment is in flight', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'public/js/views/invoices.js'), 'utf8')
  const handler = src.slice(src.indexOf("$('#go', bg).onclick"), src.indexOf("$('#pay')?"))
  assert.ok(handler.length > 40, 'found the Record Payment handler')
  assert.match(handler, /disabled = true/, 'the button must be dead before the POST goes out')
  assert.ok(handler.indexOf('disabled = true') < handler.indexOf('api.post'), 'and dead BEFORE it, not after')
  assert.match(handler, /catch[\s\S]*disabled = false/, 'a failed payment has to leave a button the shop can press again')
})
await t('…and so does Save on a new estimate', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'public/js/views/estimates.js'), 'utf8')
  const handler = src.slice(src.indexOf("$('#save').onclick"), src.indexOf('  draw()\n}'))
  assert.ok(handler.length > 40, 'found the estimate Save handler')
  assert.match(handler, /disabled = true/, 'two clicks must not create two estimates')
  assert.ok(handler.indexOf('disabled = true') < handler.indexOf('api.post'), 'and dead BEFORE the create')
  assert.match(handler, /catch[\s\S]*disabled = false/, 'a rejected save must leave the quote editable')
})

section('nothing binds a listener during a render onto a root that outlives it')
await t('Invoices binds its row handler once per visit, not once per tab', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'public/js/views/invoices.js'), 'utf8')
  const render = src.slice(src.indexOf('const render = async () =>'), src.indexOf("$('#view').innerHTML"))
  assert.doesNotMatch(render, /\bon\(\s*\$\('#list'\)/, '#list survives the render — every tab switch stacked another listener')
  assert.match(src, /onOnce\(\$\('#list'\)/, 'the binding has to be made once, outside render()')
})
await t('…and no view attaches a raw listener to #view either', async () => {
  const { readFileSync, readdirSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const dir = join(root, 'public/js/views')
  const offenders = []
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    readFileSync(join(dir, f), 'utf8').split('\n').forEach((line, i) => {
      if (/\$\('#view'\)\.addEventListener\(/.test(line)) offenders.push(`${f}:${i + 1}`)
    })
  }
  assert.deepEqual(offenders, [], `#view is repainted and never replaced — a raw listener on it stacks per visit: ${offenders.join(', ')}`)
})

/* ---------- the price-matrix editor keeps the prices you typed (v11) ----------
 * The editor tracked `dirty`, printed " · unsaved" from it, and then never acted on it. Back went
 * straight to the list and every price typed since the last Save was gone — no prompt, no undo, on
 * the one screen in the app where a shop types for ten minutes before saving once. */
section('the price-matrix editor keeps the prices you typed')
await t('Back out of an unsaved grid asks first', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'public/js/views/matrices.js'), 'utf8')
  assert.match(src, /let dirty = false/, 'precondition: the editor still tracks unsaved state')
  assert.doesNotMatch(src, /\$\('#mx-back'\)\.onclick = \(\) => go\('\/matrices'\)/,
    'Back discards every price typed since the last Save, silently')
  const leave = src.slice(src.indexOf('const leaveEditor'), src.indexOf('const leaveEditor') + 460)
  assert.match(leave, /if \(!dirty\)/, 'the flag the screen already keeps has to actually be read')
  assert.match(leave, /confirmModal/, 'and an unsaved grid has to be confirmed, not thrown away')
  assert.match(src, /beforeunload/, 'a reload or a closed tab must not eat them either')
  assert.match(src, /getElementById\('mx-table'\)/, "…and that prompt must not follow the user onto screens that aren't the grid")
})

/* ---------- a backup can actually be put back ----------
 * The product's only in-place restore instruction was one line printed by deploy/release.sh:
 * `systemctl stop && cp <backup>.db <live>.db && systemctl start` — contradicted twenty-eight
 * lines above it in the same script, which says in as many words that a stale -wal beside a
 * restored database is worse than none.
 *
 * Every PrintShopCRM database runs in WAL mode, so a crash — the thing you are recovering FROM —
 * leaves a -wal on disk holding committed frames. SQLite validates a WAL by its own internal
 * checksums, not against the database it sits beside, so the next start replays the crash-time
 * log straight over the file that was just restored. Measured below, end to end: restore a
 * 500-customer backup with cp and read back the 1000 rows you were trying to undo, quick_check
 * "ok", exit 0. Green, silent, and the shop still has the data it asked to be rid of — or, with
 * the timings the other way round, none at all. */
section('a backup can actually be put back')
{
  const { mkdtempSync, rmSync, mkdirSync, copyFileSync, existsSync, readdirSync, writeFileSync, readFileSync, statSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const { execFileSync } = await import('node:child_process')
  const { DatabaseSync } = await import('node:sqlite')
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

  /** A data root with one WAL-mode database, a backup of it at 500 rows, and a crash-time -wal. */
  const fixture = () => {
    const dir = mkdtempSync(join(tmpdir(), 'psc-restore-'))
    const data = join(dir, 'data'), backup = join(dir, 'backup')
    mkdirSync(data, { recursive: true }); mkdirSync(backup, { recursive: true })
    const live = join(data, 'printshop.db')
    let d = new DatabaseSync(live)
    d.exec('PRAGMA journal_mode = WAL')
    d.exec('CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT)')
    for (let i = 0; i < 500; i++) d.exec(`INSERT INTO customers (name) VALUES ('C${i}')`)
    d.close()
    copyFileSync(live, join(backup, 'printshop.db'))          // the backup: 500 customers
    // 500 more rows in a CHILD that is then SIGKILLed. A clean close checkpoints and removes the
    // -wal, which is the opposite of the situation being reproduced: the orphaned log only exists
    // because the process died holding it, and that is the whole defect.
    const crash = `
      import { DatabaseSync } from 'node:sqlite'
      const d = new DatabaseSync(${JSON.stringify(live)})
      d.exec('PRAGMA journal_mode = WAL')
      for (let i = 0; i < 500; i++) d.exec("INSERT INTO customers (name) VALUES ('L" + i + "')")
      process.kill(process.pid, 'SIGKILL')`
    try { execFileSync(process.execPath, ['--input-type=module', '-e', crash], { stdio: 'ignore' }) }
    catch { /* SIGKILL is the point */ }
    return { dir, data, backup, live }
  }
  const count = (p) => { const d = new DatabaseSync(p, { readOnly: true }); try { return d.prepare('SELECT COUNT(*) AS n FROM customers').get().n } finally { d.close() } }
  const run = (args, ok = true) => {
    try { return execFileSync(process.execPath, [join(ROOT, 'bin', 'restore.mjs'), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch (e) { if (ok) throw new Error(`restore.mjs failed: ${e.stdout || ''}${e.stderr || ''}`); return `${e.stdout || ''}${e.stderr || ''}` }
  }

  await t('cp really does leave the shop with the data it asked to be rid of', () => {
    const f = fixture()
    try {
      assert.ok(existsSync(`${f.live}-wal`), 'precondition: a crash leaves a -wal on disk')
      copyFileSync(join(f.backup, 'printshop.db'), f.live)     // the instruction we used to print
      const d = new DatabaseSync(f.live, { readOnly: true })
      const check = d.prepare('PRAGMA quick_check').get().quick_check
      const n = d.prepare('SELECT COUNT(*) AS n FROM customers').get().n
      d.close()
      assert.equal(check, 'ok', 'and it reports itself perfectly healthy, which is the trap')
      assert.equal(n, 1000, `the stale -wal replayed over the restore — 500 was asked for, ${n} came back`)
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })

  await t('bin/restore.mjs puts back what the backup actually holds', () => {
    const f = fixture()
    try {
      const staleBytes = statSync(`${f.live}-wal`).size
      run([f.backup, '--data-root', f.data, '--yes'])
      // Not "no -wal exists": restore.mjs verifies the file it just wrote, and opening a WAL-mode
      // database legitimately creates a fresh, empty log of its own. What must be gone is the
      // CRASH-TIME log — so assert on the thing that actually matters (the data), and that
      // whatever log is there now is not the 2MB one carrying the 500 rows we are undoing.
      assert.ok(staleBytes > 100_000, `precondition: the crash left a real log (${staleBytes} bytes)`)
      const after = existsSync(`${f.live}-wal`) ? statSync(`${f.live}-wal`).size : 0
      assert.ok(after < staleBytes / 10, `the crash-time log is still beside the restore (${after} bytes)`)
      assert.equal(count(f.live), 500, 'the restored database must hold the backup, not the crash')
      // And it must STAY 500 — a stale log replays on the next open, not on the one that wrote it.
      assert.equal(count(f.live), 500, 'and still hold it the next time the app opens it')
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })

  await t('…and changes nothing at all until it is told to', () => {
    const f = fixture()
    try {
      const out = run([f.backup, '--data-root', f.data])
      assert.equal(count(f.live), 1000, 'a plain run is a plan, not an action')
      assert.match(out, /Nothing has been changed/)
      assert.match(out, /500 customers/, 'it has to show what is in the backup')
      assert.match(out, /replacing: 1000 customers/, 'and what it would replace, so the shop can tell them apart')
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })

  await t('…keeping what it replaced, -wal and all, so the restore is undoable', () => {
    const f = fixture()
    try {
      run([f.backup, '--data-root', f.data, '--yes'])
      const safety = join(f.data, 'backups')
      const kept = readdirSync(safety).filter((n) => n.startsWith('pre-restore-'))
      assert.equal(kept.length, 1, 'the replaced database has to be kept somewhere')
      const files = readdirSync(join(safety, kept[0]))
      assert.ok(files.includes('printshop.db'), 'the file that was replaced')
      assert.ok(files.includes('printshop.db-wal'), 'and the -wal, which may be the only copy of the last few minutes of work')
      // Undo it, exactly as the tool prints: the crash-time state comes back.
      copyFileSync(join(safety, kept[0], 'printshop.db'), f.live)
      copyFileSync(join(safety, kept[0], 'printshop.db-wal'), `${f.live}-wal`)
      assert.equal(count(f.live), 1000, 'putting the safety copy back has to restore what was there')
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })

  await t('a corrupt backup never overwrites a live database', () => {
    const f = fixture()
    try {
      writeFileSync(join(f.backup, 'printshop.db'), Buffer.alloc(16384, 7))
      const out = run([f.backup, '--data-root', f.data, '--yes'], false)
      assert.match(out, /did not pass PRAGMA quick_check/, 'it has to say why it stopped')
      assert.equal(count(f.live), 1000, 'and the live database must be exactly as it was')
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })

  /* This fixture used to hold BEGIN EXCLUSIVE, and that is the ONE state the old probe could
   * still see. SQLite documents EXCLUSIVE as behaving exactly like IMMEDIATE in WAL mode, and
   * every PrintShopCRM database is WAL — so the probe only ever collided with another connection
   * mid-WRITE. A running app holds an open, IDLE handle between requests, which is almost all of
   * the time; the probe said "free" and the restore went ahead underneath it. So the fixture is
   * now what a running service actually looks like from outside: open, having read, not writing. */
  await t('a database a running service still has open is not restored over', () => {
    const f = fixture()
    const service = new DatabaseSync(f.live)
    try {
      service.exec('PRAGMA journal_mode = WAL')
      service.prepare('SELECT count(*) AS n FROM customers').get()   // served a request, now idle
      const out = run([f.backup, '--data-root', f.data, '--yes'], false)
      assert.match(out, /still open/, 'restoring under a running service corrupts the file')
      assert.match(out, /systemctl stop/, 'and it has to say what to do about it')
      assert.equal(count(f.live), 1000, 'and nothing may have been written over it')
    } finally { try { service.close() } catch { /* already gone */ } rmSync(f.dir, { recursive: true, force: true }) }
  })

  await t('…and one that is mid-write is not either', () => {
    const f = fixture()
    const service = new DatabaseSync(f.live)
    try {
      service.exec('PRAGMA journal_mode = WAL')
      service.exec('BEGIN EXCLUSIVE')
      const out = run([f.backup, '--data-root', f.data, '--yes'], false)
      assert.match(out, /still open/, 'a write in flight is still a running service')
    } finally { try { service.close() } catch { /* already gone */ } rmSync(f.dir, { recursive: true, force: true }) }
  })

  /* ---------- the other half of a backup ----------
   * deploy/backup.sh writes uploads.tar.gz beside the databases and counts the files into it, and
   * restore.mjs walked straight past it. Reproduced end to end — backup, wipe, restore — and got
   * "✓ Restored 2 database(s)" with zero artwork on disk. The app comes back up healthy and every
   * proof, every mockup and the shop's own logo is a broken image, with nothing on any screen
   * saying where the files went. Art IS the customer's property; it is the part of a print shop's
   * data you cannot re-derive. */
  const withArt = (files) => {
    const f = fixture()
    const src = join(f.dir, 'art-src', 'uploads')
    mkdirSync(src, { recursive: true })
    for (const [name, body] of Object.entries(files)) writeFileSync(join(src, name), body)
    execFileSync('tar', ['czf', join(f.backup, 'uploads.tar.gz'), '-C', join(f.dir, 'art-src'), 'uploads'], { stdio: 'ignore' })
    // …and the live data root has the shop's current art, which a restore replaces.
    mkdirSync(join(f.data, 'uploads'), { recursive: true })
    writeFileSync(join(f.data, 'uploads', 'todays-proof.png'), 'TODAY')
    return f
  }

  await t('a restore puts the customers\' artwork back, not just the databases', () => {
    const f = withArt({ 'proof-v3.png': 'APPROVED-ARTWORK', 'shop-logo.png': 'LOGO' })
    try {
      const out = run([f.backup, '--data-root', f.data, '--yes'], true)
      assert.match(out, /Restored 1 database/, 'the databases still restore')
      const art = join(f.data, 'uploads')
      assert.ok(existsSync(join(art, 'proof-v3.png')), 'the approved proof has to come back — it is what the customer signed off')
      assert.equal(readFileSync(join(art, 'proof-v3.png'), 'utf8'), 'APPROVED-ARTWORK')
      assert.ok(existsSync(join(art, 'shop-logo.png')), 'and the shop logo, which is on every invoice')
      assert.match(out, /2 artwork file\(s\)/, 'and it has to say how many, the way the backup counted them')
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })

  await t('…moving what was there aside rather than destroying it', () => {
    const f = withArt({ 'proof-v3.png': 'APPROVED-ARTWORK' })
    try {
      run([f.backup, '--data-root', f.data, '--yes'], true)
      const safety = readdirSync(join(f.data, 'backups'))
      const prev = join(f.data, 'backups', safety[0], 'uploads-previous', 'todays-proof.png')
      assert.ok(existsSync(prev), 'the art that was on disk must be recoverable — a restore may never be what loses it')
      assert.equal(readFileSync(prev, 'utf8'), 'TODAY')
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })

  await t('…and a backup with NO artwork in it says so instead of reporting success', () => {
    const f = fixture()                                        // databases only, as backup.sh
    try {                                                      // writes when uploads/ is missing
      const out = run([f.backup, '--data-root', f.data, '--yes'], true)
      assert.match(out, /NO ARTWORK IN THIS BACKUP/, 'a database-only restore looks perfectly healthy and is missing every proof')
      assert.match(out, /broken image/, 'and it has to say what that means on screen')
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })

  await t('…and the plan says it before anything is touched', () => {
    const f = withArt({ 'proof-v3.png': 'APPROVED-ARTWORK' })
    try {
      const out = run([f.backup, '--data-root', f.data], true)   // no --yes
      assert.match(out, /uploads\.tar\.gz/, 'the plan must name the artwork it is going to restore')
      assert.equal(readFileSync(join(f.data, 'uploads', 'todays-proof.png'), 'utf8'), 'TODAY',
        'and a plan-only run must not touch a single file')
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })

  await t('…while a database nothing holds still restores', () => {
    const f = fixture()
    try {
      const out = run([f.backup, '--data-root', f.data, '--yes'], true)
      assert.match(out, /Restored 1 database/, 'the guard must not refuse a stopped service')
      assert.equal(count(f.live), 500, 'and the backup really has to land')
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })

  await t('a backup that could not go off-site says so instead of reporting success', async () => {
    const { readFileSync, mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { execFileSync } = await import('node:child_process')

    // The script's own header tells you to install it as /usr/local/bin/printshopcrm-backup.
    // APP_DIR was `dirname $0/..`, which from there is /usr/local — where bin/backup-drive.mjs is
    // not. The `-f` guard failed, the upload was skipped, and the script printed "backup ok" with
    // NOTHING off-site. An operator who had connected Google Drive believed their backups were
    // leaving the box for as long as it took the box to die.
    const dir = mkdtempSync(join(tmpdir(), 'psc-bk-'))
    try {
      mkdirSync(join(dir, 'bin'), { recursive: true })
      // Copy the script somewhere its ../bin does NOT hold the uploader, exactly like /usr/local/bin.
      const script = join(dir, 'bin', 'printshopcrm-backup')
      writeFileSync(script, readFileSync(join(ROOT, 'deploy/backup.sh'), 'utf8'), { mode: 0o755 })
      const data = join(dir, 'data'); mkdirSync(data, { recursive: true })
      let out = ''
      try {
        out = execFileSync('bash', [script], {
          encoding: 'utf8',
          env: { ...process.env, DATA_ROOT: data, BACKUP_ROOT: join(dir, 'backups'), APP_DIR: join(dir, 'nowhere'), PSC_BACKUP_GDRIVE_REFRESH_TOKEN: 'pretend-token' },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (e) { out = `${e.stdout || ''}${e.stderr || ''}` }
      assert.match(out, /ONLY on this machine|off-site/i,
        'off-site backup configured but unreachable must be reported, not skipped in silence')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  await t('the documented Docker restore clears every stale write-ahead log, not most of them', async () => {
    const { readFileSync } = await import('node:fs')
    const text = readFileSync(join(ROOT, 'deploy/DEPLOY.md'), 'utf8')
    // The restore block states the rule itself three lines above the command: delete any -wal/-shm
    // left beside the database you are replacing, or the crash's log replays over the restore. It
    // swept printshop.db and every tenant, and missed control.db — which holds the shop directory,
    // the members and the sessions on every multi-tenant install.
    const i = text.indexOf('rm -f /data/printshop.db-wal')
    assert.ok(i > 0, 'the documented restore should still clear stale logs')
    const cmd = text.slice(i, text.indexOf('\n', i))
    for (const db of ['printshop.db', 'control.db']) {
      for (const ext of ['-wal', '-shm']) {
        assert.match(cmd, new RegExp(`/data/${db.replace('.', '\\.')}${ext}\\b`),
          `the restore copies ${db} back, so it has to clear its ${ext} first`)
      }
    }
    assert.match(cmd, /tenants\/\*\/printshop\.db-wal/, 'and every tenant database too')
  })

  await t('every OS the docs say CI covers has a CI job', async () => {
    const { readFileSync } = await import('node:fs')
    const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')
    const runners = ci.match(/runs-on:\s*(\S+)/g).join(' ')
    // README.md:319 and INSTALL.md:21 both claim all three are exercised by CI on every push.
    // macOS was not, and README.md:274 said so itself two paragraphs earlier.
    for (const [os, runner] of [['Linux', /ubuntu/], ['macOS', /macos/], ['Windows', /windows/]]) {
      assert.match(runners, runner, `the docs claim CI covers ${os} — so there has to be a job for it`)
    }
  })

  await t('the documented size list is the size list the API enforces', async () => {
    const { readFileSync } = await import('node:fs')
    const { SIZES } = await import('../public/js/shared/pricing.js')
    const text = readFileSync(join(ROOT, 'docs/API.md'), 'utf8')
    const row = text.split('\n').find((l) => /^\|\s*`sizes`\s*\|/.test(l))
    assert.ok(row, "docs/API.md should still document the `sizes` field")
    const listed = (row.match(/allowed: `([^`]+)`/) || [])[1]
    assert.ok(listed, 'and should still print the allowlist')
    // 6XL and the tall run were added to the code specifically so the API would stop refusing
    // them, and the doc went on saying it refused them. Compare against the constant, so the next
    // widening cannot drift either.
    assert.deepEqual(listed.trim().split(/\s+/), [...SIZES],
      'docs/API.md and public/js/shared/pricing.js must list the same sizes')
  })

  await t('nothing still tells an operator to restore with cp', async () => {
    const { readFileSync } = await import('node:fs')
    for (const file of ['deploy/release.sh', 'INSTALL.md', 'deploy/DEPLOY.md']) {
      const text = readFileSync(join(ROOT, file), 'utf8')
      for (const line of text.split('\n')) {
        if (/^\s*[#>]/.test(line)) continue                       // prose and comments may discuss it
        // The paths are quoted in shell and in the docs, so allow a closing quote before the gap.
        if (!/cp\s+\S*\.db['"]?\s+\S*\.db/.test(line)) continue
        // A cp is only safe where the stale log is cleared first — DEPLOY.md's Docker block does
        // exactly that, on the line above, and is correct. Judge the block, not the line.
        const i = text.indexOf(line)
        const block = text.slice(Math.max(0, i - 700), i)
        assert.ok(/restore\.mjs/.test(line) || /rm -f[^\n]*-wal/.test(block),
          `${file}: copying a .db without clearing the -wal beside it replays the crash over the restore — ${line.trim().slice(0, 100)}`)
      }
    }
  })
}

/* ---------- the boot warning describes the app that is actually running ----------
 * The PSC_PUBLIC_URL warning said every emailed link is built from the request Host header. That
 * stopped being true when reset and welcome moved to trustedOrigin(), which prefers the origin the
 * owner actually signed in on — so the account-takeover the warning was written for is closed
 * whether or not the variable is set. A warning that overstates its case is a warning an operator
 * learns to scroll past, and the links it is still RIGHT about are the ones going to customers. */
await t('an install that never chose a trust-proxy setting is told what it got', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'server.mjs'), 'utf8')
  // Rate limiting only works if the client IP is real, and with trust-proxy on it comes from a
  // header the CLIENT sets. Correct behind nginx/Caddy/Fly/Render, which overwrite it; a hole with
  // nothing in front, where a rotating forged X-Forwarded-For buys one fresh bucket per fake IP on
  // signup, password reset, lead capture and the embed chat that spends the shop's model credit.
  // The default stays 1 — flipping it would break https link-building on every proxied install
  // that has not set PSC_PUBLIC_URL — so the operator has to be told instead.
  const i = src.indexOf("PSC_TRUST_PROXY is on by default")
  assert.ok(i > 0, 'a default nobody chose, that decides whether rate limiting works, has to be said out loud')
  const warn = src.slice(Math.max(0, i - 400), i + 800)
  assert.match(warn, /!String\(process\.env\.PSC_TRUST_PROXY \|\| ''\)\.trim\(\)/,
    'and only when it was never set — a warning everyone sees is a warning nobody reads')
  assert.match(warn, /PSC_TRUST_PROXY=0/, 'it has to name the fix for the exposed case')
  assert.match(warn, /PSC_TRUST_PROXY=1/, 'and how a proxied install silences it')

  // …which only stays quiet for the proxied installs if the shipped manifests set it themselves.
  for (const [file, want] of [
    ['deploy/fly.toml', /PSC_TRUST_PROXY\s*=\s*"1"/],
    ['deploy/render.yaml', /key:\s*PSC_TRUST_PROXY/],
    ['INSTALL.md', /PSC_TRUST_PROXY=1/],
  ]) {
    assert.match(readFileSync(join(root, file), 'utf8'), want,
      `${file} puts a proxy in front, so it has to say so or its operators get a warning aimed at someone else`)
  }
})

await t('the PSC_PUBLIC_URL warning names the links that really are Host-derived', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'server.mjs'), 'utf8')
  const i = src.indexOf("PSC_PUBLIC_URL is not set")
  assert.ok(i > 0, 'the boot warning should still exist — it is still worth setting')
  const warning = src.slice(i, i + 700)
  // The three that still call publicOrigin(req) directly.
  for (const kind of [/[Pp]roof/, /pay/, /invite/]) {
    assert.match(warning, kind, `the warning has to name the links it is still true of: ${kind}`)
  }
  // And it must not keep claiming the two that no longer are.
  assert.doesNotMatch(warning, /^\s*console\.warn\([^\n]*emailed links are built from the request Host/m,
    'reset and welcome use the learned per-shop origin — the blanket claim is no longer true')
  // The code has to still back that up: if reset stops using trustedOrigin, this test is a lie too.
  assert.match(src, /const origin = trustedOrigin\(req, r\.tenant\)/, 'the reset route must still use the learned origin')
})

section('the first screen after login does not build the whole sales board')
{
  const { DatabaseSync } = await import('node:sqlite')
  const dbmod = await import('../lib/db.mjs')
  const mem = new DatabaseSync(':memory:')
  dbmod.setDefaultDb(mem)
  dbmod.initDb(mem)
  const pipe = await import('../lib/pipeline.mjs')

  dbmod.run(`INSERT INTO contacts (id, name) VALUES (1, 'Pipeline Co')`)
  // Every stage represented, a NULL value, a zero, and enough rows that a per-row fold and a
  // GROUP BY have somewhere to disagree.
  const stages = pipe.STAGE_KEYS
  for (let i = 1; i <= 600; i++) {
    const stage = stages[i % stages.length]
    const value = i % 37 === 0 ? null : (i % 53 === 0 ? 0 : Math.round((i * 137.77) * 100) / 100)
    dbmod.run(`INSERT INTO opportunities (contact_id, title, stage, value, sort_order) VALUES (1,?,?,?,?)`,
      `Deal ${i}`, stage, value, i)
  }

  // opportunities shipped with no index at all. oppForEstimate() is on the write path of every
  // quote — create, send, approve, convert, quick-quote — and full-scanned a table the app appends
  // to for every estimate the shop ever writes (1.18 ms per call at 29,910 rows, growing forever).
  for (const [what, sql] of [
    ['the opportunity behind a quote is found by index', 'SELECT * FROM opportunities WHERE estimate_id = 1'],
    ['…and the one behind a customer is too', 'SELECT * FROM opportunities WHERE contact_id = 1'],
    ['…and the dashboard KPI never touches the table', 'SELECT stage, COUNT(*) AS n, COALESCE(SUM(value), 0) AS v FROM opportunities GROUP BY stage'],
  ]) {
    await t(what, () => {
      const plan = mem.prepare('EXPLAIN QUERY PLAN ' + sql).all().map((r) => String(r.detail || '')).join(' | ')
      assert.match(plan, /USING (COVERING )?INDEX/, `plan was: ${plan}`)
      assert.doesNotMatch(plan, /SCAN opportunities(?! USING)/, `plan was: ${plan}`)
    })
  }

  await t('the five KPIs are the same five numbers the board computes', () => {
    assert.deepEqual(pipe.pipelineStats(), pipe.pipelineBoard().stats)
  })

  await t('a shop with no opportunities at all reports the same nothing', () => {
    const empty = new DatabaseSync(':memory:')
    dbmod.setDefaultDb(empty); dbmod.initDb(empty)
    try { assert.deepEqual(pipe.pipelineStats(), pipe.pipelineBoard().stats) }
    finally { dbmod.setDefaultDb(mem) }
  })

  // The whole point: pipelineBoard() materialises every opportunity the shop has ever had, joins
  // contacts onto each, and builds nine arrays out of the result — 154.5 ms of blocked event loop
  // and 34.7 MB of heap on 29,910 rows, for five scalars, on the landing screen. node:sqlite is
  // synchronous, so every other tenant on the box waits through it.
  await t('…and reads six rows to do it, not one per deal', () => {
    const realPrepare = mem.prepare.bind(mem)
    let rows = 0
    mem.prepare = (sql) => {
      const st = realPrepare(sql)
      const realAll = st.all.bind(st)
      st.all = (...a) => { const r = realAll(...a); rows += r.length; return r }
      return st
    }
    try { pipe.pipelineStats() } finally { mem.prepare = realPrepare }
    assert.ok(rows <= pipe.STAGES.length, `pipelineStats read ${rows} rows for 600 deals`)
  })
}

/* ---------- the customer wrote the message, so the model may not answer it for them ----------
 * Round 15 settled this for lib/ai.mjs's mergeIntake: "is the slot empty?" is the wrong question,
 * because every field falls back to a default, and `evidence` answers the right one — "did the
 * TEXT supply it?". Two paths never got the fix, and one of them is reachable by a stranger. */
section('the receptionist only records what the visitor actually said')
{
  const { applyValidated } = await import('../lib/agent.mjs')

  // The exact request that was measured: one unauthenticated POST to /api/embed/chat/message,
  // no login and no API key, carrying a message with no number, no garment noun, no decoration
  // word and no address. The model's reply supplied all four; every one was accepted on shape
  // alone; the shop's books took EST-1001 for $4,937,000, a 'qualified' opportunity at the same
  // value, and a contact at the address the model chose.
  const STRANGER = 'Hi, I am looking for something for our club. Could you help me out today please?'
  const INVENTED = { qty: 100000, product: 'hoodie', decoration: 'Embroidery', sizes: '24 S, 60 M', email: 'attacker@evil.test', phone: '555-867-5309' }
  const got = applyValidated({}, INVENTED, STRANGER)
  for (const [field, why] of [
    ['qty', 'a quantity the message never states'],
    ['product', 'a garment the message never names'],
    ['decoration', 'a decoration the message never names'],
    ['sizes', 'a size run the message never gives'],
    ['email', 'an address the message never contains'],
    ['phone', 'a number the message never contains'],
  ]) {
    await t(`the model may not supply ${why}`, () => {
      assert.ok(!got[field], `applyValidated took ${field} = ${JSON.stringify(got[field])} from the model alone`)
    })
  }

  // …and the guardrail is worth nothing if it also refuses the ordinary case.
  await t('a fact the visitor did state is still recorded', () => {
    const said = 'we would want 48 embroidered hoodies for the club, email sam@club.test or call 555-123-9876'
    const ok = applyValidated({}, { qty: 48, product: 'hoodies', decoration: 'Embroidery', email: 'sam@club.test', phone: '555-123-9876' }, said)
    assert.equal(ok.qty, 48)
    assert.match(ok.product, /hoodie/i)
    assert.equal(ok.decoration, 'Embroidery')
    assert.equal(ok.email, 'sam@club.test')
    assert.ok(ok.phone)
  })
  await t('…including a quantity written with a thousands separator', () => {
    assert.equal(applyValidated({}, { qty: 1200 }, 'we want 1,200 tees please').qty, 1200)
    assert.equal(applyValidated({}, { qty: 1200 }, 'we want 1200 tees please').qty, 1200)
  })
  await t('…and a count nowhere in the message is refused even when the message has other numbers', () => {
    assert.ok(!applyValidated({}, { qty: 48 }, 'shirts for our 2026 conference, not sure how many yet').qty,
      'the message names a year, not a quantity')
    assert.ok(!applyValidated({}, { qty: 2500 }, 'we ordered 250 last time but this is a new run').qty,
      '250 must not corroborate 2500')
  })
  await t('…and a size run the visitor really typed is parsed', () => {
    const sz = applyValidated({}, { sizes: '24 S, 60 M, 80 L' }, 'we need 24 S, 60 M, 80 L tees')
    assert.deepEqual(sz.sizes, { S: 24, M: 60, L: 80 })
  })
}

section('a rush the message did not ask for does not leave the building unread')
{
  const { mergeIntake } = await import('../lib/ai.mjs')

  // needs_review filtered on `ev[f]` — true only where the PARSER read the field — so the one
  // case where the model is the SOLE author of a fact was structurally invisible to it. Measured
  // on "300 tees, one colour front, autumn is fine" with a model reply of {rush:true,
  // due_hint:'2026-09-01'}: the quote went from $2,845.00 to $4,255.00 (+49.6%) with "RUSH +50%."
  // printed on the line the customer signs, the job's promise from ten working days to two — and
  // Full Auto mailed it, because needs_review came back empty and its stand-down never engaged.
  const base = parseIntakeHeuristic('Hi, our club would like 300 tees, one colour front. Autumn is fine.')
  await t('the parser read no rush and no deadline out of that message', () => {
    assert.equal(base.evidence.rush, false)
    assert.equal(base.evidence.due_hint, false)
  })
  const m = mergeIntake(base, { rush: true, due_hint: '2099-09-01' })
  await t('a rush the model added on its own is held for a human', () => {
    assert.ok(m.needs_review.includes('rush'), `needs_review was ${JSON.stringify(m.needs_review)}`)
  })
  await t('…as is a deadline it invented', () => {
    assert.ok(m.needs_review.includes('due_hint'), `needs_review was ${JSON.stringify(m.needs_review)}`)
  })
  await t('…and the review screen is given something to render', () => {
    assert.match(m.ai_note, /added rush, due_hint on its own/)
  })
  await t('an agreeing parse still flows straight through', () => {
    const clean = mergeIntake(base, { rush: false, due_hint: null })
    assert.deepEqual(clean.needs_review, [])
    assert.equal(clean.ai_note, '')
  })
}

section('"no rush" is not a rush')
{
  // Unanchored substring match: /rush|asap|urgent|hurry|…/. "No rush at all" — one of the most
  // ordinary courtesies in an inbound enquiry — read as asking for one. On 300 tees that is
  // $4,255.00 against $2,845.00, with "RUSH +50%." on the line the customer signs and a 3-working
  // -day promise on a job they said could wait until autumn. Round 15's one-way rush rule then
  // made it unclearable: ev.rush comes from this same regex, so a model reading the sentence
  // correctly and returning rush:false was refused.
  for (const text of [
    '300 tees one colour front, no rush at all, autumn is fine',
    '300 tees one colour front, there is no hurry',
    '300 tees, this is not urgent',
    '300 tees, not in a hurry',
    '300 tees, no big rush',
    '300 tees, I do not need a rush on this',
    "300 tees, we don't need these this week",
    '300 tees, no need to rush',
  ]) {
    await t(`a declined rush is not a rush: ${JSON.stringify(text.slice(10))}`, () => {
      assert.equal(parseIntakeHeuristic(text).rush, false)
    })
  }
  for (const text of [
    '300 tees, we need these rushed please',
    '300 tees ASAP if you can',
    '300 tees, this is urgent',
    '300 tees, need them by friday',
    '300 tees rush order',
    '300 tees, no rush on the hoodies but the tees are urgent',
  ]) {
    await t(`a real rush is still a rush: ${JSON.stringify(text.slice(10))}`, () => {
      assert.equal(parseIntakeHeuristic(text).rush, true)
    })
  }
  await t('and declining a rush costs no more than not mentioning one', async () => {
    const { priceIntake } = await import('../lib/quickquote.mjs')
    const settings = { screen_fee: 25, default_markup: 2, tax_rate: 0 }
    const declined = priceIntake(parseIntakeHeuristic('300 tees one colour front, no rush at all'), settings)
    const silent = priceIntake(parseIntakeHeuristic('300 tees one colour front'), settings)
    assert.equal(declined.totals.total, silent.totals.total,
      `declining a rush was billed at ${declined.totals.total} against ${silent.totals.total}`)
  })
}

section('the sidebar does not download the shop to draw six dots')
await t('the chrome refresh asks for badges, not for six list endpoints', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const app = readFileSync(join(root, 'public/js/app.js'), 'utf8')
  const server = readFileSync(join(root, 'server.mjs'), 'utf8')

  // refreshChrome() runs at the end of every navigate() AND on every realtime notify/board/
  // conversation event — and rtBroadcast('board') reaches every tab open on the floor, so one
  // drag re-ran this everywhere at once. Measured on a shop with 40k proofs: 48.12 MB and
  // 1,632 ms of blocked event loop per sidebar click; four tablets on one board move blocked
  // the whole box, every other tenant included, for 6,716 ms.
  const i = app.indexOf('async function drawChrome')
  assert.ok(i > 0, 'the chrome refresh must still exist')
  const body = app.slice(i, app.indexOf('\n}', i))
  for (const heavy of ['/api/dashboard', '/api/art', '/api/followups', '/api/automations', '/api/conversations']) {
    assert.ok(!body.includes(heavy), `the chrome refresh must not fetch ${heavy} for a badge count`)
  }
  assert.match(body, /\/api\/chrome\/badges/, 'it should ask the endpoint that returns exactly the six numbers')

  // The endpoint has to exist and produce every key the nav reads, or the dots go dark.
  const j = server.indexOf("app.get('/api/chrome/badges'")
  assert.ok(j > 0, 'GET /api/chrome/badges must exist')
  const route = server.slice(j, j + 1400)
  for (const key of ['active_jobs', 'open_invoices', 'art_pending', 'followups', 'automations', 'unread']) {
    assert.match(route, new RegExp(`\\b${key}:`), `the badge endpoint must return ${key}`)
  }
  // Six counts, not six materialised lists — that is the entire point of the endpoint.
  assert.ok(!/\ball\(/.test(route), 'the badge endpoint must count, never materialise rows')
  // Seven counts for six numbers: `followups` is two populations (stale quotes + overdue
  // invoices), which is exactly what the client used to add together.
  assert.equal((route.match(/COUNT\(\*\)/g) || []).length, 7, 'six numbers, seven counts')

  // A burst of board events must not stack a round trip each.
  assert.match(app, /function refreshChrome\(\)\s*\{\s*if \(chromeTimer\) return/,
    'refreshChrome should coalesce bursts — one board drag broadcasts to every tab in the shop')
})

/* ---------- summary ---------- */
console.log(`\n  ${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
