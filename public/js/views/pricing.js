import { api, $, $$, esc, money, setPage, toast, on, go, modal, closeModal, onOnce, announce, confirmModal, guardLeave } from '../core.js'

/* Pricing Matrix + margin-floor guard — the shop's whole price grid, generated from its own
   costing inputs, with the real margin of every cell and a hard flag on anything that loses money. */

const DECOS = ['Screen Print', 'DTF Transfer', 'Embroidery', 'UV DTF', 'Vinyl', 'Patch']
let state = { deco: 'Screen Print' }

/** Which price card is showing. Screen print prices on colors; embroidery on stitch count; DTF on
 *  the square inch of film. They are genuinely different charts, so they get their own tabs. */
let chart = 'screen'

export async function pricingView() {
  setPage('Pricing')
  await loadChart(chart)
}

async function loadChart(which) {
  // "Your matrices" is a screen of its own (list + editor + deep links), not a tab body.
  if (which === 'matrices') return go('/matrices')
  chart = which
  if (which === 'book') return loadBook()
  const qs = which === 'screen' ? '' : `?chart=${which}`
  const r = await api.get(`/api/pricing/matrix${qs}`)
  if (which === 'screen') { state = { ...r.defaults, deco: 'Screen Print' }; render(r.matrix, r.defaults) }
  else { state = { ...r.defaults }; renderChart(r.matrix) }
}

const chartTabs = () => `<div class="tabs" id="pm-tabs" style="margin-bottom:14px">
  ${[['screen', 'Screen Print'], ['embroidery', 'Embroidery'], ['dtf', 'DTF'], ['book', 'Your prices'], ['matrices', 'Your matrices']]
    .map(([k, l]) => `<button data-c="${k}" class="${chart === k ? 'on' : ''}">${l}</button>`).join('')}
</div>`

/* ── The price book editor ────────────────────────────────────────────────────
   Every shop starts on a stock book so it can quote in its first minute. This screen exists so no
   shop is stuck with our numbers: every rate, every setup fee, and the services themselves are the
   shop's to change, and a shop can add work the stock book never heard of. */

async function loadBook() {
  const b = await api.get('/api/pricebook')
  renderBook(b)
}

const AXIS_HELP = {
  colors: 'Price rises per ink colour.',
  stitches: 'Price rises per 1,000 stitches.',
  area: 'Price rises per square inch printed.',
  flat: 'One rate per piece, per placement.',
}

function serviceCard(s) {
  const su = s.setup || {}
  const n = (v) => (v === null || v === undefined ? '' : v)
  return `<div class="card pb-svc" data-svc="${esc(s.name)}">
    <div class="card-h"><h3>${esc(s.name)}</h3>
      ${s.custom ? '<span class="pill">yours</span>' : s.edited ? '<span class="pill amber">edited</span>' : '<span class="pill">stock</span>'}
      <div class="spacer"></div>
      <span class="dim" style="font-size:11px">${esc(s.axisLabel)}</span></div>
    <div class="card-b">
      <p class="dim" style="font-size:12px;margin-bottom:12px">${esc(AXIS_HELP[s.axis] || '')} Prices below are per piece at 48 pieces; bigger runs get the quantity break automatically.</p>
      <div class="grid2">
        <div class="field"><label>Base rate ($/piece)</label>
          <input class="input" data-f="base" type="number" step="0.01" value="${n(s.base)}"></div>
        <div class="field"><label>${s.axis === 'stitches' ? 'Per 1,000 stitches ($)' : s.axis === 'area' ? 'Per sq inch ($)' : s.axis === 'colors' ? 'Each extra colour ($)' : 'Per extra unit ($)'}</label>
          <input class="input" data-f="perUnit" type="number" step="0.01" value="${n(s.perUnit)}"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Minimum per piece ($)</label>
          <input class="input" data-f="minPerPiece" type="number" step="0.01" value="${n(s.minPerPiece)}"></div>
        <div class="field"><label>Setup fee ($)</label>
          <input class="input" data-f="setupFee" type="number" step="0.01" value="${n(su.fee)}"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Setup is called</label>
          <input class="input" data-f="setupLabel" type="text" value="${esc(n(su.label))}" placeholder="leave blank for no setup line"></div>
        <div class="field"><label>Charged per</label>
          <select class="input" data-f="setupPer">
            <option value="design" ${su.per === 'design' ? 'selected' : ''}>Design (once per artwork)</option>
            <option value="color" ${su.per === 'color' ? 'selected' : ''}>Colour (once per screen)</option>
          </select></div>
      </div>
      <div class="row" style="gap:10px;align-items:center;margin-top:4px">
        <button class="btn sm pb-save" type="button">Save ${esc(s.name)}</button>
        ${s.edited ? `<button class="btn ghost sm pb-reset" type="button">${s.custom ? 'Delete this service' : 'Reset to stock'}</button>` : ''}
        <span class="dim pb-note" role="status" aria-live="polite" aria-atomic="true" style="font-size:11.5px"></span>
      </div>
    </div></div>`
}

