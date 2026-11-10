import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHttpTestServer } from './helpers/http-test-server.mjs'
import { friendlyError, needsReconnect, ensureTaxItem, pushInvoice, apiBaseFor, TAX_ITEM_NAME } from '../lib/quickbooks.mjs'

const root = new URL('..', import.meta.url)

test('QuickBooks faults become sentences, and a dead connection is told apart from a bad invoice', () => {
  assert.equal(needsReconnect({ ok: false, status: 401, error: 'AuthenticationFailed' }), true)
  assert.equal(needsReconnect({ ok: false, status: 400, error: 'invalid_grant' }), true)
  assert.equal(needsReconnect({ ok: false, status: 400, error: 'Token has been revoked' }), true)
  assert.equal(needsReconnect({ ok: false, status: 400, error: 'Duplicate Name Exists Error' }), false)
  assert.equal(needsReconnect({ ok: false, error: 'fetch failed' }), false)
  assert.equal(needsReconnect({ ok: true }), false)
  assert.match(friendlyError({ ok: false, status: 401 }), /Reconnect QuickBooks/)
  assert.match(friendlyError({ ok: false, status: 400, error: 'Duplicate Document Number Error: 6140' }, 'INV-1001'), /already has a record.*INV-1001/)
  assert.match(friendlyError({ ok: false, status: 503, error: 'Service unavailable' }), /retried automatically/)
  assert.match(friendlyError({ ok: false, error: 'The operation was aborted due to timeout' }), /could not be reached/)
  const unknown = friendlyError({ ok: false, status: 400, error: '{"weird":"json"} '.repeat(40) }, 'INV-7')
  assert.match(unknown, /^QuickBooks did not accept INV-7: /); assert.ok(unknown.length < 280, 'a raw fault is trimmed, not dumped')
  assert.equal(apiBaseFor('sandbox'), 'https://sandbox-quickbooks.api.intuit.com')
  assert.equal(apiBaseFor('anything-else'), 'https://quickbooks.api.intuit.com')
})

test('sales tax goes through an item on a liability account, found before it is created', async () => {
  const calls = []
  const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
  let existing = false
  const fetch = async (url, opts = {}) => {
    const u = new URL(url), path = u.pathname.split('/').pop(), body = opts.body ? JSON.parse(opts.body) : null
    calls.push({ host: u.hostname, path, q: u.searchParams.get('query') || '', body })
    if (path === 'query' && /FROM Item/.test(u.searchParams.get('query'))) return J({ QueryResponse: existing ? { Item: [{ Id: '55' }] } : {} })
    if (path === 'query') return J({ QueryResponse: {} })
    if (path === 'account') return J({ Account: { Id: '90' } })
    if (path === 'item') return J({ Item: { Id: '56' } })
    if (path === 'invoice') return J({ Invoice: { Id: '7', SyncToken: '0', TotalAmt: 108.25 } })
    return J({}, 404)
  }
  const made = await ensureTaxItem({ realmId: '1', accessToken: 't', fetch })
  assert.deepEqual({ ok: made.ok, id: made.id, created: made.created }, { ok: true, id: '56', created: true })
  assert.equal(calls.find((c) => c.path === 'account').body.AccountType, 'Other Current Liability')
  const item = calls.find((c) => c.path === 'item').body
  assert.equal(item.Name, TAX_ITEM_NAME); assert.equal(item.IncomeAccountRef.value, '90')
  existing = true; calls.length = 0
  const found = await ensureTaxItem({ realmId: '1', accessToken: 't', fetch })
  assert.deepEqual({ id: found.id, created: found.created }, { id: '55', created: false })
  assert.ok(!calls.some((c) => c.path === 'item' || c.path === 'account'), 'an item the bookkeeper already has is used as it is')

  calls.length = 0
  const pushed = await pushInvoice({ realmId: '1', accessToken: 't', fetch, customer: '9',
    invoice: { invoice_number: 'INV-1', created_at: '2026-11-10 02:30:00', txn_date: '2026-11-09', due_date: '2026-11-24' },
    lines: [{ description: 'Tees', amount: 100 }, { description: 'Sales tax', amount: 8.25, qty: 1, itemRef: '55' }] })
  assert.equal(pushed.totalAmt, 108.25)
  const body = calls.find((c) => c.path === 'invoice').body
  assert.equal(body.TxnDate, '2026-11-09', 'the shop-local date, not the UTC stamp')
  assert.equal(body.DueDate, '2026-11-24')
  assert.deepEqual(body.Line[1].SalesItemLineDetail.ItemRef, { value: '55' })
  assert.equal(body.Line[0].SalesItemLineDetail.ItemRef, undefined)
})

