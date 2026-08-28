import { api, $, $$, el, esc, money, fmtDate, relTime, pill, setPage, empty, toast, undoable, go, on, modal, closeModal, confirmModal, formData, dueClass, dueLabel, daysOut, initials } from '../core.js'
import { SIZES, sizeSummary } from '../shared/pricing.js'
import { contactForm } from './contacts.js'

const STAGE_COLOR = { new: '#5f6b7d', art_approval: '#f7b955', prepress: '#7c6cff', production: '#4aa8ff', qc: '#10d39a', shipping: '#10d39a', complete: '#333b49' }
const DECORATIONS = ['Screen Print', 'DTF Transfer', 'Embroidery', 'UV DTF', 'Vinyl', 'Patch', 'Laser', 'Promo']

const boardState = { filter: 'all', assignee: 'all' }

export async function boardView() {
  setPage('Job Board', `<button class="btn" id="new-job">+ New Job</button>`)
  if (!$('#board')) $('#view').innerHTML = '<div class="dim">Loading…</div>'
  const d = await api.get(`/api/board?filter=${boardState.filter}&assignee=${encodeURIComponent(boardState.assignee)}`)

  const chip = (k, label, n) => `<button data-f="${k}" class="${boardState.filter === k ? 'on' : ''}">${label}${n != null ? ` <span>${n}</span>` : ''}</button>`

  $('#view').innerHTML = `<div class="boardbar">
      <div class="tabs" id="bfilter">
        ${chip('all', 'All', d.counts.all)}${chip('week', 'This week')}${chip('rush', 'Rush', d.counts.rush)}
        ${chip('late', 'Late', d.counts.late)}${chip('unpaid', 'Unpaid', d.counts.unpaid)}
      </div>
      <select class="input" id="bassign" style="max-width:170px">
        <option value="all">Everyone</option>
        ${d.assignees.map((a) => `<option ${a === boardState.assignee ? 'selected' : ''}>${esc(a)}</option>`).join('')}
      </select>
      <div class="sp"></div>
      <span class="dim" style="font-size:12px">${d.columns.reduce((t, c) => t + c.pieces, 0)} pieces on the floor</span>
    </div>
    <div class="board" id="board">
    ${d.columns.map((c) => `<div class="col" data-stage="${c.key}">
      <div class="col-h"><div class="bar" style="background:${STAGE_COLOR[c.key]}"></div>
        <div class="nm">${esc(c.label)}</div>
        ${c.pieces ? `<span class="pcs" title="${c.pieces} pieces in this stage">${c.pieces >= 1000 ? `${(c.pieces / 1000).toFixed(1)}k` : c.pieces} pc</span>` : ''}
        <div class="ct">${c.jobs.length}</div></div>
      <div class="col-b" data-drop="${c.key}">${c.jobs.map(card).join('') || '<div class="col-empty">Drop a job here</div>'}</div>
    </div>`).join('')}
  </div>`

  on($('#bfilter'), '[data-f]', (_e, t) => { boardState.filter = t.dataset.f; boardView() })
  $('#bassign').onchange = (e) => { boardState.assignee = e.target.value; boardView() }

  wireDnd()
  on($('#board'), '.jcard', (e, t) => {
    if (dragEndedAt && Date.now() - dragEndedAt < 250) return // a drag, not a click
    if (!e.target.closest('[data-nodrag]')) go(`/jobs/${t.dataset.id}`)
  })
  $('#new-job').onclick = () => jobForm(null, boardView)
  if (new URLSearchParams(location.hash.split('?')[1] || '').get('new')) { history.replaceState(null, '', location.hash.split('?')[0]); jobForm(null, boardView) }
}

function card(j) {
  const late = daysOut(j.due_date) < 0
  const artPill = j.art_status === 'sent' ? '<span class="pill amber">proof sent</span>'
    : j.art_status === 'approved' ? '<span class="pill green">art ok</span>'
    : j.art_status === 'rejected' ? '<span class="pill red">changes</span>'
    : j.art_count ? '<span class="pill gray">art</span>' : ''
  return `<div class="jcard ${j.rush ? 'rush' : ''}" data-id="${j.id}">
    ${j.rush ? '<div class="rushb">RUSH</div>' : ''}
    <div class="jn">${esc(j.job_number)}</div>
    <div class="ti">${esc(j.title)}</div>
    <div class="cn"><div class="avatar" style="width:17px;height:17px;font-size:8px;border-radius:5px">${esc(initials(j.contact_name))}</div>${esc(j.contact_name || '—')}</div>
    ${j.pieces ? `<div class="jpc"><strong>${j.pieces}</strong> pc${j.garment ? ` · ${esc(String(j.garment).split('—')[0].trim())}` : ''}</div>` : ''}
    <div class="ft">
      <span class="due ${dueClass(j.due_date)}">${late ? '⚠ ' : ''}${esc(dueLabel(j.due_date))}</span>
      <div class="sp"></div>
      ${artPill}
      ${j.invoice_status === 'paid' ? '<span class="pill green">paid</span>' : j.invoice_status === 'partial' ? '<span class="pill blue">part</span>' : j.invoice_status ? '<span class="pill gray">unpaid</span>' : ''}
      ${j.assigned_to ? `<span class="jassign">${esc(j.assigned_to)}</span>` : ''}
    </div>
  </div>`
}

