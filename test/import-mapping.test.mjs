import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCsv, importMapping, applyImportMapping, mapContactRow, mapOrderRows } from '../lib/csv.mjs'

test('custom customer columns, first/last names and deliberately ignored synonyms', () => {
  const rows = parseCsv('Buyer,Given,Surname,Reply to,Email\nShop,Jamie,Rivera,real@example.test,old@example.test')
  const mapping = { name: null, first: 'given', last: 'surname', email: 'reply to', company: 'buyer' }
  const contact = mapContactRow(applyImportMapping(rows, 'contacts', mapping)[0])
  assert.equal(contact.name, 'Jamie Rivera')
  assert.equal(contact.email, 'real@example.test')
  assert.equal(contact.company, 'Shop')
  assert.equal(mapContactRow(applyImportMapping(rows, 'contacts', { ...mapping, email: null })[0]).email, '')
  assert.equal(importMapping(rows, 'contacts').mapping.email, 'email')
  assert.equal(applyImportMapping(rows, 'contacts', undefined), rows)
})

test('custom order totals/status map with size columns preserved and subtotal ignored', () => {
  const rows = parseCsv('Buyer,Document,Settlement,Amount Due,Subtotal,Total,S,M\nShop,001,unpaid,120,90,999,2,4')
  const mapping = { customer_name: 'buyer', order_number: 'document', status: 'settlement', total: 'amount due' }
  const { orders } = mapOrderRows(applyImportMapping(rows, 'orders', JSON.stringify(mapping)))
  assert.equal(orders[0].total, 120)
  assert.equal(orders[0].order_number, '001')
  assert.equal(orders[0].status, 'unpaid')
  assert.equal(orders[0].quantity, 6)
})

test('invalid mappings fail before writing rather than silently use another source', () => {
  const rows = parseCsv('name,email\nShop,a@example.test')
  for (const mapping of ['{', '[]', false, { email: 'missing' }, { unknown: 'name' }, { email: 1 }, JSON.parse('{"__proto__":"name"}')]) {
    assert.throws(() => importMapping(rows, 'contacts', mapping))
  }
})
