import { api, $, $$, esc, money, fmtDate, setPage, toast, go, on, modal, closeModal, formData, daysOut } from '../core.js'

/**
 * Order board — the lite edition's whiteboard. Five columns (Estimate → Paid → Mockup Approved →
 * Printing → Shipped) and one card per order, dragged by hand. Deliberately dumb: a card sits where
 * a person put it. Payments and mockup approvals nudge a card FORWARD server-side, never back, so
 * nobody's manual move gets undone by a late deposit.
 *
 * Uses pointer events rather than HTML5 drag-and-drop so it works on the tablet or phone that
 * actually lives on a shop floor — native DnD does not fire on touch at all.
 */

const STAGE_TONE = { quote: 'gray', paid: 'green', mockup: 'blue', printing: 'amber', shipped: 'green' }

export async function ordersView() {
  setPage('Orders', '<button class="btn ghost" id="ob-refresh">Refresh</button>')
  const d = await api.get('/api/orders')

  const card = (c) => {
    // new Date('2026-08-28') is midnight UTC, so comparing it to `now` made an order due TODAY
    // overdue from the first second of the day — in every timezone, including UTC itself. This
    // was the last raw date comparison left in public/js; 629f4dc corrected core.js and every
    // view that imports from it, and missed this one because it does its own arithmetic.
    // daysOut() is the shop's own calendar day, the same predicate the job board already uses.
    const late = c.due_date && c.balance > 0 && daysOut(c.due_date) < 0
    return `<div class="jcard" data-id="${c.id}">
      <div class="jc-h">
        <span class="jc-num">${esc(c.invoice_number || c.estimate_number)}</span>
        <strong class="jc-amt">${money(c.total)}</strong>
      </div>
      <div class="jc-who">${esc(c.contact_name || '—')}${c.company ? ` · ${esc(c.company)}` : ''}</div>
      <div class="jc-tags">
        ${c.invoice_status === 'void' ? '<span class="tag">invoice voided</span>'
          : c.balance > 0 ? `<span class="tag ${late ? 'red' : ''}">${late ? '⚠ overdue · ' : ''}${money(c.balance)} due</span>`
          : c.invoice_id ? '<span class="tag green">paid</span>' : '<span class="tag">not invoiced</span>'}
        ${c.mockup_status === 'approved' ? '<span class="tag green">art ok</span>' : ''}
        ${c.mockup_status === 'sent' ? '<span class="tag amber">art out</span>' : ''}
        ${c.mockup_status === 'rejected' ? '<span class="tag red">art changes</span>' : ''}
      </div>
      ${c.tracking_number ? `<div class="jc-track">${esc(c.carrier || 'Tracking')} ${esc(c.tracking_number)}</div>` : ''}
    </div>`
  }

  $('#view').innerHTML = `
    <p class="dim" style="font-size:12.5px;margin:0 0 12px;line-height:1.6">Drag a card to move the job along. Tap one to open it, add a tracking number, or jump to the estimate.</p>
    <div class="board" id="board">
      ${d.columns.map((col) => `<div class="col" data-stage="${col.key}">
        <div class="col-h"><span class="nm">${esc(col.label)}</span><span class="ct">${col.cards.length}</span></div>
        <div class="col-b" data-drop="${col.key}">
          ${col.cards.map(card).join('') || `<div class="col-empty">${esc(col.hint)}</div>`}
        </div>
      </div>`).join('')}
    </div>`

  $('#ob-refresh').onclick = () => ordersView()

  const byId = (id) => d.columns.flatMap((c) => c.cards).find((c) => String(c.id) === String(id))
  const stages = d.columns.map((c) => ({ key: c.key, label: c.label }))
  wireDnd(() => ordersView(), byId, stages)
  // A TAP has to open the card, and until now nothing on this board answered one.
  //
  // The touch guard in wireDnd returns before `st` is assigned, and the only call site of
  // openCard() was inside the pointerup handler behind `if (!st) return` — so on a finger the
  // whole path was dead. Browsers fire compatibility MOUSE events after a touch, not a second
  // pointerdown, and this file bound nothing to 'click'. The two sibling boards carry the
  // identical touch guard and BOTH pair it with a delegated click (board.js, pipeline.js), which
  // is why they work and this one did not — on the shop-floor tablet this screen was written for,
  // the card could not be opened, the stage could not be changed, and Shipped was a one-way door.
  on($('#board'), '.jcard', (e, t) => {
    if (dragEndedAt && Date.now() - dragEndedAt < 250) return // a drag, not a click
    openCard(byId(t.dataset.id), () => ordersView(), stages)
  })
}

/** Which column the pointer is over — by x-range, so a drop below a short column still lands. */
function columnAt(x) {
  const cols = $$('.col')
  const hit = cols.find((c) => { const r = c.getBoundingClientRect(); return x >= r.left && x <= r.right })
  if (hit) return hit
  return cols.reduce((best, c) => {
    const r = c.getBoundingClientRect()
    const dist = Math.min(Math.abs(x - r.left), Math.abs(x - r.right))
    return !best || dist < best.dist ? { c, dist } : best
  }, null)?.c
}

let st = null
// When the last real drag finished, so the click that a mouse fires after a drop is not read as a
// tap and does not open the card that was just moved. Same guard board.js uses.
let dragEndedAt = 0

