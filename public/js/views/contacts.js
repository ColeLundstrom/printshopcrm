import { api, $, $$, esc, money, money0, fmtDate, relTime, pill, setPage, empty, modal, closeModal, confirmModal, formData, toast, go, initials, on , onOnce, onceClick } from '../core.js'

let filterTag = ''

// A single mapping editor shared by both import dialogs. No data leaves this shop.
function mappingEditor(bg, prefix, kind) {
  let mapping = null
  const box = document.createElement('div')
  $('#' + prefix + '-out', bg).before(box)
  return {
    reset() { mapping = null; box.replaceChildren() },
    append(fd) { if (mapping) fd.append('mapping', JSON.stringify(mapping)) },
    async prepare(fd) {
      if (mapping) return
      const probe = new FormData()
      for (const [key, value] of fd) probe.append(key, value)
      probe.set('mapping_only', 'true')
      const info = await api.req('POST', '/api/import/' + kind, probe)
      mapping = info.mapping
      box.innerHTML = `<details open style="margin-top:12px"><summary>Match your columns</summary><p class="dim">Choose where each field comes from. Changes require another preview. Size columns on orders are detected automatically.</p><div class="grid2">${info.fields.map((field, i) => `<div class="field"><label for="${prefix}-map-${i}">${esc(({first:'first name',last:'last name'})[field] || field.replaceAll('_', ' '))}</label><select class="input" id="${prefix}-map-${i}"><option value="">Do not import</option>${info.headers.map((h, n) => `<option value="${n + 1}" ${mapping[field] === h ? 'selected' : ''}>${esc(h)}${info.examples[h] ? ' — ' + esc(info.examples[h]) : ''}</option>`).join('')}</select></div>`).join('')}</div></details>`
      info.fields.forEach((field, i) => {
        $('#' + prefix + '-map-' + i, bg).onchange = e => {
          mapping[field] = e.target.value ? info.headers[Number(e.target.value) - 1] : null
          $('#' + prefix + '-go', bg).disabled = true
          $('#' + prefix + '-out', bg).textContent = 'Preview the updated column mapping before importing.'
        }
      })
    },
    reviewed() { const details = box.querySelector('details'); if (details) details.open = false },
    lock(value) { box.querySelectorAll('select').forEach(el => { el.disabled = value }) }
  }
}


