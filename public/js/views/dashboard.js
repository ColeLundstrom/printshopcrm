import { api, $, el, esc, money0, money, fmtDate, relTime, pill, setPage, empty, dueClass, dueLabel, go, onOnce, skeleton, store } from '../core.js'

const ICON = { estimate: '▤', invoice: '▣', payment: '⊕', job: '▦', stage: '→', art: '◈', contact: '◉', note: '✎' }

export async function dashboardView() {
  setPage('Dashboard', `<button class="btn" id="new-est">+ New Estimate</button>`)
  $('#view').innerHTML = skeleton('dashboard')
  const [d, ob] = await Promise.all([api.get('/api/dashboard'), api.get('/api/onboarding').catch(() => null)])
  const k = d.kpis

  const jobRow = (j) => `<tr class="click" data-job="${j.id}">
    <td><div style="font-weight:600">${esc(j.title)}</div><div class="mono">${esc(j.job_number)}</div></td>
    <td class="muted">${esc(j.contact_name || '—')}</td>
    <td><span class="tag">${esc(j.stage.replace('_', ' '))}</span></td>
    <td class="num"><span class="due ${dueClass(j.due_date)}" style="font-size:12px">${esc(dueLabel(j.due_date))}</span></td>
  </tr>`

  $('#view').innerHTML = `
    ${setupCard(ob)}
    <div class="kpis">
      <div class="kpi"><div class="lbl">Revenue MTD</div><div class="val">${money0(k.revenue_mtd)}</div><div class="sub">Payments received this month</div></div>
      <div class="kpi warn"><div class="lbl">Outstanding</div><div class="val">${money0(k.outstanding)}</div><div class="sub">${k.overdue > 0 ? `<span style="color:var(--red)">${money0(k.overdue)} overdue</span>` : 'Nothing overdue'}</div></div>
      <div class="kpi info"><div class="lbl">Open Estimates</div><div class="val">${money0(k.open_estimates)}</div><div class="sub">Quoted, not yet approved</div></div>
      <div class="kpi ${k.due_this_week > 0 ? 'bad' : ''}"><div class="lbl">On the Floor</div><div class="val">${k.active_jobs}</div><div class="sub">${k.due_this_week} due within 7 days</div></div>
    </div>

    <div class="rollup">
      <a class="rup" href="#/pipeline">
        <div class="rup-ic" style="color:var(--violet)">◱</div>
        <div><div class="rup-v">${money0(d.pipeline?.open_value || 0)}</div><div class="rup-l">Open pipeline · ${d.pipeline?.win_rate == null ? '—' : d.pipeline.win_rate + '% win'}</div></div>
      </a>
      <a class="rup" href="#/conversations">
        <div class="rup-ic" style="color:var(--blue)">▭</div>
        <div><div class="rup-v">${d.inbox?.unread || 0}${d.inbox?.unread ? ' <span class="rup-dot"></span>' : ''}</div><div class="rup-l">Unread message${d.inbox?.unread === 1 ? '' : 's'}</div></div>
      </a>
      <a class="rup" href="#/automations">
        <div class="rup-ic" style="color:var(--accent)">⟳</div>
        <div><div class="rup-v">${d.automations_week || 0}</div><div class="rup-l">Auto-actions this week</div></div>
      </a>
    </div>

    ${d.at_risk?.length ? `<div class="card riskcard">
      <div class="card-h"><h3>⚠ Deadlines at risk — waiting on customer approval</h3><div class="spacer"></div>
        <span class="pill red">${d.at_risk.length}</span></div>
      <table class="tbl"><thead><tr><th>Job</th><th>Customer</th><th>Promised</th><th>Really lands</th><th class="num">Proof sitting</th></tr></thead>
      <tbody>${d.at_risk.map((j) => `<tr class="click" data-job="${j.id}">
        <td><div style="font-weight:600">${esc(j.title)}</div><div class="mono">${esc(j.job_number)}${j.rush ? ' · <span style="color:var(--red)">RUSH</span>' : ''}</div></td>
        <td class="muted">${esc(j.contact_name || '—')}</td>
        <td><span style="text-decoration:line-through;color:var(--txt-3)">${fmtDate(j.due_date)}</span></td>
        <td><strong style="color:var(--amber)">${fmtDate(j.projected_due)}</strong> <span class="dim" style="font-size:11px">+${j.slip}d</span></td>
        <td class="num">${j.waiting_days != null ? `<span style="color:${j.waiting_days >= 2 ? 'var(--red)' : 'var(--txt-2)'}">${j.waiting_days} day${j.waiting_days === 1 ? '' : 's'}</span>` : '<span class="dim">no proof sent</span>'}</td>
      </tr>`).join('')}</tbody></table>
      <div class="card-b" style="border-top:1px solid var(--line);padding:10px 16px">
        <span class="dim" style="font-size:11.5px">Turnaround starts at art approval, not at order. These dates already slipped — the customer just doesn't know yet.</span>
      </div>
    </div>` : ''}

    <div class="cols">
      <div class="stack">
        <div class="card">
          <div class="card-h"><h3>Due Today</h3><div class="spacer"></div><a class="btn ghost sm" href="#/board">Open board</a></div>
          ${d.due_today.length ? `<table class="tbl"><tbody>${d.due_today.map(jobRow).join('')}</tbody></table>`
            : empty('◎', 'Nothing due today', 'The floor is clear. Check upcoming work below.')}
        </div>

        <div class="card">
          <div class="card-h"><h3>Upcoming Deadlines</h3></div>
          ${d.upcoming.length ? `<table class="tbl">
            <thead><tr><th>Job</th><th>Customer</th><th>Stage</th><th class="num">Due</th></tr></thead>
            <tbody>${d.upcoming.map(jobRow).join('')}</tbody></table>`
            : empty('▦', 'No scheduled work', 'Approve an estimate to put a job on the board.')}
        </div>

        ${d.awaiting_art.length ? `<div class="card">
          <div class="card-h"><h3>Waiting on Customer Art Approval</h3><div class="spacer"></div><span class="pill amber">${d.awaiting_art.length} stuck</span></div>
          <table class="tbl"><tbody>${d.awaiting_art.map(jobRow).join('')}</tbody></table></div>` : ''}
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-h"><h3>Outstanding Invoices</h3><div class="spacer"></div><a class="btn ghost sm" href="#/invoices">All</a></div>
          ${d.outstanding_invoices.length ? `<table class="tbl"><tbody>${d.outstanding_invoices.map((i) => `
            <tr class="click" data-inv="${i.id}">
              <td><div class="mono">${esc(i.invoice_number)}</div><div style="font-size:12px" class="muted">${esc(i.contact_name || '')}</div></td>
              <td>${pill(i.status)}</td>
              <td class="num"><strong>${money(i.amount_due - i.amount_paid)}</strong><div class="dim" style="font-size:11px">due ${fmtDate(i.due_date)}</div></td>
            </tr>`).join('')}</tbody></table>`
            : empty('✓', 'All paid up', 'No open balances.')}
        </div>

        <div class="card">
          <div class="card-h"><h3>Recent Activity</h3><div class="spacer"></div><a class="btn ghost sm" href="#/activity">All</a></div>
          <div class="card-b">
            ${d.activity.length ? `<div class="tl">${d.activity.map((a) => `
              <div class="tl-i ${['stage', 'note'].includes(a.type) ? 'gray' : ''}">
                <div class="tx">${ICON[a.type] || '•'} ${esc(a.description)}</div>
                <div class="dt">${relTime(a.created_at)}${a.contact_name ? ` · ${esc(a.contact_name)}` : ''}</div>
              </div>`).join('')}</div>` : '<div class="dim">No activity yet.</div>'}
          </div>
        </div>
      </div>
    </div>`

  // #view is repainted, never replaced. A raw addEventListener on it stacked one more copy on
  // every visit to the dashboard — the most-visited screen in the app — so the fourth visit ran
  // go() four times per click. The existing gate rule looks for a delegated binding on #view, so
  // a raw addEventListener slipped past it. onOnce is keyed on (root, event, selector).
  onOnce($('#view'), '[data-job],[data-inv],[data-setup],#setup-dismiss', (e) => {
    const j = e.target.closest('[data-job]')
    if (j) return go(`/jobs/${j.dataset.job}`)
    const i = e.target.closest('[data-inv]')
    if (i) return go(`/invoices/${i.dataset.inv}`)
    if (e.target.closest('[data-setup]')) return go('/welcome')
    if (e.target.closest('#setup-dismiss')) { store.set('psc-setup-dismissed', '1'); $('.setup-card')?.remove() }
  })
  $('#new-est').onclick = () => go('/estimates/new')
}

