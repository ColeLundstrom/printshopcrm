/** Durable hosting Checkout attempts. No provider call runs inside a SQLite transaction. */
import crypto from 'node:crypto'
import { buildHostingCheckoutRequest, createPlatformBillingClient, HOSTING_PURPOSE, PLANS } from './billing.mjs'
import { legacyProductMatches } from './platform-subscription-events.mjs'
import { initHostingDeletion, assertNoHostingDeletion, withHostingBillingOperation } from './hosting-deletion.mjs'

const OPEN = ['reserved', 'creating', 'unknown', 'open', 'held']
const TERMINAL_SUB = new Set(['canceled', 'incomplete_expired'])
const SUB_STATUS = new Set(['active', 'trialing', 'past_due', 'canceled', 'incomplete', 'incomplete_expired', 'unpaid', 'paused'])
const ID = (value, prefix) => {
  const raw = value && typeof value === 'object' ? value.id : value
  return typeof raw === 'string' && !/\s/.test(raw) && new RegExp(`^${prefix}_[A-Za-z0-9_]{1,240}$`).test(raw) ? raw : null
}
const sha = value => crypto.createHash('sha256').update(value).digest('hex')
const safe = (code, message, status = 409) => Object.assign(new Error(message), { code, status, expose: true, hostingSafe: true, retryable: status === 503 })
const unavailable = () => safe('hosting_checkout_unavailable', 'Hosting checkout could not be verified. Try reconciliation again shortly.', 503)
const mismatch = () => safe('hosting_checkout_mismatch', 'That Stripe session does not match this saved hosting checkout.')
const DIAGNOSTICS = new Set(['provider_unavailable', 'key_window_elapsed', 'account_mismatch', 'request_changed', 'verification_failed', 'binding_changed', 'existing_subscription', 'customer_mismatch', 'missing_subscription', 'unknown_intent', 'attempt_limit'])

