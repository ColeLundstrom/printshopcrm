import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AsyncLocalStorage } from 'node:async_hooks'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const DB_PATH = process.env.PSC_DB || join(ROOT, 'data', 'printshop.db')

// This runs at import, before any error handling in server.mjs is installed, so a bad PSC_DB
// surfaced as a raw Node stack trace ending in mkdirSync — nothing a shop owner could act on,
// and it is the single most likely way a first self-hosted start fails: a path that does not
// exist, or a Docker/Fly volume that was not mounted where the config says it is.
try {
  mkdirSync(dirname(DB_PATH), { recursive: true })
} catch (err) {
  const why =
    err?.code === 'EACCES' || err?.code === 'EPERM'
      ? 'this user does not have permission to write there'
      : err?.code === 'EROFS'
        ? 'that location is read-only — on Docker, Fly or Render it usually means the persistent volume is not mounted'
        : err?.code === 'ENOTDIR'
          ? 'part of that path is a file, not a directory'
          : err?.message || String(err)
  console.error(`\n  PrintShopCRM could not create its data directory:\n    ${dirname(DB_PATH)}\n`)
  console.error(`  ${why}.\n`)
  console.error(`  PSC_DB is currently ${process.env.PSC_DB ? `set to ${DB_PATH}` : `unset, so it defaults to ${DB_PATH}`}.`)
  console.error(`  Point it somewhere writable, for example:  PSC_DB=./data/printshop.db npm start\n`)
  process.exit(1)
}

/* ---------- multi-tenant DB routing ----------
 * Each shop gets its own SQLite database (complete data + config isolation — "every shop
 * a unique system"). A request runs inside tenantStore.run({ db }), and the query helpers
 * below resolve the current tenant's handle from it. Outside any tenant context (dev, seed,
 * one-off scripts) they fall back to the default db. */
