import { api, $, $$, esc, relTime, initials, setPage, empty, toast, on, onOnce, go, announce } from '../core.js'

/**
 * Connected conversation history, with an in-memory draft and pending-operation state per
 * customer. SMTP alone does not synchronize a mailbox. Never reuse a draft for another contact.
 */
let activeId = null
let screen = null

const isCurrent = s => screen === s && s.owner === window.__me && s.list.isConnected && s.thread.isConnected && /^#\/conversations(?:\/\d+)?(?:\?|$)/.test(location.hash)
const draftFor = (s, id) => s.drafts.get(id) || { text: '', channel: 'email', revision: 0 }
function saveDraft(s, id, text, channel) {
  const old = draftFor(s, id)
  const next = text === old.text && channel === old.channel ? old : { text, channel, revision: old.revision + 1 }
  s.drafts.set(id, next)
  return next
}
function captureDraft(s) {
  if (!isCurrent(s) || s.renderedId === null) return
  const input = $('#ct-text', s.thread)
  if (input) saveDraft(s, s.renderedId, input.value, $('#ct-channel .on', s.thread)?.dataset.ch === 'sms' ? 'sms' : 'email')
}

export async function conversationsView(contactId) {
  setPage('Conversations')
  if (screen) captureDraft(screen)
  activeId = contactId ? +contactId : activeId
  /**
   * Do not rebuild the shell when it is already on screen.
   *
   * The realtime path does not enter at drawThread — where the draft-preserving capture below
   * lives, correctly, for its own repaints. app.js re-enters HERE on every `chat` frame, and
   * server.mjs broadcasts one to the whole shop on every takeover reply from the receptionist
   * screen. This innerHTML destroys #ct-text three lines before drawThread reads it, so the
   * capture saw an empty box on the one path its comment is about, and the reply the shop was
   * half-way through typing was gone. Driven under a DOM shim against a real websocket frame:
   * "Hi Coach — yes, we can have those 48 hoodies ready by the 12th. I will" → "".
   *
   * Guarding the shell rather than threading the draft through also keeps the caret and the
   * channel picker, which the rebuild reset to Email — so an SMS reply went out as an email.
   *
   * Every other route in the app replaces #view wholesale on entry, so arriving here from
   * anywhere else still rebuilds; drawList() and drawThread() repaint both panes regardless.
   */
  if (!$('#convo-list')) {
    $('#view').innerHTML = `<div class="convo">
      <div class="convo-list card" id="convo-list"><div class="dim" style="padding:20px">Loading…</div></div>
      <div class="convo-thread card" id="convo-thread"></div>
    </div>`
  }
  if (!screen || screen.owner !== window.__me) screen = {
    owner: window.__me, list: null, thread: null, renderedId: null,
    drafts: new Map(), sending: new Map(), drafting: new Set(), errors: new Map(), viewRequest: 0, listRequest: 0, threadRequest: 0,
  }
  if (screen.list !== $('#convo-list')) {
    screen.list = $('#convo-list'); screen.thread = $('#convo-thread'); screen.renderedId = null
    ++screen.threadRequest
  }
  const s = screen, request = ++s.viewRequest
  if (s.renderedId !== null && s.renderedId !== activeId) {
    s.renderedId = null
    s.thread.innerHTML = '<div class="card-b dim" role="status">Loading conversation…</div>'
  }
  await drawList(s)
  if (!isCurrent(s) || request !== s.viewRequest) return
  if (activeId) await drawThread(activeId, s)
  else s.thread.innerHTML = empty('▭', 'Pick a conversation', 'Sent emails and connected inbound messages appear here.')
}

