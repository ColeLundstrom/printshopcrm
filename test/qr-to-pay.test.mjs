import test from 'node:test'
import assert from 'node:assert/strict'
import QRCode from 'qrcode'
import { renderDocument } from '../lib/pdf.mjs'
import { qrRuns, qrPdfOps, qrSvg } from '../lib/qr.mjs'

// Synthetic shop and customer (RFC-2606 domains).
const settings = { shop_name: 'Demo Print Shop', shop_address: '10 Printer Lane', shop_email: 'shop@example.test', shop_phone: '555-0100', currency: 'USD', locale: 'en-US', tax_rate: 8, invoice_terms: 'Net 30.' }
const contact = { name: 'Dylan Example', email: 'dylan@example.test' }
const payUrl = 'https://shop.example.test/p/pay/42?k=0123456789abcdef'
const base = { invoice_number: 'INV-42', status: 'sent', created_at: '2026-09-04', due_date: '2026-10-04', subtotal: 100, tax: 0, amount_due: 100, amount_paid: 0 }
const items = [{ description: 'Tees', sizes: { M: 4 }, unit_price: 25 }]
const render = (doc, extra = {}) => renderDocument('INVOICE', { doc: { ...base, ...doc }, contact, settings, items, payUrl, ...extra }).toString('latin1')
const stream = (pdf) => [...pdf.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map(m => m[1])

test('invoice PDF draws a vector QR and "Scan to pay" while a balance is owed', () => {
  const pdf = render({})
  assert.match(pdf, /% qr-to-pay/)
  assert.match(pdf, /\(Scan to pay\) Tj/)
  assert.doesNotMatch(pdf, /\/Image|\/XObject/, 'no embedded image is needed')
  const partial = render({ amount_paid: 40, status: 'partial' })
  assert.match(partial, /% qr-to-pay/)
})

test('no QR when the invoice is paid, overpaid, void, an estimate, or has no pay link', () => {
  for (const doc of [{ amount_paid: 100, status: 'paid' }, { amount_paid: 120 }, { status: 'void' }]) {
    const pdf = render(doc)
    assert.doesNotMatch(pdf, /qr-to-pay|Scan to pay/, JSON.stringify(doc))
  }
  assert.doesNotMatch(render({}, { payUrl: '' }), /qr-to-pay/)
  const estimate = renderDocument('ESTIMATE', { doc: { ...base, estimate_number: 'EST-1', total: 100 }, contact, settings, items, payUrl }).toString('latin1')
  assert.doesNotMatch(estimate, /qr-to-pay/)
})

test('the drawn rectangles reproduce the QR matrix exactly and sit clear of the totals column', () => {
  const pdf = render({})
  const page = stream(pdf).find(s => s.includes('% qr-to-pay'))
  const block = page.slice(page.indexOf('% qr-to-pay'))
  const rects = [...block.slice(0, block.indexOf('\nf')).matchAll(/([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re/g)].map(m => m.slice(1).map(Number))
  const { modules } = QRCode.create(payUrl, { errorCorrectionLevel: 'M' })
  const n = modules.size, m = rects[0][3], left = Math.min(...rects.map(r => r[0])), topPdf = Math.max(...rects.map(r => r[1] + r[3]))
  const grid = Array.from({ length: n }, () => Array(n).fill(0))
  for (const [x, y, w] of rects) {
    const row = Math.round((topPdf - (y + m)) / m), col = Math.round((x - left) / m)
    for (let c = 0; c < Math.round(w / m); c++) grid[row][col + c] = 1
  }
  // The finder pattern sits at the corner, so the leftmost/topmost dark module is (0,0).
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) assert.equal(grid[r][c], modules.get(r, c) ? 1 : 0, `module ${r},${c}`)
  const right = Math.max(...rects.map(r => r[0] + r[2]))
  assert.ok(left >= 54 - 0.01, 'inside the margin')
  assert.ok(right + 4 * m < 612 - 54 - 230, 'quiet zone clear of the totals column')
  assert.ok(792 - topPdf + n * m <= 792 - 126, 'above the terms band')
})

test('a long totals block still keeps the QR on the page with BALANCE DUE and inside the page', () => {
  const payments = Array.from({ length: 30 }, (_, i) => ({ amount: 1, method: 'Cash', created_at: '2026-09-04', note: 'n' + i }))
  const pdf = render({ amount_paid: 30, status: 'partial' }, { payments, items: Array.from({ length: 18 }, () => items[0]) })
  const pages = stream(pdf)
  const qrPage = pages.findIndex(s => s.includes('% qr-to-pay'))
  assert.ok(qrPage >= 0)
  assert.equal(pages.filter(s => s.includes('% qr-to-pay')).length, 1)
  assert.match(pages[qrPage], /\(BALANCE DUE\) Tj/)
  for (const [, y] of pages[qrPage].slice(pages[qrPage].indexOf('% qr-to-pay')).matchAll(/[\d.]+ ([\d.]+) [\d.]+ [\d.]+ re/g)) assert.ok(Number(y) > 126 && Number(y) < 792)
})

test('qr helpers: runs merge horizontally, SVG is self-contained and escapes its label', () => {
  const { size, runs } = qrRuns('https://example.com/x')
  assert.ok(size >= 21)
  assert.ok(runs.some(r => r.len >= 7), 'finder pattern rows merge into one run')
  assert.equal(qrPdfOps('https://example.com/x', 0, 0, 80, 792).at(-1), 'f')
  const svg = qrSvg('https://example.com/x', { label: 'A "quoted" <label>' })
  assert.match(svg, /^<svg[^>]+viewBox="0 0 \d+ \d+"/)
  assert.match(svg, /aria-label="A &quot;quoted&quot; &lt;label&gt;"/)
  assert.doesNotMatch(svg, /<script|<image/)
})
