import { api, $, esc, money, setPage, toast, go, on, copyText, guardLeave, confirmModal } from '../core.js'
import { customerPicker } from '../shared/customer-picker.js'

/**
 * Make an estimate — the guided way.
 *
 * The estimate editor is a spreadsheet: a blank row, a Rate box that starts at $0.00, and the
 * shop's own pricing hidden behind "Price calculator" and "From a price matrix". Someone who just
 * wants to quote 48 hoodies has to know all of that first. This asks three plain questions —
 * who, what, how it's decorated — and prices it live with the same engine every other quoting path
 * uses (POST /api/quick-price → priceIntakeLive). The editor is still one click away for anything
 * unusual, and the estimate this makes is an ordinary one the editor can open.
 */

const SIZE_ROW = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL']
const MORE_SIZES = ['4XL', '5XL', 'YS', 'YM', 'YL', 'YXL', 'OSFA']
const SPOTS = ['Front', 'Back', 'Left Chest', 'Right Chest', 'Left Sleeve', 'Right Sleeve', 'Hood', 'Yoke']
// What a decoration method is called on the button, when the shop's price book uses trade names.
const FRIENDLY = { 'Screen Print': 'Screen print', 'DTF Transfer': 'DTF transfer', 'UV DTF': 'UV DTF' }

let state = null
let priceTimer = null
let priceSeq = 0

const blankOrder = () => ({
  garment: '', garment_color: '', sizes: {}, total_pieces: 0, decoration: 'Screen Print',
  locations: [{ name: 'Front', colors: 1 }], dark_garment: false,
})

export async function doEstimateView() {
  clearTimeout(priceTimer)
  state = { step: 1, contact: null, order: blankOrder(), services: [], priced: null, created: null, moreSizes: false }
  setPage('Make an estimate', '', '<a href="#/">Home</a> /')
  // Leaving with a half-built order loses it, and nothing was saved yet — ask once.
  guardLeave((to) => {
    const typed = state && state.step === 2 && !state.created && (state.order.garment || piecesOf(state.order))
    if (!typed) return true
    confirmModal('Leave this estimate?', 'Nothing has been saved yet. Leaving now throws away what you picked.', () => { state.step = 0; go(to) }, 'Leave')
    return false
  })
  const pb = await api.get('/api/pricebook').catch(() => null)
  state.services = (pb?.services || []).map((s) => ({ name: s.name, axis: s.axis }))
  if (!state.services.length) state.services = [{ name: 'Screen Print', axis: 'colors' }]
  const params = new URLSearchParams(location.hash.split('?')[1] || '')
  const preset = +params.get('contact')
  if (preset) {
    const { contacts } = await api.get('/api/contacts')
    const c = contacts.find((x) => x.id === preset)
    if (c) { state.contact = c; state.step = 2 }
  }
  draw()
}

const piecesOf = (o) => Math.max(Object.values(o.sizes).reduce((a, n) => a + (Number(n) || 0), 0), Number(o.total_pieces) || 0)
const axisOf = (name) => state.services.find((s) => s.name === name)?.axis || 'colors'

function stepper() {
  const steps = ['Who is it for?', 'What do they want?', 'Send it']
  return `<ol class="guide-steps" aria-label="Steps">${steps.map((s, i) => {
    const n = i + 1, cls = n < state.step ? 'done' : n === state.step ? 'on' : ''
    return `<li class="${cls}"${n === state.step ? ' aria-current="step"' : ''}><span class="gs-n">${n < state.step ? '✓' : n}</span>${s}</li>`
  }).join('')}</ol>`
}

function draw() {
  // The editor escape hatch belongs to the questions, not to the estimate that already exists.
  setPage('Make an estimate', state.step === 3 ? '' : '<a class="btn ghost" href="#/estimates/new">Use the full editor</a>', '<a href="#/">Home</a> /')
  $('#view').innerHTML = `<div class="guide">${stepper()}<div id="g-body"></div></div>`
  if (state.step === 1) return drawWho()
  if (state.step === 2) return drawWhat()
  return drawSend()
}

/* ---------- 1. who ---------- */
function drawWho() {
  $('#g-body').innerHTML = `<section class="guide-card">
    <h2 class="guide-q">Who is this estimate for?</h2>
    <p class="guide-hint">Start typing their name. New customer? Add them right here.</p>
    <div id="g-picker"></div>
  </section>`
  customerPicker($('#g-picker'), (c) => { state.contact = c; state.step = 2; draw() })
}

