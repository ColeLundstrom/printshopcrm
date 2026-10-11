import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createHttpTestServer } from './helpers/http-test-server.mjs'

// Exercise the real public handler without a staff cookie. Both shops and every upload are
// disposable fixtures; the demo launcher blocks outbound providers throughout this suite.
test('public proof decisions are explicit, tenant-bound and recoverable', { timeout: 120000 }, async t => {
  const temp = mkdtempSync(join(tmpdir(), 'psc-proof-boundaries-'))
  const dest = join(temp, 'demo')
  const server = await createHttpTestServer()
  const databases = []
  try {
    const built = spawnSync(process.execPath, ['bin/demo.mjs', dest, String(server.port)], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 90000 })
    assert.equal(built.status, 0, built.stderr)
    const env = JSON.parse(readFileSync(join(dest, 'demo-env.json'), 'utf8'))
    const primarySlug = readdirSync(join(dest, 'data/tenants'))[0]
    const password = readFileSync(join(dest, 'LOGIN.txt'), 'utf8').match(/Password: (.+)/)[1]
    const created = spawnSync(process.execPath, ['--no-warnings', '--import', './bin/demo-network-guard.mjs', '--input-type=module', '-e', `
      import {createTenant,saveOnboarding} from './lib/tenants.mjs';
      const shop=await createTenant({shop_name:'Boundary shop',owner_name:'Fixture owner',owner_email:'boundary@example.test',password:process.env.FIXTURE_PASSWORD});
      saveOnboarding(shop.id,{done:true});console.log(shop.slug);
    `], { cwd: dest, env: { ...env, FIXTURE_PASSWORD: password }, encoding: 'utf8', timeout: 30000 })
    assert.equal(created.status, 0, created.stderr)
    const secondarySlug = created.stdout.trim()
    assert.match(secondarySlug, /^[a-z0-9-]+$/)
    const open = slug => {
      const db = new DatabaseSync(join(dest, 'data/tenants', slug, 'printshop.db'))
      db.exec('PRAGMA busy_timeout=5000; UPDATE automations SET enabled=0')
      databases.push(db)
      return db
    }
    const db = open(primarySlug), otherDb = open(secondarySlug)
    await server.start({ cwd: dest, env, args: ['--no-warnings', '--import', './bin/demo-network-guard.mjs', 'server.mjs'] })
    const login = async email => {
      const response = await fetch(server.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })
      assert.equal(response.status, 200)
      return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    }
    const cookie = await login('dylan@example.test'), otherCookie = await login('boundary@example.test')
    const staff = async (path, body, method = 'POST', session = cookie) => {
      const response = await fetch(server.base + path, { method, headers: { Cookie: session, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      return response
    }
    const json = async (...args) => {
      const response = await staff(...args)
      assert.equal(response.status, 200, await response.clone().text())
      return response.json()
    }
    const contact = await json('/api/contacts', { name: 'Proof boundary customer', email: 'proof@example.test' })
    const otherContact = await json('/api/contacts', { name: 'Other shop customer', email: 'other@example.test' }, 'POST', otherCookie)
    const newJob = (title, session = cookie, contactId = contact.id) => json('/api/jobs', { contact_id: contactId, title, approval_gated: true }, 'POST', session)
    const upload = async (job, session = cookie) => {
      const form = new FormData()
      form.append('file', new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="navy"/></svg>'], { type: 'image/svg+xml' }), 'synthetic-proof.svg')
      const response = await fetch(server.base + '/api/jobs/' + job.id + '/art', { method: 'POST', headers: { Cookie: session }, body: form })
      assert.equal(response.status, 200, await response.clone().text())
      const art = await response.json()
      return (await json('/api/jobs/' + job.id, undefined, 'GET', session)).art.find(row => row.id === art.id)
    }
    const decision = (link, body, type = 'application/x-www-form-urlencoded') => fetch(server.base + link.replace('?', '/decide?'), {
      method: 'POST', redirect: 'manual', headers: { 'Content-Type': type }, body: type === 'application/json' ? JSON.stringify(body) : body,
    })
    const snapshot = (art, job, database = db) => ({
      art: database.prepare('SELECT * FROM art_versions WHERE id=?').get(art.id),
      job: database.prepare('SELECT * FROM jobs WHERE id=?').get(job.id),
      activities: database.prepare('SELECT * FROM activities WHERE job_id=? ORDER BY id').all(job.id),
      runs: database.prepare('SELECT * FROM automation_runs WHERE entity_type=? AND entity_id=? ORDER BY id').all('job', job.id),
    })

    await t.test('ambiguous or malformed fields never sign off artwork', async () => {
      const job = await newJob('Explicit decisions only'), art = await upload(job)
      const before = snapshot(art, job)
      const bodies = [
        ['decision=rejected&approved=1', 'application/x-www-form-urlencoded'],
        ['decision=approved&approved=false', 'application/x-www-form-urlencoded'],
        ['decision=typo&approved=1', 'application/x-www-form-urlencoded'],
        ['decision=approved&approved=typo', 'application/x-www-form-urlencoded'],
        ['decision=approved&decision=rejected&approved=1', 'application/x-www-form-urlencoded'],
        ['approved=1&approved=0&decision=approved', 'application/x-www-form-urlencoded'],
        ['decision=approved&notes=first&notes=second', 'application/x-www-form-urlencoded'],
        [{ decision: ['rejected'], approved: '1' }, 'application/json'],
        [{ decision: 'approved', notes: { text: 'not a note' } }, 'application/json'],
        [{ decision: 'approved', approved: true }, 'application/json'],
        [{ decision: 'approved', notes: null }, 'application/json'],
        ['decision=', 'application/x-www-form-urlencoded'],
        ['notes=Please+make+the+logo+larger', 'application/x-www-form-urlencoded'],
      ]
      for (const [body, type] of bodies) {
        const response = await decision(art.share_url, body, type)
        assert.equal(response.status, 400, 'Invalid payload: ' + JSON.stringify(body))
        assert.deepEqual(snapshot(art, job), before, 'Invalid payload must leave proof, production and audit unchanged')
      }
      assert.equal((await decision(art.share_url, 'decision=approved')).status, 302, 'A valid retry remains possible')
    })

    await t.test('canonical decisions and documented legacy aliases retain their exact meaning', async () => {
      for (const [body, expected] of [
        ['decision=approved', 'approved'], ['decision=rejected&notes=Move+logo+left', 'rejected'],
        ['approved=1', 'approved'], ['approved=true', 'approved'],
        ['approved=0&notes=Move+logo+left', 'rejected'], ['approved=false&notes=Move+logo+left', 'rejected'],
        ['decision=approved&approved=1', 'approved'], ['decision=rejected&approved=false&notes=Move+logo+left', 'rejected'],
      ]) {
        const job = await newJob('Compatible decision ' + body), art = await upload(job)
        const response = await decision(art.share_url, body)
        assert.equal(response.status, 302, body)
        assert.equal(response.headers.get('location'), art.share_url)
        assert.equal(db.prepare('SELECT status FROM art_versions WHERE id=?').get(art.id).status, expected)
      }
    })

    await t.test('tokens stay bound to the proof, shop and row identity after deletion', async () => {
      const job = await newJob('Primary proof'), art = await upload(job)
      const otherJob = await newJob('Second shop proof', otherCookie, otherContact.id), otherArt = await upload(otherJob, otherCookie)
      // Equal numeric IDs in two shop databases must not make either token transferable.
      otherDb.prepare('UPDATE art_versions SET id=? WHERE id=?').run(art.id, otherArt.id)
      otherArt.id = art.id
      const before = snapshot(art, job), otherBefore = snapshot(otherArt, otherJob, otherDb)
      const url = new URL(art.share_url, server.base)
      const invalid = []
      for (const [key, value] of [['s', secondarySlug], ['s', 'missing-fixture-shop'], ['k', '0'.repeat(16)], ['k', ''], ['s', '']]) {
        const altered = new URL(url)
        altered.searchParams.set(key, value)
        invalid.push(altered.pathname + altered.search)
      }
      const otherProof = await upload(await newJob('Different proof'))
      invalid.push(art.share_url.replace('/art/' + art.id + '?', '/art/' + otherProof.id + '?'))
      for (const link of invalid) {
        assert.ok([403, 404].includes((await fetch(server.base + link)).status), link)
        assert.ok([403, 404].includes((await decision(link, 'decision=approved')).status), link)
      }
      assert.deepEqual(snapshot(art, job), before)
      assert.deepEqual(snapshot(otherArt, otherJob, otherDb), otherBefore)
      const page = await fetch(server.base + art.share_url)
      assert.equal(page.status, 200)
      const uploadUrl = (await page.text()).match(/<img src="([^"]*\/uploads\/[^\"]+)" alt="Proof/)[1].replaceAll('&amp;', '&')
      assert.equal((await fetch(server.base + uploadUrl)).status, 200)
      await json('/api/jobs/' + job.id + '/art/' + art.id, undefined, 'DELETE')
      assert.ok([403, 404].includes((await decision(art.share_url, 'decision=approved')).status))
      assert.equal((await fetch(server.base + uploadUrl)).status, 404, 'Deleted public bytes are revoked')
      const replacement = await upload(job)
      // Force SQLite row-ID reuse to exercise the random per-row share key, not sequence luck.
      db.prepare('UPDATE art_versions SET id=? WHERE id=?').run(art.id, replacement.id)
      assert.equal((await fetch(server.base + art.share_url)).status, 403)
      assert.equal((await decision(art.share_url, 'decision=approved')).status, 403)
      assert.equal(db.prepare('SELECT status FROM art_versions WHERE id=?').get(art.id).status, 'draft')
    })

    await t.test('a newer upload blocks a stale open form and opposing concurrent decisions commit once', async () => {
      const job = await newJob('Two open customer tabs'), old = await upload(job)
      assert.match(await (await fetch(server.base + old.share_url)).text(), /Approve proof<\/button>/)
      const current = await upload(job), before = snapshot(current, job)
      assert.equal((await decision(old.share_url, 'decision=approved')).status, 409)
      assert.deepEqual(snapshot(current, job), before)
      assert.doesNotMatch(await (await fetch(server.base + old.share_url)).text(), /Approve proof<\/button>/)
      const responses = await Promise.all([
        decision(current.share_url, 'decision=approved'),
        decision(current.share_url, 'decision=rejected&notes=Move+logo+left'),
      ])
      assert.deepEqual(responses.map(response => response.status), [302, 302])
      const decided = snapshot(current, job)
      assert.ok(['approved', 'rejected'].includes(decided.art.status))
      assert.equal(decided.activities.filter(row => /APPROVED|changes requested/.test(row.description)).length, 1)
      for (const body of ['decision=approved', 'decision=rejected&notes=Different+late+feedback']) {
        assert.equal((await decision(current.share_url, body)).status, 302)
        assert.equal((await staff('/api/art/' + current.id + '/decide', { decision: 'approved' })).status, 409)
        assert.deepEqual(snapshot(current, job), decided, 'Repeat public and staff actions cannot overwrite the first decision')
      }
    })

    await t.test('failed customer release rolls back before automation and the same link can retry', async () => {
      const job = await newJob('Approval error recovery'), art = await upload(job)
      db.prepare(`INSERT INTO automations(name,enabled,trigger,actions) VALUES (?,1,'art.approved',?)`).run('Fixture local approval note', JSON.stringify([{ key: 'note.log', config: { body: 'Fixture approval dispatch' } }]))
      const before = snapshot(art, job)
      db.exec(`CREATE TRIGGER fail_boundary_activity BEFORE INSERT ON activities WHEN NEW.job_id=${job.id} BEGIN SELECT RAISE(ABORT, 'fixture approval failure'); END`)
      assert.equal((await decision(art.share_url, 'decision=approved')).status, 500)
      assert.deepEqual(snapshot(art, job), before, 'The proof, job, revision and audit roll back together')
      db.exec('DROP TRIGGER fail_boundary_activity')
      assert.equal((await decision(art.share_url, 'decision=approved')).status, 302)
      const released = snapshot(art, job)
      assert.equal(released.art.status, 'approved')
      assert.ok(released.job.art_approved_at)
      assert.equal(released.activities.filter(row => /APPROVED/.test(row.description)).length, 1)
      assert.equal(released.runs.length, 1, 'Only the committed decision dispatches automation')
      assert.equal(released.activities.filter(row => row.description === 'Fixture approval dispatch').length, 1)
      assert.equal((await decision(art.share_url, 'decision=approved')).status, 302)
      assert.deepEqual(snapshot(art, job), released)
    })

    await t.test('staff and customer decisions cannot overwrite each other or replay production release', async () => {
      const job = await newJob('Staff and customer race'), art = await upload(job)
      const [customer, staffResponse] = await Promise.all([
        decision(art.share_url, 'decision=approved'),
        staff('/api/art/' + art.id + '/decide', { decision: 'rejected', notes: 'Move the logo left', by: 'Fixture staff' }),
      ])
      assert.equal(customer.status, 302)
      assert.ok([200, 409].includes(staffResponse.status))
      const firstDecision = snapshot(art, job)
      assert.equal(firstDecision.art.status, staffResponse.status === 200 ? 'rejected' : 'approved')
      assert.equal(firstDecision.activities.filter(row => /APPROVED|changes requested/.test(row.description)).length, 1)
      if (firstDecision.art.status === 'approved') await json('/api/jobs/' + job.id + '/stage', { stage: 'production' }, 'PATCH')
      const beforeReplay = snapshot(art, job)
      assert.equal((await decision(art.share_url, 'decision=approved')).status, 302)
      assert.deepEqual(snapshot(art, job), beforeReplay, 'Replayed customer form never moves production backwards or repeats dispatch')
    })
  } finally {
    await server.close()
    for (const db of databases) db.close()
    rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