let dragEndedAt = 0

/**
 * Columns tile horizontally, so the drop target is whichever column's x-range holds
 * the pointer — no elementFromPoint (the floating ghost sits under the cursor) and no
 * requirement to be inside the column's height, so a drop below a short column still lands.
 */
function columnAt(x) {
  const cols = $$('.col')
  const hit = cols.find((c) => { const r = c.getBoundingClientRect(); return x >= r.left && x <= r.right })
  if (hit) return hit
  // Past the ends of the board: clamp to the nearest column.
  return cols.reduce((best, c) => {
    const r = c.getBoundingClientRect()
    const d = Math.min(Math.abs(x - r.left), Math.abs(x - r.right))
    return !best || d < best.d ? { c, d } : best
  }, null)?.c
}

/**
 * Pointer-event drag, not HTML5 dragstart/drop: this one also works on touch
 * (the native DnD API does not fire on phones at all) and degrades to a plain
 * click when the pointer barely moves.
 */
let st = null

function wireDnd() {
  $('#board').addEventListener('pointerdown', (e) => {
    const card = e.target.closest('.jcard')
    if (!card || e.button !== 0) return
    // A finger scrolls; it does not drag. columnAt() picks the target column purely from clientX,
    // so a sideways swipe to scroll a 7-column board used to commit a stage change — the job moved
    // because somebody looked at it. Tapping the card opens the job, where the stage select is.
    if (e.pointerType === 'touch') return
    const r = card.getBoundingClientRect()
    st = { card, id: card.dataset.id, from: card.closest('.col'), x0: e.clientX, y0: e.clientY,
      ox: e.clientX - r.left, oy: e.clientY - r.top, w: r.width, moved: false, ghost: null, col: null }
  })

  // #board is replaced on every render, but window is not — bind the move/up pair once
  // or each revisit stacks another copy of these listeners.
  if (wireDnd.bound) return
  wireDnd.bound = true

  window.addEventListener('pointermove', (e) => {
    if (!st) return
    if (!st.moved) {
      if (Math.hypot(e.clientX - st.x0, e.clientY - st.y0) < 5) return // tolerate a shaky click
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
    const col = columnAt(e.clientX)
    st.col = col
    $$('.col').forEach((c) => c.classList.toggle('over', c === col))
  })

  window.addEventListener('pointerup', async () => {
    if (!st) return
    const s = st
    st = null
    s.ghost?.remove()
    s.card.classList.remove('drag')
    document.body.classList.remove('dragging')
    $$('.col').forEach((c) => c.classList.remove('over'))
    if (!s.moved) return
    dragEndedAt = Date.now()
    const col = s.col
    if (!col || col === s.from) return
    const stage = col.dataset.stage
    const fromCol = s.from
    const fromStage = fromCol.dataset.stage
    col.querySelector('.col-b').appendChild(s.card)
    recount()
    // Commit the move to the server NOW, not on a 6-second timer. The old code deferred the write
    // behind the undo window, and that write was lost entirely if the tab closed, the laptop shut,
    // or an emailed link was clicked inside those six seconds — the board said "Moved to
    // Production" and the job was back in Prepress on the next load. Undo issues the reverse move
    // instead, so the server always holds what the operator last saw.
    api.patch(`/api/jobs/${s.id}/stage`, { stage })
      .then(() => { if (stage === 'complete') boardView() })
      .catch((err) => { toast(err.message, true); boardView() })
    undoable(`Moved to ${col.querySelector('.nm').textContent}`, {
      undo: async () => {
        fromCol.querySelector('.col-b').appendChild(s.card); recount()
        try { await api.patch(`/api/jobs/${s.id}/stage`, { stage: fromStage }) } catch (err) { toast(err.message, true); boardView() }
      },
    })
  })
}

const recount = () => $$('.col').forEach((c) => c.querySelector('.ct').textContent = c.querySelectorAll('.jcard').length)

/* ---------- job form ---------- */

export async function jobForm(job, after) {
  const { contacts } = await api.get('/api/contacts')
  // The garment is what the purchase order buys. A job typed onto the board had no field for it
  // anywhere in the product, so its PO came back with no SKU and no cost and could never be
  // submitted. The datalist is the shop's own catalogue, and the style number has to stay ahead
  // of the first em-dash because that is what costFor() reads.
  const { garments = [] } = await api.get('/api/products').catch(() => ({ garments: [] }))
  modal({
    title: job ? `Edit ${job.job_number}` : 'New Job',
    body: `<div class="field"><label>Customer *</label>${job || contacts.length
        ? `<select class="input" name="contact_id" ${job ? 'disabled' : ''}>
            ${job ? '' : '<option value="">Choose a customer…</option>'}
            ${contacts.map((c) => `<option value="${c.id}" ${c.id === job?.contact_id ? 'selected' : ''}>${esc(c.name)}${c.company ? ` — ${esc(c.company)}` : ''}</option>`).join('')}</select>`
        : `<div class="dim" style="font-size:13px">No customers yet — every job belongs to one.</div>
          <button class="btn ghost sm" id="add-contact" style="margin-top:7px">+ Add your first customer</button>`}</div>
      <div class="field"><label>Job title *</label><input class="input" name="title" value="${esc(job?.title || '')}" placeholder="200 tees — 2 color front"></div>
      <div class="grid2">
        <div class="field"><label>Decoration</label><select class="input" name="decoration">
          ${DECORATIONS.map((d) => `<option ${d === job?.decoration ? 'selected' : ''}>${d}</option>`).join('')}</select></div>
        <div class="field"><label>Quantities</label><input class="input" name="quantities" value="${esc(job?.quantities || '')}" placeholder="24 S / 60 M / 80 L / 36 XL"></div>
      </div>
      <div class="field"><label>Garment</label>
        <input class="input" name="garment" list="garment-styles" value="${esc(job?.garment || '')}"
               placeholder="Gildan 5000 Heavy Cotton Tee — Black">
        <datalist id="garment-styles">${garments.map((g) => `<option value="${esc([g.brand, g.style, g.name].filter(Boolean).join(' '))}">`).join('')}</datalist>
        <div class="dim" style="font-size:11.5px;margin-top:4px">What the purchase order buys. Keep the style number first.</div></div>
      <div class="grid2">
        <div class="field"><label>Due date</label><input class="input" name="due_date" type="date" value="${esc(job?.due_date || '')}"></div>
        <div class="field"><label>Assigned to</label><input class="input" name="assigned_to" value="${esc(job?.assigned_to || '')}" placeholder="Press 1 / Marco"></div>
      </div>
      <div class="field"><label>Notes</label><textarea class="input" name="notes" placeholder="Ink colors, placement, packing…">${esc(job?.notes || '')}</textarea></div>
      <label class="row" style="gap:7px;cursor:pointer"><input type="checkbox" name="rush" ${job?.rush ? 'checked' : ''}> <span style="font-size:13px">Rush job</span></label>`,
    footer: `<button class="btn ghost" data-close>Cancel</button><button class="btn" id="save">${job ? 'Save' : 'Create Job'}</button>`,
    onMount: (bg) => {
      // Opening the customer form closes this modal, so reopen the job form once it saves —
      // it refetches contacts, which now includes the one just created.
      $('#add-contact', bg)?.addEventListener('click', () => contactForm(null, () => jobForm(job, after)))
      $('#save', bg).onclick = async () => {
        const d = formData(bg)
        if (!d.title?.trim()) return toast('Job title is required', true)
        if (!job && !d.contact_id) return toast(contacts.length ? 'Choose a customer for this job first' : 'Add a customer first', true)
        if (job) d.contact_id = job.contact_id
        try {
          const saved = job ? await api.put(`/api/jobs/${job.id}`, d) : await api.post('/api/jobs', d)
          closeModal()
          toast(job ? 'Job saved' : `Job ${saved.job_number} created`)
          after?.(saved)
        } catch (e) {
          // "24 S / 60 M" cannot be re-split across two styles, and guessing would put the wrong
          // count against the wrong garment on a real purchase order — so the server refuses, and
          // hands back the per-garment split instead. Its advice ("edit it on the estimate") does
          // not work once the estimate is invoiced, which is the ordinary case, so this is the
          // screen that actually does it rather than a sentence that sends the shop nowhere.
          if (e.data?.code === 'multi_garment_quantities') return splitForm(job, e.data.lines || [], d, after)
          toast(e.message, true)
        }
      }
    },
  })
}

/**
 * Correct the size split per garment, on the job.
 *
 * The only route into an order that is already invoiced and part-paid: the estimate refuses
 * (invoiced), the invoice edits nothing but a due date, and voiding refuses to walk over recorded
 * cash. This edits what actually gets printed and bought.
 */
function splitForm(job, lines, rest, after) {
  // Every size any garment on the job uses, so a shop can move pieces BETWEEN sizes, plus the
  // standard run of sizes so it can add one that was not quoted.
  const cols = SIZES.filter((s) => lines.some((l) => Number(l.sizes?.[s]) > 0) || ['S', 'M', 'L', 'XL', '2XL'].includes(s))
  // The garment is an INPUT, not a caption. This is the only screen that can post a corrected
  // line, and on a two-garment job it is the only place the exact style can be named — which is
  // what the purchase order spends money on. A quote line says "Tee" because it was written for a
  // customer to read; the distributor needs "Gildan 5000".
  const rowOf = (l, i) => `<tr><td style="padding:4px 8px"><input class="input" data-garment="${i}"
        value="${esc(l.garment || l.description || '')}" placeholder="Gildan 5000 Heavy Cotton"
        style="width:190px;padding:5px;font-size:12.5px"></td>
      ${cols.map((sz) => `<td style="padding:4px"><input class="input" data-line="${i}" data-size="${esc(sz)}" type="number" min="0" step="1"
        style="width:64px;padding:5px;text-align:center" value="${Number(l.sizes?.[sz]) > 0 ? Number(l.sizes[sz]) : ''}"></td>`).join('')}</tr>`
  modal({
    title: `Size split — ${job?.job_number || 'job'}`,
    body: `<div class="dim" style="font-size:12.5px;margin-bottom:9px">
        This order covers ${lines.length} garments, so one combined grid cannot say which pieces belong to which style.
        Set each garment's own counts — this is what the purchase order buys and what the work ticket prints.</div>
      <div style="overflow:auto"><table style="width:100%;border-collapse:collapse">
        <thead><tr><th style="text-align:left;padding:6px 8px;font-size:11.5px" class="dim">Garment</th>
          ${cols.map((sz) => `<th class="dim" style="padding:6px 4px;font-size:11.5px">${esc(sz)}</th>`).join('')}</tr></thead>
        <tbody>${lines.map(rowOf).join('')}</tbody></table></div>
      <div class="dim" style="font-size:12px;margin-top:9px" id="split-total"></div>`,
    footer: `<button class="btn ghost" data-close>Cancel</button><button class="btn" id="split-save">Save split</button>`,
    onMount: (bg) => {
      const read = () => lines.map((l, i) => {
        const style = $(`[data-garment="${i}"]`, bg)?.value?.trim() || l.garment || l.description || ''
        return {
          description: style,
          garment: style,
          sizes: Object.fromEntries($$(`[data-line="${i}"]`, bg)
            .map((inp) => [inp.dataset.size, Math.trunc(Number(inp.value) || 0)])
            .filter(([, n]) => n > 0)),
        }
      })
      const total = () => read().reduce((t, l) => t + Object.values(l.sizes).reduce((a, n) => a + n, 0), 0)
      const paint = () => { $('#split-total', bg).textContent = `${total()} pieces across ${lines.length} garments` }
      $$('input[data-line]', bg).forEach((inp) => inp.addEventListener('input', paint))
      paint()
      $('#split-save', bg).onclick = async () => {
        const line_sizes = read()
        if (!total()) return toast('Every garment came to zero pieces — a job has to make something', true)
        try {
          // `rest` carries the rest of the job form (title, due date, notes) so the edit that
          // provoked this is not lost; `quantities` is dropped because the split replaces it.
          const { quantities, ...keep } = rest || {}
          const saved = await api.put(`/api/jobs/${job.id}`, { ...keep, line_sizes })
          closeModal()
          toast('Size split saved')
          after?.(saved)
        } catch (e) { toast(e.message, true) }
      }
    },
  })
}

/* ---------- job detail ---------- */

export async function jobDetailView(id) {
  const [j, roi] = await Promise.all([api.get(`/api/jobs/${id}`), api.get(`/api/roi/${id}`).catch(() => null)])
  const STAGES = [['new', 'New'], ['art_approval', 'Art Approval'], ['prepress', 'Prepress'], ['production', 'Production'], ['qc', 'QC'], ['shipping', 'Shipping'], ['complete', 'Complete']]
  const grid = (() => { try { return JSON.parse(j.sizes || '{}') } catch { return {} } })()
  const sizes = SIZES.filter((s) => Number(grid[s]) > 0).map((s) => [s, grid[s]])
  const total = sizes.reduce((s, [, n]) => s + n, 0)
  // Screens/inks recorded on jobs that were separated before that tool was removed. Read-only:
  // the data still feeds capacity and costing, so it stays visible rather than silently vanishing.
  const sep = (() => { try { return j.separation ? JSON.parse(j.separation) : null } catch { return null } })()

  // Explain the due date rather than just showing it. A projected date that's later than
  // what the customer was promised is the single most useful thing on this page.
  const sc = j.schedule || {}
  const slip = sc.slip || 0
  const sched = !sc.gated ? `<div class="schednote"><span class="dim">Fixed due date — not gated on art approval.</span></div>`
    : sc.projected ? `<div class="schednote ${slip > 0 ? 'risk' : ''}">
        <div><strong>${j.turnaround_days} working days from art approval</strong></div>
        <div class="dim">Proof isn't approved yet. Approve today and it lands <strong style="color:var(--amber)">${fmtDate(sc.due)}</strong>${slip > 0
          ? ` — <span style="color:var(--red)">${slip} working day${slip === 1 ? '' : 's'} past the promised ${fmtDate(j.due_date)}</span>` : ''}.</div>
      </div>`
    : `<div class="schednote ok"><div><strong>Art approved ${fmtDate(sc.approvedOn)}</strong></div>
        <div class="dim">${j.turnaround_days} working days from approval → due ${fmtDate(sc.due)}.</div></div>`

  setPage(j.title, `<button class="btn ghost" id="edit">Edit</button><button class="btn" id="upload-btn">+ Upload Art</button>`,
    `<a href="#/board">Board</a> /`)

  $('#view').innerHTML = `<div class="cols">
    <div class="stack">
      <div class="card"><div class="card-b">
        <div class="row" style="margin-bottom:14px">
          <div><div class="mono">${esc(j.job_number)}</div>
            <div style="font-size:19px;font-weight:700;letter-spacing:-.3px;margin:2px 0 4px">${esc(j.title)}</div>
            <a class="muted" href="#/contacts/${j.contact_id}" style="font-size:13px">${esc(j.contact_name || '')}${j.company ? ` · ${esc(j.company)}` : ''} →</a></div>
          <div class="sp"></div>
          ${j.rush ? '<span class="pill red">RUSH</span>' : ''}
        </div>
        <div class="field" style="margin:0"><label>Stage</label>
          <select class="input" id="stage">${STAGES.map(([k, l]) => `<option value="${k}" ${j.stage === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        ${sched}
      </div></div>

      <div class="card"><div class="card-h"><h3>Art & Proofs</h3><div class="spacer"></div>
        <span class="dim" style="font-size:12px">${j.art.length} version${j.art.length === 1 ? '' : 's'}</span></div>
        <div class="card-b" id="art-list">
          <div class="drop" id="drop">Drop art here or click to upload — PNG, JPG, PDF, AI, SVG</div>
          <input type="file" id="file" hidden accept="image/*,.pdf,.ai,.eps,.svg">
          ${j.art.length ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px;margin-top:14px">
            ${j.art.map((a) => `<div class="card" style="background:var(--panel-2)">
              ${(a.mime || '').startsWith('image/') ? `<img class="art-thumb" src="/uploads/${esc(a.filename)}" alt="v${a.version}">`
                : `<div class="art-thumb" style="display:grid;place-items:center;font-size:26px">◈</div>`}
              <div style="padding:10px">
                <div class="row"><strong style="font-size:12.5px">v${a.version}</strong><div class="sp"></div>${pill(a.status)}</div>
                <div class="dim" style="font-size:11px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.original_name || '')}</div>
                ${a.notes ? `<div class="muted" style="font-size:11.5px;margin-top:5px;font-style:italic">"${esc(a.notes)}"</div>` : ''}
                <div class="wrap-row" style="margin-top:8px">
                  ${a.status === 'draft' ? `<button class="btn sm" data-send="${a.id}">Send for approval</button>` : ''}
                  ${a.status === 'sent' ? `<a class="btn ghost sm" href="${esc(a.share_url)}" target="_blank">Proof link</a>` : ''}
                  <a class="btn ghost sm" href="/uploads/${esc(a.filename)}" target="_blank">Open</a>
                </div>
              </div></div>`).join('')}</div>` : ''}
        </div>
      </div>

      <div class="card"><div class="card-h"><h3>Job Details</h3><div class="spacer"></div>
        <button class="btn ghost sm" id="print-ticket">Work ticket</button></div><div class="card-b">
        <div class="grid2" style="gap:14px">
          ${[['Decoration', j.decoration], ['Garment', j.garment], ['Due date', fmtDate(j.due_date)], ['Assigned to', j.assigned_to || '—']]
            .map(([k, v]) => `<div><div class="dim" style="font-size:10px;text-transform:uppercase;letter-spacing:.6px">${k}</div><div>${esc(v || '—')}</div></div>`).join('')}
        </div>
        ${sizes.length ? `<div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--line)">
          <div class="dim" style="font-size:10px;text-transform:uppercase;letter-spacing:.6px;margin-bottom:7px">Size breakdown — ${total} pieces</div>
          <div class="sizebar">${sizes.map(([s, n]) => `<div class="sizebox"><span>${esc(s)}</span><strong>${n}</strong></div>`).join('')}
            <div class="sizebox tot"><span>TOTAL</span><strong>${total}</strong></div></div>
        </div>` : ''}
        ${sep ? `<div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--line)">
          <div class="dim" style="font-size:10px;text-transform:uppercase;letter-spacing:.6px;margin-bottom:7px">Screens &amp; inks — ${sep.screens} screen${sep.screens === 1 ? '' : 's'} · ${esc(sep.mode === 'process' ? 'sim process' : 'spot color')}</div>
          <div class="wrap-row">${(sep.inks || []).map((ink) => `<span class="inkchip"><span class="sw" style="background:${esc(ink.hex)}"></span>${esc(ink.name)}</span>`).join('')}
            ${sep.dark ? '<span class="inkchip"><span class="sw" style="background:#f5f5f5"></span>underbase</span>' : ''}</div>
        </div>` : ''}
        ${j.notes ? `<div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--line)">
          <div class="dim" style="font-size:10px;text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px">Notes</div>
          <div class="muted" style="font-size:13px;white-space:pre-wrap">${esc(j.notes)}</div></div>` : ''}
      </div></div>
    </div>

    <div class="stack">
      ${j.invoice_number ? `<div class="card"><div class="card-h"><h3>Money</h3></div><div class="card-b">
        <div class="row" style="justify-content:space-between;margin-bottom:7px">
          <a href="#/invoices/${j.invoice_id}" class="mono" style="color:var(--accent)">${esc(j.invoice_number)} →</a>${pill(j.invoice_status)}</div>
        <div class="row" style="justify-content:space-between"><span class="dim" style="font-size:12.5px">Total</span><strong>${money(j.amount_due)}</strong></div>
        <div class="row" style="justify-content:space-between"><span class="dim" style="font-size:12.5px">Balance</span>
          <strong style="color:${j.amount_due - j.amount_paid > 0 ? 'var(--amber)' : 'var(--accent)'}">${money(j.amount_due - j.amount_paid)}</strong></div>
        ${j.estimate_number ? `<a href="#/estimates/${j.estimate_id}" class="dim" style="font-size:12px;display:block;margin-top:9px">From ${esc(j.estimate_number)} →</a>` : ''}
      </div></div>` : ''}

      ${roi && roi.revenue ? (() => {
        const vc = { good: 'var(--accent)', warn: 'var(--amber)', bad: 'var(--red)' }[roi.verdict.level] || 'var(--txt-2)'
        const row = (k, v, sub) => `<div class="row" style="justify-content:space-between;margin-bottom:6px"><span class="dim" style="font-size:12.5px">${k}${sub ? ` <span style="opacity:.6">${sub}</span>` : ''}</span><span>${v}</span></div>`
        return `<div class="card"><div class="card-h"><h3>Profitability</h3><div class="spacer"></div>
          <span class="pill" style="background:${vc}22;color:${vc}">${esc(roi.verdict.label)}</span></div>
          <div class="card-b">
            <div class="row" style="align-items:baseline;gap:10px;margin-bottom:12px">
              <div style="font-size:26px;font-weight:800;letter-spacing:-.5px;color:${vc}">${money(roi.profit)}</div>
              <div class="dim" style="font-size:13px">profit · <strong style="color:${vc}">${roi.margin}%</strong> margin</div>
            </div>
            ${row('Revenue', money(roi.revenue))}
            ${row('Blanks', '−' + money(roi.breakdown.garment), roi.blank_matched ? 'catalog cost' : 'estimated')}
            ${row('Labor', '−' + money(roi.breakdown.labor), 'real press time')}
            ${roi.breakdown.screens ? row('Screens', '−' + money(roi.breakdown.screens)) : ''}
            <div style="border-top:1px solid var(--line);margin:8px 0 8px"></div>
            ${row('<strong>Profit</strong>', `<strong style="color:${vc}">${money(roi.profit)}</strong>`)}
            ${roi.value_per_hour ? `<div class="dim" style="font-size:11.5px;margin-top:8px">Earns <strong style="color:var(--txt-2)">${money(roi.value_per_hour)}/productive hour</strong> on the press.</div>` : ''}
            <a class="btn ghost sm" href="#/roi" style="margin-top:12px;width:100%">See all jobs →</a>
          </div></div>`
      })() : ''}

      <div class="card"><div class="card-h"><h3>Production Files</h3><span class="pill green">RIP-ready</span></div>
        <div class="card-b">
          <p class="dim" style="font-size:12px;margin-bottom:11px;line-height:1.55">One bundle for the press — approved art, ink list and the full size grid — ready to drop into your RIP.</p>
          <div class="stack" style="gap:8px">
            <a class="btn sm" href="/api/jobs/${id}/print-package?download=1" style="width:100%">↓ Print-ready package</a>
            <button class="btn ghost sm" id="po-order" style="width:100%">Order blanks from supplier</button>
            <a class="btn ghost sm" href="/api/jobs/${id}/po?download=1" style="width:100%">↓ Download PO (JSON)</a>
          </div>
        </div></div>

      <div class="card" id="po-recv-card" style="display:none"><div class="card-h"><h3>Blanks &amp; Receiving</h3></div>
        <div class="card-b" id="po-recv-body"></div></div>

      <div class="card"><div class="card-h"><h3>History</h3></div><div class="card-b">
        ${j.activities.length ? `<div class="tl">${j.activities.map((a) => `<div class="tl-i ${a.type === 'stage' ? 'gray' : ''}">
          <div class="tx">${esc(a.description)}</div><div class="dt">${relTime(a.created_at)}</div></div>`).join('')}</div>`
          : '<div class="dim">No history yet.</div>'}
      </div></div>

      <div class="card"><div class="card-b"><button class="btn danger sm" id="del" style="width:100%">Delete job</button></div></div>
    </div>
  </div>`

  $('#po-order')?.addEventListener('click', () => openPO(id, j.job_number))
  loadReceiving(id)
  $('#print-ticket').onclick = () => window.open(j.ticket_url || `/p/ticket/${id}`, '_blank')
  $('#stage').onchange = async (e) => {
    await api.patch(`/api/jobs/${id}/stage`, { stage: e.target.value })
    toast('Stage updated')
    jobDetailView(id)
  }
  $('#edit').onclick = () => jobForm(j, () => jobDetailView(id))

  const doUpload = async (file) => {
    if (!file) return
    const fd = new FormData()
    fd.append('file', file)
    try {
      await api.post(`/api/jobs/${id}/art`, fd)
      toast(`Uploaded ${file.name}`)
      jobDetailView(id)
    } catch (e) { toast(e.message, true) }
  }
  $('#file').onchange = (e) => doUpload(e.target.files[0])
  $('#upload-btn').onclick = () => $('#file').click()
  const drop = $('#drop')
  drop.onclick = () => $('#file').click()
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over') }
  drop.ondragleave = () => drop.classList.remove('over')
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); doUpload(e.dataTransfer.files[0]) }

  // #art-list is rebuilt on every render; #view is not, so binding there stacked one
  // listener per render and sent the customer a duplicate proof email for each.
  on($('#art-list'), '[data-send]', async (_e, t) => {
    t.disabled = true
    try {
      await api.post(`/api/art/${t.dataset.send}/send`)
      toast('Proof emailed to customer')
      jobDetailView(id)
    } catch (e) { toast(e.message, true); t.disabled = false }
  })
  $('#del').onclick = () => confirmModal('Delete job?', `${j.job_number} and its art versions will be removed.`, async () => {
    await api.del(`/api/jobs/${id}`)
    toast('Job deleted')
    go('/board')
  })
}

