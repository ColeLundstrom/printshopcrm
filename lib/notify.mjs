/**
 * Real delivery: email over SMTP and SMS over Twilio.
 *
 * Same honesty rule as the rest of the app — every message is ALWAYS logged to the outbox,
 * and delivery is attempted only when the shop has wired credentials. With no credentials
 * the message still records (nothing silently vanishes), tagged as "logged" rather than
 * "delivered", so the UI can tell the truth about what actually left the building.
 *
 * Credentials live in the shop's own settings (never ours):
 *   SMTP:   smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from, smtp_secure
 *   Twilio: twilio_sid, twilio_token, twilio_from   (a +E.164 number or a Messaging Service SID)
 */
import nodemailer from 'nodemailer'
import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import net from 'node:net'
import { relayConfigured, sendViaRelay } from './relay.mjs'
import { isBlockedIp } from './webhook.mjs'

let smtpCache = { key: '', tx: null }

/**
 * The SHOP'S own credentials win, and they are taken as a SET.
 *
 * These read `process.env.SMTP_HOST || s?.smtp_host` — env FIRST — which inverts both the
 * docstring above and .env.example, where the server-wide values are described as "a fallback".
 * On a multi-tenant box one SMTP_HOST in the operator's .env sent EVERY shop's customer mail
 * through the operator's server, as the operator's address, including shops that had wired their
 * own domain in Settings and could see it listed there as connected. Measured with two SMTP
 * catchers: the shop's own server received nothing and the operator's received the mail. It is
 * the same defect lib/suppliers.mjs:178 already argues against for distributor accounts.
 *
 * Atomic, because a credential set is not a pile of independent strings: taking the shop's host
 * with the operator's password authenticates the wrong account against the wrong server. A shop
 * that has host + user + pass of its own is fully self-hosted for mail; anything less falls back
 * to the server-wide values exactly as before, which is what a single-tenant self-host relies on.
 */
export const smtpCreds = (s) => {
  const own = { host: String(s?.smtp_host || '').trim(), user: String(s?.smtp_user || '').trim(), pass: String(s?.smtp_pass || '') }
  if (own.host && own.user && own.pass) {
    return {
      host: own.host,
      port: Number(s?.smtp_port || 587),
      user: own.user,
      pass: own.pass,
      from: s?.smtp_from || s?.shop_email || '',
      secure: String(s?.smtp_secure ?? '') === 'true' || Number(s?.smtp_port) === 465,
      shopHost: true,
      replyTo: '',
    }
  }
  const port = Number(process.env.SMTP_PORT || s?.smtp_port || 587)
  // The operator's relay. On a multi-tenant install the From must be the OPERATOR's sender: this
  // read `SMTP_FROM || s.smtp_from || s.shop_email`, and both of those are fields any shop manager
  // can PUT — so with SMTP_FROM unset, every shop could send mail authenticated by the operator's
  // account as any address it liked. The shop's own address goes in Reply-To instead, which is the
  // pattern lib/relay.mjs uses, so customer replies still reach the shop. A single-tenant install
  // IS the operator, so its Settings address keeps working there.
  const operatorRelay = !!process.env.SMTP_HOST
  const relayLocked = operatorRelay && multiTenant()
  const operatorFrom = process.env.SMTP_FROM || process.env.SMTP_USER || ''
  const shopAddress = relayLocked ? oneRecipient(s?.smtp_from || s?.shop_email || '') : ''
  return {
    host: process.env.SMTP_HOST || s?.smtp_host || '',
    port,
    // Operator credentials only ever travel to the operator's own host. With SMTP_USER/PASS set
    // and SMTP_HOST left blank, this paired the operator's password with a host the SHOP typed,
    // and a shop pointing smtp_host at a server it runs would be handed that password on AUTH.
    user: operatorRelay ? (process.env.SMTP_USER || s?.smtp_user || '') : (s?.smtp_user || ''),
    pass: operatorRelay ? (process.env.SMTP_PASS || s?.smtp_pass || '') : (s?.smtp_pass || ''),
    from: relayLocked ? operatorFrom : (process.env.SMTP_FROM || s?.smtp_from || s?.shop_email || ''),
    replyTo: shopAddress && shopAddress !== operatorFrom ? shopAddress : '',
    // Operator env SMTP_HOST is trusted; a host that came from the shop's settings is not.
    shopHost: !operatorRelay,
    // …derived from the port we actually connect on. This read `s?.smtp_port` — the SHOP's setting
    // — while the port came from process.env.SMTP_PORT, so the documented env config for the
    // commonest implicit-TLS port (SMTP_PORT=465, no SMTP_SECURE) produced secure:false.
    // nodemailer then opens a plaintext socket against a TLS-only listener: every send burns the
    // connection timeout and fails, on a self-host that configured mail exactly as the docs say.
    // The shop branch above has always derived this from its own port.
    secure: String(process.env.SMTP_SECURE ?? s?.smtp_secure ?? '') === 'true' || port === 465,
  }
}

