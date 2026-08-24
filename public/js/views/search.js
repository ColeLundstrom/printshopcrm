import { api, $, $$, el, esc, go, on } from '../core.js'

/**
 * ⌘K command palette — "go to anything, do anything".
 *
 * Two things in one box: fuzzy-matched COMMANDS (create, navigate, toggle) that run
 * instantly and locally, plus live entity SEARCH (jobs, customers, estimates, invoices,
 * deals) from the server. Commands are the click-saver; nothing here is the only way to do
 * a thing — every command is also a button somewhere, and the palette shows its shortcut.
 */
let box = null
let items = []
let cursor = 0
let seq = 0

const themeToggle = () => $('#theme-toggle')?.click()

/** The static command set. `run` fires the action; `hint` shows the keyboard equivalent. */
const COMMANDS = [
  { icon: '◍', title: 'Ask the assistant', kw: 'ask assistant ai help chat message', run: () => window.dispatchEvent(new Event('psc:assistant')), hint: 'a' },
  { icon: '▤', title: 'New estimate', kw: 'create quote new estimate', run: () => go('/estimates/new'), hint: 'n' },
  { icon: '▦', title: 'New job', kw: 'create job board production', run: () => go('/board?new=1') },
  { icon: '◉', title: 'New customer', kw: 'create contact customer add', run: () => go('/contacts?new=1') },
  { icon: '◱', title: 'New opportunity', kw: 'create deal pipeline lead', run: () => go('/pipeline?new=1') },
  { icon: '◆', title: 'Run Autopilot', kw: 'autopilot email automate front office', run: () => go('/autopilot') },
  { icon: '⟳', title: 'New automation', kw: 'create automation rule workflow', run: () => go('/automations?new=1') },
  { icon: '◳', title: 'DTF Resize — trim art to print size', kw: 'dtf resize trim transparent png dpi print size film', run: () => go('/dtf') },
  { icon: '◷', title: 'Can we promise this date?', kw: 'capacity promise date schedule deadline can we hit press hours booked', run: () => go('/capacity'), hint: 'g y' },
  { icon: '⊛', title: 'Reorder Radar — who\'s due to reorder', kw: 'reorder radar repeat customers due follow up cadence returning', run: () => go('/reorders'), hint: 'g r' },
  { icon: '◐', title: 'Toggle light / dark', kw: 'theme dark light mode toggle', run: themeToggle, hint: 't' },
  { icon: '⌨', title: 'Keyboard shortcuts', kw: 'help shortcuts keys cheatsheet', run: () => window.dispatchEvent(new Event('psc:help')), hint: '?' },
  // Navigation — same targets as `g <key>`.
  { icon: '◧', title: 'Go to Dashboard', kw: 'dashboard home', run: () => go('/'), hint: 'g d' },
  { icon: '▦', title: 'Go to Job Board', kw: 'board jobs production kanban', run: () => go('/board'), hint: 'g b' },
  { icon: '▤', title: 'Go to Estimates', kw: 'estimates quotes', run: () => go('/estimates'), hint: 'g e' },
  { icon: '▣', title: 'Go to Invoices', kw: 'invoices money billing', run: () => go('/invoices'), hint: 'g v' },
  { icon: '◱', title: 'Go to Pipeline', kw: 'pipeline deals sales opportunities', run: () => go('/pipeline'), hint: 'g p' },
  { icon: '▭', title: 'Go to Conversations', kw: 'inbox messages conversations chat', run: () => go('/conversations'), hint: 'g i' },
  { icon: '◉', title: 'Go to Customers', kw: 'customers contacts crm', run: () => go('/contacts'), hint: 'g c' },
  { icon: '◎', title: 'Go to Follow-ups', kw: 'followups chase money quotes', run: () => go('/followups'), hint: 'g f' },
  { icon: '⟳', title: 'Go to Automations', kw: 'automations rules workflows', run: () => go('/automations'), hint: 'g u' },
  { icon: '⚙', title: 'Go to Settings', kw: 'settings config shop preferences', run: () => go('/settings'), hint: 'g ,' },
]

