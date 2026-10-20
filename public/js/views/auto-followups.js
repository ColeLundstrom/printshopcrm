import { api, $, esc, relTime, setPage, toast, on } from '../core.js'

/**
 * Automatic follow-ups — switches, not a rule builder.
 *
 * Everything here already existed as automation rules: the starter pack ships a quote chase, a
 * proof nudge, a late-invoice chase and a thank-you. But turning one on meant finding Automations
 * (folded away under "More tools"), reading a WHEN / IF / THEN builder and knowing which trigger
 * key meant "they never answered my quote". This screen is the same rules, said the way a shop
 * owner says them: one card per situation, one switch, the number of days, and the email itself.
 *
 * A card edits the first "Email the customer" step of its rule and nothing else, so a rule a shop
 * has extended in the full builder (an extra text, a tag) keeps those steps. A rule that was
 * deleted is re-created from its starter template the moment its switch is turned on.
 */

export const RECIPES = [
  { trigger: 'estimate.stale', starter: 'Chase a quote after 3 quiet days', title: 'Quote not answered',
    when: 'If a customer hasn’t answered an estimate after', after: 'days, email them.',
    tokens: [['First name', 'first_name'], ['Estimate #', 'estimate_number'], ['Total', 'total'], ['Shop name', 'shop_name']] },
  { trigger: 'art.waiting', starter: 'Nudge a proof sitting 2+ days', title: 'Proof not approved',
    when: 'If a proof sits unapproved for', after: 'days, email the customer.',
    tokens: [['First name', 'first_name'], ['Order name', 'job_title'], ['Proof version', 'version'], ['Days waiting', 'days'], ['Shop name', 'shop_name']] },
  { trigger: 'invoice.overdue', starter: 'Chase money the day it goes late', title: 'Invoice past due',
    when: 'When an invoice is', after: 'days past due, email a reminder.',
    tokens: [['First name', 'first_name'], ['Invoice #', 'invoice_number'], ['Total', 'total'], ['Due date', 'due_date'], ['Shop name', 'shop_name']] },
  { trigger: 'invoice.paid', starter: 'Thank the customer when they pay', title: 'Thank-you after payment',
    when: 'When an invoice is paid in full, send a thank-you.',
    tokens: [['First name', 'first_name'], ['Invoice #', 'invoice_number'], ['Shop name', 'shop_name']] },
  { trigger: 'contact.created', starter: 'New lead nurture (3-step)', title: 'Welcome new customers',
    when: 'When a new customer is added, send a welcome email.',
    tokens: [['First name', 'first_name'], ['Shop name', 'shop_name']] },
  { trigger: 'opportunity.lost', starter: 'Win-back after a lost deal', title: 'Win back lost deals',
    when: 'When a deal is marked lost, reach back out later.',
    tokens: [['First name', 'first_name'], ['Shop name', 'shop_name']] },
]

const STEP_WORDS = {
  'sms.customer': () => 'text them', 'notify.staff': () => 'tell the shop', 'contact.tag': (c) => `tag them “${c?.tag || ''}”`,
  'note.log': () => 'note it on the timeline', 'job.move': (c) => `move the job to ${String(c?.stage || '').replace('_', ' ')}`,
  'job.flag_rush': () => 'flag the job rush', 'webhook.post': () => 'send a webhook', 'email.customer': () => 'email them again',
  wait: (c) => `wait ${c?.days || 1} day${Number(c?.days) === 1 ? '' : 's'}`,
}

/** The rule a card stands for: the starter by name first, else the first rule on that trigger that emails the customer. */
export function ruleFor(recipe, rules) {
  const fits = rules.filter((a) => a.trigger === recipe.trigger && (a.actions || []).some((x) => x.key === 'email.customer'))
  return fits.find((a) => a.name === recipe.starter) || fits[0] || null
}

/** The rule's actions with the first customer email replaced by the card's subject and body. */
export function withEmail(actions, subject, body) {
  let done = false
  return actions.map((x) => {
    if (done || x.key !== 'email.customer') return x
    done = true
    return { ...x, config: { ...(x.config || {}), subject, body } }
  })
}

// What a customer would read, for the preview under each email. Invented, plainly sample values.
const SAMPLE = { first_name: 'Dana', contact_name: 'Dana Wu', estimate_number: 'EST-1042', invoice_number: 'INV-1031', total: '$1,240.00',
  due_date: 'Oct 12', job_title: 'Team hoodies', job_number: 'JOB-1007', version: '2', days: '3' }

