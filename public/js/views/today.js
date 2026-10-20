import { api, $, esc, money0, setPage, empty, skeleton, shopLocale } from '../core.js'

/**
 * Today: the role-aware action center that replaces the flat dashboard. One ranked "do this next"
 * queue instead of a wall of equally-weighted counters: the highest-risk money and production items
 * float to the top, shaped to who's signed in. Owners/managers see money first; staff see the floor first.
 */

const KIND_TINT = { collect: 'var(--red)', risk: 'var(--amber)', approval: 'var(--violet)', floor: 'var(--blue)', reply: 'var(--accent)', followup: 'var(--accent)' }

/**
 * A shop with nothing in it at all. The generic "You're all caught up" is technically true here but
 * reads as a dead end, since a brand-new shop has no idea where to start, which is exactly the complaint
 * that prompted this. Nothing created yet → show the start card instead.
 */
// The onboarding demo seeds exactly one estimate and one contact, so "no rows at all" flipped to
// false the moment the owner ran the sample quote, and Today then showed "all caught up" with zero
// next actions. Keep the start card until there is real work: an invoice, or a second estimate or
// contact beyond the demo's one.
const isFirstRun = (_lite, c) => !!c && !c.jobs && !c.invoices && (c.estimates || 0) <= 1 && (c.contacts || 0) <= 1

/** Lite tiles: money and paperwork only. The pro version links to /capacity, /art and /board, none
 *  of which exist in this edition, so those tiles were dead ends. */
const litePulse = (p, c) => `<div class="tdy-pulse">
  <a class="tdy-stat ${p.money_at_risk > 0 ? 'bad' : ''}" href="#/invoices"><div class="tdy-stat-v">${money0(p.money_at_risk)}</div><div class="tdy-stat-l">Money at risk</div></a>
  <a class="tdy-stat" href="#/invoices"><div class="tdy-stat-v">${c ? c.open : 0}</div><div class="tdy-stat-l">Unpaid invoices</div></a>
  <a class="tdy-stat" href="#/estimates"><div class="tdy-stat-v">${c ? c.estimates : 0}</div><div class="tdy-stat-l">Estimates</div></a>
  <a class="tdy-stat" href="#/contacts"><div class="tdy-stat-v">${c ? c.contacts : 0}</div><div class="tdy-stat-l">Customers</div></a>
</div>`

/** The first thing a brand-new shop should see: three things it can actually do, right now. */
const startCard = (lite) => `<div class="card">
  <div class="card-h"><h3>Let's get your first job in</h3></div>
  <div class="card-b">
    <p class="dim" style="font-size:13.5px;margin:0 0 16px;line-height:1.6">Your pricing is already set up, so there's nothing to configure first. Start wherever you like. Most shops start by adding the customer.</p>
    <div class="tdy-start">
      ${(lite ? [
        ['/contacts', '◉', 'Add a customer', 'Name and email is enough to start.'],
        ['/estimates', '▤', 'Send an estimate', 'Quote a job and email it as a link.'],
        ['/invoices', '▣', 'Create an invoice', 'Bill a job and take card payment.'],
      ] : [
        ['/contacts', '◉', 'Add a customer', 'Name and email is enough to start.'],
        ['/estimates', '▤', 'Quote a job', 'Per-size pricing, sent as a link they approve.'],
        ['/pricing', '⊞', 'Check your pricing', 'See the margin on every quantity and colour.'],
      ]).map(([href, ico, title, sub]) => `<a class="tdy-start-a" href="#${href}">
        <span class="tdy-start-ic">${ico}</span>
        <span class="tdy-start-t">${title}</span>
        <span class="tdy-start-s">${sub}</span>
        <span class="tdy-start-go">Start →</span></a>`).join('')}
    </div>
    <p class="dim" style="font-size:12.5px;margin:16px 0 0">Want your logo and shop details on what you send? <a href="#/settings">Finish your shop profile →</a></p>
  </div>
</div>`

