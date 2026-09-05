// Additive production records. Existing jobs are never enrolled by a migration.
export const DEFAULT_FLOWS = [
  {
    name: 'Screen printing',
    match: 'screen',
    steps: [
      ['Receive and count', 'Receiving', 'new', 'receiving'],
      ['Approve artwork', 'Art', 'art_approval', 'approval'],
      ['Burn screens', 'Prepress', 'prepress', ''],
      ['Print', 'Screen printing', 'production', ''],
      ['Quality check', 'QC', 'qc', ''],
      ['Pack and ship / collect', 'Shipping', 'shipping', '']
    ]
  },
  {
    name: 'Embroidery',
    match: 'embroid',
    steps: [
      ['Receive and count', 'Receiving', 'new', 'receiving'],
      ['Approve sew-out', 'Art', 'art_approval', 'approval'],
      ['Digitize and hoop', 'Embroidery', 'prepress', ''],
      ['Embroider', 'Embroidery', 'production', ''],
      ['Quality check', 'QC', 'qc', ''],
      ['Pack and ship / collect', 'Shipping', 'shipping', '']
    ]
  },
  {
    name: 'DTF',
    match: 'dtf',
    steps: [
      ['Receive and count', 'Receiving', 'new', 'receiving'],
      ['Approve artwork', 'Art', 'art_approval', 'approval'],
      ['Prepare transfers', 'DTF', 'prepress', ''],
      ['Press transfers', 'DTF', 'production', ''],
      ['Quality check', 'QC', 'qc', ''],
      ['Pack and ship / collect', 'Shipping', 'shipping', '']
    ]
  }
]
export function initProductionSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS production_templates(id INTEGER PRIMARY KEY, name TEXT NOT NULL, match_text TEXT NOT NULL DEFAULT '', steps TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, archived INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS production_jobs(job_id INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE, revision INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS production_tasks(id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, template_name TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, department TEXT NOT NULL, stage TEXT NOT NULL, gate TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL, assigned_id INTEGER, status TEXT NOT NULL DEFAULT 'pending', note TEXT NOT NULL DEFAULT '', completed_by TEXT, completed_at TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX IF NOT EXISTS idx_production_tasks_job ON production_tasks(job_id,position,id);
    CREATE INDEX IF NOT EXISTS idx_production_tasks_queue ON production_tasks(status,department,assigned_id);
    CREATE TABLE IF NOT EXISTS production_events(id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, task_id INTEGER, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS production_counts(job_id INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,counts TEXT NOT NULL DEFAULT '{}',counted_by TEXT NOT NULL,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS production_shipments(id INTEGER PRIMARY KEY,job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,carrier TEXT NOT NULL,tracking_number TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',created_by TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(job_id,carrier,tracking_number));
    CREATE TABLE IF NOT EXISTS supplier_order_checks(po_id INTEGER PRIMARY KEY,provider TEXT NOT NULL,payload TEXT NOT NULL,checked_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS production_preferences(member_id INTEGER PRIMARY KEY, department TEXT NOT NULL DEFAULT '');
  `)
  for (const table of ['production_templates','production_jobs','production_tasks']) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === 'timing'))
      db.exec(`ALTER TABLE ${table} ADD COLUMN timing TEXT NOT NULL DEFAULT '{}'`)
  }
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE name='production-timing-v1'").get()) {
    db.exec('DROP TRIGGER IF EXISTS production_auto_new_job')
    db.prepare("INSERT INTO schema_migrations(name) VALUES('production-timing-v1')").run()
  }
  // Seed only once: archiving or customizing a starter must survive upgrades.
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE name='production-starters-v1'").get()) {
    for (const f of DEFAULT_FLOWS)
      db.prepare('INSERT INTO production_templates(name,match_text,steps) VALUES(?,?,?)').run(
        f.name,
        f.match,
        JSON.stringify(
          f.steps.map(([title, department, stage, gate]) => ({
            title,
            department,
            stage,
            gate,
            assigned_id: null
          }))
        )
      )
    db.prepare("INSERT INTO schema_migrations(name) VALUES('production-starters-v1')").run()
  }
  db.exec(`CREATE TRIGGER IF NOT EXISTS production_auto_new_job AFTER INSERT ON jobs
    WHEN NEW.status='active' AND NEW.stage='new' AND EXISTS(SELECT 1 FROM settings WHERE key='production_auto' AND value='1')
    BEGIN
      INSERT INTO production_jobs(job_id,timing) SELECT NEW.id,json_set(timing,'$.start_date',substr(NEW.created_at,1,10)) FROM production_templates WHERE archived=0 AND match_text<>'' AND instr(lower(NEW.decoration),lower(match_text))>0 ORDER BY length(match_text) DESC,id LIMIT 1;
      INSERT INTO production_tasks(job_id,template_name,title,department,stage,gate,position,assigned_id,timing)
        SELECT NEW.id,t.name,json_extract(s.value,'$.title'),json_extract(s.value,'$.department'),json_extract(s.value,'$.stage'),coalesce(json_extract(s.value,'$.gate'),''),s.key,json_extract(s.value,'$.assigned_id'),json_object('due_offset',json_extract(s.value,'$.due_offset'))
        FROM production_templates t,json_each(t.steps) s WHERE t.id=(SELECT id FROM production_templates WHERE archived=0 AND match_text<>'' AND instr(lower(NEW.decoration),lower(match_text))>0 ORDER BY length(match_text) DESC,id LIMIT 1);
    END;`)
}
