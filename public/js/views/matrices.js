import { api, $, $$, esc, money, fmtDate, setPage, empty, toast, go, on, modal, closeModal, confirmModal , onOnce, guardLeave } from '../core.js'

/* Custom price matrices — the shop's own price sheets, in any shape.
 *
 * The whole screen is built on one idea: this software has no opinion about what you sell. A
 * matrix is a name, a grid of labels you wrote, and prices. Screen printing by ink colour and mug
 * printing by mug size are the same object here, which is why a shop can add "Laser Engraving" or
 * "Rush Fees" without anyone shipping a release for it.
 */

let cache = null   // last /api/matrices payload — templates and limits don't change mid-session

export async function matricesView() {
  setPage('Price matrices', `<button class="btn ghost" id="mx-new-blank">+ Blank matrix</button><button class="btn" id="mx-new">＋ New matrix</button>`,
    `<a href="#/pricing">Pricing</a> /`)
  $('#view').innerHTML = `<div class="stack" id="mx-list"><div class="card"><div class="card-b dim">Loading your price matrices…</div></div></div>`
  await drawList()
}

async function drawList() {
  cache = await api.get('/api/matrices')
  const { matrices: list, templates } = cache

  $('#mx-list').innerHTML = `
    <div class="card"><div class="card-b">
      <p class="dim" style="font-size:12.5px;line-height:1.6;margin:0">A price matrix is your own price sheet. Name it anything, label the rows and columns in your own words, and type your prices in. Screen printing by ink colour, mugs by size, engraving by area, banners by the square foot — same grid, your labels. Quotes let you pick which matrix a line is priced from, so one estimate can use several.</p>
    </div></div>

    ${list.length ? `<div class="card"><div class="card-h"><h3>Your matrices</h3><div class="spacer"></div>
        <span class="dim" style="font-size:11px">${list.length} matri${list.length === 1 ? 'x' : 'ces'}</span></div>
      <table class="tbl">
        <thead><tr><th>Name</th><th>Grid</th><th>Prices</th><th>Updated</th><th></th></tr></thead>
        <tbody>${list.map(rowHtml).join('')}</tbody>
      </table></div>`
      : empty('▦', 'No price matrices yet',
        'Start from a template that matches something you already sell, then change every number on it — or build one from scratch.', '')}

    <div class="card"><div class="card-h"><h3>Start from a template</h3></div>
      <div class="card-b">
        <p class="dim" style="font-size:12.5px;line-height:1.6;margin-bottom:14px">These are <strong style="color:var(--txt-2)">starting points, not rules</strong>. Importing one gives you your own copy — rename it, add or delete rows and columns, and overwrite every price. Nothing links back to the template.</p>
        <div class="mx-tpl">${templates.map(tplHtml).join('')}</div>
      </div></div>`

  wireList()
}

const rowHtml = (m) => `<tr>
  <td data-label="Name">
    <div style="font-weight:600">${esc(m.name)} ${m.isDefault ? '<span class="pill green">default</span>' : ''}</div>
    ${m.description ? `<div class="dim" style="font-size:12px">${esc(m.description)}</div>` : ''}
  </td>
  <td class="muted" data-label="Grid" style="font-size:12.5px">${m.rows} × ${m.cols}
    <div class="dim" style="font-size:11px">${esc(m.rowLabel)} × ${esc(m.colLabel)} · ${m.unit === 'flat' ? 'flat charge' : 'per piece'}</div></td>
  <td class="muted" data-label="Prices" style="font-size:12.5px">${m.filled} / ${m.rows * m.cols}
    ${m.filled < m.rows * m.cols ? `<div class="dim" style="font-size:11px">${m.rows * m.cols - m.filled} blank</div>` : ''}</td>
  <td class="dim" data-label="Updated" style="font-size:12px">${fmtDate(m.updatedAt)}</td>
  <td class="num mx-actions" data-label="">
    <button class="btn ghost sm" data-edit="${m.id}">Edit</button>
    <button class="btn ghost sm" data-dup="${m.id}" title="Make a copy of this matrix">Duplicate</button>
    ${m.isDefault ? '' : `<button class="btn ghost sm" data-def="${m.id}" title="Pre-select this matrix on new quotes">Make default</button>`}
    <button class="btn ghost sm" data-del="${m.id}" title="Delete this matrix" aria-label="Delete ${esc(m.name)}">&times;</button>
  </td></tr>`

