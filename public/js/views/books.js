import { api, $, esc, money, setPage, on, toast, empty, confirmModal, onOnce, onceClick, fmtDate, copyText } from '../core.js'

/**
 * Books — receivables, saved collection-review flags and the QuickBooks reconciliation queue.
 */
let viewRequest = 0

export async function booksView() {
  const request = ++viewRequest, route = location.hash, identity = window.__me
  setPage('Books', '', '<span class="dim">Money</span>')
  $('#view').innerHTML = '<div id="books-loading" class="dim" role="status">Adding it up…</div>'
  const loading = $('#books-loading')
  const current = () => request === viewRequest && loading.isConnected && route === location.hash && identity === window.__me
  /* The A/R aging report is open to every role — /api/reports/ar-aging carries no requireRole —
   * and "Books & A/R" is in every role's sidebar. /api/qbo/queue is manager-only, and this
   * Promise.all was unguarded, so for a STAFF account the 403 rejected the whole thing and the
   * page they were sent to showed an error instead of the receivables report they can read.
   * The QuickBooks half degrades to a line that says who can see it; the report renders. */
  try {
    const [aging, qbo, qs] = await Promise.all([
      api.get('/api/reports/ar-aging'),
      api.get('/api/qbo/queue').catch((e) => ({ forbidden: e?.status === 403, error: e?.message || 'unavailable' })),
      api.get('/api/qbo/status').catch(() => null),
    ])
    if (current()) render(aging, qbo, qs)
  } catch (error) {
    if (!current()) return
    loading.innerHTML = `<p role="alert">${esc(error.message)}</p><button class="btn" id="books-retry">Try again</button>`
    $('#books-retry').onclick = booksView
  }
}

