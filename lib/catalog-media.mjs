/**
 * Exact S&S SKU photos, with no style search, generic image or color substitution.
 * Provider contract: https://api.ssactivewear.com/V2/Products.aspx (checked 2026-09-04).
 * The published color image paths use www.ssactivewear.com; S&S's own product pages
 * also link cdn.ssactivewear.com. Neither host is a configurable proxy destination.
 * Only metadata is cached. Image bytes are bounded per request and never retained.
 */
import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import https from 'node:https'
import net from 'node:net'
import { pinnedLookupFor } from './webhook.mjs'
import { readRasterHeader, MOCKUP_LIMITS } from '../public/js/shared/raster-header.js'

export const CATALOG_MEDIA_LIMITS = Object.freeze({
  jsonBytes: 512 * 1024, mediaBytes: 10 * 1024 * 1024, timeoutMs: 12000,
  concurrency: 4, tenantConcurrency: 2, handles: 256, tenantHandles: 32,
  handleBytes: 512 * 1024, tenantHandleBytes: 64 * 1024,
  handleTtlMs: 10 * 60 * 1000, ticketTtlMs: 60 * 60 * 1000,
})
const VIEWS = Object.freeze([
  ['front','Front','colorFrontImage'], ['back','Back','colorBackImage'],
  ['side','Side','colorSideImage'], ['direct_side','Direct side','colorDirectSideImage'],
  ['model_front','On model — front','colorOnModelFrontImage'],
  ['model_back','On model — back','colorOnModelBackImage'],
  ['model_side','On model — side','colorOnModelSideImage'],
])
const MEDIA_HOSTS = new Set(['www.ssactivewear.com','cdn.ssactivewear.com'])
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status, expose:true, catalogSafe:true })
const scopeOf = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\x00-\x1f]/.test(value)) throw fail('catalog_scope_required','A shop is required for catalog media.')
  return value
}
export function normalizeCatalogSku(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.trim())) throw fail('catalog_exact_sku_required','Enter one exact S&S SKU, including its color and size. Style searches are not supported here.')
  return value.trim().toUpperCase()
}

// Only globally routable address ranges. This deliberately rejects special-use IPv6
// transition/mapped ranges rather than attempting to reach their embedded IPv4 target.
export function isPublicCatalogAddress(address) {
  const family = net.isIP(address)
  if (family === 4) {
    const [a,b,c] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113))
  }
  if (family !== 6) return false
  const [a,b] = address.split(':').map(x => parseInt(x || '0',16))
  return a >= 0x2000 && a <= 0x3fff && !(a === 0x2001 && (b < 0x200 || b === 0xdb8)) && a !== 0x2002 && !(a === 0x3fff && b < 0x1000)
}

export function catalogMediaUrl(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 1024 || /[\s\\%]/.test(raw)) throw fail('catalog_media_url_invalid','S&S returned an unsupported photo URL.',502)
  let url
  try { url = new URL(raw, 'https://www.ssactivewear.com/') } catch { throw fail('catalog_media_url_invalid','S&S returned an unsupported photo URL.',502) }
  if (url.protocol !== 'https:' || !MEDIA_HOSTS.has(url.hostname) || url.username || url.password || url.port || url.search || url.hash ||
    !/^\/Images\/(?:Color|ModelColor)\/[A-Za-z0-9_.-]+\.(?:jpe?g|png|webp)$/i.test(url.pathname) || /(?:^|\/)\.\.(?:\/|$)/.test(raw)) {
    throw fail('catalog_media_url_invalid','S&S returned an unsupported photo URL. Upload the exact product photo manually instead.',502)
  }
  return url.href
}

/** Injectable low-level transport. It receives a checked URL and a pinned lookup.
 * Return {status, headers, body}; body is bytes or an async iterable of byte chunks.
 * Tests inject fixtures here; no account credentials or external sockets are needed.
 */
