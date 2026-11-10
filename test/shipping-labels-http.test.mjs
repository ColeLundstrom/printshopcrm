import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHttpTestServer } from './helpers/http-test-server.mjs'

const FAKE = fileURLToPath(new URL('./fixtures/fake-easypost.mjs', import.meta.url))

test('shipping labels over HTTP: one purchase per label, private files, shop and role boundaries', { timeout: 150000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'psc-labels-http-')), dest = join(temp, 'demo')
  const log = join(temp, 'easypost.jsonl'), ctl = join(temp, 'ctl.json')
  writeFileSync(ctl, '{}'); writeFileSync(log, '')
  const server = await createHttpTestServer()
  let db, control
  try {
    const built = spawnSync(process.execPath, ['bin/demo.mjs', dest, String(server.port)], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 90000 })
    assert.equal(built.status, 0, built.stderr)
    const env = { ...JSON.parse(readFileSync(join(dest, 'demo-env.json'), 'utf8')), PSC_TICK_MS: '3600000', FAKE_EASYPOST_LOG: log, FAKE_EASYPOST_CTL: ctl }
    // The demo guard cuts every outbound connection; the fake then answers EasyPost's two hosts and
    // nothing else, so this test cannot reach a real carrier whatever it does.
    await (async () => {
      control = new DatabaseSync(join(dest, 'data/control.db')); control.exec('PRAGMA busy_timeout=5000')
      const member = control.prepare('SELECT * FROM members LIMIT 1').get()
      const id = Number(control.prepare('INSERT INTO members(tenant_id,name,email,password_hash,role,status) VALUES(?,?,?,?,?,?)')
        .run(member.tenant_id, 'Sam label fixture', 'sam-labels@example.test', member.password_hash, 'staff', 'active').lastInsertRowid)
      control.prepare('INSERT INTO sessions(token,tenant_id,member_id,expires_at) VALUES(?,?,?,?)')
        .run('fixture-labels-' + id, member.tenant_id, id, new Date(Date.now() + 3600000).toISOString().replace('T', ' ').slice(0, 19))
      control.staff = 'psc_session=fixture-labels-' + id
    })()
    await server.start({ cwd: dest, env, args: ['--no-warnings', '--import', './bin/demo-network-guard.mjs', '--import', FAKE, 'server.mjs'] })
    db = new DatabaseSync(join(dest, 'data/tenants', readdirSync(join(dest, 'data/tenants'))[0], 'printshop.db'))
    db.exec('PRAGMA busy_timeout=5000')
    const login = await fetch(server.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'dylan@example.test', password: readFileSync(join(dest, 'LOGIN.txt'), 'utf8').match(/Password: (.+)/)[1] }) })
    assert.equal(login.status, 200)
    const owner = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '), staff = control.staff
    const raw = (path, { body, method = body === undefined ? 'GET' : 'POST', cookie = owner } = {}) => fetch(server.base + path, { method, redirect: 'manual',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) })
    const call = async (path, opts) => { const r = await raw(path, opts); const text = await r.text(); let json = null; try { json = JSON.parse(text) } catch { /* not json */ } return { status: r.status, body: json, text } }
    const purchases = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.kind === 'purchase').length
    const apiCalls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).length

    // Setup is manager-only and the key is write-only.
    assert.equal((await call('/api/shipping/labels/setup', { method: 'PUT', body: { api_key: 'EZAKlive0000000000' }, cookie: staff })).status, 403)
    assert.equal((await call('/api/shipping/labels/setup', { cookie: '' })).status, 401)
    const saved = await call('/api/shipping/labels/setup', { method: 'PUT', body: { api_key: 'EZAKlive0000000000', ship_from: { company: 'Fixture Press', street1: '900 Print Way', city: 'Dallas', state: 'TX', zip: '75201' } } })
    assert.equal(saved.status, 200, saved.text); assert.equal(saved.body.connected, true); assert.equal(saved.body.key_mode, 'production')
    for (const path of ['/api/shipping/labels/setup', '/api/settings']) assert.ok(!(await call(path)).text.includes('EZAKlive'), `${path} must not return the key`)
    const tested = await call('/api/shipping/labels/setup/test', { body: {} })
    assert.equal(tested.status, 200, tested.text); assert.match(tested.body.message, /live key/)

    const job = db.prepare("SELECT id FROM jobs WHERE status='active' ORDER BY id LIMIT 1").get().id
    db.prepare('UPDATE jobs SET shipping_address=? WHERE id=?').run('Val Stone\n44 Maple Ave\nAustin, TX 78701', job)
    const view = await call(`/api/production/jobs/${job}/labels`)
    assert.equal(view.status, 200, view.text); assert.equal(view.body.ship_to.street1, '44 Maple Ave'); assert.equal(view.body.can_buy, true)
    // Staff with no shipping task on this job can look, and cannot rate or buy.
    const staffView = await call(`/api/production/jobs/${job}/labels`, { cookie: staff })
    assert.equal(staffView.status, 200); assert.equal(staffView.body.can_buy, false)
    const before = apiCalls()
    assert.equal((await call(`/api/production/jobs/${job}/labels/rates`, { body: { request_id: 'http-staff-00000001', to: view.body.ship_to, boxes: [{ weight_lb: 1 }] }, cookie: staff })).status, 403)
    assert.equal(apiCalls(), before, 'a refused request never reaches the carrier')

    const rates = { request_id: 'http-rates-00000001', to: view.body.ship_to, boxes: [{ weight_lb: 3, length: 12, width: 9, height: 3 }] }
    const [r1, r2] = await Promise.all([call(`/api/production/jobs/${job}/labels/rates`, { body: rates }), call(`/api/production/jobs/${job}/labels/rates`, { body: rates })])
    assert.equal(r1.status, 200, r1.text); assert.equal(r2.status, 200, r2.text)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM shipping_labels').get().n, 1, 'a doubled rate request makes one row')
    const label = r1.body.labels.find((l) => l.id === r1.body.rated[0]), rate = label.rates.find((x) => x.cheapest)
    assert.equal(rate.price_cents, 845)

    assert.equal((await call(`/api/shipping/labels/${label.id}/buy`, { body: { rate_id: rate.id, confirm_price_cents: rate.price_cents }, cookie: staff })).status, 403)
    // Double click over HTTP.
    const buy = { rate_id: rate.id, confirm_price_cents: rate.price_cents }
    const [b1, b2] = await Promise.all([call(`/api/shipping/labels/${label.id}/buy`, { body: buy }), call(`/api/shipping/labels/${label.id}/buy`, { body: buy })])
    assert.equal(b1.status, 200, b1.text); assert.equal(b2.status, 200, b2.text)
    assert.equal(purchases(), 1, 'two simultaneous Buy requests are one purchase')
    assert.equal((await call(`/api/shipping/labels/${label.id}/buy`, { body: buy })).body.replayed, true); assert.equal(purchases(), 1)
    const bought = b1.body.label
    assert.equal(bought.status, 'bought'); assert.equal(bought.test, false); assert.equal(bought.recorded, true)
    const records = db.prepare('SELECT * FROM shipping_records WHERE job_id=?').all(job)
    assert.equal(records.length, 1); assert.equal(records[0].tracking_number, bought.tracking_code)
    assert.equal(db.prepare("SELECT COUNT(*) n FROM email_log WHERE kind='shipping'").get().n, 0, 'buying a label mails nobody')

    // The label file: the shop's signed-in members only, never the public uploads path.
    const file = db.prepare('SELECT label_file f FROM shipping_labels WHERE id=?').get(label.id).f
    assert.ok(existsSync(join(dest, 'public/uploads', file)))
    const png = await raw(`/api/shipping/labels/${label.id}/file`)
    assert.equal(png.status, 200); assert.equal(png.headers.get('content-type'), 'image/png'); assert.equal(png.headers.get('x-content-type-options'), 'nosniff'); assert.match(png.headers.get('cache-control'), /no-store/)
    assert.equal(Buffer.from(await png.arrayBuffer()).subarray(1, 4).toString(), 'PNG')
    assert.equal((await raw(`/api/shipping/labels/${label.id}/file`, { cookie: '' })).status, 401)
    assert.equal((await raw(`/uploads/${file}`)).status, 404, 'the generic uploads path does not serve labels, even to the owner')
    assert.equal((await raw(`/uploads/${file}`, { cookie: '' })).status, 404)
    const print = await call(`/api/shipping/labels/${label.id}/print`)
    assert.equal(print.status, 200); assert.ok(!print.text.includes('TEST LABEL'), 'a live label carries no test mark'); assert.ok(print.text.includes(bought.tracking_code))

    // Another shop on the same server sees no key, no label and no file.
    const signup = await raw('/api/auth/signup', { cookie: '', body: { shop_name: 'Neighbor label fixture', owner_name: 'Other owner', owner_email: 'labels-neighbor@example.test', password: 'Labels-neighbor-fixture-1' } })
    assert.equal(signup.status, 200, await signup.clone().text())
    const neighbor = signup.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
    assert.equal((await call('/api/shipping/labels/setup', { cookie: neighbor })).body.connected, false)
    for (const path of [`/api/shipping/labels/${label.id}/file`, `/api/shipping/labels/${label.id}/print`]) assert.equal((await raw(path, { cookie: neighbor })).status, 404, path)
    for (const action of ['buy', 'track', 'void', 'notify', 'check', 'discard']) assert.equal((await call(`/api/shipping/labels/${label.id}/${action}`, { body: { reason: 'x', ...buy }, cookie: neighbor })).status, 404, action)
    assert.equal((await raw(`/uploads/${file}`, { cookie: neighbor })).status, 404)
    assert.equal(purchases(), 1)

    // Void: staff refused, manager accepted once; the ledger entry is voided with it.
    assert.equal((await call(`/api/shipping/labels/${label.id}/void`, { body: { reason: 'wrong box' }, cookie: staff })).status, 403)
    const voided = await call(`/api/shipping/labels/${label.id}/void`, { body: { reason: 'Customer changed the address' } })
    assert.equal(voided.status, 200, voided.text); assert.equal(voided.body.label.status, 'void_requested')
    assert.equal(db.prepare('SELECT status FROM shipping_records WHERE id=?').get(records[0].id).status, 'void')

    // A test key marks everything TEST and writes nothing to the ledger.
    assert.equal((await call('/api/shipping/labels/setup', { method: 'PUT', body: { api_key: 'EZTKtest0000000000' } })).body.key_mode, 'test')
    const t = await call(`/api/production/jobs/${job}/labels/rates`, { body: { ...rates, request_id: 'http-rates-00000002' } })
    const tl = t.body.labels.find((l) => l.id === t.body.rated[0]), tr = tl.rates.find((x) => x.cheapest)
    assert.equal(tl.test, true)
    const tb = await call(`/api/shipping/labels/${tl.id}/buy`, { body: { rate_id: tr.id, confirm_price_cents: tr.price_cents } })
    assert.equal(tb.status, 200, tb.text); assert.equal(tb.body.label.test, true); assert.equal(tb.body.label.recorded, false)
    assert.equal(db.prepare("SELECT COUNT(*) n FROM shipping_records WHERE job_id=? AND status!='void'").get(job).n, 0)
    assert.match((await call(`/api/shipping/labels/${tl.id}/print`)).text, /TEST LABEL<br>NOT VALID POSTAGE/)
    assert.match((await raw(`/api/shipping/labels/${tl.id}/file`)).headers.get('content-disposition'), /TEST-label/)
    assert.equal((await call(`/api/shipping/labels/${tl.id}/notify`, { body: {} })).status, 409)

    // A carrier outage and a rejected key are sentences, not stack traces.
    writeFileSync(ctl, JSON.stringify({ all: 'timeout' }))
    const down = await call(`/api/production/jobs/${job}/labels/rates`, { body: { ...rates, request_id: 'http-rates-00000003' } })
    assert.equal(down.status, 502); assert.match(down.body.error, /did not answer in time/)
    writeFileSync(ctl, JSON.stringify({ key: 'reject' }))
    const rejected = await call(`/api/production/jobs/${job}/labels/rates`, { body: { ...rates, request_id: 'http-rates-00000004' } })
    assert.equal(rejected.status, 400); assert.match(rejected.body.error, /did not accept this API key/)
    writeFileSync(ctl, '{}')
    const disconnected = await call('/api/shipping/labels/setup/disconnect', { body: {} })
    assert.equal(disconnected.body.connected, false)
    assert.equal(db.prepare("SELECT value FROM settings WHERE key='easypost_api_key'").get()?.value || '', '')
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  } finally {
    await server.close(); db?.close(); control?.close(); rmSync(temp, { recursive: true, force: true })
  }
})
