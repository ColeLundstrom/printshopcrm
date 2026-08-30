/* Shared plumbing: fetch wrapper, DOM helpers, modal, toast, hash router. */

import { createNavGuard } from './shared/navguard.js'

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
  // An unparseable value is not a date, and this returned it VERBATIM into a dozen innerHTML
  // sites that treat fmtDate() as safe — contacts.js:241, followups.js:56/72, dashboard.js:49/50,
  // capacity.js:135/136, board.js:323/327. jobs.due_date was free text on POST and PUT /api/jobs
  // (the identical field on invoices has been format-checked since server.mjs:2600), so this was
  // stored XSS on the app's own origin, plantable by the LOWEST role and fired by a manager
  // simply opening the customer's page. A formatter must not be able to emit markup; it has
  // nothing useful to say about a non-date anyway. relTime() falls through to here, so it is
  // covered by the same line.
  if (isNaN(dt)) return esc(String(d))
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

/**
 * There is not one aria-live region, role="status" or role="alert" anywhere in public/. Every
 * answer this app gives a non-visual user — "Matrix saved", "Estimate sent", "The server is
 * restarting", and the message the unhandledrejection net puts on screen for all 24 write
 * handlers — is a <div> that appears silently in a corner and removes itself 3.4 seconds later.
 * A screen-reader user presses Email Invoice on a $4,200 invoice and is told nothing at all, in
 * either direction, so the only safe thing to do is press it again.
 *
 * A live region is only announced if it was ALREADY in the document when its text changed:
 * inserting a <div aria-live> that already contains its message is silent in NVDA and JAWS and
 * unreliable in VoiceOver. So the regions are created empty at boot and the words are written
 * INTO them. Two of them, because politeness cannot be flipped on a live element and reliably
 * honoured — 'polite' waits for a pause, 'assertive' interrupts, which is what an error is for.
 */
let liveRegions = null
function liveRegion(assertive) {
  // A partial DOM (bin/gate.mjs stubs one; this module must import under plain Node) has no live
  // region and does not need one — say nothing rather than throw.
  if (typeof document === 'undefined' || !document.body || typeof document.createElement !== 'function') return null
  if (!liveRegions) {
    const make = (id, role, politeness) => {
      const r = document.createElement('div')
      if (!r || typeof r.setAttribute !== 'function') return null
      r.setAttribute('id', id)
      r.setAttribute('class', 'sr-only')
      r.setAttribute('role', role)
      r.setAttribute('aria-live', politeness)
      r.setAttribute('aria-atomic', 'true')
      document.body.appendChild(r)
      return r
    }
    liveRegions = { polite: make('psc-live', 'status', 'polite'), assertive: make('psc-live-alert', 'alert', 'assertive') }
  }
  return assertive ? liveRegions.assertive : liveRegions.polite
}

/**
 * Say something to a screen reader without putting it on screen. Exported so a view can announce
 * a result that has no toast — a filtered count, a finished upload.
 */
export function announce(msg, assertive = false) {
  const r = liveRegion(assertive)
  if (!r) return
  // The same sentence twice running is not re-announced unless the region is cleared first, and
  // "Saved" twice in a row is exactly what this app says.
  r.textContent = ''
  setTimeout(() => { r.textContent = String(msg ?? '') }, 60)
}

let toastTimer
export function toast(msg, isErr = false) {
  $('.toast')?.remove()
  const t = el(`<div class="toast ${isErr ? 'err' : ''}" role="${isErr ? 'alert' : 'status'}">${esc(msg)}</div>`)
  document.body.appendChild(t)
  announce(msg, isErr)
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
  // The undo window is six seconds of time-limited choice — the one message that must not be silent.
  announce(`${msg}. Press ${label} to undo.`)
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

// Where focus goes when the dialog closes. Without it, closeModal() blows the dialog away with
// innerHTML = '' and focus falls to <body>: a keyboard user is dumped at the top of the document
// and has to Tab back through the whole sidebar to get where they were, and a screen reader
// announces nothing at all — the dialog simply stops existing mid-sentence.
let modalReturnFocus = null
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
export const focusable = (root) => [...$$(FOCUSABLE, root)].filter((n) => n.offsetParent !== null || n === document.activeElement)
/**
 * Keep Tab inside an overlay. Exported because three overlays in this app are hand-rolled rather
 * than built by modal() — the ⌘K palette, the shortcuts help and the Assistant — and every one of
 * them let Tab walk invisibly into the sidebar behind a dimmed backdrop, where Enter then fired
 * whatever it landed on. This is the same rule modal() applies below, in one place, so the next
 * hand-rolled overlay gets it by calling one function instead of copying twenty lines.
 */
export function trapTab(root, e) {
  if (e.key !== 'Tab') return
  const f = focusable(root)
  if (!f.length) return
  const first = f[0], last = f[f.length - 1]
  if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) { e.preventDefault(); first.focus() }
}
/**
 * Remember what opened an overlay so it can be handed focus back when the overlay goes.
 * closeModal() has done this since v11; the three hand-rolled overlays dropped focus on <body>,
 * which dumps a keyboard user at the top of the document with the whole sidebar to Tab through.
 */