const tplHtml = (t) => `<button class="mx-tpl-card" data-tpl="${esc(t.key)}" type="button" aria-label="Start a new matrix from the ${esc(t.name)} template">
  <div class="mx-tpl-name">${esc(t.name)}</div>
  <div class="mx-tpl-desc">${esc(t.description)}</div>
  <div class="mx-tpl-meta">${t.rows} × ${t.cols} · ${esc(t.rowLabel)} × ${esc(t.colLabel)}${t.sample ? ` · from ${money(t.sample.price)}` : ''}</div>
</button>`

function wireList() {
  /* #mx-list, NOT #view.
   *
   * #view is the app shell's one permanent <main>, shared by every screen, and onOnce never
   * unbinds — that is the point of it. So `[data-edit]` bound here stayed live for the rest of the
   * session, over every screen the shop opened afterwards, and `data-edit` is not a private
   * spelling: automations.js renders every rule row as <div class="autorow" data-edit="${a.id}">.
   * Its own edit handler does not stopPropagation (its DELETE handler does), so after one visit to
   * Price matrices, clicking any automation rule opened the rule dialog AND navigated the page to
   * #/matrices/<that rule's id> — an unrelated matrix, or core.js's "Page not found" underneath the
   * open dialog.
   *
   * #mx-list is rebuilt by matricesView() on each entry, so onOnce still binds exactly once per
   * screen, and drawList()'s repaints (which only replace its innerHTML) do not re-bind. */
  const root = $('#mx-list')
  onOnce(root, '[data-edit]', (_e, el) => go(`/matrices/${el.dataset.edit}`))
  onOnce(root, '[data-tpl]', async (_e, el) => {
    try {
      const { matrix } = await api.post('/api/matrices', { template: el.dataset.tpl })
      toast(`${matrix.name} added — it's yours now, change anything`)
      go(`/matrices/${matrix.id}`)
    } catch (e) { toast(e.message, true) }
  })
  onOnce(root, '[data-dup]', async (_e, el) => {
    try {
      const { matrix } = await api.post(`/api/matrices/${el.dataset.dup}/duplicate`)
      toast(`Copied to “${matrix.name}”`)
      go(`/matrices/${matrix.id}`)
    } catch (e) { toast(e.message, true) }
  })
  onOnce(root, '[data-def]', async (_e, el) => {
    try { await api.post(`/api/matrices/${el.dataset.def}/default`); toast('New quotes start on this matrix'); drawList() }
    catch (e) { toast(e.message, true) }
  })
  onOnce(root, '[data-del]', (_e, el) => {
    const m = cache.matrices.find((x) => String(x.id) === el.dataset.del)
    confirmModal('Delete this matrix?',
      `“${m.name}” and its ${m.filled} price${m.filled === 1 ? '' : 's'} are removed. Estimates already priced from it keep their prices — nothing on a saved quote changes.`,
      async () => { await api.del(`/api/matrices/${m.id}`); toast(`${m.name} deleted`); drawList() })
  })
  $('#mx-new').onclick = () => newMatrixModal()
  $('#mx-new-blank').onclick = async () => {
    try {
      const { matrix } = await api.post('/api/matrices', { template: 'blank' })
      go(`/matrices/${matrix.id}`)
    } catch (e) { toast(e.message, true) }
  }
}

