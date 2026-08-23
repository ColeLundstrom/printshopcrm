import { api, $, $$, esc, money, money0, relTime, initials, setPage, empty, toast, undoable, on, go, modal, closeModal, confirmModal, formData } from '../core.js'

/**
 * Sales pipeline — GHL's opportunities board, kept separate from production on purpose.
 * "Will they say yes?" is a different board from "will we finish it?", and merging them
 * loses the sales view. Opportunities auto-sync from estimate events, so it stays honest
 * without the shop maintaining a second list.
 */
const STAGE_COLOR = { lead: '#5f6b7d', quoted: '#7c6cff', sent: '#4aa8ff', negotiation: '#f7b955', won: '#10d39a', lost: '#ff5f6d' }
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
    if (stage === 'lost') return promptLost(s.id, col, s.card) // capture why we lost it
    const fromCol = s.from
    col.querySelector('.col-b').appendChild(s.card); recount()
    // Deferred write behind the undo window — same as the job board.
    undoable(`Moved to ${col.querySelector('.nm').textContent}`, {
      commit: async () => {
        try { await api.patch(`/api/opportunities/${s.id}/stage`, { stage }); if (stage === 'won') pipelineView() }
        catch (e) { toast(e.message, true); pipelineView() }
      },
      undo: () => { fromCol.querySelector('.col-b').appendChild(s.card); recount() },
    })
  })
}

function promptLost(id, col, card) {
  col.querySelector('.col-b').appendChild(card); recount()
  modal({
    title: 'Mark as lost', body: `<div class="field"><label>What happened? (optional)</label>
      <input class="input" name="lost_reason" placeholder="Price · went with another shop · ghosted…"></div>`,
    footer: `<button class="btn ghost" data-close>Cancel</button><button class="btn danger" id="go">Mark lost</button>`,
    onMount: (bg) => $('#go', bg).onclick = async () => {
      await api.patch(`/api/opportunities/${id}/stage`, { stage: 'lost', lost_reason: $('[name=lost_reason]', bg).value })
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
      body: `<div class="field"><label>Customer</label><select class="input" name="contact_id" ${o ? 'disabled' : ''}>
          ${contacts.map((c) => `<option value="${c.id}" ${c.id === o?.contact_id ? 'selected' : ''}>${esc(c.name)}${c.company ? ` — ${esc(c.company)}` : ''}</option>`).join('')}</select></div>
        <div class="grid2">
          <div class="field"><label>Title</label><input class="input" name="title" value="${esc(o?.title || '')}" placeholder="Fall spirit wear"></div>
          <div class="field"><label>Value ($)</label><input class="input" name="value" type="number" min="0" value="${esc(o?.value || '')}"></div>
        </div>
        <div class="field"><label>Notes</label><textarea class="input" name="notes" placeholder="Where it came from, next step…">${esc(o?.notes || '')}</textarea></div>
        ${o ? `<div class="dim" style="font-size:11.5px">Stage: <strong>${esc(o.stage)}</strong>${o.estimate_id ? ` · <a href="#/estimates/${o.estimate_id}" style="color:var(--accent)">view estimate →</a>` : ''}</div>` : ''}`,
      footer: `${o ? '<button class="btn danger" id="del" style="margin-right:auto">Delete</button>' : ''}<button class="btn ghost" data-close>Cancel</button><button class="btn" id="save">${isNew ? 'Create' : 'Save'}</button>`,
      onMount: (bg) => {
        $('#save', bg).onclick = async () => {
          const data = formData(bg)
          if (isNew && !data.title) return toast('Give it a title', true)
          try {
            if (isNew) await api.post('/api/opportunities', data)
            else await api.put(`/api/opportunities/${o.id}`, data)
            closeModal(); toast(isNew ? 'Opportunity created' : 'Saved'); pipelineView()
          } catch (e) { toast(e.message, true) }
        }
        $('#del', bg)?.addEventListener('click', () => confirmModal('Delete opportunity?', `"${o.title}" will be removed.`, async () => {
          await api.del(`/api/opportunities/${o.id}`); closeModal(); toast('Deleted'); pipelineView()
        }))
      },
    })
  })
}