/** Fill {{tokens}} with the sample values (and the shop's own name) so the email reads as sent. */
export function previewText(text, shopName = 'Your shop') {
  return String(text || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k) => (k === 'shop_name' ? shopName : SAMPLE[k] ?? m))
}

let data = null
let shopName = 'Your shop'

export async function autoFollowupsView() {
  setPage('Automatic follow-ups', '<a class="btn ghost" href="#/automations">Custom rules</a>', '<a href="#/">Home</a> /')
  const [d, notify, cfg] = await Promise.all([api.get('/api/automations'), api.get('/api/notify/status').catch(() => null), api.get('/api/settings').catch(() => null)])
  data = d
  shopName = cfg?.settings?.shop_name || 'Your shop'
  const emailReady = !!(notify && (notify.shop_email || notify.email))
  const starters = d.starters || []

  const cards = RECIPES.map((r, i) => {
    const rule = ruleFor(r, d.automations)
    const starter = starters.find((s) => s.name === r.starter)
    if (!rule && !starter) return ''
    const src = rule || { ...starter, enabled: false }
    const email = (src.actions || []).find((x) => x.key === 'email.customer')?.config || {}
    const timed = d.triggers.find((t) => t.key === r.trigger)?.timed
    const days = src.params?.days ?? starter?.params?.days ?? 3
    const others = (src.actions || []).slice((src.actions || []).findIndex((x) => x.key === 'email.customer') + 1)
      .map((x) => STEP_WORDS[x.key]?.(x.config)).filter(Boolean)
    const on = !!(rule && rule.enabled)
    return `<article class="af-card${on ? ' on' : ''}" data-card="${i}">
      <div class="af-head">
        <label class="tog af-tog"><input type="checkbox" data-on="${i}"${on ? ' checked' : ''} aria-label="${esc(r.title)}: ${on ? 'on' : 'off'}"><span></span></label>
        <div class="af-main">
          <h3>${esc(r.title)} <span class="af-state">${on ? 'On' : 'Off'}</span></h3>
          <p class="af-when">${timed
            ? `${esc(r.when)} <label class="sr-only" for="af-days-${i}">Days</label><input class="input af-days" id="af-days-${i}" type="number" min="1" max="90" data-days="${i}" value="${esc(String(days))}"> ${esc(r.after)}`
            : esc(r.when)}</p>
          ${others.length ? `<p class="af-then">Then: ${esc(others.join(' → '))}.</p>` : ''}
          ${rule?.run_count ? `<p class="af-meta">Ran ${rule.run_count} time${rule.run_count === 1 ? '' : 's'} · last ${relTime(rule.last_run_at)}</p>` : ''}
        </div>
      </div>
      <details class="af-email">
        <summary>See or change the email</summary>
        <div class="field"><label for="af-subj-${i}">Subject</label><input class="input" id="af-subj-${i}" data-subj="${i}" value="${esc(email.subject || '')}"></div>
        <div class="field"><label for="af-body-${i}">Message</label><textarea class="input" id="af-body-${i}" data-body="${i}" rows="7">${esc(email.body || '')}</textarea></div>
        <div class="af-tokens"><span class="dim">Fill in automatically:</span>${r.tokens.map(([label, key]) => `<button type="button" class="chip" data-token="${i}" data-key="${key}">${esc(label)}</button>`).join('')}</div>
        <div class="af-preview" aria-live="polite"><div class="af-preview-l">What the customer sees</div>
          <div class="af-preview-s" id="af-pv-s-${i}">${esc(previewText(email.subject, shopName))}</div>
          <div class="af-preview-b" id="af-pv-b-${i}">${esc(previewText(email.body, shopName))}</div></div>
        <button type="button" class="btn primary sm" data-save="${i}">Save email</button>
      </details>
    </article>`
  }).join('')

  const recent = (d.runs || []).slice(0, 6)
  $('#view').innerHTML = `<div class="af">
    <div class="af-intro">
      <h1>Let the shop chase people for you</h1>
      <p>Flip a switch and we send the follow-up when it’s due. Every email goes out from your shop and is logged below.</p>
    </div>
    ${emailReady ? '' : `<div class="af-warn" role="status"><strong>Email isn’t connected yet.</strong> You can set these up now, but nothing sends until it is. <a class="btn secondary sm" href="#/setup">Connect email →</a></div>`}
    <div class="af-list">${cards}</div>
    <div class="af-foot">
      <div class="card"><div class="card-h"><h3>What went out lately</h3><div class="spacer"></div><a class="dim" href="#/outbox" style="font-size:12px">All sent mail →</a></div>
        <div class="card-b">${recent.length ? `<ul class="af-runs">${recent.map((x) => `<li class="${x.status === 'error' ? 'bad' : ''}"><strong>${esc(x.automation_name || '')}</strong> · ${esc(x.entity_label || '')}<span class="dim"> — ${esc(x.detail || x.status || '')} · ${relTime(x.created_at)}</span></li>`).join('')}</ul>`
          : '<p class="dim" style="margin:0">Nothing has gone out yet.</p>'}</div></div>
      <p class="guide-hint">Need to nudge someone right now? <a href="#/followups">See who owes you →</a> · Something these don’t cover? <a href="#/automations">Build a custom rule →</a></p>
    </div>
  </div>`

  // .af is rebuilt on every render, so these listeners die with it (unlike a binding on #view).
  const page = $('.af')
  on(page, '[data-on]', (_e, t) => toggle(+t.dataset.on, t.checked, t), 'change')
  on(page, '[data-days]', (_e, t) => saveDays(+t.dataset.days, t), 'change')
  on(page, '[data-save]', (_e, t) => saveEmail(+t.dataset.save, t))
  const repaint = (i) => {
    $(`#af-pv-s-${i}`).textContent = previewText($(`#af-subj-${i}`).value, shopName)
    $(`#af-pv-b-${i}`).textContent = previewText($(`#af-body-${i}`).value, shopName)
  }
  on(page, '[data-subj]', (_e, t) => repaint(t.dataset.subj), 'input')
  on(page, '[data-body]', (_e, t) => repaint(t.dataset.body), 'input')
  on(page, '[data-token]', (_e, t) => {
    const box = $(`#af-body-${t.dataset.token}`)
    const tok = `{{${t.dataset.key}}}`
    const at = box.selectionStart ?? box.value.length
    box.value = box.value.slice(0, at) + tok + box.value.slice(box.selectionEnd ?? at)
    box.focus(); box.selectionStart = box.selectionEnd = at + tok.length
    repaint(t.dataset.token)
  })
}

