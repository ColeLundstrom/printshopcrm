import { api, $, $$, esc, route, runRouter, initials, on, toast, announce, acceptRoute, store } from './core.js'
import { dashboardView } from './views/dashboard.js'
import { agentView } from './views/agent.js'
import { productsView } from './views/products.js'
import { pricingView } from './views/pricing.js'
import { matricesView, matrixEditor } from './views/matrices.js'
import { contactsView, contactDetailView } from './views/contacts.js'
import { estimatesView, estimateEditor, estimateDetailView } from './views/estimates.js'
import { invoicesView, invoiceDetailView } from './views/invoices.js'
import { boardView, jobDetailView } from './views/board.js'
import { artView, activityView, outboxView, settingsView } from './views/misc.js'
import { adminView } from './views/admin.js'
import { openSearch, closeSearch, wireSearchHotkey } from './views/search.js'
import { wireKeys } from './keys.js'
import { openAssistant, closeAssistant } from './views/assistant.js'
import { followupsView } from './views/followups.js'
import { automationsView } from './views/automations.js'
import { conversationsView } from './views/conversations.js'
import { pipelineView } from './views/pipeline.js'
import { autopilotView } from './views/autopilot.js'
import { roiView } from './views/roi.js'
import { onboardingView } from './views/onboarding.js'
import { ordersView } from './views/orders.js'
import { gangSheetView } from './views/gangsheet.js'
import { billingView } from './views/billing.js'
import { capacityView } from './views/capacity.js'
import { reorderView } from './views/reorder.js'
import { todayView } from './views/today.js'
import { dtfResizeView } from './views/dtfresize.js'
import { scanView } from './views/scan.js'
import { booksView } from './views/books.js'
import { developersView } from './views/developers.js'

// Workflow-first IA (Today / Sales / Production / Money / Customers / Automate / More): grouped by
// what someone is trying to DO, not by feature inventory. Rarely-touched tools live under "More".
const NAV = [
  { href: '/', ico: 'today', name: 'Today' },
  { label: 'Sales', section: true },
  { href: '/conversations', ico: 'conversations', name: 'Conversations', badge: 'unread' },
  { href: '/pipeline', ico: 'pipeline', name: 'Pipeline' },
  { href: '/estimates', ico: 'estimates', name: 'Estimates' },
  { href: '/orders', ico: 'orders', name: 'Orders' },
  { href: '/followups', ico: 'followups', name: 'Follow-ups', badge: 'followups' },
  { href: '/reorders', ico: 'reorders', name: 'Reorder Radar' },
  { label: 'Production', section: true },
  { href: '/board', ico: 'board', name: 'Job Board', badge: 'active_jobs' },
  { href: '/art', ico: 'art', name: 'Art & Prepress', badge: 'art_pending' },
  { advanced: true, href: '/dtf', ico: 'dtf', name: 'DTF Resize' },
  { advanced: true, href: '/gangsheet', ico: 'gangsheet', name: 'Gang Sheet Builder' },
  { href: '/capacity', ico: 'capacity', name: 'Capacity' },
  { advanced: true, href: '/scan', ico: 'board', name: 'Floor Mode' },
  { label: 'Money', section: true },
  { href: '/pricing', ico: 'pricing', name: 'Pricing' },
  { href: '/invoices', ico: 'invoices', name: 'Invoices', badge: 'open_invoices' },
  { href: '/roi', ico: 'roi', name: 'Profitability' },
  { href: '/books', ico: 'invoices', name: 'Books & A/R' },
  { label: 'Customers', section: true },
  { href: '/contacts', ico: 'customers', name: 'Customers' },
  { label: 'Automate', section: true },
  { href: '/autopilot', ico: 'autopilot', name: 'Autopilot' },
  { advanced: true, href: '/receptionist', ico: 'receptionist', name: 'AI Receptionist' },
  { advanced: true, href: '/automations', ico: 'automations', name: 'Automations', badge: 'automations' },
  { label: 'More', section: true },
  { advanced: true, href: '/products', ico: 'products', name: 'Products' },
  { advanced: true, href: '/activity', ico: 'activity', name: 'Activity' },
  { advanced: true, href: '/developers', ico: 'settings', name: 'Developers' },
  { advanced: true, href: '/outbox', ico: 'outbox', name: 'Outbox' },
  { href: '/billing', ico: 'billing', name: 'Billing', owner: true },
  { href: '/settings', ico: 'settings', name: 'Settings' },
  { label: 'Admin', section: true, admin: true },
  { href: '/admin', ico: 'admin', name: 'Control Room', admin: true },
]

