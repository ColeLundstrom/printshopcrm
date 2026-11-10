import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCsv, mapContactRow, mapOrderRows, importMapping, applyImportMapping, importPaymentState, parsePaymentTerm, parseExempt, detectColumns } from '../lib/csv.mjs'

const csv = (...lines) => parseCsv(lines.join('\n'))

test('customer import carries tax-exempt status, resale number and payment terms', () => {
  const printavo = csv(
    'Customer ID,Company,First Name,Last Name,Email,Tax Exempt,Tax Resale No,Default Payment Term,Billing Address - City',
    '101,Harbor Athletics,Dana,Lee,dana@example.test,true,RS-99-1234,Net 30,Tustin',
    '102,Walk In,Sam,Poe,sam@example.test,false,,Due on receipt,Tustin',
    '103,Odd Terms,Ari,Fox,ari@example.test,,,Net 60,Tustin')
  const info = importMapping(printavo, 'contacts')
  assert.equal(info.preset, 'printavo')
  assert.equal(info.mapping.tax_exempt, 'tax exempt')
  assert.equal(info.mapping.tax_exempt_id, 'tax resale no')
  assert.equal(info.mapping.payment_term, 'default payment term')
  const [a, b, c] = applyImportMapping(printavo, 'contacts', info.mapping).map(mapContactRow)
  assert.deepEqual([a.tax_exempt, a.tax_exempt_id, a.payment_term], [1, 'RS-99-1234', 'net_30'])
  assert.deepEqual([b.tax_exempt, b.tax_exempt_id, b.payment_term], [undefined, undefined, 'due_on_receipt'], 'an explicit "false" leaves the customer taxable')
  assert.equal(c.payment_term, undefined, 'a term the app has no equivalent for keeps the default instead of a guess')

  const yoprint = csv(
    'customer_name,contact_first_name,contact_last_name,contact_email,customer_tax_exempt,customer_resale_number,customer_payment_term,billing_postcode',
    'Ridge Co,Lee,Kim,lee@example.test,Yes,TX-778,net_45,92780')
  const y = importMapping(yoprint, 'contacts')
  assert.equal(y.preset, 'yoprint')
  const mapped = mapContactRow(applyImportMapping(yoprint, 'contacts', y.mapping)[0])
  assert.deepEqual([mapped.tax_exempt, mapped.tax_exempt_id, mapped.payment_term], [1, 'TX-778', 'net_45'])

  // Unmapped (API) path: the generic synonyms pick the same columns up.
  const plain = mapContactRow(csv('Name,Email,Tax Exempt,Resale Number,Payment Terms', 'Pat,pat@example.test,Y,R-1,30')[0])
  assert.deepEqual([plain.tax_exempt, plain.tax_exempt_id, plain.payment_term], [1, 'R-1', 'net_30'])
  assert.equal(detectColumns(['name', 'tax exempt', 'payment terms']).tax_exempt, true)

  assert.equal(parseExempt('exempt'), true); assert.equal(parseExempt('0'), false); assert.equal(parseExempt('maybe'), null)
  for (const [raw, want] of [['Net 15', 'net_15'], ['45 days', 'net_45'], ['net-30', 'net_30'], ['COD', 'due_on_receipt'], ['0', 'due_on_receipt'], ['2/10 Net 30', ''], ['', '']])
    assert.equal(parsePaymentTerm(raw), want, raw)
})