/** What the card currently says, merged onto the rule (or its starter template if it has none). */
function draftOf(i) {
  const r = RECIPES[i]
  const rule = ruleFor(r, data.automations)
  const starter = (data.starters || []).find((s) => s.name === r.starter)
  const base = rule || starter
  const subject = $(`#af-subj-${i}`)?.value ?? ''
  const body = $(`#af-body-${i}`)?.value ?? ''
  const daysBox = $(`#af-days-${i}`)
  const params = { ...(base.params || {}) }
  if (daysBox) params.days = Math.max(1, Math.min(90, Math.floor(+daysBox.value || params.days || 1)))
  return { rule, starter, payload: { params, actions: withEmail(base.actions || [], subject, body) } }
}

async function persist(i, extra) {
  const { rule, starter, payload } = draftOf(i)
  if (rule) return api.put(`/api/automations/${rule.id}`, { ...payload, ...extra })
  return api.post('/api/automations', { name: starter.name, trigger: starter.trigger, conditions: starter.conditions || [], enabled: false, ...payload, ...extra })
}

async function toggle(i, on, box) {
  box.disabled = true
  try {
    await persist(i, { enabled: on })
    toast(on ? `${RECIPES[i].title}: on` : `${RECIPES[i].title}: off`)
  } catch (err) { toast(err.message, true) }
  autoFollowupsView()
}

async function saveDays(i, box) {
  if (!ruleFor(RECIPES[i], data.automations)) return   // saved with the rest when it is switched on
  box.disabled = true
  try { await persist(i, {}); toast('Saved') } catch (err) { toast(err.message, true) }
  autoFollowupsView()
}

async function saveEmail(i, btn) {
  btn.disabled = true
  try {
    const had = !!ruleFor(RECIPES[i], data.automations)
    await persist(i, {})
    toast(had ? 'Email saved' : 'Email saved. Flip the switch to start sending.')
  } catch (err) { toast(err.message, true) }
  autoFollowupsView()
}

