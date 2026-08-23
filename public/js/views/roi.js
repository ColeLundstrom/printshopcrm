import { api, $, $$, esc, money, money0, setPage, empty, on, go } from '../core.js'

/**
 * Job Profitability: real revenue vs. real cost on every
 * job, so a shop finds a money-loser the day they quote it, not months later on the P&L.
 */
let sortBy = 'margin'

export async function roiView() {
  setPage('Profitability', `<a class="btn ghost" href="/api/export/quickbooks.iif" download>Export to QuickBooks</a>`)
  $('#view').innerHTML = '<div class="dim">Costing every job…</div>'
  const d = await api.get('/api/roi')
  const t = d.totals

  const verdictPill = (r) => `<span class="pill ${r.verdict.level === 'good' ? 'green' : r.verdict.level === 'warn' ? 'amber' : 'red'}">${r.margin}%</span>`
  const sorted = [...d.jobs].sort((a, b) => sortBy === 'profit' ? b.profit - a.profit : sortBy === 'revenue' ? b.revenue - a.revenue : a.margin - b.margin)

  $('#view').innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="lbl">Revenue</div><div class="val">${money0(t.revenue)}</div><div class="sub">${t.count} costed jobs</div></div>
      <div class="kpi bad"><div class="lbl">Cost to produce</div><div class="val">${money0(t.cost)}</div><div class="sub">blanks · labor · screens</div></div>
      <div class="kpi"><div class="lbl">Profit</div><div class="val">${money0(t.profit)}</div><div class="sub">what you actually keep</div></div>
      <div class="kpi ${t.margin < 40 ? 'warn' : ''}"><div class="lbl">Avg margin</div><div class="val">${t.margin}%</div>
        <div class="sub">${t.losers ? `<span style="color:var(--red)">${t.losers} losing money</span> · ` : ''}${t.thin} thin</div></div>
    </div>

    ${t.losers || t.thin ? `<div class="card" style="border-color:${t.losers ? 'rgba(255,95,109,.4)' : 'rgba(247,185,85,.4)'};margin-bottom:16px">
      <div class="card-b" style="font-size:13px">
        ${t.losers ? `<strong style="color:var(--red)">⚠ ${t.losers} job${t.losers === 1 ? '' : 's'} losing money.</strong> ` : ''}
        ${t.thin ? `<strong style="color:var(--amber)">${t.thin} under 25% margin.</strong> ` : ''}
        These are priced too low for what they cost you. Raise the price or the quantity next time. Sorted worst-first below.
      </div></div>` : `<div class="card" style="border-color:rgba(16,211,154,.3);margin-bottom:16px"><div class="card-b" style="font-size:13px">
        <strong style="color:var(--accent)">✓ Every job is profitable.</strong> Nothing under 25% margin.</div></div>`}

    <div class="card">
      <div class="card-h"><h3>Every job, costed</h3><div class="spacer"></div>
        <div class="tabs" id="roi-sort">
          <button data-s="margin" class="${sortBy === 'margin' ? 'on' : ''}">By margin</button>
          <button data-s="profit" class="${sortBy === 'profit' ? 'on' : ''}">By profit</button>
          <button data-s="revenue" class="${sortBy === 'revenue' ? 'on' : ''}">By revenue</button>
        </div></div>
      ${d.jobs.length ? `<table class="tbl">
        <thead><tr><th>Job</th><th class="num">Pieces</th><th class="num">Revenue</th><th class="num">Cost</th><th class="num">Profit</th><th class="num">Margin</th></tr></thead>
        <tbody>${sorted.map((r) => `<tr class="click" data-job="${r.job_id}">
          <td><div style="font-weight:600">${esc(r.title)}</div><div class="mono">${esc(r.job_number)}${!r.blank_matched ? ' · <span class="dim" title="No catalog match, cost estimated">est. cost</span>' : ''}</div></td>
          <td class="num">${r.pieces}</td>
          <td class="num">${money(r.revenue)}</td>
          <td class="num muted">${money(r.cost)}</td>
          <td class="num"><strong style="color:${r.profit >= 0 ? 'var(--txt)' : 'var(--red)'}">${money(r.profit)}</strong></td>
          <td class="num">${verdictPill(r)}</td>
        </tr>`).join('')}</tbody></table>`
        : empty('◲', 'No costed jobs yet', 'Convert an estimate to a job and its profitability shows here.', '<a class="btn" href="#/estimates">Go to estimates</a>')}
    </div>

    <div class="cols" style="margin-top:16px">
      <div class="card"><div class="card-h"><h3>Most profitable</h3></div>
        ${roiList(d.best)}</div>
      <div class="card"><div class="card-h"><h3>${t.losers ? '✗' : t.below_target ? '⚠' : '✓'} Below your ${t.target}% target</h3>${d.worst.length ? `<div class="spacer"></div><span class="pill ${t.losers ? 'red' : 'amber'}">${d.worst.length}</span>` : ''}</div>
        ${d.worst.length ? roiList(d.worst) : '<div class="card-b dim" style="font-size:12.5px">Every costed job is at or above your target margin. Nothing to watch.</div>'}</div>
    </div>

    <p class="dim" style="font-size:11.5px;margin-top:14px;text-align:center">Blank costs come from your garment catalog. Connect an <strong>S&amp;S Activewear</strong> or <strong>SanMar</strong> account in Settings for live wholesale pricing on every job.</p>`

  on($('#roi-sort'), '[data-s]', (_e, el) => { sortBy = el.dataset.s; roiView() })
  on($('#view'), '[data-job]', (_e, el) => go(`/jobs/${el.dataset.job}`))
}

const roiList = (rows) => rows.length ? `<table class="tbl"><tbody>${rows.map((r) => `
  <tr class="click" data-job="${r.job_id}">
    <td><div style="font-weight:600;font-size:12.5px">${esc(r.title)}</div><div class="mono">${esc(r.job_number)}</div></td>
    <td class="num"><strong>${money0(r.profit)}</strong></td>
    <td class="num"><span class="pill ${r.verdict.level === 'good' ? 'green' : r.verdict.level === 'warn' ? 'amber' : 'red'}">${r.margin}%</span></td>
  </tr>`).join('')}</tbody></table>` : '<div class="card-b dim">—</div>'
