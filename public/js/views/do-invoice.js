import { api, $, esc, money, fmtDate, setPage, toast, go, on, copyText } from '../core.js'

/**
 * Bill a customer — the guided way.
 *
 * An invoice here is always made from an approved estimate (Convert, on the estimate's own page),
 * which is right, but nothing told a shop that: "Invoices" had no New button and the way in was to
 * find the estimate, notice it said approved, and spot "Convert to Invoice + Job" among seven
 * buttons. This screen lists what is ready to bill, lets the shop record a yes it got by phone,
 * asks the one real question (when is it due?) and ends on Send.
 */

const TERMS = [['due_on_receipt', 'Due now'], ['net_15', 'In 15 days'], ['net_30', 'In 30 days'], ['net_45', 'In 45 days']]

let state = null

export async function doInvoiceView() {
  state = { step: 1, estimate: null, invoice: null }
  setPage('Bill a customer', '', '<a href="#/">Home</a> /')
  const [approved, sent] = await Promise.all([api.get('/api/estimates?status=approved'), api.get('/api/estimates?status=sent')])
  state.approved = approved.filter((e) => !e.invoice_id)
  state.sent = sent
  draw()
}

const lite = () => window.__EDITION === 'lite'

function stepper() {
  const steps = ['What are you billing?', 'When is it due?', 'Send it']
  return `<ol class="guide-steps" aria-label="Steps">${steps.map((s, i) => {
    const n = i + 1, cls = n < state.step ? 'done' : n === state.step ? 'on' : ''
    return `<li class="${cls}"${n === state.step ? ' aria-current="step"' : ''}><span class="gs-n">${n < state.step ? '✓' : n}</span>${s}</li>`
  }).join('')}</ol>`
}

function draw() {
  $('#view').innerHTML = `<div class="guide">${stepper()}<div id="g-body"></div></div>`
  if (state.step === 1) return drawPick()
  if (state.step === 2) return drawTerms()
  return drawSend()
}

const estRow = (e, verb) => `<button type="button" class="cp-row" role="listitem" data-est="${e.id}">
  <span class="cp-av" aria-hidden="true"><svg viewBox="0 0 16 16"><use href="#i-estimates"></use></svg></span>
  <span class="cp-txt"><span class="cp-n">${esc(e.contact_name || 'Customer')} · ${money(e.total)}</span>
    <span class="cp-d">${esc([e.estimate_number, e.items?.[0]?.description, e.company].filter(Boolean).join(' · '))}</span></span>
  <span class="cp-go" aria-hidden="true">${verb} →</span></button>`

function drawPick() {
  const { approved, sent } = state
  $('#g-body').innerHTML = `<div class="guide-split even">
    <section class="guide-card">
      <h2 class="guide-q">Ready to bill</h2>
      <p class="guide-hint">These customers approved their estimate.</p>
      ${approved.length ? `<div class="cp-list" role="list" id="inv-ready">${approved.map((e) => estRow(e, 'Bill this')).join('')}</div>`
        : '<p class="dim">Nothing approved and waiting to be billed right now.</p>'}
    </section>
    <section class="guide-card">
      <h2 class="guide-q">Waiting on a yes</h2>
      <p class="guide-hint">Sent but not approved online. If they said yes by phone or email, pick it and we’ll mark it approved.</p>
      ${sent.length ? `<div class="cp-list" role="list" id="inv-sent">${sent.map((e) => estRow(e, 'They said yes')).join('')}</div>`
        : '<p class="dim">No estimates waiting on the customer.</p>'}
      <p class="guide-hint" style="margin-top:var(--sp-6)">Billing something new? <a href="#/do/estimate">Make the estimate first →</a> it takes a minute.</p>
    </section>
  </div>`
  on($('#inv-ready'), '[data-est]', (_e, t) => pick(+t.dataset.est, false))
  on($('#inv-sent'), '[data-est]', (_e, t) => pick(+t.dataset.est, true))
}

async function pick(id, needsApproval) {
  try {
    let e = await api.get(`/api/estimates/${id}`)
    if (needsApproval) {
      await api.post(`/api/estimates/${id}/approve`, { commercial_revision: e.commercial_revision })
      toast(`${e.estimate_number} marked approved`)
      e = await api.get(`/api/estimates/${id}`)
    }
    if (e.invoice) { toast(`${e.estimate_number} already has invoice ${e.invoice.invoice_number}`); go(`/invoices/${e.invoice.id}`); return }
    state.estimate = e
    state.step = 2
    draw()
  } catch (err) { toast(err.message, true) }
}

