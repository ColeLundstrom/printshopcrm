/** Provider reads precede a one-use, transactional authorization to remove a billed shop. */
import crypto from 'node:crypto'
import { createPlatformBillingClient, HOSTING_PURPOSE, PLANS } from './billing.mjs'
import { legacyProductMatches } from './platform-subscription-events.mjs'

const safe = (code, message, status = 409) => Object.assign(new Error(message), { code, status, expose: true, hostingSafe: true, retryable: status === 503 })
const busy = () => safe('hosting_deletion_busy', 'Hosting is being checked. Wait briefly and try again.', 503)
const review = () => safe('hosting_deletion_review', 'Reconcile this shop’s hosting payments before deleting it.')
const unavailable = () => safe('hosting_deletion_unavailable', 'Hosting could not be verified. The shop was kept. Try again shortly.', 503)
const changed = () => safe('hosting_deletion_changed', 'Hosting changed during the check. The shop was kept. Try again.')
const id = (value, prefix) => {
  const raw = value && typeof value === 'object' ? value.id : value
  return typeof raw === 'string' && !/\s/.test(raw) && new RegExp(`^${prefix}_[A-Za-z0-9_]{1,240}$`).test(raw) ? raw : null
}
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const terminal = new Set(['canceled', 'incomplete_expired'])
const purposeMatches = meta => meta?.purpose == null || meta.purpose === '' || meta.purpose === HOSTING_PURPOSE
const tx = (db, callback) => {
  db.exec('BEGIN IMMEDIATE')
  try { const value = callback(); db.exec('COMMIT'); return value }
  catch (error) { try { db.exec('ROLLBACK') } catch {}; throw error }
}

