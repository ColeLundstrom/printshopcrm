import { api, $, $$, esc, money, money0, fmtDate, pill, setPage, empty, toast, go, on, onOnce, modal, closeModal, confirmModal, formData, daysOut, copyText, onceClick } from '../core.js'
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
          <td data-label="Status">${i.payment_review ? '<span class="pill amber">Review payment</span>' : pill(late ? 'overdue' : i.status)}</td>
          <td class="num" data-label="Total">${money(i.amount_due)}</td>
          <td class="num muted" data-label="Paid">${money(i.amount_paid)}</td>
          <td class="num" data-label="Balance"><strong style="${bal > 0 ? 'color:var(--amber)' : 'color:var(--txt-3)'}">${money(bal)}</strong></td>
          <td class="num" data-label="Due" style="font-size:12px"><span class="${late ? '' : 'dim'}" style="${late ? 'color:var(--red);font-weight:600' : ''}">${fmtDate(i.due_date)}</span></td>
        </tr>`
      }).join('')}</tbody></table>` : empty('▣', 'No invoices', 'Approve an estimate and convert it to create one.', '<a class="btn" href="#/estimates">Go to estimates</a>')
  }

  $('#view').innerHTML = `<div class="searchbar">
      <div class="tabs" id="tabs" role="group" aria-label="Filter invoices by status">${['all', 'unpaid', 'overdue', 'partial', 'paid', 'void'].map((s) => `<button type="button" data-s="${s}" class="${filter === s ? 'on' : ''}" aria-pressed="${filter === s}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}</div>
      <div class="sp"></div><div id="sum" style="align-self:center"></div>
    </div><div class="card" id="list"></div>`
  // #list is created ONCE per visit and only its innerHTML is repainted, so this binding used to
  // sit inside render() and stacked one more listener on every tab switch: by the sixth tab a
  // single click on a row ran go() six times. onOnce is keyed on (root, event, selector).
  onOnce($('#list'), '[data-id]', (_e, t) => go(`/invoices/${t.dataset.id}`))
  on($('#tabs'), '[data-s]', (_e, t) => {
    filter = t.dataset.s
    $$('#tabs button').forEach((b) => { const on = b.dataset.s === filter; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)) })
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
  const manager=['owner','manager'].includes(cfg.role)
  const chaseable = bal > 0 && i.status !== 'void' && !i.payment_review
  setPage(i.invoice_number, `
    ${chaseable ? `<button class="btn" id="reqpay">Request Payment</button>` : ''}
    ${chaseable ? `<button class="btn ghost" id="pay">Record Payment</button>` : ''}
    ${i.status === 'void' || i.payment_review ? '' : '<button class="btn ghost" id="send">Email Invoice</button>'}
    ${i.status !== 'void' && manager ? '<button class="btn ghost" id="credit">Issue credit</button>' : ''}
    <a class="btn ghost" href="/api/invoices/${id}/pdf" target="_blank">PDF</a>
    ${i.status === 'void' ? '' : `<button class="btn ghost" id="void">Void</button>`}`,
    `<a href="#/invoices">Invoices</a> /`)

  $('#view').innerHTML = `${i.payment_review ? `<section class="setup-section" role="status"><h2>Review this payment change</h2><p>${esc(i.payment_review)}</p><p>Payment requests and invoice automations are paused. A refund returns money; an invoice credit reduces what the customer owes. Check both before resuming.</p>${manager ? '<button class="btn" id="review-payment">Review balance</button>' : '<p>An owner or manager must complete this review.</p>'} <a class="btn ghost" href="#/payments">Payment history & recheck</a></section>` : ''}<div class="cols invoice-workspace">
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
          ${i.credit_base ? `<div><span>Original invoice</span><span>${money(i.credit_base.amount_due)}</span></div>${i.credits.filter(c=>!c.cancelled_at).map(c=>`<div><span>Credit: ${esc(c.reason)}${c.tax_cents ? ` (includes ${money(c.tax_cents/100)} tax)` : ''}</span><span>-${money((c.subtotal_cents+c.tax_cents)/100)}</span></div>`).join('')}` : ''}
          <div><span>Invoice total</span><span>${money(i.amount_due)}</span></div>
          <div><span>Net received</span><span style="color:var(--accent)">-${money(i.amount_paid)}</span></div>
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
        ${manager ? '<div class="row" style="margin-top:10px"><button class="btn ghost sm" id="terms">Edit terms &amp; addresses</button></div>' : ''}
        ${i.billing_address || i.shipping_address ? `<details style="margin-top:12px"><summary>Invoice addresses</summary>${[['Billing address',i.billing_address],['Ship to',i.shipping_address]].map(([label,value]) => `<p><strong>${label}</strong></p><div style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(value || 'Not set')}</div>`).join('')}</details>` : ''}
      </div></div>

      <div class="card" id="pay-list">
        <div class="card-h"><h3>Payments</h3><div class="spacer"></div>${chaseable ? `<button class="btn ghost sm" id="pay2">+ Add</button>` : ''}</div>
        ${i.payments.length ? `<table class="tbl"><tbody>${i.payments.map((p) => `<tr>
          <td><strong>${money(p.amount)}</strong><div class="dim" style="font-size:11.5px">${esc(p.method)}${p.note ? ` · ${esc(p.note)}` : ''}</div></td>
          <td class="num dim" style="font-size:12px">${fmtDate(p.created_at)}</td>
          <td class="num" style="width:34px">${p.stripe_session ? '<span class="dim" title="Verified processor entry; refund at your provider">Verified</span>' : `<button class="del btn danger sm" data-del-payment="${p.id}" aria-label="Delete the ${esc(money(p.amount))} ${esc(p.method || '')} payment">&times;</button>`}</td>
        </tr>`).join('')}</tbody></table>` : '<div class="card-b dim">No payments recorded.</div>'}
      </div>

      ${chaseable ? `<div class="card"><div class="card-b">
        <div class="row" style="justify-content:space-between;margin-bottom:6px"><span class="dim" style="font-size:11px;text-transform:uppercase;letter-spacing:.6px">Online payment</span>
          <span class="pill ${i.stripe_ready ? 'green' : 'gray'}" style="font-size:9.5px">${i.stripe_ready ? esc(i.payment_provider_label)+' on' : 'Not connected'}</span></div>
        <p class="dim" style="font-size:12px;line-height:1.55;margin-bottom:8px">${i.stripe_ready ? 'Customers pay a deposit or balance through '+esc(i.payment_provider_label)+'. Verified payments are recorded here automatically.' : 'Connect Stripe or Authorize.net in Setup & connections, or record payments taken elsewhere.'}</p>
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

  // Credits change the amount owed; they never initiate a refund or move production.
  onceClick($('#credit'),'Opening…',async()=>{
    let reference
    try { ({reference}=await api.get(`/api/invoices/${id}/credit-reference`)) }
    catch(e) {toast(e.message,true);return}
    modal({title:'Issue invoice credit',body:`<p>This reduces the invoice. It does not return money to the customer. Refund cards in your payment provider first when needed.</p><div class="field"><label for="credit-sub">Credit before tax</label><input class="input" type="number" min="0" step="0.01" name="subtotal" id="credit-sub" value="${Math.max(0,bal).toFixed(2)}"></div><div class="field"><label for="credit-tax">Tax to credit</label><input class="input" type="number" min="0" step="0.01" name="tax" id="credit-tax" value="0"></div><div class="field"><label for="credit-reason">Reason shown on invoice</label><input class="input" name="reason" id="credit-reason" maxlength="500" placeholder="e.g. Canceled 12 shirts"></div><p class="dim">Enter the actual tax adjustment; tax is not guessed. Review the balance afterward. Credit documents in QuickBooks require manual reconciliation.</p>`,footer:'<button class="btn ghost" data-close>Cancel</button><button class="btn" id="credit-save">Issue credit</button>',onMount:bg=>onceClick($('#credit-save',bg),'Saving…',async()=>{try{await api.post(`/api/invoices/${id}/credits`,{reference,...formData(bg)});closeModal();toast('Credit recorded; review the balance');await invoiceDetailView(id)}catch(e){toast(e.message,true)}})})
  })
  $('#review-payment')?.addEventListener('click',()=>modal({title:'Review the remaining balance',body:`<p>Invoice total: <strong>${money(i.amount_due)}</strong><br>Net received after refunds: <strong>${money(i.amount_paid)}</strong><br>Remaining balance: <strong>${money(bal)}</strong></p><p>If work was canceled, issue a credit before completing this review. If no money remains and the whole invoice was canceled, void the invoice. Continuing allows new payment requests for a positive balance. Old draft messages remain blocked.</p><div class="field"><label for="review-note">What did you verify?</label><textarea class="input" id="review-note" name="note" maxlength="1000" rows="3"></textarea></div>`,footer:'<button class="btn ghost" data-close>Back</button><button class="btn" id="review-save">Confirm reviewed balance</button>',onMount:bg=>onceClick($('#review-save',bg),'Saving…',async()=>{try{await api.post(`/api/invoices/${id}/payment-review`,formData(bg));closeModal();toast('Review saved');await invoiceDetailView(id)}catch(e){toast(e.message,true)}})}))
  if(i.credits?.length) {
    const section=document.createElement('section');section.className='setup-section'
    section.innerHTML=`<h2>Credit history</h2>${i.credits.map(c=>`<div class="payment-attempt"><div><strong>${money((c.subtotal_cents+c.tax_cents)/100)}${c.cancelled_at ? ' · Canceled' : ''}</strong><p>${esc(c.reason)}${c.tax_cents ? ' · Tax '+money(c.tax_cents/100) : ''}<br>${fmtDate(c.created_at)}${c.cancel_reason ? ' · Canceled: '+esc(c.cancel_reason) : ''}</p></div>${manager && !c.cancelled_at && i.status!=='void' ? `<button class="btn ghost" data-cancel-credit="${esc(c.reference)}">Cancel credit</button>` : ''}</div>`).join('')}`
    $('#view').append(section)
    $$('[data-cancel-credit]',section).forEach(b=>b.onclick=()=>modal({title:'Cancel this credit',body:'<p>The invoice amount will increase again. No money moves; collections pause for review.</p><div class="field"><label for="cancel-reason">Reason</label><input class="input" id="cancel-reason" name="reason" maxlength="500"></div>',footer:'<button class="btn ghost" data-close>Back</button><button class="btn" id="cancel-save">Cancel credit</button>',onMount:bg=>onceClick($('#cancel-save',bg),'Saving…',async()=>{try{await api.post(`/api/invoices/${id}/credits/${b.dataset.cancelCredit}/cancel`,formData(bg));closeModal();await invoiceDetailView(id)}catch(e){toast(e.message,true)}})}))
  }

  const openPay = () => modal({
    title: 'Record Payment',
    body: `<div class="field"><label>Amount</label><input class="input" name="amount" type="number" step="0.01" value="${bal.toFixed(2)}"></div>
      <div class="field"><label>Method</label><select class="input" name="method">
        ${['card', 'check', 'cash', 'ach', 'other'].map((m) => `<option>${m}</option>`).join('')}</select></div>
      <div class="field"><label>Note</label><input class="input" name="note" placeholder="Check #1042, deposit, etc."></div>
      <p class="dim" style="font-size:12px">Balance due is ${money(bal)}. Partial payments are fine. The invoice flips to <em>partial</em>.</p>
      <p id="pay-dup" role="alert" hidden style="font-size:12px;color:var(--amber);margin-top:8px"></p>`,
    footer: `<button class="btn ghost" data-close>Cancel</button><button class="btn" id="go">Record Payment</button>`,
    onMount: (bg) => {
      // In-flight guard, the same one the Terms dialog below has always had. Without it the button
      // stayed live and the dialog stayed open for the whole round trip, so on shop wifi a second
      // impatient click posted the payment again. A full-balance double-click is caught by the
      // server (the second one is over the remaining balance) — a PARTIAL payment is not: $500
      // twice on a $1,000 invoice records $1,000, flips the invoice to paid, and the shop believes
      // it collected money it never got.
      // …and the server refuses a same-amount/method/note repeat inside two minutes, because the
      // guard above is per-TAB: two people at two desks with the same cheque, or a re-click after
      // a response that never arrived, walk straight past it. That refusal is a question, so the
      // dialog has to be able to answer it — otherwise a shop taking two genuine $50 cash payments
      // in a row hits a wall it cannot get through from any screen.
      let confirmDuplicate = false
      $('#go', bg).onclick = async () => {
        const btn = $('#go', bg); btn.disabled = true; btn.textContent = 'Recording…'
        try {
          await api.post(`/api/invoices/${id}/payments`, { ...formData(bg), ...(confirmDuplicate ? { confirm: true } : {}) })
          closeModal()
          toast('Payment recorded')
          invoiceDetailView(id)
        } catch (e) {
          btn.disabled = false
          if (e.data?.code === 'duplicate_payment' && !confirmDuplicate) {
            confirmDuplicate = true
            $('#pay-dup', bg).textContent = `${e.message} Press again to record it anyway.`
            $('#pay-dup', bg).hidden = false
            btn.textContent = 'Record it anyway'
            return
          }
          toast(e.message, true); btn.textContent = 'Record Payment'
        }
      }
    },
  })

  $('#pay')?.addEventListener('click', openPay)
  $('#pay2')?.addEventListener('click', openPay)

  // Amend terms and postal addresses. The amount is owned by the estimate's
  // line items, so it stays read-only here rather than letting the two documents disagree.
  $('#terms')?.addEventListener('click', () => modal({
    title: `Terms for ${i.invoice_number}`,
    body: `<div class="field"><label>Payment due</label><input class="input" name="due_date" type="date" value="${esc(i.due_date || '')}"></div>
      <div class="field" style="margin-top:10px"><label>Customer PO number (optional)</label>
        <input class="input" name="po_number" value="${esc(i.po_number || '')}" placeholder="e.g. 4501-22"></div>
      <div class="grid2">
        <div class="field"><label for="invoice-billing-address">Billing address</label><textarea class="input" id="invoice-billing-address" name="billing_address" rows="4" maxlength="600">${esc(i.billing_address || '')}</textarea></div>
        <div class="field"><label for="invoice-shipping-address">Shipping address</label><textarea class="input" id="invoice-shipping-address" name="shipping_address" rows="4" maxlength="600">${esc(i.shipping_address || '')}</textarea></div>
      </div>
      <div class="dim" style="font-size:12px">Up to 8 lines each. These addresses belong to this invoice. Update the job separately if its shipping destination changes.</div>
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
  onceClick($('#send'), 'Sending…', async () => {
    try {
      const out = await api.post(`/api/invoices/${id}/send`)
      toast(out?.emailed_to ? `Invoice emailed to ${out.emailed_to}. Check the Outbox` : 'Invoice queued. Check the Outbox')
    } catch (e) { toast(e.message, true) }
  })
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
      if (!r.stripe_ready) toast('Connect a provider in Setup & connections to accept online card payments', true)
    } catch (e) { toast(e.message, true) }
  })
  $('#copylink')?.addEventListener('click', async () => {
    const url = location.origin + i.pay_link
    await copyText(url, 'Pay link copied')
  })
  // Scoped to the payments card, not #view: #view survives navigation, so a delegation left here
  // caught [data-del] clicks from other screens and read their index as a payment id.
  on($('#pay-list'), '[data-del-payment]', (_e, t) => confirmModal('Remove payment?', 'The invoice balance will be recalculated.', async () => {
    await api.del(`/api/payments/${t.dataset.delPayment}`)
    toast('Payment removed')
    invoiceDetailView(id)
  }, 'Remove'))
}