/** Hide nav entries a role can't use (Billing is owner-only, Control Room is platform-admin) and
 *  then drop any now-empty section header. Nothing is hidden by plan — there is one product and
 *  every shop has all of it (2026-08-21; see lib/billing.mjs). */
function visibleNav() {
  const me = window.__me || {}
  const owner = me.single_tenant || me.is_owner
  const items = NAV.filter((n) =>
    !(n.owner && !owner) &&
    !(n.admin && !me.is_admin))
  return items.filter((n, i) => !n.section || items.slice(i + 1).some((x) => !x.section) && !items[i + 1]?.section)
}

/* routes — order matters, first match wins */
route(/^\/$/, todayView)
route(/^\/dashboard$/, dashboardView)
route(/^\/autopilot$/, autopilotView)
route(/^\/receptionist$/, agentView)
route(/^\/orders$/, ordersView)
route(/^\/products$/, productsView)
route(/^\/pricing$/, pricingView)
// Custom price matrices live under Pricing rather than in the sidebar — the nav was deliberately
// simplified (2026-08-24) and this is a setup screen you visit, not a place you work all day.
route(/^\/matrices$/, matricesView)
route(/^\/matrices\/(\d+)$/, matrixEditor)
route(/^\/board$/, boardView)
route(/^\/capacity$/, capacityView)
route(/^\/jobs\/(\d+)$/, jobDetailView)
route(/^\/art$/, artView)
route(/^\/gangsheet$/, gangSheetView)
route(/^\/dtf$/, dtfResizeView)
route(/^\/estimates$/, estimatesView)
route(/^\/estimates\/new/, () => estimateEditor('new'))
route(/^\/estimates\/(\d+)\/edit$/, estimateEditor)
route(/^\/estimates\/(\d+)$/, estimateDetailView)
route(/^\/invoices$/, invoicesView)
route(/^\/invoices\/(\d+)$/, invoiceDetailView)
route(/^\/roi$/, roiView)
route(/^\/scan$/, scanView)
route(/^\/books$/, booksView)
route(/^\/developers$/, developersView)
route(/^\/welcome$/, onboardingView)
route(/^\/billing$/, billingView)
route(/^\/pipeline$/, pipelineView)
route(/^\/conversations\/(\d+)$/, conversationsView)
route(/^\/conversations$/, conversationsView)
route(/^\/followups$/, followupsView)
route(/^\/reorders$/, reorderView)
route(/^\/contacts$/, contactsView)
route(/^\/contacts\/(\d+)$/, contactDetailView)
route(/^\/activity$/, activityView)
route(/^\/outbox$/, outboxView)
route(/^\/automations$/, automationsView)
route(/^\/settings$/, settingsView)
route(/^\/admin$/, adminView)

let badges = {}

// Mobile primary nav — a bottom tab bar in the thumb zone (2026 standard over a hidden hamburger).
// Five thumb-reachable destinations; "More" opens the full sidebar drawer.
/**
 * Mobile tab-bar destinations, preferred order per edition. Filtered against visibleNav() so the bar
 * can only ever offer routes this edition and plan actually expose — the pro Board/Inbox tabs were
 * showing in lite, where neither view exists, so a narrow window left the sidebar hidden behind ☰
 * and the visible tabs going nowhere.
 */
