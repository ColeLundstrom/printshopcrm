// Delivery contacts are snapshots, not alternative customer/account identities.
export function initBillingRecipientSchema(db) {
  const add = (table, name, type) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
  }
  const snapshot = id => `COALESCE((SELECT json_object('buyer_name',COALESCE(name,''),'buyer_email',COALESCE(email,''),
    'billing_mode',billing_mode,'billing_name',CASE billing_mode WHEN 'buyer' THEN COALESCE(name,'') WHEN 'custom' THEN billing_name ELSE '' END,
    'billing_email',CASE billing_mode WHEN 'buyer' THEN COALESCE(email,'') WHEN 'custom' THEN billing_email ELSE '' END) FROM contacts WHERE id=${id}),
    '{"buyer_name":"","buyer_email":"","billing_mode":"none","billing_name":"","billing_email":""}')`
  db.exec('SAVEPOINT billing_recipients')
  try {
    add('contacts','billing_mode',"TEXT NOT NULL DEFAULT 'buyer'")
    add('contacts','billing_name',"TEXT NOT NULL DEFAULT ''")
    add('contacts','billing_email',"TEXT NOT NULL DEFAULT ''")
    for (const table of ['estimates','invoices']) {
      add(table,'recipient_snapshot','TEXT')
      add(table,'recipient_revision','INTEGER NOT NULL DEFAULT 0')
      add(table,'recipient_source',"TEXT NOT NULL DEFAULT 'created'")
    }
    for (const [name,type] of [['estimate_id','INTEGER'],['recipient_name',"TEXT NOT NULL DEFAULT ''"],['recipient_revision','INTEGER'],['recipient_stale','INTEGER NOT NULL DEFAULT 0']]) add('email_log',name,type)
    for (const name of ['recipient_name','recipient_email']) add('messages',name,"TEXT NOT NULL DEFAULT ''")
    db.exec(`CREATE TABLE IF NOT EXISTS document_recipient_history (
      id INTEGER PRIMARY KEY, document_type TEXT NOT NULL, document_id INTEGER NOT NULL, revision INTEGER NOT NULL,
      before_snapshot TEXT NOT NULL, after_snapshot TEXT NOT NULL, actor TEXT NOT NULL, changed_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_recipient_history ON document_recipient_history(document_type,document_id,id);
      CREATE INDEX IF NOT EXISTS idx_email_invoice_recipient ON email_log(invoice_id) WHERE invoice_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_email_estimate_recipient ON email_log(estimate_id) WHERE estimate_id IS NOT NULL;`)
    if (!db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get('billing_recipient_snapshots_v1')) {
      // Only the contacts known at upgrade can be frozen; do not claim historical exactness.
      for (const table of ['estimates','invoices']) db.exec(`UPDATE ${table} SET recipient_snapshot=${snapshot(`${table}.contact_id`)},recipient_source='legacy_migration' WHERE recipient_snapshot IS NULL`)
      db.exec("UPDATE email_log SET recipient_stale=1 WHERE delivered=0 AND COALESCE(trim(to_email),'')='' AND kind!='sms'")
      // Older quote/automation drafts have no reliable document identity. Keep
      // their recorded destination, but require a fresh, reviewed message.
      db.exec("UPDATE email_log SET recipient_stale=1 WHERE delivered=0 AND invoice_id IS NULL AND estimate_id IS NULL AND kind IN ('estimate','nudge','invoice','payment','automation')")
      db.prepare('INSERT INTO schema_migrations(name) VALUES(?)').run('billing_recipient_snapshots_v1')
    }
    for (const table of ['estimates','invoices']) {
      const inherited = table === 'invoices' ? `COALESCE((SELECT recipient_snapshot FROM estimates WHERE id=NEW.estimate_id AND contact_id IS NEW.contact_id),${snapshot('NEW.contact_id')})` : snapshot('NEW.contact_id')
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_recipient_snapshot AFTER INSERT ON ${table} WHEN NEW.recipient_snapshot IS NULL BEGIN
        UPDATE ${table} SET recipient_snapshot=${inherited} WHERE id=NEW.id; END;
        CREATE TRIGGER IF NOT EXISTS ${table}_recipient_retarget AFTER UPDATE OF contact_id ON ${table} WHEN NEW.contact_id IS NOT OLD.contact_id BEGIN
        UPDATE ${table} SET recipient_snapshot=${snapshot('NEW.contact_id')},recipient_revision=recipient_revision+1,recipient_source='customer_changed' WHERE id=NEW.id; END;
        CREATE TRIGGER IF NOT EXISTS ${table}_recipient_stale AFTER UPDATE OF recipient_revision ON ${table} WHEN NEW.recipient_revision!=OLD.recipient_revision BEGIN
        UPDATE email_log SET recipient_stale=1 WHERE ${table === 'invoices' ? 'invoice_id' : 'estimate_id'}=NEW.id AND delivered=0 AND kind!='sms'; END;`)
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_recipient_send_guard BEFORE UPDATE OF contact_id,recipient_snapshot ON ${table}
        WHEN (NEW.contact_id IS NOT OLD.contact_id OR NEW.recipient_snapshot IS NOT OLD.recipient_snapshot) AND
          EXISTS(SELECT 1 FROM email_log WHERE ${table === 'invoices'?'invoice_id':'estimate_id'}=OLD.id AND sending_at>=datetime('now','-5 minutes'))
        BEGIN SELECT RAISE(ABORT,'Document delivery is in progress; wait before editing recipients'); END;`)
    }
    db.exec('RELEASE billing_recipients')
  } catch (error) { db.exec('ROLLBACK TO billing_recipients; RELEASE billing_recipients'); throw error }
}