const multiTenant = () => process.env.PSC_AUTH === '1'

/**
 * May a shop-configured SMTP host resolve to a private / loopback / link-local address?
 *
 * Not on a multi-tenant install: smtp_host and smtp_port are fields any shop manager can PUT, and
 * "Verify SMTP" connected to whatever they named — so any shop could port-scan the server's own
 * network (127.0.0.1:22 answered with the SSH banner) and reach the cloud metadata address. A
 * single-tenant self-host (PSC_AUTH unset) owns its network, and a LAN relay is a normal setup
 * there, so it stays allowed by default. PSC_SMTP_ALLOW_PRIVATE=1 is the operator's escape hatch
 * for a multi-tenant box whose relay really is on the LAN; =0 forces the check on a single shop.
 */
export const smtpPrivateAllowed = () => {
  const v = String(process.env.PSC_SMTP_ALLOW_PRIVATE ?? '').trim().toLowerCase()
  if (v === '1' || v === 'true') return true
  if (v === '0' || v === 'false') return false
  return !multiTenant()
}

const SMTP_BLOCKED = 'That SMTP server points at a private or internal network address, which this server does not allow. Use your mail provider’s public SMTP host.'
const blockedErr = () => Object.assign(new Error(SMTP_BLOCKED), { code: 'smtp_host_blocked' })

/**
 * Resolve a shop-supplied SMTP host and return the ONE address to connect to, or throw
 * smtp_host_blocked. Same rule, and the same reason for returning the vetted IP rather than a
 * yes/no, as assertPublicUrl in lib/webhook.mjs: a DNS-rebind server answers a public IP here and
 * 127.0.0.1 a moment later, so the connection is pinned to the address that was checked.
 */
export async function vetSmtpHost(host, { resolver = dns } = {}) {
  const h = String(host || '').trim().replace(/^\[|\]$/g, '')
  const lo = h.toLowerCase()
  if (!h || lo === 'localhost' || lo.endsWith('.localhost')) throw blockedErr()
  const ips = net.isIP(h) ? [h] : (await resolver.lookup(h, { all: true })).map((r) => r.address)
  if (!ips.length || ips.some(isBlockedIp)) throw blockedErr()
  return ips[0]
}

/**
 * Settings-time check: the message to show for a host that may not be saved, or ''. A name that
 * does not resolve right now is not refused here (a DNS blip must not block saving the rest of
 * Settings); the connect-time check in transport() still applies to every send and verify.
 */
export async function smtpHostProblem(host, { resolver = dns } = {}) {
  if (!String(host || '').trim() || smtpPrivateAllowed()) return ''
  try { await vetSmtpHost(host, { resolver }); return '' }
  catch (e) { return e?.code === 'smtp_host_blocked' ? e.message : '' }
}

/**
 * What a shop is told when SMTP fails. Never the remote server's own words: those are whatever
 * the far end chose to say, and echoing them made "Verify SMTP" a banner grabber for any port on
 * any host. The nodemailer error code is ours, safe, and enough to diagnose with.
 */