const TABBAR_PREF = {
  pro: [
    { href: '/', ico: 'today', name: 'Today' },
    { href: '/board', ico: 'board', name: 'Board', badge: 'active_jobs' },
    { href: '/conversations', ico: 'conversations', name: 'Inbox', badge: 'unread' },
    { href: '/pricing', ico: 'pricing', name: 'Pricing' },
  ],
  lite: [
    { href: '/', ico: 'today', name: 'Today' },
    { href: '/orders', ico: 'orders', name: 'Orders' },
    { href: '/estimates', ico: 'estimates', name: 'Estimates' },
    { href: '/invoices', ico: 'invoices', name: 'Invoices', badge: 'open_invoices' },
  ],
}
function tabbarItems() {
  const allowed = new Set(visibleNav().filter((n) => !n.section).map((n) => n.href))
  const pref = TABBAR_PREF[window.__EDITION === 'lite' ? 'lite' : 'pro']
  return [...pref.filter((t) => allowed.has(t.href)).slice(0, 4), { more: true, ico: 'menu', name: 'More' }]
}

/**
 * One nav icon. `ico` on a NAV / TABBAR_PREF entry is a sprite name ('invoices'), not a character —
 * the shapes live in the inline <svg> sprite at the top of index.html. The symbol paints with
 * stroke="currentColor", so the icon takes the colour of the link it sits in and the existing
 * hover / .on / .hot / light-dark rules in app.css keep working untouched.
 */
const icon = (name, cls) => `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`

function isActive(href, path) {
  return href === '/' ? path === '/' : path.startsWith(href) || (href === '/board' && path.startsWith('/jobs'))
}

/**
 * Power tools stay folded away until asked for.
 *
 * The full nav is 27 destinations. A shop owner opening this for the first time has to read all of
 * them to work out "where do I write a quote", and most of what they read is a tool they may never
 * use. Nothing is removed — every item is one click, ⌘K, or a URL away — but the sidebar leads with
 * the daily loop: quote → produce → invoice → get paid.
 */
const MORE_KEY = 'psc-nav-more'
const moreOpen = () => store.get(MORE_KEY) === '1'

