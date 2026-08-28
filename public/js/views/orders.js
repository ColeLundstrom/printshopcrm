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
        ${c.balance > 0 ? `<span class="tag ${late ? 'red' : ''}">${late ? '⚠ overdue · ' : ''}${money(c.balance)} due</span>`
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
  wireDnd(() => ordersView(), byId)
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

function wireDnd(rerender, byId) {
  $('#board').addEventListener('pointerdown', (e) => {
    const c = e.target.closest('.jcard')
    if (!c || e.button !== 0) return
    // A finger scrolls the board; it does not drag a card. columnAt() picks the target column
    // purely from clientX, so a sideways swipe to reach the Shipped column committed a stage
    // change — and PUT /api/orders/:id/stage moves an order BACKWARDS as happily as forwards, with
    // no confirm and no undo. This is the one screen written for a phone, and it was the one
    // missing the guard that board.js and pipeline.js both carry. Tapping still opens the order.
    if (e.pointerType === 'touch') return
    const r = c.getBoundingClientRect()
    st = { card: c, id: c.dataset.id, from: c.closest('.col'), x0: e.clientX, y0: e.clientY,
      ox: e.clientX - r.left, oy: e.clientY - r.top, w: r.width, moved: false, ghost: null, col: null }
  })

  // #board is rebuilt every render but window is not — bind the move/up pair once, or each revisit
  // stacks another copy and one drag fires several PUTs.
  if (wireDnd.bound) { wireDnd.rerender = rerender; wireDnd.byId = byId; return }
  wireDnd.bound = true
  wireDnd.rerender = rerender
  wireDnd.byId = byId

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

    // Barely moved → treat it as a tap and open the card.
    if (!s.moved) { openCard(wireDnd.byId(s.id), wireDnd.rerender); return }
    const stage = s.col?.dataset.stage
    if (!stage || s.col === s.from) return
    try {
      await api.put(`/api/orders/${s.id}/stage`, { stage })
      wireDnd.rerender()
    } catch (e) { toast(e.message, true); wireDnd.rerender() }
  })
}

/** Tap a card: tracking number, and a way into the estimate or invoice. */
function openCard(c, rerender) {
  if (!c) return
  modal({
    title: `${c.estimate_number}${c.invoice_number ? ` · ${c.invoice_number}` : ''}`,
    body: `<div class="dim" style="font-size:13px;margin-bottom:14px">${esc(c.contact_name || '')}${c.company ? ` · ${esc(c.company)}` : ''} — ${money(c.total)}${c.balance > 0 ? ` · ${money(c.balance)} still due` : c.invoice_id ? ' · paid in full' : ''}</div>
      <div class="grid2">
        <div class="field"><label>Carrier</label>
          <input class="input" name="carrier" list="ob-carriers" value="${esc(c.carrier || '')}" placeholder="UPS">
          <datalist id="ob-carriers"><option>UPS</option><option>FedEx</option><option>USPS</option><option>DHL</option><option>Local delivery</option><option>Customer pickup</option></datalist>
        </div>
        <div class="field"><label>Tracking number</label>
          <input class="input" name="tracking_number" value="${esc(c.tracking_number || '')}" placeholder="1Z999…"></div>
      </div>
      <div class="dim" style="font-size:11.5px;margin-top:8px;line-height:1.6">Adding a tracking number moves this card to Shipped.</div>`,
    footer: `<button class="btn ghost" data-close>Close</button>
      <a class="btn ghost" href="#/estimates/${c.id}">Open estimate</a>
      ${c.invoice_id ? `<a class="btn ghost" href="#/invoices/${c.invoice_id}">Open invoice</a>` : ''}
      <button class="btn" id="ob-save">Save</button>`,
    onMount: (bg) => {
      $('#ob-save', bg).onclick = async () => {
        const btn = $('#ob-save', bg); btn.disabled = true; btn.textContent = 'Saving…'
        try {
          await api.put(`/api/orders/${c.id}/tracking`, formData(bg))
          closeModal(); toast('Saved'); rerender()
        } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = 'Save' }
      }
      // Modal links are plain hashes; close so the board isn't left underneath.
      bg.querySelectorAll('a[href^="#/"]').forEach((a) => a.addEventListener('click', () => closeModal()))
    },
  })
}
