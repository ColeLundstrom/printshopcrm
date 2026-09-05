import test from 'node:test'
import assert from 'node:assert/strict'
import { renderDocument, packingSlip } from '../lib/pdf.mjs'

const settings = { shop_name: 'Demo Print Shop', shop_address: '10 Printer Lane', shop_email: 'shop@example.test', shop_phone: '555-0100', currency: 'USD', locale: 'en-US', tax_rate: 8, invoice_terms: 'Payment terms on file.', estimate_terms: 'Valid for 30 days.' }
const contact = { name: 'Dylan Example', company: 'Example School', email: 'dylan@example.test', phone: '555-0199', billing_address: 'CONTACT BILLING', shipping_address: 'CONTACT SHIPPING', address: 'LEGACY ADDRESS' }
const doc = { estimate_number: 'EST-164', invoice_number: 'INV-164', status: 'partial', created_at: '2026-09-04', due_date: '2026-10-04', subtotal: 2250, tax: 180, tax_rate: 8, total: 2430, amount_due: 2430, amount_paid: 275, po_number: 'SCHOOL-164' }
const items = Array.from({ length: 20 }, (_, i) => ({ description: `Garment ${i + 1}`, detail: 'One color front', sizes: { S: 2, M: 3, L: 4 }, unit_price: 12.5 }))
const payments = [{ amount: 200, method: 'Check', note: '#1042', created_at: '2026-09-04' }, { amount: 75, method: 'Cash', created_at: '2026-09-05' }]
const pages = (buffer) => [...buffer.toString('latin1').matchAll(/stream\n([\s\S]*?)\nendstream/g)].map(m => [...m[1].matchAll(/\/(F1|F2) ([\d.]+) Tf 1 0 0 1 ([\d.-]+) ([\d.-]+) Tm \(((?:\\.|[^\\)])*)\) Tj/g)].map(o => ({ font: o[1], size: Number(o[2]), x: Number(o[3]), y: 792 - Number(o[4]), text: o[5].replace(/\\([()\\])/g, '$1') })))
const text = (buffer) => pages(buffer).flat().map(o => o.text).join('\n')
const document = (kind, billing_address, customer = contact) => renderDocument(kind, { doc: { ...doc, billing_address }, contact: customer, settings, items: items.slice(0, 1), payments })
const slip = (shipping_address, customer = contact, goods = items.slice(0, 1)) => packingSlip({ job: { job_number: 'JOB-164', shipping_address, ship_date: '2026-09-04', po_number: 'SCHOOL-164' }, contact: customer, settings, items: goods })

test('invoice and estimate prefer saved billing address, including an intentional blank', () => {
  for (const kind of ['INVOICE', 'ESTIMATE']) {
    const saved = text(document(kind, 'SAVED BILLING\nSuite 164'))
    assert.match(saved, /SAVED BILLING\nSuite 164/)
    assert.doesNotMatch(saved, /CONTACT BILLING|CONTACT SHIPPING|LEGACY ADDRESS/)
    assert.doesNotMatch(text(document(kind, '')), /CONTACT BILLING|CONTACT SHIPPING|LEGACY ADDRESS/)
    assert.match(text(document(kind, null)), /CONTACT BILLING/)
    assert.match(text(document(kind, undefined)), /CONTACT BILLING/)
    assert.doesNotMatch(text(document(kind, undefined, { ...contact, billing_address: '' })), /CONTACT SHIPPING|LEGACY ADDRESS/)
  }
})

test('packing slip uses saved shipping address and the precise legacy fallback chain', () => {
  assert.match(text(slip('SAVED SHIPPING\nReceiving dock')), /SAVED SHIPPING\nReceiving dock/)
  assert.doesNotMatch(text(slip('')), /CONTACT SHIPPING|CONTACT BILLING|LEGACY ADDRESS/)
  assert.match(text(slip(null)), /CONTACT SHIPPING/)
  assert.match(text(slip(undefined, { ...contact, shipping_address: '' })), /CONTACT BILLING/)
  assert.match(text(slip(null, { ...contact, shipping_address: '', billing_address: '' })), /LEGACY ADDRESS/)
})

test('600-character, eight-line postal addresses wrap unbroken text without losing content or overlapping metadata', () => {
  const address = 'W'.repeat(586) + '\nA\nB\nC\nD\nE\nF\nG'
  assert.equal(address.length, 600)
  assert.equal(address.split('\n').length, 8)
  for (const buffer of [document('INVOICE', address), document('ESTIMATE', address), slip(address)]) {
    const first = pages(buffer)[0]
    const postal = first.filter(o => o.x === 340 && (/^W+$/.test(o.text) || /^[A-G]$/.test(o.text)))
    assert.equal(postal.map(o => o.text).join(''), address.replaceAll('\n', ''))
    for (const o of postal.filter(o => /^W+$/.test(o.text))) {
      // Helvetica W has a 944-unit advance. This independently checks the actual column edge.
      assert(o.x + o.text.length * 944 * o.size / 1000 <= 558, 'postal line crosses right margin')
      assert(!o.text.endsWith('...'), 'postal content cannot be clipped')
    }
    const lastContact = first.find(o => o.x === 340 && o.text === contact.phone)
    const metaHeading = first.find(o => o.x === 68 && ['DATE', 'JOB'].includes(o.text))
    assert(metaHeading.y >= lastContact.y + 20, 'metadata must move below the measured recipient block')
    assert(first.find(o => ['DESCRIPTION', 'CONTENTS'].includes(o.text)).y > metaHeading.y)
  }
})