function drawNav() {
  const path = location.hash.replace(/^#/, '').split('?')[0] || '/'
  const all = visibleNav()
  // Never hide the page you are standing on: arriving at an advanced route from a link, a search
  // result or a bookmark must not produce a sidebar with no current item in it.
  const onAdvanced = all.some((n) => !n.section && n.advanced && isActive(n.href, path))
  const expanded = moreOpen() || onAdvanced
  const shown = expanded ? all : all.filter((n) => !n.advanced)
  const hiddenCount = all.filter((n) => !n.section && n.advanced).length

  const link = (n) => {
    const on = isActive(n.href, path)
    const c = badges[n.badge]
    return `<a href="#${n.href}" class="${on ? 'on' : ''} ${n.hot ? 'hot' : ''}"${on ? ' aria-current="page"' : ''}>${icon(n.ico, 'ico')}${n.name}${n.hot ? '<span class="hotdot"></span>' : ''}${c ? `<span class="count">${c}</span>` : ''}</a>`
  }

  // Drop any section header left with nothing beneath it once the advanced items are filtered out.
  const pruned = shown.filter((n, i) => !n.section || shown.slice(i + 1).some((x) => !x.section) && !shown[i + 1]?.section)

  $('#nav').innerHTML = pruned.map((n) => (n.section ? `<div class="nav-label">${n.label}</div>` : link(n))).join('')
    + (hiddenCount
      ? `<button type="button" class="nav-more" id="nav-more" aria-expanded="${expanded}">${
          expanded ? 'Show fewer tools' : `More tools <span class="count">${hiddenCount}</span>`}</button>`
      : '')

  const btn = $('#nav-more')
  if (btn) {
    btn.onclick = () => {
      store.set(MORE_KEY, expanded ? '0' : '1')
      drawNav()
    }
  }
  drawTabbar(path)
}

function drawTabbar(path) {
  const el = $('#tabbar'); if (!el) return
  el.innerHTML = tabbarItems().map((t) => {
    if (t.more) return `<a href="#" data-more="1" role="button" aria-haspopup="menu" aria-controls="sidebar" aria-expanded="false" aria-label="More">${icon(t.ico, 'tico')}${t.name}</a>`
    const on = isActive(t.href, path)
    const c = badges[t.badge]
    return `<a href="#${t.href}" class="${on ? 'on' : ''}"${on ? ' aria-current="page"' : ''}>${icon(t.ico, 'tico')}${t.name}${c ? '<span class="tdot"></span>' : ''}</a>`
  }).join('')
  const more = el.querySelector('[data-more]')
  if (more) more.onclick = (e) => { e.preventDefault(); toggleDrawer(more) }
}

/**
 * Redraw the sidebar: the shop's name, and the six dots.
 *
 * This runs at the end of every navigate() and on every realtime notify/board/conversation event,
 * so it is the hottest client path in the app — and it used to fetch six full list endpoints
 * (/api/dashboard, /api/art, /api/followups, /api/automations, /api/conversations) to read six
 * integers out of them: 48 MB and 1.6 s of server event loop per sidebar click on a shop with a
 * few years of proofs, multiplied by every tab open on the floor whenever anyone moved a job.
 * GET /api/chrome/badges returns exactly those six numbers and nothing else.
 */
async function drawChrome() {
  try {
    const [{ settings }, b] = await Promise.all([api.get('/api/settings'), api.get('/api/chrome/badges')])
    // In the lite edition the product brand is fixed by the deployment (stamped into the shell), not
    // a per-shop setting — don't let a shop's brand_name override the InkVoice chrome.
    if (window.__EDITION !== 'lite') {
      $('#brand-name').textContent = settings.brand_name
      $('#brand-tag').textContent = settings.brand_tagline
      document.title = settings.brand_name
    }
    $('#shop-name').textContent = settings.shop_name
    $('#shop-initials').textContent = initials(settings.shop_name)
    badges = b
    drawNav()
  } catch (e) { console.error('chrome refresh failed', e) }
}

/**
 * Coalesce the bursts. One drag on the job board broadcasts to every open tab in the shop, and a
 * busy floor produces a stream of them; each event used to start its own round trip, so the tabs
 * queued up behind each other. At most one refresh is ever in flight or scheduled.
 */
let chromeTimer = null
function refreshChrome() {
  if (chromeTimer) return
  chromeTimer = setTimeout(() => { chromeTimer = null; drawChrome() }, 250)
}

/**
 * Routes this edition/plan actually owns. Hiding a nav entry is not the same as closing the route:
 * every view stays registered, so in lite a typed `#/board` or `#/roi` (or a stale bookmark, or the
 * old convert flow's redirect) rendered a pro screen the product doesn't include. Send those home.
 *
 * Deliberately allows the prefixes lite reaches through legitimately — /estimates/:id/edit,
 * /invoices/:id, /contacts/:id — by matching on the first path segment only.
 */
function allowedRoute() {
  return true // every route ships to every shop
}

async function navigate() {
  closeDrawer({ silent: true }) // choosing a destination inside the drawer closes it; don't steal focus
  closeSearch() // otherwise the palette lingers over the new page on back/forward
  // Ask the screen we are leaving whether it is safe to repaint over it. A hash change is this
  // app's only navigation, so this is the single choke point every route change goes through:
  // Cancel, a sidebar click, a `g e` shortcut and the browser's Back button all land here.
  // Returning false means the URL has been put back and this screen must NOT be redrawn.
  if (!acceptRoute(location.hash || '#/')) return
  const path = location.hash.replace(/^#/, '').split('?')[0] || '/'
  if (!allowedRoute(path)) { location.hash = '#/'; return }
  drawNav()
  await runRouter()
  window.scrollTo(0, 0)
  // Replay the entrance animation on every navigation (force reflow so it re-triggers).
  const v = $('#view')
  v.classList.remove('view-in'); void v.offsetWidth; v.classList.add('view-in')
  refreshChrome()
}

window.addEventListener('hashchange', navigate)

/* Setting location.hash to the value it already holds fires no hashchange, so every sidebar link,
 * every tabbar link and every in-view `<a href="#/...">` is inert on the screen it points at. That
 * is invisible when the screen is fine and a trap when it is not: a view that failed to load, a
 * list gone stale behind a lost websocket, the 404 panel's "Back to dashboard" while standing on
 * '#/'. The instinct is always to click the nav item again, so make that mean "repaint this". */
const sameHash = (e) => {
  if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  const a = e.target?.closest?.('a[href^="#/"]')
  if (!a) return
  if (a.getAttribute('href') !== (location.hash || '#/')) return   // a real move; let hashchange do it
  e.preventDefault()
  navigate()
}
document.addEventListener('click', sameHash)
window.addEventListener('psc:settings', refreshChrome)

/* -------------------------------------------------------------------------------------------------
 * Accessibility chrome: keyboard-operable topbar controls, an a11y mobile nav drawer, and a skip
 * link. The search trigger and menu button ship as <div>s in the server-stamped shell (index.html),
 * so they're upgraded to real buttons here at runtime — role, focusability, and Enter/Space.
 * ---------------------------------------------------------------------------------------------- */

const sidebar = $('#sidebar')
const menuBtn = $('#menu-btn')

/** Promote a non-focusable <div> control to a keyboard-operable button, preserving its click use. */
function asButton(el, label, onActivate) {
  if (!el) return
  el.setAttribute('role', 'button')
  el.setAttribute('tabindex', '0')
  if (label && !el.getAttribute('aria-label')) el.setAttribute('aria-label', label)
  el.addEventListener('click', onActivate)
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); onActivate(e) }
  })
}

