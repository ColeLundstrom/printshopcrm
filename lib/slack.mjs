/**
 * Slack — one bot per shop, on the shop's own Slack workspace.
 *
 * The shop creates its own Slack app and pastes the bot token + signing secret into Settings. We
 * never hold a platform-wide Slack app, so one shop's workspace, messages, and rate limits are
 * entirely its own — the same "bring your own credentials" posture as the Stripe key and the AI key.
 *
 * ROUTING: a Slack request carries a team_id, not a login. Rather than scan every tenant's
 * settings looking for a matching team, each shop gets its own request URL keyed by the embed_key
 * it already has (/api/slack/<key>/events). Tenant resolution is then a single indexed lookup, the
 * same trick the gang-sheet embed uses.
 *
 * TIMING: Slack requires a response within 3 seconds and retries anything slower — which would
 * quote the same message two or three times. Every handler therefore acknowledges immediately and
 * does the real work afterwards, posting the result back with chat.postMessage.
 */
import crypto from 'node:crypto'
import { shopFormat } from './db.mjs'

const SLACK_API = 'https://slack.com/api'

export const slackConfigured = (s) => /^xoxb-/.test(String(s?.slack_bot_token || '').trim()) && !!String(s?.slack_signing_secret || '').trim()

/**
 * Verify a request really came from Slack.
 *
 * Two things matter and both are load-bearing: the HMAC must be compared in constant time (a
 * plain === leaks the signature a byte at a time), and the timestamp must be fresh — without the
 * age check a captured request stays replayable against this endpoint forever.
 */
export function verifySlackSignature({ signingSecret, rawBody, timestamp, signature, maxAgeSec = 300 }) {
  const secret = String(signingSecret || '')
  const sig = String(signature || '')
  const ts = String(timestamp || '')
  if (!secret || !sig || !/^\d+$/.test(ts)) return false
  if (Math.abs(Date.now() / 1000 - Number(ts)) > maxAgeSec) return false // stale — replay
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '')
  const mine = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')
  const a = Buffer.from(mine), b = Buffer.from(sig)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/** Post a message. Threads under the triggering message when thread_ts is given. */
export async function postMessage({ token, channel, text, blocks, thread_ts, plain = false }) {
  const r = await fetch(`${SLACK_API}/chat.postMessage`, {
    signal: AbortSignal.timeout(10000),
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ channel, text, ...(plain ? {mrkdwn:false,parse:'none',unfurl_links:false,unfurl_media:false} : {}), ...(blocks ? { blocks } : {}), ...(thread_ts ? { thread_ts } : {}) }),
  })
  const j = await r.json().catch(() => ({}))
  if (!j.ok) throw new Error(`slack chat.postMessage: ${j.error || r.status}`)
  return j
}

/** Confirm a pasted bot token actually works, and say which workspace it belongs to. */
export async function testAuth(token) {
  try {
    const r = await fetch(`${SLACK_API}/auth.test`, { signal: AbortSignal.timeout(10000), method: 'POST', headers: { Authorization: `Bearer ${token}` } })
    const j = await r.json().catch(() => ({}))
    return j.ok ? { ok: true, team: j.team, bot: j.user, team_id: j.team_id } : { ok: false, error: j.error || 'unknown_error' }
  } catch (e) { return { ok: false, error: e.message } }
}

/**
 * Strip Slack's markup back to the plain text a parser can read: <@U123> mentions, <#C1|general>
 * channel refs, <http://x|label> links, and the HTML entities Slack escapes on the way in. Left
 * alone, an "&amp;" or a link wrapper ends up inside a quantity or a garment name.
 */
