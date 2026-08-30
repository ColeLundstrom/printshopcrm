/**
 * Wipes and reseeds the demo database with a shop mid-week: work on every stage
 * of the board, money in every state, proofs waiting on customers.
 * Usage: npm run seed
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import { db, run, get, all, computeTotals, freezeUpcharges, syncInvoiceStatus, getSettings, seedSettings, getUpcharges, rollupSizes, sizeSummary, lineQty, DB_PATH } from './lib/db.mjs'
import { dealValue } from './lib/pipeline.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const UPLOADS = join(ROOT, 'public', 'uploads')
mkdirSync(UPLOADS, { recursive: true })

/**
 * Say what is about to be destroyed, and refuse to destroy somebody's shop.
 *
 * `npm run reset` is documented as "wipe and reseed" and was the one script in package.json that
 * did not pass --env-file-if-exists=.env — so bin/reset.mjs deleted ./data/printshop.db (usually
 * nothing, reporting success) while `&& npm run seed` DID read .env and wiped whatever PSC_DB
 * pointed at. Two halves of one command, aimed at two different databases. The deletes below are
 * unguarded `DELETE FROM` over contacts, estimates, invoices, jobs, payments, messages and
 * settings, and what comes back is "Rebel Ink Press" with a 7.75% California tax rate.
 *
 * The env-file half is fixed in package.json. This is the second lock: seeding is a demo action,
 * so it may create a shop and it may replace the demo shop, and it may not overwrite a real one.
 * A shop that has named itself and has records is a real one.
 */
const rows = (t) => { try { return get(`SELECT COUNT(*) AS n FROM ${t}`)?.n || 0 } catch { return 0 } }
const existing = ['contacts', 'estimates', 'invoices', 'jobs', 'payments'].reduce((n, t) => n + rows(t), 0)
const shopName = String(getSettings()?.shop_name || '').trim()
/**
 * A blank shop_name does NOT mean "this is the demo".
 *
 * lib/db.mjs's own default for shop_name is '', and no screen in the product forces it — a shop
 * can take orders for a year without ever typing its own name into Settings. Treating that as the
 * demo meant a database with 13 real records and a blank name was deleted, `removed 1 file(s)`,
 * exit 0, and reseeded as Rebel Ink Press. INSTALL.md promises the opposite in as many words.
 *
 * Records are what make a shop real. The demo is identified by the exact name the demo writes,
 * and by nothing else. A genuinely blank database still seeds and resets freely, because it has
 * no records.
 */
const isDemo = shopName === 'Rebel Ink Press'
console.log(`  seeding ${DB_PATH}`)
if (existing > 0 && !isDemo && process.env.PSC_SEED_FORCE !== '1') {
  console.error(`\n  Refusing to seed: that database belongs to a real shop.\n`)
  console.error(`    database   ${DB_PATH}`)
  console.error(`    shop       ${shopName || '(unnamed — a shop that never filled in Settings is still a real shop)'}`)
  console.error(`    records    ${existing} across contacts, estimates, invoices, jobs and payments\n`)
  console.error(`  Seeding DELETES all of them and replaces the shop with the "Rebel Ink Press" demo.`)
  console.error(`  If you want a demo database, point PSC_DB somewhere else:`)
  console.error(`    PSC_DB=./data/demo.db npm run seed\n`)
  console.error(`  If you really mean to wipe this one, back it up first and then:`)
  console.error(`    PSC_SEED_FORCE=1 npm run seed\n`)
  process.exit(1)
}

// Ids restart at 1 after a full delete — these tables use plain INTEGER PRIMARY KEY, no AUTOINCREMENT.
for (const t of ['payments', 'art_versions', 'activities', 'jobs', 'invoices', 'estimates', 'contacts', 'email_log', 'messages', 'opportunities']) {
  run(`DELETE FROM ${t}`)
}
// Settings are upserted, not inserted-if-missing, so template edits in code reach an existing db.
run('DELETE FROM settings')
seedSettings()

// The demo shop's identity lives HERE, not in SETTING_DEFAULTS, because the defaults are what a
// real self-hosted install starts from. When these were defaults, every shop that followed the
// README quickstart sent invoices headed "Rebel Ink Press — (714) 555-0142" and charged its own
// customers 7.75% California sales tax. Both were silent. Seeding is opt-in: you only get this
// identity by asking for the demo data, and `npm run reset` is how you clear it.
for (const [k, v] of Object.entries({
  shop_name: 'Rebel Ink Press',
  shop_tagline: 'Custom apparel since 2011',
  shop_email: 'orders@example.com',
  shop_phone: '(714) 555-0142',
  shop_address: '500 Main Street, Springfield, IL 62701',
  tax_rate: '7.75',
})) run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', k, v)

