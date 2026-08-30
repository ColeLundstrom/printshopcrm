import { api, $, $$, el, esc, go, on, toast, announce, focusKeeper } from '../core.js'

/**
 * The Assistant panel — a slide-over you can open from any page to just say what you need.
 * "Quote 48 navy hoodies for Northgate", "who owes me money", "move the Wildcats job to
 * production". It calls /api/assistant, which does the thing and answers. Every result links
 * into the app so the human can take over — AI-first, manual-always.
 */
let panel = null
// Where focus goes when the panel closes. closeAssistant() used to drop it on <body>, and render()
// destroys the chip or button that was focused on every reply, so a keyboard user was thrown to
// the top of the document mid-conversation.
let asstReturnFocus = null
const history = [] // { role: 'user'|'bot', ...payload } — kept for the session

const GREETING = {
  role: 'bot',
  reply: "Hey — I'm your front desk. Tell me what you need and I'll handle it (or point you to it). Everything I do, you can edit or undo.",
  followups: ["What's due today?", 'Who owes me money?', 'Quote 48 navy hoodies, 2 color front, for Northgate', "How's the board?"],
}

/** ** bold ** and newlines → safe HTML. */
const fmt = (s) => esc(String(s || '')).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>')

/**
 * A NON-modal slide-over: the page behind stays live and there is no backdrop, so a hard focus
 * trap would be wrong here. What it did need and did not have: a dialog role (a screen reader was
 * never told a panel had opened), focus restore, a working Escape from anywhere inside it, and —
 * the one with teeth — an entry in keys.js's dialogOpen(). With focus on a chip or the send
 * button, every global single-key shortcut fired straight through: `n` navigated the page out
 * from under the open panel, `t` flipped the theme mid-conversation, `g b` jumped to the board.
 */
export function openAssistant(seed) {
  if (panel) { $('#asst-input', panel)?.focus(); if (seed) send(seed); return }
  asstReturnFocus = focusKeeper()
  panel = el(`<div class="asst" role="dialog" aria-label="Assistant">
    <div class="asst-head">
      <div class="asst-badge">◍</div>
      <div style="flex:1"><div class="asst-title">Assistant</div><div class="asst-sub">Message your problem</div></div>
      <button class="asst-x" data-close aria-label="Close the assistant">&times;</button>
    </div>
    <div class="asst-log" id="asst-log" role="log" aria-live="polite" aria-atomic="false"></div>
    <div class="asst-compose">
      <textarea id="asst-input" rows="1" placeholder="Ask or tell me anything…"></textarea>
      <button class="asst-send" id="asst-send" title="Send" aria-label="Send this message">↑</button>
    </div>
  </div>`)
  document.body.appendChild(panel)
  // Escape from anywhere in the panel, not only from the textarea. keys.js's global Escape is
  // owned by the help overlay, and dialogOpen() now returns early for `.asst`, so this is the
  // only handler that can close it from a chip, a card or the send button.
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeAssistant() } })
  void panel.offsetWidth // paint the off-screen start state so the slide-in transitions
  setTimeout(() => panel && panel.classList.add('open'), 10) // setTimeout (not rAF) so it fires even when backgrounded
  on(panel, '[data-close]', closeAssistant)

  if (!history.length) history.push(GREETING)
  render()

  // Delegated handlers attached ONCE to the persistent log (render() only swaps innerHTML) —
  // attaching them per-render would stack and fire N times on one click.
  const log = $('#asst-log', panel)
  // The cards ARE the answer — the docstring above says "every result links into the app so the
  // human can take over" — and they were `<a>` with no href, so they were not links: not
  // focusable, not reachable by Tab, not activatable by Enter, and announced as nothing. The href
  // makes them real links; the handler still owns the click so the panel closes with them.
  on(log, '[data-href]', (e, t) => { e.preventDefault(); closeAssistant(); go(t.dataset.href) })
  on(log, '[data-chip]', (_e, t) => send(t.dataset.chip))
  on(log, '[data-undo]', async (_e, t) => {
    const m = history[+t.dataset.undo]; const u = m?.action?.undo
    if (u?.type === 'job_stage') { await api.patch(`/api/jobs/${u.id}/stage`, { stage: u.stage }); delete m.action; toast('Undone'); pushBot({ reply: 'Reverted — put it back where it was.' }) }
  })

  const input = $('#asst-input', panel)
  const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(120, input.scrollHeight) + 'px' }
  input.oninput = grow
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const v = input.value.trim(); if (v) { input.value = ''; grow(); send(v) } }
    if (e.key === 'Escape') closeAssistant()
  }
  $('#asst-send', panel).onclick = () => { const v = input.value.trim(); if (v) { input.value = ''; grow(); send(v) } }
  input.focus()
  if (seed) send(seed)
}

