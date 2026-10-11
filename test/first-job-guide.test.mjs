import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHttpTestServer } from './helpers/http-test-server.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = path => readFileSync(join(root, path), 'utf8')

test('first-job guide has working local links, source-backed controls and safe entry points', () => {
  const guide = read('docs/FIRST-JOB.md')
  const headingIds = text => new Set([...text.matchAll(/^#{1,6} (.+)$/gm)].map(([, label]) =>
    label.toLowerCase().replace(/[`*_]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/ /g, '-')))
  for (const [, target] of guide.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    if (/^https:\/\//.test(target)) continue
    const [path, fragment] = target.split('#')
    const full = resolve(root, 'docs', path || 'FIRST-JOB.md')
    assert(full.startsWith(root.endsWith(sep) ? root : root + sep), target)
    assert(existsSync(full), `Missing guide target: ${target}`)
    if (fragment) assert(headingIds(readFileSync(full, 'utf8')).has(fragment), `Missing anchor: ${target}`)
  }
  const estimates = read('public/js/views/estimates.js')
  for (const label of ['+ New Estimate', 'Create Estimate', 'Open customer view', 'Convert to Invoice + Job', 'Create Invoice + Job', 'Payment terms', 'Production due', 'Duplicate']) {
    assert(estimates.includes(label), `Guide control changed: ${label}`)
    assert(guide.includes(label), `Guide should use the real control: ${label}`)
  }
  const install = read('INSTALL.md')
  const quickStart = install.split('## Try it locally')[1].split('### Start a blank local shop')[0]
  assert.match(quickStart, /npm ci/)
  assert.match(quickStart, /npm run demo -- \.\.\/printshopcrm-evaluation 4380/)
  assert.match(quickStart, /node \.\.\/printshopcrm-evaluation\/start\.mjs/)
  assert.doesNotMatch(quickStart, /npm run (?:seed|reset)|PSC_SEED_FORCE/)
  for (const path of ['README.md', 'INSTALL.md', 'docs/DEMO.md']) assert.match(read(path), /\]\((?:docs\/)?FIRST-JOB\.md\)/)
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.license, 'AGPL-3.0-or-later')
  assert.equal(pkg.scripts.demo, 'node bin/demo.mjs')
  assert.match(guide, /fictional/i)
  assert.match(guide, /not evidence of email delivery/)
  assert.match(guide, /does not collect money/)
  assert.match(guide, /technical release/)
  assert.match(guide, /paid hosting.*optional/)
})

test('documented 48-shirt walkthrough reconciles approval, proof, payments, restart and a fresh repeat draft', { timeout: 120000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'psc-first-job-'))
  const dest = join(temp, 'demo')
  const server = await createHttpTestServer()
  try {
    const built = spawnSync(process.execPath, ['bin/demo.mjs', dest, String(server.port)], {
      cwd: root, encoding: 'utf8', timeout: 90000,
    })
    assert.equal(built.status, 0, built.stderr)
    const env = JSON.parse(readFileSync(join(dest, 'demo-env.json'), 'utf8'))
    assert.equal(env.PSC_DEMO, '1')
    assert.equal(env.PSC_HOST, '127.0.0.1')
    const start = () => server.start({ cwd: dest, env, args: ['--no-warnings', '--import', './bin/demo-network-guard.mjs', 'server.mjs'] })
    await start()
    const password = readFileSync(join(dest, 'LOGIN.txt'), 'utf8').match(/Password: (.+)/)[1]
    const login = await fetch(server.base + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'dylan@example.test', password }),
    })
    assert.equal(login.status, 200)
    const cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
    const request = (path, body, method = body === undefined ? 'GET' : 'POST') => fetch(server.base + path, {
      method, headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000),
    })
    const json = async (path, body, method) => {
      const response = await request(path, body, method)
      assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`)
      return response.json()
    }
    const publicDecision = (link, suffix, body) => {
      const url = new URL(link, server.base)
      assert.equal(url.origin, server.base)
      url.pathname += suffix
      return fetch(url, {
        method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body, signal: AbortSignal.timeout(10000),
      })
    }
    const customer = await json('/api/contacts', { name: 'First job evaluation', email: 'first-job@example.test', payment_term: 'net_30' })
    const quote = await json('/api/estimates', {
      contact_id: customer.id, tax_rate: 0,
      items: [
        { description: 'Evaluation shirts', decoration: 'Screen Print', sizes: { M: 24, L: 24 }, unit_price: 12, taxable: true },
        { description: 'Evaluation setup', qty: 1, unit_price: 24, taxable: false },
      ],
    })
    const quotePath = '/api/estimates/' + quote.id
    let detail = await json(quotePath)
    assert.equal(detail.subtotal, 600)
    assert.equal(detail.tax, 0)
    assert.equal(detail.total, 600)
    assert.equal((await publicDecision(detail.share_url, '/approve')).status, 302)
    detail = await json(quotePath)
    assert.equal(detail.status, 'approved')
    assert.equal(detail.approval_history[0].source, 'customer_link')
    const converted = await json(quotePath + '/convert', { commercial_revision: detail.commercial_revision, payment_term: 'net_30' })
    const invoicePath = '/api/invoices/' + converted.invoice_id
    const jobPath = '/api/jobs/' + converted.job_id
    const job = await json(jobPath)
    assert.equal(job.estimate_id, quote.id)
    assert.equal(job.invoice_id, converted.invoice_id)
    assert.deepEqual(JSON.parse(job.sizes), { M: 24, L: 24 })
    assert.equal((await json(invoicePath)).amount_due, 600)
    assert.equal((await request(quotePath + '/convert', { commercial_revision: detail.commercial_revision })).status, 409)

    // A generated sample is owned by the test; no customer or competitor art is used.
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="navy"/></svg>'
    const form = new FormData()
    form.append('file', new Blob([svg], { type: 'image/svg+xml' }), 'evaluation-proof.svg')
    const uploaded = await fetch(server.base + jobPath + '/art', { method: 'POST', headers: { Cookie: cookie }, body: form })
    assert.equal(uploaded.status, 200)
    const art = await uploaded.json()
    const sent = await json('/api/art/' + art.id + '/send', {})
    assert.equal((await publicDecision(sent.share_url, '/decide', 'decision=approved')).status, 302)
    const manifest = await json(jobPath + '/print-package')
    assert.equal(manifest.appearance_approved, true)
    assert.equal(manifest.technical_ready, false, 'Appearance approval is not technical production release')
    assert.equal((await json(jobPath)).art[0].status, 'approved')

    await json(invoicePath + '/payments', { amount: 200, method: 'other', note: 'Fictional evaluation deposit' })
    let invoice = await json(invoicePath)
    assert.equal(invoice.status, 'partial')
    assert.equal(invoice.amount_due - invoice.amount_paid, 400)
    await json(invoicePath + '/payments', { amount: 400, method: 'other', note: 'Fictional evaluation balance' })
    invoice = await json(invoicePath)
    assert.equal(invoice.status, 'paid')
    assert.equal(invoice.amount_paid, 600)
    assert.equal(invoice.amount_due - invoice.amount_paid, 0)
    assert.equal(invoice.payments.length, 2)

    await server.stop()
    await start()
    assert.equal((await json(invoicePath)).amount_paid, 600)
    assert.equal((await json(invoicePath)).payments.length, 2)
    assert.deepEqual(JSON.parse((await json(jobPath)).sizes), { M: 24, L: 24 })
    assert.equal((await json(jobPath)).art[0].status, 'approved')
    assert.equal(await (await request('/uploads/' + art.filename)).text(), svg)
    assert.equal((await json(quotePath)).invoice.id, converted.invoice_id)
    const repeated = await json(quotePath + '/duplicate', {})
    const draft = await json('/api/estimates/' + repeated.id)
    assert.equal(draft.status, 'draft')
    assert.equal(draft.approved_at, null)
    assert.equal(draft.invoice, undefined)
    assert.equal(draft.approval_history.length, 0)
    assert.equal(draft.items[0].unit_price, 12)
    assert.deepEqual(draft.items[0].sizes, { M: 24, L: 24 })
  } finally {
    await server.close()
    rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})