// The automation run log dedupes by entity id, so a reseed that left it in place would
// suppress every timed rule against the fresh data. Clear the history, keep the rules.
try {
  run('DELETE FROM automation_runs')
  run('DELETE FROM automation_pending')
  run('UPDATE automations SET run_count = 0, last_run_at = NULL')
} catch { /* first run — the automations tables don't exist until the server boots */ }

const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10)
const stamp = (n, h = 10) => new Date(Date.now() + n * 864e5).toISOString().replace('T', ' ').slice(0, 19)
const usd = (n) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const S = getSettings()
const UP = getUpcharges()

/* ---------- art placeholders ---------- */

const art = (title, sub, bg, fg) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 480">
  <rect width="600" height="480" fill="${bg}"/>
  <circle cx="300" cy="196" r="104" fill="none" stroke="${fg}" stroke-width="7"/>
  <text x="300" y="188" font-family="Impact, Haettenschweiler, sans-serif" font-size="62" fill="${fg}" text-anchor="middle">${title}</text>
  <text x="300" y="232" font-family="Georgia, serif" font-size="21" fill="${fg}" text-anchor="middle" letter-spacing="7">${sub}</text>
  <path d="M120 340 H480" stroke="${fg}" stroke-width="4"/>
  <text x="300" y="386" font-family="Helvetica, sans-serif" font-size="27" font-weight="bold" fill="${fg}" text-anchor="middle" letter-spacing="3">EST. 2011</text>