async function drawList(s) {
  const request = ++s.listRequest
  const d = await api.get('/api/conversations')
  if (!isCurrent(s) || request !== s.listRequest) return
  if (!activeId && d.threads.length) activeId = d.threads[0].id
  $('#convo-list').innerHTML = d.threads.length ? d.threads.map((t) => `
    <div class="convo-item ${t.id === activeId ? 'on' : ''} ${t.unread ? 'unread' : ''}" role="button" tabindex="0" aria-label="Conversation with ${esc(t.name)}" data-c="${t.id}"${t.id === activeId ? ' aria-current="true"' : ''}>
      <div class="avatar">${esc(initials(t.name))}</div>
      <div class="ci-main">
        <div class="ci-top"><span class="ci-name">${esc(t.name)}</span><span class="ci-time">${relTime(t.last_at)}</span></div>
        <div class="ci-preview">${t.last_dir === 'out' ? '<span class="dim">You: </span>' : ''}${esc((t.last_body || '').replace(/\n/g, ' ').slice(0, 60))}</div>
      </div>
      ${t.unread ? `<span class="ci-badge" aria-label="${t.unread} unread">${t.unread}</span>` : `<span class="ci-ch" aria-hidden="true">${t.last_channel === 'sms' ? '✉' : '@'}</span>`}
    </div>`).join('') : empty('▭', 'No conversations', 'Send an estimate or a proof to start one.', '<a class="btn" href="#/autopilot">Create an estimate</a>')
  onOnce(s.list, '[data-c]', (_e, t) => go(`/conversations/${+t.dataset.c}`))
}

