import { api, esc, money0, setPage, shopLocale } from '../core.js'

/**
 * Shop TV — a full-screen wallboard for the screen over the presses (or the booth monitor).
 *
 * It paints over the whole app as a fixed layer rather than inside #view, so the sidebar, topbar
 * and trial bar never show on the wall, and it tears itself down on the next navigation. Data is
 * GET /api/tv, refreshed every 20s and immediately on the realtime 'board'/'production' events
 * (app.js calls window.__pscTvRefresh). Each refresh diffs against the last snapshot so a job that
 * moved columns glows for a few seconds: on a wall, motion is what tells you something happened.
 */

const POLL_MS = 20000
let state = null // { timer, clock, idle, prev: Map(id -> stage), theme, root, onHash, onKey, onMove }

const dueText = (j, today) => {
  if (!j.due_date) return { cls: '', txt: 'No date' }
  if (j.late > 0) return { cls: 'late', txt: `${j.late}d late` }
  if (j.due_date === today) return { cls: 'today', txt: 'Due today' }
  if (j.late === -1) return { cls: 'soon', txt: 'Tomorrow' }
  const d = new Date(`${j.due_date}T12:00:00`)
  return { cls: j.late >= -3 ? 'soon' : '', txt: d.toLocaleDateString(shopLocale(), { weekday: 'short', month: 'short', day: 'numeric' }) }
}

const card = (j, today, moved) => {
  const due = dueText(j, today)
  return `<div class="tv-card${j.rush ? ' rush' : ''}${j.late > 0 ? ' is-late' : ''}${moved ? ' moved' : ''}" data-id="${j.id}">
    <div class="tv-card-top"><span class="tv-num">${esc(j.job_number || '')}</span>${j.rush ? '<span class="tv-rush">RUSH</span>' : ''}<span class="tv-due ${due.cls}">${esc(due.txt)}</span></div>
    <div class="tv-title">${esc(j.title || 'Untitled job')}</div>
    <div class="tv-meta"><span>${esc(j.customer || '')}</span>${j.pieces ? `<span class="tv-pcs">${j.pieces.toLocaleString(shopLocale())} pcs</span>` : ''}</div>
    ${j.decoration || j.assigned_to ? `<div class="tv-tags">${j.decoration ? `<span>${esc(j.decoration)}</span>` : ''}${j.assigned_to ? `<span class="who">${esc(j.assigned_to)}</span>` : ''}</div>` : ''}
  </div>`
}

/** Inline SVG sparkline — fourteen days of payments, last point emphasised. */
const spark = (pts) => {
  const w = 220, h = 54, max = Math.max(1, ...pts.map((p) => p.amount))
  const xy = pts.map((p, i) => [Math.round(i * (w / (pts.length - 1)) * 10) / 10, Math.round((h - 6 - (p.amount / max) * (h - 12)) * 10) / 10])
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ')
  const [lx, ly] = xy[xy.length - 1]
  return `<svg class="tv-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${line} L${w} ${h} L0 ${h} Z" class="area"/><path d="${line}" class="ln"/><circle cx="${lx}" cy="${ly}" r="3.5" class="pt"/></svg>`
}

const stat = (label, value, cls = '', sub = '') =>
  `<div class="tv-stat ${cls}"><div class="tv-stat-v">${value}</div><div class="tv-stat-l">${label}</div>${sub ? `<div class="tv-stat-s">${sub}</div>` : ''}</div>`

function paint(d) {
  const root = state?.root
  if (!root) return
  const prev = state.prev
  const next = new Map()
  for (const c of d.columns) for (const j of c.jobs) next.set(j.id, j.stage)
  // A job "moved" when it was on the wall before in a different column. The first paint has no
  // history, so nothing glows on load.
  const moved = (j) => prev.size > 0 && prev.has(j.id) && prev.get(j.id) !== j.stage
  state.prev = next

  const s = d.stats, n = (v) => Number(v || 0).toLocaleString(shopLocale())
  const money = d.money
  root.querySelector('.tv-stats').innerHTML = [
    stat('Pieces on the floor', n(s.pieces_on_floor), '', `${n(s.active_jobs)} jobs`),
    stat('Due today', n(s.due_today), s.due_today ? 'warn' : ''),
    stat('Late', n(s.overdue), s.overdue ? 'bad' : 'good', s.overdue ? 'past promise date' : 'nothing late'),
    stat('Proofs out', n(s.proofs_out), s.proofs_out ? 'violet' : ''),
    stat('On track · 7 days', s.on_track_pct == null ? '—' : `${s.on_track_pct}%`, s.on_track_pct == null ? '' : s.on_track_pct >= 90 ? 'good' : s.on_track_pct >= 70 ? 'warn' : 'bad'),
    stat('Shipped this week', n(s.shipped_week), '', s.pieces_completed_week ? `${n(s.pieces_completed_week)} pcs done` : ''),
    money ? `<div class="tv-stat money"><div class="tv-stat-v">${money0(money.revenue_mtd)}</div><div class="tv-stat-l">Collected this month</div><div class="tv-stat-s">${money0(money.revenue_today)} today</div>${spark(money.daily)}</div>` : '',
  ].join('')

  root.querySelector('.tv-lanes').innerHTML = d.columns.map((c) => `<section class="tv-lane" data-stage="${esc(c.key)}">
      <header><span class="tv-lane-nm">${esc(c.label)}</span><span class="tv-lane-ct">${c.count}</span>${c.pieces ? `<span class="tv-lane-pcs">${n(c.pieces)} pcs</span>` : ''}${c.late ? `<span class="tv-lane-late">${c.late} late</span>` : ''}</header>
      <div class="tv-lane-b">${c.jobs.length ? c.jobs.map((j) => card(j, d.today, moved(j))).join('') : '<div class="tv-empty">Clear</div>'}
      ${c.more ? `<div class="tv-more">+${c.more} more</div>` : ''}</div>
    </section>`).join('')

  const items = d.recent.length ? d.recent.map((a) => `<span class="tv-tick tv-t-${esc(a.type)}">${esc(a.description)}</span>`).join('') : '<span class="tv-tick">Waiting for the first move of the day</span>'
  // Doubled so the marquee loops seamlessly; the duration scales with length so it reads at the same pace.
  const tick = root.querySelector('.tv-ticker-track')
  tick.innerHTML = items + items
  tick.style.animationDuration = `${Math.max(30, d.recent.length * 7)}s`
  root.querySelector('.tv-updated').textContent = `Updated ${new Date().toLocaleTimeString(shopLocale(), { hour: 'numeric', minute: '2-digit' })}`
  root.classList.remove('loading')
}

