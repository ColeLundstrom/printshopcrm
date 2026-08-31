import { api, $, $$, el, esc, relTime, initials, setPage, empty, toast, on, go, announce } from '../core.js'

/**
 * Conversations — GHL's unified inbox, built in.
 *
 * One thread per customer, both directions, email and SMS together. Every automated touch
 * and every nudge already lands here, so the shop sees the whole relationship in one place
 * instead of paying for a separate CRM to remember it.
 */
let activeId = null

export async function conversationsView(contactId) {
  setPage('Conversations')
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
  await drawList()
  if (activeId) await drawThread(activeId)
  else $('#convo-thread').innerHTML = empty('▭', 'Pick a conversation', 'Every email and text with a customer lives here, both directions.')
}

async function drawList() {
  const d = await api.get('/api/conversations')
  if (!activeId && d.threads.length) activeId = d.threads[0].id
  $('#convo-list').innerHTML = d.threads.length ? d.threads.map((t) => `
    <div class="convo-item ${t.id === activeId ? 'on' : ''} ${t.unread ? 'unread' : ''}" data-c="${t.id}"${t.id === activeId ? ' aria-current="true"' : ''}>
      <div class="avatar">${esc(initials(t.name))}</div>
      <div class="ci-main">
        <div class="ci-top"><span class="ci-name">${esc(t.name)}</span><span class="ci-time">${relTime(t.last_at)}</span></div>
        <div class="ci-preview">${t.last_dir === 'out' ? '<span class="dim">You: </span>' : ''}${esc((t.last_body || '').replace(/\n/g, ' ').slice(0, 60))}</div>
      </div>
      ${t.unread ? `<span class="ci-badge" aria-label="${t.unread} unread">${t.unread}</span>` : `<span class="ci-ch" aria-hidden="true">${t.last_channel === 'sms' ? '✉' : '@'}</span>`}
    </div>`).join('') : empty('▭', 'No conversations', 'Send an estimate or a proof to start one.', '<a class="btn" href="#/autopilot">Create an estimate</a>')
  on($('#convo-list'), '[data-c]', (_e, t) => { activeId = +t.dataset.c; go(`/conversations/${activeId}`) })
}

async function drawThread(id) {
  // What the shop has typed but not sent, captured before the repaint that would destroy it.
  //
  // app.js repaints this whole screen on every `conversation` and `chat` realtime event. The line
  // immediately above that one already guards the receptionist screen, for exactly this reason and
  // in almost these words — and this screen, where the unsaved thing is a customer reply, was left
  // unconditional. An inbound email or SMS landing mid-sentence wiped the reply, including an AI
  // draft that had just been generated and billed.
  //
  // Preserved rather than skipped: skipping the repaint would keep the draft but hide the message
  // that just arrived, which is the other half of the same job. The customer's new message appears
  // AND the half-written answer survives. After a successful send the caller has already cleared
  // the box, so what is restored is the empty string, which is correct.
  const draft = $('#ct-text')?.value ?? ''
  // The chosen channel is part of the reply being written. It lived only in the `let channel`
  // below, which the repaint re-initialised to 'email' — so a shop that had picked SMS and was
  // typing sent the customer an email instead, with nothing on screen to say it had changed.
  const channelWas = $('#ct-channel .on')?.dataset.ch === 'sms' ? 'sms' : 'email'
  const d = await api.get(`/api/conversations/${id}`)
  const c = d.contact
  $('#convo-thread').innerHTML = `
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
        <div class="bub-meta">${m.channel === 'sms' ? 'SMS' : 'Email'} · ${relTime(m.created_at)}${m.kind === 'automation' ? ' · auto' : ''}</div>
      </div>`).join('')}
    </div>
    <div class="ct-compose">
      <div class="row" style="margin-bottom:7px">
        <div class="tabs" id="ct-channel" role="group" aria-label="Send this reply as">
          <button type="button" data-ch="email" class="${channelWas === 'email' ? 'on' : ''}" aria-pressed="${channelWas === 'email'}">Email</button><button type="button" data-ch="sms" class="${channelWas === 'sms' ? 'on' : ''}" aria-pressed="${channelWas === 'sms'}">SMS</button>
        </div>
        <div class="sp"></div>
        <button class="btn ghost sm" id="ct-ai">Draft with AI</button>
        ${window.__me?.single_tenant ? '<button class="btn ghost sm" id="ct-sim" title="Dev preview only — fakes a customer reply">Simulate reply</button>' : ''}
      </div>
      <textarea class="input" id="ct-text" placeholder="Write a reply…" style="min-height:70px"></textarea>
      <div class="row" style="margin-top:7px"><div class="sp"></div><button class="btn" id="ct-send">Send</button></div>
    </div>`

  if (draft) $('#ct-text').value = draft
  const body = $('#ct-body'); body.scrollTop = body.scrollHeight
  let channel = channelWas
  // Of the sixteen segmented controls in this app, this is the one where being unable to tell
  // which option is armed costs the shop money and reaches the customer on the wrong channel. The
  // class is the state store — line 75 reads `$('#ct-channel .on')?.dataset.ch` to survive the
  // realtime repaint — so aria-pressed is added beside it, and the change is also said out loud.
  on($('#ct-channel'), '[data-ch]', (_e, t) => {
    channel = t.dataset.ch
    $$('#ct-channel button').forEach((b) => { const on = b.dataset.ch === channel; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)) })
    announce(`Replying by ${channel === 'sms' ? 'text message' : 'email'}`)
  })

  $('#ct-send').onclick = async () => {
    const text = $('#ct-text').value.trim()
    if (!text) return toast('Write a reply first', true)
    $('#ct-send').disabled = true
    try {
      await api.post(`/api/conversations/${id}/reply`, { body: text, channel })
      $('#ct-text').value = ''
      await drawThread(id); await drawList()
      toast('Sent')
    } catch (e) { toast(e.message, true); $('#ct-send').disabled = false }
  }

  $('#ct-ai').onclick = async () => {
    const btn = $('#ct-ai'); btn.disabled = true; btn.textContent = 'Drafting…'
    try {
      const last = d.messages.filter((m) => m.direction === 'in').slice(-1)[0]
      const r = await api.post('/api/ai/draft', { contact_id: id, intent: 'reply helpfully to the customer', context: last?.body || 'follow up on their order' })
      if (r.text) { $('#ct-text').value = r.text; toast('Draft ready — edit before sending') }
      else toast(r.ai_note || 'Model offline — type your reply', true)
    } catch (e) { toast(e.message, true) } finally { btn.disabled = false; btn.textContent = 'Draft with AI' }
  }

  const sim = $('#ct-sim')
  if (sim) sim.onclick = async () => {
    await api.post(`/api/conversations/${id}/simulate`, { channel, body: 'Sounds good — go ahead!' })
    await drawThread(id); await drawList()
  }
}