export async function contactsView() {
  setPage('Customers', `<button class="btn ghost" id="import-c">Import CSV</button><button class="btn ghost" id="import-o">Import order history</button><button class="btn" id="new-c">+ New Customer</button>`)
  const render = async (q = '') => {
    const d = await api.get(`/api/contacts?q=${encodeURIComponent(q)}&tag=${encodeURIComponent(filterTag)}`)
    const body = d.contacts.length ? `<table class="tbl stack">
      <thead><tr><th>Customer</th><th>Contact</th><th>Tags</th><th class="num">Orders</th><th class="num">Lifetime</th><th class="num">Balance</th></tr></thead>
      <tbody>${d.contacts.map((c) => `<tr class="click" data-id="${c.id}">
        <td data-label="Customer"><div class="row"><div class="avatar">${esc(initials(c.name))}</div><div>
          <div style="font-weight:600">${esc(c.name)}</div>
          <div class="dim" style="font-size:12px">${esc(c.company || '—')}</div></div></div></td>
        <td data-label="Contact"><div style="font-size:12.5px">${esc(c.email || '—')}</div><div class="dim" style="font-size:12px">${esc(c.phone || '')}</div></td>
        <td data-label="Tags">${c.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(' ') || '<span class="dim">—</span>'}</td>
        <td class="num" data-label="Orders">${c.job_count}</td>
        <td class="num" data-label="Lifetime"><strong>${money0(c.lifetime_value)}</strong></td>
        <td class="num" data-label="Balance">${c.balance > 0 ? `<span style="color:var(--amber);font-weight:600">${money0(c.balance)}</span>` : '<span class="dim">—</span>'}</td>
      </tr>`).join('')}</tbody></table>`
      : empty('◉', 'No customers found', q || filterTag ? 'Try a different search or clear the tag filter.' : 'Add your first customer to get started.', q || filterTag ? '' : '<a class="btn" href="#/contacts?new=1">Add a customer</a>')

    // Only the innerHTML is replaced here. The delegated listeners are bound ONCE below, on the
    // persistent #list and #tags elements — binding them inside render() added a new listener on
    // every render, and since the tag handler calls render(), one tag click fired 1→2→4→8… fetches.
    // Ten clicks meant a thousand concurrent GET /api/contacts and a locked tab.
    // The tag chips are inside the node their own click replaces, so pressing one destroyed the
    // button that was pressed and dropped focus on <body> — back to the top of the document, past
    // the skip link and the whole sidebar. board.js carries this rule for the board's filter chips
    // and the gate asserts it there; this is the same control one screen over.
    const wasTag = document.activeElement?.dataset?.tag
    $('#list').innerHTML = body
    $('#tags').innerHTML = ['', ...d.tags].map((t) => `<button type="button" class="${filterTag === t ? 'on' : ''}" data-tag="${esc(t)}" aria-pressed="${filterTag === t}">${t ? esc(t) : 'All'}</button>`).join('')
    if (wasTag !== undefined) $(`#tags [data-tag="${CSS.escape(wasTag)}"]`)?.focus?.()
  }

  $('#view').innerHTML = `<div class="searchbar">
      <input class="input" id="q" placeholder="Search name, company, email…" autocomplete="off">
      <div class="tabs" id="tags" role="group" aria-label="Filter customers by tag"></div>
    </div><div class="card" id="list"></div>`

  // Bound once, on elements that outlive every render.
  on($('#list'), '[data-id]', (_e, t) => go(`/contacts/${t.dataset.id}`))
  on($('#tags'), '[data-tag]', (_e, t) => { filterTag = t.dataset.tag; render($('#q').value) })

  let t
  $('#q').oninput = (e) => { clearTimeout(t); t = setTimeout(() => render(e.target.value), 180) }
  $('#new-c').onclick = () => contactForm(null, () => render($('#q').value))
  $('#import-c').onclick = () => importContacts(() => render($('#q').value))
  $('#import-o').onclick = () => importOrders(() => render($('#q').value))
  if (new URLSearchParams(location.hash.split('?')[1] || '').get('new')) { history.replaceState(null, '', location.hash.split('?')[0]); contactForm(null, () => render($('#q').value)) }
  await render()
}

