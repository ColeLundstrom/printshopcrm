/**
 * Lead nurture drip — the automated follow-up for marketing leads who left an email but haven't
 * signed up. A fixed sequence over 20 days, sent from printshopcrm.com through the same proven GHL
 * pipe as our welcome/staff mail. Day-0 is sent at capture time (see captureLead); this schedule
 * covers days 2/5/10/20. The drip stops the moment a lead signs up or unsubscribes.
 *
 * Copy approved by Cole 2026-07-27. Edit the DRIP array to change wording/cadence.
 */
import { sendPlatformEmail } from './notify.mjs'
import { dueNurture, advanceNurture, stopNurture, emailHasAccount } from './tenants.mjs'

const SIGNUP_URL = 'https://pro.printshopcrm.com/signup'
const UNSUB_BASE = 'https://pro.printshopcrm.com/unsub?t='

// Index 0 is day-0 (sent at capture, kept here for reference/parity); the drip sends 1..4.
export const DRIP = [
  { day: 0, subject: 'Your PrintShopCRM trial link',
    paras: ["Thanks for checking out PrintShopCRM. It's your CRM, customer inbox, automations, live pricing, production board, proofs, and payments — one login, built for print shops.",
      'Your 30-day free trial is one click, no card. Questions? Just reply — a real person reads these.'] },
  { day: 2, subject: 'Are your small runs quietly losing money?',
    paras: ['The thing most shops get wrong is pricing small and multi-color runs.',
      "PrintShopCRM's live pricing matrix flags the jobs that lose money before you send the quote, so you stop eating the loss."] },
  { day: 5, subject: 'One login instead of five subscriptions',
    paras: ['A CRM here, a scheduler there, a proofing tool, an invoicing app…',
      'PrintShopCRM replaces the stack — quotes, production, proofs, payments, and an AI receptionist in one place.'] },
  { day: 10, subject: 'Bring your customers over in a few minutes',
    paras: ['Worried about switching? Export your customer list from whatever you use now, import the CSV, and we match the columns automatically.',
      'We never touch your existing records, and your data exports anytime.'] },
  { day: 20, subject: 'Still want that trial spot?',
    paras: ["No pressure — if now's not the time, I'll stop here.",
      "If you'd like to see it in action, your 30-day free trial is still one click."] },
]
const DAY_OFFSETS = DRIP.map((d) => d.day)

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))

/** Branded HTML for one drip email: greeting, body, a Start-free-trial button, CAN-SPAM footer. */
function renderEmail(entry, lead) {
  const hi = lead.name ? `Hi ${esc(lead.name.split(/\s+/)[0])},` : 'Hi,'
  const paras = entry.paras.map((p) => `<p style="margin:0 0 14px">${esc(p)}</p>`).join('')
  const unsub = `${UNSUB_BASE}${encodeURIComponent(lead.unsub_token)}`
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;max-width:560px">
<p style="margin:0 0 14px">${hi}</p>
${paras}
<p style="margin:22px 0"><a href="${SIGNUP_URL}" style="background:#0b7;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600;display:inline-block">Start your free trial</a></p>
<p style="margin:0 0 4px;color:#555;font-size:13px">No credit card — cancel anytime.</p>
<p style="margin:20px 0 0;color:#999;font-size:12px;line-height:1.5">PrintShopCRM · Merch Troop, La Habra, CA<br>You're getting this because you asked for the trial link at printshopcrm.com. <a href="${unsub}" style="color:#999">Unsubscribe</a>.</p>
</div>`
}

let running = false
/**
 * Send every drip email that's due as of `nowMs`. Fire-and-forget from the tick. Skips + closes out
 * leads who've since signed up; advances a lead only after its email actually leaves, so a failed
 * send is retried on the next tick rather than skipped. Re-entrancy guarded so overlapping ticks
 * never double-send.
 */
export async function runNurtureDrip(nowMs = Date.now()) {
  if (running) return { sent: 0, skipped: 'in-flight' }
  running = true
  let sent = 0
  try {
    for (const lead of dueNurture(nowMs, DAY_OFFSETS)) {
      if (emailHasAccount(lead.email)) { stopNurture(lead.email, 'done'); continue }
      const entry = DRIP[lead.step]
      if (!entry) { advanceNurture(lead.id, DRIP.length, nowMs); continue }
      const r = await sendPlatformEmail({ to: lead.email, toName: lead.name, subject: entry.subject, html: renderEmail(entry, lead) })
      if (r.delivered) { advanceNurture(lead.id, DRIP.length, nowMs); sent++ }
      else console.log('nurture send deferred:', lead.email, 'step', lead.step, r.error || '')
    }
  } finally { running = false }
  return { sent }
}
