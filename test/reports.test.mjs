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
const TZ = 'America/Los_Angeles'
const laToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const shift = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }

test('the Reports screen is routed, in the Money tools, and styled', () => {
  const app = read('public/js/app.js')
  assert.match(app, /import \{ reportsView \} from '\.\/views\/reports\.js'/)
  assert.match(app, /route\(\/\^\\\/reports\(\?:\\\?\.\*\)\?\$\/, reportsView\)/)
  const tools = app.slice(app.indexOf('const TOOLS = ['))
  const money = tools.slice(tools.indexOf("{ label: 'Money', section: true },"))
  assert.match(money.split('\n')[1], /href: '\/reports', ico: 'roi', name: 'Reports', manage: true/, 'Reports leads the Money section')
  assert.match(read('public/index.html'), /\/css\/reports\.css\?v=__ASSET_V__/)
  assert.doesNotMatch(read('public/js/views/reports.js'), /on\(\$\('#view'\)/)
})

test('reports total invoices, payments, tax and aging on the shop calendar, manager-only, with CSV downloads', { timeout: 120000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'psc-reports-')), dest = join(temp, 'demo'), server = await createHttpTestServer()
  let control, db
  try {
    const built = spawnSync(process.execPath, ['bin/demo.mjs', dest, String(server.port)], { cwd: ROOT, encoding: 'utf8', timeout: 90000 })
    assert.equal(built.status, 0, built.stderr)
    const env = JSON.parse(readFileSync(join(dest, 'demo-env.json'), 'utf8')); env.PSC_TICK_MS = '3600000'
    control = new DatabaseSync(join(dest, 'data/control.db')); control.exec('PRAGMA busy_timeout=5000')
    const owner = control.prepare("SELECT * FROM members WHERE role = 'owner' LIMIT 1").get() || control.prepare('SELECT * FROM members LIMIT 1').get()
    const expires = "datetime('now','+1 hour')"
    control.prepare(`INSERT INTO sessions(token,tenant_id,member_id,expires_at) VALUES(?,?,?,${expires})`).run('reports-owner', owner.tenant_id, owner.id)
    const staffId = Number(control.prepare('INSERT INTO members(tenant_id,name,email,password_hash,role,status) VALUES(?,?,?,?,?,?)').run(owner.tenant_id, 'Report staff', 'reports-staff@example.test', owner.password_hash, 'staff', 'active').lastInsertRowid)
    control.prepare(`INSERT INTO sessions(token,tenant_id,member_id,expires_at) VALUES(?,?,?,${expires})`).run('reports-staff', owner.tenant_id, staffId)

    db = new DatabaseSync(join(dest, 'data/tenants', readdirSync(join(dest, 'data/tenants'))[0], 'printshop.db'))
    db.exec('PRAGMA busy_timeout=5000')
    db.exec(`UPDATE automations SET enabled=0; UPDATE invoices SET status='void';`)
    db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('timezone',?)").run(TZ)
    const contact = db.prepare('INSERT INTO contacts(name,company) VALUES(?,?)')
    const alpha = Number(contact.run('Report Alpha', 'Alpha Athletics').lastInsertRowid)
    const beta = Number(contact.run('Report Beta', '=cmd|evil').lastInsertRowid)
    const est = db.prepare('INSERT INTO estimates(contact_id,estimate_number,status,items,subtotal,tax,total,sent_at,approved_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    const items = JSON.stringify([
      { description: 'Tees', decoration: 'Screen Print', qty: 10, unit_price: 20, taxable: true },
      { description: 'Caps', decoration: 'Embroidery', qty: 5, unit_price: 20, taxable: false },
    ])
    const e1 = Number(est.run(alpha, 'RPT-E1', 'approved', items, 300, 16, 316, '2025-03-02 15:00:00', '2025-03-05 15:00:00', '2025-03-01 15:00:00').lastInsertRowid)
    est.run(beta, 'RPT-E2', 'declined', '[]', 80, 0, 80, '2025-03-10 15:00:00', null, '2025-03-10 15:00:00')
    est.run(beta, 'RPT-E3', 'draft', '[]', 50, 0, 50, null, null, '2025-03-11 15:00:00')
    const today = laToday()
    const inv = db.prepare('INSERT INTO invoices(estimate_id,contact_id,invoice_number,status,amount_due,amount_paid,due_date,created_at) VALUES(?,?,?,?,?,?,?,?)')
    const i1 = Number(inv.run(e1, alpha, 'RPT-1', 'partial', 316, 158, '2025-04-04', '2025-03-05 16:00:00').lastInsertRowid)
    inv.run(null, beta, 'RPT-2', 'overdue', 100, 0, '2025-03-25', '2025-03-20 12:00:00')
    inv.run(null, beta, 'RPT-VOID', 'void', 999, 0, '2025-03-25', '2025-03-10 12:00:00')
    // 12:00 UTC on Apr 1 is 05:00 Apr 1 in Los Angeles: April, outside March.
    inv.run(null, alpha, 'RPT-4', 'unpaid', 50, 0, shift(today, 10), '2025-04-01 12:00:00')
    inv.run(null, alpha, 'RPT-5', 'overdue', 25, 0, shift(today, -45), '2025-04-02 12:00:00')
    // 03:00 UTC on Apr 1 is still Mar 31 in Los Angeles — this payment is March money.
    db.prepare('INSERT INTO payments(invoice_id,amount,method,created_at) VALUES(?,?,?,?)').run(i1, 158, 'check', '2025-04-01 03:00:00')
    db.prepare("INSERT INTO jobs(contact_id,job_number,title,status,stage,ship_date) VALUES(?,?,?,'complete','complete','2025-03-15')").run(alpha, 'RPT-J1', 'Done job')

    await server.start({ cwd: dest, env, args: ['--no-warnings', '--import', './bin/demo-network-guard.mjs', 'server.mjs'] })
    const fetchAs = (path, cookie = 'psc_session=reports-owner') => fetch(server.base + path, { headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(15000) })

    assert.equal((await fetchAs('/api/reports', null)).status, 401)
    assert.equal((await fetchAs('/api/reports', 'psc_session=reports-staff')).status, 403, 'staff cannot read money reports')
    assert.equal((await fetchAs('/api/reports/sales-by-month.csv', 'psc_session=reports-staff')).status, 403)
    for (const q of ['from=2025-02-30', 'from=2025-03-31&to=2025-03-01', 'to=nope', 'from=2025-3-1']) assert.equal((await fetchAs('/api/reports?' + q)).status, 400, q)

    const def = await fetchAs('/api/reports')
    assert.equal(def.status, 200)
    const d = await def.json()
    assert.equal(d.to, today); assert.equal(d.from, today.slice(0, 8) + '01', 'defaults to this month on the shop calendar')

    const r = await (await fetchAs('/api/reports?from=2025-03-01&to=2025-03-31')).json()
    assert.deepEqual(r.summary, {
      invoiced: 416, invoices: 2, sales_pre_tax: 400, collected: 158,
      sales_tax_invoiced: 16, sales_tax_collected: 8,
      open_ar: 333, overdue_ar: 283,
      estimates_sent: 2, estimates_won: 1, estimates_won_value: 300, win_rate: 50,
      avg_order_value: 208, jobs_completed: 1,
    })
    assert.equal(r.sales_by_month.length, 12)
    assert.equal(r.sales_by_month[0].month, '2024-04')
    assert.deepEqual(r.sales_by_month.at(-1), { month: '2025-03', invoiced: 416, sales: 400, tax: 16, collected: 158, invoices: 2 })
    assert.deepEqual(r.sales_by_customer.map((c) => [c.name, c.invoices, c.invoiced, c.collected]), [['Report Alpha', 1, 316, 158], ['Report Beta', 1, 100, 0]])
    assert.deepEqual(r.sales_by_decoration.map((x) => [x.decoration, x.sales]), [['Screen Print', 200], ['Embroidery', 100], ['Not itemized', 100]])
    assert.deepEqual(r.sales_tax, [{ month: '2025-03', sales: 400, taxable_sales: 200, exempt_sales: 200, tax: 16, tax_collected: 8 }])
    const bucket = Object.fromEntries(r.ar_aging.buckets.map((b) => [b.key, b]))
    assert.equal(r.ar_aging.total, 333)
    assert.deepEqual([bucket.current.total, bucket.d30.total, bucket.d60.total, bucket.d90.total, bucket.d90p.total], [50, 0, 25, 0, 258])
    assert.deepEqual(bucket.d90p.invoices.map((i) => i.number).sort(), ['RPT-1', 'RPT-2'])
    assert.equal(bucket.d60.invoices[0].days_past, 45)

    // April starts with the 05:00-local invoice and none of March's payment.
    const april = await (await fetchAs('/api/reports?from=2025-04-01&to=2025-04-30')).json()
    assert.equal(april.summary.invoiced, 75)
    assert.equal(april.summary.collected, 0)

    const csv = await fetchAs('/api/reports/sales-by-customer.csv?from=2025-03-01&to=2025-03-31')
    assert.equal(csv.status, 200)
    assert.match(csv.headers.get('content-type'), /^text\/csv/)
    assert.equal(csv.headers.get('cache-control'), 'private, no-store')
    assert.match(csv.headers.get('content-disposition'), /^attachment; filename="printshopcrm-sales-by-customer-2025-03-01-to-2025-03-31\.csv"$/)
    const lines = (await csv.text()).trim().split('\n')
    assert.equal(lines[0], 'Customer,Company,Invoices,Invoiced,Collected')
    assert.deepEqual(lines.slice(1), ['Report Alpha,Alpha Athletics,1,316,158', "Report Beta,'=cmd|evil,1,100,0"], 'formula cells are neutralized')
    for (const kind of ['sales-by-month', 'sales-by-decoration', 'ar-aging', 'sales-tax']) {
      const res = await fetchAs(`/api/reports/${kind}.csv?from=2025-03-01&to=2025-03-31`)
      assert.equal(res.status, 200, kind)
      assert.match(res.headers.get('content-disposition'), /attachment/)
      assert.ok((await res.text()).split('\n').length > 1, kind)
    }
    const aging = (await (await fetchAs('/api/reports/ar-aging.csv')).text()).trim().split('\n')
    assert.equal(aging.length, 5, 'header plus the four open invoices')
    assert.equal((await fetchAs('/api/reports/nope.csv')).status, 404)
    assert.equal((await fetchAs('/api/reports/sales-tax.csv?from=bad')).status, 400)
    // The older A/R endpoint and this report agree on what is owed.
    assert.equal((await (await fetchAs('/api/reports/ar-aging')).json()).totals.due, r.ar_aging.total)
  } finally {
    db?.close(); control?.close()
    await server.close()
    rmSync(temp, { recursive: true, force: true })
  }
})