export function slackToPlain(text) {
  return String(text || '')
    // Decode first: doing this last meant decoded markup slipped past every rule below.
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/<@[UW][A-Z0-9]+(\|[^>]*)?>/g, ' ')          // user mention
    .replace(/<!subteam\^[A-Z0-9]+(\|[^>]*)?>/g, ' ')      // group mention
    .replace(/<!(here|channel|everyone)(\|[^>]*)?>/g, ' ')  // broadcast
    .replace(/<#[A-Z0-9]+(?:\|([^>]*))?>/g, '$1')          // channel ref, label optional
    .replace(/<(?:mailto|tel):([^|>]+)(?:\|[^>]*)?>/g, '$1') // Slack auto-links every email
    .replace(/<(https?:[^|>]+)\|([^>]*)>/g, '$2')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * Pull the first email address out of a message so the quote lands on the right customer.
 *
 * Every quantifier here is BOUNDED, for the same reason lib/agent.mjs:190 is. The unbounded
 * `[\w.+-]+@[\w-]+(?:\.[\w-]+)*` backtracks quadratically on a long run of word characters that
 * never resolves into an address — which is what an ordinary forwarded email thread looks like.
 * Measured on the shipped pattern: 319ms at 20KB, 2.7s at 60KB, 11s at 120KB, all of it holding
 * the single Node event loop, so every other shop on the box waits. Round 1 fixed exactly this in
 * the receptionist's copy of the regex; this second copy never got it. Real addresses are bounded
 * by RFC anyway — 64 chars local part, 63 per label — so the bounds cost nothing.
 */
const EMAIL_RE = /[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){0,4}\.[A-Za-z]{2,24}/g
// And bound the input as well as the pattern: a bounded regex is still linear work per character,
// and nothing in a real quote request needs more than this to find the sender.
const SCAN_LIMIT = 100_000
export function findEmail(text, { exclude = [] } = {}) {
  const raw = String(text || '').slice(0, SCAN_LIMIT)
  const skip = new Set(exclude.filter(Boolean).map((e) => String(e).toLowerCase()))
  const clean = (e) => e.replace(/\.+$/, '') // trailing sentence period, not part of the address
  const usable = (e) => e && !skip.has(e.toLowerCase()) && !/^(no-?reply|do-?not-?reply|postmaster|mailer-daemon)@/i.test(e)
  // A forwarded email leads with the sender — usually the shop itself. Prefer an addressee.
  for (const line of raw.split('\n')) {
    if (!/^\s*(to|reply-to|cc)\s*:/i.test(line)) continue
    const hit = (line.match(EMAIL_RE) || []).map(clean).find(usable)
    if (hit) return hit
  }
  return (raw.match(EMAIL_RE) || []).map(clean).find(usable) || null
}

/**
 * Slack blocks for a finished quote. Rendered as blocks rather than a wall of text because this is
 * the shop's working surface — the numbers should be scannable and the deep link one click away.
 */
export function quoteBlocks({ result, origin }) {
  const { estimate, contact, pieces, total, per_piece, order, ai } = result
  const money = shopFormat().money   // the shop's own currency — this posts into the shop's own Slack
  const line = [
    `*${estimate.estimate_number}* · ${contact.name}${result.contact_created ? ' _(new customer)_' : ''}`,
    `${pieces} × ${order.garment} · ${order.decoration}`,
    `*${money(total)}* total · ${money(per_piece)}/pc`,
    order.due_hint ? `Due *${order.due_hint}*` : null,
    order.rush ? ':rotating_light: marked RUSH' : null,
  ].filter(Boolean).join('\n')
  return [
    { type: 'section', text: { type: 'mrkdwn', text: line } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: result.unassigned
      ? 'Draft — no customer named yet, so it is filed under *Unassigned*. Open it to set the customer.'
      : `Draft — nothing sent to the customer. Read by ${ai === 'model' ? 'your AI model' : 'the built-in reader'}.` }] },
    { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open estimate' }, url: `${origin}/#/estimates/${estimate.id}`, style: 'primary' }] },
  ]
}

/** What to say when the message didn't carry enough to price. */
export function needsMoreBlocks(reason) {
  const msg = reason === 'no_quantity'
    ? "I can read that, but there's no quantity in it — tell me how many pieces and I'll price it."
    : "Paste the customer's message and I'll draft an estimate: garment, colours, quantity, and any deadline."
  return [{ type: 'section', text: { type: 'mrkdwn', text: msg } }]
}