export function focusKeeper() {
  const opener = document.activeElement
  const held = (opener && opener !== document.body && document.contains(opener)) ? opener : null
  return () => { if (held && typeof held.focus === 'function' && document.contains(held)) { try { held.focus() } catch { /* detached mid-teardown */ } } }
}
let modalSeq = 0

/**
 * Copy text, and never claim to have done it when it did not happen.
 *
 * `navigator.clipboard?.writeText(x); toast('Link copied')` was the pattern on the estimate share
 * button and the mockup approval link: no await, no catch, and an optional chain that evaluates to
 * `undefined` and toasts success anyway. `navigator.clipboard` does not exist outside a secure
 * context, and INSTALL.md documents `http://192.168.x.x` as a supported private-network deploy —
 * so on that install the button said "Link copied" and copied nothing, every time.
 *
 * It matters more than a copy button usually does: with no SMTP connected the app TELLS the shop
 * to copy the link and send it themselves, which makes this the only delivery path the customer
 * has. Falls back to execCommand, and if even that fails, puts the text on screen selected so a
 * human can copy it by hand. The one thing it will not do is lie.
 */
export async function copyText(text, okMsg = 'Copied') {
  const s = String(text ?? '')
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(s); toast(okMsg); return true }
  } catch { /* fall through — a denied permission is not a reason to say nothing happened */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = s
    ta.setAttribute('readonly', '')
    ta.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    if (ok) { toast(okMsg); return true }
  } catch { /* fall through to showing it */ }
  modal({
    title: 'Copy this link',
    body: `<p class="dim" style="font-size:12.5px;margin-bottom:10px">This browser will not let the page copy for you — it needs an https address. Select the link and copy it.</p>
      <textarea class="input" id="copy-fallback" rows="3" readonly style="font-size:12px"></textarea>`,
    footer: '<button class="btn" data-close>Done</button>',
    onMount: (bg) => { const t = $('#copy-fallback', bg); t.value = s; t.focus(); t.select() },
  })
  return false
}

export function modal({ title, body, footer = '', wide = false, onMount }) {
  // Captured BEFORE closeModal(), so a dialog opened FROM a dialog still returns to the control
  // that started the whole thing rather than to a node that is about to be detached.
  const opener = document.activeElement
  const outer = closeModal()
  modalReturnFocus = (opener && opener !== document.body && document.contains(opener)) ? opener : outer
  const titleId = `modal-t-${++modalSeq}`
  const bg = el(`<div class="modal-bg">
    <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
      <div class="modal-h"><h3 id="${titleId}">${esc(title)}</h3><button class="x" data-close aria-label="Close">&times;</button></div>
      <div class="modal-b"></div>
      ${footer ? `<div class="modal-f">${footer}</div>` : ''}
    </div></div>`)
  $('.modal-b', bg).innerHTML = body
  $('#modal-root').appendChild(bg)
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) closeModal() })
  on(bg, '[data-close]', closeModal)
  document.addEventListener('keydown', escClose)
  // Tab must not walk out of an open dialog. Without this, Tab from a confirmModal — whose body is
  // a paragraph, so the focus line below found nothing to focus and focus STAYED on the trigger
  // behind the overlay — went straight into the sidebar, and Enter re-fired the button that opened
  // the dialog. Escape and focus-restore were already right; this is the half that was missing.
  bg.addEventListener('keydown', (e) => trapTab(bg, e))
  onMount?.(bg)
  // Land inside the dialog, always. A dialog with no form control (every confirmModal) used to
  // leave focus on the control behind the overlay.
  const start = $('.modal-b input, .modal-b select, .modal-b textarea', bg) || focusable(bg)[0]
  start?.focus()
  return bg
}

const escClose = (e) => { if (e.key === 'Escape') closeModal() }

