// Additive ledger: keep every historical source and never infer dispatch from tracking text.
export function initShippingSchema(db) {
  db.exec('SAVEPOINT shipping_schema')
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS shipping_scopes (
      scope TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS shipping_records (
      id INTEGER PRIMARY KEY,
      scope TEXT NOT NULL REFERENCES shipping_scopes(scope),
      estimate_id INTEGER REFERENCES estimates(id) ON DELETE RESTRICT,
      job_id INTEGER REFERENCES jobs(id) ON DELETE RESTRICT,
      source_key TEXT UNIQUE,
      kind TEXT NOT NULL, carrier TEXT NOT NULL DEFAULT '', tracking_number TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '', dispatched_on TEXT NOT NULL DEFAULT '',
      shipping_address TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'recorded', revision INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL DEFAULT '', created_at TEXT,
      updated_by TEXT NOT NULL DEFAULT '', updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS shipping_by_order ON shipping_records(estimate_id,id);
    CREATE INDEX IF NOT EXISTS shipping_by_job ON shipping_records(job_id,id);
    CREATE TABLE IF NOT EXISTS shipping_events (
      id INTEGER PRIMARY KEY, shipment_id INTEGER REFERENCES shipping_records(id) ON DELETE SET NULL,
      actor TEXT NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
      before_json TEXT, after_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS shipping_requests (
      actor_key TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      result_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(actor_key,request_id)
    )`)
    if (!db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get('shipping_ledger_v1')) {
      const scope = db.prepare('INSERT OR IGNORE INTO shipping_scopes(scope) VALUES(?)')
      const insert = db.prepare(`INSERT INTO shipping_records
        (scope,estimate_id,job_id,source_key,kind,carrier,tracking_number,note,created_by,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`)
      for (const r of db.prepare(`SELECT p.*,j.estimate_id FROM production_shipments p JOIN jobs j ON j.id=p.job_id ORDER BY p.id`).all()) {
        const key = `job:${r.job_id}`; scope.run(key)
        insert.run(key,r.estimate_id,r.job_id,`production:${r.id}`,'legacy_unspecified',r.carrier,r.tracking_number,r.note || '',r.created_by || '',r.created_at)
      }
      for (const r of db.prepare("SELECT id,carrier,tracking_number FROM estimates WHERE COALESCE(carrier,'')<>'' OR COALESCE(tracking_number,'')<>'' ORDER BY id").all()) {
        const key = `estimate:${r.id}`; scope.run(key)
        // Keep matching values from different old sources separately. Their identity is unknown.
        insert.run(key,r.id,null,`order:${r.id}`,'legacy_unspecified',r.carrier || '',r.tracking_number || '','','',null)
      }
      db.prepare('INSERT INTO schema_migrations(name) VALUES(?)').run('shipping_ledger_v1')
    }
    db.exec('RELEASE shipping_schema')
  } catch (error) {
    db.exec('ROLLBACK TO shipping_schema; RELEASE shipping_schema')
    throw error
  }
}