function wireDnd(rerender, byId, stages) {
  $('#board').addEventListener('pointerdown', (e) => {
    const c = e.target.closest('.jcard')
    if (!c || e.button !== 0) return
    // A finger scrolls the board; it does not drag a card. columnAt() picks the target column
    // purely from clientX, so a sideways swipe to reach the Shipped column committed a stage
    // change — and PUT /api/orders/:id/stage moves an order BACKWARDS as happily as forwards, with
    // no confirm and no undo. This is the one screen written for a phone, and it was the one
    // missing the guard that board.js and pipeline.js both carry. Tapping opens the order, via
    // the delegated click in ordersView() — this handler is drag only, and returning here used to
    // take the tap with it.
    if (e.pointerType === 'touch') return
    const r = c.getBoundingClientRect()
    st = { card: c, id: c.dataset.id, from: c.closest('.col'), x0: e.clientX, y0: e.clientY,
      ox: e.clientX - r.left, oy: e.clientY - r.top, w: r.width, moved: false, ghost: null, col: null }
  })

  // #board is rebuilt every render but window is not — bind the move/up pair once, or each revisit
  // stacks another copy and one drag fires several PUTs.
  if (wireDnd.bound) { wireDnd.rerender = rerender; wireDnd.byId = byId; wireDnd.stages = stages; return }
  wireDnd.bound = true
  wireDnd.rerender = rerender
  wireDnd.byId = byId
  wireDnd.stages = stages

  window.addEventListener('pointermove', (e) => {
    if (!st) return
    if (!st.moved) {
      if (Math.hypot(e.clientX - st.x0, e.clientY - st.y0) < 5) return // tolerate a shaky tap
      st.moved = true
      const g = st.card.cloneNode(true)
      g.className = 'jcard ghost'
      g.style.width = `${st.w}px`
      document.body.appendChild(g)
      st.ghost = g
      st.card.classList.add('drag')
      document.body.classList.add('dragging')
    }
    e.preventDefault()
    st.ghost.style.left = `${e.clientX - st.ox}px`
    st.ghost.style.top = `${e.clientY - st.oy}px`
    st.col = columnAt(e.clientX)
    $$('.col').forEach((c) => c.classList.toggle('over', c === st.col))
  })

  window.addEventListener('pointerup', async () => {
    if (!st) return
    const s = st
    st = null
    s.ghost?.remove()
    s.card.classList.remove('drag')
    document.body.classList.remove('dragging')
    $$('.col').forEach((c) => c.classList.remove('over'))

    // Barely moved → the delegated click in ordersView() owns tapping now, for mouse and finger
    // alike. Opening it here as well would open the card twice on every mouse click.
    if (!s.moved) return
    dragEndedAt = Date.now()
    const stage = s.col?.dataset.stage
    if (!stage || s.col === s.from) return
    try {
      await api.put(`/api/orders/${s.id}/stage`, { stage })
      wireDnd.rerender()
    } catch (e) { toast(e.message, true); wireDnd.rerender() }
  })
}

/** Tap a card: stage, tracking number, and a way into the estimate or invoice. */
function openCard(c, rerender, stages) {
  if (!c) return
  const opts = (stages && stages.length ? stages : wireDnd.stages || [])
  modal({
    title: `${c.estimate_number}${c.invoice_number ? ` · ${c.invoice_number}` : ''}`,
    body: `<div class="dim" style="font-size:13px;margin-bottom:14px">${esc(c.contact_name || '')}${c.company ? ` · ${esc(c.company)}` : ''} — ${money(c.total)}${c.invoice_status === 'void' ? ' · invoice voided' : c.balance > 0 ? ` · ${money(c.balance)} still due` : c.invoice_id ? ' · paid in full' : ''}</div>
      ${opts.length ? `<div class="field"><label for="ob-stage">Stage</label>
        <select class="input" id="ob-stage" name="stage">
          ${opts.map((o) => `<option value="${esc(o.key)}"${c.stage === o.key ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
        </select>
        <div class="dim" style="font-size:11.5px;margin-top:4px">Moving a card back is allowed — this is the only way to do it on a touch screen, where a card cannot be dragged.</div></div>` : ''}
      <div class="grid2">
        <div class="field"><label>Carrier</label>
          <input class="input" name="carrier" list="ob-carriers" value="${esc(c.carrier || '')}" placeholder="UPS">
          <datalist id="ob-carriers"><option>UPS</option><option>FedEx</option><option>USPS</option><option>DHL</option><option>Local delivery</option><option>Customer pickup</option></datalist>
        </div>
        <div class="field"><label>Tracking number</label>
          <input class="input" name="tracking_number" value="${esc(c.tracking_number || '')}" placeholder="1Z999…"></div>
      </div>
      <div class="dim" style="font-size:11.5px;margin-top:8px;line-height:1.6">Adding a tracking number moves this card forward to Shipped. It never moves one back — clearing the number leaves the card where it is, so use the Stage select above.</div>`,
    footer: `<button class="btn ghost" data-close>Close</button>
      <a class="btn ghost" href="#/estimates/${c.id}">Open estimate</a>
      ${c.invoice_id ? `<a class="btn ghost" href="#/invoices/${c.invoice_id}">Open invoice</a>` : ''}
      <button class="btn" id="ob-save">Save</button>`,
    onMount: (bg) => {
      $('#ob-save', bg).onclick = async () => {
        const btn = $('#ob-save', bg); btn.disabled = true; btn.textContent = 'Saving…'
        try {
          const f = formData(bg)
          // Stage FIRST. /tracking runs advanceOrder afterwards, and advanceOrder is forward-only
          // by construction — so a stage set first is never clobbered by a tracking number that is
          // still in the box, while the other order would silently undo a walk-back.
          const stage = f.stage
          delete f.stage
          if (stage && stage !== c.stage) await api.put(`/api/orders/${c.id}/stage`, { stage })
          await api.put(`/api/orders/${c.id}/tracking`, f)
          closeModal(); toast('Saved'); rerender()
        } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = 'Save' }
      }
      // Modal links are plain hashes; close so the board isn't left underneath.
      bg.querySelectorAll('a[href^="#/"]').forEach((a) => a.addEventListener('click', () => closeModal()))
    },
  })
}