/** A resumable "finish setting up" card — shows remaining steps as chips until setup is complete. */
function setupCard(ob) {
  if (!ob?.onboarding || ob.onboarding.pct >= 100) return ''
  if (store.get('psc-setup-dismissed') === '1') return ''
  const steps = ob.onboarding.steps
  const chips = steps.map((s) => `<span class="setup-chip ${s.done ? 'done' : s.skipped ? 'skipped' : ''}" ${s.done ? '' : 'data-setup="1"'}>${s.done ? '✓' : s.skipped ? '–' : `<svg class="ico" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><use href="#i-${s.icon}"></use></svg>`} ${esc(s.title)}</span>`).join('')
  return `<div class="setup-card">
    <div class="setup-card-h"><h3>Finish setting up your shop</h3>
      <div class="spacer"></div><span class="dim" style="font-size:12px">${ob.onboarding.done}/${ob.onboarding.total}</span>
      <button class="btn ghost sm" data-setup="1" style="margin-left:10px">Resume →</button>
      <button class="x" id="setup-dismiss" title="Dismiss" aria-label="Dismiss the setup checklist" style="background:none;border:0;color:var(--txt-3);cursor:pointer;font-size:18px;margin-left:4px">&times;</button></div>
    <div class="setup-chips">${chips}</div>
  </div>`
}
