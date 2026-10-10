import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.PSC_DB = ':memory:'
const { db: defaultDb, initDb, seedSettings, tenantStore } = await import('../lib/db.mjs')

const quote = value => '"' + value.replaceAll('"', '""') + '"'
function snapshot(db) {
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()
  return { schema, rows: Object.fromEntries(schema.filter(row => row.type === 'table').map(row => [row.name,
    db.prepare('SELECT * FROM ' + quote(row.name)).all(),
  ])) }
}
function failMigration(db) {
  const exec = db.exec
  let alterations = 0
  db.exec = function (sql) {
    if (/^ALTER TABLE/.test(sql) && ++alterations === 3) throw Error('fixture migration interrupted')
    return exec.call(this, sql)
  }
  return () => { db.exec = exec }
}
function settingsFixture() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
    INSERT INTO settings VALUES('shop_name','Existing shop');
    CREATE TABLE marker(value TEXT);
    CREATE TRIGGER fixture_seed_failure BEFORE INSERT ON settings WHEN NEW.key='shop_phone'
    BEGIN SELECT RAISE(ABORT,'fixture settings interrupted'); END;`)
  return db
}

test('interrupted bootstrap rolls back schema changes and saved rows, then retries after reopening', () => {
  const temp = mkdtempSync(join(tmpdir(), 'psc-bootstrap-')), path = join(temp, 'shop.db')
  let db = new DatabaseSync(path)
  try {
    db.exec("CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('saved before migration')")
    const before = snapshot(db), restore = failMigration(db)
    assert.throws(() => initDb(db), /fixture migration interrupted/)
    restore()
    assert.deepEqual(snapshot(db), before, 'A failed migration must not leave earlier schema writes committed')
    db.close(); db = new DatabaseSync(path)
    initDb(db)
    assert.equal(db.prepare('SELECT value FROM marker').get().value, 'saved before migration')
    const migrated = snapshot(db)
    db.close(); db = new DatabaseSync(path)
    initDb(db)
    assert.deepEqual(snapshot(db), migrated, 'Restart must preserve the migrated schema and records')
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally {
    db.close()
    rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

test('bootstrap participates in an existing transaction without committing the caller changes', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec("PRAGMA foreign_keys=ON; CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('saved')")
    const before = snapshot(db)
    db.exec("BEGIN; INSERT INTO marker VALUES('pending')")
    initDb(db)
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='contacts'").get())
    db.exec('ROLLBACK')
    assert.deepEqual(snapshot(db), before)
  } finally { db.close() }
})

test('an interrupted nested bootstrap preserves the caller transaction and its pending work', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec("PRAGMA foreign_keys=ON; CREATE TABLE marker(value TEXT); BEGIN; INSERT INTO marker VALUES('pending')")
    const before = snapshot(db), restore = failMigration(db)
    assert.throws(() => initDb(db), /fixture migration interrupted/)
    restore()
    assert.deepEqual(snapshot(db), before)
    db.exec('COMMIT')
    assert.equal(db.prepare('SELECT value FROM marker').get().value, 'pending')
  } finally { db.close() }
})

test('default settings are atomic, preserve shop values and stay on the selected tenant', () => {
  const db = settingsFixture(), other = snapshot(defaultDb)
  try {
    const before = snapshot(db)
    tenantStore.run({ db }, () => {
      assert.throws(seedSettings, /fixture settings interrupted/)
      assert.deepEqual(snapshot(db), before, 'No partial settings may survive a failed batch')
      db.exec('DROP TRIGGER fixture_seed_failure')
      seedSettings()
      assert.equal(db.prepare("SELECT value FROM settings WHERE key='shop_name'").get().value, 'Existing shop')
      assert.ok(db.prepare('SELECT count(*) n FROM settings').get().n > 50)
      const seeded = snapshot(db)
      seedSettings()
      assert.deepEqual(snapshot(db), seeded)
    })
    assert.deepEqual(snapshot(defaultDb), other, 'Seeding one tenant never changes the default database')
  } finally { db.close() }
})

test('default settings can succeed or fail inside a caller transaction without ending it', () => {
  const db = settingsFixture()
  try {
    tenantStore.run({ db }, () => {
      db.exec("BEGIN; INSERT INTO marker VALUES('pending')")
      const before = snapshot(db)
      assert.throws(seedSettings, /fixture settings interrupted/)
      assert.deepEqual(snapshot(db), before)
      db.exec('DROP TRIGGER fixture_seed_failure')
      seedSettings()
      assert.ok(db.prepare('SELECT count(*) n FROM settings').get().n > 50)
      db.exec('ROLLBACK')
      assert.equal(db.prepare('SELECT count(*) n FROM settings').get().n, 1)
      assert.equal(db.prepare('SELECT count(*) n FROM marker').get().n, 0)
    })
  } finally { db.close() }
})
