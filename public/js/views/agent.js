import { api, $, $$, esc, relTime, pill, setPage, empty, toast, on, modal, closeModal, copyText } from '../core.js'

/* The AI Receptionist — configure the bot, preview it live, and work the leads it captures. */

let cfg = null
let embedKey = 'demo'
let previewSession = null

export async function agentView() {
  setPage('AI Receptionist', `<button class="btn ghost sm" id="copy-embed">⟨⟩ Embed code</button>`)
  const [data, sessions] = await Promise.all([api.get('/api/agent/config'), api.get('/api/agent/sessions')])
  cfg = data.config
  embedKey = data.embed_key || 'demo'
  const ai = data.ai || {}

  const caps = cfg.capabilities || {}
  const cap = (k, label, hint) => `<label class="capbox">
    <input type="checkbox" name="cap_${k}" ${caps[k] ? 'checked' : ''}>
    <span><strong>${label}</strong><em>${hint}</em></span></label>`

  $('#view').innerHTML = `${renderAiBanner(data)}<div class="agent-grid">
    <div class="stack">
      <div class="card">
        <div class="card-h"><h3>Receptionist</h3>
          <div class="spacer"></div>
          <label class="switch"><input type="checkbox" id="enabled" ${cfg.enabled ? 'checked' : ''}><span class="track"></span></label>
          <span class="dim" style="font-size:12px" id="enabled-lbl">${cfg.enabled ? 'Live' : 'Off'}</span>
        </div>
        <div class="card-b">
          <p class="dim" style="font-size:12.5px;line-height:1.6;margin-bottom:14px">A configurable AI front desk that greets website visitors, answers your FAQs, qualifies real leads, hands back an instant ballpark, and drops every lead into your pipeline — then hands off to you when it should.
            ${ai.available ? `<span class="pill green" style="margin-left:4px">Model on · ${esc(ai.model || 'connected')}</span>` : `<span class="pill" style="margin-left:4px">Runs without a model too</span>`}</p>

          <div class="field"><label>Mode</label>
            <div class="modepick" id="modepick">
              <button type="button" class="modeopt ${cfg.mode === 'ai' ? 'on' : ''}" data-mode="ai">
                <strong>AI mode</strong><span>Replies on its own, 24/7. Captures and quotes automatically.</span></button>
              <button type="button" class="modeopt ${cfg.mode === 'assist' ? 'on' : ''}" data-mode="assist">
                <strong>Assist mode</strong><span>Still qualifies + captures, but frames prices as "the team will confirm" and flags every lead for you.</span></button>
            </div>
          </div>

          <div class="grid2">
            <div class="field"><label>Bot name</label><input class="input" id="name" value="${esc(cfg.name)}"></div>
            <div class="field"><label>Accent color</label><input class="input" id="accent" type="color" value="${esc(cfg.accent)}" style="height:40px;padding:4px"></div>
          </div>
          <div class="field"><label>Greeting</label><textarea class="input" id="greeting" style="min-height:64px">${esc(cfg.greeting)}</textarea></div>
          <div class="field"><label>Personality</label><textarea class="input" id="persona" style="min-height:56px">${esc(cfg.persona)}</textarea>
            <div class="dim" style="font-size:11px;margin-top:4px">How it should sound. The model follows this; the built-in flow stays polite regardless.</div></div>
        </div>
      </div>

      <div class="card">
        <div class="card-h"><h3>What it can do</h3></div>
        <div class="card-b">
          <div class="capgrid">
            ${cap('faq', 'Answer FAQs', 'From the list below')}
            ${cap('quote', 'Give ballpark quotes', 'Priced from your rules')}
            ${cap('qualify', 'Qualify + capture leads', 'Contact, opp & draft estimate')}
            ${cap('handoff', 'Hand off to a human', 'When they ask for a person')}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-h"><h3>Knowledge & FAQs</h3><div class="spacer"></div><button class="btn ghost sm" id="add-faq">+ FAQ</button></div>
        <div class="card-b">
          <div class="field"><label>Knowledge base <span class="dim" style="font-weight:400;text-transform:none;letter-spacing:0">the AI answers from this</span></label>
            <textarea class="input" id="knowledge" style="min-height:160px;line-height:1.6" placeholder="Turnaround times, order minimums, rush policy, pricing rules, hours, location, brands you carry, what makes you different…">${esc(cfg.knowledge || '')}</textarea>
            <div class="dim" style="font-size:11.5px;margin-top:6px;line-height:1.55">Paste your policies, turnaround times, minimums, FAQs — anything you'd tell a customer. When AI is connected, the receptionist answers freeform questions straight from this instead of dead-ending.</div></div>
          <div id="faqs" class="faqlist"></div>
        </div>
      </div>

      <div class="row" style="justify-content:flex-end;gap:8px">
        <span class="dim" id="save-note" style="font-size:12px"></span>
        <button class="btn" id="save">Save receptionist</button>
      </div>
    </div>

    <div class="stack">
      <div class="card preview-card">
        <div class="card-h"><h3>Live preview</h3><div class="spacer"></div><button class="btn ghost sm" id="reset-preview">Reset</button></div>
        <div class="chatprev" id="chatprev"></div>
        <div class="chatinput"><input class="input" id="prev-in" placeholder="Message the bot as a customer…"><button class="btn sm" id="prev-send">Send</button></div>
      </div>

      <div class="card">
        <div class="card-h"><h3>Put it on your site</h3></div>
        <div class="card-b">
          <p class="dim" style="font-size:12px;line-height:1.6;margin-bottom:10px">Paste this one line before <code>&lt;/body&gt;</code> on any page. The bubble matches your accent and works on mobile.</p>
          <textarea class="input" id="embed-code" readonly style="min-height:64px;font-family:ui-monospace,Menlo,monospace;font-size:12px" onclick="this.select()"></textarea>
          <div class="row" style="margin-top:8px;gap:8px"><button class="btn ghost sm" id="copy-embed2">Copy</button>
            <a class="btn ghost sm" href="/embed/chatdemo?shop=${encodeURIComponent(embedKey)}" target="_blank">Open demo page ↗</a></div>
        </div>
      </div>

      <div class="card">
        <div class="card-h"><h3>Chats & leads</h3><div class="spacer"></div><span class="pill ${sessions.sessions.length ? 'green' : ''}">${sessions.sessions.length}</span></div>
        <div id="sessions">${renderSessions(sessions.sessions)}</div>
      </div>
    </div>
  </div>`

  renderFaqs(cfg.faqs || [])
  updateEmbed()
  bindConfig()
  resetPreview()
  bindSessions()
}

