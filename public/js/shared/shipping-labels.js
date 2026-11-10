/* Shipping labels on a job: rate a box, buy the label once, print it, track it, void it.
 * The server owns every decision that costs money; this file only shows what it says. */
import { api, esc, modal, closeModal, toast } from '../core.js'

const STATUS = { delivered: 'Delivered', out_for_delivery: 'Out for delivery', in_transit: 'In transit', pre_transit: 'Label created — not scanned yet', available_for_pickup: 'Ready for pickup', return_to_sender: 'Returning to sender', failure: 'Delivery problem', cancelled: 'Cancelled', error: 'Tracking error', unknown: 'No scans yet' }
const tidy = (s) => String(s || '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b([A-Z])([A-Z]+)\b/g, (_, a, b) => a + b.toLowerCase())
// "FEDEX_2_DAY" under carrier "FedEx" reads "2 Day", not "Fedex 2 Day".
const service = (s, carrier = '') => { const t = tidy(s); return carrier && t.toLowerCase().startsWith(String(carrier).toLowerCase() + ' ') ? t.slice(String(carrier).length + 1) : t }
// A label is priced in the CARRIER's currency (the rate says which), not the shop's display currency.
const cash = (cents, currency = 'USD') => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format((cents || 0) / 100) } catch { return ((cents || 0) / 100).toFixed(2) + ' ' + currency } }
const weight = (p) => { const oz = Number(p?.weight_oz) || 0, lb = Math.floor(oz / 16), rest = Math.round((oz - lb * 16) * 10) / 10; return [lb ? `${lb} lb` : '', rest ? `${rest} oz` : ''].filter(Boolean).join(' ') || '0 oz' }
const dims = (p) => (p?.length ? ` · ${p.length} × ${p.width} × ${p.height} in` : '')
const days = (n) => (Number.isInteger(n) ? `${n} day${n === 1 ? '' : 's'}` : 'Time not given')
const when = (iso) => { const d = new Date(String(iso || '').replace(' ', 'T') + (/[zZ]$/.test(String(iso)) ? '' : 'Z')); return Number.isFinite(d.getTime()) ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '' }
function requestId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return `label-${globalThis.crypto.randomUUID()}`
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  return 'label-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
const TEST_TAG = '<span class="tag label-test" title="Bought with a test key: a sample, not valid postage">TEST</span>'
const field = (label, name, value = '', extra = '') => `<label class="field">${esc(label)}<input class="input" name="${name}" value="${esc(value)}" ${extra}></label>`

// What a person typed and has not sent survives a repaint of the job screen, per job, for this session.
const drafts = new Map()
let seq = 0