function renderBook(b) {
  const app = $('#view')
  app.innerHTML = `<div class="stack">
    ${chartTabs()}
    <div class="card"><div class="card-h"><h3>Your prices</h3><div class="spacer"></div>
      <span class="dim" style="font-size:11px">${b.services.length} services</span></div>
      <div class="card-b">
        <p class="dim" style="font-size:12.5px;line-height:1.6">Every shop starts on our stock rates so you can quote today. They are a starting point, not a rule. Change any number, rename any setup fee, or add work we've never heard of. Whatever you set here is what your quotes use, everywhere: Autopilot, Slack, and the estimate screen.</p>
        <p class="dim" style="font-size:12.5px;line-height:1.6;margin-top:10px">Sell something this calculator has never modelled — mug printing, laser engraving, banners by the square foot? Build a <a href="#/matrices">price matrix of your own</a>: any name, your row and column headings, your prices.</p>
      </div></div>

    <div class="card" id="pm-matrix-card"><div class="card-b dim" style="font-size:12.5px">Loading your price matrix…</div></div>

    ${b.services.map(serviceCard).join('')}
    <div class="card"><div class="card-h"><h3>Add a service</h3></div>
      <div class="card-b">
        <p class="dim" style="font-size:12.5px;margin-bottom:12px">Puff embroidery, sublimation, foil, rhinestones — anything you sell.</p>
        <div class="grid2">
          <div class="field"><label>Name</label><input class="input" id="pb-new-name" placeholder="e.g. Puff Embroidery"></div>
          <div class="field"><label>Prices on</label><select class="input" id="pb-new-axis">
            ${b.axes.map((a) => `<option value="${a.key}">${esc(a.label)}</option>`).join('')}
          </select></div>
        </div>
        <div class="grid2">
          <div class="field"><label>Base rate ($/piece)</label><input class="input" id="pb-new-base" type="number" step="0.01" value="5.00"></div>
          <div class="field"><label>Setup fee ($)</label><input class="input" id="pb-new-fee" type="number" step="0.01" value="0"></div>
        </div>
        <button class="btn sm" id="pb-add" type="button">Add service</button>
      </div></div>
  </div>`
  wireBook(b)
  loadMatrix()
}

/**
 * The matrix redraw after a save used to be an unconditional `setTimeout(() => loadMatrix(), 600)`.
 * On a grid of up to 8 quantity bands × 14 colour counts, carrying straight on to the next cell
 * after clicking Save is the natural motion — and 600 ms in, the grid was rebuilt from the server
 * and that half-typed cell silently reverted. For a keyboard user it also destroyed focus on every
 * save. The redraw only exists to repaint the pm-custom markers, so it can wait until the shop has
 * stopped typing in the grid.
 */
function reloadMatrixUnlessTyping() {
  setTimeout(() => {
    const a = document.activeElement
    if (a && a.closest?.('.pm-editable')) return
    loadMatrix()
  }, 600)
}

