export const DEFAULT_ESTIMATE_TERMS = 'Estimate valid 30 days. 50% deposit required to schedule production. Turnaround begins after art approval.'

export function initEstimateApprovalSchema(db) {
  db.exec('SAVEPOINT estimate_approval_schema')
  try {
    const columns = new Set(db.prepare('PRAGMA table_info(estimates)').all().map(c => c.name))
    for (const [name, type] of [['commercial_revision', 'INTEGER NOT NULL DEFAULT 0'], ['terms_snapshot', 'TEXT'], ['terms_snapshot_source', 'TEXT']])
      if (!columns.has(name)) db.exec(`ALTER TABLE estimates ADD COLUMN ${name} ${type}`)
    db.exec(`CREATE TABLE IF NOT EXISTS estimate_approval_history (
      id INTEGER PRIMARY KEY,
      estimate_id INTEGER REFERENCES estimates(id) ON DELETE SET NULL,
      commercial_revision INTEGER NOT NULL,
      approved_at TEXT,
      recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      source TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT '',
      snapshot TEXT NOT NULL,
      revoked_at TEXT,
      revoked_by TEXT,
      UNIQUE(estimate_id,commercial_revision)
    )`)
    db.exec("CREATE INDEX IF NOT EXISTS estimate_approval_customer_history ON estimate_approval_history(json_extract(snapshot,'$.contact_id'),estimate_id DESC,commercial_revision DESC)")
    if (!db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get('estimate_terms_snapshot_v1')) {
      const terms = db.prepare("SELECT value FROM settings WHERE key='estimate_terms'").get()?.value ?? DEFAULT_ESTIMATE_TERMS
      // Old releases rendered live settings. Freeze what this install can render at migration;
      // the original terms of a historical approval cannot be reconstructed.
      db.prepare("UPDATE estimates SET terms_snapshot=COALESCE(terms_snapshot,?),terms_snapshot_source=COALESCE(terms_snapshot_source,'legacy_migration')").run(terms)
      db.prepare('INSERT INTO schema_migrations(name) VALUES(?)').run('estimate_terms_snapshot_v1')
    }
    db.exec(`CREATE TRIGGER IF NOT EXISTS estimates_terms_snapshot AFTER INSERT ON estimates
      WHEN NEW.terms_snapshot IS NULL OR NEW.terms_snapshot_source IS NULL BEGIN
        UPDATE estimates SET
          terms_snapshot=COALESCE(NEW.terms_snapshot,(SELECT value FROM settings WHERE key='estimate_terms'),'${DEFAULT_ESTIMATE_TERMS.replaceAll("'", "''")}'),
          terms_snapshot_source=COALESCE(NEW.terms_snapshot_source,'created')
        WHERE id=NEW.id;
      END`)
    db.exec('RELEASE estimate_approval_schema')
  } catch (error) {
    db.exec('ROLLBACK TO estimate_approval_schema; RELEASE estimate_approval_schema')
    throw error
  }
}
