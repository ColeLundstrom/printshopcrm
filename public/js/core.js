/* Shared plumbing: fetch wrapper, DOM helpers, modal, toast, hash router. */

/**
 * What to tell a human when the response body was not JSON we could read. The status is usually
 * the whole story — and for the restart window specifically, "try again in a moment" is the true
 * and actionable answer.
 */
function httpMessage(status, text) {
  if (status === 502 || status === 503 || status === 504) return 'The server is restarting — try that again in a moment.'
  if (status === 413) return 'That was too large to send.'
  if (status === 429) return 'Too many requests just now — wait a moment and try again.'
  if (status === 404) return 'Not found.'
  if (status === 0 || !status) return 'No connection to the server.'
  // A short plain-text body ("Not found", "unknown shop") is worth showing; a wall of HTML is not.
  const plain = String(text || '').trim()
  if (plain && plain.length <= 120 && !/^\s*</.test(plain)) return plain
  return `Something went wrong (${status}).`
}

export const api = {
  async req(method, url, body) {
    const opts = { method, headers: {} }
    if (body instanceof FormData) opts.body = body
    else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body) }
    const r = await fetch(url, opts)
    // Session expired or not signed in → bounce to the login page.
    if (r.status === 401 && !url.startsWith('/api/auth/')) { location.href = '/login'; throw new Error('Not signed in') }
    const text = await r.text()
    // Not everything that answers this app speaks JSON. A proxy 502/504 during a deploy, an
    // Express default HTML 404 on a mistyped path, "unknown shop" from the tenant resolver — all
    // came back through a bare JSON.parse, which threw a SyntaxError, and the router printed it as
    // the whole page: "Unexpected token '<', "<html>Cann"... is not valid JSON". During a restart
    // window that was the answer to EVERY action, and there is nothing a shop owner can do with it.
    let data = null
    let parsed = false
    if (text) { try { data = JSON.parse(text); parsed = true } catch { /* not JSON — say something useful */ } }
    // The whole answer rides on the Error, not just its sentence. A refusal like 409
    // {code:'multi_garment_quantities', lines:[…]} hands the caller exactly what it needs to send
    // back — and while all a screen could reach was `error`, the only thing it could do was print
    // a sentence whose advice was itself refused one route away. Additive: `.message` is unchanged.
    if (!r.ok) {
      const err = new Error((parsed && data?.error) || httpMessage(r.status, text))
      err.status = r.status
      if (parsed && data) err.data = data
      throw err
    }
    if (!parsed && text) { const err = new Error(httpMessage(r.status, text)); err.status = r.status; throw err }
    return data
  },
  get: (u) => api.req('GET', u),
  post: (u, b) => api.req('POST', u, b),
  put: (u, b) => api.req('PUT', u, b),
  patch: (u, b) => api.req('PATCH', u, b),
  del: (u) => api.req('DELETE', u),
}

/* ---------- formatting ---------- */

// Negatives read as -$40.00, not $-40.00 — a discount line is a signed credit.
export const money = (n) => { const v = Number(n) || 0; return `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` }
export const money0 = (n) => `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export const initials = (s) => String(s || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase()

/**
 * The shop's own calendar day. Every due date in the product means "the day it is here", so this
 * must NOT be toISOString(), which is UTC: west of UTC that made `today()` tomorrow from 5pm
 * local onwards, and it feeds daysOut() and the overdue colouring on the board.
 */
export const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export const today = () => localDay()

export function fmtDate(d) {
  if (!d) return '—'
  // lib/db.mjs stores UTC as 'YYYY-MM-DD HH:MM:SS' — no T, no Z — and new Date() parses that shape
  // as LOCAL time. So an invoice created at 9:05pm Pacific (04:05 UTC the next day) printed
  // "Aug 28" in every date column while relTime() beside it, on the same value, said "just now":
  // relTime appends the Z and this did not. Every stored timestamp was a day out west of UTC
  // after ~5pm, and a day out the other way east of it late at night.
  const s = String(d)
  const dt = /\d\d:\d\d/.test(s)
    ? new Date(s.replace(' ', 'T') + (/[Zz]$|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'))
    // A bare date is a calendar day, not an instant — anchor it at local noon so no timezone
    // shift can slide it onto the day either side.
    : new Date(`${s}T12:00:00`)
  if (isNaN(dt)) return String(d)
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: dt.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })
}

export function relTime(ts) {
  if (!ts) return ''
  const dt = new Date(String(ts).replace(' ', 'T') + (String(ts).endsWith('Z') ? '' : 'Z'))
  const mins = Math.round((Date.now() - dt.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`
  const days = Math.round(mins / 1440)
  if (days < 30) return `${days}d ago`
  return fmtDate(ts)
}