/** Closes the dialog and returns focus to whatever opened it. Returns that element, or null. */
export function closeModal() {
  const root = $('#modal-root')
  const wasOpen = !!(root && root.firstElementChild)
  if (root) root.innerHTML = ''
  document.removeEventListener('keydown', escClose)
  const back = modalReturnFocus
  modalReturnFocus = null
  if (wasOpen && back && typeof back.focus === 'function' && document.contains(back)) {
    try { back.focus() } catch { /* detached mid-teardown — leave focus where it is */ }
    return back
  }
  return null
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
/**
 * A button whose handler cannot be run twice at once.
 *
 * The estimate editor's Create has guarded this since round 14 — "two clicks made two estimates,
 * with two estimate numbers, and the shop then has to work out which one the customer was sent" —
 * and four more controls with exactly that shape never got it. On shop wifi the round trip is
 * long enough to click again, and a UI that shows no progress invites it:
 *
 *   New Job      two job numbers for one order, each with its own purchase order, print package,
 *                work ticket and capacity claim, and nothing on the board says they are the same job
 *   New Customer two customer records with one name, splitting that customer's job history,
 *                lifetime value and A/R balance across two rows, with no merge anywhere
 *   Send         a live customer gets the quote, or the invoice, twice
 *
 * The button is re-enabled in a `finally`, so a refused save is still editable and the label the
 * shop was reading comes back. On the success paths the node has usually been detached by a close
 * or a repaint, and touching a detached node is harmless.
 */
export function onceClick(btn, busyLabel, fn) {
  if (!btn) return null
  btn.onclick = async () => {
    if (btn.disabled) return
    const was = btn.textContent
    btn.disabled = true
    if (busyLabel) btn.textContent = busyLabel
    try { await fn() } finally {
      btn.disabled = false
      if (busyLabel) btn.textContent = was
    }
  }
  return btn
}

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

/* A screen that holds unsaved work arms this; app.js's navigate() asks before it repaints.
 * The predicate returns false to REFUSE the navigation, and then owns asking the person and
 * re-issuing go() once they have answered. It is disarmed automatically the moment a navigation
 * is allowed through, so a view only ever guards while it is the view on screen. */
const navGuard = createNavGuard((hash) => { location.hash = hash })
export const guardLeave = (fn) => navGuard.register(fn)
export const acceptRoute = (target) => navGuard.accept(target)

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

/* ---------- keyboard parity for the rows and cards a view makes clickable ----------
 *
 * Twenty-four places in public/js/views render a row or a card whose only affordance is a mouse
 * click — `<tr class="click" data-id>`, `.jcard`, `.convo-item`, `.autorow`, the setup chips.
 * The handler is delegated through on()/onOnce(), so the markup carries no button, no href, no
 * tabindex and no role: with a keyboard alone you cannot open an estimate, an invoice, a job, a
 * customer, a conversation or an automation. That is not a rough edge, it is the product behind
 * a mouse.
 *
 * Fixing twenty-four call sites would leave the twenty-fifth broken, so it is fixed once, here,
 * as a property of the app. Nothing about the mouse path changes and no view changes.
 *
 * Three things this has to get right:
 *  - A <tr> or <td> keeps its table semantics. role="button" on a row tells a screen reader it is
 *    no longer a row, which costs more than it buys, so table elements get tabindex only.
 *  - It must not hijack a control INSIDE the row. automations.js:62 puts a checkbox inside the
 *    clickable row and followups.js puts a Nudge button in the last cell — Space and Enter there
 *    belong to the checkbox and the button, not to the row around them.
 *  - Rows arrive after this file runs; every render is an innerHTML. So it watches for them.
 *
 * The `typeof window` guard is load-bearing, not decoration: bin/gate.mjs imports this module
 * under plain Node, where window and document do not exist, and an unguarded reference here
 * throws ReferenceError at import time and takes twelve unrelated assertions down with it.
 */
/*
 * .drop and .csv-drop are on the same list for the same reason. Every file the app accepts —
 * artwork onto a job (board.js:350), the Autopilot logo, both CSV importers, the DTF trimmer,
 * the gang-sheet builder — arrives through a <div> or a <label> with an onclick and a
 * `hidden` file input behind it. A hidden input is not focusable and a div is not either, so
 * attaching art to a job had NO keyboard path at all: not Tab, not Enter, not Space. Enter on
 * the zone now clicks it, which is exactly what the mouse does, and the native picker opens.
 */
// `.copy` is the estimate's Customer Link box. It carries cursor:pointer and an onclick, and it is
// a bare <div> — so it was mouse-only, on the one control that matters most when a shop has no SMTP
// wired: "Marked sent. No email connected yet, copy the customer link to send it" is the app
// telling the owner this box IS the delivery path.
export const CLICKABLE_ROWS = '.click,.jcard[data-id],.convo-item[data-c],.autorow[data-edit],.setup-chip[data-setup],.card[data-job],.drop,.csv-drop,.copy'

const KB_INNER = 'a[href],button,input,select,textarea,label,summary,[contenteditable="true"]'
const KB_TABLE = /^(TR|TD|TH|THEAD|TBODY)$/
const KB_NATIVE = /^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/

/** Put every clickable row in `root` into the tab order. Idempotent — a second pass adds nothing. */
export function upgradeClickableRows(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return 0
  const found = [...root.querySelectorAll(CLICKABLE_ROWS)]
  if (typeof root.matches === 'function' && root.matches(CLICKABLE_ROWS)) found.unshift(root)
  let n = 0
  for (const node of found) {
    if (KB_NATIVE.test(node.tagName)) continue        // already operable on its own
    if (node.hasAttribute('tabindex')) continue       // already upgraded, or deliberately placed
    node.setAttribute('tabindex', '0')
    if (!KB_TABLE.test(node.tagName) && !node.hasAttribute('role')) node.setAttribute('role', 'button')
    n++
  }
  return n
}

/* ---------- <label> ↔ control association ----------
 * 170 of the 177 <label>s under public/ carry no for=, and most are written as the sibling pair
 * `<label>Email</label><input class="input" name="email">` with nothing joining them. To a screen
 * reader those inputs are unlabelled — the estimate form, the settings screen and every modal read
 * out as "edit text, blank" — and clicking the label does not focus the field either.
 *
 * Rewriting the templates by hand is that many chances to typo an id, and the next one written
 * ships unlabelled anyway. So the pairing is done once, at runtime, on the shape the markup
 * already has. A label that WRAPS its control is left alone: that is already a valid association.
 * A label with nothing to point at is left alone too, and the gate lists them as hand edits.
 */
let labelSeq = 0
export function wireLabels(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return 0
  const found = [...root.querySelectorAll('label:not([for])')]
  if (typeof root.matches === 'function' && root.matches('label:not([for])')) found.unshift(root)
  let n = 0
  for (const lab of found) {
    if (lab.hasAttribute('data-psc-lab')) continue
    if (lab.querySelector('input,select,textarea')) { lab.setAttribute('data-psc-lab', 'wrap'); continue }
    let c = lab.nextElementSibling
    if (c && !/^(INPUT|SELECT|TEXTAREA)$/.test(c.tagName)) {
      const inner = typeof c.querySelectorAll === 'function' ? [...c.querySelectorAll('input,select,textarea')] : []
      c = inner.length === 1 ? inner[0] : null
    }
    // A hidden control is not in the accessibility tree, so pointing a label at it buys nothing
    // and hides the fact that the visible trigger (the "Upload logo" button) is the real target.
    if (!c || c.getAttribute('type') === 'hidden' || c.hasAttribute('hidden')) continue
    if (!c.getAttribute('id')) c.setAttribute('id', `psc-f${++labelSeq}`)
    lab.setAttribute('for', c.getAttribute('id'))
    lab.setAttribute('data-psc-lab', '1')
    n++
  }
  return n
}

/** One pass over whatever just rendered. Exported so a test can drive it without the observer. */
export function a11yUpgrade(root) {
  return { rows: upgradeClickableRows(root), labels: wireLabels(root) }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && !window.__pscA11y) {
  window.__pscA11y = true

  // Enter or Space on a clickable row dispatches the click its delegated handler already waits for.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
    const target = e.target
    if (!target || typeof target.closest !== 'function') return
    const row = target.closest(CLICKABLE_ROWS)
    if (!row) return
    const inner = target.closest(KB_INNER)
    if (inner && inner !== row && row.contains(inner)) return   // the control owns its own keys
    e.preventDefault()                                          // Space must not scroll the page
    row.click()
  })

  const sweep = (n) => { if (n && n.nodeType === 1) { upgradeClickableRows(n); wireLabels(n) } }
  const start = () => {
    // Create the live regions at boot, empty. A region inserted with its message already inside
    // is not announced — see liveRegion() above.
    liveRegion(false); liveRegion(true)
    sweep(document.body)
    if (typeof MutationObserver === 'function' && document.documentElement) {
      new MutationObserver((recs) => { for (const r of recs) for (const n of r.addedNodes) sweep(n) })
        .observe(document.documentElement, { childList: true, subtree: true })
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
}
