/**
 * Google Drive per-shop art storage — each shop connects its OWN Drive so we don't host infinite
 * storage. Uploaded art lands in the shop's Drive (under a "PrintShopCRM" root + a per-job
 * subfolder); we keep only the returned file id + share link in art_versions.
 *
 * This is ONE platform Google OAuth app that shops authorize (mirrors lib/quickbooks.mjs exactly).
 * Least-privilege scope: `drive.file` — the app only ever sees files IT creates, never the rest
 * of the shop's Drive.
 *
 * DESIGN CONTRACT (so this file stays pure and unit-testable — identical to quickbooks.mjs):
 *   - ALL network I/O goes through an injectable `fetch` param (defaults to global fetch).
 *   - Every base URL is overridable ({ apiBase, uploadBase, tokenUrl, authorizeBase }) so tests
 *     can point at a mock.
 *   - Every network call uses AbortSignal.timeout(20000) (uploads can be slow) and NEVER throws.
 *     It returns a plain result object: { ok, ...?, error?, status? }. A thrown fetch (DNS, abort,
 *     offline) is caught and returned as { ok:false, error } — callers branch on `.ok`, never
 *     try/catch.
 *   - A 401 comes back as { ok:false, status:401 }; the caller refreshes with `refreshToken()`
 *     (or the `withRefresh` helper) and retries. Nothing here mutates stored tokens — the app
 *     owns persistence via the GDRIVE_SETTING_KEYS below.
 *   - Google error JSON `{ error: { message } }` (or the OAuth `{ error_description }`) is parsed
 *     into `.error`.
 */

/** Settings keys the app must add to SETTING_DEFAULTS (+ the secret ones to SECRET_KEYS). */
export const GDRIVE_SETTING_KEYS = [
  'gdrive_client_id',      // OAuth app client id (the platform app)
  'gdrive_client_secret',  // SECRET — OAuth app client secret
  'gdrive_refresh_token',  // SECRET — long-lived, returned only on first consent
  'gdrive_access_token',   // SECRET — short-lived (~1 hour) bearer
  'gdrive_token_expires',  // epoch ms when the access token expires; refresh before this
  'gdrive_root_folder',    // cached Drive folder id of the shop's "PrintShopCRM" root
]

/** Of the above, these hold credentials and belong in SECRET_KEYS (redacted in publicSettings). */
export const GDRIVE_SECRET_KEYS = ['gdrive_client_secret', 'gdrive_refresh_token', 'gdrive_access_token']

/* ---------- endpoints ---------- */
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const DEFAULT_API_BASE = 'https://www.googleapis.com'            // files.list / files.get / permissions / about
const DEFAULT_UPLOAD_BASE = 'https://www.googleapis.com/upload'  // multipart file uploads
const SCOPE = 'https://www.googleapis.com/auth/drive.file'
const FOLDER_MIME = 'application/vnd.google-apps.folder'
const TIMEOUT_MS = 20000

/* ================= OAuth2 ================= */

/**
 * Build the Google consent URL to redirect the shop owner to. `state` is your CSRF token — the
 * app must generate it, stash it, and verify it on the callback.
 *
 * access_type=offline + prompt=consent guarantee a refresh token (Google only mints one on first
 * consent otherwise); include_granted_scopes keeps any previously-granted scopes.
 */
export function authorizeUrl({ clientId, redirectUri, state, scope = SCOPE, authorizeBase = AUTHORIZE_URL }) {
  const p = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    scope,
    redirect_uri: redirectUri,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  })
  return `${authorizeBase}?${p.toString()}`
}

/** POST to Google's token endpoint (form-encoded), shared by exchangeCode + refreshToken. */
async function tokenRequest({ body, fetch = globalThis.fetch, tokenUrl = TOKEN_URL, prevRefreshToken }) {
  try {
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
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
      // Google only returns a refresh token on first consent — preserve the stored one otherwise.
      refreshToken: data.refresh_token || prevRefreshToken,
      // expires_in is seconds; hand the caller an absolute epoch-ms deadline to store.
      expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
      data,
    }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}

/** Exchange an authorization `code` (from the OAuth callback) for tokens. Never throws. */
export async function exchangeCode({ clientId, clientSecret, code, redirectUri, fetch, tokenUrl }) {
  return tokenRequest({
    fetch, tokenUrl,
    body: { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret },
  })
}

/**
 * Trade the stored refresh token for a fresh access token. Google usually omits the refresh token
 * in the response — tokenRequest preserves the one passed in so callers can persist it unchanged.
 */
export async function refreshToken({ clientId, clientSecret, refreshToken, fetch, tokenUrl }) {
  return tokenRequest({
    fetch, tokenUrl, prevRefreshToken: refreshToken,
    body: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret },
  })
}

/* ================= Drive REST core ================= */

/**
 * One authenticated JSON call against the Drive API. Returns { ok, status, data?, error? }.
 * Never throws — a 401 surfaces as { ok:false, status:401 } for the caller to refresh + retry.
 */