/** Days until a due date, negative when past. */
export const daysOut = (d) => (d ? Math.round((new Date(`${d}T12:00:00`) - new Date(`${today()}T12:00:00`)) / 864e5) : null)

export function dueClass(d) {
  const n = daysOut(d)
  if (n === null) return ''
  if (n < 0) return 'late'
  if (n <= 2) return 'soon'
  return ''
}

export function dueLabel(d) {
  const n = daysOut(d)
  if (n === null) return 'No due date'
  if (n === 0) return 'Due today'
  if (n === 1) return 'Due tomorrow'
  if (n < 0) return `${Math.abs(n)}d late`
  return `Due ${fmtDate(d)}`
}

export const STATUS_COLOR = {
  draft: 'gray', sent: 'blue', approved: 'green', declined: 'red',
  unpaid: 'amber', partial: 'blue', paid: 'green', overdue: 'red',
  rejected: 'red', active: 'green', complete: 'gray',
}

export const pill = (s) => `<span class="pill ${STATUS_COLOR[s] || 'gray'}">${esc(s || '')}</span>`

/* ---------- DOM ---------- */

export const $ = (sel, root = document) => root.querySelector(sel)
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]

export function el(html) {
  const t = document.createElement('template')
  t.innerHTML = html.trim()
  return t.content.firstElementChild
}

/** Delegated click binding: on(root, '.selector', handler). */
export function on(root, sel, fn, evt = 'click') {
  root.addEventListener(evt, (e) => {
    const t = e.target.closest(sel)
    if (t && root.contains(t)) fn(e, t)
  })
}

/**
 * on(), for a root that OUTLIVES the render — #view above all, which is repainted and never
 * replaced. on() attaches; it does not replace. So every re-render added another listener and
 * the same click ran the handler once more each time.
 *
 * This has now been fixed three times in three different screens (84ee9ad was the last), because
 * the shape is invisible at the call site: the code looks correct, and it only misbehaves the
 * second time you visit the page. The damage is real — Books fired 1, then 2, then 4, then 8,
 * then 16 QuickBooks retries per click; one click of a price-matrix row's × deleted two rows of
 * prices; one click of Duplicate made 32 copies of a matrix with no cap and no bulk delete.
 *
 * Keyed on (root, event, selector), so binding twice is a no-op and re-entering a view is free.
 */
const boundOnce = new WeakMap()
export function onOnce(root, sel, fn, evt = 'click') {
  if (!root) return
  let seen = boundOnce.get(root)
  if (!seen) boundOnce.set(root, seen = new Set())
  const key = `${evt}|${sel}`
  if (seen.has(key)) return
  seen.add(key)
  on(root, sel, fn, evt)
}

/* ---------- toast ---------- */

let toastTimer
export function toast(msg, isErr = false) {
  $('.toast')?.remove()
  const t = el(`<div class="toast ${isErr ? 'err' : ''}">${esc(msg)}</div>`)
  document.body.appendChild(t)
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.remove(), 3400)
}

