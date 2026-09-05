const initialized = new WeakSet()

/** Additive collection state on every tenant before any manual or online payment mutation. */
export function initPaymentCollectionSchema(dbh) {
  if(initialized.has(dbh)) return
  const run=(sql,...args)=>dbh.prepare(sql).run(...args),all=(sql,...args)=>dbh.prepare(sql).all(...args)
  run(`CREATE TABLE IF NOT EXISTS payment_attempts (
    reference TEXT PRIMARY KEY, provider TEXT NOT NULL, invoice_id INTEGER, estimate_id INTEGER,
    amount_cents INTEGER NOT NULL, currency TEXT NOT NULL, kind TEXT NOT NULL,
    session_id TEXT, checkout_token TEXT, checkout_url TEXT, return_url TEXT,
    is_test INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', error TEXT, created_at TEXT NOT NULL,
    paid_at TEXT, transaction_id TEXT
  )`)
  run('CREATE UNIQUE INDEX IF NOT EXISTS idx_attempt_session ON payment_attempts(provider,session_id) WHERE session_id IS NOT NULL')
  run(`CREATE TABLE IF NOT EXISTS payment_collections (
    reference TEXT PRIMARY KEY,resource_key TEXT NOT NULL,snapshot TEXT NOT NULL,request_body TEXT NOT NULL,
    account_id TEXT,destination TEXT,is_test INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'creating',revision INTEGER NOT NULL DEFAULT 0,
    claim_token TEXT,claim_until INTEGER NOT NULL DEFAULT 0,next_retry_at INTEGER NOT NULL DEFAULT 0,submitted_at INTEGER,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,closed_at TEXT,error_code TEXT,response_evidence TEXT)`)
  if(!all('PRAGMA table_info(payment_collections)').some(c=>c.name==='response_evidence')) run('ALTER TABLE payment_collections ADD COLUMN response_evidence TEXT')
  run('CREATE UNIQUE INDEX IF NOT EXISTS payment_collection_one_open ON payment_collections(resource_key) WHERE closed_at IS NULL')
  run(`CREATE TABLE IF NOT EXISTS payment_collection_versions(resource_key TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0)`)
  run(`CREATE TRIGGER IF NOT EXISTS payment_collection_invoice_version AFTER UPDATE ON invoices
    WHEN OLD.amount_due IS NOT NEW.amount_due OR OLD.amount_paid IS NOT NEW.amount_paid OR OLD.status IS NOT NEW.status
      OR OLD.contact_id IS NOT NEW.contact_id OR OLD.estimate_id IS NOT NEW.estimate_id OR OLD.payment_review IS NOT NEW.payment_review
      OR OLD.recipient_revision IS NOT NEW.recipient_revision
    BEGIN INSERT INTO payment_collection_versions(resource_key,revision) VALUES('i:'||NEW.id,1)
      ON CONFLICT(resource_key) DO UPDATE SET revision=revision+1; END`)
  run(`CREATE TRIGGER IF NOT EXISTS payment_collection_estimate_version AFTER UPDATE ON estimates
    WHEN OLD.total IS NOT NEW.total OR OLD.contact_id IS NOT NEW.contact_id OR OLD.commercial_revision IS NOT NEW.commercial_revision
    BEGIN INSERT INTO payment_collection_versions(resource_key,revision) VALUES('e:'||NEW.id,1)
      ON CONFLICT(resource_key) DO UPDATE SET revision=revision+1; END`)
  run(`CREATE TABLE IF NOT EXISTS payment_collection_receipts (
    id TEXT PRIMARY KEY,reference TEXT,provider TEXT NOT NULL,account_id TEXT NOT NULL,is_test INTEGER NOT NULL,
    transaction_id TEXT NOT NULL,invoice_id INTEGER,estimate_id INTEGER,amount_cents INTEGER NOT NULL,currency TEXT NOT NULL,
    state TEXT NOT NULL,reason TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    UNIQUE(provider,account_id,is_test,transaction_id))`)
  run('CREATE INDEX IF NOT EXISTS payment_collection_receipt_invoice ON payment_collection_receipts(invoice_id,state)')
  run(`CREATE TRIGGER IF NOT EXISTS payment_collection_manual_receipt AFTER UPDATE OF amount_paid ON invoices
    WHEN OLD.amount_paid IS NOT NEW.amount_paid AND EXISTS(SELECT 1 FROM payment_attempts a LEFT JOIN payment_collections c ON c.reference=a.reference
      WHERE a.invoice_id=NEW.id AND ((c.reference IS NOT NULL AND c.closed_at IS NULL) OR (c.reference IS NULL AND a.status='pending')))
    BEGIN UPDATE invoices SET payment_review='A payment changed while another checkout may still be payable. Verify or close that checkout before requesting more money.' WHERE id=NEW.id;
      UPDATE email_log SET payment_stale=1 WHERE invoice_id=NEW.id AND delivered=0; END`)
  initialized.add(dbh)
}
