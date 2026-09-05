import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createHttpTestServer } from './helpers/http-test-server.mjs'
import { DatabaseSync } from 'node:sqlite'
import { supportsImportCheckpointVersion } from '../lib/import-checkpoints.mjs'

const versionDb = new DatabaseSync(':memory:')
const fixedSqlite = supportsImportCheckpointVersion(versionDb.prepare('SELECT sqlite_version() version').get().version)
versionDb.close()

// Subprocesses keep the real tenant registry, database handles and checkpoint worker lifecycle
// isolated from the test runner and from every other test's environment.
const modules = Object.fromEntries(['import-checkpoints', 'contact-import', 'tenants', 'db'].map(name =>
  [name, new URL(`../lib/${name}.mjs`, import.meta.url).href]))
const prelude = `
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
const { withImportCheckpoints, importCheckpointActive, shutdownImportCheckpoints } = await import(${JSON.stringify(modules['import-checkpoints'])})
const { writeContactImport } = await import(${JSON.stringify(modules['contact-import'])})
const contact = n => ({ name: 'Imported ' + n, email: 'import' + n + '@example.test', phone: '', company: '', notes: '', tags: '' })
const schema = \`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS contacts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, phone TEXT,
    company TEXT, notes TEXT, tags TEXT, created_at TEXT, updated_at TEXT, billing_address TEXT, shipping_address TEXT);
  CREATE INDEX IF NOT EXISTS contact_email ON contacts(lower(email));
  CREATE TABLE IF NOT EXISTS ordinary_writes (id INTEGER PRIMARY KEY, note TEXT);\`
`

