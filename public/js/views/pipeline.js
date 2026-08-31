import { api, $, $$, esc, money, money0, relTime, initials, setPage, empty, toast, undoable, on, go, modal, closeModal, confirmModal, formData } from '../core.js'
import { contactForm } from './contacts.js'

/**
 * Sales pipeline — GHL's opportunities board, kept separate from production on purpose.
 * "Will they say yes?" is a different board from "will we finish it?", and merging them
 * loses the sales view. Opportunities auto-sync from estimate events, so it stays honest
 * without the shop maintaining a second list.
 */
const STAGE_COLOR = { lead: '#5f6b7d', quoted: '#7c6cff', sent: '#4aa8ff', negotiation: '#f7b955', won: '#10d39a', lost: '#ff5f6d' }
// Mirrors lib/pipeline.mjs STAGES. The board's only way to change a stage was to DRAG a card, so a
// deal could never be marked Won or Lost without a mouse: no keyboard path, and after the touch
// fix in wireDnd() no finger path either. The stage was printed in the deal as dead text.
const STAGE_OPTIONS = [
  ['lead', 'Lead'], ['quoted', 'Quoted'], ['sent', 'Sent'],
  ['negotiation', 'Negotiating'], ['won', 'Won'], ['lost', 'Lost'],
]
let dragEndedAt = 0
let st = null

export async function pipelineView() {
  setPage('Pipeline', `<button class="btn" id="new-opp">+ New Opportunity</button>`)
  if (!$('#pipe')) $('#view').innerHTML = '<div class="dim">Loading…</div>'
  const d = await api.get('/api/pipeline')

  $('#view').innerHTML = `
    <div class="kpis">
      <div class="kpi info"><div class="lbl">Open pipeline</div><div class="val">${money0(d.stats.open_value)}</div><div class="sub">${d.stats.open_count} live deal${d.stats.open_count === 1 ? '' : 's'}</div></div>
      <div class="kpi"><div class="lbl">Weighted</div><div class="val">${money0(d.stats.weighted_value)}</div><div class="sub">By stage probability</div></div>
      <div class="kpi"><div class="lbl">Won</div><div class="val">${money0(d.stats.won_value)}</div><div class="sub">Closed business</div></div>
      <div class="kpi ${d.stats.win_rate != null && d.stats.win_rate < 50 ? 'warn' : ''}"><div class="lbl">Win rate</div><div class="val">${d.stats.win_rate == null ? '—' : d.stats.win_rate + '%'}</div><div class="sub">Won ÷ decided</div></div>
    </div>
    <div class="board" id="pipe">
      ${d.columns.map((c) => `<div class="col" data-stage="${c.key}">
        <div class="col-h"><div class="bar" style="background:${STAGE_COLOR[c.key]}"></div>
          <div class="nm">${esc(c.label)}</div>
          ${c.value ? `<span class="pcs">${money0(c.value)}</span>` : ''}
          <div class="ct">${c.opps.length}</div></div>
        <div class="col-b" data-drop="${c.key}">${c.opps.map(card).join('') || '<div class="col-empty">Drop a deal here</div>'}</div>
      </div>`).join('')}
    </div>`

  wireDnd()
  on($('#pipe'), '.jcard', (e, t) => { if (dragEndedAt && Date.now() - dragEndedAt < 250) return; openOpp(+t.dataset.id) })
  $('#new-opp').onclick = () => oppForm(null)
  if (new URLSearchParams(location.hash.split('?')[1] || '').get('new')) { history.replaceState(null, '', location.hash.split('?')[0]); oppForm(null) }
}

function card(o) {
  return `<div class="jcard" data-id="${o.id}">
    <div class="ti">${esc(o.title)}</div>
    <div class="cn"><div class="avatar" style="width:17px;height:17px;font-size:8px;border-radius:5px">${esc(initials(o.contact_name))}</div>${esc(o.contact_name || '—')}</div>
    <div class="ft"><strong style="font-size:13px">${money0(o.value)}</strong><div class="sp"></div>
      <span class="dim" style="font-size:10px">${esc(o.source)}</span></div>
    ${o.stage === 'won' ? '<div class="jassign" style="color:var(--accent)">WON</div>' : o.stage === 'lost' ? `<div class="jassign" style="color:var(--red)">${o.lost_reason ? esc(o.lost_reason.slice(0, 18)) : 'LOST'}</div>` : ''}
  </div>`
}