test('long addresses retain financial values, every garment, pagination and final totals', () => {
  const address = Array.from({ length: 8 }, (_, i) => `Address line ${i + 1} for Receiving Department at East Campus`).join('\n')
  const invoice = renderDocument('INVOICE', { doc: { ...doc, billing_address: address }, contact, settings, items, payments })
  const packing = slip(address, contact, items)
  for (const buffer of [invoice, packing]) {
    const all = pages(buffer), strings = all.flat().map(o => o.text)
    assert(all.length > 1, 'long orders still paginate')
    for (const item of items) assert(strings.includes(item.description), `${item.description} omitted`)
    assert(all.every(page => page.every(o => o.y >= 0 && o.y <= 760)), 'text outside printable page')
  }
  const invoiceText = text(invoice)
  for (const amount of ['$2,250.00', '$180.00', '$2,430.00', '-$200.00', '-$75.00', '$2,155.00']) assert(invoiceText.includes(amount), `missing financial amount ${amount}`)
  assert.match(invoiceText, /BALANCE DUE/)
  const packingText = text(packing)
  assert.match(packingText, /TOTAL UNITS\n180/)
  assert.doesNotMatch(packingText, /\$|RATE|AMOUNT|BALANCE DUE/)
})

test('postal whitespace and PDF punctuation stay readable while long contact emails remain visibly clipped', () => {
  const customer = { ...contact, email: 'katherine.vandermeulen@riverside-consolidated-schools.example.org' }
  const output = text(document('INVOICE', '42 Route (North)\\Dock\r\nSuite 164\rMontréal QC H2Y 1C6', customer))
  assert.match(output, /42 Route \(North\)\\Dock\nSuite 164\nMontréal QC H2Y 1C6/)
  assert.match(output, /katherine\.vandermeulen[^\n]*\.\.\./)
  assert(!output.includes(customer.email), 'existing long-email clip contract remains intact')
})

test('accented postal text keeps PDF stream lengths and cross-reference byte offsets valid', () => {
  const address = '42 Rue de l\'École\nMontréal QC H2Y 1C6\nÀ côté du café'
  for (const buffer of [document('INVOICE', address), document('ESTIMATE', address), slip(address)]) {
    const pdf = buffer.toString('latin1')
    const start = Number(pdf.match(/startxref\n(\d+)\n%%EOF/)[1])
    assert.equal(buffer.subarray(start, start + 5).toString('ascii'), 'xref\n', 'startxref must name the actual byte offset')
    const xref = pdf.slice(start).match(/^xref\n0 (\d+)\n([\s\S]*?)trailer\n/)
    const rows = xref[2].trimEnd().split('\n')
    assert.equal(rows.length, Number(xref[1]))
    rows.slice(1).forEach((row, index) => {
      const offset = Number(row.slice(0, 10))
      assert(buffer.subarray(offset).toString('latin1').startsWith(`${index + 1} 0 obj\n`), `object ${index + 1} has a wrong offset`)
    })
    for (const stream of pdf.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)) {
      assert.equal(Number(stream[1]), Buffer.from(stream[2], 'latin1').length, 'stream length must match emitted bytes')
    }
    assert.match(text(buffer), /Montréal QC H2Y 1C6/)
  }
})

test('invoice and estimate row separators leave space around garment titles and size runs', () => {
  for (const kind of ['INVOICE', 'ESTIMATE']) {
    const buffer = renderDocument(kind, { doc: { ...doc, billing_address: 'Suite 164\n42 Printer Way' }, contact, settings, items: items.slice(0, 3) })
    const first = pages(buffer)[0], titles = first.filter(o => /^Garment \d+$/.test(o.text))
    const rules = [...buffer.toString('latin1').matchAll(/0\.5 w 54\.00 ([\d.]+) m 558\.00 \1 l S/g)].map(m => 792 - Number(m[1]))
    for (let i = 1; i < titles.length; i++) {
      const before = first.filter(o => o.x === 54 && o.y >= titles[i - 1].y && o.y < titles[i].y).at(-1)
      const rule = rules.find(y => y > before.y && y < titles[i].y)
      assert(rule, 'separator remains between adjacent rows')
      assert(rule >= before.y + before.size * .207 + 2, 'separator crosses the previous text descenders')
      assert(rule <= titles[i].y - titles[i].size * .718 - 2, 'separator crosses the next title capitals')
    }
  }
})
