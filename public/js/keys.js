import { $, $$, el, esc, go, on } from './core.js'
import { openSearch } from './views/search.js'

/**
 * Keyboard system — the click-saver power users expect, discoverable so beginners aren't
 * left out. Everything here is ADDITIVE: every shortcut maps to something you can still do
 * with the mouse. `?` shows the full list; nothing is hidden or gated.
 *
 * Conventions follow the 2026 norm (Linear/GitHub/Gmail): `g` then a letter to go somewhere,
 * single keys for the common action on the current page, `/` or ⌘K to search, `?` for help.
 */

// Per-page "new" action, so `n` always does the obvious thing where you are. URL-driven
// (?new=1) so it's also linkable and each view opens its own create form on load.
export const NEW_HREF = {
  '/estimates': '/estimates/new',
  '/invoices': '/estimates/new',
  '/board': '/board?new=1',
  '/jobs': '/board?new=1',
  '/contacts': '/contacts?new=1',
  '/pipeline': '/pipeline?new=1',
  '/automations': '/automations?new=1',
  '*': '/estimates/new',
}
export const newHrefFor = (p) => NEW_HREF[Object.keys(NEW_HREF).find((k) => k !== '*' && p.startsWith(k))] || NEW_HREF['*']

export const GOTO = [
  ['d', '/', 'Dashboard'],
  ['a', '/autopilot', 'Autopilot'],
  ['b', '/board', 'Job Board'],
  ['y', '/capacity', 'Capacity & promise dates'],
  ['e', '/estimates', 'Estimates'],
  ['v', '/invoices', 'Invoices'],
  ['p', '/pipeline', 'Pipeline'],
  ['i', '/conversations', 'Conversations (inbox)'],
  ['c', '/contacts', 'Customers'],
  ['f', '/followups', 'Follow-ups'],
  ['r', '/reorders', 'Reorder Radar'],
  ['u', '/automations', 'Automations'],
  [',', '/settings', 'Settings'],
]

const SHORTCUTS = [
  { keys: ['a'], desc: 'Ask the assistant' },
  { keys: ['⌘K', '/'], desc: 'Search & run commands' },
  { keys: ['g then …'], desc: 'Go to a page (see below)' },
  { keys: ['n'], desc: 'New (estimate / job / customer — depends on page)' },
  { keys: ['t'], desc: 'Toggle light / dark' },
  { keys: ['?'], desc: 'This help' },
  { keys: ['Esc'], desc: 'Close anything' },
]

const isTyping = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable
const path = () => location.hash.replace(/^#/, '').split('?')[0] || '/'

let awaitingG = false
let gTimer

export function wireKeys() {
  window.addEventListener('psc:help', helpOverlay)
  window.addEventListener('keydown', (e) => {
    // ⌘K / Ctrl-K is owned by search.js, which toggles it — handling it here too would
    // close and immediately reopen the palette on the same keystroke.
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (isTyping(e)) return

    // `g` then a letter = go to a page.
    if (awaitingG) {
      awaitingG = false; clearTimeout(gTimer)
      const dest = GOTO.find(([k]) => k === e.key.toLowerCase())
      if (dest) { e.preventDefault(); go(dest[1]) }
      return
    }

    switch (e.key) {
      case 'g': awaitingG = true; clearTimeout(gTimer); gTimer = setTimeout(() => { awaitingG = false }, 1200); e.preventDefault(); break
      case '/': e.preventDefault(); openSearch(); break
      case '?': e.preventDefault(); helpOverlay(); break
      case 'n': e.preventDefault(); go(newHrefFor(path())); break
      case 'a': e.preventDefault(); window.dispatchEvent(new Event('psc:assistant')); break
      case 't': e.preventDefault(); $('#theme-toggle')?.click(); break
      default: break
    }
  })
}

export function helpOverlay() {
  if ($('.kbd-help')) return $('.kbd-help').remove()
  const ov = el(`<div class="kbd-help" tabindex="-1">
    <div class="kbd-card">
      <div class="kbd-h"><h3>Keyboard shortcuts</h3><button class="x" data-close>&times;</button></div>
      <div class="kbd-cols">
        <div><div class="kbd-sec">Anywhere</div>
          ${SHORTCUTS.map((s) => `<div class="kbd-row"><span>${s.desc}</span><span class="kbd-keys">${s.keys.map((k) => `<kbd>${esc(k)}</kbd>`).join('')}</span></div>`).join('')}</div>
        <div><div class="kbd-sec">Go to (press <kbd>g</kbd> then…)</div>
          ${GOTO.map(([k, , label]) => `<div class="kbd-row"><span>${esc(label)}</span><span class="kbd-keys"><kbd>g</kbd><kbd>${esc(k)}</kbd></span></div>`).join('')}</div>
      </div>
      <div class="kbd-foot">Every shortcut also has a button — nothing here is the only way to do it.</div>
    </div></div>`)
  document.body.appendChild(ov)
  on(ov, '[data-close]', () => ov.remove())
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) ov.remove() })
  ov.focus()
}