</svg>`

const artFile = (name, svg) => { writeFileSync(join(UPLOADS, name), svg); return name }

const ART = {
  wildcats: artFile('seed-wildcats.svg', art('WILDCATS', 'LAKESIDE', '#1a1d22', '#f5c518')),
  brewfest: artFile('seed-brewfest.svg', art('BREWFEST', 'ANAHEIM 26', '#0f2419', '#e8dcc0')),
  summit: artFile('seed-summit.svg', art('SUMMIT', 'DEV CONF', '#12141a', '#4aa8ff')),
  crossfit: artFile('seed-crossfit.svg', art('FORGE', 'CROSSFIT', '#1c1210', '#ff5f3d')),
  bakery: artFile('seed-bakery.svg', art('ROSIE&apos;S', 'BAKERY', '#2b1d24', '#f2a8c4')),
}

/* ---------- contacts ---------- */

const CONTACTS = [
  ['Jamie Rivera', 'jamie.rivera@example.edu', '(714) 555-0142', 'Lakeside High School', 'ASB advisor. Orders spirit wear 3x/year. Needs PO before production — district net-30. Always asks for a size run sample.', 'school,repeat,net-30'],
  ['Marcus Chen', 'marcus@example.com', '(657) 555-0188', 'Harbor City Brewfest', 'Event organizer. Big Q3 order every year, plus live printing on site. Pays card on file, no PO needed.', 'events,repeat,vip'],
  ['Priya Nair', 'priya@example.com', '(949) 555-0117', 'Summit Dev Conf', 'Runs swag for the conference. Very picky about Pantone match on the logo blue. Approves art fast.', 'tech,events'],
  ['Danny Ortiz', 'danny@example.com', '(714) 555-0163', 'Forge Fitness Co.', 'Gym owner. Small reorders, quick turns. Prefers DTF on tri-blends.', 'fitness,repeat'],
  ['Rosie Almeida', 'rosie@example.com', '(562) 555-0134', "Rosie's Bakery", 'Aprons and hats for staff. Embroidery only. Loves a rush job at the last minute.', 'food,embroidery'],
  ['Terrence Wallace', 'twallace@example.org', '(562) 555-0199', 'Westport City Parks', 'Municipal. Slow to pay but reliable. Requires W-9 on file and itemized invoices.', 'municipal,net-30'],
  ['Alexis Kim', 'alexis.kim@example.org', '(714) 555-0155', 'Northgate HS Booster Club', 'Booster club treasurer. Volume orders for football season. First order — earn the reorder.', 'school,new'],
  ['Sam Whitfield', 'sam@example.com', '(949) 555-0171', 'Whitfield Realty', 'Polos and hats for the agent team. Wants everything embroidered left chest.', 'corporate,embroidery'],
]

const cid = {}
for (const [name, email, phone, company, notes, tags] of CONTACTS) {
  const r = run('INSERT INTO contacts (name, email, phone, company, notes, tags, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    name, email, phone, company, notes, tags, stamp(-90), stamp(-90))
  cid[name] = Number(r.lastInsertRowid)
}

/* ---------- estimates ---------- */

let estN = 1000, invN = 1000, jobN = 1000
const nx = (p, n) => `${p}-${n}`

function addEstimate({ contact, items, status, notes, created, sent, approved }) {
  /* Freeze the upcharge table these lines were priced with, exactly as every write door in the
   * app does (lib/db.mjs freezeUpcharges). The seed was the last writer storing bare lines, so
   * the demo shop shipped seven documents that RE-PRICE themselves the moment the shop changes
   * an ordinary setting: raise the extended-size upcharges and EST-1006's lines total $6,315.00
   * against its own printed Subtotal of $5,784.00. That is the exact defect the freeze exists to
   * prevent, shipped in the dataset every new install starts from. */
  const frozen = freezeUpcharges(items, UP)
  const t = computeTotals(frozen, S.tax_rate, UP)
  const num = nx('EST', ++estN)
  const id = Number(run('INSERT INTO estimates (contact_id, estimate_number, status, items, subtotal, tax, total, notes, sent_at, approved_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    cid[contact], num, status, JSON.stringify(frozen), t.subtotal, t.tax, t.total, notes || '', sent || null, approved || null, created).lastInsertRowid)
  return { id, num, total: t.total, contact }
}

const E = {}

E.wildcats = addEstimate({
  contact: 'Jamie Rivera', status: 'approved', created: stamp(-21), sent: stamp(-20), approved: stamp(-18),
  notes: 'PO #FJ-2026-0418 on file. Two week turn from art approval.',
  items: [
    { description: 'Gildan 5000 Tee — Wildcats spirit shirt', detail: 'Athletic gold, 2 color front + 1 color back', decoration: 'Screen Print',
      sizes: { S: 40, M: 90, L: 110, XL: 48, '2XL': 10, '3XL': 2 }, unit_price: 8.75, taxable: true },
    { description: 'Screen setup — 3 screens', detail: 'One-time charge, screens held 12 months', decoration: 'Screen Print', qty: 3, unit_price: 25, taxable: false },
  ],
})

E.brewfest = addEstimate({
  contact: 'Marcus Chen', status: 'approved', created: stamp(-14), sent: stamp(-14), approved: stamp(-12),
  notes: 'Staff shirts for the 2026 fest + on-site live printing booth Saturday. Booth runs 11a-7p.',
  items: [
    { description: 'Next Level 6210 — Brewfest staff tee', detail: 'Forest green, full front 2 color', decoration: 'Screen Print',
      sizes: { S: 12, M: 30, L: 40, XL: 28, '2XL': 8, '3XL': 2 }, unit_price: 11.5, taxable: true },
    { description: 'Richardson 112 Trucker — Brewfest patch hat', detail: 'Leather patch, laser engraved', decoration: 'Patch',
      sizes: { OSFA: 60 }, unit_price: 18, taxable: true },
    { description: 'Live printing booth — Saturday', detail: '8 hours, 2 operators, press + supplies', decoration: 'Screen Print', qty: 8, unit_price: 250, taxable: false },
  ],
})

E.summit = addEstimate({
  contact: 'Priya Nair', status: 'approved', created: stamp(-9), sent: stamp(-9), approved: stamp(-7),
  notes: 'Pantone 2925 C on the logo — customer will reject anything off. Ship to Long Beach Convention Center by the 24th.',
  items: [
    { description: 'Bella+Canvas 3001 — Summit attendee tee', detail: 'Black, 1 color front, Pantone 2925 C', decoration: 'Screen Print',
      sizes: { XS: 15, S: 70, M: 130, L: 140, XL: 70, '2XL': 20, '3XL': 5 }, unit_price: 9.25, taxable: true },
    { description: 'Champion S700 Hoodie — speaker gift', detail: 'Charcoal, left chest embroidery', decoration: 'Embroidery',
      sizes: { S: 6, M: 12, L: 14, XL: 6, '2XL': 2 }, unit_price: 34, taxable: true },
  ],
})

E.forge = addEstimate({
  contact: 'Danny Ortiz', status: 'approved', created: stamp(-5), sent: stamp(-5), approved: stamp(-4),
  notes: 'Reorder of the FORGE tank, same art as last run.',
  items: [{ description: 'Bella+Canvas 8800 Tank — FORGE', detail: 'Heather orange, DTF front', decoration: 'DTF Transfer',
    sizes: { S: 12, M: 16, L: 14, XL: 6 }, unit_price: 14.5, taxable: true }],
})

E.rosie = addEstimate({
  contact: 'Rosie Almeida', status: 'approved', created: stamp(-3), sent: stamp(-3), approved: stamp(-2),
  notes: 'RUSH — new location opens Saturday. Aprons must be done Friday.',
  items: [
    { description: 'Port Authority A700 Apron — embroidered logo', detail: 'Black, 4in left chest', decoration: 'Embroidery',
      sizes: { OSFA: 24 }, unit_price: 27, taxable: true },
    { description: 'Rush fee — 3 day turnaround', detail: 'Bumps the schedule', decoration: 'Embroidery', qty: 1, unit_price: 150, taxable: false },
  ],
})

E.northgate = addEstimate({
  contact: 'Alexis Kim', status: 'sent', created: stamp(-2), sent: stamp(-2),
  notes: 'Football season package. Quote holds 30 days — sizes can be finalized after approval.',
  items: [
    { description: 'Gildan 18500 Hoodie — Northgate football', detail: 'Navy, full front + sleeve hit', decoration: 'Screen Print',
      sizes: { S: 18, M: 40, L: 50, XL: 30, '2XL': 10, '3XL': 2 }, unit_price: 26.5, taxable: true },
    { description: 'Gildan 5000 Tee — booster shirt', detail: 'White, 2 color front', decoration: 'Screen Print',
      sizes: { S: 25, M: 55, L: 65, XL: 40, '2XL': 12, '3XL': 3 }, unit_price: 8.25, taxable: true },
    { description: 'Screen setup — 4 screens', detail: 'One-time', decoration: 'Screen Print', qty: 4, unit_price: 25, taxable: false },
  ],
})

E.whitfield = addEstimate({
  contact: 'Sam Whitfield', status: 'sent', created: stamp(-1), sent: stamp(-1),
  notes: 'Polos for the agent team. Add names below the logo? Let me know before we digitize.',
  items: [
    { description: 'Port Authority K500 Polo — embroidered', detail: 'Navy, left chest 3in logo', decoration: 'Embroidery',
      sizes: { S: 4, M: 9, L: 11, XL: 6, '2XL': 2 }, unit_price: 31, taxable: true },
    { description: 'Digitizing — Whitfield logo', detail: 'One-time, file kept on record', decoration: 'Embroidery', qty: 1, unit_price: 65, taxable: false },
  ],
})

E.parks = addEstimate({
  contact: 'Terrence Wallace', status: 'draft', created: stamp(0),
  notes: 'Summer camp counselor shirts. Waiting on final headcount from Terrence before sending.',
  items: [{ description: 'Gildan 5000 Tee — Parks summer camp', detail: 'Safety green, 1 color front + back', decoration: 'Screen Print',
    sizes: { YS: 20, YM: 30, YL: 30, S: 30, M: 50, L: 50, XL: 25, '2XL': 5 }, unit_price: 7.95, taxable: true }],
})

/* ---------- invoices + jobs ---------- */

function addInvoice(est, { due, payments = [], created }) {
  const num = nx('INV', ++invN)
  const id = Number(run('INSERT INTO invoices (estimate_id, contact_id, invoice_number, status, amount_due, amount_paid, due_date, created_at) VALUES (?,?,?,?,?,?,?,?)',
    est.id, cid[est.contact], num, 'unpaid', est.total, 0, due, created).lastInsertRowid)
  // `amt: 'full'` derives from the taxed total so paid-in-full lands at a zero balance.
  for (const p of payments) {
    const amt = p.amt === 'full' ? est.total : p.amt
    run('INSERT INTO payments (invoice_id, amount, method, note, created_at) VALUES (?,?,?,?,?)', id, amt, p.method, p.note || '', p.at)
  }
  syncInvoiceStatus(id)
  return { id, num }
}

function addJob(est, inv, { title, stage, decoration, quantities, sizes, garment, due, notes, assigned, rush = 0, created,
  turnaround = 10, approvedAt = null, gated = 1 }) {
  const num = nx('JOB', ++jobN)
  // Pull the size grid off the estimate the job came from — same numbers, no retyping.
  const grid = sizes || (est.id ? rollupSizes(JSON.parse(get('SELECT items FROM estimates WHERE id=?', est.id).items)) : {})
  const id = Number(run(`INSERT INTO jobs (contact_id, estimate_id, invoice_id, job_number, title, status, stage, decoration, garment, sizes,
      quantities, due_date, date_promised, turnaround_days, approval_gated, art_approved_at, notes, assigned_to, rush, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    cid[est.contact], est.id, inv?.id || null, num, title, stage === 'complete' ? 'complete' : 'active', stage, decoration,
    garment || '', JSON.stringify(grid), quantities || sizeSummary(grid), due, due, turnaround, gated, approvedAt,
    notes || '', assigned || '', rush, created, created).lastInsertRowid)
  return { id, num, contact: est.contact }
}

