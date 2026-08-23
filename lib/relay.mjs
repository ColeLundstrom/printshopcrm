/**
 * Platform transactional email relay.
 *
 * A brand-new trial shop has no SMTP of its own. Today notify.mjs's sendEmail degrades to
 * {delivered:false, via:'logged'} for such shops — the estimate/proof/invoice email never leaves
 * the building, and the shop assumes the product is broken. That silent failure is the #1
 * trial-death path. This module lets the PLATFORM send that mail on the shop's behalf over a
 * hosted transactional provider (Postmark or Resend), with zero shop configuration.
 *
 * BYO posture is preserved. We send FROM a neutral platform address
 *   "<Shop Name> via PrintShopCRM" <shop-<slug>@mail.printshopcrm.com>
 * with Reply-To set to the shop's OWN email, so when the customer hits reply it lands in the
 * shop's inbox — not ours. We relay the delivery; we do NOT route replies into our CRM, and we
 * are never in the middle of the shop↔customer conversation.
 *
 * Provider is auto-selected from whichever env token is present:
 *   Postmark:  PSC_POSTMARK_TOKEN   → POST https://api.postmarkapp.com/email
 *                                     header  X-Postmark-Server-Token: <token>
 *                                     body    { From, To, Subject, HtmlBody, TextBody, ReplyTo }
 *   Resend:    PSC_RESEND_KEY       → POST https://api.resend.com/emails
 *                                     header  Authorization: Bearer <key>
 *                                     body    { from, to, subject, html, text, reply_to }
 *   PSC_RELAY_DOMAIN                → sender base domain (default 'mail.printshopcrm.com')
 */

const RELAY_TIMEOUT_MS = 12000

/** Which platform relay provider is active, if any. Postmark wins when both are set. */
export function relayProvider() {
  if (process.env.PSC_POSTMARK_TOKEN) return 'postmark'
  if (process.env.PSC_RESEND_KEY) return 'resend'
  return null
}

/** True when a platform relay is configured (Postmark or Resend). */
export function relayConfigured() {
  return relayProvider() !== null
}

/** Base domain for the neutral platform sender address. */
function relayDomain() {
  return (process.env.PSC_RELAY_DOMAIN || 'mail.printshopcrm.com').trim() || 'mail.printshopcrm.com'
}

/** Turn a shop name into a stable, address-safe local-part fragment. */
function slugify(name) {
  const s = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return s || 'shop'
}

/**
 * Build the neutral platform From header. Sends AS the shop (display name) from an address we
 * control, so SPF/DKIM align to our verified relay domain and deliverability is ours to keep.
 */
function buildFrom(fromName) {
  const display = String(fromName || 'Print Shop').replace(/["\\]/g, '').trim() || 'Print Shop'
  const local = `shop-${slugify(fromName)}`
  return `"${display} via PrintShopCRM" <${local}@${relayDomain()}>`
}

/**
 * Send one email through the active platform relay. Never throws — returns { ok, id?, error? }
 * so a caller's send loop never dies on one bad message. Reply-To is the shop's own email, so
 * customer replies go to the shop, not to us.
 */
export async function sendViaRelay({ to, subject, html, text, fromName, replyTo }) {
  const provider = relayProvider()
  if (!provider) return { ok: false, error: 'relay not configured' }
  if (!to) return { ok: false, error: 'no recipient' }

  const from = buildFrom(fromName)
  const subj = subject || '(no subject)'

  let url, headers, body
  if (provider === 'postmark') {
    url = 'https://api.postmarkapp.com/email'
    headers = {
      'X-Postmark-Server-Token': process.env.PSC_POSTMARK_TOKEN,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }
    body = {
      From: from,
      To: to,
      Subject: subj,
      ...(html ? { HtmlBody: html } : {}),
      ...(text ? { TextBody: text } : {}),
      ...(replyTo ? { ReplyTo: replyTo } : {}),
      MessageStream: 'outbound',
    }
  } else {
    // resend
    url = 'https://api.resend.com/emails'
    headers = {
      Authorization: `Bearer ${process.env.PSC_RESEND_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }
    body = {
      from,
      to,
      subject: subj,
      ...(html ? { html } : {}),
      ...(text ? { text } : {}),
      ...(replyTo ? { reply_to: replyTo } : {}),
    }
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      headers,
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      // Postmark: { Message, ErrorCode }; Resend: { error: { message } } or { message }
      const msg = data?.Message || data?.error?.message || data?.message || `${provider} ${res.status}`
      return { ok: false, error: String(msg).slice(0, 200) }
    }
    // Postmark returns MessageID; Resend returns id.
    const id = data?.MessageID || data?.id || undefined
    return { ok: true, id }
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) }
  }
}
