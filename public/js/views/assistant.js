import { api, $, $$, el, esc, go, on, toast } from '../core.js'

/**
 * The Assistant panel — a slide-over you can open from any page to just say what you need.
 * "Quote 48 navy hoodies for Northgate", "who owes me money", "move the Wildcats job to
 * production". It calls /api/assistant, which does the thing and answers. Every result links
 * into the app so the human can take over — AI-first, manual-always.
 */
let panel = null
const history = [] // { role: 'user'|'bot', ...payload } — kept for the session

const GREETING = {
  role: 'bot',
  reply: "Hey — I'm your front desk. Tell me what you need and I'll handle it (or point you to it). Everything I do, you can edit or undo.",
  followups: ["What's due today?", 'Who owes me money?', 'Quote 48 navy hoodies, 2 color front, for Northgate', "How's the board?"],
}

/** ** bold ** and newlines → safe HTML. */
const fmt = (s) => esc(String(s || '')).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>')

export function openAssistant(seed) {
  if (panel) { $('#asst-input', panel)?.focus(); if (seed) send(seed); return }
  panel = el(`<div class="asst">
    <div class="asst-head">
      <div class="asst-badge">◍</div>
      <div style="flex:1"><div class="asst-title">Assistant</div><div class="asst-sub">Message your problem</div></div>
      <button class="asst-x" data-close aria-label="Close the assistant">&times;</button>
    </div>
    <div class="asst-log" id="asst-log"></div>
    <div class="asst-compose">
      <textarea id="asst-input" rows="1" placeholder="Ask or tell me anything…"></textarea>
      <button class="asst-send" id="asst-send" title="Send" aria-label="Send this message">↑</button>
    </div>
  </div>`)
  document.body.appendChild(panel)
  void panel.offsetWidth // paint the off-screen start state so the slide-in transitions
  setTimeout(() => panel && panel.classList.add('open'), 10) // setTimeout (not rAF) so it fires even when backgrounded
  on(panel, '[data-close]', closeAssistant)

  if (!history.length) history.push(GREETING)
  render()

  // Delegated handlers attached ONCE to the persistent log (render() only swaps innerHTML) —
  // attaching them per-render would stack and fire N times on one click.
  const log = $('#asst-log', panel)
  on(log, '[data-href]', (_e, t) => { closeAssistant(); go(t.dataset.href) })
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
}

function render() {
  const log = $('#asst-log', panel); if (!log) return
  log.innerHTML = history.map((m, i) => m.role === 'user'
    ? `<div class="asst-msg user"><div class="asst-bub">${fmt(m.reply)}</div></div>`
    : `<div class="asst-msg bot">
        <div class="asst-bub">${m.thinking ? '<span class="asst-dots"><i></i><i></i><i></i></span>' : fmt(m.reply)}${m.model ? ' <span class="asst-ai">AI</span>' : ''}</div>
        ${(m.cards || []).map((c, ci) => `<a class="asst-card" data-href="${esc(c.href)}"><span class="asst-card-ic">${c.icon || '→'}</span>
          <span><span class="asst-card-t">${esc(c.title)}</span>${c.sub ? `<span class="asst-card-s">${esc(c.sub)}</span>` : ''}</span></a>`).join('')}
        ${m.action?.undo ? `<button class="asst-undo" data-undo="${i}">Undo that</button>` : ''}
        ${(m.followups || []).length ? `<div class="asst-chips">${m.followups.map((f) => `<button class="asst-chip" data-chip="${esc(f)}">${esc(f)}</button>`).join('')}</div>` : ''}
      </div>`).join('')
  log.scrollTop = log.scrollHeight
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
}
