import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { writeContactImport } from '../lib/contact-import.mjs'

const contact = (n, extra = {}) => ({ name: `Person ${n}`, email: `person${n}@example.test`, phone: '', company: '', notes: '', tags: '', ...extra })
function database({ deferred = false } = {}) {
  const db = new DatabaseSync(':memory:')
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE companies (name TEXT PRIMARY KEY); INSERT INTO companies VALUES ('');
    CREATE TABLE contacts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, phone TEXT,
      company TEXT ${deferred ? 'REFERENCES companies(name) DEFERRABLE INITIALLY DEFERRED' : ''},
      notes TEXT, tags TEXT, created_at TEXT, updated_at TEXT);
    CREATE INDEX contact_email ON contacts(lower(email));
    CREATE TABLE row_effects (name TEXT);`)
  return db
}
const count = db => db.prepare('SELECT count(*) AS n FROM contacts').get().n

test('customer import counts only committed batches after a real deferred-COMMIT failure', async () => {
  const db = database({ deferred: true })
  try {
    const result = await writeContactImport(db, [contact(1), contact(2), contact(3), contact(4, { company: 'missing' }), contact(5)], { batchSize: 2 })
    assert.equal(result.created, 2)
    assert.equal(result.stopped?.errcode, 787, 'the real COMMIT failed with extended SQLITE_CONSTRAINT_FOREIGNKEY')
    assert.equal(count(db), 2, 'the failed batch, including its valid first row, rolled back')
    assert.equal(db.prepare('SELECT 1 FROM contacts WHERE email=?').get('person3@example.test'), undefined)
    const resumed = await writeContactImport(db, [contact(1), contact(2), contact(3), contact(4), contact(5)], { batchSize: 2 })
    assert.deepEqual({ ...resumed }, { created: 3, duplicates: 2, skipped: 0, stopped: null })
    assert.equal(count(db), 5)
  } finally { db.close() }
})

test('storage errors stop instead of becoming skipped rows, with the entire active batch rolled back', async () => {
  const db = database()
  try {
    let inserted = 0
    const full = Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 })
    const faulted = {
      exec: sql => db.exec(sql),
      prepare(sql) {
        const statement = db.prepare(sql)
        if (!sql.startsWith('INSERT INTO contacts')) return statement
        return { run(...args) { if (++inserted === 4) throw full; return statement.run(...args) } }
      },
    }
    const result = await writeContactImport(faulted, Array.from({ length: 6 }, (_, i) => contact(i + 1)), { batchSize: 2 })
    assert.equal(result.stopped, full)
    assert.equal(result.created, 2)
    assert.equal(result.skipped, 0)
    assert.equal(count(db), 2)
    assert.equal(inserted, 4, 'nothing after the failed row was attempted')
  } finally { db.close() }
})

test('an extended row constraint skips that row and rolls back its trigger side effects', async () => {
  const db = database()
  try {
    db.exec(`CREATE TRIGGER reject_one BEFORE INSERT ON contacts WHEN NEW.name='Reject' BEGIN
      INSERT INTO row_effects VALUES (NEW.name); SELECT RAISE(FAIL, 'invalid customer'); END`)
    const result = await writeContactImport(db, [contact(1), contact(2, { name: 'Reject' }), contact(3)])
    assert.deepEqual(result, { created: 2, duplicates: 0, skipped: 1, stopped: null })
    assert.equal(count(db), 2)
    assert.equal(db.prepare('SELECT count(*) AS n FROM row_effects').get().n, 0)
  } finally { db.close() }
})

test('a trigger that rolls back the entire transaction stops the import without phantom counts', async () => {
  const db = database()
  try {
    db.exec(`CREATE TRIGGER reject_batch BEFORE INSERT ON contacts WHEN NEW.name='Reject' BEGIN
      SELECT RAISE(ROLLBACK, 'reject batch'); END`)
    const result = await writeContactImport(db, [contact(1), contact(2, { name: 'Reject' }), contact(3)])
    assert.equal(result.created, 0)
    assert.equal(result.skipped, 0)
    assert.equal(result.stopped?.errcode, 1811)
    assert.equal(count(db), 0)
    assert.equal((await writeContactImport(db, [contact(3)])).created, 1, 'no transaction remains open')
  } finally { db.close() }
})

test('a trigger that ignores an insert counts it as skipped and removes its side effects', async () => {
  const db = database()
  try {
    db.exec(`CREATE TRIGGER ignore_one BEFORE INSERT ON contacts WHEN NEW.name='Ignored' BEGIN
      INSERT INTO row_effects VALUES (NEW.name); SELECT RAISE(IGNORE); END`)
    const result = await writeContactImport(db, [contact(1), contact(2, { name: 'Ignored' }), contact(3)])
    assert.deepEqual(result, { created: 2, duplicates: 0, skipped: 1, stopped: null })
    assert.equal(count(db), 2)
    assert.equal(db.prepare('SELECT count(*) AS n FROM row_effects').get().n, 0)
    assert.equal(db.prepare('SELECT 1 FROM contacts WHERE email=?').get('person2@example.test'), undefined)
  } finally { db.close() }
})

test('concurrent imports recheck email inside each batch instead of trusting preview snapshots', async () => {
  const db = database()
  try {
    const people = Array.from({ length: 8 }, (_, i) => contact(i + 1))
    const results = await Promise.all([
      writeContactImport(db, people, { batchSize: 2 }),
      writeContactImport(db, people.map(c => ({ ...c, email: c.email.toUpperCase() })), { batchSize: 2 }),
    ])
    assert.equal(results.reduce((n, r) => n + r.created, 0), 8)
    assert.equal(results.reduce((n, r) => n + r.duplicates, 0), 8)
    assert.equal(count(db), 8)
    assert.ok(results.every(r => !r.stopped))
  } finally { db.close() }
})

test('the explicit database handle keeps overlapping shop imports isolated', async () => {
  const a = database(), b = database()
  try {
    const [ra, rb] = await Promise.all([
      writeContactImport(a, [contact(1, { name: 'Shop A' }), contact(2)], { batchSize: 1 }),
      writeContactImport(b, [contact(1, { name: 'Shop B' }), contact(2)], { batchSize: 1 }),
    ])
    assert.equal(ra.created, 2); assert.equal(rb.created, 2)
    assert.equal(a.prepare('SELECT name FROM contacts WHERE id=1').get().name, 'Shop A')
    assert.equal(b.prepare('SELECT name FROM contacts WHERE id=1').get().name, 'Shop B')
  } finally { a.close(); b.close() }
})
