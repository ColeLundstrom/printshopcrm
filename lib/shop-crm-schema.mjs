// Additive tables only. Existing contacts, sessions, documents and production stay intact.
export function initShopCrmSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS crm_tasks (
      id INTEGER PRIMARY KEY, contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
      title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', due_date TEXT NOT NULL DEFAULT '',
      assigned_id INTEGER, status TEXT NOT NULL DEFAULT 'open', revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS crm_tasks_work ON crm_tasks(status,due_date,assigned_id);
    CREATE TABLE IF NOT EXISTS crm_history (
      id INTEGER PRIMARY KEY, kind TEXT NOT NULL, record_id INTEGER NOT NULL,
      actor TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS crm_contact_holds (
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK(channel IN ('email','sms')), reason TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
      revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
      PRIMARY KEY(contact_id,channel)
    );
    CREATE TABLE IF NOT EXISTS crm_import_refs (
      source TEXT NOT NULL, kind TEXT NOT NULL, external_id TEXT NOT NULL,
      local_id INTEGER NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(source,kind,external_id)
    );
    CREATE TABLE IF NOT EXISTS crm_import_receipts (
      digest TEXT PRIMARY KEY, summary TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `)
}
