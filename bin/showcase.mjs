/**
 * Showcase data: turns the seeded demo shop into a busy one.
 *
 * `npm run seed` builds a small, hand-written shop — eight customers, eight jobs — which is right
 * for learning the product and for the tests that pin its numbers. On a wall screen or a booth
 * monitor it reads as empty. This adds a quarter of history on top: two dozen more fictional
 * customers, thirty-odd jobs spread across every stage, three months of finished and paid work
 * (so Profitability, revenue trends and the wallboard sparkline have something to draw), open
 * quotes in the pipeline, and a morning's worth of stage moves for the ticker.
 *
 * It only ever runs on top of the demo shop ("Rebel Ink Press", the name `npm run seed` writes)
 * and refuses anything else, for the same reason seed.mjs does: a real shop's database is not a
 * canvas. Everything is fictional and uses reserved example domains. It is deterministic — the
 * same day produces the same shop — so a demo can be rehearsed.
 *
 * Usage: npm run showcase   (reseeds, then adds this)
 */
import { run, get, computeTotals, freezeUpcharges, syncInvoiceStatus, getSettings, getUpcharges, rollupSizes, sizeSummary, DB_PATH } from '../lib/db.mjs'
import { dealValue } from '../lib/pipeline.mjs'

const S = getSettings()
if (String(S.shop_name || '').trim() !== 'Rebel Ink Press') {
  console.error(`\n  Refusing: ${DB_PATH} is not the demo shop. Run \`npm run seed\` against a demo database first,`)
  console.error('  or use `npm run showcase`, which does both.\n')
  process.exit(1)
}
if (get("SELECT COUNT(*) AS n FROM contacts WHERE email LIKE '%@showcase.example'").n > 0) {
  console.error('\n  Showcase data is already in this database. `npm run showcase` reseeds from scratch.\n')
  process.exit(1)
}

// Deterministic PRNG (mulberry32), seeded by the calendar day.
let seed = Number(new Date().toISOString().slice(0, 10).replaceAll('-', '')) >>> 0
const rand = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const pick = (a) => a[Math.floor(rand() * a.length)]
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1))

const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10)
const stamp = (n, h = 10) => { const d = new Date(Date.now() + n * 864e5); d.setUTCHours(h + 7, between(0, 59), 0, 0); return d.toISOString().replace('T', ' ').slice(0, 19) }
const UP = getUpcharges()

/* ---------- customers ---------- */

