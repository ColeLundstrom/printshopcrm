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
import { relayConfigured, sendViaRelay } from './relay.mjs'

let smtpCache = { key: '', tx: null }

const smtpCreds = (s) => ({
  host: process.env.SMTP_HOST || s?.smtp_host || '',
  port: Number(process.env.SMTP_PORT || s?.smtp_port || 587),
  user: process.env.SMTP_USER || s?.smtp_user || '',
  pass: process.env.SMTP_PASS || s?.smtp_pass || '',
  from: process.env.SMTP_FROM || s?.smtp_from || s?.shop_email || '',
  secure: String(process.env.SMTP_SECURE ?? s?.smtp_secure ?? '') === 'true' || Number(s?.smtp_port) === 465,
})

const twilioCreds = (s) => ({
  sid: process.env.TWILIO_SID || s?.twilio_sid || '',
  token: process.env.TWILIO_TOKEN || s?.twilio_token || '',
  from: process.env.TWILIO_FROM || s?.twilio_from || '',
})

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
const GHL_BASE = 'https://services.leadconnectorhq.com'
const ghlCreds = () => ({
  token: process.env.GHL_PIT || '',
  locationId: process.env.GHL_LOCATION_ID || '',
  from: process.env.GHL_EMAIL_FROM || '',
})
// `from` counts as part of the credential set: without a verified sender the relay is accepted by
// config but rejected by the provider, which looks like mail silently vanishing.
export function platformEmailConfigured() { const c = ghlCreds(); return !!(c.token && c.locationId && c.from) }

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

/** A reusable SMTP transport, rebuilt only when the credentials change. */
function transport(s) {
  const c = smtpCreds(s)
  // The key MUST include the password (fingerprinted) — two shops on the same host with the same
  // username (e.g. both use "apikey" for Postmark/SendGrid) would otherwise share one cached
  // transport and one shop would send through the OTHER shop's credentials.
  const passFp = crypto.createHash('sha256').update(String(c.pass)).digest('hex').slice(0, 12)
  const key = `${c.host}:${c.port}:${c.user}:${c.secure}:${passFp}`
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
        host: c.host,
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
 * Deliver an email. Returns { delivered, via, id?, error? }. Never throws — a failed send
 * degrades to a logged message, exactly like having no credentials at all.
 */
export async function sendEmail({ to, subject, body, settings, html, platform, toName }) {
  if (!to) return { delivered: false, via: 'logged', error: 'no recipient' }
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
    const info = await transport(settings).sendMail({
      from: c.from ? `${settings?.shop_name || 'Print Shop'} <${c.from}>` : c.user,
      to, subject: subject || '(no subject)',
      text: body || '',
      html: html || textToHtml(body || ''),
    })
    return { delivered: true, via: 'smtp', id: info.messageId }
  } catch (e) {
    return { delivered: false, via: 'error', error: String(e.message || e).slice(0, 200) }
  }
}

/**
 * Deliver an SMS through Twilio's REST API with plain fetch (no SDK). Returns the same
 * shape as sendEmail. A Messaging Service SID (MG...) or a From number both work.
 */
export async function sendSms({ to, body, settings }) {
  if (!to) return { delivered: false, via: 'logged', error: 'no recipient' }
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
export async function verifyEmail(settings) {
  if (!emailConfigured(settings)) return { ok: false, error: 'SMTP not configured' }
  try { await transport(settings).verify(); return { ok: true } }
  catch (e) { return { ok: false, error: String(e.message || e).slice(0, 200) } }
}