export const smtpFailure = (e) => {
  if (e?.code === 'smtp_host_blocked') return SMTP_BLOCKED
  if (e?.code === 'EAUTH') return 'The SMTP server rejected the username or password (EAUTH).'
  if (e?.code === 'EENVELOPE') return 'The SMTP server refused the sender or recipient address (EENVELOPE).'
  if (e?.code === 'EMESSAGE') return 'The SMTP server refused the message (EMESSAGE).'
  const code = /^E[A-Z]{2,20}$/.test(String(e?.code || '')) ? ` (${e.code})` : ''
  return `Could not connect to the SMTP server${code}. Check the host, port and security setting.`
}

/** Same rule for Twilio: a shop with its own account is billed on its own account. */
export const twilioCreds = (s) => {
  const own = { sid: String(s?.twilio_sid || '').trim(), token: String(s?.twilio_token || '').trim(), from: String(s?.twilio_from || '').trim() }
  if (own.sid && own.token && own.from) return own
  return {
    sid: process.env.TWILIO_SID || s?.twilio_sid || '',
    token: process.env.TWILIO_TOKEN || s?.twilio_token || '',
    from: process.env.TWILIO_FROM || s?.twilio_from || '',
  }
}

/**
 * A display name is a display name, not a second address.
 *
 * `${settings?.shop_name} <${c.from}>` was raw interpolation of a field any manager can PUT. Set
 * shop_name to `Alpha Tees <ceo@beta-prints.test>` and the header became
 * `Alpha Tees <ceo@beta-prints.test> <orders@alpha.test>`; the parser takes the FIRST angle-addr,
 * so the envelope sender measured off the wire was `MAIL FROM:<ceo@beta-prints.test>` and the
 * shop's own configured address was demoted into the display name. On a shared operator relay
 * that is one shop sending as another; on the shop's own server it is mail leaving with SPF
 * alignment for a domain nobody checked. CR and LF are stripped for the same reason — a display
 * name must not be able to add a header.
 *
 * lib/relay.mjs:59 has always done this correctly; this path never did.
 */