test('Xero export rows reproduce each invoice to the cent', { timeout: 30000 }, () => {
  const code = `
    import assert from 'node:assert/strict'
    const { xeroRowsForInvoice, XERO_COLUMNS } = await import(${JSON.stringify(new URL('lib/quickbooks-routes.mjs', root).href)})
    assert.equal(XERO_COLUMNS.length, 29); assert.equal(XERO_COLUMNS[0], '*ContactName'); assert.equal(XERO_COLUMNS[10], '*InvoiceNumber')
    const o = { upcharges: {}, dateFmt: 'mdy', accountCode: '200', taxType: 'Tax on Sales', exemptType: 'Tax Exempt', currency: 'USD' }
    const inv = { invoice_number: 'INV-9', company: 'Lakeside High', email: 'a@example.test', created_at: '2026-11-10 02:30:00', due_date: '2026-11-24', amount_due: 1085.19, po_number: 'PO-7' }
    const rows = xeroRowsForInvoice(inv, { ...o, tax: 76.19, items: [
      { description: 'Tees', sizes: { M: 48 }, unit_price: 9.5 }, { description: 'Hoodies', sizes: { L: 20 }, unit_price: 23.35 },
      { description: 'Setup', qty: 1, unit_price: 86, taxable: false }] })
    assert.equal(rows.length, 3)
    const cents = (s) => Math.round(Number(s) * 100)
    assert.equal(rows.reduce((n, r) => n + Math.round(Number(r['*Quantity']) * Number(r['*UnitAmount']) * 100), 0) + rows.reduce((n, r) => n + cents(r.TaxAmount), 0), 108519)
    assert.equal(rows[2]['*TaxType'], 'Tax Exempt'); assert.equal(rows[2].TaxAmount, '0.00'); assert.equal(rows[0]['*TaxType'], 'Tax on Sales')
    assert.equal(rows[0]['*DueDate'], '11/24/2026'); assert.equal(rows[0].Reference, 'PO-7'); assert.equal(rows[0].Total, '1085.19')
    assert.equal(xeroRowsForInvoice(inv, { ...o, dateFmt: 'dmy', tax: 0, items: [] })[0]['*DueDate'], '24/11/2026')
    // Lines that do not add up to the invoice are not exported as a document that disagrees with it.
    const odd = xeroRowsForInvoice({ ...inv, amount_due: 500 }, { ...o, tax: 0, items: [{ description: 'Tees', qty: 10, unit_price: 9.5 }] })
    assert.equal(odd.length, 1); assert.equal(odd[0]['*UnitAmount'], '500'); assert.equal(odd[0]['*Quantity'], '1')
  `
  const run = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], { env: { ...process.env, PSC_DB: ':memory:', TZ: 'UTC' }, encoding: 'utf8', timeout: 25000 })
  assert.equal(run.status, 0, run.stderr)
})

