import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createHttpTestServer } from './helpers/http-test-server.mjs'

// One link per customer: it must list exactly what that customer's individual /p/ links would show
// — never a neighbour's rows, never a draft the shop has not sent — and refuse every forged,
// stale or cross-shop token with the same "Link expired" page the other /p/ routes use.
test('customer portal lists only this customer’s sent documents and refuses foreign tokens', { timeout: 120000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'psc-portal-')), dest = join(tmp, 'demo'), server = await createHttpTestServer()
  let db
  try {
    const built = spawnSync(process.execPath, ['bin/demo.mjs', dest, String(server.port)], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 90000 })
    assert.equal(built.status, 0, built.stderr)
    const env = JSON.parse(readFileSync(join(dest, 'demo-env.json'), 'utf8'))
    await server.start({ cwd: dest, env, args: ['--no-warnings', '--import', './bin/demo-network-guard.mjs', 'server.mjs'] })
    const login = await fetch(server.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'dylan@example.test', password: readFileSync(join(dest, 'LOGIN.txt'), 'utf8').match(/Password: (.+)/)[1] }) })
    assert.equal(login.status, 200)
    const cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
    const request = (path, { body, method = 'GET', cookie: ck = cookie } = {}) => fetch(new URL(path, server.base), {
      method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(ck ? { Cookie: ck } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000),
    })
    const json = async (path, options) => { const r = await request(path, options); assert([200, 201].includes(r.status), await r.clone().text()); return r.json() }
    const upload = async (path, name) => { const f = new FormData(); f.append('file', new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'], { type: 'image/svg+xml' }), name); const r = await fetch(server.base + path, { method: 'POST', headers: { Cookie: cookie }, body: f }); assert.equal(r.status, 200, await r.clone().text()); return r.json() }
    const anon = async (url) => { const r = await fetch(new URL(url, server.base), { redirect: 'manual' }); return { status: r.status, html: await r.text() } }

    const line = { description: 'Portal fixture tees', decoration: 'Screen Print', sizes: { M: 10 }, unit_price: 12.5, taxable: false }
    const alice = await json('/api/contacts', { method: 'POST', body: { name: 'Alice Portalfixture', company: 'Alice Co', email: 'alice-portal@example.test' } })
    const bob = await json('/api/contacts', { method: 'POST', body: { name: 'Bob Otherfixture', email: 'bob-portal@example.test' } })
    const sentQuote = await json('/api/estimates', { method: 'POST', body: { contact_id: alice.id, items: [line], tax_rate: 0 } })
    const draftQuote = await json('/api/estimates', { method: 'POST', body: { contact_id: alice.id, items: [line], tax_rate: 0 } })
    const bobQuote = await json('/api/estimates', { method: 'POST', body: { contact_id: bob.id, items: [line], tax_rate: 0 } })
    await json('/api/estimates/' + sentQuote.id + '/send', { method: 'POST', body: {} })
    await json('/api/estimates/' + bobQuote.id + '/send', { method: 'POST', body: {} })
    const job = await json('/api/jobs', { method: 'POST', body: { contact_id: alice.id, title: 'Alice league shirts', due_date: '2031-05-04' } })
    const proof = await upload('/api/jobs/' + job.id + '/art', 'alice.svg')
    await json('/api/art/' + proof.id + '/send', { method: 'POST', body: {} })
    const bobJob = await json('/api/jobs', { method: 'POST', body: { contact_id: bob.id, title: 'Bob secret hoodies' } })

    const slug = readdirSync(join(dest, 'data/tenants'))[0]
    db = new DatabaseSync(join(dest, 'data/tenants', slug, 'printshop.db')); db.exec('PRAGMA busy_timeout=5000')
    const inv = (contact, num, due, paid, status = 'unpaid') => db.prepare('INSERT INTO invoices(contact_id, invoice_number, status, amount_due, amount_paid, due_date) VALUES(?,?,?,?,?,?)').run(contact, num, status, due, paid, '2031-01-01').lastInsertRowid
    inv(alice.id, 'PORTAL-OPEN', 1234.5, 234.5)
    inv(alice.id, 'PORTAL-VOID', 999, 0, 'void')
    inv(bob.id, 'PORTAL-BOB', 4321, 0)
    const draftNumber = db.prepare('SELECT estimate_number FROM estimates WHERE id=?').get(draftQuote.id).estimate_number
    const bobNumber = db.prepare('SELECT estimate_number FROM estimates WHERE id=?').get(bobQuote.id).estimate_number
    const sentNumber = db.prepare('SELECT estimate_number FROM estimates WHERE id=?').get(sentQuote.id).estimate_number

    // Staff mint the link; it is stable across calls and absolute.
    const { url } = await json('/api/contacts/' + alice.id + '/portal-link')
    assert.match(url, new RegExp(`^${server.base}/p/account/${alice.id}\\?k=[0-9a-f]{16}&s=${slug}$`))
    assert.equal((await json('/api/contacts/' + alice.id + '/portal-link')).url, url)
    assert.equal((await request('/api/contacts/999999/portal-link')).status, 404)
    assert.equal((await request('/api/contacts/' + alice.id + '/portal-link', { cookie: '' })).status, 401, 'staff-only endpoint')

    const page = await anon(url)
    assert.equal(page.status, 200)
    const html = page.html
    assert.match(html, /Alice Portalfixture/); assert.match(html, /Alice Co/)
    assert.match(html, new RegExp(sentNumber)); assert.match(html, /Review &amp; approve/)
    assert.ok(!html.includes(draftNumber), 'a draft the shop never sent must not leak')
    assert.match(html, /PORTAL-OPEN/); assert.ok(!html.includes('PORTAL-VOID'), 'void invoices owe nothing and are not listed')
    assert.match(html, /\$1,000\.00/, 'balance through the shop money formatter'); assert.match(html, /\$1,234\.50/)
    assert.match(html, /Alice league shirts/); assert.match(html, /proof v1/); assert.match(html, /Review proof/)
    assert.match(html, /class="pt-steps"/); assert.match(html, /aria-current="step"><span>Art Approval/)
    for (const foreign of ['Bob Otherfixture', 'PORTAL-BOB', bobNumber, 'Bob secret hoodies', '$4,321.00']) assert.ok(!html.includes(foreign), `another customer's row leaked: ${foreign}`)

    // Every link on the portal is one of the existing /p/ links and opens as such.
    const links = [...html.matchAll(/href="(\/p\/(?:estimate|art|pay)\/\d+\?k=[0-9a-f]{16}(?:&amp;s=[^"]+)?)"/g)].map(m => m[1].replaceAll('&amp;', '&'))
    assert.ok(links.some(l => l.startsWith('/p/estimate/' + sentQuote.id)) && links.some(l => l.startsWith('/p/art/' + proof.id)) && links.some(l => l.startsWith('/p/pay/')))
    for (const l of links) assert.equal((await anon(l)).status, 200, l)
    // …and those pages link back to the portal.
    const est = await anon(links.find(l => l.startsWith('/p/estimate/')))
    assert.ok(est.html.includes(`href="${url.slice(server.base.length).replace('&', '&amp;')}">All your orders`), 'estimate page links to the portal')
    assert.match((await anon(links.find(l => l.startsWith('/p/art/')))).html, /All your orders/)
    assert.match((await anon(links.find(l => l.startsWith('/p/pay/')))).html, /All your orders/)

    // Forged, swapped and stripped tokens all get the expired page.
    const k = new URL(url).searchParams.get('k')
    const bobUrl = (await json('/api/contacts/' + bob.id + '/portal-link')).url
    for (const bad of [url.replace(k, '0'.repeat(16)), url.replace('/p/account/' + alice.id, '/p/account/' + bob.id), `/p/account/${alice.id}?s=${slug}`, url.replace(`&s=${slug}`, ''), bobUrl.replace(new URL(bobUrl).searchParams.get('k'), k)]) {
      const r = await anon(bad); assert.equal(r.status, 403, bad); assert.match(r.html, /Link expired/); assert.ok(!r.html.includes('Alice'))
    }
    assert.equal((await anon(url.replace('?k=', '?t='))).status, 200, '?t= is accepted as an alias of ?k=')

    // Another shop: Alice's token replayed under its slug is refused, and its staff cannot mint
    // a link for an id that only exists in the first shop.
    const neighbor = await request('/api/auth/signup', { method: 'POST', cookie: '', body: { shop_name: 'Portal neighbor', owner_name: 'Neighbor', owner_email: 'portal-neighbor@example.test', password: 'Portal-neighbor-fixture-1' } })
    assert.equal(neighbor.status, 200, await neighbor.clone().text())
    const neighborCookie = neighbor.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
    const neighborSlug = readdirSync(join(dest, 'data/tenants')).find(s => s !== slug)
    assert.ok(neighborSlug)
    const cross = await anon(url.replace(`s=${slug}`, `s=${neighborSlug}`))
    assert.equal(cross.status, 403); assert.ok(!cross.html.includes('Alice'))
    const neighborMint = await request('/api/contacts/' + alice.id + '/portal-link', { cookie: neighborCookie })
    if (neighborMint.status === 200) {
      const other = (await neighborMint.json()).url
      assert.notEqual(other, url); assert.ok(!(await anon(other)).html.includes('Alice Portalfixture'))
    } else assert.equal(neighborMint.status, 404)

    // Deleting the customer kills the key: the old link cannot open whoever reuses the rowid.
    const carol = await json('/api/contacts', { method: 'POST', body: { name: 'Carol Shortlived' } })
    const carolUrl = (await json('/api/contacts/' + carol.id + '/portal-link')).url
    assert.equal((await anon(carolUrl)).status, 200)
    await json('/api/contacts/' + carol.id, { method: 'DELETE' })
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customer_portal_keys WHERE contact_id=?').get(carol.id).n, 0)
    assert.equal((await anon(carolUrl)).status, 403)
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  } finally {
    db?.close(); await server.close(); rmSync(tmp, { recursive: true, force: true })
  }
})