/** Name it and say what the rows and columns mean. Four fields — the fastest path to a real grid. */
function newMatrixModal() {
  modal({
    title: 'New price matrix',
    body: `<p class="dim" style="font-size:12.5px;line-height:1.6;margin-bottom:14px">Name it whatever you call it in the shop. The row and column labels are just headings on your grid — you can change all of it later.</p>
      <div class="field"><label>Name *</label><input class="input" id="mx-n-name" placeholder="e.g. Mug Printing" maxlength="60"></div>
      <div class="field"><label>What it's for</label><input class="input" id="mx-n-desc" placeholder="Optional — a note to yourself" maxlength="200"></div>
      <div class="grid2">
        <div class="field"><label>Rows are…</label><input class="input" id="mx-n-rl" value="Quantity" maxlength="40"></div>
        <div class="field"><label>Columns are…</label><input class="input" id="mx-n-cl" value="Option" maxlength="40" placeholder="e.g. Mug size"></div>
      </div>
      <div class="field"><label>Each price is…</label><select class="input" id="mx-n-unit">
        <option value="piece">Per piece — multiplied by the quantity</option>
        <option value="flat">A flat charge — the whole line, whatever the quantity</option>
      </select></div>
      <div class="dim" id="mx-n-err" role="alert" style="color:var(--red);font-size:12px;display:none;margin-top:6px"></div>`,
    footer: `<button class="btn ghost" data-close>Cancel</button><button class="btn" id="mx-n-go">Create &amp; edit</button>`,
    onMount: (bg) => {
      $('#mx-n-name', bg).focus()
      $('#mx-n-go', bg).onclick = async () => {
        const name = $('#mx-n-name', bg).value.trim()
        if (!name) { const e = $('#mx-n-err', bg); e.textContent = 'Give the matrix a name.'; e.style.display = ''; return }
        try {
          const { matrix } = await api.post('/api/matrices', {
            template: 'blank', name,
            description: $('#mx-n-desc', bg).value.trim(),
            rowLabel: $('#mx-n-rl', bg).value.trim() || 'Quantity',
            colLabel: $('#mx-n-cl', bg).value.trim() || 'Option',
            unit: $('#mx-n-unit', bg).value,
          })
          closeModal(); go(`/matrices/${matrix.id}`)
        } catch (e) { const el = $('#mx-n-err', bg); el.textContent = e.message; el.style.display = '' }
      }
    },
  })
}

/* ── the editor ───────────────────────────────────────────────────────────────
   The grid is edited live in the browser and saved in one call, so adding a column and typing
   into it is one uninterrupted motion. `m` is the working copy; nothing is written until Save. */

let m = null
let dirty = false

export async function matrixEditor(id) {
  try { m = (await api.get(`/api/matrices/${id}`)).matrix }
  catch { setPage('Price matrix'); $('#view').innerHTML = empty('▦', 'Matrix not found', 'It may have been deleted.', '<a class="btn" href="#/matrices">Back to matrices</a>'); return }
  dirty = false
  setPage(m.name, `<button class="btn ghost" id="mx-back">Back</button><button class="btn" id="mx-save">Save matrix</button>`,
    `<a href="#/pricing">Pricing</a> / <a href="#/matrices">Price matrices</a> /`)
  drawEditor()
}

