import { api, $, esc, money0, setPage, go, empty, shopLocale } from '../core.js'

/**
 * Today: the role-aware action center that replaces the flat dashboard. One ranked "do this next"
 * queue instead of a wall of equally-weighted counters: the highest-risk money and production items
 * float to the top, shaped to who's signed in. Owners/managers see money first; staff see the floor first.
 */

const KIND_TINT = { collect: 'var(--red)', risk: 'var(--amber)', approval: 'var(--violet)', floor: 'var(--blue)', reply: 'var(--accent)', followup: 'var(--accent)' }

/** Rows for the lite tiles + the first-run test. One call each, and a failure just reads as zero. */
async function liteCounts() {
  const len = (v, key) => (Array.isArray(v) ? v.length : (v?.[key] || []).length)
  const [inv, est, con] = await Promise.all([
    api.get('/api/invoices').catch(() => []),
    api.get('/api/estimates').catch(() => []),
    api.get('/api/contacts').catch(() => []),
  ])
  const invoices = Array.isArray(inv) ? inv : (inv.invoices || [])
  return {
    invoices: invoices.length,
    open: invoices.filter((i) => Number(i.amount_due) - Number(i.amount_paid) > 0.005).length,
    estimates: len(est, 'estimates'),
    contacts: len(con, 'contacts'),
  }
}

/**
 * A shop with nothing in it at all. The generic "You're all caught up" is technically true here but
 * reads as a dead end, since a brand-new shop has no idea where to start, which is exactly the complaint
 * that prompted this. Nothing created yet → show the start card instead.
 */
// The onboarding demo seeds exactly one estimate and one contact, so "no rows at all" flipped to
// false the moment the owner ran the sample quote, and Today then showed "all caught up" with zero
// next actions. Keep the start card until there is real work: an invoice, or a second estimate or
// contact beyond the demo's one.
const isFirstRun = (_lite, c) => !!c && !c.invoices && (c.estimates || 0) <= 1 && (c.contacts || 0) <= 1

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
  setPage('Today', '<a class="btn" href="#/estimates/new">New estimate</a>')
  $('#view').innerHTML = '<div class="dim">Loading your day…</div>'
  const me = window.__me || {}
  const lite = window.__EDITION === 'lite'
  // In lite there is no production floor, so the day is only about money and paperwork. Fetch the
  // counts that decide whether this is a brand-new shop (which needs a start card, not an empty
  // "all caught up") and what the tiles should say.
  const [d, counts] = await Promise.all([api.get('/api/today'), liteCounts()])

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
      <a class="tdy-stat" href="#/board"><div class="tdy-stat-v">${p.due_week}</div><div class="tdy-stat-l">Due this week</div></a>
    </div>`}

    ${isFirstRun(lite, counts) ? startCard(lite) : `<div class="card">
      <div class="card-h"><h3>Do this next</h3><div class="spacer"></div>
        <span class="dim" style="font-size:12px">ranked by what's most at stake</span></div>
      <div class="card-b">
        ${d.actions.length ? `<div class="tdy-list">${d.actions.map(row).join('')}</div>`
          : empty('✓', "You're all caught up", lite ? 'No overdue invoices and no estimates waiting. Nice.' : 'No overdue money, no slipping deadlines, no proofs waiting. Nice.')}
      </div>
    </div>`}`
  // Action items are plain <a href="#/…"> links; the hash router handles them, no JS click handler needed.
}