let bookBound = false
let bookData = null
function wireBook(b) {
  bookData = b
  if (bookBound) return
  bookBound = true
  onOnce($('#view'), '#pm-tabs button', (e, el) => leaveMatrix(() => loadChart(el.dataset.c)))

  const readCard = (card) => {
    const g = (f) => card.querySelector(`[data-f="${f}"]`)?.value
    const label = (g('setupLabel') || '').trim()
    return {
      axis: bookData.services.find((x) => x.name === card.dataset.svc)?.axis,
      base: g('base'), perUnit: g('perUnit'), minPerPiece: g('minPerPiece'),
      setup: { label: label || null, fee: g('setupFee'), per: g('setupPer') },
    }
  }
  onOnce($('#view'), '.pb-save', async (e, el) => {
    const card = el.closest('.pb-svc'), name = card.dataset.svc, note = card.querySelector('.pb-note')
    note.textContent = 'Saving…'
    try {
      await api.put('/api/pricebook', { services: { [name]: readCard(card) } })
      // Refresh THIS card, not the screen.
      //
      // This was `setTimeout(() => loadBook(), 700)`, and loadBook() does `#view`.innerHTML — so
      // saving one service silently threw away every number the shop had typed into every OTHER
      // service card, 700 ms later, while they were still typing. The price book is a stack of one
      // card per service with six fields each, and going down the page retyping rates is exactly
      // how a shop uses this screen: new base rate on Screen Print, new per-colour, a new minimum
      // on Embroidery, then Save on the first card because it is the one you finished. Everything
      // below it reverted, with a green "Saved" underneath.
      //
      // The reload only ever existed to refresh this card's own pill (stock → edited → yours) and
      // reveal its "Reset to stock" button, both of which live in serviceCard(). So re-render the
      // one card, keep its note, and leave the rest of the page — and the caret — alone.
      const fresh = (await api.get('/api/pricebook')).services.find((sv) => sv.name === name)
      if (fresh) {
        card.outerHTML = serviceCard(fresh)
        const again = $(`.pb-svc[data-svc="${CSS.escape(name)}"] .pb-note`, $('#view'))
        if (again) again.innerHTML = '<span style="color:var(--accent)">Saved — your quotes use this now.</span>'
      } else {
        note.innerHTML = '<span style="color:var(--accent)">Saved — your quotes use this now.</span>'
      }
      // The note element is REPLACED with the card, so writing into a live region is not enough
      // on its own — the region a screen reader was watching no longer exists. Say it out loud.
      announce(`${name} saved — your quotes use this now.`)
    } catch (err) {
      note.innerHTML = `<span style="color:var(--red)">${esc(err.message)}</span>`
      announce(`${name} was not saved. ${err.message}`, true)
    }
  })
  onOnce($('#view'), '.pb-reset', async (e, el) => {
    const name = el.closest('.pb-svc').dataset.svc
    // ?name=, not the path: a service the shop called "Front/Back" encodes to %2F, which the
    // path-canonicalisation guard refuses — so in the path this button 404'd on exactly the names
    // a shop is most likely to invent, and left the service unremovable.
    await api.del(`/api/pricebook?name=${encodeURIComponent(name)}`)
    toast(`${name} reset`); loadBook()
  })
  onOnce($('#view'), '#mx-svc', (_e, el) => leaveMatrix(() => loadMatrix(el.value)), 'change')
  onOnce($('#view'), '#mx-colors', (_e, el) => leaveMatrix(() => loadMatrix(null, Number(el.value) || 8)), 'change')
  onOnce($('#view'), '#mx-save', async () => {
    const note = $('#mx-note'); note.textContent = 'Saving…'
    try {
      const r = await api.put('/api/pricebook', { matrices: { [mxState.service]: collectMatrixCells() } })
      mxDirty = false
      note.innerHTML = `<span style="color:var(--accent)">Saved. ${r.cells} custom cell(s) — your quotes use these now.</span>`
      announce(`Matrix saved. ${r.cells} custom cell${r.cells === 1 ? '' : 's'}.`)
      reloadMatrixUnlessTyping()
    } catch (err) {
      note.innerHTML = `<span style="color:var(--red)">${esc(err.message)}</span>`
      announce(`The matrix was not saved. ${err.message}`, true)
    }
  })
  onOnce($('#view'), '#mx-file', async (_e, el) => {
    const file = el.files && el.files[0]; if (!file) return
    const note = $('#mx-note'); note.textContent = 'Reading your sheet…'
    try {
      const fd = new FormData(); fd.append('file', file); fd.append('service', mxState.service)
      const r = await api.req('POST', '/api/pricebook/import', fd)
      // The sheet's own price breaks travel with its prices. Without them the cells are keyed to
      // rows the book does not have, and every break the stock list lacks reads as the calculator.
      await api.put('/api/pricebook', { matrices: { [mxState.service]: r.cells }, ...(r.bands ? { bands: r.bands } : {}) })
      note.innerHTML = `<span style="color:var(--accent)">Imported ${r.filled} price(s) from your sheet.</span>`
      announce(`Imported ${r.filled} price${r.filled === 1 ? '' : 's'} from your sheet.`)
      reloadMatrixUnlessTyping()
    } catch (err) {
      note.innerHTML = `<span style="color:var(--red)">${esc(err.message)}</span>`
      announce(`That sheet could not be read. ${err.message}`, true)
    }
    el.value = ''
    // 'change', not onOnce's default 'click'. The input is display:none inside a <label class="btn">,
    // so clicking the label fires a synthetic click on the input that BUBBLES — this handler ran
    // with no file yet and returned, the picker opened, the shop chose a sheet, and nothing was
    // listening for it. The one import path in the price book never ran at all.
  }, 'change')
  onOnce($('#view'), '#pb-add', async () => {
    const name = $('#pb-new-name').value.trim()
    if (!name) return toast('Give the service a name')
    const existing = {}
    existing[name] = { axis: $('#pb-new-axis').value, base: $('#pb-new-base').value, perUnit: 0, minPerPiece: $('#pb-new-base').value, setup: { label: Number($('#pb-new-fee').value) > 0 ? 'Setup' : null, fee: $('#pb-new-fee').value, per: 'design' } }
    await api.put('/api/pricebook', { services: existing })
    toast(`${name} added`); loadBook()
  })
}