/* Supercharged status. Reads the `ai` status object off the /api/agent/config
   payload ({ available, provider, model }); falls back to a boolean `supercharged`
   field; hides itself gracefully when neither is present. */
function renderAiBanner(data) {
  data = data || {}
  const ai = data.ai || (('supercharged' in data) ? { available: !!data.supercharged } : null)
  if (!ai) return '' // engine didn't report AI status — show nothing rather than guess
  const wrap = (inner) => `<div class="card" style="margin-bottom:14px">${inner}</div>`
  if (ai.available) {
    const prov = esc(ai.provider || 'your AI')
    const model = ai.model ? ` · <span style="font-weight:500;color:var(--txt-2)">${esc(ai.model)}</span>` : ''
    return wrap(`<div class="card-b" style="display:flex;align-items:center;gap:14px">
      <div style="width:34px;height:34px;flex:0 0 auto;border-radius:var(--r-md);display:grid;place-items:center;font-size:18px;background:linear-gradient(135deg,var(--accent),var(--violet));color:var(--accent-ink)">✦</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:650;font-size:13.5px">Supercharged — powered by ${prov}${model} <span class="pill green" style="margin-left:4px;vertical-align:middle">Active</span></div>
        <div class="dim" style="font-size:12px;line-height:1.5;margin-top:2px">The receptionist now answers freeform questions grounded in your knowledge base and FAQs instead of dead-ending, and can draft replies for you in the inbox.</div>
      </div></div>`)
  }
  return wrap(`<div class="card-b" style="display:flex;align-items:center;gap:14px">
    <div style="width:34px;height:34px;flex:0 0 auto;border-radius:var(--r-md);display:grid;place-items:center;font-size:18px;background:var(--panel-2);border:1px solid var(--line-2);color:var(--txt-2)">✦</div>
    <div style="flex:1;min-width:0">
      <div style="font-weight:650;font-size:13.5px">Add your AI key in Settings to supercharge the receptionist</div>
      <div class="dim" style="font-size:12px;line-height:1.5;margin-top:2px">With a key connected, the bot answers freeform questions from your knowledge base instead of dead-ending, and can draft inbox replies for you.</div>
    </div>
    <a class="btn sm" href="#/settings" style="flex:0 0 auto">Add AI key</a></div>`)
}

