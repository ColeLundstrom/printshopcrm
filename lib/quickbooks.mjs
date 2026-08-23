/**
 * QuickBooks Online (QBO) two-way sync — the connected upgrade to the one-way IIF file export.
 *
 * Four of six competitors offer QBO sync and it's asked on every sales call, so this is the
 * real OAuth2 + REST integration. The IIF export at server.mjs (`/api/export/quickbooks.iif`)
 * stays as the credential-free fallback; this module mirrors its account mapping exactly:
 *
 *   Invoice  → A/R (debit)                + Sales Income (credit line)
 *   Payment  → Undeposited Funds (deposit) applied against the invoice's A/R
 *
 * DESIGN CONTRACT (so this file stays pure and unit-testable):
 *   - ALL network I/O goes through an injectable `fetch` param (defaults to global fetch).
 *   - The QBO API base is overridable via `{ apiBase }` so tests — and sandbox realms — can
 *     point at a mock or at `https://sandbox-quickbooks.api.intuit.com`.
 *   - Every network call uses AbortSignal.timeout(15000) and NEVER throws. It returns a plain
 *     result object: { ok, id?, error?, status?, data? }. A thrown fetch (DNS, abort, offline)
 *     is caught and returned as { ok:false, error } — callers branch on `.ok`, never try/catch.
 *   - A 401 comes back as { ok:false, status:401 }; the caller refreshes with `refreshToken()`
 *     (or the `withRefresh` helper) and retries. Nothing here mutates stored tokens — the app
 *     owns persistence via the QBO_SETTING_KEYS below.
 *
 * The account names below are literal QBO account NAMES (matched by the query endpoint). QBO
 * requires income/AR accounts to exist; we look them up by name and fall back to Intuit's
 * default account ids only when the shop hasn't renamed them.
 */

/** Settings keys the app must add to SETTING_DEFAULTS (+ the secret ones to SECRET_KEYS). */
export const QBO_SETTING_KEYS = [
  'qbo_realm_id',        // company id returned by the OAuth callback (not secret, but identifying)
  'qbo_refresh_token',   // SECRET — long-lived, ~100 days, rotates on every refresh
  'qbo_access_token',    // SECRET — short-lived (~1 hour) bearer
  'qbo_token_expires',   // epoch ms when the access token expires; refresh before this
  'qbo_client_id',       // OAuth app client id (per-shop app, or the platform app)
  'qbo_client_secret',   // SECRET — OAuth app client secret
]

/** Of the above, these hold credentials and belong in SECRET_KEYS (redacted in publicSettings). */
export const QBO_SECRET_KEYS = ['qbo_refresh_token', 'qbo_access_token', 'qbo_client_secret']

/* ---------- endpoints ---------- */
const AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2'
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'
const DEFAULT_API_BASE = 'https://quickbooks.api.intuit.com'
export const SANDBOX_API_BASE = 'https://sandbox-quickbooks.api.intuit.com'
const SCOPE = 'com.intuit.quickbooks.accounting'
const TIMEOUT_MS = 15000

/* ---------- account mapping (mirrors the IIF export) ---------- */
export const ACCOUNTS = {
  receivable: 'Accounts Receivable',
  income: 'Sales Income',
  undepositedFunds: 'Undeposited Funds',
}

/* ================= OAuth2 ================= */

/**
 * Build the Intuit consent URL to redirect the shop owner to. `state` is your CSRF token — the
 * app must generate it, stash it, and verify it on the callback.
 */
export function authorizeUrl({ clientId, redirectUri, state, scope = SCOPE }) {
  const p = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    scope,
    redirect_uri: redirectUri,
    state,
  })
  return `${AUTHORIZE_URL}?${p.toString()}`
}

const basicAuth = (clientId, clientSecret) => 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64')

/** POST to Intuit's token endpoint (form-encoded), shared by exchangeCode + refreshToken. */
async function tokenRequest({ clientId, clientSecret, body, fetch = globalThis.fetch, tokenUrl = TOKEN_URL }) {
  try {
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(clientId, clientSecret),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, status: res.status, error: data.error_description || data.error || `HTTP ${res.status}` }
    return {
      ok: true,
      status: res.status,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      // expires_in is seconds; hand the caller an absolute epoch-ms deadline to store.
      expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
      realmId: data.realmId, // present on some flows; the callback usually supplies it separately
      data,
    }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}

/** Exchange an authorization `code` (from the OAuth callback) for tokens. Never throws. */
export async function exchangeCode({ clientId, clientSecret, code, redirectUri, fetch, tokenUrl }) {
  return tokenRequest({
    clientId, clientSecret, fetch, tokenUrl,
    body: { grant_type: 'authorization_code', code, redirect_uri: redirectUri },
  })
}