function drawEditor() {
  $('#view').innerHTML = `<div class="stack" style="max-width:1180px">
    <div class="card"><div class="card-b">
      <div class="grid2">
        <div class="field"><label>Name</label><input class="input" id="mx-name" value="${esc(m.name)}" maxlength="60"></div>
        <div class="field"><label>What it's for</label><input class="input" id="mx-desc" value="${esc(m.description)}" placeholder="Optional note to yourself" maxlength="200"></div>
      </div>
      <div class="grid3">
        <div class="field"><label>Rows are…</label><input class="input" id="mx-rl" value="${esc(m.rowLabel)}" maxlength="40"></div>
        <div class="field"><label>Columns are…</label><input class="input" id="mx-cl" value="${esc(m.colLabel)}" maxlength="40"></div>
        <div class="field"><label>Each price is…</label><select class="input" id="mx-unit">
          <option value="piece" ${m.unit === 'piece' ? 'selected' : ''}>Per piece</option>
          <option value="flat" ${m.unit === 'flat' ? 'selected' : ''}>A flat charge</option>
        </select></div>
      </div>
      <p class="dim" style="font-size:12px;margin:0">${m.unit === 'flat'
        ? 'A flat charge is the whole line total, whatever the quantity — right for setup fees, art charges and rush tiers.'
        : 'A per-piece price is multiplied by the line quantity on the quote.'}</p>
    </div></div>

    <div class="card"><div class="card-h"><h3>The grid</h3><div class="spacer"></div>
        <span class="dim" style="font-size:11px" id="mx-count"></span></div>
      <div class="card-b">
        <p class="dim" style="font-size:12.5px;line-height:1.6;margin-bottom:12px">Type over any heading to rename it, and type your prices into the cells. Leave a cell blank if you don't price that combination — the quote screen will say so rather than invent a number.${qtyAware() ? ' Your row headings read as quantity bands, so quotes will pick the right row from the line quantity automatically.' : ''}</p>
        <div class="tbl-wrap"><table class="mx-grid" id="mx-table"></table></div>
        <div class="wrap-row" style="margin-top:12px">
          <button class="btn ghost sm" id="mx-add-row">+ Add row</button>
          <button class="btn ghost sm" id="mx-add-col">+ Add column</button>
          <div class="sp"></div>
          <label class="btn ghost sm" style="cursor:pointer">Import a price sheet<input type="file" id="mx-file" accept=".csv,.tsv,text/csv,text/plain" style="display:none"></label>
          <button class="btn ghost sm" id="mx-paste">Paste a grid</button>
        </div>
        <div id="mx-note" class="dim" style="font-size:12px;margin-top:10px"></div>
      </div></div>

    <div class="card"><div class="card-h"><h3>Danger zone</h3></div>
      <div class="card-b wrap-row">
        <button class="btn ghost sm" id="mx-dup">Duplicate this matrix</button>
        ${m.isDefault ? '<span class="pill green">This is the default for new quotes</span>' : '<button class="btn ghost sm" id="mx-def">Make it the default for new quotes</button>'}
        <div class="sp"></div>
        <button class="btn ghost sm" id="mx-del" style="color:var(--red)">Delete matrix</button>
      </div></div>
  </div>`
  drawGrid()
  wireEditor()
}

/** True when the row headings read like quantity bands, which unlocks auto-row-pick on quotes. */
const qtyAware = () => m.rows.filter((r) => /\d/.test(r)).length >= Math.max(2, Math.ceil(m.rows.length / 2))

function drawGrid() {
  const t = $('#mx-table')
  t.innerHTML = `
    <thead><tr>
      <th class="mx-corner">${esc(m.rowLabel)} &darr; / ${esc(m.colLabel)} &rarr;</th>
      ${m.cols.map((c, ci) => `<th class="mx-head">
        <input class="mx-h" data-col="${ci}" value="${esc(c)}" maxlength="48" aria-label="Heading for column ${ci + 1} of ${m.cols.length}">
        <button class="mx-x" data-delcol="${ci}" title="Delete this column" type="button" aria-label="Delete the ${esc(c)} column">&times;</button>
      </th>`).join('')}
    </tr></thead>
    <tbody>${m.rows.map((r, ri) => `<tr>
      <th class="mx-head mx-rowhead">
        <input class="mx-h" data-row="${ri}" value="${esc(r)}" maxlength="48" aria-label="Heading for row ${ri + 1} of ${m.rows.length}">
        <button class="mx-x" data-delrow="${ri}" title="Delete this row" type="button" aria-label="Delete the ${esc(r)} row">&times;</button>
      </th>
      ${m.cols.map((_c, ci) => `<td class="mx-cell">
        <input class="mx-in" data-r="${ri}" data-c="${ci}" type="number" step="0.01" min="0" inputmode="decimal"
          value="${m.cells[ri][ci] === null ? '' : Number(m.cells[ri][ci]).toFixed(2)}" placeholder="—"
          aria-label="${esc(r)}, ${esc(m.cols[ci])}"></td>`).join('')}
    </tr>`).join('')}</tbody>`
  countCells()
}

function countCells() {
  const filled = m.cells.flat().filter((v) => v !== null).length
  const total = m.rows.length * m.cols.length
  const el = $('#mx-count')
  if (el) el.textContent = `${m.rows.length} × ${m.cols.length} · ${filled} of ${total} priced${dirty ? ' · unsaved' : ''}`
}

