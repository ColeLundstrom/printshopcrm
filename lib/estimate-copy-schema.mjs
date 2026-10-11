/** Internal non-secret creation identities. SQLite rowids and quote numbers may both be reused. */
export function initEstimateCopySchema(db) {
  db.exec('SAVEPOINT estimate_copy_schema')
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS estimate_copy_identities (
      estimate_id INTEGER PRIMARY KEY REFERENCES estimates(id) ON DELETE CASCADE,
      identity TEXT NOT NULL UNIQUE CHECK(length(identity)=32 AND identity NOT GLOB '*[^0-9a-f]*')
    );
    CREATE TRIGGER IF NOT EXISTS estimate_copy_identity_insert AFTER INSERT ON estimates BEGIN
      INSERT INTO estimate_copy_identities(estimate_id,identity) VALUES(NEW.id,lower(hex(randomblob(16))));
    END;
    CREATE TRIGGER IF NOT EXISTS estimate_copy_identity_immutable BEFORE UPDATE ON estimate_copy_identities
      WHEN NEW.estimate_id IS NOT OLD.estimate_id OR NEW.identity IS NOT OLD.identity BEGIN
      SELECT RAISE(ABORT,'Estimate creation identity is immutable');
    END;
    INSERT INTO estimate_copy_identities(estimate_id,identity)
      SELECT id,lower(hex(randomblob(16))) FROM estimates e
      WHERE NOT EXISTS(SELECT 1 FROM estimate_copy_identities i WHERE i.estimate_id=e.id);`)
    db.exec('RELEASE estimate_copy_schema')
  } catch (error) {
    db.exec('ROLLBACK TO estimate_copy_schema; RELEASE estimate_copy_schema')
    throw error
  }
}