test('QuickBooks Online: owner connects, invoices and payments push, credits park, a dead sign-in asks to reconnect', { timeout: 150000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'psc-qbo-')), dest = join(dir, 'demo'), fake = join(dir, 'fake')
  mkdirSync(fake)
  const server = await createHttpTestServer(); let db
  try {
    const built = spawnSync(process.execPath, ['bin/demo.mjs', dest, String(server.port)], { cwd: root, encoding: 'utf8', timeout: 90000 })
    assert.equal(built.status, 0, built.stderr)
    const env = { ...JSON.parse(readFileSync(join(dest, 'demo-env.json'), 'utf8')), FAKE_INTUIT_DIR: fake }
    // The demo's network guard stays installed; the fixture replaces fetch for Intuit's hosts only.
    const preload = new URL('./helpers/fake-intuit.mjs', import.meta.url).href
    await server.start({ cwd: dest, env, args: ['--no-warnings', '--import', './bin/demo-network-guard.mjs', '--import', preload, 'server.mjs'] })
    const password = readFileSync(join(dest, 'LOGIN.txt'), 'utf8').match(/Password: (.+)/)[1]
    const signIn = async (email, pw) => {
      const r = await fetch(server.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pw }) })
      assert.equal(r.status, 200, email); return r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
    }
    const owner = await signIn('dylan@example.test', password)
    const request = async (path, body, method = body === undefined ? 'GET' : 'POST', auth = owner) => {
      const r = await fetch(new URL(path, server.base), { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', Cookie: auth }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) })
      const text = await r.text(); let json; try { json = JSON.parse(text) } catch { json = text }
      return { status: r.status, body: json, location: r.headers.get('location') }
    }
    const ok = async (...a) => { const r = await request(...a); assert.equal(r.status, 200, `${a[0]} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body }
    const calls = () => (existsSync(join(fake, 'calls.jsonl')) ? readFileSync(join(fake, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [])
    const api = () => calls().filter((c) => c.kind === 'api')
    const flag = (name, on = '1') => (on ? writeFileSync(join(fake, name), on) : rmSync(join(fake, name), { force: true }))
    const tenant = readdirSync(join(dest, 'data/tenants'))[0]
    db = new DatabaseSync(join(dest, 'data/tenants', tenant, 'printshop.db'))
    db.exec("PRAGMA busy_timeout=5000; UPDATE automations SET enabled=0; DELETE FROM qbo_sync")
    const queue = async () => Object.fromEntries((await ok('/api/qbo/queue')).rows.map((r) => [r.invoice_number, r]))
    await ok('/api/settings', { tax_rate: 8.25, timezone: 'America/Los_Angeles' }, 'PUT')

    // --- a manager can look, only the owner can set it up
    await ok('/api/members', { name: 'Morgan Manager', email: 'morgan@example.test', password: 'manager-pass-1', role: 'manager' })
    const manager = await signIn('morgan@example.test', 'manager-pass-1')
    assert.equal((await request('/api/qbo/status', undefined, 'GET', manager)).body.can_configure, false)
    assert.equal((await request('/api/qbo/credentials', { client_id: 'ABclientid1234567890', client_secret: 'managersecret12345' }, 'PUT', manager)).status, 403)
    assert.equal((await request('/api/qbo/connect', undefined, 'GET', manager)).status, 403)
    const viaSettings = await request('/api/settings', { qbo_client_id: 'SNEAKclientid1234567' }, 'PUT', manager)
    assert.equal(viaSettings.status, 403); assert.equal(viaSettings.body.code, 'owner_only_quickbooks')
    assert.equal((await request('/api/qbo/status', undefined, 'GET', '')).status, 401)

    // --- keys: validated, stored, never returned
    let status = await ok('/api/qbo/status')
    assert.equal(status.connected, false); assert.equal(status.direction, 'one_way_push'); assert.match(status.redirect_uri, /\/api\/qbo\/callback$/)
    assert.equal((await request('/api/qbo/connect')).body.code, 'qbo_keys_missing')
    assert.equal((await request('/api/qbo/credentials', { client_id: 'has spaces' }, 'PUT')).status, 400)
    assert.equal((await request('/api/qbo/credentials', { environment: 'staging' }, 'PUT')).status, 400)
    await ok('/api/qbo/credentials', { client_id: 'ABclientid1234567890', client_secret: 'ownersecret-9f8e7d6c', environment: 'sandbox' }, 'PUT')
    status = await ok('/api/qbo/status')
    assert.equal(status.client_secret_set, true); assert.equal(status.environment, 'sandbox')
    for (const path of ['/api/qbo/status', '/api/settings', '/api/qbo/queue']) assert.ok(!JSON.stringify(await ok(path)).includes('ownersecret-9f8e7d6c'), `${path} returned the client secret`)

    // --- OAuth: state is checked, the code is exchanged, the company is named
    const authorize = new URL((await ok('/api/qbo/connect')).url)
    assert.equal(authorize.origin + authorize.pathname, 'https://appcenter.intuit.com/connect/oauth2')
    assert.equal(authorize.searchParams.get('redirect_uri'), status.redirect_uri)
    const state = authorize.searchParams.get('state')
    assert.equal((await request('/api/qbo/callback?state=forged&code=good-code&realmId=9130')).status, 400)
    assert.equal((await request(`/api/qbo/callback?state=${state}&code=good-code&realmId=9130`, undefined, 'GET', manager)).status, 403)
    assert.equal(calls().filter((c) => c.kind === 'token').length, 0, 'no code is exchanged for a forged state or a non-owner')
    assert.equal((await request(`/api/qbo/callback?state=${state}&code=stolen&realmId=9130`)).status, 400)
    const back = await request(`/api/qbo/callback?state=${(new URL((await ok('/api/qbo/connect')).url)).searchParams.get('state')}&code=good-code&realmId=9130`)
    assert.equal(back.status, 302); assert.equal(back.location, '/#/books?qbo=connected')
    const exchange = calls().filter((c) => c.kind === 'token').pop()
    assert.deepEqual({ grant: exchange.grant, redirect: exchange.redirect, basic: exchange.basic }, { grant: 'authorization_code', redirect: status.redirect_uri, basic: true })
    status = await ok('/api/qbo/status')
    assert.deepEqual({ connected: status.connected, company: status.company_name, realm: status.realm_id, reconnect: status.needs_reconnect }, { connected: true, company: 'Fixture Print Co', realm: '9130', reconnect: false })
    assert.ok(!JSON.stringify(status).match(/access-\d|refresh-\d/), 'tokens never reach the browser')

    // --- a taxed invoice and its payment push: tax through the liability item, shop-local dates
    const customer = await ok('/api/contacts', { name: 'Dana Coach', company: 'Lakeside Fixture High', email: 'dana@example.test' })
    const order = async (label, price = 10) => {
      const est = await ok('/api/estimates', { contact_id: customer.id, items: [{ description: label, decoration: 'Screen Print', sizes: { M: 10 }, unit_price: price }] })
      return ok(`/api/estimates/${est.id}/convert`, { commercial_revision: est.commercial_revision || 0 })
    }
    const first = await order('Fixture tees')
    await ok(`/api/invoices/${first.invoice_id}/payments`, { amount: 50, method: 'check' })
    let sync = await ok('/api/qbo/sync-now', {})
    assert.equal(sync.synced, 1)
    assert.deepEqual([...new Set(api().map((c) => c.host))], ['sandbox-quickbooks.api.intuit.com'], 'a sandbox shop only ever talks to the sandbox host')
    const pushed = api().find((c) => c.path === 'invoice').body
    assert.equal(pushed.DocNumber, first.invoice_number)
    assert.deepEqual(pushed.Line.map((l) => l.Amount), [100, 8.25])
    assert.equal(pushed.Line[1].Description, 'Sales tax'); assert.deepEqual(pushed.Line[1].SalesItemLineDetail.ItemRef, { value: '55' })
    assert.equal(pushed.Line[0].SalesItemLineDetail.ItemRef, undefined)
    const localDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date())
    assert.ok([localDay, new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date(Date.now() - 60000))].includes(pushed.TxnDate), `TxnDate ${pushed.TxnDate} is the shop's date`)
    assert.equal(api().find((c) => c.path === 'account').body.AccountType, 'Other Current Liability')
    const payment = api().find((c) => c.path === 'payment').body
    assert.equal(payment.TotalAmt, 50); assert.equal(payment.Line[0].LinkedTxn[0].TxnType, 'Invoice'); assert.equal(payment.TxnDate, pushed.TxnDate)
    assert.equal((await queue())[first.invoice_number].status, 'ok')
    assert.ok((await ok('/api/qbo/status')).last_sync_at, 'last sync time is recorded')
    assert.equal(api().filter((c) => c.path === 'item').length, 1)

    // --- a credit parks ITS row for a person and nothing behind it waits
    const credited = await order('Credited tees'), after = await order('Later tees')
    await ok(`/api/invoices/${credited.invoice_id}/payments`, { amount: 10, method: 'cash' })
    await ok(`/api/invoices/${credited.invoice_id}/credits`, { reference: 'fixture-credit-0001', subtotal: 20, tax: 0, reason: 'Misprint' })
    await ok(`/api/invoices/${after.invoice_id}/payments`, { amount: 10, method: 'cash' })
    sync = await ok('/api/qbo/sync-now', {})
    let rows = await queue()
    assert.equal(rows[credited.invoice_number].status, 'manual'); assert.match(rows[credited.invoice_number].error, /credit memo in QuickBooks by hand/)
    assert.equal(rows[credited.invoice_number].next_attempt_at, null, 'a row only a person can finish is not retried')
    assert.equal(rows[after.invoice_number].status, 'ok', 'the invoice behind the credit still went')
    assert.equal(api().filter((c) => c.path === 'item').length, 1, 'the tax item is created once and remembered')
    assert.equal((await ok('/api/qbo/status')).counts.manual, 1)
    const parked = rows[credited.invoice_number].id
    await ok(`/api/qbo/queue/${parked}/dismiss`, {})
    assert.equal((await queue())[credited.invoice_number].status, 'dismissed')

    // --- an expired access token refreshes quietly and the push still lands
    const expiring = await order('Refresh tees')
    await ok(`/api/invoices/${expiring.invoice_id}/payments`, { amount: 10, method: 'cash' })
    flag('expire-once', api().pop().token)
    sync = await ok('/api/qbo/sync-now', {})
    flag('expire-once', null)
    assert.equal(sync.synced, 1); assert.equal(sync.needs_reconnect, false)
    assert.equal(calls().filter((c) => c.kind === 'token' && c.grant === 'refresh_token').length, 1)
    assert.equal((await queue())[expiring.invoice_number].status, 'ok')

    // --- a server fault is a retry with a sentence; Retry all failed puts failures back
    const flaky = await order('Flaky tees')
    await ok(`/api/invoices/${flaky.invoice_id}/payments`, { amount: 10, method: 'cash' })
    flag('invoice-500')
    await ok('/api/qbo/sync-now', {})
    rows = await queue()
    assert.equal(rows[flaky.invoice_number].status, 'retrying'); assert.match(rows[flaky.invoice_number].error, /problem on its side.*retried automatically/)
    assert.ok(!/Fault|\{/.test(rows[flaky.invoice_number].error), 'no raw API JSON in the log')
    db.prepare("UPDATE qbo_sync SET status='failed', attempts=6 WHERE id=?").run(rows[flaky.invoice_number].id)
    flag('invoice-500', null)
    assert.equal((await ok('/api/qbo/queue/retry-failed', {})).requeued, 1)
    assert.equal((await ok('/api/qbo/sync-now', {})).synced, 1)
    assert.equal((await queue())[flaky.invoice_number].status, 'ok')

    // --- QuickBooks adding its own tax is caught by comparing totals
    const doubled = await order('Doubled tees')
    await ok(`/api/invoices/${doubled.invoice_id}/payments`, { amount: 10, method: 'cash' })
    flag('ast-adds-tax')
    await ok('/api/qbo/sync-now', {})
    flag('ast-adds-tax', null)
    assert.match((await queue())[doubled.invoice_number].error, /QuickBooks is likely adding its own sales tax/)
    assert.equal((await ok(`/api/qbo/queue/${(await queue())[doubled.invoice_number].id}/retry`, {})).ok, true)

    // --- a revoked sign-in: one banner, the row waits untouched, the sweep stops trying
    const stranded = await order('Stranded tees')
    await ok(`/api/invoices/${stranded.invoice_id}/payments`, { amount: 10, method: 'cash' })
    flag('all-401'); flag('refresh-dead')
    sync = await ok('/api/qbo/sync-now', {})
    assert.deepEqual({ synced: sync.synced, reconnect: sync.needs_reconnect }, { synced: 0, reconnect: true })
    rows = await queue()
    assert.equal(rows[stranded.invoice_number].status, 'pending'); assert.equal(rows[stranded.invoice_number].attempts, 0, 'a dead connection does not burn the row’s attempts')
    assert.match(rows[stranded.invoice_number].error, /Reconnect QuickBooks/)
    assert.equal((await ok('/api/qbo/status')).needs_reconnect, true)
    flag('all-401', null); flag('refresh-dead', null)
    const again = new URL((await ok('/api/qbo/connect')).url).searchParams.get('state')
    assert.equal((await request(`/api/qbo/callback?state=${again}&code=good-code&realmId=9130`)).status, 302)
    assert.equal((await ok('/api/qbo/status')).needs_reconnect, false)
    assert.equal((await ok('/api/qbo/sync-now', {})).synced, 1)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE qbo_id IS NOT NULL AND qbo_id != ''").get().n, 1, 'reconnecting the SAME company keeps its ids — no duplicate customers')

    // --- Xero: a file, in Xero's columns, manager-only
    const csv = await fetch(new URL(`/api/xero/invoices.csv?from=${localDay.slice(0, 8)}01&to=2099-01-01`, server.base), { headers: { Cookie: owner } })
    assert.equal(csv.status, 200); assert.match(csv.headers.get('content-disposition'), /attachment; filename="printshopcrm-xero-invoices-/)
    const lines = (await csv.text()).trim().split('\r\n')
    assert.match(lines[0], /^\*ContactName,EmailAddress,.*\*InvoiceNumber,Reference,\*InvoiceDate,\*DueDate,Total,InventoryItemCode,\*Description,\*Quantity,\*UnitAmount,Discount,\*AccountCode,\*TaxType,TaxAmount,/)
    assert.ok(lines.some((l) => l.includes(first.invoice_number) && l.includes(',Tax on Sales,8.25,')), 'the taxed invoice carries its tax in TaxAmount')
    assert.equal((await fetch(new URL('/api/xero/invoices.csv?from=2099-01-01', server.base), { headers: { Cookie: owner } }).then((r) => r.text())).trim().split('\r\n').length, 1, 'a range with nothing in it is just the header')
    assert.equal((await fetch(new URL('/api/xero/invoices.csv', server.base))).status, 401)

    // --- another shop sees none of it
    const other = await fetch(server.base + '/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shop_name: 'Other Fixture Shop', owner_name: 'Olive Other', owner_email: 'olive-other@example.test', password: 'other-pass-123' }) })
    assert.equal(other.status, 200, 'a second shop can be created to check isolation')
    {
      const otherCookie = other.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
      const theirs = (await request('/api/qbo/status', undefined, 'GET', otherCookie)).body
      assert.deepEqual({ connected: theirs.connected, id: theirs.client_id, secret: theirs.client_secret_set, company: theirs.company_name, ok: theirs.counts.ok }, { connected: false, id: '', secret: false, company: '', ok: 0 })
      assert.equal((await request('/api/qbo/queue', undefined, 'GET', otherCookie)).body.rows.length, 0)
      assert.equal((await request(`/api/qbo/queue/${parked}/retry`, {}, 'POST', otherCookie)).status, 404)
    }

    // --- disconnect clears the keys and tokens, and the queue waits
    await ok('/api/settings/disconnect/quickbooks', {})
    status = await ok('/api/qbo/status')
    assert.deepEqual({ connected: status.connected, id: status.client_id, secret: status.client_secret_set, company: status.company_name }, { connected: false, id: '', secret: false, company: '' })
    for (const key of ['qbo_access_token', 'qbo_refresh_token', 'qbo_client_secret', 'qbo_realm_id']) assert.equal(db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value || '', '', key)
    assert.equal((await request('/api/qbo/sync-now', {})).body.code, 'qbo_not_connected')
    const before = api().length
    const waiting = await order('Waiting tees')
    await ok(`/api/invoices/${waiting.invoice_id}/payments`, { amount: 10, method: 'cash' })
    assert.equal(api().length, before, 'nothing is sent while disconnected')
  } finally {
    await server.close(); db?.close(); rmSync(dir, { recursive: true, force: true })
  }
})
