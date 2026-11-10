import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseShipTo } from '../lib/shipping-labels.mjs'
import { easypost } from '../lib/label-provider-easypost.mjs'
import { installFakeEasyPost } from './fixtures/fake-easypost.mjs'

const root = new URL('..', import.meta.url)

/** Run `code` in a fresh process: in-memory shop database, fake EasyPost, a temp uploads directory. */
function child(code, env = {}) {
  const uploads = mkdtempSync(join(tmpdir(), 'psc-labels-'))
  const prelude = `
    import assert from 'node:assert/strict'
    import { readdirSync, readFileSync } from 'node:fs'
    const lib = (f) => import(new URL('lib/' + f, ${JSON.stringify(root.href)}).href)
    const { installFakeEasyPost } = await import(new URL('test/fixtures/fake-easypost.mjs', ${JSON.stringify(root.href)}).href)
    const fake = installFakeEasyPost()
    const db = await lib('db.mjs'), L = await lib('shipping-labels.mjs')
    const uploads = ${JSON.stringify(uploads)}
    const sent = [], notes = []
    const deps = { uploads, money: (n) => '$' + Number(n).toFixed(2), rtBroadcast() {}, logActivity: (k, t) => notes.push(t), queueEmail: (m) => sent.push(m) }
    const boss = { id: null, name: 'Morgan Owner', manager: true }
    db.run("INSERT INTO contacts (name, company, email, phone, created_at, updated_at) VALUES ('Jamie Rivera','Lakeside High','jamie@example.test','512-555-0100',datetime('now'),datetime('now'))")
    db.run("INSERT INTO jobs (contact_id, job_number, title, status, stage, sizes, shipping_address, created_at, updated_at) VALUES (1,'JOB-1001','Spirit tees','active','shipping','{}',?,datetime('now'),datetime('now'))", 'Jamie Rivera\\nLakeside High\\n12 Elm St\\nSuite 4\\nAustin, TX 78701')
    const connect = (key = 'EZAKlive0000000000') => L.saveLabelSetup({ api_key: key, ship_from: { company: 'Rebel Ink Press', street1: '900 Print Way', city: 'Dallas', state: 'tx', zip: '75201', phone: '214-555-0100' } })
    const to = () => L.jobLabels(1, boss).ship_to
    const rid = (s) => 'req-' + s + '-00000000'
    const row = (id) => db.get('SELECT * FROM shipping_labels WHERE id=?', id)
    const purchases = () => fake.calls.filter((c) => c.kind === 'purchase').length
    const buyCalls = () => fake.calls.filter((c) => c.kind === 'api' && /\\/buy$/.test(c.path)).length
    const ledger = () => db.all('SELECT * FROM shipping_records ORDER BY id')
    const rate = async (tag, boxes = [{ weight_lb: 2, weight_oz: 4, length: 12, width: 10, height: 4 }]) => (await L.rateBoxes(1, { request_id: rid(tag), to: to(), boxes }, boss)).rated
    const cheapest = (id) => JSON.parse(row(id).rates)[0]
    const rejects = async (p, re) => { let e = null; try { await p } catch (x) { e = x } assert.ok(e, 'expected a refusal'); if (typeof re === 'function') assert.ok(re(e), e.message); else if (re) assert.match(e.message + ' ' + (e.code || ''), re); return e }
  `
  try {
    const run = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', prelude + code], {
      env: { ...process.env, PSC_DB: ':memory:', TZ: 'UTC', ...env }, encoding: 'utf8', timeout: 60000,
    })
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`)
  } finally { rmSync(uploads, { recursive: true, force: true }) }
}

test('a typed ship-to address is read into the parts a carrier needs', () => {
  const a = parseShipTo('Jamie Rivera\nLakeside High\n12 Elm St\nSuite 4\nAustin, TX 78701', { phone: '512-555-0100' })
  assert.deepEqual([a.name, a.company, a.street1, a.street2, a.city, a.state, a.zip, a.country], ['Jamie Rivera', 'Lakeside High', '12 Elm St', 'Suite 4', 'Austin', 'TX', '78701', 'US'])
  const b = parseShipTo('PO Box 12\nSalt Lake City UT 84101-1234\nUSA', { name: 'Val Stone' })
  assert.deepEqual([b.name, b.street1, b.city, b.state, b.zip, b.country], ['Val Stone', 'PO Box 12', 'Salt Lake City', 'UT', '84101-1234', 'US'])
  const c = parseShipTo('Maple Print Co\n88 King St W\nToronto, ON M5H 1J9\nCanada', {})
  assert.deepEqual([c.street1, c.city, c.state, c.zip, c.country], ['88 King St W', 'Toronto', 'ON', 'M5H 1J9', 'CA'])
  const none = parseShipTo('ask the customer', { name: 'Val' })
  assert.equal(none.city, '', 'an address it cannot read is left for a person to fill in')
  assert.equal(parseShipTo('', {}).street1, '')
})

test('EasyPost answers are mapped to rates, and its refusals to sentences a shop can act on', async () => {
  const fake = installFakeEasyPost()
  try {
    const from = { company: 'Rebel Ink', street1: '900 Print Way', city: 'Dallas', state: 'TX', zip: '75201', country: 'US' }
    const to = { name: 'Jamie', street1: '12 Elm St', city: 'Austin', state: 'TX', zip: '78701', country: 'US' }
    const r = await easypost.rates({ key: 'EZTKtest0000000000', from, to, parcel: { weight_oz: 36, length: 12, width: 10, height: 4 }, reference: 'JOB-1' })
    assert.equal(r.mode, 'test')
    assert.deepEqual(r.rates.map((x) => x.price_cents), [845, 1120, 1290, 2410, 3850], 'cheapest first, in cents')
    assert.deepEqual(r.rates[0], { id: r.rates[0].id, carrier: 'USPS', service: 'GroundAdvantage', price_cents: 845, currency: 'USD', days: 3 })
    const sent = fake.calls.find((c) => c.path === '/shipments' && c.method === 'POST').body.shipment
    assert.equal(sent.parcel.weight, 36, 'weight goes out in ounces')
    assert.equal(sent.to_address.zip, '78701')
    assert.equal(easypost.keyMode('EZTKabc'), 'test'); assert.equal(easypost.keyMode('EZAKabc'), 'production')

    await assert.rejects(easypost.rates({ key: 'EZTKtest0000000000', from, to: { ...to, zip: '00000' }, parcel: { weight_oz: 8 } }), (e) => e.code === 'label_address' && /could not use that address/.test(e.message) && e.status === 400)
    await assert.rejects(easypost.rates({ key: 'EZTK_REJECT_000000', from, to, parcel: { weight_oz: 8 } }), (e) => e.code === 'label_key_rejected')
    fake.ctl.rates = 'timeout'
    await assert.rejects(easypost.rates({ key: 'EZTKtest0000000000', from, to, parcel: { weight_oz: 8 } }), (e) => e.code === 'label_provider_unreachable' && e.uncertain === true)
    fake.ctl.rates = ''; fake.ctl.buy = 'funds'
    await assert.rejects(easypost.buy({ key: 'EZTKtest0000000000', shipment_id: r.shipment_id, rate_id: r.rates[0].id }), (e) => e.code === 'label_funds' && /Nothing was bought/.test(e.message))
    await assert.rejects(easypost.rates({ key: 'not a key', from, to, parcel: { weight_oz: 8 } }), (e) => e.code === 'label_not_connected')
    // The label file is only ever fetched from EasyPost's own file hosts, over https.
    for (const bad of ['http://easypost-files.s3.us-west-2.amazonaws.com/x.png', 'https://169.254.169.254/latest/meta-data', 'https://evil.example/easypost-files.s3.amazonaws.com.png', 'https://easypost-files.s3.us-west-2.amazonaws.com.evil.example/x.png', 'https://user:pw@easypost-files.s3.us-west-2.amazonaws.com/x.png'])
      await assert.rejects(easypost.downloadLabel(bad), (e) => e.code === 'label_file', bad)
    const before = fake.calls.length
    await assert.rejects(easypost.downloadLabel('https://localhost/x.png'))
    assert.equal(fake.calls.length, before, 'a refused host is never contacted')
    fake.ctl.file = 'html'
    await assert.rejects(easypost.downloadLabel('https://easypost-files.s3.us-west-2.amazonaws.com/files/a.png'), /not a PNG/)
  } finally { fake.restore() }
})

test('a label is rated, bought once, saved, written to the ledger once, tracked and voided', { timeout: 90000 }, () => {
  child(`
    await rejects(L.rateBoxes(1, { request_id: rid('a'), to: to(), boxes: [{ weight_lb: 1 }] }, boss), /Connect a shipping label account/)
    connect()
    const setup = L.labelSetup(boss)
    assert.equal(setup.connected, true); assert.equal(setup.key_mode, 'production'); assert.equal(setup.ship_from.state, 'TX')
    assert.ok(!JSON.stringify(setup).includes('EZAK'), 'the key never leaves the server')
    assert.ok(!JSON.stringify(db.publicSettings()).includes('EZAKlive'), 'publicSettings redacts it too')

    // Rating: validation first, then one provider shipment per box.
    await rejects(L.rateBoxes(1, { request_id: rid('bad'), to: { ...to(), zip: '787' }, boxes: [{ weight_lb: 1 }] }, boss), /five digits/)
    await rejects(L.rateBoxes(1, { request_id: rid('bad'), to: to(), boxes: [{}] }, boss), /needs a weight/)
    await rejects(L.rateBoxes(1, { request_id: rid('bad'), to: to(), boxes: [{ weight_lb: 1, length: 10 }] }, boss), /all three dimensions/)
    assert.equal(fake.calls.length, 0, 'nothing reaches the carrier until the form is valid')
    await rejects(L.rateBoxes(1, { request_id: rid('zz'), to: { ...to(), zip: '00000' }, boxes: [{ weight_lb: 1 }] }, boss), /could not use that address/)
    const [a, b] = await rate('two', [{ weight_lb: 2, weight_oz: 4, length: 12, width: 10, height: 4 }, { weight_lb: 12 }])
    assert.equal(row(a).status, 'rated'); assert.equal(row(b).box, 2)
    assert.equal(JSON.parse(row(b).rates)[0].price_cents, 1445, 'the heavier box has its own prices')
    const again = await rate('two', [{ weight_lb: 2, weight_oz: 4, length: 12, width: 10, height: 4 }, { weight_lb: 12 }])
    assert.deepEqual(again, [a, b], 'the same request answers with the same rows')
    assert.equal(fake.shipments.size, 2, '…and rates nothing twice')
    const view = L.jobLabels(1, boss).labels[0]
    assert.equal(view.rates.find((r) => r.cheapest).service, 'GroundAdvantage')
    assert.equal(view.rates.find((r) => r.fastest).service, 'Express')
    assert.equal(L.labelSetup(boss).parcel_default.length, 12, 'the last box typed is the next default')

    // Buying needs the rate that was on screen at the price that was on screen.
    const r = cheapest(a)
    await rejects(L.buyLabel(a, { rate_id: 'rate_nope', confirm_price_cents: r.price_cents }, boss, deps), /Choose one of the rates/)
    await rejects(L.buyLabel(a, { rate_id: r.id, confirm_price_cents: r.price_cents - 1 }, boss, deps), /label_price_changed/)
    assert.equal(buyCalls(), 0)

    // Double click: two calls in the same instant are one purchase.
    const [one, two] = await Promise.all([L.buyLabel(a, { rate_id: r.id, confirm_price_cents: r.price_cents }, boss, deps), L.buyLabel(a, { rate_id: r.id, confirm_price_cents: r.price_cents }, boss, deps)])
    assert.equal(purchases(), 1); assert.equal(buyCalls(), 1)
    assert.equal(one.label.status, 'bought'); assert.equal(two.replayed, true)
    // …and a replay after the fact buys nothing either.
    const replay = await L.buyLabel(a, { rate_id: r.id, confirm_price_cents: r.price_cents }, boss, deps)
    assert.equal(replay.replayed, true); assert.equal(buyCalls(), 1)

    const bought = row(a)
    assert.equal(bought.mode, 'production'); assert.equal(bought.price_cents, 845); assert.match(bought.tracking_code, /^94/)
    assert.match(bought.label_file, /^label-[a-f0-9]{36}\\.png$/)
    assert.deepEqual(readdirSync(uploads), [bought.label_file], 'the label image is saved here, not hot-linked')
    assert.equal(readFileSync(uploads + '/' + bought.label_file).subarray(1, 4).toString(), 'PNG')
    assert.equal(ledger().length, 1, 'one ledger entry')
    assert.equal(ledger()[0].tracking_number, bought.tracking_code); assert.equal(ledger()[0].carrier, 'USPS Ground Advantage'); assert.equal(ledger()[0].kind, 'parcel')
    assert.equal(ledger()[0].dispatched_on, '', 'buying a label is not dispatch')
    assert.equal(bought.shipment_id, ledger()[0].id)
    assert.equal(db.all('SELECT * FROM shipping_events').length, 1)
    assert.equal(sent.length, 0, 'buying a label does not message the customer')

    // Tracking on view, cached on the row.
    const t = await L.refreshLabel(a, boss, deps)
    assert.equal(t.label.tracking.status, 'pre_transit'); assert.equal(t.label.tracking_stale, false); assert.match(t.label.tracking_url, /^https:\\/\\/track\\.easypost\\.com\\//)
    assert.equal(ledger().length, 1, 'refreshing does not write the ledger again')

    // Emailing tracking is its own action, once.
    const m1 = L.emailTracking(a, boss, deps), m2 = L.emailTracking(a, boss, deps)
    assert.equal(sent.length, 1); assert.equal(m2.replayed, true); assert.ok(m1.label.notified_at)
    assert.equal(sent[0].vars.tracking_number, bought.tracking_code); assert.equal(sent[0].contact.email, 'jamie@example.test')

    // Void: managers only, with a reason; the ledger entry it wrote is voided with its history kept.
    await rejects(L.voidLabel(a, { reason: 'wrong box' }, { id: 7, name: 'Sam Staff', manager: false }, deps), /Only a manager/)
    await rejects(L.voidLabel(a, {}, boss, deps), /Say why/)
    const v = await L.voidLabel(a, { reason: 'Customer changed the address' }, boss, deps)
    assert.equal(v.accepted, true); assert.equal(v.label.status, 'void_requested'); assert.equal(v.label.refund_status, 'submitted')
    assert.equal(ledger()[0].status, 'void'); assert.equal(db.all('SELECT * FROM shipping_events').length, 2)
    assert.equal((await L.voidLabel(a, { reason: 'again' }, boss, deps)).replayed, true); assert.equal(fake.refunds, 1)
    await rejects(L.buyLabel(a, { rate_id: r.id, confirm_price_cents: r.price_cents }, boss, deps), /was voided/)

    // A carrier that refuses the refund leaves the label valid and the ledger alone.
    const r2 = cheapest(b)
    await L.buyLabel(b, { rate_id: r2.id, confirm_price_cents: r2.price_cents }, boss, deps)
    fake.ctl.refund = 'rejected'
    const v2 = await L.voidLabel(b, { reason: 'try' }, boss, deps)
    assert.equal(v2.accepted, false); assert.equal(v2.label.status, 'bought'); assert.match(v2.label.error, /still valid postage/)
    assert.equal(ledger().filter((x) => x.status !== 'void').length, 1)

    // Rates that were never bought can be cleared; a bought label cannot.
    const [c] = await rate('clear')
    L.discardLabel(c, boss); assert.equal(row(c), undefined)
    await rejects(Promise.resolve().then(() => L.discardLabel(b, boss)), /never bought/)
  `)
})

test('a lost answer, a timeout and a refusal never buy a second label', { timeout: 90000 }, () => {
  child(`
    connect()
    // 1. Bought at the carrier, but the answer never arrived.
    const [a] = await rate('lost'); const ra = cheapest(a)
    fake.ctl.buy = 'lost'; fake.ctl.get = 'timeout'
    const e1 = await rejects(L.buyLabel(a, { rate_id: ra.id, confirm_price_cents: ra.price_cents }, boss, deps), /label_buy_unconfirmed/)
    assert.match(e1.message, /will not be charged twice/)
    assert.equal(row(a).status, 'buying', 'unknown is not failed: the row stays claimed'); assert.equal(purchases(), 1); assert.equal(ledger().length, 0)
    fake.ctl.buy = ''; fake.ctl.get = ''
    // Pressing Buy again asks first, finds the purchase, and finishes from it.
    const again = await L.buyLabel(a, { rate_id: ra.id, confirm_price_cents: ra.price_cents }, boss, deps)
    assert.equal(again.recovered, true); assert.equal(again.label.status, 'bought')
    assert.equal(purchases(), 1, 'one purchase'); assert.equal(buyCalls(), 1, '…and the second press never called buy')
    assert.equal(ledger().length, 1); assert.ok(row(a).label_file)

    // 2. Same loss, recovered with "Check purchase" instead.
    const [b] = await rate('lost2'); const rb = cheapest(b)
    fake.ctl.buy = 'lost'; fake.ctl.get = 'timeout'
    await rejects(L.buyLabel(b, { rate_id: rb.id, confirm_price_cents: rb.price_cents }, boss, deps), /label_buy_unconfirmed/)
    fake.ctl.buy = ''; fake.ctl.get = ''
    const chk = await L.checkPurchase(b, boss, deps)
    assert.equal(chk.recovered, true); assert.equal(purchases(), 2); assert.equal(ledger().length, 2)

    // 3. The request never reached the carrier. The row stays claimed until the carrier says it has nothing.
    const [c] = await rate('never'); const rc = cheapest(c)
    fake.ctl.buy = 'timeout'
    await rejects(L.buyLabel(c, { rate_id: rc.id, confirm_price_cents: rc.price_cents }, boss, deps), /label_buy_unconfirmed/)
    assert.equal(row(c).status, 'buying'); assert.equal(purchases(), 2)
    await rejects(L.checkPurchase(c, boss, deps), /Still waiting|label_busy/)
    db.run("UPDATE shipping_labels SET buy_claimed_at = datetime('now','-1 minute') WHERE id=?", c)
    const released = await L.checkPurchase(c, boss, deps)
    assert.equal(released.released, true); assert.equal(row(c).status, 'rated')
    fake.ctl.buy = ''
    const ok = await L.buyLabel(c, { rate_id: rc.id, confirm_price_cents: rc.price_cents }, boss, deps)
    assert.equal(ok.label.status, 'bought'); assert.equal(purchases(), 3)

    // 4. A clear refusal (no funds) hands the rates back and says what to do.
    const [d] = await rate('funds'); const rd = cheapest(d)
    fake.ctl.buy = 'funds'
    await rejects(L.buyLabel(d, { rate_id: rd.id, confirm_price_cents: rd.price_cents }, boss, deps), /add billing details or funds/)
    assert.equal(row(d).status, 'rated'); assert.match(row(d).error, /Nothing was bought/); assert.equal(purchases(), 3)

    // 5. "Refused" because it was ALREADY bought (a second process got there first) is read back, not believed.
    fake.ctl.buy = ''
    const [e] = await rate('race'); const re = cheapest(e)
    const s = fake.shipments.get(row(e).provider_shipment_id); s.bought = re.id; s.tracking = '9400000000000000000001'
    const raced = await L.buyLabel(e, { rate_id: re.id, confirm_price_cents: re.price_cents }, boss, deps)
    assert.equal(raced.recovered, true); assert.equal(raced.label.tracking_code, '9400000000000000000001'); assert.equal(purchases(), 3)

    // 6. The label file would not download: the purchase stands, and a refresh fetches the file later.
    const [f] = await rate('file'); const rf = cheapest(f)
    fake.ctl.file = 'fail'
    const nofile = await L.buyLabel(f, { rate_id: rf.id, confirm_price_cents: rf.price_cents }, boss, deps)
    assert.equal(nofile.label.status, 'bought'); assert.equal(nofile.label.has_file, false); assert.match(nofile.label.error, /could not be saved yet/)
    assert.equal(nofile.label.recorded, true, 'the ledger entry does not wait for the picture')
    fake.ctl.file = ''
    const fixed = await L.refreshLabel(f, boss, deps)
    assert.equal(fixed.label.has_file, true); assert.equal(fixed.label.error, '')
    assert.equal(ledger().length, new Set(ledger().map((x) => x.tracking_number)).size, 'no tracking number is in the ledger twice')
  `)
})

test('test-mode labels are marked, kept out of the ledger and never emailed; staff buy only when the shop allows', { timeout: 90000 }, () => {
  child(`
    connect('EZTKtest0000000000')
    assert.equal(L.labelSetup(boss).key_mode, 'test')
    const [a] = await rate('test'); const ra = cheapest(a)
    const t = await L.buyLabel(a, { rate_id: ra.id, confirm_price_cents: ra.price_cents }, boss, deps)
    assert.equal(t.label.test, true); assert.equal(t.label.status, 'bought'); assert.equal(t.label.recorded, false)
    assert.equal(ledger().length, 0, 'a sample label is not a shipment')
    await rejects(Promise.resolve().then(() => L.emailTracking(a, boss, deps)), /TEST label/)
    assert.equal(sent.length, 0)
    assert.ok(notes.some((n) => /\\(TEST\\)/.test(n)), 'the timeline says it was a test')

    // Staff: the shipping task must be theirs to work, AND the shop must have switched staff buying on.
    connect()
    const sam = { id: 7, name: 'Sam Staff', manager: false }
    const view = L.jobLabels(1, sam)
    assert.equal(view.can_buy, false); assert.ok(view.blocked)
    await rejects(L.rateBoxes(1, { request_id: rid('staff'), to: to(), boxes: [{ weight_lb: 1 }] }, sam), (e) => e.status === 403)
    assert.equal(L.jobLabels(1, boss).can_buy, true)
    L.saveLabelSetup({ staff_can_buy: true }); assert.equal(L.labelSetup(sam).staff_can_buy, true)
    // Still refused: there is no shipping task assigned to Sam on this job. The switch widens nothing else.
    assert.equal(L.jobLabels(1, sam).can_buy, false)
    const [b] = await rate('mgr'); const rb = cheapest(b)
    await rejects(L.buyLabel(b, { rate_id: rb.id, confirm_price_cents: rb.price_cents }, sam, deps), (e) => e.status === 403)
    assert.equal(purchases(), 1, 'the refused attempt bought nothing')

    await rejects(Promise.resolve().then(() => L.saveLabelSetup({ api_key: 'has spaces in it' })), /does not look like an EasyPost API key/)
    await rejects(Promise.resolve().then(() => L.saveLabelSetup({ ship_from: { company: 'X', street1: '1 A St', city: 'Dallas', state: 'Texas', zip: '75201' } })), /two-letter state/)
  `)
})