/* ---------- 2. what ---------- */
function drawWhat() {
  const o = state.order
  const c = state.contact
  const deco = o.decoration
  const colorAxis = axisOf(deco) === 'colors'
  $('#g-body').innerHTML = `<div class="guide-split">
    <section class="guide-card">
      <div class="guide-who">For <strong>${esc(c.name)}</strong>${c.company ? ` · ${esc(c.company)}` : ''} <button type="button" class="linkbtn" id="g-change">Change</button></div>

      <details class="guide-paste" id="g-paste">
        <summary>Got an email or text from them? Paste it and we’ll fill this in.</summary>
        <label class="sr-only" for="g-paste-text">Their message</label>
        <textarea class="input" id="g-paste-text" rows="5" placeholder="e.g. Need 48 navy Gildan 18500 hoodies, 6 S 14 M 16 L 8 XL 4 2XL, 2 colour front and 1 colour back"></textarea>
        <button type="button" class="btn secondary" id="g-paste-go">Fill it in for me</button>
      </details>

      <h2 class="guide-q">1. What are they getting?</h2>
      <div class="grid2">
        <div class="field"><label for="g-garment">Item</label><input class="input" id="g-garment" value="${esc(o.garment)}" placeholder="Gildan 5000 T-shirt" autocomplete="off"></div>
        <div class="field"><label for="g-color">Colour</label><input class="input" id="g-color" value="${esc(o.garment_color)}" placeholder="Black" autocomplete="off"></div>
      </div>

      <h2 class="guide-q">2. How many of each size?</h2>
      <div class="size-grid" id="g-sizes">${[...SIZE_ROW, ...(state.moreSizes ? MORE_SIZES : [])].map((s) => `<label class="size-box"><span>${s}</span>
        <input class="input" type="number" min="0" inputmode="numeric" data-size="${s}" value="${o.sizes[s] || ''}" placeholder="0" aria-label="${s} quantity"></label>`).join('')}</div>
      <div class="guide-row">
        ${state.moreSizes ? '' : '<button type="button" class="linkbtn" id="g-more-sizes">＋ More sizes (4XL, youth…)</button>'}
        <span class="spacer"></span>
        <label class="guide-total" for="g-total">Don’t know sizes yet? Total pieces <input class="input" id="g-total" type="number" min="0" inputmode="numeric" value="${o.total_pieces || ''}" placeholder="0"></label>
      </div>

      <h2 class="guide-q">3. How is it decorated?</h2>
      <div class="choice-row" id="g-deco" role="radiogroup" aria-label="Decoration">${state.services.map((s) => `<button type="button" class="choice${s.name === deco ? ' on' : ''}" role="radio" aria-checked="${s.name === deco}" data-deco="${esc(s.name)}">${esc(FRIENDLY[s.name] || s.name)}</button>`).join('')}</div>

      <h2 class="guide-q">4. Where does it go?</h2>
      <div class="spots" id="g-spots">${o.locations.map((l, i) => `<div class="spot">
        <label class="sr-only" for="g-spot-${i}">Print location ${i + 1}</label>
        <select class="input" id="g-spot-${i}" data-spot="${i}">${SPOTS.map((s) => `<option${s === l.name ? ' selected' : ''}>${s}</option>`).join('')}</select>
        ${colorAxis ? `<label class="spot-colors">Ink colours
          <select class="input" data-colors="${i}" aria-label="Ink colours for location ${i + 1}">${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<option${n === l.colors ? ' selected' : ''}>${n}</option>`).join('')}</select></label>` : ''}
        ${o.locations.length > 1 ? `<button type="button" class="del" data-rm-spot="${i}" aria-label="Remove location ${i + 1}">&times;</button>` : ''}
      </div>`).join('')}</div>
      <button type="button" class="btn ghost sm" id="g-add-spot">＋ Add another spot</button>
      ${colorAxis ? `<label class="guide-check"><input type="checkbox" id="g-dark"${o.dark_garment ? ' checked' : ''}> Dark shirt (adds a white underbase)</label>` : ''}
    </section>

    <div class="price-dock" id="g-dock" hidden><span class="price-dock-v" id="g-dock-v"></span><button type="button" class="btn primary" id="g-dock-go">Create →</button></div>
    <aside class="guide-card price-card" aria-live="polite">
      <h2 class="guide-q">Price</h2>
      <div id="g-price"></div>
      <button type="button" class="btn primary big" id="g-create" disabled>Create estimate →</button>
      <p class="guide-hint center">You can change anything after.</p>
    </aside>
  </div>`

  $('#g-change').onclick = () => { state.step = 1; draw() }
  $('#g-garment').oninput = (e) => { o.garment = e.target.value; reprice() }
  $('#g-color').oninput = (e) => { o.garment_color = e.target.value; reprice() }
  on($('#g-sizes'), '[data-size]', (_e, t) => { const n = Math.max(0, Math.floor(+t.value || 0)); if (n) o.sizes[t.dataset.size] = n; else delete o.sizes[t.dataset.size]; reprice() }, 'input')
  $('#g-total').oninput = (e) => { o.total_pieces = Math.max(0, Math.floor(+e.target.value || 0)); reprice() }
  $('#g-more-sizes')?.addEventListener('click', () => { state.moreSizes = true; drawWhat() })
  // Bound to elements this render just made: #g-body outlives every redraw, and a listener on it
  // would fire once more for each one.
  on($('#g-deco'), '[data-deco]', (_e, t) => { o.decoration = t.dataset.deco; drawWhat() })
  on($('#g-spots'), '[data-spot]', (_e, t) => { o.locations[+t.dataset.spot].name = t.value; reprice() }, 'change')
  on($('#g-spots'), '[data-colors]', (_e, t) => { o.locations[+t.dataset.colors].colors = +t.value; reprice() }, 'change')
  on($('#g-spots'), '[data-rm-spot]', (_e, t) => { o.locations.splice(+t.dataset.rmSpot, 1); drawWhat() })
  $('#g-add-spot').onclick = () => {
    const used = new Set(o.locations.map((l) => l.name))
    o.locations.push({ name: SPOTS.find((s) => !used.has(s)) || 'Back', colors: 1 })
    drawWhat()
  }
  $('#g-dark')?.addEventListener('change', (e) => { o.dark_garment = e.target.checked; reprice() })
  $('#g-paste-go').onclick = () => fillFromText($('#g-paste-text').value)
  $('#g-create').onclick = create
  $('#g-dock-go').onclick = create
  reprice(true)
}

/** Read a pasted message with the same parser Autopilot and the assistant use, then show it. */
async function fillFromText(text) {
  if (String(text || '').trim().length < 8) return toast('Paste their message first', true)
  const btn = $('#g-paste-go'); btn.disabled = true; btn.textContent = 'Reading…'
  try {
    const r = await api.post('/api/ai/intake', { text })
    const o = state.order
    if (r.garment) o.garment = r.garment
    if (r.garment_color || r.color) o.garment_color = r.garment_color || r.color
    const sizes = {}
    for (const [k, v] of Object.entries(r.sizes || {})) if (Number(v) > 0) sizes[k] = Math.floor(Number(v))
    o.sizes = sizes
    if (Object.keys(sizes).some((k) => MORE_SIZES.includes(k))) state.moreSizes = true
    o.total_pieces = Number(r.total_pieces) > 0 ? Math.floor(Number(r.total_pieces)) : 0
    if (r.decoration && state.services.some((s) => s.name === r.decoration)) o.decoration = r.decoration
    if (Array.isArray(r.locations) && r.locations.length) o.locations = r.locations.slice(0, 8).map((l) => ({ name: SPOTS.includes(l.name) ? l.name : 'Front', colors: Math.max(1, Math.min(8, Number(l.colors) || 1)) }))
    o.dark_garment = !!r.dark_garment
    toast('Filled in from their message. Check it over.')
    drawWhat()
  } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = 'Fill it in for me' }
}

function reprice(now = false) {
  clearTimeout(priceTimer)
  const box = $('#g-price'), createBtn = $('#g-create')
  if (!box) return
  if (!piecesOf(state.order)) {
    state.priced = null
    box.innerHTML = '<p class="price-empty">Enter how many they want and the price shows up here.</p>'
    createBtn.disabled = true
    return
  }
  box.classList.add('busy')
  priceTimer = setTimeout(async () => {
    const seq = ++priceSeq
    try {
      const r = await api.post('/api/quick-price', { order: state.order, contact_id: state.contact?.id })
      if (seq !== priceSeq || !$('#g-price')) return
      state.priced = r.priced
      paintPrice()
    } catch (err) {
      if (seq !== priceSeq || !$('#g-price')) return
      state.priced = null
      $('#g-price').classList.remove('busy')
      $('#g-price').innerHTML = `<p class="price-empty bad">Could not price this: ${esc(err.message)}</p>`
      $('#g-create').disabled = true
    }
  }, now ? 0 : 350)
}

function paintPrice() {
  const p = state.priced, box = $('#g-price')
  box.classList.remove('busy')
  if (!p) { box.innerHTML = '<p class="price-empty">Enter how many they want and the price shows up here.</p>'; $('#g-create').disabled = true; return }
  box.innerHTML = `<div class="price-big">${money(p.totals.total)}</div>
    <div class="price-sub">${p.pieces} piece${p.pieces === 1 ? '' : 's'} · ${money(p.per_piece)} each${p.totals.tax ? ` · incl. ${money(p.totals.tax)} tax` : ''}</div>
    <ul class="price-lines">${p.items.map((i) => {
      const qty = i.qty || Object.values(i.sizes || {}).reduce((a, n) => a + (Number(n) || 0), 0)
      return `<li><span>${esc(i.description)}</span><span>${qty} × ${money(i.unit_price)}</span></li>`
    }).join('')}</ul>
    ${p.blank?.source === 'default' ? '<p class="guide-hint">Blank cost is your shop default. Connect a supplier in Setup for live prices.</p>' : ''}`
  $('#g-create').disabled = false
  // On a phone the price card is below the whole form; the dock keeps the total in sight.
  $('#g-dock').hidden = false
  $('#g-dock-v').textContent = `${money(p.totals.total)} · ${p.pieces} pcs`
}

async function create() {
  if (!state.priced) return
  const btn = $('#g-create'); btn.disabled = true; btn.textContent = 'Creating…'
  const o = state.order
  // The engine names the garment; the colour the shop typed belongs on the customer's line too.
  const items = state.priced.items.map((it, i) => (i === 0 && o.garment_color && !String(it.description).toLowerCase().includes(o.garment_color.toLowerCase())
    ? { ...it, description: `${it.description.replace(/ — /, ` (${o.garment_color}) — `)}` } : it))
  try {
    const est = await api.post('/api/estimates', { contact_id: state.contact.id, items })
    state.created = est
    state.step = 3
    draw()
  } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = 'Create estimate →' }
}

/* ---------- 3. send ---------- */
function drawSend() {
  const e = state.created
  let c = state.contact
  const first = esc(String(c.name || '').split(' ')[0] || 'them')
  $('#g-body').innerHTML = `<section class="guide-card guide-done">
    <div class="done-badge" aria-hidden="true">✓</div>
    <h2 class="guide-q">${esc(e.estimate_number)} is ready · ${money(e.total)}</h2>
    ${c.email
      ? `<p class="guide-hint" id="g-send-hint">Send it to <strong>${esc(c.email)}</strong>. They get a link to look it over and approve it.</p>`
      : `<p class="guide-hint" id="g-send-hint">${esc(c.name)} has no email on file yet. Add it and we send the estimate there.</p>
         <div class="field narrow"><label for="g-email">Their email</label><input class="input" id="g-email" type="email" autocomplete="off" placeholder="name@example.com"></div>`}
    <div class="guide-actions" id="g-send-row">
      <button type="button" class="btn primary big" id="g-send">Send it to ${first} →</button>
      <a class="btn ghost big" href="#/estimates/${e.id}">Look it over first</a>
    </div>
    <div id="g-sent"></div>
  </section>`
  $('#g-send').onclick = async () => {
    const btn = $('#g-send'), label = btn.textContent
    const emailBox = $('#g-email')
    if (emailBox && !emailBox.value.trim()) { toast('Type their email first', true); emailBox.focus(); return }
    btn.disabled = true; btn.textContent = 'Sending…'
    try {
      if (emailBox) state.contact = c = await api.put(`/api/contacts/${c.id}`, { email: emailBox.value.trim() })
      const fresh = await api.get(`/api/estimates/${e.id}`)
      const r = await api.post(`/api/estimates/${e.id}/send`, { recipient_revision: fresh.recipient_revision })
      const emailed = r.email_live && r.emailed_to
      // The server answers with a path; a link someone pastes into a text has to be whole.
      const link = r.share_url ? new URL(r.share_url, location.origin).href : ''
      $('#g-send-hint')?.remove()
      $('#g-send-row').innerHTML = `<a class="btn ghost" href="#/estimates/${e.id}">Open ${esc(e.estimate_number)}</a>`
      emailBox?.closest('.field')?.remove()
      const canManage = window.__me?.can_manage !== false
      $('#g-sent').innerHTML = `<div class="sent-box">
        <p><strong>${emailed ? `Emailed to ${esc(r.emailed_to)}.` : 'Marked as sent.'}</strong> ${emailed ? '' : 'Your shop email is not connected yet, so nothing went out. Copy this link and send it yourself, or <a href="#/setup">connect email</a>.'}</p>
        ${emailed ? '' : `<div class="copy-row"><input class="input" readonly value="${esc(link)}" aria-label="Customer link"><button type="button" class="btn secondary" id="g-copy">Copy link</button></div>`}
        ${canManage ? '<p class="guide-hint">Want us to nudge them if they go quiet? <a href="#/auto-follow-ups">Turn on automatic follow-ups →</a></p>' : ''}
        <div class="guide-actions"><a class="btn primary" href="#/do/estimate">Make another estimate</a><a class="btn ghost" href="#/">Back to Home</a></div>
      </div>`
      $('#g-copy')?.addEventListener('click', () => copyText(link, 'Link copied'))
    } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = label }
  }
}

// Exposed for the headless view test.
export const _test = { piecesOf, get state() { return state } }