function render(aging, qbo, qs) {
  const t = aging.totals
  const review = aging.collection_review
  const invoiceRow = i => `<div class="card card-b" style="margin-top:10px;overflow-wrap:anywhere">
    <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
      <a href="#/invoices/${i.id}"><strong>${esc(i.number)}</strong></a>
      <strong>${i.balance > 0 ? money(i.balance) + ' due' : i.balance < 0 ? 'Credit balance ' + money(-i.balance) : 'No balance due'}</strong>
    </div>
    <p class="dim">${esc(i.company || i.contact_name)} · ${i.due_date ? 'Due ' + esc(i.due_date) : 'No due date saved; aging uses invoice date'}</p>
    <p>Net invoice ${money(i.amount_due)} · Recorded payments ${money(i.amount_paid)} · Active credits ${money(i.credit_total)}</p>
    ${i.payment_review ? `<p><span class="pill amber">Review before collecting</span> ${esc(i.payment_review)}</p>` : ''}
  </div>`
  const kpi = (label, v, danger) => `<div class="kpi${danger && v > 0 ? ' bad' : ''}"><div class="lbl">${esc(label)}</div><div class="val${danger && v > 0 ? ' bad' : ''}">${money(v)}</div></div>`
  const custRow = (c) => `
    <tr>
      <td><a href="#/contacts/${c.contact_id}">${esc(c.company || c.name)}</a></td>
      <td class="r">${c.current ? money(c.current) : '<span class="dim">—</span>'}</td>
      <td class="r">${c.d30 ? money(c.d30) : '<span class="dim">—</span>'}</td>
      <td class="r">${c.d60 ? money(c.d60) : '<span class="dim">—</span>'}</td>
      <td class="r${c.d90 + c.d90p > 0 ? ' bad' : ''}">${c.d90 + c.d90p ? money(c.d90 + c.d90p) : '<span class="dim">—</span>'}</td>
      <td class="r"><strong>${money(c.total)}</strong></td>
      <td class="r"><a class="btn ghost sm" href="/api/contacts/${c.contact_id}/statement.pdf" target="_blank">Statement</a></td>
    </tr>`

  // What the status column says, in words a bookkeeper uses. `manual` is a row only a person can
  // finish (a credit memo, a refund); it is parked at once instead of being retried six times.
  const QBO_STATE = { ok: ['Synced', 'green'], pending: ['Waiting', 'amber'], retrying: ['Will retry', 'amber'], syncing: ['Sending…', 'amber'],
    failed: ['Failed', 'red'], manual: ['Enter by hand', 'red'], dismissed: ['Done by hand', ''] }
  const qboRow = (r) => { const [label, tone] = QBO_STATE[r.status] || [r.status, 'amber']; return `
    <tr>
      <td data-label="Invoice">${r.invoice_number ? `<a href="#/invoices/${r.entity_id}">${esc(r.invoice_number)}</a>` : `#${esc(r.entity_id)}`}<div class="dim t-2xs">${esc(r.contact_name || '')}</div></td>
      <td class="r" data-label="Amount">${money(r.amount_due || 0)}</td>
      <td data-label="Status"><span class="pill ${tone}">${esc(label)}</span></td>
      <td class="dim qbo-detail" data-label="Detail">${esc(r.error || (r.qbo_id ? `In QuickBooks as #${r.qbo_id}` : ''))}</td>
      <td class="r">${r.status === 'dismissed'
        ? `<button class="btn ghost sm" data-qbo-requeue="${r.id}">Send to QuickBooks</button>`
        : r.status === 'manual' ? `<button class="btn sm" data-qbo-dismiss="${r.id}">Mark done</button> <button class="btn ghost sm" data-qbo-retry="${r.id}">Retry</button>`
        : r.status !== 'ok' ? `<button class="btn sm" data-qbo-retry="${r.id}">Retry</button> <button class="btn ghost sm" data-qbo-dismiss="${r.id}">Dismiss</button>` : ''}</td>
    </tr>` }

  const owner = !!qs?.can_configure
  const today = new Date().toISOString().slice(0, 10)
  // Setup: the shop's own Intuit app, like every other connection here. Shown until connected,
  // and again (collapsed) afterwards so the keys or environment can be changed.
  const qboSetup = (open) => !qs ? '' : `
    <details class="qbo-setup"${open ? ' open' : ''}>
      <summary class="fold-sum">${qs.connected ? 'App keys and options' : 'Set up the connection'}</summary>
      ${owner ? `
      <p class="dim">QuickBooks connects through an Intuit app that belongs to your shop. Create one free at <strong>developer.intuit.com → My Hub → App dashboard</strong> (scope: Accounting), then paste its two keys below.</p>
      <div class="field"><label class="lbl" for="qbo-redirect">Redirect URI to add in your Intuit app (Keys &amp; credentials → Redirect URIs)</label>
      <div class="row qbo-copy"><input class="input" id="qbo-redirect" readonly value="${esc(qs.redirect_uri)}"><button class="btn ghost sm" type="button" id="qbo-copy">Copy</button></div></div>
      <div class="qbo-grid">
        <div class="field"><label class="lbl" for="qbo-client-id">Client ID</label><input class="input" id="qbo-client-id" autocomplete="off" spellcheck="false" value="${esc(qs.client_id)}"></div>
        <div class="field"><label class="lbl" for="qbo-client-secret">Client Secret</label><input class="input" id="qbo-client-secret" type="password" autocomplete="new-password" placeholder="${qs.client_secret_set ? 'Saved — leave blank to keep it' : ''}"></div>
        <div class="field"><label class="lbl" for="qbo-env">Keys are for</label><select class="input" id="qbo-env"><option value="production"${qs.environment === 'production' ? ' selected' : ''}>Production (your real books)</option><option value="sandbox"${qs.environment === 'sandbox' ? ' selected' : ''}>Sandbox (Intuit test company)</option></select></div>
        <div class="field"><label class="lbl" for="qbo-tax">Sales tax goes to</label><select class="input" id="qbo-tax"><option value="liability"${qs.tax_mode === 'liability' ? ' selected' : ''}>${esc(qs.tax_account)} (a liability)</option><option value="income_line"${qs.tax_mode === 'income_line' ? ' selected' : ''}>A plain invoice line (counts as income)</option></select></div>
      </div>
      <label class="row qbo-auto"><input type="checkbox" id="qbo-autosync"${qs.autosync ? ' checked' : ''}> Send invoices and payments automatically as they happen</label>
      <div class="row qbo-actions">
        <button class="btn${qs.connected ? ' ghost' : qs.client_id && qs.client_secret_set ? ' ghost' : ''}" type="button" id="qbo-save">Save</button>
        ${qs.connected ? '' : `<button class="btn${qs.client_id && qs.client_secret_set ? '' : ' ghost'}" type="button" id="qbo-connect"${qs.client_id && qs.client_secret_set ? '' : ' disabled'}>Connect QuickBooks</button>`}
      </div>
      <p class="dim t-2xs">Sales tax is posted through an item named “${esc(qs.tax_item)}”, created in QuickBooks on the first taxed invoice. Your keys stay on this server and are never shown again.</p>`
      : '<p class="dim">Only the shop owner can connect QuickBooks or change its keys.</p>'}
    </details>`

  const qboXero = !qs ? '' : `
    <details class="qbo-setup" id="xero-export">
      <summary class="fold-sum">Export for Xero</summary>
      <p class="dim">A file, not a connection: invoices in Xero’s own import layout. In Xero, go to Invoices → Import; they arrive as drafts for you to approve. Voided and imported-history invoices are left out.</p>
      <div class="qbo-grid">
        <div class="field"><label class="lbl" for="xero-from">From</label><input class="input" type="date" id="xero-from" value="${today.slice(0, 8)}01"></div>
        <div class="field"><label class="lbl" for="xero-to">To</label><input class="input" type="date" id="xero-to" value="${today}"></div>
        <div class="field"><label class="lbl" for="xero-account">Sales account code</label><input class="input" id="xero-account" value="200" maxlength="20"></div>
        <div class="field"><label class="lbl" for="xero-tax">Tax rate name in Xero</label><input class="input" id="xero-tax" value="Tax on Sales" maxlength="60"></div>
      </div>
      <div class="row qbo-actions"><button class="btn ghost" type="button" id="xero-download">Download CSV</button></div>
    </details>`

  const qboBody = !qbo.counts
    ? `<p class="dim">${qbo.forbidden
        ? 'The QuickBooks queue is visible to managers and owners. The receivables report above is yours to use.'
        : `The QuickBooks queue could not be loaded — ${esc(qbo.error || 'unavailable')}.`}</p>`
    : !qbo.connected
    ? `<p>Not connected. Once connected, every invoice and payment is sent to QuickBooks as it happens, and this card shows what went and what did not.</p>
       ${qbo.counts.open ? `<p class="bad">${qbo.counts.open} invoice${qbo.counts.open === 1 ? ' is' : 's are'} waiting — connect QuickBooks and ${qbo.counts.open === 1 ? 'it' : 'they'} will go through.</p>` : ''}
       ${qboSetup(true)}
       <p class="dim t-2xs">Prefer a file? <a href="/api/export/quickbooks.iif">Download an IIF export</a> that imports into QuickBooks Desktop.</p>`
    : `${qs?.needs_reconnect ? `<div class="qbo-alert" role="alert"><strong>QuickBooks needs to be reconnected.</strong> The sign-in expired or was revoked, so nothing is being sent. Everything waiting stays queued. ${owner ? '<button class="btn sm" type="button" id="qbo-connect">Reconnect QuickBooks</button>' : 'Ask the shop owner to reconnect.'}</div>` : ''}
       <p class="qbo-who"><strong>${esc(qs?.company_name || 'QuickBooks company')}</strong>${qs?.environment === 'sandbox' ? ' <span class="pill amber">Sandbox</span>' : ''}
         <span class="dim">· ${qs?.last_sync_at ? `last sent ${esc(fmtDate(qs.last_sync_at))}` : 'nothing sent yet'} · automatic sending ${qbo.autosync ? 'on' : 'off'}</span></p>
       <div class="row qbo-counts">
         <span><strong>${qbo.counts.ok}</strong> synced</span><span><strong>${qbo.counts.open}</strong> waiting</span>
         <span${qbo.counts.failed ? ' class="bad"' : ''}><strong>${qbo.counts.failed}</strong> failed</span>
         <span${qbo.counts.manual ? ' class="bad"' : ''}><strong>${qbo.counts.manual || 0}</strong> to enter by hand</span>
         <span class="qbo-push"><button class="btn${qs?.needs_reconnect ? ' ghost' : ''} sm" type="button" id="qbo-sync-now">Sync now</button>
         ${qbo.counts.failed ? '<button class="btn ghost sm" type="button" id="qbo-retry-failed">Retry all failed</button>' : ''}</span>
       </div>
       ${qbo.rows.length ? `<div class="qbo-log" role="region" aria-label="QuickBooks sync log" tabindex="0"><table class="tbl stack">
         <thead><tr><th>Invoice</th><th class="r">Amount</th><th>Status</th><th>Detail</th><th></th></tr></thead>
         <tbody>${qbo.rows.map(qboRow).join('')}</tbody>
       </table></div>` : '<p class="dim">Nothing sent yet — the next invoice or payment will appear here.</p>'}
       ${qboSetup(false)}
       <div class="row qbo-actions">
         <button class="btn ghost sm" type="button" id="qbo-disconnect">Disconnect QuickBooks</button>
         <span class="dim t-2xs">Removes the saved keys and tokens. Nothing already in QuickBooks is touched.</span>
       </div>`

  $('#view').innerHTML = `
    <div id="books-page">
    <div class="kpis">
      ${kpi('Current', t.current)} ${kpi('1–30 days', t.d30)} ${kpi('31–60', t.d60, true)} ${kpi('61–90', t.d90, true)} ${kpi('90+', t.d90p, true)}
      <div class="kpi"><div class="kpi-n">${money(t.due)}</div><div class="kpi-l">Total receivable</div></div>
    </div>

    ${review ? `<section class="card card-b" aria-labelledby="collection-review-title">
      <h2 id="collection-review-title">Collection review</h2>
      <p><strong>${money(review.due)}</strong> of receivables are on invoices marked for review. <strong>${money(review.unpaused_due)}</strong> have no saved review flag.</p>
      <p class="dim">The full receivable remains in the aging report. A missing review flag is not a confirmation that a payment request is safe. Credits are already included in net invoice amounts; they do not record a cash refund.</p>
      ${review.count ? `<details open><summary>Review before collecting · ${review.count} invoice${review.count === 1 ? '' : 's'}</summary>
        ${review.no_balance_count ? `<p>${review.no_balance_count} flagged invoice${review.no_balance_count === 1 ? ' has' : 's have'} no positive balance.${review.overpaid ? ` Their credit balances total ${money(review.overpaid)} and are not subtracted from other receivables.` : ''}</p>` : ''}
        ${review.invoices.map(invoiceRow).join('')}</details>` : '<p>No invoices currently have a saved payment-review flag.</p>'}
    </section>` : ''}

    <div class="card">
      <h2>A/R aging by customer <span class="dim" style="font-weight:400;font-size:12px">as of ${esc(aging.as_of)}</span></h2>
      ${aging.customers.length ? `<div style="overflow-x:auto" role="region" aria-label="Receivables aging by customer" tabindex="0"><table class="tbl">
        <tr><th>Customer</th><th class="r">Current</th><th class="r">1–30</th><th class="r">31–60</th><th class="r">61+</th><th class="r">Total</th><th></th></tr>
        ${aging.customers.map(custRow).join('')}
      </table></div>
      <div class="card-b"><h3>Invoice details</h3>${aging.customers.map(c => `<details style="margin-top:12px"><summary>${esc(c.company || c.name)} · ${c.invoices.length} invoice${c.invoices.length === 1 ? '' : 's'} · ${money(c.total)}</summary>${c.invoices.map(invoiceRow).join('')}</details>`).join('')}</div>` : empty('check', 'No positive balances', review?.count ? 'Review the flagged invoices above before closing the books.' : 'No non-void invoices have a positive balance.')}
    </div>

    <div class="card card-b" id="qbo-card">
      <h2>QuickBooks Online <span class="dim qbo-oneway">One-way: PrintShopCRM → QuickBooks</span></h2>
      ${qboBody}
      ${qbo.counts ? qboXero : ''}
    </div>
    </div>`

  // The only way to take QuickBooks back out. Its keys and tokens are all secrets, so blanking
  // them on the settings form was a deliberate no-op and there was no route that cleared them —
  // a shop whose bookkeeper left could not disconnect the books from any screen.
  if ($('#qbo-disconnect')) $('#qbo-disconnect').onclick = () => confirmModal('Disconnect QuickBooks?',
    'The saved app keys and tokens are removed from this shop. Invoices already synced stay in QuickBooks, and anything waiting will queue until you connect again.',
    async () => {
      try { await api.post('/api/settings/disconnect/quickbooks', {}); toast('QuickBooks disconnected'); booksView() }
      catch (e) { toast(e.message, true) }
    }, 'Disconnect')

  // Back from Intuit's consent page: say so once, then drop the marker so a refresh does not repeat it.
  if (/[?&]qbo=connected\b/.test(location.hash)) {
    toast('QuickBooks connected')
    if (typeof history !== 'undefined') history.replaceState(null, '', '#/books')
  }
  if ($('#qbo-copy')) $('#qbo-copy').onclick = () => copyText($('#qbo-redirect').value, 'Redirect URI copied')
  if ($('#qbo-save')) onceClick($('#qbo-save'), 'Saving…', async () => {
    const body = { environment: $('#qbo-env').value, tax_mode: $('#qbo-tax').value, autosync: $('#qbo-autosync').checked }
    if ($('#qbo-client-id').value.trim()) body.client_id = $('#qbo-client-id').value.trim()
    if ($('#qbo-client-secret').value.trim()) body.client_secret = $('#qbo-client-secret').value.trim()
    try {
      const r = await api.put('/api/qbo/credentials', body)
      toast(r.needs_reconnect ? 'Saved — reconnect QuickBooks to use the new keys' : 'Saved')
      booksView()
    } catch (e) { toast(e.message, true) }
  })
  // Connect and Reconnect are the same door: Intuit's consent page, then back here.
  if ($('#qbo-connect')) onceClick($('#qbo-connect'), 'Opening QuickBooks…', async () => {
    try { const r = await api.get('/api/qbo/connect'); location.href = r.url }
    catch (e) { toast(e.message, true) }
  })
  if ($('#qbo-sync-now')) onceClick($('#qbo-sync-now'), 'Sending…', async () => {
    try {
      const r = await api.post('/api/qbo/sync-now', {})
      toast(r.needs_reconnect ? 'QuickBooks needs to be reconnected' : r.synced ? `${r.synced} sent to QuickBooks${r.waiting ? `, ${r.waiting} still waiting` : ''}` : r.waiting ? `${r.waiting} could not be sent — see the reasons below` : 'Nothing was waiting', !!r.needs_reconnect)
      booksView()
    } catch (e) { toast(e.message, true) }
  })
  if ($('#qbo-retry-failed')) onceClick($('#qbo-retry-failed'), 'Queuing…', async () => {
    try { const r = await api.post('/api/qbo/queue/retry-failed', {}); toast(`${r.requeued} back on the queue — press Sync now to send them`); booksView() }
    catch (e) { toast(e.message, true) }
  })
  if ($('#xero-download')) $('#xero-download').onclick = () => {
    const q = new URLSearchParams({ from: $('#xero-from').value, to: $('#xero-to').value, account: $('#xero-account').value.trim() || '200', tax: $('#xero-tax').value.trim() || 'Tax on Sales' })
    location.href = `/api/xero/invoices.csv?${q}`
  }

  onOnce($('#view'), '[data-qbo-retry]', async (e) => {
    const btn = e.target.closest('[data-qbo-retry]')
    btn.disabled = true; btn.textContent = 'Retrying…'
    try { await api.post(`/api/qbo/queue/${btn.dataset.qboRetry}/retry`); toast('Synced to QuickBooks'); booksView() }
    catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = 'Retry' }
  })
  onOnce($('#view'), '[data-qbo-dismiss]', async (e) => {
    const btn = e.target.closest('[data-qbo-dismiss]')
    try { await api.post(`/api/qbo/queue/${btn.dataset.qboDismiss}/dismiss`); booksView() }
    catch (err) { toast(err.message, true) }
  })
  // Dismiss used to be a one-way door: a dismissed row rendered no buttons, the sweep only ever
  // claims 'pending'/'retrying', and enqueueQbo needs another payment on an already-paid invoice.
  // One mis-click marked collected money as dealt-with for good, escapable only with sqlite3.
  onOnce($('#view'), '[data-qbo-requeue]', async (e) => {
    const btn = e.target.closest('[data-qbo-requeue]')
    btn.disabled = true
    try { await api.post(`/api/qbo/queue/${btn.dataset.qboRequeue}/requeue`); toast('Queued — it will go on the next sweep'); booksView() }
    catch (err) { toast(err.message, true); btn.disabled = false }
  })
}