export const tenantStore = new AsyncLocalStorage()
let defaultDb = null
export const getDb = () => tenantStore.getStore()?.db || defaultDb
export const setDefaultDb = (d) => { defaultDb = d }

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  company TEXT,
  notes TEXT,
  tags TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS estimates (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  estimate_number TEXT UNIQUE,
  status TEXT DEFAULT 'draft',
  items TEXT DEFAULT '[]',
  subtotal REAL DEFAULT 0,
  tax REAL DEFAULT 0,
  total REAL DEFAULT 0,
  notes TEXT,
  sent_at DATETIME,
  approved_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  estimate_id INTEGER REFERENCES estimates(id) ON DELETE SET NULL,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  invoice_number TEXT UNIQUE,
  status TEXT DEFAULT 'unpaid',
  amount_due REAL DEFAULT 0,
  amount_paid REAL DEFAULT 0,
  due_date DATE,
  paid_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER REFERENCES invoices(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  method TEXT DEFAULT 'other',
  note TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  estimate_id INTEGER REFERENCES estimates(id) ON DELETE SET NULL,
  invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  job_number TEXT UNIQUE,
  title TEXT,
  status TEXT DEFAULT 'active',
  stage TEXT DEFAULT 'new',
  decoration TEXT,
  art_files TEXT DEFAULT '[]',
  sizes TEXT DEFAULT '{}',
  quantities TEXT,
  due_date DATE,
  notes TEXT,
  assigned_to TEXT,
  rush INTEGER DEFAULT 0,
  sort_order REAL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS art_versions (
  id INTEGER PRIMARY KEY,
  job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  filename TEXT,
  original_name TEXT,
  mime TEXT,
  size INTEGER,
  status TEXT DEFAULT 'draft',
  notes TEXT,
  sent_at DATETIME,
  decided_at DATETIME,
  decided_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  type TEXT,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- One-shot DATA restatements, latched so they run exactly once per database.
-- Schema migrations are idempotent by construction (a guarded ALTER, a CREATE ... IF NOT EXISTS).
-- Rewriting somebody's DATA is not: applyMigrations runs on every process start, so an UPDATE
-- guarded by "does this still look untouched?" re-fires forever, and any value a person later
-- types that happens to satisfy the predicate is silently rewritten again on the next restart.
CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER,
  to_email TEXT,
  subject TEXT,
  body TEXT,
  kind TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS opportunities (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  estimate_id INTEGER REFERENCES estimates(id) ON DELETE SET NULL,
  title TEXT,
  stage TEXT DEFAULT 'lead',
  value REAL DEFAULT 0,
  source TEXT DEFAULT 'manual',
  notes TEXT,
  sort_order REAL DEFAULT 0,
  won_at DATETIME,
  lost_at DATETIME,
  lost_reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  subject TEXT,
  body TEXT,
  kind TEXT,
  read INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Outbound webhook subscriptions (public API). events is a comma list of trigger names or '*'.
-- secret signs every delivery (X-PSC-Signature: sha256=…) so receivers can verify origin.
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  events TEXT DEFAULT '*',
  secret TEXT NOT NULL,
  active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id INTEGER PRIMARY KEY,
  subscription_id INTEGER REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  event TEXT,
  payload TEXT,
  status TEXT DEFAULT 'pending',
  attempts INTEGER DEFAULT 0,
  last_error TEXT,
  delivered_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- QuickBooks reconciliation queue: every push attempt is a row a human can see, retry, or fix.
-- The incumbents' QBO syncs fail silently and bookkeepers re-key by hand; this one keeps receipts.
CREATE TABLE IF NOT EXISTS qbo_sync (
  id INTEGER PRIMARY KEY,
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  action TEXT DEFAULT 'push',
  status TEXT DEFAULT 'pending',
  qbo_id TEXT,
  error TEXT,
  attempts INTEGER DEFAULT 0,
  next_attempt_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Shop-floor scan events. A scan is a timestamped stage transition made from a phone; the deltas
-- between production scans are the labor ACTUALS that turn ROI from an estimate into a measurement.
CREATE TABLE IF NOT EXISTS job_scans (
  id INTEGER PRIMARY KEY,
  job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  from_stage TEXT,
  to_stage TEXT,
  actor TEXT,
  note TEXT,
  -- 'scan' = a physical scan on the floor (counts as a labor measurement) | 'board' = a kanban
  -- drag | 'api'. Only 'scan' feeds ROI actuals; see lib/roi.mjs laborActualMinutes.
  source TEXT DEFAULT 'board',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- The shop's own price sheets, in whatever shape its trade uses. A matrix has NO built-in meaning:
-- the row and column headers are free text ("11 oz mug", "Both sides", "1–11"), and the cells are
-- prices. This is what lets a shop that sells mug printing or laser engraving hold its real pricing
-- instead of bending it into a screen-printing calculator. See lib/matrices.mjs.
--
-- The grid is stored DENSE and POSITIONAL (cells[r][c]) rather than keyed by header text, so
-- renaming a column or reordering rows can never orphan a price.
CREATE TABLE IF NOT EXISTS price_matrices (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  row_label TEXT DEFAULT 'Quantity',      -- what the rows mean, in the shop's words
  col_label TEXT DEFAULT 'Option',        -- what the columns mean
  -- 'piece' = the cell is a per-piece price (line total = price × qty)
  -- 'flat'  = the cell is the whole charge for the line, whatever the quantity
  unit TEXT DEFAULT 'piece',
  grid_rows TEXT DEFAULT '[]',            -- JSON array of row header strings
  grid_cols TEXT DEFAULT '[]',            -- JSON array of column header strings
  cells TEXT DEFAULT '[]',                -- JSON 2-D array of numbers, null = no price set
  is_default INTEGER DEFAULT 0,           -- pre-selected on new quotes; at most one row has this
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_webhook_del_sub ON webhook_deliveries(subscription_id, created_at);
-- Retention sweep filters on created_at alone, which the composite index above can't serve.
CREATE INDEX IF NOT EXISTS idx_webhook_del_created ON webhook_deliveries(created_at);
CREATE INDEX IF NOT EXISTS idx_qbo_sync_status ON qbo_sync(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_job_scans_job ON job_scans(job_id, created_at);

CREATE INDEX IF NOT EXISTS idx_est_contact ON estimates(contact_id);
CREATE INDEX IF NOT EXISTS idx_inv_contact ON invoices(contact_id);
CREATE INDEX IF NOT EXISTS idx_jobs_stage ON jobs(stage);
CREATE INDEX IF NOT EXISTS idx_jobs_contact ON jobs(contact_id);
-- Profitability asks each run which other runs share its order. Without this that is a full scan
-- of jobs PER JOB, and /api/roi blocked the event loop for 18.7s on a five-year shop.
CREATE INDEX IF NOT EXISTS idx_jobs_estimate ON jobs(estimate_id);
CREATE INDEX IF NOT EXISTS idx_act_contact ON activities(contact_id);
-- The dashboard and the activity feed both ORDER BY created_at DESC, id DESC with no filter, and
-- job timelines filter by job_id — all full scans of a table that grows without bound (one prod
-- shop is past 100k rows). The recent-activity feed alone was ~160ms of blocked event loop on the
-- dashboard, which every shop hits on login; these take it to single-digit milliseconds.
CREATE INDEX IF NOT EXISTS idx_act_recent ON activities(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_act_job ON activities(job_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_art_job ON art_versions(job_id);
CREATE INDEX IF NOT EXISTS idx_pay_invoice ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_inv_status_due ON invoices(status, due_date);
CREATE INDEX IF NOT EXISTS idx_msg_contact_dir ON messages(contact_id, direction);
-- Contact lookup is by lower(email) and lower(name) in a dozen places — the CSV order import
-- matches every row that way, the receptionist and the assistant resolve a customer that way, and
-- the unauthenticated embed/quickquote paths hit it too. Without an index each is a full scan, so
-- a 3,000-row import ran 6,000 scans inside one synchronous transaction and froze the event loop
-- for the whole fleet for seconds to minutes. Expression indexes on the exact match expressions
-- used (measured 2,449ms → 14ms on the import loop).
CREATE INDEX IF NOT EXISTS idx_contacts_lower_email ON contacts(lower(email));
CREATE INDEX IF NOT EXISTS idx_contacts_lower_name ON contacts(lower(name));
`

/* ---------- query helpers (resolve the current tenant's db per request) ---------- */

/**
 * Guard against under-binding a statement.
 *
 * node:sqlite does NOT throw when fewer arguments are passed than there are `?` placeholders — it
 * binds the tail to NULL. An Autopilot INSERT shipped with 16 placeholders and 15 arguments, which
 * silently shifted every column after the tenth and corrupted every job it created for weeks. This
 * turns that failure mode into a loud one. Counts `?` outside string literals and comments; named
 * parameters and statements bound with a single object are left alone.
 */
const countPlaceholders = (sql) =>
  (String(sql)
    .replace(/'(?:[^']|'')*'/g, "''")      // strip single-quoted literals
    .replace(/"(?:[^"]|"")*"/g, '""')      // strip quoted identifiers
    .replace(/--[^\n]*/g, '')              // strip line comments
    .replace(/\/\*[\s\S]*?\*\//g, '')      // strip block comments
    .match(/\?/g) || []).length

const checkParams = (sql, p) => {
  if (p.length === 1 && p[0] !== null && typeof p[0] === 'object' && !Array.isArray(p[0])) return // named/object binding
  const want = countPlaceholders(sql)
  if (want !== p.length) {
    throw new Error(`SQL parameter mismatch: ${want} placeholder(s) but ${p.length} argument(s) — ${String(sql).replace(/\s+/g, ' ').trim().slice(0, 120)}`)
  }
}

export const all = (sql, ...p) => { checkParams(sql, p); return getDb().prepare(sql).all(...p) }
export const get = (sql, ...p) => { checkParams(sql, p); return getDb().prepare(sql).get(...p) }
export const run = (sql, ...p) => { checkParams(sql, p); return getDb().prepare(sql).run(...p) }
// Row-at-a-time iteration for large exports, so a full-shop dump never has to hold every row (or a
// giant pretty-printed string) in memory at once. Same param-safety check as the others.
export const iterate = (sql, ...p) => { checkParams(sql, p); return getDb().prepare(sql).iterate(...p) }

// A tiny contact-created signal so the AI paths (receptionist, quick-quote) can trigger the same
// automations the manual and API creation paths do. lib/agent.mjs and lib/quickquote.mjs cannot
// import server.mjs (that would be a cycle), and they create contacts directly — so the default
// "New lead nurture" rule never fired for a bot-captured lead. server.mjs registers the real
// dispatcher here at startup; until it does, emitting is a no-op. Never let a hook throw into a
// caller that is mid-insert.
let contactCreatedHook = null
export const onContactCreated = (fn) => { contactCreatedHook = fn }
export const emitContactCreated = (contact) => { try { contactCreatedHook?.(contact) } catch (e) { console.error('contact.created hook:', e && e.message) } }

/**
 * Run a synchronous callback inside a single SQLite transaction on the current tenant's handle.
 *
 * node:sqlite is synchronous, so as long as `fn` contains no `await`, BEGIN IMMEDIATE … COMMIT
 * wraps every statement it runs atomically — a crash or a throw rolls the whole thing back instead
 * of leaving a half-written estimate→invoice→job or a tenant with no owner. The callback MUST stay
 * synchronous; an await inside would release the transaction to interleave with other requests,
 * which is exactly what this guards against. Returns whatever `fn` returns.
 */
export function tx(fn) {
  const db = getDb()
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* the failed statement may have already aborted the txn */ }
    throw e
  }
}

/* ---------- schema init + migrations ----------
 * initDb(dbh) is run against every database — the default one and each tenant's — so a new
 * shop gets the full, current schema. CREATE TABLE IF NOT EXISTS is a no-op on an existing
 * table, so new columns are added by addColumn. Additive only — an existing db keeps its data.
 */
function addColumn(dbh, table, col, decl) {
  const has = dbh.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)
  if (!has) dbh.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`)
}
/**
 * Run a one-shot data restatement exactly once per database, ever.
 *
 * See schema_migrations in SCHEMA for why a data rewrite cannot be left to re-run the way an
 * additive schema change can. Orphan sweeps are deliberately NOT wrapped in this: they are
 * genuinely idempotent safety nets with no judgement in them, and re-running one costs nothing.
 */
function once(dbh, name, fn) {
  if (dbh.prepare('SELECT 1 AS x FROM schema_migrations WHERE name = ?').get(name)) return
  fn()
  dbh.prepare('INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)').run(name)
}

function applyMigrations(dbh) {
  addColumn(dbh, 'jobs', 'sizes', "TEXT DEFAULT '{}'")
  addColumn(dbh, 'jobs', 'garment', 'TEXT')
  addColumn(dbh, 'jobs', 'ship_date', 'DATE')
  addColumn(dbh, 'estimates', 'quote_meta', "TEXT DEFAULT '{}'")
  // The editor has a per-estimate tax-rate field, but only the resulting tax DOLLARS were stored.
  // Documents then labelled the tax line with the shop's CURRENT setting, so a resale-exempt quote
  // printed "Tax (7.75%) $0.00", and changing the shop's rate retroactively relabelled every
  // historical estimate. Persist the rate that actually produced the dollars.
  addColumn(dbh, 'estimates', 'tax_rate', 'REAL')
  // A proof can hang off an ESTIMATE, not just a production job. The lite edition (Print Shop
  // Control) has no job board, so mockup approval attaches to the quote the customer is already
  // looking at. Nullable: job-based proofs keep working exactly as before.
  // Voiding an invoice: the only way to take back an invoice raised against the wrong customer
  // or for the wrong amount. Before this there was no delete route and no void, so a mistake
  // counted toward money owed and chased the wrong customer forever, escapable only with sqlite3.
  // Webhook retry state must live in the DB, not an in-process timer. A failed delivery's retry
  // was a setTimeout, so a deploy or crash during the 30s/5min wait dropped it forever and left
  // the row stuck 'retrying' with nobody to re-attempt it. next_attempt_at lets the tick drain
  // due retries — the same durable pattern qbo_sync already uses.
  addColumn(dbh, 'webhook_deliveries', 'next_attempt_at', 'DATETIME')
  addColumn(dbh, 'invoices', 'voided_at', 'DATETIME')
  addColumn(dbh, 'invoices', 'void_reason', 'TEXT')
  addColumn(dbh, 'art_versions', 'estimate_id', 'INTEGER')
  // ALTER TABLE cannot add a REFERENCES clause, so art_versions.estimate_id was the one parent
  // link in the schema with no foreign key — and the consequence is not a tidy orphan row.
  // estimates.id IS the rowid, and SQLite reuses max(rowid)+1 after a delete, so a mockup left
  // behind by a deleted estimate RE-ATTACHES to the next estimate created. The next customer's
  // quote then shows the previous customer's artwork, already marked approved, and the board
  // reports the proof as cleared — so the shop sends someone else's art to press.
  // A trigger is the FK we cannot declare. The DELETE first sweeps any orphan already sitting in
  // an existing database, including ones that have not collided yet.
  dbh.exec(`
    DELETE FROM art_versions WHERE estimate_id IS NOT NULL AND estimate_id NOT IN (SELECT id FROM estimates);
    CREATE TRIGGER IF NOT EXISTS trg_art_versions_estimate_delete AFTER DELETE ON estimates
      BEGIN DELETE FROM art_versions WHERE estimate_id = OLD.id; END;
  `)

  // email_log.contact_id is the other pointer with no foreign key behind it, and its failure mode
  // is the Outbox button. activities.contact_id DOES have one (ON DELETE CASCADE) and foreign keys
  // are on, so once a customer was deleted, every message they had left in the Outbox answered
  // "Send it" with FOREIGN KEY constraint failed → HTTP 500, forever, with no way to clear the row
  // from any screen. On a shop with SMTP configured the mail really went out first and the shop was
  // told the send had failed. Sweep the pointers that are already dangling; the delete route nulls
  // them from here on.
  dbh.exec('UPDATE email_log SET contact_id = NULL WHERE contact_id IS NOT NULL AND contact_id NOT IN (SELECT id FROM contacts)')

  // Restate deal values that were written as the estimate's TAX-INCLUSIVE total.
  //
  // syncFromEstimate stored `estimate.total`, so every forecast number in the product — the board
  // columns, open/weighted/won value, and the dashboard's "open estimates" KPI — carried sales tax
  // as revenue the shop was going to keep. Only rows that STILL match the total they were written
  // from are touched: a deal whose value a person has since typed by hand (PUT /api/pipeline/:id,
  // or the agent) no longer matches, and that number is theirs, not ours to correct.
  //
  // ONCE. The "still matches the total" predicate is not a latch, because a person is perfectly
  // entitled to type the tax-inclusive figure — that is what the customer is going to pay, and it
  // is the number on the quote in front of them. Unlatched, applyMigrations runs on every process
  // start, so their $2,931.45 was rewritten to $2,726.00 at the next restart, and again at the one
  // after they retyped it, forever, from no screen and with nothing to show why.
  once(dbh, 'opportunity_value_excludes_tax', () => {
    dbh.exec(`UPDATE opportunities SET value = (SELECT round(e.subtotal, 2) FROM estimates e WHERE e.id = opportunities.estimate_id)
      WHERE estimate_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM estimates e WHERE e.id = opportunities.estimate_id
                      AND e.subtotal IS NOT NULL AND abs(opportunities.value - e.total) < 0.005 AND abs(e.total - e.subtotal) >= 0.005)`)
  })
  // The same reused rowid, one layer out: a customer-facing /p/ link is HMAC(kind:id:slug), a pure
  // function of the ROWID. Delete a cancelled quote and the next quote lands on that id — so the
  // link already sitting in the first customer's inbox opens the SECOND customer's order, priced,
  // named, with a working Approve button, and approving it stamps the record and mails the shop.
  // Unauthenticated, from a link the shop itself sent, and invisible afterwards: the timeline names
  // the wrong-but-plausible customer. No screen in the product can revoke or rotate a link.
  //
  // Every shareable row now carries its own random key, mixed into the HMAC. A row that pre-dates
  // this migration keeps share_key NULL, which reproduces the LEGACY token exactly — so links
  // already in customers' inboxes keep working. Everything created from here on has a key, so a
  // reused id can never mint an old token again. A trigger rather than a dozen INSERT sites across
  // four files: missing one would leave the hole open.
  for (const t of ['estimates', 'invoices', 'jobs', 'art_versions']) {
    addColumn(dbh, t, 'share_key', 'TEXT')
    dbh.exec(`CREATE TRIGGER IF NOT EXISTS trg_${t}_share_key AFTER INSERT ON ${t}
      BEGIN UPDATE ${t} SET share_key = lower(hex(randomblob(8))) WHERE id = NEW.id AND share_key IS NULL; END;`)
  }
  // Art can live in the shop's Google Drive instead of on our disk — store the file id + view link.
  addColumn(dbh, 'art_versions', 'drive_file_id', 'TEXT')
  addColumn(dbh, 'art_versions', 'drive_link', 'TEXT')
  // Customer's own PO reference. Schools, teams and any AP department that issues one will not pay
  // an invoice that doesn't quote it back, so it belongs on the document the customer receives.
  addColumn(dbh, 'invoices', 'po_number', "TEXT DEFAULT ''")
  // The lite edition's order board. One estimate = one order card, moved by hand between five
  // stages. Kept on `estimates` because that is the record the whole chain hangs off (the invoice,
  // the mockups and the payments all point back to it), so a card survives every step.
  addColumn(dbh, 'estimates', 'board_stage', "TEXT DEFAULT 'quote'")
  addColumn(dbh, 'estimates', 'tracking_number', "TEXT DEFAULT ''")
  addColumn(dbh, 'estimates', 'carrier', "TEXT DEFAULT ''")
  addColumn(dbh, 'estimates', 'stage_moved_at', 'DATETIME')
  // Wholesale/resale accounts don't get charged sales tax. Flagging the CUSTOMER (rather than
  // remembering to zero the rate on each quote) is what shops actually want: every estimate for a
  // wholesale account comes out untaxed by default, and the resale cert lives with the account.
  addColumn(dbh, 'contacts', 'tax_exempt', 'INTEGER DEFAULT 0')
  addColumn(dbh, 'contacts', 'tax_exempt_id', 'TEXT DEFAULT \'\'')
  // Approval-gated scheduling: every shop's terms say "N days from art approval", but the
  // due date is typed at intake and never moves. These let the schedule tell the truth.
  addColumn(dbh, 'jobs', 'turnaround_days', 'INTEGER DEFAULT 10')
  addColumn(dbh, 'jobs', 'date_promised', 'DATE')      // what we first told the customer
  addColumn(dbh, 'jobs', 'approval_gated', 'INTEGER DEFAULT 1')
  addColumn(dbh, 'jobs', 'art_approved_at', 'DATETIME')
  addColumn(dbh, 'jobs', 'spec', "TEXT DEFAULT '{}'")  // reorder spec sheet
  addColumn(dbh, 'jobs', 'separation', "TEXT")          // screens/inks recorded before the separation tool was removed;
                                                       // still read by capacity + costing, no longer written
  // Real delivery status on every outbound message (email/SMS). 'logged' means recorded but not
  // sent (no credentials or no recipient); 'smtp'/'twilio' means it actually left the building.
  addColumn(dbh, 'email_log', 'delivered', 'INTEGER DEFAULT 0')
  addColumn(dbh, 'email_log', 'via', "TEXT DEFAULT 'logged'")
  addColumn(dbh, 'email_log', 'delivery_error', 'TEXT')
  // Online deposit/balance collection through the shop's own Stripe: the Checkout Session id is
  // stored on the payment so a return trip (or a refresh) can never double-record the same charge.
  addColumn(dbh, 'payments', 'stripe_session', 'TEXT')

  // QuickBooks entity mappings. Without a persisted qbo_id a re-sync can only create duplicates
  // and a payment can never follow its invoice across — the exact incumbent failure bookkeepers
  // complain about ("invoice amounts not matching for reconciliation").
  addColumn(dbh, 'contacts', 'qbo_id', 'TEXT')
  addColumn(dbh, 'invoices', 'qbo_id', 'TEXT')
  addColumn(dbh, 'payments', 'qbo_id', 'TEXT')
  // QBO rotates a SyncToken on every write; an update without the CURRENT one is rejected (5010).
  addColumn(dbh, 'invoices', 'qbo_sync_token', 'TEXT')

  // Where an imported record came from. `source_ref` is the old system's order number and is the
  // idempotency key for re-importing an export (it replaced a substring LIKE over the notes text,
  // which silently swallowed any order number that was a prefix of another). `imported_at` marks
  // history so the timed automations never email a customer about a 2024 invoice from the tool
  // the shop just left.
  addColumn(dbh, 'job_scans', 'source', "TEXT DEFAULT 'board'")
  addColumn(dbh, 'estimates', 'source_ref', 'TEXT')
  addColumn(dbh, 'estimates', 'imported_at', 'DATETIME')
  addColumn(dbh, 'invoices', 'imported_at', 'DATETIME')
  addColumn(dbh, 'jobs', 'imported_at', 'DATETIME')
  // Per-garment size grids: [{ description, garment, sizes }], one entry per sized quote line.
  // jobs.sizes stays the ROLLED-UP total — capacity and every piece count read it, and changing
  // its shape would break them — so this is purely additive. Jobs written before this column
  // existed read '[]' and fall back to the estimate's items, then to the flat grid; see
  // jobLines() in server.mjs. Nothing needs backfilling.
  addColumn(dbh, 'jobs', 'line_sizes', "TEXT DEFAULT '[]'")

  // ── Performance indexes ────────────────────────────────────────────────────
  // These MUST live here, not in SCHEMA: several reference columns that addColumn creates above
  // (jobs.approval_gated, jobs.art_approved_at). SCHEMA runs BEFORE this function, so a partial
  // index on a migrated column there throws "no such column" inside initDb — which means every
  // tenant database fails to OPEN. Learned the hard way.
  //
  // Why these matter beyond one shop: node:sqlite is synchronous, so a slow query blocks the event
  // loop for EVERY tenant, not just the one that asked.
  dbh.exec(`
    -- That query also ran a correlated subquery per row to find each job's latest sent proof.
    CREATE INDEX IF NOT EXISTS idx_art_job_status_ver ON art_versions(job_id, status, version DESC);
    -- Outstanding-balance sums, covering so the sum never touches the table.
    CREATE INDEX IF NOT EXISTS idx_inv_outstanding ON invoices(status, amount_due, amount_paid);
    -- Open-quote totals on the dashboard and follow-ups.
    CREATE INDEX IF NOT EXISTS idx_est_status_total ON estimates(status, total);
    -- Board and job lists order by due date within a status.
    CREATE INDEX IF NOT EXISTS idx_jobs_status_due ON jobs(status, due_date);
    -- /api/orders ran a correlated subquery for each estimate's latest proof and each estimate's
    -- invoice. estimate_id on both tables is created by addColumn above, so these are the FIRST
    -- indexes that GENUINELY require this placement — a full 30k-row scan per row (measured 35-61s,
    -- a fleet-wide freeze) collapses to 69ms with them.
    CREATE INDEX IF NOT EXISTS idx_art_estimate_ver ON art_versions(estimate_id, version DESC);
    -- Every GET /uploads/:file asks "is this filename ours?" — v1.19.0's tenant scoping, on the
    -- one route that serves bytes. Without this it is a full SCAN of art_versions, and on a
    -- default self-host (PSC_AUTH unset) that route is reachable with no session and no rate
    -- limit. Measured on 39,906 rows: 2.35ms -> 0.005ms per lookup, and the Art & Prepress page
    -- (which renders one <img> per version) 1.36ms -> 0.14ms per thumbnail.
    CREATE INDEX IF NOT EXISTS idx_art_filename ON art_versions(filename);
    CREATE INDEX IF NOT EXISTS idx_inv_estimate ON invoices(estimate_id);
    -- Import idempotency: one row per source order number. Partial so the many non-imported
    -- estimates (source_ref NULL) don't collide with each other.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_est_source_ref ON estimates(source_ref) WHERE source_ref IS NOT NULL;

    -- Revenue MTD on /api/dashboard, the first screen after login. Its WHERE was
    -- date(p.created_at) >= ?, and wrapping the column in a function makes any index on it
    -- unusable — so the KPI scanned every payment the shop had ever taken. The query now compares
    -- the stored 'YYYY-MM-DD HH:MM:SS' text directly, which orders identically, and this seeks.
    CREATE INDEX IF NOT EXISTS idx_pay_created ON payments(created_at, amount);
    -- Floor Mode. GET /api/scan/:code matches on upper(job_number), which defeats the UNIQUE index
    -- on job_number, so every barcode scan on the shop floor full-scanned the jobs table. Indexing
    -- the same expression the query uses is what makes it seek; the query text does not change.
    CREATE INDEX IF NOT EXISTS idx_jobs_upper_number ON jobs(upper(job_number));
    -- Stripe's webhook idempotency check ("have I already recorded this session?") scanned every
    -- payment. Partial, because the overwhelming majority of payments are not card payments.
    CREATE INDEX IF NOT EXISTS idx_pay_stripe_session ON payments(stripe_session) WHERE stripe_session IS NOT NULL;
    -- The unread-message badge on /api/dashboard AND /api/today. messages is append-only, so this
    -- scan grows forever while the answer stays tiny. The index holds only unread inbound rows and
    -- shrinks again as the shop reads its mail.
    CREATE INDEX IF NOT EXISTS idx_msg_unread ON messages(id) WHERE direction = 'in' AND read = 0;
  `)
}

/** Apply PRAGMAs + schema + migrations to a database handle. Idempotent. */
export function initDb(dbh) {
  dbh.exec('PRAGMA journal_mode = WAL')
  dbh.exec('PRAGMA foreign_keys = ON')
  // Wait up to 5s for a write lock instead of throwing SQLITE_BUSY — the 5-min automation tick and
  // a live request can briefly contend on the same tenant db.
  dbh.exec('PRAGMA busy_timeout = 5000')
  // Negative = KiB rather than pages. The default (~2MB per connection) is charged once per shop,
  // so a few hundred shops would hold hundreds of MB of page cache on a 4GB box. Each shop's
  // working set is small; 1MB keeps the hot pages and bounds total cache growth with tenant count.
  dbh.exec('PRAGMA cache_size = -1024')
  dbh.exec(SCHEMA)
  applyMigrations(dbh)
  return dbh
}

// The default database. In single-tenant dev this is the whole app; in production it is only
// touched outside a tenant context (never for a shop's data — the auth middleware always wraps
// gated requests in that tenant's own database).
export const db = new DatabaseSync(DB_PATH)
initDb(db)
setDefaultDb(db)

export const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19)

/**
 * Can this database still take a WRITE?
 *
 * /health used to answer with `SELECT 1`, which is a read — and on a full disk reads keep working
 * perfectly while every write fails. Measured on a full volume: 25/25 writes returned 500 while
 * /health answered {"ok":true} 200 throughout. That is the signal deploy/ship.sh polls to decide
 * whether to roll back, and the signal any uptime monitor watches, so the one failure that stops a
 * shop saving anything was also the one failure nothing reported.
 *
 * The probe writes a single fixed settings key and removes it, inside one transaction, so it costs
 * one tiny row and can never accumulate. ENOSPC and a read-only volume both surface here.
 */
export function canWrite(dbh = getDb()) {
  try {
    dbh.exec("BEGIN IMMEDIATE; INSERT OR REPLACE INTO settings (key, value) VALUES ('__health', datetime('now')); DELETE FROM settings WHERE key = '__health'; COMMIT")
    return { ok: true }
  } catch (e) {
    try { dbh.exec('ROLLBACK') } catch { /* nothing open */ }
    const msg = String(e?.message || e)
    return {
      ok: false,
      error: /full|no space/i.test(msg) ? 'disk full'
        : /readonly|read-only/i.test(msg) ? 'database is read-only'
          : 'database unavailable',
      detail: msg,
    }
  }
}
// The fallback existed because the `n + 'e2'` string trick returns NaN for very large or very
// small magnitudes — but `Math.round(Infinity * 100) / 100` is Infinity, so this money helper
// happily handed Infinity back to its callers. One opportunity created with value "1e400" put Inf
// in the column, and SUM() over it then blanked the WHOLE shop's Open Pipeline and Weighted KPIs —
// not just that card. A money helper must only ever return a finite number.
export const round2 = (n) => {
  n = Number(n) || 0
  const v = Number(Math.round(n + 'e2') + 'e-2')
  if (Number.isFinite(v)) return v
  const w = Math.round(n * 100) / 100
  return Number.isFinite(w) ? w : 0
}

/* ---------- settings ---------- */

const SETTING_DEFAULTS = {
  // The shop's own identity and its sales tax start EMPTY, deliberately.
  //
  // These used to default to the demo shop — Rebel Ink Press, a California address, 7.75% CA tax.
  // createTenant() blanked them for multi-tenant signups, with a comment naming the exact bug. But
  // single-shop mode has no signup, and single-shop is what the README quickstart, INSTALL's local
  // trial, the docker run line and HOSTING's self-host snippet all produce — and what the README
  // documents as a supported production mode.
  //
  // So every self-hosted shop inherited them: invoices headed with another business's name,
  // address and phone, and California sales tax charged to customers in Texas. Both silent.
  //
  // Blank identity renders as omitted rather than wrong (lib/pdf.mjs), and a 0% rate is visibly
  // missing rather than quietly incorrect. Onboarding asks for all of it. The demo values now live
  // in seed.mjs, where the demo shop belongs.
  shop_name: '',
  shop_tagline: '',
  // Filename (inside public/uploads) of the shop's logo. Shown on everything a customer sees —
  // estimates, invoices, receipts, proofs. Empty = the shop name alone, as before.
  shop_logo: '',
  shop_email: '',
  shop_phone: '',
  shop_address: '',
  tax_rate: '0',
  default_garment_cost: '',   // fallback blank cost when no supplier match and none parsed (blank = use 3.20)
  size_upcharges: JSON.stringify({ '2XL': 2, '3XL': 3, '4XL': 4, '5XL': 5 }),
  screen_fee: '25',
  default_markup: '2.0',
  // Costing inputs. utilization_pct is the load-bearing one: presses only print ~24-33%
  // of the clock, so costing at the raw shop rate understates labor by ~3x.
  shop_hourly_rate: '75',
  utilization_pct: '30',
  spoilage_pct: '2',
  press_type: 'auto',
  target_margin_pct: '45',
  // Capacity planner. Productive press-minutes/day = stations × hours × 60 × utilization_pct.
  // Reuses the same utilization figure as costing, so the schedule and the price agree.
  capacity_stations: '2',
  capacity_hours_per_day: '8',
  capacity_default_colors: '2',   // assumed screens when a job has no saved separation yet
  // DTF gang-sheet builder (the embeddable customer tool) + the shop's OWN Stripe.
  // Embroidery is sold per 1,000 stitches with a per-piece floor, plus one-time digitizing.
  emb_rate_per_1k: '1.00',
  emb_min_charge: '5.00',
  emb_digitizing_fee: '25',
  // DTF sold by the square inch of film, plus the per-piece labor of pressing it on.
  dtf_price_per_sq_in: '0.035',
  dtf_press_fee: '1.25',
  // Per-PIECE floor for a single transfer. Distinct from dtf_min_charge, which is the minimum for a
  // whole gang-sheet order — using that here ($10) put every print size at the same price.
  dtf_min_per_piece: '1.50',
  dtf_sheet_width: '22',
  dtf_price_per_inch: '0.95',
  dtf_min_charge: '10',
  stripe_publishable: '',   // the SHOP's Stripe keys — checkouts go to their account, not ours
  stripe_secret: '',
  // QuickBooks Online sync (lib/quickbooks.mjs). Refresh token rotates on every refresh — persist it.
  qbo_realm_id: '', qbo_client_id: '', qbo_client_secret: '', qbo_access_token: '', qbo_refresh_token: '', qbo_token_expires: '',
  qbo_autosync: 'on',   // push invoices + payments to QBO automatically as money moves; 'off' = manual button only
  // Google Drive art storage (lib/gdrive.mjs). Each shop connects its OWN Drive; art lives there so
  // we don't host unlimited storage. gdrive_connected is the UI flag set once OAuth completes.
  gdrive_client_id: '', gdrive_client_secret: '', gdrive_refresh_token: '', gdrive_access_token: '', gdrive_token_expires: '', gdrive_root_folder: '', gdrive_connected: '',
  // Print Shop Control (lite) edition: shops don't paste a key — they connect a Stripe Express
  // account we manage, and pay a 4% fee on collected payments (see lib/connect.mjs).
  stripe_account_id: '',        // acct_… of the shop's connected account (empty = not started)
  stripe_charges_enabled: '',   // '1' once Stripe has enabled the account for charges
  // Wholesale supplier logins (S&S Activewear REST, SanMar PromoStandards) — live blank cost + PO lookups.
  ss_account: '',
  ss_api_key: '',
  sanmar_user: '',
  sanmar_pass: '',
  sanmar_cust: '',
  alpha_account: '',
  alpha_pass: '',
  // Real delivery credentials — the shop's own SMTP + Twilio. Empty = messages log to the
  // outbox without sending, and the UI says so.
  smtp_host: '', smtp_port: '587', smtp_user: '', smtp_pass: '', smtp_from: '', smtp_secure: '',
  twilio_sid: '', twilio_token: '', twilio_from: '',
  // Bring-your-own AI. Each shop connects its own provider + key, so model usage bills to them,
  // never to the platform. Empty = model features off; the deterministic parser still runs.
  ai_provider: '',   // '' | 'anthropic' | 'openai' | 'cli'
  ai_api_key: '',
  ai_model: '',      // optional override; defaults per provider
  // Slack — the shop's OWN Slack app, on the shop's OWN workspace. The bot token posts as their
  // bot; the signing secret proves inbound requests really came from Slack.
  slack_bot_token: '',
  slack_signing_secret: '',
  // AI-first / manual-always. Each workflow can run on autopilot or wait for a human.
  // 'ai' = the system acts; 'manual' = it drafts and a person confirms.
  mode_intake: 'ai',      // parse inbound messages into draft orders automatically
  mode_estimates: 'ai',   // let the assistant/agent draft estimates
  mode_followups: 'ai',   // send follow-up nudges automatically vs. draft for review
  mode_agent: 'ai',       // the website receptionist replies on its own vs. assist-only
  mode_art: 'manual',     // art/proofs stay human by default
  estimate_terms: 'Estimate valid 30 days. 50% deposit required to schedule production. Turnaround begins after art approval.',
  invoice_terms: 'Net 15. Late payments accrue 1.5% monthly. Make checks payable to the shop name above.',
  brand_name: 'PrintShopCRM',
  brand_tagline: "The print shop management system that doesn't need a separate CRM",
  email_template_estimate: 'Hi {{first_name}},\n\nThanks for the opportunity to quote this one. Estimate {{estimate_number}} for {{total}} is attached and viewable at the link below.\n\nApprove it and we will get you on the production schedule.\n\n— {{shop_name}}',
  email_template_art: 'Hi {{first_name}},\n\nProof v{{version}} for {{job_title}} is ready for your review. Check the placement, sizing, spelling, and colors — once you approve, this is exactly what we print.\n\n— {{shop_name}}',
  email_template_invoice: 'Hi {{first_name}},\n\nInvoice {{invoice_number}} for {{total}} is ready. Due {{due_date}}.\n\nThanks for the business.\n\n— {{shop_name}}',
  email_template_nudge: 'Hi {{first_name}},\n\nCircling back on estimate {{estimate_number}} for {{total}} — it is still good on our end, and we have room on the schedule.\n\nAnything you want changed, or want us to get it moving?\n\n— {{shop_name}}',
  email_template_overdue: 'Hi {{first_name}},\n\nInvoice {{invoice_number}} was due {{due_date}} and shows a balance of {{total}}.\n\nIf it is already on the way, ignore this. Otherwise a quick payment would be a big help.\n\n— {{shop_name}}',
  email_template_reorder: 'Hi {{first_name}},\n\nIt has been a little while since your last run ({{last_order}}). If you are running low or planning the next batch, we still have your art and specs on file, so a reorder is quick and easy.\n\nWant us to spin up a fresh quote? Just reply with the count.\n\n— {{shop_name}}',
  reorder_snooze: '{}',
  // Per-service pricing multipliers (relative to a screen-print base of 1.0) — a shop's own rules
  // for what embroidery / DTF / vinyl etc. cost vs. screen print. Empty = use the built-in defaults.
  service_pricing: '{}',
  // The shop's price book: per-service rates, setup fees and quantity bands, plus any service the
  // shop invented. Empty = the stock book in lib/pricebook.mjs. Every number in it is overridable.
  price_book: '{}',
  // Guided-onboarding progress: { stepKey: 'done' | 'skipped' }. Lets setup be finished later.
  onboarding_progress: '{}',
}

export function getSettings() {
  const rows = all('SELECT key, value FROM settings')
  const out = { ...SETTING_DEFAULTS }
  for (const r of rows) out[r.key] = r.value
  return out
}

/**
 * Secret settings that must NEVER reach the browser — API keys, tokens, passwords. The server
 * reads them via getSettings(); anything sent to the client goes through publicSettings(), which
 * replaces a set secret with a boolean `<key>_set` flag so the UI can show "connected" without
 * ever handling the value. On save, an empty submission for one of these means "leave unchanged".
 */
export const SECRET_KEYS = [
  'ai_api_key', 'stripe_secret', 'smtp_pass', 'twilio_token',
  'ss_api_key', 'sanmar_pass', 'alpha_pass',
  'slack_bot_token', 'slack_signing_secret',
  'qbo_client_secret', 'qbo_access_token', 'qbo_refresh_token',
  'gdrive_client_secret', 'gdrive_access_token', 'gdrive_refresh_token',
]

/**
 * The tax rate that applies to one buyer — the ONLY way any code should decide what to tax.
 *
 * It lives here, rather than in server.mjs where it started, because it kept being bypassed.
 * Every path that writes an estimate must consult the buyer's tax_exempt flag, and the two
 * that did not — the AI receptionist and the in-app assistant — billed sales tax to resale
 * accounts. Those are the shop's wholesale customers: the ones who notice.
 *
 * Pass the resulting rate to computeTotals AND store it on the row. An estimate written with a
 * NULL tax_rate is not merely missing a value: the public estimate page labels it with the
 * shop's *current* rate, and editing the estimate re-derives it from settings, so the mistake
 * cannot be corrected by hand afterwards.
 */
/**
 * A sales tax rate is a percentage. No jurisdiction charges more than 100%, and a negative rate
 * is a discount wearing a tax label. Both were accepted verbatim — `tax_rate: 100000` on an
 * estimate produced a real, storable, thousand-fold "tax" line on a document a customer signs.
 */
export const clampRate = (n) => {
  const v = Number(n) || 0
  return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0
}

/**
 * An override may not silently outrank an exemption. The override was checked FIRST, so it
 * short-circuited before the buyer was ever read — and the app's own estimate editor always
 * sends `tax_rate` (public/js/views/estimates.js), so the one screen a shop writes most of its
 * quotes on billed 7.75% to every resale account while displaying "Wholesale account. Sales tax
 * off." $310.00 of tax on a $4,000 quote, on the accounts that notice.
 *
 * A shop CAN still tax an exempt buyer deliberately — a resale customer buying something they
 * are not reselling — but it has to say so, with `allowExemptOverride`, rather than have it
 * happen because a form field carried the shop's default rate.
 */
export const taxRateFor = (contactId, override, { allowExemptOverride = false } = {}) => {
  const buyer = contactId ? get('SELECT tax_exempt FROM contacts WHERE id = ?', Number(contactId)) : null
  if (buyer?.tax_exempt && !allowExemptOverride) return 0
  if (override != null && override !== '') return clampRate(override)
  return clampRate(getSettings().tax_rate)
}

/**
 * Settings a message template is allowed to interpolate with {{name}}.
 *
 * This is an allowlist on purpose. Both template renderers used to fall back to the whole
 * settings row, so `{{stripe_secret}}` in an email body rendered the shop's live Stripe key —
 * and templates are editable in the app by any user who can reply to a conversation. The
 * rendered body is stored in the outbox and readable back over the API, so it was a complete
 * credential dump, and with SMTP wired it would mail those credentials to any address the
 * sender chose.
 *
 * A blocklist of SECRET_KEYS would have closed the reported hole and left the next one open:
 * every integration added since has put another token in this row. So the rule is inverted —
 * a setting is not reachable from a template until it is named here, and nothing here is a
 * credential. These are the shop's own letterhead details, which is all a template ever wanted.
 */
export const TEMPLATE_SETTING_KEYS = new Set([
  'shop_name', 'shop_tagline', 'shop_email', 'shop_phone', 'shop_address',
])

/** Resolve one {{key}} for a message template: caller vars first, then the letterhead allowlist. */
export function templateValue(key, vars, settings) {
  const v = vars?.[key]
  if (v != null) return v
  if (TEMPLATE_SETTING_KEYS.has(key)) return settings?.[key] ?? ''
  return ''
}

/** Settings safe to send to the client: every secret redacted to '' plus a `<key>_set` flag. */
export function publicSettings() {
  const s = getSettings()
  const out = { ...s }
  for (const k of SECRET_KEYS) { out[`${k}_set`] = !!String(s[k] || '').trim(); out[k] = '' }
  return out
}

/**
 * The one value that means "erase this credential".
 *
 * A secret field is rendered blank by the settings form — the browser never sees the stored
 * value — so an empty submission has to mean "unchanged" or every save would wipe every key.
 * The consequence was that there was NO value that meant "remove it": a shop that pasted the
 * wrong key, or whose Slack admin, bookkeeper or office manager just left, could not take that
 * credential out of the product from any screen. Blanking the field was a deliberate no-op.
 * This sentinel gives "unchanged" and "erase" separate spellings.
 */
export const CLEAR_SECRET = '__CLEAR__'

/** Apply a settings patch from the client, preserving unchanged secrets (empty secret = keep). */
// Only keys that are real settings may be written from a client patch. Without this, a shop could
// POST arbitrary keys into its settings row — the vector that let a shop-supplied SanMar endpoint
// be stored and then used for an SSRF probe (now also blocked at use-time in suppliers.mjs).
const SETTINGS_WRITABLE = new Set(Object.keys(SETTING_DEFAULTS))

/**
 * Settings whose VALUE the server later treats as proof of something. These are real settings —
 * they belong in SETTING_DEFAULTS and they render on the Settings screen — but they may only be
 * written by the route that establishes the fact, never asserted in a client patch.
 *
 * `shop_logo` is a filename, and `/uploads/:file` accepts `getSettings().shop_logo === f` as
 * proof that this shop owns that file. Because shop_logo was patchable, ownership was
 * self-asserted: shop B's owner sent `PUT /api/settings {"shop_logo":"<A's proof filename>"}`
 * and then read shop A's customer artwork, 200, byte-identical — through the access control
 * v1.19.0 shipped to close exactly that. Worse, B's own /p/ page then rendered the logo, so the
 * server MINTED a valid anonymous fileToken for A's file under B's slug: a permanent public URL
 * for another shop's property, still serving after A deleted it. On open signup the attacker is
 * anyone with an email address.
 *
 * Nothing in public/js has ever PUT shop_logo; POST/DELETE /api/settings/logo are the only
 * writers, and both setSetting() directly, so this costs the product nothing.
 */
const SETTINGS_NOT_PATCHABLE = new Set(['shop_logo'])
export function applySettingsPatch(patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (!SETTINGS_WRITABLE.has(k)) continue // ignore unknown keys entirely
    if (SETTINGS_NOT_PATCHABLE.has(k)) continue // set by the route that establishes it, never claimed
    if (SECRET_KEYS.includes(k) && String(v) === CLEAR_SECRET) { setSetting(k, ''); continue } // the one way out
    if (SECRET_KEYS.includes(k) && !String(v ?? '').trim()) continue // don't wipe a stored secret
    setSetting(k, v)
  }
}

/** Per-size upcharge map from settings, falling back to the shared defaults if it's malformed. */
export function getUpcharges() {
  try {
    const v = JSON.parse(getSettings().size_upcharges)
    return v && typeof v === 'object' ? v : DEFAULT_UPCHARGES
  } catch { return DEFAULT_UPCHARGES }
}

export function setSetting(key, value) {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value ?? ''))
}

export function seedSettings() {
  for (const [k, v] of Object.entries(SETTING_DEFAULTS)) {
    run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', k, v)
  }
}

/* ---------- document numbering ---------- */

function nextNumber(table, column, prefix) {
  const row = get(`SELECT ${column} AS n FROM ${table} WHERE ${column} LIKE ? ORDER BY id DESC LIMIT 1`, `${prefix}-%`)
  const last = row ? parseInt(String(row.n).split('-').pop(), 10) : 1000
  return `${prefix}-${(Number.isFinite(last) ? last : 1000) + 1}`
}

export const nextEstimateNumber = () => nextNumber('estimates', 'estimate_number', 'EST')
export const nextInvoiceNumber = () => nextNumber('invoices', 'invoice_number', 'INV')
export const nextJobNumber = () => nextNumber('jobs', 'job_number', 'JOB')

/* ---------- scheduling ---------- */

/**
 * Add N business days to a date (skips Sat/Sun). Shops quote turnaround in working days.
 */
export function addBusinessDays(from, days) {
  const d = new Date(`${String(from).slice(0, 10)}T12:00:00`)
  let left = Math.max(0, Number(days) || 0)
  while (left > 0) {
    d.setDate(d.getDate() + 1)
    if (d.getDay() !== 0 && d.getDay() !== 6) left--
  }
  return d.toISOString().slice(0, 10)
}

/** Business days between two dates, negative if `to` is before `from`. */
export function businessDaysBetween(from, to) {
  // O(1) instead of one Date mutation per calendar day. The old loop counted, for each day after
  // `lo` up to and including `hi`, the ones that are Mon–Fri. Whole weeks contribute 5 each; the
  // remainder is walked by weekday index. Verified byte-identical to the day-walk on random pairs.
  const a = new Date(`${String(from).slice(0, 10)}T12:00:00`)
  const b = new Date(`${String(to).slice(0, 10)}T12:00:00`)
  const sign = b < a ? -1 : 1
  const [lo, hi] = b < a ? [b, a] : [a, b]
  const days = Math.round((hi - lo) / 86400000)
  if (days <= 0) return 0
  const weeks = Math.floor(days / 7)
  let n = weeks * 5
  let dow = lo.getDay()
  for (let i = 0; i < days - weeks * 7; i++) {
    dow = (dow + 1) % 7
    if (dow !== 0 && dow !== 6) n++
  }
  return n * sign
}

/**
 * The real due date for an approval-gated job: turnaround starts when art is approved,
 * not when the order was taken. Until approval lands, the date is a projection from today
 * — which is exactly the honesty every shop's terms promise and no tool delivers.
 */
export function scheduleFor(job) {
  const days = Number(job.turnaround_days) || 10
  // `slip` is always computed here so the dashboard and the job page can never disagree
  // about how late something is. Working days is the unit turnaround is quoted in;
  // calendar days is what the customer feels — both are returned.
  const withSlip = (o) => (job.due_date && o.due
    ? { ...o, slip: businessDaysBetween(job.due_date, o.due), slipCalendar: Math.round((new Date(`${o.due}T12:00:00`) - new Date(`${String(job.due_date).slice(0, 10)}T12:00:00`)) / 864e5) }
    : { ...o, slip: 0, slipCalendar: 0 })

  if (!job.approval_gated) return withSlip({ due: job.due_date, gated: false, projected: false, days })
  if (job.art_approved_at) {
    return withSlip({ due: addBusinessDays(job.art_approved_at, days), gated: true, projected: false, days, approvedOn: String(job.art_approved_at).slice(0, 10) })
  }
  // Only jobs still waiting on a proof get a projected date. Once work has moved past
  // art approval the gate no longer applies, and re-projecting from today would invent
  // a slip that isn't real.
  if (!AWAITING_APPROVAL.has(job.stage)) return withSlip({ due: job.due_date, gated: true, projected: false, days, stale: true })
  const today = new Date().toISOString().slice(0, 10)
  return withSlip({ due: addBusinessDays(today, days), gated: true, projected: true, days })
}

const AWAITING_APPROVAL = new Set(['new', 'art_approval'])

/* ---------- activity feed ---------- */

export function logActivity(type, description, { contact_id = null, job_id = null } = {}) {
  run('INSERT INTO activities (contact_id, job_id, type, description, created_at) VALUES (?, ?, ?, ?, ?)', contact_id, job_id, type, description, now())
}

/* ---------- money ---------- */

// Totals come from the shared module the browser also imports, so the number in the
// estimate editor and the number on the invoice can never drift apart.
export { computeTotals, lineAmount, lineQty, lineUpcharge, sizeTotal, sizeSummary, rollupSizes, garmentLines, SIZES, SIZE_KEY, sizeKeys } from '../public/js/shared/pricing.js'
import { DEFAULT_UPCHARGES, SIZE_KEY as UP_SIZE_KEY } from '../public/js/shared/pricing.js'

/**
 * Stamp the upcharge table a set of lines is being priced with onto the lines themselves.
 *
 * lineUpcharges() reads `item.size_upcharges` when it is there and the shop's LIVE table when it
 * is not, so a line with no snapshot re-prices every time the shop edits an ordinary documented
 * setting — on documents the customer is already holding. sanitizeEstimateItems has done this
 * since the freeze shipped, but it guards only the two hand-edited routes; nine other writers
 * (reorder, duplicate, autopilot, CSV import, the v1 API, gang sheets, quick quote, the
 * receptionist and the assistant) stored bare lines. A 300-tee autopilot quote printed lines
 * summing $3,499.00 under its own stored "Subtotal $3,369.00" after one upcharge change, and the
 * QuickBooks push then refused it forever — "lines total X but the invoice is Y" is unresolvable
 * from any screen, because the number that moved is not on the invoice.
 *
 * Only ever fills a blank: a document re-saved for an unrelated reason must not re-price itself.
 */
export function freezeUpcharges(items, upcharges = getUpcharges()) {
  const snap = {}
  for (const [k, v] of Object.entries(upcharges || {})) {
    const key = String(k).trim().toUpperCase()
    const n = Number(v)
    if (UP_SIZE_KEY.test(key) && Number.isFinite(n) && n !== 0) snap[key] = n
  }
  return (items || []).map((it) => {
    if (!it || typeof it !== 'object' || Array.isArray(it)) return it
    if (it.size_upcharges != null) {
      // A caller cannot post junk into the table its own line is priced by.
      if (typeof it.size_upcharges !== 'object' || Array.isArray(it.size_upcharges)) {
        const { size_upcharges: _drop, ...rest } = it
        return rest
      }
      return it
    }
    if (!it.sizes || typeof it.sizes !== 'object' || Array.isArray(it.sizes) || !Object.keys(it.sizes).length) return it
    return { ...it, size_upcharges: snap }
  })
}

/**
 * Drop webhook delivery history past its retention window.
 *
 * Every outbound webhook writes a row here with its full payload, and nothing ever removed them —
 * a shop with a busy Zapier hook accumulates rows (and payload bodies) forever, in a SQLite file
 * that also has to hold the actual business. The Developers screen only ever shows the last 25.
 *
 * Returns the number of rows removed. `PSC_WEBHOOK_RETENTION_DAYS=0` disables the sweep entirely
 * for anyone who wants to keep the lot.
 */
export function pruneWebhookDeliveries(days = Number(process.env.PSC_WEBHOOK_RETENTION_DAYS ?? 30)) {
  if (!Number.isFinite(days) || days <= 0) return 0
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString().replace('T', ' ').slice(0, 19)
  // Never delete something still being retried — it hasn't reached a terminal state yet.
  const r = run(`DELETE FROM webhook_deliveries WHERE created_at < ? AND status IN ('delivered','failed')`, cutoff)
  return Number(r?.changes || 0)
}

/**
 * Effective invoice status, computed in SQL.
 *
 * The stored `status` column only changes when something writes to the invoice, but "overdue" is a
 * function of the calendar — an invoice goes overdue while nobody is touching it. The dashboard
 * always computed money-at-risk live from `due_date`, while the invoice list filtered on the
 * stored column, so an invoice that quietly passed its due date showed in the dashboard total and
 * then wasn't there under Invoices → Overdue. Same precedence as syncInvoiceStatus() below: paid,
 * then partial, then overdue. Pass today's date (YYYY-MM-DD) as the bound parameter.
 */
export const EFFECTIVE_STATUS_SQL = `(CASE
  WHEN i.status = 'void' THEN 'void'
  WHEN i.amount_paid >= i.amount_due - 0.005 THEN 'paid'
  WHEN i.due_date IS NOT NULL AND i.due_date != '' AND i.due_date < ? THEN 'overdue'
  WHEN i.amount_paid > 0 THEN 'partial'
  ELSE 'unpaid' END)`

/**
 * Overdue is now tested BEFORE partial, which changes which bucket a part-paid, past-due invoice
 * lands in — and it was previously landing in one no screen could show.
 *
 * The Invoices screen offers all / unpaid / overdue / partial / paid. Because the old order put
 * 'partial' first, an invoice with a deposit against it and a due date three weeks gone was
 * reported 'partial' and never appeared under Overdue — while the dashboard's money-at-risk KPI
 * and the follow-up scan, which both use `status != 'paid' AND due_date < today`, counted it as
 * overdue. The dashboard said money was at risk and no list could tell you which invoice.
 *
 * Being past due is the fact that needs acting on. A deposit does not make a late invoice
 * on-time, so 'overdue' wins and the amount outstanding is what the row shows.
 */

/** Today in the same YYYY-MM-DD form the due_date column uses. */
export const todayIso = () => new Date().toISOString().slice(0, 10)

/** Recompute invoice status from its payments. Returns the updated row. */
export function syncInvoiceStatus(invoiceId) {
  const inv = get('SELECT * FROM invoices WHERE id = ?', invoiceId)
  if (!inv) return null
  const paid = round2(get('SELECT COALESCE(SUM(amount), 0) AS p FROM payments WHERE invoice_id = ?', invoiceId).p)
  // A voided invoice stays voided: it is a bookkeeping record, not an outstanding demand, and a
  // payment arriving against it must not silently revive it.
  //
  // It must still show the money, though. Returning early without writing amount_paid meant a
  // payment row could exist — counted in Revenue MTD, pushed to QuickBooks — while the invoice it
  // was attached to read $0.00 paid, so the only document a human looks at was the one place the
  // charge was invisible. Record the amount, hold the status.
  if (inv.status === 'void') {
    if (Math.abs(paid - (Number(inv.amount_paid) || 0)) > 0.005) {
      run('UPDATE invoices SET amount_paid = ? WHERE id = ?', paid, invoiceId)
      return get('SELECT * FROM invoices WHERE id = ?', invoiceId)
    }
    return inv
  }
  // Same precedence as EFFECTIVE_STATUS_SQL — overdue before partial. These two must agree or the
  // list and the dashboard disagree about the same invoice, which is how this drifted before.
  let status = 'unpaid'
  if (paid >= inv.amount_due - 0.005) status = 'paid'
  else if (inv.due_date && inv.due_date < new Date().toISOString().slice(0, 10)) status = 'overdue'
  else if (paid > 0) status = 'partial'
  run('UPDATE invoices SET amount_paid = ?, status = ?, paid_at = ? WHERE id = ?', paid, status, status === 'paid' ? (inv.paid_at || now()) : null, invoiceId)
  return get('SELECT * FROM invoices WHERE id = ?', invoiceId)
}

seedSettings()
