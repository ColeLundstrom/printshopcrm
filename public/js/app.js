import { api, $, $$, esc, route, runRouter, initials, on, toast } from './core.js'
import { dashboardView } from './views/dashboard.js'
import { agentView } from './views/agent.js'
import { productsView } from './views/products.js'
import { pricingView } from './views/pricing.js'
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
import { sepsView } from './views/seps.js'
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
  // Separation Studio hidden from nav 2026-08-19 — underperforms; route still reachable by URL.
  { href: '/dtf', ico: 'dtf', name: 'DTF Resize' },
  { href: '/gangsheet', ico: 'gangsheet', name: 'Gang Sheet Builder' },
  { href: '/capacity', ico: 'capacity', name: 'Capacity' },
  { href: '/scan', ico: 'board', name: 'Floor Mode' },
  { label: 'Money', section: true },
  { href: '/pricing', ico: 'pricing', name: 'Pricing' },
  { href: '/invoices', ico: 'invoices', name: 'Invoices', badge: 'open_invoices' },
  { href: '/roi', ico: 'roi', name: 'Profitability' },
  { href: '/books', ico: 'invoices', name: 'Books & A/R' },
  { label: 'Customers', section: true },
  { href: '/contacts', ico: 'customers', name: 'Customers' },
  { label: 'Automate', section: true },
  { href: '/autopilot', ico: 'autopilot', name: 'Autopilot' },
  { href: '/receptionist', ico: 'receptionist', name: 'AI Receptionist' },
  { href: '/automations', ico: 'automations', name: 'Automations', badge: 'automations' },
  { label: 'More', section: true },
  { href: '/products', ico: 'products', name: 'Products' },
  { href: '/activity', ico: 'activity', name: 'Activity' },
  { href: '/developers', ico: 'settings', name: 'Developers' },
  { href: '/outbox', ico: 'outbox', name: 'Outbox' },
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
route(/^\/board$/, boardView)
route(/^\/capacity$/, capacityView)
route(/^\/jobs\/(\d+)$/, jobDetailView)
route(/^\/art$/, artView)
route(/^\/seps/, sepsView)
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

function drawNav() {
  const path = location.hash.replace(/^#/, '').split('?')[0] || '/'
  $('#nav').innerHTML = visibleNav().map((n) => {
    if (n.section) return `<div class="nav-label">${n.label}</div>`
    const on = isActive(n.href, path)
    const c = badges[n.badge]
    return `<a href="#${n.href}" class="${on ? 'on' : ''} ${n.hot ? 'hot' : ''}"${on ? ' aria-current="page"' : ''}>${icon(n.ico, 'ico')}${n.name}${n.hot ? '<span class="hotdot"></span>' : ''}${c ? `<span class="count">${c}</span>` : ''}</a>`
  }).join('')
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

async function refreshChrome() {
  try {
    const [{ settings }, d, art, fu, au, cv] = await Promise.all([api.get('/api/settings'), api.get('/api/dashboard'), api.get('/api/art'), api.get('/api/followups'), api.get('/api/automations'), api.get('/api/conversations')])
    // In the lite edition the product brand is fixed by the deployment (stamped into the shell), not
    // a per-shop setting — don't let a shop's brand_name override the InkVoice chrome.
    if (window.__EDITION !== 'lite') {
      $('#brand-name').textContent = settings.brand_name
      $('#brand-tag').textContent = settings.brand_tagline
      document.title = settings.brand_name
    }
    $('#shop-name').textContent = settings.shop_name
    $('#shop-initials').textContent = initials(settings.shop_name)
    badges = {
      active_jobs: d.kpis.active_jobs,
      open_invoices: d.outstanding_invoices.length,
      art_pending: art.filter((a) => a.status === 'sent' || a.status === 'rejected').length,
      followups: fu.stale.length + fu.overdue.length,
      automations: au.stats.enabled,
      unread: cv.unread_total,
    }
    drawNav()
  } catch (e) { console.error('chrome refresh failed', e) }
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
  localStorage.setItem('psc-theme', next)
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
let ws = null, wsTries = 0
function connectRealtime() {
  try {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(`${proto}://${location.host}/ws`)
    ws.onopen = () => { wsTries = 0 }
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data) } catch { return }
      handleRealtime(m)
    }
    ws.onclose = () => { ws = null; wsTries++; if (wsTries < 40) setTimeout(connectRealtime, Math.min(15000, 1000 * wsTries)) }
    ws.onerror = () => { try { ws.close() } catch {} }
  } catch { /* ignore — no live layer, app still fine */ }
}

function handleRealtime(m) {
  const path = location.hash.replace(/^#/, '').split('?')[0] || '/'
  if (m.type === 'notify') {
    toast(`${m.data?.title || 'Update'}${m.data?.body ? ' — ' + m.data.body : ''}`)
    refreshChrome()
  } else if (m.type === 'board') {
    if (path.startsWith('/board')) runRouter()   // someone (or the bot) moved a job
    refreshChrome()
  } else if (m.type === 'conversation' || m.type === 'chat') {
    if (path.startsWith('/conversations') || path.startsWith('/receptionist')) runRouter()
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
  } catch { location.href = '/login'; return }
  drawNav()
  navigate()
  connectRealtime()
}
boot()