function fixture(temp, name, body, { checkpointMode = 'on', ipc = false } = {}) {
  const script = join(temp, `${name}.mjs`)
  writeFileSync(script, prelude + body, { flag: 'wx' })
  const child = spawn(process.execPath, ['--no-warnings', script], {
    cwd: temp,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: temp, TMP: temp,
      PSC_DB: join(temp, 'default.db'), PSC_CONTROL_DB: join(temp, 'control.db'),
      PSC_IMPORT_CHECKPOINTS: checkpointMode },
    stdio: ['ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])],
  })
  let log = ''
  child.stdout.on('data', data => { log += data })
  child.stderr.on('data', data => { log += data })
  const finished = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${name} timed out\n${log}`)) }, 60000)
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, log }) })
  })
  return { child, finished }
}

async function succeeded(run) {
  const result = await run.finished
  assert.equal(result.signal, null, result.log)
  assert.equal(result.code, 0, result.log)
}

test('tenant deletion preserves the complete shop while any overlapping import lease is active', { timeout: 120000 }, async () => {
  for (const checkpointMode of ['on', 'off']) {
    const temp = mkdtempSync(join(tmpdir(), 'psc-import-delete-'))
    try {
      await succeeded(fixture(temp, 'delete-guard', `
        const { createTenant, openTenantDb, createSession, firstOwnerId, getTenantById, listMembers,
          getSession, deleteTenantFully } = await import(${JSON.stringify(modules.tenants)})
        const tenant = await createTenant({ shop_name: 'Checkpoint fixture', owner_name: 'Fixture Owner',
          owner_email: 'owner@example.test', password: 'Fixture-only-password' })
        const untouched = await createTenant({ shop_name: 'Other fixture', owner_name: 'Other Owner',
          owner_email: 'other@example.test', password: 'Fixture-only-password' })
        const db = openTenantDb(tenant.slug)
        const originalAuto = db.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint
        const token = createSession(tenant.id, firstOwnerId(tenant.id))
        const registryBefore = JSON.stringify({ tenant: getTenantById(tenant.id), members: listMembers(tenant.id), session: getSession(token) })
        const dir = join(process.cwd(), 'tenants', tenant.slug)
        let releaseFirst, releaseSecond, enteredFirst, enteredSecond
        const heldFirst = new Promise(resolve => { releaseFirst = resolve })
        const heldSecond = new Promise(resolve => { releaseSecond = resolve })
        const firstEntered = new Promise(resolve => { enteredFirst = resolve })
        const secondEntered = new Promise(resolve => { enteredSecond = resolve })
        const first = withImportCheckpoints(db, async checkpoint => {
          const imported = await writeContactImport(db, [contact(1)], { checkpoint })
          assert.equal(imported.created, 1); assert.equal(imported.stopped, null)
          enteredFirst(); await heldFirst
        })
        await firstEntered
        const second = withImportCheckpoints(db, async checkpoint => { await checkpoint(); enteredSecond(); await heldSecond })
        await secondEntered
        const assertRefusedIntact = () => {
          assert.equal(importCheckpointActive(db), true)
          assert.throws(() => deleteTenantFully(tenant.id), error => error.status === 409 && error.code === 'import_in_progress')
          assert.equal(JSON.stringify({ tenant: getTenantById(tenant.id), members: listMembers(tenant.id), session: getSession(token) }), registryBefore)
          assert.equal(existsSync(join(dir, 'printshop.db')), true)
          assert.equal(db.prepare('SELECT count(*) n FROM contacts').get().n, 1, 'refused deletion leaves the open database usable')
          assert.equal(getTenantById(untouched.id).owner_email, 'other@example.test')
        }
        assertRefusedIntact()
        releaseFirst(); await first
        assertRefusedIntact()
        releaseSecond(); await second
        assert.equal(importCheckpointActive(db), false)
        assert.equal(db.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint, originalAuto)
        const deleted = deleteTenantFully(tenant.id)
        assert.equal(deleted.ok, true); assert.equal(deleted.dataRemoved, true)
        assert.equal(getTenantById(tenant.id), undefined); assert.equal(listMembers(tenant.id).length, 0)
        assert.equal(getSession(token), null); assert.equal(existsSync(dir), false)
        assert.equal(getTenantById(untouched.id).owner_email, 'other@example.test')
        assert.equal(deleteTenantFully(untouched.id).dataRemoved, true)
        await shutdownImportCheckpoints()
        const { db: defaultDb } = await import(${JSON.stringify(modules.db)}); defaultDb.close()
      `, { checkpointMode }))
    } finally { rmSync(temp, { recursive: true, force: true }) }
  }
})

test('a real pinned WAL stops an import at a committed batch and resumes after the reader releases it', {
  timeout: 120000, skip: !fixedSqlite && 'This SQLite requires ordinary synchronous checkpoints for WAL safety',
}, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'psc-import-backlog-'))
  try {
    await succeeded(fixture(temp, 'pinned-reader', `
      const path = join(process.cwd(), 'shop.db'), db = new DatabaseSync(path)
      db.exec(schema); db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      const reader = new DatabaseSync(path), writer = new DatabaseSync(path)
      writer.exec('PRAGMA busy_timeout=5000; PRAGMA wal_autocheckpoint=0')
      reader.exec('BEGIN'); assert.equal(reader.prepare('SELECT count(*) n FROM contacts').get().n, 0)
      // Reusing one string keeps the fixture's JS heap bounded while creating a real >64 MiB WAL.
      const notes = 'x'.repeat(1024 * 1024)
      const people = Array.from({ length: 88 }, (_, i) => ({ ...contact(i + 1), notes }))
      let ordinaryWrites = 0
      const result = await withImportCheckpoints(db, checkpoint => writeContactImport(db, people, {
        batchSize: 8,
        checkpoint: async () => {
          const pending = checkpoint()
          writer.prepare('INSERT INTO ordinary_writes(note) VALUES (?)').run('Operator edit ' + (++ordinaryWrites))
          await pending
        },
      }))
      assert.equal(result.stopped?.code, 'import_checkpoint_backlog', result.stopped?.stack)
      assert.match(result.stopped.message, /saved|committed/i)
      assert.ok(result.created > 0 && result.created < people.length, 'backlog must halt before remaining batches')
      assert.equal(result.created % 8, 0, 'the failure occurs after a whole committed batch')
      assert.equal(result.duplicates, 0); assert.equal(result.skipped, 0)
      assert.equal(db.prepare('SELECT count(*) n FROM contacts').get().n, result.created)
      assert.equal(reader.prepare('SELECT count(*) n FROM contacts').get().n, 0, 'the reader really pinned the original snapshot')
      assert.equal(db.prepare('SELECT count(*) n FROM ordinary_writes').get().n, ordinaryWrites, 'same-shop edits stay writable during maintenance')
      assert.equal(importCheckpointActive(db), false)
      reader.exec('ROLLBACK'); reader.close(); writer.close()
      const resumed = await withImportCheckpoints(db, checkpoint => writeContactImport(db, people, { batchSize: 8, checkpoint }))
      assert.equal(resumed.stopped, null)
      assert.equal(resumed.created, people.length - result.created); assert.equal(resumed.duplicates, result.created)
      assert.equal(db.prepare('SELECT count(*) n FROM contacts').get().n, people.length)
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
      await shutdownImportCheckpoints(); db.close()
    `))
  } finally { rmSync(temp, { recursive: true, force: true }) }
})

test('process loss after a checkpoint preserves the committed batch and permits a deduplicated retry', { timeout: 120000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'psc-import-restart-'))
  let crash
  try {
    crash = fixture(temp, 'before-crash', `
      const db = new DatabaseSync(join(process.cwd(), 'shop.db')); db.exec(schema)
      await withImportCheckpoints(db, checkpoint => writeContactImport(db, [1, 2, 3, 4].map(contact), {
        batchSize: 2,
        checkpoint: async () => {
          await checkpoint()
          process.send({ checkpointed: db.prepare('SELECT count(*) n FROM contacts').get().n })
          await new Promise(() => {})
        },
      }))
    `, { ipc: true })
    const reached = await Promise.race([
      new Promise(resolve => crash.child.once('message', resolve)),
      crash.finished.then(result => { throw new Error(`Fixture exited before checkpoint: ${JSON.stringify(result)}`) }),
    ])
    assert.equal(reached.checkpointed, 2)
    assert.equal(crash.child.kill('SIGKILL'), true)
    const exited = await crash.finished
    assert.notEqual(exited.code, 0, 'the first process must exit abruptly without cleanup')
    await succeeded(fixture(temp, 'after-restart', `
      const db = new DatabaseSync(join(process.cwd(), 'shop.db'))
      db.exec('PRAGMA busy_timeout=5000')
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
      assert.equal(db.prepare('SELECT count(*) n FROM contacts').get().n, 2)
      const retried = await withImportCheckpoints(db, checkpoint => writeContactImport(db, [1, 2, 3, 4].map(contact), { batchSize: 2, checkpoint }))
      assert.equal(retried.stopped, null); assert.equal(retried.created, 2); assert.equal(retried.duplicates, 2)
      assert.equal(db.prepare('SELECT count(*) n FROM contacts').get().n, 4)
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
      assert.equal(importCheckpointActive(db), false)
      await shutdownImportCheckpoints(); db.close()
    `))
  } finally {
    if (crash?.child.exitCode === null && crash.child.signalCode === null) { crash.child.kill('SIGKILL'); await crash.finished }
    rmSync(temp, { recursive: true, force: true })
  }
})

test('order import HTTP receipts survive activity failures and checkpoint interruption without duplicating financial records', { timeout: 180000 }, async t => {
  const temp = mkdtempSync(join(tmpdir(), 'psc-order-checkpoint-http-')), dest = join(temp, 'demo')
  const httpServer = await createHttpTestServer(), port = httpServer.port
  let server, db, reader
  try {
    const built = spawnSync(process.execPath, ['bin/demo.mjs', dest, String(port)], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 90000,
    })
    assert.equal(built.status, 0, built.stderr)
    const slug = readdirSync(join(dest, 'data/tenants'))[0]
    const path = join(dest, 'data/tenants', slug, 'printshop.db')
    db = new DatabaseSync(path)
    db.exec(`PRAGMA busy_timeout=5000;
      CREATE TRIGGER checkpoint_test_activity BEFORE INSERT ON activities
      WHEN NEW.description LIKE 'Imported %order(s)%from a CSV'
      BEGIN SELECT RAISE(ABORT, 'fixture activity unavailable'); END;`)
    const env = JSON.parse(readFileSync(join(dest, 'demo-env.json'), 'utf8'))
    env.PSC_TICK_MS = '3600000'; env.PSC_IMPORT_CHECKPOINTS = 'on'
    let log = ''
    await httpServer.start({ cwd: dest, env,
      args: ['--no-warnings', '--import', './bin/demo-network-guard.mjs', 'server.mjs'],
      onOutput: text => { log += text },
    })
    server = httpServer.child
    for (let i = 0; i < 600 && server.exitCode === null && !log.includes('(ws /ws live'); i++) await new Promise(resolve => setTimeout(resolve, 50))
    assert.match(log, /ws \/ws live/)
    const base = httpServer.base
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'dylan@example.test', password: readFileSync(join(dest, 'LOGIN.txt'), 'utf8').match(/Password: (.+)/)[1] }) })
    assert.equal(login.status, 200)
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const submit = text => fetch(base + '/api/import/orders', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, status_policy: 'strict' }) })
    const simple = 'customer,email,invoice #,date,status,total\nActivity Fixture,activity-fixture@example.test,ACTIVITY-ONLY-01,2025-08-01,paid,10'
    let response = await submit(simple), body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.imported, 1)
    response = await submit(simple); body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.imported, 0); assert.equal(body.skipped_duplicates, 1)
    const savedSimple = db.prepare(`SELECT count(*) n FROM payments p JOIN invoices i ON i.id=p.invoice_id
      JOIN estimates e ON e.id=i.estimate_id WHERE e.source_ref='ACTIVITY-ONLY-01'`).get().n
    assert.equal(savedSimple, 1, 'a failed timeline write cannot cause a duplicate paid invoice on retry')

    if (!fixedSqlite) { t.diagnostic('Backlog phase needs fixed SQLite; activity-failure HTTP coverage passed.'); return }
    // A fixture trigger grows the real WAL without bypassing the HTTP upload-size limits or
    // changing the importer's batch policy. The production endpoint still writes whole orders.
    db.exec(`CREATE TABLE checkpoint_test_payload(job_id INTEGER PRIMARY KEY, payload BLOB);
      CREATE TRIGGER checkpoint_test_wal AFTER INSERT ON jobs WHEN NEW.title='Checkpoint backlog'
      BEGIN INSERT INTO checkpoint_test_payload VALUES(NEW.id, zeroblob(1048576)); END;
      PRAGMA wal_checkpoint(TRUNCATE);`)
    reader = new DatabaseSync(path)
    reader.exec('BEGIN'); reader.prepare('SELECT count(*) n FROM contacts').get()
    const text = 'customer,email,invoice #,date,status,total,garment\n' + Array.from({ length: 112 }, (_, i) =>
      `Backlog Fixture,backlog-fixture@example.test,CHECKPOINT-${i + 1},2025-08-01,paid,10,Checkpoint backlog`).join('\n')
    response = await submit(text); body = await response.json()
    assert.equal(response.status, 503, JSON.stringify(body))
    assert.equal(body.code, 'import_checkpoint_backlog'); assert.equal(body.of, 112)
    assert.match(body.error, /export or backup finish, then retry/)
    assert.match(body.error, /already written.*on the books/)
    assert.ok(body.imported > 0 && body.imported < 112)
    assert.doesNotMatch(body.error, /nothing was saved|Nothing was written|Something went wrong/)
    const counts = () => db.prepare(`SELECT
      (SELECT count(*) FROM estimates WHERE source_ref LIKE 'CHECKPOINT-%') estimates,
      (SELECT count(*) FROM invoices i JOIN estimates e ON e.id=i.estimate_id WHERE e.source_ref LIKE 'CHECKPOINT-%') invoices,
      (SELECT count(*) FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN estimates e ON e.id=i.estimate_id WHERE e.source_ref LIKE 'CHECKPOINT-%') payments,
      (SELECT count(*) FROM jobs j JOIN estimates e ON e.id=j.estimate_id WHERE e.source_ref LIKE 'CHECKPOINT-%') jobs`).get()
    assert.deepEqual({ ...counts() }, { estimates: body.imported, invoices: body.imported, payments: body.imported, jobs: body.imported })
    const committed = body.imported
    reader.exec('ROLLBACK'); reader.close(); reader = null
    db.exec('DROP TRIGGER checkpoint_test_wal')
    response = await submit(text); body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.imported, 112 - committed)
    assert.equal(body.skipped_duplicates, committed)
    assert.deepEqual({ ...counts() }, { estimates: 112, invoices: 112, payments: 112, jobs: 112 })
    response = await submit(text); body = await response.json()
    assert.equal(response.status, 200); assert.equal(body.imported, 0); assert.equal(body.skipped_duplicates, 112)
    assert.deepEqual({ ...counts() }, { estimates: 112, invoices: 112, payments: 112, jobs: 112 })
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.equal((await fetch(base + '/health')).status, 200)
  } finally {
    reader?.close(); db?.close()
    await httpServer.close()
    rmSync(temp, { recursive: true, force: true })
  }
})