function wireEditor() {
  const root = $('#view') // persistent: bind with onOnce, never on()

  // Header + cell edits patch the working copy in place — redrawing would blur the field mid-type.
  onOnce(root, '.mx-in', (_e, el) => {
    const v = el.value.trim()
    m.cells[+el.dataset.r][+el.dataset.c] = v === '' ? null : Math.max(0, Math.round(Number(v) * 100) / 100)
    markDirty()
  }, 'input')
  onOnce(root, '.mx-h[data-col]', (_e, el) => { m.cols[+el.dataset.col] = el.value; markDirty() }, 'input')
  onOnce(root, '.mx-h[data-row]', (_e, el) => { m.rows[+el.dataset.row] = el.value; markDirty() }, 'input')

  onOnce(root, '[data-delrow]', (_e, el) => {
    if (m.rows.length <= 1) return toast('A matrix needs at least one row')
    const i = +el.dataset.delrow
    m.rows.splice(i, 1); m.cells.splice(i, 1)
    markDirty(); drawGrid()
  })
  onOnce(root, '[data-delcol]', (_e, el) => {
    if (m.cols.length <= 1) return toast('A matrix needs at least one column')
    const i = +el.dataset.delcol
    m.cols.splice(i, 1); m.cells.forEach((row) => row.splice(i, 1))
    markDirty(); drawGrid()
  })

  $('#mx-add-row').onclick = () => {
    m.rows.push(nextRowLabel())
    m.cells.push(m.cols.map(() => null))
    markDirty(); drawGrid()
    $$('.mx-h[data-row]').pop()?.select()
  }
  $('#mx-add-col').onclick = () => {
    m.cols.push(`${m.colLabel} ${m.cols.length + 1}`)
    m.cells.forEach((row) => row.push(null))
    markDirty(); drawGrid()
    $$('.mx-h[data-col]').pop()?.select()
  }

  // A quantity-banded matrix should suggest the next band, not "Row 9".
  function nextRowLabel() {
    const last = m.rows[m.rows.length - 1] || ''
    const mm = String(last).match(/(\d[\d,]*)\s*[-–—+]?\s*(\d[\d,]*)?/)
    if (!mm) return `${m.rowLabel} ${m.rows.length + 1}`
    const high = Number(String(mm[2] || mm[1]).replace(/,/g, ''))
    return Number.isFinite(high) ? `${high + 1}+` : `${m.rowLabel} ${m.rows.length + 1}`
  }

  for (const id of ['mx-name', 'mx-desc', 'mx-rl', 'mx-cl']) $(`#${id}`).oninput = markDirty
  $('#mx-unit').onchange = markDirty

  $('#mx-save').onclick = save

  // `dirty` was tracked, displayed (" · unsaved") and then never acted on. Back went straight to
  // the list and every price typed since the last Save was gone — no prompt, no undo, and this
  // grid is the one screen where a shop types for ten minutes before saving once.
  const leaveEditor = (to) => {
    if (!dirty) return go(to)
    confirmModal('Leave without saving?',
      'The prices you typed are only in this browser. Leaving now discards them.',
      () => { dirty = false; go(to) }, 'Discard changes')
  }
  $('#mx-back').onclick = () => leaveEditor('/matrices')

  /* The paths the app DOES control: the sidebar, the tabbar, the `g` keyboard shortcuts and the
   * browser's Back button. Every one of them is a hash change, and a hash change fires no
   * beforeunload — so the listener below never saw any of them. This is the choke point that does.
   * Refusing owns re-issuing the navigation once the shop has answered. */
  guardLeave((to) => {
    if (!dirty) return true
    confirmModal('Leave without saving?',
      'The prices you typed are only in this browser. Leaving now discards them.',
      () => { dirty = false; go(to) }, 'Discard changes')
    return false
  })
  $('#mx-dup').onclick = async () => {
    const { matrix } = await api.post(`/api/matrices/${m.id}/duplicate`)
    toast(`Copied to “${matrix.name}”`); go(`/matrices/${matrix.id}`)
  }
  const defBtn = $('#mx-def')
  if (defBtn) defBtn.onclick = async () => { await api.post(`/api/matrices/${m.id}/default`); toast('New quotes start on this matrix'); matrixEditor(m.id) }
  $('#mx-del').onclick = () => confirmModal('Delete this matrix?',
    `“${m.name}” is removed. Estimates already priced from it keep their prices.`,
    async () => { await api.del(`/api/matrices/${m.id}`); toast('Deleted'); go('/matrices') })

  $('#mx-file').onchange = async (e) => {
    const file = e.target.files && e.target.files[0]
    if (!file) return
    await importSheet(() => { const fd = new FormData(); fd.append('file', file); fd.append('replace', String(m.id)); return fd })
    e.target.value = ''
  }
  $('#mx-paste').onclick = () => pasteModal()
}

