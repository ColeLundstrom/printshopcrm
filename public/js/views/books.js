import { api, $, esc, money, setPage, on, toast, empty , onOnce} from '../core.js'

/**
 * Books — the bookkeeper page: A/R aging (the report InkSoft users say they can't get) and the
 * QuickBooks reconciliation queue (every push, every failure with its reason, one-click retry —
 * the incumbents' syncs fail silently and someone finds the hole at month close).
 */

export async function booksView() {
  setPage('Books', '', '<span class="dim">Money</span>')
  $('#view').innerHTML = '<div class="dim">Adding it up…</div>'
  const [aging, qbo] = await Promise.all([api.get('/api/reports/ar-aging'), api.get('/api/qbo/queue')])
  render(aging, qbo)
}

function render(aging, qbo) {
  const t = aging.totals
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

  const qboRow = (r) => `
    <tr>
      <td>${esc(r.invoice_number || `#${r.entity_id}`)}<div class="dim" style="font-size:11px">${esc(r.contact_name || '')}</div></td>
      <td class="r">${money(r.amount_due || 0)}</td>
      <td><span class="pill ${r.status === 'ok' ? 'green' : r.status === 'failed' ? 'red' : 'amber'}">${esc(r.status)}</span></td>
      <td class="dim" style="max-width:260px;font-size:11.5px">${esc(r.error || (r.qbo_id ? `QBO #${r.qbo_id}` : ''))}</td>
      <td class="r">${r.status !== 'ok' && r.status !== 'dismissed' ? `<button class="btn sm" data-qbo-retry="${r.id}">Retry</button> <button class="btn ghost sm" data-qbo-dismiss="${r.id}">Dismiss</button>` : ''}</td>
    </tr>`

  $('#view').innerHTML = `
    <div class="kpis">
      ${kpi('Current', t.current)} ${kpi('1–30 days', t.d30)} ${kpi('31–60', t.d60, true)} ${kpi('61–90', t.d90, true)} ${kpi('90+', t.d90p, true)}
      <div class="kpi"><div class="kpi-n">${money(t.due)}</div><div class="kpi-l">Total receivable</div></div>
    </div>

    <div class="card">
      <h2>A/R aging by customer <span class="dim" style="font-weight:400;font-size:12px">as of ${esc(aging.as_of)}</span></h2>
      ${aging.customers.length ? `<table class="tbl">
        <tr><th>Customer</th><th class="r">Current</th><th class="r">1–30</th><th class="r">31–60</th><th class="r">61+</th><th class="r">Total</th><th></th></tr>
        ${aging.customers.map(custRow).join('')}
      </table>` : empty('✅', 'Nothing outstanding', 'Every invoice is paid up.')}
    </div>

    <div class="card" id="qbo-card">
      <h2>QuickBooks sync</h2>
      ${!qbo.connected
        ? `<p class="dim">Not connected. Add your QuickBooks app keys in <a href="#/settings">Settings</a> and connect — invoices and payments will post themselves as money moves, and anything that fails shows up here with the reason.</p>
           ${qbo.counts.open ? `<p class="bad">${qbo.counts.open} invoice${qbo.counts.open === 1 ? '' : 's'} waiting to sync — reconnect QuickBooks and they'll go through.</p>` : ''}`
        : `<div class="dim" style="margin-bottom:10px">
             ${qbo.counts.ok} synced · ${qbo.counts.open} waiting · <strong${qbo.counts.failed ? ' class="bad"' : ''}>${qbo.counts.failed} need attention</strong>
             · auto-sync ${qbo.autosync ? 'on' : 'off'}
           </div>
           ${qbo.rows.length ? `<table class="tbl">
             <tr><th>Invoice</th><th class="r">Amount</th><th>Status</th><th>Detail</th><th></th></tr>
             ${qbo.rows.map(qboRow).join('')}
           </table>` : '<p class="dim">No sync activity yet — record a payment and it will queue itself.</p>'}`}
    </div>`

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
}
