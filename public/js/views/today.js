import { api, $, esc, money0, setPage, empty, skeleton, shopLocale } from '../core.js'
import { taskTiles } from '../shared/tasks.js'

/**
 * Home. It leads with the question a shop actually arrives with — "what do you want to do?" — as a
 * set of big, plainly-worded tiles (shared/tasks.js), then the ranked "needs you" queue, then the
 * numbers. It used to open on four KPI tiles and a twelve-week chart, which answer "how is the
 * shop doing?" — a fine question, and never the first one.
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

/** A brand-new shop: the tiles above are the way in; this only says where to begin. */
const startNote = () => `<p class="home-first">Your pricing is already set up, so there’s nothing to configure first. Most shops start with an estimate.
  <a href="#/settings">Add your logo and shop details →</a></p>`

export async function todayView() {
  setPage('Home')
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

  const first = isFirstRun(lite, counts)
  const pulse = lite ? litePulse(p, counts) : `<div class="tdy-pulse">
      <a class="tdy-stat ${p.money_at_risk > 0 ? 'bad' : ''}" href="#/invoices"><div class="tdy-stat-v">${money0(p.money_at_risk)}</div><div class="tdy-stat-l">Money at risk</div></a>
      <a class="tdy-stat ${p.jobs_at_risk ? 'warn' : ''}" href="#/capacity"><div class="tdy-stat-v">${p.jobs_at_risk}</div><div class="tdy-stat-l">Deadlines slipping</div></a>
      <a class="tdy-stat ${p.approvals ? 'warn' : ''}" href="#/art"><div class="tdy-stat-v">${p.approvals}</div><div class="tdy-stat-l">Proofs waiting</div></a>
      <a class="tdy-stat" href="#/board"><div class="tdy-stat-v">${p.due_week}</div><div class="tdy-stat-l">Due in 7 days${p.overdue_jobs ? ` · ${p.overdue_jobs} overdue` : ''}</div></a>
    </div>`

  $('#view').innerHTML = `
    <div class="tdy-head">
      <h1>${greet}${name ? ', ' + esc(name) : ''}</h1>
      <p class="tdy-date">${new Date(`${d.date}T12:00:00`).toLocaleDateString(shopLocale(), { weekday: 'long', month: 'long', day: 'numeric' })}${d.role !== 'owner' ? ` · <span class="dim">${esc(d.role)}</span>` : ''}</p>
    </div>

    <section class="home-launch" aria-labelledby="home-q">
      <h2 id="home-q" class="home-q">${first ? 'Let\'s get your first job in' : 'What do you want to do?'}</h2>
      ${taskTiles(me, lite ? 'lite' : 'pro')}
      ${first ? startNote() : ''}
    </section>

    ${first ? '' : `<div class="card">
      <div class="card-h"><h3>Needs you today</h3><div class="spacer"></div>
        <span class="dim" style="font-size:12px">most urgent first</span></div>
      <div class="card-b">
        ${d.actions.length ? `<div class="tdy-list">${d.actions.map(row).join('')}</div>`
          : empty('check', "You're all caught up", lite ? 'No overdue invoices and no estimates waiting. Nice.' : 'No overdue money, no slipping deadlines, no proofs waiting. Nice.')}
      </div>
    </div>`}

    <h2 class="home-sub">How the shop is doing</h2>
    ${pulse}
    ${!lite && me.can_manage !== false && !first ? '<div id="tdy-insights"></div>' : ''}`
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