function markDirty() { dirty = true; countCells() }

// The same promise for the paths the app does not control: tab close, reload, and navigating off
// the origin entirely. NOT the browser's Back button — that is a hash change, it fires no
// beforeunload, and it is the guardLeave above that catches it. Bound once, and it only speaks
// while the grid is actually on screen.
if (typeof window !== 'undefined' && !window.__pscMxGuard) {
  window.__pscMxGuard = true
  window.addEventListener('beforeunload', (e) => {
    if (!dirty || !document.getElementById('mx-table')) return
    e.preventDefault()
    e.returnValue = ''
  })
}

async function importSheet(bodyFn) {
  const note = $('#mx-note')
  note.textContent = 'Reading your sheet…'
  try {
    const r = await api.req('POST', '/api/matrices/import', bodyFn())
    m = r.matrix; dirty = false
    drawEditor()
    $('#mx-note').innerHTML = `<span style="color:var(--accent)">Imported ${r.filled} price${r.filled === 1 ? '' : 's'} — your headings came through as you wrote them.</span>`
  } catch (e) { note.innerHTML = `<span style="color:var(--red)">${esc(e.message)}</span>` }
}

function pasteModal() {
  modal({
    title: 'Paste a price grid', wide: true,
    body: `<p class="dim" style="font-size:12.5px;line-height:1.6;margin-bottom:12px">Copy the grid straight out of your spreadsheet and paste it here. First row = your column headings, first column = your row headings. Headings can be anything — “11 oz Mug”, “Both sides”, “1-11”.</p>
      <textarea class="input" id="mx-paste-text" rows="10" style="font-family:var(--mono,monospace);font-size:12px" placeholder="Quantity,11 oz Mug,15 oz Mug&#10;1-11,18.00,20.00&#10;12-23,13.00,14.50"></textarea>
      <p class="dim" style="font-size:11.5px;margin-top:8px">This replaces the whole grid in <strong style="color:var(--txt-2)">${esc(m.name)}</strong>.</p>
      <div class="dim" id="mx-paste-err" role="alert" style="color:var(--red);font-size:12px;display:none;margin-top:6px"></div>`,
    footer: `<button class="btn ghost" data-close>Cancel</button><button class="btn" id="mx-paste-go">Read the grid</button>`,
    onMount: (bg) => {
      $('#mx-paste-go', bg).onclick = async () => {
        const text = $('#mx-paste-text', bg).value
        if (!text.trim()) { const e = $('#mx-paste-err', bg); e.textContent = 'Paste your grid first.'; e.style.display = ''; return }
        try {
          const r = await api.post('/api/matrices/import', { text, replace: m.id })
          closeModal()
          m = r.matrix; dirty = false
          drawEditor()
          $('#mx-note').innerHTML = `<span style="color:var(--accent)">Imported ${r.filled} price${r.filled === 1 ? '' : 's'}.</span>`
        } catch (e) { const el = $('#mx-paste-err', bg); el.textContent = e.message; el.style.display = '' }
      }
    },
  })
}