async function driveRequest({ accessToken, method = 'GET', path, query, body, apiBase = DEFAULT_API_BASE, fetch = globalThis.fetch }) {
  try {
    let url = `${apiBase}${path}`
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
    // 204 (files.delete) has no body — guard the json() parse.
    const data = res.status === 204 ? {} : await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, status: res.status, error: data?.error?.message || data?.error_description || data?.error || `HTTP ${res.status}`, data }
    return { ok: true, status: res.status, data }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}

const escQ = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'") // escape for Drive query literals

/* ================= Folders ================= */

/**
 * Find-or-create a folder by name (optionally under `parentId`). Used to keep a "PrintShopCRM"
 * root folder and a per-job subfolder. Returns { ok, id, created? }.
 */
export async function ensureFolder({ accessToken, name, parentId, apiBase, fetch }) {
  const clauses = [
    `mimeType = '${FOLDER_MIME}'`,
    `name = '${escQ(name)}'`,
    'trashed = false',
    ...(parentId ? [`'${escQ(parentId)}' in parents`] : []),
  ]
  const found = await driveRequest({
    accessToken, apiBase, fetch, method: 'GET', path: '/drive/v3/files',
    query: { q: clauses.join(' and '), fields: 'files(id,name)', pageSize: '1', spaces: 'drive' },
  })
  if (!found.ok) return found
  const hit = found.data?.files?.[0]
  if (hit?.id) return { ok: true, id: hit.id, created: false }

  const created = await driveRequest({
    accessToken, apiBase, fetch, method: 'POST', path: '/drive/v3/files', query: { fields: 'id' },
    body: { name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}) },
  })
  if (!created.ok) return created
  return { ok: true, id: created.data?.id, created: true }
}

/* ================= Files ================= */

/**
 * Multipart upload of a file buffer into `folderId`. Returns { ok, id, webViewLink, webContentLink }.
 * A multipart request is a metadata JSON part + the raw file bytes in one POST.
 */
export async function uploadFile({ accessToken, name, mimeType, buffer, folderId, uploadBase = DEFAULT_UPLOAD_BASE, fetch = globalThis.fetch }) {
  try {
    const boundary = 'psc-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
    const metadata = { name, ...(folderId ? { parents: [folderId] } : {}) }
    const type = mimeType || 'application/octet-stream'
    const head = Buffer.from(
      `--${boundary}\r\n` +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) + '\r\n' +
      `--${boundary}\r\n` +
      `Content-Type: ${type}\r\n\r\n`,
    )
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
    const payload = Buffer.concat([head, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || ''), tail])

    const url = `${uploadBase}/drive/v3/files?uploadType=multipart&fields=id,webViewLink,webContentLink`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        Accept: 'application/json',
      },
      body: payload,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, status: res.status, error: data?.error?.message || `HTTP ${res.status}`, data }
    return { ok: true, id: data.id, webViewLink: data.webViewLink, webContentLink: data.webContentLink }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}

/**
 * Grant `{ role:'reader', type:'anyone' }` so a share link works — the customer-facing proof page
 * can render the image without the shop's Drive login. Returns { ok }.
 */
export async function makeAnyoneReader({ accessToken, fileId, apiBase, fetch }) {
  const r = await driveRequest({
    accessToken, apiBase, fetch, method: 'POST',
    path: `/drive/v3/files/${encodeURIComponent(fileId)}/permissions`, query: { fields: 'id' },
    body: { role: 'reader', type: 'anyone' },
  })
  if (!r.ok) return r
  return { ok: true }
}

/** files.get for the shareable links + thumbnail. Returns { ok, id, webViewLink, webContentLink, thumbnailLink }. */
export async function getFileLink({ accessToken, fileId, apiBase, fetch }) {
  const r = await driveRequest({
    accessToken, apiBase, fetch, method: 'GET',
    path: `/drive/v3/files/${encodeURIComponent(fileId)}`,
    query: { fields: 'id,webViewLink,webContentLink,thumbnailLink' },
  })
  if (!r.ok) return r
  return { ok: true, id: r.data?.id, webViewLink: r.data?.webViewLink, webContentLink: r.data?.webContentLink, thumbnailLink: r.data?.thumbnailLink }
}

/** files.delete (best-effort — Drive returns 204 on success). Returns { ok }. */
export async function deleteFile({ accessToken, fileId, apiBase, fetch }) {
  const r = await driveRequest({
    accessToken, apiBase, fetch, method: 'DELETE',
    path: `/drive/v3/files/${encodeURIComponent(fileId)}`,
  })
  if (!r.ok) return r
  return { ok: true }
}

/** about.get storageQuota so the UI can show how full the shop's Drive is. Returns { ok, limit, usage }. */
export async function storageQuota({ accessToken, apiBase, fetch }) {
  const r = await driveRequest({
    accessToken, apiBase, fetch, method: 'GET', path: '/drive/v3/about',
    query: { fields: 'storageQuota' },
  })
  if (!r.ok) return r
  const q = r.data?.storageQuota || {}
  return { ok: true, limit: q.limit, usage: q.usage }
}

/* ================= token-refresh helper ================= */

/**
 * Run a Drive operation, transparently refreshing the access token on a 401 and retrying once.
 *
 * `op(accessToken)` must be an async fn returning a { ok, status } result (any of the fns above
 * bound to the current token). `onRefresh(tokens)` lets the caller persist the refreshed
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
