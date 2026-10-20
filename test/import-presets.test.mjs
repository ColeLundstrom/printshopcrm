import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseCsv, importMapping, applyImportMapping, mapContactRow } from '../lib/csv.mjs'
import { detectImportPreset, normHeader } from '../lib/import-presets.mjs'

// Synthetic, fictional rows only (RFC-2606 example domains).
const fixture = name => readFileSync(new URL('./fixtures/import-presets/' + name, import.meta.url), 'utf8')
const importAll = (rows, mapping) => applyImportMapping(rows, 'contacts', mapping).map(mapContactRow)

test('Printavo customer export is detected and pre-maps split addresses and contact names', () => {
  const rows = parseCsv(fixture('printavo-customers.csv'))
  const info = importMapping(rows, 'contacts')
  assert.equal(info.preset, 'printavo')
  assert.equal(info.detected.short, 'Printavo export')
  assert.deepEqual(info.presets.map(p => p.id), ['generic', 'printavo', 'yoprint'])
  assert.equal(info.mapping.first, 'first name')
  assert.equal(info.mapping.company, 'company')
  assert.equal(info.mapping.billing_city, 'billing address - city')
  assert.equal(info.mapping.billing_postal_code, 'billing address - zip')
  assert.equal(info.mapping.shipping_address, 'shipping address - address 1')
  const [person, business] = importAll(rows, info.mapping)
  assert.equal(person.name, 'Avery Quill')
  assert.equal(person.company, 'Fictional Lanes Bowling')
  assert.equal(person.email, 'avery@example.com')
  assert.match(person.billing_address, /100 Sample Way/)
  assert.match(person.billing_address, /Testville, CA 90000/)
  assert.match(person.shipping_address, /Portside, CA 90001/)
  assert.equal(business.name, 'Demo Robotics, Inc.') // no contact person: falls back to the company
  assert.equal(business.shipping_address, undefined)
})

test('YoPrint snake_case export is detected; customer_name becomes the company', () => {
  const rows = parseCsv(fixture('yoprint-customers.csv'))
  const info = importMapping(rows, 'contacts')
  assert.equal(info.preset, 'yoprint')
  assert.equal(info.detected.short, 'YoPrint export')
  assert.equal(info.mapping.company, 'customer_name')
  assert.equal(info.mapping.email, 'contact_email')
  assert.equal(info.mapping.notes, 'customer_internal_notes')
  assert.equal(info.mapping.billing_postal_code, 'billing_postcode')
  assert.equal(info.mapping.billing_country, 'billing_country_code')
  const [club, brewery] = importAll(rows, info.mapping)
  assert.equal(club.name, 'Rowan Tidewell')
  assert.equal(club.company, 'Sample Swim Club')
  assert.equal(club.notes, 'Prefers pickup')
  assert.match(club.billing_address, /Lakeside, OR 97000/)
  assert.equal(brewery.name, 'Placeholder Brewing')
  assert.match(brewery.billing_address, /Unit B/)
})

test('an ordinary spreadsheet stays Generic with the established synonym mapping', () => {
  const rows = parseCsv(fixture('generic-customers.csv'))
  const info = importMapping(rows, 'contacts')
  assert.equal(info.preset, 'generic')
  assert.equal(info.mapping.name, 'name')
  assert.equal(info.mapping.billing_city, 'city')
  assert.deepEqual(info.mapping, info.presets.find(p => p.id === 'generic').mapping)
  assert.equal(importAll(rows, info.mapping)[0].name, 'Jordan Example')
})

test('presets stay editable: explicit choices win over the detected preset', () => {
  const rows = parseCsv(fixture('printavo-customers.csv'))
  const info = importMapping(rows, 'contacts', { company: null, email: 'owner email' })
  assert.equal(info.preset, 'printavo')
  assert.equal(info.mapping.company, null)
  assert.equal(info.mapping.email, 'owner email')
  assert.equal(info.mapping.first, 'first name')
  // Switching to the Generic preset exposes its (different) suggestions for the same headers.
  assert.equal(info.presets.find(p => p.id === 'generic').mapping.billing_city, null)
})

test('detection is case/punctuation-insensitive and needs two signature headers', () => {
  assert.equal(normHeader('Billing_Address - Address 1'), 'billing address address 1')
  assert.equal(normHeader('Tax Resale No.'), 'tax resale no')
  assert.equal(detectImportPreset(['CUSTOMER ID', 'Tax Exempt?', 'Email']).id, 'printavo')
  assert.equal(detectImportPreset(['Customer Name', 'Billing Postcode', 'Email']).id, 'yoprint')
  assert.equal(detectImportPreset(['Customer ID', 'Email']).id, 'generic')
  assert.equal(detectImportPreset([]).id, 'generic')
})

test('order history import keeps the generic mapping only', () => {
  const rows = parseCsv('Customer,Total,Billing Postcode,Customer Tax Exempt\nShop,10,97000,FALSE')
  const info = importMapping(rows, 'orders')
  assert.equal(info.preset, 'generic')
  assert.deepEqual(info.presets.map(p => p.id), ['generic'])
  assert.equal(info.mapping.total, 'total')
})