export async function todayView() {
  setPage('Today', '<a class="btn primary" href="#/estimates/new">New estimate</a>')
  // The router paints this on entry too; a direct re-run must not leave a stale "caught up" on
  // screen while it fetches (or after the fetch fails).
  $('#view').innerHTML = skeleton('cards')
  const me = window.__me || {}
  const lite = window.__EDITION === 'lite'
  // One tenant-scoped response supplies both the work queue and onboarding/tile counts.
  const d = await api.get('/api/today')
  const counts = d.counts

  const hour = new Date().getHours()
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  const name = (me.member?.name || me.shop_name || '').split(' ')[0]
  const p = d.pulse

  const row = (a, i) => `<a class="tdy-item ${i === 0 ? 'lead' : ''}" href="${a.href}">
    <span class="tdy-ic" style="background:var(--panel-2);color:${KIND_TINT[a.kind] || 'var(--txt-2)'}"><svg viewBox="0 0 16 16" aria-hidden="true"><use href="#i-${({ collect: 'invoices', risk: 'capacity', approval: 'art', floor: 'board', reply: 'conversations', followup: 'followups' })[a.kind] || 'today'}"></use></svg></span>
    <span class="tdy-txt"><span class="tdy-t">${esc(a.title)}</span><span class="tdy-s">${esc(a.sub)}</span></span>
    <span class="tdy-go">→</span></a>`

  $('#view').innerHTML = `
    <div class="tdy-head">
      <h1>${greet}${name ? ', ' + esc(name) : ''}</h1>
      <p class="tdy-date">${new Date(`${d.date}T12:00:00`).toLocaleDateString(shopLocale(), { weekday: 'long', month: 'long', day: 'numeric' })}${d.role !== 'owner' ? ` · <span class="dim">${esc(d.role)}</span>` : ''}</p>
    </div>

    ${lite ? litePulse(p, counts) : `<div class="tdy-pulse">
      <a class="tdy-stat ${p.money_at_risk > 0 ? 'bad' : ''}" href="#/invoices"><div class="tdy-stat-v">${money0(p.money_at_risk)}</div><div class="tdy-stat-l">Money at risk</div></a>
      <a class="tdy-stat ${p.jobs_at_risk ? 'warn' : ''}" href="#/capacity"><div class="tdy-stat-v">${p.jobs_at_risk}</div><div class="tdy-stat-l">Deadlines slipping</div></a>
      <a class="tdy-stat ${p.approvals ? 'warn' : ''}" href="#/art"><div class="tdy-stat-v">${p.approvals}</div><div class="tdy-stat-l">Proofs waiting</div></a>
      <a class="tdy-stat" href="#/board"><div class="tdy-stat-v">${p.due_week}</div><div class="tdy-stat-l">Due in 7 days${p.overdue_jobs ? ` · ${p.overdue_jobs} overdue` : ''}</div></a>
    </div>`}
    ${!lite && me.can_manage !== false && !isFirstRun(lite, counts) ? '<div id="tdy-insights"></div>' : ''}

    ${isFirstRun(lite, counts) ? startCard(lite) : `<div class="card">
      <div class="card-h"><h3>Do this next</h3><div class="spacer"></div>
        <span class="dim" style="font-size:12px">ranked by what's most at stake</span></div>
      <div class="card-b">
        ${d.actions.length ? `<div class="tdy-list">${d.actions.map(row).join('')}</div>`
          : empty('check', "You're all caught up", lite ? 'No overdue invoices and no estimates waiting. Nice.' : 'No overdue money, no slipping deadlines, no proofs waiting. Nice.')}
      </div>
    </div>`}`
  // Action items are plain <a href="#/…"> links; the hash router handles them, no JS click handler needed.
  // The trend card loads after the queue paints: the queue is the job, the trends are context.
  if ($('#tdy-insights')) api.get('/api/insights').then((i) => { const m = $('#tdy-insights'); if (m) m.innerHTML = insightsCard(i) }).catch(() => $('#tdy-insights')?.remove())
}

/** Twelve weeks of collected vs. won as paired bars, plus the three numbers that say how it's going. */
export function insightsCard(i) {
  const W = 600, H = 150, pad = 18, n = i.weeks.length
  const max = Math.max(1, ...i.weeks.flatMap((w) => [w.collected, w.won]))
  const slot = (W - pad * 2) / n, bw = Math.max(4, slot * 0.32)
  const y = (v) => H - 22 - (v / max) * (H - 40)
  const loc = shopLocale()
  const bars = i.weeks.map((w, k) => {
    const x = pad + k * slot + slot / 2
    const label = new Date(`${w.start}T12:00:00`).toLocaleDateString(loc, { month: 'short', day: 'numeric' })
    return `<g><title>Week of ${esc(label)}: ${esc(money0(w.collected))} collected, ${esc(money0(w.won))} won</title>
      <rect class="ins-won" x="${(x - bw - 1).toFixed(1)}" y="${y(w.won).toFixed(1)}" width="${bw.toFixed(1)}" height="${(H - 22 - y(w.won)).toFixed(1)}" rx="2"/>
      <rect class="ins-col${k === n - 1 ? ' now' : ''}" x="${(x + 1).toFixed(1)}" y="${y(w.collected).toFixed(1)}" width="${bw.toFixed(1)}" height="${(H - 22 - y(w.collected)).toFixed(1)}" rx="2"/>
      ${k % 2 === n % 2 ? '' : `<text x="${x.toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(label)}</text>`}</g>`
  }).join('')
  const change = i.collected_change_pct
  const margin = i.margin_completed
  return `<div class="card ins-card">
    <div class="card-h"><h3>Shop pulse</h3><div class="spacer"></div>
      <span class="ins-key"><i class="ins-won"></i>Won</span><span class="ins-key"><i class="ins-col"></i>Collected</span></div>
    <div class="ins-body">
      <div class="ins-figs">
        <a class="ins-fig" href="#/invoices"><span class="ins-v">${money0(i.collected_4w)}</span><span class="ins-l">Collected, last 4 weeks</span>
          ${change == null ? '' : `<span class="ins-d ${change >= 0 ? 'up' : 'down'}">${change >= 0 ? '▲' : '▼'} ${Math.abs(change)}% vs prior 4</span>`}</a>
        <a class="ins-fig" href="#/pipeline"><span class="ins-v">${i.win_rate_90d == null ? '—' : i.win_rate_90d + '%'}</span><span class="ins-l">Quotes won, 90 days</span>
          <span class="ins-d">${i.open_quotes_90d} still open</span></a>
        <a class="ins-fig" href="#/roi"><span class="ins-v ${margin == null ? '' : margin >= i.margin_target ? 'good' : margin >= 25 ? 'warn' : 'bad'}">${margin == null ? '—' : margin + '%'}</span><span class="ins-l">Margin kept on finished jobs</span>
          <span class="ins-d">target ${i.margin_target}% · ${i.jobs_measured} job${i.jobs_measured === 1 ? '' : 's'}</span></a>
      </div>
      <svg class="ins-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Collected and won per week, last ${n} weeks">${bars}</svg>
    </div>
  </div>`
}