const I = {}, J = {}

I.wildcats = addInvoice(E.wildcats, { due: day(-3), created: stamp(-18), payments: [{ amt: 1400, method: 'check', note: 'Check #4471 — 50% deposit', at: stamp(-17) }] })
J.wildcats = addJob(E.wildcats, I.wildcats, { title: '300 tees — Wildcats spirit shirt', stage: 'production', decoration: 'Screen Print',
  garment: 'Gildan 5000 — Athletic Gold', due: day(2), assigned: 'Marco — Press 1', created: stamp(-18),
  turnaround: 10, approvedAt: stamp(-16),
  notes: 'Gold on black, 2 color front + 1 color back. Screens are burned and racked. Print back first.' })

I.brewfest = addInvoice(E.brewfest, { due: day(9), created: stamp(-12), payments: [{ amt: 1500, method: 'card', note: 'Deposit — Visa 4411', at: stamp(-12) }] })
J.brewfest = addJob(E.brewfest, I.brewfest, { title: 'Brewfest staff tees + patch hats', stage: 'prepress', decoration: 'Screen Print',
  garment: 'Next Level 6210 — Forest / Richardson 112', due: day(6), assigned: 'Nina', created: stamp(-12),
  turnaround: 10, approvedAt: stamp(-11),
  notes: 'Hats go on the laser first — 60 leather patches. Tees are 2 color forest green.' })

