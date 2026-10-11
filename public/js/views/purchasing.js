import { api, $, esc, fmtDate, daysOut, setPage } from '../core.js'

const views = [
  ['attention', 'Needs attention'], ['outstanding', 'Outstanding quantities'],
  ['confirmation', 'Placement unconfirmed'], ['short_closed', 'Short-closed'],
  ['received', 'Fully received'], ['all', 'All recorded POs']
]
const placement = {
  confirmed_manual: 'Manual confirmation recorded', confirmed_supplier: 'Supplier confirmation recorded',
  submitting: 'Submission in progress / unresolved', unknown: 'Placement outcome unknown',
  unverified_legacy: 'Placement unverified', manual_required: 'Manual placement needed'
}
let visit = 0

export async function purchasingView() {
  const request = ++visit, route = location.hash, identity = window.__me
  const query = route.split('?')[1] || ''
  setPage('Purchasing', '<a class="btn ghost" href="#/production">Department queue</a><button class="btn ghost" id="purchasing-refresh">Refresh</button>')
  $('#view').innerHTML = '<div id="purchasing-loading" role="status">Reading recorded purchase orders…</div>'
  const loading = $('#purchasing-loading')
  // Another asynchronous route can leave this loader connected while its own request runs.
  const current = () => request === visit && loading.isConnected && route === location.hash && identity === window.__me
  $('#purchasing-refresh').onclick = purchasingView
  try {
    const data = await api.get('/api/purchasing?' + query)
    if (!current()) return
    render(data)
  } catch (error) {
    if (!current()) return
    loading.innerHTML = `<p role="alert">${esc(error.message)}</p><button class="btn" id="purchasing-retry">Try again</button>`
    $('#purchasing-retry').onclick = purchasingView
  }
}

