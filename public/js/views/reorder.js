import { api, $, esc, money0, setPage, empty, on, go, toast, fmtDate } from '../core.js'

/**
 * Reorder Radar: repeat customers who are due (or overdue) to buy again, ranked by value, each
 * with their last order and a one-click nudge. The follow-up money every shop leaves on the table.
 */

const STATUS = {
  overdue: { pill: 'red', label: 'Overdue' },
  due: { pill: 'amber', label: 'Due now' },
  upcoming: { pill: 'blue', label: 'Coming up' },
}
const CONF = { high: 'Strong pattern', medium: 'Likely', low: 'One order so far' }

export async function reorderView() {
  setPage('Reorder Radar', '', '<span class="dim">CRM</span>')
  $('#view').innerHTML = '<div class="dim">Reading order history…</div>'
  const d = await api.get('/api/reorders')
  render(d)
}

function render(d) {
  const k = d.stats
  const card = (c) => {
    const st = STATUS[c.status] || STATUS.upcoming
    const ago = c.days_since >= 365 ? `${Math.round(c.days_since / 30)} mo` : `${c.days_since}d`
    const dueTxt = c.due_in_days < 0 ? `${Math.abs(c.due_in_days)}d overdue` : c.due_in_days === 0 ? 'due today' : `due in ${c.due_in_days}d`
    return `<div class="ro-card" data-cid="${c.contact_id}">
      <div class="ro-main">
        <div class="ro-top">
          <a class="ro-name" href="#/contacts/${c.contact_id}">${esc(c.name)}</a>
          ${c.company ? `<span class="dim" style="font-size:12px">${esc(c.company)}</span>` : ''}
          <span class="pill ${st.pill}">${st.label}</span>
          <span class="dim" style="font-size:11px">${esc(CONF[c.confidence] || '')}</span>
        </div>
        <div class="ro-sub">
          Ordered <strong>${c.orders}×</strong> · last ${ago} ago${c.last_order.title ? ` · <span style="color:var(--txt-2)">${esc(c.last_order.title)}</span>` : ''}
          ${c.last_order.sizes_summary ? `<span class="dim"> · ${esc(c.last_order.sizes_summary)}</span>` : ''}
        </div>
        <div class="ro-meta">
          <span title="Predicted from their own order rhythm">${esc(dueTxt)} · usually every ${c.cadence_days}d</span>
          ${c.lifetime_value ? `<span>${money0(c.lifetime_value)} lifetime</span>` : ''}
          ${c.email ? '' : '<span style="color:var(--amber)">no email on file</span>'}
        </div>
      </div>
      <div class="ro-actions">
        <button class="btn sm" data-nudge="${c.contact_id}" ${c.email ? '' : 'disabled'}>Send nudge</button>
        <button class="btn ghost sm" data-snooze="${c.contact_id}">Snooze</button>
      </div>
    </div>`
  }

  $('#view').innerHTML = `
    <div class="kpis">
      <div class="kpi ${k.actionable ? 'warn' : ''}"><div class="lbl">Due to reorder</div><div class="val">${k.actionable}</div><div class="sub">customers to reach today</div></div>
      <div class="kpi ${k.overdue ? 'bad' : ''}"><div class="lbl">Overdue</div><div class="val">${k.overdue}</div><div class="sub">past their usual rhythm</div></div>
      <div class="kpi info"><div class="lbl">Potential value</div><div class="val">${money0(k.potential_value)}</div><div class="sub">lifetime value of those due</div></div>
      <div class="kpi"><div class="lbl">On the horizon</div><div class="val">${k.upcoming}</div><div class="sub">due in the next few weeks</div></div>
    </div>

    <div class="card">
      <div class="card-h"><h3>Time to reach out</h3><div class="spacer"></div>
        <span class="dim" style="font-size:11.5px">learned from each customer's own order rhythm</span></div>
      <div class="card-b" id="ro-body">
        ${d.candidates.length
          ? `<div class="ro-list">${d.candidates.map(card).join('')}</div>`
          : empty('⊛', 'Nobody\'s due just yet', 'As customers build up order history, the ones due for a reorder surface here automatically, ranked by what they\'re worth. Nothing to chase today.', '<a class="btn" href="#/estimates">Go to estimates</a>')}
      </div>
    </div>
    ${d.snoozed?.length ? `<div class="card" style="margin-top:16px">
      <div class="card-h"><h3>Snoozed</h3><div class="spacer"></div>
        <span class="dim" style="font-size:11.5px">hidden from the list above — bring one back any time</span></div>
      <div class="card-b" id="ro-snoozed">${d.snoozed.map((sz) => `<div class="row" style="gap:10px;align-items:center;padding:7px 0;border-bottom:1px solid var(--line)">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:13px">${esc(sz.name || 'Customer')}${sz.company ? ` <span class="dim" style="font-weight:400">· ${esc(sz.company)}</span>` : ''}</div>
          <div class="dim" style="font-size:11.5px">back on the radar ${esc(sz.until)}${sz.lifetime_value ? ` · ${money0(sz.lifetime_value)} lifetime` : ''}</div>
        </div>
        <button class="btn ghost sm" data-unsnooze="${sz.contact_id}">Bring back</button>
      </div>`).join('')}</div>
    </div>` : ''}
    ${d.candidates.length ? '<p class="dim" style="font-size:11.5px;text-align:center;margin-top:12px">Dates are predicted from each customer\'s own order intervals. A customer who reorders every 90 days shows up around day 90, not on a fixed schedule.</p>' : ''}`

  // #view outlives every render, so delegations hang off #ro-body, rebuilt each pass so listeners die with it
  on($('#ro-body'), '[data-nudge]', async (_e, t) => {
    t.disabled = true; t.textContent = 'Sending…'
    try {
      const r = await api.post(`/api/reorders/${t.dataset.nudge}/nudge`)
      toast(r.delivered ? 'Reorder nudge sent' : 'Drafted to Outbox (Manual mode)')
      const c = t.closest('.ro-card'); if (c) { c.style.opacity = '.5'; t.textContent = r.delivered ? 'Sent ✓' : 'Drafted ✓' }
    } catch (e) { toast(e.message, true); t.disabled = false; t.textContent = 'Send nudge' }
  })
  on($('#ro-body'), '[data-snooze]', async (_e, t) => {
    t.disabled = true
    try { await api.post(`/api/reorders/${t.dataset.snooze}/snooze`, { days: 30 }); toast('Snoozed for 30 days'); reorderView() }
    catch (e) { toast(e.message, true); t.disabled = false }
  })
  // The way back. POST /api/reorders/:id/unsnooze has existed since the snooze route beside it and
  // had no caller anywhere in public/ — so a mis-tap on the ghost button next to Send nudge, with
  // no confirm on either, hid the shop's biggest repeat account for 30 days and the only exit was
  // a sqlite3 UPDATE on settings.
  on($('#ro-snoozed'), '[data-unsnooze]', async (_e, t) => {
    t.disabled = true
    try { await api.post(`/api/reorders/${t.dataset.unsnooze}/unsnooze`, {}); toast('Back on the radar'); reorderView() }
    catch (e) { toast(e.message, true); t.disabled = false }
  })
}