async function save() {
  const note = $('#mx-note')
  note.textContent = 'Saving…'
  try {
    const payload = {
      name: $('#mx-name').value.trim(),
      description: $('#mx-desc').value.trim(),
      rowLabel: $('#mx-rl').value.trim(),
      colLabel: $('#mx-cl').value.trim(),
      unit: $('#mx-unit').value,
      rows: m.rows, cols: m.cols, cells: m.cells,
    }
    const r = await api.put(`/api/matrices/${m.id}`, payload)
    m = r.matrix; dirty = false
    // The server may have de-duplicated headings or renamed a blank one, so redraw from its answer.
    drawEditor()
    $('#mx-note').innerHTML = '<span style="color:var(--accent)">Saved — quotes use these prices now.</span>'
    toast('Matrix saved')
  } catch (e) { note.innerHTML = `<span style="color:var(--red)">${esc(e.message)}</span>` }
}

/* ── the quote-side picker ────────────────────────────────────────────────────
   Exported for the estimate editor: pick a matrix, a row and a column, see the price, use it.
   `onPick` receives the priced line so the caller decides whether to fill a line or add one. */

export async function matrixPickerModal({ qty = 0, onPick } = {}) {
  let payload
  try { payload = await api.get('/api/matrices') } catch { return toast('Could not load your price matrices', true) }
  if (!payload.matrices.length) {
    return modal({
      title: 'No price matrices yet',
      body: `<p class="dim" style="font-size:13px;line-height:1.6">A price matrix is your own price sheet — your rows, your columns, your prices. Set one up and every quote can pull from it.</p>`,
      footer: `<button class="btn ghost" data-close>Not now</button><button class="btn" id="mx-goto">Set one up</button>`,
      onMount: (bg) => { $('#mx-goto', bg).onclick = () => { closeModal(); go('/matrices') } },
    })
  }

  const start = payload.matrices.find((x) => x.isDefault) || payload.matrices[0]
  let loaded = null

  modal({
    title: 'Price from a matrix', wide: true,
    body: `<div class="grid2">
        <div class="field"><label>Matrix</label><select class="input" id="mp-matrix">
          ${payload.matrices.map((x) => `<option value="${x.id}" ${x.id === start.id ? 'selected' : ''}>${esc(x.name)}${x.isDefault ? ' — default' : ''}</option>`).join('')}
        </select></div>
        <div class="field"><label>Quantity</label><input class="input" id="mp-qty" type="number" min="0" value="${Math.max(0, Number(qty) || 0)}"></div>
      </div>
      <div class="grid2">
        <div class="field"><label id="mp-rl">Row</label><select class="input" id="mp-row"></select></div>
        <div class="field"><label id="mp-cl">Column</label><select class="input" id="mp-col"></select></div>
      </div>
      <div id="mp-out" class="mx-out"></div>
      <div class="field"><label>Line description</label><input class="input" id="mp-desc" placeholder="What the customer sees on the quote"></div>`,
    footer: `<button class="btn ghost" data-close>Cancel</button><button class="btn" id="mp-use">Use this price</button>`,
    onMount: (bg) => {
      const load = async (id) => {
        loaded = (await api.get(`/api/matrices/${id}`)).matrix
        $('#mp-rl', bg).textContent = loaded.rowLabel
        $('#mp-cl', bg).textContent = loaded.colLabel
        const q = Number($('#mp-qty', bg).value) || 0
        // A quantity-banded matrix pre-selects its own row, which is the whole point of typing
        // "1-11" / "48-71" as headings. A matrix of sizes or sides just starts at the first row.
        const suggested = suggestRow(loaded.rows, q)
        $('#mp-row', bg).innerHTML = loaded.rows.map((r, i) => `<option value="${i}" ${i === suggested ? 'selected' : ''}>${esc(r)}</option>`).join('')
        $('#mp-col', bg).innerHTML = loaded.cols.map((c, i) => `<option value="${i}">${esc(c)}</option>`).join('')
        show()
      }
      const show = () => {
        const ri = +$('#mp-row', bg).value, ci = +$('#mp-col', bg).value
        const q = Number($('#mp-qty', bg).value) || 0
        const price = loaded.cells[ri]?.[ci]
        const out = $('#mp-out', bg)
        if (price === null || price === undefined) {
          out.className = 'mx-out empty'
          out.innerHTML = `<div>No price set for <strong>${esc(loaded.rows[ri])}</strong> × <strong>${esc(loaded.cols[ci])}</strong>. Fill that cell in on the matrix, or pick another combination.</div>`
        } else {
          const amount = loaded.unit === 'flat' ? price : price * q
          out.className = 'mx-out'
          out.innerHTML = `<div class="mx-out-price">${money(price)}<span>${loaded.unit === 'flat' ? ' flat' : ' / piece'}</span></div>
            <div class="mx-out-sub">${esc(loaded.name)} · ${esc(loaded.rows[ri])} × ${esc(loaded.cols[ci])}${loaded.unit === 'flat' ? '' : ` · ${q} pcs = <strong>${money(amount)}</strong>`}</div>`
        }
        const d = $('#mp-desc', bg)
        if (!d.dataset.touched) d.value = `${loaded.name} — ${loaded.cols[ci]}`
      }
      $('#mp-matrix', bg).onchange = (e) => load(e.target.value)
      $('#mp-row', bg).onchange = show
      $('#mp-col', bg).onchange = show
      $('#mp-qty', bg).oninput = () => {
        // Re-suggest the band as the quantity changes, unless the user has picked a row by hand.
        const sel = $('#mp-row', bg)
        if (!sel.dataset.touched) {
          const s = suggestRow(loaded.rows, Number($('#mp-qty', bg).value) || 0)
          if (s >= 0) sel.value = String(s)
        }
        show()
      }
      $('#mp-row', bg).addEventListener('change', (e) => { e.target.dataset.touched = '1' })
      $('#mp-desc', bg).addEventListener('input', (e) => { e.target.dataset.touched = '1' })

      $('#mp-use', bg).onclick = () => {
        const ri = +$('#mp-row', bg).value, ci = +$('#mp-col', bg).value
        const price = loaded.cells[ri]?.[ci]
        if (price === null || price === undefined) return toast('That cell has no price yet', true)
        closeModal()
        onPick?.({
          price, unit: loaded.unit,
          qty: Number($('#mp-qty', bg).value) || 0,
          description: $('#mp-desc', bg).value.trim() || loaded.name,
          detail: `${loaded.rows[ri]} · ${loaded.cols[ci]}`,
          matrix: { id: loaded.id, name: loaded.name, row: loaded.rows[ri], col: loaded.cols[ci] },
        })
      }
      load(start.id)
    },
  })
}