function render(d) {
  $('#view').innerHTML = `<div id="purchasing-page" class="stack production-page">
    <p class="dim">Recorded purchase orders across the shop, including jobs without a workflow and jobs that have ended. Jobs without a PO and manual garment counts are not included. These counts do not establish production readiness or live supplier delivery status.</p>
    <form id="purchasing-filter" class="prod-toolbar">
      <div class="field"><label for="purchasing-state">View</label><select class="input" id="purchasing-state" name="state">${views.map(([value, label]) => `<option value="${value}" ${d.state === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
      <div class="field"><label for="purchasing-supplier">Supplier</label><select class="input" id="purchasing-supplier" name="supplier"><option value="">All suppliers</option>${[...new Set([...d.suppliers, ...(d.supplier ? [d.supplier] : [])])].map(value => `<option value="${esc(value)}" ${d.supplier === value ? 'selected' : ''}>${esc(value)}</option>`).join('')}</select></div>
      <div class="field"><label for="purchasing-search">PO or job search</label><input class="input" id="purchasing-search" name="q" maxlength="120" value="${esc(d.q)}" placeholder="PO, job, title or supplier"></div>
      <button class="btn">Show purchase orders</button>
    </form>
    <section aria-label="Matching purchase order totals"><p class="dim">Totals for this search and supplier, across all views</p><div class="kpis">
      ${[['Needs attention', d.summary.needs_attention], ['Open outstanding units', d.summary.outstanding_units], ['Placement unconfirmed', d.summary.needs_confirmation], ['Short-closed POs', d.summary.short_closed]].map(([label, value]) => `<div class="kpi"><div class="lbl">${label}</div><div class="val">${value}</div></div>`).join('')}
    </div></section>
    <p role="status" id="purchasing-result-count">${d.total} purchase order${d.total === 1 ? '' : 's'} in this view. Earliest job due date first; undated jobs last.</p>
    <div class="stack" id="purchasing-results">${d.rows.length ? d.rows.map(poCard).join('') : `<div class="card card-b"><h2>No purchase orders in this view</h2><p>Try another view or clear the filters. Recorded short closes and cancelled orders appear under All recorded POs.</p><a class="btn ghost" href="#/purchasing?state=all">Show all recorded POs</a></div>`}</div>
    ${pages(d)}
  </div>`
  $('#purchasing-filter').onsubmit = event => {
    event.preventDefault()
    const params = new URLSearchParams(new FormData(event.currentTarget))
    params.set('page_size', String(d.page_size))
    const next = '#/purchasing?' + params.toString()
    if (location.hash === next) purchasingView()
    else location.hash = next
  }
}

function poCard(po) {
  const closed = po.status === 'closed', cancelled = po.status === 'cancelled'
  const outstanding = !closed && !cancelled && po.outstanding > 0
  const late = outstanding && po.due_date && daysOut(po.due_date) < 0
  const receiving = cancelled ? 'Cancelled' : closed ? po.outstanding > 0 ? 'Closed short' : 'Closed' : po.ordered === 0 ? 'No ordered quantities recorded' : po.outstanding > 0 ? po.received > 0 ? 'Partially received' : 'Awaiting receipt' : 'Fully received'
  return `<article class="card card-b purchasing-card" data-po="${po.id}">
    <div class="purchasing-heading"><div><h2>${esc(po.po_number || 'PO ' + po.id)}</h2><p>${esc(po.supplier || 'Supplier not recorded')}</p></div><div class="purchasing-tags"><span class="tag ${closed || cancelled ? 'gray' : outstanding ? 'amber' : po.ordered ? 'green' : 'amber'}">${receiving}</span>${po.rush ? '<span class="tag red">Rush job</span>' : ''}</div></div>
    <p>${po.job_id ? `<span class="mono">${esc(po.job_number)}</span> · ${esc(po.title || 'Untitled job')}${po.job_status !== 'active' ? ` · <strong>Job ${esc(po.job_status || 'status unknown')}</strong>` : ''}` : '<strong>No linked job</strong> · This PO is retained for review.'}</p>
    <p class="${late ? 'purchasing-late' : 'dim'}">${po.due_date ? `Job due ${esc(fmtDate(po.due_date))}${late ? ' · overdue with outstanding quantities' : ''}` : 'Job due date not set'}</p>
    <p><strong>${po.received} / ${po.ordered}</strong> received${po.outstanding ? ` · <strong>${po.outstanding} ${closed ? 'closed short' : cancelled ? 'not received (cancelled)' : 'outstanding'}</strong>` : ''}</p>
    <p class="${po.placement_confirmed ? 'dim' : 'purchasing-warning'}">${esc(placement[po.placement_state] || 'Placement unverified')}${!po.placement_confirmed ? ' · receiving counts alone do not confirm an order was placed.' : ''}</p>
    ${closed && po.outstanding ? '<p class="dim">The shortage was closed, not received. A manager can review or reopen it from the full job.</p>' : ''}
    ${po.job_id ? `<div class="purchasing-actions"><a class="btn ghost" href="#/production/jobs/${po.job_id}?receiving=1" aria-label="Open receiving for ${esc(po.job_number)}">Open receiving</a><a class="btn ghost" href="#/jobs/${po.job_id}" aria-label="Open full job ${esc(po.job_number)}">Full job & purchasing</a></div>` : ''}
  </article>`
}

function pages(d) {
  if (d.pages <= 1 && d.page === 1) return ''
  const link = (page, label) => {
    const query = new URLSearchParams({ state: d.state, supplier: d.supplier, q: d.q, page: String(page), page_size: String(d.page_size) })
    return `<a class="btn ghost" href="#/purchasing?${esc(query.toString())}">${label}</a>`
  }
  return `<nav class="prod-toolbar" aria-label="Purchase order pages">${d.page > 1 ? link(Math.min(d.page - 1, d.pages), 'Previous') : ''}<span>Page ${d.page} of ${d.pages}</span>${d.page < d.pages ? link(d.page + 1, 'Next') : ''}</nav>`
}
