import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { initShippingSchema } from '../lib/shipping-schema.mjs'

const quote = value => '"' + value.replaceAll('"', '""') + '"'
function snapshot(db) {
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()
  return { schema, tables: Object.fromEntries(schema.filter(s => s.type === 'table').map(s => [s.name, {
    columns: db.prepare('PRAGMA table_info(' + quote(s.name) + ')').all(),
    rows: db.prepare('SELECT * FROM ' + quote(s.name)).all(),
  }])) }
}
function legacy() {
  const db = new DatabaseSync(':memory:')
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE schema_migrations(name TEXT PRIMARY KEY);
    CREATE TABLE estimates(id INTEGER PRIMARY KEY,carrier TEXT,tracking_number TEXT,status TEXT);
    CREATE TABLE jobs(id INTEGER PRIMARY KEY,estimate_id INTEGER REFERENCES estimates(id),stage TEXT,status TEXT);
    CREATE TABLE production_shipments(id INTEGER PRIMARY KEY,job_id INTEGER NOT NULL REFERENCES jobs(id),carrier TEXT NOT NULL,tracking_number TEXT NOT NULL,note TEXT,created_by TEXT,created_at TEXT);
    CREATE TABLE production_tasks(id INTEGER PRIMARY KEY,job_id INTEGER,title TEXT,assigned_id INTEGER,status TEXT);
    CREATE TABLE custom_rules(id INTEGER PRIMARY KEY,payload TEXT);
    INSERT INTO estimates VALUES(1,'UPS','ORDER-ONLY','draft'),(2,'UPS','MATCHED','approved'),(3,'Unknown method','','draft'),(4,NULL,'REF-ONLY','draft'),(5,'','','draft');
    INSERT INTO jobs VALUES(1,2,'shipping','active'),(2,2,'qc','active'),(3,NULL,'complete','complete');
    INSERT INTO production_shipments VALUES
      (10,1,'UPS','MATCHED','First parcel','Original employee','2024-01-02 03:04:05'),
      (11,1,'UPS','SECOND','Second parcel','Original employee',NULL),
      (12,2,'UPS','MATCHED','Other linked job','Other employee','2024-02-03 04:05:06'),
      (13,3,'Customer pickup','COLLECTED','Job without quote','Former employee',NULL);
    INSERT INTO production_tasks VALUES(1,1,'Custom dispatch task',18,'pending'),(2,2,'Custom QC task',19,'done');
    INSERT INTO custom_rules VALUES(1,'{"custom":"Do not rewrite during migration"}');`)
  return db
}

test('shipping migration preserves every legacy source and unknown fact without merging matching references', () => {
  const db = legacy()
  try {
    const old = snapshot(db)
    initShippingSchema(db)
    const migrated = snapshot(db)
    for (const [name, table] of Object.entries(old.tables)) {
      assert.deepEqual(migrated.tables[name].columns, table.columns)
      if (name === 'schema_migrations') continue
      assert.deepEqual(migrated.tables[name].rows, table.rows, name + ' legacy data changed')
    }
    for (const object of old.schema) assert.deepEqual(migrated.schema.find(s => s.name === object.name), object)
    const records = db.prepare('SELECT * FROM shipping_records ORDER BY source_key').all()
    assert.equal(records.length, 8)
    assert.equal(records.filter(r => r.carrier === 'UPS' && r.tracking_number === 'MATCHED').length, 3,
      'Matching order/floor text does not prove the sources describe one parcel')
    for (const row of records) {
      assert.equal(row.kind, 'legacy_unspecified')
      assert.equal(row.status, 'recorded')
      assert.equal(row.dispatched_on, '')
      assert.equal(row.shipping_address, '')
    }
    const bySource = Object.fromEntries(records.map(r => [r.source_key, r]))
    assert.equal(bySource['production:10'].created_at, '2024-01-02 03:04:05')
    assert.equal(bySource['production:10'].created_by, 'Original employee')
    assert.equal(bySource['production:11'].created_at, null)
    assert.equal(bySource['production:13'].estimate_id, null)
    assert.equal(bySource['production:13'].job_id, 3)
    assert.equal(bySource['order:2'].job_id, null, 'Several jobs are never resolved by choosing the first')
    assert.equal(bySource['order:2'].created_at, null, 'No historical timestamp is invented')
    assert.equal(bySource['order:3'].tracking_number, '')
    assert.equal(bySource['order:4'].carrier, '')
    assert(!bySource['order:5'])
    assert(db.prepare('SELECT revision FROM shipping_scopes').all().every(r => r.revision === 0))
    assert.equal(db.prepare('SELECT count(*) n FROM shipping_events').get().n, 0)
    assert.equal(db.prepare('SELECT count(*) n FROM shipping_requests').get().n, 0)
    initShippingSchema(db)
    assert.deepEqual(snapshot(db), migrated, 'Second pass changes no rows or schema objects')
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { db.close() }
})

test('shipping backfill failure rolls back scopes, rows and migration marker atomically', () => {
  const db = legacy()
  try {
    // Establish the additive table shape, then rehearse an interrupted backfill with an
    // injected durable-write failure. The source legacy records remain the real input.
    initShippingSchema(db)
    db.exec(`DELETE FROM shipping_records; DELETE FROM shipping_scopes;
      DELETE FROM schema_migrations WHERE name='shipping_ledger_v1';
      CREATE TRIGGER fixture_shipping_write_failure BEFORE INSERT ON shipping_records
        WHEN NEW.source_key='production:11' BEGIN SELECT RAISE(ABORT,'fixture shipping write failure'); END;`)
    const before = snapshot(db)
    assert.throws(() => initShippingSchema(db), /fixture shipping write failure/)
    assert.deepEqual(snapshot(db), before, 'Earlier successful backfill rows must roll back too')
    db.exec('DROP TRIGGER fixture_shipping_write_failure')
    initShippingSchema(db)
    assert.equal(db.prepare('SELECT count(*) n FROM shipping_records').get().n, 8)
    assert.equal(db.prepare("SELECT count(*) n FROM schema_migrations WHERE name='shipping_ledger_v1'").get().n, 1)
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { db.close() }
})

test('retained shipping evidence prevents parent ID reuse even after a record is voided', () => {
  const db = legacy()
  try {
    initShippingSchema(db)
    assert.throws(() => db.exec('DELETE FROM estimates WHERE id=1'), /FOREIGN KEY/)
    assert.throws(() => db.exec('DELETE FROM jobs WHERE id=3'), /FOREIGN KEY/)
    db.exec("UPDATE shipping_records SET status='void' WHERE source_key IN ('order:1','production:13')")
    assert.throws(() => db.exec('DELETE FROM estimates WHERE id=1'), /FOREIGN KEY/)
    assert.throws(() => db.exec('DELETE FROM jobs WHERE id=3'), /FOREIGN KEY/)
    assert.equal(db.prepare('SELECT count(*) n FROM shipping_records').get().n, 8)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { db.close() }
})
