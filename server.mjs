import express from 'express'
import multer from 'multer'
import crypto from 'node:crypto'
import { mkdirSync, existsSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  all, get, run, iterate, tx, now, round2, getSettings, setSetting, publicSettings, applySettingsPatch, logActivity, computeTotals, getUpcharges,
  freezeUpcharges,
  syncInvoiceStatus, EFFECTIVE_STATUS_SQL, todayIso, pruneWebhookDeliveries, nextEstimateNumber, nextInvoiceNumber, nextJobNumber, sizeSummary, rollupSizes, garmentLines, lineQty, sizeTotal,
  lineAmount, lineUpcharge, SIZES, SIZE_KEY,
  scheduleFor, addBusinessDays, businessDaysBetween, templateValue, taxRateFor, clampRate, onContactCreated, canWrite, SECRET_KEYS,
} from './lib/db.mjs'
import { renderDocument, packingSlip, pickTicket, customerStatement } from './lib/pdf.mjs'
import { db, tenantStore } from './lib/db.mjs'
import {
  createTenant, authMember, createSession, getSession, getSessionTenant, deleteSession,
  openTenantDb, withTenant, getTenantByEmbedKey, getTenantBySlug, tenantOpen, saveOnboarding, tenantPublic,
  billingState, setSubscription, getTenantById, getTenantByStripeCustomer,
  getPlatformConfig, setPlatformConfig, isAdminEmail,
  listMembers, addMember, updateMember, deleteMember, getMemberById, ROLES, ROLE_RANK,
  activeTenantSlugs, automationTenantSlugs, purgeExpiredSessions, enrollNurture, stopNurtureByToken,
  listTenantsAdmin, setTenantStatus, deleteTenantFully,
  verifyMemberPassword, setMemberPassword, setPassword, MIN_PASSWORD,
  createPasswordReset, checkPasswordReset, consumePasswordReset,
  getTenantByApiKey, rotateApiKey, revokeApiKey, brokenTenants,
} from './lib/tenants.mjs'
import {
  PLANS, createSubscriptionCheckout, createBillingPortal, verifyWebhook, webhookSecret,
  billingLive, setPlatformCredentials, LITE_PLAN_ORDER, PLAN_ORDER, litePlanAllows, isFreePlan,
} from './lib/billing.mjs'
import { initAutomations, seedAutomations, listAutomations, needsSetup, fire, tick, TRIGGERS, ACTIONS, CONDITIONS } from './lib/automations.mjs'
import { parseIntake, aiStatus, draftReply, testAi, AI_PROVIDERS, DEFAULT_MODELS, parseSizeRun } from './lib/ai.mjs'
import * as pipeline from './lib/pipeline.mjs'
import { capacityReport, promise as capacityPromise, colorsFromItems } from './lib/capacity.mjs'
import { reorderRadar, snoozeReorder, unsnoozeReorder } from './lib/reorder.mjs'
import { parseCsv, mapContactRow, detectColumns, mapOrderRows, summarizeImport } from './lib/csv.mjs'
import { quoteScreenPrint, pricingMatrix, embroideryMatrix, dtfMatrix } from './public/js/shared/pricing.js'
import { ask } from './lib/assistant.mjs'
import { initSuppliers, listGarments, supplierStatus, lookupLive, buildPurchaseOrder, buildJobPurchaseOrder, submitPurchaseOrder, blankCost, blankCostLabel, createPurchaseOrder, getPurchaseOrder, purchaseOrdersForJob, receivePurchaseOrder, poAlreadySent } from './lib/suppliers.mjs'
import { deliverWebhook, assertPublicUrl } from './lib/webhook.mjs'
import * as qbo from './lib/quickbooks.mjs'
import * as gdrive from './lib/gdrive.mjs'
import { liveInventory } from './lib/suppliers.mjs'
import { jobRoi, shopRoi, laborActualMinutes } from './lib/roi.mjs'
import { code128Svg } from './lib/barcode.mjs'
import { nest, priceSheet } from './public/js/shared/gangnest.js'
import { createCheckout, stripeConfigured, retrieveSession } from './lib/stripe.mjs'
import { connectReady, createExpressAccount, createAccountLink, getConnectAccount, createConnectedCheckout, retrieveConnectedSession, FEE_PCT } from './lib/connect.mjs'
import { parseShopProfile, onboardingChecklist, onboardingSteps, SERVICE_DEFAULTS } from './lib/onboarding.mjs'
import { initAgent, getBotConfig, saveBotConfig, startSession, sessionByPublicId, sessionMessages, listSessions, respond, agentReply, OFFLINE_REPLY, MESSAGE_CAP, transcriptFor } from './lib/agent.mjs'
import { sendEmail, sendSms, notifyStatus, verifyEmail, captureLead, platformEmailDeliverable } from './lib/notify.mjs'
import { verifySlackSignature, postMessage as slackPost, testAuth as slackTestAuth, slackToPlain, findEmail, quoteBlocks, needsMoreBlocks, slackConfigured } from './lib/slack.mjs'
import { quickQuote, priceIntake, priceIntakeLive } from './lib/quickquote.mjs'
import { resolveBook, serviceMatrix, serviceNames, STOCK_SERVICES, QTY_BANDS, AXIS, AXIS_LABEL, bandMinFor, bandFor } from './lib/pricebook.mjs'
import * as matrices from './lib/matrices.mjs'
import { runNurtureDrip } from './lib/nurture.mjs'
import { initRealtime, closeRealtime, broadcast, roomSize } from './lib/realtime.mjs'
import { createServer } from 'node:http'

initAutomations(db)
seedAutomations()
initSuppliers(db)
initAgent(db)

// Load the platform billing credentials (the owner's Stripe) from the control store so shops can be charged.
try { const pc = getPlatformConfig(); setPlatformCredentials({ secret: pc.platform_secret, webhookSecret: pc.webhook_secret }) } catch (e) { console.error('billing cred load:', e.message) }

// Conversations: one unified thread per customer, both directions, email + SMS. This is
// GHL's inbox, built in — the reason a shop doesn't also pay for a separate CRM.
// (The messages table itself is declared in db.mjs so seed.mjs can populate it too.)
db.exec('CREATE INDEX IF NOT EXISTS idx_msg_contact ON messages(contact_id)')

/** Record a message on the thread. Every outbound touch (email, SMS, nudge) also lands here. */
function recordMessage({ contact_id, direction, channel = 'email', subject = '', body = '', kind = '', read }) {
  if (!contact_id) return
  run('INSERT INTO messages (contact_id, direction, channel, subject, body, kind, read, created_at) VALUES (?,?,?,?,?,?,?,?)',
    contact_id, direction, channel, subject, body, kind, read ?? (direction === 'in' ? 0 : 1), now())
  if (direction === 'in') { try { broadcast(curSlug(), 'conversation', { contact_id, channel, preview: String(body).slice(0, 80) }) } catch {} }
}

const ROOT = dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 3333
/**
 * The interface to listen on. Unset means every interface, which is what this server has always
 * done and what a container needs.
 *
 * INSTALL.md has described the reference deployment as "nginx terminating SSL, the app on
 * 127.0.0.1:3870" since it was written, and there was no way to do that: `server.listen(PORT)`
 * binds every interface, so on that reference install the app was also answering on the box's LAN
 * and public addresses, bypassing nginx and its TLS. Setting PSC_HOST=127.0.0.1 now does what the
 * documentation already promised.
 */
const HOST = String(process.env.PSC_HOST || '').trim()
const SECRET = process.env.PSC_SECRET || 'preview-secret-change-in-prod'
// In production (multi-tenant), the share-link HMAC secret MUST be set. Booting with the in-repo
// default would make every estimate/pay/proof/ticket token forgeable — refuse to start.
if (process.env.PSC_AUTH === '1' && SECRET === 'preview-secret-change-in-prod') {
  console.error('FATAL: PSC_SECRET is unset in multi-tenant mode — share-link tokens would be forgeable. Set PSC_SECRET.')
  process.exit(1)
}
const UPLOADS = join(ROOT, 'public', 'uploads')
mkdirSync(UPLOADS, { recursive: true })

const app = express()
// Trust X-Forwarded-* so req.protocol says https (customer links) and req.ip is the real client
// (per-IP rate limiting). "1" means trust exactly one proxy hop — correct behind a single nginx/
// Caddy/Fly/Render, which is every recommended deployment.
//
// It MUST be 0 if the app's port is exposed directly to the internet with no proxy in front (e.g.
// `docker run -p 3333:3333` straight onto a public IP). With trust-proxy on and nothing stripping
// the header, a client sets its own X-Forwarded-For and Express believes it — so a rotating XFF
// walks straight past the login, signup and embed rate limiters, one fresh bucket per forged IP.
// Configurable so a direct-exposure install can turn it off; defaults to 1 because behind-a-proxy
// is the documented setup and flipping the default would break https link-building on every
// existing proxied install. PSC_TRUST_PROXY also accepts a subnet or "true"/"false" per Express.
const TRUST_PROXY = process.env.PSC_TRUST_PROXY ?? '1'
app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY === 'false' ? false : TRUST_PROXY === 'true' ? true : TRUST_PROXY)
// Express matches routes case-insensitively by default, but the auth gate below tested the path
// with a case-sensitive startsWith('/api/'). That mismatch let `/API/contacts` slip past the gate
// and still reach the handler — a full auth + paywall bypass. Make routing case-sensitive so a
// mangled-case path can never match a route, and (belt + suspenders) the gate normalises too.
app.set('case sensitive routing', true)

// Express advertises itself by default; the version is a free hint for anyone matching CVEs.
app.disable('x-powered-by')

/**
 * Security response headers.
 *
 * This app shipped with none of these, so a browser had no instruction to keep the CRM out of a
 * frame, to stop sniffing a response's type, or to refuse plain http on a return visit.
 *
 * The one thing that stops this from being a copy-paste of the usual block: /embed/* is *designed*
 * to be framed cross-origin — the gang-sheet builder and the AI receptionist widget run inside an
 * iframe on the SHOP'S OWN website. A blanket X-Frame-Options: DENY / frame-ancestors 'self' would
 * silently break the embed for every shop, so those paths opt out of the framing rules only, and
 * keep the rest.
 *
 * CSP allows 'unsafe-inline' for scripts and styles deliberately: index.html carries the no-flash
 * theme boot script inline, and the canvas/kanban/mockup code writes el.style at runtime, which a
 * strict style-src blocks. Locking those down means nonces + a refactor of the drag and canvas
 * layers; the value here is object-src/base-uri/form-action/frame-ancestors, which cost nothing.
 */
const EMBEDDABLE = /^\/(embed|api\/embed)\//
app.use((req, res, next) => {
  const embeddable = EMBEDDABLE.test(req.path)
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    // https: keeps supplier/product artwork loading; it grants no script execution.
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    embeddable ? 'frame-ancestors *' : "frame-ancestors 'self'",
  ].join('; ')
  res.setHeader('Content-Security-Policy', csp)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  // `camera=()` is an EMPTY allowlist, which disables getUserMedia for this document — not just
  // for embedded frames. So Floor Mode's barcode scanner (public/js/views/scan.js) has never
  // worked on any install: getUserMedia rejects with `NotAllowedError: Permissions policy
  // violation` before the browser shows a permission prompt, and the screen toasts an error
  // naming a policy the shop cannot change from anywhere in the product. It only ever ran on
  // Chromium, because scan.js gates the camera on BarcodeDetector — which is exactly where this
  // header is enforced. manifest.json's start_url is /#/scan, so the installed tablet PWA opens
  // straight onto the broken screen. `(self)` grants the app's own origin and nothing else.
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=()')
  if (!embeddable) res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  // Only assert HSTS on a request that actually arrived over TLS — sending it on plain http in
  // local dev would pin localhost to https and make the dev server unreachable.
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  next()
})

/**
 * CORS for the embed API, and ONLY the embed API.
 *
 * These three routes exist to be called from the shop's OWN website — that is the entire feature,
 * and the app hands the shop a one-line script tag with "paste this before </body> on any page".
 * No Access-Control header was ever sent, so the browser blocked every call and the widget showed
 * the visitor "Sorry, chat is unavailable right now." Verified in real headless Chrome from a
 * second origin: `BLOCKED Failed to fetch`. The same request over curl returned 200 and a live
 * session, which is why it looked fine in the app — /embed/chatdemo is same-origin.
 *
 * '*' is correct here and nowhere else: these routes take no cookie, and the credential is the
 * public shop key that is published in the shop's own page source. Allow-Credentials is
 * deliberately absent, and the path prefix must never widen beyond /api/embed — every other /api
 * route is cookie-authenticated and leans on SameSite=Lax plus the same-origin policy. The
 * per-IP+shop limiter still bounds abuse.
 *
 * Registered before express.json so a preflight is answered without parsing a body.
 */
app.use('/api/embed', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Max-Age', '600')
  if (req.method === 'OPTIONS') return res.status(204).end()
  next()
})

// Stripe webhook needs the RAW body for signature verification — register it before express.json,
// which then skips re-parsing (body-parser sets req._body). This route bypasses the auth gate.
app.post('/webhooks/stripe', express.raw({ type: '*/*' }), (req, res) => stripeWebhook(req, res))

/* ================= SLACK — one bot per shop, on the shop's own workspace ================= */

/**
 * Slack signs the RAW body, so these routes are registered before express.json and take the body
 * as a Buffer — exactly like the Stripe webhook above. Parsing first would re-serialise the JSON
 * and the signature would never match.
 *
 * The shop is identified by its embed_key in the path, so no session cookie is involved and one
 * indexed lookup resolves the tenant. Every reply is posted back through the shop's own bot token.
 */
/**
 * The address this shop is reachable at. Prefers PSC_PUBLIC_URL because the alternative — trusting
 * the request's Host header — lets a caller decide what link we paste into the shop's Slack and
 * what URLs we bake into the manifest they hand to Slack.
 */
const publicOrigin = (req) => String(process.env.PSC_PUBLIC_URL || '').replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`

/**
 * The origin an emailed link may point at when the request that triggered it is UNAUTHENTICATED.
 *
 * publicOrigin() falls back to the request's own Host header, and Host is chosen by whoever sent
 * the request. On the password-reset route that is a complete account takeover: POST
 * /api/auth/reset with `Host: evil.example` mails the REAL owner a working, one-time link that
 * sets their password — hosted by the attacker. PSC_PUBLIC_URL closes it, the app has warned at
 * boot when it is unset since 3527b14, and it is STILL unset on the install this was found on,
 * four releases later. A warning nobody acts on is not a fix; it is a fix that lives in someone
 * else's todo list.
 *
 * So the app learns the answer rather than asking for it. A signed-in OWNER loading the app is
 * proof of a host the shop genuinely uses. That host is remembered on the control database and
 * used for links built off unauthenticated requests from then on.
 *
 * PER SHOP, and this is the whole of it. The first version of this kept ONE platform-wide value,
 * written by whichever owner happened to make the last GET — and on an open-signup install
 * anybody is an owner five seconds after they arrive. One free trial and one GET with a chosen
 * Host header repointed the reset link for EVERY shop on the box, which is the exact takeover the
 * learned origin was added to prevent, one signup further away: the next owner anywhere on the
 * install to forget their password handed a live token to a stranger. It was persisted, so it
 * survived restarts, and nothing in the product could show or clear it. A shop may only ever
 * teach us its OWN address, and ann@alpha's reset link is built from what ALPHA's owners have
 * actually signed in on.
 *
 * It is deliberately NOT used for the rest of them. Every other link is generated behind auth,
 * where Host is whatever the shop's own staff are looking at, and overriding it there would send a
 * share link to the wrong address for anyone whose office URL and public URL differ. And on a
 * brand-new install where nobody has signed in yet this falls straight through to today's
 * behaviour, because refusing to send a new shop its welcome email is the worse failure.
 */
let learnedOrigins = null // slug -> origin; null = not read from the control db yet
const ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i
const learnedOriginFor = (slug) => {
  if (learnedOrigins === null) {
    learnedOrigins = new Map()
    try {
      for (const [k, v] of Object.entries(getPlatformConfig())) {
        if (k.startsWith('origin:')) learnedOrigins.set(k.slice(7), String(v || ''))
      }
    } catch { /* start empty — the PSC_PUBLIC_URL and Host fallbacks below still work */ }
  }
  return (slug && learnedOrigins.get(slug)) || ''
}
const rememberPublicOrigin = (req) => {
  const slug = req.tenant?.slug || ''
  const o = `${req.protocol}://${req.get('host') || ''}`
  if (!slug || !ORIGIN_RE.test(o) || o === learnedOriginFor(slug)) return
  try { setPlatformConfig({ [`origin:${slug}`]: o }); learnedOrigins.set(slug, o) } catch (e) { console.error('learn origin:', e.message) }
}
// `tenant` is the shop the LINK is for, which on /api/auth/forgot is not the shop that sent the
// request — an unauthenticated request has no shop at all. createPasswordReset() returns it.
const trustedOrigin = (req, tenant = req.tenant) =>
  String(process.env.PSC_PUBLIC_URL || '').replace(/\/$/, '') || learnedOriginFor(tenant?.slug) || publicOrigin(req)

const slackRaw = express.raw({ type: '*/*', limit: '256kb' }) // Slack payloads are far under this

/**
 * These two routes are unauthenticated by necessity, and the embed_key in their path is public —
 * it ships inside the gang-sheet snippet a shop pastes on its own website. Without a brake, anyone
 * who scrapes that key can flood us: every request costs a control-DB read plus a settings scan on
 * a SYNCHRONOUS sqlite handle shared by every tenant, so a flood blocks the event loop for all
 * shops. The limiter runs before the body parser so oversized bodies are never buffered.
 */
const slackLimit = rateLimit({
  windowMs: 60_000, max: 120,
  keyFn: (req) => `${clientIp(req)}:${req.params.key || 'none'}`,
  message: 'Too many Slack requests.',
})

// Slack retries anything it doesn't hear back from in 3s. Work happens after the ack, so we track
// the event ids we've already accepted and drop the duplicates a retry brings.
const slackSeen = new Map()
setInterval(() => { const t = Date.now(); for (const [k, v] of slackSeen) if (t - v > 600_000) slackSeen.delete(k) }, 120_000).unref?.()
const slackDupe = (id) => { if (!id) return false; if (slackSeen.has(id)) return true; slackSeen.set(id, Date.now()); return false }

/** The endpoint handshake Slack sends to prove a Request URL is live, or null if this isn't one. */
function readChallenge(raw) {
  try {
    const b = JSON.parse(raw)
    return b && b.type === 'url_verification' ? String(b.challenge || '') : null
  } catch { return null } // form-encoded slash commands land here; they are never a handshake
}

/**
 * Resolve shop → verify signature → hand the parsed payload to `fn`.
 *
 * ORDERING IS LOAD-BEARING. Slack mints the signing secret at the moment it creates the app, and
 * it verifies the Request URL as part of that same creation step — so at handshake time the shop
 * cannot possibly have pasted a secret to us yet. Gating the handshake behind the secret made
 * setup unsatisfiable in both directions: no app without a verified URL, no secret without an app.
 * The handshake therefore answers before the secret gate.
 *
 * That is safe: the challenge is an opaque nonce Slack itself just sent us, we echo it and nothing
 * else, no state changes, and the shop must already be resolved by embed_key. Once a secret IS
 * stored we still verify the signature on handshakes, so the unverified path closes as soon as
 * setup is finished.
 */
function slackRun(req, res, fn) {
  const tenant = getTenantByEmbedKey(String(req.params.key || ''))
  if (!tenantOpen(tenant)) return res.status(404).send('unknown shop')
  return withTenant(tenant.slug, async () => {
    const s = getSettings()
    const secret = String(s.slack_signing_secret || '').trim()
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : ''
    const verify = () => verifySlackSignature({
      signingSecret: secret,
      rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
      timestamp: req.get('x-slack-request-timestamp'),
      signature: req.get('x-slack-signature'),
    })

    const challenge = readChallenge(raw)
    if (challenge !== null) {
      if (secret && !verify()) return res.status(401).send('bad signature')
      return res.type('text/plain').send(challenge)
    }

    if (!secret) return res.status(400).send('Slack is not configured for this shop')
    if (!verify()) return res.status(401).send('bad signature')
    // The web UI refuses writes when a shop's trial or subscription has lapsed; Slack is registered
    // above that gate, so without this check it stayed a way in after the front door was locked.
    try { if (billingState(tenant).locked) return res.status(402).send('This shop needs an active plan.') } catch {}
    return fn({ tenant, settings: s, raw })
  })
}

/** Turn a Slack message into a draft estimate and post the result back in-thread. */
async function slackQuoteAndReply({ slug, token, channel, thread_ts, text, origin }) {
  await withTenant(slug, async () => {
    try {
      const body = slackToPlain(text)
      const result = await quickQuote({ text: body, contact_email: findEmail(body), source: 'slack' })
      const blocks = result.ok ? quoteBlocks({ result, origin }) : needsMoreBlocks(result.reason)
      const fallback = result.ok ? `${result.estimate.estimate_number} — $${Number(result.total).toFixed(2)}` : 'I need a bit more detail to quote that.'
      await slackPost({ token, channel, thread_ts, text: fallback, blocks })
    } catch (e) {
      console.error('slack quote:', e)
      try { await slackPost({ token, channel, thread_ts, text: `Couldn't build that quote: ${e.message}` }) } catch {}
    }
  })
}

app.post('/api/slack/:key/events', slackLimit, slackRaw, (req, res) => slackRun(req, res, async ({ tenant, settings, raw }) => {
  let body = null
  try { body = JSON.parse(raw) } catch { /* handled below */ }
  if (!body || typeof body !== 'object') return res.status(400).send('bad json')

  const ev = body.event || {}
  const isBot = !!ev.bot_id || ev.subtype === 'bot_message'
  // A DM that is edited or deleted re-fires message.im with the text nested under ev.message, so
  // without the subtype guard the bot answered an edit nobody addressed to it.
  const wanted = !ev.subtype && (ev.type === 'app_mention' || (ev.type === 'message' && ev.channel_type === 'im'))
  // Ack FIRST — everything below this line is best-effort background work.
  res.status(200).send('')
  if (isBot || !wanted || slackDupe(body.event_id && `${tenant.slug}:${body.event_id}`)) return
  const token = String(settings.slack_bot_token || '').trim()
  if (!token) return
  const origin = publicOrigin(req)
  // Reply in the thread when there is one, so a busy channel doesn't get a wall of loose quotes.
  slackQuoteAndReply({ slug: tenant.slug, token, channel: ev.channel, thread_ts: ev.thread_ts || ev.ts, text: ev.text, origin })
    .catch((e) => console.error('slack async:', e.message))
}))

app.post('/api/slack/:key/command', slackLimit, slackRaw, (req, res) => slackRun(req, res, async ({ tenant, settings, raw }) => {
  const form = new URLSearchParams(raw)
  const text = form.get('text') || ''
  const channel = form.get('channel_id')
  // Slash commands carry no event_id, so a captured signed request stayed replayable for the whole
  // 5-minute window — each replay a new estimate and a new billed model call. trigger_id is unique
  // per invocation.
  const trigger = form.get('trigger_id')
  const replay = slackDupe(trigger && `${tenant.slug}:${trigger}`)
  const token = String(settings.slack_bot_token || '').trim()
  // Slash commands get an immediate ephemeral ack, then the quote lands in the channel.
  res.json({ response_type: 'ephemeral', text: text.trim() ? 'Working on that quote…' : 'Paste the customer request after the command and I will draft an estimate.' })
  if (!text.trim() || !token || replay) return
  const origin = publicOrigin(req)
  slackQuoteAndReply({ slug: tenant.slug, token, channel, text, origin })
    .catch((e) => console.error('slack cmd:', e.message))
}))


// 1 MB, not 25. This parser runs on every JSON route, and it runs BEFORE the auth gate and every
// rate limiter — there is no way to authenticate a request before its body is read. At 25 MB, 35
// anonymous POSTs of a 24 MB body to /api/auth/login took the process from 38 MB to 1.08 GB of RSS
// and the 401s cost the memory anyway: one unauthenticated loop OOMed the box for all 14 shops.
//
// Nothing legitimate needs more than a fraction of this. File uploads and CSV imports go through
// multer, not here; the largest JSON body the app sends is a pasted price matrix, far under 1 MB.
// Express answers an oversize body with 413 as soon as the declared length exceeds the cap, so the
// giant payload is refused, not buffered. PSC_JSON_LIMIT can raise it for an unusual integration.
app.use(express.json({ limit: process.env.PSC_JSON_LIMIT || '1mb' }))

const upload = multer({
  limits: { fileSize: 40 * 1024 * 1024 },
  storage: multer.diskStorage({
    destination: UPLOADS,
    // The extension comes from the uploader's filename, so it is attacker-controlled: `a.png"onerror=x`
    // yields an extension carrying quotes and an event handler, which breaks out of any src attribute
    // that renders it unescaped. Keep only a short, plain alphanumeric extension.
    filename: (_req, file, cb) => {
      const raw = extname(file.originalname || '').toLowerCase()
      const ext = /^\.[a-z0-9]{1,8}$/.test(raw) ? raw : ''
      cb(null, `${Date.now()}-${crypto.randomBytes(16).toString('hex')}${ext}`)
    },
  }),
})
// CSV imports stay in memory (they're text, and we never keep the file) — a separate, smaller cap.
const uploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } })

/* ---------- helpers ---------- */

/**
 * Read a JSON blob column, with a fallback for anything unreadable.
 *
 * The `v == null` clause is load-bearing: a LEFT JOIN that misses hands back SQL NULL, and
 * `JSON.parse(null)` is `JSON.parse('null')`, which SUCCEEDS and returns null. So the fallback
 * never fired and the caller's `.filter` / `.map` threw. That is how the work ticket — the page
 * the press operator runs the job from — returned a bare 500 for every job with no estimate
 * behind it, including one in the shipped demo data. The two call sites that pass `null` as the
 * fallback are unaffected: null is what they wanted anyway.
 */
const parse = (s, fallback) => { try { const v = JSON.parse(s); return v == null ? fallback : v } catch { return fallback } }

/**
 * The largest piece count any single line or capacity question may carry. A million shirts in one
 * size cell is already three orders of magnitude past a real screen-print run; past that the
 * number is not an order, and it reaches the day-by-day scheduling loops in lib/capacity.mjs.
 */
const MAX_PIECES = 1_000_000
// node:sqlite refuses to bind undefined, an object, or an array, and surfaces it as
// "Provided value cannot be bound to SQLite parameter N" — a 500. Request bodies are external
// input, so an omitted field, or a client that sends {} or [] where a string is expected, must not
// crash the route. Coerce anything that isn't a usable scalar to a safe string before it is bound.
const str = (v, fallback = '') =>
  v == null ? fallback : typeof v === 'string' ? v : (typeof v === 'number' || typeof v === 'boolean') ? String(v) : fallback
/**
 * Resolve the customer a document is being raised for, or answer why not.
 *
 * `if (!b.contact_id)` is a truthiness check, and contact_id is a real foreign key on estimates,
 * jobs and opportunities — so an id that no longer resolves raised `FOREIGN KEY constraint
 * failed`, which wrap() turned into a bare 500 with no `code` and nothing the caller could act on.
 * Two ordinary paths reach it: a customer <select> rendered before someone else deleted that
 * customer (two tabs, or two people), and an integration posting an id it cached. The v1 API got
 * this exact refusal in round 4; the app's own create routes never did.
 */
const resolveContactId = (raw, res, verb) => {
  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: `Pick a customer to ${verb} for.`, code: 'customer_required' })
    return null
  }
  if (!get('SELECT id FROM contacts WHERE id = ?', id)) {
    res.status(404).json({
      error: 'That customer no longer exists — they may have been deleted while this screen was open. Reload and pick again.',
      code: 'customer_not_found',
    })
    return null
  }
  return id
}
// HTML-escape for server-rendered customer-facing /p/ pages. Shop- and customer-entered strings
// (names, notes, item descriptions — some from PUBLIC lead/gang-sheet forms) must never reach the
// page as live markup, or a crafted name becomes stored XSS on the customer's proof/pay page.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
// The current tenant's slug (empty in single-tenant dev). Customer-facing links carry it so a
// proof/estimate link resolves to the right shop's isolated database.
const curSlug = () => tenantStore.getStore()?.slug || ''
// Which table each /p/ link kind lives in — see the share_key migration in lib/db.mjs.
const SHARE_TABLES = { estimate: 'estimates', pay: 'invoices', ticket: 'jobs', art: 'art_versions' }
// A row's own random key, or '' for a row created before that migration — '' reproduces the legacy
// token, so links already in customers' inboxes keep verifying. Without this the token was a pure
// function of a REUSABLE rowid, and a deleted quote's link opened the next customer's order.
const shareKey = (kind, id) => {
  const t = SHARE_TABLES[kind]
  if (!t) return ''
  try { return String(get(`SELECT share_key FROM ${t} WHERE id = ?`, Number(id))?.share_key || '') } catch { return '' }
}
// `key` lets a caller that ALREADY holds the row hand its share_key straight in. A list route
// selecting `a.*` has it in memory and was re-SELECTing it once per row: /api/art issued 39,906
// hidden single-row lookups for a column it had already fetched, 214ms of pure redundancy inside
// a 700ms synchronous block that stops every tenant on the box. Omit it and the lookup happens
// exactly as before; the token is byte-identical either way.
const token = (kind, id, slug = curSlug(), key) => {
  const k = key === undefined ? shareKey(kind, id) : String(key ?? '')
  return crypto.createHmac('sha256', SECRET).update(`${kind}:${id}:${slug}${k ? `:${k}` : ''}`).digest('hex').slice(0, 16)
}
const checkToken = (kind, id, k, slug = curSlug()) => {
  const want = Buffer.from(token(kind, id, slug))
  const got = Buffer.from(String(k || ''))
  return want.length === got.length && crypto.timingSafeEqual(want, got)
}
// Build a customer-facing share URL, carrying the shop slug when multi-tenant is on.
const shareUrl = (kind, id, key) => {
  const s = curSlug()
  return `/p/${kind}/${id}?k=${token(kind, id, s, key)}${s ? `&s=${s}` : ''}`
}
/**
 * A capability token for ONE uploaded file, bound to ONE shop.
 *
 * Uploaded art is customer property — unreleased logos, team rosters with player names, brand
 * assets under NDA — and it used to be served straight out of public/uploads by express.static,
 * which runs after the auth gate has already waved every non-/api path through. So a second
 * shop's signed-in owner, and an anonymous caller with no cookie at all, both fetched another
 * shop's proof: 200, full bytes. The database layer is airtight; this was the one surface where
 * tenants shared storage.
 *
 * Staff are resolved by their session like every other route. Customers have no session, so the
 * images on the server-rendered /p/ pages carry this instead — the same promise the page's own
 * ?k= makes, narrowed to a single filename. It is scoped to the shop, so it cannot be replayed
 * against another shop's file, and the handler re-checks that the shop still owns the file, so
 * deleting a proof really does take the artwork off the internet.
 */
const fileToken = (filename, slug = curSlug()) =>
  crypto.createHmac('sha256', SECRET).update(`file:${slug}:${filename}`).digest('hex').slice(0, 16)
/** The customer-facing URL for an uploaded file: the path, plus proof the shop handed it out. */
const uploadUrl = (filename, slug = curSlug()) => {
  const f = String(filename || '')
  return `/uploads/${encodeURIComponent(f)}?t=${fileToken(f, slug)}${slug ? `&s=${encodeURIComponent(slug)}` : ''}`
}
// Negatives read as -$40.00, not $-40.00 — discount credits appear on customer documents.
const money = (n) => { const v = Number(n) || 0; return `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` }

/**
 * Timestamps are stored as UTC "YYYY-MM-DD HH:MM:SS". Without the Z, JS parses them as
 * local time, which makes anything logged in the last few hours look like the future and
 * produces negative ages. Always parse them as UTC, and never report a negative age.
 */
const parseUtc = (s) => new Date(`${String(s).replace(' ', 'T')}${/[Z+]/.test(String(s).slice(-6)) ? '' : 'Z'}`)
const ageInDays = (s) => (s ? Math.max(0, Math.floor((Date.now() - parseUtc(s).getTime()) / 864e5)) : null)
// Unexpected throws only — routes with user-facing errors catch their own. Never hand the raw
// message to the client: it leaks internals ("rows.flatMap is not a function") and file paths.
const wrap = (fn) => async (req, res, next) => {
  try { await fn(req, res, next) } catch (e) { next(e) }
}

/** Run a DB function in the right tenant context after the request has ended (async delivery). */
const withSlugDb = (slug, fn) => (AUTH_ENABLED && slug ? withTenant(slug, fn) : fn())

/** Push a realtime event to the current shop's room (no-op when nobody's connected). */
const rtBroadcast = (type, data) => { try { broadcast(curSlug(), type, data) } catch (e) { console.error('rt:', e.message) } }

/**
 * Stamp an outbox row with its real delivery result, back in the shop's own database. Runs
 * after the request completes, so it re-enters the tenant context by slug.
 */
function markDelivery(slug, rowId, result) {
  if (!rowId) return
  // Best-effort bookkeeping that runs AFTER the response is sent. It must never throw: there is no
  // Express frame left to catch it, so a throw here becomes an unhandled rejection that (Node 22
  // default) exits the shared process and takes every tenant down. A locked/full/read-only DB is
  // enough to trigger it, so swallow everything.
  try {
    withSlugDb(slug, () => {
      run('UPDATE email_log SET delivered = ?, via = ?, delivery_error = ? WHERE id = ?',
        result.delivered ? 1 : 0, result.via || 'logged', result.error || null, rowId)
    })
  } catch (e) { console.error('markDelivery:', e && e.message) }
}

/**
 * Renders a template, records it on the thread + outbox, and ACTUALLY sends it when the shop
 * has wired SMTP. With no credentials the message still records (tagged "logged"), so nothing
 * silently vanishes — the honesty rule, now with real delivery on top.
 */
function queueEmail({ contact, subject, template, vars, kind, deliver = true }) {
  const s = getSettings()
  const slug = curSlug()
  const merged = { first_name: String(contact?.name || '').split(' ')[0], ...vars }
  const body = String(template || '').replace(/\{\{(\w+)\}\}/g, (_, k) => templateValue(k, merged, s))
  const rowId = Number(run('INSERT INTO email_log (contact_id, to_email, subject, body, kind, via, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    contact?.id ?? null, contact?.email ?? '', subject, body, kind, deliver ? 'logged' : 'draft', now()).lastInsertRowid)
  recordMessage({ contact_id: contact?.id, direction: 'out', channel: 'email', subject, body, kind })
  const to = contact?.email
  if (deliver && to) sendEmail({ to, subject, body, settings: s }).then((r) => markDelivery(slug, rowId, r)).catch((e) => markDelivery(slug, rowId, { delivered: false, via: 'error', error: String(e.message) })).catch(() => {})
  return body
}

/** SMS: same path as email, delivered over Twilio when the shop has wired it. */
function queueSms({ contact, body, deliver = true }) {
  const s = getSettings()
  const slug = curSlug()
  const rowId = Number(run('INSERT INTO email_log (contact_id, to_email, subject, body, kind, via, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    contact?.id ?? null, contact?.phone ?? '', 'SMS', body, 'sms', deliver ? 'logged' : 'draft', now()).lastInsertRowid)
  recordMessage({ contact_id: contact?.id, direction: 'out', channel: 'sms', subject: 'SMS', body, kind: 'sms' })
  const to = contact?.phone
  if (deliver && to) sendSms({ to, body, settings: s }).then((r) => markDelivery(slug, rowId, r)).catch((e) => markDelivery(slug, rowId, { delivered: false, via: 'error', error: String(e.message) })).catch(() => {})
  return body
}

// Injected into the automation engine so every side effect stays in this file. Automated
// customer messages respect the shop's follow-up mode: in Manual mode they still render and
// land in the outbox as drafts for a person to send, but nothing goes out on its own.
/**
 * Fire-and-forget webhook: SSRF-guarded delivery (lib/webhook.mjs) plus a timeline note on the
 * shop's own database. A webhook must never block or crash an automation, so this is detached.
 */
function fireWebhook(rawUrl, payload) {
  const slug = curSlug()
  deliverWebhook(rawUrl, payload).then((r) => {
    let host = rawUrl; try { host = new URL(r.url || rawUrl).host } catch { /* keep */ }
    try {
      withSlugDb(slug, () => logActivity('note', `Webhook ${r.ok ? 'delivered to' : 'FAILED to'} ${host}${r.error ? ` — ${String(r.error).slice(0, 80)}` : ''}`, {}))
    } catch (e) { console.error('markWebhook:', e && e.message) }
  }).catch(() => {})
}

const autoDeps = {
  fireWebhook,
  queueEmail: (o) => queueEmail({ ...o, deliver: getSettings().mode_followups !== 'manual' }),
  queueSms: (o) => queueSms({ ...o, deliver: getSettings().mode_followups !== 'manual' }),
}

/**
 * Fan an event out to the shop's webhook subscriptions (public API, Settings → Developers).
 * Separate from automation-rule webhooks: subscriptions get EVERY matching event, signed with
 * the subscription's secret, with delivery receipts and two retries (30s, 5m). Runs detached.
 */
function dispatchSubscriptions(event, data) {
  let subs
  try {
    subs = all('SELECT * FROM webhook_subscriptions WHERE active = 1')
      .filter((s) => s.events === '*' || String(s.events).split(',').map((x) => x.trim()).includes(event))
  } catch (e) { console.error('webhook subs:', e.message); return }
  if (!subs.length) return
  const slug = curSlug()
  const payload = { event, at: now(), data }
  for (const sub of subs) {
    const deliveryId = Number(run('INSERT INTO webhook_deliveries (subscription_id, event, payload, status, next_attempt_at) VALUES (?,?,?,?,?)',
      sub.id, event, JSON.stringify(payload), 'pending', now()).lastInsertRowid)
    // One immediate attempt for responsiveness; every retry after that is owned by the tick drain
    // (retryDueWebhooks), which reads next_attempt_at from the row — so a restart mid-wait resumes
    // the retry instead of losing it. No in-process setTimeout to drop on a deploy.
    attemptWebhookDelivery(slug, { id: deliveryId, url: sub.url, secret: sub.secret, event, payload, attempts: 0 })
  }
}

// Backoff schedule by attempt number (0-indexed): first retry ~30s out, then 5 minutes. Capped at
// MAX_WEBHOOK_ATTEMPTS total tries, after which the delivery is 'failed' and stops.
const MAX_WEBHOOK_ATTEMPTS = 3
const webhookBackoffMs = (attempts) => (attempts <= 1 ? 30_000 : 300_000)

// Deliver once, record the outcome, and — on a retryable failure — stamp next_attempt_at so the
// tick can pick it up later. Runs after the response, so it must never throw into an empty stack.
function attemptWebhookDelivery(slug, d) {
  const n = (Number(d.attempts) || 0) + 1
  deliverWebhook(d.url, d.payload, { secret: d.secret, event: d.event }).then((r) => {
    try {
      withSlugDb(slug, () => {
        if (r.ok) {
          run("UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, delivered_at = ?, last_error = NULL, next_attempt_at = NULL WHERE id = ?", n, now(), d.id)
        } else if (n < MAX_WEBHOOK_ATTEMPTS) {
          const next = new Date(Date.now() + webhookBackoffMs(n)).toISOString().replace('T', ' ').slice(0, 19)
          run("UPDATE webhook_deliveries SET status = 'retrying', attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?", n, String(r.error || '').slice(0, 200), next, d.id)
        } else {
          run("UPDATE webhook_deliveries SET status = 'failed', attempts = ?, last_error = ?, next_attempt_at = NULL WHERE id = ?", n, String(r.error || '').slice(0, 200), d.id)
        }
      })
    } catch (e) { console.error('webhook delivery log:', e && e.message) }
  }).catch(() => {})
}

/**
 * Drain webhook deliveries whose retry time has come. This is the durable half of the retry:
 * dispatchSubscriptions does one immediate attempt, and everything after that is picked up here
 * from next_attempt_at — so a deploy or crash during a backoff wait resumes the retry rather than
 * stranding the delivery in 'retrying' forever. Rescues 'pending' rows too (a process that died
 * between the INSERT and the first attempt). Runs inside a tenant context, like the QBO drain.
 */
function retryDueWebhooks(limit = 20) {
  const due = all(
    `SELECT d.id, d.attempts, d.payload, s.url, s.secret, d.event
       FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id = d.subscription_id
      WHERE s.active = 1 AND d.status IN ('retrying', 'pending')
        AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)
        AND d.attempts < ?
      ORDER BY d.id LIMIT ?`,
    now(), MAX_WEBHOOK_ATTEMPTS, limit,
  )
  const slug = curSlug()
  for (const row of due) {
    // Claim it so two overlapping ticks can't double-send: bump next_attempt_at forward first.
    const hold = new Date(Date.now() + 60_000).toISOString().replace('T', ' ').slice(0, 19)
    run("UPDATE webhook_deliveries SET next_attempt_at = ? WHERE id = ?", hold, row.id)
    let payload
    try { payload = JSON.parse(row.payload) } catch { payload = { event: row.event } }
    attemptWebhookDelivery(slug, { id: row.id, url: row.url, secret: row.secret, event: row.event, payload, attempts: row.attempts })
  }
  return due.length
}

// Small, stable event payloads: ids + the human-facing numbers, never whole rows (a webhook
// body ends up in other systems' logs — keep money fields, drop notes/PII beyond the basics).
function subscriptionData(ctx) {
  const c = ctx || {}
  const out = {}
  if (c.contact) out.contact = { id: c.contact.id, name: c.contact.name, company: c.contact.company || '', email: c.contact.email || '' }
  if (c.estimate) out.estimate = { id: c.estimate.id, number: c.estimate.estimate_number, status: c.estimate.status, total: c.estimate.total }
  if (c.invoice) out.invoice = { id: c.invoice.id, number: c.invoice.invoice_number, status: c.invoice.status, amount_due: c.invoice.amount_due, amount_paid: c.invoice.amount_paid, due_date: c.invoice.due_date }
  if (c.job) out.job = { id: c.job.id, number: c.job.job_number, title: c.job.title, stage: c.job.stage, due_date: c.job.due_date }
  if (c.opportunity) out.opportunity = { id: c.opportunity.id, title: c.opportunity.title, stage: c.opportunity.stage, value: c.opportunity.value }
  if (c.days != null) out.days = c.days
  return out
}

const fireAuto = (trigger, ctx) => {
  try { fire(trigger, ctx, autoDeps) } catch (e) { console.error('automation:', e.message) }
  try { dispatchSubscriptions(trigger, subscriptionData(ctx)) } catch (e) { console.error('webhook dispatch:', e.message) }
}

// AI-created contacts (receptionist, quick-quote/autopilot) create their rows inside lib/, which
// cannot import this file — they emit a signal through db.mjs instead. Wire it to the same
// automation dispatch the manual and API paths use, so a bot-captured lead gets the nurture drip.
onContactCreated((contact) => { try { fireAuto('contact.created', { contact }) } catch (e) { console.error('contact.created:', e && e.message) } })

/* ================= AUTH & MULTI-TENANCY =================
 * When PSC_AUTH=1, every request is resolved to a logged-in shop and run inside that shop's
 * own isolated database. When it is unset (single-tenant dev), everything uses the default
 * database and the gate is a no-op — the existing local workflow is unchanged. */
const AUTH_ENABLED = process.env.PSC_AUTH === '1'

const parseCookies = (req) => {
  const out = {}
  ;(req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=')
    if (i <= 0) return
    const raw = p.slice(i + 1).trim()
    // decodeURIComponent THROWS on a malformed percent-escape ("%", "%zz", "%e0%a4"), and a cookie
    // is attacker-controlled — a browser or a curl can send any bytes. This runs on every request
    // before the auth gate, so one bad cookie 500'd every route, login included: a single
    // malformed value locked the user out of their own shop until they cleared site data. Decode
    // defensively and fall back to the raw value rather than taking down the request.
    let val = raw
    try { val = decodeURIComponent(raw) } catch { /* keep the raw bytes */ }
    out[p.slice(0, i).trim()] = val
  })
  return out
}
// Secure is keyed off the actual request protocol (works behind a TLS-terminating proxy via
// x-forwarded-proto), not the auth flag — so http://localhost testing works and prod stays secure.
const isHttps = (req) => req.secure || req.headers['x-forwarded-proto'] === 'https'
const setSessionCookie = (res, tok, req) =>
  res.setHeader('Set-Cookie', `psc_session=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 864e2}${isHttps(req) ? '; Secure' : ''}`)
const clearSessionCookie = (res) =>
  res.setHeader('Set-Cookie', 'psc_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0')

// Lower-cased path for gate decisions, so the gate never disagrees with the case-sensitive router
// about what counts as an /api/ route.
const gatePath = (req) => String(req.path || '').toLowerCase()
const isApiPath = (lp) => lp === '/api' || lp.startsWith('/api/')
// API paths that never require a logged-in shop.
const isPublicApi = (p) => p.startsWith('/api/auth/') || p.startsWith('/api/embed/') || p === '/api/capture' || /^\/api\/slack\/[^/]+\/(events|command)$/.test(p)

// Role hierarchy for gating. In single-tenant dev (no auth) every check passes as owner.
const hasRole = (req, min) => !AUTH_ENABLED || (ROLE_RANK[req.role] || 0) >= (ROLE_RANK[min] || 0)
const requireRole = (min) => (req, res, next) => hasRole(req, min) ? next() : res.status(403).json({ error: `This needs ${min} access.`, code: 'forbidden' })

// The gate. A valid session runs the request inside its shop's database via AsyncLocalStorage,
// with the signed-in member and their role attached for permission checks.
app.use((req, res, next) => {
  if (!AUTH_ENABLED) return next()
  const lp = gatePath(req)
  // A caller that sent an API key has told us which shop this request is for. A browser cookie
  // that happens to ride the same connection must never answer for it. The session branch below
  // ran first and returned, so a cookie silently overrode the key: an INVALID key returned 200, a
  // REVOKED key returned 200 — and revoking is a shop's only response to a leak — a key belonging
  // to a DIFFERENT shop was served (and written into) the cookie's shop, and the published 120/min
  // limiter never ran. Every integration built or debugged in a browser holds both.
  // Only a Bearer psc_… on /api/v1 suppresses the cookie; a plain cookie request to /api/v1 still
  // authenticates as the session with its real role, which is what requireRole() there depends on.
  const bearer = lp.startsWith('/api/v1/') ? /^Bearer\s+(psc_\S+)$/i.exec(req.headers.authorization || '') : null
  const session = bearer ? null : getSession(parseCookies(req).psc_session)
  if (session) {
    const { tenant, member } = session
    req.tenant = tenant
    req.member = member
    req.role = member?.role || 'staff'
    // A host an OWNER really signed in on is the only host we have any evidence for. Remember it,
    // so an emailed reset link never has to trust a Host header a stranger chose — trustedOrigin().
    if (req.role === 'owner' && req.method === 'GET') rememberPublicOrigin(req)
    // Soft paywall: once the trial lapses with no plan, block new work (writes) but keep read + billing open.
    const isWrite = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE'
    const exempt = lp.startsWith('/api/auth/') || lp.startsWith('/api/billing') || lp.startsWith('/api/admin/') || lp.startsWith('/api/onboarding') || lp.startsWith('/api/stripe/')
    if (isWrite && isApiPath(lp) && !exempt && billingState(tenant).locked) {
      return res.status(402).json({ error: 'Your free trial has ended — choose a plan to keep working.', code: 'payment_required' })
    }
    return tenantStore.run({ db: openTenantDb(tenant.slug), slug: tenant.slug, tenant }, () => next())
  }
  // Public REST API: Authorization: Bearer psc_live_… resolves the shop the same way a session
  // does — same store shape, same billing paywall — so every /api/v1 handler runs in the right
  // tenant database. Available on EVERY plan; the incumbents gate this behind their top tier.
  if (lp.startsWith('/api/v1/')) {
    const tenant = bearer ? getTenantByApiKey(bearer[1]) : null
    if (!tenant) return res.status(401).json({ error: 'Provide your API key: Authorization: Bearer psc_live_…  (Settings → Developers)', code: 'invalid_api_key' })
    // Mirror the session rule: a lapsed shop can still READ (so an integration can export its own
    // data — the Data Freedom promise is worth nothing if a lapsed shop is locked out of it) but
    // cannot create new work until it subscribes.
    const isWriteReq = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE'
    if (isWriteReq && billingState(tenant).locked) return res.status(402).json({ error: 'This shop’s trial has ended — choose a plan to keep creating work. Reads still work so you can export.', code: 'payment_required' })
    const lim = apiV1RateLimit(tenant.id)
    if (lim) {
      res.setHeader('Retry-After', String(lim))
      res.setHeader('X-RateLimit-Limit', '120')
      res.setHeader('X-RateLimit-Remaining', '0')
      return res.status(429).json({ error: `Rate limit exceeded (120 requests/min). Retry in ${lim}s.`, code: 'rate_limited' })
    }
    req.tenant = tenant
    req.role = 'manager'
    req.apiKeyAuth = true
    return tenantStore.run({ db: openTenantDb(tenant.slug), slug: tenant.slug, tenant }, () => next())
  }
  if (isApiPath(lp)) {
    if (isPublicApi(lp)) return next()
    return res.status(401).json({ error: 'Not signed in' })
  }
  return next() // the SPA shell, static assets, /login, /signup, /embed, /p/ serve themselves
})

// Published, honest rate limit for the public API: 120 req/min per shop, sliding minute window.
// Printavo's is 10 requests per 5 seconds on an unpublished-price tier; ours is on every plan.
const apiV1Hits = new Map()
function apiV1RateLimit(tenantId) {
  const now = Date.now()
  const hits = (apiV1Hits.get(tenantId) || []).filter((t) => now - t < 60_000)
  // Return the TRUE wait, so an obedient client's retry doesn't land inside the same window.
  if (hits.length >= 120) { apiV1Hits.set(tenantId, hits); return Math.max(1, Math.ceil((60_000 - (now - hits[0])) / 1000)) }
  hits.push(now)
  apiV1Hits.set(tenantId, hits)
  return 0
}
setInterval(() => {
  const now = Date.now()
  for (const [k, hits] of apiV1Hits) {
    const live = hits.filter((t) => now - t < 60_000)
    if (live.length) apiV1Hits.set(k, live)
    else apiV1Hits.delete(k)
  }
}, 120_000).unref()

/**
 * Re-enter the shop's database context after a multipart body has been parsed.
 *
 * The gate above establishes the tenant inside tenantStore.run(...), but multer consumes the
 * request stream and its completion callback fires from the socket's async resource — created
 * before that scope existed — so the store is gone by the time the route handler runs. Every query
 * then silently falls back to getDb()'s shared default database: CSV imports were written into a
 * pooled file the shop never reads back (it saw "created: N" and zero new customers), and art
 * uploads attached to whatever job happened to hold that id there. express.json is unaffected
 * because it is registered before the gate.
 *
 * Must sit AFTER the multer middleware and BEFORE the handler. Mirrors the gate's store shape.
 */
/**
 * Lite plan gate. In the Print Shop Control edition, the catalog and the pricing matrix are what the
 * $40 plan buys, so a Free shop's requests for them are refused with a 402 the client turns into an
 * upgrade prompt. Deliberately narrow: estimates, invoices, customers, payments and settings are
 * never gated, so a Free shop can always do the thing it signed up for — invoice and get paid.
 *
 * Registered after the auth gate (needs req.tenant) and before the routes it protects. No-ops
 * entirely in pro, where every plan includes these.
 */
// Feature gating removed 2026-08-21: one product, every feature, every shop. Kept as a pass-through
// so the middleware chain and its registration site stay intact (and so there is exactly one place
// a future gate would have to be re-argued). See lib/billing.mjs for the reasoning.
const litePlanGate = (_req, _res, next) => next()

const reTenant = (req, _res, next) => (
  AUTH_ENABLED && req.tenant
    ? tenantStore.run({ db: openTenantDb(req.tenant.slug), slug: req.tenant.slug, tenant: req.tenant }, () => next())
    : next()
)

app.use(litePlanGate)

/**
 * Liveness AND readiness. This answered `{ok:true}` unconditionally, which meant it stayed 200
 * while the database behind it was unopenable — and deploy/ship.sh now rolls a release back on
 * this endpoint, so a health check that cannot fail is a rollback that never fires. Touch the
 * database: a locked, missing or closed handle is exactly the failure a restart needs to catch.
 */
app.get('/health', (_req, res) => {
  // A WRITE probe, not `SELECT 1`. On a full disk reads keep working while every write fails, so
  // the old read-only check answered {"ok":true} 200 while the shop could not save anything —
  // and this is the signal deploy/ship.sh polls to decide whether to roll back a release.
  const w = canWrite()
  if (!w.ok) {
    console.error('health:', w.detail)
    return res.status(503).json({ ok: false, error: w.error })
  }
  // ...and canWrite() with no tenant context probes the DEFAULT database, which in multi-tenant
  // mode holds no shop at all. A release whose migration threw on one shop's real data left that
  // shop 100% down — login succeeded, then every screen answered "Something went wrong on our
  // end." forever — while this endpoint answered {"ok":true} throughout, and ship.sh polls
  // exactly this to decide whether to roll back. The deploy was declared successful with the
  // shops dark. Answer for the databases that actually hold shops.
  const broken = AUTH_ENABLED ? [...brokenTenants.keys()] : []
  if (broken.length) {
    return res.status(503).json({ ok: false, error: `${broken.length} shop database(s) unavailable`, shops: broken.slice(0, 20) })
  }
  res.json({ ok: true })
})

/**
 * Login/signup rate limiter — a brute-force brake. In-memory sliding window keyed by client IP
 * (and, for login, the target email), so spraying passwords from one IP trips it. Successful
 * logins clear the counter. Single-process app, so a Map is enough; behind a proxy it honors
 * X-Forwarded-For's first hop.
 *
 * NOTE: because the key includes the IP, this alone does NOT stop one account being guessed from
 * many IPs — each host simply gets its own fresh bucket. loginBackoff() below closes that gap.
 */
const rlHits = new Map()
setInterval(() => { const now = Date.now(); for (const [k, v] of rlHits) if (now - v.first > v.win) rlHits.delete(k) }, 60_000).unref?.()
// req.ip (with `trust proxy: 1`) is the real client as seen past exactly one proxy hop (nginx) —
// a client-supplied X-Forwarded-For can't spoof it. Reading the raw header's first entry could.
const clientIp = (req) => req.ip || req.socket?.remoteAddress || 'unknown'
// keyFn lets a route scope its bucket differently — login keys on the submitted email so one person
// fumbling their password can't lock out the rest of an office behind the same NAT IP, while the
// anonymous embed routes key on IP+shop since there is no email to key on.
function rateLimit({ windowMs = 15 * 60_000, max = 12, keyFn = null, message = null } = {}) {
  return (req, res, next) => {
    const key = keyFn ? `${req.path}:${keyFn(req)}` : `${req.path}:${clientIp(req)}:${String(req.body?.email || '').toLowerCase()}`
    const now = Date.now()
    let e = rlHits.get(key)
    if (!e || now - e.first > windowMs) { e = { first: now, count: 0, win: windowMs }; rlHits.set(key, e) }
    e.count++
    if (e.count > max) {
      const retry = Math.ceil((e.first + windowMs - now) / 1000)
      res.setHeader('Retry-After', String(retry))
      return res.status(429).json({ error: message || `Too many attempts. Try again in ${Math.ceil(retry / 60)} minute(s).`, code: 'rate_limited' })
    }
    req._rlKey = key
    next()
  }
}
// The embed chat is unauthenticated and the shop key is public (it sits in the widget script tag on
// the shop's own website), so anyone can call it. Each message runs a billed LLM call and writes a
// chat_sessions row, so without a cap one scraper can burn a shop's AI budget and grow its DB
// unbounded. Scoped per IP+shop so one abuser can't throttle a different shop's real visitors.
//
// The shop half of that key is the RESOLVED shop, not the string the caller sent — which is the
// mistake the comment three lines below already describes for signup and lead capture. On a
// single-tenant install (PSC_AUTH unset, which is the default for every self-hoster) embedRun
// does not validate ?shop= at all, so varying it minted a fresh bucket per request: 300 chat
// messages accepted from one IP against a designed ceiling of 180, up to 900 model calls billed
// to the shop's own API key. An unresolvable key shares one bucket, so hammering junk keys is
// throttled rather than free.
const embedBucketOf = (req) => {
  if (!AUTH_ENABLED) return 'single'  // one shop; a caller-chosen string must not mint buckets
  const raw = String(req.query.shop || req.body?.shop || req.query.s || '')
  const t = raw ? getTenantByEmbedKey(raw) : null
  return t ? t.slug : 'unknown'
}
const embedLimit = (max, message) => rateLimit({ windowMs: 15 * 60_000, max, message, keyFn: (req) => `${clientIp(req)}:${embedBucketOf(req)}` })
// Signup and lead capture also take an email, but there it is the *caller's* choice rather than a
// target account: mixing it into the key let one host mint an unlimited number of fresh buckets by
// varying the field, so those routes get a plain per-IP ceiling instead.
const ipLimit = (max) => rateLimit({ max, keyFn: clientIp })
const clearRateLimit = (req) => { if (req._rlKey) rlHits.delete(req._rlKey) }

/**
 * Account-wide login backoff — the half the per-IP limiter can't cover.
 *
 * rateLimit() keys on IP+email, so a password spray spread over a botnet gets a fresh 12 guesses
 * per host and never trips it. This tracks consecutive failures against the ACCOUNT, wherever they
 * come from, and makes each one after the fourth cost exponentially more waiting: 30s, 60s, 2m,
 * 4m… capped at 15 minutes.
 *
 * It is a delay, not a permanent lockout, and a correct password clears it instantly — so someone
 * who knows a victim's email can slow that account down but can never lock them out of their shop.
 * Counters live in memory: a restart forgives everyone, which is the safe direction to fail.
 */
const loginFails = new Map()
const FAIL_GRACE = 4          // honest typos shouldn't cost anything
const FAIL_CAP_MS = 15 * 60_000
setInterval(() => { const t = Date.now(); for (const [k, v] of loginFails) if (t - v.last > FAIL_CAP_MS) loginFails.delete(k) }, 60_000).unref?.()
const acctKey = (email) => String(email || '').trim().toLowerCase()

/** How much longer this account must wait, in seconds (0 = go ahead). */
function loginBackoff(email) {
  const e = loginFails.get(acctKey(email))
  if (!e || !e.until) return 0
  return Math.max(0, Math.ceil((e.until - Date.now()) / 1000))
}
function recordLoginFail(email) {
  const k = acctKey(email)
  if (!k) return
  const e = loginFails.get(k) || { count: 0, until: 0, last: 0 }
  e.count++
  e.last = Date.now()
  if (e.count > FAIL_GRACE) e.until = e.last + Math.min(FAIL_CAP_MS, 30_000 * 2 ** (e.count - FAIL_GRACE - 1))
  loginFails.set(k, e)
}
const clearLoginFails = (email) => loginFails.delete(acctKey(email))

app.post('/api/auth/signup', ipLimit(6), wrap(async (req, res) => {
  if (!AUTH_ENABLED) return res.status(400).json({ error: 'Signups are disabled in single-tenant mode' })
  const b = req.body || {}
  // Honeypot: the form carries an off-screen "website" field no human can see or tab into, so
  // anything in it means a script filled every input on the page. Answer 200 with a plausible
  // shape and create nothing — a bot that gets a clean error learns to try again without it.
  if (String(b.website || '').trim()) {
    console.log('signup honeypot tripped from', clientIp(req))
    return res.json({ ok: true, slug: 'pending', shop_name: b.shop_name || '', onboarding: true })
  }
  // requireAdmin() grants the Control Room — the shop list, delete, suspend and one-click sign-in
  // as any shop — on one test: isAdminEmail(tenant.owner_email). tenants.owner_email is written in
  // exactly one place, createTenant(), reached from THIS unauthenticated form, and nothing
  // reserved the address. An operator sets PSC_ADMIN_EMAIL and restarts; the app is live from that
  // second and their own account does not exist until they register. Whoever signs up with it
  // first owns the platform. It is normally the support address printed on the operator's own
  // site, so it is not a guess. The operator makes their shop with `npm run admin -- create-shop`.
  if (isAdminEmail(b.owner_email || b.email)) {
    return res.status(403).json({ error: 'That address is reserved for this install\u2019s operator. Use another one.', code: 'reserved_email' })
  }
  try {
    const t = await createTenant({ shop_name: b.shop_name, owner_name: b.owner_name, owner_email: b.owner_email || b.email, password: b.password })
    // Bind the session to the owner's own member row. Left null it falls back to "first owner by
    // id" on every request — unrevocable by deleteMember, and it resolves to nobody (dropping the
    // founder to 'staff' mid-session) the day that owner is demoted.
    const owner = listMembers(t.id).find((m) => m.role === 'owner')
    setSessionCookie(res, createSession(t.id, owner?.id || null), req)
    sendWelcomeEmail(t, trustedOrigin(req, t)) // fire-and-forget; delivers if platform SMTP is set
    res.json({ ok: true, slug: t.slug, shop_name: t.shop_name, onboarding: true })
  } catch (e) {
    res.status(e.code === 'dupe_email' ? 409 : 400).json({ error: e.message })
  }
}))

/**
 * Change your own password.
 *
 * There was previously no way to do this anywhere in the product, while the staff-invite email
 * instructed every new hire to "change your password from your profile". Emailed temporary
 * passwords were therefore permanent, and a forgotten owner password orphaned the whole shop.
 *
 * Requires the current password so a borrowed/stolen session can't lock the real owner out.
 */
app.post('/api/auth/password', rateLimit({ max: 10 }), wrap(async (req, res) => {
  if (!AUTH_ENABLED || !req.member) return res.status(401).json({ error: 'Sign in first.' })
  const cur = String(req.body?.current_password || '')
  const next = String(req.body?.new_password || '')
  if (!cur || !next) return res.status(400).json({ error: 'Enter your current password and a new one.' })
  if (next.length < MIN_PASSWORD) return res.status(400).json({ error: `Your new password needs at least ${MIN_PASSWORD} characters.` })
  if (!await verifyMemberPassword(req.member.id, cur)) return res.status(401).json({ error: "That current password isn't right." })
  await setMemberPassword(req.member.id, next)
  // Owners also carry a legacy hash on the tenant row; leaving it stale would keep the old
  // password working through authTenant.
  if (req.role === 'owner' && req.tenant) await setPassword(req.tenant.id, next)
  // setMemberPassword just signed out every session for this member, including this one. Mint a
  // fresh session for the device that made the change, so the person changing their password stays
  // signed in here while any other logged-in session — the one they are worried about — is dropped.
  setSessionCookie(res, createSession(req.member.tenant_id, req.member.id), req)
  clearRateLimit(req)
  res.json({ ok: true })
}))

/**
 * Forgotten password — request a reset link.
 *
 * Always answers the same way whether or not the address has an account. Saying "no such user"
 * would turn this into a free membership check against any email list, and the shops on here are
 * exactly the audience a competitor would like to enumerate.
 *
 * Capped per-IP and per-address so it can't be used to flood someone's inbox.
 */
app.post('/api/auth/forgot', ipLimit(6), rateLimit({ max: 4 }), wrap((req, res) => {
  if (!AUTH_ENABLED) return res.status(400).json({ error: 'Password reset is unavailable in single-tenant mode' })
  const email = String(req.body?.email || '').trim()
  const generic = { ok: true, message: 'If that email has an account, a reset link is on its way.' }
  // Before promising a link, check that this install can send one at all. Reset mail goes out on
  // the SERVER's own mail — `platform: true` below, with no shop SMTP behind it — so on an install
  // with none of the three arrangements configured the answer is always "nothing will arrive", and
  // the owner sat waiting, retried, hit the 4/hour limit, and was locked out of a database sitting
  // on their own disk. The fix was logged to stdout, where someone running under systemd or Docker
  // will never see it.
  //
  // This is an install-wide fact, not a per-address one, so answering honestly reveals nothing
  // about whether the account exists — the enumeration guard below still stands.
  // Ask whether ANY route can deliver it, not whether one particular relay is wired up. Gating on
  // GoHighLevel alone refused installs whose SMTP_HOST/USER/PASS — the arrangement .env.example
  // documents — would have sent the mail, and then told the owner to fix it in a Settings card that
  // does not exist in this edition and would not have applied to reset mail if it did.
  if (!platformEmailDeliverable()) {
    return res.status(503).json({
      ok: false,
      error: 'This install has no email configured, so a reset link cannot be sent.',
      fix: `Whoever runs this server can set the password directly:\n  npm run admin -- reset-password ${email || '<your-email>'}\n\nReset mail goes out on the SERVER's own mail settings, not a shop's. To make this work next time set SMTP_HOST / SMTP_USER / SMTP_PASS (or PSC_POSTMARK_TOKEN, or PSC_RESEND_KEY) in the server's .env and restart — see .env.example.`,
    })
  }
  if (!email) return res.json(generic)
  let r = null
  try { r = createPasswordReset(email) } catch (e) { console.error('reset create:', e.message) }
  if (!r) return res.json(generic) // unknown address — identical response, nothing sent
  // NEVER build this from the raw Host header. The link carries a one-time token that sets the
  // account password, and Host is chosen by whoever sent the request — so `Host: evil.example`
  // mailed the real owner a working reset link pointing at the attacker, who then owned the shop.
  // trustedOrigin() prefers PSC_PUBLIC_URL and then the host an owner has actually signed in on,
  // and only falls back to this request's Host on an install where neither exists yet.
  const origin = trustedOrigin(req, r.tenant)
  const link = `${origin}/reset?token=${encodeURIComponent(r.token)}`
  const body = `Hi${r.member.name ? ' ' + r.member.name : ''},

Someone asked to reset the password for your ${BRAND_NAME} account (${r.member.email}).

Set a new password: ${link}

This link works once and expires in 60 minutes. If you didn't ask for it you can ignore this email — your password stays as it is.

— The ${BRAND_NAME} team`
  sendEmail({ to: r.member.email, toName: r.member.name, subject: `Reset your ${BRAND_NAME} password`, body, settings: { shop_name: BRAND_NAME }, platform: true })
    .then((d) => {
      if (d.delivered) return console.log('reset email sent via', d.via, 'to', r.member.email)
      // No mail configured — the user is staring at "a reset link is on its way" and nothing is
      // coming. Tell the operator, in the logs they can actually see, how to unlock the account.
      // The token itself is deliberately not logged: logs get shipped to aggregators, and the
      // offline command below is a better path anyway.
      console.warn(`reset email NOT delivered to ${r.member.email} — no mail is configured.${d.error ? ' (' + d.error + ')' : ''}`)
      console.warn(`  → unlock it from the server:  npm run admin -- reset-password ${r.member.email}`)
    })
    .catch((e) => console.error('reset email:', e.message))
  res.json(generic)
}))

/** Is this reset link still good? Lets /reset show "expired" instead of a form that will fail. */
app.get('/api/auth/reset', wrap((req, res) => {
  const found = checkPasswordReset(String(req.query.token || ''))
  res.json({ valid: !!found, email: found?.member?.email || null })
}))

/** Spend the token and set the new password. */
app.post('/api/auth/reset', ipLimit(10), wrap(async (req, res) => {
  if (!AUTH_ENABLED) return res.status(400).json({ error: 'Password reset is unavailable in single-tenant mode' })
  try {
    // Awaited: unawaited, this returned before the password was written and the detached write then
    // deleted the session minted two lines below, bouncing every reset back to the login form.
    const { member } = await consumePasswordReset(String(req.body?.token || ''), String(req.body?.password || ''))
    // Every old session for this member was just dropped, so sign them straight into a new one
    // rather than bouncing them to a login form with a password they only typed a second ago.
    setSessionCookie(res, createSession(member.tenant_id, member.id), req)
    clearLoginFails(member.email) // the reset is proof enough; don't leave them in a backoff window
    res.json({ ok: true })
  } catch (e) {
    res.status(e.code === 'bad_token' ? 410 : 400).json({ error: e.message })
  }
}))

app.get('/reset', (_req, res) => res.type('html').send(authHtml()))

// CORS for the public capture endpoint — the marketing site (printshopcrm.com) is a different origin
// than this app (pro.printshopcrm.com), so the browser needs an explicit allow. Scoped to the two
// marketing origins and this one endpoint; nothing else on the app is cross-origin accessible.
const CAPTURE_ORIGINS = new Set(['https://printshopcrm.com', 'https://www.printshopcrm.com'])
function captureCors(req, res) {
  const origin = req.get('origin')
  if (origin && CAPTURE_ORIGINS.has(origin)) {
    res.set('Access-Control-Allow-Origin', origin)
    res.set('Vary', 'Origin')
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.set('Access-Control-Allow-Headers', 'Content-Type')
  }
}
app.options('/api/capture', (req, res) => { captureCors(req, res); res.status(204).end() })

/**
 * Public lead capture from the marketing landing page. A visitor who isn't ready to create an
 * account yet leaves just an email; we save+tag them in GHL and send the trial link, so a landing
 * view is no longer a dead end. Never creates a tenant — that's what /signup is for.
 */
app.post('/api/capture', ipLimit(10), wrap(async (req, res) => {
  captureCors(req, res)
  const b = req.body || {}
  const email = String(b.email || '').trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'A valid email is required' })
  try {
    const r = await captureLead({ email, name: b.name, shop: b.shop, source: b.source || 'landing' })
    if (!r.ok) return res.status(502).json({ error: 'Could not save right now — please try again' })
    // Enroll into the follow-up drip (day-0 was just sent by captureLead; the rest fires on schedule).
    try { enrollNurture({ email, name: b.name, shop: b.shop, source: b.source || 'landing' }, Date.now()) } catch (e) { console.error('nurture enroll:', e.message) }
    res.json({ ok: true, emailed: r.emailed })
  } catch (e) { res.status(502).json({ error: String(e.message || e).slice(0, 160) }) }
}))

// One-click unsubscribe from the nurture drip (CAN-SPAM). Public, GET so the email link just works.
app.get('/unsub', (req, res) => {
  try { stopNurtureByToken(String(req.query.t || '')) } catch { /* ignore — always confirm */ }
  res.set('Content-Type', 'text/html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1220;color:#e6edf3;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0"><div style="text-align:center;max-width:420px;padding:24px"><h1 style="font-size:20px;margin:0 0 8px">You're unsubscribed</h1><p style="color:#9aa4b2;line-height:1.6">You won't get any more PrintShopCRM emails. Changed your mind? You can always <a href="https://pro.printshopcrm.com/signup" style="color:#3ba">start a free trial</a>.</p></div></body>`)
})

/**
 * Welcome a self-serve signup. Delivers via platform SMTP when configured (the shop is brand new
 * and has none of its own yet); silently no-ops otherwise, so a missing relay never breaks signup.
 * They're already logged in and dropped into the wizard, so this is a friendly confirmation.
 */
function sendWelcomeEmail(tenant, origin) {
  const to = tenant.owner_email
  // Edition-aware: lite ships as its own product (Print Shop Control), and its setup is one screen
  // with no distributor/AI/Stripe-key steps — promising those would send a new shop looking for
  // screens that its edition doesn't have.
  const setupLine = EDITION === 'lite'
    ? 'When you sign in, a one-screen setup asks for your shop name and logo, and your pricing is already built in. It takes about a minute.'
    : 'When you sign in, a short guided setup walks you through your pricing, your own Stripe and AI keys, distributor accounts, and importing your customers from a CSV. Every step is optional and you can finish it later.'
  const body = `Hi${tenant.owner_name ? ' ' + tenant.owner_name : ''},

Welcome to ${BRAND_NAME} — your ${tenant.shop_name} account is live and your 30-day free trial has started.

Sign in anytime: ${origin}/login
Your email: ${to}

${setupLine}

Anything you need, just reply.

— The ${BRAND_NAME} team`
  sendEmail({ to, toName: tenant.owner_name, subject: `Welcome to ${BRAND_NAME} — ${tenant.shop_name} is ready`, body, settings: { shop_name: BRAND_NAME }, platform: true })
    .then((r) => { if (!r.delivered) console.log('welcome email not delivered (no platform relay):', to, r.error || ''); else console.log('welcome email sent via', r.via, 'to', to) })
    .catch((e) => console.error('welcome email:', e.message))
}

/**
 * Email a newly-added staff member their own login. The owner set a temporary password when adding
 * them; we hand it to the person directly so the owner doesn't have to relay it, and nudge them to
 * change it on first sign-in. Platform mail (the shop may have no SMTP), so it routes via GHL.
 */
function sendStaffInviteEmail({ tenant, member, tempPassword, inviterName, origin }) {
  const to = member.email
  if (!to) return
  const roleWord = member.role === 'manager' ? 'a manager' : member.role === 'owner' ? 'an owner' : 'a team member'
  const body = `Hi${member.name ? ' ' + member.name : ''},

${inviterName ? inviterName + ' added you' : "You've been added"} to ${tenant.shop_name} on ${BRAND_NAME} as ${roleWord}.

SIGN IN
Web address: ${origin}/login
Email: ${to}
Temporary password: ${tempPassword}

Please sign in and change your password from your profile the first time you're in. If you weren't expecting this, you can ignore this email.`
  sendEmail({ to, toName: member.name, subject: `You've been added to ${tenant.shop_name} on ${BRAND_NAME}`, body, settings: { shop_name: BRAND_NAME }, platform: true })
    .then((r) => { if (!r.delivered) console.log('staff invite not delivered (no platform relay):', to, r.error || ''); else console.log('staff invite sent via', r.via, 'to', to) })
    .catch((e) => console.error('staff invite email:', e.message))
}

app.post('/api/auth/login', rateLimit({ max: 12 }), wrap(async (req, res) => {
  const b = req.body || {}
  // Account-wide backoff first: this is what a distributed spray runs into, since the per-IP
  // window above hands every new host its own budget.
  const wait = loginBackoff(b.email)
  if (wait > 0) {
    res.setHeader('Retry-After', String(wait))
    return res.status(429).json({ error: `Too many failed sign-ins for this account. Try again in ${wait < 60 ? `${wait} seconds` : `${Math.ceil(wait / 60)} minute(s)`}.`, code: 'rate_limited' })
  }
  const r = await authMember(b.email, b.password)
  if (!r) {
    recordLoginFail(b.email)
    return res.status(401).json({ error: 'Wrong email or password' })
  }
  // The password was RIGHT. Do not count it as a failure — the account backoff is for guessing,
  // and a suspended owner retrying their own correct password used to walk straight into it on
  // top of being told the password was wrong. Name the real reason and who can lift it.
  if (r.blocked === 'member_disabled') {
    return res.status(403).json({
      error: 'Your access to this shop was turned off. Ask an owner to switch it back on in Settings → Staff & Logins.',
      code: 'member_disabled',
    })
  }
  if (r.blocked) {
    return res.status(403).json({
      error: `This shop's account is ${r.tenant.status}. Your password is correct — contact your provider to reopen it.`,
      code: 'tenant_suspended',
    })
  }
  clearRateLimit(req) // a correct login shouldn't count against the window
  clearLoginFails(b.email)
  setSessionCookie(res, createSession(r.tenant.id, r.member.id), req)
  res.json({ ok: true, slug: r.tenant.slug, shop_name: r.tenant.shop_name, role: r.member.role })
}))

app.post('/api/auth/logout', wrap((req, res) => {
  deleteSession(parseCookies(req).psc_session)
  clearSessionCookie(res)
  res.json({ ok: true })
}))

app.get('/api/auth/me', wrap((req, res) => {
  if (!AUTH_ENABLED) return res.json({ authed: true, single_tenant: true, shop_name: getSettings().shop_name, role: 'owner', can_manage: true, is_owner: true })
  if (!req.tenant) return res.json({ authed: false })
  const onboarding = parse(req.tenant.onboarding, {})
  res.json({
    authed: true, shop_name: req.tenant.shop_name, slug: req.tenant.slug, embed_key: req.tenant.embed_key,
    onboarding_done: !!onboarding.done, is_admin: isAdminEmail(req.tenant.owner_email),
    billing: billingState(req.tenant),
    // Who's signed in + what they may do — the client hides controls it isn't allowed to use.
    member: req.member ? { name: req.member.name, email: req.member.email, role: req.member.role } : null,
    role: req.role, is_owner: req.role === 'owner', can_manage: hasRole(req, 'manager'),
  })
}))

app.post('/api/auth/onboarding', wrap((req, res) => {
  if (req.tenant) saveOnboarding(req.tenant.id, { ...(req.body || {}), done: true })
  res.json({ ok: true })
}))

app.get(['/login', '/signup'], (_req, res) => res.type('html').send(authHtml()))

/* ---- AI-assisted onboarding ---- */

/** The welcome screen's state: shop name, guided-setup steps + progress, and the embed snippet key. */
app.get('/api/onboarding', wrap((req, res) => {
  const s = getSettings()
  const ctx = {
    stripeOn: paymentsReady(s),
    // The 'cli' provider runs on the platform's own OAuth'd Claude binary, so lib/ai.mjs only
    // honours it in single-tenant mode. Counting it as "connected" in production would tick the
    // onboarding checklist for a shop whose AI calls will actually be refused.
    aiOn: !!String(s.ai_api_key || '').trim() || (s.ai_provider === 'cli' && !AUTH_ENABLED),
    suppliersOn: supplierStatus(s).connected,
    customers: get('SELECT COUNT(*) AS n FROM contacts').n,
  }
  res.json({
    shop_name: s.shop_name,
    embed_key: req.tenant ? req.tenant.embed_key : '',
    checklist: onboardingChecklist(s),      // kept for any older client
    onboarding: onboardingSteps(s, ctx),    // the wizard's step list + progress
    service_defaults: SERVICE_DEFAULTS,
    service_pricing: parse(s.service_pricing, {}),
    // Current values the wizard prefills from (secrets stay redacted — only *_set flags leak).
    settings: publicSettings(),
  })
}))

/** Record a wizard step as done/skipped so setup can be resumed later. Merges into the progress map. */
app.post('/api/onboarding/step', wrap((req, res) => {
  const { key, status } = req.body || {}
  if (!key) return res.status(400).json({ error: 'Missing step key' })
  const prog = parse(getSettings().onboarding_progress, {})
  prog[String(key)] = status === 'done' ? 'done' : 'skipped'
  setSetting('onboarding_progress', JSON.stringify(prog))
  res.json({ ok: true, progress: prog })
}))

/** Save the shop's per-service pricing rules (multipliers vs. a screen-print base of 1.0). */
app.put('/api/onboarding/service-pricing', requireRole('manager'), wrap((req, res) => {
  const clean = {}
  for (const [k, v] of Object.entries(req.body || {})) {
    const n = Number(v)
    if (SERVICE_DEFAULTS[k] != null && n > 0 && n < 20) clean[k] = Math.round(n * 100) / 100
  }
  setSetting('service_pricing', JSON.stringify(clean))
  res.json({ ok: true, service_pricing: clean })
}))

/**
 * "Tell us about your shop" → configure settings from one plain-English description.
 * Deterministic parse; only sets values it actually finds; returns exactly what changed so the
 * owner can see it and edit anything in Settings. This is the "just say it" path — the manual
 * path (Settings) is always there and never limited.
 */
app.post('/api/onboarding/configure', requireRole('manager'), wrap((req, res) => {
  const { settings, applied, methods } = parseShopProfile((req.body || {}).description)
  for (const [k, v] of Object.entries(settings)) setSetting(k, v)
  res.json({ applied, methods, changed: Object.keys(settings).length })
}))

/* ---- subscription billing (shops pay PrintShopCRM) ---- */

app.get('/api/billing', wrap((req, res) => {
  // `order` drives what the billing page renders: one plan, everything included. PLANS still
  // carries the retired tier ids so an existing tenant row's plan_tier resolves to a name.
  res.json({ live: billingLive(), plans: PLANS, order: PLAN_ORDER, state: req.tenant ? billingState(req.tenant) : null })
}))

/** Start a subscription — returns a Stripe Checkout URL on the platform account. Owner-only. */
app.post('/api/billing/checkout', requireRole('owner'), async (req, res) => {
  try {
    if (!req.tenant) return res.status(401).json({ error: 'Not signed in' })
    if (!billingLive()) return res.status(503).json({ error: 'Billing is not live yet — the owner needs to connect the platform Stripe.' })
    const b = req.body || {}
    const origin = `${req.protocol}://${req.get('host')}`
    const { url } = await createSubscriptionCheckout({
      plan: b.plan, interval: b.interval === 'year' ? 'year' : 'month',
      email: req.tenant.owner_email, tenantId: req.tenant.id, slug: req.tenant.slug, origin,
    })
    res.json({ url })
  } catch (e) { console.error('checkout:', e); res.status(500).json({ error: e.message }) }
})

/**
 * Switch to the Free plan. There is nothing to charge, so this never touches Stripe — it just marks
 * the shop active on 'free', which billingState() treats as a never-locking plan (the platform earns
 * on the 4% payment fee instead of a subscription). Owner-only.
 *
 * A shop with a live paid subscription is sent to the Stripe portal instead: silently flipping them
 * to free here would leave Stripe still billing them $40 while the app said the plan was free.
 */
app.post('/api/billing/free', requireRole('owner'), wrap((req, res) => {
  if (!req.tenant) return res.status(401).json({ error: 'Not signed in' })
  // There is no free tier to switch to any more — one plan, everything included. Kept so an old
  // client build gets a clear answer instead of a confusing 404 from the SPA fallback.
  if (!LITE_PLAN_ORDER.includes('free')) return res.status(410).json({ error: 'PrintShopCRM is one plan with every feature — there is no separate Free tier to switch to.', code: 'plan_retired' })
  const st = billingState(req.tenant)
  if (st.subscribed && st.plan && st.plan !== 'free') {
    return res.status(409).json({ error: 'You have a paid subscription — cancel it from Manage subscription first, then switch to Free.', code: 'has_subscription' })
  }
  setSubscription(req.tenant.id, { plan: 'free', status: 'active' })
  res.json({ ok: true, plan: 'free' })
}))

/** Stripe billing portal so a subscribed shop can manage or cancel. Owner-only. */
app.post('/api/billing/portal', requireRole('owner'), async (req, res) => {
  try {
    const st = req.tenant ? billingState(req.tenant) : null
    if (!st?.stripe_customer_id) return res.status(400).json({ error: 'No subscription on file yet' })
    const origin = `${req.protocol}://${req.get('host')}`
    const { url } = await createBillingPortal({ customerId: st.stripe_customer_id, origin })
    res.json({ url })
  } catch (e) { console.error('portal:', e); res.status(500).json({ error: e.message }) }
})

/* ---- platform admin: connect the owner's Stripe (owner-only, key never sent back) ---- */

const requireAdmin = (req, res) => {
  // Platform-admin config (the owner's Stripe) requires BOTH the admin shop AND that the signed-in
  // member is that shop's owner — not merely any staff/manager of the admin shop.
  if (!req.tenant || !isAdminEmail(req.tenant.owner_email) || !hasRole(req, 'owner')) { res.status(403).json({ error: 'Admins only' }); return false }
  return true
}

app.get('/api/admin/billing', wrap((req, res) => {
  if (!requireAdmin(req, res)) return
  res.json({ is_admin: true, live: billingLive(), webhook_set: !!webhookSecret() })
}))

app.post('/api/admin/billing', wrap((req, res) => {
  if (!requireAdmin(req, res)) return
  const b = req.body || {}
  const cfg = {}
  if (typeof b.platform_secret === 'string' && b.platform_secret.trim()) cfg.platform_secret = b.platform_secret.trim()
  if (typeof b.webhook_secret === 'string') cfg.webhook_secret = b.webhook_secret.trim()
  setPlatformConfig(cfg)
  setPlatformCredentials({ secret: cfg.platform_secret, webhookSecret: cfg.webhook_secret })
  res.json({ ok: true, live: billingLive(), webhook_set: !!webhookSecret() })
}))

/* ---- platform admin: the control room for every shop on this deployment (admin-owner only) ---- */

app.get('/api/admin/shops', wrap((req, res) => {
  if (!requireAdmin(req, res)) return
  res.json({ shops: listTenantsAdmin(), admin_email: (process.env.PSC_ADMIN_EMAIL || '').toLowerCase() })
}))

// Create a client's shop for them (the hands-on onboarding Stan does) — returns the temp password
// once so it can be handed off. Never emails it from here; the admin shares it directly.
app.post('/api/admin/shops', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return
  const b = req.body || {}
  const password = String(b.password || '').trim() || Math.random().toString(36).slice(2, 6) + '-' + Math.random().toString(36).slice(2, 8)
  try {
    const t = await createTenant({ shop_name: b.shop_name, owner_name: b.owner_name, owner_email: b.owner_email, password })
    logActivity('admin', `Admin created shop ${t.shop_name} (${b.owner_email})`)
    res.json({ ok: true, shop: { id: t.id, slug: t.slug, shop_name: t.shop_name, owner_email: t.owner_email }, password })
  } catch (e) { res.status(e.code === 'dupe_email' ? 409 : 400).json({ error: e.message }) }
}))

app.post('/api/admin/shops/:id/status', wrap((req, res) => {
  if (!requireAdmin(req, res)) return
  if (+req.params.id === req.tenant?.id) return res.status(400).json({ error: "You can't suspend your own admin account." })
  res.json({ ok: true, tenant: tenantPublic(setTenantStatus(+req.params.id, req.body?.status)) })
}))

app.delete('/api/admin/shops/:id', wrap((req, res) => {
  if (!requireAdmin(req, res)) return
  if (+req.params.id === req.tenant?.id) return res.status(400).json({ error: "You can't delete your own admin account here." })
  res.json({ ok: deleteTenantFully(+req.params.id) })
}))

// Sign in as a client to help them set up. Swaps the current session for one on the target shop
// (its owner). The admin signs back into their own account normally afterward.
app.post('/api/admin/shops/:id/signin', wrap((req, res) => {
  if (!requireAdmin(req, res)) return
  const t = getTenantById(+req.params.id)
  if (!t) return res.status(404).json({ error: 'No such shop' })
  if (t.status !== 'active') return res.status(400).json({ error: 'Reactivate the shop before signing in as it.' })
  deleteSession(parseCookies(req).psc_session)
  setSessionCookie(res, createSession(t.id), req) // null member → resolves to the shop's owner
  res.json({ ok: true, slug: t.slug })
}))

/**
 * Stripe webhook — keeps each shop's subscription status in sync. Raw body (registered above),
 * signature-verified. Handles the events that move a shop between trial, active, past-due, canceled.
 */
function stripeWebhook(req, res) {
  try {
    const raw = req.body instanceof Buffer ? req.body.toString('utf8') : JSON.stringify(req.body || {})
    if (!verifyWebhook(raw, req.headers['stripe-signature'], webhookSecret())) return res.status(400).send('bad signature')
    const event = JSON.parse(raw)
    const obj = event?.data?.object || {}
    const tenantId = Number(obj.metadata?.tenant_id || obj.client_reference_id || 0) || null
    switch (event.type) {
      case 'checkout.session.completed':
        if (tenantId) setSubscription(tenantId, { plan: obj.metadata?.plan, status: 'active', customerId: obj.customer, subscriptionId: obj.subscription })
        break
      case 'customer.subscription.updated': {
        const t = tenantId ? getTenantById(tenantId) : getTenantByStripeCustomer(obj.customer)
        if (t) setSubscription(t.id, { plan: obj.metadata?.plan, status: obj.status === 'active' || obj.status === 'trialing' ? 'active' : (obj.status === 'past_due' ? 'past_due' : obj.status), customerId: obj.customer, subscriptionId: obj.id })
        break
      }
      case 'customer.subscription.deleted': {
        const t = getTenantByStripeCustomer(obj.customer)
        if (t) setSubscription(t.id, { status: 'canceled' })
        break
      }
      case 'invoice.payment_failed': {
        const t = getTenantByStripeCustomer(obj.customer)
        if (t) setSubscription(t.id, { status: 'past_due' })
        break
      }
      default: break
    }
    res.json({ received: true })
  } catch (e) { console.error('webhook:', e); res.status(400).send('error') }
}

/* ================= DASHBOARD ================= */

/**
 * The six integers the sidebar draws a dot from — and nothing else.
 *
 * `refreshChrome()` runs at the end of EVERY navigate() and on every realtime 'notify', 'board' and
 * 'conversation' event, which means one drag on the job board re-runs it in every tab open on the
 * floor. It used to get those six numbers by fetching /api/settings + /api/dashboard + /api/art +
 * /api/followups + /api/automations + /api/conversations and throwing away the rest: 48.12 MB and
 * 1,632 ms of blocked event loop per sidebar click, measured on a shop with 40k proofs; four floor
 * tablets reacting to one board move blocked the whole box — every other tenant included — for 6.7
 * seconds, and took RSS from 155 MB to 486 MB on a 512 MB machine.
 *
 * As six COUNT(*)s the same numbers cost 36 ms and about a hundred bytes. Each count below is
 * deliberately written to be the exact population the old client-side derivation produced, joins
 * included, so the badge does not change meaning: art_versions INNER JOINs jobs (an estimate-only
 * mockup has no job and was never counted), and unread only counts messages whose contact still
 * exists (the Inbox list is built FROM contacts).
 *
 * `open_invoices` is the one number that gets MORE correct: it came from /api/dashboard's
 * `outstanding_invoices`, which carries LIMIT 8. The sidebar only renders a dot, so nothing visible
 * changes — but the value is now the truth rather than a page size.
 */
app.get('/api/chrome/badges', wrap((_req, res) => {
  const today = new Date().toISOString().slice(0, 10)
  const n = (sql, ...p) => get(sql, ...p).c
  res.json({
    active_jobs: n(`SELECT COUNT(*) AS c FROM jobs WHERE status = 'active'`),
    open_invoices: n(`SELECT COUNT(*) AS c FROM invoices WHERE status NOT IN ('paid','void')`),
    art_pending: n(`SELECT COUNT(*) AS c FROM art_versions a JOIN jobs j ON j.id = a.job_id
      WHERE a.status IN ('sent','rejected')`),
    followups: n(`SELECT COUNT(*) AS c FROM estimates WHERE status = 'sent'`)
      + n(`SELECT COUNT(*) AS c FROM invoices WHERE status NOT IN ('paid','void') AND due_date < ?`, today),
    automations: n(`SELECT COUNT(*) AS c FROM automations WHERE enabled = 1`),
    unread: n(`SELECT COUNT(*) AS c FROM messages m WHERE m.direction = 'in' AND m.read = 0
      AND EXISTS (SELECT 1 FROM contacts c WHERE c.id = m.contact_id)`),
  })
}))

app.get('/api/dashboard', wrap((_req, res) => {
  const today = new Date().toISOString().slice(0, 10)
  const monthStart = today.slice(0, 8) + '01'

  const revenue_mtd = round2(get(
    // date(p.created_at) wrapped the column in a function, which makes any index on it unusable —
    // so Revenue MTD, on the first screen after login, scanned every payment the shop had ever
    // taken. created_at is stored as 'YYYY-MM-DD HH:MM:SS', which orders identically to the date
    // alone, so comparing the text directly gives the same answer and seeks.
    `SELECT COALESCE(SUM(p.amount), 0) AS v FROM payments p WHERE p.created_at >= ?`, monthStart).v)
  const outstanding = round2(get(
    `SELECT COALESCE(SUM(amount_due - amount_paid), 0) AS v FROM invoices WHERE status NOT IN ('paid','void')`).v)
  const overdue = round2(get(
    `SELECT COALESCE(SUM(amount_due - amount_paid), 0) AS v FROM invoices WHERE status NOT IN ('paid','void') AND due_date < ?`, today).v)
  // SUM(total) counted sales tax as quoted revenue. What the shop is chasing is what it keeps.
  const open_estimates = round2(get(
    `SELECT COALESCE(SUM(COALESCE(subtotal, total)), 0) AS v FROM estimates WHERE status IN ('draft','sent')`).v)

  const jobsByStage = {}
  for (const r of all(`SELECT stage, COUNT(*) AS c FROM jobs WHERE status = 'active' GROUP BY stage`)) jobsByStage[r.stage] = r.c

  res.json({
    kpis: { revenue_mtd, outstanding, overdue, open_estimates,
      active_jobs: get(`SELECT COUNT(*) AS c FROM jobs WHERE status = 'active'`).c,
      due_this_week: get(`SELECT COUNT(*) AS c FROM jobs WHERE status='active' AND due_date <= date('now','+7 day')`).c },
    jobs_by_stage: jobsByStage,
    due_today: all(`SELECT j.*, c.name AS contact_name FROM jobs j LEFT JOIN contacts c ON c.id=j.contact_id
      WHERE j.status='active' AND j.due_date = ? ORDER BY j.rush DESC`, today),
    upcoming: all(`SELECT j.*, c.name AS contact_name FROM jobs j LEFT JOIN contacts c ON c.id=j.contact_id
      WHERE j.status='active' AND j.due_date >= ? ORDER BY j.due_date LIMIT 8`, today),
    // Jobs whose promised date is already unreachable because the proof is still out.
    // Surfaced before the deadline, not after — this is the whole point of gating.
    at_risk: all(`SELECT j.*, c.name AS contact_name,
        (SELECT sent_at FROM art_versions a WHERE a.job_id=j.id AND a.status='sent' ORDER BY version DESC LIMIT 1) AS proof_sent_at
      FROM jobs j LEFT JOIN contacts c ON c.id=j.contact_id
      WHERE j.status='active' AND j.approval_gated=1 AND j.art_approved_at IS NULL AND j.due_date IS NOT NULL
        AND j.stage IN ('new','art_approval')
      ORDER BY j.due_date LIMIT 200`)
      .map((j) => {
        const s = scheduleFor(j)
        return { ...j, projected_due: s.due, slip: businessDaysBetween(j.due_date, s.due),
          waiting_days: ageInDays(j.proof_sent_at) }
      })
      .filter((j) => j.slip > 0)
      .sort((a, b) => b.slip - a.slip),
    awaiting_art: all(`SELECT j.*, c.name AS contact_name FROM jobs j LEFT JOIN contacts c ON c.id=j.contact_id
      WHERE j.status='active' AND j.stage='art_approval' ORDER BY j.due_date LIMIT 6`),
    outstanding_invoices: all(`SELECT i.*, c.name AS contact_name FROM invoices i LEFT JOIN contacts c ON c.id=i.contact_id
      WHERE i.status NOT IN ('paid','void') ORDER BY i.due_date LIMIT 8`),
    activity: all(`SELECT a.*, c.name AS contact_name FROM activities a LEFT JOIN contacts c ON c.id=a.contact_id
      ORDER BY a.created_at DESC, a.id DESC LIMIT 12`),
    // Roll the other pillars up onto the home screen so it reflects the whole shop.
    pipeline: pipeline.pipelineBoard().stats,
    inbox: {
      unread: get(`SELECT COUNT(*) AS c FROM messages WHERE direction='in' AND read=0`).c,
      threads: all(`SELECT c.id, c.name, m.body, m.created_at FROM messages m JOIN contacts c ON c.id=m.contact_id
        WHERE m.direction='in' AND m.read=0 AND m.id IN (SELECT MAX(id) FROM messages WHERE direction='in' AND read=0 GROUP BY contact_id)
        ORDER BY m.id DESC LIMIT 5`),
    },
    automations_week: get(`SELECT COUNT(*) AS c FROM automation_runs WHERE status='ran' AND created_at > datetime('now','-7 day')`).c,
  })
}))

/* ================= CAPACITY & PROMISE DATES =================
 * "Can we physically hit this date given everything already on the press?" No MIS answers it.
 * Reuses the costing engine's press-time tables, so the schedule and the quote never disagree. */

/** The committed board, each job tagged with its honest due date (proof-gated projection). */
const activeJobsForCapacity = () =>
  // The estimate rides along so a job that was never separated still schedules against the colour
  // count the shop actually quoted, rather than the flat capacity_default_colors guess.
  all(`SELECT j.*, c.name AS contact_name, e.items AS est_items
       FROM jobs j
       LEFT JOIN contacts c ON c.id = j.contact_id
       LEFT JOIN estimates e ON e.id = j.estimate_id
       WHERE j.status = 'active'`)
    .map((j) => ({
      id: j.id, title: j.title, job_number: j.job_number, contact_name: j.contact_name,
      stage: j.stage, rush: !!j.rush, due: scheduleFor(j).due || j.due_date, separation: j.separation,
      colors: colorsFromItems(parse(j.est_items, [])),
      sizes: j.sizes, quantities: j.quantities,
    }))

app.get('/api/capacity', wrap((_req, res) => {
  res.json(capacityReport(activeJobsForCapacity(), getSettings(), { days: 14 }))
}))

/** Live "can we promise this date?" check — schedules the board, then drops the prospective job in. */
app.post('/api/capacity/promise', wrap((req, res) => {
  const b = req.body || {}
  res.json(capacityPromise(activeJobsForCapacity(), getSettings(), {
    pieces: Math.min(MAX_PIECES, Math.max(0, Number(b.pieces) || 0)),
    colors: Math.max(1, Number(b.colors) || 1),
    dueDate: b.due_date || null,
  }))
}))

/** Tune the capacity model from the planner itself — see the impact where you set the number.
 *  These are shop settings feeding pricingMatrix and every promised due date, so this carries the
 *  same manager gate as PUT /api/settings rather than being a back door around it. */
app.put('/api/capacity/settings', requireRole('manager'), wrap((req, res) => {
  const b = req.body || {}
  for (const k of ['capacity_stations', 'capacity_hours_per_day', 'utilization_pct', 'capacity_default_colors', 'press_type']) {
    if (b[k] !== undefined && b[k] !== null && b[k] !== '') setSetting(k, String(b[k]))
  }
  res.json(capacityReport(activeJobsForCapacity(), getSettings(), { days: 14 }))
}))

/* ================= TODAY — role-aware action center =================
 * Replaces the flat dashboard with a ranked "do this next" queue. Same signals as before, but
 * prioritized by financial/production risk and shaped to the signed-in person's role, so the one
 * thing that matters most is obvious instead of every counter competing at the same weight. */
app.get('/api/today', wrap((req, res) => {
  const today = new Date().toISOString().slice(0, 10)
  const role = req.role || 'owner'
  const production = role === 'staff' // staff get a floor-first ordering; owners/managers money-first
  const actions = []
  const add = (a) => actions.push(a)

  // Money at risk — overdue invoices, biggest first.
  for (const i of all(`SELECT i.*, c.name AS cn FROM invoices i LEFT JOIN contacts c ON c.id=i.contact_id
      WHERE i.status NOT IN ('paid','void') AND i.due_date < ? ORDER BY (i.amount_due-i.amount_paid) DESC LIMIT 6`, today)) {
    const bal = round2(i.amount_due - i.amount_paid)
    add({ kind: 'collect', icon: '💸', priority: (production ? 40 : 90) + Math.min(20, bal / 200),
      title: `Collect ${money(bal)} from ${i.cn || 'customer'}`, sub: `${i.invoice_number} · overdue since ${i.due_date}`,
      href: `#/invoices/${i.id}`, amount: bal })
  }
  // Proofs waiting on the customer — these block production and silently eat the schedule.
  for (const j of all(`SELECT j.*, c.name AS cn,
        (SELECT sent_at FROM art_versions a WHERE a.job_id=j.id AND a.status='sent' ORDER BY version DESC LIMIT 1) AS proof_sent
      FROM jobs j LEFT JOIN contacts c ON c.id=j.contact_id
      WHERE j.status='active' AND j.stage='art_approval' ORDER BY j.due_date LIMIT 6`)) {
    const waited = ageInDays(j.proof_sent)
    add({ kind: 'approval', icon: '🎨', priority: 78 + Math.min(15, (waited || 0) * 2),
      title: `Chase proof approval — ${j.cn || j.title}`, sub: `${j.job_number}${waited != null ? ` · waiting ${waited}d` : ''}`, href: `#/jobs/${j.id}` })
  }
  // Deadlines that already slipped (proof-gated projection past the promised date).
  for (const j of all(`SELECT j.* FROM jobs j WHERE j.status='active' AND j.approval_gated=1 AND j.art_approved_at IS NULL
      AND j.due_date IS NOT NULL AND j.stage IN ('new','art_approval')`)) {
    const s = scheduleFor(j)
    if (s.slip > 0) add({ kind: 'risk', icon: '⚠️', priority: 82 + Math.min(12, s.slip),
      title: `${j.title} will miss its date`, sub: `${j.job_number} · lands ${s.due} (+${s.slip}d late)`, href: `#/jobs/${j.id}` })
  }
  // Due today / tomorrow on the floor — production's top concern.
  for (const j of all(`SELECT j.*, c.name AS cn FROM jobs j LEFT JOIN contacts c ON c.id=j.contact_id
      WHERE j.status='active' AND j.due_date <= date(?, '+1 day') AND j.stage NOT IN ('complete','shipping') ORDER BY j.due_date LIMIT 8`, today)) {
    add({ kind: 'floor', icon: '🖨️', priority: (production ? 92 : 70) + (j.rush ? 8 : 0),
      title: `${j.title} — ${j.due_date === today ? 'due today' : 'due tomorrow'}`, sub: `${j.job_number} · ${j.stage.replace('_', ' ')}${j.rush ? ' · RUSH' : ''}`, href: `#/jobs/${j.id}` })
  }
  // Unread customer messages.
  const unread = get(`SELECT COUNT(*) AS n FROM messages WHERE direction='in' AND read=0`).n
  if (unread) add({ kind: 'reply', icon: '💬', priority: production ? 55 : 74, title: `${unread} unread customer message${unread === 1 ? '' : 's'}`, sub: 'Reply from the inbox', href: '#/conversations' })
  // Quiet estimates worth chasing (sent, not yet approved, aging).
  for (const e of all(`SELECT e.*, c.name AS cn FROM estimates e LEFT JOIN contacts c ON c.id=e.contact_id
      WHERE e.status='sent' AND e.total > 0 AND e.created_at < datetime('now','-3 day') ORDER BY e.total DESC LIMIT 4`)) {
    add({ kind: 'followup', icon: '📨', priority: (production ? 30 : 60) + Math.min(15, e.total / 300),
      title: `Follow up: ${money(e.total)} quote to ${e.cn || 'customer'}`, sub: `${e.estimate_number} · sent, gone quiet`, href: `#/estimates/${e.id}`, amount: round2(e.total) })
  }

  actions.sort((a, b) => b.priority - a.priority)

  const overdue = round2(get(`SELECT COALESCE(SUM(amount_due-amount_paid),0) AS v FROM invoices WHERE status NOT IN ('paid','void') AND due_date < ?`, today).v)
  res.json({
    role, date: today,
    pulse: {
      money_at_risk: overdue,
      jobs_at_risk: actions.filter((a) => a.kind === 'risk').length,
      approvals: actions.filter((a) => a.kind === 'approval').length,
      due_week: get(`SELECT COUNT(*) AS n FROM jobs WHERE status='active' AND due_date <= date(?, '+7 day') AND stage NOT IN ('complete','shipping')`, today).n,
    },
    actions: actions.slice(0, 12),
    clear: actions.length === 0,
  })
}))

/* ================= REORDER RADAR =================
 * The best lead is a customer who already bought. Learns each customer's cadence and surfaces
 * who's due to reorder, ranked by value, with their last order ready to clone. */

app.get('/api/reorders', wrap((_req, res) => res.json(reorderRadar())))

/** Nudge a customer to reorder — respects the shop's follow-up mode (drafts in Manual). */
app.post('/api/reorders/:id/nudge', wrap((req, res) => {
  const c = get('SELECT * FROM contacts WHERE id = ?', +req.params.id)
  if (!c) return res.status(404).json({ error: 'Customer not found' })
  if (!c.email) return res.status(400).json({ error: 'No email on file for this customer' })
  const s = getSettings()
  const last = get('SELECT title FROM jobs WHERE contact_id = ? ORDER BY created_at DESC LIMIT 1', c.id)
  const deliver = s.mode_followups !== 'manual'
  queueEmail({ contact: c, kind: 'reorder', subject: `Time for a reorder from ${s.shop_name}?`,
    template: s.email_template_reorder, vars: { last_order: last?.title || 'your last order', shop_name: s.shop_name }, deliver })
  logActivity('note', `Reorder nudge ${deliver ? 'sent' : 'drafted'} to ${c.name}`, { contact_id: c.id })
  res.json({ ok: true, delivered: deliver })
}))

app.post('/api/reorders/:id/snooze', wrap((req, res) => {
  snoozeReorder(+req.params.id, Number(req.body?.days) || 30)
  res.json({ ok: true })
}))
app.post('/api/reorders/:id/unsnooze', wrap((req, res) => { unsnoozeReorder(+req.params.id); res.json({ ok: true }) }))

/* ================= CONTACTS ================= */

app.get('/api/contacts', wrap((req, res) => {
  const q = `%${(req.query.q || '').toLowerCase()}%`
  const tag = req.query.tag || ''
  let sql = `SELECT c.*,
      (SELECT COUNT(*) FROM jobs j WHERE j.contact_id = c.id) AS job_count,
      (SELECT COALESCE(SUM(i.amount_paid),0) FROM invoices i WHERE i.contact_id = c.id) AS lifetime_value,
      (SELECT COALESCE(SUM(i.amount_due - i.amount_paid),0) FROM invoices i WHERE i.contact_id = c.id AND i.status NOT IN ('paid','void')) AS balance
    FROM contacts c WHERE (lower(c.name) LIKE ? OR lower(COALESCE(c.company,'')) LIKE ? OR lower(COALESCE(c.email,'')) LIKE ?)`
  const params = [q, q, q]
  if (tag) { sql += ` AND ',' || c.tags || ',' LIKE ?`; params.push(`%,${tag},%`) }
  sql += ' ORDER BY c.name'
  const rows = all(sql, ...params).map((r) => ({ ...r, tags: r.tags ? r.tags.split(',').filter(Boolean) : [] }))
  const tags = [...new Set(all('SELECT tags FROM contacts').flatMap((r) => (r.tags || '').split(',')).filter(Boolean))].sort()
  res.json({ contacts: rows, tags })
}))

/**
 * The tax rate that applies to a given buyer. A wholesale / resale-certificate customer is
 * tax-exempt, and EVERY estimate-creating path must honour that — a wrongly-taxed quote is a
 * number the shop has to explain to a customer, and a wrongly-untaxed one is a liability.
 * Extracted so new paths can't quietly forget the lookup (they did: the v56 reorder and API
 * routes both taxed exempt customers until this existed).
 */
// taxRateFor now lives in lib/db.mjs so lib/agent.mjs and lib/assistant.mjs can use the same
// one — both of them were quoting sales tax to tax-exempt buyers because they could not reach it.

/**
 * "Same as last time" — the reorder every shop hears weekly, as one click. Clones the
 * customer's most recent estimate (imported history included) into a fresh draft at today's
 * date. This is the payoff of importing order history: it works on day one of a trial.
 */
app.post('/api/contacts/:id/reorder', wrap((req, res) => {
  const c = get('SELECT * FROM contacts WHERE id = ?', +req.params.id)
  if (!c) return res.status(404).json({ error: 'Contact not found' })
  const last = get("SELECT * FROM estimates WHERE contact_id = ? AND items != '[]' ORDER BY id DESC", c.id)
  if (!last) return res.status(400).json({ error: 'No previous order on file for this customer yet.' })
  const items = freezeUpcharges(parse(last.items, []))
  const rate = taxRateFor(c.id)
  const t = computeTotals(items, rate, getUpcharges())
  if (!representableLines(items) || !representableTotals(t)) return res.status(400).json(NOT_REPRESENTABLE)
  const id = Number(run('INSERT INTO estimates (contact_id, estimate_number, status, items, subtotal, tax, total, tax_rate, notes, rush_days, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    c.id, nextEstimateNumber(), 'draft', JSON.stringify(items), t.subtotal, t.tax, t.total, rate,
    `Reorder — same as ${last.estimate_number}`, Math.max(0, Number(last.rush_days) || 0), now()).lastInsertRowid)
  logActivity('estimate', `Reorder drafted from ${last.estimate_number} for ${c.name}`, { contact_id: c.id })
  res.status(201).json({ ok: true, estimate_id: id, from: last.estimate_number })
}))

app.get('/api/contacts/:id', wrap((req, res) => {
  const c = get('SELECT * FROM contacts WHERE id = ?', +req.params.id)
  if (!c) return res.status(404).json({ error: 'Contact not found' })
  c.tags = c.tags ? c.tags.split(',').filter(Boolean) : []
  res.json({
    contact: c,
    estimates: all('SELECT * FROM estimates WHERE contact_id = ? ORDER BY id DESC', c.id),
    invoices: all('SELECT * FROM invoices WHERE contact_id = ? ORDER BY id DESC', c.id),
    jobs: all('SELECT * FROM jobs WHERE contact_id = ? ORDER BY id DESC', c.id),
    activities: all('SELECT * FROM activities WHERE contact_id = ? ORDER BY created_at DESC, id DESC LIMIT 40', c.id),
    stats: {
      lifetime: round2(get('SELECT COALESCE(SUM(amount_paid),0) AS v FROM invoices WHERE contact_id = ?', c.id).v),
      balance: round2(get(`SELECT COALESCE(SUM(amount_due-amount_paid),0) AS v FROM invoices WHERE contact_id = ? AND status NOT IN ('paid','void')`, c.id).v),
      orders: get('SELECT COUNT(*) AS c FROM jobs WHERE contact_id = ?', c.id).c,
    },
  })
}))

app.post('/api/contacts', wrap((req, res) => {
  const b = req.body || {}
  const name = str(b.name).trim()
  if (!name) return res.status(400).json({ error: 'Name is required' })
  const tags = Array.isArray(b.tags) ? b.tags.join(',') : str(b.tags)
  const r = run('INSERT INTO contacts (name, email, phone, company, notes, tags, tax_exempt, tax_exempt_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    name, str(b.email), str(b.phone), str(b.company), str(b.notes), tags,
    b.tax_exempt ? 1 : 0, str(b.tax_exempt_id), now(), now())
  const id = Number(r.lastInsertRowid)
  logActivity('contact', `Contact created — ${name}`, { contact_id: id })
  fireAuto('contact.created', { contact: get('SELECT * FROM contacts WHERE id = ?', id) })
  res.json(get('SELECT * FROM contacts WHERE id = ?', id))
}))

app.put('/api/contacts/:id', wrap((req, res) => {
  const b = req.body || {}
  const id = +req.params.id
  if (!get('SELECT id FROM contacts WHERE id = ?', id)) return res.status(404).json({ error: 'Contact not found' })
  const tags = Array.isArray(b.tags) ? b.tags.join(',') : str(b.tags)
  const name = str(b.name).trim()
  if (!name) return res.status(400).json({ error: 'A customer needs a name.' })
  run('UPDATE contacts SET name=?, email=?, phone=?, company=?, notes=?, tags=?, tax_exempt=?, tax_exempt_id=?, updated_at=? WHERE id=?',
    name, str(b.email), str(b.phone), str(b.company), str(b.notes), tags,
    b.tax_exempt ? 1 : 0, str(b.tax_exempt_id), now(), id)
  logActivity('contact', 'Contact updated', { contact_id: id })
  res.json(get('SELECT * FROM contacts WHERE id = ?', id))
}))

/**
 * Deleting a customer cascades — estimates, invoices, PAYMENTS, jobs, proofs, scans and the whole
 * activity trail go with the row, and manager-role was the only thing standing in the way.
 *
 * A customer who has been invoiced is a bookkeeping record, not a contact card. Reproduced on a
 * live instance: one DELETE took revenue MTD from $3,600 to $0, took INV-1001 and the cheque
 * recorded against it with it, and answered {"ok":true}. DELETE /api/estimates/:id already refuses
 * to destroy an estimate that has been invoiced, and says so in words — without the same rule
 * here, deleting the customer was simply the way around it.
 *
 * So refuse, and say what is in the way, rather than archive: a shop does not want its paid
 * invoices moved somewhere it has to go and find them, and archiving would want a new column and
 * a new filter on every list query for a case a shop meets once a year. A customer with no live
 * invoice and no recorded payment still deletes, which is what this route is actually for — a
 * typo, a duplicate, a spam lead. A VOIDED invoice does not block, because voiding is how a shop
 * retracts one raised in error. A recorded payment always blocks, void or not: that is money that
 * really arrived, and no screen in the product would ever mention it again.
 */
app.delete('/api/contacts/:id', requireRole('manager'), wrap((req, res) => {
  const id = +req.params.id
  const c = get('SELECT id, name FROM contacts WHERE id = ?', id)
  if (!c) return res.status(404).json({ error: 'Customer not found', code: 'not_found' })
  const live = get("SELECT COUNT(*) AS n FROM invoices WHERE contact_id = ? AND status != 'void'", id).n
  const paid = round2(get('SELECT COALESCE(SUM(p.amount), 0) AS v FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE i.contact_id = ?', id).v)

  // The same guard DELETE /api/jobs/:id has, applied to the customer the jobs hang off.
  //
  // jobs.contact_id cascades, so deleting a customer deleted every one of their jobs — including
  // jobs the job route itself refuses to delete because blanks are still out against them. Void the
  // invoice (which the shop does when it raised one in error) and this route stopped blocking, so a
  // customer with 200 pieces on order deleted cleanly: the job vanished, purchase_orders.job_id went
  // to NULL, and the order was left on no screen in the product. The blanks still turn up at the
  // shop door, and nothing can receive them.
  const openPos = all(`SELECT p.*, j.job_number FROM purchase_orders p JOIN jobs j ON j.id = p.job_id
    WHERE j.contact_id = ?`, id).filter((p) => PO_STILL_OUT.includes(String(p.status)) && poAlreadySent(p))
  if (openPos.length) {
    return res.status(409).json({
      error: `${c.name} has ${openPos.length === 1 ? 'a purchase order that is still out' : `${openPos.length} purchase orders still out`} — `
        + `${openPos.map((p) => `${p.po_number || 'PO'} on ${p.job_number} (${p.ordered} pcs, ${String(p.status).replace('_', ' ')})`).join(', ')}. `
        + `Receive or short-close ${openPos.length === 1 ? 'it' : 'them'} on the job first, then delete the customer. `
        + `Deleting now would take the jobs with the customer and leave the blanks with nothing to receive them against.`,
      code: 'has_open_purchase_orders',
      purchase_orders: openPos.map((p) => ({ id: p.id, po_number: p.po_number, job_number: p.job_number, supplier: p.supplier, status: p.status, ordered: p.ordered, received: p.received })),
    })
  }

  if (live > 0 || paid > 0) {
    const bits = []
    if (live > 0) bits.push(`${live} invoice${live === 1 ? '' : 's'}`)
    if (paid > 0) bits.push(`${money(paid)} in recorded payments`)
    return res.status(409).json({
      error: `${c.name} has ${bits.join(' and ')} — deleting the customer would delete ${bits.length > 1 ? 'them' : 'that'} too. Void an invoice raised in error and try again; a customer who has actually paid you stays on the books.`,
      code: 'has_financials',
      invoices: live,
      amount_paid: paid,
    })
  }
  tx(() => {
    // email_log.contact_id has no foreign key, so the row survives the customer pointing at an id
    // that is gone — and every later "Send it" on that message dies in logActivity's INSERT, which
    // does have one. Null it here, in the same transaction, so the Outbox stays usable.
    run('UPDATE email_log SET contact_id = NULL WHERE contact_id = ?', id)
    run('DELETE FROM contacts WHERE id = ?', id)
  })
  logActivity('contact', `Customer deleted — ${c.name}`, {})
  res.json({ ok: true })
}))

/**
 * Import customers from a CSV export of whatever the shop is leaving. Accepts a file upload
 * (field "file") or pasted text (body.text). `preview:true` parses + maps + dedupes WITHOUT
 * writing, so the shop sees exactly what will import first. Dedupe is by email (case-insensitive),
 * against both the existing book and within the file itself.
 */
// requireRole after multer+reTenant so a refused request has nothing on disk to clean up
// (uploadMem is in-memory, so there is no file either way). Its three siblings — pricebook,
// matrices and orders import — have all required manager since they were written; this one did
// not, so a staff session could bulk-write the entire customer book, and fire contact.created
// automations and webhooks for every row, while being unable to delete a single contact.
app.post('/api/import/contacts', uploadMem.single('file'), reTenant, requireRole('manager'), wrap(async (req, res) => {
  const text = req.file ? req.file.buffer.toString('utf8') : String(req.body?.text || '')
  if (!text.trim()) return res.status(400).json({ error: 'Upload a CSV file or paste the rows.' })
  const rows = parseCsv(text)
  if (!rows.length) return res.status(400).json({ error: 'No rows found — is the first line the column headers?' })
  const columns = detectColumns(Object.keys(rows[0]))
  if (!columns.name) return res.status(400).json({ error: "Couldn't find a name column. Expected one of: Name, Customer, Company, or First + Last." })

  const existing = new Set(all("SELECT lower(email) AS e FROM contacts WHERE email != ''").map((r) => r.e))
  const seen = new Set()
  const toAdd = []
  let skippedNoName = 0, dupes = 0
  for (const row of rows) {
    const c = mapContactRow(row)
    if (!c) { skippedNoName++; continue }
    if (c.email && (existing.has(c.email) || seen.has(c.email))) { dupes++; continue }
    if (c.email) seen.add(c.email)
    toAdd.push(c)
  }

  const preview = req.body?.preview === 'true' || req.body?.preview === true
  if (preview) {
    return res.json({ preview: true, columns, total_rows: rows.length, to_import: toAdd.length, duplicates: dupes, skipped: skippedNoName, sample: toAdd.slice(0, 8) })
  }

  // Batched, and handing the event loop back between batches, for the same reason the order
  // importer is — see the comment there. A 2.94MB customer book (well inside the 8MB upload cap)
  // was 4.65 SECONDS of unbroken blocking, with /health answering three times in the window and
  // every other shop on the box waiting behind it. The per-row try/catch stays exactly where it
  // was: a constraint violation is caught inside the transaction, so one bad row still skips
  // itself rather than sinking its batch.
  let created = 0
  const BATCH = 500
  for (let i = 0; i < toAdd.length; i += BATCH) {
    const batch = toAdd.slice(i, i + BATCH)
    tx(() => {
      for (const c of batch) {
        try {
          run('INSERT INTO contacts (name, email, phone, company, notes, tags, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
            c.name, c.email, c.phone, c.company, c.notes, c.tags, now(), now())
          created++
        } catch (e) { /* one bad row shouldn't sink the import */ }
      }
    })
    if (i + BATCH < toAdd.length) await new Promise((r) => setImmediate(r))
  }
  if (created) logActivity('contact', `Imported ${created} customer${created === 1 ? '' : 's'} from CSV`, {})
  res.json({ preview: false, created, duplicates: dupes, skipped: skippedNoName, total_rows: rows.length })
}))

app.post('/api/contacts/:id/note', wrap((req, res) => {
  const id = +req.params.id
  // activities.contact_id has a foreign key, so noting a customer a second tab just deleted (or a
  // mistyped id) threw "FOREIGN KEY constraint failed" → 500. Check the contact exists, and refuse
  // an empty note rather than recording a blank activity row.
  if (!get('SELECT id FROM contacts WHERE id = ?', id)) return res.status(404).json({ error: 'Customer not found' })
  const text = str(req.body?.text).trim()
  if (!text) return res.status(400).json({ error: 'Write something to note.' })
  logActivity('note', text, { contact_id: id })
  res.json({ ok: true })
}))

/* ================= ESTIMATES ================= */

const estimateView = (e) => ({ ...e, items: parse(e.items, []) })

app.get('/api/estimates', wrap((req, res) => {
  const status = req.query.status
  let sql = `SELECT e.*, c.name AS contact_name, c.company FROM estimates e LEFT JOIN contacts c ON c.id=e.contact_id`
  const params = []
  if (status && status !== 'all') { sql += ' WHERE e.status = ?'; params.push(status) }
  sql += ' ORDER BY e.id DESC'
  res.json(all(sql, ...params).map(estimateView))
}))

app.get('/api/estimates/:id', wrap((req, res) => {
  const e = get(`SELECT e.*, c.name AS contact_name FROM estimates e LEFT JOIN contacts c ON c.id=e.contact_id WHERE e.id=?`, +req.params.id)
  if (!e) return res.status(404).json({ error: 'Estimate not found' })
  // A VOIDED invoice is not the estimate's invoice. Without this filter, voiding froze the
  // estimate behind it: the editor gates Edit, Send, Mark Approved, Convert and Delete on
  // `e.invoice`, so all five disappeared at once and the screen was left with Duplicate, PDF and
  // a link to the cancelled invoice. The server would have allowed the fix all along — /convert
  // and DELETE both filter `status != 'void'` — so the whole void feature was defeated by one
  // missing WHERE clause on the read side, on the exact path the feature exists for (an invoice
  // raised against the wrong customer). The voided ones are still returned, so the history is
  // visible rather than hidden.
  res.json({ ...estimateView(e), share_url: shareUrl('estimate', e.id),
    invoice: get("SELECT * FROM invoices WHERE estimate_id = ? AND status != 'void' ORDER BY id DESC", e.id),
    voided_invoices: all("SELECT id, invoice_number, voided_at, void_reason FROM invoices WHERE estimate_id = ? AND status = 'void' ORDER BY id", e.id) })
}))

/**
 * Scrub the two item fields that reach the browser as raw markup.
 *
 * POST/PUT /api/estimates stored `items` with JSON.stringify and no validation, and the editor
 * renders three object-derived fields WITHOUT escaping: the size-grid keys, the size-grid values,
 * and item.matrix.{name,row,col} inside a title attribute. Everything the editor knows to be a
 * string it escapes; these are the ones that arrive as object keys and nested fields, so they were
 * missed. Any staff account can write an estimate — neither route has a role check — and the owner
 * opens it, so this was staff -> owner stored XSS, rendered through innerHTML under
 * script-src 'self' 'unsafe-inline'.
 *
 * The /api/v1 twin already validates sizes correctly. This is the same rule, applied where the
 * app's own screens post. Escaping in the editor as well is defence in depth, not the fix — the
 * PDF, the public estimate page and the pay page all render these too.
 */
/**
 * The 400 an estimate gets instead of quietly losing pieces. Same wording as the v1 twin, which has
 * always refused an unknown size rather than deleting it — this is the internal routes catching up.
 */
const unknownSizes = (keys) => ({
  error: `Unknown size${keys.length > 1 ? 's' : ''} ${[...new Set(keys)].map((k) => `"${k}"`).join(', ')} — allowed: ${SIZES.join(', ')}`,
  code: 'unknown_size',
})

function sanitizeEstimateItems(items, rejected = []) {
  // Freeze the upcharge table these lines are priced with (lib/db.mjs freezeUpcharges), so the
  // document keeps adding up after the shop changes its rates. Every writer of an estimate does
  // this now — the gate holds that — but this is still the door the editor comes through.
  return freezeUpcharges(items.map((it) => {
    if (!it || typeof it !== 'object' || Array.isArray(it)) return {}
    const out = { ...it }
    if (out.sizes != null) {
      const sizes = {}
      if (typeof out.sizes === 'object' && !Array.isArray(out.sizes)) {
        for (const [k, v] of Object.entries(out.sizes)) {
          const key = String(k).trim().toUpperCase()
          // `SIZES.includes(k)` plus `continue` DELETED the pieces instead of refusing them. The
          // comment said the editor only writes keys from SIZES, which was true of the editor and
          // false of every other door into this function — the v1 API, the CSV import, the AI
          // intake path and any integration all land here. A 45-piece order with 4 6XL and 6 LT
          // came back a 35-piece $640 quote with no error, no warning field and a 200, while the
          // JOB it converted to happily carried the sizes its own estimate had thrown away.
          // Collected and refused by the caller now: never bill a count the customer did not order.
          if (!SIZE_KEY.test(key)) { if (Number(v) > 0) rejected.push(String(k).slice(0, 24)); continue }
          const n = Math.trunc(Number(v))
          // Clamped, not just finite. A finite-but-absurd count produced a perfectly storable
          // estimate (the money stayed representable), and the JOB it converted to then made the
          // Capacity page walk business days one at a time forever — 100% CPU on the shared
          // process, every tenant on the box down, on every visit to that page. MAX_PIECES is
          // three orders of magnitude past any real screen-print run.
          if (Number.isFinite(n) && n >= 0) sizes[key] = Math.min(n, MAX_PIECES)
          else if (Number(v) > 0 || (v != null && v !== '' && !Number.isFinite(n))) rejected.push(String(k).slice(0, 24))
        }
      }
      out.sizes = sizes
    }
    if (out.matrix != null) {
      const m = out.matrix
      if (typeof m === 'object' && !Array.isArray(m)) {
        out.matrix = { id: Number(m.id) || null, name: String(m.name ?? '').slice(0, 60), row: String(m.row ?? '').slice(0, 40), col: String(m.col ?? '').slice(0, 48) }
      } else delete out.matrix
    }
    return out
  }))
}

/**
 * Money must never be a number the arithmetic could not produce.
 *
 * `qty: 1e308` on a line item multiplied out to Infinity, and round2's overflow fallback passed it
 * straight through. SQLite stored Infinity in estimates.total, converting carried it to
 * invoices.amount_due, and from there SUM(amount_due) poisoned the whole shop: the Outstanding KPI
 * and EVERY total in the A/R aging report went blank — not just that customer's. The estimate then
 * refused to delete ("can't delete a converted estimate"), so the only way out from the UI was to
 * void an invoice that looked real.
 *
 * The v1 API already refuses this, with a comment describing this exact failure. The routes the
 * app's own screens post to never got the same guard.
 */
const representableTotals = (t) => [t.subtotal, t.tax, t.total].every(Number.isFinite)

/**
 * …and the same question asked of the LINE INPUTS, before any rounding touches them.
 *
 * This used to be answered implicitly: round2() leaked Infinity, so an overflowing line carried it
 * into the totals and representableTotals() above caught it there. round2 now floors a non-finite
 * value to 0 (it is the money helper — it must not emit Infinity into a money column), which would
 * have turned a refusal into a silently stored $0 estimate. That is the worse of the two failures,
 * so the overflow is checked where it happens instead of being inferred downstream.
 */
/**
 * Can round2() carry this number without flooring it to zero?
 *
 * `Number.isFinite(qty * price)` was not enough: round2 multiplies by 100 before rounding, so a
 * FINITE product that overflows only in that step came back 0. quantity 1e300 at $10,000,000 was
 * a 201 with `subtotal 0, total 0` — the exact "$0 estimate a customer could approve" this file's
 * own comments say was closed for unit_price, still open on the other operand — and 50 lines that
 * each pass individually could overflow in the SUM, which nothing checked at all.
 */
const representable = (n) => Number.isFinite(n) && Number.isFinite(n * 100)

const representableLines = (items) => {
  let sum = 0
  for (const it of items || []) {
    if (!it || typeof it !== 'object') continue
    const qty = lineQty(it)
    const price = Number(it.unit_price ?? 0)
    if (!Number.isFinite(qty) || !Number.isFinite(price)) return false
    const amount = qty * price
    if (!representable(amount)) return false
    sum += amount
  }
  return representable(sum)
}
const NOT_REPRESENTABLE = { error: 'Those line items do not add up to an amount we can store — check the quantities and prices.', code: 'invalid_total' }

app.post('/api/estimates', wrap((req, res) => {
  const b = req.body || {}
  const contactId = resolveContactId(b.contact_id, res, 'quote')
  if (contactId == null) return
  const s = getSettings()
  // A non-array here (a bare object, a string, or a duplicated JSON key collapsing to one value)
  // reached computeTotals and threw a 500 on the app's main create path.
  if (b.items !== undefined && !Array.isArray(b.items)) return res.status(400).json({ error: 'items must be a list of line items', code: 'invalid_items' })
  const badSizes = []
  const items = sanitizeEstimateItems(b.items || [], badSizes)
  if (badSizes.length) return res.status(400).json(unknownSizes(badSizes))
  // A wholesale/resale account is tax exempt, so every quote for it is untaxed unless the caller
  // says, in as many words, that this particular order really is taxable. Merely carrying a
  // `tax_rate` is not saying so — the editor's field always carries the shop's default, which is
  // how every quote written from a wholesale customer's own page came out taxed.
  // Derive the rate BEFORE computing totals, or the stored rate and the stored tax dollars disagree.
  const rate = taxRateFor(contactId, b.tax_rate, { allowExemptOverride: b.tax_exempt_override === true })
  const t = computeTotals(items, rate, getUpcharges())
  if (!representableLines(items) || !representableTotals(t)) return res.status(400).json(NOT_REPRESENTABLE)
  const num = nextEstimateNumber()
  const r = run('INSERT INTO estimates (contact_id, estimate_number, status, items, subtotal, tax, total, tax_rate, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    contactId, num, b.status || 'draft', JSON.stringify(items), t.subtotal, t.tax, t.total, rate, b.notes || '', now())
  const id = Number(r.lastInsertRowid)
  logActivity('estimate', `Estimate ${num} created — ${money(t.total)}`, { contact_id: contactId })
  syncPipeline(get('SELECT * FROM estimates WHERE id = ?', id), 'created')
  res.json(estimateView(get('SELECT * FROM estimates WHERE id = ?', id)))
}))

app.put('/api/estimates/:id', wrap((req, res) => {
  const id = +req.params.id
  const e = get('SELECT * FROM estimates WHERE id = ?', id)
  if (!e) return res.status(404).json({ error: 'Estimate not found' })
  // Once an estimate has become an invoice + job, its totals are locked — editing the line items
  // here would silently desync the invoice's amount_due from what the customer will be billed.
  // A VOIDED invoice does not lock its estimate. Voiding exists so a wrongly-raised invoice can be
  // taken back; if the quote behind it stayed frozen, the shop still could not put things right.
  const inv = get("SELECT invoice_number FROM invoices WHERE estimate_id = ? AND status != 'void'", id)
  if (inv) return res.status(409).json({ error: `Already invoiced as ${inv.invoice_number} — edit the invoice, not the estimate.` })
  const b = req.body || {}
  const s = getSettings()
  if (b.items !== undefined && !Array.isArray(b.items)) return res.status(400).json({ error: 'items must be a list of line items', code: 'invalid_items' })
  const badSizes = []
  const items = sanitizeEstimateItems(b.items ?? parse(e.items, []), badSizes)
  if (badSizes.length) return res.status(400).json(unknownSizes(badSizes))
  // Fall back to the estimate's OWN stored rate before the shop's current setting — otherwise
  // editing a note on last quarter's resale-exempt quote silently re-taxes it at today's rate.
  // clampRate, or the edit path is a hole straight through the 0-100 guard every other write has:
  // PUT {tax_rate: 100000} wrote $1,918,000 of tax onto a $1,918 estimate, and because the editor
  // pre-fills from the stored value and this expression falls back to it, any LATER edit that
  // simply omitted tax_rate re-applied the bad rate. These columns feed A/R, the dashboard, the
  // customer-facing PDF and the invoice's amount_due at convert.
  // ...and it must go through the same door POST does, or retargeting an estimate onto a
  // tax-exempt buyer keeps the taxable rate: PUT never consulted tax_exempt at all.
  const rate = taxRateFor(b.contact_id ?? e.contact_id, b.tax_rate ?? e.tax_rate ?? s.tax_rate,
    { allowExemptOverride: b.tax_exempt_override === true })
  const t = computeTotals(items, rate, getUpcharges())
  if (!representableLines(items) || !representableTotals(t)) return res.status(400).json(NOT_REPRESENTABLE)
  run('UPDATE estimates SET contact_id=?, items=?, subtotal=?, tax=?, total=?, tax_rate=?, notes=? WHERE id=?',
    b.contact_id ?? e.contact_id, JSON.stringify(items), t.subtotal, t.tax, t.total, rate, b.notes ?? e.notes, id)
  res.json(estimateView(get('SELECT * FROM estimates WHERE id = ?', id)))
}))

app.delete('/api/estimates/:id', requireRole('manager'), wrap((req, res) => {
  const inv = get("SELECT invoice_number FROM invoices WHERE estimate_id = ? AND status != 'void'", +req.params.id)
  if (inv) return res.status(409).json({ error: `Already invoiced as ${inv.invoice_number} — can't delete a converted estimate.` })
  // One transaction with its artwork. The migration's trigger already handles the cascade, but
  // doing both writes atomically means a failure cannot leave mockups pointing at an id that is
  // about to be handed to the next estimate.
  tx(() => {
    run('DELETE FROM art_versions WHERE estimate_id = ?', +req.params.id)
    run('DELETE FROM estimates WHERE id = ?', +req.params.id)
  })
  res.json({ ok: true })
}))

app.post('/api/estimates/:id/send', wrap((req, res) => {
  const id = +req.params.id
  const e = get('SELECT * FROM estimates WHERE id = ?', id)
  if (!e) return res.status(404).json({ error: 'Estimate not found' })
  const c = get('SELECT * FROM contacts WHERE id = ?', e.contact_id)
  const s = getSettings()
  // Re-sending emails a copy. It must not REVERSE the customer's decision. This UPDATE was
  // unconditional, so "resend the estimate" on an already-approved, already-invoiced, part-paid
  // job rolled its status back to 'sent' — which put the Approve button back on the public page
  // for a customer who had already approved it, and unwound the board stage on the shop's own
  // screen. An estimate that has moved past 'sent' keeps where it got to; only the timestamp and
  // the email are refreshed.
  const settled = ['approved', 'declined', 'invoiced'].includes(e.status)
  if (settled) run('UPDATE estimates SET sent_at=? WHERE id=?', now(), id)
  else run(`UPDATE estimates SET status='sent', sent_at=? WHERE id=?`, now(), id)
  queueEmail({ contact: c, kind: 'estimate', subject: `Estimate ${e.estimate_number} from ${s.shop_name}`,
    template: s.email_template_estimate,
    vars: { contact_name: c?.name || '', estimate_number: e.estimate_number, total: money(e.total) } })
  logActivity('estimate', `Estimate ${e.estimate_number} emailed to ${c?.email || 'customer'}`, { contact_id: e.contact_id })
  fireAuto('estimate.sent', { estimate: get('SELECT * FROM estimates WHERE id = ?', id), contact: c, total: e.total })
  syncPipeline(get('SELECT * FROM estimates WHERE id = ?', id), 'sent')
  res.json({ ok: true, share_url: shareUrl('estimate', id), emailed_to: c?.email || null, email_live: notifyStatus(s).shop_email, estimate: estimateView(get('SELECT * FROM estimates WHERE id = ?', id)) })
}))

app.post('/api/estimates/:id/approve', wrap((req, res) => {
  const id = +req.params.id
  const e = get('SELECT * FROM estimates WHERE id = ?', id)
  if (!e) return res.status(404).json({ error: 'Estimate not found' })
  run(`UPDATE estimates SET status='approved', approved_at=? WHERE id=?`, now(), id)
  logActivity('estimate', `Estimate ${e.estimate_number} approved`, { contact_id: e.contact_id })
  fireAuto('estimate.approved', { estimate: get('SELECT * FROM estimates WHERE id = ?', id), contact: get('SELECT * FROM contacts WHERE id = ?', e.contact_id), total: e.total })
  syncPipeline(get('SELECT * FROM estimates WHERE id = ?', id), 'approved')
  res.json({ ok: true })
}))

/* ================= ORDER BOARD (lite) ================= */

/**
 * The five stages an order actually passes through in a small shop, in order. Deliberately short:
 * this is a whiteboard, not a production system. Staff drag cards; nothing here is computed, so a
 * card never jumps somewhere the person who moved it didn't put it.
 */
const ORDER_STAGES = [
  { key: 'quote', label: 'Estimate', hint: 'Quoted, waiting on the customer' },
  { key: 'paid', label: 'Paid', hint: 'Money in — safe to start' },
  { key: 'mockup', label: 'Mockup Approved', hint: 'Artwork signed off' },
  { key: 'printing', label: 'Printing', hint: 'On the press' },
  { key: 'shipped', label: 'Shipped', hint: 'Out the door' },
]
const ORDER_STAGE_KEYS = ORDER_STAGES.map((s) => s.key)
const stageRank = (k) => Math.max(0, ORDER_STAGE_KEYS.indexOf(k))

/**
 * Nudge an order forward when something real happens (payment lands, mockup approved) — but only
 * ever forward, and never past where staff have already dragged it. Someone who moved a card to
 * Printing must not see it yanked back to Paid because a second deposit arrived.
 */
function advanceOrder(estimateId, toStage) {
  if (!estimateId) return
  const e = get('SELECT id, board_stage FROM estimates WHERE id = ?', estimateId)
  if (!e) return
  if (stageRank(toStage) <= stageRank(e.board_stage || 'quote')) return
  run('UPDATE estimates SET board_stage = ?, stage_moved_at = ? WHERE id = ?', toStage, now(), estimateId)
}

/** The board: five columns of order cards. */
app.get('/api/orders', wrap((_req, res) => {
  const rows = all(`
    SELECT e.id, e.estimate_number, e.total, e.board_stage, e.tracking_number, e.carrier, e.stage_moved_at,
           e.status AS estimate_status, c.name AS contact_name, c.company,
           i.id AS invoice_id, i.invoice_number, i.status AS invoice_status, i.due_date,
           i.amount_due, i.amount_paid,
           (SELECT status FROM art_versions a WHERE a.estimate_id = e.id ORDER BY version DESC LIMIT 1) AS mockup_status
    FROM estimates e
    LEFT JOIN contacts c ON c.id = e.contact_id
    LEFT JOIN invoices i ON i.estimate_id = e.id
    ORDER BY COALESCE(e.stage_moved_at, e.created_at) DESC`)
  const cards = rows.map((r) => ({
    ...r,
    stage: ORDER_STAGE_KEYS.includes(r.board_stage) ? r.board_stage : 'quote',
    balance: r.invoice_id ? round2(r.amount_due - r.amount_paid) : null,
  }))
  res.json({
    stages: ORDER_STAGES,
    columns: ORDER_STAGES.map((s) => ({ ...s, cards: cards.filter((c) => c.stage === s.key) })),
  })
}))

/** Move a card. The only way a stage changes by hand. */
app.put('/api/orders/:id/stage', wrap((req, res) => {
  const id = +req.params.id
  const stage = String(req.body?.stage || '')
  if (!ORDER_STAGE_KEYS.includes(stage)) return res.status(400).json({ error: 'Unknown stage' })
  const e = get('SELECT * FROM estimates WHERE id = ?', id)
  if (!e) return res.status(404).json({ error: 'Order not found' })
  run('UPDATE estimates SET board_stage = ?, stage_moved_at = ? WHERE id = ?', stage, now(), id)
  const label = ORDER_STAGES.find((s) => s.key === stage).label
  logActivity('stage', `${e.estimate_number} moved to ${label}`, { contact_id: e.contact_id })
  res.json({ ok: true, stage })
}))

/** Tracking number + carrier. Shown on the card and on the invoice the customer sees. */
app.put('/api/orders/:id/tracking', wrap((req, res) => {
  const id = +req.params.id
  const e = get('SELECT * FROM estimates WHERE id = ?', id)
  if (!e) return res.status(404).json({ error: 'Order not found' })
  const tracking = String(req.body?.tracking_number || '').trim().slice(0, 80)
  const carrier = String(req.body?.carrier || '').trim().slice(0, 40)
  run('UPDATE estimates SET tracking_number = ?, carrier = ? WHERE id = ?', tracking, carrier, id)
  // Adding a tracking number means it went out — move the card unless staff are already past Shipped.
  if (tracking) advanceOrder(id, 'shipped')
  if (tracking && tracking !== e.tracking_number) {
    logActivity('stage', `${e.estimate_number} shipped — ${carrier ? carrier + ' ' : ''}${tracking}`, { contact_id: e.contact_id })
  }
  res.json({ ok: true, tracking_number: tracking, carrier })
}))

/**
 * Duplicate an estimate as a fresh draft. Repeat business is most of a print shop's volume, and
 * re-quoting meant retyping every line and every cell of the size grid by hand. Copies items, notes
 * and the tax rate; deliberately does NOT copy status, sent/approved timestamps or the invoice link.
 */
app.post('/api/estimates/:id/duplicate', wrap((req, res) => {
  const src = get('SELECT * FROM estimates WHERE id = ?', +req.params.id)
  if (!src) return res.status(404).json({ error: 'Estimate not found' })
  const contactId = Number(req.body?.contact_id) || src.contact_id
  const items = freezeUpcharges(parse(src.items, []))
  // Copying a taxed estimate onto a DIFFERENT buyer must re-derive the rate against that buyer —
  // otherwise "duplicate this for the wholesale account" carries the taxable rate across.
  const rate = taxRateFor(contactId, contactId === src.contact_id ? src.tax_rate : null)
  const t = computeTotals(items, rate, getUpcharges())
  if (!representableLines(items) || !representableTotals(t)) return res.status(400).json(NOT_REPRESENTABLE)
  const num = nextEstimateNumber()
  // rush_days travels with the copy: the lines being duplicated carry the rush per-piece the
  // customer was billed, so the job this converts to has to be produced on that tier too.
  const id = Number(run(`INSERT INTO estimates (contact_id, estimate_number, status, items, subtotal, tax, total, notes, tax_rate, quote_meta, rush_days, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    contactId, num, 'draft', JSON.stringify(items), t.subtotal, t.tax, t.total,
    src.notes || '', rate, src.quote_meta || '{}', Math.max(0, Number(src.rush_days) || 0), now()).lastInsertRowid)
  logActivity('estimate', `${num} created from ${src.estimate_number}`, { contact_id: contactId })
  res.json({ ok: true, id, estimate_number: num })
}))

/* ---- mockup / artwork approval on an estimate (the lite edition's proof workflow) ---- */

/**
 * Artwork approval without a production floor. Proofs normally hang off a job, but lite has no job
 * board, so a mockup attaches to the estimate the customer is already reviewing. Reuses art_versions
 * and the same token-gated /p/art/:id page the pro proofs use — including its decide-once guard —
 * so there is exactly one approval surface to keep correct.
 *
 */
// Artwork approval is part of the product, not a tier. Always allowed.
const mockupGate = () => true

/** Art lives in the shop's Google Drive when connected, else on our disk. Prefer the Drive link. */
const artUrl = (a) => a.drive_link || `/uploads/${a.filename}`
const mockupRow = (a) => ({
  id: a.id, version: a.version, filename: a.filename, original_name: a.original_name, mime: a.mime,
  status: a.status, notes: a.notes, sent_at: a.sent_at, decided_at: a.decided_at, decided_by: a.decided_by,
  created_at: a.created_at, url: artUrl(a), drive: !!a.drive_file_id, share_url: shareUrl('art', a.id),
})

app.get('/api/estimates/:id/mockups', wrap((req, res) => {
  if (!mockupGate(req, res)) return
  const rows = all('SELECT * FROM art_versions WHERE estimate_id = ? ORDER BY version DESC', +req.params.id)
  res.json(rows.map(mockupRow))
}))

app.post('/api/estimates/:id/mockups', upload.single('file'), reTenant, wrap((req, res) => {
  if (!mockupGate(req, res)) return
  const eid = +req.params.id
  const e = get('SELECT * FROM estimates WHERE id = ?', eid)
  if (!e) { dropUpload(req); return res.status(404).json({ error: 'Estimate not found' }) }
  if (!req.file) return res.status(400).json({ error: 'Choose a file' })
  const artErr = validArtFile(req.file)
  if (artErr) { try { unlinkSync(req.file.path) } catch { /* best effort */ } return res.status(400).json({ error: artErr }) }
  const version = (get('SELECT COALESCE(MAX(version), 0) AS v FROM art_versions WHERE estimate_id = ?', eid).v) + 1
  const id = Number(run(`INSERT INTO art_versions (estimate_id, version, filename, original_name, mime, size, status, notes, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`,
    eid, version, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, 'draft', req.body?.notes || '', now()).lastInsertRowid)
  logActivity('art', `Mockup v${version} added to ${e.estimate_number}`, { contact_id: e.contact_id })
  res.json(mockupRow(get('SELECT * FROM art_versions WHERE id = ?', id)))
}))

/** Send the mockup to the customer for approval. Emails when the shop's email is connected; either
 *  way it returns the link so the shop can send it themselves. */
app.post('/api/mockups/:id/send', wrap((req, res) => {
  if (!mockupGate(req, res)) return
  const a = get('SELECT * FROM art_versions WHERE id = ?', +req.params.id)
  if (!a || !a.estimate_id) return res.status(404).json({ error: 'Mockup not found' })
  const e = get('SELECT * FROM estimates WHERE id = ?', a.estimate_id)
  const c = get('SELECT * FROM contacts WHERE id = ?', e?.contact_id)
  const s = getSettings()
  run(`UPDATE art_versions SET status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END, sent_at = COALESCE(sent_at, ?) WHERE id = ?`, now(), a.id)
  const link = `${publicOrigin(req)}${shareUrl('art', a.id)}`
  // queueEmail records to the Outbox and delivers when the shop's email is connected — so a shop
  // with no email yet still gets a durable record plus the link to send by hand.
  if (c?.email) {
    queueEmail({
      contact: c, kind: 'art', subject: `Mockup for approval — ${e.estimate_number}`,
      template: `Hi {{first_name}},\n\nYour mockup for {{estimate_number}} is ready to look over:\n\n{{link}}\n\nCheck the spelling, placement, sizing and colors. Once you approve it, that is exactly what we print.\n\n— {{shop_name}}`,
      vars: { estimate_number: e.estimate_number, link, shop_name: s.shop_name },
    })
  }
  logActivity('art', `Mockup v${a.version} sent for approval on ${e.estimate_number}`, { contact_id: e?.contact_id })
  res.json({ ok: true, link, emailed_to: c?.email || null, email_live: notifyStatus(s).shop_email })
}))

app.delete('/api/mockups/:id', requireRole('manager'), wrap((req, res) => {
  if (!mockupGate(req, res)) return
  const a = get('SELECT * FROM art_versions WHERE id = ?', +req.params.id)
  if (!a || !a.estimate_id) return res.status(404).json({ error: 'Mockup not found' })
  run('DELETE FROM art_versions WHERE id = ?', a.id)
  res.json({ ok: true })
}))

/**
 * What the JOB should say about time, derived from the estimate that priced it.
 *
 * Exported shape, and its own function, because the defect was that nothing derived it at all:
 * convert bound neither `rush` nor `turnaround_days`, so the column defaults landed — 0 and 10 —
 * on a job whose customer had just paid the shop's 3-day tier. On a 300-piece order billed
 * $4,280.00 against a $2,870.00 standard price, the job was promised 2026-09-02, projected
 * 2026-09-11 the instant it was created, and rewritten by applyArtApproval to 2026-09-14 when the
 * proof came back: eight working days past the date the customer bought. Nothing on the floor
 * knew — no RUSH badge on the board card, no banner on the work ticket, no pill in Floor Mode,
 * and `GET /api/board?filter=rush`, the view a manager opens to ask what has to go out first,
 * returned seven empty columns on every shop whose rush work is quoted through any automated path.
 * capacity.mjs's rush tiebreak could never fire either, so on a tied due date the premium job was
 * scheduled second.
 *
 * A date a human typed on the convert dialog IS the turnaround they mean, whether it is a rush or
 * not — that also fixes the ordinary case of a customer who stated an in-hands date.
 */
function jobScheduleFromEstimate(e, body) {
  const rushDays = Math.max(0, Number(e?.rush_days) || 0)
  const picked = String(body?.due_date || '').trim()
  const hasPicked = /^\d{4}-\d{2}-\d{2}$/.test(picked)
  const today = todayIso()
  const days = rushDays || 10
  const due_date = hasPicked ? picked : addBusinessDays(today, days)
  return {
    due_date,
    turnaround_days: hasPicked ? Math.max(1, businessDaysBetween(today, due_date)) : days,
    rush: rushDays > 0 ? 1 : 0,
  }
}

/** Approved estimate -> invoice + production job, in one move. */
app.post('/api/estimates/:id/convert', wrap((req, res) => {
  const id = +req.params.id
  const e = get('SELECT * FROM estimates WHERE id = ?', id)
  if (!e) return res.status(404).json({ error: 'Estimate not found' })
  const existing = get("SELECT * FROM invoices WHERE estimate_id = ? AND status != 'void'", id)
  if (existing) return res.status(409).json({ error: `Already invoiced as ${existing.invoice_number}` })

  // Honor the date the shop actually picked. The convert dialog has asked for a due date all along
  // and this ignored it, so every invoice silently came out Net 15 no matter what was entered.
  const picked = String(req.body?.due_date || '').trim()
  const due = /^\d{4}-\d{2}-\d{2}$/.test(picked) ? picked : new Date(Date.now() + 15 * 864e5).toISOString().slice(0, 10)
  const items = parse(e.items, [])
  const title = req.body?.title || items[0]?.description || `Order for ${get('SELECT name FROM contacts WHERE id=?', e.contact_id)?.name || 'customer'}`
  // Carry the actual size grid onto the job — the press and packing table need
  // "40 S / 90 M / 110 L", not a piece count.
  const sizes = rollupSizes(items)
  // …and keep the per-garment grids beside it. The rolled-up total is right for piece counts and
  // capacity, and wrong for anything that buys or picks blanks: merging tees and hoodies into one
  // grid is why the purchase order used to order the first style for the whole quantity.
  const lines = garmentLines(items)
  const qty = items.reduce((s, i) => s + lineQty(i), 0)

  // Invoice + job + estimate-status, atomically. Before this was three unguarded writes: a crash
  // after the invoice insert left a billable invoice with no production job and an estimate stuck
  // at draft, and the 409 guard above then blocked every retry — an unrecoverable wedge.
  const { invId, jobId, invNum, jobNum } = tx(() => {
    const invNum = nextInvoiceNumber()
    const invId = Number(run('INSERT INTO invoices (estimate_id, contact_id, invoice_number, status, amount_due, amount_paid, due_date, created_at) VALUES (?,?,?,?,?,?,?,?)',
      id, e.contact_id, invNum, 'unpaid', e.total, 0, due, now()).lastInsertRowid)
    const jobNum = nextJobNumber()
    const garmentText = (items.find((i) => i.sizes)?.description || items[0]?.description || '').split('—')[0].trim()
    const sched = jobScheduleFromEstimate(e, req.body)
    const jobId = Number(run('INSERT INTO jobs (contact_id, estimate_id, invoice_id, job_number, title, status, stage, decoration, garment, sizes, line_sizes, quantities, due_date, turnaround_days, rush, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      e.contact_id, id, invId, jobNum, title, 'active', 'new', items[0]?.decoration || 'Screen Print', garmentText || null,
      JSON.stringify(sizes), JSON.stringify(lines), sizeSummary(sizes) || `${qty} pcs`,
      sched.due_date, sched.turnaround_days, sched.rush, e.notes || '', now(), now()).lastInsertRowid)
    run(`UPDATE estimates SET status='approved', approved_at=COALESCE(approved_at,?) WHERE id=?`, now(), id)
    return { invId, jobId, invNum, jobNum }
  })
  logActivity('invoice', `Estimate ${e.estimate_number} converted — invoice ${invNum}, job ${jobNum}`, { contact_id: e.contact_id, job_id: jobId })
  res.json({ ok: true, invoice_id: invId, job_id: jobId, invoice_number: invNum, job_number: jobNum })
}))

app.get('/api/estimates/:id/pdf', wrap((req, res) => {
  const e = get('SELECT * FROM estimates WHERE id = ?', +req.params.id)
  if (!e) return res.status(404).send('Not found')
  const pdf = renderDocument('ESTIMATE', {
    doc: e, contact: get('SELECT * FROM contacts WHERE id = ?', e.contact_id),
    settings: getSettings(), items: parse(e.items, []), upcharges: getUpcharges(),
  })
  res.type('application/pdf')
    .setHeader('Content-Disposition', `inline; filename="${e.estimate_number}.pdf"`)
  res.send(pdf)
}))

/* ================= INVOICES ================= */

app.get('/api/invoices', wrap((req, res) => {
  const status = req.query.status
  // Report and filter on the EFFECTIVE status so this list agrees with the dashboard's
  // money-at-risk figure, which has always been computed live from due_date.
  const today = todayIso()
  let sql = `SELECT i.*, ${EFFECTIVE_STATUS_SQL} AS status, c.name AS contact_name, c.company, e.estimate_number
    FROM invoices i
    LEFT JOIN contacts c ON c.id=i.contact_id LEFT JOIN estimates e ON e.id=i.estimate_id`
  const params = [today]
  if (status && status !== 'all') { sql += ` WHERE ${EFFECTIVE_STATUS_SQL} = ?`; params.push(today, status) }
  sql += ' ORDER BY i.id DESC'
  res.json(all(sql, ...params))
}))

app.get('/api/invoices/:id', wrap((req, res) => {
  const i = get(`SELECT i.*, c.name AS contact_name, c.email AS contact_email FROM invoices i LEFT JOIN contacts c ON c.id=i.contact_id WHERE i.id=?`, +req.params.id)
  if (!i) return res.status(404).json({ error: 'Invoice not found' })
  const est = i.estimate_id ? get('SELECT * FROM estimates WHERE id = ?', i.estimate_id) : null
  res.json({
    ...i, items: est ? parse(est.items, []) : [], payments: all('SELECT * FROM payments WHERE invoice_id = ? ORDER BY id', i.id),
    // The invoice's own totals block prints these line items and then asks for amount_due, which is
    // subtotal + tax — so without the breakdown the screen shows a table that does not add up to the
    // number beside it. The invoice carries no subtotal/tax of its own; they live on the estimate it
    // was converted from, and this is the only route that can reach them.
    subtotal: est ? est.subtotal : null, tax: est ? est.tax : null, tax_rate: est ? est.tax_rate : null,
    pay_link: shareUrl('pay', i.id), stripe_ready: paymentsReady(getSettings()),
  })
}))

/** Email the customer a secure link to pay online (deposit or balance) through the shop's Stripe. */
/**
 * Amend an invoice's terms. Only the due date and PO reference — the amount comes from the estimate's
 * line items and must not be editable here, or the invoice and the quote it came from would disagree.
 *
 * Existed nowhere before: the due date was fixed at conversion and there was no way to change it, so
 * a customer who asked for Net 30 after the fact made the invoice permanently wrong (and it would
 * start reporting itself overdue, and firing overdue reminders, on the original date).
 */
app.put('/api/invoices/:id', requireRole('manager'), wrap((req, res) => {
  const id = +req.params.id
  const inv = get('SELECT * FROM invoices WHERE id = ?', id)
  if (!inv) return res.status(404).json({ error: 'Invoice not found' })
  const b = req.body || {}
  const due = String(b.due_date || '').trim()
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return res.status(400).json({ error: 'Due date must be YYYY-MM-DD' })
  if (due) run('UPDATE invoices SET due_date = ? WHERE id = ?', due, id)
  if (b.po_number !== undefined) run('UPDATE invoices SET po_number = ? WHERE id = ?', String(b.po_number || '').slice(0, 60), id)
  // Recompute overdue/partial/paid against the new date rather than leaving a stale status behind.
  syncInvoiceStatus(id)
  if (due && due !== inv.due_date) logActivity('invoice', `${inv.invoice_number} due date changed ${inv.due_date} → ${due}`, { contact_id: inv.contact_id })
  res.json(get('SELECT * FROM invoices WHERE id = ?', id))
}))

/**
 * Void an invoice — the way out of an invoice raised against the wrong customer or amount.
 *
 * There was no way out. No DELETE route existed, PUT edits only the due date and PO number, and
 * the estimate behind it refuses to be deleted once converted. So an invoice sent to Lakeside High
 * that was meant for Harbor City Brewfest counted toward money owed forever, chased the wrong
 * customer on every overdue scan, and got pushed to QuickBooks — and the only fix was sqlite3 on
 * the server, which the owner of a shop does not have and should not need.
 *
 * Void rather than delete, deliberately: the invoice number was issued and a customer may have
 * seen it, so the record stays and says what happened. It simply stops being a demand for money.
 */
app.post('/api/invoices/:id/void', requireRole('manager'), wrap((req, res) => {
  const id = +req.params.id
  const inv = get('SELECT * FROM invoices WHERE id = ?', id)
  if (!inv) return res.status(404).json({ error: 'Invoice not found' })
  if (inv.status === 'void') return res.json({ ok: true, already: true, invoice: inv })
  // Money already recorded against it is a bookkeeping fact, and voiding around it would leave a
  // payment attached to nothing. Say which payments and let the human decide.
  if (Number(inv.amount_paid) > 0) {
    return res.status(409).json({
      error: `${inv.invoice_number} has ${money(inv.amount_paid)} in payments recorded against it. Remove those payments first, then void it.`,
      code: 'invoice_has_payments',
    })
  }
  const reason = String(req.body?.reason || '').slice(0, 200)
  run("UPDATE invoices SET status = 'void', voided_at = ?, void_reason = ? WHERE id = ?", now(), reason, id)
  // The convert that raised this invoice also raised a production job, and the job kept pointing
  // at the cancelled invoice — so the board still showed work billed to nothing. Don't delete it
  // (the shop may already be printing) — just unhook it, so re-converting the estimate does not
  // leave two jobs fighting over one invoice, and say so on the timeline.
  const freed = run('UPDATE jobs SET invoice_id = NULL WHERE invoice_id = ?', id).changes
  logActivity('invoice', `${inv.invoice_number} voided${reason ? ` — ${reason}` : ''}${freed ? ' · its job is no longer billed to it' : ''}`, { contact_id: inv.contact_id })
  res.json({ ok: true, invoice: get('SELECT * FROM invoices WHERE id = ?', id) })
}))

app.post('/api/invoices/:id/request-payment', wrap((req, res) => {
  const id = +req.params.id
  const inv = get('SELECT * FROM invoices WHERE id = ?', id)
  if (!inv) return res.status(404).json({ error: 'Invoice not found' })
  const c = get('SELECT * FROM contacts WHERE id = ?', inv.contact_id)
  // A voided invoice is a cancelled demand. POST /payments and both public pay routes were taught
  // that in v1.11.0; this one was missed, so the app would build a live pay link for a cancelled
  // document and email a real customer a real demand for money the shop had already withdrawn.
  if (refuseVoided(inv, res) || requireCustomerEmail(c, res, 'payment link')) return
  const s = getSettings()
  const balance = round2(inv.amount_due - inv.amount_paid)
  const origin = publicOrigin(req)
  const link = origin + shareUrl('pay', id)
  const deliver = s.mode_followups !== 'manual'
  queueEmail({ contact: c, kind: 'payment', subject: `Payment link for invoice ${inv.invoice_number}`,
    template: `Hi {{first_name}},\n\nYou can pay invoice ${inv.invoice_number} (balance ${money(balance)}) securely online here:\n\n${link}\n\nThank you,\n{{shop_name}}`,
    vars: { shop_name: s.shop_name }, deliver })
  logActivity('note', `Payment link ${deliver ? 'sent' : 'drafted'} for ${inv.invoice_number}`, { contact_id: inv.contact_id })
  res.json({ ok: true, delivered: deliver, link, stripe_ready: paymentsReady(s) })
}))

app.post('/api/invoices/:id/payments', wrap((req, res) => {
  const id = +req.params.id
  const inv = get('SELECT * FROM invoices WHERE id = ?', id)
  if (!inv) return res.status(404).json({ error: 'Invoice not found' })
  // A voided invoice is a cancelled demand, not a discounted one. syncInvoiceStatus deliberately
  // refuses to move a void invoice, so a payment recorded here inserted a real row, counted toward
  // Revenue MTD and went to QuickBooks — while the invoice itself still read $0.00 paid. Money that
  // exists in three places and nowhere on the document it belongs to is the worst kind of wrong.
  if (inv.status === 'void') {
    return res.status(409).json({
      error: `${inv.invoice_number} was voided — raise a new invoice before recording money against it.`,
      code: 'invoice_void',
    })
  }
  // Reject, never coerce — the same rule the v1 API's quantity fields got, on the one route in
  // the product that puts cash on an invoice. round2() starts `Number(n) || 0`, so `true` came
  // through as a $1.00 payment and `[40]` as $40.00, both with a 200, both inserted into
  // `payments`, counted in Revenue MTD, written to the customer's timeline and queued for
  // QuickBooks. A checkbox serialised into the wrong field, or a form library that posts a
  // single-value array, is enough — and the invoice then reads part-paid against money nobody
  // received. A numeric string is still accepted: that is what an HTML form posts.
  const rawAmount = req.body?.amount
  if (typeof rawAmount !== 'number' && !(typeof rawAmount === 'string' && rawAmount.trim() !== '')) {
    return res.status(400).json({ error: 'Payment amount must be a number', code: 'invalid_amount' })
  }
  const amount = round2(rawAmount)
  if (!Number.isFinite(Number(rawAmount)) || !(amount > 0)) return res.status(400).json({ error: 'Payment amount must be greater than zero', code: 'invalid_amount' })
  // Guard fat-finger over-payment: a manual entry can't exceed the remaining balance.
  const bal = round2(inv.amount_due - inv.amount_paid)
  if (amount > bal + 0.01) return res.status(400).json({ error: `That's more than the ${money(bal)} balance due.` })
  // Clamp to the balance so the accepted-within-tolerance cent can't push amount_paid past
  // amount_due into a negative balance (matches what recordStripePayment already does).
  const recorded = Math.min(amount, bal)
  const method = req.body?.method || 'other'
  const note = req.body?.note || ''
  /**
   * The same cheque, recorded twice, is money the shop does not have.
   *
   * The only guard here was the over-payment check, which catches a doubled FULL payment because
   * the second one exceeds the remaining balance — and catches nothing else. Two $500 posts
   * against a $1,000 invoice both return 200, and the invoice comes back amount_paid $1,000,
   * status "paid". `invoice.paid` fires, a QuickBooks push queues, the customer is never chased
   * for the $500 they still owe, and Revenue MTD shows income that does not exist.
   *
   * It is not a rare race. The dialog's in-flight guard is per-tab, so two people at two desks
   * with the same cheque, one person on a phone and a laptop, or a re-click after a response that
   * never arrived, all walk straight past it. Recording the same amount, method and note against
   * one invoice inside two minutes is a duplicate until a human says otherwise — so this is a
   * question, not a wall: the answer names the payment it matched and how to say "yes, really".
   */
  if (req.body?.confirm !== true) {
    const since = new Date(Date.now() - 120_000).toISOString().replace('T', ' ').slice(0, 19)
    const dup = get(`SELECT id, amount, created_at FROM payments
      WHERE invoice_id = ? AND amount = ? AND COALESCE(method, '') = ? AND COALESCE(note, '') = ? AND created_at >= ?
      ORDER BY id DESC LIMIT 1`, id, recorded, method, note, since)
    if (dup) {
      return res.status(409).json({
        error: `${money(recorded)} by ${method}${note ? ` — "${note}"` : ''} was already recorded on ${inv.invoice_number} moments ago. Record it again only if it really is a second payment.`,
        code: 'duplicate_payment',
        duplicate_of: dup.id,
        recorded_at: dup.created_at,
      })
    }
  }
  run('INSERT INTO payments (invoice_id, amount, method, note, created_at) VALUES (?,?,?,?,?)',
    id, recorded, method, note, now())
  const updated = syncInvoiceStatus(id)
  // Money in — walk the order card forward (never backward; see advanceOrder).
  advanceOrder(inv.estimate_id, 'paid')
  logActivity('payment', `Payment ${money(recorded)} on ${inv.invoice_number} (${method})`, { contact_id: inv.contact_id })
  if (updated.status === 'paid' && inv.status !== 'paid') {
    fireAuto('invoice.paid', { invoice: updated, contact: get('SELECT * FROM contacts WHERE id = ?', inv.contact_id), total: updated.amount_due })
  }
  enqueueQbo(id) // money moved — the books should hear about it without anyone clicking
  res.json(updated)
}))

/**
 * Remove a recorded payment.
 *
 * Recording one writes an activity row; removing one wrote nothing. So money left the books
 * silently: Revenue MTD dropped, the invoice went back to unpaid, four lines disappeared from the
 * QuickBooks export — and the customer's timeline still read "Payment $3,600.00 on INV-1001
 * (check)", because that entry describes a payment that no longer exists. Every other money event
 * in the product logs. In a shop with staff this was the one that could not be traced to anyone.
 *
 * The row is written against the contact rather than deleted-along-with anything, so it survives.
 */
app.delete('/api/payments/:id', requireRole('manager'), wrap((req, res) => {
  const p = get('SELECT * FROM payments WHERE id = ?', +req.params.id)
  if (!p) return res.status(404).json({ error: 'Payment not found', code: 'not_found' })
  const inv = get('SELECT invoice_number, contact_id FROM invoices WHERE id = ?', p.invoice_id)
  run('DELETE FROM payments WHERE id = ?', p.id)
  const out = syncInvoiceStatus(p.invoice_id)
  logActivity('payment', `Payment ${money(p.amount)} REMOVED from ${inv?.invoice_number || `invoice #${p.invoice_id}`} (${p.method || 'other'})${p.note ? ` — ${String(p.note).slice(0, 100)}` : ''}`,
    { contact_id: inv?.contact_id ?? null })
  res.json(out)
}))

/**
 * A message the shop is told went out must be a message that could go out.
 *
 * queueEmail writes an email_log row with `to_email = contact?.email ?? ''` and only actually
 * sends `if (deliver && to)`. Three routes called it and then answered {ok:true} with a timeline
 * entry asserting delivery — "Invoice INV-1007 emailed to customer", "Payment reminder sent" —
 * for a customer with no email address at all. The shop believed it had chased the money. This is
 * the dunning path; the two siblings on the same screen already refused, which is how the
 * inconsistency was found.
 */
const requireCustomerEmail = (c, res, what) => {
  if (c?.email) return false
  res.status(400).json({
    error: `${c?.name || 'This customer'} has no email address on file, so the ${what} could not be sent. Add one on their record and try again.`,
    code: 'no_email',
  })
  return true
}
/** A voided invoice is a cancelled demand. Nothing may chase money on it. */
const refuseVoided = (inv, res) => {
  if (inv.status !== 'void') return false
  res.status(409).json({
    error: `${inv.invoice_number} was voided — raise a new invoice before asking the customer to pay it.`,
    code: 'invoice_void',
  })
  return true
}

app.post('/api/invoices/:id/send', wrap((req, res) => {
  const inv = get('SELECT * FROM invoices WHERE id = ?', +req.params.id)
  if (!inv) return res.status(404).json({ error: 'Invoice not found' })
  const c = get('SELECT * FROM contacts WHERE id = ?', inv.contact_id)
  if (refuseVoided(inv, res) || requireCustomerEmail(c, res, 'invoice')) return
  const s = getSettings()
  queueEmail({ contact: c, kind: 'invoice', subject: `Invoice ${inv.invoice_number} from ${s.shop_name}`,
    template: s.email_template_invoice,
    vars: { contact_name: c?.name || '', invoice_number: inv.invoice_number, total: money(inv.amount_due), due_date: inv.due_date } })
  logActivity('invoice', `Invoice ${inv.invoice_number} emailed to ${c.email}`, { contact_id: inv.contact_id })
  res.json({ ok: true, emailed_to: c.email, email_live: notifyStatus(s).shop_email })
}))

app.get('/api/invoices/:id/pdf', wrap((req, res) => {
  const i = get('SELECT * FROM invoices WHERE id = ?', +req.params.id)
  if (!i) return res.status(404).send('Not found')
  const est = i.estimate_id ? get('SELECT * FROM estimates WHERE id = ?', i.estimate_id) : null
  // Carry the real subtotal/tax onto the invoice doc so the PDF shows a proper Subtotal → Tax →
  // Total breakdown that reconciles to amount_due, instead of labeling the tax-inclusive total "Subtotal".
  const pdf = renderDocument('INVOICE', {
    doc: { ...i, subtotal: est ? est.subtotal : round2(i.amount_due), tax: est ? est.tax : 0, total: i.amount_due, tax_rate: est?.tax_rate },
    contact: get('SELECT * FROM contacts WHERE id = ?', i.contact_id),
    settings: getSettings(), items: est ? parse(est.items, []) : [{ description: 'Custom apparel order', qty: 1, unit_price: i.amount_due }],
    payments: all('SELECT * FROM payments WHERE invoice_id = ? ORDER BY id', i.id), upcharges: getUpcharges(),
  })
  res.type('application/pdf').setHeader('Content-Disposition', `inline; filename="${i.invoice_number}.pdf"`)
  res.send(pdf)
}))

/* ================= JOBS / BOARD ================= */

export const STAGES = [
  { key: 'new', label: 'New' },
  { key: 'art_approval', label: 'Art Approval' },
  { key: 'prepress', label: 'Prepress' },
  { key: 'production', label: 'Production' },
  { key: 'qc', label: 'QC' },
  { key: 'shipping', label: 'Shipping' },
  { key: 'complete', label: 'Complete' },
]
const STAGE_KEYS = STAGES.map((s) => s.key)

app.get('/api/board', wrap((req, res) => {
  const jobs = all(`SELECT j.*, c.name AS contact_name, c.company,
      (SELECT COUNT(*) FROM art_versions a WHERE a.job_id = j.id) AS art_count,
      (SELECT status FROM art_versions a WHERE a.job_id = j.id ORDER BY version DESC LIMIT 1) AS art_status,
      i.status AS invoice_status
    FROM jobs j LEFT JOIN contacts c ON c.id = j.contact_id LEFT JOIN invoices i ON i.id = j.invoice_id
    WHERE j.status = 'active' ORDER BY j.rush DESC, j.due_date IS NULL, j.due_date, j.sort_order, j.id`)
    .map((j) => ({ ...j, pieces: sizeTotal(parse(j.sizes, {})) }))

  // Filters are applied server-side so the counts in the column headers stay honest.
  const { assignee, filter } = req.query
  const today = new Date().toISOString().slice(0, 10)
  let shown = jobs
  if (assignee && assignee !== 'all') shown = shown.filter((j) => (j.assigned_to || '') === assignee)
  if (filter === 'rush') shown = shown.filter((j) => j.rush)
  if (filter === 'late') shown = shown.filter((j) => j.due_date && j.due_date < today)
  if (filter === 'week') shown = shown.filter((j) => j.due_date && j.due_date <= new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10))
  if (filter === 'unpaid') shown = shown.filter((j) => j.invoice_status && j.invoice_status !== 'paid')

  const columns = STAGES.map((s) => {
    const list = shown.filter((j) => j.stage === s.key)
    return { ...s, jobs: list, pieces: list.reduce((t, j) => t + j.pieces, 0) }
  })
  res.json({
    stages: STAGES, columns,
    assignees: [...new Set(jobs.map((j) => j.assigned_to).filter(Boolean))].sort(),
    counts: { all: jobs.length, rush: jobs.filter((j) => j.rush).length,
      late: jobs.filter((j) => j.due_date && j.due_date < today).length,
      unpaid: jobs.filter((j) => j.invoice_status && j.invoice_status !== 'paid').length },
  })
}))

app.get('/api/jobs/:id', wrap((req, res) => {
  const j = get(`SELECT j.*, c.name AS contact_name, c.email AS contact_email, c.phone AS contact_phone, c.company,
    i.invoice_number, i.status AS invoice_status, i.amount_due, i.amount_paid, e.estimate_number
    FROM jobs j LEFT JOIN contacts c ON c.id=j.contact_id LEFT JOIN invoices i ON i.id=j.invoice_id
    LEFT JOIN estimates e ON e.id=j.estimate_id WHERE j.id=?`, +req.params.id)
  if (!j) return res.status(404).json({ error: 'Job not found' })
  res.json({
    ...j,
    schedule: scheduleFor(j),
    ticket_url: shareUrl('ticket', j.id), // tokenized internal work-ticket link for staff printing
    art: all('SELECT * FROM art_versions WHERE job_id = ? ORDER BY version DESC', j.id).map((a) => ({ ...a, url: artUrl(a), drive: !!a.drive_file_id }))
      .map((a) => ({ ...a, share_url: shareUrl('art', a.id) })),
    activities: all('SELECT * FROM activities WHERE job_id = ? ORDER BY created_at DESC, id DESC LIMIT 30', j.id),
  })
}))

// Turn the job form's free-text "24 S / 60 M / 80 L / 36 XL" into a real size grid, and store it
// as `sizes`. A job created on the board never had one, so jobPieces() fell through to a
// quantities field it could not parse and returned 0 — which meant the job booked zero press
// minutes in the schedule, printed a blank size table, ordered no blanks, and reported no ROI.
const gridFromQuantities = (q) => {
  const g = parseSizeRun(String(q || ''))
  return sizeTotal(g) > 0 ? JSON.stringify(g) : null
}

app.post('/api/jobs', wrap((req, res) => {
  const b = req.body || {}
  const contactId = resolveContactId(b.contact_id, res, 'book a job')
  if (contactId == null) return
  const num = nextJobNumber()
  const grid = gridFromQuantities(b.quantities)
  // `garment` is what costFor() reads to pick the SKU the purchase order spends money on. A job
  // typed onto the board never had a way to carry one — the column existed and no route bound it —
  // so its PO came back sku:null, est_cost 0, and submitting it said "set the exact style first"
  // with no field anywhere in the product to do that in. 17 columns, 17 placeholders, 17 values.
  const id = Number(run('INSERT INTO jobs (contact_id, estimate_id, invoice_id, job_number, title, status, stage, decoration, garment, quantities, sizes, due_date, notes, assigned_to, rush, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    contactId, b.estimate_id || null, b.invoice_id || null, num, b.title || 'Untitled job', 'active',
    STAGE_KEYS.includes(b.stage) ? b.stage : 'new', b.decoration || 'Screen Print', str(b.garment).trim() || null, b.quantities || '',
    grid || '{}', b.due_date || null, b.notes || '', b.assigned_to || '', b.rush ? 1 : 0, now(), now()).lastInsertRowid)
  logActivity('job', `Job ${num} created — ${b.title || 'Untitled job'}`, { contact_id: contactId, job_id: id })
  res.json(get('SELECT * FROM jobs WHERE id = ?', id))
}))

app.put('/api/jobs/:id', wrap((req, res) => {
  const id = +req.params.id
  const j = get('SELECT * FROM jobs WHERE id = ?', id)
  if (!j) return res.status(404).json({ error: 'Job not found' })
  const b = req.body || {}
  // The one door out of a closed ring. A two-garment job that has been invoiced and part-paid had
  // NO way to have its sizes corrected — the customer adds four hoodies and the shop is stuck:
  //   PUT /api/jobs/:id      → 409 below, "edit the split per garment on the estimate"
  //   PUT /api/estimates/:id → 409 "Already invoiced — edit the invoice, not the estimate"
  //   PUT /api/invoices/:id  → 200, and touches nothing but the due date and the PO number
  //   POST .../void          → 409 "Remove those payments first" — i.e. delete a record of real
  //                            cash that is in the bank, to fix a size.
  // Every one of those refusals is correct on its own; together they are a dead end with no shell
  // to escape from. The 409 below already hands the caller the exact per-garment structure it
  // wants; this accepts it back. Validated hard, because these numbers are what the purchase
  // order spends the shop's money on.
  let explicitLines = null
  if (b.line_sizes !== undefined) {
    const refuse = (error) => res.status(400).json({ error, code: 'bad_line_sizes' })
    if (!Array.isArray(b.line_sizes) || !b.line_sizes.length) return refuse('Send line_sizes as a list of garments, each with its own size grid.')
    if (b.line_sizes.length > 50) return refuse('A job cannot carry more than 50 garment lines.')
    const out = []
    for (const [i, l] of b.line_sizes.entries()) {
      if (!l || typeof l !== 'object' || Array.isArray(l) || !l.sizes || typeof l.sizes !== 'object' || Array.isArray(l.sizes)) {
        return refuse(`Garment ${i + 1} has no size grid.`)
      }
      const sizes = {}
      for (const [size, n] of Object.entries(l.sizes)) {
        // Not Number(n): '' and null coerce to 0 and would quietly drop a size the shop typed.
        if (!Number.isInteger(n) || n < 0 || n > 1000000) return refuse(`Garment ${i + 1}: ${JSON.stringify(String(size)).slice(0, 40)} is ${JSON.stringify(n)}, which is not a piece count.`)
        // The same rule the estimate uses. These two halves disagreed: the estimate DELETED any
        // key outside SIZES, while this accepted any string at all truncated to 12 characters — so
        // a job could carry a size its own quote had thrown away, and the only thing standing
        // between a stored `<script>alert` key and the screens that render it was every render
        // site remembering to escape. One definition, and it refuses rather than dropping.
        const key = String(size).trim().toUpperCase()
        if (!SIZE_KEY.test(key)) return res.status(400).json(unknownSizes([String(size).slice(0, 24)]))
        if (n > 0) sizes[key] = n
      }
      if (!sizeTotal(sizes)) continue
      const description = str(l.description ?? l.garment ?? '').trim().slice(0, 300)
      out.push({ description, garment: (str(l.garment ?? '').trim() || description.split('—')[0].trim()).slice(0, 200), sizes })
    }
    if (!out.length) return refuse('Every garment came to zero pieces — a job has to make something.')
    explicitLines = out
  }
  // Re-derive the size grid when the quantities text changes — but never clobber a grid that came
  // from a converted estimate (which is already structured) with an empty parse of an untouched
  // free-text field. Only overwrite when the parse actually yields sizes.
  const nextQuantities = explicitLines ? sizeSummary(rollupSizes(explicitLines)) : (b.quantities ?? j.quantities)
  const reparsed = !explicitLines && b.quantities !== undefined ? gridFromQuantities(b.quantities) : null
  const nextSizes = explicitLines ? JSON.stringify(rollupSizes(explicitLines)) : (reparsed || j.sizes || '{}')
  // jobs.line_sizes is the per-garment grid the PO, the pick ticket, the work ticket and the print
  // package all read. It is written once at conversion, and PUT never touched it — so a shop that
  // bumped a job from 100 pieces to 150 (the ordinary case: the customer added shirts) got a board,
  // a job card and a capacity plan saying 150, while everything that BUYS or PICKS blanks still
  // said 100. The print package contradicted itself on one screen.
  let nextLines = explicitLines ? JSON.stringify(explicitLines) : j.line_sizes
  if (reparsed) {
    // jobLines(), not the raw column. line_sizes is '[]' on every job written before that column
    // existed, and on those the per-garment split lives on the estimate — jobLines() is the
    // function that knows all three sources. Reading the column alone saw "no garments here",
    // took the single-garment branch below, and MERGED a tees-and-hats job into one style: the
    // purchase order then bought 60 more tees in a size that style does not come in, at the tee's
    // price, with every warning the correct PO carried gone, and no undo. On an upgraded install
    // that is every job the shop has — and it made the split editor unreachable, because the
    // editor only opens from the 409 that could never fire.
    const stored = jobLines(j)
    const lines = Array.isArray(stored) ? stored.filter((l) => l && sizeTotal(l.sizes || {}) > 0) : []
    if (lines.length <= 1) {
      const one = lines[0] || { description: j.garment || '', garment: j.garment || '' }
      nextLines = JSON.stringify([{ ...one, sizes: JSON.parse(reparsed) }])
    } else {
      // Two or more garments cannot be re-split out of one flat "24 S / 60 M" string, and guessing
      // would put the wrong count against the wrong style on a real purchase order. Refuse, and
      // say which garments are involved so the shop knows what it is looking at.
      return res.status(409).json({
        error: `${j.job_number} covers ${lines.length} garments — edit the size split per garment on the estimate, not the combined grid.`,
        code: 'multi_garment_quantities',
        lines: lines.map((l) => ({ garment: l.garment || l.description || '', sizes: l.sizes })),
      })
    }
  }
  const nextGarment = b.garment !== undefined ? (str(b.garment).trim() || null) : j.garment
  // …and the style has to reach the line the PURCHASE ORDER reads. jobLines() takes line_sizes
  // first, so on every estimate-converted job this column was written and then ignored: the job
  // form's Garment field is captioned "What the purchase order buys", the shop typed the exact
  // style, and the PO still came back sku:null with "match the exact style first" — advice no
  // screen could follow, because the estimate behind it is 409-locked by its own invoice, the
  // invoice PUT edits only a due date, and the split editor opens only for two or more garments.
  // A quote line says "Tee", not a catalogue style, because it is written for a customer to read.
  // When the job carries exactly ONE garment line, the style just typed IS that line's style;
  // with two or more, the split editor is where each one is named.
  if (!explicitLines && b.garment !== undefined && nextGarment && nextGarment !== j.garment) {
    const cur = jobLines({ ...j, line_sizes: nextLines })
    if (Array.isArray(cur) && cur.length === 1) {
      nextLines = JSON.stringify([{ ...cur[0], description: nextGarment, garment: nextGarment }])
    }
  }
  // str() on every free-text field, not just `garment`. node:sqlite refuses to bind an object or
  // an array and — worse — reads a bare object as a NAMED-parameter bag, so `{"title":{"a":1}}`
  // came back "Unknown named parameter" and the route answered a bare 500 with no field named and
  // nothing the caller could act on. str() was written for exactly this and was applied to one
  // field out of seven. An omitted field still means "leave it alone"; a malformed one now falls
  // back to what was already stored rather than taking the route down.
  run('UPDATE jobs SET title=?, decoration=?, garment=?, quantities=?, sizes=?, line_sizes=?, due_date=?, notes=?, assigned_to=?, rush=?, updated_at=? WHERE id=?',
    str(b.title, j.title), str(b.decoration, j.decoration), nextGarment, nextQuantities, nextSizes, nextLines, str(b.due_date, j.due_date),
    // `??` on every other field, and `b.rush ? 1 : 0` on this one — so any partial update cleared
    // it. PUT /api/jobs/:id {notes:"..."} took a job off RUSH: it dropped down the board's sort,
    // lost its badge on the work ticket and on Today, and stopped being counted by the Rush filter.
    // Nothing said so, and nothing on the job records that it ever was one.
    str(b.notes, j.notes), str(b.assigned_to, j.assigned_to), b.rush === undefined ? (j.rush ? 1 : 0) : (b.rush ? 1 : 0), now(), id)
  // A split change moves what the shop BUYS, on a job that may already have blanks on order, so
  // it goes on the timeline rather than happening silently between two screens.
  if (explicitLines && nextLines !== j.line_sizes) {
    logActivity('job', `${j.job_number} size split changed — ${nextQuantities || 'no sizes'}`, { contact_id: j.contact_id, job_id: id })
  }
  res.json(get('SELECT * FROM jobs WHERE id = ?', id))
}))

app.patch('/api/jobs/:id/stage', wrap((req, res) => {
  const id = +req.params.id
  const j = get('SELECT * FROM jobs WHERE id = ?', id)
  if (!j) return res.status(404).json({ error: 'Job not found' })
  const stage = req.body?.stage
  if (!STAGE_KEYS.includes(stage)) return res.status(400).json({ error: `Unknown stage: ${stage}` })
  // The guard its twin at PATCH /api/opportunities/:id/stage has carried since v1.14.0, with a
  // comment describing this exact bug — and the job board, which is the one people actually drag
  // all day, never got it. An object 500'd (node:sqlite reads a bare object as a named-parameter
  // bag, so the error is "Unknown named parameter"), and "1e400" wrote Infinity into the column
  // the board orders its cards by, after which that job sorts nowhere in particular forever.
  let order = j.sort_order
  if (req.body?.sort_order != null) {
    order = Number(req.body.sort_order)
    if (!Number.isFinite(order)) return res.status(400).json({ error: 'sort_order must be a number', code: 'invalid_sort_order' })
  }
  const status = stage === 'complete' ? 'complete' : 'active'
  run('UPDATE jobs SET stage=?, sort_order=?, status=?, updated_at=? WHERE id=?', stage, order, status, now(), id)
  if (stage !== j.stage) {
    const label = STAGES.find((s) => s.key === stage).label
    // Every transition is recorded so the job's timeline is complete. Tagged `board`, not `scan`:
    // a kanban drag is not evidence a press ran, and only scans feed the ROI labor measurement.
    run("INSERT INTO job_scans (job_id, from_stage, to_stage, actor, source, created_at) VALUES (?,?,?,?,'board',?)", id, j.stage, stage, req.member?.name || 'board', now())
    logActivity('stage', `${j.job_number} moved to ${label}`, { contact_id: j.contact_id, job_id: id })
    fireAuto('job.stage', { job: get('SELECT * FROM jobs WHERE id = ?', id), contact: get('SELECT * FROM contacts WHERE id = ?', j.contact_id) })
  }
  rtBroadcast('board', { job_id: id, stage, from: j.stage, actor: 'you' })
  res.json(get('SELECT * FROM jobs WHERE id = ?', id))
}))

/* ---- Shop-floor scan loop ----
 * A phone camera reads the Code 128 on the work ticket → the job card appears → one tap
 * advances the stage. Every scan is a timestamped transition in job_scans, which is where
 * ROI's labor ACTUALS come from — operators never type, they scan (the only version of
 * floor data capture that survives contact with a real shop). */

const scanJobPayload = (j) => {
  const idx = STAGES.findIndex((s) => s.key === j.stage)
  const next = idx >= 0 && idx < STAGES.length - 1 ? STAGES[idx + 1] : null
  return {
    id: j.id, job_number: j.job_number, title: j.title, stage: j.stage,
    stage_label: STAGES.find((s) => s.key === j.stage)?.label || j.stage,
    next_stage: next ? { key: next.key, label: next.label } : null,
    stages: STAGES, due_date: j.due_date, rush: !!j.rush, decoration: j.decoration || '',
    contact_name: get('SELECT name FROM contacts WHERE id = ?', j.contact_id)?.name || '',
    pieces: sizeTotal(parse(j.sizes, {})),
    minutes_in_production: laborActualMinutes(j.id).minutes,
    minutes_open: laborActualMinutes(j.id).open,
    scans: all('SELECT to_stage, actor, source, created_at FROM job_scans WHERE job_id = ? ORDER BY id DESC LIMIT 6', j.id),
  }
}

/**
 * Resolve a scanned/typed code to a job. Accepts "JOB-1042", "job 1042", "1042", or a ticket URL.
 *
 * Anchored on the WHOLE string. The old pattern scavenged trailing digits from anything, so an
 * unrelated barcode (a garment SKU, a shipping label) ending in a job's digits opened that job —
 * and one tap then advanced a stage on the wrong order. Express has already percent-decoded the
 * param, so it must not be decoded again (a stray '%' threw URIError and 500'd the lookup).
 */
app.get('/api/scan/:code', wrap((req, res) => {
  const raw = String(req.params.code || '').trim()
  const candidates = []
  const ticket = raw.match(/\/p\/ticket\/(\d+)/)
  const digits = raw.match(/^(?:job[-\s_]?)?(\d{1,10})$/i)
  if (digits) candidates.push(`JOB-${digits[1]}`)
  candidates.push(raw.toUpperCase().replace(/\s+/g, ''))
  candidates.push(raw.toUpperCase())
  let j = null
  if (ticket) j = get('SELECT * FROM jobs WHERE id = ?', Number(ticket[1]))
  for (const c of candidates) {
    if (j) break
    j = get('SELECT * FROM jobs WHERE upper(job_number) = ?', c)
  }
  if (!j) return res.status(404).json({ error: `No job matches “${raw}”` })
  res.json(scanJobPayload(j))
}))

/** Advance (or move) a job from a scan. Same side effects as a board move, plus the scan row. */
app.post('/api/scan', wrap((req, res) => {
  const b = req.body || {}
  const j = get('SELECT * FROM jobs WHERE id = ?', Number(b.job_id))
  if (!j) return res.status(404).json({ error: 'Job not found' })
  const stage = String(b.to_stage || '')
  if (!STAGE_KEYS.includes(stage)) return res.status(400).json({ error: `Unknown stage: ${stage}` })
  if (stage !== j.stage) {
    run('UPDATE jobs SET stage=?, status=?, updated_at=? WHERE id=?', stage, stage === 'complete' ? 'complete' : 'active', now(), j.id)
    run("INSERT INTO job_scans (job_id, from_stage, to_stage, actor, note, source, created_at) VALUES (?,?,?,?,?,'scan',?)",
      j.id, j.stage, stage, req.member?.name || 'floor', String(b.note || '').slice(0, 300), now())
    const label = STAGES.find((s) => s.key === stage).label
    logActivity('stage', `${j.job_number} scanned to ${label}`, { contact_id: j.contact_id, job_id: j.id })
    fireAuto('job.stage', { job: get('SELECT * FROM jobs WHERE id = ?', j.id), contact: get('SELECT * FROM contacts WHERE id = ?', j.contact_id) })
    rtBroadcast('board', { job_id: j.id, stage, from: j.stage, actor: 'scan' })
  }
  res.json(scanJobPayload(get('SELECT * FROM jobs WHERE id = ?', j.id)))
}))

/**
 * Deleting a job with a purchase order still out at the distributor.
 *
 * A submitted PO is a real, chargeable order: blanks are on a truck. purchase_orders.job_id is
 * ON DELETE SET NULL and purchaseOrdersForJob() is keyed on exactly that column, so deleting the
 * job never lost the order — it lost every way of ever seeing it again. There is no purchase-order
 * list screen anywhere in the product; all three references in public/js are keyed on a job id.
 * The activity row went too (activities.job_id CASCADEs), so the customer's timeline did not
 * mention it either. Reproduced: PSC-JOB-1002, 180 pieces, $1,080, S&S order SS-88213 — after the
 * delete, purchasing could see nothing at all, and 180 shirts arrived against an order no screen
 * in the shop knew about. The confirm dialog said only "and its art versions will be removed".
 *
 * So: refuse while the order is still open, and name it, and say what to do. Once it has been
 * received or closed — which the receiving card on the job page can already do — the delete goes
 * through, so this is a step to take rather than a wall to hit. A draft or failed PO never went
 * anywhere and never blocks: that is the case deleting is the right answer to.
 */
const PO_STILL_OUT = ['submitting', 'submitted', 'placed_manually', 'partial']
app.delete('/api/jobs/:id', requireRole('manager'), wrap((req, res) => {
  const id = +req.params.id
  const j = get('SELECT * FROM jobs WHERE id = ?', id)
  if (!j) return res.status(404).json({ error: 'Job not found', code: 'not_found' })
  const pos = purchaseOrdersForJob(id)
  const out = pos.filter((p) => PO_STILL_OUT.includes(String(p.status)) && poAlreadySent(p))
  if (out.length) {
    return res.status(409).json({
      code: 'job_has_purchase_order',
      error: `${j.job_number} has ${out.length === 1 ? 'a purchase order that is still out' : `${out.length} purchase orders still out`} — `
        + `${out.map((p) => `${p.po_number || 'PO'} (${p.ordered} pcs${p.order_id ? `, ${p.supplier || 'supplier'} order ${p.order_id}` : ''}, ${String(p.status).replace('_', ' ')})`).join(', ')}. `
        + `Receive it on this job, or short-close it if the rest is not coming, and then delete. Deleting now would leave the blanks with nothing to receive them against, and no screen that could find the order again.`,
      purchase_orders: out.map((p) => ({ id: p.id, po_number: p.po_number, supplier: p.supplier, status: p.status, order_id: p.order_id, ordered: p.ordered, received: p.received, est_cost: p.est_cost })),
    })
  }
  // Written against the CONTACT, not the job: activities.job_id cascades, so a row carrying one
  // would be deleted by the very statement it exists to record.
  const settled = pos.filter((p) => poAlreadySent(p))
  logActivity('job', `Job ${j.job_number} deleted — ${j.title || 'Untitled'}`
    + (settled.length ? ` (purchase order${settled.length === 1 ? '' : 's'} ${settled.map((p) => p.po_number || `#${p.id}`).join(', ')} had already been received)` : ''),
    { contact_id: j.contact_id })
  run('DELETE FROM jobs WHERE id = ?', id)
  res.json({ ok: true })
}))

/* ================= ART / PREPRESS ================= */

app.get('/api/art', wrap((_req, res) => {
  res.json(all(`SELECT a.*, j.job_number, j.title AS job_title, j.due_date, c.name AS contact_name
    FROM art_versions a JOIN jobs j ON j.id = a.job_id LEFT JOIN contacts c ON c.id = j.contact_id
    ORDER BY a.created_at DESC, a.id DESC`).map((a) => ({ ...a, share_url: shareUrl('art', a.id, a.share_key) })))
}))

// Art must actually be art: allowed types only, and the magic bytes must match — a text file or
// a corrupt PNG must never become a customer-facing proof with a broken image.
const ART_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'application/pdf'])
// multer writes the upload to disk BEFORE the handler runs, so any early return that does not go
// on to keep the file must delete it — otherwise every rejected upload leaks a file. The 404 paths
// (uploading art against a job or estimate that does not exist) did not, so a loop of uploads to a
// nonexistent id filled the disk. Call this on every non-keeping return from an upload route.
const dropUpload = (req) => { if (req.file?.path) { try { unlinkSync(req.file.path) } catch { /* already gone */ } } }

function validArtFile(file) {
  if (!ART_MIMES.has(file.mimetype)) return `Unsupported file type (${file.mimetype}) — use PNG, JPG, WebP, SVG, or PDF`
  try {
    const fd = readFileSync(file.path)
    const ok =
      (file.mimetype === 'image/png' && fd.length > 8 && fd[0] === 0x89 && fd[1] === 0x50 && fd[2] === 0x4e && fd[3] === 0x47) ||
      (file.mimetype === 'image/jpeg' && fd.length > 3 && fd[0] === 0xff && fd[1] === 0xd8) ||
      (file.mimetype === 'image/webp' && fd.length > 12 && fd.slice(8, 12).toString('ascii') === 'WEBP') ||
      (file.mimetype === 'image/svg+xml' && /<svg[\s>]/i.test(fd.slice(0, 2048).toString('utf8'))) ||
      (file.mimetype === 'application/pdf' && fd.slice(0, 5).toString('ascii') === '%PDF-')
    if (!ok) return 'That file is corrupt or mislabeled — re-export it and try again'
  } catch { return 'Could not read the uploaded file' }
  return null
}

app.post('/api/jobs/:id/art', upload.single('file'), reTenant, wrap(async (req, res) => {
  const jobId = +req.params.id
  const j = get('SELECT * FROM jobs WHERE id = ?', jobId)
  if (!j) { dropUpload(req); return res.status(404).json({ error: 'Job not found' }) }
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  const artErr = validArtFile(req.file)
  if (artErr) { try { unlinkSync(req.file.path) } catch {} return res.status(400).json({ error: artErr }) }

  // When the shop has connected Google Drive, store the art in THEIR Drive and drop the local copy —
  // that's the whole point (we don't host unlimited storage). Any Drive failure falls back to local
  // so an upload never fails because of the integration.
  const s0 = getSettings()
  let driveFileId = null, driveLink = null
  if (s0.gdrive_refresh_token) {
    try {
      const buffer = readFileSync(req.file.path)
      const out = await gdrive.withRefresh({
        clientId: s0.gdrive_client_id, clientSecret: s0.gdrive_client_secret, refreshToken: s0.gdrive_refresh_token,
        onRefresh: (nt) => applySettingsPatch({ gdrive_access_token: nt.accessToken, gdrive_refresh_token: nt.refreshToken, gdrive_token_expires: String(nt.expiresAt || '') }),
        op: async (accessToken) => {
          const at = accessToken || s0.gdrive_access_token
          const root = await gdrive.ensureFolder({ accessToken: at, name: 'PrintShopCRM' })
          if (!root.ok) return root
          const sub = await gdrive.ensureFolder({ accessToken: at, name: `Job ${j.job_number || jobId}`, parentId: root.id })
          if (!sub.ok) return sub
          const up = await gdrive.uploadFile({ accessToken: at, name: req.file.originalname, mimeType: req.file.mimetype, buffer, folderId: sub.id })
          if (!up.ok) return up
          await gdrive.makeAnyoneReader({ accessToken: at, fileId: up.id }) // so the proof page can show it
          return up
        },
      })
      if (out.ok) { driveFileId = out.id; driveLink = out.webContentLink || out.webViewLink; try { unlinkSync(req.file.path) } catch {} }
      else console.error('gdrive upload:', out.error)
    } catch (e) { console.error('gdrive upload threw:', e && e.message) }
  }

  const version = (get('SELECT COALESCE(MAX(version), 0) AS v FROM art_versions WHERE job_id = ?', jobId).v) + 1
  const id = Number(run('INSERT INTO art_versions (job_id, version, filename, original_name, mime, size, status, notes, drive_file_id, drive_link, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    jobId, version, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, 'draft', req.body?.notes || '', driveFileId, driveLink, now()).lastInsertRowid)
  logActivity('art', `Art v${version} uploaded${driveFileId ? ' to Google Drive' : ''} — ${req.file.originalname}`, { contact_id: j.contact_id, job_id: jobId })
  const row = get('SELECT * FROM art_versions WHERE id = ?', id)
  res.json({ ...row, url: artUrl(row), drive: !!driveFileId })
}))

app.post('/api/art/:id/send', wrap((req, res) => {
  const a = get('SELECT * FROM art_versions WHERE id = ?', +req.params.id)
  if (!a) return res.status(404).json({ error: 'Art version not found' })
  // Everything below assumes a job row. An estimate-attached mockup (lite, and the mockup route
  // on the quote screen in pro) has job_id NULL, so `j.contact_id` threw and this answered a bare
  // 500 — on the button that sends the proof.
  const j = a.job_id ? get('SELECT * FROM jobs WHERE id = ?', a.job_id) : null
  if (!j) return res.status(409).json({ error: 'This proof is attached to an estimate, not a job — send it from the estimate.', code: 'no_job' })
  const c = get('SELECT * FROM contacts WHERE id = ?', j.contact_id)
  const s = getSettings()
  run(`UPDATE art_versions SET status='sent', sent_at=? WHERE id=?`, now(), a.id)
  run(`UPDATE jobs SET stage='art_approval', updated_at=? WHERE id=? AND stage IN ('new','prepress')`, now(), j.id)
  queueEmail({ contact: c, kind: 'art', subject: `Proof v${a.version} for ${j.title} — approval needed`,
    template: s.email_template_art, vars: { contact_name: c?.name || '', version: a.version, job_title: j.title } })
  logActivity('art', `Proof v${a.version} sent to ${c?.email || 'customer'}`, { contact_id: j.contact_id, job_id: j.id })
  fireAuto('art.sent', { job: get('SELECT * FROM jobs WHERE id = ?', j.id), contact: c, version: a.version })
  res.json({ ok: true, share_url: shareUrl('art', a.id), art: get('SELECT * FROM art_versions WHERE id = ?', a.id) })
}))

/**
 * Take a proof back off a job — including the link the customer was already emailed.
 *
 * DELETE /api/mockups/:id is gated on `a.estimate_id`, and job art is written with job_id set and
 * estimate_id NULL, so it could never match: the one art-delete route in the product structurally
 * excluded the majority of art rows. Nothing else deleted an art_version except the cascade inside
 * DELETE /api/jobs/:id, so the only way to un-send the wrong customer's artwork was to delete the
 * whole job. Meanwhile /p/art/:id kept rendering it and /uploads/<file> kept serving it.
 *
 * Deleting the row is what revokes the link — /p/art/:id 404s once the row is gone — and the local
 * file goes with it, so neither the proof page nor the raw upload survives. Art already pushed to
 * the shop's own Google Drive stays in their Drive; that is their storage, and the response says so
 * rather than pretending we cleaned it up.
 *
 * An APPROVED version is the record of what the customer signed off, so it is not something to
 * click past by accident — but refusing it outright would leave the real emergency (someone else's
 * artwork, approved, on the wrong job) with no way out at all, which is the failure this route
 * exists to prevent. So it deletes, and the approval survives where an audit trail belongs: in the
 * activity log, which names the version, who approved it and when.
 */
app.delete('/api/jobs/:jobId/art/:id', requireRole('manager'), wrap((req, res) => {
  const a = get('SELECT * FROM art_versions WHERE id = ? AND job_id = ?', +req.params.id, +req.params.jobId)
  if (!a) return res.status(404).json({ error: 'Art version not found', code: 'not_found' })
  const j = get('SELECT * FROM jobs WHERE id = ?', a.job_id)
  run('DELETE FROM art_versions WHERE id = ?', a.id)
  if (a.filename) { try { unlinkSync(join(UPLOADS, a.filename)) } catch { /* Drive-stored, or already gone */ } }
  logActivity('art', a.status === 'approved'
    ? `Proof v${a.version} DELETED — it had been approved by ${a.decided_by || 'the customer'}${a.decided_at ? ` on ${String(a.decided_at).slice(0, 10)}` : ''}`
    : `Proof v${a.version} deleted (${a.status})`, { contact_id: j?.contact_id, job_id: a.job_id })
  res.json({ ok: true, deleted: a.id, link_revoked: true, drive_copy_left: !!a.drive_file_id })
}))

/** Internal decision endpoint; the customer-facing one is POST /p/art/:id/decide. */
app.post('/api/art/:id/decide', wrap((req, res) => {
  const a = get('SELECT * FROM art_versions WHERE id = ?', +req.params.id)
  if (!a) return res.status(404).json({ error: 'Art version not found' })
  const approved = req.body?.decision === 'approved'
  decideArt(a, approved, req.body?.notes || '', req.body?.by || 'staff')
  res.json({ ok: true })
}))

function decideArt(a, approved, notes, by) {
  // An estimate-attached mockup (lite: no job board) records the decision and stops — there is no
  // job to release to prepress and no turnaround clock to move. Everything below this point assumes
  // a job row exists, so returning here is what keeps the shared proof page usable in both editions.
  if (!a.job_id && a.estimate_id) {
    run(`UPDATE art_versions SET status=?, decided_at=?, decided_by=?, notes=? WHERE id=?`,
      approved ? 'approved' : 'rejected', now(), by, notes || a.notes, a.id)
    const e = get('SELECT * FROM estimates WHERE id = ?', a.estimate_id)
    if (approved) advanceOrder(a.estimate_id, 'mockup')
    logActivity('art', approved
      ? `Mockup v${a.version} APPROVED by ${by}${e ? ` on ${e.estimate_number}` : ''}`
      : `Mockup v${a.version} changes requested by ${by}${notes ? ` — "${notes}"` : ''}`,
      { contact_id: e?.contact_id })
    return
  }
  const j = get('SELECT * FROM jobs WHERE id = ?', a.job_id)
  run(`UPDATE art_versions SET status=?, decided_at=?, decided_by=?, notes=? WHERE id=?`,
    approved ? 'approved' : 'rejected', now(), by, notes || a.notes, a.id)
  if (!approved) {
    logActivity('art', `Proof v${a.version} changes requested by ${by}${notes ? ` — "${notes}"` : ''}`, { contact_id: j.contact_id, job_id: j.id })
    fireAuto('art.rejected', { job: j, contact: get('SELECT * FROM contacts WHERE id = ?', j.contact_id), version: a.version })
    return
  }

  run(`UPDATE jobs SET stage='prepress', art_approved_at=?, updated_at=? WHERE id=?`, now(), now(), j.id)
  logActivity('art', `Proof v${a.version} APPROVED by ${by} — released to prepress`, { contact_id: j.contact_id, job_id: j.id })
  fireAuto('art.approved', { job: get('SELECT * FROM jobs WHERE id = ?', j.id), contact: get('SELECT * FROM contacts WHERE id = ?', j.contact_id), version: a.version })

  // The clock starts now, not at intake. Move the due date and say so out loud — a proof
  // that sat for four days silently ate four days of the production window.
  const fresh = get('SELECT * FROM jobs WHERE id = ?', j.id)
  if (fresh.approval_gated) {
    const s = scheduleFor(fresh)
    if (s.due && s.due !== fresh.due_date) {
      const slip = businessDaysBetween(fresh.due_date, s.due)
      run('UPDATE jobs SET due_date=?, updated_at=? WHERE id=?', s.due, now(), j.id)
      logActivity('stage', slip > 0
        ? `Due date moved ${fresh.due_date} → ${s.due} (+${slip} working days) — ${fresh.turnaround_days}-day turnaround starts at art approval`
        : `Due date set to ${s.due} — ${fresh.turnaround_days} working days from art approval`,
        { contact_id: j.contact_id, job_id: j.id })
    }
  }
}

/* ================= FOLLOW-UPS ================= */

/**
 * The money list. A print shop's biggest leak isn't production, it's quotes that went
 * quiet and invoices nobody chased. This is what a bolted-on CRM is supposed to earn.
 */
app.get('/api/followups', wrap((_req, res) => {
  const today = new Date().toISOString().slice(0, 10)
  const days = ageInDays

  // Quotes sent but never answered — ranked by value, because $6k deserves the call first.
  const stale = all(`SELECT e.*, c.name AS contact_name, c.email, c.phone, c.company
    FROM estimates e LEFT JOIN contacts c ON c.id = e.contact_id
    WHERE e.status = 'sent' ORDER BY e.total DESC`)
    .map((e) => ({ ...e, age: days(e.sent_at), items: undefined }))

  const overdue = all(`SELECT i.*, c.name AS contact_name, c.email, c.phone
    FROM invoices i LEFT JOIN contacts c ON c.id = i.contact_id
    WHERE i.status NOT IN ('paid','void') AND i.due_date < ? ORDER BY (i.amount_due - i.amount_paid) DESC`, today)
    .map((i) => ({ ...i, age: days(i.due_date), balance: round2(i.amount_due - i.amount_paid) }))

  // Proofs sitting with the customer — these block production, so they cost days.
  const proofs = all(`SELECT a.*, j.job_number, j.title AS job_title, j.due_date, c.name AS contact_name, c.email
    FROM art_versions a JOIN jobs j ON j.id = a.job_id LEFT JOIN contacts c ON c.id = j.contact_id
    WHERE a.status = 'sent' ORDER BY a.sent_at`)
    .map((a) => ({ ...a, age: days(a.sent_at) }))

  // Repeat customers who have gone quiet — the cheapest revenue in the building.
  const reorder = all(`SELECT c.id, c.name, c.company, c.email, c.phone,
      MAX(j.created_at) AS last_job, COUNT(j.id) AS jobs,
      (SELECT COALESCE(SUM(amount_paid),0) FROM invoices WHERE contact_id = c.id) AS lifetime
    FROM contacts c JOIN jobs j ON j.contact_id = c.id
    GROUP BY c.id HAVING jobs >= 1 AND last_job < date('now','-25 day') ORDER BY lifetime DESC LIMIT 8`)
    .map((c) => ({ ...c, age: days(c.last_job) }))

  res.json({
    stale, overdue, proofs, reorder,
    totals: {
      stale: round2(stale.reduce((s, e) => s + e.total, 0)),
      overdue: round2(overdue.reduce((s, i) => s + i.balance, 0)),
    },
  })
}))

/** Nudge a quote that went quiet. Logs to the customer timeline like any other touch. */
app.post('/api/estimates/:id/nudge', wrap((req, res) => {
  const e = get('SELECT * FROM estimates WHERE id = ?', +req.params.id)
  if (!e) return res.status(404).json({ error: 'Estimate not found' })
  const c = get('SELECT * FROM contacts WHERE id = ?', e.contact_id)
  if (requireCustomerEmail(c, res, 'follow-up')) return
  const s = getSettings()
  queueEmail({ contact: c, kind: 'nudge', subject: `Following up — estimate ${e.estimate_number}`,
    template: s.email_template_nudge,
    vars: { estimate_number: e.estimate_number, total: money(e.total) } })
  logActivity('estimate', `Follow-up sent on ${e.estimate_number} (${money(e.total)}) to ${c.email}`, { contact_id: e.contact_id })
  res.json({ ok: true, emailed_to: c.email, email_live: notifyStatus(s).shop_email })
}))

/** Nudge an overdue invoice. */
app.post('/api/invoices/:id/nudge', wrap((req, res) => {
  const i = get('SELECT * FROM invoices WHERE id = ?', +req.params.id)
  if (!i) return res.status(404).json({ error: 'Invoice not found' })
  const c = get('SELECT * FROM contacts WHERE id = ?', i.contact_id)
  if (refuseVoided(i, res) || requireCustomerEmail(c, res, 'reminder')) return
  const s = getSettings()
  queueEmail({ contact: c, kind: 'nudge', subject: `Past due — invoice ${i.invoice_number}`,
    template: s.email_template_overdue,
    vars: { invoice_number: i.invoice_number, total: money(round2(i.amount_due - i.amount_paid)), due_date: i.due_date } })
  logActivity('invoice', `Payment reminder sent on ${i.invoice_number} to ${c.email}`, { contact_id: i.contact_id })
  res.json({ ok: true, emailed_to: c.email, email_live: notifyStatus(s).shop_email })
}))

/* ================= AUTOMATIONS ================= */

app.get('/api/automations', wrap((_req, res) => {
  res.json({
    // params comes back parsed, and a rule that names no stage is flagged rather than left to
    // look identical to a working one on the list. It cannot fire (see needsSetup) — but a rule
    // that quietly does nothing is only better than one that mails everybody if you can SEE it.
    automations: listAutomations().map((a) => ({ ...a, params: parse(a.params, {}), needs_setup: needsSetup(a) })),
    triggers: TRIGGERS, actions: ACTIONS, conditions: CONDITIONS,
    runs: all(`SELECT * FROM automation_runs ORDER BY id DESC LIMIT 60`),
    stats: {
      enabled: get(`SELECT COUNT(*) AS c FROM automations WHERE enabled = 1`).c,
      total_runs: get(`SELECT COALESCE(SUM(run_count),0) AS c FROM automations`).c,
      runs_7d: get(`SELECT COUNT(*) AS c FROM automation_runs WHERE status='ran' AND created_at > datetime('now','-7 day')`).c,
      pending: get(`SELECT COUNT(*) AS c FROM automation_pending WHERE status IS NULL`).c,
      parked: get(`SELECT COUNT(*) AS c FROM automation_pending WHERE status IS NOT NULL`).c,
    },
    // The queue itself, not just a count. A drip that is waiting, paused behind a switched-off
    // rule, or parked because its record was deleted was previously visible only as an integer
    // on a KPI card — there was no screen anywhere that could name WHO was in a sequence, and no
    // way to resume or cancel one. A queue a human cannot see is a queue they cannot fix.
    pending: all(`SELECT id, automation_id, automation_name, trigger, next_index, due_at, label,
                         status, attempts, note, created_at
                    FROM automation_pending ORDER BY status IS NULL DESC, due_at LIMIT 100`),
  })
}))

/**
 * Resume or cancel one queued sequence. Both are the shop's call and neither existed: an owner
 * could not restart a drip their own off switch had stalled, nor clear one whose customer had
 * asked to be left alone.
 */
app.post('/api/automations/pending/:id/resume', requireRole('manager'), wrap((req, res) => {
  const p = get('SELECT * FROM automation_pending WHERE id = ?', +req.params.id)
  if (!p) return res.status(404).json({ error: 'That queued sequence is no longer there.', code: 'not_found' })
  const rule = get('SELECT enabled FROM automations WHERE id = ?', p.automation_id)
  if (!rule) return res.status(409).json({ error: 'The rule behind this sequence was deleted, so there is nothing left to run. Cancel it instead.', code: 'rule_deleted' })
  if (!rule.enabled) return res.status(409).json({ error: 'That rule is switched off. Turn it back on and the sequence picks up where it stopped.', code: 'rule_disabled' })
  run("UPDATE automation_pending SET status = NULL, note = NULL, attempts = 0, due_at = datetime('now') WHERE id = ?", p.id)
  logActivity('note', `Automation sequence resumed — ${p.automation_name}${p.label ? ` · ${p.label}` : ''}`, {})
  res.json({ ok: true })
}))

/**
 * Let a failed timed run go again. The dedupe latch deliberately does NOT retry on its own — a
 * rule that failed after emailing the customer must not re-email them every five minutes — but
 * that made a transient failure (SMTP down for ten minutes) permanent, silently, for every
 * overdue-invoice chase and stale-quote nudge that landed in the window. Stamping 'retry' keeps
 * the failure in the history and releases the latch, so the next tick picks the entity up again.
 */
app.post('/api/automations/runs/:id/retry', requireRole('manager'), wrap((req, res) => {
  const r = get('SELECT * FROM automation_runs WHERE id = ?', +req.params.id)
  if (!r) return res.status(404).json({ error: 'That run is no longer in the log.', code: 'not_found' })
  if (r.status !== 'error') return res.status(409).json({ error: 'That run did not fail, so there is nothing to retry.', code: 'not_failed' })
  run("UPDATE automation_runs SET status = 'retry' WHERE id = ?", r.id)
  logActivity('note', `Automation retry queued — ${r.automation_name}${r.entity_label ? ` · ${r.entity_label}` : ''}`, {})
  res.json({ ok: true })
}))

app.delete('/api/automations/pending/:id', requireRole('manager'), wrap((req, res) => {
  const p = get('SELECT * FROM automation_pending WHERE id = ?', +req.params.id)
  if (!p) return res.status(404).json({ error: 'That queued sequence is no longer there.', code: 'not_found' })
  run('DELETE FROM automation_pending WHERE id = ?', p.id)
  logActivity('note', `Automation sequence cancelled — ${p.automation_name}${p.label ? ` · ${p.label}` : ''}`, {})
  res.json({ ok: true })
}))

// An automation sends real customer email and SMS on the shop's behalf, so authoring one is a
// manager call even though reading the list is not.
/**
 * An automation's `params` are stored with a bare JSON.stringify and rendered into the rules list.
 * `params.days` was interpolated into innerHTML UNESCAPED — while `params.stage`, on the same line
 * of the same template, was escaped. A manager could store `<img src=x onerror=...>` there and it
 * ran in the OWNER's browser, reaching owner-only actions (add another owner, rotate the API key).
 * The view escapes it now; this makes the stored value match its only actual use, since every
 * consumer in lib/automations.mjs already reads it through Number().
 */
const sanitizeAutoParams = (p) => {
  const out = (p && typeof p === 'object' && !Array.isArray(p)) ? { ...p } : {}
  if (out.days != null) {
    const n = Number(out.days)
    if (!Number.isFinite(n)) delete out.days
    else out.days = Math.max(0, Math.trunc(n))
  }
  if (out.stage != null) out.stage = String(out.stage).slice(0, 40)
  return out
}

/**
 * A trigger that selects on a parameter is not finished until it has one.
 *
 * "Job reaches a stage" with no stage was stored happily and then matched EVERY stage change —
 * one job crossing the board mailed the customer once per column, on every job in the shop. The
 * builder made that the default shape: its dropdown showed whatever the browser selected first
 * while `params` went up empty. Refuse the shape here as well as seeding the dropdown, so no
 * client — the UI, a script, an integration — can store a rule that means "everything".
 */
const missingTriggerParam = (trigger, params) => {
  const t = TRIGGERS.find((x) => x.key === trigger)
  if (!t?.param || t.timed) return null   // a timed threshold has a documented default; see needsSetup()
  return String(params?.[t.param.key] ?? '').trim() ? null : t.param
}

app.post('/api/automations', requireRole('manager'), wrap((req, res) => {
  const b = req.body || {}
  if (!b.name?.trim()) return res.status(400).json({ error: 'Give the automation a name' })
  if (!TRIGGERS.some((t) => t.key === b.trigger)) return res.status(400).json({ error: 'Pick a trigger' })
  const missing = missingTriggerParam(b.trigger, b.params)
  if (missing) return res.status(400).json({ error: `Choose which ${String(missing.label).toLowerCase()} this rule fires on.`, code: 'missing_param' })
  if (!Array.isArray(b.actions) || !b.actions.length) return res.status(400).json({ error: 'Add at least one action' })
  const id = Number(run('INSERT INTO automations (name, enabled, trigger, params, conditions, actions, created_at) VALUES (?,?,?,?,?,?,?)',
    b.name.trim(), b.enabled === false ? 0 : 1, b.trigger, JSON.stringify(sanitizeAutoParams(b.params)),
    JSON.stringify(b.conditions || []), JSON.stringify(b.actions), now()).lastInsertRowid)
  res.json(get('SELECT * FROM automations WHERE id = ?', id))
}))

app.put('/api/automations/:id', requireRole('manager'), wrap((req, res) => {
  const a = get('SELECT * FROM automations WHERE id = ?', +req.params.id)
  if (!a) return res.status(404).json({ error: 'Automation not found' })
  const b = req.body || {}
  const missingOnSave = missingTriggerParam(b.trigger ?? a.trigger, b.params ?? parse(a.params, {}))
  if (missingOnSave) return res.status(400).json({ error: `Choose which ${String(missingOnSave.label).toLowerCase()} this rule fires on.`, code: 'missing_param' })
  run('UPDATE automations SET name=?, enabled=?, trigger=?, params=?, conditions=?, actions=? WHERE id=?',
    b.name ?? a.name, b.enabled === undefined ? a.enabled : (b.enabled ? 1 : 0), b.trigger ?? a.trigger,
    JSON.stringify(sanitizeAutoParams(b.params ?? parse(a.params, {}))), JSON.stringify(b.conditions ?? parse(a.conditions, [])),
    JSON.stringify(b.actions ?? parse(a.actions, [])), a.id)
  res.json(get('SELECT * FROM automations WHERE id = ?', a.id))
}))

app.delete('/api/automations/:id', requireRole('manager'), wrap((req, res) => {
  run('DELETE FROM automations WHERE id = ?', +req.params.id)
  res.json({ ok: true })
}))

/** Run the timed triggers on demand — the same code the background tick calls. */
// Every neighbouring route on this resource requires manager. This one fires the whole shop's
// automation sweep — real customer email through the shop's SMTP credentials and SMS through its
// Twilio token — and was reachable by any staff account.
app.post('/api/automations/tick', requireRole('manager'), wrap((_req, res) => {
  res.json({ fired: tick(autoDeps) })
}))

/* ================= PIPELINE ================= */

const syncPipeline = (estimate, event) => { try { pipeline.syncFromEstimate(estimate, event) } catch (e) { console.error('pipeline:', e.message) } }

app.get('/api/pipeline', wrap((_req, res) => res.json(pipeline.pipelineBoard())))

/**
 * A money figure a client sent us, or null if it is not one.
 *
 * round2() now floors a non-finite input to 0, which stops Infinity reaching a money column — but
 * silently booking a $0 deal in place of what the caller sent is its own wrong answer. Refuse it
 * instead, so the caller is told rather than left to discover a $0 row later.
 */
const moneyIn = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? round2(n) : null
}

app.post('/api/opportunities', wrap((req, res) => {
  const b = req.body || {}
  const contactId = resolveContactId(b.contact_id, res, 'open a deal')
  if (contactId == null) return
  if (b.value != null && moneyIn(b.value) === null) return res.status(400).json({ error: 'Value must be a number', code: 'invalid_value' })
  const id = Number(run(`INSERT INTO opportunities (contact_id, title, stage, value, source, notes, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?)`,
    contactId, str(b.title, '') || 'New opportunity', pipeline.STAGE_KEYS.includes(b.stage) ? b.stage : 'lead',
    round2(b.value), str(b.source, '') || 'manual', str(b.notes, ''), now(), now()).lastInsertRowid)
  logActivity('note', `Opportunity added — ${str(b.title, '') || 'New opportunity'} (${money(round2(b.value))})`, { contact_id: contactId })
  res.json(get('SELECT * FROM opportunities WHERE id = ?', id))
}))

app.put('/api/opportunities/:id', wrap((req, res) => {
  const o = get('SELECT * FROM opportunities WHERE id = ?', +req.params.id)
  if (!o) return res.status(404).json({ error: 'Opportunity not found' })
  const b = req.body || {}
  if (b.value != null && moneyIn(b.value) === null) return res.status(400).json({ error: 'Value must be a number', code: 'invalid_value' })
  run('UPDATE opportunities SET title=?, value=?, notes=?, updated_at=? WHERE id=?',
    str(b.title, o.title), b.value != null ? moneyIn(b.value) : o.value, str(b.notes, o.notes), now(), o.id)
  res.json(get('SELECT * FROM opportunities WHERE id = ?', o.id))
}))

app.patch('/api/opportunities/:id/stage', wrap((req, res) => {
  const o = get('SELECT * FROM opportunities WHERE id = ?', +req.params.id)
  if (!o) return res.status(404).json({ error: 'Opportunity not found' })
  const stage = req.body?.stage
  if (!pipeline.STAGE_KEYS.includes(stage)) return res.status(400).json({ error: `Unknown stage: ${stage}` })
  // sort_order went straight to the binding: an object 500'd (node:sqlite cannot bind one) and
  // "1e400" wrote Infinity into the column the board orders cards by.
  if (req.body?.sort_order != null) {
    const so = Number(req.body.sort_order)
    if (!Number.isFinite(so)) return res.status(400).json({ error: 'sort_order must be a number', code: 'invalid_sort_order' })
    run('UPDATE opportunities SET sort_order = ? WHERE id = ?', so, o.id)
  }
  const updated = pipeline.setStage(o.id, stage, { lost_reason: req.body?.lost_reason })
  if (stage !== o.stage) {
    const label = pipeline.STAGES.find((s) => s.key === stage).label
    logActivity('note', `${o.title} moved to ${label}${stage === 'won' ? ' 🎉' : ''}`, { contact_id: o.contact_id })
    if (stage === 'won' || stage === 'lost') {
      fireAuto(`opportunity.${stage}`, { opportunity: updated, contact: get('SELECT * FROM contacts WHERE id = ?', o.contact_id), total: updated.value })
    }
  }
  res.json(updated)
}))

app.delete('/api/opportunities/:id', requireRole('manager'), wrap((req, res) => {
  run('DELETE FROM opportunities WHERE id = ?', +req.params.id)
  res.json({ ok: true })
}))

/* ================= CONVERSATIONS ================= */

app.get('/api/conversations', wrap((_req, res) => {
  const threads = all(`SELECT c.id, c.name, c.company, c.email, c.phone, c.tags,
      (SELECT body FROM messages m WHERE m.contact_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_body,
      (SELECT direction FROM messages m WHERE m.contact_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_dir,
      (SELECT channel FROM messages m WHERE m.contact_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_channel,
      (SELECT created_at FROM messages m WHERE m.contact_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_at,
      (SELECT COUNT(*) FROM messages m WHERE m.contact_id = c.id AND m.direction='in' AND m.read=0) AS unread,
      (SELECT COUNT(*) FROM messages m WHERE m.contact_id = c.id) AS total
    FROM contacts c
    WHERE EXISTS (SELECT 1 FROM messages m WHERE m.contact_id = c.id)
    ORDER BY unread DESC, last_at DESC`)
  res.json({ threads, unread_total: threads.reduce((s, t) => s + t.unread, 0) })
}))

app.get('/api/conversations/:contactId', wrap((req, res) => {
  const c = get('SELECT * FROM contacts WHERE id = ?', +req.params.contactId)
  if (!c) return res.status(404).json({ error: 'Customer not found' })
  const messages = all('SELECT * FROM messages WHERE contact_id = ? ORDER BY id', c.id)
  run('UPDATE messages SET read = 1 WHERE contact_id = ? AND direction = ? AND read = 0', c.id, 'in')
  res.json({ contact: { ...c, tags: c.tags ? c.tags.split(',').filter(Boolean) : [] }, messages })
}))

app.post('/api/conversations/:contactId/reply', wrap((req, res) => {
  const c = get('SELECT * FROM contacts WHERE id = ?', +req.params.contactId)
  if (!c) return res.status(404).json({ error: 'Customer not found' })
  const body = String(req.body?.body || '').trim()
  if (!body) return res.status(400).json({ error: 'Write a reply first' })
  const channel = req.body?.channel === 'sms' ? 'sms' : 'email'
  const subject = channel === 'sms' ? 'SMS' : (req.body?.subject || 'Re: your order')
  if (channel === 'sms') queueSms({ contact: c, body })
  else queueEmail({ contact: c, subject, template: body, vars: {}, kind: 'reply' })
  logActivity('note', `Replied to ${c.name} (${channel})`, { contact_id: c.id })
  res.json({ ok: true })
}))

/**
 * Demo helper: fabricate an inbound message so the two-way thread is visible without a live
 * mailbox. Clearly a preview affordance — real inbound arrives via an email/SMS webhook.
 */
app.post('/api/conversations/:contactId/simulate', wrap((req, res) => {
  // Dev-only: this fabricates an inbound message. Never allow it against a real shop's history.
  if (AUTH_ENABLED) return res.status(403).json({ error: 'Not available in production' })
  const c = get('SELECT * FROM contacts WHERE id = ?', +req.params.contactId)
  if (!c) return res.status(404).json({ error: 'Customer not found' })
  recordMessage({ contact_id: c.id, direction: 'in', channel: req.body?.channel || 'email',
    subject: req.body?.subject || 'Re: your order', body: String(req.body?.body || 'Sounds good, thanks!').slice(0, 1000), kind: 'inbound' })
  fireAuto('conversation.received', { contact: c })
  res.json({ ok: true })
}))

/* ================= ASSISTANT ================= */

/** "Message your problem, it's handled." Natural language → real action or answer. */
app.post('/api/assistant', async (req, res) => {
  try { res.json(await ask(req.body?.message)) }
  catch (e) { console.error('assistant:', e); res.status(500).json({ reply: `Something went wrong: ${e.message}` }) }
})

/* ================= AUTOPILOT ================= */

/**
 * The whole front office in one call: a customer email in, a paid job on the board out.
 *
 * Reads the email → finds or creates the customer → writes the estimate → sends and marks
 * it approved → converts to an invoice + production job → records the deposit. Everything
 * downstream (the mockup) the client adds as a visual flourish. When a real inbound
 * webhook + Stripe are wired, this same chain runs untouched with nobody clicking.
 */
app.post('/api/autopilot', async (req, res) => {
  try {
    const text = String(req.body?.text || '')
    if (text.trim().length < 8) return res.status(400).json({ error: 'Paste the customer email first' })
    const steps = []
    const mark = (key, label, detail, data) => steps.push({ key, label, detail, ...(data || {}) })

    // 1 — read the email into a structured order
    const order = await parseIntake(text)
    const pieces = sizeTotal(order.sizes) || order.total_pieces || 48
    mark('read', 'Read the email', `${order.garment} · ${pieces} pcs · ${order.decoration}${order.due_hint ? ` · due ${order.due_hint}` : ''}`, { via: order.source, due_hint: order.due_hint || null })

    // 2 — find or create the customer
    // The customer's identity is usually IN the message they sent — an address in the signature, a
    // "From:" line on a forward. Falling back to a row called "New customer" every time buried the
    // real contact book, so read it out of the text when the caller didn't pass one.
    const foundEmail = req.body?.contact_email || findEmail(text, { exclude: [getSettings().shop_email] })
    const nameFromEmail = foundEmail ? foundEmail.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim() : ''
    const wantName = req.body?.contact_name || nameFromEmail
    let contact = foundEmail ? get('SELECT * FROM contacts WHERE lower(email) = lower(?)', foundEmail) : null
    if (!contact && wantName) contact = get('SELECT * FROM contacts WHERE lower(name) = lower(?)', wantName)
    // Price BEFORE creating a new contact. Pricing can legitimately return null (no quantity in the
    // message) or throw (supplier down); doing it first means a failed quote doesn't leave an
    // orphan "autopilot" contact behind with no estimate. Use the matched contact's exemption if we
    // have one; a brand-new autopilot contact is never tax-exempt.
    const s = getSettings()
    const priced = await priceIntakeLive(order, s, { taxRate: contact?.tax_exempt ? 0 : null })
    if (!priced) return res.status(400).json({ error: "That request doesn't say how many pieces — a price can't be guessed from nothing." })

    let isNew = false
    if (!contact) {
      isNew = true
      const id = Number(run('INSERT INTO contacts (name, email, phone, notes, tags, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
        wantName || 'New customer', foundEmail || '', '', order.notes || '', 'autopilot', now(), now()).lastInsertRowid)
      contact = get('SELECT * FROM contacts WHERE id = ?', id)
      logActivity('contact', `Customer created by Autopilot — ${contact.name}`, { contact_id: id })
    }
    mark('customer', isNew ? 'Added the customer' : 'Matched the customer', contact.name, { contact_id: contact.id })

    // 3 — write the estimate
    const items = freezeUpcharges(priced.items)
    const t = priced.totals
    const estNum = nextEstimateNumber()
    const estId = Number(run('INSERT INTO estimates (contact_id, estimate_number, status, items, subtotal, tax, total, tax_rate, notes, rush_days, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      contact.id, estNum, 'draft', JSON.stringify(items), t.subtotal, t.tax, t.total, priced.taxRate, order.notes || '',
      priced.rushDays || 0, now()).lastInsertRowid)
    logActivity('estimate', `Estimate ${estNum} written by Autopilot — ${money(t.total)}`, { contact_id: contact.id })
    syncPipeline(get('SELECT * FROM estimates WHERE id = ?', estId), 'created')
    mark('estimate', 'Wrote the estimate', `${estNum} · ${money(t.total)}`, { estimate_id: estId, total: t.total, blank: priced.quote?.blank || null })
    if (priced.quote?.blank) mark('blank', 'Priced the blank', blankCostLabel(priced.quote.blank), { blank: priced.quote.blank })
    const q = priced.quote

    // 4 — always create the production job (in 'new'), so the mockup has a home and the
    // shop can see the work — but DON'T convert/charge yet. That's the reviewable draft.
    const grid = rollupSizes(items)
    const jobNum = nextJobNumber()
    // A date the customer actually stated beats our default turnaround — reading it out of the
    // email is the entire point of Autopilot, and quietly scheduling "10 working days from today"
    // over their "by the 8th" is how a shop misses a deadline it already agreed to. parseIntake
    // hands back due_hint already normalised to ISO (and never in the past), so it drops straight
    // in. With no stated date we fall back to the standard clock exactly as before.
    const autoDue = addBusinessDays(new Date().toISOString().slice(0, 10), order.rush ? 3 : 10)
    const dueDate = order.due_hint || autoDue
    // Keep the turnaround figure honest about the date we just committed to, so the schedule and
    // the at-risk warnings are measured against the real deadline rather than a default.
    const turnaroundDays = order.due_hint
      ? Math.max(1, businessDaysBetween(new Date().toISOString().slice(0, 10), dueDate))
      : (order.rush ? 3 : 10)
    const jobId = Number(run('INSERT INTO jobs (contact_id, estimate_id, job_number, title, status, stage, decoration, garment, sizes, line_sizes, quantities, due_date, turnaround_days, approval_gated, rush, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      contact.id, estId, jobNum, `${pieces} ${order.garment}`, 'active', 'new', order.decoration, order.garment,
      JSON.stringify(grid), JSON.stringify(garmentLines(items)), sizeSummary(grid),
      // 16 placeholders need 16 arguments. This bound only 15, and node:sqlite pads the tail with
      // NULL instead of throwing — so every Autopilot job landed shifted one column left:
      // due_date got the turnaround number (3/10), approval_gated got the notes text, and notes got
      // a timestamp. A due_date of "10" is an INTEGER, which sorts below every ISO date and matches
      // `due_date <= date('now','+7 day')`, so the job was pinned to the top of the board and stuck
      // in "due tomorrow" forever.
      // addBusinessDays parses `String(from).slice(0,10)`, so it needs an ISO date string,
      // not a Date object (String(new Date()) starts "Tue Jul 28…" and yields Invalid Date).
      dueDate,                                          // due_date
      turnaroundDays,                                   // turnaround_days
      0,                                                // approval_gated
      priced.rushDays > 0 ? 1 : 0,                      // rush — the tier the customer was billed
      order.notes || '', now(), now()).lastInsertRowid)

    // Autonomy dial: 'review' (default, conservative) stops here with an editable draft;
    // 'auto' fires the irreversible customer-facing steps (send, approve, charge) too.
    // Full Auto also stands down when the model read the customer's message differently from the
    // deterministic parser. mergeIntake refuses the overwrite either way, but a disagreement on a
    // priced field is the one thing on this path that nobody else is going to look at — and the
    // message being parsed was written by the person who benefits from getting it wrong.
    const held = order.needs_review || []
    const mode = (req.body?.mode === 'auto' && !held.length) ? 'auto' : 'review'
    let committed = null
    if (mode === 'auto') {
      committed = commitAutopilot(estId, contact, { steps, jobId })
    }

    res.json({
      order, steps, isNew, mode, committed: !!committed,
      held_for_review: held, ai_note: order.ai_note || '',
      contact, estimate: get('SELECT * FROM estimates WHERE id = ?', estId),
      invoice: committed?.invoice || null, job: get('SELECT * FROM jobs WHERE id = ?', jobId),
      art_hint: order, // the client uses this to synthesize/extract the artwork + mockup
    })
  } catch (e) { console.error('autopilot:', e); res.status(500).json({ error: e.message }) }
})

/**
 * Phase 2 — the irreversible, customer-facing steps: send, mark approved, invoice, take the
 * deposit, move the job into prepress. Runs automatically in full-auto, or on demand when the
 * human approves a reviewed draft. Idempotent-ish: skips if already invoiced.
 */
function commitAutopilot(estId, contact, { steps, jobId } = {}) {
  const e = get('SELECT * FROM estimates WHERE id = ?', estId)
  if (!e) return null
  const existing = get('SELECT * FROM invoices WHERE estimate_id = ?', estId)
  if (existing) return { invoice: existing }
  const mark = (key, label, detail, data) => steps?.push({ key, label, detail, ...(data || {}) })
  const s = getSettings()

  /* This used to run all the way through however many times it was called, and the "already
   * invoiced" guard above became dead the moment autopilot stopped raising invoices. So a second
   * press of Send — the "did that work?" press — mailed the customer the same estimate again,
   * and a third mailed it a third time. Worse, it wrote `status='sent'` unconditionally: an
   * estimate the customer had already APPROVED went back to 'sent' with approved_at still set,
   * the pipeline card stuck on won, and the shop looking at a quote that says it is waiting on a
   * customer who already said yes. POST /api/estimates/:id/send has carried exactly this guard
   * since c273ef4; this path never got it. */
  const settled = ['approved', 'declined', 'invoiced'].includes(e.status)
  if (settled) {
    mark('sent', `Already ${e.status}`, 'The customer has answered this one — nothing was re-sent.',
      { estimate_id: estId, approve_link: shareUrl('estimate', estId) })
    return { invoice: null, job: get('SELECT * FROM jobs WHERE estimate_id = ?', estId), sent: false, already: true }
  }
  if (e.status === 'sent' && e.sent_at) {
    mark('sent', 'Already sent', `Sent ${e.sent_at} — waiting on the customer’s approval.`,
      { estimate_id: estId, approve_link: shareUrl('estimate', estId) })
    return { invoice: null, job: get('SELECT * FROM jobs WHERE estimate_id = ?', estId), sent: false, already: true }
  }

  // Autopilot SENDS the estimate and stops. It used to, in the very next line, mark the estimate
  // 'approved' with "Customer said yes" and raise a real invoice — before the customer had any
  // chance to reply. That fabricated a consent that never happened: a phantom unpaid invoice in
  // A/R for money nobody agreed to, a "won" deal in the pipeline, and a job pushed to prepress on
  // an order that might never come. The customer's approval is a real event — they click Approve
  // on the estimate page (/p/estimate/:id/approve), which fires estimate.approved and is where the
  // conversion belongs. Autopilot's job ends at a sent estimate and a visible "waiting on them".
  run(`UPDATE estimates SET status='sent', sent_at=COALESCE(sent_at,?) WHERE id=?`, now(), estId)
  syncPipeline(get('SELECT * FROM estimates WHERE id = ?', estId), 'sent')
  queueEmail({ contact, kind: 'estimate', subject: `Estimate ${e.estimate_number} from ${s.shop_name}`, template: s.email_template_estimate,
    vars: { estimate_number: e.estimate_number, total: money(e.total) } })
  logActivity('estimate', `Estimate ${e.estimate_number} sent to ${contact.name} by autopilot`, { contact_id: contact.id })
  // The same event the manual Send fires. Without it the shop's own rules never saw an autopilot
  // quote go out — the shipped default "Flag big quotes for a personal call" is dead on exactly
  // the path nobody is watching — and no webhook subscriber heard about it either, because
  // dispatchSubscriptions lives inside fireAuto.
  fireAuto('estimate.sent', { estimate: get('SELECT * FROM estimates WHERE id = ?', estId), contact, total: e.total })
  mark('sent', 'Estimate sent', 'Waiting on the customer’s approval', { estimate_id: estId, approve_link: shareUrl('estimate', estId) })
  const job = jobId ? get('SELECT * FROM jobs WHERE id = ?', jobId) : get('SELECT * FROM jobs WHERE estimate_id = ?', estId)
  return { invoice: null, job: job ? get('SELECT * FROM jobs WHERE id = ?', job.id) : null, sent: true }
}

/** Fire a reviewed draft: the human approved it, now run the customer-facing steps. */
app.post('/api/autopilot/commit', wrap((req, res) => {
  const estId = +req.body?.estimate_id
  const e = get('SELECT * FROM estimates WHERE id = ?', estId)
  if (!e) return res.status(404).json({ error: 'Estimate not found' })
  const contact = get('SELECT * FROM contacts WHERE id = ?', e.contact_id)
  const steps = []
  const r = commitAutopilot(estId, contact, { steps })
  res.json({ ok: true, steps, already: !!r?.already, sent: !!r?.sent, invoice: r?.invoice || null, job: r?.job || null,
    estimate: get('SELECT * FROM estimates WHERE id = ?', estId) })
}))

/* ================= AI ================= */

app.get('/api/ai/status', async (_req, res) => {
  try { res.json(await aiStatus(true)) } catch (e) { res.json({ available: false, reason: e.message }) }
})

/**
 * Paste an email, get a draft order. Works with or without a model — see lib/ai.mjs.
 *
 * It returns the PRICE as well as the parse, because the screen that consumes this used to work
 * it out itself. views/intake.js carried a third pricing engine (`intakeQuote`) alongside
 * priceIntake and the quote screen: it wrote a bare "RUSH." onto the customer-visible line and
 * then charged the standard rate, and it ignored the shop's price book and its live blank cost.
 * On a 300-piece 3-day rush that is $3,101.00 where the canonical price is $5,705.00 — $1,860 of
 * dropped rush and $744 of engine divergence, on the biggest quoting surface in the product.
 * v1.18.0 and v1.19.0 fixed exactly this on the automated paths and in the assistant. One
 * expression, one answer, on every path.
 */
app.post('/api/ai/intake', async (req, res) => {
  try {
    const text = String(req.body?.text || '')
    if (text.trim().length < 8) return res.status(400).json({ error: 'Paste the customer message first' })
    const order = await parseIntake(text)
    // A message that never says how many is still worth reading — the shop fills the grid in on
    // the estimate. Price it at a stated assumption rather than inventing a quantity silently, so
    // the screen can say which number the figure in front of them belongs to.
    const stated = sizeTotal(order.sizes) || Number(order.total_pieces) || 0
    const assumed = stated > 0 ? 0 : 24
    const priced = await priceIntakeLive(assumed ? { ...order, total_pieces: assumed } : order, getSettings())
    res.json({ ...order, assumed_pieces: assumed || null, priced: priced ? { pieces: priced.pieces, items: priced.items, quote: priced.quote } : null })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/ai/draft', async (req, res) => {
  try {
    const c = req.body?.contact_id ? get('SELECT * FROM contacts WHERE id = ?', +req.body.contact_id) : null
    res.json(await draftReply({ contact: c, context: String(req.body?.context || ''), intent: String(req.body?.intent || 'follow up politely') }))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

/* ================= ROI / JOB COSTING ================= */

app.get('/api/roi', wrap((req, res) => res.json(shopRoi({ completedOnly: req.query.completed === '1' }))))

app.get('/api/roi/:jobId', wrap((req, res) => {
  const j = get('SELECT * FROM jobs WHERE id = ?', +req.params.jobId)
  if (!j) return res.status(404).json({ error: 'Job not found' })
  res.json(jobRoi(j))
}))

/* ================= GARMENTS / SUPPLIERS ================= */

app.get('/api/garments', wrap((_req, res) => res.json({ garments: listGarments(), suppliers: supplierStatus(getSettings()) })))

app.get('/api/suppliers/lookup', async (req, res) => {
  try { res.json(await lookupLive(String(req.query.style || ''), getSettings())) }
  catch (e) { res.status(502).json({ error: e.message }) }
})

app.get('/api/suppliers/status', wrap((_req, res) => res.json(supplierStatus(getSettings()))))

/**
 * Prove a distributor connection the only way that counts — resolve a real style and come back
 * with a real price. A credentials-shaped-right check would green-tick a key that can't quote.
 */
app.post('/api/suppliers/test', requireRole('manager'), wrap(async (req, res) => {
  const s = getSettings()
  const st = supplierStatus(s)
  if (!st.connected) return res.json({ ok: false, reason: 'No distributor credentials saved yet.' })
  const sample = String(req.body?.style || 'Gildan 5000').slice(0, 60)
  try {
    const b = await blankCost(sample, s, { color: req.body?.color || '', timeoutMs: 12000, allowLive: true })
    if (!b.live) return res.json({ ok: false, connected: st, reason: b.error || `Connected, but ${sample} came back with no live price — check the account has API access.`, fell_back_to: b.source })
    res.json({ ok: true, connected: st, label: blankCostLabel(b), blank: b })
  } catch (e) { res.json({ ok: false, connected: st, reason: e.message }) }
}))

/* ================= AI RECEPTIONIST (the configurable chatbot) ================= */

app.get('/api/agent/config', async (_req, res) => {
  try {
    const cfg = getBotConfig()
    const embed_key = tenantStore.getStore()?.tenant?.embed_key || (curSlug() ? getTenantBySlug(curSlug())?.embed_key : '') || 'demo'
    res.json({ config: cfg, ai: await aiStatus(), embed_key, presence: roomSize(curSlug()) })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.put('/api/agent/config', requireRole('manager'), wrap((req, res) => res.json({ config: saveBotConfig(req.body || {}) })))

app.get('/api/agent/sessions', wrap((_req, res) => res.json({ sessions: listSessions() })))

app.get('/api/agent/sessions/:pid', wrap((req, res) => {
  const s = sessionByPublicId(req.params.pid)
  if (!s) return res.status(404).json({ error: 'Session not found' })
  res.json({ session: s, messages: sessionMessages(s.id) })
}))

/** A human takes over a bot chat. Records the reply, and delivers it to the visitor if we have a way. */
app.post('/api/agent/sessions/:pid/reply', wrap((req, res) => {
  const s = sessionByPublicId(req.params.pid)
  if (!s) return res.status(404).json({ error: 'Session not found' })
  const text = String(req.body?.text || '').trim()
  if (!text) return res.status(400).json({ error: 'Empty reply' })
  agentReply(s, text)
  const contact = s.contact_id ? get('SELECT * FROM contacts WHERE id = ?', s.contact_id) : null
  // If the visitor left an email/phone, actually reach them; otherwise it waits in the live chat.
  if (contact?.email) queueEmail({ contact, subject: `Re: your message to ${getSettings().shop_name}`, template: text, vars: {}, kind: 'chat' })
  else if (contact?.phone) queueSms({ contact, body: text })
  rtBroadcast('chat', { session: s.public_id })
  res.json({ ok: true, messages: sessionMessages(s.id) })
}))

/**
 * "Draft with AI" for the inbox — supercharged assist. Builds a suggested reply grounded in the
 * conversation + the shop's knowledge base, for a human to edit and send. Needs the shop's own AI
 * key; degrades to a clear message when there's none.
 */
app.post('/api/agent/draft', requireRole('staff'), wrap(async (req, res) => {
  const pid = req.body?.session_pid || req.params.pid
  const sess = sessionByPublicId(String(pid || ''))
  if (!sess) return res.status(404).json({ error: 'Session not found' })
  const cfg = getBotConfig()
  const contact = sess.contact_id ? get('SELECT * FROM contacts WHERE id = ?', sess.contact_id) : null
  const transcript = transcriptFor(sess, 10, (m) => (m.role === 'visitor' ? 'Customer' : 'Shop'))
  const context = `You are the front desk of ${cfg.shop_name}, a custom apparel print shop. Draft a short, warm reply to the customer's latest message for a human teammate to review and send. Do not invent prices, dates, or policies. If you don't know, say the team will confirm.\n${cfg.knowledge ? `\nShop facts:\n${String(cfg.knowledge).slice(0, 1500)}\n` : ''}\nConversation so far:\n${transcript || '(no messages yet)'}`
  const out = await draftReply({ contact, context, intent: 'assist' })
  if (!out.text) return res.json({ ok: false, reason: out.ai_note || 'Add your AI key in Settings to draft replies.' })
  res.json({ ok: true, text: out.text })
}))

/** Owner-side live preview of the bot — runs the real engine against a throwaway session. */
app.post('/api/agent/preview', async (req, res) => {
  try {
    const b = req.body || {}
    let s = b.session ? sessionByPublicId(b.session) : null
    if (!s) s = startSession({ channel: 'preview' })
    const out = await respond(s, String(b.text || ''), getBotConfig())
    res.json({ session: s.public_id, reply: out.reply, quick: out.quick, state: out.state })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

/* ================= REAL DELIVERY (SMTP + Twilio) ================= */

app.get('/api/notify/status', wrap((_req, res) => res.json(notifyStatus(getSettings()))))

app.post('/api/notify/verify-email', async (_req, res) => {
  try { res.json(await verifyEmail(getSettings())) } catch (e) { res.json({ ok: false, error: e.message }) }
})

/**
 * Prove delivery is wired by sending yourself one message.
 *
 * The destination is restricted to the shop's own contact details (or the signed-in member's own
 * address): with a free-form `to` this was an authenticated open relay — any member could mail or
 * text arbitrary strangers from the shop's SMTP and Twilio accounts, on the shop's dime and its
 * sending reputation. Phones compare on their last 10 digits so E.164 and (714) 555-1234 match.
 */
app.post('/api/notify/test', requireRole('manager'), async (req, res) => {
  try {
    const s = getSettings()
    const to = String(req.body?.to || '').trim()
    const channel = req.body?.channel === 'sms' ? 'sms' : 'email'
    if (!to) return res.status(400).json({ error: 'Where should the test go?' })
    const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10)
    const matches = channel === 'sms'
      ? (v) => last10(v).length === 10 && last10(v) === last10(to)
      : (v) => !!v && String(v).trim().toLowerCase() === to.toLowerCase()
    const allowed = channel === 'sms' ? [s.shop_phone] : [s.shop_email, req.member?.email, req.tenant?.owner_email]
    if (!allowed.some(matches)) {
      return res.status(403).json({ error: channel === 'sms' ? "A test SMS only goes to the shop's own phone number — set it in Settings first." : "A test email only goes to the shop's own address or your sign-in email." })
    }
    const r = channel === 'sms'
      ? await sendSms({ to, body: `Test from ${s.shop_name} via PrintShopCRM. SMS is wired.`, settings: s })
      : await sendEmail({ to, subject: `Test from ${s.shop_name}`, body: `This is a test email from ${s.shop_name}'s PrintShopCRM. If you got this, delivery is wired.`, settings: s })
    res.json(r)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

/* ================= PRICING MATRIX (profit guard) ================= */

/**
 * Generate the shop's live pricing matrix + margin guard from its own costing settings.
 * Query overrides let the UI recompute instantly as the shop tweaks assumptions without
 * saving them. Every cell carries its real margin and whether it falls below the floor.
 */
app.get('/api/pricing/matrix', wrap((req, res) => {
  const s = getSettings()
  const num = (v, d) => (v == null || v === '' || isNaN(Number(v)) ? d : Number(v))
  const q = req.query

  // Embroidery and DTF don't price on colors, so they get their own charts rather than being forced
  // through the screen-print grid: embroidery bills by stitch count, DTF by the square inch of film
  // plus the labor of pressing it. Both carry quantity price breaks.
  if (q.chart === 'embroidery') {
    const m = embroideryMatrix({
      garmentCost: num(q.garment, 4), markup: num(q.markup, Number(s.default_markup) || 2),
      ratePer1k: num(q.rate_1k, Number(s.emb_rate_per_1k) || 1),
      minCharge: num(q.min_charge, Number(s.emb_min_charge) || 5),
      digitizingFee: num(q.digitizing, Number(s.emb_digitizing_fee) || 25),
    })
    return res.json({ matrix: m, defaults: {
      garment: 4, markup: Number(s.default_markup) || 2, rate_1k: Number(s.emb_rate_per_1k) || 1,
      min_charge: Number(s.emb_min_charge) || 5, digitizing: Number(s.emb_digitizing_fee) || 25 } })
  }
  if (q.chart === 'dtf') {
    const m = dtfMatrix({
      garmentCost: num(q.garment, 4), markup: num(q.markup, Number(s.default_markup) || 2),
      pricePerSqIn: num(q.per_sq_in, Number(s.dtf_price_per_sq_in) || 0.035),
      pressFee: num(q.press_fee, Number(s.dtf_press_fee) || 1.25),
      minCharge: num(q.min_charge, Number(s.dtf_min_per_piece) || 1.5),
    })
    return res.json({ matrix: m, defaults: {
      garment: 4, markup: Number(s.default_markup) || 2, per_sq_in: Number(s.dtf_price_per_sq_in) || 0.035,
      press_fee: Number(s.dtf_press_fee) || 1.25, min_charge: Number(s.dtf_min_per_piece) || 1.5 } })
  }
  const matrix = pricingMatrix({
    garmentCost: num(q.garment, 4),
    markup: num(q.markup, Number(s.default_markup) || 2),
    screenFee: num(q.screen_fee, Number(s.screen_fee) || 25),
    shopRate: num(q.rate, Number(s.shop_hourly_rate) || 75),
    utilization: num(q.util, Number(s.utilization_pct) || 30) / 100,
    spoilage: num(q.spoilage, Number(s.spoilage_pct) || 2),
    press: q.press || s.press_type || 'auto',
    targetMargin: num(q.target, Number(s.target_margin_pct) || 45),
    decoration: q.deco || 'Screen Print',
    decoMult: parse(s.service_pricing, {}), // the shop's own per-service pricing rules
  })
  res.json({
    matrix,
    defaults: {
      garment: 4, markup: Number(s.default_markup) || 2, screen_fee: Number(s.screen_fee) || 25,
      rate: Number(s.shop_hourly_rate) || 75, util: Number(s.utilization_pct) || 30,
      target: Number(s.target_margin_pct) || 45, press: s.press_type || 'auto',
    },
  })
}))

/* ================= PRICE BOOK ================= */

/**
 * The shop's price book: every service it can sell, the stock rates it starts on, and whatever it
 * has changed. A shop can rewrite any number here and invent services the stock book never had —
 * the defaults exist so a brand-new shop can quote in the first minute, not to constrain anyone.
 */
app.get('/api/pricebook', wrap((_req, res) => {
  const s = getSettings()
  const book = resolveBook(s.price_book)
  res.json({
    services: serviceNames(book).map((name) => {
      const svc = book.services[name]
      return {
        name, axis: svc.axis, axisLabel: AXIS_LABEL[svc.axis] || svc.axis,
        base: svc.base, perUnit: svc.perUnit, unitSize: svc.unitSize || null,
        minPerPiece: svc.minPerPiece || 0, pressFee: svc.pressFee || 0,
        setup: svc.setup, custom: !!svc.custom, edited: !!svc.edited,
        stock: STOCK_SERVICES[name] ? { base: STOCK_SERVICES[name].base, perUnit: STOCK_SERVICES[name].perUnit, setupFee: STOCK_SERVICES[name].setup.fee } : null,
        matrix: serviceMatrix({ book, service: name }),
      }
    }),
    bands: book.bands,
    axes: Object.entries(AXIS_LABEL).map(([k, v]) => ({ key: k, label: v })),
  })
}))

/**
 * Save the shop's own prices. Stores ONLY what differs from stock, so a shop that edits one number
 * keeps getting improvements to everything else — and "reset" is just deleting the key.
 */
/**
 * Parse an uploaded price sheet (CSV / pasted grid) into matrix cells for ONE service. The grid is
 * quantities down the first column, axis values (colours / stitch counts / sq-in) across the first
 * row. Returns `{ cells: {"48|3": 4.25, ...}, rows, cols }` for the client to review, then save via
 * PUT /api/pricebook with `{ matrices: { <service>: cells } }`. This is the "upload your own matrix".
 */
/** The editable price matrix for one service (qty rows x unit cols), with custom-cell flags. */
app.get('/api/pricebook/matrix', wrap((req, res) => {
  const book = resolveBook(getSettings().price_book)
  const service = book.services[req.query.service] ? req.query.service : serviceNames(book)[0]
  const maxColors = req.query.colors ? Number(req.query.colors) : 8
  const m = serviceMatrix({ book, service, maxColors })
  if (!m) return res.status(404).json({ error: 'No such service' })
  res.json({ matrix: m, services: serviceNames(book) })
}))

app.post('/api/pricebook/import', uploadMem.single('file'), reTenant, requireRole('manager'), wrap((req, res) => {
  const text = req.file ? req.file.buffer.toString('utf8') : String(req.body?.text || '')
  if (!text.trim()) return res.status(400).json({ error: 'Upload a CSV or paste your price grid.' })
  const book = resolveBook(getSettings().price_book)
  const service = book.services[req.body?.service] ? req.body.service : null
  if (!service) return res.status(400).json({ error: 'Pick which service this price sheet is for.' })
  // Split rows/cols on comma or tab; tolerate $ and commas in numbers.
  const money = (v) => { const n = Number(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null }
  const cellsIn = text.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.split(/[\t,]/).map((c) => c.trim()))
  if (cellsIn.length < 2) return res.status(400).json({ error: 'Need a header row of colours/units and at least one quantity row.' })
  const header = cellsIn[0].slice(1).map((h) => Math.round(Number(String(h).replace(/[^0-9.]/g, '')) || 0)).filter((n) => n > 0)
  if (!header.length) return res.status(400).json({ error: 'The first row should list the colours / stitch counts / sizes.' })
  // A row label is a quantity BAND, and every real price card writes them as ranges. Stripping the
  // non-digits read "288-499" as the number 288,499 and "500-999" as 500,999, so bandMinFor put
  // eight ordinary rows onto the single 500+ band where each overwrote the last and the 1000+ row
  // won: "Imported 24 prices", THREE stored, and every break from 12 to 499 silently back on the
  // built-in calculator and its $3.00 floor. A 300-piece 2-colour order then quoted $900.00
  // against the shop's own sheet's $1,320.00. parseQtyRange is the reader lib/matrices.mjs
  // already uses for exactly this label.
  const bandMinOf = (label) => {
    const r = matrices.parseQtyRange(label)
    return r && Number.isFinite(r.min) && r.min > 0 ? Math.round(r.min) : 0
  }
  // The sheet's rows ARE the shop's price breaks, so any the stock list lacks is added — at the
  // factor that quantity already resolves to, which leaves every computed price exactly as it is
  // today and only stops two different rows sharing one cell key.
  const bands = [...book.bands]
  const cells = {}
  for (const row of cellsIn.slice(1)) {
    const qty = bandMinOf(row[0])
    if (!(qty > 0)) continue
    if (!bands.some((b) => Number(b.min) === qty)) bands.push({ min: qty, factor: bandFor(qty, book.bands) })
    row.slice(1).forEach((raw, i) => {
      const units = header[i]
      const price = money(raw)
      if (units && price != null) cells[`${qty}|${units}`] = price
    })
  }
  // Report what was STORED, never what was read. That count is the shop's only evidence that its
  // own price sheet is the one the app will quote from.
  const filled = Object.keys(cells).length
  if (!filled) return res.status(400).json({ error: 'No prices found. Use plain numbers like 4.25.' })
  res.json({ ok: true, service, cells, filled, cols: header, bands: bands.sort((a, b) => a.min - b.min) })
}))

/** A plain JSON object — not an array, not a string, not null. */
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

app.put('/api/pricebook', requireRole('manager'), wrap((req, res) => {
  // `services` was taken on trust and walked with Object.entries. Handed a STRING, that yields one
  // entry per character: PUT {"services":"Screen Print"} minted twelve $0.00 services named "0"
  // through "11", and a 20,000-character value minted twenty thousand of them in a single 45ms
  // request. Every one is a full service object with an eight-row matrix, so GET /api/pricebook
  // went to 13.6 MB, /api/settings from 4 KB to 3.6 MB, and the Pricing and Settings screens with
  // them. Undoing it meant twenty thousand deletions one at a time.
  const incoming = req.body?.services ?? {}
  if (!isPlainObject(incoming)) {
    return res.status(400).json({ error: 'services must be an object keyed by service name', code: 'invalid_services' })
  }
  if (Object.keys(incoming).length > 100) {
    return res.status(400).json({ error: 'A price book can hold at most 100 services.', code: 'too_many_services' })
  }
  const bands = Array.isArray(req.body?.bands) ? req.body.bands : null
  const numOr = (v, d) => (v === null || v === undefined || String(v).trim() === '' ? d : (Number(v) || 0))
  // MERGE, don't replace. The editor saves one service card at a time, so a body carrying only
  // {"Screen Print": {...}} must not wipe the shop's embroidery rate or their invented services.
  const priorRaw = getSettings().price_book
  let out = {}
  try { out = JSON.parse(priorRaw || '{}').services || {} } catch { out = {} }
  for (const [name, v] of Object.entries(incoming)) {
    const clean = String(name).trim().slice(0, 40)
    if (!clean) continue
    // Each service must be an object too. A bare string or number here read every field as
    // undefined and silently saved a $0.00 rate under that name.
    if (!isPlainObject(v)) {
      return res.status(400).json({ error: `services[${JSON.stringify(clean)}] must be an object`, code: 'invalid_services' })
    }
    const stock = STOCK_SERVICES[clean]
    const entry = {
      axis: Object.values(AXIS).includes(v.axis) ? v.axis : (stock?.axis || AXIS.FLAT),
      base: Math.max(0, numOr(v.base, stock?.base ?? 0)),
      perUnit: Math.max(0, numOr(v.perUnit, stock?.perUnit ?? 0)),
      unitSize: Math.max(1, numOr(v.unitSize, stock?.unitSize ?? 1000)),
      minPerPiece: Math.max(0, numOr(v.minPerPiece, stock?.minPerPiece ?? 0)),
      pressFee: Math.max(0, numOr(v.pressFee, stock?.pressFee ?? 0)),
      setup: {
        label: v.setup?.label === null || v.setup?.label === '' ? null : String(v.setup?.label ?? stock?.setup.label ?? 'Setup').slice(0, 40),
        fee: Math.max(0, numOr(v.setup?.fee, stock?.setup.fee ?? 0)),
        per: v.setup?.per === 'color' ? 'color' : 'design',
        note: String(v.setup?.note ?? stock?.setup.note ?? '').slice(0, 120),
      },
    }
    // Only persist a built-in service if it actually differs from stock — keeps the saved book small
    // and lets an untouched service keep tracking any future change to the defaults.
    if (stock) {
      const same = entry.axis === stock.axis && entry.base === stock.base && entry.perUnit === stock.perUnit
        && entry.minPerPiece === (stock.minPerPiece || 0) && entry.pressFee === (stock.pressFee || 0)
        && entry.setup.fee === stock.setup.fee && entry.setup.label === stock.setup.label && entry.setup.per === stock.setup.per
      if (same) { delete out[clean]; continue }
    }
    out[clean] = entry
  }
  const saved = { services: out }
  let priorBands = null, priorMatrices = {}
  try { const pj = JSON.parse(priorRaw || '{}'); priorBands = pj.bands || null; priorMatrices = pj.matrices || {} } catch { priorBands = null; priorMatrices = {} }
  if (priorBands) saved.bands = priorBands
  if (bands && bands.length) {
    saved.bands = bands.map((b) => ({ min: Math.max(1, Number(b.min) || 1), factor: Math.max(0.1, Number(b.factor) || 1) }))
      .sort((a, b) => a.min - b.min)
  }
  // Custom price matrix — a shop's OWN per-cell prices, which win over the formula. Merge per cell:
  // a positive number sets the cell, an empty string / 0 / null clears it (reverts that cell to the
  // calculator). Keys are `${bandMin}|${units}`.
  //
  // `services` above got a 100-entry cap and a DELETE route after it was used to mint 20,000 junk
  // services. Its sibling here got neither, and the same trick worked better: the cell-key regex
  // bounds the SHAPE of a key but not how many there are, so one request minting `1|1` through
  // `1|60000` wrote 60,000 cells / 5,000 orphan matrices and took settings.price_book from 2 bytes
  // to 942 KB — a blob getSettings() loads on EVERY request in the process. And a matrix keyed to a
  // service that does not exist is invisible in GET /api/pricebook, so the owner could not even see
  // what to remove. The caps mirror lib/matrices.mjs LIMITS (60 rows x 40 cols).
  const MAX_MATRICES = 100
  const MAX_CELLS = 60 * 40
  const matrices = { ...priorMatrices }
  const rawMatrices = req.body?.matrices
  if (rawMatrices !== undefined && !isPlainObject(rawMatrices)) {
    return res.status(400).json({ error: 'matrices must be an object keyed by service name', code: 'invalid_matrices' })
  }
  const incMatrices = isPlainObject(rawMatrices) ? rawMatrices : null
  if (incMatrices) {
    if (Object.keys(incMatrices).length > MAX_MATRICES) {
      return res.status(400).json({ error: `A price book can hold at most ${MAX_MATRICES} price matrices.`, code: 'too_many_matrices' })
    }
    for (const [svc, cells] of Object.entries(incMatrices)) {
      const key = String(svc).trim().slice(0, 40)
      if (!key || !isPlainObject(cells)) continue
      if (Object.keys(cells).length > MAX_CELLS) {
        return res.status(400).json({ error: `A price matrix can hold at most ${MAX_CELLS} cells.`, code: 'too_many_cells' })
      }
      const m = { ...(matrices[key] || {}) }
      for (const [cell, price] of Object.entries(cells)) {
        if (!/^\d+\|\d+$/.test(cell)) continue
        const v = Number(price)
        if (price === '' || price === null || !(v > 0)) delete m[cell]
        else m[cell] = Math.round(v * 100) / 100
      }
      if (Object.keys(m).length > MAX_CELLS) {
        return res.status(400).json({ error: `A price matrix can hold at most ${MAX_CELLS} cells.`, code: 'too_many_cells' })
      }
      if (Object.keys(m).length) matrices[key] = m; else delete matrices[key]
    }
    if (Object.keys(matrices).length > MAX_MATRICES) {
      return res.status(400).json({ error: `A price book can hold at most ${MAX_MATRICES} price matrices.`, code: 'too_many_matrices' })
    }
  }
  if (Object.keys(matrices).length) saved.matrices = matrices
  setSetting('price_book', JSON.stringify(saved))
  const cellCount = Object.values(saved.matrices || {}).reduce((a, m) => a + Object.keys(m).length, 0)
  logActivity('note', `Price book updated — ${Object.keys(out).length} custom rate(s), ${cellCount} matrix cell(s)`)
  res.json({ ok: true, saved: Object.keys(out).length, cells: cellCount })
}))

/** Drop a service's overrides (built-in reverts to stock; a custom service is removed entirely). */
app.delete('/api/pricebook/:name', requireRole('manager'), wrap((req, res) => {
  let saved = {}
  try { saved = JSON.parse(getSettings().price_book || '{}') } catch { saved = {} }
  if (saved.services) delete saved.services[req.params.name]
  // …and its matrix. Deleting only the service left the matrix behind, and a matrix keyed to a
  // service that no longer exists is not listed by GET /api/pricebook — so the bytes stayed in
  // settings.price_book forever with nothing in the UI able to name them, let alone remove them.
  if (saved.matrices) delete saved.matrices[req.params.name]
  setSetting('price_book', JSON.stringify(saved))
  res.json({ ok: true })
}))

/* ================= CUSTOM PRICE MATRICES =================
 * The shop's own price sheets, in any shape. Unlike /api/pricebook — which drives a calculator
 * that knows what a screen and a stitch count are — a matrix here is just a named grid with free
 * text headers, so a shop can hold pricing for work this software has never modelled: mug
 * printing, laser engraving, banner square footage, rush tiers, anything.
 *
 * Reads are open to any signed-in user (quoting needs them); writes are manager+, matching the
 * price book. See lib/matrices.mjs for the shape and why the grid is stored positionally.
 */

/** Every matrix the shop has, as summaries — plus the starter templates it can import. */
app.get('/api/matrices', wrap((_req, res) => {
  const list = matrices.listMatrices()
  res.json({
    matrices: list.map(matrices.summary),
    templates: matrices.templateSummaries(),
    units: Object.values(matrices.UNITS),
    limits: matrices.LIMITS,
  })
}))

/** One matrix, with every cell — what the editor and the quote picker load. */
app.get('/api/matrices/:id', wrap((req, res) => {
  const m = matrices.getMatrix(req.params.id)
  if (!m) return res.status(404).json({ error: 'No such price matrix' })
  res.json({ matrix: m })
}))

/**
 * Create a matrix — from scratch, or seeded from a starter template with `{ template: 'dtf' }`.
 * A template is a starting point: the new matrix is the shop's own copy, editable to the last cell,
 * with no link back to the template it came from.
 */
app.post('/api/matrices', requireRole('manager'), wrap((req, res) => {
  const b = req.body || {}
  try {
    const m = b.template ? matrices.createFromTemplate(b.template, b) : matrices.createMatrix(b)
    res.json({ matrix: m })
  } catch (e) { res.status(400).json({ error: e.message }) }
}))

/** Save a matrix. Send the whole grid; anything omitted keeps its current value. */
app.put('/api/matrices/:id', requireRole('manager'), wrap((req, res) => {
  try {
    const m = matrices.updateMatrix(req.params.id, req.body || {})
    if (!m) return res.status(404).json({ error: 'No such price matrix' })
    res.json({ matrix: m })
  } catch (e) { res.status(400).json({ error: e.message }) }
}))

/** Copy a matrix — the fast way to make a variant (a second brand, a wholesale sheet, 2026 prices). */
app.post('/api/matrices/:id/duplicate', requireRole('manager'), wrap((req, res) => {
  const m = matrices.duplicateMatrix(req.params.id, req.body?.name)
  if (!m) return res.status(404).json({ error: 'No such price matrix' })
  res.json({ matrix: m })
}))

/** Pre-select this matrix on new quotes. Exactly one matrix is the default at a time. */
app.post('/api/matrices/:id/default', requireRole('manager'), wrap((req, res) => {
  const m = matrices.setDefaultMatrix(req.params.id)
  if (!m) return res.status(404).json({ error: 'No such price matrix' })
  res.json({ matrix: m })
}))

app.delete('/api/matrices/:id', requireRole('manager'), wrap((req, res) => {
  if (!matrices.deleteMatrix(req.params.id)) return res.status(404).json({ error: 'No such price matrix' })
  res.json({ ok: true })
}))

/**
 * Price lookup — the call the quote screen makes. `row` and `col` accept either an index or the
 * header text, and omitting `row` while passing `qty` lets a quantity-banded matrix pick its own
 * row ("144 pieces" → the 144–287 band). Returns 200 with `price: null` when the cell is simply
 * empty, which is a real answer ("we don't price that combination"), not an error.
 */
app.get('/api/matrices/:id/price', wrap((req, res) => {
  const m = matrices.getMatrix(req.params.id)
  if (!m) return res.status(404).json({ error: 'No such price matrix' })
  const hit = matrices.lookupPrice(m, { row: req.query.row, col: req.query.col, qty: req.query.qty })
  res.json({
    matrix: { id: m.id, name: m.name, unit: m.unit, rowLabel: m.rowLabel, colLabel: m.colLabel },
    suggestedRow: matrices.rowIndexForQty(m.rows, req.query.qty),
    ...(hit || { price: null }),
  })
}))

/**
 * Read a price sheet (CSV upload or pasted grid) into matrix shape. Headers are kept as TEXT, so
 * "11 oz Mug" and "Both Sides" survive — the thing that made the old numbers-only importer useless
 * for any trade but screen printing. Creates a new matrix unless `replace` names an existing one.
 */
app.post('/api/matrices/import', uploadMem.single('file'), reTenant, requireRole('manager'), wrap((req, res) => {
  const text = req.file ? req.file.buffer.toString('utf8') : String(req.body?.text || '')
  if (!text.trim()) return res.status(400).json({ error: 'Upload a CSV or paste your price grid.' })
  let sheet
  try { sheet = matrices.parseSheet(text) } catch (e) { return res.status(400).json({ error: e.message }) }
  const replaceId = Number(req.body?.replace) || 0
  const payload = {
    rows: sheet.rows, cols: sheet.cols, cells: sheet.cells,
    ...(sheet.cornerLabel ? { rowLabel: sheet.cornerLabel } : {}),
  }
  try {
    const m = replaceId
      ? matrices.updateMatrix(replaceId, payload)
      : matrices.createMatrix({ ...payload, name: req.body?.name || 'Imported price sheet' })
    if (!m) return res.status(404).json({ error: 'No such price matrix' })
    res.json({ matrix: m, filled: sheet.filled })
  } catch (e) { res.status(400).json({ error: e.message }) }
}))

/* ================= PRODUCTS / CATALOG ================= */

app.get('/api/products', wrap((_req, res) => {
  const garments = listGarments()
  const byBrand = {}
  for (const g of garments) (byBrand[g.brand] ||= []).push(g)
  res.json({ garments, byBrand, count: garments.length, suppliers: supplierStatus(getSettings()) })
}))

/**
 * A job's garments and their own size grids, one entry per sized quote line.
 *
 * Three sources, in order of trust:
 *   1. jobs.line_sizes — written at conversion/quote/autopilot/import since the column existed.
 *   2. the estimate's items — every job written BEFORE that column has an empty line_sizes, and
 *      the per-garment data is still sitting on the estimate. This is what the packing slip has
 *      always read, which is why the packing slip was the one document that got it right.
 *   3. the flat rolled-up grid — a board-created job with no estimate behind it. Single garment
 *      by construction, so one entry is the whole truth.
 * No backfill migration is needed: (2) covers the entire history.
 */
const jobLines = (j) => {
  const stored = parse(j.line_sizes, [])
  if (Array.isArray(stored) && stored.length) return stored
  if (j.estimate_id) {
    const gl = garmentLines(parse(get('SELECT items FROM estimates WHERE id = ?', j.estimate_id)?.items, []))
    if (gl.length) return gl
  }
  // `garment` ONLY — never j.title. This description is handed to costFor(), which picks the SKU
  // the purchase order spends money on, and a job title is free text the shop types. "Reorder — 50
  // for the 3001 event" would have ordered 50 Bella+Canvas 3001, and "Repeat of 2000 shirts" a
  // Gildan 2000, both with matched:true and no warning. A board-created job with no garment on it
  // must keep coming back sku:null with the honest "set the exact style before submitting" warning:
  // a visible dead end is recoverable, a confidently wrong order is not.
  return [{ description: j.garment || '', garment: j.garment || '', sizes: parse(j.sizes, {}) }]
}

/** Build the supplier PO for a job's blanks (ready to submit when a supplier is connected). */
app.get('/api/jobs/:id/po', wrap((req, res) => {
  const j = get('SELECT * FROM jobs WHERE id = ?', +req.params.id)
  if (!j) return res.status(404).json({ error: 'Job not found' })
  const po = buildJobPurchaseOrder(j, jobLines(j), getSettings())
  if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename="PO-${j.job_number}.json"`)
  res.json(po)
}))

/**
 * Submit a garment PO to the connected distributor. Real spend, so it's manager-gated and
 * consolidated (one line per style/color/size) to avoid split shipments. `?dry=1` previews.
 */
app.post('/api/jobs/:id/po/submit', requireRole('manager'), wrap(async (req, res) => {
  const j = get('SELECT * FROM jobs WHERE id = ?', +req.params.id)
  if (!j) return res.status(404).json({ error: 'Job not found' })
  const s = getSettings()
  // Every garment on the job, each costed against its own style. jobLines() already falls back to
  // the estimate's items and then to the flat grid, which is what the old single-garment fallback
  // here was reaching for — one style at a time.
  const po = buildJobPurchaseOrder(j, jobLines(j), s)
  po.po_number = `PSC-${j.job_number}`
  if (req.body?.dry_run) return res.json({ ok: true, dry_run: true, po })
  if (!po.lines.length) return res.status(400).json({ error: 'This job has no sized quantities to order.', po })

  // Idempotency. The PO number is deterministic (PSC-<job>), and submitting places a REAL,
  // chargeable order at the distributor. Without this, a double-click, a nervous re-click after a
  // slow response, or a retry after a timeout each created another purchase_orders row and fired
  // another order — four clicks, four shipments of the same blanks, billed to the shop. If this
  // job's PO is already submitted, return it and do not send again.
  const prior = get('SELECT * FROM purchase_orders WHERE job_id = ? AND po_number = ? ORDER BY id DESC LIMIT 1', j.id, po.po_number)
  // "Has it already gone out?" — not "is the status exactly 'submitted'?". See poAlreadySent().
  // The row is then claimed synchronously before anything is awaited: node:sqlite is synchronous
  // and there is no await between the read and the claim, so a concurrent request cannot slip past.
  if (prior && poAlreadySent(prior)) {
    return res.json({ ok: true, already: true, supplier: prior.supplier, order_id: prior.order_id, po, purchase_order: getPurchaseOrder(prior.id) })
  }

  // Persist FIRST — the local PO record is what receiving works against, and the shop needs it even
  // when they place the order by hand in the distributor's portal (no live connection, or no SKU
  // matched yet). Auto-submission to the distributor is a best-effort layer on top. Reuse the
  // existing row on a retry rather than stacking duplicate draft/failed POs for the one job.
  const stored = prior || createPurchaseOrder(j, po, { status: 'draft' })
  // Claim it before the await — see the note on ALREADY_SENT above.
  run("UPDATE purchase_orders SET status = 'submitting', updated_at = ? WHERE id = ?", now(), stored.id)
  let result = { ok: false, supplier: po.supplier, pending: true }
  try {
    result = await submitPurchaseOrder(po, s, { dryRun: false, poNumber: po.po_number })
  } catch (e) { result = { ok: false, supplier: po.supplier, error: e.message, pending: true } }
  // 'placed_manually' means a human typed this order into the distributor's portal. It is NOT
  // what an API failure means, and calling it that told the shop their blanks were on the way.
  // With an expired S&S key the submit failed, the PO said "placed manually", the timeline said
  // "recorded", and 240 shirts were never ordered — discovered on the due date.
  //
  // Only the genuinely-not-wired path (pending, with a note explaining it and no error) may claim
  // placed_manually. A real error is 'failed', and says so everywhere a human might look.
  const status = result.ok ? 'submitted' : (result.pending && !result.error ? 'placed_manually' : 'failed')
  run('UPDATE purchase_orders SET status = ?, order_id = ?, submitted_at = ?, updated_at = ? WHERE id = ?',
    status, result.order_id || null, result.ok ? now() : null, now(), stored.id)
  logActivity('note', `Blanks PO ${po.po_number} ${status === 'failed' ? 'NOT PLACED' : 'recorded'}${result.supplier ? ` for ${result.supplier}` : ''}${result.order_id ? ` (order ${result.order_id})` : ''} — ${po.total_units} pcs${result.error ? ` — submit failed: ${String(result.error).slice(0, 160)}` : ''}`, { job_id: j.id, contact_id: j.contact_id })
  res.json({ ...result, po, purchase_order: getPurchaseOrder(stored.id) })
}))

/** All purchase orders recorded for a job, each with per-cell receiving state. */
app.get('/api/jobs/:id/purchase-orders', wrap((req, res) => {
  const j = get('SELECT * FROM jobs WHERE id = ?', +req.params.id)
  if (!j) return res.status(404).json({ error: 'Job not found' })
  res.json({ purchase_orders: purchaseOrdersForJob(j.id) })
}))

/** One PO with its lines + shortages. */
app.get('/api/purchase-orders/:id', wrap((req, res) => {
  const po = getPurchaseOrder(+req.params.id)
  if (!po) return res.status(404).json({ error: 'Purchase order not found' })
  res.json(po)
}))

/**
 * Receive goods against a PO, per size cell. Body: { receipts: [{ line_id, qty }] }. This is the
 * "100 ordered, 97 arrived — 2 S and 1 M short" case that no competitor models per cell.
 */
app.post('/api/purchase-orders/:id/receive', requireRole('manager'), wrap((req, res) => {
  const before = getPurchaseOrder(+req.params.id)
  if (!before) return res.status(404).json({ error: 'Purchase order not found' })
  const updated = receivePurchaseOrder(before.id, Array.isArray(req.body?.receipts) ? req.body.receipts : [], { by: req.member?.name })
  const shortLines = updated.lines.filter((l) => l.short > 0)
  logActivity('note', `Received on ${updated.po_number}: ${updated.received}/${updated.ordered} pcs${updated.short > 0 ? ` — ${updated.short} short (${shortLines.map((l) => `${l.short} ${l.size}`).join(', ')})` : ''}`, { job_id: updated.job_id })
  res.json(updated)
}))

/**
 * Short-close a purchase order: the rest is not coming.
 *
 * DELETE /api/jobs/:id has told shops to do exactly this since it was written, and nothing
 * anywhere could. 'closed' is READ by poAlreadySent() and written by nobody, and
 * receivePurchaseOrder() can only reach 'received' on a FULL receipt — so a PO the distributor
 * part-filled (a discontinued colour, the routine case) sat at 'partial', which is in
 * PO_STILL_OUT, and the job could never leave the board. It kept counting toward the board's
 * piece totals and Capacity's committed pieces, and the one escape the product offered was to
 * record blanks as received that never arrived: a number that then feeds the shortage report, the
 * pick ticket, the packing list and the job's blank cost in ROI. A permanently wedged board or a
 * corrupted inventory record, under a refusal naming an action that did not exist.
 *
 * Deliberately not a delete. The money was spent and the shortage is a fact the shop may still
 * need to chase with the distributor, so the order stays, says what happened, and stops being an
 * open commitment.
 */
app.post('/api/purchase-orders/:id/close', requireRole('manager'), wrap((req, res) => {
  const po = getPurchaseOrder(+req.params.id)
  if (!po) return res.status(404).json({ error: 'Purchase order not found', code: 'not_found' })
  if (po.status === 'closed') return res.json({ ok: true, already: true, purchase_order: po })
  if (po.fully_received) return res.status(409).json({ error: `${po.po_number || `PO #${po.id}`} arrived in full — there is nothing outstanding to close.`, code: 'po_fully_received' })
  const reason = String(req.body?.reason || '').slice(0, 200)
  run("UPDATE purchase_orders SET status = 'closed' WHERE id = ?", po.id)
  logActivity('note', `${po.po_number || `PO #${po.id}`} short-closed — ${po.received}/${po.ordered} received, ${po.short} never arrived${reason ? ` — ${reason}` : ''}`, { job_id: po.job_id })
  res.json({ ok: true, purchase_order: getPurchaseOrder(po.id) })
}))

/* ================= RIP / PRINT PACKAGE ================= */

/**
 * Print-ready package for the RIP / hot folder: the approved art + any recorded screen spec (
 * inks, print order) + the size grid, as a manifest a RIP or DTF workflow can consume. The film
 * positives come from whatever prepress tool the shop already uses.
 */
app.get('/api/jobs/:id/print-package', wrap((req, res) => {
  const j = get('SELECT * FROM jobs WHERE id = ?', +req.params.id)
  if (!j) return res.status(404).json({ error: 'Job not found' })
  const approved = get(`SELECT * FROM art_versions WHERE job_id = ? AND status='approved' ORDER BY version DESC LIMIT 1`, j.id)
  const sep = parse(j.separation, null)
  if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename="print-package-${j.job_number}.json"`)
  res.json({
    job: j.job_number, title: j.title, garment: j.garment,
    // `sizes` is the rolled-up total; `lines` carries each garment with its own grid, so a RIP
    // package for a two-style order no longer describes it as one merged run.
    sizes: parse(j.sizes, {}), lines: jobLines(j), quantities: j.quantities,
    approved_art: approved ? { file: `/uploads/${approved.filename}`, version: approved.version } : null,
    separation: sep ? { mode: sep.mode, screens: sep.screens, inks: sep.inks, dark: sep.dark } : null,
    // Print-readiness is APPROVED ART. A screen separation is a screen-print-only extra that
    // nothing in the running product records any more — jobs.separation is read everywhere and
    // written only by seed.mjs, so the demo shop was the one install where this looked right.
    // Gating on it told every DTF, embroidery and vinyl job, and every job on a real install,
    // "needs approved art" with the approved art's filename one key above the sentence.
    ready: !!approved,
    note: !approved ? 'Not print-ready: no approved art on this job yet — send a proof and get it signed off.'
      : sep ? 'Ready for the RIP — approved art, ink list and the full size grid.'
        : 'Ready for the RIP — approved art and the full size grid. No screen separation is recorded (DTF, embroidery and vinyl do not use one).',
  })
}))

/** Packing slip PDF for a job — what's in the box, no prices. */
/**
 * A/R aging — balance-carrying invoices bucketed by days past due, grouped per customer.
 * The report InkSoft/Deco users say they can't get; here it's an endpoint plus a view.
 */
app.get('/api/reports/ar-aging', wrap((_req, res) => {
  const today = new Date().toISOString().slice(0, 10)
  // `status != 'void'` is load-bearing: without it this report chased invoices the shop had already
  // cancelled, and disagreed with the dashboard about the same money.
  const open = all(`SELECT i.*, c.name AS contact_name, c.company, c.email FROM invoices i
    LEFT JOIN contacts c ON c.id = i.contact_id
    WHERE i.status != 'void' AND (i.amount_due - i.amount_paid) > 0.005 ORDER BY i.due_date IS NULL, i.due_date`)
  const daysPast = (i) => {
    const ref = i.due_date || String(i.created_at || '').slice(0, 10)
    return ref ? Math.floor((new Date(`${today}T00:00:00Z`) - new Date(`${ref}T00:00:00Z`)) / 864e5) : 0
  }
  const bucketOf = (d) => (d <= 0 ? 'current' : d <= 30 ? 'd30' : d <= 60 ? 'd60' : d <= 90 ? 'd90' : 'd90p')
  const totals = { current: 0, d30: 0, d60: 0, d90: 0, d90p: 0 }
  const byContact = new Map()
  for (const i of open) {
    const balRaw = round2(i.amount_due - i.amount_paid)
    const b = bucketOf(daysPast(i))
    totals[b] = round2(totals[b] + balRaw)
    const key = i.contact_id || 0
    if (!byContact.has(key)) byContact.set(key, { contact_id: i.contact_id, name: i.contact_name || 'Unknown', company: i.company || '', email: i.email || '', current: 0, d30: 0, d60: 0, d90: 0, d90p: 0, total: 0, invoices: [] })
    const row = byContact.get(key)
    row[b] = round2(row[b] + balRaw)
    row.total = round2(row.total + balRaw)
    row.invoices.push({ id: i.id, number: i.invoice_number, due_date: i.due_date, balance: balRaw, days_past: daysPast(i), status: i.status })
  }
  const rows = [...byContact.values()].sort((a, b) => b.total - a.total)
  res.json({ as_of: today, totals: { ...totals, due: round2(totals.current + totals.d30 + totals.d60 + totals.d90 + totals.d90p) }, customers: rows })
}))

/**
 * Customer statement PDF — every open item plus recent settled ones, with an aging strip.
 *
 * OPEN INVOICES ARE NEVER TRUNCATED. A cap here understates what the customer owes on the document
 * you mail them, and makes the statement disagree with the A/R report. Only the settled "recent
 * activity" rows are limited, and they can't change the balance.
 */
app.get('/api/contacts/:id/statement.pdf', wrap((req, res) => {
  const c = get('SELECT * FROM contacts WHERE id = ?', +req.params.id)
  if (!c) return res.status(404).json({ error: 'Contact not found' })
  const open = all(`SELECT * FROM invoices WHERE contact_id = ? AND status != 'void' AND (amount_due - amount_paid) > 0.005
    ORDER BY COALESCE(due_date, date(created_at)) ASC, id ASC`, c.id)
  const settled = all(`SELECT * FROM invoices WHERE contact_id = ? AND status != 'void' AND (amount_due - amount_paid) <= 0.005
    AND created_at >= date('now', '-365 days')
    ORDER BY COALESCE(due_date, date(created_at)) DESC, id DESC LIMIT 60`, c.id)
  const invoices = [...open, ...settled]
  const buf = customerStatement({ contact: c, settings: getSettings(), invoices })
  res.type('application/pdf').setHeader('Content-Disposition', `inline; filename="statement-${(c.company || c.name || 'customer').replace(/[^\w-]+/g, '-').toLowerCase()}.pdf"`)
  res.send(buf)
}))

app.get('/api/jobs/:id/packing-slip.pdf', wrap((req, res) => {
  const j = get('SELECT * FROM jobs WHERE id = ?', +req.params.id)
  if (!j) return res.status(404).send('Not found')
  const contact = get('SELECT * FROM contacts WHERE id = ?', j.contact_id)
  const est = j.estimate_id ? get('SELECT items FROM estimates WHERE id = ?', j.estimate_id) : null
  const items = est ? parse(est.items, []) : [{ description: j.garment || j.title, sizes: parse(j.sizes, {}) }]
  res.type('application/pdf').setHeader('Content-Disposition', `inline; filename="${j.job_number}-packing-slip.pdf"`)
  res.send(packingSlip({ job: j, contact, settings: getSettings(), items }))
}))

/** Warehouse pick ticket PDF — the size grid as a checkable pick list. */
app.get('/api/jobs/:id/pick-ticket.pdf', wrap((req, res) => {
  const j = get('SELECT * FROM jobs WHERE id = ?', +req.params.id)
  if (!j) return res.status(404).send('Not found')
  res.type('application/pdf').setHeader('Content-Disposition', `inline; filename="${j.job_number}-pick-ticket.pdf"`)
  res.send(pickTicket({ job: j, settings: getSettings(), sizes: parse(j.sizes, {}), lines: jobLines(j) }))
}))

/** Live blank inventory across connected distributors (degrades to empty when none/unverified). */
app.get('/api/suppliers/inventory', wrap(async (req, res) => {
  const style = String(req.query.style || '').trim()
  if (!style) return res.status(400).json({ error: 'Pass a style, e.g. ?style=Gildan 5000' })
  res.json(await liveInventory(style, getSettings(), { timeoutMs: 8000 }))
}))

/**
 * Order-history import (Printavo/YoPrint/InkSoft/Deco CSV export). Preview parses + summarizes;
 * commit writes the FULL history graph per order — estimate + invoice (+ payment) + completed job,
 * all backdated to the order date — so Reorder Radar cadence, lifetime value, AR aging and
 * "same as last time" work from day one of a trial, not after a year of new data.
 *
 * Open quotes in the export stay open (sent estimate, no invoice); unpaid invoices stay unpaid
 * (they land in AR aging, which is where a switching shop wants them). Everything else is history:
 * paid invoice + payment row + a job in 'complete' so the board stays clean (board shows only
 * status='active'). Re-imports are idempotent on the source order number.
 */
/**
 * Fold an order export's per-line rows into one order each, and decide what the order was worth.
 *
 * A `Total` column means one of two different things depending on who wrote the export: the ORDER
 * total, repeated on every line, or THAT LINE's extended total. The fold used to take the largest
 * value it saw, which is right for the first shape and badly wrong for the second — a real
 * three-line order of 1000 + 600 + 300 was recorded as a $1,900 subtotal under a $1,000 total, and
 * a $1,000 invoice was written and marked paid. $900 of the shop's own history simply disappeared,
 * on an import whose whole promise is that leaving a competitor costs you nothing.
 *
 * The file carries the evidence to tell them apart: quantity x unit price, which the exporter
 * computed independently of whichever total it chose to print. Whichever reading lands closer to
 * that is the one it meant. When the file gives no unit price at all there is nothing to weigh, and
 * an identical total on every single line is the signature of a repeated order total, so that case
 * keeps the old behaviour.
 */
function groupImportedOrders(orders) {
  const qtyOf = (l) => (l.sizes && sizeTotal(l.sizes) > 0 ? sizeTotal(l.sizes) : Number(l.quantity) || 0)
  const grouped = []
  const byRef = new Map()
  for (const o of orders || []) {
    const key = o.order_number ? `#${String(o.order_number).toLowerCase()}` : ''
    if (key && byRef.has(key)) { byRef.get(key)._lines.push(o); continue }
    const g = { ...o, _lines: [o] }
    grouped.push(g)
    if (key) byRef.set(key, g)
  }
  for (const g of grouped) {
    const totals = g._lines.map((l) => Number(l.total)).filter((n) => Number.isFinite(n) && n > 0)
    if (!totals.length) { g.total = null; continue }
    if (totals.length === 1) { g.total = round2(totals[0]); continue }
    const sum = round2(totals.reduce((a, b) => a + b, 0))
    const max = Math.max(...totals)
    const hasUnitPrice = g._lines.some((l) => Number(l.unit_price) > 0)
    if (!hasUnitPrice && totals.every((n) => n === totals[0])) { g.total = round2(max); continue }
    const evidence = round2(g._lines.reduce((a, l) => a + (Number(l.unit_price) || 0) * qtyOf(l), 0))
    g.total = Math.abs(sum - evidence) <= Math.abs(max - evidence) ? sum : round2(max)
  }
  return grouped
}

app.post('/api/import/orders', uploadMem.single('file'), reTenant, requireRole('manager'), wrap(async (req, res) => {
  const text = req.file ? req.file.buffer.toString('utf8') : String(req.body?.text || '')
  if (!text.trim()) return res.status(400).json({ error: 'Upload a CSV file or paste the rows.' })
  const rows = parseCsv(text)
  if (!rows.length) return res.status(400).json({ error: 'No rows found — is the first line the column headers?' })
  const mapped = mapOrderRows(rows)
  // Preview what the import will WRITE, not what the file contains. Folded per line-item rows are
  // one order, not four, and the value shown has to be the value that lands: a three-line $1,900
  // order previewed as "3 orders — $1,900 of history" and then wrote one $1,000 invoice.
  // Fold ONCE. The commit path used to group the file a second time further down and throw this
  // copy away, which on a 60,000-row export is a second full pass for nothing.
  const grouped = groupImportedOrders(mapped.orders)
  const preview = req.body?.preview === 'true' || req.body?.preview === true
  if (preview) {
    const summary = summarizeImport({ orders: grouped, warnings: mapped.warnings })
    return res.json({ preview: true, ...summary, sample: grouped.slice(0, 8), warnings: mapped.warnings.slice(0, 20) })
  }

  let created = 0, contactsMade = 0, skippedDupes = 0, openQuotes = 0, unpaidInvoices = 0, reconciled = 0
  const findContact = (name, email) => {
    let c = email ? get('SELECT * FROM contacts WHERE lower(email) = lower(?)', email) : null
    if (!c && name) c = get('SELECT * FROM contacts WHERE lower(name) = lower(?)', name)
    if (c) return c
    const id = Number(run('INSERT INTO contacts (name, email, tags, created_at, updated_at) VALUES (?,?,?,?,?)',
      name || email || 'Imported customer', email || '', 'imported', now(), now()).lastInsertRowid)
    contactsMade++
    return get('SELECT * FROM contacts WHERE id = ?', id)
  }

  // (`grouped` is folded once, above the preview branch: many exports are one row PER LINE ITEM
  // with the order number repeated, and a 4-line order must not become 4 one-line orders.)
  // The export's own status decides how much of the graph gets written.
  const classify = (status) => {
    const s = String(status || '').toLowerCase()
    if (/quote|estimate|draft|pending approval/.test(s)) return 'quote'
    if (/unpaid|invoiced|awaiting payment|balance|overdue|partial/.test(s)) return 'unpaid'
    return 'paid' // complete/delivered/shipped/closed/paid/blank — treat as settled history
  }
  const stamp = now()
  // Every imported order needs a stable identity, and plenty of real exports have no order-number
  // column at all — customer, date, product, qty, price is a perfectly ordinary shape. Those rows
  // got an EMPTY ref, which skipped the dedupe check entirely, so re-importing the same file wrote
  // everything a second time: 300 rows became 600 estimates, 600 invoices and 600 payments, and
  // every customer's lifetime value doubled ($208,800 recorded where $104,400 was real). Reorder
  // Radar computes cadence from that same order count, so the shop's "due to reorder" list was
  // then driven off a buying pattern that never happened — while the dialog on screen promised
  // re-running an export was safe. One double-click or one refresh was enough, and there is no
  // screen anywhere that lists imported orders, so nothing could be found or undone afterwards.
  //
  // A content hash of the file plus the row's position gives those rows an identity. It is
  // deliberately per-FILE: two different exports that happen to contain the same order both
  // import, exactly as today, because refusing data the shop meant to add is the worse error.
  const fileTag = crypto.createHash('sha1').update(text).digest('hex').slice(0, 12)
  /**
   * Write the import in batches, handing the event loop back between them.
   *
   * node:sqlite is synchronous, so one tx() around 60,000 orders is 18 SECONDS of unbroken
   * blocking — measured, with /health answering twice in that window and every other shop on the
   * box frozen behind it, on a 4.79MB file that is well inside the app's own 8MB upload cap. A
   * `tx()` callback must stay synchronous (an await inside would let another request interleave
   * mid-transaction), so the yield goes BETWEEN transactions, not inside one.
   *
   * The unit of atomicity that matters is the ORDER — estimate → invoice → payment → job is what
   * must never be half-written — and a batch never splits one. Whole-file atomicity is what we
   * give up, and it was worth less than it looks: a throw on the last row used to roll back all
   * 18 seconds of work, whereas now the batches that landed stay landed and re-uploading the same
   * file finishes the job. That resumption is not a hope — every row's identity is derived from
   * the file's content hash and its position (`csv:<fileTag>:<index>`), or from the export's own
   * order number, so a re-import skips exactly what already arrived. The gate asserts both halves:
   * that the loop keeps breathing, and that a re-import writes nothing new.
   */
  const BATCH = 200
  const writeOne = (o, rowIndex) => {
    // Idempotent on the source system's order number, matched EXACTLY against its own column.
    // (This was a substring LIKE over the notes text, so importing INV-9 after INV-90 silently
    // discarded the whole order as a "duplicate".)
    const ref = o.order_number ? String(o.order_number).slice(0, 120) : `csv:${fileTag}:${rowIndex}`
    if (get('SELECT id FROM estimates WHERE source_ref = ?', ref)) { skippedDupes++; return }

    const c = findContact(o.customer_name, o.customer_email)
    const when = o.date ? `${o.date} 12:00:00` : now()
    const items = o._lines.map((ln) => {
      const sizes = ln.sizes && Object.keys(ln.sizes).length ? ln.sizes : { M: ln.quantity || 0 }
      const qty = sizeTotal(sizes)
      return {
        description: ln.garment || ln.order_number || 'Imported order',
        sizes,
        unit_price: Number(ln.unit_price) || (ln.total && qty ? Number(ln.total) / qty : 0),
        decoration: ln.decoration || 'Screen Print',
        taxable: true,
      }
    })
    const allSizes = rollupSizes(items)
    freezeUpcharges(items).forEach((it, i) => { items[i] = it })
    const t = computeTotals(items, 0, getUpcharges())
    // A document must never hide money between its subtotal and its total — 8e9239e. The file's
    // total is authoritative, because it is what the shop actually billed; the reconstructed
    // lines are what the document PRINTS, and an export's total routinely carries setup, rush,
    // shipping or tax that no line accounts for. Storing one over the other reproduced that exact
    // defect one layer down: Subtotal $1,000.00 / Tax $0.00 / TOTAL $1,180.00, with $180 arriving
    // from nowhere, stored, carried into the invoice's frozen amount_due and posted to the books.
    // Give the difference a line of its own instead, so the money is named rather than missing.
    const filed = Number(o.total) > 0 ? round2(Number(o.total)) : null
    const gap = filed == null ? 0 : round2(filed - t.total)
    if (Math.abs(gap) >= 0.01) {
      items.push({ description: gap > 0 ? 'Other charges' : 'Discount', qty: 1, unit_price: gap, taxable: false })
      reconciled++
    }
    const doc = Math.abs(gap) >= 0.01 ? computeTotals(items, 0, getUpcharges()) : t
    const total = filed != null ? doc.total : t.total
    const kind = classify(o.status)
    // Keyed off the REAL order number: "was csv:1f1c562505d8:0" is not something to show a customer.
    const notes = `Imported${o.order_number ? ` — was ${ref}` : ''}${o.date ? ` (${o.date})` : ''}`.trim()

    const estStatus = kind === 'quote' ? 'sent' : 'approved'
    const estId = Number(run('INSERT INTO estimates (contact_id, estimate_number, status, items, subtotal, tax, total, tax_rate, notes, source_ref, imported_at, sent_at, approved_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      c.id, nextEstimateNumber(), estStatus, JSON.stringify(items), doc.subtotal, doc.tax, total, 0,
      notes, ref, stamp, when, kind === 'quote' ? null : when, when).lastInsertRowid)
    created++
    if (kind === 'quote') { openQuotes++; return }

    const invId = Number(run('INSERT INTO invoices (estimate_id, contact_id, invoice_number, status, amount_due, amount_paid, due_date, paid_at, imported_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      estId, c.id, nextInvoiceNumber(), kind === 'paid' ? 'paid' : 'unpaid', total,
      kind === 'paid' ? total : 0, o.due_date || o.date || null, kind === 'paid' ? when : null, stamp, when).lastInsertRowid)
    if (kind === 'paid') {
      run('INSERT INTO payments (invoice_id, amount, method, note, created_at) VALUES (?,?,?,?,?)',
        invId, total, 'imported', notes, when)
    } else unpaidInvoices++

    // The job row is what Reorder Radar reads cadence from — created_at MUST be the
    // historical order date, or every imported customer looks like they ordered today.
    run(`INSERT INTO jobs (contact_id, estimate_id, invoice_id, job_number, title, status, stage, decoration, sizes, line_sizes, due_date, notes, imported_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      c.id, estId, invId, nextJobNumber(), o.garment || o.order_number || 'Imported order',
      'complete', 'complete', o.decoration || 'Screen Print', JSON.stringify(allSizes), JSON.stringify(garmentLines(items)),
      o.due_date || null, notes, stamp, when, when)
  }
  for (let i = 0; i < grouped.length; i += BATCH) {
    const batch = grouped.slice(i, i + BATCH)
    tx(() => { batch.forEach((o, n) => writeOne(o, i + n)) })
    // Between transactions, never inside one: this is what lets /health answer, another shop
    // load a page, and a websocket stay alive while a big export is landing.
    if (i + BATCH < grouped.length) await new Promise((r) => setImmediate(r))
  }
  logActivity('note', `Imported ${created} order(s) with history (${contactsMade} new customers, ${openQuotes} open quotes, ${unpaidInvoices} unpaid invoices${skippedDupes ? `, ${skippedDupes} duplicates skipped` : ''}${reconciled ? `, ${reconciled} with charges the lines did not explain` : ''}) from a CSV`, {})
  res.json({ ok: true, imported: created, new_customers: contactsMade, open_quotes: openQuotes, unpaid_invoices: unpaidInvoices, skipped_duplicates: skippedDupes, totals_reconciled: reconciled, warnings: mapped.warnings.slice(0, 20) })
}))

/* ================= PUBLIC REST API v1 =================
 * Authenticated by Authorization: Bearer psc_live_… (see the gate). On every plan — Printavo
 * gates its API behind Premium, InkSoft behind Unlimited + an undisclosed fee, DecoNetwork
 * behind $439/mo Enterprise with no customer or quote objects at all. Ours ships with docs,
 * published rate limits (120/min) and signed webhooks, for every shop, day one. */

// Must floor to an integer: node:sqlite refuses a fractional binding, so `?limit=2.5` would 500
// the endpoint rather than paginate.
// Number('1e400') is Infinity, and binding Infinity as a SQLite LIMIT/OFFSET throws — so
// ?offset=1e400 returned a 500 from a public, documented query parameter. Coerce to a finite
// integer and clamp; a non-finite or absurd value becomes the default rather than a crash.
const v1int = (v, dflt, lo, hi) => {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : dflt
}
const v1Limit = (q, cap = 100) => v1int(q.limit, 25, 1, cap)
const v1Offset = (q) => v1int(q.offset, 0, 0, 1_000_000_000)
const v1List = (res, rows, limit) => res.json({ data: rows.slice(0, limit), has_more: rows.length > limit })

const v1Customer = (c) => c && ({ id: c.id, name: c.name, email: c.email || '', phone: c.phone || '', company: c.company || '', tags: c.tags || '', created_at: c.created_at })
const v1Estimate = (e) => e && ({ id: e.id, number: e.estimate_number, customer_id: e.contact_id, status: e.status, items: parse(e.items, []), subtotal: e.subtotal, tax: e.tax, total: e.total, notes: e.notes || '', sent_at: e.sent_at, approved_at: e.approved_at, created_at: e.created_at })
const v1Invoice = (i) => i && ({ id: i.id, number: i.invoice_number, customer_id: i.contact_id, estimate_id: i.estimate_id, status: i.status, amount_due: i.amount_due, amount_paid: i.amount_paid, balance: Math.round(((i.amount_due || 0) - (i.amount_paid || 0)) * 100) / 100, due_date: i.due_date, paid_at: i.paid_at, created_at: i.created_at })
const v1Job = (j) => j && ({ id: j.id, number: j.job_number, customer_id: j.contact_id, estimate_id: j.estimate_id, invoice_id: j.invoice_id, title: j.title, status: j.status, stage: j.stage, decoration: j.decoration || '', sizes: parse(j.sizes, {}), due_date: j.due_date, rush: !!j.rush, created_at: j.created_at })
const v1Payment = (p) => p && ({ id: p.id, invoice_id: p.invoice_id, amount: p.amount, method: p.method, created_at: p.created_at })

app.get('/api/v1/me', wrap((req, res) => {
  const s = getSettings()
  res.json({ shop: s.shop_name || req.tenant?.shop_name || '', plan: req.tenant?.plan_tier || req.tenant?.plan || 'dev', rate_limit: '120/min', docs: '/docs-api.html' })
}))

app.get('/api/v1/customers', wrap((req, res) => {
  const limit = v1Limit(req.query); const off = v1Offset(req.query)
  const q = String(req.query.query || '').trim()
  const rows = q
    ? all('SELECT * FROM contacts WHERE name LIKE ? OR email LIKE ? OR company LIKE ? ORDER BY id DESC LIMIT ? OFFSET ?', `%${q}%`, `%${q}%`, `%${q}%`, limit + 1, off)
    : all('SELECT * FROM contacts ORDER BY id DESC LIMIT ? OFFSET ?', limit + 1, off)
  v1List(res, rows.map(v1Customer), limit)
}))
app.get('/api/v1/customers/:id', wrap((req, res) => {
  const c = get('SELECT * FROM contacts WHERE id = ?', Number(req.params.id))
  if (!c) return res.status(404).json({ error: 'not_found' })
  const orders = all('SELECT * FROM jobs WHERE contact_id = ? ORDER BY created_at DESC LIMIT 20', c.id).map(v1Job)
  // Same effective status as the list and the detail endpoint — this embedded copy had the third
  // spelling of the same invoice.
  const invoices = all(`SELECT i.*, ${EFFECTIVE_STATUS_SQL} AS status FROM invoices i WHERE i.contact_id = ? ORDER BY i.created_at DESC LIMIT 20`, todayIso(), c.id).map(v1Invoice)
  res.json({ ...v1Customer(c), recent_jobs: orders, recent_invoices: invoices })
}))
app.post('/api/v1/customers', wrap((req, res) => {
  const b = req.body || {}
  const name = String(b.name || '').trim()
  if (!name) return res.status(400).json({ error: 'name is required' })
  const email = String(b.email || '').trim().toLowerCase()
  const dupe = email ? get('SELECT * FROM contacts WHERE lower(email) = ?', email) : null
  if (dupe) return res.status(409).json({ error: 'A customer with that email already exists', id: dupe.id })
  const id = Number(run('INSERT INTO contacts (name, email, phone, company, tags, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
    name.slice(0, 120), email.slice(0, 160), String(b.phone || '').slice(0, 40), String(b.company || '').slice(0, 120), 'api', now(), now()).lastInsertRowid)
  const c = get('SELECT * FROM contacts WHERE id = ?', id)
  fireAuto('contact.created', { contact: c })
  res.status(201).json(v1Customer(c))
}))

app.get('/api/v1/estimates', wrap((req, res) => {
  const limit = v1Limit(req.query); const off = v1Offset(req.query)
  const st = String(req.query.status || '').trim()
  const rows = st
    ? all('SELECT * FROM estimates WHERE status = ? ORDER BY id DESC LIMIT ? OFFSET ?', st, limit + 1, off)
    : all('SELECT * FROM estimates ORDER BY id DESC LIMIT ? OFFSET ?', limit + 1, off)
  v1List(res, rows.map(v1Estimate), limit)
}))
app.get('/api/v1/estimates/:id', wrap((req, res) => {
  const e = get('SELECT * FROM estimates WHERE id = ?', Number(req.params.id))
  if (!e) return res.status(404).json({ error: 'not_found' })
  res.json(v1Estimate(e))
}))
app.post('/api/v1/estimates', wrap((req, res) => {
  const b = req.body || {}
  // A customer_id that names nobody used to fall through to the customer{} block and CREATE
  // someone: `{"customer_id": 9999, "customer": {"name":"Ghost"}}` returned 201 with the estimate
  // attached to a brand-new contact 3. The caller asked to bill an existing account and got a
  // duplicate instead — a silent wrong write, which is worse than a refusal. An id that was
  // supplied is authoritative: honour it or say it does not exist.
  let contact = null
  if (b.customer_id !== undefined && b.customer_id !== null && b.customer_id !== '') {
    const cid = Number(b.customer_id)
    if (!Number.isInteger(cid) || cid <= 0) return res.status(400).json({ error: 'customer_id must be a positive whole number', code: 'invalid_customer_id' })
    contact = get('SELECT * FROM contacts WHERE id = ?', cid)
    if (!contact) return res.status(404).json({ error: `customer_id ${cid} does not exist`, code: 'customer_not_found' })
  }
  if (!contact && b.customer && b.customer.name) {
    const email = String(b.customer.email || '').trim().toLowerCase()
    contact = email ? get('SELECT * FROM contacts WHERE lower(email) = ?', email) : null
    if (!contact) {
      const id = Number(run('INSERT INTO contacts (name, email, phone, company, tags, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
        String(b.customer.name).slice(0, 120), email.slice(0, 160), String(b.customer.phone || '').slice(0, 40), String(b.customer.company || '').slice(0, 120), 'api', now(), now()).lastInsertRowid)
      contact = get('SELECT * FROM contacts WHERE id = ?', id)
    }
  }
  if (!contact) return res.status(400).json({ error: 'customer_id or customer{name,…} is required' })
  if (!Array.isArray(b.items) || !b.items.length) return res.status(400).json({ error: 'items[] is required' })
  // Reject, never coerce. An integration cannot see a silently-defaulted quantity or a dropped
  // line — it just gets a 201 and a wrong dollar figure on a document a customer will sign.
  if (b.items.length > 50) return res.status(400).json({ error: 'items[] is limited to 50 lines per estimate', code: 'too_many_items' })
  const items = []
  for (const [i, it] of b.items.entries()) {
    const where = `items[${i}]`
    // A null element is what a Zapier or Make line-item mapping emits for a blank row, and it was
    // the one malformed shape that reached `it.sizes` and threw — a 500 where every other bad
    // element ("str", 123, [], true) already answered 400. The docs promise refusals, not crashes.
    if (!it || typeof it !== 'object' || Array.isArray(it)) {
      return res.status(400).json({ error: `${where} must be an object like {"description":"…","quantity":24,"unit_price":9.5}`, code: 'invalid_item' })
    }
    let sizes
    if (it.sizes != null) {
      if (typeof it.sizes !== 'object' || Array.isArray(it.sizes)) return res.status(400).json({ error: `${where}.sizes must be an object like {"M":24}` })
      sizes = {}
      for (const [k, v] of Object.entries(it.sizes)) {
        if (!SIZES.includes(k)) return res.status(400).json({ error: `${where}.sizes has unknown size "${k}" — allowed: ${SIZES.join(', ')}` })
        // The same "reject, never coerce" rule unit_price gets below. Number(true) is 1 and
        // Number([24]) is 24, and both pass Number.isInteger — so {"M":true} booked one piece and
        // {"M":[24]} booked twenty-four, each with a 201 and no way for the caller to see it.
        if (typeof v !== 'number' && !(typeof v === 'string' && v.trim() !== '')) {
          return res.status(400).json({ error: `${where}.sizes["${k}"] must be a whole number >= 0`, code: 'invalid_quantity' })
        }
        const n = Number(v)
        if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return res.status(400).json({ error: `${where}.sizes["${k}"] must be a whole number >= 0`, code: 'invalid_quantity' })
        // Number.isInteger(1e300) is true. Uncapped, that reached the money arithmetic and came
        // back a stored subtotal of 1e302. The app's own screens clamp to MAX_PIECES; the public
        // API refuses instead, because an integration must never see a silently-changed quantity.
        if (n > MAX_PIECES) return res.status(400).json({ error: `${where}.sizes["${k}"] must be at most ${MAX_PIECES}`, code: 'invalid_quantity' })
        sizes[k] = n
      }
      if (!Object.values(sizes).some((n) => n > 0)) return res.status(400).json({ error: `${where}.sizes must contain at least one quantity greater than zero` })
    } else {
      // `qty` is the canonical name in public/js/shared/pricing.js; `quantity` is its documented alias.
      // Same rule as unit_price: a real number or a string that says one. Number(true) is 1 and
      // Number([24]) is 24, so `quantity: true` used to book one piece and `quantity: [24]`
      // twenty-four, both with a 201 — while `taxable: 1` one field over was already a 400.
      const rawQ = it.quantity ?? it.qty
      if (typeof rawQ !== 'number' && !(typeof rawQ === 'string' && rawQ.trim() !== '')) {
        return res.status(400).json({ error: `${where} needs sizes{} or quantity > 0`, code: 'invalid_quantity' })
      }
      const q = Number(rawQ)
      if (!Number.isFinite(q) || q <= 0) return res.status(400).json({ error: `${where} needs sizes{} or quantity > 0`, code: 'invalid_quantity' })
      // Reject a fraction rather than rounding it. Math.round() was wrong in both directions:
      // 0.4 became 0 pieces and a $0 estimate, and 2.5 billed the caller for 3. Shirts do not
      // come in halves, so a fractional quantity is a caller bug worth reporting, not guessing at.
      if (!Number.isInteger(q)) return res.status(400).json({ error: `${where}.quantity must be a whole number (got ${q})`, code: 'invalid_quantity' })
      // The operand PRICE_CAP's twin was missing. 1e300 pieces at $10,000,000 overflowed round2
      // and stored a $0 estimate, with a 201.
      if (q > MAX_PIECES) return res.status(400).json({ error: `${where}.quantity must be at most ${MAX_PIECES}`, code: 'invalid_quantity' })
      sizes = { M: q }
    }
    // Reject, never coerce. An omitted unit_price used to default to 0, so a caller that forgot
    // the field got a 201 and a $0 estimate a customer could approve. That was fixed with a
    // `== null` check, which only catches null and undefined — and the values integrations
    // actually send are neither. An HTML form posts "" for an empty field; a Zapier line-item
    // mapping with nothing bound sends "" or []; a toggle sends false. All three coerced to 0 and
    // shipped a $0 quote, which is the same bug wearing different clothes.
    //
    // So require a real number, or a string that says one. A free line is still expressible —
    // pass unit_price: 0 explicitly, and that is what docs/API.md promises.
    const priceGiven = typeof it.unit_price === 'number' ||
      (typeof it.unit_price === 'string' && it.unit_price.trim() !== '')
    if (!priceGiven) return res.status(400).json({ error: `${where}.unit_price is required — pass 0 explicitly for a no-charge line`, code: 'unit_price_required' })
    const price = Number(it.unit_price)
    if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: `${where}.unit_price must be a number >= 0`, code: 'invalid_unit_price' })
    // Number.isFinite(1e308) is true, but multiplying it by a quantity is not: computeTotals
    // overflowed to Infinity, SQLite stored NULL, and the caller got a 201 for an estimate whose
    // subtotal and total were both null. Refuse a price no shop will ever charge instead.
    const PRICE_CAP = 1e7
    if (price > PRICE_CAP) return res.status(400).json({ error: `${where}.unit_price must be at most ${PRICE_CAP}`, code: 'invalid_unit_price' })
    // Same "reject, never coerce" rule as unit_price above, and it was broken the same way.
    // `it.taxable !== false` is a strict identity test against the boolean, so EVERY other way an
    // integration expresses no came out taxable: the string "false" (a form post, a spreadsheet
    // column, a Zapier text field), 0, "no", null. A resale or freight line arrived exempt and was
    // taxed anyway, on a document the customer signs — 8.75% of it, silently, with a 201.
    let taxable = true
    if (it.taxable !== undefined && it.taxable !== null) {
      if (typeof it.taxable === 'boolean') taxable = it.taxable
      else if (typeof it.taxable === 'string' && /^(true|false)$/i.test(it.taxable.trim())) taxable = it.taxable.trim().toLowerCase() === 'true'
      else return res.status(400).json({ error: `${where}.taxable must be true or false`, code: 'invalid_taxable' })
    }
    items.push({
      description: String(it.description || 'Item').slice(0, 200),
      sizes,
      unit_price: Number.isFinite(price) ? price : 0,
      decoration: String(it.decoration || '').slice(0, 80),
      taxable,
    })
  }
  const rate = taxRateFor(contact.id)
  freezeUpcharges(items).forEach((it, i) => { items[i] = it })
  const t = computeTotals(items, rate, getUpcharges())
  // Backstop: never store a total the arithmetic could not produce. A NULL subtotal on a document
  // a customer can approve is worse than a refusal.
  if (![t.subtotal, t.tax, t.total].every(Number.isFinite)) {
    return res.status(400).json({ error: 'those line items do not add up to a representable total', code: 'invalid_total' })
  }
  const id = Number(run('INSERT INTO estimates (contact_id, estimate_number, status, items, subtotal, tax, total, tax_rate, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    contact.id, nextEstimateNumber(), 'draft', JSON.stringify(items), t.subtotal, t.tax, t.total, rate, String(b.notes || '').slice(0, 2000), now()).lastInsertRowid)
  logActivity('estimate', `Estimate created via API for ${contact.name}`, { contact_id: contact.id })
  res.status(201).json(v1Estimate(get('SELECT * FROM estimates WHERE id = ?', id)))
}))

app.get('/api/v1/invoices', wrap((req, res) => {
  const limit = v1Limit(req.query); const off = v1Offset(req.query)
  const st = String(req.query.status || '').trim()
  // Effective status, same as the app's own list — an integration polling for overdue invoices
  // must not miss the ones that went overdue while nothing wrote to them.
  const today = todayIso()
  const rows = st
    ? all(`SELECT i.*, ${EFFECTIVE_STATUS_SQL} AS status FROM invoices i WHERE ${EFFECTIVE_STATUS_SQL} = ? ORDER BY i.id DESC LIMIT ? OFFSET ?`, today, today, st, limit + 1, off)
    : all(`SELECT i.*, ${EFFECTIVE_STATUS_SQL} AS status FROM invoices i ORDER BY i.id DESC LIMIT ? OFFSET ?`, today, limit + 1, off)
  v1List(res, rows.map(v1Invoice), limit)
}))
app.get('/api/v1/invoices/:id', wrap((req, res) => {
  // The stored `status` column does not know what day it is. The LIST endpoint computes the
  // effective status (EFFECTIVE_STATUS_SQL turns an unpaid invoice past its due date into
  // 'overdue'); the DETAIL endpoint returned the stale column. So one invoice reported 'overdue'
  // from /invoices, came back 'unpaid' from /invoices/:id, and appeared under ?status=overdue
  // while denying it — an integrator reconciling the two saw the API contradict itself.
  const i = get(`SELECT i.*, ${EFFECTIVE_STATUS_SQL} AS status FROM invoices i WHERE i.id = ?`, todayIso(), Number(req.params.id))
  if (!i) return res.status(404).json({ error: 'not_found' })
  res.json({ ...v1Invoice(i), payments: all('SELECT * FROM payments WHERE invoice_id = ? ORDER BY id', i.id).map(v1Payment) })
}))

app.get('/api/v1/jobs', wrap((req, res) => {
  const limit = v1Limit(req.query); const off = v1Offset(req.query)
  const stage = String(req.query.stage || '').trim()
  const rows = stage
    ? all('SELECT * FROM jobs WHERE stage = ? ORDER BY id DESC LIMIT ? OFFSET ?', stage, limit + 1, off)
    : all('SELECT * FROM jobs ORDER BY id DESC LIMIT ? OFFSET ?', limit + 1, off)
  v1List(res, rows.map(v1Job), limit)
}))
app.get('/api/v1/jobs/:id', wrap((req, res) => {
  const j = get('SELECT * FROM jobs WHERE id = ?', Number(req.params.id))
  if (!j) return res.status(404).json({ error: 'not_found' })
  res.json(v1Job(j))
}))
app.post('/api/v1/jobs/:id/stage', wrap((req, res) => {
  const j = get('SELECT * FROM jobs WHERE id = ?', Number(req.params.id))
  if (!j) return res.status(404).json({ error: 'not_found' })
  const stage = String(req.body?.stage || '')
  if (!STAGE_KEYS.includes(stage)) return res.status(400).json({ error: `stage must be one of: ${STAGE_KEYS.join(', ')}` })
  const from = j.stage
  run("UPDATE jobs SET stage = ?, status = ?, updated_at = ? WHERE id = ?", stage, stage === 'complete' ? 'complete' : 'active', now(), j.id)
  const fresh = get('SELECT * FROM jobs WHERE id = ?', j.id)
  if (from !== stage) {
    logActivity('stage', `${j.job_number} moved to ${STAGES.find((s) => s.key === stage)?.label || stage} via API`, { contact_id: j.contact_id, job_id: j.id })
    fireAuto('job.stage', { job: fresh, contact: get('SELECT * FROM contacts WHERE id = ?', j.contact_id) })
  }
  rtBroadcast('board', { job_id: j.id, stage, from, actor: 'api' })
  res.json(v1Job(fresh))
}))

app.get('/api/v1/payments', wrap((req, res) => {
  const limit = v1Limit(req.query); const off = v1Offset(req.query)
  // docs/API.md has documented `?invoice_id=` narrowing this list since the endpoint shipped, and
  // the handler ignored it — so an integration reconciling one invoice was silently handed every
  // payment in the shop and had no way to tell that its filter had not been applied.
  const raw = req.query.invoice_id
  if (raw !== undefined) {
    const invoiceId = Number(raw)
    if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
      return res.status(400).json({ error: 'invoice_id must be a positive whole number', code: 'invalid_invoice_id' })
    }
    return v1List(res, all('SELECT * FROM payments WHERE invoice_id = ? ORDER BY id DESC LIMIT ? OFFSET ?', invoiceId, limit + 1, off).map(v1Payment), limit)
  }
  v1List(res, all('SELECT * FROM payments ORDER BY id DESC LIMIT ? OFFSET ?', limit + 1, off).map(v1Payment), limit)
}))

// Webhook subscription CRUD — same handlers back both the API-key surface and the Developers UI.
const listWebhooks = () => all('SELECT id, url, events, active, created_at FROM webhook_subscriptions ORDER BY id')
const WEBHOOK_EVENTS = ['contact.created', 'estimate.sent', 'estimate.approved', 'invoice.paid', 'job.stage',
  'art.sent', 'art.approved', 'art.rejected', 'opportunity.won', 'opportunity.lost', 'conversation.received']
const MAX_WEBHOOKS = 10

/**
 * Subscribe an endpoint. Validated at SUBSCRIBE time, not just at delivery time — accepting a URL
 * we will always refuse to call (private address, bad scheme) and handing back a signing secret
 * teaches the integrator their setup works when it never will.
 */
async function createWebhook(b) {
  const bad = (msg) => { const e = new Error(msg); e.status = 400; e.expose = true; return e }
  const url = String(b?.url || '').trim()
  try { await assertPublicUrl(url) } catch (e) { throw bad(e.message) }
  // `events: []` is not the same request as omitting `events`. An empty array is truthy in JS, so
  // `[] || '*'` kept the array, String([]) made it '', and `'' || '*'` turned "subscribe to
  // nothing" into "subscribe to everything" — the endpoint that asked for no events received all
  // of them, with a 201 confirming it. Omitted still means all, as documented; explicitly empty is
  // a caller mistake worth naming.
  const rawEvents = b?.events
  let events
  if (rawEvents === undefined || rawEvents === null) events = '*'
  else if (Array.isArray(rawEvents)) {
    const list = rawEvents.map((x) => String(x).trim()).filter(Boolean)
    if (!list.length) throw bad('events must name at least one event, or "*" for all — an empty list subscribes to nothing.')
    events = list.join(',')
  } else {
    events = String(rawEvents).trim()
    if (!events) throw bad('events must name at least one event, or "*" for all — an empty list subscribes to nothing.')
  }
  if (events !== '*') {
    const unknown = events.split(',').map((x) => x.trim()).filter(Boolean).filter((e) => !WEBHOOK_EVENTS.includes(e))
    if (unknown.length) throw bad(`Unknown event(s): ${unknown.join(', ')}. Allowed: ${WEBHOOK_EVENTS.join(', ')} (or * for all).`)
  }
  if (get('SELECT COUNT(*) AS n FROM webhook_subscriptions').n >= MAX_WEBHOOKS) {
    throw bad(`A shop can have at most ${MAX_WEBHOOKS} webhook endpoints — delete one first.`)
  }
  // docs/API.md has told integrators to send their own `secret` since this endpoint shipped, and
  // it was overwritten here, unconditionally and silently: 201, a green delivery log, and every
  // signature check on the receiving end failing against the secret they had configured. Honour
  // it — but never quietly accept one too weak to sign with, because the whole point of the
  // header is that a forged delivery cannot be produced without it.
  const given = b?.secret === undefined || b?.secret === null ? '' : String(b.secret).trim()
  if (given && given.length < 24) {
    throw bad('A webhook secret needs at least 24 characters — it is what proves a delivery came from us. Omit it and one will be generated for you.')
  }
  const secret = given || `whsec_${crypto.randomBytes(24).toString('base64url')}`
  const id = Number(run('INSERT INTO webhook_subscriptions (url, events, secret, active) VALUES (?,?,?,1)', url.slice(0, 500), events.slice(0, 500), secret.slice(0, 200)).lastInsertRowid)
  // The secret is returned ONCE, at creation — store it then; we only keep it server-side for signing.
  return { id, url, events, active: 1, secret }
}
// Same authorization as the Developers UI twins. A cookie session reaches /api/v1/* with its real
// role, so without these a staff member could subscribe an endpoint of their choosing to every
// event in the shop (and read back its signing secret) simply by calling the v1 URL instead.
// API-key callers are unaffected: the gate grants them 'manager'.
app.get('/api/v1/webhooks', requireRole('manager'), wrap((_req, res) => res.json({ data: listWebhooks() })))
app.post('/api/v1/webhooks', requireRole('manager'), wrap(async (req, res) => res.status(201).json(await createWebhook(req.body))))
app.delete('/api/v1/webhooks/:id', requireRole('manager'), wrap((req, res) => {
  const r = run('DELETE FROM webhook_subscriptions WHERE id = ?', Number(req.params.id))
  if (!r.changes) return res.status(404).json({ error: 'not_found' })
  res.json({ ok: true })
}))

/* ---- Developers (cookie-auth UI side): key management + subscriptions + delivery log ---- */

app.get('/api/developers', requireRole('manager'), wrap((req, res) => {
  const key = req.tenant?.api_key || ''
  res.json({
    api_key_set: !!key,
    api_key_preview: key ? `${key.slice(0, 13)}…${key.slice(-4)}` : '',
    webhooks: listWebhooks(),
    deliveries: all(`SELECT d.id, d.event, d.status, d.attempts, d.last_error, d.created_at, s.url
                     FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id = d.subscription_id
                     ORDER BY d.id DESC LIMIT 25`),
    events: ['contact.created', 'estimate.sent', 'estimate.approved', 'invoice.paid', 'job.stage', 'art.sent', 'art.approved', 'art.rejected', 'opportunity.won', 'opportunity.lost', 'conversation.received'],
    docs: '/docs-api.html',
  })
}))
app.post('/api/developers/key/rotate', requireRole('manager'), wrap((req, res) => {
  if (!AUTH_ENABLED || !req.tenant) return res.status(400).json({ error: 'API keys need a signed-in shop (multi-tenant mode).' })
  const key = rotateApiKey(req.tenant.id)
  logActivity('note', 'API key rotated', {})
  res.json({ api_key: key }) // shown once
}))
app.post('/api/developers/key/revoke', requireRole('manager'), wrap((req, res) => {
  if (!AUTH_ENABLED || !req.tenant) return res.status(400).json({ error: 'API keys need a signed-in shop (multi-tenant mode).' })
  revokeApiKey(req.tenant.id)
  logActivity('note', 'API key revoked', {})
  res.json({ ok: true })
}))
app.post('/api/developers/webhooks', requireRole('manager'), wrap(async (req, res) => res.status(201).json(await createWebhook(req.body))))
app.patch('/api/developers/webhooks/:id', requireRole('manager'), wrap((req, res) => {
  run('UPDATE webhook_subscriptions SET active = ? WHERE id = ?', req.body?.active ? 1 : 0, Number(req.params.id))
  res.json({ ok: true })
}))
app.delete('/api/developers/webhooks/:id', requireRole('manager'), wrap((req, res) => {
  run('DELETE FROM webhook_subscriptions WHERE id = ?', Number(req.params.id))
  res.json({ ok: true })
}))

/**
 * Re-drive one webhook delivery.
 *
 * Three attempts inside about ten minutes is the entire retry budget, so an endpoint that was down
 * over a lunch hour lost every event in that window permanently: the row goes to 'failed' with
 * next_attempt_at NULL and retryDueWebhooks() only ever looks at 'retrying'/'pending' rows under
 * the attempt cap. The Developers log showed those events red, with the HTTP code, and there was
 * nothing on the screen to press — while the QuickBooks queue and the automation sequence queue
 * each already ship exactly this button.
 *
 * Replaying costs almost nothing, because the evidence is still on the row:
 * webhook_deliveries.payload holds the exact JSON body for PSC_WEBHOOK_RETENTION_DAYS. Resetting
 * the counter hands the delivery back to the durable pipeline, which owns it from there —
 * including across a restart, since it reads next_attempt_at off the row.
 */
app.post('/api/developers/deliveries/:id/redeliver', requireRole('manager'), wrap((req, res) => {
  const d = get('SELECT * FROM webhook_deliveries WHERE id = ?', Number(req.params.id))
  if (!d) return res.status(404).json({ error: 'Delivery not found', code: 'not_found' })
  const sub = get('SELECT * FROM webhook_subscriptions WHERE id = ?', d.subscription_id)
  if (!sub) return res.status(404).json({ error: 'That subscription no longer exists.', code: 'not_found' })
  if (!sub.active) return res.status(409).json({ error: 'That webhook is paused — switch it back on first.', code: 'webhook_paused' })
  run("UPDATE webhook_deliveries SET status = 'pending', attempts = 0, last_error = NULL, next_attempt_at = ? WHERE id = ?", now(), d.id)
  let payload
  try { payload = JSON.parse(d.payload) } catch { payload = { event: d.event } }
  attemptWebhookDelivery(curSlug(), { id: d.id, url: sub.url, secret: sub.secret, event: d.event, payload, attempts: 0 })
  res.json({ ok: true })
}))

/* ================= QUICKBOOKS ONLINE ================= */

const QBO_REDIRECT = (req) => `${req.protocol}://${req.get('host')}/api/qbo/callback`

/** Start the Intuit OAuth consent flow. */
app.get('/api/qbo/connect', requireRole('manager'), wrap((req, res) => {
  const s = getSettings()
  if (!s.qbo_client_id) return res.status(400).json({ error: 'Add your QuickBooks app Client ID and Secret in Settings first.' })
  const state = crypto.randomBytes(12).toString('base64url')
  setSetting('qbo_oauth_state', state)
  res.json({ url: qbo.authorizeUrl({ clientId: s.qbo_client_id, redirectUri: QBO_REDIRECT(req), state }) })
}))

/** Intuit redirects back here with an auth code + realmId. */
app.get('/api/qbo/callback', wrap(async (req, res) => {
  const s = getSettings()
  if (!req.query.state || req.query.state !== s.qbo_oauth_state) return res.status(400).send('QuickBooks connection expired — try again.')
  const r = await qbo.exchangeCode({ clientId: s.qbo_client_id, clientSecret: s.qbo_client_secret, code: String(req.query.code || ''), redirectUri: QBO_REDIRECT(req) })
  if (!r.ok) return res.status(400).send(`QuickBooks connection failed: ${esc(r.error || 'unknown')}`)
  applySettingsPatch({ qbo_realm_id: String(req.query.realmId || r.realmId || ''), qbo_access_token: r.accessToken, qbo_refresh_token: r.refreshToken, qbo_token_expires: String(r.expiresAt || '') })
  setSetting('qbo_oauth_state', '')
  logActivity('note', 'QuickBooks Online connected', {})
  res.redirect('/#/settings?qbo=connected')
}))

/* ================= GOOGLE DRIVE (art storage) ================= */

const GDRIVE_REDIRECT = (req) => `${req.protocol}://${req.get('host')}/api/gdrive/callback`

/** Is Google Drive connected for this shop? (drives the onboarding step + Settings state) */
app.get('/api/gdrive/status', wrap((_req, res) => {
  const s = getSettings()
  // Both signals, so the status card and the upload path can never disagree about whether Drive
  // is on. They did: the card read gdrive_connected and the uploader read the refresh token.
  res.json({ connected: !!(s.gdrive_refresh_token && s.gdrive_connected), configured: !!(s.gdrive_client_id && s.gdrive_client_secret) })
}))

/** Start the Google consent flow. Needs the platform Google app's client id/secret in settings. */
app.get('/api/gdrive/connect', requireRole('manager'), wrap((req, res) => {
  const s = getSettings()
  if (!s.gdrive_client_id || !s.gdrive_client_secret) return res.status(400).json({ error: 'Add your own Google Client ID and secret first (Settings or the onboarding Drive step).' })
  const state = crypto.randomBytes(16).toString('hex')
  setSetting('gdrive_oauth_state', state)
  res.json({ url: gdrive.authorizeUrl({ clientId: s.gdrive_client_id, redirectUri: GDRIVE_REDIRECT(req), state }) })
}))

/** Google redirects back with an auth code; store the refresh token + mark connected. */
app.get('/api/gdrive/callback', wrap(async (req, res) => {
  const s = getSettings()
  if (!req.query.state || req.query.state !== s.gdrive_oauth_state) return res.status(400).send('Google Drive connection expired — start again from Settings.')
  const r = await gdrive.exchangeCode({ clientId: s.gdrive_client_id, clientSecret: s.gdrive_client_secret, code: String(req.query.code || ''), redirectUri: GDRIVE_REDIRECT(req) })
  if (!r.ok) return res.status(400).send(`Google Drive connection failed: ${esc(r.error || 'unknown')}`)
  applySettingsPatch({ gdrive_access_token: r.accessToken, gdrive_refresh_token: r.refreshToken, gdrive_token_expires: String(r.expiresAt || '') })
  setSetting('gdrive_connected', '1')
  setSetting('gdrive_oauth_state', '')
  logActivity('note', 'Google Drive connected — new art will be stored there', {})
  res.redirect('/#/settings?gdrive=connected')
}))

/** Disconnect Drive (future uploads go back to local storage; existing Drive files stay in Drive). */
app.post('/api/gdrive/disconnect', requireRole('manager'), wrap((_req, res) => {
  // setSetting, NOT applySettingsPatch. The patch helper deliberately skips any SECRET_KEYS entry
  // whose new value is empty, so that saving the settings form does not wipe a stored credential
  // the form renders as blank. Both Drive tokens are SECRET_KEYS, so "Disconnect" wrote nothing:
  // it cleared the gdrive_connected flag and left the refresh token in place. The UI said
  // disconnected while the upload path — which gates on the token, not the flag — kept pushing
  // customer artwork into the Drive the shop had just revoked, and kept deleting the local copy.
  // A shop disconnects because someone left the company. That is the worst possible time to be
  // still uploading to their account.
  for (const k of ['gdrive_access_token', 'gdrive_refresh_token', 'gdrive_token_expires', 'gdrive_root_folder']) setSetting(k, '')
  setSetting('gdrive_connected', '')
  res.json({ ok: true })
}))

/** Manual "sync this invoice to QuickBooks" — inert until connected. */
/* ---- QBO sync engine + reconciliation queue ----
 * Every push is a qbo_sync row a human can SEE — status, the actual error, attempts — with
 * auto-retry and a one-click manual retry. The incumbents' syncs fail silently until the
 * bookkeeper finds the hole at reconciliation time; ours keeps receipts. Invoice + its
 * payments sync together (payment can't land without its invoice's QBO id), and QBO entity
 * ids are persisted, so a re-sync UPDATES instead of duplicating. */

const qboConnected = () => { const s = getSettings(); return !!(s.qbo_realm_id && s.qbo_refresh_token) }
/** Has this shop ever set QuickBooks up? Queue for them even while the connection is down. */
const qboConfigured = () => !!getSettings().qbo_realm_id

/**
 * Queue an invoice for QBO push (idempotent while a row is still open).
 *
 * Queues whenever the shop has EVER configured QuickBooks — not only while the token is live.
 * Dropping the row when the connection happens to be down is exactly the silent-gap failure this
 * whole queue exists to prevent: the money moves, nobody is told, and the books quietly diverge.
 * processQboQueue() no-ops while disconnected and drains once the shop reconnects.
 */
function enqueueQbo(invoiceId) {
  if (!qboConfigured() || getSettings().qbo_autosync === 'off') return
  const open = get("SELECT id FROM qbo_sync WHERE entity = 'invoice' AND entity_id = ? AND status IN ('pending','retrying','syncing')", Number(invoiceId))
  if (open) return
  run("INSERT INTO qbo_sync (entity, entity_id, status, next_attempt_at) VALUES ('invoice', ?, 'pending', ?)", Number(invoiceId), now())
}

/**
 * Push one invoice (customer → invoice → unsynced payments) to QBO.
 *
 * Serialized per invoice: the manual button, the retry button and the tick worker can all ask for
 * the same invoice at once, and every duplicate guard here (contacts.qbo_id, invoices.qbo_id,
 * payments.qbo_id) is read before a multi-second network call and written after it — a textbook
 * read-check-write race that would post the same invoice to the books twice.
 */
// This map is process-wide and every shop shares it, so the key MUST carry the tenant. Keyed on
// the invoice id alone, shop B asking for its invoice 5 was handed shop A's in-flight promise for
// a completely different invoice: B's push never happened, and B's row was then marked ok and
// stamped with A's QuickBooks id. Invoice ids start at 1 in every shop's own database, so this
// was not a rare collision — it was the common case whenever two shops synced at the same moment.
const qboInFlight = new Map()
function syncInvoiceToQbo(invoiceId) {
  const id = Number(invoiceId)
  const key = `${curSlug()}#${id}`
  const running = qboInFlight.get(key)
  if (running) return running
  const p = syncInvoiceToQboInner(id).finally(() => qboInFlight.delete(key))
  qboInFlight.set(key, p)
  return p
}

async function syncInvoiceToQboInner(invoiceId) {
  const s = getSettings()
  if (!s.qbo_realm_id || !s.qbo_refresh_token) return { ok: false, error: 'QuickBooks is not connected' }
  const contactOf = (id) => get('SELECT * FROM contacts WHERE id = ?', id)
  const out = await qbo.withRefresh({
    clientId: s.qbo_client_id, clientSecret: s.qbo_client_secret, refreshToken: s.qbo_refresh_token,
    onRefresh: (nt) => applySettingsPatch({ qbo_access_token: nt.accessToken, qbo_refresh_token: nt.refreshToken, qbo_token_expires: String(nt.expiresAt || '') }),
    // withRefresh REPLAYS this whole callback after a 401 refresh, so it must be idempotent:
    // every piece of state is re-read here rather than captured once outside.
    op: async (accessToken = s.qbo_access_token) => {
      const inv = get('SELECT * FROM invoices WHERE id = ?', Number(invoiceId))
      if (!inv) return { ok: false, error: 'Invoice not found' }
      const contact = contactOf(inv.contact_id)
      const est = inv.estimate_id ? get('SELECT items FROM estimates WHERE id = ?', inv.estimate_id) : null
      const items = est ? parse(est.items, []) : []
      const lines = items.map((it) => ({ description: it.description, amount: lineAmount(it, getUpcharges()) }))

      // Tax must not silently vanish. invoices.amount_due is subtotal + tax, but `lines` only
      // carries the subtotal components — pushing them alone books an invoice for less than the
      // payment that follows it, which is precisely the "amounts don't match for reconciliation"
      // complaint that drives shops off the incumbents.
      const lineSum = round2(lines.reduce((t, l) => t + (Number(l.amount) || 0), 0))
      const taxAmount = round2((Number(inv.amount_due) || 0) - lineSum)
      if (Math.abs(taxAmount) > 0.005) {
        lines.push({ description: 'Sales tax', amount: taxAmount, qty: 1 })
      }
      const pushSum = round2(lines.reduce((t, l) => t + (Number(l.amount) || 0), 0))
      if (Math.abs(pushSum - (Number(inv.amount_due) || 0)) > 0.005) {
        return { ok: false, error: `refusing to push: lines total ${money(pushSum)} but the invoice is ${money(inv.amount_due)} — fix the invoice, then retry` }
      }

      // Customer: reuse the persisted mapping; resolve + persist on first contact.
      let custId = contact?.qbo_id || ''
      if (!custId) {
        const cust = await qbo.ensureCustomer({ realmId: s.qbo_realm_id, accessToken, contact })
        if (!cust.ok) return cust
        custId = cust.id
        if (contact) run('UPDATE contacts SET qbo_id = ? WHERE id = ?', String(custId), contact.id)
      }
      // Invoice: create, or update in place when we already hold its QBO id + current SyncToken.
      // QBO rotates the token on every write and rejects a stale one (error 5010).
      const pushed = await qbo.pushInvoice({
        realmId: s.qbo_realm_id, accessToken, customer: custId, lines,
        invoice: inv.qbo_id ? { ...inv, qboId: inv.qbo_id, syncToken: inv.qbo_sync_token ?? '0' } : inv,
      })
      if (!pushed.ok) return pushed
      run('UPDATE invoices SET qbo_id = ?, qbo_sync_token = ? WHERE id = ?', String(pushed.id), String(pushed.syncToken ?? ''), inv.id)
      // Payments: everything recorded here that QBO hasn't seen yet.
      for (const p of all("SELECT * FROM payments WHERE invoice_id = ? AND (qbo_id IS NULL OR qbo_id = '')", inv.id)) {
        const pr = await qbo.pushPayment({ realmId: s.qbo_realm_id, accessToken, payment: p, qboInvoiceId: pushed.id, customerId: custId })
        if (!pr.ok) return { ok: false, error: `invoice synced, payment ${p.id} failed: ${pr.error || `HTTP ${pr.status || '?'}`}`, qbo_id: pushed.id }
        run('UPDATE payments SET qbo_id = ? WHERE id = ?', String(pr.id), p.id)
      }
      return { ok: true, qbo_id: pushed.id }
    },
  })
  return out.ok ? { ok: true, qbo_id: out.qbo_id || out.id } : { ok: false, error: out.error || `HTTP ${out.status || '?'}`, qbo_id: out.qbo_id }
}

/** Work the reconciliation queue: due rows, oldest first, exponential backoff, 6 tries then parked. */
async function processQboQueue(limit = 5) {
  if (!qboConnected()) return 0
  // Reclaim rows abandoned by a crash/restart mid-push before looking for new work.
  run("UPDATE qbo_sync SET status = 'retrying' WHERE status = 'syncing' AND updated_at < datetime('now', '-15 minutes')")
  const due = all("SELECT * FROM qbo_sync WHERE status IN ('pending','retrying') AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY id LIMIT ?", now(), limit)
  let done = 0
  for (const row of due) {
    // Claim the row before awaiting: two overlapping ticks (or a tick and a manual retry) would
    // otherwise both work the same invoice across a multi-second network call.
    const claim = run("UPDATE qbo_sync SET status = 'syncing', updated_at = ? WHERE id = ? AND status IN ('pending','retrying')", now(), row.id)
    if (!claim.changes) continue
    let r
    try { r = await syncInvoiceToQbo(row.entity_id) } catch (e) { r = { ok: false, error: e.message } }
    const attempts = (row.attempts || 0) + 1
    if (r.ok) {
      run("UPDATE qbo_sync SET status = 'ok', qbo_id = ?, error = NULL, attempts = ?, updated_at = ? WHERE id = ?", String(r.qbo_id || ''), attempts, now(), row.id)
      const inv = get('SELECT * FROM invoices WHERE id = ?', row.entity_id)
      if (inv) logActivity('note', `Invoice ${inv.invoice_number} synced to QuickBooks`, { contact_id: inv.contact_id })
      done++
    } else {
      const backoffMin = Math.min(5 * 2 ** attempts, 240)
      const next = new Date(Date.now() + backoffMin * 60_000).toISOString().slice(0, 19).replace('T', ' ')
      run('UPDATE qbo_sync SET status = ?, error = ?, attempts = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?',
        attempts >= 6 ? 'failed' : 'retrying', String(r.error || 'unknown').slice(0, 400), attempts, attempts >= 6 ? null : next, now(), row.id)
    }
  }
  return done
}

/** Manual "sync this invoice now" — records the attempt in the queue either way. */
app.post('/api/invoices/:id/qbo-sync', requireRole('manager'), wrap(async (req, res) => {
  if (!qboConnected()) return res.status(400).json({ error: 'Connect QuickBooks Online in Settings first.' })
  const inv = get('SELECT * FROM invoices WHERE id = ?', +req.params.id)
  if (!inv) return res.status(404).json({ error: 'Invoice not found' })
  const r = await syncInvoiceToQbo(inv.id)
  const open = get("SELECT id FROM qbo_sync WHERE entity = 'invoice' AND entity_id = ? AND status IN ('pending','retrying','failed')", inv.id)
  if (r.ok) {
    if (open) run("UPDATE qbo_sync SET status = 'ok', qbo_id = ?, error = NULL, updated_at = ? WHERE id = ?", String(r.qbo_id || ''), now(), open.id)
    else run("INSERT INTO qbo_sync (entity, entity_id, status, qbo_id, attempts) VALUES ('invoice', ?, 'ok', ?, 1)", inv.id, String(r.qbo_id || ''))
    logActivity('note', `Invoice ${inv.invoice_number} synced to QuickBooks`, { contact_id: inv.contact_id })
    return res.json({ ok: true, qbo_id: r.qbo_id })
  }
  if (open) run("UPDATE qbo_sync SET status = 'retrying', error = ?, updated_at = ? WHERE id = ?", String(r.error).slice(0, 400), now(), open.id)
  else run("INSERT INTO qbo_sync (entity, entity_id, status, error, attempts, next_attempt_at) VALUES ('invoice', ?, 'retrying', ?, 1, ?)", inv.id, String(r.error).slice(0, 400), now())
  res.status(502).json({ error: r.error || 'QuickBooks sync failed' })
}))

/** The reconciliation queue, for the UI: what's synced, what's failing, and why. */
app.get('/api/qbo/queue', requireRole('manager'), wrap((_req, res) => {
  const rows = all(`SELECT q.*, i.invoice_number, i.amount_due, i.status AS invoice_status, c.name AS contact_name
    FROM qbo_sync q LEFT JOIN invoices i ON i.id = q.entity_id LEFT JOIN contacts c ON c.id = i.contact_id
    ORDER BY CASE q.status WHEN 'failed' THEN 0 WHEN 'retrying' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END, q.updated_at DESC LIMIT 200`)
  res.json({
    connected: qboConnected(),
    autosync: getSettings().qbo_autosync !== 'off',
    counts: {
      ok: get("SELECT COUNT(*) AS n FROM qbo_sync WHERE status = 'ok'").n,
      open: get("SELECT COUNT(*) AS n FROM qbo_sync WHERE status IN ('pending','retrying','syncing')").n,
      failed: get("SELECT COUNT(*) AS n FROM qbo_sync WHERE status = 'failed'").n,
    },
    rows,
  })
}))
app.post('/api/qbo/queue/:id/retry', requireRole('manager'), wrap(async (req, res) => {
  const row = get('SELECT * FROM qbo_sync WHERE id = ?', +req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  const r = await syncInvoiceToQbo(row.entity_id)
  if (r.ok) run("UPDATE qbo_sync SET status = 'ok', qbo_id = ?, error = NULL, attempts = attempts + 1, updated_at = ? WHERE id = ?", String(r.qbo_id || ''), now(), row.id)
  else run("UPDATE qbo_sync SET status = 'retrying', error = ?, attempts = attempts + 1, updated_at = ?, next_attempt_at = ? WHERE id = ?", String(r.error).slice(0, 400), now(), new Date(Date.now() + 600_000).toISOString().slice(0, 19).replace('T', ' '), row.id)
  res.status(r.ok ? 200 : 502).json(r.ok ? { ok: true, qbo_id: r.qbo_id } : { error: r.error })
}))
app.post('/api/qbo/queue/:id/dismiss', requireRole('manager'), wrap((req, res) => {
  run("UPDATE qbo_sync SET status = 'dismissed', updated_at = ? WHERE id = ?", now(), +req.params.id)
  res.json({ ok: true })
}))

/* ================= EXPORT ================= */

/**
 * Your data, on demand, complete — including line items and size grids.
 *
 * Every incumbent in this category treats the invoice archive as the moat: exports that
 * drop line items, customers who stay only because leaving means losing their history.
 * This exists so switching away from us is never the reason to stay.
 */
// A plain negative number. NOT a formula, and the exception that makes the guard below usable:
// a leading apostrophe forces Excel and Sheets to treat the cell as TEXT, so every credit,
// discount, refund and negative adjustment was silently skipped by the bookkeeper's SUM. On a
// $300.00 document whose lines are 400.00 and -100.00, the column added up to $400.00 — always
// overstating, never flagged, in the file a shop hands to its accountant.
const CSV_NUMBER = /^-\d+(\.\d+)?([eE][-+]?\d+)?$/
const csvCell = (v) => {
  let s = v === null || v === undefined ? '' : String(v)
  // Neutralize CSV/spreadsheet formula injection: a cell starting with = + - @ (or tab/CR) is
  // treated as a formula by Excel/Sheets. Attacker-controlled fields (contact names from public
  // lead/gang-sheet forms) reach these exports, so prefix a quote to force it to a literal string.
  // `-7.75` is the one shape that is unambiguously a number rather than a formula, and it is the
  // shape money actually takes here — round2 writes plain decimals. Everything else that starts
  // with a formula character, including `-2+3+cmd|…`, still gets quoted.
  if (/^[=+\-@\t\r]/.test(s) && !CSV_NUMBER.test(s)) s = `'${s}`
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
/**
 * Each export is a CURSOR, not an array.
 *
 * These were `all(...)`, and the route then handed the whole array to a toCsv() that built the
 * entire file as one more string on top of it. Measured on a shop with five years of history:
 * payments.csv blocked the event loop for 891 ms and took RSS from 79 MB to 398 MB to produce a
 * 13 MB file — on the 512 MB box INSTALL.md documents, with every other shop on that box sharing
 * it, and node:sqlite is synchronous so the blocking is fleet-wide. The whole-shop JSON export
 * next door was converted to a cursor for exactly this reason in v1.7.0; this half was left
 * behind, and it is the half a shop reaches for first.
 *
 * line_items also did a contact lookup per estimate — an N+1 — which the JOIN removes.
 */
const EXPORTS = {
  contacts: () => iterate('SELECT * FROM contacts ORDER BY id'),
  estimates: () => iterate('SELECT * FROM estimates ORDER BY id'),
  invoices: () => iterate('SELECT * FROM invoices ORDER BY id'),
  payments: () => iterate('SELECT * FROM payments ORDER BY id'),
  jobs: () => iterate('SELECT * FROM jobs ORDER BY id'),
  activities: () => iterate('SELECT * FROM activities ORDER BY id'),
  art_versions: () => iterate('SELECT * FROM art_versions ORDER BY id'),
  // The one everyone else drops: every line of every document, flattened, with sizes.
  line_items: function* () {
    for (const e of iterate('SELECT e.*, c.name AS customer, c.company FROM estimates e LEFT JOIN contacts c ON c.id = e.contact_id ORDER BY e.id')) {
      for (const [i, it] of parse(e.items, []).entries()) {
        yield {
          estimate_number: e.estimate_number, status: e.status, created_at: e.created_at,
          customer: e.customer || '', company: e.company || '',
          line: i + 1, description: it.description || '', detail: it.detail || '',
          decoration: it.decoration || '', size_breakdown: sizeSummary(it.sizes) || '',
          qty: lineQty(it), unit_price: it.unit_price ?? 0,
          taxable: it.taxable === false ? 'no' : 'yes',
          // lineAmount, not qty x unit_price. Extended sizes carry a per-piece upcharge — 2XL +$2,
          // 3XL +$3 out of the box — and the document's stored subtotal has always included it.
          // The export did not, so the lines under a $2,325 estimate summed to $2,150 and the
          // difference was nowhere on the file: the one number a bookkeeper reconciles against.
          // The upcharge gets its own column so the two figures can be told apart.
          size_upcharge: lineUpcharge(it, getUpcharges()),
          amount: lineAmount(it, getUpcharges()),
        }
      }
    }
  },
}

app.get('/api/export/:table.csv', requireRole('manager'), wrap(async (req, res) => {
  // hasOwn, not a bare lookup: EXPORTS.constructor / __proto__ / toString are inherited and would
  // otherwise be "found" and called, 500ing on junk instead of returning a clean 404.
  const fn = Object.hasOwn(EXPORTS, req.params.table) ? EXPORTS[req.params.table] : null
  if (!fn) return res.status(404).json({ error: `Nothing to export called "${req.params.table}"` })
  res.type('text/csv').setHeader('Content-Disposition', `attachment; filename="printshopcrm-${req.params.table}.csv"`)
  // Same backpressure contract as the JSON export: yield to the event loop when the socket is
  // full, so the copy does not simply move from the heap into the socket's user-space queue.
  const write = async (chunk) => { if (!res.write(chunk)) await drainOnce(res) }
  // Every row of a `SELECT *` has the same keys, and line_items yields a fixed shape, so the
  // first row's keys are the header — the old code took the union of all of them, which is the
  // same answer and required holding all of them. An empty table sends an empty body, as before.
  let cols = null
  try {
    for (const row of fn()) {
      if (!cols) { cols = Object.keys(row); await write(cols.join(',')) }
      await write(`\n${cols.map((c) => csvCell(row[c])).join(',')}`)
    }
  } catch (e) {
    // The attachment header went out with the first row, so this cannot become a 500 — the
    // browser is already saving a file. Say so IN the file: a silently truncated export that
    // looks complete is how a shop discovers three months later that its records stop in May.
    try { res.write(`\n"EXPORT FAILED — this file is incomplete: ${String(e && e.message || e).slice(0, 200).replace(/"/g, "'")}"`) } catch { /* socket already gone */ }
    console.error(`export/${req.params.table}.csv failed after headers:`, e && e.message)
  } finally {
    res.end()
  }
}))

/** Everything, as one JSON file. No support ticket, no fee, no waiting. */
// The whole-shop export STREAMS, one row at a time. It used to load every table into memory and
// then JSON.stringify(out, null, 2) the entire graph — building a second, pretty-printed copy of
// everything at once. On a real shop (one prod tenant has 2,836 contacts; the largest table,
// activities, runs to tens of thousands of rows) that was a ~17 MB string on top of the data, and
// this app runs 14 shops in 40 MB. So the one feature whose entire job is "get all your data out,
// no lock-in" was the one most likely to OOM at the moment a shop actually needed it. Streaming
// bounds memory to a single row, and the AGPL anti-lock-in promise holds at any size.
//
// STREAM_TABLES carry a raw SQL string so they can be iterated; the derived line_items view is
// streamed from the estimates cursor with the contact name JOINed in (the old code did a contact
// lookup per estimate — an N+1). EXPORTS (used by the per-table CSV) stays as-is for small pulls.
const STREAM_TABLES = {
  contacts: 'SELECT * FROM contacts ORDER BY id',
  estimates: 'SELECT * FROM estimates ORDER BY id',
  invoices: 'SELECT * FROM invoices ORDER BY id',
  payments: 'SELECT * FROM payments ORDER BY id',
  jobs: 'SELECT * FROM jobs ORDER BY id',
  activities: 'SELECT * FROM activities ORDER BY id',
  art_versions: 'SELECT * FROM art_versions ORDER BY id',
}
/**
 * Wait for the socket to drain, so a big export costs one row of memory rather than the whole file.
 *
 * res.write() returning false means the kernel buffer is full and Node is now queueing the rest in
 * USER space. The loop below ignored that return value and never yielded, so the event loop never
 * turned and not one byte reached the wire until the last row had been generated: measured at 60k
 * activity rows, the loop ended with 14.8 MB still sitting in socket.writableLength and RSS up
 * from 45 MB to 175 MB. At 400k rows it was 99 MB queued and 440 MB RSS, and then the final flush
 * failed with writev EINVAL — the client got zero bytes and the server log said nothing at all.
 * v1.7.0 moved the copy off the heap and into the socket's write queue; it did not remove it.
 *
 * Rejects rather than hanging if the client goes away, so a cancelled download is not a wedged
 * request holding a SQLite cursor open.
 */
const drainOnce = (res) => new Promise((resolve, reject) => {
  const done = (err) => {
    res.off('drain', ok); res.off('close', gone); res.off('error', fail)
    err ? reject(err) : resolve()
  }
  const ok = () => done()
  const gone = () => done(new Error('the download was cancelled'))
  const fail = (e) => done(e)
  res.once('drain', ok); res.once('close', gone); res.once('error', fail)
})

/**
 * Tables deliberately left out of "export everything", and why. Anything NOT named here is
 * exported — so a table added later is in the export by default rather than quietly missing from
 * it, which is how this drifted to 7 of 26 in the first place.
 */
const EXPORT_SKIP = new Map([
  ['sessions', 'live login sessions — credentials, not shop data'],
  ['password_resets', 'single-use password reset tokens — credentials, not shop data'],
  ['blank_cache', 'cached supplier catalogue — refetched from the supplier, not yours'],
  ['garments', 'cached supplier catalogue — refetched from the supplier, not yours'],
])

/**
 * Credential COLUMNS inside tables that are otherwise the shop's own data.
 *
 * EXPORT_SKIP is a whole-TABLE deny-list and had no way to say this. webhook_subscriptions is
 * shop data — the shop wants its endpoints and event selections back — but `secret` is the live
 * HMAC signing key, and listWebhooks() is careful never to return it. The export was not: an
 * export file gets emailed around and dropped in Drive, which is the reason the settings branch
 * below redacts, and holding one let anyone forge a signed invoice.paid into whatever the shop
 * had wired up. The row still exports, with the secret blanked and flagged, so re-importing tells
 * the shop what it has to re-issue rather than silently handing back a key that will not verify.
 */
const EXPORT_REDACT = new Map([['webhook_subscriptions', ['secret']]])

/** Every table this shop's database actually has, minus credentials and refetchable cache. */
const exportTableNames = () => all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .map((r) => r.name).filter((n) => !EXPORT_SKIP.has(n))

app.get('/api/export/all.json', requireRole('manager'), wrap(async (_req, res) => {
  res.type('application/json').setHeader('Content-Disposition', 'attachment; filename="printshopcrm-export.json"')
  const write = async (chunk) => { if (!res.write(chunk)) await drainOnce(res) }

  const skipped = Object.fromEntries([...EXPORT_SKIP].map(([k, why]) => [k, why]))
  // Named, not silent: a shop reading this file must be able to see that a column was held back,
  // the same way it can see which tables were.
  const redacted = Object.fromEntries([...EXPORT_REDACT].map(([t, cols]) => [t, `${cols.join(', ')} — live credential, re-issue rather than restore`]))
  await write(`{\n  "exported_at": ${JSON.stringify(now())},\n  "shop": ${JSON.stringify(getSettings().shop_name)},\n  "excluded": ${JSON.stringify(skipped)},\n  "redacted": ${JSON.stringify(redacted)},\n  "tables": {\n`)

  // The export used to name seven tables from a hand-kept list while README, docs/API.md and the
  // Settings card all promised "every table" / "the whole database" / "Everything is yours,
  // complete" — and the e2e gate asserted "with every table present" against that same short list,
  // so the gap shipped green every release. The list is derived from the schema now.
  const tableNames = [...exportTableNames(), 'line_items']
  let openArray = false
  let firstTable = true
  try {
    for (const name of tableNames) {
      await write(`${firstTable ? '' : ',\n'}    ${JSON.stringify(name)}: [`)
      firstTable = false
      openArray = true
      let first = true
      const emit = async (row) => { await write(`${first ? '\n' : ',\n'}      ${JSON.stringify(row)}`); first = false }

      if (name === 'line_items') {
        // Flatten every estimate's line items, contact name joined in — no per-row lookup.
        for (const e of iterate('SELECT e.*, c.name AS customer, c.company FROM estimates e LEFT JOIN contacts c ON c.id = e.contact_id ORDER BY e.id')) {
          for (const [i, it] of parse(e.items, []).entries()) {
            await emit({
              estimate_number: e.estimate_number, status: e.status, created_at: e.created_at,
              customer: e.customer || '', company: e.company || '',
              line: i + 1, description: it.description || '', detail: it.detail || '',
              decoration: it.decoration || '', size_breakdown: sizeSummary(it.sizes) || '',
              qty: lineQty(it), unit_price: it.unit_price ?? 0,
              taxable: it.taxable === false ? 'no' : 'yes',
              size_upcharge: lineUpcharge(it, getUpcharges()),
              amount: lineAmount(it, getUpcharges()),
            })
          }
        }
      } else if (name === 'settings') {
        // The shop's own configuration is theirs and includes the price book — but the same row
        // holds every integration credential, and an export file gets emailed around and dropped
        // in Drive. Same allowlist the API redaction already uses.
        for (const row of iterate('SELECT key, value FROM settings ORDER BY key')) {
          await emit(SECRET_KEYS.includes(row.key) ? { key: row.key, value: '', redacted: true } : row)
        }
      } else {
        const redact = EXPORT_REDACT.get(name)
        for (const row of iterate(STREAM_TABLES[name] || `SELECT * FROM "${name}"`)) {
          if (redact) { for (const col of redact) if (col in row) row[col] = ''; row.redacted = true }
          await emit(row)
        }
      }
      await write(`${first ? '' : '\n    '}]`)
      openArray = false
    }
    await write('\n  },\n  "complete": true\n}\n')
  } catch (e) {
    // The status line and the attachment header went out with the first row, so this cannot be
    // turned into a 500 — the browser has already started saving a file. It CAN still be told the
    // truth. Previously the terminal handler saw headersSent and returned without res.end(), so
    // the shop was left holding a silently truncated file that looked complete, and the socket
    // hung open until the client gave up (measured: 75s, one leaked socket and SQLite cursor per
    // retry). Close the JSON, say complete:false, and name the failure.
    if (openArray) { try { res.write('\n    ]') } catch { /* socket already gone */ } }
    try {
      res.write(`\n  },\n  "complete": false,\n  "error": ${JSON.stringify(String(e && e.message || e).slice(0, 300))}\n}\n`)
    } catch { /* socket already gone */ }
    console.error('export/all.json failed after headers:', e && e.message)
  } finally {
    res.end()
  }
}))

/**
 * QuickBooks IIF export — invoices as A/R transactions and payments as deposits, ready to
 * import into QuickBooks Desktop. (QBO's two-way API sync is the connected upgrade; this file
 * export works today with no credentials, and is more reliable than Printavo's 2-hour one-way
 * push.) Tab-delimited IIF is QuickBooks' native interchange format.
 */
app.get('/api/export/quickbooks.iif', requireRole('manager'), wrap((_req, res) => {
  const d = (s) => { const x = new Date(String(s).replace(' ', 'T')); return `${x.getMonth() + 1}/${x.getDate()}/${x.getFullYear()}` }
  const money2 = (n) => (Number(n) || 0).toFixed(2)
  // IIF is tab-delimited and newline-terminated, so a tab or a newline inside ANY field ends the
  // field or the record early and everything after it is read by QuickBooks as new columns or a new
  // transaction. payments.method went in raw and is free text a STAFF account writes; the customer
  // name stripped tabs but not newlines, and a contact name is writable by an unauthenticated
  // stranger holding the shop's public embed key. Either one could splice a complete, correctly
  // delimited TRNS/SPL/ENDTRNS journal entry into the file the owner imports into their books.
  // Every field goes through this — the delimiters are what must not survive, not the characters
  // a real customer's name might legitimately contain.
  const iif = (v, max = 80) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim().slice(0, max)
  const lines = [
    '!TRNS\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO',
    '!SPL\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO',
    '!ENDTRNS',
  ]
  // A voided invoice is not a receivable and must never be posted to Accounts Receivable / Sales
  // Income. These three reports were the only balance queries in the file without the filter the
  // other nine carry, so the dashboard said $0.00 outstanding while Books, the customer's mailed
  // statement and the bookkeeper's IIF all still billed the cancelled invoice.
  for (const i of all(`SELECT i.*, c.name AS cn FROM invoices i LEFT JOIN contacts c ON c.id=i.contact_id WHERE i.status != 'void' ORDER BY i.id`)) {
    const name = iif(i.cn || 'Customer')
    const docnum = iif(i.invoice_number, 32)
    lines.push(`TRNS\tINVOICE\t${d(i.created_at)}\tAccounts Receivable\t${name}\t${money2(i.amount_due)}\t${docnum}\tPrintShopCRM`)
    lines.push(`SPL\tINVOICE\t${d(i.created_at)}\tSales Income\t${name}\t${money2(-i.amount_due)}\t${docnum}\t`)
    lines.push('ENDTRNS')
  }
  for (const p of all(`SELECT p.*, i.invoice_number, c.name AS cn FROM payments p JOIN invoices i ON i.id=p.invoice_id LEFT JOIN contacts c ON c.id=i.contact_id WHERE i.status != 'void' ORDER BY p.id`)) {
    const name = iif(p.cn || 'Customer')
    const docnum = iif(p.invoice_number, 32)
    lines.push(`TRNS\tPAYMENT\t${d(p.created_at)}\tUndeposited Funds\t${name}\t${money2(p.amount)}\t${docnum}\t${iif(p.method, 40)}`)
    lines.push(`SPL\tPAYMENT\t${d(p.created_at)}\tAccounts Receivable\t${name}\t${money2(-p.amount)}\t${docnum}\t`)
    lines.push('ENDTRNS')
  }
  res.type('text/plain').setHeader('Content-Disposition', 'attachment; filename="printshopcrm-quickbooks.iif"')
  res.send(lines.join('\n'))
}))

/* ================= SEARCH ================= */

/** One box that finds anything: customer, job number, estimate/invoice number, or title. */
app.get('/api/search', wrap((req, res) => {
  const raw = String(req.query.q || '').trim()
  if (raw.length < 1) return res.json([])
  const q = `%${raw.toLowerCase()}%`
  const out = []

  for (const c of all(`SELECT id, name, company, email FROM contacts
    WHERE lower(name) LIKE ? OR lower(COALESCE(company,'')) LIKE ? OR lower(COALESCE(email,'')) LIKE ? LIMIT 5`, q, q, q)) {
    out.push({ type: 'customer', icon: '◉', id: c.id, title: c.name, sub: c.company || c.email || '', href: `/contacts/${c.id}` })
  }
  for (const j of all(`SELECT j.id, j.job_number, j.title, j.stage, c.name AS cn FROM jobs j LEFT JOIN contacts c ON c.id=j.contact_id
    WHERE lower(j.job_number) LIKE ? OR lower(j.title) LIKE ? OR lower(COALESCE(c.name,'')) LIKE ? LIMIT 6`, q, q, q)) {
    out.push({ type: 'job', icon: '▦', id: j.id, title: j.title, sub: `${j.job_number} · ${j.cn || ''} · ${String(j.stage).replace('_', ' ')}`, href: `/jobs/${j.id}` })
  }
  for (const e of all(`SELECT e.id, e.estimate_number, e.total, e.status, c.name AS cn FROM estimates e LEFT JOIN contacts c ON c.id=e.contact_id
    WHERE lower(e.estimate_number) LIKE ? OR lower(COALESCE(c.name,'')) LIKE ? LIMIT 5`, q, q)) {
    out.push({ type: 'estimate', icon: '▤', id: e.id, title: e.estimate_number, sub: `${e.cn || ''} · ${money(e.total)} · ${e.status}`, href: `/estimates/${e.id}` })
  }
  for (const i of all(`SELECT i.id, i.invoice_number, i.amount_due, i.status, c.name AS cn FROM invoices i LEFT JOIN contacts c ON c.id=i.contact_id
    WHERE lower(i.invoice_number) LIKE ? OR lower(COALESCE(c.name,'')) LIKE ? LIMIT 5`, q, q)) {
    out.push({ type: 'invoice', icon: '▣', id: i.id, title: i.invoice_number, sub: `${i.cn || ''} · ${money(i.amount_due)} · ${i.status}`, href: `/invoices/${i.id}` })
  }
  for (const o of all(`SELECT o.id, o.title, o.value, o.stage, c.name AS cn FROM opportunities o LEFT JOIN contacts c ON c.id=o.contact_id
    WHERE lower(o.title) LIKE ? OR lower(COALESCE(c.name,'')) LIKE ? LIMIT 4`, q, q)) {
    out.push({ type: 'deal', icon: '◱', id: o.id, title: o.title, sub: `${o.cn || ''} · ${money(o.value)} · ${o.stage}`, href: `/pipeline` })
  }
  res.json(out)
}))

/* ================= ACTIVITY / OUTBOX / SETTINGS ================= */

app.get('/api/activities', wrap((_req, res) => {
  res.json(all(`SELECT a.*, c.name AS contact_name, j.job_number FROM activities a
    LEFT JOIN contacts c ON c.id=a.contact_id LEFT JOIN jobs j ON j.id=a.job_id
    ORDER BY a.created_at DESC, a.id DESC LIMIT 100`))
}))

app.get('/api/outbox', wrap((_req, res) => {
  res.json(all('SELECT * FROM email_log ORDER BY id DESC LIMIT 50'))
}))

/**
 * Send — or re-send — one message from the Outbox. The missing half of it.
 *
 * Two ordinary states put a row here that nothing in the product could ever move on:
 *
 *   'draft'  Settings → Automation Modes → Follow-ups set to Manual. The card promises the system
 *            "drafts and waits for a person" and queueEmail's own comment says the message will
 *            "land in the outbox as drafts for a person to send". The person had no button, on any
 *            screen, so every drafted nudge sat there forever and Manual mode sent nothing, ever.
 *            The Outbox even rendered it as "logged" — the label for "no email is connected" —
 *            so a shop in Manual mode was told nothing was expected of them.
 *
 *   'error'  the send was attempted and the mail server refused it: wrong password, expired API
 *            token, greylisted. The estimate says "sent", the customer never got it, and the only
 *            way to try again was to re-send the estimate itself, which re-stamps sent_at and
 *            re-fires every estimate.sent automation behind it.
 *
 * The QuickBooks queue and the automation sequence queue each already ship exactly this button.
 */
app.post('/api/outbox/:id/send', wrap(async (req, res) => {
  const row = get('SELECT * FROM email_log WHERE id = ?', +req.params.id)
  if (!row) return res.status(404).json({ error: 'Message not found', code: 'not_found' })
  if (row.delivered) return res.status(409).json({ error: 'That message has already gone out.', code: 'already_sent' })
  const c = row.contact_id ? get('SELECT email, phone FROM contacts WHERE id = ?', row.contact_id) : null
  const to = String(row.to_email || '').trim() || String((row.kind === 'sms' ? c?.phone : c?.email) || '').trim()
  if (!to) return res.status(400).json({ error: 'No address on file for this message — add one to the customer first.', code: 'no_recipient' })
  const s = getSettings()
  const r = row.kind === 'sms'
    ? await sendSms({ to, body: row.body, settings: s })
    : await sendEmail({ to, subject: row.subject, body: row.body, settings: s })
  run('UPDATE email_log SET to_email = ?, delivered = ?, via = ?, delivery_error = ? WHERE id = ?',
    to, r.delivered ? 1 : 0, r.via || 'logged', r.error || null, row.id)
  // The mail has already gone out by this point, and email_log already says so. A throw here — a
  // dangling contact_id, a disk hiccup — used to become a 500 on a send that actually succeeded,
  // which reads to the shop as "it failed", and the retry then answers "already gone out". Record
  // the timeline line if we can, and never let the bookkeeping contradict the delivery.
  try {
    logActivity('note', `Outbox: "${row.subject}" ${r.delivered ? 'sent to' : 'could NOT be sent to'} ${to}${r.error ? ` — ${String(r.error).slice(0, 140)}` : ''}`, { contact_id: row.contact_id })
  } catch (e) { console.error('outbox log:', e?.message || e) }
  if (!r.delivered) {
    return res.status(502).json({
      ok: false,
      code: 'not_delivered',
      error: r.error || 'No email connection yet — add your SMTP details under Settings → Message Delivery and try again.',
      via: r.via || 'logged',
    })
  }
  res.json({ ok: true, via: r.via, to })
}))

app.get('/api/settings', wrap((req, res) => {
  // publicSettings() redacts every secret (API keys, tokens, passwords) to a `<key>_set` flag —
  // secrets are never sent to the browser. Staff (the sign-in accounts) come from the members table.
  // Only owners/managers see the staff roster (names/emails/roles); plain staff get an empty list.
  const members = AUTH_ENABLED && req.tenant && hasRole(req, 'manager') ? listMembers(req.tenant.id) : []
  res.json({ settings: publicSettings(), members, role: req.role || 'owner', single_tenant: !AUTH_ENABLED })
}))

/* ---- Slack self-setup (authed) ---- */

/**
 * Everything a shop needs to connect Slack themselves, in one payload.
 *
 * The manifest is the important part: Slack can create an app from a pasted manifest, so instead
 * of walking an owner through scopes, event subscriptions and two request URLs by hand, we hand
 * them a blob that already contains their own URLs and the exact scopes required. Paste, install,
 * copy two values back. That is the whole setup.
 */
app.get('/api/slack-setup', requireRole('manager'), wrap((req, res) => {
  const s = getSettings()
  const key = req.tenant?.embed_key || getSettings().embed_key || ''
  if (!key) return res.json({ unavailable: true, reason: 'Slack setup needs a hosted shop account — it is not available in single-tenant mode.' })
  const origin = publicOrigin(req)
  const events = `${origin}/api/slack/${key}/events`
  const command = `${origin}/api/slack/${key}/command`
  const shop = String(s.shop_name || 'Print Shop').slice(0, 30)
  const manifest = {
    display_information: { name: `${shop} Quotes`.slice(0, 35), description: 'Paste a customer request, get a draft estimate back.', background_color: '#101418' },
    features: {
      bot_user: { display_name: `${shop} Quotes`.slice(0, 35), always_online: true },
      slash_commands: [{ command: '/quote', url: command, description: 'Draft an estimate from a pasted customer request', usage_hint: '40 navy tees, 2 colour front, by Sept 8', should_escape: false }],
    },
    oauth_config: { scopes: { bot: ['app_mentions:read', 'chat:write', 'commands', 'im:history', 'im:read', 'im:write'] } },
    settings: {
      event_subscriptions: { request_url: events, bot_events: ['app_mention', 'message.im'] },
      interactivity: { is_enabled: false },
      org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false,
    },
  }
  res.json({
    connected: slackConfigured(s),
    events_url: events, command_url: command,
    manifest: JSON.stringify(manifest, null, 2),
    has_token: !!String(s.slack_bot_token || '').trim(),
    has_secret: !!String(s.slack_signing_secret || '').trim(),
  })
}))

/** Slack's API error codes are enums; a shop owner needs to know which box to go re-copy. */
const SLACK_ERRORS = {
  invalid_auth: "Slack didn't accept that token. Make sure you copied the Bot User OAuth Token that starts with \u201Cxoxb-\u201D from OAuth & Permissions \u2014 not the App-Level token (xapp-) or the Client Secret.",
  not_authed: 'No token reached us. Paste your Bot User OAuth Token above, save, then test again.',
  account_inactive: 'This Slack app was uninstalled from your workspace. Reinstall it from OAuth & Permissions \u2192 Install to Workspace, then paste the new token here.',
  token_revoked: 'This token was revoked in Slack. Reinstall the app and copy the new Bot User OAuth Token.',
  missing_scope: "This token is missing a permission the bot needs. Reinstall the app from the setup file above \u2014 it grants exactly the right scopes.",
}
const slackError = (code) => SLACK_ERRORS[code] || `Slack rejected the connection (${code || 'unknown error'}). Re-copy both values and try again.`

/**
 * Prove the connection end to end before the shop trusts it.
 *
 * Two halves have to work and they fail independently: the BOT TOKEN lets us post, and the SIGNING
 * SECRET lets Slack reach us. Checking only the token (auth.test) is what an obvious implementation
 * does, and it reports a confident green tick on a shop whose secret is wrong — every real event
 * then 401s forever and the owner has no reason to look here again. So we also sign a synthetic
 * handshake with the stored secret and post it to this shop's own events URL: if the secret is
 * wrong, our own endpoint rejects it and we say so specifically.
 */
app.post('/api/slack-test', requireRole('manager'), wrap(async (req, res) => {
  const s = getSettings()
  const token = String(req.body?.token || '').trim() || String(s.slack_bot_token || '').trim()
  const secret = String(s.slack_signing_secret || '').trim()
  if (!token) return res.status(400).json({ ok: false, error: 'Paste your Bot User OAuth Token above and save first.' })

  const auth = await slackTestAuth(token)
  if (!auth.ok) return res.json({ ok: false, error: slackError(auth.error) })

  if (!secret) {
    return res.json({ ok: false, half: 'token', team: auth.team, bot: auth.bot,
      error: `Token works \u2014 connected to ${auth.team}. Now add your Signing Secret (Basic Information \u2192 App Credentials \u2192 Show) so Slack can reach your shop.` })
  }

  // Round-trip a signed handshake through our own public URL, exactly as Slack would.
  let reachable = false, why = ''
  try {
    const origin = `${req.protocol}://${req.get('host')}`
    const url = `${origin}/api/slack/${req.tenant?.embed_key || s.embed_key}/events`
    const payload = JSON.stringify({ type: 'url_verification', challenge: `psc-${Date.now()}` })
    const ts = Math.floor(Date.now() / 1000).toString()
    const sig = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${payload}`).digest('hex')
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': sig }, body: payload, signal: AbortSignal.timeout(8000) })
    const text = await r.text()
    reachable = r.status === 200 && text === JSON.parse(payload).challenge
    if (!reachable) why = r.status === 401 ? 'signature' : `http_${r.status}`
  } catch (e) { why = 'unreachable'; console.error('slack self-test:', e.message) }

  if (reachable) return res.json({ ok: true, team: auth.team, bot: auth.bot })
  if (why === 'signature') {
    return res.json({ ok: false, half: 'secret', team: auth.team, bot: auth.bot,
      error: `Token works \u2014 connected to ${auth.team} \u2014 but the Signing Secret doesn't match, so Slack can't reach your shop. Re-copy it from Basic Information \u2192 App Credentials \u2192 Signing Secret \u2192 Show.` })
  }
  return res.json({ ok: false, half: 'reach', team: auth.team, bot: auth.bot,
    error: `Token works \u2014 connected to ${auth.team} \u2014 but we couldn't reach this shop's own web address to complete the check. If this shop isn't on a public https:// address yet, Slack won't be able to reach it either.` })
}))

app.put('/api/settings', requireRole('manager'), wrap((req, res) => {
  // applySettingsPatch preserves a stored secret when its field comes back empty (unchanged),
  // and erases it for the one sentinel value that means erase — see CLEAR_SECRET.
  applySettingsPatch(req.body || {})
  res.json(publicSettings())
}))

/**
 * Disconnect an integration — the exit every one of them was missing.
 *
 * Google Drive was the only integration in the product with a way out. Everything else was
 * write-only: a secret field renders blank, blanking it is a deliberate no-op, and there was no
 * route that removed one. So a shop that pasted the wrong Stripe key, or whose Slack admin,
 * bookkeeper or office manager just left with the credentials in their head, could not take that
 * connection out of the product from any screen. The answer was sqlite3, which is the definition
 * of a state a human cannot fix.
 *
 * Grouped, so the UI names an integration rather than having to know which six keys make up a
 * QuickBooks connection. setSetting, NOT applySettingsPatch — see the note at /api/gdrive/disconnect.
 */
const DISCONNECT_GROUPS = {
  slack: ['slack_bot_token', 'slack_signing_secret'],
  stripe: ['stripe_secret', 'stripe_publishable'],
  twilio: ['twilio_sid', 'twilio_token', 'twilio_from'],
  smtp: ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from', 'smtp_secure'],
  ai: ['ai_api_key'],
  quickbooks: ['qbo_realm_id', 'qbo_client_id', 'qbo_client_secret', 'qbo_access_token', 'qbo_refresh_token', 'qbo_token_expires', 'qbo_oauth_state'],
  ss: ['ss_account', 'ss_api_key'],
  sanmar: ['sanmar_user', 'sanmar_pass', 'sanmar_cust'],
  alpha: ['alpha_account', 'alpha_pass'],
}
app.post('/api/settings/disconnect/:group', requireRole('manager'), wrap((req, res) => {
  const group = String(req.params.group)
  const keys = DISCONNECT_GROUPS[Object.hasOwn(DISCONNECT_GROUPS, group) ? group : '']
  if (!keys) return res.status(404).json({ error: 'No such integration', code: 'unknown_group' })
  for (const k of keys) setSetting(k, '')
  // On the shop's own timeline, because removing a credential is the kind of thing someone asks
  // about a week later — and in a shop with staff it needs to be traceable to a person.
  logActivity('note', `${group} disconnected — its credentials were removed`, {})
  res.json({ ok: true, cleared: keys, settings: publicSettings() })
}))

/**
 * Upload the shop's logo. Goes on every customer-facing document (estimates, invoices, receipts,
 * proofs). Images only — an arbitrary upload rendered in an <img> on our own origin is a delivery
 * vector, and while /uploads already ships a sandboxing CSP, the type check keeps junk out entirely.
 */
const LOGO_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'])
app.post('/api/settings/logo', requireRole('manager'), upload.single('file'), reTenant, wrap((req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose an image file' })
  if (!LOGO_MIME.has(req.file.mimetype)) {
    try { unlinkSync(join(UPLOADS, req.file.filename)) } catch { /* best effort */ }
    return res.status(400).json({ error: 'That needs to be an image (PNG, JPG, WEBP, GIF or SVG).' })
  }
  setSetting('shop_logo', req.file.filename)
  res.json({ ok: true, shop_logo: req.file.filename })
}))

/** Remove the logo (the file itself stays — other documents may already reference it). */
app.delete('/api/settings/logo', requireRole('manager'), wrap((_req, res) => {
  setSetting('shop_logo', '')
  res.json({ ok: true })
}))

/* ---- AI: bring-your-own provider + key (usage bills to the shop, never the platform) ---- */

// Returns config only — never probes the model, so Settings renders instantly even when a live
// model check would take seconds. The card verifies on demand via /api/ai/test.
app.get('/api/ai/providers', wrap((_req, res) => {
  const s = getSettings()
  res.json({
    providers: AI_PROVIDERS, defaults: DEFAULT_MODELS,
    current: { provider: s.ai_provider || '', model: s.ai_model || '', key_set: !!String(s.ai_api_key || '').trim() },
  })
}))

/** Probe a provider + key WITHOUT saving — so a bad key never gets stored. */
app.post('/api/ai/test', requireRole('manager'), wrap(async (req, res) => {
  const b = req.body || {}
  const key = String(b.api_key || '').trim() || (b.use_saved ? String(getSettings().ai_api_key || '') : '')
  res.json(await testAi({ provider: String(b.provider || ''), key, model: String(b.model || '') }))
}))

/* ---- staff members: real logins with Owner / Manager / Staff roles ---- */

const staffGuard = (req, res) => {
  if (!AUTH_ENABLED || !req.tenant) { res.status(400).json({ error: 'Staff logins require multi-tenant mode (PSC_AUTH=1).' }); return false }
  if (!hasRole(req, 'manager')) { res.status(403).json({ error: 'Only owners and managers can manage staff.', code: 'forbidden' }); return false }
  return true
}
// Only an owner may create, change, or remove another owner — managers can't touch owner accounts.
const touchesOwner = (req, targetRole, existing) =>
  (targetRole === 'owner' || existing?.role === 'owner') && !hasRole(req, 'owner')

app.get('/api/members', wrap((req, res) => {
  if (!staffGuard(req, res)) return
  res.json({ members: listMembers(req.tenant.id) })
}))

app.post('/api/members', wrap(async (req, res) => {
  if (!staffGuard(req, res)) return
  const b = req.body || {}
  const role = ROLES.includes(b.role) ? b.role : 'staff'
  if (touchesOwner(req, role)) return res.status(403).json({ error: 'Only an owner can add another owner.' })
  try {
    const member = await addMember(req.tenant.id, { name: b.name, email: b.email, password: b.password, role })
    // Fire-and-forget: hand the new member their own login. Uses the plaintext temp password the owner
    // just set (addMember only returns the hashed record), so send it before the response, not after.
    sendStaffInviteEmail({ tenant: req.tenant, member, tempPassword: b.password, inviterName: req.member?.name, origin: publicOrigin(req) })
    res.json(member)
  } catch (e) { res.status(e.code === 'dupe_email' ? 409 : 400).json({ error: e.message }) }
}))

app.patch('/api/members/:id', wrap((req, res) => {
  if (!staffGuard(req, res)) return
  const b = req.body || {}
  const existing = getMemberById(+req.params.id)
  if (!existing || existing.tenant_id !== req.tenant.id) return res.status(404).json({ error: 'No such member' })
  if (touchesOwner(req, b.role, existing)) return res.status(403).json({ error: 'Only an owner can change an owner account.' })
  try {
    res.json(updateMember(req.tenant.id, +req.params.id, { role: b.role, name: b.name, status: b.status }))
  } catch (e) { res.status(e.code === 'last_owner' ? 409 : 400).json({ error: e.message }) }
}))

app.delete('/api/members/:id', wrap((req, res) => {
  if (!staffGuard(req, res)) return
  const existing = getMemberById(+req.params.id)
  if (!existing || existing.tenant_id !== req.tenant.id) return res.status(404).json({ error: 'No such member' })
  if (existing.role === 'owner' && !hasRole(req, 'owner')) return res.status(403).json({ error: 'Only an owner can remove an owner.' })
  if (req.member && existing.id === req.member.id) return res.status(400).json({ error: "You can't remove your own account." })
  try {
    deleteMember(req.tenant.id, +req.params.id)
    res.json({ ok: true })
  } catch (e) { res.status(e.code === 'last_owner' ? 409 : 400).json({ error: e.message }) }
}))

/* ================= EMBEDDABLE GANG SHEET (shop's site + shop's Stripe) =================
 * These run on the SHOP's website, with no login. The shop's iframe carries its embed key
 * (?shop=KEY); we resolve it to that shop and run the request inside their isolated database,
 * so the order, the customer, and the Stripe account are all the right shop's. */
const embedTenant = (req) => {
  const key = req.query.shop || (req.body && req.body.shop) || req.query.s
  return key ? getTenantByEmbedKey(String(key)) : null
}
async function embedRun(req, res, fn) {
  try {
    if (!AUTH_ENABLED) return await fn()          // single-tenant dev → default db
    // A suspended shop is closed to its customers too, not only to its own staff. 404, not 403:
    // the answer must not tell a scraper which shops exist or what state they are in.
    const t = embedTenant(req)
    if (!tenantOpen(t)) return res.status(404).json({ error: 'Unknown shop' })
    return await withTenant(t.slug, fn)
  } catch (e) { console.error('embed:', e); if (!res.headersSent) res.status(500).json({ error: 'Something went wrong.' }) }
}

/** Public config the embedded builder needs — branding + DTF pricing + whether Stripe is on.
 *  The secret key is NEVER sent; only whether checkout is available. */
app.get('/api/embed/config', (req, res) => embedRun(req, res, () => {
  const s = getSettings()
  res.json({
    shop: s.shop_name, tagline: s.shop_tagline,
    dtf: { sheetWidth: Number(s.dtf_sheet_width) || 22, pricePerInch: Number(s.dtf_price_per_inch) || 0.95, minCharge: Number(s.dtf_min_charge) || 10 },
    checkout: paymentsReady(s) ? 'stripe' : 'quote',
  })
}))

/**
 * A customer submitted a gang sheet from the shop's website. Verify the price server-side
 * (never trust the client), create the customer + estimate in this shop's account, and either
 * start a Stripe Checkout on the SHOP's account or record it as a quote for the shop to follow up.
 */
app.post('/api/embed/gangsheet/order', embedLimit(20, 'Too many orders from this connection. Try again shortly.'), (req, res) => embedRun(req, res, async () => {
    const b = req.body || {}
    const items = Array.isArray(b.items) ? b.items : []
    if (!items.length) return res.status(400).json({ error: 'Add at least one design' })
    // This is a PUBLIC, unauthenticated endpoint that creates a contact and a sent estimate and
    // fires the estimate.sent automations, so it needs bounds on both volume and geometry. The
    // nester caps quantity and width, but height was unbounded: a design 1e15 inches tall priced
    // the sheet in the quadrillions and stored it as a real estimate. No DTF design is taller than
    // a few feet; refuse anything outside a sane envelope rather than nesting it.
    if (items.length > 100) return res.status(400).json({ error: 'That is more designs than a single sheet holds.' })
    const MAX_IN = 120 // 10 feet — comfortably past any real transfer, far short of an overflow
    for (const it of items) {
      const w = Number(it?.w), h = Number(it?.h), qty = Number(it?.qty)
      if (!(w > 0 && w <= MAX_IN) || !(h > 0 && h <= MAX_IN)) {
        return res.status(400).json({ error: 'A design size looks off — width and height must be between 0 and 120 inches.' })
      }
      if (!(qty >= 1 && qty <= 5000)) return res.status(400).json({ error: 'A design quantity looks off — it must be between 1 and 5000.' })
    }
    const s = getSettings()
    const { usedHeight } = nest(items, { sheetWidth: Number(s.dtf_sheet_width) || 22 })
    const price = priceSheet(usedHeight, { pricePerInch: Number(s.dtf_price_per_inch) || 0.95, minCharge: Number(s.dtf_min_charge) || 10 })
    const name = String(b.name || '').trim() || 'Website order'
    const email = String(b.email || '').trim()

    // Find or create the customer in this shop's CRM.
    let contact = email ? get('SELECT * FROM contacts WHERE lower(email)=lower(?)', email) : null
    // A stranger on the public builder may be LINKED to an existing customer and may NOT write on
    // one — the rule lib/agent.mjs enforces for the chat widget, which this twin never got. Both
    // are unauthenticated and both are reached with nothing but the shop's embed key, which ships
    // inside the snippet the shop pastes on its own website. So anyone who scrapes that key and
    // knows one customer's address could burn a real estimate number onto that account, mark it
    // sent, put its value in the shop's forecast, and fire the shop's estimate.sent automations —
    // which means the customer receives email from their printer about an order they never placed.
    // A brand-new visitor is their own record, and that path is unchanged.
    const unverified = !!contact
    if (!contact) {
      const id = Number(run('INSERT INTO contacts (name, email, tags, created_at, updated_at) VALUES (?,?,?,?,?)', name, email, 'website,gang-sheet', now(), now()).lastInsertRowid)
      contact = get('SELECT * FROM contacts WHERE id = ?', id)
    }
    const desc = `DTF gang sheet — ${items.reduce((n, i) => n + (Number(i.qty) || 0), 0)} design${items.length === 1 ? '' : 's'}, ${Math.ceil(usedHeight)}" of ${s.dtf_sheet_width}" roll`
    // The public builder prices the sheet client-side from /api/embed/config, which carries no tax
    // rate — so the button on the shop's own website says $11.40 while adding tax here charged the
    // card $12.28. The quoted sheet price is what gets charged; tax stays out of the embed flow.
    const estItems = freezeUpcharges([{ description: desc, detail: `Built on ${s.shop_name}'s website`, decoration: 'DTF Transfer', qty: 1, unit_price: price.subtotal, taxable: false }])
    const t = computeTotals(estItems, s.tax_rate, getUpcharges())
    const num = nextEstimateNumber()
    const estId = Number(run('INSERT INTO estimates (contact_id, estimate_number, status, items, subtotal, tax, total, notes, sent_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      contact.id, num, unverified ? 'draft' : 'sent', JSON.stringify(estItems), t.subtotal, t.tax, t.total,
      unverified
        ? '⚠ UNVERIFIED — a website visitor gave this customer’s email address; nobody has confirmed they are them. Gang sheet from the website'
        : 'Gang sheet from the website',
      unverified ? null : now(), now()).lastInsertRowid)
    logActivity('estimate', `Gang-sheet order ${num} from the website${unverified ? ' — UNVERIFIED, the visitor supplied only this customer’s email' : ''} — ${money(t.total)}`, { contact_id: contact.id })
    // 'created' is what an ordinary DRAFT quote does (see POST /api/estimates), which lands the
    // deal in 'quoted' rather than the 'sent' column the shop's forecast is read from.
    syncPipeline(get('SELECT * FROM estimates WHERE id = ?', estId), unverified ? 'created' : 'sent')
    if (!unverified) fireAuto('estimate.sent', { estimate: get('SELECT * FROM estimates WHERE id = ?', estId), contact, total: t.total })

    if (paymentsReady(s)) {
      const origin = `${req.protocol}://${req.get('host')}`
      const shopQ = req.query.shop ? `&shop=${encodeURIComponent(req.query.shop)}` : ''
      const co = await startCheckout(s, {
        customerEmail: email,
        lineItems: [{ name: `DTF Gang Sheet (${Math.ceil(usedHeight)}" × ${s.dtf_sheet_width}")`, amountCents: Math.round(t.total * 100), qty: 1 }],
        successUrl: `${origin}/embed/gangsheet?paid=1${shopQ}`, cancelUrl: `${origin}/embed/gangsheet?canceled=1${shopQ}`,
        metadata: { estimate: num, shop: s.shop_name },
      })
      return res.json({ mode: 'stripe', checkout_url: co.url, estimate: num, total: t.total })
    }
    // No Stripe connected — it's a quote the shop follows up on.
    res.json({ mode: 'quote', estimate: num, total: t.total, price })
}))

/** The embeddable page itself — chrome-less, drops into an iframe on the shop's website. */
app.get('/embed/gangsheet', (_req, res) => {
  res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1"><title>DTF Gang Sheet Builder</title>
    <link rel="stylesheet" href="/css/embed.css"></head>
    <body><div id="gs-root"></div><script type="module" src="/embed/gangsheet.js"></script></body></html>`)
})

/* ================= AI RECEPTIONIST — public chat widget (shop's website) ================= */

/**
 * The self-contained widget. A shop pastes:
 *   <script src="https://app.example.com/embed/chat.js?shop=THEIR_KEY" defer></script>
 * and gets a floating chat bubble powered by their configured bot, isolated in a shadow root
 * so it can't collide with their site's CSS. Everything it needs it reads off its own <script>.
 */
const CHAT_WIDGET_JS = String.raw`(function(){
  var me = document.currentScript || (function(){var s=document.getElementsByTagName('script');return s[s.length-1]})();
  if(!me) return;
  var src = new URL(me.src, location.href);
  var ORIGIN = src.origin;
  var KEY = src.searchParams.get('shop') || me.getAttribute('data-shop') || '';
  if(!KEY) { console.warn('[PrintShopCRM chat] missing shop key'); return; }
  var session=null, accent='#10d39a', botName='Assistant', busy=false, started=false;

  var host=document.createElement('div');
  host.setAttribute('id','psc-chat-widget');
  document.body.appendChild(host);
  var root=host.attachShadow({mode:'open'});

  function css(){ return '\
    :host{all:initial} *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif}\
    .bubble{position:fixed;bottom:20px;right:20px;width:60px;height:60px;border-radius:50%;background:'+accent+';color:#04140f;\
      display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 8px 30px rgba(0,0,0,.25);z-index:2147483000;\
      transition:transform .15s ease;border:none}\
    .bubble:hover{transform:scale(1.06)} .bubble svg{width:28px;height:28px}\
    .panel{position:fixed;bottom:92px;right:20px;width:370px;max-width:calc(100vw - 32px);height:560px;max-height:calc(100vh - 120px);\
      background:#0f1512;border:1px solid #223028;border-radius:16px;display:none;flex-direction:column;overflow:hidden;z-index:2147483000;\
      box-shadow:0 24px 70px rgba(0,0,0,.45)}\
    .panel.open{display:flex}\
    .hd{padding:16px 18px;background:linear-gradient(135deg,'+accent+'22,transparent);border-bottom:1px solid #223028;display:flex;align-items:center;gap:10px}\
    .hd .av{width:34px;height:34px;border-radius:50%;background:'+accent+';color:#04140f;font-weight:700;display:flex;align-items:center;justify-content:center}\
    .hd .nm{color:#eaf5ef;font-weight:600;font-size:15px} .hd .st{color:#7fd4b6;font-size:12px}\
    .hd .x{margin-left:auto;background:none;border:none;color:#6b7f74;font-size:20px;cursor:pointer;line-height:1}\
    .body{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;background:#0b0f0d}\
    .msg{max-width:82%;padding:10px 13px;border-radius:14px;font-size:14px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word}\
    .bot{background:#1a241e;color:#e7f2eb;align-self:flex-start;border-bottom-left-radius:4px}\
    .me{background:'+accent+';color:#04140f;align-self:flex-end;border-bottom-right-radius:4px;font-weight:500}\
    .typing{align-self:flex-start;color:#6b7f74;font-size:13px;padding:4px 6px}\
    .quick{display:flex;flex-wrap:wrap;gap:6px;padding:0 16px 8px}\
    .chip{background:#16201b;border:1px solid #2a3a31;color:#bfe6d5;border-radius:20px;padding:7px 12px;font-size:12.5px;cursor:pointer}\
    .chip:hover{border-color:'+accent+'}\
    .ft{border-top:1px solid #223028;padding:10px;display:flex;gap:8px;background:#0f1512}\
    .ft input{flex:1;background:#0b0f0d;border:1px solid #2a3a31;border-radius:10px;color:#eaf5ef;padding:11px 13px;font-size:14px;outline:none}\
    .ft input:focus{border-color:'+accent+'} .ft button{background:'+accent+';border:none;border-radius:10px;color:#04140f;font-weight:700;padding:0 16px;cursor:pointer}\
    .powered{text-align:center;font-size:10.5px;color:#4a5a51;padding:6px}\
    .powered a{color:#5b7d6f;text-decoration:none}';
  }
  function icon(){return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'}

  root.innerHTML='<style>'+css()+'</style>'+
    '<button class="bubble" id="b">'+icon()+'</button>'+
    '<div class="panel" id="p"><div class="hd"><div class="av" id="av">A</div>'+
      '<div><div class="nm" id="nm">Assistant</div><div class="st">Typically replies instantly</div></div>'+
      '<button class="x" id="x">&times;</button></div>'+
      '<div class="body" id="body"></div><div class="quick" id="quick"></div>'+
      '<div class="ft"><input id="in" placeholder="Type a message..." autocomplete="off"><button id="send">Send</button></div>'+
      '<div class="powered">Powered by <a href="https://printshopcrm.com" target="_blank" rel="noopener">PrintShopCRM</a></div></div>';

  var $=function(id){return root.getElementById(id)};
  function api(path,body){return fetch(ORIGIN+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({shop:KEY},body||{}))}).then(function(r){return r.json()})}
  function add(text,who){var d=document.createElement('div');d.className='msg '+(who==='me'?'me':'bot');d.textContent=text;$('body').appendChild(d);$('body').scrollTop=$('body').scrollHeight;return d}
  function typing(on){var t=root.getElementById('typing');if(on){if(!t){t=document.createElement('div');t.className='typing';t.id='typing';t.textContent=botName+' is typing…';$('body').appendChild(t);$('body').scrollTop=$('body').scrollHeight}}else if(t){t.remove()}}
  function chips(list){var q=$('quick');q.innerHTML='';(list||[]).forEach(function(c){var b=document.createElement('button');b.className='chip';b.textContent=c;b.onclick=function(){sendMsg(c)};q.appendChild(b)})}

  function open(){$('p').classList.add('open');if(!started){started=true;boot()};setTimeout(function(){$('in').focus()},50)}
  function close(){$('p').classList.remove('open')}
  $('b').onclick=function(){$('p').classList.contains('open')?close():open()};$('x').onclick=close;

  function boot(){
    api('/api/embed/chat/start',{page_url:location.href}).then(function(d){
      if(d&&d.enabled===false){add('Chat is currently offline. Please email us and we will get right back to you.','bot');return}
      if(!d||!d.session){add('Sorry, chat is unavailable right now.','bot');return}
      session=d.session; accent=d.accent||accent; botName=d.name||'Assistant';
      $('av').textContent=(botName[0]||'A').toUpperCase(); $('nm').textContent=botName;
      root.querySelector('style').textContent=css();
      add(d.greeting||('Hi! I am '+botName+'. How can I help?'),'bot');
      chips(['Get a quote','What is your minimum?','How fast can you turn it around?']);
    }).catch(function(){add('Sorry, chat is unavailable right now.','bot')});
  }
  function sendMsg(text){
    text=(text||'').trim(); if(!text||busy||!session)return;
    add(text,'me'); $('in').value=''; chips([]); busy=true; typing(true);
    api('/api/embed/chat/message',{session:session,text:text}).then(function(d){
      typing(false); busy=false;
      if(d&&d.reply)add(d.reply,'bot'); else add('Hmm, I did not catch that. Try again?','bot');
      if(d&&d.quick)chips(d.quick);
    }).catch(function(){typing(false);busy=false;add('Connection hiccup — say that again?','bot')});
  }
  $('send').onclick=function(){sendMsg($('in').value)};
  $('in').addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();sendMsg($('in').value)}});
})();`

/** Public config for the chat bubble — never leaks anything the widget shouldn't show. */
app.get('/api/embed/agent/config', (req, res) => embedRun(req, res, () => {
  const c = getBotConfig()
  res.json({ enabled: !!c.enabled, name: c.name, greeting: c.greeting, accent: c.accent, shop: c.shop_name,
    quick: ['Get a quote', 'What is your minimum?', 'How fast can you turn it around?'] })
}))

/** Open a chat session (one per visitor tab). */
app.post('/api/embed/chat/start', embedLimit(12, 'Too many chats from this connection. Try again shortly.'), (req, res) => embedRun(req, res, () => {
  const c = getBotConfig()
  if (!c.enabled) return res.json({ enabled: false })
  // 'web' is not a hint from the caller — it IS what this route is. captureLead() decides from
  // this value whether a visitor may WRITE on a customer it matched them to, so taking it from
  // the request body handed that decision to the visitor: {"channel":"sms"} on this very call
  // turned the guard off, and a stranger with only the shop's published embed key overwrote a
  // real customer's blank phone with their own number and drafted a numbered estimate on that
  // customer's account. The widget has never sent this field — it posts {page_url} and nothing else.
  const s = startSession({ channel: 'web', page_url: req.body?.page_url || '' })
  res.json({ enabled: true, session: s.public_id, greeting: c.greeting, name: c.name, accent: c.accent })
}))

/** A visitor sent a message. Runs the engine, notifies the shop's staff on captured leads. */
app.post('/api/embed/chat/message', embedLimit(60, 'You are sending messages very quickly — give it a moment.'), (req, res) => embedRun(req, res, async () => {
  const s = sessionByPublicId(String(req.body?.session || ''))
  if (!s) return res.status(404).json({ error: 'Session expired' })
  const cfg = getBotConfig()
  // /start refuses to open a session when the bot is off; this route never checked, so every
  // widget already on a visitor's screen kept being answered by a receptionist the shop had
  // switched off. respond() enforces the same rule, but say it here too so the widget gets a
  // clean `enabled:false` rather than a reply that looks like the bot is still working.
  if (!cfg.enabled) return res.json({ reply: OFFLINE_REPLY, quick: [], enabled: false })
  // A real chat message is not four thousand characters. This is the public, unauthenticated
  // endpoint a shop pastes onto its own website, and whatever arrives here is STORED and then
  // replayed into every later model prompt on the shop's own API key — so the cost of one
  // oversize message was paid again on every subsequent turn. Refuse it rather than truncate:
  // silently dropping half of what someone typed is its own kind of wrong answer.
  const text = String(req.body?.text || '')
  if (text.length > MESSAGE_CAP) {
    return res.json({ reply: 'That message is a bit long for me — could you send the short version?', quick: [], enabled: true })
  }
  const out = await respond(s, text, cfg)
  for (const ev of out.events) {
    rtBroadcast('notify', {
      kind: ev.type,
      title: ev.type === 'handoff' ? 'A visitor wants to talk to a person' : 'New lead from the website chat',
      body: `${ev.name} — ${ev.summary}${ev.value ? ` (~$${Math.round(ev.value)})` : ''}`,
      contact_id: ev.contact_id, session: ev.session_public,
    })
  }
  res.json({ reply: out.reply, quick: out.quick })
}))

/** The drop-in widget loader. A shop pastes one script tag with their key; this injects the bubble. */
app.get('/embed/chat.js', (_req, res) => {
  res.type('application/javascript').send(CHAT_WIDGET_JS)
})

/** A blank demo page so a shop can try the real widget exactly as a visitor would. */
app.get('/embed/chatdemo', (req, res) => {
  const key = String(req.query.shop || '').replace(/[^A-Za-z0-9_-]/g, '')
  res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex"><title>Receptionist demo</title>
    <style>body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0f0d;color:#cfe;display:grid;place-items:center;height:100vh;text-align:center}
    .b{max-width:440px;padding:24px}h1{font-size:20px}p{color:#7fa;line-height:1.6;font-size:14px}</style></head>
    <body><div class="b"><h1>Your website (demo)</h1><p>This is a blank page standing in for your site. The chat bubble in the bottom-right is your live AI receptionist — click it and have a conversation as a customer would.</p></div>
    <script src="/embed/chat.js?shop=${key}" defer></` + `script></body></html>`)
})

/* ================= CUSTOMER-FACING PAGES ================= */

/**
 * Customer documents carry the deployment's brand colour. public.css defaults to the pro green, so
 * without this a Print Shop Control shop sent invoices with a green accent while its whole app was
 * blue — the one place brand consistency matters most, since it's what the customer sees.
 */
const docAccentCss = () => {
  if (EDITION !== 'lite') return ''
  const a = BRAND_ACCENT || '#2563eb'
  return `<style>:root{--doc-accent:${a};--doc-accent-ink:#ffffff;--doc-accent-glow:rgba(37,99,235,.15)}`
    + `.btn:hover{background:#1d4ed8}</style>`
}

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${title}</title><link rel="stylesheet" href="/css/public.css">${docAccentCss()}</head><body>${body}</body></html>`

/**
 * The shop's logo for a customer-facing document, or nothing when none is set.
 *
 * The stored filename ends in an extension taken from the uploader's own filename, so a name like
 * `logo.png"onerror=…` would yield an extension that breaks straight out of the src attribute. Some
 * callers pass raw settings and some pass an escaped view, so rather than depend on the caller this
 * validates the whole filename against a strict whitelist and renders nothing if it doesn't match.
 */
/**
 * "Billed to" for an invoice, including the customer's own PO reference and the due date. An AP
 * department needs its PO quoted back before it will pay, and the due date belongs on the document
 * rather than only in the shop's own screen.
 */
const billedTo = (inv, c) => `<div class="to">Billed to <strong>${esc(c?.name || '')}</strong>${c?.company ? ` · ${esc(c.company)}` : ''}`
  + `${inv.po_number ? ` · PO ${esc(inv.po_number)}` : ''}${inv.due_date ? ` · due ${esc(inv.due_date)}` : ''}</div>`

/**
 * The invoice's line items. Invoices carry no items of their own — they inherit the estimate they
 * were converted from — so this reads them back through that link. Empty (no estimate, e.g. an
 * Autopilot invoice) renders nothing rather than a misleading placeholder line.
 */
function itemsTable(inv) {
  if (!inv.estimate_id) return ''
  const e = get('SELECT items FROM estimates WHERE id = ?', inv.estimate_id)
  const items = parse(e?.items, [])
  if (!items.length) return ''
  const up = getUpcharges()
  const rows = items.map((i) => {
    const extra = lineUpcharge(i, up)
    return `<tr><td><strong>${esc(i.description || '')}</strong>`
      + `${i.detail ? `<div class="detail">${esc(i.detail)}</div>` : ''}`
      + `${i.sizes && sizeTotal(i.sizes) > 0 ? `<div class="detail">${esc(sizeSummary(i.sizes))}</div>` : ''}</td>`
      + `<td class="num">${esc(lineQty(i) || '')}</td>`
      + `<td class="num">${money(i.unit_price)}${extra ? `<div class="detail">+${money(extra)} sizes</div>` : ''}</td>`
      + `<td class="num">${money(lineAmount(i, up))}</td></tr>`
  }).join('')
  return `<table><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead><tbody>${rows}</tbody></table>`
}

/**
 * The totals block for the customer-facing invoice pages.
 *
 * itemsTable() above prints the estimate's lines, and those lines sum to the SUBTOTAL. The page
 * then asked for `amount_due`, which is subtotal + tax — so on an $798.00 order carrying $50.22 of
 * tax the customer read a table totalling $798.00 and a demand for $848.22, with nothing anywhere
 * on the page accounting for the $50.22. This is the document customers actually pay from; the PDF
 * and /p/estimate have always broken it out correctly.
 *
 * The breakdown is only printed when subtotal + tax genuinely reconciles to amount_due. An invoice
 * whose amount_due came from somewhere else — an imported invoice, an Autopilot invoice with no
 * estimate behind it — keeps the single-line form, because a breakdown that does not add up is a
 * worse lie than no breakdown at all.
 */
function invoiceTotals(inv, balance, s, c) {
  const e = inv.estimate_id ? get('SELECT subtotal, tax, tax_rate FROM estimates WHERE id = ?', inv.estimate_id) : null
  const sub = Number(e?.subtotal)
  const tax = Number(e?.tax) || 0
  const reconciles = !!e && Number.isFinite(sub)
    && Math.abs(round2(sub + tax) - (Number(inv.amount_due) || 0)) <= 0.005
  const head = reconciles
    ? `<div><span>Subtotal</span><span>${money(sub)}</span></div>`
      + (Math.abs(tax) > 0.005
        ? `<div><span>Tax (${esc(e.tax_rate ?? s.tax_rate)}%)</span><span>${money(tax)}</span></div>`
        : `<div><span>Tax</span><span>${c?.tax_exempt ? 'Exempt (resale)' : money(0)}</span></div>`)
    : ''
  return `<div class="totals">${head}<div><span>Invoice total</span><span>${money(inv.amount_due)}</span></div>`
    + `${inv.amount_paid > 0 ? `<div><span>Already paid</span><span>${money(inv.amount_paid)}</span></div>` : ''}`
    + `<div class="grand"><span>Balance due</span><span>${money(balance)}</span></div></div>`
}

const SAFE_UPLOAD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/
const logoImg = (s) => {
  const f = String(s?.shop_logo || '')
  if (!f || !SAFE_UPLOAD_NAME.test(f) || f.includes('..')) return ''
  return `<img class="shop-logo" src="${esc(uploadUrl(f))}" alt="">`
}

/**
 * An escaped view of the settings object for pages that build raw HTML.
 *
 * shop_name is written by the PUBLIC signup endpoint, so anyone who can create a shop controls it.
 * Interpolating it unescaped is stored XSS on this app's own origin, aimed at whoever opens the
 * link. Returning a proxy that escapes every string property makes `${s.shop_name}` safe by
 * construction — including at call sites added later. Only use it on handlers that don't already
 * call esc() on these fields, or the output double-escapes.
 */
const escView = (o) => new Proxy(o || {}, { get: (t, k) => (typeof t[k] === 'string' ? esc(t[k]) : t[k]) })

/** Join document footer parts, dropping blanks — a new shop has no phone yet and " ·  · " on a
 *  customer-facing invoice looks broken. Takes already-escaped values. */
const joinDot = (...parts) => parts.map((p) => String(p ?? '').trim()).filter(Boolean).join(' · ')

// Customer share links carry the shop slug (?s=) so they resolve to the right shop's database.
const sQ = (req) => (req.query.s ? `&s=${encodeURIComponent(req.query.s)}` : '')
const pPage = (fn) => (req, res) => {
  const go = () => { try { return fn(req, res) } catch (e) { console.error('p-page:', e); if (!res.headersSent) res.status(500).send('Error') } }
  if (!AUTH_ENABLED || !req.query.s) return go()   // authed staff are already in tenant context via the gate
  const t = getTenantBySlug(String(req.query.s))
  // Same rule as the embed routes: a suspended shop's public documents close with it. A pay button
  // on one of them would route money into an account the operator has just cut off.
  if (!tenantOpen(t)) return res.status(404).send('Unknown shop')
  return withTenant(t.slug, go)
}

app.get('/p/estimate/:id', pPage((req, res) => {
  const id = +req.params.id
  if (!checkToken('estimate', id, req.query.k)) return res.status(403).send(page('Not found', '<div class="card"><h1>Link expired</h1><p>Ask the shop to resend this estimate.</p></div>'))
  const e = get('SELECT * FROM estimates WHERE id = ?', id)
  if (!e) return res.status(404).send(page('Not found', '<div class="card"><h1>Not found</h1></div>'))
  const c = get('SELECT * FROM contacts WHERE id = ?', e.contact_id)
  const s = getSettings()
  const items = parse(e.items, [])
  // Garment lines carry a `sizes` grid and no `qty`, so the old `(i.qty || 0) * i.unit_price` here
  // rendered every real line as blank Qty / $0.00 while the totals below showed the true amount —
  // the customer got a quote whose line items contradicted its own total. Use the same shared
  // helpers the PDF and the estimate editor use, so all three documents agree.
  const up = getUpcharges()
  const rows = items.map((i) => {
    const extra = lineUpcharge(i, up)
    return `<tr><td><strong>${esc(i.description || '')}</strong>${i.detail ? `<div class="detail">${esc(i.detail)}</div>` : ''}${i.sizes && sizeTotal(i.sizes) > 0 ? `<div class="detail">${esc(sizeSummary(i.sizes))}</div>` : ''}</td>
    <td class="num">${esc(lineQty(i) || '')}</td><td class="num">${money(i.unit_price)}${extra ? `<div class="detail">+${money(extra)} sizes</div>` : ''}</td><td class="num">${money(lineAmount(i, up))}</td></tr>`
  }).join('')
  const done = e.status === 'approved'
  res.send(page(`Estimate ${esc(e.estimate_number)}`, `<div class="wrap">
    <div class="card">
      <div class="head"><div>${logoImg(s)}<div class="shop">${esc(s.shop_name)}</div><div class="tag">${esc(s.shop_tagline)}</div></div>
        <div class="right"><div class="doc">ESTIMATE</div><div class="num2">${esc(e.estimate_number)}</div></div></div>
      <div class="to">Prepared for <strong>${esc(c?.name || '')}</strong>${c?.company ? ` · ${esc(c.company)}` : ''}</div>
      <table><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="totals"><div><span>Subtotal</span><span>${money(e.subtotal)}</span></div>
        ${Math.abs(Number(e.tax) || 0) > 0.005
          ? `<div><span>Tax (${esc(e.tax_rate ?? s.tax_rate)}%)</span><span>${money(e.tax)}</span></div>`
          : `<div><span>Tax</span><span>${c?.tax_exempt ? 'Exempt (resale)' : money(0)}</span></div>`}
        <div class="grand"><span>Total</span><span>${money(e.total)}</span></div></div>
      ${e.notes ? `<div class="notes"><strong>Notes</strong><p>${esc(e.notes)}</p></div>` : ''}
      <div class="terms">${esc(s.estimate_terms)}</div>
      ${done ? '<div class="ok">✓ Approved — thank you! The shop has been notified.</div>'
        : `<form method="POST" action="/p/estimate/${id}/approve?k=${req.query.k}${sQ(req)}">
             <button class="btn">Approve this estimate</button>
             <button type="button" class="btn ghost" onclick="window.print()">Print / Save PDF</button>
           </form>`}
    </div><div class="foot">${joinDot(esc(s.shop_name), esc(s.shop_phone), esc(s.shop_email))}</div></div>`))
}))

app.post('/p/estimate/:id/approve', express.urlencoded({ extended: false }), pPage((req, res) => {
  const id = +req.params.id
  if (!checkToken('estimate', id, req.query.k)) return res.status(403).send('Forbidden')
  const e = get('SELECT * FROM estimates WHERE id = ?', id)
  if (!e) return res.status(404).send('Not found')
  // Approve once. Its sibling /p/art/:id/decide has had exactly this guard, for exactly this
  // reason, since it was written — and this route did not. An estimate link gets forwarded around
  // a purchasing department and re-opened for weeks, and without a guard every re-POST re-stamped
  // approved_at, wrote another "APPROVED" line on the customer's timeline, and re-fired
  // estimate.approved: 50 unauthenticated POSTs in 277ms produced 50 real customer emails out of
  // the shop's own SMTP and 50 webhook deliveries. Event-triggered automations have no dedupe of
  // their own — only the timed path does — so this was the whole brake.
  if (e.status === 'approved' || e.status === 'invoiced') return res.redirect(`/p/estimate/${id}?k=${req.query.k}${sQ(req)}`)
  run(`UPDATE estimates SET status='approved', approved_at=? WHERE id=?`, now(), id)
  const c = get('SELECT name FROM contacts WHERE id = ?', e.contact_id)
  logActivity('estimate', `Estimate ${e.estimate_number} APPROVED by ${c?.name || 'customer'} online`, { contact_id: e.contact_id })
  fireAuto('estimate.approved', { estimate: get('SELECT * FROM estimates WHERE id = ?', id), contact: get('SELECT * FROM contacts WHERE id = ?', e.contact_id), total: e.total })
  syncPipeline(get('SELECT * FROM estimates WHERE id = ?', id), 'approved')
  res.redirect(`/p/estimate/${id}?k=${req.query.k}${sQ(req)}`)
}))

/* ---- online payment: deposit or balance, on the SHOP's own Stripe ---- */

/** Record a confirmed Stripe payment against an invoice, idempotently (session id can't double-post). */
function recordStripePayment(inv, session, sessionId, kind) {
  if (get('SELECT 1 FROM payments WHERE stripe_session = ?', sessionId)) return syncInvoiceStatus(inv.id) // already recorded (idempotent)
  // The pay page and the checkout route both refuse a voided invoice now, so the only way to land
  // here is a session that was already open when the shop voided it. That money is real and sitting
  // at Stripe: record it so it is visible, keep the invoice void, and say plainly that it needs
  // refunding. Swallowing it silently is how a customer ends up out of pocket with nothing on file.
  const live = get('SELECT status FROM invoices WHERE id = ?', inv.id)
  if (live?.status === 'void') {
    const arrived = round2((Number(session.amountCents) || 0) / 100)
    run('INSERT INTO payments (invoice_id, amount, method, note, stripe_session, created_at) VALUES (?,?,?,?,?,?)',
      inv.id, arrived, 'card', `Payment arrived AFTER ${inv.invoice_number} was voided — refund at Stripe`, sessionId, now())
    logActivity('payment', `${money(arrived)} arrived by card on VOIDED ${inv.invoice_number} — refund it at Stripe`, { contact_id: inv.contact_id })
    return syncInvoiceStatus(inv.id)
  }
  const paid = round2((Number(session.amountCents) || 0) / 100)
  const fresh = get('SELECT amount_due, amount_paid FROM invoices WHERE id = ?', inv.id)
  const bal = round2((fresh?.amount_due || 0) - (fresh?.amount_paid || 0))
  // This used to clamp to the remaining balance and DROP the difference: `Math.min(paid, bal)`,
  // then `if (!(amount > 0)) return` — so a customer with the deposit link open in one tab and the
  // balance link in another paid $9,450 on a $6,300 invoice, the shop recorded $6,300, and the
  // remaining $3,150 existed nowhere but at Stripe. At an already-zero balance the whole payment
  // vanished: no payment row, no activity, no notification, and the customer was shown
  // "your payment went through / Balance $0.00". The card really was charged.
  //
  // Record what ARRIVED. The void branch a dozen lines above already takes exactly this position:
  // money that reached Stripe is real, and the shop cannot refund what it was never told about.
  // The invoice going past 100% paid is a true state the shop has to resolve, not one to hide —
  // A/R aging filters on a positive balance so an overpaid invoice drops out of it cleanly.
  if (!(paid > 0)) return syncInvoiceStatus(inv.id)
  const over = Math.max(0, round2(paid - Math.max(0, bal)))
  const label = `Online ${kind === 'deposit' ? 'deposit' : 'payment'} (Stripe)`
  run('INSERT INTO payments (invoice_id, amount, method, note, stripe_session, created_at) VALUES (?,?,?,?,?,?)',
    inv.id, paid, 'card', over > 0.005 ? `${label} — ${money(over)} MORE than the balance owed; refund the difference at Stripe` : label, sessionId, now())
  const amount = paid
  const updated = syncInvoiceStatus(inv.id)
  advanceOrder(inv.estimate_id, 'paid')
  logActivity('payment', `Online ${money(amount)} on ${inv.invoice_number} (card)`, { contact_id: inv.contact_id })
  if (over > 0.005) {
    // Loud, and on the customer's own timeline, because the shop has to act on it at Stripe.
    logActivity('payment', `${money(over)} OVERPAID on ${inv.invoice_number} — refund the difference at Stripe`, { contact_id: inv.contact_id })
    rtBroadcast('notify', { title: 'Overpayment — refund needed', body: `${money(over)} more than owed on ${inv.invoice_number}` })
  }
  if (updated.status === 'paid' && inv.status !== 'paid') {
    fireAuto('invoice.paid', { invoice: updated, contact: get('SELECT * FROM contacts WHERE id = ?', inv.contact_id), total: updated.amount_due })
  }
  enqueueQbo(inv.id) // online money in — queue the books update alongside the manual path
  rtBroadcast('notify', { title: 'Payment received', body: `${money(amount)} on ${inv.invoice_number}` })
  return updated
}

app.get('/p/pay/:id', pPage(async (req, res) => {
  const id = +req.params.id
  if (!checkToken('pay', id, req.query.k)) return res.status(403).send(page('Link expired', '<div class="wrap"><div class="card"><h1>Link expired</h1><p>Ask the shop to resend your payment link.</p></div></div>'))
  const inv = get('SELECT * FROM invoices WHERE id = ?', id)
  if (!inv) return res.status(404).send(page('Not found', '<div class="wrap"><div class="card"><h1>Not found</h1></div></div>'))
  const s = escView(getSettings())
  const c = get('SELECT * FROM contacts WHERE id = ?', inv.contact_id)

  // The customer may still be holding a payment link that was emailed before the shop voided the
  // invoice. Without this the page cheerfully showed the old balance and a Pay button, and every
  // click opened a NEW Stripe session — so the same cancelled invoice could be paid over and over,
  // each charge real and none of them visible on the invoice.
  if (inv.status === 'void') {
    return res.send(page('Invoice cancelled', `<div class="wrap"><div class="card">
      <div class="head"><div>${logoImg(s)}<div class="shop">${s.shop_name}</div><div class="tag">${s.shop_tagline}</div></div><div class="right"><div class="doc">CANCELLED</div><div class="num2">${esc(inv.invoice_number)}</div></div></div>
      <h1>This invoice was cancelled</h1>
      <p>Nothing is owed on ${esc(inv.invoice_number)} and it can no longer be paid. If you were expecting to pay for this order, please contact us and we will send you a current invoice.</p>
    </div><div class="foot">${joinDot(s.shop_name, s.shop_phone, s.shop_email)}</div></div>`))
  }

  // Returning from Stripe → confirm the session actually paid, then record it (idempotent).
  //
  // The confirm used to be wrapped in a bare try/catch and the success page rendered regardless, so
  // a thrown confirm — a rejected key, a network blip, Stripe being slow — printed "✓ Thank you,
  // your payment went through" to a customer whose card HAD been charged (Stripe only redirects
  // here after charging) while amount_paid never moved. It then offered a "Pay the remaining"
  // button, which is how the same balance gets paid twice. Say which of the three things happened.
  if (req.query.session_id) {
    let outcome = 'unconfirmed'
    try {
      const session = await confirmSession(s, String(req.query.session_id))
      if (session.paid && String(session.metadata?.invoice) === String(id)) {
        recordStripePayment(inv, session, String(req.query.session_id), session.metadata?.kind)
        outcome = 'paid'
      } else {
        outcome = 'not_paid'
      }
    } catch (e) {
      console.error('pay-confirm:', e.message)
      // Loud, because the money may be real and only the shop can reconcile it.
      logActivity('payment', `Could not confirm a card payment on ${inv.invoice_number} — check Stripe for session ${String(req.query.session_id).slice(0, 40)}`, { contact_id: inv.contact_id })
    }
    const fresh = get('SELECT * FROM invoices WHERE id = ?', id)
    const bal = round2(fresh.amount_due - fresh.amount_paid)
    const headline = outcome === 'paid'
      ? '<div class="ok">✓ Thank you — your payment went through.</div>'
      : outcome === 'not_paid'
        ? `<div class="ok">This payment was not completed. Nothing has been charged — you can try again below.</div>`
        : `<div class="ok">We could not confirm this payment just yet. <strong>Do not pay again.</strong> If your card was charged it will be applied to ${esc(fresh.invoice_number)}; ${esc(s.shop_name)} has been notified and will be in touch.</div>`
    // Only invite another payment when we KNOW the first one did not happen. Offering it after a
    // failed confirm is exactly how a customer pays the same balance twice.
    const offerPay = bal > 0 && outcome === 'not_paid'
    return res.send(page(outcome === 'paid' ? 'Payment received' : 'Payment status', `<div class="wrap"><div class="card">
      <div class="head"><div>${logoImg(s)}<div class="shop">${s.shop_name}</div><div class="tag">${s.shop_tagline}</div></div><div class="right"><div class="doc">${outcome === 'paid' ? 'RECEIPT' : 'INVOICE'}</div><div class="num2">${fresh.invoice_number}</div></div></div>
      ${headline}
      <div class="totals"><div><span>Invoice total</span><span>${money(fresh.amount_due)}</span></div>
        <div><span>Paid</span><span>${money(fresh.amount_paid)}</span></div>
        <div class="grand"><span>${bal > 0 ? 'Remaining balance' : 'Balance'}</span><span>${money(bal)}</span></div></div>
      ${offerPay ? `<form method="GET" action="/p/pay/${id}"><input type="hidden" name="k" value="${req.query.k}">${req.query.s ? `<input type="hidden" name="s" value="${esc(req.query.s)}">` : ''}<button class="btn">Pay the remaining ${money(bal)}</button></form>` : ''}
    </div><div class="foot">${joinDot(s.shop_name, s.shop_phone, s.shop_email)}</div></div>`))
  }

  const balance = round2(inv.amount_due - inv.amount_paid)
  if (balance <= 0) return res.send(page('Paid', `<div class="wrap"><div class="card"><div class="head"><div>${logoImg(s)}<div class="shop">${s.shop_name}</div></div><div class="right"><div class="doc">RECEIPT</div><div class="num2">${inv.invoice_number}</div></div></div><div class="ok">✓ This invoice is paid in full. Thank you!</div></div></div>`))

  if (!paymentsReady(s)) {
    // Until the shop connects Stripe this IS the invoice its customers receive, so it has to be a
    // real document — itemized, with totals, terms and how to pay. It used to be one sentence
    // ("online payment isn't set up yet") over a bare header, which reads like a broken link.
    return res.send(page(`Invoice ${inv.invoice_number}`, `<div class="wrap"><div class="card">
      <div class="head"><div>${logoImg(s)}<div class="shop">${s.shop_name}</div><div class="tag">${s.shop_tagline}</div></div>
        <div class="right"><div class="doc">INVOICE</div><div class="num2">${inv.invoice_number}</div></div></div>
      ${billedTo(inv, c)}
      ${itemsTable(inv)}
      ${invoiceTotals(inv, balance, s, c)}
      <div class="notes"><strong>How to pay</strong><p>Card payment isn't switched on for this shop yet — please contact ${s.shop_name} to settle this invoice.</p></div>
      <div class="terms">${esc(getSettings().invoice_terms || '')}</div>
      <div class="foot">${joinDot(s.shop_name, s.shop_phone, s.shop_email)}</div></div></div>`))
  }

  const deposit = round2(Math.min(balance, inv.amount_due * 0.5))
  const depositBtn = (inv.amount_paid <= 0 && deposit > 0 && deposit < balance)
    ? `<button class="btn" name="kind" value="deposit">Pay 50% deposit — ${money(deposit)}</button>`
    : ''
  res.send(page(`Pay ${inv.invoice_number}`, `<div class="wrap"><div class="card">
    <div class="head"><div>${logoImg(s)}<div class="shop">${s.shop_name}</div><div class="tag">${s.shop_tagline}</div></div><div class="right"><div class="doc">INVOICE</div><div class="num2">${inv.invoice_number}</div></div></div>
    ${billedTo(inv, c)}
    ${itemsTable(inv)}
    ${invoiceTotals(inv, balance, s, c)}
    <form method="POST" action="/p/pay/${id}/checkout?k=${req.query.k}${sQ(req)}" style="display:flex;flex-direction:column;gap:10px;margin-top:14px">
      ${depositBtn}
      <button class="btn ${depositBtn ? 'ghost' : ''}" name="kind" value="balance">Pay ${inv.amount_paid > 0 ? 'the balance' : 'in full'} — ${money(balance)}</button>
    </form>
    <div class="terms">Secure payment through ${s.shop_name}'s Stripe account. Your card details go straight to Stripe.</div>
    <div class="foot">${joinDot(s.shop_name, s.shop_phone, s.shop_email)}</div></div></div>`))
}))

app.post('/p/pay/:id/checkout', express.urlencoded({ extended: false }), pPage(async (req, res) => {
  const id = +req.params.id
  if (!checkToken('pay', id, req.query.k)) return res.status(403).send('Forbidden')
  const inv = get('SELECT * FROM invoices WHERE id = ?', id)
  if (!inv) return res.status(404).send('Not found')
  // Never open a Stripe session for a cancelled invoice — see the note on GET /p/pay/:id.
  if (inv.status === 'void') return res.redirect(`/p/pay/${id}?k=${req.query.k}${sQ(req)}`)
  const s = escView(getSettings())
  const balance = round2(inv.amount_due - inv.amount_paid)
  if (balance <= 0) return res.redirect(`/p/pay/${id}?k=${req.query.k}${sQ(req)}`)
  const kind = req.body?.kind === 'deposit' ? 'deposit' : 'balance'
  const amount = kind === 'deposit' ? round2(Math.min(balance, inv.amount_due * 0.5)) : balance
  if (!(amount > 0)) return res.redirect(`/p/pay/${id}?k=${req.query.k}${sQ(req)}`)
  const c = get('SELECT * FROM contacts WHERE id = ?', inv.contact_id)
  const origin = `${req.protocol}://${req.get('host')}`
  const back = `${origin}/p/pay/${id}?k=${req.query.k}${sQ(req)}`
  try {
    const { url } = await startCheckout(s, {
      lineItems: [{ name: `${inv.invoice_number} — ${kind === 'deposit' ? 'deposit' : 'balance'} (${s.shop_name})`, amountCents: Math.round(amount * 100), qty: 1 }],
      successUrl: `${back}&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: back,
      customerEmail: c?.email || undefined,
      metadata: { invoice: String(id), kind, slug: curSlug() },
    })
    res.redirect(303, url)
  } catch (e) {
    console.error('pay-checkout:', e.message)
    res.status(502).send(page('Payment error', `<div class="wrap"><div class="card"><h1>Couldn't start checkout</h1><p>${esc(e.message)}</p><p><a href="${back}">Go back</a></p></div></div>`))
  }
}))

/**
 * Work ticket — the sheet that rides with the garments. Deliberately internal (costs,
 * assignments, notes) and not token-gated: it is never sent to a customer.
 */
app.get('/p/ticket/:id', pPage((req, res) => {
  const id = +req.params.id
  // The work ticket carries costs, staff notes, phone, and the ink/screen recipe — internal only.
  // It lives on the public /p/ namespace for one-click staff printing, so it MUST be token-gated
  // exactly like the other /p/ pages; the HMAC binds to the shop, closing the cross-tenant hole too.
  if (!checkToken('ticket', id, req.query.k)) return res.status(403).send('Forbidden')
  const j = get(`SELECT j.*, c.name AS contact_name, c.company, c.phone, i.invoice_number, e.estimate_number, e.items AS est_items
    FROM jobs j LEFT JOIN contacts c ON c.id=j.contact_id LEFT JOIN invoices i ON i.id=j.invoice_id
    LEFT JOIN estimates e ON e.id=j.estimate_id WHERE j.id=?`, +req.params.id)
  if (!j) return res.status(404).send('Not found')
  const s = getSettings()
  const grid = parse(j.sizes, {})
  // The imprint the press actually runs, pulled from the quote. A formal separation exists on
  // almost no real job, so the ticket used to show nothing about colours or placement unless one
  // had been entered by hand — leaving the operator to guess. The quote already states it in the
  // trade's shorthand ("Gildan 5000 — 3/0 Front + 1/0 Back"); surface that. Each garment line
  // becomes a placement row with its colour count.
  const estItems = parse(j.est_items, [])
  const imprintLines = estItems
    .filter((it) => it && it.sizes && !/screen|setup|digitiz/i.test(String(it.description || '')))
    .map((it) => {
      const desc = String(it.description || '')
      const afterDash = desc.includes('—') ? desc.split('—').slice(1).join('—').trim() : desc
      // Split "3/0 Front + 1/0 Back" into placements with their colour counts.
      const placements = afterDash.split('+').map((p) => p.trim()).filter(Boolean)
      return { garment: desc.split('—')[0].trim(), placements: placements.length ? placements : [afterDash || 'Print'] }
    })
  const sizes = Object.entries(grid).filter(([, n]) => Number(n) > 0)
  const total = sizes.reduce((t, [, n]) => t + Number(n), 0)
  // The ticket used to name both garments in the Imprint block and then print ONE merged size
  // table below it — the same page contradicting itself. Render a table per garment instead.
  const tkLines = jobLines(j)
  const sizeTables = tkLines
    .map((l) => ({ garment: l.description || l.garment || '', cells: Object.entries(l.sizes || {}).filter(([, n]) => Number(n) > 0) }))
    .filter((b) => b.cells.length)
  const grandTotal = sizeTables.reduce((t, b) => t + b.cells.reduce((s, [, n]) => s + Number(n), 0), 0)
  const art = all('SELECT * FROM art_versions WHERE job_id = ? ORDER BY version DESC', j.id)
  const approved = art.find((a) => a.status === 'approved')

  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(j.job_number)} — Work Ticket</title>
    <link rel="stylesheet" href="/css/ticket.css"></head><body>
    <button class="printbtn" onclick="window.print()">🖨 Print this ticket</button>
    <div class="tk">
      <div class="tk-h">
        <div><div class="jn">${esc(j.job_number)}</div><h1>${esc(j.title)}</h1>
          <div class="cust">${esc(j.contact_name || '')}${j.company ? ` · ${esc(j.company)}` : ''}${j.phone ? ` · ${esc(j.phone)}` : ''}</div></div>
        <div class="tk-r">${j.rush ? '<div class="rush">RUSH</div>' : ''}
          <div class="due"><span>DUE</span><strong>${esc(j.due_date || '—')}</strong></div>
          <div class="tk-bc">${code128Svg(j.job_number, { height: 44, module: 1.6 })}<div class="tk-bc-num">${esc(j.job_number)} — scan to advance</div></div></div>
      </div>
      <div class="tk-meta">
        ${[['Decoration', j.decoration], ['Garment', sizeTables.map((b) => b.garment.split('—')[0].trim()).filter(Boolean).join(' + ') || j.garment], ['Stage', String(j.stage || '').replace('_', ' ')],
           ['Assigned', j.assigned_to || '—'], ['Invoice', j.invoice_number || '—'], ['Estimate', j.estimate_number || '—']]
          .map(([k, v]) => `<div><span>${esc(k)}</span><strong>${esc(v || '—')}</strong></div>`).join('')}
      </div>
      <h2>Size Breakdown</h2>
      ${sizeTables.length
        ? sizeTables.map((b) => `${sizeTables.length > 1 ? `<div class="tk-gname">${esc(b.garment || '—')}</div>` : ''}
        <table class="tk-sz"><tr>${b.cells.map(([sz]) => `<th>${esc(sz)}</th>`).join('')}<th class="t">TOTAL</th></tr>
          <tr>${b.cells.map(([, n]) => `<td>${esc(n)}</td>`).join('')}<td class="t">${b.cells.reduce((s, [, n]) => s + Number(n), 0)}</td></tr></table>`).join('')
          + (sizeTables.length > 1 ? `<div class="tk-gtotal">All garments — ${grandTotal} pieces</div>` : '')
        : `<table class="tk-sz"><tr>${sizes.map(([sz]) => `<th>${esc(sz)}</th>`).join('')}<th class="t">TOTAL</th></tr>
        <tr>${sizes.map(([, n]) => `<td>${esc(n)}</td>`).join('')}<td class="t">${total}</td></tr></table>`}
      ${(() => {
        const sep = parse(j.separation, null)
        if (sep) {
          const chips = [...(sep.inks || []).map((i) => ({ name: i.name, hex: i.hex })), ...(sep.dark ? [{ name: 'Underbase', hex: '#f5f5f5' }] : [])]
          return `<h2>Screens — ${sep.screens} · ${sep.mode === 'process' ? 'sim process' : 'spot color'}</h2>
            <div class="tk-screens">${chips.map((c, i) => `<div class="tk-scr"><span class="dot" style="background:${esc(c.hex)}"></span>${i + 1}. ${esc(c.name)}</div>`).join('')}</div>`
        }
        // No formal separation: show the imprint from the quote so the operator knows what prints
        // where, and give labelled BLANKS for the specs the system doesn't capture — the operator
        // fills them at the press rather than the ticket pretending they don't matter.
        if (!imprintLines.length) return ''
        return `<h2>Imprint</h2>
          <table class="tk-imp">
            ${imprintLines.map((l) => `<tr><td class="g">${esc(l.garment)}</td><td>${l.placements.map((p) => `<span class="tk-pl">${esc(p)}</span>`).join('')}</td></tr>`).join('')}
          </table>
          <div class="tk-specs">
            ${['Ink colours / PMS', 'Ink type', 'Mesh', 'Squeegee', 'Flash / cure', 'Platen'].map((k) => `<div><span>${esc(k)}</span><div class="ln"></div></div>`).join('')}
          </div>`
      })()}
      <div class="tk-cols">
        <div><h2>Notes</h2><div class="tk-notes">${esc(j.notes || 'None.')}</div></div>
        <div><h2>Approved Art</h2>
          ${approved ? `<div class="tk-art"><img src="${esc(uploadUrl(approved.filename))}" alt="v${esc(approved.version)}">
            <div class="cap">v${esc(approved.version)} — approved ${esc((approved.decided_at || '').slice(0, 10))} by ${esc(approved.decided_by || '')}</div></div>`
            : '<div class="warnbox">⚠ NO APPROVED ART — do not print.</div>'}
        </div>
      </div>
      <div class="tk-sign">
        <div><span>Printed by</span><div class="ln"></div></div>
        <div><span>Count checked</span><div class="ln"></div></div>
        <div><span>QC pass</span><div class="ln"></div></div>
        <div><span>Date</span><div class="ln"></div></div>
      </div>
      <div class="tk-f">${esc(s.shop_name)} · ${esc(j.job_number)} · printed ${new Date().toISOString().slice(0, 10)}</div>
    </div></body></html>`)
}))

app.get('/p/art/:id', pPage((req, res) => {
  const id = +req.params.id
  if (!checkToken('art', id, req.query.k)) return res.status(403).send(page('Not found', '<div class="card"><h1>Link expired</h1></div>'))
  const a = get('SELECT * FROM art_versions WHERE id = ?', id)
  if (!a) return res.status(404).send(page('Not found', '<div class="card"><h1>Not found</h1></div>'))
  const j = a.job_id ? get('SELECT * FROM jobs WHERE id = ?', a.job_id) : null
  // Estimate-attached mockups (lite) have no job, so the subject line comes from the quote instead.
  const e = !j && a.estimate_id ? get('SELECT * FROM estimates WHERE id = ?', a.estimate_id) : null
  if (!j && !e) return res.status(404).send(page('Not found', '<div class="card"><h1>Not found</h1></div>'))
  const ec = e ? get('SELECT name, company FROM contacts WHERE id = ?', e.contact_id) : null
  const s = getSettings()
  const isImg = (a.mime || '').startsWith('image/')
  const decided = a.status === 'approved' || a.status === 'rejected'
  const subject = j
    ? `<strong>${esc(j.title)}</strong> · ${esc(j.job_number)} · ${esc(j.decoration || '')}`
    : `<strong>${esc(ec?.name || 'Your order')}</strong>${ec?.company ? ` · ${esc(ec.company)}` : ''} · ${esc(e.estimate_number)}`
  res.send(page(`Proof v${esc(a.version)}`, `<div class="wrap"><div class="card">
    <div class="head"><div>${logoImg(s)}<div class="shop">${esc(s.shop_name)}</div><div class="tag">Artwork for approval</div></div>
      <div class="right"><div class="doc">PROOF</div><div class="num2">v${esc(a.version)}</div></div></div>
    <div class="to">${subject}</div>
    <div class="proof">${isImg ? `<img src="${esc(uploadUrl(a.filename))}" alt="Proof v${esc(a.version)}">`
      : `<a class="btn ghost" href="${esc(uploadUrl(a.filename))}" target="_blank">Open ${esc(a.original_name)}</a>`}</div>
    <div class="check"><strong>Check before approving:</strong> spelling, placement, size, colors, and garment. Once approved, this is exactly what we print.</div>
    ${decided ? `<div class="${a.status === 'approved' ? 'ok' : 'warn'}">${a.status === 'approved'
        // "Moving this to production" is only true when a job exists. On an estimate-attached mockup
        // there is no production floor yet, so promising one would be a lie to the customer.
        ? (j ? '✓ Approved — thank you! We are moving this to production.' : '✓ Approved — thank you! The shop has your sign-off and will take it from here.')
        : '↺ Changes requested. The shop is on it — a new proof is coming.'}</div>`
      : `<form method="POST" action="/p/art/${id}/decide?k=${req.query.k}${sQ(req)}">
          <textarea name="notes" placeholder="Changes needed? Tell us here (optional if approving)"></textarea>
          <div class="row"><button class="btn" name="decision" value="approved">Approve proof</button>
          <button class="btn ghost" name="decision" value="rejected">Request changes</button></div></form>`}
  </div><div class="foot">${joinDot(esc(s.shop_name), esc(s.shop_phone))}</div></div>`))
}))

app.post('/p/art/:id/decide', express.urlencoded({ extended: false }), pPage((req, res) => {
  const id = +req.params.id
  if (!checkToken('art', id, req.query.k)) return res.status(403).send('Forbidden')
  const a = get('SELECT * FROM art_versions WHERE id = ?', id)
  if (!a) return res.status(404).send('Not found')
  // A proof link gets forwarded around a purchasing department and re-opened weeks later. Decide
  // once: a second POST would otherwise drag a job that is already printing back to prepress,
  // push its due date out by a full turnaround, and re-send the customer the automation email.
  if (a.status === 'approved' || a.status === 'rejected') return res.redirect(`/p/art/${id}?k=${req.query.k}${sQ(req)}`)
  // The proof's owner is a job in pro and an estimate in lite. Reading j.contact_id unconditionally
  // threw on an estimate-attached mockup, so the customer's Approve click 500'd.
  const owner = a.job_id
    ? get('SELECT contact_id FROM jobs WHERE id = ?', a.job_id)
    : get('SELECT contact_id FROM estimates WHERE id = ?', a.estimate_id)
  const c = owner ? get('SELECT name FROM contacts WHERE id = ?', owner.contact_id) : null
  // Only an explicit decision counts. Anything else is a 400 — never default a proof to
  // "rejected" because a caller used an unexpected field name. (approved=1 accepted as alias.)
  const b = req.body || {}
  const approved = b.decision === 'approved' || b.approved === '1' || b.approved === 'true'
  const rejected = b.decision === 'rejected' || b.approved === '0' || b.approved === 'false'
  if (!approved && !rejected) return res.status(400).send('Missing decision — post decision=approved or decision=rejected')
  decideArt(a, approved, b.notes || '', c?.name || 'customer')
  res.redirect(`/p/art/${id}?k=${req.query.k}${sQ(req)}`)
}))

/* ================= STATIC + SPA ================= */

const PUBLIC = join(ROOT, 'public')

/**
 * /uploads/* — the one path in the app that serves another person's private property.
 *
 * express.static below serves everything under public/, and the auth gate ends with
 * `return next()` for every non-/api path, so this directory answered with no session and no
 * tenant check at all. Reproduced on two shops sharing one process: shop B's signed-in owner
 * fetched shop A's proof, 200, full bytes; so did a caller with no cookie. Filenames are random,
 * but "hard to guess" is a different promise from "tenant isolation is absolute", and it is not
 * the one the product makes.
 *
 * Now the caller is resolved the same way every other route resolves one: a signed-in member of
 * the shop that owns the file, or a customer holding a token this shop minted for this filename.
 * Ownership is re-read on every request, so DELETE on a proof revokes the artwork too.
 *
 * It must NEVER call next(): falling through would hand the request to express.static, which is
 * the thing being fixed. Every path out of here ends the response.
 */
app.get('/uploads/:file', (req, res) => {
  const f = String(req.params.file || '')
  if (!SAFE_UPLOAD_NAME.test(f) || f.includes('..')) return res.status(404).end()
  // Does THIS shop's database claim the file? Proof/mockup art, or the shop's own logo (which is
  // branding on the customer's invoice, not a secret, but still belongs to exactly one shop).
  const ownedHere = () => {
    try {
      if (get('SELECT 1 AS x FROM art_versions WHERE filename = ? LIMIT 1', f)) return true
      return String(getSettings()?.shop_logo || '') === f
    } catch { return false }
  }
  let ok = false
  if (!AUTH_ENABLED || req.tenant) {
    // Single-tenant (no login anywhere in the product), or a signed-in member: the gate already
    // put us in that shop's database, so this asks "is it yours?" and nothing else.
    ok = ownedHere()
  } else {
    const slug = String(req.query.s || '')
    const want = Buffer.from(fileToken(f, slug))
    const got = Buffer.from(String(req.query.t || ''))
    if (slug && want.length === got.length && crypto.timingSafeEqual(want, got)) {
      const t = getTenantBySlug(slug)
      if (t) { try { ok = withTenant(t.slug, ownedHere) } catch { ok = false } }
    }
  }
  // 404, not 403: a 403 would confirm the file exists to a caller who should not learn that.
  if (!ok) return res.status(404).end()
  // Uploaded art is attacker-supplied and served from the app origin. Neutralize active content —
  // an uploaded SVG with an inline <script> would otherwise run as us. Carried over verbatim from
  // the express.static mount these files used to come from.
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; sandbox")
  // private: a shared proxy must not cache one shop's artwork and hand it to the next caller.
  res.setHeader('Cache-Control', 'private, max-age=86400')
  res.sendFile(join(UPLOADS, f), { dotfiles: 'deny' }, (err) => {
    if (err && !res.headersSent) res.status(404).end()
  })
})

/**
 * AGPL §13 — the two templated pages must never be served off disk.
 *
 * `index: false` on the static mount below only suppresses the DIRECTORY index, so `GET /` fell
 * through to the SPA catch-all and got shellHtml(). An explicit `GET /index.html` or
 * `GET /auth.html` matches a real file, and express.static answered it straight from disk —
 * bypassing shellHtml()/authHtml(), the only two places `__SOURCE_LINK__` is ever replaced.
 * Measured: `GET /` carried one `source-link`; `GET /index.html` and `GET /auth.html` carried
 * zero, and shipped the literal placeholder instead. Both raw pages load /css and /js by absolute
 * path, so they are a fully working copy of the app served to an anonymous caller with no offer of
 * the Corresponding Source. That is a licence breach, not a cosmetic one — and it is exactly the
 * "no off switch" this file's §13 note claims. Anything under public/ carrying a placeholder has
 * to come through its renderer; the gate holds that no response body ever contains one.
 */
app.get(['/index.html', '/auth.html'], (req, res) => {
  res.set('Cache-Control', 'no-cache').type('html').send(req.path === '/auth.html' ? authHtml() : shellHtml())
})

app.use(express.static(PUBLIC, {
  index: false,
  setHeaders: (res, p) => {
    // The SPA imports its view modules by fixed path (no build hashing), so a stale cached module
    // would silently break new features after a deploy. Force JS/CSS/HTML to always revalidate
    // (a 304 when unchanged keeps it fast); let images/fonts cache for a day.
    if (/\.(js|mjs|css|html)$/.test(p)) res.setHeader('Cache-Control', 'no-cache')
    else res.setHeader('Cache-Control', 'public, max-age=86400')
    // Uploaded art (customer/attacker-supplied) is served from the app origin. Neutralize any
    // active content — an uploaded SVG with an inline <script> would otherwise run as us.
    if (/[\\/]uploads[\\/]/.test(p)) {
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; sandbox")
    }
  },
}))

/**
 * The SPA shell, with a cache-busting version stamped into the CSS/JS URLs. The version is the
 * newest mtime of app.css/app.js, so a deploy that changes either forces every browser to fetch
 * the new file instead of serving a stale cached copy (the "unstyled page" failure). Computed
 * once and cached; a manual edit + restart re-reads it.
 */
const assetVersion = () => {
  try {
    const mt = (p) => { try { return statSync(join(PUBLIC, p)).mtimeMs } catch { return 0 } }
    return Math.floor(Math.max(mt('css/app.css'), mt('js/app.js'))).toString(36)
  } catch { return '1' }
}
// Edition: the same codebase ships as 'pro' (full) or 'lite' (a stripped, separately-branded
// invoice-only product). Everything below is env-driven, so pro is untouched when PSC_EDITION is
// unset, and a second deployment becomes a different-looking product with one env block.
const EDITION = process.env.PSC_EDITION === 'lite' ? 'lite' : 'pro'
const BRAND_NAME = process.env.PSC_BRAND_NAME || (EDITION === 'lite' ? 'InkVoice' : 'PrintShopCRM')
const BRAND_TAG = process.env.PSC_BRAND_TAG || (EDITION === 'lite'
  ? 'Estimates & invoices for print shops — no fuss.'
  : "The print shop management system that doesn't need a separate CRM")
const BRAND_ACCENT = process.env.PSC_BRAND_ACCENT || (EDITION === 'lite' ? '#2563eb' : '')
// A rounded-square favicon in the brand accent with the brand's first initial.
const faviconFor = (accent, letter) => `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='${accent}'/><text x='16' y='23' font-size='18' font-family='sans-serif' font-weight='bold' text-anchor='middle' fill='#fff'>${letter}</text></svg>`)}`
// Lite is light-first with a blue accent (a clean, FunnelCtrl-style look). Overriding the CSS var
// re-skins every accented element — buttons, links, the brand dot — in one place.
const editionCss = () => {
  if (EDITION !== 'lite') return ''
  const a = BRAND_ACCENT, a2 = '#3b82f6'
  return `:root[data-theme="light"]{--accent:${a};--accent-2:${a2};--accent-dim:${a};--accent-glow:rgba(37,99,235,.12);--accent-ink:#ffffff}`
    + `:root[data-theme="dark"]{--accent:${a2};--accent-2:#60a5fa;--accent-glow:rgba(59,130,246,.16)}`
}
/**
 * Optional "hosted by" credit in the sidebar, for operators who run this for other people.
 *
 * Off unless PSC_HOST_BADGE_TEXT is set, so a self-hosted install shows nothing and carries no
 * third-party branding. Set both vars to credit whoever runs the box:
 *   PSC_HOST_BADGE_TEXT="Hosted by MerchTroop"
 *   PSC_HOST_BADGE_URL="https://printshopcrm.com/hosting"
 */
const htmlEscape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
// Only http(s) — an operator-supplied javascript: or data: URL would be a stored XSS vector.
const safeHttpUrl = (u) => (/^https?:\/\//i.test(String(u || '').trim()) ? String(u).trim() : '')

const HOST_BADGE_TEXT = String(process.env.PSC_HOST_BADGE_TEXT || '').trim()
const HOST_BADGE_URL = String(process.env.PSC_HOST_BADGE_URL || '').trim()
const hostBadgeHtml = () => {
  if (!HOST_BADGE_TEXT) return ''
  const safeUrl = safeHttpUrl(HOST_BADGE_URL)
  const label = htmlEscape(HOST_BADGE_TEXT)
  return safeUrl
    ? `<a class="host-badge" href="${htmlEscape(safeUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>`
    : `<div class="host-badge">${label}</div>`
}

/**
 * AGPL §13 — Remote Network Interaction.
 *
 * This app is licensed under the AGPL and is used over a network, so every user interacting with
 * it remotely must be offered the Corresponding Source of the version actually running. That is a
 * licence obligation, not a courtesy, and it is why this link is always rendered and has no "off"
 * switch — only a way to point it somewhere truthful.
 *
 * IF YOU MODIFY THIS SOFTWARE AND RUN IT FOR OTHER PEOPLE, set PSC_SOURCE_URL to a public
 * repository containing YOUR modified source. Leaving it pointing at upstream while running
 * patched code does not satisfy §13.
 */
const SOURCE_URL = safeHttpUrl(process.env.PSC_SOURCE_URL) || 'https://github.com/ColeLundstrom/printshopcrm'
const sourceLinkHtml = () =>
  `<a class="source-link" href="${htmlEscape(SOURCE_URL)}" target="_blank" rel="noopener noreferrer"
      title="This software is free and open source (AGPL-3.0). Click for the source code.">Source · AGPL-3.0</a>`

let SHELL_HTML = null
const shellHtml = () => {
  if (SHELL_HTML) return SHELL_HTML
  const raw = readFileSync(join(PUBLIC, 'index.html'), 'utf8')
  SHELL_HTML = raw
    .replaceAll('__ASSET_V__', assetVersion())
    .replaceAll('__EDITION__', EDITION)
    .replaceAll('__HOST_BADGE__', hostBadgeHtml())
    .replaceAll('__SOURCE_LINK__', sourceLinkHtml())
    .replaceAll('__BRAND_NAME__', BRAND_NAME)
    .replaceAll('__BRAND_TAG__', BRAND_TAG)
    .replaceAll('__THEME_FORCE__', EDITION === 'lite' ? 'light' : '')
    .replaceAll('__EDITION_CSS__', editionCss())
    .replaceAll('__FAVICON__', faviconFor(BRAND_ACCENT || '#10d39a', (BRAND_NAME[0] || 'P').toUpperCase()))
  return SHELL_HTML
}
// The login/signup page (auth.html) is served on its own, so it gets the same brand + a light/blue
// skin in lite. Pro leaves __AUTH_SKIN__ empty, so it renders exactly as before.
const AUTH_SKIN = EDITION === 'lite'
  ? `:root{--bg:#eef2f7;--panel:#ffffff;--line:#e2e8f0;--txt:#1a2233;--dim:#64748b;--accent:${BRAND_ACCENT};--accent2:#3b82f6}`
    + `body{background:radial-gradient(1200px 600px at 70% -10%,#e8eefb 0%,var(--bg) 55%)!important}`
    + `.card{box-shadow:0 20px 60px rgba(37,99,235,.12)}.tabs{background:#f1f5f9}input{background:#f8fafc}.tabs button.on,.btn{color:#fff}`
  : ''
let AUTH_HTML = null
const authHtml = () => {
  if (AUTH_HTML) return AUTH_HTML
  AUTH_HTML = readFileSync(join(PUBLIC, 'auth.html'), 'utf8')
    .replaceAll('__BRAND_NAME__', BRAND_NAME)
    .replaceAll('__SOURCE_LINK__', sourceLinkHtml())
    .replaceAll('__AUTH_SKIN__', AUTH_SKIN)
  return AUTH_HTML
}

/* ================= Payments — edition-aware dispatch ================= */
// Pro shops bring their OWN Stripe key (direct charges, we take nothing). Lite shops (Print Shop
// Control) are onboarded onto our platform via Connect Express and pay a 4% fee on collected
// payments. Every payment call site routes through these three helpers so pro stays byte-identical.
const isLite = EDITION === 'lite'
const paymentsReady = (s) => (isLite ? connectReady(s) : stripeConfigured(s))
const startCheckout = (s, args) => (isLite
  ? createConnectedCheckout({ accountId: s.stripe_account_id, ...args })
  : createCheckout({ settings: s, ...args }))
const confirmSession = (s, sessionId) => (isLite
  ? retrieveConnectedSession({ sessionId })
  : retrieveSession({ settings: s, sessionId }))

if (isLite) {
  // Start (or resume) Express onboarding. Creates the connected account on first call, then returns
  // a one-time Stripe-hosted onboarding link the shop follows. Owner-only. Explicit try/catch (not
  // wrap()) so a Stripe rejection returns 500 instead of crashing the process.
  app.post('/api/stripe/connect', requireRole('owner'), async (req, res) => {
    try {
      const s = getSettings()
      let acct = s.stripe_account_id
      if (!acct) {
        acct = await createExpressAccount({ email: s.shop_email, shopName: s.shop_name, slug: curSlug() })
        setSetting('stripe_account_id', acct)
      }
      const origin = `${req.protocol}://${req.get('host')}`
      const url = await createAccountLink({ accountId: acct, origin })
      res.json({ url })
    } catch (e) { console.error('stripe-connect:', e.message); res.status(500).json({ error: e.message }) }
  })

  // Poll the connected account and cache whether it can take charges yet. Owner-only.
  app.get('/api/stripe/connect/status', requireRole('owner'), async (_req, res) => {
    try {
      const s = getSettings()
      if (!s.stripe_account_id) return res.json({ connected: false, charges_enabled: false })
      const a = await getConnectAccount({ accountId: s.stripe_account_id })
      setSetting('stripe_charges_enabled', a.charges_enabled ? '1' : '')
      res.json({ connected: true, charges_enabled: a.charges_enabled, details_submitted: a.details_submitted, payouts_enabled: a.payouts_enabled })
    } catch (e) { console.error('stripe-status:', e.message); res.status(500).json({ error: e.message }) }
  })

  // Stripe redirects the shop's browser back here when onboarding finishes. Their session cookie is
  // present (they started from the app), so the gate has set tenantStore and getSettings() hits the
  // right shop db. Cache the charge state, then bounce into the settings screen.
  app.get('/stripe/connect/return', async (_req, res) => {
    try {
      const s = getSettings()
      if (s.stripe_account_id) {
        const a = await getConnectAccount({ accountId: s.stripe_account_id })
        setSetting('stripe_charges_enabled', a.charges_enabled ? '1' : '')
      }
    } catch (e) { console.error('connect-return:', e.message) }
    res.redirect('/#/settings?stripe=connected')
  })

  // Stripe sends the shop here if the onboarding link expired — bounce back to settings to retry.
  app.get('/stripe/connect/refresh', (_req, res) => res.redirect('/#/settings?stripe=refresh'))
}

// The lite edition is a product people have to be sold, so its root is a marketing page rather than
// a redirect to a login box. Signed-in shops still land in the app (the shell below); only anonymous
// visitors to "/" see the pitch. Pro has no landing page, so it is unaffected.
// Lives in templates/, NOT public/ — express.static would otherwise serve /landing.html raw, with
// every __BRAND_NAME__ placeholder visible to anyone (or any crawler) who requested it directly.
const LANDING_FILE = join(ROOT, 'templates', 'landing.html')
let LANDING_HTML = null
const landingHtml = () => {
  if (LANDING_HTML) return LANDING_HTML
  LANDING_HTML = readFileSync(LANDING_FILE, 'utf8')
    .replaceAll('__BRAND_NAME__', BRAND_NAME)
    .replaceAll('__BRAND_TAG__', BRAND_TAG)
    .replaceAll('__ACCENT__', BRAND_ACCENT || '#2563eb')
    .replaceAll('__FAVICON__', faviconFor(BRAND_ACCENT || '#2563eb', (BRAND_NAME[0] || 'P').toUpperCase()))
  return LANDING_HTML
}
const hasLanding = () => EDITION === 'lite' && existsSync(LANDING_FILE)

/**
 * An unknown /api path answers in JSON, whatever the method.
 *
 * The API 404 lived inside the GET-only SPA catch-all, so a PUT, POST, PATCH or DELETE to a path
 * that does not exist fell through to Express's finalhandler and came back as an HTML error page —
 * `Cannot PUT /api/v1/customers/1`, Content-Type text/html — while docs/API.md promises "all
 * responses are JSON". An integrator's JSON.parse throws on the one response shape it was never
 * told about, which reads as a network fault rather than a wrong URL. Seen for real in this repo's
 * own e2e output before the fix.
 */
app.use('/api', (req, res) => res.status(404).json({
  error: `No such endpoint: ${req.method} /api${req.path === '/' ? '' : req.path}`,
  code: 'unknown_endpoint',
  docs: '/docs-api.html',
}))

app.get('/{*any}', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Unknown endpoint', code: 'unknown_endpoint' })
  // Anonymous visitor to the lite root → the sales page. req.tenant is set by the auth gate above.
  if (req.path === '/' && !req.tenant && hasLanding()) {
    return res.set('Cache-Control', 'no-cache').type('html').send(landingHtml())
  }
  // The shell must never be cached itself, so a new deploy's version stamp is always seen.
  res.set('Cache-Control', 'no-cache').type('html').send(shellHtml())
})

if (!existsSync(join(ROOT, 'public', 'index.html'))) console.warn('! public/index.html missing')

// Has the HTTP server actually reached "listening"? This single flag decides whether a stray
// error is survivable or fatal, and the distinction matters more than it looks.
//
// AFTER startup: every tenant shares this one process, so a throw in an after-response callback
// (a delivery bookkeeping write, a timer) must not take the whole fleet down — log and keep serving.
//
// BEFORE startup: the opposite. A failure here means the app never bound a port, so there is no
// event loop work left and Node exits — *with status 0*, because the handler below "handled" it.
// A zero exit is a lie to every supervisor there is: Docker, Fly, Render and any systemd unit with
// Restart=on-failure all read it as "finished successfully" and do not restart or raise an alarm.
// The shop owner sees a container that exited cleanly, no error, and no app. So a startup failure
// exits 1, loudly, with something the operator can act on.
let httpUp = false
// What an operator should DO about it, keyed off the error code. A startup failure a shop owner
// cannot act on is the same as no message at all, and these two account for almost all of them.
// Node may deliver a bind failure either as a synchronous throw from listen() or as an 'error'
// event on the server, so the advice lives here, on the one path both of them reach.
const startupAdvice = (err, port) => {
  if (err?.code === 'EADDRINUSE') {
    return (
      `Port ${port} is already in use.\n` +
      `  Another copy of PrintShopCRM is probably still running — stop it, or start this one\n` +
      `  on a different port:  PORT=8081 npm start`
    )
  }
  if (err?.code === 'EACCES') {
    return (
      `Permission denied binding port ${port}.\n` +
      `  Ports below 1024 need root. Use PORT=8080 and put nginx in front of it.`
    )
  }
  if (err?.code === 'SQLITE_CANTOPEN' || /SQLITE_CANTOPEN|unable to open database/i.test(err?.message || '')) {
    return (
      `The database file could not be opened.\n` +
      `  Check that PSC_DB points somewhere this user can write, and that the directory exists.`
    )
  }
  if (err?.code === 'EROFS' || err?.code === 'EACCES_FS') return 'The data directory is read-only.'
  return null
}
const fatalStartup = (what, err) => {
  console.error(`\n  PrintShopCRM could not start — ${what}`)
  const advice = startupAdvice(err, PORT)
  if (advice) console.error(`\n  ${advice}\n`)
  console.error(`  ${(err && (err.stack || err.message)) || err}\n`)
  process.exit(1)
}
process.on('unhandledRejection', (reason) => {
  if (!httpUp) return fatalStartup('an unhandled rejection during startup', reason)
  console.error('unhandledRejection:', reason && (reason.stack || reason.message || reason))
})
process.on('uncaughtException', (err) => {
  if (!httpUp) return fatalStartup('an uncaught exception during startup', err)
  console.error('uncaughtException:', err && (err.stack || err.message || err))
})
// Graceful shutdown so a deploy drains in-flight work instead of hard-killing it.
let shuttingDown = false
const shutdown = (sig) => {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n  ${sig} — draining…`)
  // Stop accepting, then hang up the live sockets. server.close() waits for EVERY connection to
  // end and an upgraded WebSocket never ends on its own, so a single open browser tab used to
  // carry every deploy all the way to the hard exit below — 8016ms measured, versus 14ms with no
  // tab open — and that hard exit is what severs an in-flight request. The graceful path only
  // existed on paper until the live layer was taught to let go.
  server.close(() => process.exit(0))
  closeRealtime()
  setTimeout(() => process.exit(0), 8000).unref() // never hang a deploy
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

const server = createServer(app)
initRealtime(server, { authEnabled: AUTH_ENABLED, getSessionTenant })
// WS server + HTTP server error listeners, so a socket-level error can't become an uncaught throw.
// A bind failure is not a socket hiccup though — it means we are not serving anyone, so say which
// port and what to do about it, and exit non-zero so the supervisor treats it as the failure it is.
server.on('error', (e) => {
  if (!httpUp) return fatalStartup(`the HTTP server could not start on port ${PORT}`, e)
  console.error('http server error:', e && e.message)
})
// Bound outbound-connection safety: cap how long a request can occupy the process.
server.requestTimeout = 30000
server.headersTimeout = 35000
/**
 * Terminal error handler. Without one, Express answers unexpected throws with its default HTML
 * page — which carries a full stack trace and absolute server paths straight to the browser.
 */
app.use((err, req, res, _next) => {
  console.error('unhandled:', req.method, req.path, err && err.message)
  // A route that throws AFTER it has started writing cannot be given a status any more — but it
  // must still be finished. This returned without res.end(), so the socket stayed open with no FIN
  // and no terminating chunk until the client gave up (measured at 75s on the export path), and
  // every retry leaked another socket, response object and open SQLite cursor. Ending the response
  // is the least a half-written reply is owed; a route that wants to say more about the failure
  // has to do it before this point, as /api/export/all.json now does.
  if (res.headersSent) { try { res.end() } catch { /* already gone */ } return }
  // multer throws a MulterError with a .code but no .status, so an over-size upload fell through to
  // the generic 500 "something went wrong" — when the real, actionable answer is "that file is too
  // big". Map its limit codes to the right status and a message the uploader can act on.
  if (err?.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'That file is too large.' })
    return res.status(400).json({ error: 'That upload was rejected — check the file and try again.' })
  }
  const status = Number(err?.status || err?.statusCode) || 500
  // Deliberate 4xx errors carry a message the caller needs to act on ("url must be http(s)",
  // "unknown event"). Only 5xx gets the generic text — those can leak internals.
  if (status < 500 && err?.expose && err.message) return res.status(status).json({ error: String(err.message).slice(0, 300) })
  res.status(status).json({ error: status === 413 ? 'That upload is too large.' : 'Something went wrong on our end.' })
})

server.listen(...(HOST ? [PORT, HOST] : [PORT]), () => {
  httpUp = true // from here on, a stray throw is survivable — see the note by fatalStartup
  const s = getSettings()
  console.log(`\n  ${s.brand_name} — ${s.brand_tagline}`)
  console.log(`  → http://${HOST || 'localhost'}:${PORT}   (ws /ws live${HOST ? `, bound to ${HOST} only` : ''})\n`)

  // Every link this server emails has to name a host, and without PSC_PUBLIC_URL that host comes
  // from somewhere less trustworthy.
  //
  // This warning used to say all of them come from the request's Host header. That stopped being
  // true when reset and welcome moved to trustedOrigin(), which prefers the origin an owner has
  // actually signed in on — so the account-takeover this warning was written for is closed either
  // way. Saying it anyway trains an operator to discount the warning, and the links it is STILL
  // right about are the ones going to customers. Name those.
  // Rate limiting only works if the client IP is real, and with trust-proxy on it comes from an
  // X-Forwarded-For header the CLIENT can set. That is correct behind nginx, Caddy, Fly or Render,
  // which overwrite it — and it is a hole with nothing in front, because a rotating forged header
  // gives an attacker one fresh bucket per fake IP on signup, password reset, lead capture and the
  // embed chat that spends the shop's own model credit.
  //
  // The default stays 1: flipping it would break https link-building on every existing proxied
  // install that has not set PSC_PUBLIC_URL. So say it instead, and only to the operator who never
  // chose — the documented proxied deployments (fly.toml, render.yaml, the INSTALL .env) all set
  // it explicitly now, so this stays quiet for them and means something when it does appear.
  if (AUTH_ENABLED && app.get('trust proxy') && !String(process.env.PSC_TRUST_PROXY || '').trim()) {
    console.warn('  ⚠ PSC_TRUST_PROXY is on by default, so the client IP is read from the')
    console.warn('     X-Forwarded-For header. If this port is published straight to the internet')
    console.warn('     with nothing in front of it, a caller sets that header themselves and walks')
    console.warn('     past every signup, password-reset, lead-capture and embed-chat rate limit.')
    console.warn('     Behind nginx/Caddy/Fly/Render: set PSC_TRUST_PROXY=1 to silence this.')
    console.warn('     Exposed directly:              set PSC_TRUST_PROXY=0.\n')
  }

  if (AUTH_ENABLED && !String(process.env.PSC_PUBLIC_URL || '').trim()) {
    console.warn('  ⚠ PSC_PUBLIC_URL is not set. Proof-approval, pay and staff-invite links are built')
    console.warn('     from the request Host header, which is chosen by whoever sent the request.')
    console.warn('     (Password-reset and welcome links use the origin your owner signed in on.)')
    console.warn(`     Set it to this install's real address:  PSC_PUBLIC_URL=https://shop.example.com\n`)
  }

  // The fatal check above only fires when PSC_AUTH is set — and the commonest way to get here
  // wrongly is that NOTHING in the environment was read. `node server.mjs` does not load .env
  // (only the npm scripts pass --env-file-if-exists), so a self-hoster who wrote a .env and
  // started the app that way got: no login, the database inside the app directory, and this
  // in-repo secret — which is published on GitHub, so every estimate, pay, proof and work-ticket
  // link is forgeable by anyone who can count. Say both things out loud, every boot.
  if (SECRET === 'preview-secret-change-in-prod') {
    console.warn('  ⚠ PSC_SECRET is the built-in development value, which is public in the source.')
    console.warn('     Every customer link this install signs can be forged. Set PSC_SECRET before anyone real uses it.')
    if (!AUTH_ENABLED) console.warn('     (If you meant to load a .env, start with `npm start` — `node server.mjs` does not read it.)')
    console.warn('')
  }
  if (!AUTH_ENABLED) {
    console.warn('  ⚠ PSC_AUTH is not set, so there is NO LOGIN — anyone who can reach this port has full access,')
    console.warn('     including the whole API. That is fine on a private machine and nowhere else. Set PSC_AUTH=1.\n')
  }

  // Touch every shop's database once, now. A migration that throws on one shop's real data is
  // discovered HERE — at deploy time, where /health reports it and ship.sh can roll back —
  // instead of on that shop's first request tomorrow morning, invisibly. These are the same
  // handles the automation tick opens moments later, so it costs nothing extra. It must never be
  // fatal: one bad shop cannot be allowed to stop the process serving all the others.
  if (AUTH_ENABLED) {
    for (const slug of activeTenantSlugs()) {
      try { openTenantDb(slug) } catch (e) {
        console.error(`  ⚠ shop database unavailable: ${slug} — ${(e && e.message) || e}`)
      }
    }
    if (brokenTenants.size) {
      console.error(`  ⚠ ${brokenTenants.size} shop(s) cannot open their database. /health is reporting 503 until they can.\n`)
    }
  }

  // Time-based automations. Printavo sells these as a top-tier feature; here it's a loop.
  // Each timed trigger checks the run log before firing, so restarting won't re-nag anyone.
  const TICK_MS = Number(process.env.PSC_TICK_MS) || 5 * 60 * 1000

  // Housekeeping that belongs on a daily cadence rather than every tick. In-process only: a
  // restart just means the sweep runs once more than strictly needed, which is harmless.
  let lastDailySweep = 0
  const dueForDailySweep = () => Date.now() - lastDailySweep > 24 * 60 * 60 * 1000
  const markDailySweepDone = () => { lastDailySweep = Date.now() }
  const runTick = async () => {
    try {
      if (AUTH_ENABLED) purgeExpiredSessions() // keep control.db's sessions table from growing forever
      // In lite, automations ARE the $99 Print Shop Control Automation tier, so the tick runs only
      // for shops on that plan (plus live trials). Free and $40 shops keep a fully manual tool —
      // their seeded rules stay inert. Lite also skips the platform marketing drip below.
      if (AUTH_ENABLED) {
        // Multi-tenant: the tick must run INSIDE each shop's own database, or it hits the empty
        // default db and no shop's time-based automations ever fire. Iterate every eligible tenant.
        // node:sqlite is SYNCHRONOUS, so this loop used to hold the event loop for the SUM of
        // every shop's tick — nothing else in the process ran, for any tenant, until it finished.
        // Measured ~8ms per modest shop: 1000 shops froze the whole fleet for ~8s every 5 minutes,
        // and one shop that had just CSV-imported years of history pushed a single pass past 6
        // minutes. Yielding doesn't reduce total CPU; it converts one long outage into interleaved
        // work, so a request arriving mid-tick waits for ONE shop's tick instead of all of them.
        let total = 0
        let qboPushed = 0
        let pruned = 0
        // Decide ONCE, before the loop. Two bugs lived in asking per-shop and marking after:
        // markDailySweepDone() below sat OUTSIDE the `if`, so it reset the clock on EVERY 5-minute
        // tick and dueForDailySweep() was therefore only ever true on the first tick after boot —
        // the retention sweep ran once per process lifetime and then never again, on the
        // multi-tenant path that every real install runs. And re-evaluating it per shop meant a
        // pass that crossed the 24h boundary swept some shops and not others.
        const sweepDue = dueForDailySweep()
        for (const slug of automationTenantSlugs({ lite: EDITION === 'lite' })) {
          try { total += withTenant(slug, () => tick(autoDeps)).length }
          catch (e) { console.error(`  tick failed for ${slug}:`, e.message) }
          // Webhook history retention. Once a day, not every tick — it's housekeeping, and on a
          // large fleet running it every 5 minutes is a lot of scanning for nothing.
          if (sweepDue) {
            try { pruned += withTenant(slug, () => pruneWebhookDeliveries()) }
            catch (e) { console.error(`  webhook prune failed for ${slug}:`, e.message) }
          }
          // QBO reconciliation queue: retries are network-bound and awaited, so they don't
          // extend the synchronous per-shop tick — the event loop stays free during each push.
          try { qboPushed += await withTenant(slug, () => processQboQueue()) }
          catch (e) { console.error(`  qbo queue failed for ${slug}:`, e.message) }
          // Durable webhook retries: re-attempt any delivery whose backoff has elapsed. A retry
          // used to be an in-process timer that a deploy dropped; now it survives a restart.
          try { withTenant(slug, () => retryDueWebhooks()) }
          catch (e) { console.error(`  webhook retry failed for ${slug}:`, e.message) }
          await new Promise((r) => setImmediate(r)) // hand the event loop back between shops
        }
        if (total) console.log(`  automations: ${total} fired across tenants`)
        if (qboPushed) console.log(`  qbo: ${qboPushed} invoice(s) synced`)
        if (pruned) console.log(`  webhook history: ${pruned} old deliver{y,ies} pruned`)
        if (sweepDue) markDailySweepDone() // only when it actually swept
      } else if (EDITION !== 'lite') {
        const fired = tick(autoDeps)
        if (fired.length) console.log(`  automations: ${fired.length} fired — ${fired.slice(0, 4).join(', ')}`)
        await processQboQueue().catch((e) => console.error('  qbo queue failed:', e.message))
        try { retryDueWebhooks() } catch (e) { console.error('  webhook retry failed:', e.message) }
        if (dueForDailySweep()) {
          const n = pruneWebhookDeliveries()
          if (n) console.log(`  webhook history: ${n} old deliveries pruned`)
          markDailySweepDone()
        }
      }
      // Platform-level: fire any due marketing nurture emails (approved by Cole 2026-07-27; re-enabled
      // 2026-07-28 after a review pause). Not a per-tenant concern, so it runs once per tick. This is
      // the pro funnel's drip — lite is a separate product with its own list, so it stays out.
      if (AUTH_ENABLED && EDITION !== 'lite') runNurtureDrip().then((r) => { if (r.sent) console.log(`  nurture: ${r.sent} drip email(s) sent`) }).catch((e) => console.error('  nurture drip failed:', e.message))
    } catch (e) { console.error('  automation tick failed:', e.message) }
  }
  // The tick now yields, so a slow pass can still be running when the next interval fires. Without
  // this guard the passes would overlap and pile up on exactly the fleets that are already slow.
  let tickRunning = false
  const runTickGuarded = async () => {
    if (tickRunning) { console.log('  automation tick still running — skipping this interval'); return }
    tickRunning = true
    try { await runTick() } finally { tickRunning = false }
  }
  setTimeout(runTickGuarded, 4000).unref?.()
  setInterval(runTickGuarded, TICK_MS).unref?.()

  // Warm the AI availability check off the request path, so Autopilot's first run doesn't
  // pay the model-probe latency (and stays instant when the model is offline).
  aiStatus(true).catch(() => {})
})