I.summit = addInvoice(E.summit, { due: day(12), created: stamp(-7) })
J.summit = addJob(E.summit, I.summit, { title: '450 attendee tees + 40 speaker hoodies', stage: 'art_approval', decoration: 'Screen Print',
  garment: 'Bella+Canvas 3001 — Black', due: day(9), assigned: 'Nina', created: stamp(-7), turnaround: 10,
  notes: 'PANTONE 2925 C — mix it, do not eyeball it. Priya will reject an off blue. Hoodies to embroidery after tees.' })

I.forge = addInvoice(E.forge, { due: day(10), created: stamp(-4), payments: [{ amt: 'full', method: 'card', note: 'Paid in full', at: stamp(-4) }] })
J.forge = addJob(E.forge, I.forge, { title: '48 FORGE tanks — DTF reorder', stage: 'qc', decoration: 'DTF Transfer',
  garment: 'Bella+Canvas 8800 — Heather Orange', due: day(1), assigned: 'Dee', created: stamp(-4),
  turnaround: 5, approvedAt: stamp(-3),
  notes: 'Same art as the March run. Check transfer adhesion on the tri-blend before boxing.' })

I.rosie = addInvoice(E.rosie, { due: day(11), created: stamp(-2) })
J.rosie = addJob(E.rosie, I.rosie, { title: '24 embroidered aprons — RUSH', stage: 'art_approval', decoration: 'Embroidery',
  garment: 'Port Authority A700 — Black', due: day(1), assigned: 'Nina', rush: 1, created: stamp(-2), turnaround: 3,
  notes: 'RUSH — store opens Saturday. Digitizing done, needs customer sign-off on the proof today.' })

// A finished job, so the board and revenue have history.
const eDone = addEstimate({
  contact: 'Danny Ortiz', status: 'approved', created: stamp(-30), sent: stamp(-30), approved: stamp(-29),
  notes: 'March tee run.',
  items: [{ description: 'Bella+Canvas 3001 — FORGE tee', detail: 'Black, DTF front', decoration: 'DTF Transfer',
    sizes: { S: 10, M: 18, L: 20, XL: 10, '2XL': 2 }, unit_price: 13.5, taxable: true }],
})
const iDone = addInvoice(eDone, { due: day(-16), created: stamp(-29), payments: [{ amt: 'full', method: 'card', note: 'Paid in full', at: stamp(-26) }] })
J.done = addJob(eDone, iDone, { title: '60 FORGE tees — March run', stage: 'complete', decoration: 'DTF Transfer',
  garment: 'Bella+Canvas 3001 — Black', due: day(-18), assigned: 'Dee', created: stamp(-29), turnaround: 10, approvedAt: stamp(-28),
  notes: 'Delivered to the gym. Danny happy.' })

// Walk-in with no estimate — jobs do not require one.
J.walkin = addJob({ id: null, contact: 'Terrence Wallace' }, null, { title: '12 staff polos — walk-in', stage: 'new', decoration: 'Embroidery',
  garment: 'Port Authority K500 — Navy', sizes: { M: 3, L: 5, XL: 3, '2XL': 1 }, due: day(8), assigned: '', created: stamp(0), gated: 0,
  notes: 'Terrence dropped these off. Needs a quote written up — left chest logo, navy.' })

J.shipping = addJob(E.wildcats, I.wildcats, { title: 'Wildcats — coach polos add-on', stage: 'shipping', decoration: 'Embroidery',
  garment: 'Port Authority K500 — Gold', sizes: { M: 2, L: 3, XL: 2, '2XL': 1 }, due: day(0), assigned: 'Dee', created: stamp(-6),
  turnaround: 10, approvedAt: stamp(-5),
  notes: 'Boxed and labeled. UPS pickup at 4pm.' })

/* ---------- art versions ---------- */

