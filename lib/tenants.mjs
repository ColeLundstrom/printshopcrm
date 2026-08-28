/**
 * Multi-tenant control plane.
 *
 * A single control database (control.db) holds the shop registry and login sessions. Each shop
 * ("tenant") gets its OWN SQLite database under data/tenants/<slug>/ — complete data and config
 * isolation, so every shop is a genuinely separate system. The app database helpers resolve the
 * current tenant's handle from an AsyncLocalStorage set by the auth middleware, so none of the
 * existing query code had to change.
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import crypto from 'node:crypto'
import { DB_PATH, initDb, tenantStore, seedSettings, setSetting } from './db.mjs'
import { initAutomations, seedAutomations } from './automations.mjs'
import { initSuppliers } from './suppliers.mjs'
import { initAgent } from './agent.mjs'
import { TRIAL_DAYS, billingLive } from './billing.mjs'

const iso = (d) => d.toISOString().replace('T', ' ').slice(0, 19)

const DATA_DIR = dirname(DB_PATH)
const CONTROL_PATH = process.env.PSC_CONTROL_DB || join(DATA_DIR, 'control.db')
const TENANTS_DIR = join(DATA_DIR, 'tenants')
mkdirSync(TENANTS_DIR, { recursive: true })

/** Enforced server-side on signup and password change — the form's minlength can be bypassed. */
export const MIN_PASSWORD = 8

const control = new DatabaseSync(CONTROL_PATH)
control.exec('PRAGMA journal_mode = WAL')
// Every authenticated request resolves its session against this database, and it is the only
// handle in the product that had no busy_timeout — lib/db.mjs:501 gives every tenant handle one.
// Without it SQLite does not wait at all, it fails on the first contended write: a live login
// answered 500 while bin/admin.mjs held a lock, and admin.mjs itself — the documented and only
// way out of a lockout — died with a raw ERR_SQLITE_ERROR stack trace. The recovery tool was the
// thing that broke. Five seconds, matching every tenant handle.
control.exec('PRAGMA busy_timeout = 5000')
control.exec(`
CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  shop_name TEXT NOT NULL,
  owner_name TEXT,
  owner_email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  embed_key TEXT UNIQUE NOT NULL,
  plan TEXT DEFAULT 'trial',
  status TEXT DEFAULT 'active',
  onboarding TEXT DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_login DATETIME
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON sessions(tenant_id);
CREATE TABLE IF NOT EXISTS platform_config (key TEXT PRIMARY KEY, value TEXT);

-- Members: every person who can sign in. Identity lives here (in the global control db) so login
-- can resolve an email to its shop, while each shop's business data stays in its own isolated db.
-- Roles: owner (billing + everything), manager (settings, keys, staff), staff (day-to-day work).
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'staff',
  status TEXT NOT NULL DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_login DATETIME
);
CREATE INDEX IF NOT EXISTS idx_members_tenant ON members(tenant_id);

-- Password resets. Only the SHA-256 of the token is stored: the raw value exists solely in the
-- email we send, so a stolen control.db can't be used to seize accounts. One row per request,
-- single-use (used_at), and short-lived.
CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  used_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_resets_member ON password_resets(member_id);

-- Nurture drip: marketing leads who left an email but haven't signed up. Platform-level (not a
-- tenant's data) — these are prospects for the SaaS itself. The scheduled sequence lives here so a
-- lead is never lost and gets a fixed set of follow-ups, then stops.
CREATE TABLE IF NOT EXISTS nurture_leads (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT DEFAULT '',
  shop TEXT DEFAULT '',
  source TEXT DEFAULT '',
  enrolled_at INTEGER NOT NULL,        -- ms epoch, the schedule anchor
  step INTEGER NOT NULL DEFAULT 1,     -- next email index to send (0 = day-0, sent at capture time)
  last_sent_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active',-- active | done | stopped
  unsub_token TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nurture_active ON nurture_leads(status, enrolled_at);
`)

// Additive: sessions carry the member who signed in (older rows resolve to the shop owner).
if (!control.prepare('PRAGMA table_info(sessions)').all().some((c) => c.name === 'member_id')) {
  control.exec('ALTER TABLE sessions ADD COLUMN member_id INTEGER')
}

// Additive migration for subscription billing (safe to run every boot).
for (const [col, decl] of [
  ['trial_ends_at', 'DATETIME'],
  ['plan_tier', "TEXT DEFAULT ''"],
  ['subscription_status', "TEXT DEFAULT 'trialing'"],  // trialing | active | past_due | canceled | trial_expired
  ['stripe_customer_id', 'TEXT'],
  ['stripe_subscription_id', 'TEXT'],
  // Public REST API key. On every plan — the incumbents all gate their API behind the top tier,
  // and that gating is a documented reason shops leave them.
  ['api_key', 'TEXT'],
]) {
  const has = control.prepare('PRAGMA table_info(tenants)').all().some((c) => c.name === col)
  if (!has) control.exec(`ALTER TABLE tenants ADD COLUMN ${col} ${decl}`)
}
control.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_api_key ON tenants(api_key)')

