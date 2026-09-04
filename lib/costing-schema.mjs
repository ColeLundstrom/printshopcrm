export function initCostingSchema(db) {
  db.exec(`
 CREATE TABLE IF NOT EXISTS costing_machines(id INTEGER PRIMARY KEY,name TEXT NOT NULL,method TEXT NOT NULL,hourly_cost REAL NOT NULL DEFAULT 0,output_hour REAL NOT NULL DEFAULT 1,setup_minutes REAL NOT NULL DEFAULT 0,hours_week REAL NOT NULL DEFAULT 40,active INTEGER NOT NULL DEFAULT 1,revision INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS costing_employees(member_id INTEGER PRIMARY KEY,hourly_cost REAL NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS costing_jobs(job_id INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,customer_supplied INTEGER NOT NULL DEFAULT 0,material_cost REAL,other_cost REAL NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS costing_operations(id INTEGER PRIMARY KEY,job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,machine_id INTEGER,member_id INTEGER,machine_name TEXT NOT NULL,employee_name TEXT NOT NULL,method TEXT NOT NULL,units INTEGER NOT NULL,planned_minutes REAL NOT NULL,actual_minutes REAL,good_units INTEGER,machine_rate REAL NOT NULL,labor_rate REAL NOT NULL,overhead_rate REAL NOT NULL,note TEXT NOT NULL DEFAULT '',created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
 CREATE INDEX IF NOT EXISTS idx_costing_operations_job ON costing_operations(job_id);
 CREATE TABLE IF NOT EXISTS costing_events(id INTEGER PRIMARY KEY,job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,actor TEXT NOT NULL,detail TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
`)
  if (
    !db
      .prepare('PRAGMA table_info(costing_jobs)')
      .all()
      .some((c) => c.name === 'consumable_cost')
  )
    db.exec('ALTER TABLE costing_jobs ADD COLUMN consumable_cost REAL')
  if (
    !db
      .prepare('PRAGMA table_info(costing_operations)')
      .all()
      .some((c) => c.name === 'voided_at')
  )
    db.exec('ALTER TABLE costing_operations ADD COLUMN voided_at TEXT')
}