export function initHostingDeletion(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS hosting_tenant_deletions (
    tenant_id INTEGER PRIMARY KEY, slug TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('checking','failed','deleted')),
    lease_token TEXT, lease_until INTEGER, snapshot_digest TEXT,
    evidence_json TEXT CHECK(length(evidence_json)<=262144), verified_at INTEGER,
    deleted_at INTEGER, result_json TEXT CHECK(length(result_json)<=16384), diagnostic TEXT
  );
  CREATE TABLE IF NOT EXISTS hosting_billing_operations (
    token TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, lease_until INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS hosting_billing_operations_tenant ON hosting_billing_operations(tenant_id);
  CREATE TABLE IF NOT EXISTS hosting_billing_verifications (
    id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, session_id TEXT NOT NULL,
    identity_json TEXT NOT NULL CHECK(length(identity_json)<=8192),
    state TEXT NOT NULL CHECK(state IN ('pending','cleared')), created_at INTEGER NOT NULL, cleared_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS hosting_billing_verifications_tenant ON hosting_billing_verifications(tenant_id,state);`)
}

export function assertNoHostingDeletion(db, tenantId, now = Date.now) {
  const row = db.prepare('SELECT state,lease_until FROM hosting_tenant_deletions WHERE tenant_id=?').get(tenantId)
  if (row?.state === 'deleted' || (row?.state === 'checking' && row.lease_until > now())) throw busy()
}

/** Admission fence for already-received hosting events, including pre-intent legacy Checkout. */
export async function withHostingBillingOperation(db, tenantId, callback, { now = Date.now, leaseMs = 120000, maxConcurrent = 4, verification = null } = {}) {
  const token = crypto.randomUUID()
  let receiptId = null
  tx(db, () => {
    assertNoHostingDeletion(db, tenantId, now)
    if (!db.prepare('SELECT 1 FROM tenants WHERE id=?').get(tenantId)) throw busy()
    db.prepare('DELETE FROM hosting_billing_operations WHERE lease_until<=?').run(now())
    if (db.prepare('SELECT 1 FROM hosting_billing_operations WHERE tenant_id=?').get(tenantId)
        || db.prepare('SELECT count(*) AS n FROM hosting_billing_operations').get().n
          + db.prepare("SELECT count(*) AS n FROM hosting_tenant_deletions WHERE state='checking' AND lease_until>?").get(now()).n >= maxConcurrent) throw safe('hosting_checkout_busy', 'This hosting checkout is already being checked. Try again shortly.', 503)
    db.prepare('INSERT INTO hosting_billing_operations VALUES(?,?,?)').run(token, tenantId, now() + leaseMs)
    if (verification) {
      if (!id(verification.session_id, 'cs')) throw review()
      const identity = { session_id: verification.session_id, subscription_id: id(verification.subscription_id,'sub'),
        customer_id: id(verification.customer_id,'cus'), plan: typeof verification.plan === 'string' ? verification.plan.slice(0,100) : null,
        purpose: typeof verification.purpose === 'string' ? verification.purpose.slice(0,100) : null,
        intent_id: typeof verification.intent_id === 'string' ? verification.intent_id.slice(0,100) : null }
      receiptId = digest([tenantId, identity.session_id])
      const previous = db.prepare('SELECT identity_json FROM hosting_billing_verifications WHERE id=?').get(receiptId)
      if (previous && previous.identity_json !== JSON.stringify(identity)) throw review()
      if (!previous && (db.prepare('SELECT count(*) AS n FROM hosting_billing_verifications').get().n >= 100000
          || db.prepare('SELECT count(*) AS n FROM hosting_billing_verifications WHERE tenant_id=?').get(tenantId).n >= 500)) throw review()
      db.prepare(`INSERT INTO hosting_billing_verifications(id,tenant_id,session_id,identity_json,state,created_at)
        VALUES(?,?,?,?,'pending',?) ON CONFLICT(id) DO UPDATE SET state='pending',cleared_at=NULL`)
        .run(receiptId, tenantId, identity.session_id, JSON.stringify(identity), now())
    }
  })
  const assertActive = () => {
    if (!db.prepare('SELECT 1 FROM hosting_billing_operations WHERE token=? AND tenant_id=? AND lease_until>?').get(token, tenantId, now())) throw busy()
    assertNoHostingDeletion(db, tenantId, now)
  }
  try {
    const result = await callback(assertActive)
    if (receiptId) tx(db, () => {
      assertActive()
      // Returning an ignored result is not evidence that an admitted payment is harmless.
      // Only a committed binding, a recorded review, or an already-deleted identity closes it.
      if (result?.handled !== true && result?.verificationResolved !== true && db.prepare('SELECT 1 FROM tenants WHERE id=?').get(tenantId)) throw safe('hosting_checkout_unavailable','This received hosting payment could not be verified. Check it again shortly.',503)
      db.prepare("UPDATE hosting_billing_verifications SET state='cleared',cleared_at=? WHERE id=?").run(now(), receiptId)
    })
    return result
  }
  finally { db.prepare('DELETE FROM hosting_billing_operations WHERE token=?').run(token) }
}

export function createHostingDeletion(db, { checkouts, finalize, createClient = createPlatformBillingClient, now = Date.now, limits = {} } = {}) {
  initHostingDeletion(db)
  const config = { maxConcurrent: 4, leaseMs: 120000, budgetMs: 60000, maxReads: 24, maxHistory: 500, maxTombstones: 100000, ...limits }
  if (!checkouts || typeof finalize !== 'function' || Object.values(config).some(x => !Number.isSafeInteger(x) || x < 1)
      || config.leaseMs < 120000 || config.budgetMs > 60000 || config.maxConcurrent > 4 || config.maxReads > 32) throw new TypeError('Invalid hosting deletion configuration')
  const get = tenantId => db.prepare('SELECT * FROM hosting_tenant_deletions WHERE tenant_id=?').get(tenantId)
  const tenant = tenantId => db.prepare('SELECT * FROM tenants WHERE id=?').get(tenantId)
  const snapshot = tenantId => {
    const t = tenant(tenantId)
    if (!t) return null
    const intents = db.prepare(`SELECT id,account_scope,state,revision,request_digest,expected_customer_id,expected_subscription_id,
      plan,session_id,subscription_id,resolved_at FROM hosting_checkout_intents WHERE tenant_id=? ORDER BY id LIMIT ?`).all(tenantId, config.maxHistory + 1)
    const anomalies = db.prepare(`SELECT id,intent_id,account_scope,session_id,subscription_id,code,resolved_at,resolution_evidence,occurrences
      FROM hosting_checkout_anomalies WHERE tenant_id=? ORDER BY id LIMIT ?`).all(tenantId, config.maxHistory + 1)
    const verifications = db.prepare('SELECT id,session_id,identity_json,state,created_at,cleared_at FROM hosting_billing_verifications WHERE tenant_id=? ORDER BY id LIMIT ?').all(tenantId, config.maxHistory + 1)
    if (intents.length > config.maxHistory || anomalies.length > config.maxHistory || verifications.length > config.maxHistory) throw review()
    const billed = !!(t.stripe_customer_id || t.stripe_subscription_id || t.plan === 'paid'
      || intents.some(row => row.state === 'complete' || row.subscription_id || row.expected_subscription_id) || anomalies.length || verifications.some(row=>row.state==='pending'))
    const value = { tenant: { id: t.id, slug: t.slug, stripe_customer_id: t.stripe_customer_id, stripe_subscription_id: t.stripe_subscription_id,
      subscription_status: t.subscription_status, plan: t.plan, plan_tier: t.plan_tier, hosting_revision: t.hosting_revision }, intents, anomalies, verifications, billed }
    return { ...value, digest: digest(value) }
  }
  const blockers = tenantId => {
    try { checkouts.assertTenantDeletionAllowed(tenantId) }
    catch (error) { if (error?.hostingSafe) throw review(); throw error }
    if (db.prepare('SELECT 1 FROM hosting_billing_operations WHERE tenant_id=? AND lease_until>? LIMIT 1').get(tenantId, now())) throw busy()
  }
  const tombstone = tenantId => {
    const row = get(tenantId)
    return row?.state === 'deleted' && row.result_json ? JSON.parse(row.result_json) : null
  }
  const pendingResult = slug => ({ ok: true, slug, dataRemoved: false, path: '', error: 'The shop registry was removed. Its data cleanup outcome needs server-operator review.' })
  // Called only inside the same transaction which deletes registry rows. The public sync
  // function never receives the private token used by the async finalizer.
  const authorizeCommit = (tenantId, token = null, evidence = null) => {
    const snap = snapshot(tenantId)
    if (!snap) throw changed()
    blockers(tenantId)
    const row = get(tenantId)
    if (token) {
      if (!row || row.state !== 'checking' || row.lease_token !== token || row.lease_until <= now() || row.snapshot_digest !== snap.digest || !Array.isArray(evidence)) throw changed()
    } else {
      if (snap.billed) throw safe('hosting_deletion_verification_required', 'This shop has hosting history. Verify that its subscriptions ended before deleting it.')
      if (row?.state === 'checking' && row.lease_until > now()) throw busy()
    }
    if (!row && db.prepare('SELECT count(*) AS n FROM hosting_tenant_deletions').get().n >= config.maxTombstones) throw review()
    db.prepare(`INSERT INTO hosting_tenant_deletions(tenant_id,slug,state,snapshot_digest,evidence_json,verified_at,deleted_at,result_json)
      VALUES(?,?,'deleted',?,?,?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET state='deleted',lease_token=NULL,lease_until=NULL,
      snapshot_digest=excluded.snapshot_digest,evidence_json=excluded.evidence_json,verified_at=excluded.verified_at,
      deleted_at=excluded.deleted_at,result_json=excluded.result_json,diagnostic=NULL`)
      .run(tenantId, snap.tenant.slug, snap.digest, JSON.stringify(evidence || []), token ? now() : null, now(), JSON.stringify(pendingResult(snap.tenant.slug)))
    if (token) db.prepare("UPDATE hosting_billing_verifications SET state='cleared',cleared_at=? WHERE tenant_id=? AND state='pending'").run(now(), tenantId)
  }
  const recordResult = (tenantId, result) => {
    // Registry deletion is already committed. Never turn a later diagnostic write failure
    // into an error which claims that the shop was preserved.
    try { db.prepare("UPDATE hosting_tenant_deletions SET result_json=? WHERE tenant_id=? AND state='deleted'").run(JSON.stringify(result), tenantId) } catch {}
  }
  const remove = async tenantId => {
    if (!Number.isSafeInteger(tenantId) || tenantId < 1) return false
    if (!tenant(tenantId)) return tombstone(tenantId) || false
    const token = crypto.randomUUID()
    let snap
    try {
      snap = tx(db, () => {
        const s = snapshot(tenantId)
        if (!s) throw changed()
        blockers(tenantId)
        assertNoHostingDeletion(db, tenantId, now)
        if (!get(tenantId) && db.prepare('SELECT count(*) AS n FROM hosting_tenant_deletions').get().n >= config.maxTombstones) throw review()
        if (db.prepare("SELECT count(*) AS n FROM hosting_tenant_deletions WHERE state='checking' AND lease_until>?").get(now()).n
            + db.prepare('SELECT count(*) AS n FROM hosting_billing_operations WHERE lease_until>?').get(now()).n >= config.maxConcurrent) throw busy()
        db.prepare(`INSERT INTO hosting_tenant_deletions(tenant_id,slug,state,lease_token,lease_until,snapshot_digest)
          VALUES(?,?,'checking',?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET state='checking',lease_token=excluded.lease_token,
          lease_until=excluded.lease_until,snapshot_digest=excluded.snapshot_digest,evidence_json=NULL,verified_at=NULL,diagnostic=NULL`)
          .run(tenantId, s.tenant.slug, token, now() + config.leaseMs, s.digest)
        return s
      })
      const evidence = []
      if (snap.billed) {
        const started = performance.now(), deadline = now() + config.budgetMs
        let reads = 0
        const assertCurrent = () => {
          const row = get(tenantId)
          if (!row || row.state !== 'checking' || row.lease_token !== token || row.lease_until <= now()
              || now() > deadline || performance.now() - started > config.budgetMs) throw unavailable()
          if (snapshot(tenantId)?.digest !== snap.digest) throw changed()
        }
        const read = async callback => {
          assertCurrent()
          if (++reads > config.maxReads) throw review()
          const result = await callback()
          assertCurrent()
          return result
        }
        const client = createClient(), account = await read(() => client.account())
        if (!id(account?.accountId, 'acct') || typeof account.livemode !== 'boolean') throw unavailable()
        const scope = `${account.accountId}:${account.livemode ? 'live' : 'test'}`
        const customer = id(snap.tenant.stripe_customer_id, 'cus')
        if (snap.tenant.stripe_customer_id && !customer) throw review()
        if (snap.tenant.stripe_subscription_id && !customer) throw review()
        const liabilities = new Map()
        const add = (subscriptionId, expectedCustomer, reference = null) => {
          if (!id(subscriptionId, 'sub')) throw review()
          if (!id(expectedCustomer,'cus') || (customer && expectedCustomer !== customer)) throw review()
          if (!liabilities.has(subscriptionId)) liabilities.set(subscriptionId, { customer: expectedCustomer, references: [] })
          const liability = liabilities.get(subscriptionId)
          if (liability.customer !== expectedCustomer) throw review()
          if (reference) liability.references.push(reference)
          if (liabilities.size > config.maxReads - 1) throw review()
        }
        const checkedSessions = new Map()
        const verifyRecordedSession = async row => {
          if (!id(row.session_id,'cs')) throw review()
          let session = checkedSessions.get(row.session_id)
          if (!session) { session = await read(() => client.retrieveCheckout(row.session_id)); checkedSessions.set(row.session_id,session) }
          if (session?.object !== 'checkout.session' || session.id !== row.session_id || session.mode !== 'subscription'
              || session.livemode !== account.livemode || !purposeMatches(session.metadata) || session.metadata?.tenant_id !== String(tenantId)
              || typeof session.metadata?.plan !== 'string' || !Object.hasOwn(PLANS,session.metadata.plan)
              || (row.plan && session.metadata.plan !== row.plan)
              || (row.intent_id && (session.metadata?.hosting_intent !== row.intent_id || session.metadata?.purpose !== HOSTING_PURPOSE))) throw review()
          const expectedCustomer = id(session.customer,'cus'), actualSub = id(session.subscription,'sub')
          if ((customer && expectedCustomer !== customer) || (row.customer_id && expectedCustomer !== row.customer_id)
              || (row.subscription_id && actualSub !== row.subscription_id)) throw review()
          if (actualSub) {
            if (session.status !== 'complete') throw review()
            add(actualSub, expectedCustomer, row.modern || null)
          } else {
            if (session.status !== 'expired' || row.subscription_id || !legacyProductMatches({items:session.line_items},session.metadata.plan)) throw review()
            evidence.push({session_id:session.id,account_scope:scope,status:'expired',verified_at:now()})
          }
          return expectedCustomer
        }
        if (snap.tenant.stripe_subscription_id) add(snap.tenant.stripe_subscription_id, customer)
        for (const row of snap.intents) {
          if (row.state === 'complete' && !row.subscription_id) throw review()
          if (row.subscription_id || row.expected_subscription_id) {
            if (row.account_scope !== scope || (customer && row.expected_customer_id && row.expected_customer_id !== customer)) throw review()
            let expectedCustomer = row.expected_customer_id || customer
            if (!expectedCustomer) expectedCustomer = await verifyRecordedSession({ ...row, intent_id:row.id, modern:row })
            if (row.subscription_id) add(row.subscription_id, expectedCustomer, row)
            if (row.expected_subscription_id) add(row.expected_subscription_id, expectedCustomer)
          }
        }
        for (const row of snap.anomalies) {
          if (!row.resolved_at) throw review()
          if (row.account_scope !== 'legacy-platform' && row.account_scope !== scope) throw review()
          await verifyRecordedSession(row)
        }
        for (const row of snap.verifications.filter(row=>row.state==='pending')) await verifyRecordedSession(JSON.parse(row.identity_json))
        if (!liabilities.size && !evidence.length) throw review()
        for (const [subscriptionId, liability] of liabilities) {
          const { references, customer: expectedCustomer } = liability
          const sub = await read(() => client.retrieveSubscription(subscriptionId))
          if (sub?.object !== 'subscription' || id(sub.id, 'sub') !== subscriptionId || id(sub.customer, 'cus') !== expectedCustomer
              || sub.livemode !== account.livemode || sub.metadata?.tenant_id !== String(tenantId) || !purposeMatches(sub.metadata)
              || typeof sub.metadata?.plan !== 'string' || !Object.hasOwn(PLANS, sub.metadata.plan)) throw review()
          const modern = references.length ? references : snap.intents.filter(row => row.id === sub.metadata?.hosting_intent && row.subscription_id === subscriptionId)
          if (modern.length) {
            if (modern.some(row => sub.metadata.purpose !== HOSTING_PURPOSE || sub.metadata.hosting_intent !== row.id || sub.metadata.plan !== row.plan)) throw review()
          } else if (!legacyProductMatches(sub, sub.metadata.plan)) throw review()
          if (!terminal.has(sub.status)) throw safe('hosting_deletion_active', 'Hosting is still active at Stripe. End the subscription in Manage hosting or Stripe, then try deleting the shop again.')
          evidence.push({ subscription_id: subscriptionId, customer_id: expectedCustomer, account_scope: scope, status: sub.status, plan: sub.metadata.plan, verified_at: now() })
        }
        assertCurrent()
      }
      return finalize(tenantId, token, evidence)
    } catch (error) {
      if (!tenant(tenantId)) return tombstone(tenantId) || false
      try { db.prepare("UPDATE hosting_tenant_deletions SET state='failed',lease_token=NULL,lease_until=NULL,diagnostic=? WHERE tenant_id=? AND lease_token=? AND state='checking'").run(error?.hostingSafe ? error.code : 'hosting_deletion_unavailable', tenantId, token) } catch {}
      if (error?.code === 'import_in_progress' || error?.hostingSafe) throw error
      throw unavailable()
    }
  }
  return Object.freeze({ remove, authorizeCommit, recordResult, tombstone })
}