const recount = () => $$('#pipe .col').forEach((c) => c.querySelector('.ct').textContent = c.querySelectorAll('.jcard').length)
function columnAt(x) {
  const cols = $$('#pipe .col')
  return cols.find((c) => { const r = c.getBoundingClientRect(); return x >= r.left && x <= r.right })
    || cols.reduce((b, c) => { const r = c.getBoundingClientRect(); const dd = Math.min(Math.abs(x - r.left), Math.abs(x - r.right)); return !b || dd < b.d ? { c, d: dd } : b }, null)?.c
}

function wireDnd() {
  $('#pipe').addEventListener('pointerdown', (e) => {
    const card = e.target.closest('.jcard'); if (!card || e.button !== 0) return
    // Same rule as the job board: a finger scrolls the column, it does not drag a deal. Tapping the
    // card opens the deal, which is where a touch user changes its stage.
    if (e.pointerType === 'touch') return
    const r = card.getBoundingClientRect()
    st = { card, id: card.dataset.id, from: card.closest('.col'), x0: e.clientX, y0: e.clientY, ox: e.clientX - r.left, oy: e.clientY - r.top, w: r.width, moved: false, ghost: null, col: null }
  })
  if (wireDnd.bound) return
  wireDnd.bound = true
  window.addEventListener('pointermove', (e) => {
    if (!st) return
    if (!st.moved) { if (Math.hypot(e.clientX - st.x0, e.clientY - st.y0) < 5) return; st.moved = true
      const g = st.card.cloneNode(true); g.className = 'jcard ghost'; g.style.width = `${st.w}px`; document.body.appendChild(g); st.ghost = g; st.card.classList.add('drag'); document.body.classList.add('dragging') }
    e.preventDefault()
    st.ghost.style.left = `${e.clientX - st.ox}px`; st.ghost.style.top = `${e.clientY - st.oy}px`
    const col = columnAt(e.clientX); st.col = col
    $$('#pipe .col').forEach((c) => c.classList.toggle('over', c === col))
  })
  window.addEventListener('pointerup', async () => {
    if (!st) return
    const s = st; st = null
    s.ghost?.remove(); s.card.classList.remove('drag'); document.body.classList.remove('dragging'); $$('#pipe .col').forEach((c) => c.classList.remove('over'))
    if (!s.moved) return
    dragEndedAt = Date.now()
    const col = s.col; if (!col || col === s.from) return
    const stage = col.dataset.stage
    if (stage === 'lost') return promptLost(s.id) // capture why we lost it
    const fromCol = s.from
    const fromStage = fromCol.dataset.stage
    col.querySelector('.col-b').appendChild(s.card); recount()
    // Commit now, undo reverses — same fix as the job board. A deferred write was lost if the tab
    // closed inside the undo window, so a deal the pipeline showed advanced silently snapped back.
    api.patch(`/api/opportunities/${s.id}/stage`, { stage })
      .then(() => { if (stage === 'won') pipelineView() })
      .catch((e) => { toast(e.message, true); pipelineView() })
    undoable(`Moved to ${col.querySelector('.nm').textContent}`, {
      undo: async () => {
        fromCol.querySelector('.col-b').appendChild(s.card); recount()
        try { await api.patch(`/api/opportunities/${s.id}/stage`, { stage: fromStage }) } catch (e) { toast(e.message, true); pipelineView() }
      },
    })
  })
}

function promptLost(id) {
  // The card is deliberately NOT moved into the Lost column here. It used to be moved first and
  // asked afterwards, so Cancel, Escape and a backdrop click all closed the dialog with no server
  // call and no repaint — leaving a live deal sitting in Lost on screen, and every later read of
  // that board (its own recount, the KPI row, the next drag's from-stage) working off a position
  // the server had never agreed to. The drop handler has not moved it either at this point, so the
  // card simply stays where it was until the shop actually answers.
  modal({
    title: 'Mark as lost', body: `<div class="field"><label>What happened? (optional)</label>
      <input class="input" name="lost_reason" placeholder="Price · went with another shop · ghosted…"></div>`,
    footer: `<button class="btn ghost" data-close>Cancel</button><button class="btn danger" id="go">Mark lost</button>`,
    onMount: (bg) => $('#go', bg).onclick = async () => {
      const btn = $('#go', bg)
      btn.disabled = true
      try {
        await api.patch(`/api/opportunities/${id}/stage`, { stage: 'lost', lost_reason: $('[name=lost_reason]', bg).value })
      } catch (e) { toast(e.message, true); btn.disabled = false; return }
      closeModal(); toast('Marked lost'); pipelineView()
    },
  })
}

async function openOpp(id) {
  const d = await api.get('/api/pipeline')
  const o = d.columns.flatMap((c) => c.opps).find((x) => x.id === id)
  if (o) oppForm(o)
}

