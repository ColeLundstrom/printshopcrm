import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHttpTestServer } from './helpers/http-test-server.mjs'

/*
 * The server halves of the trade-show UI pass:
 *  - GET /api/invoices/:id names the estimate it came from (the "From estimate →" link was blank)
 *  - Request Payment says whether email is really connected, so the toast cannot claim a delivery
 *  - /api/auth/me carries the preferred department, so boot no longer loads the whole queue for it
 *  - a stylesheet or app.js requested with the shell's exact ?v= stamp is cached as immutable,
 *    while views (no stamp), html and a stale stamp keep revalidating
 */
test('invoice estimate number, honest payment-link delivery, preferred department and stamped asset caching', { timeout: 180000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'psc-ui-polish-')), dest = join(temp, 'demo'), server = await createHttpTestServer()
  try {
    const built = spawnSync(process.execPath, ['bin/demo.mjs', dest, String(server.port)], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 120000 })
    assert.equal(built.status, 0, built.stderr)
    const env = JSON.parse(readFileSync(join(dest, 'demo-env.json'), 'utf8')); env.PSC_TICK_MS = '3600000'
    const control = new DatabaseSync(join(dest, 'data/control.db'))
    const owner = control.prepare("SELECT * FROM members WHERE role='owner' LIMIT 1").get()
    control.prepare("INSERT INTO sessions(token,tenant_id,member_id,expires_at) VALUES('ui-polish-owner',?,?,datetime('now','+1 hour'))").run(owner.tenant_id, owner.id)
    control.close()
    await server.start({ cwd: dest, env, args: ['--no-warnings', '--import', './bin/demo-network-guard.mjs', 'server.mjs'] })
    const call = (path, body, method = body === undefined ? 'GET' : 'POST') => fetch(server.base + path, {
      method, headers: { 'Content-Type': 'application/json', cookie: 'psc_session=ui-polish-owner' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
    })
    const ok = async (path, body, method) => { const r = await call(path, body, method); assert.equal(r.status, 200, await r.clone().text()); return r.json() }

    // 1. The invoice detail carries the number of the estimate it was converted from.
    const customer = await ok('/api/contacts', { name: 'Polish fixture', email: 'polish@example.test' })
    const estimate = await ok('/api/estimates', { contact_id: customer.id, items: [{ description: 'Example tees', sizes: { M: 12 }, unit_price: 10 }], tax_rate: 0 })
    const converted = await ok(`/api/estimates/${estimate.id}/convert`, { payment_due_date: '2027-03-12', production_due_date: '2027-02-12' })
    const inv = { id: converted.invoice_id ?? converted.invoice?.id }
    assert.ok(inv.id, JSON.stringify(converted))
    const detail = await ok(`/api/invoices/${inv.id}`)
    assert.ok(estimate.estimate_number)
    assert.equal(detail.estimate_number, estimate.estimate_number)

    // 2. With no shop SMTP, Request Payment must report email_live:false (the client then says
    //    "copy the pay link" instead of "Payment link emailed").
    await ok('/api/settings', { smtp_host: '', smtp_user: '', smtp_pass: '' }, 'PUT')
    const reqPay = await ok(`/api/invoices/${inv.id}/request-payment`, { recipient_revision: detail.recipient_revision })
    assert.equal(reqPay.email_live, false)
    assert.equal(typeof reqPay.delivered, 'boolean')

    // 3. The member's preferred department rides on /api/auth/me.
    let me = await ok('/api/auth/me')
    assert.equal(me.preferred_department, '')
    await ok('/api/production/preference', { department: 'Screen printing' }, 'PUT')
    me = await ok('/api/auth/me')
    assert.equal(me.preferred_department, 'Screen printing')

    // 4. Asset caching. The shell's stamp comes from the shell itself.
    const shell = await (await call('/')).text()
    const stamp = /\/css\/app\.css\?v=([^"']+)/.exec(shell)?.[1]
    assert.ok(stamp && stamp !== '__ASSET_V__', 'the shell stamps a version onto its stylesheets')
    assert.match(shell, new RegExp(`/js/app\\.js\\?v=${stamp}`), 'app.js carries the same stamp')
    for (const path of [`/css/app.css?v=${stamp}`, `/css/calendar.css?v=${stamp}`, `/js/app.js?v=${stamp}`]) {
      const r = await call(path); assert.equal(r.status, 200, path)
      assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable', path)
    }
    for (const path of ['/css/app.css', '/css/app.css?v=stale', '/js/views/board.js', '/js/core.js']) {
      const r = await call(path); assert.equal(r.status, 200, path)
      assert.equal(r.headers.get('cache-control'), 'no-cache', `${path} must keep revalidating`)
    }
  } finally {
    await server.close()
    rmSync(temp, { recursive: true, force: true })
  }
})