// Mobile nav drawer — the sidebar slides in under 900px. Give it a backdrop, Escape / outside-tap
// close, aria-expanded on its toggles, and a focus trap so keyboard focus can't leak to the page
// behind it. Focus returns to whatever opened it.
let drawerReturnFocus = null
let backdrop = document.getElementById('drawer-backdrop')
if (!backdrop) {
  backdrop = document.createElement('div')
  backdrop.id = 'drawer-backdrop'
  backdrop.className = 'drawer-backdrop'
  backdrop.hidden = true
  document.body.appendChild(backdrop)
}
backdrop.addEventListener('click', () => closeDrawer())

const drawerOpen = () => sidebar?.classList.contains('open')

/** Visible, tabbable elements inside a container — for the focus trap and initial focus. */
function focusablesIn(container) {
  return [...container.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.hasAttribute('hidden') && el.offsetParent !== null)
}

function setToggles(expanded) {
  menuBtn?.setAttribute('aria-expanded', String(expanded))
  document.querySelectorAll('[data-more]').forEach((m) => m.setAttribute('aria-expanded', String(expanded)))
}

function openDrawer(opener) {
  if (!sidebar || drawerOpen()) return
  drawerReturnFocus = opener || menuBtn
  sidebar.classList.add('open')
  backdrop.hidden = false
  setToggles(true)
  focusablesIn(sidebar)[0]?.focus()
}

function closeDrawer(opts) {
  backdrop.hidden = true
  if (!sidebar || !drawerOpen()) return
  sidebar.classList.remove('open')
  setToggles(false)
  const back = drawerReturnFocus
  drawerReturnFocus = null
  // On navigation we close silently — the new page owns focus, not the hamburger.
  if (!opts?.silent && back && document.contains(back) && back.offsetParent !== null) back.focus()
}

function toggleDrawer(opener) { drawerOpen() ? closeDrawer() : openDrawer(opener) }

// Escape closes the drawer; Tab is cycled within it while open.
document.addEventListener('keydown', (e) => {
  if (!drawerOpen()) return
  if (e.key === 'Escape') { e.preventDefault(); closeDrawer(); return }
  if (e.key !== 'Tab') return
  const f = focusablesIn(sidebar)
  if (!f.length) return
  const first = f[0], last = f[f.length - 1]
  if (!sidebar.contains(document.activeElement)) { e.preventDefault(); first.focus() }
  else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
})

menuBtn?.setAttribute('aria-controls', 'sidebar')
menuBtn?.setAttribute('aria-haspopup', 'menu')
setToggles(false)
asButton(menuBtn, 'Menu', () => toggleDrawer(menuBtn))
asButton($('#search-trigger'), 'Search', openSearch)