export function closeAssistant() {
  if (!panel) return
  panel.classList.remove('open')
  const p = panel; panel = null
  setTimeout(() => p.remove(), 250)
  const back = asstReturnFocus
  asstReturnFocus = null
  back?.()
}

function render() {
  const log = $('#asst-log', panel); if (!log) return
  /**
   * The two controls this function is fired FROM — a followup chip and "Undo that" — live inside
   * #asst-log, and this innerHTML replaces it. So pressing either dropped focus on <body>, outside
   * a NON-modal panel, with the skip link, the sidebar and the whole page to Tab back through.
   * board.js and scan.js already carry this rule and the gate asserts it for both.
   *
   * `log.contains(activeElement)` is deliberately narrow: focus only moves when it was inside the
   * node about to be destroyed, so someone typing in the compose box while an answer arrives is
   * not interrupted, and neither is anyone reading the page behind this panel. The compose box is
   * the control that does the next thing here, and unlike a chip it is outside the log.
   */
  const hadFocus = log.contains(document.activeElement)
  log.innerHTML = history.map((m, i) => m.role === 'user'
    ? `<div class="asst-msg user"><div class="asst-bub">${fmt(m.reply)}</div></div>`
    : `<div class="asst-msg bot">
        <div class="asst-bub">${m.thinking ? '<span class="asst-dots"><i></i><i></i><i></i></span>' : fmt(m.reply)}${m.model ? ' <span class="asst-ai">AI</span>' : ''}</div>
        ${(m.cards || []).map((c) => `<a class="asst-card" href="#${esc(c.href)}" data-href="${esc(c.href)}"><span class="asst-card-ic" aria-hidden="true">${c.icon || '→'}</span>
          <span><span class="asst-card-t">${esc(c.title)}</span>${c.sub ? `<span class="asst-card-s">${esc(c.sub)}</span>` : ''}</span></a>`).join('')}
        ${m.action?.undo ? `<button class="asst-undo" data-undo="${i}">Undo that</button>` : ''}
        ${(m.followups || []).length ? `<div class="asst-chips">${m.followups.map((f) => `<button class="asst-chip" data-chip="${esc(f)}">${esc(f)}</button>`).join('')}</div>` : ''}
      </div>`).join('')
  log.scrollTop = log.scrollHeight
  if (hadFocus) $('#asst-input', panel)?.focus?.()
}

const pushBot = (payload) => { history.push({ role: 'bot', ...payload }); render() }

async function send(text) {
  history.push({ role: 'user', reply: text })
  const thinking = { role: 'bot', thinking: true }
  history.push(thinking); render()
  try {
    const r = await api.post('/api/assistant', { message: text })
    Object.assign(thinking, { thinking: false, ...r })
  } catch (e) {
    Object.assign(thinking, { thinking: false, reply: `Something went wrong: ${e.message}` })
  }
  render()
  // The log is a live region, but render() rewrites the WHOLE list on every turn, which reads as
  // a wall of text rather than the new answer. Say the settled reply, once.
  announce(thinking.reply || 'The assistant answered.')
}