export function createHostingCheckouts(db, { createClient = createPlatformBillingClient, buildRequest = buildHostingCheckoutRequest, now = Date.now, limits = {} } = {}) {
  initHostingDeletion(db)
  const config = { maxConcurrent: 4, leaseMs: 120000, keyWindowMs: 23 * 60 * 60 * 1000, maxAttempts: 12, maxTenantHistory: 500, maxHistory: 100000, maxAnomalies: 10000, ...limits }
  for (const value of Object.values(config)) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Invalid hosting checkout limits')
  if (config.keyWindowMs > 23 * 60 * 60 * 1000 || config.leaseMs < 120000 || config.maxConcurrent > 16) throw new TypeError('Unsafe hosting checkout limits')
  if (!db.prepare('PRAGMA table_info(tenants)').all().some(column=>column.name === 'hosting_revision')) db.exec('ALTER TABLE tenants ADD COLUMN hosting_revision INTEGER NOT NULL DEFAULT 0')
  db.exec(`
    CREATE TABLE IF NOT EXISTS hosting_checkout_intents (
      id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, account_scope TEXT NOT NULL,
      request_body TEXT NOT NULL CHECK(length(request_body)<=16384), request_digest TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE, expected_customer_id TEXT, expected_subscription_id TEXT,
      plan TEXT NOT NULL, interval TEXT NOT NULL, amount_cents INTEGER NOT NULL, currency TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('reserved','creating','unknown','open','held','complete','expired')),
      session_id TEXT, session_url TEXT CHECK(length(session_url)<=8192), subscription_id TEXT,
      expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      first_attempt_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER,
      diagnostic TEXT, lease_token TEXT, lease_until INTEGER, revision INTEGER NOT NULL DEFAULT 0, resolved_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS hosting_checkout_one_unresolved ON hosting_checkout_intents(tenant_id)
      WHERE state IN ('reserved','creating','unknown','open','held');
    CREATE UNIQUE INDEX IF NOT EXISTS hosting_checkout_one_session ON hosting_checkout_intents(account_scope,session_id) WHERE session_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS hosting_checkout_history ON hosting_checkout_intents(tenant_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS hosting_checkout_anomalies (
      id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, intent_id TEXT, account_scope TEXT NOT NULL,
      session_id TEXT, subscription_id TEXT, code TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      occurrences INTEGER NOT NULL DEFAULT 1, resolved_at INTEGER, resolution_note TEXT, resolution_evidence TEXT
    );
    CREATE INDEX IF NOT EXISTS hosting_checkout_anomaly_tenant ON hosting_checkout_anomalies(tenant_id,created_at DESC);
    CREATE TRIGGER IF NOT EXISTS hosting_checkout_immutable BEFORE UPDATE ON hosting_checkout_intents
    WHEN NEW.id IS NOT OLD.id OR NEW.tenant_id IS NOT OLD.tenant_id OR NEW.account_scope IS NOT OLD.account_scope
      OR NEW.request_body IS NOT OLD.request_body OR NEW.request_digest IS NOT OLD.request_digest
      OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.expected_customer_id IS NOT OLD.expected_customer_id
      OR NEW.expected_subscription_id IS NOT OLD.expected_subscription_id OR NEW.plan IS NOT OLD.plan
      OR NEW.interval IS NOT OLD.interval OR NEW.amount_cents IS NOT OLD.amount_cents OR NEW.currency IS NOT OLD.currency
      OR NEW.created_at IS NOT OLD.created_at
      OR (OLD.first_attempt_at IS NOT NULL AND NEW.first_attempt_at IS NOT OLD.first_attempt_at)
      OR (OLD.session_id IS NOT NULL AND NEW.session_id IS NOT OLD.session_id)
      OR (OLD.subscription_id IS NOT NULL AND NEW.subscription_id IS NOT OLD.subscription_id)
    BEGIN SELECT RAISE(ABORT,'hosting checkout identity is immutable'); END;
  `)
  // Additive for a database opened by an earlier candidate, too. No receipt or tenant is rebuilt.
  for (const [table, columns] of [['hosting_checkout_intents', [['resolved_at','INTEGER']]], ['hosting_checkout_anomalies', [['resolved_at','INTEGER'],['resolution_note','TEXT'],['resolution_evidence','TEXT']]]]) {
    const present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column=>column.name))
    for (const [column, type] of columns) if (!present.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }
  const indexSql = db.prepare("SELECT sql FROM sqlite_schema WHERE name='hosting_checkout_one_unresolved'").get()?.sql || ''
  if (!indexSql.includes('resolved_at')) db.exec(`BEGIN IMMEDIATE; DROP INDEX hosting_checkout_one_unresolved;
    CREATE UNIQUE INDEX hosting_checkout_one_unresolved ON hosting_checkout_intents(tenant_id)
      WHERE state IN ('reserved','creating','unknown','open','held') AND resolved_at IS NULL; COMMIT;`)
  const transaction = callback => {
    db.exec('BEGIN IMMEDIATE')
    try { const result = callback(); db.exec('COMMIT'); return result }
    catch (error) { try { db.exec('ROLLBACK') } catch {} throw error }
  }
  const get = id => db.prepare('SELECT * FROM hosting_checkout_intents WHERE id=?').get(id)
  const tenant = id => db.prepare('SELECT * FROM tenants WHERE id=?').get(id)
  const unresolved = id => db.prepare("SELECT * FROM hosting_checkout_intents WHERE tenant_id=? AND state IN ('reserved','creating','unknown','open','held') AND resolved_at IS NULL").get(id)
  const hasAnomaly = id => !!db.prepare('SELECT 1 FROM hosting_checkout_anomalies WHERE tenant_id=? AND resolved_at IS NULL LIMIT 1').get(id)
    || !!db.prepare("SELECT 1 FROM hosting_billing_verifications WHERE tenant_id=? AND state='pending' LIMIT 1").get(id)
  const validTenant = id => { if (!Number.isSafeInteger(id) || id < 1 || !tenant(id)) throw safe('hosting_checkout_tenant', 'Shop not found.', 404) }
  const accountScope = account => {
    if (!account || !ID(account.accountId, 'acct') || typeof account.livemode !== 'boolean') throw unavailable()
    return `${account.accountId}:${account.livemode ? 'live' : 'test'}`
  }
  let localWork = 0
  const bounded = async callback => {
    if (localWork >= config.maxConcurrent) throw safe('hosting_checkout_busy', 'Hosting checkout is busy. Try again shortly.', 503)
    localWork++
    try { return await callback() } catch (error) { if (error?.hostingSafe) throw error; throw unavailable() } finally { localWork-- }
  }
  const claim = id => transaction(() => {
    const row = get(id), stamp = now()
    if (!row) throw safe('hosting_checkout_missing', 'No saved hosting checkout was found.', 404)
    if (!tenant(row.tenant_id)) throw safe('hosting_checkout_tenant', 'Shop not found.', 404)
    assertNoHostingDeletion(db, row.tenant_id, now)
    if (row.lease_token && row.lease_until > stamp) throw safe('hosting_checkout_busy', 'This hosting checkout is already being checked. Try again shortly.', 503)
    if (db.prepare('SELECT count(*) AS n FROM hosting_checkout_intents WHERE lease_until>? AND lease_token IS NOT NULL').get(stamp).n >= config.maxConcurrent) throw safe('hosting_checkout_busy', 'Hosting checkout is busy. Try again shortly.', 503)
    const token = crypto.randomUUID()
    const changed = db.prepare('UPDATE hosting_checkout_intents SET lease_token=?,lease_until=?,revision=revision+1 WHERE id=? AND revision=?').run(token, stamp + config.leaseMs, id, row.revision)
    if (changed.changes !== 1) throw unavailable()
    return { row: get(id), token }
  })
  const owned = (id, token) => {
    const row = get(id)
    if (!row || row.lease_token !== token || row.lease_until <= now()) throw safe('hosting_checkout_lease', 'This checkout check expired. Reconcile the saved checkout again.', 503)
    return row
  }
  const update = (id, token, patch) => {
    owned(id, token)
    const allowed = new Set(['state','session_id','session_url','subscription_id','expires_at','first_attempt_at','attempts','retry_at','diagnostic'])
    if (Object.keys(patch).some(key => !allowed.has(key))) throw new TypeError('Invalid checkout update')
    const keys = Object.keys(patch)
    const result = db.prepare(`UPDATE hosting_checkout_intents SET ${keys.map(key=>`${key}=?`).join(',')},updated_at=?,revision=revision+1 WHERE id=? AND lease_token=? AND lease_until>?`)
      .run(...keys.map(key=>patch[key]), now(), id, token, now())
    if (result.changes !== 1) throw unavailable()
    return get(id)
  }
  const release = (id, token) => {
    try { db.prepare('UPDATE hosting_checkout_intents SET lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?').run(id, token) } catch {}
  }
  const status = (tenantId, ignoreLease = null) => {
    validTenant(tenantId)
    const row = unresolved(tenantId) || db.prepare('SELECT * FROM hosting_checkout_intents WHERE tenant_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(tenantId)
    const active = row && OPEN.includes(row.state) && !row.resolved_at, stamp = now()
    const canRetry = !!active && !(row.lease_token && row.lease_token !== ignoreLease && row.lease_until > stamp) && (!row.retry_at || row.retry_at <= stamp)
    return {
      intent: row ? { id: row.id, state: row.resolved_at ? 'closed' : row.state, plan: row.plan, interval: row.interval, amount_cents: row.amount_cents, currency: row.currency,
        url: row.state === 'open' && !row.resolved_at && row.expires_at > stamp && !row.diagnostic && !hasAnomaly(tenantId)
          && !db.prepare("SELECT 1 FROM hosting_tenant_deletions WHERE tenant_id=? AND state='checking' AND lease_until>?").get(tenantId, stamp) ? row.session_url : null,
        session_id: row.session_id, created_at: row.created_at, updated_at: row.updated_at, expires_at: row.expires_at,
        retry_at: row.retry_at, diagnostic: row.diagnostic, can_retry: canRetry, can_expire: canRetry && !!row.session_id && row.diagnostic !== 'account_mismatch' } : null,
      anomalies: db.prepare('SELECT id,intent_id,session_id,subscription_id,code,created_at,updated_at,occurrences FROM hosting_checkout_anomalies WHERE tenant_id=? AND resolved_at IS NULL ORDER BY updated_at DESC LIMIT 20').all(tenantId),
      resolved_anomalies: db.prepare('SELECT id,code,resolved_at,resolution_note FROM hosting_checkout_anomalies WHERE tenant_id=? AND resolved_at IS NOT NULL ORDER BY resolved_at DESC LIMIT 10').all(tenantId),
      pending_verifications: db.prepare("SELECT id,session_id,identity_json,created_at FROM hosting_billing_verifications WHERE tenant_id=? AND state='pending' ORDER BY created_at LIMIT 20").all(tenantId)
        .map(row=>({id:row.id,session_id:row.session_id,subscription_id:JSON.parse(row.identity_json).subscription_id,created_at:row.created_at})),
    }
  }
  const recordAnomaly = ({ tenantId, intentId = null, scope = 'legacy-platform', sessionId = null, subscriptionId = null, code }) => {
    if (!DIAGNOSTICS.has(code)) code = 'verification_failed'
    if (!Number.isSafeInteger(tenantId) || tenantId < 1) throw mismatch()
    if (!tenant(tenantId)) return false
    sessionId = ID(sessionId, 'cs'); subscriptionId = ID(subscriptionId, 'sub')
    const identity = sha(JSON.stringify([tenantId, scope, sessionId, subscriptionId, code]))
    if (!db.prepare('SELECT 1 FROM hosting_checkout_anomalies WHERE id=?').get(identity)
        && db.prepare('SELECT count(*) AS n FROM hosting_checkout_anomalies').get().n >= config.maxAnomalies) throw safe('hosting_checkout_history_full', 'Hosting checkout needs server-operator review before continuing.', 503)
    db.prepare(`INSERT INTO hosting_checkout_anomalies(id,tenant_id,intent_id,account_scope,session_id,subscription_id,code,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,occurrences=MIN(occurrences+1,1000000)`)
      .run(identity, tenantId, intentId, scope, sessionId, subscriptionId, code, now(), now())
  }
  const hold = (row, token, code, subscriptionId = null, anomaly = false) => transaction(() => {
    owned(row.id, token)
    if (anomaly) recordAnomaly({ tenantId: row.tenant_id, intentId: row.id, scope: row.account_scope, sessionId: row.session_id, subscriptionId, code })
    if (OPEN.includes(row.state)) update(row.id, token, { state: 'held', session_url: null, diagnostic: code, retry_at: null })
    return { handled: false, reason: code }
  })
  const verifySession = (row, session) => {
    const params = new URLSearchParams(row.request_body)
    if (!session || session.object !== 'checkout.session' || !ID(session.id, 'cs') || (row.session_id && row.session_id !== session.id)
        || session.mode !== 'subscription' || !['open','complete','expired'].includes(session.status)
        || session.livemode !== row.account_scope.endsWith(':live') || session.metadata?.hosting_intent !== row.id
        || session.metadata?.purpose !== HOSTING_PURPOSE || session.metadata?.tenant_id !== String(row.tenant_id)
        || session.metadata?.plan !== row.plan || session.client_reference_id !== String(row.tenant_id)
        || session.success_url !== params.get('success_url') || session.cancel_url !== params.get('cancel_url')
        || session.allow_promotion_codes !== true) throw mismatch()
    const customer = ID(session.customer, 'cus')
    if ((row.expected_customer_id && customer !== row.expected_customer_id) || (session.status === 'complete' && !customer)) throw mismatch()
    const lines = session.line_items
    if (!Array.isArray(lines?.data)) throw unavailable()
    if (lines.has_more || lines.data.length !== 1) throw mismatch()
    const line = lines.data[0], price = line?.price, product = price?.product
    if (!product || typeof product !== 'object') throw unavailable()
    // Discounts affect amount_total legitimately. Verify the immutable base price instead.
    if (line.quantity !== 1 || price.currency !== row.currency || price.unit_amount !== row.amount_cents
        || price.recurring?.interval !== row.interval || (price.recurring?.interval_count ?? 1) !== 1
        || product.name !== params.get('line_items[0][price_data][product_data][name]')
        || product.metadata?.purpose !== HOSTING_PURPOSE || product.metadata?.plan !== row.plan) throw mismatch()
    if (!Number.isSafeInteger(session.expires_at) || session.expires_at <= 0) throw mismatch()
    if (session.status === 'open') {
      let url
      try { url = new URL(session.url) } catch { throw mismatch() }
      if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com' || url.port || url.username || url.password || session.url.length > 8192) throw mismatch()
    }
  }
  const subscription = async (client, id) => {
    const result = await client.retrieveSubscription(id)
    if (result?.object !== 'subscription' || ID(result.id, 'sub') !== id || !ID(result.customer, 'cus') || !SUB_STATUS.has(result.status)) throw unavailable()
    return result
  }
  const finish = async (row, token, client, session) => {
    const subscriptionId = ID(session.subscription, 'sub')
    if (!subscriptionId) return hold(row, token, 'missing_subscription', null, true)
    const snapshot = tenant(row.tenant_id)
    if (!snapshot) return { handled: false, reason: 'deleted_tenant' }
    const sub = await subscription(client, subscriptionId), customerId = ID(session.customer, 'cus')
    if (tenant(row.tenant_id)?.hosting_revision !== snapshot.hosting_revision) throw unavailable()
    if (ID(sub.customer, 'cus') !== customerId || sub.livemode !== row.account_scope.endsWith(':live') || sub.metadata?.hosting_intent !== row.id || sub.metadata?.purpose !== HOSTING_PURPOSE
        || sub.metadata?.tenant_id !== String(row.tenant_id) || sub.metadata?.plan !== row.plan) return hold(row, token, 'verification_failed', subscriptionId, true)
    if (row.state === 'complete' && snapshot.stripe_subscription_id !== row.subscription_id) return { handled: false, reason: 'old_completed_intent' }
    if ((snapshot.stripe_customer_id && snapshot.stripe_customer_id !== customerId)
        || db.prepare('SELECT id FROM tenants WHERE stripe_customer_id=? AND id<>?').get(customerId, row.tenant_id)) return hold(row, token, 'customer_mismatch', subscriptionId, true)
    if (snapshot.stripe_subscription_id !== subscriptionId) {
      if ((snapshot.stripe_subscription_id || null) !== row.expected_subscription_id || (snapshot.stripe_customer_id || null) !== row.expected_customer_id) return hold(row, token, 'binding_changed', subscriptionId, true)
      if (snapshot.stripe_subscription_id) {
        const previous = await subscription(client, snapshot.stripe_subscription_id)
        if (ID(previous.customer, 'cus') !== customerId || (previous.metadata?.tenant_id && previous.metadata.tenant_id !== String(row.tenant_id))
            || (previous.metadata?.purpose && previous.metadata.purpose !== HOSTING_PURPOSE)) return hold(row, token, 'customer_mismatch', subscriptionId, true)
        if (!TERMINAL_SUB.has(previous.status) || TERMINAL_SUB.has(sub.status)) return hold(row, token, 'existing_subscription', subscriptionId, true)
      }
    }
    return transaction(() => {
      owned(row.id, token)
      const current = tenant(row.tenant_id)
      if (!current || ['stripe_customer_id','stripe_subscription_id','subscription_status','plan_tier','hosting_revision'].some(key=>current[key] !== snapshot[key])) throw unavailable()
      if (db.prepare('SELECT id FROM tenants WHERE stripe_customer_id=? AND id<>?').get(customerId, row.tenant_id)) throw unavailable()
      const mapped = sub.status === 'trialing' ? 'active' : sub.status
      db.prepare('UPDATE tenants SET plan_tier=?,subscription_status=?,stripe_customer_id=?,stripe_subscription_id=?,plan=?,hosting_revision=hosting_revision+1 WHERE id=?')
        .run(row.plan, mapped, customerId, subscriptionId, mapped === 'active' ? 'paid' : (current.plan || 'trial'), row.tenant_id)
      update(row.id, token, { state: 'complete', subscription_id: subscriptionId, session_url: null, diagnostic: null, retry_at: null })
      return { handled: true, tenantId: row.tenant_id }
    })
  }
  const consume = async (row, token, client, session) => {
    verifySession(row, session)
    row = update(row.id, token, { session_id: session.id, expires_at: session.expires_at * 1000 })
    if (session.status === 'expired') {
      update(row.id, token, { state: 'expired', session_url: null, diagnostic: null, retry_at: null })
      return { handled: false, reason: 'expired' }
    }
    if (session.status === 'complete') return finish(row, token, client, session)
    if (!OPEN.includes(row.state) || row.resolved_at) throw mismatch()
    if (hasAnomaly(row.tenant_id)) return hold(row, token, 'verification_failed')
    const current = tenant(row.tenant_id)
    if (!current || (current.stripe_customer_id || null) !== row.expected_customer_id || (current.stripe_subscription_id || null) !== row.expected_subscription_id) return hold(row, token, 'binding_changed')
    update(row.id, token, { state: 'open', session_url: session.url, diagnostic: null, retry_at: null })
    return { handled: false, reason: 'open' }
  }
  const execute = async (intentId, client, scope, action, suppliedSessionId = null) => {
    const { row: initial, token } = claim(intentId)
    const initialRevision = tenant(initial.tenant_id)?.hosting_revision
    let row = initial
    try {
      if (row.account_scope !== scope) { hold(row, token, 'account_mismatch'); return status(row.tenant_id, token) }
      if (sha(row.request_body) !== row.request_digest) { hold(row, token, 'verification_failed'); return status(row.tenant_id, token) }
      if (row.retry_at > now()) throw safe('hosting_checkout_backoff', 'Wait briefly before checking this hosting checkout again.')
      let session, selectedId = suppliedSessionId || row.session_id
      if (selectedId) {
        if (!ID(selectedId, 'cs') || (row.session_id && row.session_id !== selectedId)) throw mismatch()
        session = await client.retrieveCheckout(selectedId)
      } else {
        if (action === 'expire') throw safe('hosting_checkout_unknown_session', 'Reconcile the saved checkout before attempting expiration.')
        if (hasAnomaly(row.tenant_id)) { hold(row, token, 'verification_failed'); return status(row.tenant_id, token) }
        if (row.first_attempt_at !== null && now() - row.first_attempt_at >= config.keyWindowMs) {
          hold(row, token, 'key_window_elapsed'); return status(row.tenant_id, token)
        }
        if (row.attempts >= config.maxAttempts) { hold(row, token, 'attempt_limit'); return status(row.tenant_id, token) }
        row = update(row.id, token, { state: 'creating', first_attempt_at: row.first_attempt_at ?? now(), attempts: row.attempts + 1, diagnostic: null })
        session = await client.createCheckout({ requestBody: row.request_body, idempotencyKey: row.idempotency_key })
      }
      verifySession(row, session)
      row = update(row.id, token, { session_id: session.id, expires_at: session.expires_at * 1000 })
      if (action === 'expire' && session.status === 'open') {
        try { await client.expireCheckout({ sessionId: session.id, idempotencyKey: `${row.idempotency_key}_expire` }) } catch { /* payment may have won; retrieve the actual state */ }
        session = await client.retrieveCheckout(session.id)
        if (session.status === 'open') {
          update(row.id, token, { state: 'unknown', session_url: null, diagnostic: 'provider_unavailable', retry_at: now() + 1000 })
          return status(row.tenant_id, token)
        }
      }
      if (tenant(row.tenant_id)?.hosting_revision !== initialRevision) throw unavailable()
      await consume(row, token, client, session)
      return status(row.tenant_id, token)
    } catch (error) {
      if (error?.hostingSafe && error.status !== 503) throw error
      try {
        row = owned(row.id, token)
        if (OPEN.includes(row.state)) update(row.id, token, { state: row.state === 'held' ? 'held' : 'unknown', session_url: null, diagnostic: 'provider_unavailable', retry_at: now() + Math.min(60000, 1000 * 2 ** Math.min(row.attempts, 6)) })
      } catch {}
      throw unavailable()
    } finally { release(row.id, token) }
  }
  const withTenantBillingOperation = (tenantId, callback, options = {}) => withHostingBillingOperation(db, tenantId, callback, { ...options, now })
  const start = options => bounded(() => withTenantBillingOperation(options?.tenantId, async assertActive => {
    const { tenantId, plan, interval = 'month', origin } = options || {}
    validTenant(tenantId)
    if (hasAnomaly(tenantId)) throw safe('hosting_checkout_review_required', 'A hosting payment needs server-operator review before another checkout can start.')
    const client = createClient(), scope = accountScope(await client.account())
    assertActive()
    const before = tenant(tenantId)
    if (before.stripe_subscription_id) {
      const previous = await subscription(client, before.stripe_subscription_id)
      assertActive()
      if (ID(previous.customer, 'cus') !== before.stripe_customer_id || (previous.metadata?.tenant_id && previous.metadata.tenant_id !== String(tenantId))
          || (previous.metadata?.purpose && previous.metadata.purpose !== HOSTING_PURPOSE)) throw mismatch()
      if (!TERMINAL_SUB.has(previous.status)) {
        transaction(() => {
          const current = tenant(tenantId)
          if (current?.hosting_revision !== before.hosting_revision) throw unavailable()
          if (current?.stripe_subscription_id === before.stripe_subscription_id && current?.stripe_customer_id === before.stripe_customer_id) {
            db.prepare('UPDATE tenants SET subscription_status=?,hosting_revision=hosting_revision+1 WHERE id=?').run(previous.status === 'trialing' ? 'active' : previous.status, tenantId)
          }
        })
        throw safe('hosting_subscription_exists', 'This shop already has hosting. Use Manage hosting to update it.')
      }
    }
    const row = transaction(() => {
      assertActive()
      assertNoHostingDeletion(db, tenantId, now)
      const current = tenant(tenantId), existing = unresolved(tenantId)
      if (hasAnomaly(tenantId)) throw safe('hosting_checkout_review_required', 'A hosting payment needs server-operator review before another checkout can start.')
      if (!current || current.hosting_revision !== before.hosting_revision || (current.stripe_customer_id || null) !== (before.stripe_customer_id || null) || (current.stripe_subscription_id || null) !== (before.stripe_subscription_id || null)) throw unavailable()
      if (current.stripe_subscription_id && !TERMINAL_SUB.has(current.subscription_status)) throw safe('hosting_subscription_exists', 'This shop already has hosting. Use Manage hosting to update it.')
      const id = existing?.id || crypto.randomUUID()
      const requestBody = buildRequest({ plan, interval, tenantId, intentId: id, origin, email: current.owner_email, customerId: current.stripe_customer_id })
      if (existing) {
        if (existing.request_body !== requestBody) throw safe('hosting_checkout_parameters_changed', 'A saved checkout uses different details. Reconcile or expire it before starting another.')
        return existing
      }
      if (db.prepare('SELECT count(*) AS n FROM hosting_checkout_intents WHERE tenant_id=?').get(tenantId).n >= config.maxTenantHistory
          || db.prepare('SELECT count(*) AS n FROM hosting_checkout_intents').get().n >= config.maxHistory) throw safe('hosting_checkout_history_full', 'Hosting checkout needs server-operator review before continuing.', 503)
      const params = new URLSearchParams(requestBody)
      db.prepare(`INSERT INTO hosting_checkout_intents(id,tenant_id,account_scope,request_body,request_digest,idempotency_key,expected_customer_id,expected_subscription_id,plan,interval,amount_cents,currency,state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?,?)`).run(id, tenantId, scope, requestBody, sha(requestBody), `psc_host_${crypto.randomUUID()}`, current.stripe_customer_id || null, current.stripe_subscription_id || null,
          plan, interval, Number(params.get('line_items[0][price_data][unit_amount]')), params.get('line_items[0][price_data][currency]'), now(), now())
      return get(id)
    })
    return execute(row.id, client, scope, 'start')
  }))
  const action = (options, kind) => bounded(() => withTenantBillingOperation(options?.tenantId, async assertActive => {
    const { tenantId, sessionId } = options || {}
    validTenant(tenantId)
    const row = unresolved(tenantId) || db.prepare('SELECT * FROM hosting_checkout_intents WHERE tenant_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(tenantId)
    if (!row || row.resolved_at) return status(tenantId)
    const client = createClient(), scope = accountScope(await client.account())
    assertActive()
    return execute(row.id, client, scope, kind, sessionId)
  }))
  const processCheckoutEvent = event => bounded(async () => {
    const object = event?.data?.object, intentId = object?.metadata?.hosting_intent
    if (event?.account || object?.metadata?.purpose !== HOSTING_PURPOSE || typeof intentId !== 'string' || !/^[a-f0-9-]{36}$/.test(intentId) || !ID(object.id, 'cs')) return { handled: false, reason: 'unrelated_checkout' }
    const row = get(intentId)
    if (row && !tenant(row.tenant_id)) return { handled: false, reason: 'deleted_tenant' }
    if (row?.resolved_at) return { handled: false, reason: 'closed_intent' }
    if (!row || object.metadata?.tenant_id !== String(row.tenant_id)) {
      // A signature is necessary but not a recorded checkout authorization. Verify the actual
      // provider object before preserving an unknown genuine hosting payment for operator review.
      const target = Number(object.metadata?.tenant_id)
      if (!Number.isSafeInteger(target) || !tenant(target)) return { handled: false, reason: 'unknown_intent' }
      return withTenantBillingOperation(target, async assertActive => {
      const client = createClient(), scope = accountScope(await client.account()), session = await client.retrieveCheckout(object.id)
      assertActive()
      if (session?.object === 'checkout.session' && session.id === object.id && session.mode === 'subscription' && session.livemode === scope.endsWith(':live')
          && session.status === 'complete' && session.metadata?.hosting_intent === intentId && session.metadata?.purpose === HOSTING_PURPOSE && session.metadata?.tenant_id === String(target) && ID(session.subscription, 'sub')) {
        const sub = await subscription(client, ID(session.subscription, 'sub'))
        assertActive()
        if (ID(sub.customer, 'cus') === ID(session.customer, 'cus') && sub.metadata?.hosting_intent === intentId && sub.metadata?.tenant_id === String(target) && sub.metadata?.purpose === HOSTING_PURPOSE) {
          transaction(() => recordAnomaly({ tenantId: target, intentId, scope, sessionId: session.id, subscriptionId: sub.id, code: 'unknown_intent' }))
          return { handled: false, reason: 'unknown_intent', verificationResolved: true }
        }
      }
      return { handled: false, reason: 'unknown_intent' }
      }, { verification: { session_id: object.id, subscription_id: ID(object.subscription,'sub'), customer_id: ID(object.customer,'cus'),
        intent_id: intentId, plan: object.metadata?.plan, purpose: object.metadata?.purpose } })
    }
    return withTenantBillingOperation(row.tenant_id, async assertActive => {
    const client = createClient(), scope = accountScope(await client.account())
    assertActive()
    if (!tenant(row.tenant_id)) return { handled: false, reason: 'deleted_tenant' }
    try { await execute(row.id, client, scope, 'reconcile', object.id) }
    catch (error) { if (!tenant(row.tenant_id)) return { handled: false, reason: 'deleted_tenant' }; throw error }
    const final = get(row.id)
    return final.state === 'complete' && tenant(row.tenant_id)?.stripe_subscription_id === final.subscription_id
      ? { handled: true, tenantId: row.tenant_id } : { handled: false, reason: final.diagnostic || final.state }
    })
  })
  // Authorization belongs to the platform-admin route. This operation only records a verified
  // resolution; it never cancels a subscription, refunds a charge or deletes financial history.
  const resolveAnomaly = options => bounded(async () => {
    const { tenantId, anomalyId, note } = options || {}
    validTenant(tenantId)
    if (typeof note !== 'string' || !note.trim() || note.length > 1000 || /[\0]/.test(note)) throw safe('hosting_checkout_resolution_note', 'Add a short note describing the operator review.', 400)
    const anomaly = db.prepare('SELECT * FROM hosting_checkout_anomalies WHERE id=? AND tenant_id=?').get(String(anomalyId || ''), tenantId)
    if (!anomaly) throw safe('hosting_checkout_anomaly_missing', 'That hosting review item was not found.', 404)
    if (anomaly.resolved_at) return status(tenantId)
    const client = createClient(), scope = accountScope(await client.account())
    const legacy = anomaly.account_scope === 'legacy-platform'
    if (!legacy && anomaly.account_scope !== scope) throw safe('hosting_checkout_account_mismatch', 'Connect the original Stripe account and mode before resolving this review item.')
    const legacyPurposeMatches = meta => meta?.purpose == null || meta.purpose === '' || meta.purpose === HOSTING_PURPOSE
    const snapshot = tenant(tenantId)
    let sub = null, session = null, evidence = null
    if (anomaly.session_id) {
      session = await client.retrieveCheckout(anomaly.session_id)
      if (session?.object !== 'checkout.session' || session.id !== anomaly.session_id || session.mode !== 'subscription'
          || session.livemode !== scope.endsWith(':live') || session.metadata?.tenant_id !== String(tenantId)
          || (legacy ? !legacyPurposeMatches(session.metadata) : session.metadata?.purpose !== HOSTING_PURPOSE)) throw mismatch()
      if (anomaly.intent_id && session.metadata?.hosting_intent !== anomaly.intent_id) throw mismatch()
      if (session.status === 'expired') evidence = { kind: 'expired_checkout', session_id: session.id, status: 'expired' }
    }
    const subscriptionId = anomaly.subscription_id || ID(session?.subscription, 'sub')
    if (subscriptionId) {
      sub = await subscription(client, subscriptionId)
      if (sub.livemode !== scope.endsWith(':live') || (session && ID(session.customer, 'cus') !== ID(sub.customer, 'cus'))
          || (sub.metadata?.tenant_id && sub.metadata.tenant_id !== String(tenantId))) throw mismatch()
      // Pre-purpose checkout receipts can only close after the same product/price identity
      // used to admit the original legacy payment is verified again on the exact subscription.
      if (legacy && (!session || ID(session.subscription, 'sub') !== sub.id || !legacyPurposeMatches(sub.metadata)
          || sub.metadata?.tenant_id !== String(tenantId) || typeof session.metadata?.plan !== 'string'
          || !Object.hasOwn(PLANS, session.metadata.plan) || sub.metadata?.plan !== session.metadata.plan
          || !legacyProductMatches(sub, session.metadata.plan))) throw mismatch()
      if (TERMINAL_SUB.has(sub.status)) evidence = { kind: 'ended_subscription', subscription_id: sub.id, customer_id: ID(sub.customer, 'cus'), status: sub.status }
      else if (snapshot.stripe_subscription_id === sub.id && snapshot.stripe_customer_id === ID(sub.customer, 'cus')) evidence = { kind: 'bound_subscription', subscription_id: sub.id, customer_id: ID(sub.customer, 'cus'), status: sub.status }
      else throw safe('hosting_checkout_payment_unresolved', 'The extra hosting subscription is still active. Review it in Stripe before resolving this item.')
    }
    if (legacy && !sub) throw mismatch()
    if (!evidence) throw safe('hosting_checkout_payment_unresolved', 'Stripe has not confirmed this checkout expired or its subscription ended.')
    const intent = anomaly.intent_id ? get(anomaly.intent_id) : null
    // A still-open local intent must itself be verified expired; resolving a different anomaly
    // cannot make a payable session disappear from the one-unresolved-intent constraint.
    const closesIntent = !!intent && intent.tenant_id === tenantId && intent.session_id === anomaly.session_id
      && OPEN.includes(intent.state) && ['expired_checkout','ended_subscription','bound_subscription'].includes(evidence.kind)
    if (closesIntent && intent.lease_token && intent.lease_until > now()) throw safe('hosting_checkout_busy', 'The checkout is being reconciled. Try resolving this review item shortly.', 503)
    transaction(() => {
      if (tenant(tenantId)?.hosting_revision !== snapshot.hosting_revision) throw unavailable()
      const currentIntent = intent && get(intent.id)
      if (closesIntent && (currentIntent.revision !== intent.revision || (currentIntent.lease_token && currentIntent.lease_until > now()))) throw unavailable()
      db.prepare('UPDATE hosting_checkout_anomalies SET resolved_at=?,resolution_note=?,resolution_evidence=? WHERE id=? AND resolved_at IS NULL')
        .run(now(), note.trim(), JSON.stringify({ ...evidence, account_scope: scope, verified_at: now() }), anomaly.id)
      if (closesIntent) db.prepare('UPDATE hosting_checkout_intents SET resolved_at=?,session_url=NULL,updated_at=?,revision=revision+1 WHERE id=?').run(now(), now(), intent.id)
    })
    return status(tenantId)
  })
  const reconcileVerification = async (options, processEvent) => {
    const prepared = await bounded(async () => {
    const {tenantId,verificationId} = options || {}
    validTenant(tenantId)
    if (typeof verificationId !== 'string' || verificationId.length !== 64 || !/^[a-f0-9]+$/.test(verificationId)) throw safe('hosting_verification_missing','That payment verification was not found.',404)
    const row = db.prepare('SELECT * FROM hosting_billing_verifications WHERE id=? AND tenant_id=?').get(verificationId,tenantId)
    if (!row) throw safe('hosting_verification_missing','That payment verification was not found.',404)
    if (row.state === 'cleared') return {status:status(tenantId)}
    if (typeof processEvent !== 'function') throw unavailable()
    let session
    const identity = JSON.parse(row.identity_json)
    await withTenantBillingOperation(tenantId,async assertActive=>{
      const client=createClient(), scope=accountScope(await client.account())
      assertActive()
      session=await client.retrieveCheckout(row.session_id)
      assertActive()
      if (session?.object!=='checkout.session' || session.id!==row.session_id || session.mode!=='subscription' || session.livemode!==scope.endsWith(':live')
          || session.metadata?.tenant_id!==String(tenantId) || (session.metadata?.purpose || null)!==identity.purpose
          || (identity.plan && session.metadata?.plan!==identity.plan) || (identity.intent_id && session.metadata?.hosting_intent!==identity.intent_id)
          || (identity.customer_id && ID(session.customer,'cus')!==identity.customer_id)
          || (identity.subscription_id && ID(session.subscription,'sub')!==identity.subscription_id)) throw mismatch()
      if (session.status==='expired' && !session.subscription && !identity.subscription_id) {
        if (typeof session.metadata?.plan!=='string' || !Object.hasOwn(PLANS,session.metadata.plan) || !legacyProductMatches({items:session.line_items},session.metadata.plan)) throw mismatch()
        transaction(()=>{
          assertActive()
          db.prepare("UPDATE hosting_billing_verifications SET state='cleared',cleared_at=? WHERE id=? AND identity_json=?").run(now(),row.id,row.identity_json)
        })
        session=null
      } else if (session.status!=='complete' || !ID(session.subscription,'sub')) throw mismatch()
    })
    return {session,tenantId}
    })
    if (prepared.status) return prepared.status
    // Release this read's budget before handing the same logical recovery to the processor.
    // The durable pending receipt still fences deletion/new checkout across that hand-off.
    if (prepared.session) await processEvent({type:'checkout.session.completed',data:{object:prepared.session}})
    return status(prepared.tenantId)
  }
  return Object.freeze({
    start, reconcile: options => action(options, 'reconcile'), expire: options => action(options, 'expire'), status, processCheckoutEvent, resolveAnomaly, reconcileVerification, withTenantBillingOperation,
    recordLegacyAnomaly({ tenantId, session, subscription, reason }) {
      transaction(() => recordAnomaly({ tenantId, sessionId: session?.id, subscriptionId: subscription?.id, code: reason }))
    },
    assertTenantDeletionAllowed(tenantId) {
      if (unresolved(tenantId) || db.prepare('SELECT 1 FROM hosting_checkout_anomalies WHERE tenant_id=? AND resolved_at IS NULL LIMIT 1').get(tenantId)
          || db.prepare('SELECT 1 FROM hosting_checkout_intents WHERE tenant_id=? AND lease_until>? AND lease_token IS NOT NULL LIMIT 1').get(tenantId, now())) throw safe('hosting_checkout_unresolved', 'Reconcile this shop’s hosting checkout before deleting the shop.')
    },
    health() {
      return { local_in_flight: localWork, leased: db.prepare('SELECT count(*) AS n FROM hosting_checkout_intents WHERE lease_until>? AND lease_token IS NOT NULL').get(now()).n,
        stranded: db.prepare("SELECT count(*) AS n FROM hosting_checkout_intents WHERE state IN ('creating','unknown','held') AND resolved_at IS NULL AND (lease_until IS NULL OR lease_until<=?)").get(now()).n,
        unresolved: db.prepare("SELECT count(*) AS n FROM hosting_checkout_intents WHERE state IN ('reserved','creating','unknown','open','held') AND resolved_at IS NULL").get().n,
        anomalies: db.prepare('SELECT count(*) AS n FROM hosting_checkout_anomalies WHERE resolved_at IS NULL').get().n }
    },
  })
}