/* ---------- editable price matrix — the shop's OWN cell prices win over the calculator ---------- */
let mxState = { service: null, colors: 8 }

async function loadMatrix(service, colors) {
  const card = $('#pm-matrix-card'); if (!card) return
  if (service) mxState.service = service
  if (colors) mxState.colors = colors
  let r
  try {
    const qs = new URLSearchParams({ colors: String(mxState.colors) })
    if (mxState.service) qs.set('service', mxState.service)
    r = await api.get(`/api/pricebook/matrix?${qs}`)
  } catch { card.innerHTML = '<div class="card-b dim">Price matrix unavailable.</div>'; return }
  mxState.service = r.matrix.service
  renderMatrix(card, r)
}

function renderMatrix(card, r) {
  const m = r.matrix
  const isColors = m.axis === 'colors'
  // Every one of these cells is a real sell price the app quotes from — "your number beats the
  // calculator" — and up to 8 quantity bands × 14 colour counts is 112 of them. Unlabelled, a
  // screen reader calls each one "edit text, blank", with no way to know whether you are typing
  // the 24-piece 3-colour price or the 500-piece 1-colour price. matrices.js labels the identical
  // grid; this one, the one the price book itself uses, never did.
  const colName = (c) => (isColors ? `${c} colour${c === 1 ? '' : 's'}` : String(c))
  const head = m.cols.map((c) => `<th scope="col">${isColors ? c + (c === 1 ? ' color' : '') : esc(String(c))}</th>`).join('')
  const body = m.rows.map((row) => `<tr>
    <th class="pm-qty" scope="row">${row.qty}+</th>
    ${row.cells.map((price, i) => `<td class="pm-cell ${row.custom[i] ? 'pm-custom' : ''}">
      <input class="pm-in" data-cell="${bandKey(m, row.qty)}|${m.cols[i]}" type="number" step="0.01" min="0" inputmode="decimal"
        aria-label="${esc(String(row.qty))}+ pieces, ${esc(colName(m.cols[i]))}"
        value="${row.custom[i] ? Number(price).toFixed(2) : ''}" placeholder="${Number(price).toFixed(2)}"></td>`).join('')}
  </tr>`).join('')
  card.innerHTML = `<div class="card-h"><h3>Your price matrix</h3><div class="spacer"></div>
      <span class="dim" style="font-size:11px">your number beats the calculator</span></div>
    <div class="card-b">
      <p class="dim" style="font-size:12.5px;line-height:1.6;margin-bottom:12px">Type your real price into any cell and that exact number is what quotes use for that quantity and colour count, even if it doesn't match the calculator. Leave a cell blank to let the calculator fill it. Or upload your existing price sheet.</p>
      <div class="row" style="gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
        <div class="field" style="margin:0"><label style="font-size:11px">Service</label>
          <select class="input" id="mx-svc">${r.services.map((sv) => `<option ${sv === m.service ? 'selected' : ''}>${esc(sv)}</option>`).join('')}</select></div>
        ${isColors ? `<div class="field" style="margin:0"><label style="font-size:11px">Colours on your press</label>
          <input class="input" id="mx-colors" type="number" min="1" max="14" value="${m.cols.length}" style="width:90px"></div>` : ''}
        <div class="spacer"></div>
        <label class="btn ghost sm" style="cursor:pointer">Upload price sheet<input type="file" id="mx-file" accept=".csv,text/csv,text/plain" style="display:none"></label>
        <button class="btn sm" id="mx-save" type="button">Save matrix</button>
      </div>
      <div class="tbl-wrap"><table class="pm-table pm-editable">
        <thead><tr><th>Qty &darr; / ${isColors ? 'Colours' : 'Units'} &rarr;</th>${head}</tr></thead>
        <tbody>${body}</tbody></table></div>
      <div id="mx-note" class="dim" role="status" aria-live="polite" aria-atomic="true" style="font-size:12px;margin-top:10px"></div>
    </div>`
  // The card is rebuilt from the server on every load, so the freshly drawn grid is clean and the
  // listeners go on the cells this render just made.
  mxDirty = false
  for (const i of card.querySelectorAll('.pm-in')) i.addEventListener('input', () => { mxDirty = true })

  /* The paths the app DOES control: the sidebar, the tabbar, the `g` keyboard shortcuts and the
   * browser's Back button. Every one of them is a hash change, and a hash change fires no
   * beforeunload — so the listener below never saw any of them. This is the choke point that does.
   * Refusing owns re-issuing the navigation once the shop has answered. */
  guardLeave((to) => {
    if (!mxDirty) return true
    confirmModal('Leave these prices?',
      'The prices you typed into the grid have not been saved. Leaving now discards them.',
      () => { mxDirty = false; go(to) }, 'Discard changes')
    return false
  })
}

