import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHttpTestServer } from './helpers/http-test-server.mjs'

test('quick search visibility is independent, tenant scoped and preserves records', { timeout: 120000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'psc-search-'))
  const dest = join(temp, 'demo')
  const server = await createHttpTestServer()
  let db, control
  try {
    const built = spawnSync(process.execPath, ['bin/demo.mjs', dest, String(server.port)], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 90000,
    })
    assert.equal(built.status, 0, built.stderr)
    const env = JSON.parse(readFileSync(join(dest, 'demo-env.json'), 'utf8'))
    env.PSC_TICK_MS = '3600000'
    db = new DatabaseSync(join(dest, 'data/tenants', readdirSync(join(dest, 'data/tenants'))[0], 'printshop.db'))
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON')
    const quote = Number(db.prepare("INSERT INTO estimates(estimate_number,status,total) VALUES('SEARCH-QUOTE-816','draft',19)").run().lastInsertRowid)
    const approved = Number(db.prepare("INSERT INTO estimates(estimate_number,status,total) VALUES('SEARCH-APPROVED-816','approved',29)").run().lastInsertRowid)
    const qjob = Number(db.prepare("INSERT INTO jobs(estimate_id,job_number,title,stage) VALUES(?,'SEARCH-JOB-816','SEARCH-JOB-816','new')").run(quote).lastInsertRowid)
    db.prepare("INSERT INTO jobs(estimate_id,job_number,title,stage) VALUES(?,'SEARCH-APPROVED-JOB-816','SEARCH-APPROVED-JOB-816','new')").run(approved)
    db.exec("INSERT INTO jobs(job_number,title,stage) VALUES('SEARCH-MANUAL-JOB-816','SEARCH-MANUAL-JOB-816','new'); INSERT INTO invoices(invoice_number,amount_due,status) VALUES('SEARCH-INVOICE-816',19,'unpaid')")
    // Rehearse an older shop database with no rows for the new preferences.
    db.exec("DELETE FROM settings WHERE key IN ('search_estimates','search_quote_jobs')")
    const records = () => JSON.stringify(['estimates','jobs','invoices'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()))
    const before = records()

    control = new DatabaseSync(join(dest, 'data/control.db'))
    control.exec('PRAGMA busy_timeout=5000')
    const owner = control.prepare('SELECT * FROM members LIMIT 1').get()
    const staff = Number(control.prepare("INSERT INTO members(tenant_id,name,email,password_hash,role,status) VALUES(?,'Staff','search-staff@example.test',?,'staff','active')").run(owner.tenant_id, owner.password_hash).lastInsertRowid)
    const session = control.prepare("INSERT INTO sessions(token,tenant_id,member_id,expires_at) VALUES(?,?,?,datetime('now','+1 hour'))")
    session.run('search-owner', owner.tenant_id, owner.id)
    session.run('search-staff', owner.tenant_id, staff)
    const other = spawnSync(process.execPath, ['--no-warnings','--input-type=module','-e',
      "const t=await import('./lib/tenants.mjs');const shop=await t.createTenant({shop_name:'Other shop',owner_email:'search-other@example.test',password:'fixture-password-123'});t.createSession(shop.id,t.firstOwnerId(shop.id));"],
      { cwd: dest, env, encoding: 'utf8', timeout: 30000 })
    assert.equal(other.status, 0, other.stderr)
    const otherToken = control.prepare('SELECT token FROM sessions WHERE tenant_id!=? LIMIT 1').get(owner.tenant_id).token

    await server.start({ cwd: dest, env, args: ['--no-warnings','--import','./bin/demo-network-guard.mjs','server.mjs'] })
    const request = async (path, token = 'search-owner', method = 'GET', body) => {
      const response = await fetch(server.base + path, {
        method, headers: token ? { cookie: `psc_session=${token}`, ...(body ? { 'content-type': 'application/json' } : {}) } : {},
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000),
      })
      return { status: response.status, body: await response.json() }
    }
    const search = async (term, token) => (await request(`/api/search?q=${encodeURIComponent(term)}`, token)).body
    assert.equal((await request('/api/search?q=SEARCH-QUOTE-816', null)).status, 401)
    assert((await search('SEARCH-QUOTE-816')).some(row => row.type === 'estimate'))
    assert((await search('SEARCH-JOB-816')).some(row => row.id === qjob && row.type === 'job'))
    assert.equal((await request('/api/settings', 'search-staff')).body.settings.search_estimates, 'on')
    assert.equal((await request('/api/settings', 'search-staff', 'PUT', { search_estimates: 'off' })).status, 403)
    assert.equal((await request('/api/settings', 'search-owner', 'PUT', { search_estimates: 'invalid' })).status, 400)

    assert.equal((await request('/api/settings', 'search-owner', 'PUT', { search_estimates: 'off' })).status, 200)
    assert(!(await search('SEARCH-QUOTE-816')).some(row => row.type === 'estimate'))
    assert((await search('SEARCH-JOB-816')).some(row => row.id === qjob && row.type === 'job'))
    assert.equal((await request('/api/settings', 'search-owner', 'PUT', { search_quote_jobs: 'off' })).status, 200)
    assert(!(await search('SEARCH-JOB-816')).some(row => row.id === qjob && row.type === 'job'))
    assert((await search('SEARCH-APPROVED-JOB-816')).some(row => row.type === 'job'))
    assert((await search('SEARCH-MANUAL-JOB-816')).some(row => row.type === 'job'))
    assert((await search('SEARCH-INVOICE-816')).some(row => row.type === 'invoice'))
    assert((await request('/api/estimates?status=all')).body.some(row => row.id === quote), 'Full estimate list remains available')
    assert.equal((await request(`/api/jobs/${qjob}`)).status, 200)
    assert.equal((await request('/api/settings', 'search-owner')).body.settings.search_quote_jobs, 'off')
    assert.equal((await request('/api/settings', otherToken)).body.settings.search_estimates, 'on')
    assert(!(await search('SEARCH-QUOTE-816', otherToken)).some(row => row.type === 'estimate'), 'Other tenant cannot see this shop')
    assert.equal(records(), before, 'Search preferences must not change commercial records')
  } finally { await server.close(); db?.close(); control?.close(); rmSync(temp, { recursive: true, force: true }) }
})