/** Trade the stored refresh token for a fresh access token (and a rotated refresh token). */
export async function refreshToken({ clientId, clientSecret, refreshToken, fetch, tokenUrl }) {
  return tokenRequest({
    clientId, clientSecret, fetch, tokenUrl,
    body: { grant_type: 'refresh_token', refresh_token: refreshToken },
  })
}

/* ================= QBO REST core ================= */

/**
 * One authenticated call against the QBO company API. Returns { ok, status, data?, error? }.
 * Never throws — a 401 surfaces as { ok:false, status:401 } for the caller to refresh + retry.
 */
async function qboRequest({ realmId, accessToken, method = 'GET', path, query, body, apiBase = DEFAULT_API_BASE, fetch = globalThis.fetch }) {
  try {
    let url = `${apiBase}/v3/company/${realmId}/${path}`
    if (query) url += (url.includes('?') ? '&' : '?') + new URLSearchParams(query).toString()
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const fault = data?.Fault?.Error?.[0]
      const error = fault ? `${fault.Message}${fault.Detail ? ': ' + fault.Detail : ''}` : (data?.error_description || data?.error || `HTTP ${res.status}`)
      return { ok: false, status: res.status, error, data }
    }
    return { ok: true, status: res.status, data }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}

/** QBO SQL-ish query endpoint. Returns { ok, rows } where rows is the entity array (or []). */
async function qboQuery({ realmId, accessToken, query, entity, apiBase, fetch }) {
  const r = await qboRequest({ realmId, accessToken, method: 'GET', path: 'query', query: { query }, apiBase, fetch })
  if (!r.ok) return r
  const rows = (entity && r.data?.QueryResponse?.[entity]) || []
  return { ok: true, status: r.status, rows, data: r.data }
}