/**
 * Which row a quantity falls in — the browser-side twin of rowIndexForQty in lib/matrices.mjs.
 * Duplicated deliberately: the picker re-suggests on every keystroke, and a round trip per digit
 * would make typing a quantity feel broken. The server stays authoritative for stored prices.
 */
function suggestRow(rows, qty) {
  if (!qty || !rows?.length) return 0
  const parsed = rows.map((label) => {
    const s = String(label)
    if (!/\d/.test(s)) return null
    const n = (x) => Number(String(x).replace(/,/g, ''))
    let mm = s.match(/^\D*(\d[\d,]*)\s*(?:\+|plus\b|or more\b|and up\b)/i)
    if (mm) return { min: n(mm[1]), max: Infinity, exact: false }
    mm = s.match(/^\D*(\d[\d,]*)\s*(?:-|–|—|to|thru|through)\s*(\d[\d,]*)/i)
    if (mm) return { min: n(mm[1]), max: n(mm[2]), exact: false }
    mm = s.match(/^\s*(?:up to|under|below|max|<=?)\s*(\d[\d,]*)/i)
    if (mm) return { min: 0, max: n(mm[1]), exact: false }
    mm = s.match(/(\d[\d,]*)/)
    return mm ? { min: n(mm[1]), max: n(mm[1]), exact: true } : null
  })
  if (!parsed.some(Boolean)) return 0
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i]
    if (p && !p.exact && qty >= p.min && qty <= p.max) return i
  }
  let best = 0, bestMin = -1
  parsed.forEach((p, i) => { if (p && p.min <= qty && p.min >= bestMin) { bestMin = p.min; best = i } })
  return best
}
