/* Shared plumbing: fetch wrapper, DOM helpers, modal, toast, hash router. */

export const api = {
  async req(method, url, body) {
    const opts = { method, headers: {} }
    if (body instanceof FormData) opts.body = body
    else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body) }
    const r = await fetch(url, opts)
    // Session expired or not signed in → bounce to the login page.
    if (r.status === 401 && !url.startsWith('/api/auth/')) { location.href = '/login'; throw new Error('Not signed in') }
    const text = await r.text()
    const data = text ? JSON.parse(text) : null
    if (!r.ok) throw new Error(data?.error || `Request failed (${r.status})`)
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

export const today = () => new Date().toISOString().slice(0, 10)

export function fmtDate(d) {
  if (!d) return '—'
  const dt = new Date(String(d).includes('T') || String(d).includes(' ') ? d : `${d}T12:00:00`)
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
export function undoable(msg, { commit, undo, label = 'Undo', delay = 6000 } = {}) {
  $('.toast')?.remove()
  clearTimeout(toastTimer)
  let done = false
  const t = el(`<div class="toast undo"><span>${esc(msg)}</span>
    <button class="toast-undo">${esc(label)}</button>
    <span class="toast-bar"><span class="toast-bar-fill"></span></span></div>`)
  document.body.appendChild(t)
  requestAnimationFrame(() => { const f = $('.toast-bar-fill', t); if (f) { f.style.transition = `width ${delay}ms linear`; f.style.width = '0%' } })
  const timer = setTimeout(() => { if (done) return; done = true; t.remove(); try { commit?.() } catch (e) { console.error(e) } }, delay)
  $('.toast-undo', t).onclick = () => { if (done) return; done = true; clearTimeout(timer); t.remove(); undo?.() }
  // Committing early (e.g. on navigation) keeps data consistent — expose a flush.
  return { flush: () => { if (done) return; done = true; clearTimeout(timer); t.remove(); commit?.() } }
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