/**
 * Undo-instead-of-confirm. Replaces an "Are you sure?" dialog: the action appears to happen
 * instantly (caller hides the row), but the real, irreversible `commit` is DEFERRED until the
 * undo window closes. Click Undo and `commit` never runs — nothing was ever destroyed
 * server-side. This is the click-saver that also refuses to trap the user.
 *
 *   undoable('Job deleted', { commit: () => api.del(...), undo: () => redraw(), delay: 6000 })
 */
// The undoable whose commit is still pending, if any. A deferred commit that never runs is a
// change the UI confirmed and then silently dropped, so exactly one must be outstanding at a time
// and it must be flushed before the page can go away.
let pendingUndoable = null
if (typeof window !== 'undefined' && !window.__pscUndoFlush) {
  window.__pscUndoFlush = true
  // pagehide fires on tab close, navigation and bfcache — the moment a pending commit would be
  // lost. Flush it synchronously so the server gets the change the user already saw succeed.
  window.addEventListener('pagehide', () => { try { pendingUndoable?.flush() } catch { /* leaving anyway */ } })
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { try { pendingUndoable?.flush() } catch { /* noop */ } } })

  // One net under every write in the app.
  //
  // api.req() THROWS on any non-2xx — including the 502/503 restart window httpMessage() was
  // written for. A handler shaped `async () => { await api.post(…); toast('Sent') }` therefore
  // stops BEFORE the toast and before the re-render, and the rejection goes nowhere: pressing
  // "Email Invoice" on a $4,200 invoice with bad SMTP credentials did absolutely nothing on
  // screen, so the shop pressed it again. A scan of public/js/views found 24 write handlers in
  // exactly that shape, which makes it a contract problem rather than a list of oversights — and
  // a list would grow back. A local catch is still better where the screen has state to put back
  // (see the job stage select and the automation toggle); this is the floor under all of them.
  window.addEventListener('unhandledrejection', (e) => {
    const msg = String(e?.reason?.message || e?.reason || '').trim()
    if (!msg) return
    e.preventDefault?.()   // handled — don't also log it as unhandled
    toast(msg, true)
  })
}

export function undoable(msg, { commit, undo, label = 'Undo', delay = 6000 } = {}) {
  // Starting a new undoable COMMITS the previous one rather than orphaning its timer. Before, a
  // second toast in the 6s window removed the Undo element while the old timer kept running, so
  // the user was shown they could undo and then could not; flushing makes the earlier change final
  // and honest.
  try { pendingUndoable?.flush() } catch { /* previous commit best-effort */ }
  $('.toast')?.remove()
  clearTimeout(toastTimer)
  let done = false
  const t = el(`<div class="toast undo"><span>${esc(msg)}</span>
    <button class="toast-undo">${esc(label)}</button>
    <span class="toast-bar"><span class="toast-bar-fill"></span></span></div>`)
  document.body.appendChild(t)
  requestAnimationFrame(() => { const f = $('.toast-bar-fill', t); if (f) { f.style.transition = `width ${delay}ms linear`; f.style.width = '0%' } })
  const settle = (fn) => { if (done) return; done = true; clearTimeout(timer); t.remove(); if (pendingUndoable === handle) pendingUndoable = null; try { fn?.() } catch (e) { console.error(e) } }
  const timer = setTimeout(() => settle(commit), delay)
  $('.toast-undo', t).onclick = () => settle(undo)
  // flush commits early — called on navigation/tab-close and when the next undoable begins.
  const handle = { flush: () => settle(commit) }
  pendingUndoable = handle
  return handle
}

/* ---------- modal ---------- */