/* -------------------------------------------------------------------------------------------------
 * The grid holds up to 8 quantity bands × 14 colour counts = 112 real sell prices, and nothing is
 * on the server until Save matrix. Three controls sitting directly above it — the Service select,
 * the "Colours on your press" box and every tab in #pm-tabs — called loadMatrix()/loadChart(),
 * which overwrite the card from the SERVER. A shop that went down the grid typing its real rates
 * and then changed the Service to check the embroidery sheet lost the lot: no confirm, no toast,
 * no undo. These are the numbers every quote, Autopilot and the Slack quick-quote price from, and
 * the card itself says "your number beats the calculator".
 *
 * views/matrices.js already ships this guard for its own grid, and reloadMatrixUnlessTyping()
 * above shows the shape was known — it just only covered the redraw the SAVE schedules.
 * ---------------------------------------------------------------------------------------------- */
let mxDirty = false

/** Run `next` — but not over prices the shop has typed and not saved. */
function leaveMatrix(next) {
  if (!mxDirty) return next()
  confirmModal('Leave these prices?',
    'The prices you typed into the grid have not been saved. Changing this discards them.',
    () => { mxDirty = false; next() }, 'Discard changes')
}

// The band-min for a qty (mirrors the server key) — the matrix rows are already band mins, so use qty.
const bandKey = (m, qty) => qty