/**
 * Order blanks from the connected distributor. Shows the CONSOLIDATED PO (one line per
 * style/color/size — never split-ships), then submits it. Real spend, so it confirms clearly.
 */
async function openPO(id, jobNumber) {
  let po
  try { po = await api.get(`/api/jobs/${id}/po`) } catch (e) { return toast(e.message, true) }
  const rows = (po.lines || []).map((l) => `<tr>
    <td>${esc(l.sku || l.style || '—')}</td><td>${esc(l.color || '—')}</td><td>${esc(l.size)}</td>
    <td class="num">${l.qty}</td><td class="num muted">${l.unit_cost != null ? money(l.unit_cost) : '—'}</td></tr>`).join('')
  const connected = po.status === 'ready-to-submit' && po.supplier
  const warn = (po.warnings || []).length
    ? `<div class="card-b" style="border:1px solid rgba(247,185,85,.4);border-radius:8px;background:rgba(247,185,85,.08);font-size:12px;margin-bottom:12px">⚠ ${po.warnings.map(esc).join('<br>⚠ ')}</div>` : ''
  modal({
    title: `Order blanks — ${esc(jobNumber || po.job || '')}`,
    wide: true,
    body: `${warn}
      <p class="dim" style="font-size:12.5px;margin-bottom:10px">${connected
        ? `Submitting to <strong style="color:var(--txt-2)">${esc(po.supplier)}</strong>. Lines are consolidated to one row per style/color/size, so nothing split-ships.`
        : 'No distributor connected. Add S&S / SanMar / AlphaBroder credentials in Settings, or download this PO to place it manually.'}</p>
      <table class="tbl"><thead><tr><th>SKU / Style</th><th>Color</th><th>Size</th><th class="num">Qty</th><th class="num">Cost</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="dim">No sized lines on this job.</td></tr>'}</tbody></table>
      <div class="row" style="justify-content:space-between;margin-top:12px;font-size:13px">
        <span class="dim">${po.total_units} units${po.color ? ` · ${esc(po.color)}` : ''}</span>
        <strong>${po.est_cost ? money(po.est_cost) + ' est.' : ''}</strong></div>
      <div id="po-note" class="dim" style="font-size:12px;margin-top:10px"></div>`,
    footer: connected
      ? `<button class="btn ghost" data-close>Cancel</button><a class="btn ghost" href="/api/jobs/${id}/po?download=1">Download</a><button class="btn" id="po-submit">Submit order to ${esc(po.supplier)}</button>`
      : `<button class="btn ghost" data-close>Close</button><a class="btn" href="/api/jobs/${id}/po?download=1">Download PO</a>`,
    onMount: (bg) => {
      const btn = $('#po-submit', bg); if (!btn) return
      btn.onclick = async () => {
        btn.disabled = true; btn.textContent = 'Submitting…'
        try {
          const r = await api.post(`/api/jobs/${id}/po/submit`, {})
          if (r.ok) { toast(`Order placed with ${r.supplier}${r.order_id ? ` — #${r.order_id}` : ''}`); closeModal(); jobDetailView(id) }
          // The error branch used to be unreachable: a failed submit came back with pending:true
          // and no note, so this rendered esc(undefined) — an empty line — and the shop saw the
          // button quietly reset. Check for a real error FIRST, and show the distributor's own
          // words, because "Could not place order" does not tell anyone which key expired.
          else if (r.error) {
            $('#po-note', bg).innerHTML = `<strong>Not ordered.</strong> ${esc(r.error)}`
            toast(`Order NOT placed: ${r.error}`, true)
            btn.disabled = false; btn.textContent = 'Retry'
          } else if (r.pending) { $('#po-note', bg).innerHTML = esc(r.note || 'Submit this one by hand in the distributor’s portal, then mark it received here.'); btn.textContent = 'Submit order to ' + esc(r.supplier); btn.disabled = false }
          else { toast('Could not place order', true); btn.disabled = false; btn.textContent = 'Retry' }
        } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = 'Retry' }
      }
    },
  })
}


/* ---------- blanks receiving ---------- */

async function loadReceiving(jobId) {
  const card = document.getElementById('po-recv-card'); if (!card) return
  let data
  try { data = await api.get(`/api/jobs/${jobId}/purchase-orders`) } catch { return }
  const pos = data.purchase_orders || []
  if (!pos.length) { card.style.display = 'none'; return }
  card.style.display = ''
  renderReceiving(jobId, pos)
}

function poStatusPill(po) {
  const map = { received: 'green', partial: 'amber', submitted: '', placed_manually: '', draft: '' }
  const label = po.status === 'placed_manually' ? 'placed by hand' : po.status
  return `<span class="pill ${map[po.status] || ''}">${esc(label)}</span>`
}

function renderReceiving(jobId, pos) {
  const body = document.getElementById('po-recv-body'); if (!body) return
  body.innerHTML = pos.map((po) => {
    const shortLines = po.lines.filter((l) => l.short > 0)
    return `<div class="po-recv" data-po="${po.id}" style="border:1px solid var(--line);border-radius:8px;padding:11px;margin-bottom:10px">
      <div class="row" style="justify-content:space-between;align-items:center">
        <div><strong style="font-size:12.5px">${esc(po.po_number || 'PO')}</strong> ${poStatusPill(po)}</div>
        <div class="dim" style="font-size:12px">${po.received}/${po.ordered} received${po.short > 0 ? ` · <span style="color:var(--amber)">${po.short} short</span>` : ''}</div>
      </div>
      ${shortLines.length ? `<div class="dim" style="font-size:11.5px;margin-top:5px">Short: ${shortLines.map((l) => `${l.short} ${esc(l.size)}`).join(', ')}</div>` : ''}
      ${!po.fully_received ? `<button class="btn ghost sm" data-recv="${po.id}" style="margin-top:9px">Receive blanks</button>` : '<div class="dim" style="font-size:11.5px;margin-top:7px">✓ Fully received</div>'}
    </div>`
  }).join('')
  body.querySelectorAll('[data-recv]').forEach((b) => {
    b.addEventListener('click', () => { const po = pos.find((x) => String(x.id) === b.dataset.recv); if (po) openReceive(jobId, po) })
  })
}

/** Per-size receiving grid: enter how many of each size actually arrived. */
function openReceive(jobId, po) {
  const rows = po.lines.map((l) => `<tr>
    <td>${esc([l.style, l.color].filter(Boolean).join(' ') || l.sku || '—')}</td>
    <td>${esc(l.size)}</td>
    <td class="num">${l.qty_ordered}</td>
    <td class="num">${l.qty_received}</td>
    <td class="num" style="color:${l.short > 0 ? 'var(--amber)' : 'var(--txt-3)'}">${l.short}</td>
    <td><input class="input" type="number" min="0" max="${l.short}" value="${l.short}" data-line="${l.id}" style="width:70px;text-align:right"></td>
  </tr>`).join('')
  modal({
    title: `Receive blanks — ${esc(po.po_number || '')}`,
    wide: true,
    body: `<p class="dim" style="font-size:12.5px;margin-bottom:10px">Enter how many of each size actually arrived. Defaults to the outstanding count; lower it when a box comes up short.</p>
      <table class="tbl"><thead><tr><th>Blank</th><th>Size</th><th class="num">Ordered</th><th class="num">Received</th><th class="num">Short</th><th>Receiving now</th></tr></thead>
        <tbody>${rows}</tbody></table>
      <div id="recv-note" class="dim" style="font-size:12px;margin-top:10px"></div>`,
    footer: `<button class="btn ghost" data-close>Cancel</button><button class="btn" id="recv-save">Receive</button>`,
    onMount: (bg) => {
      $('#recv-save', bg).onclick = async () => {
        const receipts = [...bg.querySelectorAll('input[data-line]')]
          .map((i) => ({ line_id: Number(i.dataset.line), qty: Number(i.value) || 0 }))
          .filter((r) => r.qty > 0)
        if (!receipts.length) { $('#recv-note', bg).textContent = 'Enter at least one quantity.'; return }
        try {
          const updated = await api.post(`/api/purchase-orders/${po.id}/receive`, { receipts })
          toast(updated.fully_received ? 'All blanks received' : `Received — ${updated.received}/${updated.ordered}${updated.short ? `, ${updated.short} still short` : ''}`)
          closeModal(); loadReceiving(jobId)
        } catch (e) { $('#recv-note', bg).textContent = e.message }
      }
    },
  })
}