test('a snake_case order export maps its columns instead of importing blanks', () => {
  const rows = csv(
    'order_number,customer_name,customer_email,order_date,status,item_name,quantity,unit_price,sub_total,sales_tax,grand_total,amount_paid,balance_due,po_number,job_name,payment_due_date,customer_due_date,production_notes',
    'SO-1002,Ridge Co,ridge@example.test,2026-04-02,Completed,Gildan 5000,25,2.00,50.00,8.25,58.25,0,58.25,PO-77,Ridge spring tees,2026-05-02,2026-04-20,Bag by size')
  const [o] = mapOrderRows(rows).orders
  assert.deepEqual(
    [o.order_number, o.customer_name, o.customer_email, o.date, o.garment, o.quantity, o.unit_price, o.subtotal, o.tax, o.total, o.amount_paid, o.balance, o.po_number, o.title, o.payment_due_date, o.due_date, o.notes],
    ['SO-1002', 'Ridge Co', 'ridge@example.test', '2026-04-02', 'Gildan 5000', 25, 2, 50, 8.25, 58.25, 0, 58.25, 'PO-77', 'Ridge spring tees', '2026-05-02', '2026-04-20', 'Bag by size'])
  // The mapper the UI shows suggests the same columns, so "Match your columns" does not blank them.
  const info = importMapping(rows, 'orders')
  assert.equal(info.mapping.order_number, 'order_number'); assert.equal(info.mapping.total, 'grand_total')
  assert.equal(info.mapping.amount_paid, 'amount_paid'); assert.equal(info.mapping.tax, 'sales_tax'); assert.equal(info.mapping.title, 'job_name')
  const [viaUi] = mapOrderRows(applyImportMapping(rows, 'orders', info.mapping)).orders
  assert.deepEqual([viaUi.order_number, viaUi.total, viaUi.amount_paid, viaUi.tax, viaUi.po_number], ['SO-1002', 58.25, 0, 8.25, 'PO-77'])
})

test('Total still outranks Subtotal, and Subtotal is its own field', () => {
  const [o] = mapOrderRows(csv('Order #,Customer,Subtotal,Sales Tax,Total', 'A-1,Harbor,2775.00,228.94,3003.94')).orders
  assert.deepEqual([o.subtotal, o.tax, o.total], [2775, 228.94, 3003.94])
  const [only] = mapOrderRows(csv('Order #,Customer,Subtotal', 'A-2,Harbor,100')).orders
  assert.deepEqual([only.subtotal, only.total], [100, 100], 'a file with only a Subtotal still states what was billed')
  const [st] = mapOrderRows(csv('Order #,Customer,Subtotal,Tax', 'A-3,Harbor,100,8.25')).orders
  assert.equal(st.total, 108.25, 'no Total column: subtotal + tax')
})

test('the money columns decide paid, part-paid and unpaid; status alone no longer guesses', () => {
  const st = (o, opts) => importPaymentState(o, opts)
  assert.deepEqual(st({ status: 'Completed', total: 2165, amount_paid: 1000 }), { kind: 'partial', paid: 1000 })
  assert.deepEqual(st({ status: 'Completed', total: 353.13, balance: 353.13 }), { kind: 'unpaid', paid: 0 })
  assert.deepEqual(st({ status: 'Completed', total: 500, balance: 0 }), { kind: 'paid', paid: 500 })
  assert.deepEqual(st({ status: 'Quote Approved', total: 3000, amount_paid: 1500 }), { kind: 'partial', paid: 1500 })
  assert.deepEqual(st({ status: 'Partial', total: 100, amount_paid: 40 }, { strict: true }), { kind: 'partial', paid: 40 }, 'strict mode takes the amounts too')
  assert.equal(st({ status: 'Partial', total: 100 }).kind, null, 'a part payment with no amount is named, not guessed')
  assert.equal(st({ status: 'Partial', total: 100 }, { strict: true }).kind, null)
  assert.equal(st({ status: 'Completed', total: 100 }).kind, null, 'a finished job is not proof of payment')
  assert.equal(st({ status: '', total: 100 }, { statusColumn: true }).kind, null, 'blank in a file with a status column')
  assert.equal(st({ status: '', total: 100 }).kind, 'paid', 'no status column at all stays paid history (documented lenient shape)')
  assert.equal(st({ status: 'Cancelled', total: 100, amount_paid: 100 }).kind, 'cancelled')
  assert.equal(st({ status: 'Quote', total: 100, amount_paid: 0 }).kind, 'quote')
  assert.deepEqual(st({ status: 'Paid', total: 100, amount_paid: 250 }), { kind: 'paid', paid: 100 }, 'an overpayment is capped at the total')
})