export async function mountLabels(element, { jobId, onChange } = {}) {
  if (!element) return
  const mount = ++seq
  element.dataset.labelMount = String(mount)
  const current = () => element.isConnected && element.dataset.labelMount === String(mount)
  const st = drafts.get(jobId) || { open: false, to: null, boxes: null, request: null, busy: '', message: '', error: false, picked: {} }
  drafts.set(jobId, st)
  let data = null

  const capture = () => {
    const form = element.querySelector('[data-label-form]')
    if (!form) return
    const f = new FormData(form)
    st.to = Object.fromEntries(['name', 'company', 'street1', 'street2', 'city', 'state', 'zip', 'country', 'phone', 'email'].map((k) => [k, String(f.get(k) ?? '')]))
    st.boxes = [...form.querySelectorAll('[data-box]')].map((b) => Object.fromEntries(['weight_lb', 'weight_oz', 'length', 'width', 'height'].map((k) => [k, b.querySelector(`[data-b="${k}"]`).value])))
  }
  const say = (message, error = false) => { st.message = message; st.error = error }
  const load = async () => {
    try { data = await api.get(`/api/production/jobs/${jobId}/labels`) } catch (e) { if (current()) element.innerHTML = `<p role="alert">${esc(e.message)}</p>`; return }
    if (!current()) return
    render()
    // Tracking is refreshed when the job is opened, one label at a time, without holding the screen.
    for (const l of data.labels.filter((x) => x.tracking_stale)) {
      api.post(`/api/shipping/labels/${l.id}/track`, {}).then((r) => { if (!current()) return; const i = data.labels.findIndex((x) => x.id === l.id); if (i >= 0) { data.labels[i] = r.label; if (!st.busy && !element.querySelector('[data-label-form]')) render() } }).catch(() => {})
    }
  }

  const rateRows = (l) => l.rates.length ? `<div class="label-rates" role="radiogroup" aria-label="Rates for box ${l.box}">${l.rates.map((r) => `
      <label class="label-rate ${st.picked[l.id] === r.id ? 'on' : ''}"><input type="radio" name="rate-${l.id}" value="${esc(r.id)}" ${st.picked[l.id] === r.id ? 'checked' : ''} ${l.status === 'buying' ? 'disabled' : ''}>
        <span class="label-rate-name"><strong>${esc(r.carrier)}</strong> ${esc(service(r.service, r.carrier))}${r.cheapest ? ' <span class="tag green">Cheapest</span>' : ''}${r.fastest ? ' <span class="tag">Fastest</span>' : ''}</span>
        <span class="label-rate-days">${esc(days(r.days))}</span><span class="label-rate-price">${esc(cash(r.price_cents, r.currency))}</span></label>`).join('')}</div>`
    : `<p role="status">No carrier offered a rate for this box.${l.messages.length ? ` ${esc(l.messages.join(' · '))}` : ''} Check the address and weight, then get rates again.</p>`

  const labelCard = (l) => {
    const head = `Box ${l.box} · ${esc(weight(l.parcel))}${esc(dims(l.parcel))}`
    const problem = l.error ? `<p class="label-problem" role="status">${esc(l.error)}</p>` : ''
    if (l.status === 'rated') return `<article class="shipment-row label-card" data-label="${l.id}">
      <div class="shipment-heading"><strong>${head}</strong>${l.test ? TEST_TAG : ''}<span class="tag">Rates</span></div>${problem}${rateRows(l)}
      <div class="shipment-actions">${l.rates.length ? `<button class="btn ghost" type="button" data-buy="${l.id}" ${data.can_buy ? '' : 'disabled'}>Buy label…</button>` : ''}<button class="btn ghost" type="button" data-discard="${l.id}">Clear these rates</button></div></article>`
    if (l.status === 'buying') return `<article class="shipment-row label-card" data-label="${l.id}">
      <div class="shipment-heading"><strong>${head}</strong>${l.test ? TEST_TAG : ''}<span class="tag amber">Purchase not confirmed</span></div>
      <p role="alert">We asked to buy ${esc(l.carrier)} ${esc(service(l.service, l.carrier))} for ${esc(cash(l.price_cents, l.currency))} and did not get a clear answer. Check before doing anything else — checking never buys a second label.</p>
      <div class="shipment-actions"><button class="btn" type="button" data-check="${l.id}">Check purchase</button></div></article>`
    const t = l.tracking
    const voided = l.status === 'void_requested' || l.status === 'voided'
    const state = voided ? `<span class="tag">${l.status === 'voided' ? 'Voided — refunded' : 'Void requested'}</span>` : `<span class="tag green">Label bought</span>`
    return `<article class="shipment-row label-card ${voided ? 'label-voided' : ''}" data-label="${l.id}">
      <div class="shipment-heading"><strong>${esc(l.carrier)} ${esc(service(l.service, l.carrier))} · ${esc(cash(l.price_cents, l.currency))}</strong>${l.test ? TEST_TAG : ''}${state}</div>
      <p class="dim">${head}${l.bought_by ? ` · bought by ${esc(l.bought_by)}` : ''}${l.bought_at ? ` ${esc(when(l.bought_at))}` : ''}</p>
      <p>Tracking <strong class="label-tracking">${esc(l.tracking_code || 'not issued yet')}</strong>${l.tracking_url ? ` · <a href="${esc(l.tracking_url)}" target="_blank" rel="noopener noreferrer">Track package</a>` : ''}</p>
      ${!voided && t ? `<p class="dim">${esc(STATUS[t.status] || t.status || 'No scans yet')}${t.est_delivery_date ? ` · expected ${esc(when(t.est_delivery_date))}` : ''}${t.events?.length ? ` · last: ${esc(t.events[t.events.length - 1].message)}${t.events[t.events.length - 1].where ? `, ${esc(t.events[t.events.length - 1].where)}` : ''}` : ''}</p>` : ''}
      ${l.test ? '<p class="dim">Test labels are samples. They are not added to this job’s shipments and are never sent to a customer.</p>' : l.recorded && !voided ? '<p class="dim">Added to this job’s shipments below.</p>' : ''}
      ${voided ? `<p class="dim">Refund ${esc(l.refund_status || 'submitted')}. Do not use this label; carriers take days or weeks to return the postage.</p>` : ''}${problem}
      <div class="shipment-actions">
        ${!voided && l.has_file ? `<button class="btn ghost" type="button" data-print="${l.id}">Print label</button>` : ''}
        ${!voided ? `<button class="btn ghost" type="button" data-track="${l.id}">${l.has_file ? 'Refresh tracking' : 'Fetch label file'}</button>` : ''}
        ${!voided && !l.test && l.tracking_code ? (l.notified_at ? `<span class="dim">Tracking emailed ${esc(when(l.notified_at))}</span>` : `<button class="btn ghost" type="button" data-notify="${l.id}" ${data.can_buy ? '' : 'disabled'}>Email tracking to customer</button>`) : ''}
        ${!voided && data.setup.manager ? `<button class="btn ghost" type="button" data-void="${l.id}">Void label</button>` : ''}
      </div></article>`
  }

  const boxRow = (b, i, n) => `<div class="label-box" data-box><span class="label-box-n">Box ${i + 1}</span>
      <label class="field">Weight (lb)<input class="input" data-b="weight_lb" inputmode="decimal" value="${esc(b.weight_lb || '')}" aria-label="Box ${i + 1} weight, pounds"></label>
      <label class="field">oz<input class="input" data-b="weight_oz" inputmode="decimal" value="${esc(b.weight_oz || '')}" aria-label="Box ${i + 1} weight, ounces"></label>
      <label class="field">Length (in)<input class="input" data-b="length" inputmode="decimal" value="${esc(b.length || '')}" aria-label="Box ${i + 1} length, inches"></label>
      <label class="field">Width<input class="input" data-b="width" inputmode="decimal" value="${esc(b.width || '')}" aria-label="Box ${i + 1} width, inches"></label>
      <label class="field">Height<input class="input" data-b="height" inputmode="decimal" value="${esc(b.height || '')}" aria-label="Box ${i + 1} height, inches"></label>
      ${n > 1 ? `<button class="btn ghost" type="button" data-remove-box="${i}" aria-label="Remove box ${i + 1}">Remove</button>` : ''}</div>`

  function render() {
    if (!current()) return
    const s = data.setup
    if (!s.connected || !s.ship_from_ready) {
      element.innerHTML = `<div class="shipment-panel label-panel"><h3>Shipping labels</h3>
        <p class="dim">${!s.connected ? 'Buy postage and print labels here with your own EasyPost account. The tracking number is saved to this job for you.' : 'Add the address your parcels ship from before rating a box.'}</p>
        ${s.manager ? `<a class="btn ghost" href="#/shipping-labels">${s.connected ? 'Add ship-from address' : 'Set up shipping labels'}</a>` : '<p class="dim">Ask a manager to set this up.</p>'}</div>`
      return
    }
    const to = st.to || data.ship_to, d = s.parcel_default
    const boxes = st.boxes || [{ weight_lb: d.weight_lb || '', weight_oz: d.weight_oz || '', length: d.length || '', width: d.width || '', height: d.height || '' }]
    const busy = !!st.busy
    element.innerHTML = `<div class="shipment-panel label-panel"><h3>Shipping labels ${s.key_mode === 'test' ? TEST_TAG : ''}</h3>
      ${s.key_mode === 'test' ? '<p class="dim">Connected with a test key: labels are samples and cost nothing. Switch to your live key under Shipping labels setup when you are ready.</p>' : ''}
      ${data.labels.length ? `<div class="shipment-list">${data.labels.map(labelCard).join('')}</div>` : ''}
      ${!data.can_buy ? `<p role="status" class="dim">${esc(data.blocked || 'You cannot buy labels on this job.')}</p>` : ''}
      <p class="shipment-feedback ${st.error ? 'shipment-error' : ''}" role="${st.error ? 'alert' : 'status'}">${esc(st.message)}</p>
      ${data.can_buy ? (st.open ? `<form data-label-form novalidate>
        <h3>Ship to</h3>
        ${data.ship_to_text ? '' : '<p class="dim">This job has no shipping address saved. Enter where it is going.</p>'}
        <fieldset ${busy ? 'disabled' : ''}><div class="shipment-fields">
          ${field('Name', 'name', to.name, 'maxlength="80" autocomplete="off"')}${field('Company', 'company', to.company, 'maxlength="80" autocomplete="off"')}
          ${field('Street address', 'street1', to.street1, 'maxlength="100" required autocomplete="off"')}${field('Apt, suite (optional)', 'street2', to.street2, 'maxlength="100" autocomplete="off"')}
          ${field('City', 'city', to.city, 'maxlength="60" required autocomplete="off"')}${field('State', 'state', to.state, 'maxlength="20" required autocomplete="off"')}
          ${field('ZIP / postal code', 'zip', to.zip, 'maxlength="12" required autocomplete="off"')}${field('Country', 'country', to.country || 'US', 'maxlength="2" required autocomplete="off"')}
          ${field('Phone (some carriers need it)', 'phone', to.phone, 'maxlength="30" autocomplete="off"')}${field('Email (optional)', 'email', to.email, 'maxlength="120" autocomplete="off"')}
        </div>
        <h3>Boxes</h3><p class="dim">One label per box. Weigh the packed box; dimensions are optional but give truer prices.</p>
        <div class="label-boxes">${boxes.map((b, i) => boxRow(b, i, boxes.length)).join('')}</div>
        <button class="btn ghost" type="button" data-add-box ${boxes.length >= 10 ? 'disabled' : ''}>Add another box</button></fieldset>
        <div class="shipment-actions"><button class="btn ghost" type="submit" ${busy ? 'disabled' : ''}>${st.busy === 'rates' ? 'Getting rates…' : st.request ? 'Retry getting rates' : 'Get rates'}</button>
          <button class="btn ghost" type="button" data-close-form ${busy ? 'disabled' : ''}>Cancel</button></div>
      </form>` : `<div class="shipment-actions"><button class="btn ghost" type="button" data-open-form>${data.labels.length ? 'Create another label' : 'Create a shipping label'}</button></div>`) : ''}
    </div>`
    wire()
  }

  const replace = (label) => { const i = data.labels.findIndex((x) => x.id === label.id); if (i >= 0) data.labels[i] = label; else data.labels.push(label) }
  const act = async (name, fn) => {
    if (st.busy) return
    st.busy = name
    try { await fn() } catch (e) { say(e.message, true) } finally { st.busy = ''; if (current()) render() }
  }

  function buyDialog(l) {
    const rate = l.rates.find((r) => r.id === st.picked[l.id])
    if (!rate) { say('Choose a rate for this box first.', true); return render() }
    const price = cash(rate.price_cents, rate.currency)
    const bg = modal({
      title: `Buy this label for ${price}?`,
      body: `<p style="line-height:1.6"><strong>${esc(rate.carrier)} ${esc(service(rate.service, rate.carrier))}</strong> · ${esc(days(rate.days))} · box ${l.box}, ${esc(weight(l.parcel))}</p>
        <p class="muted" style="line-height:1.6">${l.test
          ? 'This is a TEST purchase. It makes a sample label and costs nothing.'
          : `This charges your EasyPost account ${esc(price)} now. A label you do not use can be voided, but the carrier takes days or weeks to return the postage.`}</p>
        <p class="muted" style="line-height:1.6">To: ${esc([l.to_address.name || l.to_address.company, l.to_address.street1, `${l.to_address.city}, ${l.to_address.state} ${l.to_address.zip}`].filter(Boolean).join(' · '))}</p>`,
      footer: `<button class="btn ghost" data-close>Cancel</button><button class="btn" id="label-buy-yes">Buy label — ${esc(price)}</button>`,
    })
    const yes = bg.querySelector('#label-buy-yes')
    yes.onclick = () => {
      yes.disabled = true
      closeModal()
      act('buy', async () => {
        say('Buying label…')
        render()
        try {
          const r = await api.post(`/api/shipping/labels/${l.id}/buy`, { rate_id: rate.id, confirm_price_cents: rate.price_cents })
          replace(r.label)
          say(r.label.error || (r.label.test ? 'Test label made.' : `Label bought — ${r.label.tracking_code}.`), !!r.label.error)
          toast(r.label.test ? 'Test label made' : 'Label bought')
          if (!r.label.test) onChange?.()
        } catch (e) {
          // Whatever happened, show what the server now holds for this box.
          try { data = await api.get(`/api/production/jobs/${jobId}/labels`) } catch { /* keep what we have */ }
          throw e
        }
      })
    }
  }

  function voidDialog(l) {
    const bg = modal({
      title: 'Void this label?',
      body: `<p class="muted" style="line-height:1.6">This asks ${esc(l.carrier)} to refund ${esc(cash(l.price_cents, l.currency))} for tracking ${esc(l.tracking_code)}. Do not use the label after this. ${l.recorded ? 'Its shipment record on this job is voided too, with its history kept.' : ''}</p>
        <label class="field">Reason<input class="input" id="label-void-reason" maxlength="300" placeholder="Wrong address, order cancelled…"></label>`,
      footer: '<button class="btn ghost" data-close>Keep label</button><button class="btn danger" id="label-void-yes">Void label</button>',
    })
    bg.querySelector('#label-void-yes').onclick = () => {
      const reason = bg.querySelector('#label-void-reason').value.trim()
      if (!reason) { bg.querySelector('#label-void-reason').focus(); return }
      closeModal()
      act('void', async () => {
        const r = await api.post(`/api/shipping/labels/${l.id}/void`, { reason })
        replace(r.label)
        say(r.accepted ? 'Refund requested. Do not use this label.' : r.label.error || 'The carrier did not accept a refund for this label.', !r.accepted)
        if (r.accepted) onChange?.()
      })
    }
  }

  function wire() {
    const q = (sel) => element.querySelector(sel), qa = (sel) => [...element.querySelectorAll(sel)]
    const byId = (id) => data.labels.find((l) => String(l.id) === String(id))
    q('[data-open-form]')?.addEventListener('click', () => { st.open = true; say(''); render(); q('[name="street1"]')?.focus() })
    q('[data-close-form]')?.addEventListener('click', () => { st.open = false; st.request = null; say(''); render() })
    q('[data-add-box]')?.addEventListener('click', () => { capture(); st.boxes.push({ ...st.boxes[st.boxes.length - 1] }); render(); qa('[data-box]').pop()?.querySelector('input')?.focus() })
    for (const b of qa('[data-remove-box]')) b.onclick = () => { capture(); st.boxes.splice(Number(b.dataset.removeBox), 1); render() }
    const form = q('[data-label-form]')
    if (form) {
      form.oninput = () => { capture(); st.request = null }
      form.onsubmit = (event) => {
        event.preventDefault()
        capture()
        // One request id per set of answers: pressing twice, or retrying after a lost reply, rates nothing twice.
        if (!st.request) st.request = requestId()
        act('rates', async () => {
          say('Getting rates from your carriers…'); render()
          const r = await api.post(`/api/production/jobs/${jobId}/labels/rates`, { request_id: st.request, to: st.to, boxes: st.boxes })
          data = r; st.open = false; st.request = null; st.boxes = null
          for (const id of r.rated || []) { const l = byId(id); const pick = l?.rates.find((x) => x.cheapest); if (pick) st.picked[id] = pick.id }
          say(r.rated?.length > 1 ? `Rates for ${r.rated.length} boxes. Choose one for each, then buy.` : 'Choose a rate, then buy the label.')
        })
      }
    }
    for (const input of qa('.label-rate input')) input.onchange = () => { st.picked[input.name.slice(5)] = input.value; render() }
    for (const b of qa('[data-buy]')) b.onclick = () => buyDialog(byId(b.dataset.buy))
    for (const b of qa('[data-void]')) b.onclick = () => voidDialog(byId(b.dataset.void))
    for (const b of qa('[data-discard]')) b.onclick = () => act('discard', async () => { data = await api.post(`/api/shipping/labels/${b.dataset.discard}/discard`, {}); say('') })
    for (const b of qa('[data-check]')) b.onclick = () => act('check', async () => {
      const r = await api.post(`/api/shipping/labels/${b.dataset.check}/check`, {})
      replace(r.label)
      say(r.recovered ? `The label was bought — ${r.label.tracking_code}. Nothing was charged twice.` : r.released ? 'The carrier has no purchase for this box. Nothing was charged; the rates are back.' : '')
      if (r.recovered && !r.label.test) onChange?.()
    })
    for (const b of qa('[data-track]')) b.onclick = () => act('track', async () => { const r = await api.post(`/api/shipping/labels/${b.dataset.track}/track`, {}); replace(r.label); say(r.label.error || 'Tracking updated.', !!r.label.error) })
    for (const b of qa('[data-notify]')) b.onclick = () => act('notify', async () => { const r = await api.post(`/api/shipping/labels/${b.dataset.notify}/notify`, {}); replace(r.label); say('Tracking emailed to the customer.'); toast('Tracking emailed') })
    for (const b of qa('[data-print]')) b.onclick = () => {
      const w = window.open(`/api/shipping/labels/${b.dataset.print}/print`, '_blank')
      // Same origin, so the print dialog can be opened for them once the label has drawn.
      if (w) w.addEventListener('load', () => setTimeout(() => { try { w.focus(); w.print() } catch { /* they can press print themselves */ } }, 250))
    }
    for (const el of qa('button')) if (st.busy && !el.closest('[data-label-form]')) el.disabled = true
  }

  element.innerHTML = '<p role="status" class="dim">Loading shipping labels…</p>'
  await load()
}
