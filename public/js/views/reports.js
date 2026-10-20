import { api, $, esc, money, money0, setPage, empty, skeleton, shopLocale } from '../core.js'

/**
 * Reports: the "how did we do" screen. One date range drives everything — KPI tiles, twelve months
 * of invoiced vs collected, top customers, sales by decoration, sales tax by month — plus A/R aging
 * as of today. Every table downloads as CSV for the bookkeeper. Manager-only (the API enforces it).
 */

let visit = 0

const iso = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
const utc = (y, m, d) => new Date(Date.UTC(y, m, d))

/** The preset ranges, measured from the shop's own "today" as the server reports it. */
export function presets(today) {
  const [y, m] = today.split('-').map(Number)
  const q = Math.floor((m - 1) / 3) * 3
  return [
    ['month', 'This month', `${today.slice(0, 8)}01`, today],
    ['last_month', 'Last month', iso(utc(y, m - 2, 1)), iso(utc(y, m - 1, 0))],
    ['quarter', 'This quarter', iso(utc(y, q, 1)), today],
    ['year', 'This year', `${y}-01-01`, today],
  ]
}

const fmtMonth = (ym, style = 'short') => new Date(`${ym}-15T12:00:00`).toLocaleDateString(shopLocale(), { month: style, year: style === 'short' ? '2-digit' : 'numeric' })
const fmtDay = (d) => d ? new Date(`${d}T12:00:00`).toLocaleDateString(shopLocale(), { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

export async function reportsView() {
  const request = ++visit, route = location.hash
  const params = new URLSearchParams(route.split('?')[1] || '')
  const query = new URLSearchParams()
  for (const k of ['from', 'to']) if (params.get(k)) query.set(k, params.get(k))
  setPage('Reports')
  $('#view').innerHTML = skeleton('cards')
  let d
  try { d = await api.get('/api/reports' + (query.toString() ? '?' + query : '')) } catch (e) {
    if (request !== visit || route !== location.hash) return
    $('#view').innerHTML = empty('alert', 'Reports did not load', e.message, '<a class="btn ghost" href="#/reports">Back to this month</a>')
    return
  }
  if (request !== visit || route !== location.hash) return
  render(d, params.get('range') === 'custom')
}

function render(d, customOpen) {
  const range = `from=${encodeURIComponent(d.from)}&to=${encodeURIComponent(d.to)}`
  const csv = (kind, label = 'Download CSV') => `<a class="btn ghost sm" href="/api/reports/${kind}.csv?${range}" download>${label}</a>`
  const list = presets(d.today)
  const active = customOpen ? null : list.find(([, , f, t]) => f === d.from && t === d.to)?.[0]
  const s = d.summary
  setPage('Reports', `<a class="btn ghost" href="#/books">Books & A/R</a>`)

  $('#view').innerHTML = `<div class="rpt" id="rpt-page">
    <div class="rpt-bar">
      <div class="rpt-chips" role="group" aria-label="Date range">
        ${list.map(([key, label, f, t]) => `<a class="rpt-chip${active === key ? ' on' : ''}" href="#/reports?range=${key}&from=${f}&to=${t}"${active === key ? ' aria-current="true"' : ''}>${label}</a>`).join('')}
        <a class="rpt-chip${active ? '' : ' on'}" href="#/reports?range=custom&from=${d.from}&to=${d.to}"${active ? '' : ' aria-current="true"'}>Custom</a>
      </div>
      <form class="rpt-custom" id="rpt-custom"${active ? ' hidden' : ''}>
        <label for="rpt-from">From</label><input class="input" type="date" id="rpt-from" name="from" value="${esc(d.from)}" required>
        <label for="rpt-to">To</label><input class="input" type="date" id="rpt-to" name="to" value="${esc(d.to)}" required>
        <button class="btn primary sm">Apply</button>
      </form>
      <p class="rpt-range">${fmtDay(d.from)} – ${fmtDay(d.to)}</p>
    </div>

    <div class="kpis rpt-kpis">
      ${kpi('Invoiced', money0(s.invoiced), `${s.invoices} invoice${s.invoices === 1 ? '' : 's'} · avg ${money0(s.avg_order_value)}`)}
      ${kpi('Collected', money0(s.collected), 'Payments received, net of refunds', 'info')}
      ${kpi('Open A/R', money0(s.open_ar), s.overdue_ar > 0 ? `${money0(s.overdue_ar)} past due today` : 'Nothing past due', s.overdue_ar > 0 ? 'warn' : '')}
      ${kpi('Sales tax invoiced', money(s.sales_tax_invoiced), `${money(s.sales_tax_collected)} collected`)}
      ${kpi('Estimates won', String(s.estimates_won), `${s.win_rate == null ? 'No decisions yet' : s.win_rate + '% win rate'} · ${s.estimates_sent} sent`)}
      ${kpi('Jobs completed', String(s.jobs_completed), `${money0(s.estimates_won_value)} won before tax`)}
    </div>

    <section class="card rpt-card">
      <div class="card-h"><h3>Sales by month</h3><div class="spacer"></div>
        <span class="rpt-key"><i class="rpt-inv"></i>Invoiced</span><span class="rpt-key"><i class="rpt-col"></i>Collected</span>${csv('sales-by-month')}</div>
      <div class="card-b">${chart(d.sales_by_month)}</div>
    </section>

    <div class="rpt-cols">
      <section class="card rpt-card">
        <div class="card-h"><h3>Top customers</h3><div class="spacer"></div>${csv('sales-by-customer', d.customers_total > d.sales_by_customer.length ? `All ${d.customers_total} as CSV` : 'Download CSV')}</div>
        ${d.sales_by_customer.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Customer</th><th scope="col" class="num">Invoices</th><th scope="col" class="num">Invoiced</th><th scope="col" class="num">Collected</th></tr></thead><tbody>
          ${d.sales_by_customer.map((c) => `<tr><td>${c.contact_id ? `<a href="#/contacts/${c.contact_id}">${esc(c.name)}</a>` : esc(c.name)}${c.company ? `<div class="rpt-sub">${esc(c.company)}</div>` : ''}</td><td class="num">${c.invoices}</td><td class="num">${money(c.invoiced)}</td><td class="num">${money(c.collected)}</td></tr>`).join('')}
        </tbody></table></div>` : none('No invoices or payments in this range.')}
      </section>
      <section class="card rpt-card">
        <div class="card-h"><h3>Sales by decoration</h3><div class="spacer"></div>${csv('sales-by-decoration')}</div>
        ${d.sales_by_decoration.length ? `<div class="card-b rpt-deco">${d.sales_by_decoration.map((x) => `<div class="rpt-deco-row">
            <div class="rpt-deco-t"><span>${esc(x.decoration)}</span><span class="num">${money(x.sales)}</span></div>
            <div class="rpt-meter" role="img" aria-label="${esc(x.decoration)}: ${x.share}% of sales"><i style="width:${Math.max(0, Math.min(100, x.share))}%"></i></div>
            <div class="rpt-sub">${x.share}% of sales before tax</div></div>`).join('')}</div>` : none('Nothing invoiced in this range.')}
      </section>
    </div>

    <section class="card rpt-card">
      <div class="card-h"><h3>A/R aging</h3><span class="rpt-sub rpt-asof">as of ${fmtDay(d.ar_aging.as_of)}</span><div class="spacer"></div>${csv('ar-aging')}</div>
      <div class="rpt-aging">${d.ar_aging.buckets.map((b, i) => `<div class="rpt-bucket${b.total > 0 && i >= 3 ? ' bad' : b.total > 0 && i >= 1 ? ' warn' : ''}"><div class="rpt-bucket-l">${esc(b.label)}</div><div class="rpt-bucket-v">${money0(b.total)}</div><div class="rpt-sub">${b.count} invoice${b.count === 1 ? '' : 's'}</div></div>`).join('')}</div>
      ${d.ar_aging.total > 0 ? `<div class="rpt-aging-lists">${d.ar_aging.buckets.filter((b) => b.count).map((b) => `<details class="rpt-details"${b.key === 'd90p' || b.key === 'd90' ? ' open' : ''}>
        <summary><span>${esc(b.label)}</span><span class="num">${money(b.total)} · ${b.count}</span></summary>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Invoice</th><th scope="col">Customer</th><th scope="col">Due</th><th scope="col" class="num">Days late</th><th scope="col" class="num">Balance</th></tr></thead><tbody>
        ${b.invoices.map((i) => `<tr><td><a href="#/invoices/${i.id}">${esc(i.number || '#' + i.id)}</a></td><td>${i.contact_id ? `<a href="#/contacts/${i.contact_id}">${esc(i.customer)}</a>` : esc(i.customer)}</td><td>${fmtDay(i.due_date)}</td><td class="num">${i.days_past || '—'}</td><td class="num">${money(i.balance)}</td></tr>`).join('')}
        </tbody></table></div></details>`).join('')}</div>` : none('Every invoice is paid. Nobody owes you anything right now.')}
    </section>

    <section class="card rpt-card">
      <div class="card-h"><h3>Sales tax</h3><div class="spacer"></div>${csv('sales-tax')}</div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Month</th><th scope="col" class="num">Sales before tax</th><th scope="col" class="num">Taxable</th><th scope="col" class="num">Exempt</th><th scope="col" class="num">Tax invoiced</th><th scope="col" class="num">Tax collected</th></tr></thead><tbody>
        ${d.sales_tax.map((m) => `<tr><td>${esc(fmtMonth(m.month, 'long'))}</td><td class="num">${money(m.sales)}</td><td class="num">${money(m.taxable_sales)}</td><td class="num">${money(m.exempt_sales)}</td><td class="num">${money(m.tax)}</td><td class="num">${money(m.tax_collected)}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="rpt-note">Tax comes from each invoice's estimate. Imported invoices without a tax breakdown count as untaxed. Tax collected is each payment's share of its invoice's tax.</p>
    </section>
  </div>`

  const form = $('#rpt-custom')
  if (form) form.onsubmit = (e) => {
    e.preventDefault()
    const f = form.elements.from.value, t = form.elements.to.value
    if (!f || !t) return
    const [from, to] = f <= t ? [f, t] : [t, f]
    const next = `#/reports?range=custom&from=${from}&to=${to}`
    if (location.hash === next) reportsView()
    else location.hash = next
  }
}

const kpi = (label, value, sub, tone = '') => `<div class="kpi${tone ? ' ' + tone : ''}"><div class="lbl">${esc(label)}</div><div class="val">${esc(value)}</div><div class="sub">${esc(sub)}</div></div>`
const none = (msg) => `<p class="rpt-none">${esc(msg)}</p>`

/** Twelve months of invoiced vs collected as paired bars — the same inline-SVG approach as Today's pulse card. */
export function chart(months) {
  const W = 720, H = 190, pad = 18, n = months.length || 1
  const max = Math.max(1, ...months.flatMap((m) => [m.invoiced, m.collected]))
  const slot = (W - pad * 2) / n, bw = Math.max(4, slot * 0.3)
  const base = H - 24
  const y = (v) => base - (Math.max(0, v) / max) * (H - 44)
  const bars = months.map((m, k) => {
    const x = pad + k * slot + slot / 2
    const label = fmtMonth(m.month)
    return `<g><title>${esc(fmtMonth(m.month, 'long'))}: ${esc(money0(m.invoiced))} invoiced, ${esc(money0(m.collected))} collected</title>
      <rect class="rpt-inv" x="${(x - bw - 1).toFixed(1)}" y="${y(m.invoiced).toFixed(1)}" width="${bw.toFixed(1)}" height="${(base - y(m.invoiced)).toFixed(1)}" rx="2"/>
      <rect class="rpt-col${k === n - 1 ? ' now' : ''}" x="${(x + 1).toFixed(1)}" y="${y(m.collected).toFixed(1)}" width="${bw.toFixed(1)}" height="${(base - y(m.collected)).toFixed(1)}" rx="2"/>
      <text x="${x.toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(label)}</text></g>`
  }).join('')
  const top = `<text class="rpt-max" x="${pad}" y="12">${esc(money0(max))}</text><line class="rpt-axis" x1="${pad}" x2="${W - pad}" y1="${base}" y2="${base}"/>`
  return `<svg class="rpt-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Invoiced and collected per month, last ${months.length} months">${top}${bars}</svg>`
}