function collectMatrixCells() {
  const cells = {}
  document.querySelectorAll('#pm-matrix-card .pm-in').forEach((i) => {
    const v = i.value.trim()
    cells[i.dataset.cell] = v === '' ? '' : Number(v)   // '' clears the cell server-side
  })
  return cells
}

function wireTabs() {
  on($('#pm-tabs'), '[data-c]', (_e, t) => loadChart(t.dataset.c))
}

/**
 * The embroidery and DTF cards. Same shape as the screen-print grid — quantity down the side, the
 * thing that actually drives the price across the top — but no margin colouring, because these are
 * sell-price cards a shop reads off to a customer rather than a costing model.
 */
function renderChart(m) {
  const emb = m.kind === 'embroidery'
  const cols = emb ? m.stitchCounts.map((s) => `${(s / 1000).toLocaleString()}k`) : m.sizes.map((z) => z.label)
  const controls = emb
    ? [num('garment', 'Blank cost $', 'per piece'), num('markup', 'Markup ×', 'on the blank'),
       num('rate_1k', 'Per 1,000 stitches $', 'your stitch rate', '0.05'),
       num('min_charge', 'Minimum $', 'per piece floor', '0.5'),
       num('digitizing', 'Digitizing $', 'one-time setup', '1')]
    : [num('garment', 'Blank cost $', 'per piece'), num('markup', 'Markup ×', 'on the blank'),
       num('per_sq_in', 'Price / sq inch $', 'printed film', '0.005'),
       num('press_fee', 'Pressing $', 'per piece labor', '0.25'),
       num('min_charge', 'Minimum $', 'per piece floor', '0.5')]

  $('#view').innerHTML = `<div class="stack" style="max-width:1040px">
    ${chartTabs()}
    <div class="card">
      <div class="card-h"><h3>${emb ? 'Embroidery' : 'DTF'} price card</h3><div class="spacer"></div>
        <span class="pill">quantity breaks built in</span></div>
      <div class="card-b">
        <p class="dim" style="font-size:12.5px;line-height:1.6;margin-bottom:14px">${emb
          ? 'Embroidery is sold by <strong style="color:var(--txt-2)">stitch count</strong>, not colors — thread is cheap, machine time is not. Set your rate per 1,000 stitches and the whole card prices itself. Digitizing is a one-time charge on the first order.'
          : 'DTF is sold by the <strong style="color:var(--txt-2)">square inch</strong> of printed film, plus the per-piece labor of pressing it on. Set your per-square-inch rate and your pressing fee.'}
          The decoration price drops as the run grows; the blank and the pressing don\'t.</p>
        <div class="pm-controls">${controls.join('')}</div>
      </div>
    </div>

    <div class="card">
      <div class="card-h"><h3>Per-piece price</h3><div class="spacer"></div>
        <span class="dim" style="font-size:11.5px">blank ${money(m.blank)} included</span></div>
      <div class="card-b">
        <div class="tbl-wrap"><table class="pm-table">
          <thead><tr><th>Qty ↓ / ${emb ? 'Stitches' : 'Size'} →</th>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
          <tbody>${m.rows.map((r) => `<tr>
            <th class="pm-qty">${r.qty}+<div class="dim" style="font-weight:400;font-size:10px">${Math.round((1 - r.factor) * 100)}% off deco</div></th>
            ${r.cells.map((c) => `<td class="pm-cell">
              <div class="pm-price">${money(c.perPiece)}</div>
              <div class="pm-margin">${emb ? money(c.decoration) + ' stitch' : money(c.film) + ' film'}</div>
            </td>`).join('')}
          </tr>`).join('')}</tbody>
        </table></div>
        <p class="dim" style="font-size:11.5px;margin-top:12px;line-height:1.6">${emb
          ? `Add <strong style="color:var(--txt-2)">${money(m.inputs.digitizingFee)}</strong> digitizing once per new design. Re-orders of the same file skip it.`
          : `Every price includes <strong style="color:var(--txt-2)">${money(m.inputs.pressFee)}</strong> pressing per piece.`}
          Change any number above and the card re-prices instantly. These are sell prices — nothing here is saved until you edit your defaults in Settings.</p>
      </div>
    </div>
  </div>`

  const recompute = async () => {
    const q = new URLSearchParams({ chart })
    $$('#view .pm-controls [name]').forEach((el) => q.set(el.name, el.value))
    try {
      const r = await api.get(`/api/pricing/matrix?${q}`)
      $$('#view .pm-controls [name]').forEach((el) => { state[el.name] = el.value })
      renderChart(r.matrix)
    } catch (e) { toast(e.message, true) }
  }
  $$('#view .pm-controls [name]').forEach((el) => { el.onchange = recompute })
  wireTabs()
}