/** Import a customer list from a CSV export of the shop's old tool — preview first, then import. */
export function importContacts(after) {
  modal({
    title: 'Import customers from CSV',
    wide: true,
    body: `<p class="dim" style="font-size:12.5px;line-height:1.6;margin-bottom:12px">Export your customers from Printavo, shopVOX, DecoNetwork, QuickBooks, or a spreadsheet, then drop the CSV here. Review the suggested column matches or choose your own. Existing email addresses are skipped; rows without email cannot be matched to existing customers.</p>
      <label class="csv-drop" id="csv-drop"><input type="file" id="csv-file" accept=".csv,text/csv,text/plain" hidden>
        <div id="csv-drop-txt">Choose a CSV file — or paste rows below</div></label>
      <div class="field" style="margin-top:10px"><label>…or paste CSV rows</label>
        <textarea class="input" id="csv-text" style="min-height:90px;font-family:ui-monospace,Menlo,monospace;font-size:12px" placeholder="name,email,phone,company&#10;Jamie Rivera,jamie@example.edu,(714) 555-0142,Lakeside High School"></textarea></div>
      <div id="csv-out" style="margin-top:12px"></div>`,
    footer: `<button class="btn ghost" data-close>Cancel</button><button class="btn ghost" id="csv-preview">Preview</button><button class="btn" id="csv-go" disabled>Import</button>`,
    onMount: (bg) => {
      const fileInput = $('#csv-file', bg)
      const mapper = mappingEditor(bg, 'csv', 'contacts')
      let busy = false
      $('#csv-text', bg).oninput = () => { mapper.reset(); fileInput.value = ''; $('#csv-go', bg).disabled = true; $('#csv-out', bg).textContent = 'Preview the updated rows before importing.' }
      const send = async (preview) => {
        const out = $('#csv-out', bg)
        if (busy) return
        $('#csv-go', bg).disabled = true
        const fd = new FormData()
        fd.append('preview', preview ? 'true' : 'false')
        if (fileInput.files[0]) fd.append('file', fileInput.files[0])
        else if ($('#csv-text', bg).value.trim()) fd.append('text', $('#csv-text', bg).value)
        else { out.innerHTML = '<span class="dim" style="color:var(--amber)">Choose a file or paste some rows first.</span>'; return }
        out.innerHTML = '<span class="dim">Reading…</span>'
        try {
          busy = true; fileInput.disabled = true; $('#csv-text', bg).disabled = true
          await mapper.prepare(fd); mapper.lock(true); mapper.append(fd)
          const r = await api.req('POST', '/api/import/contacts', fd)
          if (r.preview) {
            mapper.reviewed()
            const cols = Object.entries(r.columns).filter(([, v]) => v).map(([k]) => k)
            out.innerHTML = `<div class="card-b" style="border:1px solid var(--line);border-radius:8px">
              <div style="font-size:13px"><strong style="color:var(--accent)">${r.to_import}</strong> new customer${r.to_import === 1 ? '' : 's'} ready to import
                ${r.duplicates ? ` · <span class="dim">${r.duplicates} already on file</span>` : ''}${r.skipped ? ` · <span class="dim">${r.skipped} without a name skipped</span>` : ''}</div>
              <div class="dim" style="font-size:11.5px;margin-top:5px">Detected columns: ${cols.join(', ') || 'none'}</div>
              ${r.sample.length ? `<table class="tbl" style="margin-top:8px"><tbody>${r.sample.map((c) => `<tr><td style="font-weight:600">${esc(c.name)}</td><td class="dim" style="font-size:12px">${esc(c.email || '—')}</td><td class="dim" style="font-size:12px">${esc(c.company || '')}</td></tr>`).join('')}</tbody></table>` : ''}</div>`
            $('#csv-go', bg).disabled = r.to_import === 0
          } else {
            out.innerHTML = `<div style="color:var(--accent);font-size:13px">✓ Imported ${r.created} customer${r.created === 1 ? '' : 's'}.${r.duplicates ? ` ${r.duplicates} were already on file.` : ''}</div>`
            toast(`Imported ${r.created} customers`)
            setTimeout(() => { closeModal(); after?.() }, 900)
          }
        } catch (e) { out.innerHTML = `<span style="color:var(--red)">${esc(e.message)}</span>` } finally { busy = false; mapper.lock(false); fileInput.disabled = false; $('#csv-text', bg).disabled = false }
      }
      $('#csv-drop', bg).onclick = () => fileInput.click()
      fileInput.onchange = () => { mapper.reset(); if (fileInput.files[0]) { $('#csv-drop-txt', bg).textContent = `${fileInput.files[0].name}`; send(true) } }
      $('#csv-preview', bg).onclick = () => send(true)
      $('#csv-go', bg).onclick = () => send(false)
    },
  })
}

/**
 * Import full ORDER HISTORY (Printavo "Quotes/Invoices" export, YoPrint, InkSoft, Deco order
 * summaries). Writes real history — estimates, paid invoices, completed jobs, all backdated —
 * so Reorder Radar, lifetime value, A/R aging and "same as last time" work on day one.
 * This is the switching-cost inverter: their old tool held the history hostage; we ingest it.
 */