/** Subsequence fuzzy score: matches "tgldk" → "Toggle dark", rewards start + consecutive hits. */
function fuzzy(query, text) {
  const q = query.toLowerCase(), t = text.toLowerCase()
  if (!q) return 0
  let qi = 0, score = 0, streak = 0, prevMatch = -2
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      streak = ti === prevMatch + 1 ? streak + 1 : 0
      score += 1 + streak * 2 + (ti === 0 ? 4 : t[ti - 1] === ' ' ? 3 : 0)
      prevMatch = ti; qi++
    }
  }
  return qi === q.length ? score : -1
}

export function openSearch() {
  if (box) return
  box = el(`<div class="cmd-bg">
    <div class="cmd">
      <div class="cmd-in"><span class="cmd-ico">⌕</span>
        <input id="cmd-q" placeholder="Search or run a command…" autocomplete="off" spellcheck="false">
        <kbd>esc</kbd></div>
      <div class="cmd-list" id="cmd-list"></div>
    </div></div>`)
  document.body.appendChild(box)
  box.addEventListener('mousedown', (e) => { if (e.target === box) closeSearch() })
  const input = $('#cmd-q', box)

  const draw = () => {
    if (!items.length) { $('#cmd-list', box).innerHTML = '<div class="cmd-empty">No matches</div>'; return }
    $('#cmd-list', box).innerHTML = items.map((r, i) => `<div class="cmd-i ${i === cursor ? 'on' : ''}" data-i="${i}">
      <span class="ci">${r.icon}</span>
      <div class="ct"><div class="c1">${esc(r.title)}</div>${r.sub ? `<div class="c2">${esc(r.sub)}</div>` : ''}</div>
      ${r.hint ? `<span class="cmd-hintkey">${r.hint.split(' ').map((k) => `<kbd>${esc(k)}</kbd>`).join('')}</span>` : `<span class="cty">${r.type || 'go'}</span>`}</div>`).join('')
    on($('#cmd-list', box), '[data-i]', (_e, t) => pick(+t.dataset.i))
  }

  // Default view: the commands a shop reaches for most.
  const showDefault = () => {
    items = COMMANDS.slice(0, 6).map((c) => ({ ...c, isCmd: true }))
    cursor = 0; draw()
  }

  const pick = (i) => {
    const r = items[i]; if (!r) return
    closeSearch()
    if (r.isCmd) r.run(); else go(r.href)
  }

  let timer
  input.oninput = () => {
    clearTimeout(timer)
    const q = input.value.trim()
    if (!q) return showDefault()
    // Commands match instantly and locally; entities stream in from the server.
    const cmds = COMMANDS.map((c) => ({ c, s: Math.max(fuzzy(q, c.title), fuzzy(q, c.kw) - 1) }))
      .filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, 6).map((x) => ({ ...x.c, isCmd: true }))
    items = cmds; cursor = 0; draw()
    timer = setTimeout(async () => {
      const mine = ++seq
      try {
        const rows = await api.get(`/api/search?q=${encodeURIComponent(q)}`)
        if (mine !== seq || input.value.trim() !== q) return
        items = [...cmds, ...rows]; draw()
      } catch { /* keep the commands even if search fails */ }
    }, 120)
  }

  input.onkeydown = (e) => {
    if (e.key === 'Escape') return closeSearch()
    if (e.key === 'ArrowDown') { e.preventDefault(); cursor = Math.min(cursor + 1, items.length - 1); draw(); scrollTo() }
    if (e.key === 'ArrowUp') { e.preventDefault(); cursor = Math.max(cursor - 1, 0); draw(); scrollTo() }
    if (e.key === 'Enter') { e.preventDefault(); pick(cursor) }
  }
  const scrollTo = () => $('.cmd-i.on', box)?.scrollIntoView({ block: 'nearest' })

  showDefault()
  input.focus()
}

export function closeSearch() {
  box?.remove(); box = null; items = []; cursor = 0
}

/** ⌘K / Ctrl-K anywhere. (`/` and other keys are handled by the keyboard system.) */
export function wireSearchHotkey() {
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); box ? closeSearch() : openSearch() }
  })
}