function num(name, label, hint, step = '0.1') {
  return `<div class="pm-input"><label>${label}</label>
    <input class="input" name="${name}" type="number" step="${step}" value="${esc(state[name] ?? '')}">
    <div class="pm-hint">${hint}</div></div>`
}

function render(matrix, defaults) {
  const cellClass = (c) => c.belowFloor ? 'pm-cell below' : `pm-cell ${c.verdict}`
  $('#view').innerHTML = `<div class="stack" style="max-width:1040px">
    ${chartTabs()}
    <div class="card">
      <div class="card-h"><h3>Pricing matrix</h3><span class="pill green">margin floor ${matrix.targetMargin}%</span><div class="spacer"></div><button class="btn ghost sm" id="rate-wizard">◱ True shop rate</button></div>
      <div class="card-b">
        <p class="dim" style="font-size:12.5px;line-height:1.6;margin-bottom:14px">Your whole price grid, generated from <strong style="color:var(--txt-2)">your</strong> costing — garment, markup, real press time, and the load-bearing <strong style="color:var(--txt-2)">press-utilization %</strong>. Every cell shows the true margin, and anything under your floor is flagged <span style="color:var(--red);font-weight:600">before</span> a customer ever asks. Change an assumption and the whole grid re-prices live — no spreadsheet.</p>
        <div class="pm-controls">
          <div class="pm-input"><label>Decoration</label>
            <select class="input" name="deco">${DECOS.map((d) => `<option ${state.deco === d ? 'selected' : ''}>${d}</option>`).join('')}</select>
            <div class="pm-hint">changes cost basis</div></div>
          ${num('garment', 'Blank cost $', 'per piece')}
          ${num('markup', 'Markup ×', 'on the blank')}
          ${num('rate', 'Shop rate $/hr', 'loaded')}
          ${num('util', 'Utilization %', 'press-on time', '1')}
          ${num('screen_fee', 'Screen fee $', 'per color', '1')}
          ${num('target', 'Margin floor %', 'flag below', '1')}
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-h"><h3>${esc(matrix.decoration)} · per-piece price & true margin</h3>
        <div class="spacer"></div>
        <span class="pm-legend"><span class="sw good"></span>Healthy <span class="sw warn"></span>Tight <span class="sw bad"></span>Losing money</span></div>
      <div class="card-b">
        <div class="tbl-wrap"><table class="pm-table">
          <thead><tr><th>Qty ↓ / Colors →</th>${matrix.colorCounts.map((c) => `<th>${c} color${c === 1 ? '' : 's'}</th>`).join('')}</tr></thead>
          <tbody>${matrix.rows.map((r) => `<tr>
            <th class="pm-qty">${r.qty}</th>
            ${r.cells.map((c) => `<td class="${cellClass(c)}" title="${c.belowFloor ? 'Below your ' + matrix.targetMargin + '% floor — ' + c.label : c.label}">
              <div class="pm-price">${money(c.perPiece)}</div>
              <div class="pm-margin">${c.margin}%${c.belowFloor ? ' ⚠' : ''}</div>
            </td>`).join('')}
          </tr>`).join('')}</tbody>
        </table></div>
        <p class="dim" style="font-size:11.5px;margin-top:12px;line-height:1.6">Margin is figured against real job cost — blanks + <strong style="color:var(--txt-2)">press time costed at your rate ÷ utilization</strong> + screens + spoilage. That utilization divide is why a 12-piece, 6-color run shows red: the setup eats the run. Most shops price these at a loss and never know.</p>
      </div>
    </div>
  </div>`

  const recompute = async () => {
    const q = new URLSearchParams({
      deco: $('[name=deco]').value,
      garment: $('[name=garment]').value, markup: $('[name=markup]').value, rate: $('[name=rate]').value,
      util: $('[name=util]').value, screen_fee: $('[name=screen_fee]').value, target: $('[name=target]').value,
    })
    try {
      const r = await api.get(`/api/pricing/matrix?${q}`)
      state = { deco: $('[name=deco]').value, garment: $('[name=garment]').value, markup: $('[name=markup]').value, rate: $('[name=rate]').value, util: $('[name=util]').value, screen_fee: $('[name=screen_fee]').value, target: $('[name=target]').value }
      render(r.matrix, r.defaults)
    } catch (e) { toast(e.message, true) }
  }
  $$('#view .pm-controls [name]').forEach((el) => { el.onchange = recompute })
  $('#rate-wizard').onclick = () => openRateWizard()
  wireTabs()
}