function drawTerms() {
  const e = state.estimate
  const term = e.customer_payment_term || 'net_15'
  $('#g-body').innerHTML = `<section class="guide-card" style="max-width:720px">
    <div class="guide-who">Billing <strong>${esc(e.contact_name || '')}</strong> · ${esc(e.estimate_number)} · <strong>${money(e.total)}</strong> <button type="button" class="linkbtn" id="inv-back">Change</button></div>
    <h2 class="guide-q">When should they pay?</h2>
    <div class="choice-row" id="inv-terms" role="radiogroup" aria-label="Payment terms">${TERMS.map(([v, l]) => `<button type="button" class="choice${v === term ? ' on' : ''}" role="radio" aria-checked="${v === term}" data-term="${v}">${l}</button>`).join('')}</div>
    ${lite() ? '' : `<h2 class="guide-q">What should we call the job?</h2>
      <div class="field"><label for="inv-title" class="sr-only">Job name</label><input class="input" id="inv-title" value="${esc(e.items?.[0]?.description || 'Custom order')}"></div>
      <p class="guide-hint">The job goes on the board so the shop can start printing.</p>`}
    <button type="button" class="btn primary big" id="inv-go">${lite() ? 'Create invoice →' : 'Create invoice and job →'}</button>
  </section>`
  let chosen = term
  $('#inv-back').onclick = () => { state.step = 1; draw() }
  on($('#inv-terms'), '[data-term]', (_ev, t) => {
    chosen = t.dataset.term
    for (const b of $('#inv-terms').querySelectorAll('[data-term]')) { const isOn = b === t; b.classList.toggle('on', isOn); b.setAttribute('aria-checked', String(isOn)) }
  })
  $('#inv-go').onclick = async () => {
    const btn = $('#inv-go'), label = btn.textContent
    btn.disabled = true; btn.textContent = 'Creating…'
    try {
      const body = { payment_term: chosen, commercial_revision: e.commercial_revision }
      if (!lite()) body.title = $('#inv-title').value.trim() || 'Custom order'
      const r = await api.post(`/api/estimates/${e.id}/convert`, body)
      state.invoice = await api.get(`/api/invoices/${r.invoice_id}`)
      state.job = lite() ? null : { id: r.job_id, number: r.job_number, reused: r.job_reused }
      state.step = 3
      draw()
    } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = label }
  }
}

function drawSend() {
  const i = state.invoice, e = state.estimate
  const link = i.pay_link ? new URL(i.pay_link, location.origin).href : ''
  $('#g-body').innerHTML = `<section class="guide-card guide-done">
    <div class="done-badge" aria-hidden="true">✓</div>
    <h2 class="guide-q">${esc(i.invoice_number)} is ready · ${money(i.amount_due ?? i.total)}</h2>
    <p class="guide-hint" id="inv-hint">Due ${esc(fmtDate(i.due_date))}.${state.job ? ` Job ${esc(state.job.number)} is ${state.job.reused ? 'already' : 'now'} on the board.` : ''}</p>
    <div class="guide-actions" id="inv-actions">
      <button type="button" class="btn primary big" id="inv-send">Email it to ${esc(String(e.contact_name || 'them').split(' ')[0])} →</button>
      <a class="btn ghost big" href="#/invoices/${i.id}">Look it over first</a>
    </div>
    ${link ? `<p class="guide-hint" style="margin-top:var(--sp-6)">Or text them the pay link:</p>
      <div class="copy-row"><input class="input" readonly value="${esc(link)}" aria-label="Pay link"><button type="button" class="btn secondary" id="inv-copy">Copy link</button></div>` : ''}
    <div id="inv-sent"></div>
  </section>`
  $('#inv-copy')?.addEventListener('click', () => copyText(link, 'Pay link copied'))
  $('#inv-send').onclick = async () => {
    const btn = $('#inv-send'), label = btn.textContent
    btn.disabled = true; btn.textContent = 'Sending…'
    try {
      const r = await api.post(`/api/invoices/${i.id}/send`, { recipient_revision: i.recipient_revision })
      $('#inv-actions').innerHTML = `<a class="btn ghost" href="#/invoices/${i.id}">Open ${esc(i.invoice_number)}</a>${state.job ? `<a class="btn ghost" href="#/jobs/${state.job.id}">Open the job</a>` : ''}`
      $('#inv-sent').innerHTML = `<div class="sent-box"><p><strong>${r.email_live && r.emailed_to ? `Emailed to ${esc(r.emailed_to)}.` : 'Saved to Sent mail.'}</strong> ${r.email_live ? '' : 'Your shop email is not connected yet, so nothing went out. Copy the pay link above, or <a href="#/setup">connect email</a>.'}</p>
        <div class="guide-actions"><a class="btn primary" href="#/do/invoice">Bill someone else</a><a class="btn ghost" href="#/">Back to Home</a></div></div>`
    } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = label }
  }
}