// Skip link — the first focusable element on the page, visually hidden until focused, jumps focus
// to the main content region. It manages focus itself so it never disturbs the hash router.
const viewEl = $('#view')
if (viewEl && !document.querySelector('.skip-link')) {
  viewEl.setAttribute('tabindex', '-1')
  const skip = document.createElement('a')
  skip.href = '#view'
  skip.className = 'skip-link'
  skip.textContent = 'Skip to content'
  skip.addEventListener('click', (e) => { e.preventDefault(); viewEl.focus(); viewEl.scrollIntoView() })
  document.body.insertBefore(skip, document.body.firstChild)
}

$('#asst-trigger').onclick = () => openAssistant()
window.addEventListener('psc:assistant', (e) => openAssistant(e.detail))
wireSearchHotkey()
wireKeys()

// Theme toggle — persists, and the whole UI cross-fades via the body transition.
$('#theme-toggle').onclick = () => {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light'
  document.documentElement.setAttribute('data-theme', next)
  store.set('psc-theme', next)
}

// Logout — clears the server session and returns to the login page.
$('#logout-btn').onclick = async () => {
  try { await api.post('/api/auth/logout') } catch { /* sign out locally regardless */ }
  // Leave nothing of this shop on the device — floor tablets are shared.
  try { navigator.serviceWorker?.controller?.postMessage('CLEAR_CACHES') } catch { /* no SW */ }
  try { if (window.caches) await caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k)))) } catch { /* best effort */ }
  location.href = '/login'
}

// Trial / upgrade banner across the top of the app.
function updateTrialBar(b) {
  const el = $('#trialbar'); if (!el) return
  if (!b || b.subscribed) { el.hidden = true; return }
  if (b.status === 'trial_expired' || b.locked) {
    el.hidden = false; el.className = 'trialbar danger'
    el.innerHTML = 'Your free trial has ended — <strong>choose a plan to keep working →</strong>'
  } else if (b.status === 'trialing') {
    el.hidden = false; el.className = 'trialbar'
    el.innerHTML = `<strong>${b.trial_days_left} day${b.trial_days_left === 1 ? '' : 's'} left</strong> in your free trial — see plans and upgrade →`
  } else { el.hidden = true }
}

/**
 * Realtime — a WebSocket to the shop's room. Board moves, new messages, and bot-captured leads
 * arrive live: badges refresh, the board reshuffles, and notifications toast. Purely additive —
 * if the socket never connects the app still works on refresh.
 */
let ws = null, wsTries = 0, wsTimer = null
function connectRealtime() {
  // Already connected or on the way — the reconnect triggers below can all fire at once (a laptop
  // waking up is 'online' AND 'visibilitychange'), and two sockets per tab is two of every message.
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  clearTimeout(wsTimer); wsTimer = null
  try {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    // Held locally as well as on `ws`. The handlers used to close over the module-level variable,
    // so a close arriving late from a socket that had already been replaced nulled out the NEWER
    // one and took the live layer down with it.
    const sock = new WebSocket(`${proto}://${location.host}/ws`)
    ws = sock
    sock.onopen = () => { wsTries = 0 }
    sock.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data) } catch { return }
      handleRealtime(m)
    }
    sock.onclose = () => {
      if (ws !== sock) return // a later connection already took over
      ws = null
      wsTries++
      // Keep retrying, forever. This used to give up after 40 attempts — about eight minutes — and
      // never try again: the board stopped reshuffling, notifications stopped arriving, and nothing
      // on screen said so. A shop on a floor tablet leaves that tab open all day, so the live layer
      // was reliably dead by mid-morning and only a manual refresh brought it back. Backing off to
      // 30s costs nothing while the server is down and reconnects promptly when it returns.
      wsTimer = setTimeout(connectRealtime, Math.min(30000, 1000 * wsTries))
    }
    sock.onerror = () => { try { sock.close() } catch { /* already closing */ } }
  } catch { wsTimer = setTimeout(connectRealtime, 5000) }
}
// The two moments a dropped socket is worth retrying immediately rather than on the next backoff
// tick: the network came back, or the tab did. Both are the ordinary shop cases — wifi dropping in
// the back of the shop, and a laptop that was shut for lunch.
addEventListener('online', () => { wsTries = 0; connectRealtime() })
addEventListener('visibilitychange', () => { if (!document.hidden) { wsTries = 0; connectRealtime() } })