export function importOrders(after) {
  modal({
    title: 'Import order history from CSV',
    wide: true,
    body: `<p class="dim" style="font-size:12.5px;line-height:1.6;margin-bottom:12px">Drop your old system's <strong>orders / invoices export</strong> (Printavo: Reports → Export → Quotes/Invoices; also works with YoPrint, InkSoft and DecoNetwork order summaries). Review explicit payment states before importing: paid, unpaid, or quote. Unknown, completed-only, and partial-payment statuses pause the import for review. Historical jobs are treated as completed; migrate active production separately. Reorder Radar and "same as last time" light up immediately. Re-running the same export is safe — orders already on file are skipped, whether or not your export has an order-number column.</p>
      <label class="csv-drop" id="ocsv-drop"><input type="file" id="ocsv-file" accept=".csv,text/csv,text/plain" hidden>
        <div id="ocsv-drop-txt">Choose the orders CSV — or paste rows below</div></label>
      <div class="field" style="margin-top:10px"><label>…or paste CSV rows</label>
        <textarea class="input" id="ocsv-text" style="min-height:90px;font-family:ui-monospace,Menlo,monospace;font-size:12px" placeholder="customer,email,invoice #,date,status,total&#10;Lakeside High School,jamie@example.edu,INV-2041,2025-09-14,paid,1284.00"></textarea></div>
      <div id="ocsv-out" style="margin-top:12px"></div>`,
    footer: `<button class="btn ghost" data-close>Cancel</button><button class="btn ghost" id="ocsv-preview">Preview</button><button class="btn" id="ocsv-go" disabled>Import history</button>`,
    onMount: (bg) => {
      const fileInput = $('#ocsv-file', bg)
      const mapper = mappingEditor(bg, 'ocsv', 'orders')
      let busy = false
      $('#ocsv-text', bg).oninput = () => { mapper.reset(); fileInput.value = ''; $('#ocsv-go', bg).disabled = true; $('#ocsv-out', bg).textContent = 'Preview the updated rows before importing.' }
      const send = async (preview) => {
        const out = $('#ocsv-out', bg)
        if (busy) return
        $('#ocsv-go', bg).disabled = true
        const fd = new FormData()
        fd.append('preview', preview ? 'true' : 'false')
        fd.append('status_policy', 'strict')
        if (fileInput.files[0]) fd.append('file', fileInput.files[0])
        else if ($('#ocsv-text', bg).value.trim()) fd.append('text', $('#ocsv-text', bg).value)
        else { out.innerHTML = '<span class="dim" style="color:var(--amber)">Choose a file or paste some rows first.</span>'; return }
        out.innerHTML = '<span class="dim">Reading…</span>'
        try {
          busy = true; fileInput.disabled = true; $('#ocsv-text', bg).disabled = true
          await mapper.prepare(fd); mapper.lock(true); mapper.append(fd)
          const r = await api.req('POST', '/api/import/orders', fd)
          if (r.preview) {
            if (r.orders > 0 && !r.blocked) mapper.reviewed()
            out.innerHTML = `<div class="card-b" style="border:1px solid var(--line);border-radius:8px">
              <div style="font-size:13px"><strong style="color:var(--accent)">${r.orders}</strong> order${r.orders === 1 ? '' : 's'} across <strong>${r.customers}</strong> customer${r.customers === 1 ? '' : 's'} — ${money0(r.totalValue)} of history</div>
              ${r.payment_states ? `<p class="dim">${r.payment_states.paid || 0} paid · ${r.payment_states.unpaid || 0} unpaid · ${r.payment_states.quote || 0} quotes · ${r.payment_states.needs_review || 0} need review</p>` : ''}
              ${r.blocked ? '<p style="color:var(--amber)">Import paused: use an explicit paid, unpaid, or quote status. Completed production does not prove payment. Partial payments need balance reconciliation before importing.</p>' : ''}
              ${r.warnings?.length ? `<div class="dim" style="font-size:11.5px;margin-top:5px">${r.warnings.length} row(s) need attention: ${esc(r.warnings[0].message)}${r.warnings.length > 1 ? ` (+${r.warnings.length - 1} more)` : ''}</div>` : ''}
              ${r.sample?.length ? `<table class="tbl" style="margin-top:8px"><tbody>${r.sample.map((o) => `<tr><td style="font-weight:600">${esc(o.customer_name || o.customer_email || '?')}</td><td class="dim" style="font-size:12px">${esc(o.order_number || '')}</td><td class="dim" style="font-size:12px">${esc(o.date || '')}</td><td class="num">${money0(o.total || 0)}</td></tr>`).join('')}</tbody></table>` : ''}</div>`
            $('#ocsv-go', bg).disabled = r.orders === 0 || r.blocked
          } else {
            // Say when a total did not match its own lines. The difference is written as a named
            // line on the document rather than left as a gap between subtotal and total, and the
            // shop is the only one who knows whether it was shipping, a rush fee or old tax.
            out.innerHTML = `<div style="color:var(--accent);font-size:13px">✓ Imported ${r.imported} order${r.imported === 1 ? '' : 's'} (${r.new_customers} new customer${r.new_customers === 1 ? '' : 's'}${r.open_quotes ? `, ${r.open_quotes} open quotes` : ''}${r.unpaid_invoices ? `, ${r.unpaid_invoices} unpaid invoices` : ''}${r.skipped_duplicates ? `, ${r.skipped_duplicates} duplicates skipped` : ''}).</div>`
              + (r.totals_reconciled ? `<div class="dim" style="font-size:11.5px;margin-top:5px">${r.totals_reconciled} order${r.totals_reconciled === 1 ? ' had a total that did not match its' : 's had totals that did not match their'} lines — the difference is on each document as “Other charges” or “Discount”, so every one of them adds up.</div>` : '')
            toast(`Imported ${r.imported} orders with history`)
            setTimeout(() => { closeModal(); after?.() }, 1200)
          }
        } catch (e) { out.innerHTML = `<span style="color:var(--red)">${esc(e.message)}</span>` } finally { busy = false; mapper.lock(false); fileInput.disabled = false; $('#ocsv-text', bg).disabled = false }
      }
      $('#ocsv-drop', bg).onclick = () => fileInput.click()
      fileInput.onchange = () => { mapper.reset(); if (fileInput.files[0]) { $('#ocsv-drop-txt', bg).textContent = `${fileInput.files[0].name}`; send(true) } }
      $('#ocsv-preview', bg).onclick = () => send(true)
      $('#ocsv-go', bg).onclick = () => send(false)
    },
  })
}