const displayName = (n) => String(n || 'Print Shop').replace(/["\\<>\r\n]/g, '').trim().slice(0, 78) || 'Print Shop'

export function emailConfigured(s) { const c = smtpCreds(s); return !!(c.host && c.user && c.pass) }
export function smsConfigured(s) { const c = twilioCreds(s); return !!(c.sid && c.token && c.from) }

/**
 * Optional platform email relay via GoHighLevel (LeadConnector). This carries PLATFORM
 * transactional mail only — the welcome/onboarding messages a brand-new shop needs before it has
 * configured any mail of its own. Shop→customer mail NEVER routes here: that would send from the
 * wrong brand and pull another shop's customers into the operator's CRM.
 *
 * Off unless GHL_PIT + GHL_LOCATION_ID are both set. Self-hosters normally leave it unset and use
 * SMTP (or PSC_POSTMARK_TOKEN / PSC_RESEND_KEY) instead — see .env.example. GHL_EMAIL_FROM has no
 * default on purpose: it must be an address on a domain YOU have verified with the provider.
 */
// Overridable so the platform relay can be pointed at a stub and actually TESTED. Every send on
// this path — the password-reset link above all — was previously unassertable without calling the
// real provider from a test suite, which is a thing no gate should ever do.
const GHL_BASE = String(process.env.GHL_BASE || 'https://services.leadconnectorhq.com').replace(/\/$/, '')
const ghlCreds = () => ({
  token: process.env.GHL_PIT || '',
  locationId: process.env.GHL_LOCATION_ID || '',
  from: process.env.GHL_EMAIL_FROM || '',
})
// `from` counts as part of the credential set: without a verified sender the relay is accepted by
// config but rejected by the provider, which looks like mail silently vanishing.
export function platformEmailConfigured() { const c = ghlCreds(); return !!(c.token && c.locationId && c.from) }

/**
 * Can this install deliver PLATFORM mail — a password reset, a welcome, a staff invite — by ANY
 * route? Mirrors sendEmail({ platform: true }) exactly: server-wide SMTP first, then GHL, then the
 * Postmark/Resend relay.
 *
 * The forgot-password route gated on platformEmailConfigured() alone, which asks only whether
 * GoHighLevel is wired up. So an install configured the way .env.example documents — SMTP_HOST /
 * SMTP_USER / SMTP_PASS — was told "this install has no email configured, so a reset link cannot
 * be sent", and its locked-out owner was pushed to a shell command on a server that would have
 * mailed the reset perfectly well. Two of the three supported ways to configure platform mail
 * were invisible to the one check that decides whether anyone can get back in.
 */
export function platformEmailDeliverable() {
  return emailConfigured({}) || platformEmailConfigured() || relayConfigured()
}

async function ghlFetch(path, opts = {}) {
  const { token } = ghlCreds()
  const res = await fetch(`${GHL_BASE}${path}`, {
    signal: AbortSignal.timeout(12000),
    ...opts,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json', Version: '2021-07-28', ...(opts.headers || {}) },
  })
  const text = await res.text()
  let json; try { json = JSON.parse(text) } catch { json = { raw: text } }
  if (!res.ok) { const e = new Error(`GHL ${res.status}: ${path}`); e.status = res.status; e.body = json; throw e }
  return json
}

/** Send a platform email through GHL. Upserts the recipient as a contact (a new SaaS lead — desired
 *  for onboarding), then queues an Email message from our printshopcrm.com domain. */
async function sendViaGhl({ to, toName, subject, html, body }) {
  const c = ghlCreds()
  const [firstName, ...rest] = String(toName || '').trim().split(/\s+/)
  const up = await ghlFetch('/contacts/upsert', {
    method: 'POST',
    body: JSON.stringify({ locationId: c.locationId, email: to, ...(firstName ? { firstName, lastName: rest.join(' ') } : {}) }),
  })
  const contactId = up.contact?.id || up.id
  if (!contactId) throw new Error('GHL upsert returned no contact id')
  const r = await ghlFetch('/conversations/messages', {
    method: 'POST',
    body: JSON.stringify({ type: 'Email', contactId, subject: subject || '(no subject)', html: html || textToHtml(body || ''), emailFrom: c.from, emailTo: to }),
  })
  return { delivered: true, via: 'ghl', id: r.emailMessageId || r.messageId }
}

/** Reusable platform sender (welcome, staff invite, nurture drip). Sends from printshopcrm.com via
 *  GHL when configured; returns {delivered} without throwing so a caller's loop never dies on one send. */
export async function sendPlatformEmail({ to, toName, subject, html, body }) {
  if (!to || !platformEmailConfigured()) return { delivered: false, via: 'logged' }
  try { return await sendViaGhl({ to, toName, subject, html, body }) }
  catch (e) { return { delivered: false, via: 'error', error: String(e.message || e).slice(0, 200) } }
}

/**
 * Capture a not-yet-ready visitor from the marketing site: upsert them as a tagged GHL contact so
 * they're never lost (the whole point — a landing-page view with no signup used to vanish), then
 * send one immediate nurture email with the trial link. Longer multi-touch drip is a GHL workflow
 * attached to the tag. Returns { ok, contactId, emailed }.
 */
export async function captureLead({ email, name, shop, source }) {
  if (!platformEmailConfigured()) return { ok: false, error: 'capture relay not configured' }
  const c = ghlCreds()
  const [firstName, ...rest] = String(name || '').trim().split(/\s+/)
  const tags = ['PrintShopCRM Trial Interest']
  if (source) tags.push(`source-${String(source).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}`)
  const up = await ghlFetch('/contacts/upsert', {
    method: 'POST',
    body: JSON.stringify({
      locationId: c.locationId, email,
      ...(firstName ? { firstName, lastName: rest.join(' ') } : {}),
      ...(shop ? { companyName: shop } : {}),
      tags,
    }),
  })
  const contactId = up.contact?.id || up.id
  if (!contactId) return { ok: false, error: 'GHL upsert returned no contact id' }
  const body = `Hi${firstName ? ' ' + firstName : ''},

Thanks for checking out PrintShopCRM. Here's the short version: it's the CRM, customer inbox, automations, live pricing, production board, proofs, and payments — built for print shops, in one login, so you can cancel the pile of separate subscriptions.

When you're ready, your 30-day free trial is one click (no credit card):
https://pro.printshopcrm.com/signup

Want the deeper walkthrough first? It's all here:
https://printshopcrm.com/#system

Any questions, just reply to this email — a real person reads it.

— The PrintShopCRM team`
  let emailed = false
  try {
    await ghlFetch('/conversations/messages', {
      method: 'POST',
      body: JSON.stringify({ type: 'Email', contactId, subject: 'Your PrintShopCRM trial link (and how it works)', html: textToHtml(body), emailFrom: c.from, emailTo: email }),
    })
    emailed = true
  } catch { /* contact is saved either way; the email is best-effort */ }
  return { ok: true, contactId, emailed }
}

export function notifyStatus(s) {
  return {
    email: emailConfigured(s) || platformEmailConfigured(),
    sms: smsConfigured(s),
    email_from: smtpCreds(s).from || (platformEmailConfigured() ? ghlCreds().from : null),
    sms_from: twilioCreds(s).from || null,
    // Whether mail to CUSTOMERS actually leaves the building. `email` above is true when only the
    // platform relay is configured, but that relay is reserved for our own transactional mail — so a
    // shop with no SMTP saw "Delivery is live" while every estimate it sent silently stayed in the
    // Outbox. This is the honest field for shop→customer delivery.
    shop_email: emailConfigured(s),
    shop_email_from: emailConfigured(s) ? smtpCreds(s).from : null,
  }
}

/**
 * How long any single SMTP step may take. A real mail server answers in well under a second; a
 * misconfigured host is what takes minutes, and the person waiting is an owner trying to fix it.
 * Overridable for the rare slow relay, but never unbounded.
 */
export const smtpTimeoutMs = () => Math.min(60000, Math.max(1000, Number(process.env.PSC_SMTP_TIMEOUT_MS) || 12000))

/**
 * A reusable SMTP transport, rebuilt only when the credentials (or the vetted address) change.
 * A shop-controlled host is resolved and checked on every call, and the transport connects to
 * that exact IP with the original name kept as the TLS servername, so SNI and certificate
 * verification are unchanged.
 */
async function transport(s, { resolver = dns } = {}) {
  const c = smtpCreds(s)
  let connectHost = c.host
  let servername = ''
  if (c.shopHost && !smtpPrivateAllowed()) {
    connectHost = await vetSmtpHost(c.host, { resolver })
    if (!net.isIP(c.host.replace(/^\[|\]$/g, ''))) servername = c.host
  }
  // The key MUST include the password (fingerprinted) — two shops on the same host with the same
  // username (e.g. both use "apikey" for Postmark/SendGrid) would otherwise share one cached
  // transport and one shop would send through the OTHER shop's credentials.
  const passFp = crypto.createHash('sha256').update(String(c.pass)).digest('hex').slice(0, 12)
  const key = `${c.host}:${connectHost}:${c.port}:${c.user}:${c.secure}:${passFp}`
  if (smtpCache.key !== key || !smtpCache.tx) {
    // Bounded, because nothing else bounds it. nodemailer's own defaults are a 2-minute connection
    // timeout and a TEN-minute socket timeout, and sendMail() is awaited inside a request handler.
    // Measured against a blackholed host: 75.0s before the call came back; against a host that
    // accepts the connection and never greets: 30.0s. The screen an owner is on while that happens
    // is Settings -> "Send a test email", which is the exact screen they went to in order to FIX
    // their mail configuration — so the one action that diagnoses the problem was the one that
    // hung. server.requestTimeout only bounds receiving a request, not producing the answer.
    //
    // pool:true as well: without it every message opens its own connection, and one tick against a
    // stalled host opened up to PSC_TICK_BUDGET (100) of them at once.
    smtpCache = {
      key,
      tx: nodemailer.createTransport({
        host: connectHost,
        ...(servername ? { servername, tls: { servername } } : {}),
        port: c.port,
        secure: c.secure,
        auth: { user: c.user, pass: c.pass },
        pool: true,
        maxConnections: 3,
        connectionTimeout: smtpTimeoutMs(),
        greetingTimeout: smtpTimeoutMs(),
        socketTimeout: smtpTimeoutMs(),
      }),
    }
  }
  return smtpCache.tx
}

/**
 * ONE recipient. Always.
 *
 * `to` lands in nodemailer's `to:` and in the relay's `To` — both of which are address-LIST
 * fields, not address fields. Every one of them is fed from `contacts.email`, and not one of the
 * nine doors that writes that column validated it: `str(b.email)` on POST and PUT /api/contacts,
 * a length cap and nothing else on the v1 API, and the anonymous embed insert is raw.
 *
 * So one row reading `a@x.com, b@y.com, c@z.com` is a fan-out, and the shipped, enabled-by-default
 * "New lead nurture" rule fires `email.customer` on `contact.created` — meaning a single
 * `POST /api/contacts` from a *staff* account mails N strangers From: the shop, with the shop's
 * SPF alignment, or on a shop with no SMTP of its own through the PLATFORM's relay. The 300/hour
 * outbound cap counts REQUESTS; without this it would count one request carrying two hundred
 * recipients as one.
 *
 * Newlines are the same bug one layer down: a raw CR/LF in a header field is header injection,
 * which is how a Bcc: gets added to a message the shop composed.
 *
 * Deliberately loose about what an address may CONTAIN. Refusing a real customer's unusual but
 * valid address would be its own failure — a shop watching mail not arrive with nothing to fix.
 * This rejects what makes the value a list or a header, not what makes it exotic.
 */
export const oneRecipient = (v) => {
  const s = String(v ?? '').trim()
  if (!s || s.length > 254) return ''          // RFC 5321 caps the whole path at 254 octets
  if (/[,;<>"\s]/.test(s)) return ''           // list separators, header framing, CR/LF/tab/space
  if (s.split('@').length !== 2) return ''     // exactly one @, and something on both sides
  const [local, domain] = s.split('@')
  if (!local || !domain || !domain.includes('.')) return ''
  return s
}

/**
 * The same rule for a phone number: Twilio's `To` is one destination, not a list.
 *
 * Deliberately tolerant of how a shop actually types a number — `(714) 555-1234`, `+1 714 555
 * 1234` and `714.555.1234` are all things the product already stores on purpose (the receptionist
 * extracts and keeps exactly those shapes). Only the characters that turn one destination into
 * two, or into a header, are refused.
 */
export const oneDestination = (v) => {
  const s = String(v ?? '').trim()
  if (!s || s.length > 32) return ''
  if (/[,;<>"\r\n\t]/.test(s)) return ''
  return /^\+?[\d\s().-]*\d[\d\s().-]*$/.test(s) ? s : ''
}

/**
 * Deliver an email. Returns { delivered, via, id?, error? }. Never throws — a failed send
 * degrades to a logged message, exactly like having no credentials at all.
 */
export async function sendEmail({ to, subject, body, settings, html, platform, toName }) {
  if (!to) return { delivered: false, via: 'logged', error: 'no recipient' }
  // One recipient per message, checked here rather than at each of the nine write doors, because
  // the door that gets added next will not know to check. The refusal is recorded on the outbox
  // row, so the shop sees the reason and can fix the customer and press Send again.
  if (!oneRecipient(to)) {
    return { delivered: false, via: 'error', error: `Not a single valid email address: ${String(to).slice(0, 80)}` }
  }
  // Shop's own SMTP is always preferred so shop→customer mail carries the shop's brand. When a shop
  // has no SMTP, platform transactional mail (welcome/onboarding) still goes out via GHL from our
  // printshopcrm.com domain; ordinary shop mail without SMTP stays logged, as before.
  if (!emailConfigured(settings)) {
    if (platform && platformEmailConfigured()) {
      try { return await sendViaGhl({ to, toName, subject, body, html }) }
      catch (e) { return { delivered: false, via: 'error', error: String(e.message || e).slice(0, 200) } }
    }
    // No shop SMTP. Rather than silently logging shop→customer mail (the #1 trial-death path — the
    // shop thinks the product is broken), relay it through the PLATFORM transactional provider when
    // one is configured. BYO posture is intact: the relay sends AS the shop from a neutral
    // printshopcrm.com address with Reply-To the shop's OWN email, so customer replies land in the
    // shop's inbox, never ours — we relay delivery, we do not route replies into our CRM.
    if (relayConfigured()) {
      const replyTo = settings?.shop_email || smtpCreds(settings).from || ''
      const r = await sendViaRelay({
        to,
        subject,
        html: html || textToHtml(body || ''),
        text: body || '',
        fromName: settings?.shop_name || 'Print Shop',
        ...(replyTo ? { replyTo } : {}),
      })
      if (r.ok) return { delivered: true, via: 'relay', id: r.id }
      // Relay failed — record honestly rather than claiming delivery.
      return { delivered: false, via: 'error', error: r.error || 'relay failed' }
    }
    return { delivered: false, via: 'logged' }
  }
  const c = smtpCreds(settings)
  try {
    const info = await (await transport(settings)).sendMail({
      from: c.from ? `"${displayName(settings?.shop_name)}" <${c.from}>` : c.user,
      ...(c.replyTo ? { replyTo: c.replyTo } : {}),
      to, subject: subject || '(no subject)',
      text: body || '',
      html: html || textToHtml(body || ''),
    })
    return { delivered: true, via: 'smtp', id: info.messageId }
  } catch (e) {
    return { delivered: false, via: 'error', error: smtpFailure(e) }
  }
}

/**
 * Deliver an SMS through Twilio's REST API with plain fetch (no SDK). Returns the same
 * shape as sendEmail. A Messaging Service SID (MG...) or a From number both work.
 */
export async function sendSms({ to, body, settings }) {
  if (!to) return { delivered: false, via: 'logged', error: 'no recipient' }
  if (!oneDestination(to)) {
    return { delivered: false, via: 'error', error: `Not a single valid phone number: ${String(to).slice(0, 80)}` }
  }
  if (!smsConfigured(settings)) return { delivered: false, via: 'logged' }
  const c = twilioCreds(settings)
  try {
    const form = new URLSearchParams({ To: normalizePhone(to), Body: String(body || '').slice(0, 1500) })
    if (c.from.startsWith('MG')) form.set('MessagingServiceSid', c.from)
    else form.set('From', normalizePhone(c.from))
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.sid}/Messages.json`, {
      signal: AbortSignal.timeout(12000),
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${c.sid}:${c.token}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    })
    const data = await res.json().catch(() => ({}))
    if (res.ok) return { delivered: true, via: 'twilio', id: data.sid }
    return { delivered: false, via: 'error', error: (data.message || `Twilio ${res.status}`).slice(0, 200) }
  } catch (e) {
    return { delivered: false, via: 'error', error: String(e.message || e).slice(0, 200) }
  }
}

/** US-centric E.164 nudge: bare 10-digit numbers get a +1. Anything already +prefixed is left alone. */
function normalizePhone(p) {
  const s = String(p || '').trim()
  if (s.startsWith('+')) return s
  const d = s.replace(/\D/g, '')
  if (d.length === 10) return `+1${d}`
  if (d.length === 11 && d.startsWith('1')) return `+${d}`
  return d ? `+${d}` : s
}

const textToHtml = (t) => `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;white-space:pre-wrap">${String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</div>`

/** One-shot connection test used by Settings so a shop can verify creds before relying on them. */
export async function verifyEmail(settings, { resolver = dns } = {}) {
  if (!emailConfigured(settings)) return { ok: false, error: 'SMTP not configured' }
  try { await (await transport(settings, { resolver })).verify(); return { ok: true } }
  catch (e) { return { ok: false, error: smtpFailure(e) } }
}
