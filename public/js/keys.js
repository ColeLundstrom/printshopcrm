import { $, $$, el, esc, go, on, trapTab, focusKeeper } from './core.js'
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
/** True while a modal, the search palette, the help overlay or the mobile drawer is up. */
// `.asst` was missing. With focus on an Assistant chip or its send button, `n` navigated the page
// out from under the open panel, `t` flipped the theme mid-conversation and `g b` jumped to the
// board — the exact bug the comment below was written to fix, one overlay short of covering it.
const dialogOpen = () => !!($('#modal-root')?.firstElementChild || $('.kbd-help') || $('.cmd-bg') || $('.asst') || $('#sidebar')?.classList.contains('open'))
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

    // The help overlay had no keyboard close at all: Escape did nothing and the only exits were
    // clicking its × or its backdrop. It goes through the same close as the × and the backdrop,
    // or Escape leaves focus on <body> instead of handing it back to whatever opened the overlay.
    if (e.key === 'Escape') { closeHelp?.(); return }

    // A dialog owns the keyboard while it is open. These are single, unmodified keys and
    // isTyping() only covers a focused INPUT/TEXTAREA/SELECT — so with focus on the Delete button
    // of a confirm dialog, `n` navigated the page out from under the dialog, `t` flipped the
    // theme mid-form and `g` armed a jump the user never asked for.
    if (dialogOpen()) return

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

/**
 * The overlay the keyboard user is most stranded inside, because it is the one written FOR them.
 *
 * It was a bare `<div class="kbd-help" tabindex="-1">`: no dialog role, so a screen reader was
 * never told the page behind was blocked; no focus trap, so Tab walked invisibly into the sidebar
 * under the blur and Enter fired whatever it landed on; and `ov.remove()` dropped focus on <body>,
 * so the reward for reading the shortcut list was being dumped at the top of the document.
 * modal() has done all three correctly since v11 — this one just never went through it.
 */
let closeHelp = null
export function helpOverlay() {
  if ($('.kbd-help')) return (closeHelp || (() => $('.kbd-help').remove()))()
  const back = focusKeeper()
  const ov = el(`<div class="kbd-help">
    <div class="kbd-card" role="dialog" aria-modal="true" aria-labelledby="kbd-help-t">
      <div class="kbd-h"><h3 id="kbd-help-t">Keyboard shortcuts</h3><button class="x" data-close aria-label="Close the shortcut list">&times;</button></div>
      <div class="kbd-cols">
        <div><div class="kbd-sec">Anywhere</div>
          ${SHORTCUTS.map((s) => `<div class="kbd-row"><span>${s.desc}</span><span class="kbd-keys">${s.keys.map((k) => `<kbd>${esc(k)}</kbd>`).join('')}</span></div>`).join('')}</div>
        <div><div class="kbd-sec">Go to (press <kbd>g</kbd> then…)</div>
          ${GOTO.map(([k, , label]) => `<div class="kbd-row"><span>${esc(label)}</span><span class="kbd-keys"><kbd>g</kbd><kbd>${esc(k)}</kbd></span></div>`).join('')}</div>
      </div>
      <div class="kbd-foot">Every shortcut also has a button — nothing here is the only way to do it.</div>
    </div></div>`)
  document.body.appendChild(ov)
  const close = () => { ov.remove(); closeHelp = null; back() }
  closeHelp = close
  on(ov, '[data-close]', close)
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close() })
  ov.addEventListener('keydown', (e) => trapTab(ov, e))
  $('[data-close]', ov)?.focus()
}