export function contactForm(c, after) {
  modal({
    title: c ? 'Edit Customer' : 'New Customer',
    body: `<div class="grid2">
        <div class="field"><label>Name *</label><input class="input" name="name" value="${esc(c?.name || '')}" placeholder="Jamie Rivera"></div>
        <div class="field"><label>Company</label><input class="input" name="company" value="${esc(c?.company || '')}" placeholder="Lakeside High School"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Email</label><input class="input" name="email" type="email" value="${esc(c?.email || '')}" placeholder="jamie@example.com"></div>
        <div class="field"><label>Phone</label><input class="input" name="phone" value="${esc(c?.phone || '')}" placeholder="(714) 555-0142"></div>
      </div>
      <div class="field"><label>Tags (comma separated)</label><input class="input" name="tags" value="${esc((c?.tags || []).join(', '))}" placeholder="school, repeat, net-30"></div>
      <div class="field">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" name="tax_exempt" id="tax-exempt" ${c?.tax_exempt ? 'checked' : ''} style="width:auto;margin:0">
          <span>Wholesale / tax exempt — don't charge sales tax</span>
        </label>
        <div class="dim" style="font-size:12px;margin-top:4px">Every new estimate for this customer is created untaxed.</div>
      </div>
      <div class="field" id="exempt-id-wrap" style="${c?.tax_exempt ? '' : 'display:none'}">
        <label>Resale / exemption certificate #</label>
        <input class="input" name="tax_exempt_id" value="${esc(c?.tax_exempt_id || '')}" placeholder="Optional — kept on file for your records">
      </div>
      <div class="field"><label>Notes</label><textarea class="input" name="notes" placeholder="Sizing preferences, PO requirements, who signs off…">${esc(c?.notes || '')}</textarea></div>`,
    footer: `<button class="btn ghost" data-close>Cancel</button><button class="btn" id="save">${c ? 'Save' : 'Create Customer'}</button>`,
    onMount: (bg) => {
      // Only ask for the certificate number once the box is ticked.
      const box = $('#tax-exempt', bg)
      box.onchange = () => { $('#exempt-id-wrap', bg).style.display = box.checked ? '' : 'none' }
      onceClick($('#save', bg), c ? 'Saving…' : 'Creating…', async () => {
        const d = formData(bg)
        if (!d.name?.trim()) return toast('Name is required', true)
        d.tags = d.tags.split(',').map((s) => s.trim()).filter(Boolean)
        d.tax_exempt = box.checked ? 1 : 0
        try {
          const saved = c ? await api.put(`/api/contacts/${c.id}`, d) : await api.post('/api/contacts', d)
          closeModal()
          toast(c ? 'Customer saved' : 'Customer created')
          after?.(saved)
        } catch (e) { toast(e.message, true) }
      })
    },
  })
}