function oppForm(o) {
  const isNew = !o
  api.get('/api/contacts').then(({ contacts }) => {
    modal({
      title: isNew ? 'New Opportunity' : o.title,
      /* A brand-new shop has no contacts, and this select had no empty state and no placeholder.
       * It rendered with ZERO options, Create posted contact_id: '', and POST /api/opportunities
       * answered 400 customer_required — "Pick a customer to open a deal for." — which the dialog
       * offered no control to satisfy. The first thing a shop is invited to do on the Pipeline was
       * a dead end.
       *
       * The placeholder matters just as much once contacts exist: with no empty first option the
       * select silently pre-selects whichever contact sorts first, so a distracted click files the
       * deal against the wrong customer. board.js solves both, twenty lines away, and estimates.js
       * has a comment about precisely this hazard. */
      body: `<div class="field"><label>Customer${isNew ? ' *' : ''}</label>${o || contacts.length
        ? `<select class="input" name="contact_id" ${o ? 'disabled' : ''}>
          ${o ? '' : '<option value="">Choose a customer…</option>'}
          ${contacts.map((c) => `<option value="${c.id}" ${c.id === o?.contact_id ? 'selected' : ''}>${esc(c.name)}${c.company ? ` — ${esc(c.company)}` : ''}</option>`).join('')}</select>`
        : `<div class="dim" style="font-size:13px">No customers yet — every deal belongs to one.</div>
          <button class="btn ghost sm" id="add-contact" type="button" style="margin-top:7px">+ Add your first customer</button>`}</div>
        <div class="grid2">
          <div class="field"><label>Title</label><input class="input" name="title" value="${esc(o?.title || '')}" placeholder="Fall spirit wear"></div>
          <div class="field"><label>Value ($)</label><input class="input" name="value" type="number" min="0" value="${esc(o?.value || '')}"></div>
        </div>
        <div class="field"><label>Notes</label><textarea class="input" name="notes" placeholder="Where it came from, next step…">${esc(o?.notes || '')}</textarea></div>
        ${o ? `<div class="field"><label for="opp-stage">Stage</label>
          <select class="input" id="opp-stage">${STAGE_OPTIONS.map(([k, l]) => `<option value="${k}" ${o.stage === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div class="field" id="opp-lost-wrap" style="display:${o.stage === 'lost' ? 'block' : 'none'}"><label for="opp-lost">What happened? (optional)</label>
          <input class="input" id="opp-lost" value="${esc(o.lost_reason || '')}" placeholder="Price · went with another shop · ghosted…"></div>
          ${o.estimate_id ? `<div class="dim" style="font-size:11.5px"><a href="#/estimates/${o.estimate_id}" style="color:var(--accent)">view estimate →</a></div>` : ''}` : ''}`,
      footer: `${o ? '<button class="btn danger" id="del" style="margin-right:auto">Delete</button>' : ''}<button class="btn ghost" data-close>Cancel</button><button class="btn" id="save">${isNew ? 'Create' : 'Save'}</button>`,
      onMount: (bg) => {
        // Reopens this dialog when the customer is saved, so the deal being written is not lost.
        $('#add-contact', bg)?.addEventListener('click', () => contactForm(null, () => oppForm(o)))
        $('#save', bg).onclick = async () => {
          const data = formData(bg)
          if (isNew && !data.title) return toast('Give it a title', true)
          // Said here rather than by a 400 the dialog cannot act on.
          if (isNew && !data.contact_id) return toast(contacts.length ? 'Choose a customer for this deal first' : 'Add a customer first', true)
          try {
            if (isNew) await api.post('/api/opportunities', data)
            else {
              await api.put(`/api/opportunities/${o.id}`, data)
              // Stage moves through its own route (it fires the won/lost automations), so send it
              // only when it actually changed.
              const stage = $('#opp-stage', bg)?.value
              if (stage && stage !== o.stage) {
                await api.patch(`/api/opportunities/${o.id}/stage`, { stage, lost_reason: $('#opp-lost', bg)?.value || '' })
              }
            }
            closeModal(); toast(isNew ? 'Opportunity created' : 'Saved'); pipelineView()
          } catch (e) { toast(e.message, true) }
        }
        const stageSel = $('#opp-stage', bg)
        if (stageSel) stageSel.onchange = () => { $('#opp-lost-wrap', bg).style.display = stageSel.value === 'lost' ? 'block' : 'none' }
        $('#del', bg)?.addEventListener('click', () => confirmModal('Delete opportunity?', `"${o.title}" will be removed.`, async () => {
          await api.del(`/api/opportunities/${o.id}`); closeModal(); toast('Deleted'); pipelineView()
        }))
      },
    })
  })
}