export function modal({ title, body, footer = '', wide = false, onMount }) {
  closeModal()
  const bg = el(`<div class="modal-bg">
    <div class="modal ${wide ? 'wide' : ''}">
      <div class="modal-h"><h3>${esc(title)}</h3><button class="x" data-close>&times;</button></div>
      <div class="modal-b"></div>
      ${footer ? `<div class="modal-f">${footer}</div>` : ''}
    </div></div>`)
  $('.modal-b', bg).innerHTML = body
  $('#modal-root').appendChild(bg)
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) closeModal() })
  on(bg, '[data-close]', closeModal)
  document.addEventListener('keydown', escClose)
  onMount?.(bg)
  $('.modal-b input, .modal-b select, .modal-b textarea', bg)?.focus()
  return bg
}

const escClose = (e) => { if (e.key === 'Escape') closeModal() }

export function closeModal() {
  $('#modal-root').innerHTML = ''
  document.removeEventListener('keydown', escClose)
}

export function confirmModal(title, msg, onYes, yesLabel = 'Delete') {
  modal({
    title,
    body: `<p class="muted" style="line-height:1.6">${esc(msg)}</p>`,
    footer: `<button class="btn ghost" data-close>Cancel</button><button class="btn danger" id="yes">${esc(yesLabel)}</button>`,
    onMount: (bg) => $('#yes', bg).onclick = async () => { closeModal(); await onYes() },
  })
}

/** Reads every [name] control inside a container into a plain object. */
export function formData(root) {
  const out = {}
  for (const f of $$('[name]', root)) {
    out[f.name] = f.type === 'checkbox' ? f.checked : f.type === 'number' ? (f.value === '' ? null : Number(f.value)) : f.value
  }
  return out
}

export const empty = (icon, title, msg, action = '') =>
  `<div class="empty"><div class="big">${icon}</div><h3 style="font-size:14px;margin-bottom:5px">${esc(title)}</h3><p>${esc(msg)}</p>${action}</div>`

/**
 * A layout-matched loading skeleton — shown instantly on a route so the content area is never
 * blank while data fetches (the #1 mobile-SPA complaint). Kinds match the pages that use them.
 */
export function skeleton(kind = 'list') {
  const line = (w) => `<div class="skel skel-line" style="width:${w}"></div>`
  if (kind === 'dashboard') return `<div class="skel-kpis">${'<div class="skel skel-kpi"></div>'.repeat(4)}</div>
    <div class="skel-kpis">${'<div class="skel skel-kpi"></div>'.repeat(4)}</div>
    <div class="skel skel-card"></div>
    <div class="cols" style="display:grid;grid-template-columns:1fr 1fr;gap:16px"><div class="skel skel-card"></div><div class="skel skel-card"></div></div>`
  if (kind === 'cards') return `<div class="skel-kpis">${'<div class="skel skel-kpi"></div>'.repeat(4)}</div><div class="skel skel-card"></div>`
  // Generic list/table skeleton.
  return `<div class="card"><div class="card-b">${[...Array(8)].map(() => `<div style="display:flex;gap:14px;padding:6px 0">${line('40%')}${line('20%')}${line('15%')}</div>`).join('')}</div></div>`
}

/* ---------- router ---------- */

const routes = []
export const route = (re, handler) => routes.push({ re, handler })
export const go = (hash) => { location.hash = hash }

export async function runRouter() {
  // Match against the path only; a `?query` (e.g. ?new=1, ?sep=1) shouldn't break routes
  // that end in `$`. Handlers read the full location.hash themselves for their params.
  const path = (location.hash.replace(/^#/, '') || '/').split('?')[0] || '/'
  for (const r of routes) {
    const m = path.match(r.re)
    if (m) {
      try { await r.handler(...m.slice(1)) } catch (e) { console.error(e); $('#view').innerHTML = empty('⚠', 'Something broke', e.message) }
      return
    }
  }
  setPage('Not found')
  $('#view').innerHTML = empty('⌕', 'Page not found', path, '<a class="btn ghost" href="#/">Back to dashboard</a>')
}

export function setPage(title, actions = '', crumb = '') {
  $('#page-title').textContent = title
  $('#crumb').innerHTML = crumb
  $('#page-actions').innerHTML = actions
}
