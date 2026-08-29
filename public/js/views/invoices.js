import { api, $, $$, esc, money, money0, fmtDate, pill, setPage, empty, toast, go, on, onOnce, modal, closeModal, confirmModal, formData, daysOut } from '../core.js'
import { lineQty, lineAmount, lineUpcharge, sizeTotal, sizeSummary } from '../shared/pricing.js'

let filter = 'all'

export async function invoicesView() {
  setPage('Invoices')
  const render = async () => {
    const rows = await api.get(`/api/invoices?status=${filter}`)
    // A voided invoice is a cancelled demand, not money owed — and the void dialog's own copy
    // promises "it stops counting toward money owed". Every balance query on the server was
    // taught that; this one client-side sum was missed, so the list header read $14,154.10 over
    // a dashboard reading $11,568.10 — the difference being exactly one voided invoice — and the
    // Void tab cheerfully totalled "$2,586 outstanding" above a list of nothing but voids.
    const owes = (r) => r.status !== 'paid' && r.status !== 'void'
    const totalOpen = rows.filter(owes).reduce((s, r) => s + r.amount_due - r.amount_paid, 0)
    $('#sum').innerHTML = rows.length ? `<span class="dim">${rows.length} invoice${rows.length > 1 ? 's' : ''} · <strong style="color:var(--amber)">${money0(totalOpen)}</strong> outstanding</span>` : ''
    $('#list').innerHTML = rows.length ? `<table class="tbl stack">
      <thead><tr><th>Invoice</th><th>Customer</th><th>Status</th><th class="num">Total</th><th class="num">Paid</th><th class="num">Balance</th><th class="num">Due</th></tr></thead>
      <tbody>${rows.map((i) => {
        // Same rule per row: a cancelled invoice is not owing and cannot be late.
        const bal = i.status === 'void' ? 0 : i.amount_due - i.amount_paid
        const late = owes(i) && daysOut(i.due_date) < 0
        return `<tr class="click" data-id="${i.id}">
          <td class="mono" data-label="Invoice" style="color:var(--txt)">${esc(i.invoice_number)}</td>
          <td data-label="Customer"><div style="font-weight:600">${esc(i.contact_name || '—')}</div><div class="dim" style="font-size:12px">${esc(i.company || '')}</div></td>
          <td data-label="Status">${pill(late ? 'overdue' : i.status)}</td>
          <td class="num" data-label="Total">${money(i.amount_due)}</td>
          <td class="num muted" data-label="Paid">${money(i.amount_paid)}</td>
          <td class="num" data-label="Balance"><strong style="${bal > 0 ? 'color:var(--amber)' : 'color:var(--txt-3)'}">${money(bal)}</strong></td>
          <td class="num" data-label="Due" style="font-size:12px"><span class="${late ? '' : 'dim'}" style="${late ? 'color:var(--red);font-weight:600' : ''}">${fmtDate(i.due_date)}</span></td>
        </tr>`
      }).join('')}</tbody></table>` : empty('▣', 'No invoices', 'Approve an estimate and convert it to create one.', '<a class="btn" href="#/estimates">Go to estimates</a>')
  }

  $('#view').innerHTML = `<div class="searchbar">
      <div class="tabs" id="tabs">${['all', 'unpaid', 'overdue', 'partial', 'paid', 'void'].map((s) => `<button data-s="${s}" class="${filter === s ? 'on' : ''}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}</div>
      <div class="sp"></div><div id="sum" style="align-self:center"></div>
    </div><div class="card" id="list"></div>`
  // #list is created ONCE per visit and only its innerHTML is repainted, so this binding used to
  // sit inside render() and stacked one more listener on every tab switch: by the sixth tab a
  // single click on a row ran go() six times. onOnce is keyed on (root, event, selector).
  onOnce($('#list'), '[data-id]', (_e, t) => go(`/invoices/${t.dataset.id}`))
  on($('#tabs'), '[data-s]', (_e, t) => {
    filter = t.dataset.s
    $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.s === filter))
    render()
  })
  await render()
}

export async function invoiceDetailView(id) {
  // The shop's size-upcharge map, same as estimateDetailView. Garment lines price off a size grid,
  // so without it this screen showed $0.00 per line above a correct invoice total.
  const [i, cfg] = await Promise.all([api.get(`/api/invoices/${id}`), api.get('/api/settings')])
  const up = (() => { try { return JSON.parse(cfg.settings.size_upcharges) } catch { return {} } })()
  const bal = i.amount_due - i.amount_paid
  const pct = i.amount_due ? Math.min(100, (i.amount_paid / i.amount_due) * 100) : 0
  // Only break the total out when subtotal + tax genuinely reconciles to what the invoice asks for.
  // An imported invoice, or one raised with no estimate behind it, has no breakdown to show — and a
  // breakdown that does not add up is worse than none.
  const reconciles = i.subtotal != null
    && Math.abs(Math.round((Number(i.subtotal) + (Number(i.tax) || 0)) * 100) / 100 - (Number(i.amount_due) || 0)) <= 0.005

  // A voided invoice is a cancelled demand. `bal > 0` is true of one — the balance is still on the
  // row, it just is not owed — so this screen went on offering Request Payment and Email Invoice,
  // and the server built a live pay link and mailed the customer a demand for money the shop had
  // already withdrawn. The list's own balance expression got this right; the detail screen's did not.
  const chaseable = bal > 0 && i.status !== 'void'
  setPage(i.invoice_number, `
    ${chaseable ? `<button class="btn" id="reqpay">Request Payment</button>` : ''}
    ${chaseable ? `<button class="btn ghost" id="pay">Record Payment</button>` : ''}
    ${i.status === 'void' ? '' : '<button class="btn ghost" id="send">Email Invoice</button>'}
    <a class="btn ghost" href="/api/invoices/${id}/pdf" target="_blank">PDF</a>
    ${i.status === 'void' ? '' : `<button class="btn ghost" id="void">Void</button>`}`,
    `<a href="#/invoices">Invoices</a> /`)

  $('#view').innerHTML = `<div class="cols">
    <div class="card">
      <div class="card-h"><h3>${esc(i.invoice_number)}</h3>${pill(i.status)}<div class="spacer"></div>
        <a class="dim" href="#/contacts/${i.contact_id}" style="font-size:13px">${esc(i.contact_name || '')} →</a></div>
      ${i.items.length ? `<table class="tbl">
        <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
        <tbody>${i.items.map((it) => {
          const extra = lineUpcharge(it, up)
          return `<tr>
          <td><div style="font-weight:600">${esc(it.description)}</div><div class="dim" style="font-size:12px">${esc(it.detail || '')}</div>
            ${it.sizes && sizeTotal(it.sizes) > 0 ? `<div class="dim" style="font-size:12px">${esc(sizeSummary(it.sizes))}</div>` : ''}</td>
          <td class="num">${lineQty(it) || ''}</td><td class="num">${money(it.unit_price)}${extra ? `<div class="dim" style="font-size:10.5px">+${money(extra)} sizes</div>` : ''}</td>
          <td class="num"><strong>${money(lineAmount(it, up))}</strong></td></tr>`
        }).join('')}</tbody></table>` : ''}
      <div class="card-b">
        <div class="totbox" style="margin-top:0">
          ${reconciles ? `<div><span>Subtotal</span><span>${money(i.subtotal)}</span></div>
          <div><span>Tax${i.tax_rate ? ` (${i.tax_rate}%)` : ''}</span><span>${money(i.tax)}</span></div>` : ''}
          <div><span>Invoice total</span><span>${money(i.amount_due)}</span></div>
          <div><span>Paid to date</span><span style="color:var(--accent)">-${money(i.amount_paid)}</span></div>
          <div class="g"><span>Balance due</span><span style="${bal > 0 ? 'color:var(--amber)' : 'color:var(--accent)'}">${money(bal)}</span></div>
        </div>
      </div>
    </div>

    <div class="stack">
      <div class="card"><div class="card-b">
        <div class="row" style="justify-content:space-between;margin-bottom:8px">
          <span class="dim" style="font-size:11px;text-transform:uppercase;letter-spacing:.6px">Collected</span>
          <strong>${Math.round(pct)}%</strong>
        </div>
        <div style="height:7px;background:var(--bg);border-radius:5px;overflow:hidden">
          <div style="height:100%;width:${pct}%;background:var(--accent);border-radius:5px;transition:.3s"></div>
        </div>
        <div class="row" style="margin-top:12px;justify-content:space-between;font-size:12.5px">
          <span class="dim">Due ${fmtDate(i.due_date)}${i.po_number ? ` · PO ${esc(i.po_number)}` : ''}</span>
          ${bal > 0 && daysOut(i.due_date) < 0 ? `<span style="color:var(--red);font-weight:600">${Math.abs(daysOut(i.due_date))} days late</span>` : ''}
        </div>
        ${bal > 0 ? '<div class="row" style="margin-top:10px"><button class="btn ghost sm" id="terms">Change due date / PO</button></div>' : ''}
      </div></div>

      <div class="card" id="pay-list">
        <div class="card-h"><h3>Payments</h3><div class="spacer"></div>${bal > 0 ? `<button class="btn ghost sm" id="pay2">+ Add</button>` : ''}</div>
        ${i.payments.length ? `<table class="tbl"><tbody>${i.payments.map((p) => `<tr>
          <td><strong>${money(p.amount)}</strong><div class="dim" style="font-size:11.5px">${esc(p.method)}${p.note ? ` · ${esc(p.note)}` : ''}</div></td>
          <td class="num dim" style="font-size:12px">${fmtDate(p.created_at)}</td>
          <td class="num" style="width:34px"><button class="del btn danger sm" data-del-payment="${p.id}">&times;</button></td>
        </tr>`).join('')}</tbody></table>` : '<div class="card-b dim">No payments recorded.</div>'}
      </div>

      ${bal > 0 ? `<div class="card"><div class="card-b">
        <div class="row" style="justify-content:space-between;margin-bottom:6px"><span class="dim" style="font-size:11px;text-transform:uppercase;letter-spacing:.6px">Online payment</span>
          <span class="pill ${i.stripe_ready ? 'green' : 'gray'}" style="font-size:9.5px">${i.stripe_ready ? 'Stripe on' : 'add Stripe'}</span></div>
        <p class="dim" style="font-size:12px;line-height:1.55;margin-bottom:8px">${i.stripe_ready ? 'The customer pays a 50% deposit or the balance on your own Stripe. Money lands in your account, recorded here automatically.' : 'Add your Stripe key in Settings to collect deposits and balances online.'}</p>
        <div class="row" style="gap:8px">
          <button class="btn ghost sm" id="copylink">Copy pay link</button>
          <a class="btn ghost sm" href="${esc(i.pay_link)}" target="_blank">Preview ↗</a>
        </div></div></div>` : ''}

      ${i.estimate_id ? `<div class="card"><div class="card-b">
        <a class="row" href="#/estimates/${i.estimate_id}" style="justify-content:space-between">
          <span class="muted" style="font-size:13px">From estimate</span><span class="mono" style="color:var(--accent)">${esc(i.estimate_number || '')} →</span>
        </a></div></div>` : ''}
    </div>
  </div>`

  const openPay = () => modal({
    title: 'Record Payment',
    body: `<div class="field"><label>Amount</label><input class="input" name="amount" type="number" step="0.01" value="${bal.toFixed(2)}"></div>
      <div class="field"><label>Method</label><select class="input" name="method">
        ${['card', 'check', 'cash', 'ach', 'other'].map((m) => `<option>${m}</option>`).join('')}</select></div>
      <div class="field"><label>Note</label><input class="input" name="note" placeholder="Check #1042, deposit, etc."></div>
      <p class="dim" style="font-size:12px">Balance due is ${money(bal)}. Partial payments are fine. The invoice flips to <em>partial</em>.</p>`,
    footer: `<button class="btn ghost" data-close>Cancel</button><button class="btn" id="go">Record Payment</button>`,
    onMount: (bg) => {
      // In-flight guard, the same one the Terms dialog below has always had. Without it the button
      // stayed live and the dialog stayed open for the whole round trip, so on shop wifi a second
      // impatient click posted the payment again. A full-balance double-click is caught by the
      // server (the second one is over the remaining balance) — a PARTIAL payment is not: $500
      // twice on a $1,000 invoice records $1,000, flips the invoice to paid, and the shop believes
      // it collected money it never got.
      $('#go', bg).onclick = async () => {
        const btn = $('#go', bg); btn.disabled = true; btn.textContent = 'Recording…'
        try {
          await api.post(`/api/invoices/${id}/payments`, formData(bg))
          closeModal()
          toast('Payment recorded')
          invoiceDetailView(id)
        } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = 'Record Payment' }
      }
    },
  })

  $('#pay')?.addEventListener('click', openPay)
  $('#pay2')?.addEventListener('click', openPay)

  // Amend terms. Only the due date and the customer's PO. The amount is owned by the estimate's
  // line items, so it stays read-only here rather than letting the two documents disagree.
  $('#terms')?.addEventListener('click', () => modal({
    title: `Terms for ${i.invoice_number}`,
    body: `<div class="field"><label>Payment due</label><input class="input" name="due_date" type="date" value="${esc(i.due_date || '')}"></div>
      <div class="field" style="margin-top:10px"><label>Customer PO number (optional)</label>
        <input class="input" name="po_number" value="${esc(i.po_number || '')}" placeholder="e.g. 4501-22"></div>
      <div class="dim" style="font-size:11.5px;margin-top:8px;line-height:1.6">The PO shows on the invoice your customer sees. Changing the due date also re-checks whether this invoice counts as overdue.</div>`,
    footer: `<button class="btn ghost" data-close>Cancel</button><button class="btn" id="tgo">Save terms</button>`,
    onMount: (bg) => {
      $('#tgo', bg).onclick = async () => {
        const btn = $('#tgo', bg); btn.disabled = true; btn.textContent = 'Saving…'
        try { await api.put(`/api/invoices/${i.id}`, formData(bg)); closeModal(); toast('Terms updated'); invoiceDetailView(i.id) }
        catch (ex) { toast(ex.message, true); btn.disabled = false; btn.textContent = 'Save terms' }
      }
    },
  }))
  // Optional now: the button is not rendered on a voided invoice. And it reports what the server
  // says happened rather than announcing a delivery it has not been told about.
  if ($('#send')) {
    $('#send').onclick = async () => {
      try {
        const out = await api.post(`/api/invoices/${id}/send`)
        toast(out?.emailed_to ? `Invoice emailed to ${out.emailed_to}. Check the Outbox` : 'Invoice queued. Check the Outbox')
      } catch (e) { toast(e.message, true) }
    }
  }
  // The way back from an invoice raised against the wrong customer or for the wrong amount. Until
  // this existed the only fix was sqlite3 on the server, so the mistake counted toward money owed
  // and chased the wrong customer for as long as the shop kept using the software.
  if ($('#void')) $('#void').onclick = () => confirmModal(
    'Void this invoice?',
    'It stops counting toward money owed and stops chasing the customer. The record stays for your books, and the estimate behind it is freed so you can invoice it again correctly.',
    async () => {
      try { await api.post(`/api/invoices/${id}/void`, {}) } catch (e) { return toast(e.message, true) }
      toast('Invoice voided')
      invoiceDetailView(id)
    })
  $('#reqpay')?.addEventListener('click', async () => {
    try {
      const r = await api.post(`/api/invoices/${id}/request-payment`)
      toast(r.delivered ? 'Payment link emailed to the customer' : 'Payment email drafted to Outbox (Manual mode)')
      if (!r.stripe_ready) toast('Heads up: add your Stripe key in Settings so the link can take card payments', true)
    } catch (e) { toast(e.message, true) }
  })
  $('#copylink')?.addEventListener('click', async () => {
    const url = location.origin + i.pay_link
    try { await navigator.clipboard.writeText(url); toast('Pay link copied') } catch { toast(url) }
  })
  // Scoped to the payments card, not #view: #view survives navigation, so a delegation left here
  // caught [data-del] clicks from other screens and read their index as a payment id.
  on($('#pay-list'), '[data-del-payment]', (_e, t) => confirmModal('Remove payment?', 'The invoice balance will be recalculated.', async () => {
    await api.del(`/api/payments/${t.dataset.delPayment}`)
    toast('Payment removed')
    invoiceDetailView(id)
  }, 'Remove'))
}