async function drawThread(id, s) {
  const request = ++s.threadRequest
  const d = await api.get(`/api/conversations/${id}`)
  if (!isCurrent(s) || activeId !== id || request !== s.threadRequest) return
  // Capture after the read: staff may keep typing while a realtime refresh is in flight.
  // Drafts belong to a contact, never to whichever composer happens to be visible next.
  captureDraft(s)
  const { text: draft, channel: channelWas } = draftFor(s, id)
  const c = d.contact
  s.thread.innerHTML = `
    <div class="ct-head">
      <div class="avatar">${esc(initials(c.name))}</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:650">${esc(c.name)}</div>
        <div class="dim" style="font-size:12px">${esc(c.company || '')}${c.email ? ` · ${esc(c.email)}` : ''}</div>
      </div>
      <a class="btn ghost sm" href="#/contacts/${c.id}">Profile</a>
    </div>
    <div class="ct-body" id="ct-body">
      ${d.messages.map((m) => `<div class="bubble ${m.direction === 'out' ? 'out' : 'in'}">
        <div class="bub-txt">${esc(m.body).replace(/\n/g, '<br>')}</div>
        <div class="bub-meta">${m.channel === 'sms' ? 'SMS' : 'Email'} · ${relTime(m.created_at)}${m.kind === 'automation' ? ' · auto' : ''}${m.direction==='out' && m.recipient_email?` · To: ${esc(m.recipient_name || '')} ${esc(m.recipient_email)}`:''}</div>
      </div>`).join('')}
    </div>
    <div class="ct-compose">
      <p class="dim">Replies here go to the buyer: ${esc(c.email || 'no email saved')}. To contact accounts payable, open the invoice and use its saved billing recipient.</p>
      <div class="row" style="margin-bottom:7px">
        <div class="tabs" id="ct-channel" role="group" aria-label="Send this reply as">
          <button type="button" data-ch="email" class="${channelWas === 'email' ? 'on' : ''}" aria-pressed="${channelWas === 'email'}">Email</button><button type="button" data-ch="sms" class="${channelWas === 'sms' ? 'on' : ''}" aria-pressed="${channelWas === 'sms'}">SMS</button>
        </div>
        <div class="sp"></div>
        <button class="btn ghost sm" id="ct-ai" ${s.drafting.has(id) ? 'disabled' : ''}>${s.drafting.has(id) ? 'Drafting…' : 'Draft with AI'}</button>
        ${window.__me?.single_tenant ? '<button class="btn ghost sm" id="ct-sim" title="Dev preview only — fakes a customer reply">Simulate reply</button>' : ''}
      </div>
      <textarea class="input" id="ct-text" aria-label="Reply to ${esc(c.name)}" placeholder="Write a reply…" style="min-height:70px"></textarea>
      ${s.errors.has(id) ? `<p role="alert" class="dim">${esc(s.errors.get(id))}</p>` : ''}
      <div class="row" style="margin-top:7px"><div class="sp"></div><button class="btn" id="ct-send" ${s.sending.has(id) ? 'disabled' : ''}>${s.sending.has(id) ? 'Sending…' : 'Send'}</button></div>
    </div>`

  s.renderedId = id
  const input = $('#ct-text', s.thread), send = $('#ct-send', s.thread), ai = $('#ct-ai', s.thread)
  input.value = draft
  let channel = channelWas
  input.addEventListener('input', () => saveDraft(s, id, input.value, channel))
  const body = $('#ct-body', s.thread); body.scrollTop = body.scrollHeight
  on($('#ct-channel', s.thread), '[data-ch]', (_e, t) => {
    channel = t.dataset.ch
    $$('#ct-channel button', s.thread).forEach((b) => { const selected = b.dataset.ch === channel; b.classList.toggle('on', selected); b.setAttribute('aria-pressed', String(selected)) })
    saveDraft(s, id, input.value, channel)
    announce(`Replying by ${channel === 'sms' ? 'text message' : 'email'}`)
  })

  send.onclick = async () => {
    if (!isCurrent(s) || !input.isConnected || activeId !== id || s.sending.has(id)) return
    const saved = saveDraft(s, id, input.value, channel), text = saved.text.trim()
    if (!text) return toast('Write a reply first', true)
    s.sending.set(id, saved)
    s.errors.delete(id)
    send.disabled = true; send.textContent = 'Sending…'
    try {
      await api.post(`/api/conversations/${id}/reply`, { body: text, channel })
      captureDraft(s)
      if (draftFor(s, id).revision === saved.revision) {
        saveDraft(s, id, '', channel)
        if (isCurrent(s) && s.renderedId === id) $('#ct-text', s.thread).value = ''
      }
      if (isCurrent(s)) toast(`Sent to ${c.name}`)
    } catch (e) { s.errors.set(id, e.message); if (isCurrent(s) && activeId === id) toast(e.message, true) }
    finally {
      s.sending.delete(id)
      if (isCurrent(s) && activeId === id) {
        if (send.isConnected) { send.disabled = false; send.textContent = 'Send' }
        try { await drawThread(id, s); await drawList(s) } catch (e) { if (isCurrent(s)) toast(e.message, true) }
      }
    }
  }

  ai.onclick = async () => {
    if (!isCurrent(s) || !input.isConnected || activeId !== id || s.drafting.has(id)) return
    const saved = saveDraft(s, id, input.value, channel)
    s.drafting.add(id); ai.disabled = true; ai.textContent = 'Drafting…'
    try {
      const last = d.messages.filter((m) => m.direction === 'in').slice(-1)[0]
      const r = await api.post('/api/ai/draft', { contact_id: id, intent: 'reply helpfully to the customer', context: last?.body || 'follow up on their order' })
      captureDraft(s)
      if (r.text && draftFor(s, id).revision === saved.revision) {
        saveDraft(s, id, r.text, saved.channel)
        if (isCurrent(s) && s.renderedId === id) { $('#ct-text', s.thread).value = r.text; toast('Draft ready — edit before sending') }
      } else if (isCurrent(s) && activeId === id) toast(r.text ? 'Your reply changed while drafting. Your edits were kept.' : r.ai_note || 'Model offline — type your reply', true)
    } catch (e) { if (isCurrent(s) && activeId === id) toast(e.message, true) }
    finally {
      s.drafting.delete(id)
      if (isCurrent(s) && s.renderedId === id) { const btn = $('#ct-ai', s.thread); btn.disabled = false; btn.textContent = 'Draft with AI' }
    }
  }

  const sim = $('#ct-sim', s.thread)
  if (sim) sim.onclick = async () => {
    if (!isCurrent(s) || !sim.isConnected || activeId !== id) return
    await api.post(`/api/conversations/${id}/simulate`, { channel, body: 'Sounds good — go ahead!' })
    if (isCurrent(s) && activeId === id) { await drawThread(id, s); await drawList(s) }
  }
}