function renderSessions(list) {
  if (!list.length) return `<div class="card-b dim" style="font-size:12.5px">No chats yet. Try the live preview, or drop the widget on your site.</div>`
  const stColor = { active: 'blue', captured: 'green', handoff: 'amber', closed: 'gray' }
  return `<div class="tbl-wrap"><table class="tbl"><tbody>${list.map((s) => `<tr class="click" data-sid="${esc(s.public_id)}">
    <td><div style="font-weight:600;font-size:13px">${esc(s.contact_name || s.visitor_name || s.visitor_email || 'Website visitor')}</div>
      <div class="dim" style="font-size:11.5px;max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.last_body || '')}</div></td>
    <td style="text-align:right"><span class="pill ${stColor[s.status] || 'gray'}">${esc(s.status)}</span>
      <div class="dim" style="font-size:11px;margin-top:3px">${relTime(s.updated_at)}</div></td>
  </tr>`).join('')}</tbody></table></div>`
}

/* ---------- config editing ---------- */

function currentConfig() {
  return {
    enabled: $('#enabled').checked,
    mode: $('.modeopt.on')?.dataset.mode || 'ai',
    name: $('#name').value.trim() || 'Ari',
    accent: $('#accent').value,
    greeting: $('#greeting').value.trim(),
    persona: $('#persona').value.trim(),
    knowledge: $('#knowledge').value.trim(),
    capabilities: { faq: $('[name=cap_faq]').checked, quote: $('[name=cap_quote]').checked, qualify: $('[name=cap_qualify]').checked, handoff: $('[name=cap_handoff]').checked, book: true },
    faqs: $$('.faqrow').map((r) => ({ q: $('.faq-q', r).value.trim(), a: $('.faq-a', r).value.trim() })).filter((f) => f.q && f.a),
  }
}

function bindConfig() {
  $('#enabled').onchange = () => { $('#enabled-lbl').textContent = $('#enabled').checked ? 'Live' : 'Off' }
  on($('#modepick'), '.modeopt', (_e, t) => { $$('.modeopt').forEach((b) => b.classList.remove('on')); t.classList.add('on') })
  $('#accent').oninput = updateEmbed
  $('#add-faq').onclick = () => addFaqRow('', '')
  $('#save').onclick = async () => {
    const body = currentConfig()
    $('#save').disabled = true; $('#save-note').textContent = 'Saving…'
    try {
      const r = await api.put('/api/agent/config', body)
      cfg = r.config; $('#save-note').textContent = 'Saved ✓'
      toast('Receptionist updated')
      updateEmbed(); resetPreview()
      setTimeout(() => { $('#save-note').textContent = '' }, 2500)
    } catch (e) { toast(e.message, true); $('#save-note').textContent = '' }
    $('#save').disabled = false
  }
  const copy = () => copyText($('#embed-code').value, 'Embed code copied')
  $('#copy-embed').onclick = copy
  $('#copy-embed2').onclick = copy
}

function renderFaqs(faqs) { $('#faqs').innerHTML = ''; (faqs.length ? faqs : []).forEach((f) => addFaqRow(f.q, f.a)) }

function addFaqRow(q, a) {
  const row = document.createElement('div')
  row.className = 'faqrow'
  row.innerHTML = `<input class="input faq-q" placeholder="Question a customer asks…" value="${esc(q)}">
    <textarea class="input faq-a" placeholder="How the bot answers">${esc(a)}</textarea>
    <button class="btn danger sm faq-x" title="Remove" aria-label="Remove this question and answer">&times;</button>`
  $('.faq-x', row).onclick = () => row.remove()
  $('#faqs').appendChild(row)
}

function updateEmbed() {
  const code = `<script src="${location.origin}/embed/chat.js?shop=${encodeURIComponent(embedKey)}" defer></` + `script>`
  const el = $('#embed-code'); if (el) el.value = code
}

/* ---------- live preview ---------- */

function addPrev(text, who) {
  const d = document.createElement('div')
  d.className = `prevmsg ${who}`
  d.textContent = text
  $('#chatprev').appendChild(d)
  $('#chatprev').scrollTop = $('#chatprev').scrollHeight
  return d
}