export function catalogHttpsTransport({url, headers, lookup, signal}) {
  return new Promise((resolve,reject) => {
    const req = https.request(url, {method:'GET',headers,lookup,signal,agent:false,maxHeaderSize:16 * 1024}, res => {
      resolve({status:res.statusCode,headers:res.headers,body:res})
    })
    req.once('error',reject)
    req.end()
  })
}
const header = (headers,key) => String(headers?.get?.(key) ?? headers?.[key] ?? Object.entries(headers || {}).find(([k]) => k.toLowerCase() === key)?.[1] ?? '')
function rasterMime(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png'
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (bytes.length >= 16 && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') return 'image/webp'
  throw fail('catalog_media_format','S&S did not return a PNG, JPEG or WebP photo.',502)
}

/**
 * No implicit/global tenant or supplier credentials. Supply a durable server signing
 * secret (at least 32 bytes); rotating it intentionally invalidates outstanding tickets.
 * Fixture overrides can lower, but cannot raise, any production resource bound.
 */
export function createCatalogMedia({secret,transport=catalogHttpsTransport,resolver=dns,now=Date.now,limits={}} = {}) {
  if (!(typeof secret === 'string' || Buffer.isBuffer(secret)) || Buffer.byteLength(secret) < 32) throw new Error('Catalog media requires a server signing secret of at least 32 bytes')
  const key = Buffer.from(secret)
  const bound = Object.fromEntries(Object.entries(CATALOG_MEDIA_LIMITS).map(([name,max]) => {
    const value = limits[name] ?? max
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid catalog media limit: ${name}`)
    return [name,value]
  }))
  const handles = new Map(), inflight = new Map()
  let active = 0
  function prune() { for (const [id,h] of handles) if (h.expires_at <= now()) handles.delete(id) }
  function usage(tenant) {
    prune()
    let bytes=0, tenantBytes=0, count=0
    for (const h of handles.values()) { bytes += h.charge; if (h.tenant === tenant) { count++; tenantBytes += h.charge } }
    return {handles:handles.size,bytes,tenantHandles:count,tenantBytes,active,tenantActive:inflight.get(tenant) || 0}
  }
  async function request(tenant,url,headers,maxBytes) {
    if (active >= bound.concurrency || (inflight.get(tenant) || 0) >= bound.tenantConcurrency) throw fail('catalog_busy','Catalog photos are busy. Try again shortly.',429)
    active++; inflight.set(tenant,(inflight.get(tenant) || 0)+1)
    const controller = new AbortController()
    let timer, response
    const deadline = new Promise((_,reject) => { timer = setTimeout(() => {
      const error = fail('catalog_timeout','S&S took too long to respond. Try again or upload a product photo.',504)
      controller.abort(error); response?.body?.destroy?.(); reject(error)
    },bound.timeoutMs) })
    const operation = (async () => {
      const parsed = new URL(url)
      const resolved = await resolver.lookup(parsed.hostname,{all:true})
      if (controller.signal.aborted) throw controller.signal.reason
      if (!Array.isArray(resolved) || !resolved.length || resolved.length > 16 || resolved.some(row => !isPublicCatalogAddress(row.address))) throw fail('catalog_media_address','The supplier host did not resolve to a public address.',502)
      response = await transport({url,headers,lookup:pinnedLookupFor(resolved[0].address),signal:controller.signal,maxBytes,timeoutMs:bound.timeoutMs})
      if (controller.signal.aborted) { response?.body?.destroy?.(); throw controller.signal.reason }
      const status = Number(response.status)
      if (status >= 300 && status < 400) throw fail('catalog_redirect_refused','S&S redirected this request. Redirected photos are not supported; upload a product photo manually.',502)
      if (status === 401 || status === 403) throw fail('catalog_credentials_rejected','S&S rejected the shop credentials. Check the S&S account number and API key in Settings.',422)
      if (status === 404) throw fail('catalog_not_found','S&S did not find this exact SKU or photo. Check the SKU or upload a product photo.',404)
      if (status < 200 || status >= 300 || !Number.isFinite(status)) throw fail('catalog_upstream_error','S&S could not provide this product or photo. Try again shortly.',502)
      if (header(response.headers,'content-encoding') && header(response.headers,'content-encoding').toLowerCase() !== 'identity') throw fail('catalog_response_encoding','S&S returned an unsupported compressed response.',502)
      const declared = header(response.headers,'content-length')
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw fail('catalog_response_too_large','The supplier response exceeds the photo download limit.',413)
      // A byte limit alone does not bound an array of tiny Buffer objects. Use one
      // fixed-capacity collector, then return only the populated bytes; no per-chunk
      // object retention and no oversized backing buffer retained by a small photo.
      let collected, size=0
      const body = response.body
      const parts = Buffer.isBuffer(body) || body instanceof Uint8Array ? [body] : body
      if (!parts?.[Symbol.asyncIterator] && !parts?.[Symbol.iterator]) throw fail('catalog_response_invalid','S&S returned an unreadable response.',502)
      for await (const chunk of parts) {
        if (controller.signal.aborted) throw controller.signal.reason
        if (!(chunk instanceof Uint8Array)) throw fail('catalog_response_invalid','S&S returned an unreadable response.',502)
        if (size + chunk.byteLength > maxBytes) throw fail('catalog_response_too_large','The supplier response exceeds the photo download limit.',413)
        if (chunk.byteLength) {
          collected ??= Buffer.allocUnsafe(maxBytes)
          collected.set(chunk,size)
          size += chunk.byteLength
        }
      }
      if (declared && Number(declared) !== size) throw fail('catalog_response_incomplete','The supplier response was incomplete. Try the photo again.',502)
      // Buffer.from(smallBytes) retains a shared slab whose size varies by Node version.
      // Use an unpooled allocation so retained response backing is exactly its byte count.
      const bytes = Buffer.allocUnsafeSlow(size)
      if (size) collected.copy(bytes,0,0,size)
      return {bytes,headers:response.headers}
    })()
    try { return await Promise.race([operation,deadline]) }
    catch (error) {
      controller.abort(); response?.body?.destroy?.()
      if (error?.code?.startsWith('catalog_')) throw error
      // Never reflect a provider's body, URL, credentials or transport exception.
      throw fail('catalog_unavailable','Unable to reach S&S. Try again or upload a product photo manually.',502)
    } finally {
      clearTimeout(timer); active--
      const remaining = (inflight.get(tenant) || 1)-1
      if (remaining) inflight.set(tenant,remaining); else inflight.delete(tenant)
    }
  }
  function textField(value,name) {
    if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f]/.test(value)) throw fail('catalog_identity_missing',`S&S did not return an exact product ${name}. Upload a product photo manually.`,502)
    return value
  }
  async function resolveProduct({tenant,sku,settings} = {}) {
    tenant=scopeOf(tenant); sku=normalizeCatalogSku(sku)
    const account=String(settings?.ss_account || '').trim(), apiKey=String(settings?.ss_api_key || '').trim()
    if (!account || !apiKey) throw fail('catalog_credentials_missing','Connect this shop’s S&S account number and API key in Settings, or upload a product photo manually.',422)
    if (account.length > 512 || apiKey.length > 2048 || /[:\x00-\x1f]/.test(account) || /[\x00-\x1f]/.test(apiKey)) throw fail('catalog_credentials_invalid','Check the S&S account number and API key in Settings.',422)
    const {bytes,headers} = await request(tenant,`https://api.ssactivewear.com/v2/products/${encodeURIComponent(sku)}`,{
      Authorization:`Basic ${Buffer.from(`${account}:${apiKey}`).toString('base64')}`, Accept:'application/json', 'Accept-Encoding':'identity',
    },bound.jsonBytes)
    if (!/^application\/json(?:;|$)/i.test(header(headers,'content-type'))) throw fail('catalog_response_invalid','S&S returned an unexpected product response.',502)
    let rows
    try { rows=JSON.parse(bytes.toString('utf8')) } catch { throw fail('catalog_response_invalid','S&S returned an unreadable product response.',502) }
    if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0]?.sku !== 'string' || rows[0].sku.trim().toUpperCase() !== sku) throw fail('catalog_sku_mismatch','S&S did not return exactly the requested SKU. Check its color and size; no substitute photo was selected.',404)
    const row=rows[0], styleId=Number(row.styleID)
    if (!Number.isSafeInteger(styleId) || styleId <= 0) throw fail('catalog_identity_missing','S&S did not return an exact product style.',502)
    const identity={supplier:'ssactivewear',sku:textField(row.sku,'SKU'),style_id:styleId,
      style:textField(row.styleName,'style'),brand:textField(row.brandName,'brand'),color:textField(row.colorName,'color'),
      color_code:typeof row.colorCode === 'string' && row.colorCode.trim() ? row.colorCode.trim().slice(0,64) : null,size:textField(row.sizeName,'size')}
    const available = VIEWS.filter(([, ,field]) => row[field]).map(([view,label,field]) => ({view,label,url:catalogMediaUrl(row[field])}))
    if (!available.length) throw fail('catalog_views_missing','S&S has no color-specific photos for this exact SKU. Upload the product photo manually.',404)
    prune()
    const expiresAt=now()+bound.handleTtlMs, pending=[]
    const views=available.map(({view,label,url}) => {
      const existing=[...handles.entries()].find(([,h]) => h.tenant === tenant && h.url === url && h.view === view && JSON.stringify(h.identity) === JSON.stringify(identity))
      if (existing) return {view,label,media_id:existing[0],expires_at:existing[1].expires_at}
      const id=crypto.randomBytes(24).toString('base64url')
      const h={tenant,identity,view,url,expires_at:expiresAt}
      h.charge=Buffer.byteLength(JSON.stringify(h))+64
      pending.push([id,h]); return {view,label,media_id:id,expires_at:expiresAt}
    })
    const used=usage(tenant), charge=pending.reduce((n,[,h]) => n+h.charge,0)
    if (used.handles+pending.length > bound.handles || used.tenantHandles+pending.length > bound.tenantHandles || used.bytes+charge > bound.handleBytes || used.tenantBytes+charge > bound.tenantHandleBytes) throw fail('catalog_handle_limit','Too many catalog photos are open. Wait a few minutes before loading another product.',429)
    for (const [id,h] of pending) handles.set(id,h)
    return {...identity,views,expires_at:Math.min(...views.map(view => view.expires_at))}
  }
  function sign(payload) {
    const encoded=Buffer.from(JSON.stringify(payload)).toString('base64url')
    return `${encoded}.${crypto.createHmac('sha256',key).update(`psc-catalog-media-v1.${encoded}`).digest('base64url')}`
  }
  async function fetchMedia({tenant,media_id} = {}) {
    tenant=scopeOf(tenant); prune()
    const h=typeof media_id === 'string' && handles.get(media_id)
    if (!h || h.tenant !== tenant) throw fail('catalog_handle_expired','This photo selection expired or belongs to another shop. Look up the exact SKU again.',404)
    const {bytes,headers}=await request(tenant,h.url,{Accept:'image/png, image/jpeg, image/webp','Accept-Encoding':'identity'},bound.mediaBytes)
    const mime=rasterMime(bytes)
    if (header(headers,'content-type').split(';')[0].trim().toLowerCase() !== mime) throw fail('catalog_media_format','The supplier photo type does not match its bytes.',502)
    let raster
    try { raster=readRasterHeader(bytes) } catch (error) { throw fail('catalog_media_format',`This supplier photo cannot be used: ${error.message}`,422) }
    if (raster.animated || raster.width > MOCKUP_LIMITS.inputEdge || raster.height > MOCKUP_LIMITS.inputEdge || raster.width * raster.height > MOCKUP_LIMITS.combinedPixels) throw fail('catalog_media_dimensions','The supplier photo exceeds the mockup image limits. Upload a smaller still photo.',422)
    const sha256=crypto.createHash('sha256').update(bytes).digest('hex')
    const payload={version:1,tenant,...h.identity,view:h.view,source_url:h.url,sha256,fetched_at:now(),expires_at:now()+bound.ticketTtlMs}
    const {tenant:_,version:__,fetched_at:___,expires_at:____,...provenance}=payload
    return {bytes,mime,sha256,ticket:sign(payload),provenance}
  }
  // allowExpired is only for replaying a previously committed receipt. The caller must
  // enforce replay-only saving; this flag never authorizes a new composition or skips
  // the signature, tenant, future timestamp, or exact photo digest checks.
  function verifyTicket({tenant,ticket,sha256,allowExpired=false} = {}) {
    tenant=scopeOf(tenant)
    if (typeof ticket !== 'string' || ticket.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(ticket)) throw fail('catalog_ticket_invalid','The supplier photo verification is missing or invalid. Select the catalog photo again.',409)
    const [encoded,signature]=ticket.split('.')
    const expected=crypto.createHmac('sha256',key).update(`psc-catalog-media-v1.${encoded}`).digest()
    const actual=Buffer.from(signature,'base64url')
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual,expected)) throw fail('catalog_ticket_invalid','The supplier photo verification is invalid. Select the catalog photo again.',409)
    let payload
    try { payload=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8')) } catch { throw fail('catalog_ticket_invalid','The supplier photo verification is invalid.',409) }
    if (payload.version !== 1 || payload.tenant !== tenant || payload.supplier !== 'ssactivewear') throw fail('catalog_ticket_invalid','The supplier photo verification does not belong to this shop.',409)
    if (!Number.isSafeInteger(payload.expires_at) || payload.fetched_at > now() || (allowExpired !== true && payload.expires_at <= now())) throw fail('catalog_ticket_expired','The supplier photo verification expired. Select the catalog photo again.',409)
    if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256) || payload.sha256 !== sha256) throw fail('catalog_ticket_digest_mismatch','The photo bytes changed after catalog selection. Select the catalog photo again, or explicitly upload it as a manual photo.',409)
    const {tenant:_,version:__,fetched_at:___,expires_at:____,...provenance}=payload
    return provenance
  }
  return {resolveProduct,fetchMedia,verifyTicket,clearTenant(tenant) { tenant=scopeOf(tenant); for (const [id,h] of handles) if (h.tenant === tenant) handles.delete(id) }, stats(tenant) { return usage(scopeOf(tenant)) }}
}