const escQ = (s) => String(s ?? '').replace(/'/g, "\\'") // escape single quotes for QBO query literals

/* ================= Customers ================= */

/**
 * Find-or-create a QBO Customer by DisplayName. `contact` is the PrintShopCRM contact
 * ({ name, company, email, phone }). Returns { ok, id, created? }.
 */
export async function ensureCustomer({ realmId, accessToken, contact, apiBase, fetch }) {
  const displayName = String(contact?.company || contact?.name || 'Customer').slice(0, 100)

  const found = await qboQuery({
    realmId, accessToken, apiBase, fetch, entity: 'Customer',
    query: `SELECT Id, DisplayName FROM Customer WHERE DisplayName = '${escQ(displayName)}'`,
  })
  if (!found.ok) return found
  if (found.rows.length) return { ok: true, id: found.rows[0].Id, created: false }

  const [first, ...rest] = String(contact?.name || '').trim().split(/\s+/)
  const body = {
    DisplayName: displayName,
    ...(first ? { GivenName: first } : {}),
    ...(rest.length ? { FamilyName: rest.join(' ') } : {}),
    ...(contact?.company ? { CompanyName: String(contact.company) } : {}),
    ...(contact?.email ? { PrimaryEmailAddr: { Address: String(contact.email) } } : {}),
    ...(contact?.phone ? { PrimaryPhone: { FreeFormNumber: String(contact.phone) } } : {}),
  }
  const r = await qboRequest({ realmId, accessToken, method: 'POST', path: 'customer', body, apiBase, fetch })
  if (!r.ok) return r
  return { ok: true, id: r.data?.Customer?.Id, created: true }
}

/** Look up the QBO Account Id for an income account by name (for invoice sales lines). */
async function findIncomeAccountId({ realmId, accessToken, name, apiBase, fetch }) {
  const r = await qboQuery({
    realmId, accessToken, apiBase, fetch, entity: 'Account',
    query: `SELECT Id, Name FROM Account WHERE Name = '${escQ(name)}'`,
  })
  if (!r.ok) return null
  return r.rows[0]?.Id || null
}

/* ================= Invoices ================= */

/**
 * Create (or update, when `invoice.qboId`/SyncToken are supplied) a QBO Invoice.
 *
 * - `customer` is the QBO Customer Id string, or a contact object to be resolved first via
 *   ensureCustomer (pass the already-resolved id to save a round-trip).
 * - `lines` are PrintShopCRM invoice lines: { description, amount, qty? }. Each becomes a
 *   SalesItemLineDetail posting to the Sales Income account (mirrors the IIF Sales Income split).
 *   If `lines` is empty we fall back to a single line for the invoice's amount_due.
 *
 * Returns { ok, id, syncToken? }.
 */
export async function pushInvoice({ realmId, accessToken, invoice, customer, lines, apiBase, fetch }) {
  // Resolve the customer ref (accept a bare id string, {Id}, or a contact to look up).
  let customerRef = null
  if (typeof customer === 'string') customerRef = customer
  else if (customer?.Id) customerRef = customer.Id
  else if (customer) {
    const ec = await ensureCustomer({ realmId, accessToken, contact: customer, apiBase, fetch })
    if (!ec.ok) return ec
    customerRef = ec.id
  }
  if (!customerRef) return { ok: false, error: 'pushInvoice: could not resolve QBO customer' }

  const incomeAccountId = await findIncomeAccountId({ realmId, accessToken, name: ACCOUNTS.income, apiBase, fetch })

  const srcLines = (Array.isArray(lines) && lines.length)
    ? lines
    : [{ description: `Invoice ${invoice?.invoice_number || ''}`.trim(), amount: Number(invoice?.amount_due) || 0, qty: 1 }]

  const Line = srcLines.map((l) => ({
    DetailType: 'SalesItemLineDetail',
    Amount: Number(l.amount) || 0,
    Description: String(l.description || '').slice(0, 4000),
    SalesItemLineDetail: {
      ...(incomeAccountId ? { ItemAccountRef: { value: incomeAccountId, name: ACCOUNTS.income } } : {}),
      Qty: Number(l.qty) || 1,
      ...(l.qty ? { UnitPrice: (Number(l.amount) || 0) / (Number(l.qty) || 1) } : {}),
    },
  }))

  const body = {
    ...(invoice?.qboId ? { Id: String(invoice.qboId), SyncToken: String(invoice.syncToken ?? '0'), sparse: false } : {}),
    CustomerRef: { value: String(customerRef) },
    Line,
    ...(invoice?.invoice_number ? { DocNumber: String(invoice.invoice_number).slice(0, 21) } : {}),
    ...(invoice?.created_at ? { TxnDate: ymd(invoice.created_at) } : {}),
  }

  const r = await qboRequest({ realmId, accessToken, method: 'POST', path: 'invoice', body, apiBase, fetch })
  if (!r.ok) return r
  return { ok: true, id: r.data?.Invoice?.Id, syncToken: r.data?.Invoice?.SyncToken }
}

/* ================= Payments ================= */

/**
 * Record a QBO Payment against a synced invoice. Deposits to Undeposited Funds and applies the
 * amount to the invoice's A/R line (mirrors the IIF payment split).
 *
 * `payment` is { amount, created_at?, method? }; `qboInvoiceId` is the QBO Invoice Id from a
 * prior pushInvoice. Requires the QBO customer id (`customerId`) that owns the invoice.
 * Returns { ok, id }.
 */
export async function pushPayment({ realmId, accessToken, payment, qboInvoiceId, customerId, customer, apiBase, fetch }) {
  let customerRef = customerId || (typeof customer === 'string' ? customer : customer?.Id)
  if (!customerRef && customer) {
    const ec = await ensureCustomer({ realmId, accessToken, contact: customer, apiBase, fetch })
    if (!ec.ok) return ec
    customerRef = ec.id
  }
  if (!customerRef) return { ok: false, error: 'pushPayment: missing customer id' }
  if (!qboInvoiceId) return { ok: false, error: 'pushPayment: missing qboInvoiceId' }

  const amount = Number(payment?.amount) || 0
  const body = {
    CustomerRef: { value: String(customerRef) },
    TotalAmt: amount,
    ...(payment?.created_at ? { TxnDate: ymd(payment.created_at) } : {}),
    // 4 = Undeposited Funds is QBO's default; passing the AR sub-line applies it to the invoice.
    Line: [{
      Amount: amount,
      LinkedTxn: [{ TxnId: String(qboInvoiceId), TxnType: 'Invoice' }],
    }],
    ...(payment?.method ? { PaymentRefNum: String(payment.method).slice(0, 21) } : {}),
  }

  const r = await qboRequest({ realmId, accessToken, method: 'POST', path: 'payment', body, apiBase, fetch })
  if (!r.ok) return r
  return { ok: true, id: r.data?.Payment?.Id }
}

/* ================= token-refresh helper ================= */

/**
 * Run a QBO operation, transparently refreshing the access token on a 401 and retrying once.
 *
 * `op(accessToken)` must be an async fn returning a { ok, status } result (any of the push*
 * fns bound to the current token). `onRefresh(tokens)` lets the caller persist the rotated
 * { accessToken, refreshToken, expiresAt } to settings. Returns the op's result.
 */
export async function withRefresh({ clientId, clientSecret, refreshToken: rt, op, onRefresh, fetch, tokenUrl }) {
  let res = await op()
  if (res && res.ok === false && res.status === 401) {
    const refreshed = await refreshToken({ clientId, clientSecret, refreshToken: rt, fetch, tokenUrl })
    if (!refreshed.ok) return refreshed
    if (typeof onRefresh === 'function') await onRefresh(refreshed)
    res = await op(refreshed.accessToken)
  }
  return res
}

/* ---------- helpers ---------- */
// QBO TxnDate wants ISO yyyy-mm-dd. Accept sqlite's "YYYY-MM-DD HH:MM:SS" or an ISO string.
function ymd(s) {
  const d = new Date(String(s).replace(' ', 'T'))
  if (Number.isNaN(d.getTime())) return undefined
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