/* ---------- passwords ---------- */

// scrypt is ~36ms of CPU. node:sqlite is synchronous and every tenant shares one process, so the
// old scryptSync BLOCKED the whole fleet's event loop for that time on every login/signup. The
// async form runs on libuv's threadpool, so concurrent logins parallelise and nothing else stalls.
const scrypt = (pw, salt) => new Promise((resolve, reject) =>
  crypto.scrypt(String(pw), salt, 64, (err, dk) => (err ? reject(err) : resolve(dk.toString('hex')))))
const hashPassword = async (pw) => {
  const salt = crypto.randomBytes(16).toString('hex')
  return `${salt}:${await scrypt(pw, salt)}`
}
const verifyPassword = async (pw, stored) => {
  const [salt, hash] = String(stored || '').split(':')
  if (!salt || !hash) return false
  const test = await scrypt(pw, salt)
  const a = Buffer.from(hash, 'hex')
  const b = Buffer.from(test, 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/* ---------- tenant databases ---------- */

/**
 * Open tenant databases, most-recently-used last.
 *
 * One handle per shop, held for the life of the process. The cost that actually scales is each
 * connection's page cache, which is capped in initDb() rather than by evicting handles here:
 * evicting means CLOSING a handle that in-flight async work may still hold through
 * AsyncLocalStorage, which turns a memory optimisation into a use-after-close crash. File
 * descriptors are not the constraint (the service's limit is 524288), so we keep handles and bound
 * the memory instead. The counter is a tripwire, not a limit.
 */
const MAX_OPEN_DBS = Number(process.env.PSC_MAX_OPEN_DBS || 250)
let warnedOpenDbs = false
const openDbs = new Map() // slug -> DatabaseSync, in least-recently-used order
/**
 * Shops whose database would not open — slug -> the SQLite message. A shop lands here when its
 * migration throws on its own data, which leaves it totally dark while login still succeeds.
 * /health reads this so the deploy's automatic rollback can see the one failure that matters.
 */
export const brokenTenants = new Map()

/** Run schema + seed data + feature tables against a tenant db, inside its ALS context. */
function bootstrapDb(dbh) {
  tenantStore.run({ db: dbh }, () => {
    initDb(dbh)
    seedSettings()
    initAutomations(dbh)
    seedAutomations()
    initSuppliers(dbh)
    initAgent(dbh)
    dbh.exec('CREATE INDEX IF NOT EXISTS idx_msg_contact ON messages(contact_id)')
  })
}

/** Open (creating + bootstrapping on first touch) a tenant's database. Cached per process. */
export function openTenantDb(slug) {
  const cached = openDbs.get(slug)
  if (cached) { openDbs.delete(slug); openDbs.set(slug, cached); return cached } // touch → newest
  const path = join(TENANTS_DIR, slug, 'printshop.db')
  mkdirSync(dirname(path), { recursive: true })
  const dbh = new DatabaseSync(path)
  // Close the handle if bootstrap throws. It is only cached AFTER bootstrapDb returns, so a shop
  // whose migration fails (a duplicate that breaks a new unique index, a disk-full ALTER, a
  // corrupt page) leaked a connection on every single request for that shop — the retry re-runs
  // the same failing bootstrap and abandons another handle. Measured: 20 failed opens held 26
  // file descriptors. That climbs to process-wide EMFILE, and then every OTHER shop on the box
  // starts failing on uploads, sockets and their own databases. One broken tenant took the fleet.
  try { bootstrapDb(dbh) } catch (e) {
    // Record WHY before rethrowing. A shop whose migration throws is 100% down — every screen
    // 500s — and nothing reported it: /health probes the default database, which in multi-tenant
    // mode holds no shop at all and is perfectly writable. See brokenTenants' use in /health.
    brokenTenants.set(slug, String((e && e.message) || e))
    try { dbh.close() } catch { /* already gone */ }
    throw e
  }
  brokenTenants.delete(slug)
  openDbs.set(slug, dbh)
  if (openDbs.size > MAX_OPEN_DBS && !warnedOpenDbs) {
    warnedOpenDbs = true
    console.warn(`[tenants] ${openDbs.size} tenant databases open (soft cap ${MAX_OPEN_DBS}).`)
  }
  return dbh
}

/** Run a function inside a tenant's database context (query helpers resolve to it). */
export function withTenant(slug, fn) {
  return tenantStore.run({ db: openTenantDb(slug), slug }, fn)
}

/* ---------- slugs ---------- */

const baseSlug = (name) => String(name || 'shop').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'shop'

function uniqueSlug(name) {
  const base = baseSlug(name)
  let slug = base
  let n = 1
  while (control.prepare('SELECT 1 FROM tenants WHERE slug = ?').get(slug)) slug = `${base}-${++n}`
  return slug
}

/* ---------- tenant CRUD ---------- */

export function getTenantByEmail(email) {
  return control.prepare('SELECT * FROM tenants WHERE lower(owner_email) = lower(?)').get(String(email || ''))
}
export function getTenantBySlug(slug) {
  return control.prepare('SELECT * FROM tenants WHERE slug = ?').get(String(slug || ''))
}
export function getTenantById(id) {
  return control.prepare('SELECT * FROM tenants WHERE id = ?').get(Number(id))
}
export function getTenantByEmbedKey(key) {
  return control.prepare('SELECT * FROM tenants WHERE embed_key = ?').get(String(key || ''))
}

/* ---------- public REST API keys ---------- */

// Key format psc_live_<24 bytes base64url>. The psc_ prefix makes leaked keys findable by secret
// scanners; lookups are constant-time-ish on the unique index and the key is unguessable.
export function getTenantByApiKey(key) {
  const k = String(key || '')
  if (!k.startsWith('psc_')) return null
  return control.prepare("SELECT * FROM tenants WHERE api_key = ? AND status = 'active'").get(k)
}
export function rotateApiKey(tenantId) {
  const key = `psc_live_${crypto.randomBytes(24).toString('base64url')}`
  control.prepare('UPDATE tenants SET api_key = ? WHERE id = ?').run(key, Number(tenantId))
  return key
}
export function revokeApiKey(tenantId) {
  control.prepare('UPDATE tenants SET api_key = NULL WHERE id = ?').run(Number(tenantId))
}

/**
 * Create a shop: register it, spin up its isolated database, and set its shop name. Returns
 * { tenant } or throws { code } for a duplicate email.
 */
export async function createTenant({ shop_name, owner_name, owner_email, password }) {
  const email = String(owner_email || '').trim().toLowerCase()
  const missing = [!shop_name && 'shop name', !email && 'email', !password && 'password'].filter(Boolean)
  if (missing.length) { const e = new Error(`Missing required ${missing.length > 1 ? 'fields' : 'field'}: ${missing.join(', ')}`); e.code = 'missing'; throw e }
  // The client's minlength=6 is a hint, not a control — the API is reachable directly.
  if (String(password).length < MIN_PASSWORD) { const e = new Error(`Password must be at least ${MIN_PASSWORD} characters.`); e.code = 'weak_password'; throw e }
  if (getTenantByEmail(email) || getMemberByEmail(email)) { const e = new Error('An account with that email already exists'); e.code = 'dupe_email'; throw e }
  const embed_key = crypto.randomBytes(9).toString('base64url')
  const trialEnds = iso(new Date(Date.now() + TRIAL_DAYS * 864e5))
  const hash = await hashPassword(password)
  // Both the email check above and uniqueSlug() are check-then-insert, so two signups racing on the
  // same instant can both pass and then collide at the INSERT. That collision used to surface the
  // raw "SQLITE_CONSTRAINT: UNIQUE constraint failed: tenants.owner_email" string on the public
  // signup page, because the route only special-cased e.code === 'dupe_email'. The UNIQUE indexes
  // are the real guard; here we translate a violation into the same clean message a caller expects,
  // and a slug collision (two shops of the same name at once) simply retries with more entropy.
  let tenantId, slug
  const attempt = () => {
    slug = uniqueSlug(shop_name)
    control.exec('BEGIN IMMEDIATE')
    try {
      const info = control.prepare(
        'INSERT INTO tenants (slug, shop_name, owner_name, owner_email, password_hash, embed_key, plan, status, trial_ends_at, subscription_status) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ).run(slug, shop_name.trim(), (owner_name || '').trim(), email, hash, embed_key, 'trial', 'active', trialEnds, 'trialing')
      tenantId = Number(info.lastInsertRowid)
      // The owner is a first-class member — every login (owner and staff alike) authenticates here.
      control.prepare('INSERT INTO members (tenant_id, email, password_hash, name, role, status) VALUES (?,?,?,?,?,?)')
        .run(tenantId, email, hash, (owner_name || '').trim() || 'Owner', 'owner', 'active')
      control.exec('COMMIT')
      return true
    } catch (e) {
      try { control.exec('ROLLBACK') } catch { /* statement may have already aborted the txn */ }
      const msg = String(e && e.message)
      if (/UNIQUE constraint failed:.*(owner_email|members\.email)/i.test(msg)) {
        const de = new Error('An account with that email already exists'); de.code = 'dupe_email'; throw de
      }
      if (/UNIQUE constraint failed:.*slug/i.test(msg)) return false // lost the slug race — try again
      throw e
    }
  }
  // At most a couple of retries: a slug race resolves the instant uniqueSlug sees the winner's row.
  if (!attempt() && !attempt() && !attempt()) {
    const e = new Error('Could not create the shop just now — please try again.'); e.code = 'retry'; throw e
  }
  // Spin up the isolated database and stamp the shop's own name into its settings.
  withTenant(slug, () => {
    // SETTING_DEFAULTS describes the demo shop (Rebel Ink Press, the demo shop). Those exist for the
    // single-tenant dev seed, and a real shop must never inherit them: a Rockford, IL shop was
    // otherwise sending estimates stamped with a California address and a placeholder phone number.
    // Blank them so documents simply omit the field until the owner fills it in during onboarding.
    setSetting('shop_name', shop_name.trim())
    setSetting('shop_email', email) // always — not just when a name was supplied
    setSetting('shop_phone', '')
    setSetting('shop_address', '')
    setSetting('shop_tagline', '')
    // Sales tax is jurisdictional. The default is the demo shop's California rate, and inheriting it
    // meant an Illinois shop would quietly charge 7.75% CA tax on real customer invoices. Start at 0
    // and make the shop set its own rate in onboarding, which already asks for it.
    setSetting('tax_rate', '0')
  })
  return getTenantById(tenantId)
}

/* ---------- members (owner / manager / staff) ---------- */

export const ROLES = ['owner', 'manager', 'staff']
export const ROLE_RANK = { owner: 3, manager: 2, staff: 1 }

const memberPublic = (m) => m && ({ id: m.id, tenant_id: m.tenant_id, email: m.email, name: m.name, role: m.role, status: m.status, created_at: m.created_at, last_login: m.last_login })

/**
 * A tenant row that is safe to put on the wire — memberPublic's twin, which this table never had.
 *
 * A raw `tenants` row carries the owner's scrypt password_hash and the shop's LIVE psc_live_ API
 * key: a manager-equivalent credential the shop itself is shown exactly once and can never read
 * back. setTenantStatus returns SELECT *, so pressing Suspend or Reactivate in the Control Room
 * handed the operator both. GET /api/admin/shops next door was written as an explicit column list
 * for precisely this reason; this is the projection that makes that deliberate, not incidental.
 *
 * Allow-list, never a delete-list: a column added to `tenants` later must not start shipping
 * itself here because nobody remembered to exclude it.
 */
export const tenantPublic = (t) => t && ({
  id: t.id, slug: t.slug, shop_name: t.shop_name, owner_name: t.owner_name, owner_email: t.owner_email,
  plan: t.plan, plan_tier: t.plan_tier, status: t.status, created_at: t.created_at, last_login: t.last_login,
  trial_ends_at: t.trial_ends_at, subscription_status: t.subscription_status, embed_key: t.embed_key,
  api_key_set: !!t.api_key,
})

export function getMemberByEmail(email) {
  return control.prepare('SELECT * FROM members WHERE lower(email) = lower(?)').get(String(email || ''))
}
export function getMemberById(id) {
  return control.prepare('SELECT * FROM members WHERE id = ?').get(Number(id))
}
export function listMembers(tenantId) {
  return control.prepare("SELECT * FROM members WHERE tenant_id = ? ORDER BY (role='owner') DESC, (role='manager') DESC, id").all(Number(tenantId)).map(memberPublic)
}
export function countOwners(tenantId) {
  return control.prepare("SELECT COUNT(*) AS n FROM members WHERE tenant_id = ? AND role = 'owner' AND status = 'active'").get(Number(tenantId)).n
}

/** Add a staff/manager/owner to a shop. Email is globally unique (one login = one shop). */
export async function addMember(tenantId, { name, email, password, role }) {
  email = String(email || '').trim().toLowerCase()
  role = ROLES.includes(role) ? role : 'staff'
  if (!email || !password) { const e = new Error('Email and a temporary password are required'); e.code = 'missing'; throw e }
  // Signup, self-change, reset and the CLI all enforce MIN_PASSWORD. This was the only creation
  // path that did not, so a manager login could be created with a one-character password and it
  // signed in fine. Checked BEFORE the hash, so a rejected add does not pay for scrypt.
  if (String(password).length < MIN_PASSWORD) {
    const e = new Error(`Temporary password must be at least ${MIN_PASSWORD} characters.`); e.code = 'weak_password'; throw e
  }
  const memberHash = await hashPassword(password)
  if (getMemberByEmail(email) || getTenantByEmail(email)) { const e = new Error('That email already has an account'); e.code = 'dupe_email'; throw e }
  const id = Number(control.prepare('INSERT INTO members (tenant_id, email, password_hash, name, role, status) VALUES (?,?,?,?,?,?)')
    .run(Number(tenantId), email, memberHash, String(name || '').trim() || email.split('@')[0], role, 'active').lastInsertRowid)
  return memberPublic(getMemberById(id))
}

export function updateMember(tenantId, id, { role, name, status }) {
  const m = getMemberById(id)
  if (!m || m.tenant_id !== Number(tenantId)) { const e = new Error('No such member'); e.code = 'not_found'; throw e }
  // Never let the last active owner be demoted or deactivated — the shop must always have one.
  const demoting = (role && role !== 'owner') || (status && status !== 'active')
  if (m.role === 'owner' && demoting && countOwners(tenantId) <= 1) { const e = new Error('A shop must keep at least one owner'); e.code = 'last_owner'; throw e }
  control.prepare('UPDATE members SET role = COALESCE(?, role), name = COALESCE(?, name), status = COALESCE(?, status) WHERE id = ?')
    .run(role && ROLES.includes(role) ? role : null, name != null ? String(name).trim() : null, status || null, Number(id))
  return memberPublic(getMemberById(id))
}

export function deleteMember(tenantId, id) {
  const m = getMemberById(id)
  if (!m || m.tenant_id !== Number(tenantId)) return false
  if (m.role === 'owner' && countOwners(tenantId) <= 1) { const e = new Error('A shop must keep at least one owner'); e.code = 'last_owner'; throw e }
  control.prepare('DELETE FROM members WHERE id = ?').run(Number(id))
  control.prepare('DELETE FROM sessions WHERE member_id = ?').run(Number(id)) // sign them out everywhere
  return true
}

/**
 * Verify a member's own password. Deliberately not authMember(): that bumps last_login, which
 * would make "last signed in" wrong every time someone changed their password.
 */
export async function verifyMemberPassword(id, password) {
  const m = getMemberById(id)
  return !!m && m.status === 'active' && await verifyPassword(password, m.password_hash)
}

export async function setMemberPassword(id, password) {
  control.prepare('UPDATE members SET password_hash = ? WHERE id = ?').run(await hashPassword(password), Number(id))
  // Changing the password ends every existing session for this member — the point of a password
  // change is often that an old one is compromised, and leaving other sessions live defeats it.
  // The reset path already did this; the self-service change did not, so the two disagreed. The
  // caller that wants to keep the current device signed in mints a fresh session afterward.
  control.prepare('DELETE FROM sessions WHERE member_id = ?').run(Number(id)) // sign out everywhere
}

/**
 * Validate a login against the members table. Returns { member, tenant } or null. This is the one
 * auth path for owners and staff alike — the email resolves to exactly one shop.
 */
export async function authMember(email, password) {
  const m = getMemberByEmail(email)
  if (!m || m.status !== 'active') return null
  if (!await verifyPassword(password, m.password_hash)) return null
  const tenant = getTenantById(m.tenant_id)
  if (!tenant || tenant.status !== 'active') return null
  control.prepare('UPDATE members SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(m.id)
  return { member: memberPublic(m), tenant }
}

/**
 * One-time backfill: give every pre-members shop an owner member from its legacy owner login, so
 * existing accounts keep working after the upgrade. Idempotent — skips shops that already have one.
 */
export function backfillOwnerMembers() {
  const tenants = control.prepare('SELECT * FROM tenants').all()
  for (const t of tenants) {
    const has = control.prepare('SELECT 1 FROM members WHERE tenant_id = ?').get(t.id)
    if (has || !t.owner_email || !t.password_hash) continue
    try {
      control.prepare('INSERT INTO members (tenant_id, email, password_hash, name, role, status) VALUES (?,?,?,?,?,?)')
        .run(t.id, String(t.owner_email).toLowerCase(), t.password_hash, t.owner_name || 'Owner', 'owner', 'active')
    } catch { /* email collision across shops — skip, that shop's owner logs in via the winner */ }
  }
}

/** Validate a login. Returns the tenant or null. Legacy owner-only path, kept for compatibility. */
export async function authTenant(email, password) {
  const r = await authMember(email, password)
  return r ? r.tenant : null
}

export async function setPassword(tenantId, password) {
  control.prepare('UPDATE tenants SET password_hash = ? WHERE id = ?').run(await hashPassword(password), Number(tenantId))
}

export function saveOnboarding(tenantId, obj) {
  control.prepare('UPDATE tenants SET onboarding = ? WHERE id = ?').run(JSON.stringify(obj || {}), Number(tenantId))
}

/* ---------- sessions ---------- */

const SESSION_DAYS = 30

export function createSession(tenantId, memberId = null) {
  const token = crypto.randomBytes(24).toString('base64url')
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString().replace('T', ' ').slice(0, 19)
  control.prepare('INSERT INTO sessions (token, tenant_id, member_id, expires_at) VALUES (?,?,?,?)').run(token, Number(tenantId), memberId != null ? Number(memberId) : null, expires)
  return token
}

/** Resolve a session token to its live { tenant, member }, or null if missing/expired/inactive. */
export function getSession(token) {
  if (!token) return null
  const s = control.prepare("SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')").get(String(token))
  if (!s) return null
  const tenant = getTenantById(s.tenant_id)
  if (!tenant || tenant.status !== 'active') return null
  // Older sessions (pre-members) carry no member_id → resolve to the shop's owner.
  let member = s.member_id ? getMemberById(s.member_id) : null
  if (member && (member.status !== 'active' || member.tenant_id !== tenant.id)) return null
  if (!member) member = control.prepare("SELECT * FROM members WHERE tenant_id = ? AND role = 'owner' ORDER BY id LIMIT 1").get(tenant.id)
  return { tenant, member: member ? memberPublic(member) : null }
}

/** Resolve a session token to its live tenant, or null. Kept for the realtime layer. */
export function getSessionTenant(token) {
  return getSession(token)?.tenant || null
}

export function deleteSession(token) {
  if (token) control.prepare('DELETE FROM sessions WHERE token = ?').run(String(token))
}

/** Sweep expired sessions so control.db doesn't grow unbounded. Called periodically off the tick. */
export function purgeExpiredSessions() {
  try { return control.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run().changes } catch { return 0 }
}

export function tenantCount() {
  return control.prepare('SELECT COUNT(*) AS n FROM tenants').get().n
}

/** Active shops' slugs — used to run the automation tick inside each tenant's own database. */
export function activeTenantSlugs() {
  return control.prepare("SELECT slug FROM tenants WHERE status = 'active'").all().map((r) => r.slug)
}

/* ---------- billing ---------- */

/** Resolve a tenant's current billing state, including live-computed trial expiry. */
export function billingState(tenant) {
  const t = tenant && tenant.id ? getTenantById(tenant.id) : tenant
  if (!t) return { status: 'unknown', subscribed: false }
  let status = t.subscription_status || 'trialing'
  const trialEnds = t.trial_ends_at ? new Date(`${String(t.trial_ends_at).replace(' ', 'T')}Z`) : null
  let trialing = status === 'trialing'
  const trialExpired = trialing && trialEnds && trialEnds.getTime() < Date.now()
  if (trialExpired) status = 'trial_expired'
  // Free is a real plan with no monthly fee, so a Free shop is simply a customer — never a lapsed
  // trial. Normalizing here (rather than only exempting `locked`) keeps the whole state machine
  // coherent: without it a Free shop whose trial date passed still reported 'trial_expired', so the
  // app worked but every banner shouted "your trial has ended — choose a plan to keep working".
  const onFree = t.plan_tier === 'free'
  if (onFree) { status = 'active'; trialing = false }
  const subscribed = status === 'active' || status === 'past_due'
  const daysLeft = trialEnds ? Math.max(0, Math.ceil((trialEnds.getTime() - Date.now()) / 864e5)) : 0
  return {
    status, subscribed, plan: t.plan_tier || '',
    trial_ends_at: t.trial_ends_at || null, trial_days_left: trialing ? daysLeft : 0,
    stripe_customer_id: t.stripe_customer_id || '',
    // The app is usable during trial and while subscribed; it locks new work only when the trial
    // has lapsed with no plan. Owners can always still reach billing to upgrade.
    // Only lock when the shop can actually pay: with no platform Stripe key, checkout answers 503,
    // so locking would leave a shop unable to work AND unable to subscribe.
    locked: billingLive() && !onFree && (status === 'trial_expired' || status === 'canceled'),
  }
}

/**
 * Slugs of active tenants whose plan includes the follow-up automations. The lite edition sells
 * automations as the $99 tier, so its tick must skip every other shop; shops still in trial get
 * them (they're evaluating the whole product). Pro shops all have automations, so pass through.
 */
export function automationTenantSlugs({ lite = false } = {}) {
  const rows = control.prepare("SELECT slug, plan_tier, subscription_status, trial_ends_at FROM tenants WHERE status = 'active'").all()
  if (!lite) return rows.map((r) => r.slug)
  // subscription_status stays 'trialing' after the trial lapses (expiry is computed live in
  // billingState), so an unchecked 'trialing' test would keep firing automations forever for a
  // shop that never paid. The date is the real gate.
  const stillTrialing = (r) => r.subscription_status === 'trialing'
    && r.trial_ends_at && new Date(`${String(r.trial_ends_at).replace(' ', 'T')}Z`).getTime() > Date.now()
  return rows.filter((r) => r.plan_tier === 'control_auto' || stillTrialing(r)).map((r) => r.slug)
}

/** Persist a subscription result from Stripe (webhook or checkout return). */
export function setSubscription(tenantId, { plan, status, customerId, subscriptionId }) {
  const cur = getTenantById(tenantId)
  if (!cur) return
  control.prepare(
    'UPDATE tenants SET plan_tier = ?, subscription_status = ?, stripe_customer_id = COALESCE(?, stripe_customer_id), stripe_subscription_id = COALESCE(?, stripe_subscription_id), plan = ? WHERE id = ?',
  ).run(plan ?? cur.plan_tier ?? '', status ?? cur.subscription_status, customerId ?? null, subscriptionId ?? null, status === 'active' ? 'paid' : (cur.plan || 'trial'), tenantId)
}

export function getTenantByStripeCustomer(customerId) {
  return control.prepare('SELECT * FROM tenants WHERE stripe_customer_id = ?').get(String(customerId || ''))
}

/* ---------- platform config (the owner's platform Stripe credentials) ---------- */

export function getPlatformConfig() {
  const rows = control.prepare('SELECT key, value FROM platform_config').all()
  const out = {}
  for (const r of rows) out[r.key] = r.value
  return out
}
export function setPlatformConfig(obj) {
  const up = control.prepare('INSERT INTO platform_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  for (const [k, v] of Object.entries(obj || {})) up.run(k, String(v ?? ''))
}

/** The platform owner (you) — the tenant whose email matches PSC_ADMIN_EMAIL can manage billing config. */
export function isAdminEmail(email) {
  // Trimmed as well as lower-cased on BOTH sides. createTenant normalises what it stores, so
  // without the trim here "  OPERATOR@Example.COM " walked past the signup guard and then matched
  // once it was in the database — which is the whole platform.
  const admin = (process.env.PSC_ADMIN_EMAIL || '').trim().toLowerCase()
  return !!admin && String(email || '').trim().toLowerCase() === admin
}

/* ---------- nurture drip ---------- */

/** Enroll a captured lead into the drip. Idempotent on email: re-capturing won't reset the sequence
 *  or duplicate a person. Returns the row. `step` starts at 1 because day-0 is sent at capture time. */
export function enrollNurture({ email, name, shop, source }, nowMs) {
  email = String(email || '').trim().toLowerCase()
  if (!email) return null
  const existing = control.prepare('SELECT * FROM nurture_leads WHERE email = ?').get(email)
  if (existing) return existing
  const token = crypto.randomBytes(16).toString('hex')
  control.prepare('INSERT INTO nurture_leads (email, name, shop, source, enrolled_at, step, status, unsub_token) VALUES (?,?,?,?,?,?,?,?)')
    .run(email, String(name || ''), String(shop || ''), String(source || ''), Number(nowMs), 1, 'active', token)
  return control.prepare('SELECT * FROM nurture_leads WHERE email = ?').get(email)
}

/** Active leads whose next email is due at/before `nowMs`, given the schedule's day offsets. */
export function dueNurture(nowMs, dayOffsets) {
  const DAY = 86400000
  const rows = control.prepare("SELECT * FROM nurture_leads WHERE status = 'active'").all()
  return rows.filter((r) => {
    const off = dayOffsets[r.step]
    if (off == null) return false
    // The step is due relative to enrollment…
    if (Number(nowMs) < r.enrolled_at + off * DAY) return false
    // …BUT it must also be spaced from the PREVIOUS send by the intended gap. Without this, a lead
    // whose enrolled_at is in the past — a backdated capture, an imported lead — had every step's
    // offset already elapsed, so the tick fired one drip per pass and sent all four within ~20
    // minutes. Spacing from last_sent_at makes the real elapsed cadence match the schedule (day 2,
    // then +3, then +5, then +10) no matter how far back enrollment sits.
    if (r.last_sent_at) {
      const prevOff = dayOffsets[r.step - 1] ?? 0
      const gap = Math.max(0, off - prevOff) * DAY
      if (Number(nowMs) < r.last_sent_at + gap) return false
    }
    return true
  })
}

/** Record that step `r.step` was sent: advance to the next, or finish when the sequence runs out. */
export function advanceNurture(id, totalSteps, nowMs) {
  const r = control.prepare('SELECT * FROM nurture_leads WHERE id = ?').get(Number(id))
  if (!r) return
  const next = r.step + 1
  const status = next >= totalSteps ? 'done' : 'active'
  control.prepare('UPDATE nurture_leads SET step = ?, last_sent_at = ?, status = ? WHERE id = ?')
    .run(next, Number(nowMs), status, Number(id))
}

/** Stop the drip for an email — used when a lead signs up or unsubscribes. */
export function stopNurture(email, status = 'stopped') {
  control.prepare('UPDATE nurture_leads SET status = ? WHERE email = ?').run(status, String(email || '').trim().toLowerCase())
}
export function stopNurtureByToken(token) {
  const r = control.prepare('SELECT * FROM nurture_leads WHERE unsub_token = ?').get(String(token || ''))
  if (!r) return null
  control.prepare("UPDATE nurture_leads SET status = 'stopped' WHERE id = ?").run(r.id)
  return r
}
/** True if this email already belongs to a signed-up shop/member (so we stop marketing to them). */
export function emailHasAccount(email) {
  return !!(getTenantByEmail(email) || getMemberByEmail(email))
}

/* ---------- platform admin (superadmin control panel) ---------- */

/** Every shop on this deployment, with light per-shop stats — the admin control room's list. */
export function listTenantsAdmin() {
  const rows = control.prepare(`SELECT id, slug, shop_name, owner_name, owner_email, plan, status,
    created_at, last_login, trial_ends_at, subscription_status FROM tenants ORDER BY created_at DESC`).all()
  return rows.map((t) => {
    let invoices = 0, customers = 0, revenue = 0
    try {
      const dbh = openTenantDb(t.slug)
      invoices = dbh.prepare('SELECT COUNT(*) c FROM invoices').get().c
      customers = dbh.prepare('SELECT COUNT(*) c FROM contacts').get().c
      revenue = dbh.prepare('SELECT COALESCE(SUM(amount_paid),0) v FROM invoices').get().v
    } catch { /* brand-new/empty shop */ }
    return { ...t, invoices, customers, revenue: Math.round((Number(revenue) || 0) * 100) / 100 }
  })
}

/** Suspend or reactivate a shop. Suspended shops can't sign in (getSession rejects non-active). */
export function setTenantStatus(id, status) {
  const s = status === 'suspended' ? 'suspended' : 'active'
  control.prepare('UPDATE tenants SET status = ? WHERE id = ?').run(s, Number(id))
  return control.prepare('SELECT * FROM tenants WHERE id = ?').get(Number(id))
}

/** Permanently remove a shop and everything under it — control rows + its isolated database dir. */
export function deleteTenantFully(id) {
  const t = control.prepare('SELECT slug FROM tenants WHERE id = ?').get(Number(id))
  if (!t) return false
  control.prepare('DELETE FROM members WHERE tenant_id = ?').run(Number(id))
  control.prepare('DELETE FROM sessions WHERE tenant_id = ?').run(Number(id))
  control.prepare('DELETE FROM tenants WHERE id = ?').run(Number(id))
  const dbh = openDbs.get(t.slug); try { dbh?.close?.() } catch { /* noop */ }
  openDbs.delete(t.slug)
  try { rmSync(join(TENANTS_DIR, t.slug), { recursive: true, force: true }) } catch { /* already gone */ }
  return true
}

/* ---------- password reset ---------- */

/**
 * Forgotten-password reset.
 *
 * The product could change a password you already knew, but had no way back in for the person who
 * had actually forgotten one — for a solo owner that meant the shop, its jobs and its invoices were
 * simply gone. Standard emailed-token flow.
 *
 * The token is random, hashed at rest, valid for one hour and usable once. Requesting a new one
 * invalidates any earlier outstanding token for that member, so a forwarded old email goes dead.
 */
const RESET_TTL_MIN = 60
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex')

/**
 * Start a reset. Returns { token, member, tenant } for the caller to email, or null when the
 * address matches no active account — the ROUTE must answer identically either way, so this
 * function never becomes an account-existence oracle.
 */
export function createPasswordReset(email) {
  const m = getMemberByEmail(email)
  if (!m || m.status !== 'active') return null
  const tenant = getTenantById(m.tenant_id)
  if (!tenant || tenant.status !== 'active') return null
  // Supersede anything still outstanding for this member.
  control.prepare('DELETE FROM password_resets WHERE member_id = ? AND used_at IS NULL').run(m.id)
  const token = crypto.randomBytes(32).toString('base64url')
  const expires = new Date(Date.now() + RESET_TTL_MIN * 60_000).toISOString().replace('T', ' ').slice(0, 19)
  control.prepare('INSERT INTO password_resets (member_id, token_hash, expires_at) VALUES (?,?,?)').run(m.id, hashToken(token), expires)
  return { token, member: memberPublic(m), tenant }
}

/** Is this token still good? Used to decide whether to render the form or an "expired" message. */
export function checkPasswordReset(token) {
  if (!token) return null
  const r = control.prepare("SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')").get(hashToken(token))
  if (!r) return null
  const m = getMemberById(r.member_id)
  return m && m.status === 'active' ? { reset: r, member: memberPublic(m) } : null
}

/**
 * Spend the token and set the new password. Every existing session for that member is dropped:
 * if the reason for the reset was that somebody else had the account, leaving their cookie alive
 * would defeat the whole exercise.
 */
/**
 * MUST be awaited. setMemberPassword and setPassword both await the hash before they write, and
 * this function used to call them without awaiting — so it returned before the password had been
 * written, and the route then minted a session and answered 200. The detached call landed ~36ms
 * later and its `DELETE FROM sessions WHERE member_id` destroyed the session it had just issued:
 * every password reset signed the user straight back out at the login form, on the one screen a
 * locked-out owner reaches for.
 *
 * The ordering also mattered. `used_at` and the session purge committed FIRST and the password
 * write last and detached, so a failure in hashing spent the token and changed nothing — the link
 * is single-use, so the owner's recovery path was gone with no way to tell. The password is now
 * written first and the token is spent only once that has succeeded.
 */
export async function consumePasswordReset(token, password) {
  const found = checkPasswordReset(token)
  if (!found) { const e = new Error('That reset link has expired or already been used.'); e.code = 'bad_token'; throw e }
  if (String(password || '').length < MIN_PASSWORD) { const e = new Error(`Password must be at least ${MIN_PASSWORD} characters.`); e.code = 'weak_password'; throw e }
  const m = getMemberById(found.reset.member_id)
  // Write the credential first — everything below is only safe once it has landed.
  await setMemberPassword(m.id, password)
  // Owners also carry a legacy hash on the tenant row; leaving it stale keeps the old password
  // working through authTenant.
  if (m.role === 'owner') await setPassword(m.tenant_id, password)
  control.prepare("UPDATE password_resets SET used_at = datetime('now') WHERE id = ?").run(found.reset.id)
  // setMemberPassword has already signed out every session for this member. Doing it again here is
  // harmless and keeps the guarantee explicit even if that helper's contract ever changes.
  control.prepare('DELETE FROM sessions WHERE member_id = ?').run(m.id)
  return { member: memberPublic(m), tenant: getTenantById(m.tenant_id) }
}

// Upgrade existing installs on boot: every legacy shop gets an owner member so logins keep working.
backfillOwnerMembers()