function addArt(job, { file, mime = 'image/svg+xml', name, version, status, notes, sent, decided, by, created }) {
  run('INSERT INTO art_versions (job_id, version, filename, original_name, mime, size, status, notes, sent_at, decided_at, decided_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    job.id, version, file, name, mime, 48000, status, notes || '', sent || null, decided || null, by || null, created)
}

addArt(J.wildcats, { file: ART.wildcats, name: 'wildcats-spirit-2026-v2.svg', version: 2, status: 'approved',
  notes: 'Gold bumped to athletic gold per Jamie.', sent: stamp(-17), decided: stamp(-16), by: 'Jamie Rivera', created: stamp(-17) })
addArt(J.wildcats, { file: ART.wildcats, name: 'wildcats-spirit-2026-v1.svg', version: 1, status: 'rejected',
  notes: 'Gold reads too yellow next to the jersey — match athletic gold.', sent: stamp(-18), decided: stamp(-18), by: 'Jamie Rivera', created: stamp(-18) })

addArt(J.brewfest, { file: ART.brewfest, name: 'brewfest-2026-staff.svg', version: 1, status: 'approved',
  notes: 'Approved same day, no changes.', sent: stamp(-11), decided: stamp(-11), by: 'Marcus Chen', created: stamp(-11) })

addArt(J.summit, { file: ART.summit, name: 'summit-attendee-tee-v1.svg', version: 1, status: 'sent',
  notes: 'Pantone 2925 C on the mark.', sent: stamp(-1), created: stamp(-1) })

addArt(J.rosie, { file: ART.bakery, name: 'rosies-apron-embroidery-v1.svg', version: 1, status: 'sent',
  notes: 'Digitized, 4in left chest. Needs sign-off today to hit Friday.', sent: stamp(0), created: stamp(0) })

addArt(J.forge, { file: ART.crossfit, name: 'forge-tank-dtf.svg', version: 1, status: 'approved',
  sent: stamp(-3), decided: stamp(-3), by: 'Danny Ortiz', created: stamp(-3) })

/* ---------- recorded screens/inks on demo jobs ---------- */

const saveSep = (job, sep) => run('UPDATE jobs SET separation = ? WHERE id = ?', JSON.stringify(sep), job.id)
saveSep(J.wildcats, { colors: 4, screens: 5, dark: true, garment: 'Black', mode: 'spot',
  inks: [{ name: 'White', hex: '#f5f5f5' }, { name: 'Yellow', hex: '#f5d21e' }, { name: 'Blue', hex: '#1e46aa' }, { name: 'Red', hex: '#c81e28' }], saved_at: stamp(-16) })
saveSep(J.brewfest, { colors: 2, screens: 3, dark: true, garment: 'Navy', mode: 'spot',
  inks: [{ name: 'Cream', hex: '#e8dcc0' }, { name: 'Green', hex: '#2f6b3f' }], saved_at: stamp(-11) })

/* ---------- activity ---------- */

const act = (type, desc, { c, j, at }) => run('INSERT INTO activities (contact_id, job_id, type, description, created_at) VALUES (?,?,?,?,?)',
  c ? cid[c] : null, j || null, type, desc, at)

act('estimate', `Estimate ${E.wildcats.num} created — ${usd(E.wildcats.total)}`, { c: 'Jamie Rivera', at: stamp(-21) })
act('estimate', `Estimate ${E.wildcats.num} emailed to jamie.rivera@example.edu`, { c: 'Jamie Rivera', at: stamp(-20) })
act('estimate', `Estimate ${E.wildcats.num} APPROVED by Jamie Rivera online`, { c: 'Jamie Rivera', at: stamp(-18) })
act('invoice', `Estimate ${E.wildcats.num} converted — invoice ${I.wildcats.num}, job ${J.wildcats.num}`, { c: 'Jamie Rivera', j: J.wildcats.id, at: stamp(-18) })
act('art', 'Proof v1 changes requested by Jamie Rivera — "Gold reads too yellow next to the jersey"', { c: 'Jamie Rivera', j: J.wildcats.id, at: stamp(-18) })
act('art', 'Proof v2 APPROVED by Jamie Rivera — released to prepress', { c: 'Jamie Rivera', j: J.wildcats.id, at: stamp(-16) })
act('payment', `Payment ${usd(1400)} on ${I.wildcats.num} (check)`, { c: 'Jamie Rivera', at: stamp(-17) })
act('stage', `${J.wildcats.num} moved to Production`, { c: 'Jamie Rivera', j: J.wildcats.id, at: stamp(-2) })

act('estimate', `Estimate ${E.brewfest.num} APPROVED by Marcus Chen online`, { c: 'Marcus Chen', at: stamp(-12) })
act('payment', `Payment ${usd(1500)} on ${I.brewfest.num} (card)`, { c: 'Marcus Chen', at: stamp(-12) })
act('art', 'Proof v1 APPROVED by Marcus Chen — released to prepress', { c: 'Marcus Chen', j: J.brewfest.id, at: stamp(-11) })
act('stage', `${J.brewfest.num} moved to Prepress`, { c: 'Marcus Chen', j: J.brewfest.id, at: stamp(-11) })

act('estimate', `Estimate ${E.summit.num} APPROVED by Priya Nair online`, { c: 'Priya Nair', at: stamp(-7) })
act('art', 'Proof v1 sent to priya@example.com', { c: 'Priya Nair', j: J.summit.id, at: stamp(-1) })
act('note', 'Called Priya re: Pantone 2925 C — she is sending the brand book.', { c: 'Priya Nair', at: stamp(-1) })

act('payment', `Payment ${usd(E.forge.total)} on ${I.forge.num} (card)`, { c: 'Danny Ortiz', at: stamp(-4) })
act('stage', `${J.forge.num} moved to QC`, { c: 'Danny Ortiz', j: J.forge.id, at: stamp(0) })

act('estimate', `Estimate ${E.rosie.num} APPROVED by Rosie Almeida online`, { c: 'Rosie Almeida', at: stamp(-2) })
act('art', 'Proof v1 sent to rosie@example.com', { c: 'Rosie Almeida', j: J.rosie.id, at: stamp(0) })
act('note', 'Rosie called — new location opens Saturday, cannot slip.', { c: 'Rosie Almeida', at: stamp(-2) })

act('estimate', `Estimate ${E.northgate.num} emailed to alexis.kim@example.org`, { c: 'Alexis Kim', at: stamp(-2) })
act('estimate', `Estimate ${E.whitfield.num} emailed to sam@example.com`, { c: 'Sam Whitfield', at: stamp(-1) })
act('job', `Job ${J.walkin.num} created — 12 staff polos — walk-in`, { c: 'Terrence Wallace', j: J.walkin.id, at: stamp(0) })
act('contact', 'Contact created — Alexis Kim', { c: 'Alexis Kim', at: stamp(-3) })

/* ---------- outbox ---------- */

for (const [to, subj, kind, at, body] of [
  ['jamie.rivera@example.edu', `Estimate ${E.wildcats.num} from ${S.shop_name}`, 'estimate', stamp(-20), `Hi Jamie,\n\nThanks for the opportunity to quote this one. Estimate ${E.wildcats.num} for ${usd(E.wildcats.total)} is attached and viewable at the link below.\n\nApprove it and we will get you on the production schedule.\n\n— ${S.shop_name}`],
  ['priya@example.com', 'Proof v1 for 450 attendee tees — approval needed', 'art', stamp(-1), `Hi Priya,\n\nProof v1 for 450 attendee tees + 40 speaker hoodies is ready for your review. Check the placement, sizing, spelling, and colors — once you approve, this is exactly what we print.\n\n— ${S.shop_name}`],
  ['rosie@example.com', 'Proof v1 for 24 embroidered aprons — approval needed', 'art', stamp(0), `Hi Rosie,\n\nProof v1 for 24 embroidered aprons — RUSH is ready for your review. Check the placement, sizing, spelling, and colors — once you approve, this is exactly what we print.\n\n— ${S.shop_name}`],
  ['alexis.kim@example.org', `Estimate ${E.northgate.num} from ${S.shop_name}`, 'estimate', stamp(-2), `Hi Alexis,\n\nThanks for the opportunity to quote this one. Estimate ${E.northgate.num} for ${usd(E.northgate.total)} is attached and viewable at the link below.\n\nApprove it and we will get you on the production schedule.\n\n— ${S.shop_name}`],
]) run('INSERT INTO email_log (contact_id, to_email, subject, body, kind, created_at) VALUES (?,?,?,?,?,?)', null, to, subj, body, kind, at)

/* ---------- pipeline / opportunities ---------- */

const opp = (est, stage, { won = null, lost = null, reason = '', order = 0 } = {}) => {
  const e = get('SELECT * FROM estimates WHERE id = ?', est.id)
  const title = JSON.parse(e.items)[0]?.description || 'Quote'
  /* dealValue, not e.total. total is subtotal + sales tax, and the tax is the state's money —
   * lib/pipeline.mjs writes every opportunity in the running app through dealValue for exactly
   * that reason. The seed wrote the taxed figure, so the demo shop shipped a pipeline that
   * contradicts the code that maintains it: Won read $15,218.04 where the app's own definition
   * says $14,283.50, and the first time anything touched one of those estimates the card moved. */
  run(`INSERT INTO opportunities (contact_id, estimate_id, title, stage, value, source, sort_order, won_at, lost_at, lost_reason, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    e.contact_id, e.id, title, stage, dealValue(e), 'estimate', order, won, lost, reason, e.created_at, stamp(-1))
}
// Estimates map onto the pipeline: approved = won, sent = out for signature, draft = quoted.
opp(E.wildcats, 'won', { won: stamp(-18) })
opp(E.brewfest, 'won', { won: stamp(-12) })
opp(E.summit, 'won', { won: stamp(-7) })
opp(E.forge, 'won', { won: stamp(-4) })
opp(E.rosie, 'won', { won: stamp(-2) })
opp(E.northgate, 'sent', { order: 0 })
opp(E.whitfield, 'negotiation', { order: 1 })
opp(E.parks, 'quoted', { order: 0 })

// Pure leads with no estimate yet — the top of the funnel a shop works.
const lead = (contact, title, value, order, notes) =>
  run(`INSERT INTO opportunities (contact_id, title, stage, value, source, sort_order, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    cid[contact], title, 'lead', value, 'referral', order, notes, stamp(-1), stamp(-1))
lead('Terrence Wallace', 'Summer camp shirts — youth safety green', 1900, 0, 'Emailed asking for a quote. Youth sizes.')
lead('Alexis Kim', 'Basketball warmups — reorder', 3200, 1, 'Mentioned wanting warmups after football wraps.')

/* ---------- conversations ---------- */

const msg = (contact, direction, channel, body, at, { subject = '', read = 1, kind = '' } = {}) =>
  run('INSERT INTO messages (contact_id, direction, channel, subject, body, kind, read, created_at) VALUES (?,?,?,?,?,?,?,?)',
    cid[contact], direction, channel, subject, body, kind, read, at)

// Priya — a live back-and-forth about the Pantone match, with an unread reply waiting.
msg('Priya Nair', 'out', 'email', 'Hi Priya,\n\nProof v1 for the attendee tees is ready. The blue is mixed to Pantone 2925 C exactly.\n\n— Rebel Ink Press', stamp(-1, 9), { subject: 'Proof v1 — Summit tees' })
msg('Priya Nair', 'in', 'email', 'Looks great! One thing — can we nudge the logo up about a quarter inch? Otherwise approved.', stamp(-1, 11), { subject: 'Re: Proof v1 — Summit tees', read: 0, kind: 'inbound' })
msg('Priya Nair', 'in', 'email', 'Also — any chance we can add 25 more mediums? Headcount went up.', stamp(0, 8), { subject: 'Re: Proof v1 — Summit tees', read: 0, kind: 'inbound' })

// Rosie — rush aprons, texting.
msg('Rosie Almeida', 'out', 'sms', 'Hi Rosie — proof for the aprons is in your inbox, need sign-off today to hit Friday.', stamp(0, 8), { subject: 'SMS' })
msg('Rosie Almeida', 'in', 'sms', 'Just approved it! You are a lifesaver 🙏', stamp(0, 10), { subject: 'SMS', read: 0, kind: 'inbound' })

// Marcus — settled thread, all read.
msg('Marcus Chen', 'out', 'email', 'Hi Marcus,\n\nDeposit received, you are on the schedule. Booth confirmed for Saturday 11-7.\n\n— Rebel Ink Press', stamp(-12, 10), { subject: 'Brewfest — confirmed' })
msg('Marcus Chen', 'in', 'email', 'Perfect. See you Saturday.', stamp(-12, 14), { subject: 'Re: Brewfest — confirmed' })

// Terrence — an inbound question with no reply yet (a lead to work).
msg('Terrence Wallace', 'in', 'email', 'Hi — following up on those summer camp shirts. Can you do safety green in youth sizes? Need a quote.', stamp(-1, 15), { subject: 'Summer camp shirts', read: 0, kind: 'inbound' })

/* ---------- price matrices ----------
 * Two on purpose, and deliberately different shapes: the screen-print sheet a demo shop expects,
 * and a mug sheet that has nothing to do with ink colours. The second one IS the feature — a matrix
 * carries no built-in meaning, so a shop can hold pricing for work this software never modelled.
 */
const { createFromTemplate } = await import('./lib/matrices.mjs')
createFromTemplate('screen-print', { isDefault: true })
createFromTemplate('drinkware')

const n = (t) => get(`SELECT COUNT(*) AS c FROM ${t}`).c
console.log(`\n  Seeded ${n('contacts')} customers · ${n('estimates')} estimates · ${n('invoices')} invoices · ${n('jobs')} jobs · ${n('art_versions')} proofs · ${n('price_matrices')} price matrices · ${n('activities')} activities`)
console.log(`  Revenue MTD: $${get(`SELECT COALESCE(SUM(amount),0) AS v FROM payments WHERE date(created_at) >= date('now','start of month')`).v.toFixed(2)}`)
console.log(`  Run: npm start → http://localhost:3333\n`)