export async function contactDetailView(id) {
  const d = await api.get(`/api/contacts/${id}`)
  const c = d.contact
  setPage(c.name, `<a class="btn ghost" href="/api/contacts/${id}/statement.pdf" target="_blank">Statement</a><button class="btn ghost" id="edit">Edit</button>${d.jobs.length || d.estimates.length ? '<button class="btn ghost" id="same-again">↻ Same as last time</button>' : ''}<button class="btn" id="new-est">+ New Estimate</button><button class="btn danger" id="del-contact">Delete</button>`,
    `<a href="#/contacts">Customers</a> /`)

  const docRow = (rows, kind) => rows.length ? `<table class="tbl"><tbody>${rows.map((r) => `
    <tr class="click" data-go="/${kind}s/${r.id}">
      <td><div class="mono">${esc(r[`${kind}_number`])}</div><div class="dim" style="font-size:11.5px">${fmtDate(r.created_at)}</div></td>
      <td>${pill(r.status)}</td>
      <td class="num"><strong>${money(kind === 'estimate' ? r.total : r.amount_due)}</strong></td>
    </tr>`).join('')}</tbody></table>` : `<div class="card-b dim">No ${kind}s yet.</div>`

  $('#view').innerHTML = `<div class="cols">
    <div class="stack">
      <div class="card"><div class="card-b">
        <div class="row" style="gap:14px;margin-bottom:16px">
          <div class="avatar lg">${esc(initials(c.name))}</div>
          <div style="flex:1">
            <div style="font-size:19px;font-weight:700;letter-spacing:-.3px">${esc(c.name)}</div>
            <div class="muted">${esc(c.company || 'No company')}</div>
            <div style="margin-top:7px" class="wrap-row">${c.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
          </div>
        </div>
        <div class="grid2" style="gap:10px">
          <div><div class="lbl dim" style="font-size:10px;text-transform:uppercase;letter-spacing:.6px">Email</div>
            <div>${c.email ? `<a href="mailto:${esc(c.email)}" style="color:var(--accent)">${esc(c.email)}</a>` : '<span class="dim">—</span>'}</div></div>
          <div><div class="lbl dim" style="font-size:10px;text-transform:uppercase;letter-spacing:.6px">Phone</div>
            <div>${c.phone ? `<a href="tel:${esc(c.phone)}" style="color:var(--accent)">${esc(c.phone)}</a>` : '<span class="dim">—</span>'}</div></div>
        </div>
        ${c.notes ? `<div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--line)">
          <div class="dim" style="font-size:10px;text-transform:uppercase;letter-spacing:.6px;margin-bottom:5px">Notes</div>
          <div class="muted" style="font-size:13px;white-space:pre-wrap">${esc(c.notes)}</div></div>` : ''}
      </div></div>

      <div class="kpis" style="margin:0">
        <div class="kpi"><div class="lbl">Lifetime</div><div class="val">${money0(d.stats.lifetime)}</div></div>
        <div class="kpi ${d.stats.balance > 0 ? 'warn' : ''}"><div class="lbl">Balance</div><div class="val">${money0(d.stats.balance)}</div></div>
        <div class="kpi info"><div class="lbl">Orders</div><div class="val">${d.stats.orders}</div></div>
      </div>

      <div class="card"><div class="card-h"><h3>Jobs</h3></div>
        ${d.jobs.length ? `<table class="tbl"><tbody>${d.jobs.map((j) => `
          <tr class="click" data-go="/jobs/${j.id}">
            <td><div style="font-weight:600">${esc(j.title)}</div><div class="mono">${esc(j.job_number)}</div></td>
            <td><span class="tag">${esc(j.stage.replace('_', ' '))}</span></td>
            <td class="num dim" style="font-size:12px">${fmtDate(j.due_date)}</td>
          </tr>`).join('')}</tbody></table>` : '<div class="card-b dim">No jobs yet.</div>'}
      </div>

      <div class="card"><div class="card-h"><h3>Estimates</h3></div>${docRow(d.estimates, 'estimate')}</div>
      <div class="card"><div class="card-h"><h3>Invoices</h3></div>${docRow(d.invoices, 'invoice')}</div>
    </div>

    <div class="card">
      <div class="card-h"><h3>Activity</h3></div>
      <div class="card-b">
        <div class="row" style="margin-bottom:14px">
          <input class="input" id="note" placeholder="Log a call, a note…">
          <button class="btn ghost sm" id="add-note">Add</button>
        </div>
        ${d.activities.length ? `<div class="tl">${d.activities.map((a) => `
          <div class="tl-i ${['stage', 'note'].includes(a.type) ? 'gray' : ''}">
            <div class="tx">${esc(a.description)}</div><div class="dt">${relTime(a.created_at)}</div>
          </div>`).join('')}</div>` : '<div class="dim">No activity yet.</div>'}
      </div>
    </div>
  </div>`

  onOnce($('#view'), '[data-go]', (_e, t) => go(t.dataset.go))
  $('#edit').onclick = () => contactForm(c, () => contactDetailView(id))
  $('#new-est').onclick = () => go(`/estimates/new?contact=${id}`)
  /* DELETE /api/contacts/:id has been fully built and carefully guarded since v10 — it refuses a
   * customer with a live invoice, with a recorded payment, or with a purchase order still out, and
   * each refusal is a 409 written in words a shop owner can act on. No screen had ever called it,
   * so the cases the route exists for — a typo, a duplicate, a spam lead — could be created here
   * and removed only with an API key or sqlite3, and those three refusals had never been read by
   * anyone.
   *
   * The catch is not optional: without it a 409 throws uncaught inside confirmModal and the dialog
   * just sits there, which is the dead end the route's own wording exists to avoid. */
  $('#del-contact').onclick = () => confirmModal(`Delete ${c.name}?`,
    'Their quotes, jobs, proofs and history are deleted with them. A customer who has been invoiced or has paid cannot be deleted — you will be told what is in the way.',
    async () => {
      try {
        await api.del(`/api/contacts/${id}`)
        toast(`${c.name} deleted`)
        go('/contacts')
      } catch (ex) { toast(ex.message, true) }
    }, 'Delete')
  const again = $('#same-again')
  if (again) again.onclick = async () => {
    again.disabled = true
    try {
      const r = await api.post(`/api/contacts/${id}/reorder`)
      toast(`Drafted from ${r.from}`)
      go(`/estimates/${r.estimate_id}/edit`)
    } catch (e) { toast(e.message, true); again.disabled = false }
  }
  const addNote = async () => {
    const text = $('#note').value.trim()
    if (!text) return
    await api.post(`/api/contacts/${id}/note`, { text })
    contactDetailView(id)
  }
  $('#add-note').onclick = addNote
  $('#note').onkeydown = (e) => { if (e.key === 'Enter') addNote() }
}