async function refresh() {
  if (!state) return
  try {
    paint(await api.get('/api/tv'))
    state.root?.classList.remove('stale')
  } catch {
    // A dropped connection keeps the last good picture on the wall and says so, rather than going blank.
    state.root?.classList.add('stale')
  }
}

function tick() {
  const root = state?.root
  if (!root) return
  const d = new Date()
  root.querySelector('.tv-time').textContent = d.toLocaleTimeString(shopLocale(), { hour: 'numeric', minute: '2-digit' })
  root.querySelector('.tv-date').textContent = d.toLocaleDateString(shopLocale(), { weekday: 'long', month: 'long', day: 'numeric' })
}

function teardown() {
  if (!state) return
  clearInterval(state.timer); clearInterval(state.clock); clearTimeout(state.idle)
  removeEventListener('hashchange', state.onHash)
  removeEventListener('keydown', state.onKey)
  removeEventListener('mousemove', state.onMove)
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
  document.documentElement.setAttribute('data-theme', state.theme)
  document.body.classList.remove('tv-on')
  state.root?.remove()
  state = null
  delete window.__pscTvRefresh
}

export async function tvView() {
  teardown()
  setPage('Shop TV')
  document.getElementById('view').innerHTML = '<div class="dim">Shop TV is on screen. Press Esc to leave.</div>'
  const shop = document.getElementById('shop-name')?.textContent || ''
  const logo = document.getElementById('brand-logo')
  const source = document.querySelector('.sidebar a.source-link')

  const root = document.createElement('div')
  root.className = 'tv loading'
  root.setAttribute('role', 'region')
  root.setAttribute('aria-label', 'Shop TV wallboard')
  root.innerHTML = `
    <header class="tv-head">
      <div class="tv-brand">${logo && !logo.hidden && logo.src ? `<img src="${esc(logo.src)}" alt="">` : '<span class="tv-mark"></span>'}<span>${esc(shop)}</span><span class="tv-live"><i></i>LIVE</span></div>
      <div class="tv-clock"><div class="tv-time"></div><div class="tv-date"></div></div>
      <div class="tv-ctl"><button type="button" class="tv-btn" data-fs>Full screen</button><button type="button" class="tv-btn" data-exit>Exit <kbd>Esc</kbd></button></div>
    </header>
    <div class="tv-stats"></div>
    <div class="tv-lanes"></div>
    <footer class="tv-foot"><div class="tv-ticker"><div class="tv-ticker-track"></div></div>
      <span class="tv-updated"></span>${source ? `<a class="tv-src" href="${esc(source.href)}" target="_blank" rel="noopener">Source · AGPL-3.0</a>` : ''}</footer>`
  document.body.appendChild(root)
  document.body.classList.add('tv-on')

  state = { root, prev: new Map(), theme: document.documentElement.getAttribute('data-theme') || 'dark' }
  // A wall screen reads best dark whatever the desk theme is; the desk theme comes back on exit.
  document.documentElement.setAttribute('data-theme', 'dark')
  const exit = () => { history.length > 1 ? history.back() : (location.hash = '#/board') }
  root.querySelector('[data-exit]').onclick = exit
  root.querySelector('[data-fs]').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen?.())?.catch?.(() => {})
  state.onHash = () => { if ((location.hash || '').split('?')[0] !== '#/tv') teardown() }
  state.onKey = (e) => { if (e.key === 'Escape' && !document.fullscreenElement) exit(); if (e.key === 'f' && !e.metaKey && !e.ctrlKey) root.querySelector('[data-fs]').click() }
  // Controls fade out after a few seconds without the mouse, so the wall shows only the floor.
  state.onMove = () => { root.classList.remove('idle'); clearTimeout(state.idle); state.idle = setTimeout(() => state?.root?.classList.add('idle'), 3500) }
  addEventListener('hashchange', state.onHash)
  addEventListener('keydown', state.onKey)
  addEventListener('mousemove', state.onMove)
  state.onMove()
  window.__pscTvRefresh = refresh
  tick()
  state.clock = setInterval(tick, 15000)
  state.timer = setInterval(refresh, POLL_MS)
  await refresh()
}
