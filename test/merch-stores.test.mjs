import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHttpTestServer } from './helpers/http-test-server.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

test('merch stores are routed, styled and offered as a task', async () => {
  const app = read('public/js/app.js')
  assert.match(app, /route\(\/\^\\\/stores\$\/, storesView\)/)
  assert.match(app, /route\(\/\^\\\/stores\\\/\(\\d\+\)\$\/, storeDetailView\)/)
  assert.match(app, /href: '\/stores', ico: 'products', name: 'Merch stores'/)
  assert.match(read('public/index.html'), /\/css\/stores\.css\?v=__ASSET_V__/)
  globalThis.document ??= { querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: () => ({}) }
  globalThis.window ??= { addEventListener() {} }
  const { tasksFor } = await import('../public/js/shared/tasks.js')
  assert.ok(tasksFor({}, 'pro').some((t) => t.key === 'store' && t.href === '#/stores?new=1'))
  assert.ok(!tasksFor({}, 'lite').some((t) => t.key === 'store'))
})

test('a team store takes public orders, validates them hard, and becomes one estimate', { timeout: 150000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'psc-merch-')), dest = join(temp, 'demo'), server = await createHttpTestServer()
  let control
  try {
    const built = spawnSync(process.execPath, ['bin/demo.mjs', dest, String(server.port)], { cwd: ROOT, encoding: 'utf8', timeout: 90000 })
    assert.equal(built.status, 0, built.stderr)
    const env = JSON.parse(readFileSync(join(dest, 'demo-env.json'), 'utf8')); env.PSC_TICK_MS = '3600000'
    const slug = readdirSync(join(dest, 'data/tenants'))[0]
    control = new DatabaseSync(join(dest, 'data/control.db')); control.exec('PRAGMA busy_timeout=5000')
    const original = control.prepare("SELECT * FROM members WHERE role='owner' LIMIT 1").get()
    const staffId = Number(control.prepare('INSERT INTO members(tenant_id,name,email,password_hash,role,status) VALUES(?,?,?,?,?,?)')
      .run(original.tenant_id, 'Store staff fixture', 'store-staff@example.test', original.password_hash, 'staff', 'active').lastInsertRowid)
    control.prepare('INSERT INTO sessions(token,tenant_id,member_id,expires_at) VALUES(?,?,?,?)')
      .run('fixture-store-staff', original.tenant_id, staffId, new Date(Date.now() + 3600000).toISOString().replace('T', ' ').slice(0, 19))
    const staff = 'psc_session=fixture-store-staff'
    await server.start({ cwd: dest, env, args: ['--no-warnings', '--import', './bin/demo-network-guard.mjs', 'server.mjs'] })
    const login = await fetch(server.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'dylan@example.test', password: readFileSync(join(dest, 'LOGIN.txt'), 'utf8').match(/Password: (.+)/)[1] }) })
    assert.equal(login.status, 200)
    const owner = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
    const request = async (path, { method = 'GET', body, cookie = owner } = {}) => {
      const r = await fetch(server.base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) })
      const t = await r.text(); let json = null; try { json = JSON.parse(t) } catch { /* html */ }
      return { status: r.status, body: json, text: t }
    }
    const ok = async (...args) => { const r = await request(...args); assert([200, 201].includes(r.status), r.text); return r.body }
    const form = async (path, fields) => {
      const r = await fetch(server.base + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString(), signal: AbortSignal.timeout(10000) })
      return { status: r.status, html: await r.text() }
    }
    const anon = async (path) => { const r = await fetch(server.base + path, { signal: AbortSignal.timeout(10000) }); return { status: r.status, html: await r.text() } }

    const coach = await ok('/api/contacts', { method: 'POST', body: { name: 'Coach Storefixture', company: 'Eagles FC', email: 'coach-store@example.test' } })
    const products = [
      { name: 'Team tee', price: 15, sizes: ['S', 'M', 'L', 'XL', '2XL'], description: 'Navy, 1-color front' },
      { name: 'Hoodie', price: 35, sizes: ['M', 'L'] },
    ]

    // Staff cannot open a store; bad input is refused.
    assert.equal((await request('/api/stores', { method: 'POST', cookie: staff, body: { name: 'Nope', contact_id: coach.id, products } })).status, 403)
    assert.equal((await request('/api/stores', { method: 'POST', body: { name: 'No customer', products } })).status, 400)
    assert.equal((await request('/api/stores', { method: 'POST', body: { name: 'Bad size', contact_id: coach.id, products: [{ name: 'X', price: 5, sizes: ['HUGE'] }] } })).status, 400)
    assert.equal((await request('/api/stores', { method: 'POST', body: { name: 'No products', contact_id: coach.id, products: [] } })).status, 400)
    assert.equal((await request('/api/stores')).status, 200)
    assert.equal((await request('/api/stores', { cookie: staff })).status, 200, 'staff can still see the stores')

    const store = await ok('/api/stores', { method: 'POST', body: { name: 'Eagles Spring Gear', contact_id: coach.id, close_date: '2099-12-31', message: 'Order by Friday!', products } })
    assert.match(store.share_url, new RegExp(`/store/[A-Za-z0-9_-]{16}\\?s=${slug}$`))
    const path = store.share_url.slice(server.base.length)
    const [tee, hoodie] = store.products
    assert.match(tee.id, /^[a-z0-9]{8}$/)

    // Public page renders with no login.
    const pg = await anon(path)
    assert.equal(pg.status, 200)
    assert.match(pg.html, /Eagles Spring Gear/); assert.match(pg.html, /Order by Friday!/); assert.match(pg.html, /Team tee/)
    assert.match(pg.html, /\$15\.00/); assert.match(pg.html, new RegExp(`name="q_${tee.id}_2XL"`)); assert.ok(!pg.html.includes(`q_${hoodie.id}_S"`), 'only the allowed sizes are offered')
    assert.match(pg.html, /Place order/)
    assert.ok(!pg.html.includes('Coach Storefixture'), 'the customer contact is not shown to members')

    const orderPath = path.replace(/\/store\/([^?]+)/, '/store/$1/order')
    // Validation: bad size, missing name, bad email, qty out of range, unknown product, empty order.
    const good = { name: 'Alex Player', email: 'alex@example.test', [`q_${tee.id}_M`]: '2' }
    assert.equal((await form(orderPath, { ...good, [`q_${hoodie.id}_S`]: '1' })).status, 400, 'size not allowed for that product')
    const noName = await form(orderPath, { ...good, name: '' })
    assert.equal(noName.status, 400); assert.match(noName.html, /type your name/); assert.match(noName.html, /value="alex@example.test"/, 'the form keeps what they typed')
    assert.equal((await form(orderPath, { ...good, email: 'not-an-email' })).status, 400)
    assert.equal((await form(orderPath, { ...good, [`q_${tee.id}_M`]: '501' })).status, 400)
    assert.equal((await form(orderPath, { ...good, [`q_${tee.id}_M`]: '-1' })).status, 400)
    assert.equal((await form(orderPath, { name: 'A', email: 'a@example.test' })).status, 400, 'an empty order')
    const json = (body) => request(orderPath, { method: 'POST', cookie: '', body })
    assert.equal((await json({ name: 'A', email: 'a@example.test', items: [{ product_id: 'zzzzzzzz', size: 'M', qty: 1 }] })).status, 400)
    assert.equal((await json({ name: 'A', email: 'a@example.test', items: Array.from({ length: 51 }, () => ({ product_id: tee.id, size: 'M', qty: 1 })) })).status, 400, 'at most 50 lines')
    assert.equal((await json({ name: 'A', email: 'a@example.test', items: [{ product_id: tee.id, size: 'M', qty: 1.5 }] })).status, 400)

    // Real orders.
    const thanks = await form(orderPath, { ...good, [`q_${tee.id}_XL`]: '1', [`q_${hoodie.id}_L`]: '1', note: '#7' })
    assert.equal(thanks.status, 200, thanks.html)
    assert.match(thanks.html, /Thanks, Alex Player/); assert.match(thanks.html, /\$80\.00/, '3 tees at $15 + a $35 hoodie')
    assert.match(thanks.html, /payment/)
    assert.equal((await json({ name: 'Sam Keeper', email: 'sam@example.test', items: [{ product_id: tee.id, size: 'M', qty: 3 }, { product_id: hoodie.id, size: 'M', qty: 2 }] })).status, 200)
    assert.equal((await json({ name: 'Jo Wing', email: 'jo@example.test', items: [{ product_id: tee.id, size: '2XL', qty: 1 }, { product_id: tee.id, size: '2XL', qty: 1 }] })).status, 200)

    const detail = await ok(`/api/stores/${store.id}`)
    assert.equal(detail.order_count, 3); assert.equal(detail.orders.length, 3)
    assert.equal(detail.summary.units, 11)
    assert.deepEqual(detail.summary.products.find((p) => p.name === 'Team tee').sizes, { M: 5, XL: 1, '2XL': 2 })
    assert.deepEqual(detail.summary.products.find((p) => p.name === 'Hoodie').sizes, { M: 2, L: 1 })
    assert.equal(detail.summary.total, 8 * 15 + 3 * 35)
    assert.equal((await ok(`/api/stores/${store.id}/orders`)).orders.length, 3)

    // Tenant isolation: the same key under another shop's ?s= — or with no shop at all — finds nothing.
    const signup = await fetch(server.base + '/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shop_name: 'Other Store Shop', owner_name: 'Other', owner_email: 'other-store-shop@example.test', password: 'Other-store-fixture-pass-1' }) })
    assert.equal(signup.status, 200, await signup.clone().text())
    const otherSlug = (await signup.json()).slug
    assert.ok(otherSlug && otherSlug !== slug)
    const foreign = path.replace(`s=${slug}`, `s=${otherSlug}`)
    assert.equal((await anon(foreign)).status, 404)
    assert.equal((await form(orderPath.replace(`s=${slug}`, `s=${otherSlug}`), good)).status, 404)
    assert.equal((await anon(path.split('?')[0])).status, 404, 'no shop in the link → no store')
    assert.equal((await anon(path.replace(/\/store\/[^?]+/, '/store/AAAAAAAAAAAAAAAA'))).status, 404)

    // Staff cannot turn it into an estimate; a manager can, once.
    assert.equal((await request(`/api/stores/${store.id}/estimate`, { method: 'POST', cookie: staff, body: {} })).status, 403)
    const est = await ok(`/api/stores/${store.id}/estimate`, { method: 'POST', body: {} })
    assert.equal((await request(`/api/stores/${store.id}/estimate`, { method: 'POST', body: {} })).status, 409)
    const e = await ok(`/api/estimates/${est.estimate_id}`)
    assert.equal(e.contact_id, coach.id); assert.equal(e.status, 'draft')
    const line = (n) => e.items.find((i) => i.description === n)
    assert.deepEqual(line('Team tee').sizes, { M: 5, XL: 1, '2XL': 2 })
    assert.equal(line('Team tee').unit_price, 15)
    assert.deepEqual(line('Hoodie').sizes, { M: 2, L: 1 })
    assert.equal(e.subtotal, 8 * 15 + 3 * 35, 'store prices, no 2XL upcharge on top of what members were shown')
    assert.match(e.notes, /Alex Player/)

    // The store closed with it: the public page says so and orders are refused.
    const closed = await anon(path)
    assert.equal(closed.status, 200); assert.match(closed.html, /store is closed/)
    assert.equal((await form(orderPath, good)).status, 400)

    // A store past its close date is closed too, and close/delete need a manager.
    const late = await ok('/api/stores', { method: 'POST', body: { name: 'Last season', contact_id: coach.id, close_date: '2001-01-01', products } })
    const latePath = late.share_url.slice(server.base.length)
    assert.equal(late.is_open, false)
    assert.equal((await form(latePath.replace(/\/store\/([^?]+)/, '/store/$1/order'), { ...good, [`q_${late.products[0].id}_M`]: '1' })).status, 400)
    assert.equal((await request(`/api/stores/${late.id}/close`, { method: 'POST', cookie: staff, body: {} })).status, 403)
    assert.equal((await request(`/api/stores/${late.id}`, { method: 'DELETE', cookie: staff })).status, 403)
    assert.equal((await request(`/api/stores/${late.id}`, { method: 'DELETE' })).status, 200)
    assert.equal((await anon(latePath)).status, 404)
  } finally {
    control?.close()
    await server.close()
    rmSync(temp, { recursive: true, force: true })
  }
})
