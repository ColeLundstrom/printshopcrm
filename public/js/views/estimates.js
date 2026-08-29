import { api, $, $$, el, esc, money, fmtDate, pill, setPage, empty, toast, go, on, formData, modal, closeModal, confirmModal, today , localDay, copyText } from '../core.js'
import { COMMON_SIZES, SIZES, sizeTotal, sizeSummary, lineAmount, lineQty, lineUpcharge, computeTotals, jobCost, margin, marginVerdict, guessGarmentCost, guessColors } from '../shared/pricing.js'
import { quoteModal } from './quote.js'
import { intakeModal } from './intake.js'
import { matrixPickerModal } from './matrices.js'

let listFilter = 'all'

const DECORATIONS = ['Screen Print', 'DTF Transfer', 'Embroidery', 'UV DTF', 'Vinyl', 'Patch', 'Laser', 'Promo']

export async function estimatesView() {
  setPage('Estimates', `<button class="btn" id="new">+ New Estimate</button>`)
  const render = async () => {
    const rows = await api.get(`/api/estimates?status=${listFilter}`)
    $('#list').innerHTML = rows.length ? `<table class="tbl stack">
      <thead><tr><th>Estimate</th><th>Customer</th><th>Items</th><th>Status</th><th class="num">Total</th><th class="num">Created</th></tr></thead>
      <tbody>${rows.map((e) => `<tr class="click" data-id="${e.id}">
        <td class="mono" data-label="Estimate" style="color:var(--txt)">${esc(e.estimate_number)}</td>
        <td data-label="Customer"><div style="font-weight:600">${esc(e.contact_name || '—')}</div><div class="dim" style="font-size:12px">${esc(e.company || '')}</div></td>
        <td class="muted" data-label="Items" style="font-size:12.5px">${esc(e.items[0]?.description || '—')}${e.items.length > 1 ? ` <span class="dim">+${e.items.length - 1}</span>` : ''}</td>
        <td data-label="Status">${pill(e.status)}</td>
        <td class="num" data-label="Total"><strong>${money(e.total)}</strong></td>
        <td class="num dim" data-label="Created" style="font-size:12px">${fmtDate(e.created_at)}</td>
      </tr>`).join('')}</tbody></table>`
      : empty('▤', 'No estimates', 'Quote a job and it shows up here.', '<a class="btn" href="#/autopilot">Paste a request → estimate</a>')
  }

  $('#view').innerHTML = `<div class="searchbar"><div class="tabs" id="tabs">
      ${['all', 'draft', 'sent', 'approved'].map((s) => `<button data-s="${s}" class="${listFilter === s ? 'on' : ''}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}
    </div></div><div class="card" id="list"></div>`
  // Bound once. #list only has its innerHTML replaced by render(), so binding this inside render()
  // stacked a new listener per tab switch — the same doubling bug as the customer list.
  on($('#list'), '[data-id]', (_e, t) => go(`/estimates/${t.dataset.id}`))
  on($('#tabs'), '[data-s]', (_e, t) => {
    listFilter = t.dataset.s
    $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.s === listFilter))
    render()
  })
  $('#new').onclick = () => go('/estimates/new')
  await render()
}

/* ---------- editor ---------- */

const blankItem = () => ({ description: '', detail: '', decoration: 'Screen Print', sizes: { S: 0, M: 0, L: 0, XL: 0 }, unit_price: 0, taxable: true })
const blankFee = () => ({ description: '', detail: '', qty: 1, unit_price: 0, taxable: false })
// A discount rides in unit_price as a negative credit (see posQty's note in shared/pricing.js).
// taxable:true so it reduces the taxable base, since discounting taxable goods should reduce the tax.
const blankDiscount = () => ({ description: 'Discount', detail: '', qty: 1, unit_price: 0, taxable: true })

export async function estimateEditor(id) {
  const isNew = id === 'new'
  const params = new URLSearchParams(location.hash.split('?')[1] || '')
  const { contacts } = await api.get('/api/contacts')
  const settings = (await api.get('/api/settings')).settings
  let est = isNew
    ? { contact_id: +params.get('contact') || 0, items: [blankItem()], notes: '' } // never preselect, avoids quoting the wrong customer
    : await api.get(`/api/estimates/${id}`)
  let items = est.items.length ? est.items : [blankItem()]
  const upcharges = () => { try { return JSON.parse(settings.size_upcharges) } catch { return {} } }

  setPage(isNew ? 'New Estimate' : `Edit ${est.estimate_number}`, `<button class="btn ghost" id="cancel">Cancel</button><button class="btn" id="save">${isNew ? 'Create Estimate' : 'Save'}</button>`,
    `<a href="#/estimates">Estimates</a> /`)

  $('#view').innerHTML = `<div class="card" style="max-width:1000px">
    <div class="card-b">
      <div class="grid2">
        <div class="field"><label>Customer *</label>
          <select class="input" id="contact">
            <option value="" ${!est.contact_id ? 'selected' : ''}>Choose a customer…</option>
            ${contacts.map((c) => `<option value="${c.id}" ${c.id === est.contact_id ? 'selected' : ''}>${esc(c.name)}${c.company ? `, ${esc(c.company)}` : ''}</option>`).join('')}
            <option value="__new">＋ Add a new customer…</option>
          </select>
        </div>
        <div class="field"><label>Tax rate (%)</label><input class="input" id="tax" type="number" step="0.001" value="${esc(est.tax_rate ?? settings.tax_rate)}">
          <div class="dim" id="tax-note" style="font-size:12px;margin-top:4px;display:none">Wholesale account. Sales tax off.</div>
        </div>
      </div>

      <div class="field"><label>Line items</label>
        <div class="items" id="items">
          <div class="ih"><div>Description</div><div>Detail / Decoration</div><div class="num">Qty</div><div class="num">Rate</div><div class="num">Amount</div><div></div></div>
          <div id="rows"></div>
        </div>
        <div class="wrap-row" style="margin-top:9px">
          <button class="btn ghost sm" id="add">+ Garment line</button>
          <button class="btn ghost sm" id="add-fee">+ Fee / setup line</button>
          <button class="btn ghost sm" id="add-disc">− Discount</button>
          <button class="btn ghost sm" id="add-matrix">▦ From a price matrix</button>
          <div class="sp"></div>
          <button class="btn ghost sm" id="read-email">Read from email</button>
          <button class="btn ghost sm" id="quote-calc">Price calculator</button>
        </div>
        <div class="totbox">
          <div><span>Pieces</span><span id="pcs" class="dim">0</span></div>
          <div><span>Subtotal</span><span id="sub">$0.00</span></div>
          <div><span>Tax</span><span id="taxv">$0.00</span></div>
          <div class="g"><span>Total</span><span id="tot">$0.00</span></div>
        </div>
        <div class="margin-guard" id="margin-guard" hidden></div>
      </div>

      <div class="field"><label>Notes (customer sees these)</label>
        <textarea class="input" id="notes" placeholder="Turnaround, art notes, ship-to…">${esc(est.notes || '')}</textarea></div>
    </div>
  </div>`

  const up = upcharges()

  /** Which sizes to show for a line: the common run, plus any the line already uses. */
  const sizesFor = (it) => [...new Set([...COMMON_SIZES, ...Object.keys(it.sizes || {}).filter((s) => Number(it.sizes[s]) > 0)])]
    .sort((a, b) => SIZES.indexOf(a) - SIZES.indexOf(b))

  const rowHtml = (it, i) => {
    const gridded = !!it.sizes
    const extra = lineUpcharge(it, up)
    return `<div class="ir" data-i="${i}">
      <input class="input" data-f="description" value="${esc(it.description)}" placeholder="${gridded ? 'Gildan 5000 Tee, 2 color front' : 'Screen setup, 3 screens'}">
      <input class="input" data-f="detail" value="${esc(it.detail || '')}" placeholder="${gridded ? 'Black, 2 colors front' : 'One-time charge'}">
      ${gridded
        ? `<div class="qtycell" title="Set by the size grid">${lineQty(it)}<span class="dim" style="font-size:10px"> pcs</span></div>`
        : `<input class="input num" data-f="qty" type="number" min="0" value="${esc(it.qty)}">`}
      <div class="rate-cell">
        <input class="input num" data-f="unit_price" type="number"${gridded ? ' min="0"' : ''} step="0.01" value="${esc(it.unit_price)}">
        <button class="mx-btn" data-mx="${i}" type="button" title="${it.matrix ? `Priced from ${esc(it.matrix.name)}: ${esc(it.matrix.row)} × ${esc(it.matrix.col)}. Click to change.` : 'Price this line from one of your price matrices'}" aria-label="Price from a matrix">▦</button>
      </div>
      <div class="amt">${money(lineAmount(it, up))}</div>
      <button class="del" data-del="${i}" title="Remove line" aria-label="Remove line ${i + 1}">&times;</button>
    </div>
    ${gridded ? `<div class="sizegrid" data-sg="${i}">
      ${sizesFor(it).map((s) => `<label class="sz ${Number(it.sizes[s]) > 0 ? 'on' : ''}">
        <span>${esc(s)}${up[s] ? `<em>+$${esc(up[s])}</em>` : ''}</span>
        <input type="number" min="0" data-size="${esc(s)}" data-i="${i}" value="${esc(it.sizes[s] || '')}" placeholder="0">
      </label>`).join('')}
      <button class="sz-more" data-more="${i}" title="Add another size">+</button>
      <div class="sz-sum">${lineQty(it)} pcs${extra ? ` · <span style="color:var(--amber)">+${money(extra)} size upcharges</span>` : ''}</div>
    </div>` : ''}`
  }

  const totals = () => {
    const t = computeTotals(items, +$('#tax').value || 0, up)
    $('#pcs').textContent = `${items.reduce((s, i) => s + (i.sizes ? sizeTotal(i.sizes) : 0), 0)} pcs`
    $('#sub').textContent = money(t.subtotal)
    $('#taxv').textContent = money(t.tax)
    $('#tot').textContent = money(t.total)
    marginGuard(t.subtotal)
  }

  /**
   * Live margin guard: the profit-floor check while you build the quote (Print Life's core idea).
   * Estimates the real cost of the run from the shop's costing settings and flags Strong / Tight /
   * Losing money before you send it. Uses fast client-side guesses; the ROI page is authoritative.
   */
  const marginGuard = (revenue) => {
    const g = $('#margin-guard'); if (!g) return
    let cost = 0, priced = false
    for (const it of items) {
      const qty = it.sizes ? sizeTotal(it.sizes) : Number(it.qty) || 0
      if (qty <= 0 || it.taxable === false) continue // skip setup/fee lines
      priced = true
      const colors = guessColors(`${it.description} ${it.detail || ''}`)
      cost += jobCost({
        qty, colors, garmentCost: guessGarmentCost(it.description),
        press: settings.press_type || 'auto', shopRate: Number(settings.shop_hourly_rate) || 75,
        utilization: (Number(settings.utilization_pct) || 30) / 100, spoilage: Number(settings.spoilage_pct) || 2,
        screenCost: 8, screens: colors,
      }).total
    }
    if (!priced || revenue <= 0) { g.hidden = true; return }
    const m = margin(revenue, cost)
    const v = marginVerdict(m.margin)
    const floor = Number(settings.target_margin_pct) || 45
    const below = m.margin < floor
    g.hidden = false
    g.className = `margin-guard ${v.level}${below ? ' below' : ''}`
    g.innerHTML = `<div class="mg-row"><span class="mg-label">Est. margin</span>
        <span class="mg-pct">${m.margin}%</span>
        <span class="mg-verdict">${below ? '⚠ ' : ''}${v.label}</span></div>
      <div class="mg-sub">~${money(m.profit)} profit on ~${money(cost)} cost${below ? ` · under your ${floor}% floor` : ''}. Confirm real blank cost on the job for exact numbers.</div>`
  }

  const draw = () => {
    $('#rows').innerHTML = items.map(rowHtml).join('')
    totals()
  }

  // Wholesale accounts are tax exempt. Picking one zeroes the rate and says why, so nobody has to
  // remember; it stays editable in case a particular order really is taxable.
  // `userPicked` only: opening a NEW estimate from a wholesale customer's own page preselects the
  // contact without a pick, so the note said "Sales tax off" above a field still holding the
  // shop's 7.75% — and the save always sends that field. Zero it whenever the buyer is exempt and
  // the estimate carries no deliberately-stored rate of its own.
  const syncTaxExempt = (userPicked) => {
    const c = contacts.find((x) => x.id === +$('#contact').value)
    const exempt = !!(c && c.tax_exempt)
    $('#tax-note').style.display = exempt ? '' : 'none'
    if (exempt && (userPicked || est.tax_rate == null)) $('#tax').value = 0
    else if (!exempt && userPicked) $('#tax').value = settings.tax_rate
    totals()
  }
  /** Is the buyer on screen tax exempt right now? Used to mark a deliberate override on save. */
  const buyerIsExempt = () => !!contacts.find((x) => x.id === +$('#contact').value)?.tax_exempt
  // Quote-first onboarding: a brand-new shop's first move is often a quote, before any customer
  // exists. Rather than bounce them to Customers and lose the estimate, add one inline right here.
  const addCustomerInline = () => {
    const prev = est.contact_id ? String(est.contact_id) : ''
    $('#contact').value = prev // don't leave the "+ Add…" row selected while the dialog is open
    syncTaxExempt(false)
    modal({
      title: 'New customer',
      body: `<div class="field"><label>Name *</label><input class="input" id="nc-name" placeholder="Jamie Rivera"></div>
        <div class="grid2"><div class="field"><label>Company</label><input class="input" id="nc-company" placeholder="Lakeside High School"></div>
        <div class="field"><label>Email</label><input class="input" id="nc-email" type="email" placeholder="jamie@example.com"></div></div>
        <div class="dim" id="nc-err" role="alert" style="color:var(--red);font-size:12px;display:none;margin-top:6px"></div>`,
      footer: `<button class="btn ghost" data-close>Cancel</button><button class="btn" id="nc-save">Create &amp; use</button>`,
      onMount: (bg) => {
        // role="alert" on the div gets it read out; aria-invalid + aria-describedby tie it to the
        // field, so a screen reader that lands on the input hears WHY it was refused. There was no
        // aria-invalid or aria-describedby anywhere in public/ before this.
        const err = (m, field = '#nc-name') => {
          const e = $('#nc-err', bg); e.textContent = m; e.style.display = ''
          const f = $(field, bg)
          if (f) { f.setAttribute('aria-invalid', 'true'); f.setAttribute('aria-describedby', 'nc-err'); f.focus() }
        }
        $('#nc-save', bg).addEventListener('click', async () => {
          $('#nc-name', bg).removeAttribute('aria-invalid')
          const name = $('#nc-name', bg).value.trim()
          if (!name) return err('A customer name is required.')
          try {
            const c = await api.post('/api/contacts', { name, company: $('#nc-company', bg).value.trim(), email: $('#nc-email', bg).value.trim() })
            contacts.push(c)
            const opt = document.createElement('option')
            opt.value = String(c.id); opt.textContent = c.name + (c.company ? `, ${c.company}` : '')
            const sel = $('#contact'); sel.insertBefore(opt, sel.querySelector('option[value="__new"]'))
            sel.value = String(c.id); est.contact_id = c.id
            closeModal(); syncTaxExempt(true); toast(`Added ${c.name}`)
          } catch (e) { err(e.message || 'Could not create the customer. Try again.') }
        })
      },
    })
  }
  $('#contact').addEventListener('change', () => { if ($('#contact').value === '__new') addCustomerInline(); else syncTaxExempt(true) })
  syncTaxExempt(false)

  // Text/price edits patch in place, since redrawing would blur the field mid-type.
  on($('#rows'), '[data-f]', (e, t) => {
    const i = +t.closest('[data-i]').dataset.i
    const f = t.dataset.f
    items[i][f] = f === 'qty' || f === 'unit_price' ? +t.value : t.value
    t.closest('.ir').querySelector('.amt').textContent = money(lineAmount(items[i], up))
    totals()
  }, 'input')

  on($('#rows'), '[data-size]', (_e, t) => {
    const i = +t.dataset.i
    const n = Math.max(0, +t.value || 0)
    items[i].sizes = { ...items[i].sizes, [t.dataset.size]: n }
    t.closest('.sz').classList.toggle('on', n > 0)
    const row = $(`.ir[data-i="${i}"]`)
    row.querySelector('.qtycell').innerHTML = `${lineQty(items[i])}<span class="dim" style="font-size:10px"> pcs</span>`
    row.querySelector('.amt').textContent = money(lineAmount(items[i], up))
    const extra = lineUpcharge(items[i], up)
    t.closest('.sizegrid').querySelector('.sz-sum').innerHTML = `${lineQty(items[i])} pcs${extra ? ` · <span style="color:var(--amber)">+${money(extra)} size upcharges</span>` : ''}`
    totals()
  }, 'input')

  on($('#rows'), '[data-more]', (_e, t) => {
    const i = +t.dataset.more
    const shown = sizesFor(items[i])
    const next = SIZES.find((s) => !shown.includes(s))
    if (!next) return toast('Every size is already on this line')
    items[i].sizes = { ...items[i].sizes, [next]: 0 }
    draw()
  })

  on($('#rows'), '[data-del]', (_e, t) => {
    items.splice(+t.dataset.del, 1)
    if (!items.length) items.push(blankItem())
    draw()
  })

  /**
   * Price a line from one of the shop's own matrices. Every line can use a DIFFERENT matrix, which
   * is what makes a mixed quote work: screen printing on the tees, embroidery on the caps, and the
   * shop's mug sheet for the giveaway mugs, all on one estimate.
   *
   * `i` names an existing line to fill in; omit it to add a new line. The matrix, row and column
   * are stored on the item so the quote can say where the number came from — and so a shop can
   * find every quote priced off a sheet it later changed.
   */
  const priceFromMatrix = (i) => {
    const target = i === undefined ? null : items[i]
    matrixPickerModal({
      qty: target ? lineQty(target) || Number(target.qty) || 0 : 0,
      onPick: (pick) => {
        if (target) {
          target.unit_price = pick.price
          if (!target.description.trim()) target.description = pick.description
          target.detail = pick.detail
          target.matrix = pick.matrix
          // The decoration field is a screen-printing-era default. A line priced off the shop's own
          // sheet says what it is in the matrix headings; leaving "Screen Print" on a mug line lies.
          target.decoration = ''
          // A flat charge is a fee line by definition: it must not multiply by a size grid.
          if (pick.unit === 'flat' && target.sizes) { delete target.sizes; target.qty = 1; target.taxable = false }
        } else {
          items.push(pick.unit === 'flat'
            ? { ...blankFee(), description: pick.description, detail: pick.detail, qty: 1, unit_price: pick.price, matrix: pick.matrix }
            : { ...blankItem(), decoration: '', description: pick.description, detail: pick.detail, unit_price: pick.price, matrix: pick.matrix })
        }
        draw()
        toast(`Priced from ${pick.matrix.name}`)
      },
    })
  }
  on($('#rows'), '[data-mx]', (_e, t) => priceFromMatrix(+t.dataset.mx))

  const addLine = (mk) => { items.push(mk()); draw(); $$('#rows .ir').pop().querySelector('input').focus() }
  $('#add').onclick = () => addLine(blankItem)
  $('#add-fee').onclick = () => addLine(blankFee)
  $('#add-disc').onclick = () => addLine(blankDiscount)
  $('#add-matrix').onclick = () => priceFromMatrix()
  $('#quote-calc').onclick = () => quoteModal(settings, (line) => { items.push(line); draw() })
  $('#read-email').onclick = () => intakeModal((line, parsed) => {
    // First read replaces the empty starter row rather than sitting under it.
    if (items.length === 1 && !items[0].description && !items[0].unit_price) items = []
    items.push(line)
    if (parsed?.notes && !$('#notes').value) $('#notes').value = parsed.notes
    draw()
  })
  $('#tax').oninput = totals
  $('#cancel').onclick = () => go(isNew ? '/estimates' : `/estimates/${id}`)
  $('#save').onclick = async () => {
    const payload = {
      contact_id: +$('#contact').value,
      items: items.filter((i) => i.description.trim() || i.unit_price),
      notes: $('#notes').value,
      tax_rate: +$('#tax').value,
      // The server refuses to tax an exempt buyer unless told the shop meant it. Typing a rate
      // ON an exempt customer is the shop saying so; carrying the default is not.
      tax_exempt_override: buyerIsExempt() && +$('#tax').value > 0,
    }
    if (!payload.contact_id) return toast('Choose a customer for this estimate first', true)
    if (!payload.items.length) return toast('Add at least one line item', true)
    // Saving a NEW estimate is a create: two clicks made two estimates, with two estimate numbers,
    // and the shop then has to work out which one the customer was sent.
    const btn = $('#save'); btn.disabled = true; btn.textContent = 'Saving…'
    try {
      const saved = isNew ? await api.post('/api/estimates', payload) : await api.put(`/api/estimates/${id}`, payload)
      toast(isNew ? `Estimate ${saved.estimate_number} created` : 'Estimate saved')
      go(`/estimates/${saved.id}`)
    } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = isNew ? 'Create Estimate' : 'Save' }
  }
  draw()
}

/* ---------- detail ---------- */

/** Status → how the mockup row reads to the shop. */
const MOCKUP_PILL = {
  draft: ['gray', 'not sent'], sent: ['amber', 'waiting on customer'],
  approved: ['green', 'approved'], rejected: ['red', 'changes requested'],
}

/**
 * Artwork / mockup approval on the quote. Lite has no job board, so this is where a shop attaches
 * what the customer is going to see printed, sends it for a written approval, and gets the answer
 * on the record before burning a screen.
 */
function mockupCard(mockups) {
  const row = (m) => {
    const [tone, label] = MOCKUP_PILL[m.status] || ['gray', m.status]
    const img = (m.mime || '').startsWith('image/')
    return `<div class="mk" data-mk="${m.id}">
      <div class="mk-thumb">${img ? `<img src="${esc(m.url)}" alt="">` : '<span>▤</span>'}</div>
      <div class="mk-body">
        <div class="row" style="gap:7px;align-items:center">
          <strong style="font-size:13px">v${m.version}</strong><span class="pill ${tone}">${esc(label)}</span>
        </div>
        <div class="dim" style="font-size:11.5px;margin-top:3px">${esc(m.original_name || '')}</div>
        ${m.notes && m.status === 'rejected' ? `<div class="mk-note">"${esc(m.notes)}"</div>` : ''}
        ${m.decided_by && m.decided_at ? `<div class="dim" style="font-size:11px;margin-top:3px">${esc(m.status)} by ${esc(m.decided_by)} · ${fmtDate(m.decided_at)}</div>` : ''}
      </div>
      <div class="mk-act">
        <button class="btn ghost sm" data-mksend="${m.id}">${m.status === 'draft' ? 'Send for approval' : 'Resend'}</button>
        <button class="btn ghost sm" data-mkcopy="${m.id}" data-url="${esc(m.share_url)}">Copy link</button>
        ${m.status === 'draft' || m.status === 'rejected' ? `<button class="btn ghost sm" data-mkdel="${m.id}" style="color:var(--red)">Delete</button>` : ''}
      </div>
    </div>`
  }
  return `<div class="card"><div class="card-h"><h3>Artwork &amp; Mockups</h3>
      ${mockups.length ? `<span class="pill ${(MOCKUP_PILL[mockups[0].status] || ['gray'])[0]}">${esc((MOCKUP_PILL[mockups[0].status] || ['', mockups[0].status])[1])}</span>` : ''}
      <div class="spacer"></div><button class="btn ghost sm" id="mk-add">+ Add mockup</button></div>
    <div class="card-b">
      <input type="file" id="mk-file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,application/pdf" hidden>
      ${mockups.length
        ? `<div class="mk-list">${mockups.map(row).join('')}</div>`
        : `<p class="dim" style="font-size:12.5px;margin:0;line-height:1.6">Attach the mockup your customer should sign off on. They get a link, they approve or ask for changes in writing, and the answer lands here, so nothing goes to press on a verbal maybe.</p>`}
    </div></div>`
}

export async function estimateDetailView(id) {
  const [e, cfg] = await Promise.all([api.get(`/api/estimates/${id}`), api.get('/api/settings')])
  // 402 = the shop's plan doesn't include artwork approval; treat as "no card" rather than an error.
  const mockups = await api.get(`/api/estimates/${id}/mockups`).catch(() => null)
  const up = (() => { try { return JSON.parse(cfg.settings.size_upcharges) } catch { return {} } })()
  const canConvert = e.status === 'approved' && !e.invoice
  const pieces = e.items.reduce((s, i) => s + (i.sizes ? sizeTotal(i.sizes) : 0), 0)

  setPage(e.estimate_number, `
    ${e.status !== 'approved' ? `<button class="btn ghost" id="edit">Edit</button>` : ''}
    ${e.status === 'draft' || e.status === 'sent' ? `<button class="btn ghost" id="send">${e.status === 'sent' ? 'Resend' : 'Send to Customer'}</button>` : ''}
    ${e.status === 'sent' ? `<button class="btn ghost" id="approve">Mark Approved</button>` : ''}
    ${canConvert ? `<button class="btn" id="convert">${window.__EDITION === 'lite' ? 'Convert to Invoice' : 'Convert to Invoice + Job'}</button>` : ''}
    ${e.invoice ? `<a class="btn ghost" href="#/invoices/${e.invoice.id}">View Invoice</a>` : ''}
    ${(e.voided_invoices || []).map((v) => `<a class="btn ghost" href="#/invoices/${v.id}" title="${esc(v.void_reason || 'cancelled')}">${esc(v.invoice_number)} · voided</a>`).join('')}
    <button class="btn ghost" id="dup">Duplicate</button>
    <a class="btn ghost" href="/api/estimates/${id}/pdf" target="_blank">PDF</a>`,
    `<a href="#/estimates">Estimates</a> /`)

  $('#view').innerHTML = `<div class="cols">
    <div class="card">
      <div class="card-h">
        <h3>${esc(e.estimate_number)}</h3>${pill(e.status)}<div class="spacer"></div>
        <a class="dim" href="#/contacts/${e.contact_id}" style="font-size:13px">${esc(e.contact_name || '')} →</a>
      </div>
      <table class="tbl">
        <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
        <tbody>${e.items.map((i) => {
          const extra = lineUpcharge(i, up)
          return `<tr>
          <td><div style="font-weight:600">${esc(i.description)}</div>
            <div class="dim" style="font-size:12px">${esc([i.detail, i.decoration].filter(Boolean).join(' · '))}</div>
            ${i.sizes ? `<div class="sizetags">${sizeSummary(i.sizes).split(' / ').map((s) => `<span class="tag">${esc(s)}</span>`).join('')}</div>` : ''}</td>
          <td class="num">${lineQty(i)}</td><td class="num">${money(i.unit_price)}${extra ? `<div class="dim" style="font-size:10.5px">+${money(extra)} sizes</div>` : ''}${
            // Where the number came from — internal provenance, so a shop can trace a price back
            // to the sheet that produced it. Not part of what the customer receives.
            i.matrix ? `<div class="dim" style="font-size:10.5px" title="Priced from your ${esc(i.matrix.name)} matrix">▦ ${esc(i.matrix.name)}</div>` : ''}</td>
          <td class="num"><strong>${money(lineAmount(i, up))}</strong></td>
        </tr>`}).join('')}</tbody>
      </table>
      <div class="card-b">
        <div class="totbox" style="margin-top:0">
          ${pieces ? `<div><span>Pieces</span><span>${pieces}</span></div>` : ''}
          <div><span>Subtotal</span><span>${money(e.subtotal)}</span></div>
          <div><span>Tax</span><span>${money(e.tax)}</span></div>
          <div class="g"><span>Total</span><span>${money(e.total)}</span></div>
        </div>
        ${e.notes ? `<div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--line)">
          <div class="dim" style="font-size:10px;text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px">Notes</div>
          <div class="muted" style="font-size:13px;white-space:pre-wrap">${esc(e.notes)}</div></div>` : ''}
      </div>
    </div>

    <div class="stack">
      <div class="card"><div class="card-h"><h3>Status</h3></div><div class="card-b">
        <div class="tl">
          <div class="tl-i"><div class="tx">Created</div><div class="dt">${fmtDate(e.created_at)}</div></div>
          <div class="tl-i ${e.sent_at ? '' : 'gray'}"><div class="tx">${e.sent_at ? 'Sent to customer' : 'Not sent yet'}</div><div class="dt">${e.sent_at ? fmtDate(e.sent_at) : '—'}</div></div>
          <div class="tl-i ${e.approved_at ? '' : 'gray'}"><div class="tx">${e.approved_at ? 'Approved' : 'Awaiting approval'}</div><div class="dt">${e.approved_at ? fmtDate(e.approved_at) : '—'}</div></div>
          <div class="tl-i ${e.invoice ? '' : 'gray'}"><div class="tx">${e.invoice ? `Invoiced — ${esc(e.invoice.invoice_number)}` : 'Not invoiced'}</div><div class="dt">${e.invoice ? fmtDate(e.invoice.created_at) : '—'}</div></div>
        </div>
      </div></div>

      ${mockups ? mockupCard(mockups) : ''}

      <div class="card"><div class="card-h"><h3>Customer Link</h3></div><div class="card-b">
        <p class="dim" style="font-size:12.5px;margin-bottom:9px">Customers approve here. No login, no account.</p>
        <div class="copy" id="share" aria-label="Copy the customer approval link">${esc(location.origin + e.share_url)}</div>
        <div class="row" style="margin-top:10px">
          <a class="btn ghost sm" href="${esc(e.share_url)}" target="_blank">Open customer view</a>
          ${e.status !== 'approved' ? `<button class="btn danger sm" id="del">Delete</button>` : ''}
        </div>
      </div></div>
    </div>
  </div>`

  $('#share').onclick = () => copyText(location.origin + e.share_url, 'Link copied')

  // Mockups. Bound to the card this render created, not #view, so revisiting can't stack handlers.
  if (mockups) {
    $('#mk-add').onclick = () => $('#mk-file').click()
    $('#mk-file').onchange = async () => {
      const file = $('#mk-file').files[0]
      if (!file) return
      const btn = $('#mk-add'); btn.disabled = true; btn.textContent = 'Uploading…'
      try {
        const fd = new FormData(); fd.append('file', file)
        const r = await fetch(`/api/estimates/${id}/mockups`, { method: 'POST', body: fd })
        const d = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(d.error || 'Upload failed')
        toast(`Mockup v${d.version} added`)
        estimateDetailView(id)
      } catch (ex) { toast(ex.message, true); btn.disabled = false; btn.textContent = '+ Add mockup' }
    }
    const list = $('.mk-list', $('#view'))
    if (list) {
      on(list, '[data-mksend]', async (_ev, t) => {
        t.disabled = true; t.textContent = 'Sending…'
        try {
          const r = await api.post(`/api/mockups/${t.dataset.mksend}/send`, {})
          toast(r.email_live && r.emailed_to ? `Sent to ${r.emailed_to}` : 'Marked sent. Copy the link and send it yourself')
          estimateDetailView(id)
        } catch (ex) { toast(ex.message, true); t.disabled = false; t.textContent = 'Send for approval' }
      })
      on(list, '[data-mkcopy]', (_ev, t) => copyText(location.origin + t.dataset.url, 'Approval link copied'))
      on(list, '[data-mkdel]', (_ev, t) => confirmModal('Delete this mockup?', 'The customer will no longer be able to open its approval link.', async () => {
        try { await api.del(`/api/mockups/${t.dataset.mkdel}`); toast('Deleted'); estimateDetailView(id) }
        catch (ex) { toast(ex.message, true) }
      }, 'Delete'))
    }
  }
  $('#edit')?.addEventListener('click', () => go(`/estimates/${id}/edit`))
  $('#send')?.addEventListener('click', async () => {
    const r = await api.post(`/api/estimates/${id}/send`)
    // Tell the truth: with no email connected, nothing was sent, so the shop hands over the link.
    toast(r.email_live && r.emailed_to ? `Emailed to ${r.emailed_to}` : 'Marked sent. No email connected yet, copy the customer link to send it')
    estimateDetailView(id)
  })
  $('#approve')?.addEventListener('click', async () => {
    await api.post(`/api/estimates/${id}/approve`)
    toast('Marked approved')
    estimateDetailView(id)
  })
  $('#convert')?.addEventListener('click', () => convertModal(e))
  // Re-quote a repeat job: same lines, same size grid, fresh draft number.
  $('#dup')?.addEventListener('click', async () => {
    const btn = $('#dup'); btn.disabled = true; btn.textContent = 'Copying…'
    try {
      const r = await api.post(`/api/estimates/${id}/duplicate`, {})
      toast(`Created ${r.estimate_number}`)
      go(`/estimates/${r.id}/edit`)
    } catch (ex) { toast(ex.message, true); btn.disabled = false; btn.textContent = 'Duplicate' }
  })
  $('#del')?.addEventListener('click', () => confirmModal('Delete estimate?', `${e.estimate_number} will be permanently removed.`, async () => {
    await api.del(`/api/estimates/${id}`)
    toast('Estimate deleted')
    go('/estimates')
  }))
}

function convertModal(e) {
  // localDay, not toISOString: this date is POSTed and stored verbatim on invoices.due_date and
  // jobs.due_date, so a UTC roll after 5pm Pacific dated every invoice a day early.
  const d14 = new Date(); d14.setDate(d14.getDate() + 14)
  const due = localDay(d14)
  // Lite has no production floor. The server still opens a job row (it links the records together),
  // but the shop must never be told about it or — worse — navigated onto the Job Board, which is not
  // in this edition's nav at all. That dead end was the single most jarring thing in the lite flow.
  const lite = window.__EDITION === 'lite'
  modal({
    title: lite ? 'Convert to Invoice' : 'Convert to Invoice + Job',
    body: `<p class="muted" style="margin-bottom:15px;line-height:1.6">${lite
        ? `This creates an invoice for <strong>${money(e.total)}</strong> linked to this estimate, ready to send and take payment on.`
        : `This creates invoice for <strong>${money(e.total)}</strong>, opens a production job on the board, and links all three together.`}</p>
      <div class="field"><label>${lite ? 'Order name' : 'Job title'}</label><input class="input" name="title" value="${esc(e.items[0]?.description || 'Custom order')}"></div>
      <div class="field"><label>${lite ? 'Payment due' : 'Due date'}</label><input class="input" name="due_date" type="date" value="${due}"></div>`,
    footer: `<button class="btn ghost" data-close>Cancel</button><button class="btn" id="go">${lite ? 'Create Invoice' : 'Create Invoice + Job'}</button>`,
    onMount: (bg) => {
      $('#go', bg).onclick = async () => {
        const btn = $('#go', bg); btn.disabled = true; btn.textContent = 'Creating…'
        try {
          const r = await api.post(`/api/estimates/${e.id}/convert`, formData(bg))
          closeModal()
          // Autopilot and the Slack quick-quote open the job when they write the quote, so convert
          // adopts it rather than opening a second card for one order. Say which happened.
          toast(lite ? `Created ${r.invoice_number}`
            : r.job_reused ? `Created ${r.invoice_number} — linked to ${r.job_number}, already on the board`
              : `Created ${r.invoice_number} and ${r.job_number}`)
          go(lite ? `/invoices/${r.invoice_id}` : `/jobs/${r.job_id}`)
        } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = lite ? 'Create Invoice' : 'Create Invoice + Job' }
      }
    },
  })
}