/**
 * The "True Shop Hourly Rate" wizard — Print Life's signature move. Most shops price off a made-up
 * rate; this derives the real one from actual monthly cost ÷ actual productive hours, then writes
 * it to settings so the whole pricing engine and every margin verdict recalculate from truth.
 */
function openRateWizard() {
  const f = (name, label, val, hint) => `<div class="field"><label>${label}</label>
    <input class="input" name="${name}" type="number" min="0" step="1" value="${val}" inputmode="decimal">
    <div class="dim" style="font-size:11px;margin-top:3px">${hint}</div></div>`
  modal({
    title: 'Calculate your true shop rate', wide: true,
    body: `<p class="dim" style="font-size:12.5px;line-height:1.6;margin-bottom:14px">Add up what the shop actually costs to run each month and the hours you actually work. We divide one by the other — that is the real rate your pricing should be built on, not a number you guessed.</p>
      <div class="grid2">
        ${f('rent', 'Rent + facilities / mo', 2800, 'Lease, insurance, utilities')}
        ${f('wages', 'Total wages / mo', 9000, 'Everyone who touches production')}
      </div>
      <div class="grid2">
        ${f('other', 'Equipment + software / mo', 1200, 'Presses, RIP, subscriptions, maintenance')}
        ${f('owner', 'Owner pay / mo', 4000, 'Pay yourself — it belongs in the rate')}
      </div>
      <div class="grid2">
        ${f('staff', 'Production people', 3, 'Bodies on the floor')}
        ${f('hours', 'Hours each / week', 40, 'Actual worked hours')}
      </div>
      <div id="rate-out" class="rate-out"></div>`,
    footer: `<button class="btn ghost" data-close>Cancel</button><button class="btn" id="apply-rate">Use this rate</button>`,
    onMount: (bg) => {
      const calc = () => {
        const v = (n) => Number($(`[name=${n}]`, bg).value) || 0
        const monthly = v('rent') + v('wages') + v('other') + v('owner')
        const workedHours = v('staff') * v('hours') * 4.33
        const rate = workedHours > 0 ? monthly / workedHours : 0
        $('#rate-out', bg).innerHTML = `<div class="rate-big">${money(rate)}<span>/ loaded hour</span></div>
          <div class="dim" style="font-size:12px;line-height:1.6">${money(monthly)}/mo ÷ ${Math.round(workedHours)} worked hours. The pricing engine then divides this by your utilization %, since presses only run part of the clock — so the effective cost of press time is higher still.</div>`
        bg.__rate = Math.round(rate)
      }
      $$('[name]', bg).forEach((el) => { el.oninput = calc })
      calc()
      $('#apply-rate', bg).onclick = async () => {
        try {
          await api.put('/api/settings', { shop_hourly_rate: bg.__rate })
          closeModal(); toast(`Shop rate set to ${money(bg.__rate)}/hr — matrix recalculated`)
          pricingView()
        } catch (e) { toast(e.message, true) }
      }
    },
  })
}