const CUSTOMERS = [
  ['Morgan Blake', 'Cedar Ridge Elementary PTA', 'school,repeat'], ['Chris Delgado', 'Delgado Landscaping', 'trades,embroidery'],
  ['Ava Thompson', 'Riverbend 5K Run', 'events'], ['Jordan Price', 'Price Plumbing & Heating', 'trades,repeat'],
  ['Noah Patel', 'Copperline Coffee Roasters', 'food,repeat'], ['Grace Lee', 'Eastside Youth Soccer', 'sports,school'],
  ['Elijah Brooks', 'Brooks Family Reunion 2026', 'events,new'], ['Harper Nguyen', 'Lumen Yoga Studio', 'fitness'],
  ['Mateo Garcia', 'Garcia Auto Body', 'trades'], ['Zoe Martin', 'Pinecrest Summer Camp', 'camp,repeat'],
  ['Lucas Wright', 'Wright Brothers Brewing', 'food,vip'], ['Chloe Adams', 'Adams Dental Group', 'corporate,embroidery'],
  ['Henry Scott', 'Lincoln Robotics Club', 'school'], ['Lily Turner', 'Turner Real Estate', 'corporate'],
  ['Owen Hill', 'Hilltop Church Youth Group', 'nonprofit,repeat'], ['Ella Ramirez', 'Ramirez Taqueria', 'food'],
  ['Wyatt Cooper', 'Cooper Construction', 'trades,net-30'], ['Nora King', 'Kingston Marathon Club', 'events,sports'],
  ['Levi Morris', 'Morris & Co. Barbershop', 'small-biz'], ['Stella Reed', 'Northside Animal Rescue', 'nonprofit'],
  ['Isaac Bell', 'Bellwether Tech Meetup', 'tech,events'], ['Hazel Ward', 'Ward Middle School Band', 'school'],
]
const cid = {}
for (const [name, company, tags] of CUSTOMERS) {
  const email = `${name.split(' ')[0].toLowerCase()}@showcase.example`
  cid[name] = Number(run('INSERT INTO contacts (name, email, phone, company, notes, tags, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    name, email, `(555) 555-0${between(100, 199)}`, company, '', tags, stamp(-between(95, 180)), stamp(-between(1, 20))).lastInsertRowid)
}
const names = Object.keys(cid)

/* ---------- products ---------- */

const PRODUCTS = [
  ['Gildan 5000 Tee', 'Screen Print', 7.5, 9.5], ['Bella+Canvas 3001 Tee', 'Screen Print', 9, 12], ['Next Level 6210 Tee', 'DTF Transfer', 11, 14],
  ['Gildan 18500 Hoodie', 'Screen Print', 24, 32], ['Independent SS4500 Hoodie', 'Embroidery', 34, 44], ['Port Authority K500 Polo', 'Embroidery', 26, 34],
  ['Richardson 112 Trucker', 'Patch', 16, 22], ['Comfort Colors 1717 Tee', 'Screen Print', 12, 16], ['Sport-Tek ST350 Performance Tee', 'DTF Transfer', 10, 13],
  ['Carhartt CT104597 Hoodie', 'Embroidery', 48, 62], ['Bella+Canvas 8800 Tank', 'DTF Transfer', 12, 15], ['Port Authority A700 Apron', 'Embroidery', 22, 28],
]
const COLORS = ['Black', 'Navy', 'White', 'Heather Grey', 'Forest', 'Maroon', 'Royal', 'Sand', 'Charcoal', 'Safety Green']
const WHAT = ['staff shirts', 'event tees', 'team hoodies', 'uniform polos', 'volunteer shirts', 'merch drop', 'spirit wear', 'crew hats', 'season reorder', 'fundraiser tees']
const STAFF = ['Marco — Press 1', 'Luis — Press 2', 'Nina', 'Dee', 'Kim — Embroidery', '']
const RUN = { S: 0.14, M: 0.26, L: 0.28, XL: 0.18, '2XL': 0.09, '3XL': 0.05 }

const grid = (qty, decoration) => {
  if (decoration === 'Patch') return { OSFA: qty }
  const g = {}; let left = qty
  for (const [k, share] of Object.entries(RUN)) { const n = k === '3XL' ? left : Math.round(qty * share); if (n > 0) g[k] = n; left -= n }
  return g
}

let estN = Number(get("SELECT MAX(CAST(substr(estimate_number, 5) AS INTEGER)) AS n FROM estimates").n) || 1000
let invN = Number(get("SELECT MAX(CAST(substr(invoice_number, 5) AS INTEGER)) AS n FROM invoices").n) || 1000
let jobN = Number(get("SELECT MAX(CAST(substr(job_number, 5) AS INTEGER)) AS n FROM jobs").n) || 1000

function order(contact, { ago, status }) {
  const [garment, decoration, lo, hi] = pick(PRODUCTS)
  const color = pick(COLORS)
  const qty = pick([24, 36, 48, 60, 72, 96, 120, 144, 150, 200, 250, 300, 400])
  const price = Math.round((lo + rand() * (hi - lo)) * 4) / 4
  const colorsFront = decoration === 'Screen Print' ? between(1, 4) : 0
  const items = [{ description: `${garment} — ${contact.split(' ')[1]} ${pick(WHAT)}`, detail: `${color}${colorsFront ? `, ${colorsFront} color front` : ''}`,
    decoration, sizes: grid(qty, decoration), unit_price: price, taxable: true }]
  if (colorsFront) items.push({ description: `Screen setup — ${colorsFront} screen${colorsFront > 1 ? 's' : ''}`, detail: 'One-time', decoration, qty: colorsFront, unit_price: 25, taxable: false })
  const frozen = freezeUpcharges(items, UP)
  const t = computeTotals(frozen, S.tax_rate, UP)
  const created = stamp(-ago)
  const approved = status === 'approved' ? stamp(-ago + 1) : null
  const id = Number(run('INSERT INTO estimates (contact_id, estimate_number, status, items, subtotal, tax, total, notes, sent_at, approved_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    cid[contact], `EST-${++estN}`, status, JSON.stringify(frozen), t.subtotal, t.tax, t.total, '', status === 'draft' ? null : created, approved, created).lastInsertRowid)
  return { id, contact, total: t.total, garment: `${garment} — ${color}`, decoration, qty, title: items[0].description.split(' — ')[1], approved }
}

function invoice(e, { due, paid, created }) {
  const id = Number(run('INSERT INTO invoices (estimate_id, contact_id, invoice_number, status, amount_due, amount_paid, due_date, created_at) VALUES (?,?,?,?,?,?,?,?)',
    e.id, cid[e.contact], `INV-${++invN}`, 'unpaid', e.total, 0, due, created).lastInsertRowid)
  for (const [amount, at, note] of paid) run('INSERT INTO payments (invoice_id, amount, method, note, created_at) VALUES (?,?,?,?,?)', id, amount, pick(['card', 'card', 'check', 'ach']), note, at)
  syncInvoiceStatus(id)
  return id
}

function job(e, inv, { stage, due, created, rush = 0, shipped = null }) {
  const g = rollupSizes(JSON.parse(get('SELECT items FROM estimates WHERE id=?', e.id).items))
  const id = Number(run(`INSERT INTO jobs (contact_id, estimate_id, invoice_id, job_number, title, status, stage, decoration, garment, sizes, quantities,
      due_date, date_promised, turnaround_days, approval_gated, art_approved_at, notes, assigned_to, rush, ship_date, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    cid[e.contact], e.id, inv, `JOB-${++jobN}`, `${e.qty} ${e.title}`, stage === 'complete' ? 'complete' : 'active', stage, e.decoration, e.garment,
    JSON.stringify(g), sizeSummary(g), due, due, 10, stage === 'new' || stage === 'art_approval' ? 1 : 0,
    stage === 'new' || stage === 'art_approval' ? null : e.approved, '', pick(STAFF), rush, shipped, created, shipped ? `${shipped} 15:00:00` : created).lastInsertRowid)
  return { id, num: `JOB-${jobN}` }
}

const act = (type, desc, contact, jobId, at) => run('INSERT INTO activities (contact_id, job_id, type, description, created_at) VALUES (?,?,?,?,?)', cid[contact] || null, jobId || null, type, desc, at)
const LABEL = { new: 'New', art_approval: 'Art Approval', prepress: 'Prepress', production: 'Production', qc: 'QC', shipping: 'Shipping', complete: 'Complete' }

/* ---------- a quarter of finished, paid work ---------- */

let finished = 0
for (let ago = 92; ago >= 0; ago -= ago > 14 ? between(0, 2) : 1) {
  const c = pick(names)
  const e = order(c, { ago: ago + 12, status: 'approved' })
  const shippedOn = day(-ago)
  const inv = invoice(e, { due: day(-ago + 15), created: stamp(-ago - 11),
    paid: [[Math.round(e.total * 50) / 100, stamp(-ago - 10), 'Deposit'], [Math.round((e.total - Math.round(e.total * 50) / 100) * 100) / 100, stamp(-ago + between(0, 6)), 'Balance']] })
  job(e, inv, { stage: 'complete', due: shippedOn, created: stamp(-ago - 11), shipped: shippedOn })
  finished++
}

/* ---------- the floor right now ---------- */

const FLOOR = [
  ['new', 3], ['art_approval', 4], ['prepress', 5], ['production', 6], ['qc', 3], ['shipping', 4],
]
let active = 0
for (const [stage, count] of FLOOR) {
  for (let i = 0; i < count; i++) {
    const c = pick(names)
    const ago = between(3, 16)
    const e = order(c, { ago, status: 'approved' })
    const deposit = Math.round(e.total * 50) / 100
    const inv = invoice(e, { due: day(between(5, 25)), created: stamp(-ago + 1), paid: rand() < 0.85 ? [[deposit, stamp(-ago + 1), 'Deposit']] : [] })
    // Mostly comfortable dates, a couple tight, one or two genuinely late — the wall should have news.
    const r = rand()
    const due = r < 0.08 ? day(-between(1, 2)) : r < 0.25 ? day(between(0, 1)) : day(between(2, 18))
    const j = job(e, inv, { stage, due, created: stamp(-ago + 1), rush: rand() < 0.12 ? 1 : 0 })
    act('stage', `${j.num} moved to ${LABEL[stage]}`, c, j.id, stamp(-between(0, 1), between(7, 16)))
    active++
  }
}

/* ---------- quotes that were lost ----------
 * A pipeline that wins everything is not believable, and the win rate is one of the numbers on
 * Today. A shop that quotes honestly loses some. */
for (let i = 0; i < 14; i++) {
  const e = order(pick(names), { ago: between(8, 88), status: 'sent' })
  run("UPDATE estimates SET status = 'declined' WHERE id = ?", e.id)
}

/* ---------- open quotes ---------- */

let quotes = 0
for (let i = 0; i < 9; i++) {
  const c = pick(names)
  const status = i < 6 ? 'sent' : 'draft'
  const e = order(c, { ago: between(0, 9), status })
  const row = get('SELECT * FROM estimates WHERE id = ?', e.id)
  run(`INSERT INTO opportunities (contact_id, estimate_id, title, stage, value, source, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    row.contact_id, row.id, e.title, status === 'sent' ? pick(['sent', 'negotiation']) : 'quoted', dealValue(row), 'estimate', i, row.created_at, row.created_at)
  act('estimate', `Estimate ${row.estimate_number} emailed to ${c}`, c, null, row.created_at)
  quotes++
}

const n = (t) => get(`SELECT COUNT(*) AS c FROM ${t}`).c
console.log(`\n  Showcase added ${names.length} customers · ${finished} finished orders · ${active} jobs on the floor · ${quotes} open quotes`)
console.log(`  Shop now: ${n('contacts')} customers · ${n('estimates')} estimates · ${n('invoices')} invoices · ${n('jobs')} jobs\n`)