function handleRealtime(m) {
  const path = location.hash.replace(/^#/, '').split('?')[0] || '/'
  if (m.type === 'notify') {
    toast(`${m.data?.title || 'Update'}${m.data?.body ? ' — ' + m.data.body : ''}`)
    refreshChrome()
  } else if (m.type === 'board') {
    // someone (or the bot) moved a job. Say so: the repaint is silent, so a screen-reader user
    // watching the board is given no reason for the columns having changed under them.
    if (path.startsWith('/board')) { runRouter(); announce('The job board was updated.') }
    refreshChrome()
  } else if (m.type === 'conversation' || m.type === 'chat') {
    // The receptionist screen holds an unsaved form — knowledge base, greeting, persona, FAQ rows
    // — and rtBroadcast('chat') reaches the WHOLE shop on every takeover reply, so a colleague
    // answering a website chat from their own desk used to wipe whatever this person was writing.
    if (path.startsWith('/receptionist')) { if (!window.__pscAgentDirty?.()) runRouter() }
    else if (path.startsWith('/conversations')) runRouter()
    refreshChrome()
  }
}

/**
 * Boot: confirm a shop is signed in before showing the app. In single-tenant dev this always
 * passes. A brand-new shop (onboarding not finished) is taken to the guided welcome flow.
 */
async function boot() {
  try {
    const me = await api.get('/api/auth/me')
    if (!me.authed) { location.href = '/login'; return }
    window.__me = me
    if (!me.single_tenant) $('#logout-btn').hidden = false
    updateTrialBar(me.billing)
    // Nudge a brand-new shop into setup — but only when they land on the root. A specific deep link
    // (an emailed estimate/proof link, a bookmarked job) is honored, so onboarding never hijacks it.
    const h = (location.hash || '').replace(/^#/, '')
    const atRoot = h === '' || h === '/'
    if (me.authed && me.single_tenant !== true && me.onboarding_done === false && atRoot) {
      location.hash = '#/welcome'
    }
  } catch (e) {
    /* Not every failure of /api/auth/me means "not signed in".
     *
     * A 401 already redirects inside api.req() before it ever throws here. What was left was
     * everything ELSE — a 502 from nginx during a deploy, a dropped connection on a train, a 500 —
     * and this catch answered all of them by hard-navigating to /login. That signs a working
     * session out of its own URL: the emailed proof link, the bookmarked job, the estimate a
     * customer is on the phone about, all replaced by a sign-in form that will then land them on
     * the dashboard. The one thing the person wanted is the one thing that is gone.
     *
     * Keep the URL and offer the retry instead. The hash is untouched, so pressing it resumes
     * exactly where they were. */
    bootFailed(e)
    return
  }
  drawNav()
  navigate()
  connectRealtime()
}

/** The app could not start. Say why, keep the address bar, and offer the way back in. */
function bootFailed(e) {
  const view = document.getElementById('view')
  const why = String(e?.message || 'The server did not answer.')
  if (!view) { location.reload(); return }
  view.innerHTML = `<div class="card" style="max-width:520px;margin:60px auto;text-align:center">
      <h2 style="margin-top:0">Could not reach your shop</h2>
      <p class="dim" style="line-height:1.6">${why.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))}</p>
      <p class="dim" style="font-size:12px">This page is usually back within a few seconds of a restart. Your link is still in the address bar.</p>
      <div class="row" style="gap:8px;justify-content:center;margin-top:14px">
        <button class="btn" id="boot-retry" type="button">Try again</button>
        <a class="btn ghost" href="/login">Sign in</a>
      </div>
    </div>`
  view.setAttribute('role', 'alert')
  const btn = document.getElementById('boot-retry')
  if (btn) { btn.onclick = () => { btn.disabled = true; btn.textContent = 'Trying…'; boot() }; btn.focus() }
}
boot()