async function resetPreview() {
  previewSession = null
  const box = $('#chatprev'); if (!box) return
  box.innerHTML = ''
  addPrev(($('#greeting')?.value || cfg.greeting || 'Hi!'), 'bot')
  const chips = ['Get a quote', 'What is your minimum?', 'Talk to a person']
  const c = document.createElement('div'); c.className = 'prevchips'
  c.innerHTML = chips.map((x) => `<button class="chip">${esc(x)}</button>`).join('')
  on(c, '.chip', (_e, t) => sendPrev(t.textContent))
  box.appendChild(c)
}

function bindSessions() {
  $('#reset-preview').onclick = resetPreview
  $('#prev-send').onclick = () => sendPrev($('#prev-in').value)
  $('#prev-in').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendPrev($('#prev-in').value) } })
  on($('#sessions'), '[data-sid]', (_e, t) => openSession(t.dataset.sid))
}

let prevBusy = false
async function sendPrev(text) {
  text = (text || '').trim(); if (!text || prevBusy) return
  $('#prev-in').value = ''
  $$('.prevchips').forEach((c) => c.remove())
  addPrev(text, 'me')
  prevBusy = true
  const typing = addPrev('…', 'bot typing')
  try {
    const r = await api.post('/api/agent/preview', { session: previewSession, text })
    previewSession = r.session
    typing.remove()
    addPrev(r.reply || '…', 'bot')
    if (r.quick && r.quick.length) {
      const c = document.createElement('div'); c.className = 'prevchips'
      c.innerHTML = r.quick.map((x) => `<button class="chip">${esc(x)}</button>`).join('')
      on(c, '.chip', (_e, t) => sendPrev(t.textContent))
      $('#chatprev').appendChild(c)
      $('#chatprev').scrollTop = $('#chatprev').scrollHeight
    }
  } catch (e) { typing.remove(); addPrev('(preview error: ' + e.message + ')', 'bot') }
  prevBusy = false
}

/* ---------- session detail + human takeover ---------- */

function openSession(pid) {
  api.get(`/api/agent/sessions/${pid}`).then(({ session, messages }) => {
    const role = { visitor: 'me', bot: 'bot', agent: 'agent', system: 'sys' }
    const body = `<div class="chatlog">${messages.map((m) => `<div class="logmsg ${role[m.role] || 'bot'}"><span class="who">${m.role}</span>${esc(m.body)}</div>`).join('') || '<div class="dim">No messages.</div>'}</div>
      <div class="field" style="margin-top:12px"><label>Reply as the shop ${session.visitor_email ? `— emails ${esc(session.visitor_email)}` : session.visitor_phone ? `— texts ${esc(session.visitor_phone)}` : '(no contact info yet)'}</label>
        <textarea class="input" id="takeover" style="min-height:64px" placeholder="Type your reply to this visitor…"></textarea></div>`
    modal({
      title: `Chat · ${session.contact_name || session.visitor_email || 'Website visitor'}`,
      wide: true, body,
      footer: `<button class="btn ghost" data-close>Close</button><button class="btn ghost" id="ai-draft">✦ Draft with AI</button><button class="btn" id="send-take">Send reply</button>`,
      onMount: (bg) => {
        $('#send-take', bg).onclick = async () => {
          const text = $('#takeover', bg).value.trim(); if (!text) return
          try { await api.post(`/api/agent/sessions/${pid}/reply`, { text }); closeModal(); toast('Reply sent'); agentView() }
          catch (e) { toast(e.message, true) }
        }
        // Supercharged assist: ask the AI to draft a reply grounded in the shop's knowledge.
        // Endpoint may be absent in older builds — degrade gracefully on 404 / non-ok.
        const draftBtn = $('#ai-draft', bg)
        if (draftBtn) draftBtn.onclick = async () => {
          const ta = $('#takeover', bg); if (!ta) return
          const label = draftBtn.textContent
          draftBtn.disabled = true; draftBtn.textContent = 'Drafting…'
          try {
            const r = await api.post('/api/agent/draft', { session_pid: pid })
            if (r && r.ok && r.text) { ta.value = r.text; ta.focus(); toast('Draft ready — review before sending') }
            else { toast('AI could not draft a reply right now') }
          } catch (e) { toast('AI draft unavailable — add your AI key in Settings') }
          draftBtn.disabled = false; draftBtn.textContent = label
        }
      },
    })
  })
}
