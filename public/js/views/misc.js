import { api, $, $$, esc, fmtDate, relTime, pill, setPage, empty, toast, go, on, modal, closeModal, confirmModal, formData, onOnce, copyText, guardLeave, announce } from '../core.js'
import { DEFAULT_UPCHARGES, SIZES } from '../shared/pricing.js'

/**
 * Which sizes get an upcharge box.
 *
 * This was the literal list ['2XL','3XL','4XL','5XL']. The estimate editor's "Add size", the CSV
 * importer and the v1 API can all reach 6XL, LT, XLT, 2XLT, 3XLT and 4XLT — they are in SIZES —
 * and upchargeFor() answers 0 for every one of them, so the shop billed nothing extra on the
 * garments that cost it the most. A rate no screen can show is a rate no owner can fix.
 *
 * Everything above XL, plus anything the shop has already stored, so a key set through the API
 * is never invisible on the screen that saves the map.
 */
export const UPCHARGE_SIZES = (stored = {}) => {
  const extended = SIZES.filter((sz, i) => i > SIZES.indexOf('XL') && sz !== 'OSFA')
  return [...new Set([...extended, ...Object.keys(stored || {})])]
}

/* ---------- art queue ---------- */

export async function artView() {
  setPage('Art & Prepress')
  const rows = await api.get('/api/art')
  const groups = [
    ['Waiting on customer', rows.filter((a) => a.status === 'sent'), 'amber'],
    ['Changes requested', rows.filter((a) => a.status === 'rejected'), 'red'],
    ['Not sent yet', rows.filter((a) => a.status === 'draft'), 'gray'],
    ['Approved', rows.filter((a) => a.status === 'approved'), 'green'],
  ]

  $('#view').innerHTML = rows.length ? groups.filter((g) => g[1].length).map(([title, list, color]) => `
    <div class="card" style="margin-bottom:16px">
      <div class="card-h"><h3>${title}</h3><span class="pill ${color}">${list.length}</span></div>
      <div class="card-b"><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px">
        ${list.map((a) => `<div class="card" style="background:var(--panel-2);cursor:pointer" data-job="${a.job_id}">
          ${(a.mime || '').startsWith('image/') ? `<img class="art-thumb" loading="lazy" decoding="async" alt="" src="/uploads/${esc(a.filename)}">`
            : '<div class="art-thumb" style="display:grid;place-items:center;font-size:26px">▤</div>'}
          <div style="padding:11px">
            <div class="row"><strong style="font-size:12.5px">${esc(a.job_title || '')}</strong><div class="sp"></div><span class="tag">v${a.version}</span></div>
            <div class="dim" style="font-size:11.5px;margin-top:3px">${esc(a.contact_name || '')} · ${esc(a.job_number)}</div>
            <div class="dim" style="font-size:11px;margin-top:5px">${relTime(a.created_at)}</div>
            ${a.notes ? `<div class="muted" style="font-size:11.5px;margin-top:6px;font-style:italic">"${esc(a.notes)}"</div>` : ''}
          </div></div>`).join('')}
      </div></div>
    </div>`).join('')
    : empty('◈', 'No art yet', 'Upload art from a job to start the proof workflow.', '<a class="btn" href="#/board">Go to the job board</a>')

  onOnce($('#view'), '[data-job]', (_e, t) => go(`/jobs/${t.dataset.job}`))
}

/* ---------- activity ---------- */

export async function activityView() {
  setPage('Activity')
  const rows = await api.get('/api/activities')
  // Kept byte-identical to the canonical map in views/dashboard.js — the two render the same
  // activity feed, so a glyph that drifts here shows up as two different icons for one event type.
  const ICON = { estimate: '▤', invoice: '▣', payment: '⊕', job: '▦', stage: '→', art: '◈', contact: '◉', note: '✎' }
  $('#view').innerHTML = `<div class="card" style="max-width:820px"><div class="card-b">
    ${rows.length ? `<div class="tl">${rows.map((a) => `<div class="tl-i ${['stage', 'note'].includes(a.type) ? 'gray' : ''}">
      <div class="tx">${ICON[a.type] || '•'} ${esc(a.description)}</div>
      <div class="dt">${relTime(a.created_at)}${a.contact_name ? ` · ${esc(a.contact_name)}` : ''}${a.job_number ? ` · ${esc(a.job_number)}` : ''}</div>
    </div>`).join('')}</div>` : '<div class="dim">Nothing yet.</div>'}
  </div></div>`
}

/* ---------- outbox ---------- */

export async function outboxView(showNeeds = false) {
  setPage('Outbox')
  /* The list is a newest-50 window, and the only Send button in the product is drawn per row on
   * this screen — so every unsent message past the 50th had no Send control anywhere, while the
   * card below promises "nothing vanishes". The ones that fall off the bottom are the OLDEST,
   * which is to say the ones that have been waiting longest. "Needs sending" is the escape. */
  const [box, notif] = await Promise.all([
    api.get(`/api/outbox${showNeeds ? '?needs=1' : ''}`),
    api.get('/api/notify/status').catch(() => ({ email: false, sms: false })),
  ])
  const rows = box.rows || []
  const needs = box.needs_sending || 0
  // shop_email (not `email`) is the honest signal: `email` is also true when only our platform relay
  // is set, which shop→customer mail never uses — so this banner used to promise delivery that
  // wasn't happening.
  const live = notif.shop_email || notif.sms
  const lite = window.__EDITION === 'lite'
  const status = (m) => {
    if (m.delivered) return `<span class="deliv ok"><span class="dot"></span>${esc(m.via || 'sent')}</span>`
    if (m.via === 'error') return `<span class="deliv err" title="${esc(m.delivery_error || '')}"><span class="dot"></span>failed</span>`
    // A draft is not "logged". 'draft' means Follow-ups are on Manual and this message is waiting
    // for a person to press Send; 'logged' means no email is connected at all and nothing is
    // expected of anyone. Rendering both the same told a shop in Manual mode that its whole queue
    // was fine, while nothing had gone out and nothing ever would.
    if (m.via === 'draft') return `<span class="deliv"><span class="dot"></span>draft — needs sending</span>`
    return `<span class="deliv"><span class="dot"></span>logged</span>`
  }
  // 'logged' belongs here as much as 'draft' and 'error' do. It is the state of EVERY message a
  // shop queues before it wires SMTP — all of week one — and the card above promises "nothing
  // vanishes… add SMTP and the same calls go out for real". The same calls go out for NEW
  // messages; the dozen estimates already sitting here never did, because only the button's
  // condition was left behind when the route was added. POST /api/outbox/:id/send delivers a
  // 'logged' row perfectly well, and answers 502 with the reason when mail is still not wired.
  const sendable = (m) => !m.delivered && (m.via === 'draft' || m.via === 'error' || m.via === 'logged')
  $('#view').innerHTML = `
    <div class="card" style="margin-bottom:14px;border-color:var(--line-2)"><div class="card-b">
      <strong style="font-size:13px">${live ? '✉ Delivery is live' : '▤ Logging only'}</strong>
      <p class="muted" style="font-size:12.5px;margin-top:5px;line-height:1.6">${live
        ? (lite
          ? `Mail is going out from <strong>${esc(notif.shop_email_from || 'your address')}</strong> and logged here. Each row shows whether it actually left the building.`
          : `Messages are being delivered over your ${[notif.shop_email && 'SMTP', notif.sms && 'Twilio'].filter(Boolean).join(' + ')} connection and logged here. Each row shows whether it actually left the building.`)
        : (lite
          ? 'Your email isn\'t connected yet, so what you send is saved here with a shareable link instead of reaching the customer — nothing vanishes. Connect it under <strong>Settings → Sending Email</strong> and it goes out from your own address.'
          : 'No delivery is wired yet, so "sent" mail is recorded here instead of reaching customers — nothing vanishes. Add SMTP / Twilio in Settings → Message Delivery and the same calls go out for real.')}</p>
    </div></div>
    <div class="row" style="gap:8px;align-items:center;margin-bottom:10px">
      <button class="btn ${showNeeds ? 'ghost' : ''} sm" type="button" id="ob-all" aria-pressed="${!showNeeds}">Recent</button>
      <button class="btn ${showNeeds ? '' : 'ghost'} sm" type="button" id="ob-needs" aria-pressed="${showNeeds}">Needs sending${needs ? ` (${needs})` : ''}</button>
      ${!showNeeds && needs > rows.filter(sendable).length
        ? `<span class="dim" style="font-size:12px">${needs} message${needs === 1 ? '' : 's'} still waiting — not all of them fit in this list.</span>`
        : ''}
    </div>
    <div class="card" id="outbox-list">${rows.length ? `<div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>To</th><th>Subject</th><th>Type</th><th>Status</th><th class="num">Sent</th></tr></thead>
      <tbody>${rows.map((m) => `<tr class="click" data-id="${m.id}">
        <td>${esc(m.to_email || '—')}</td><td style="font-weight:600">${esc(m.subject)}</td>
        <td><span class="tag">${esc(m.kind)}</span></td>
        <td>${status(m)}</td>
        <td class="num dim" style="font-size:12px">${relTime(m.created_at)}</td>
      </tr>`).join('')}</tbody></table></div>`
      : empty('✉', showNeeds ? 'Nothing waiting' : 'Outbox empty', showNeeds ? 'Every message has gone out or been sent by hand.' : 'Send an estimate or a proof to see it here.')}</div>`

  $('#ob-all').onclick = () => outboxView(false)
  $('#ob-needs').onclick = () => outboxView(true)

  // Scoped to this table, not #view — [data-id] is not globally unique, so a #view binding would
  // survive navigation and pop an old email over job / invoice / contact rows elsewhere.
  on($('#outbox-list'), '[data-id]', (_e, t) => {
    const m = rows.find((r) => r.id === +t.dataset.id)
    if (!m) return
    modal({ title: m.subject, body: `<div class="dim" style="font-size:12px;margin-bottom:12px">To: ${esc(m.to_email || '—')} · ${fmtDate(m.created_at)}</div>
      ${m.via === 'draft' ? '<div class="dim" style="font-size:12px;margin-bottom:12px;color:var(--amber)">Follow-ups are on “Ask me first”, so this was drafted and is waiting for you.</div>' : ''}
      ${m.via === 'error' && m.delivery_error ? `<div class="dim" style="font-size:12px;margin-bottom:12px;color:var(--red)">It did not go out: ${esc(m.delivery_error)}</div>` : ''}
      <div style="white-space:pre-wrap;font-size:13.5px;line-height:1.65;background:var(--bg);padding:15px;border-radius:8px;border:1px solid var(--line)">${esc(m.body)}</div>`,
      footer: `<button class="btn ghost" data-close>Close</button>${sendable(m) ? '<button class="btn" id="ob-send">Send it</button>' : ''}`,
      // onMount, not a delegated #view binding: bin/gate.mjs forbids the latter, and this modal is
      // re-created on every row click.
      onMount: (bg) => {
        const btn = $('#ob-send', bg)
        if (!btn) return
        btn.onclick = async () => {
          btn.disabled = true
          // Repaint the list the person was ON. Dropping back to Recent after clearing one item
          // from the backlog hides both the rest of the backlog and the row they just handled.
          try { const out = await api.post(`/api/outbox/${m.id}/send`, {}); toast(`Sent to ${out.to}`); closeModal(); outboxView(showNeeds) }
          catch (err) { btn.disabled = false; toast(err.message, true) }
        }
      } })
  })
}

/* ---------- settings ---------- */

const ROLE_PILL = { owner: 'green', manager: 'blue', staff: 'gray' }
const ROLE_DESC = { owner: 'Billing, keys, staff, everything', manager: 'Settings, keys, staff — not billing', staff: 'Day-to-day shop work' }

/** Staff card — real logins with Owner / Manager / Staff roles. Management gated to owners/managers. */
function staffCard(d, me, esc) {
  const members = d.members || []
  const canManage = !!me.can_manage
  const isOwner = !!me.is_owner
  const myEmail = me.member?.email || ''
  if (d.single_tenant) {
    return `<div class="card"><div class="card-h"><h3>Staff</h3><span class="pill">single-tenant dev</span></div>
      <div class="card-b dim" style="font-size:12.5px;line-height:1.6">Staff logins with Owner / Manager / Staff roles activate in multi-tenant mode (<code>PSC_AUTH=1</code>). Each shop then invites its own crew, and every member signs in with their own email and password.</div></div>`
  }
  const roleCell = (m) => {
    const editable = canManage && (isOwner || m.role !== 'owner') && m.email !== myEmail
    if (!editable) return `<span class="pill ${ROLE_PILL[m.role] || 'gray'}">${esc(m.role)}</span>`
    return `<select class="input role-sel" data-mid="${m.id}" aria-label="Role for ${esc(m.name || m.email)}" style="width:120px;padding:5px 8px;font-size:12px">
      ${['owner', 'manager', 'staff'].map((r) => `<option value="${r}" ${m.role === r ? 'selected' : ''} ${r === 'owner' && !isOwner ? 'disabled' : ''}>${r}</option>`).join('')}</select>`
  }
  // The roster lives behind a disclosure: a shop sets its crew up once and then comes to Settings
  // for a phone number or a price. The summary carries the headcount and the role split, so the
  // answer to "who can get in?" is on screen without opening anything.
  const byRole = (r) => members.filter((m) => m.role === r).length
  const roster = members.length
    ? `${members.length} ${members.length === 1 ? 'login' : 'logins'} — ${['owner', 'manager', 'staff'].filter((r) => byRole(r)).map((r) => `${byRole(r)} ${r}`).join(' · ')}`
    : 'No logins yet'
  return `<div class="card">
    <div class="card-h"><h3>Staff & Logins</h3><span class="pill green">unlimited seats</span><div class="spacer"></div>
      <button class="btn ghost sm" id="chg-pass">Change my password</button>
      ${canManage ? '<button class="btn ghost sm" id="add-user">+ Invite</button>' : ''}</div>
    <div class="card-b">
      <details class="disc" style="margin-top:0"><summary>${esc(roster)}</summary>
        <div class="disc-b">
          ${members.length ? `<table class="tbl"><tbody>${members.map((m) => `<tr>
            <td><div style="font-weight:600">${esc(m.name || '')}${m.email === myEmail ? ' <span class="dim" style="font-weight:400">(you)</span>' : ''}</div>
              <div class="dim" style="font-size:12px">${esc(m.email)}${m.status !== 'active' ? ' · <span style="color:var(--amber)">' + esc(m.status) + '</span>' : ''}</div></td>
            <td>${roleCell(m)}</td>
            <td class="num" style="width:40px">${canManage && m.email !== myEmail && (isOwner || m.role !== 'owner') ? `<button class="btn danger sm" data-du="${m.id}" title="Remove" aria-label="Remove ${esc(m.name || m.email)} from this shop">&times;</button>` : ''}</td>
          </tr>`).join('')}</tbody></table>` : '<div class="dim">No staff yet.</div>'}
          <p class="dim" style="font-size:12px;line-height:1.6"><strong style="color:var(--txt-2)">Owner</strong> ${ROLE_DESC.owner}. <strong style="color:var(--txt-2)">Manager</strong> ${ROLE_DESC.manager.toLowerCase()}. <strong style="color:var(--txt-2)">Staff</strong> ${ROLE_DESC.staff.toLowerCase()}. Printavo bills per seat — here your whole crew is free.</p>
        </div></details>
    </div></div>`
}

/**
 * "Disconnect" — the exit every integration except Google Drive was missing.
 *
 * A secret field renders blank (the browser never sees a stored value), so blanking it means
 * "unchanged" and there was no value that meant "remove it". A shop that pasted the wrong key, or
 * whose Slack admin or bookkeeper just left with the credentials in their head, had no way to
 * take that connection out of the product. Rendered unconditionally: clearing a group that holds
 * nothing is a harmless no-op, and a button that appears only once you are connected is a button
 * nobody finds when they need it.
 */
const disconnectBtn = (group, label) =>
  `<button class="btn ghost sm" type="button" data-disconnect="${group}" data-label="${label}">Disconnect</button>`

/** The Bring-Your-Own-Model card. Provider + key live in the shop's own settings; usage bills to them. */
function aiCard(aiInfo, esc) {
  const providers = aiInfo?.providers || []
  const cur = aiInfo?.current || {}
  const keySet = !!cur.key_set
  const modelOpts = (provId, selected) => {
    const p = providers.find((x) => x.id === provId)
    const list = p?.models || []
    const opts = list.map((m) => `<option value="${esc(m)}" ${m === selected ? 'selected' : ''}>${esc(m)}</option>`)
    if (selected && !list.includes(selected)) opts.unshift(`<option value="${esc(selected)}" selected>${esc(selected)} (custom)</option>`)
    if (!list.length) opts.unshift('<option value="">— pick a provider first —</option>')
    return opts.join('')
  }
  const configured = cur.provider && (keySet || cur.provider === 'cli')
  const statusNote = configured
    ? `<span class="dim">${esc(cur.provider)} · ${esc(cur.model || '')} — click Test to verify.</span>`
    : cur.provider ? '<span style="color:var(--amber)">Add your API key, then Test.</span>' : '<span class="dim">Off — deterministic parser only.</span>'
  return `<div class="card">
    <div class="card-h"><h3>AI Model</h3><span class="pill ${configured ? 'green' : cur.provider ? 'amber' : ''}">${configured ? 'configured' : cur.provider ? 'needs key' : 'off'}</span>
      <div class="spacer"></div><span class="dim" style="font-size:11px">bring your own key</span></div>
    <div class="card-b" id="ai">
      <p class="dim" style="font-size:12.5px;margin-bottom:12px;line-height:1.6">AI features run on <strong style="color:var(--txt-2)">your</strong> account and bill to you, never to us. Leave it <strong style="color:var(--txt-2)">Off</strong> and the shop still works: the built-in parser reads size runs and colors without a model.</p>
      <div class="row" style="gap:10px;align-items:center">
        <button class="btn ghost sm" id="ai-test" type="button">Test connection</button>
        ${disconnectBtn('ai', 'AI model')}
        <span class="dim" id="ai-note" role="status" aria-live="polite" aria-atomic="true" style="font-size:11.5px">${statusNote}</span>
      </div>
      <details class="disc"><summary>${configured ? 'Change provider, model or API key' : 'Set up AI — pick a provider and paste your key'}</summary>
        <div class="disc-b">
          <p class="dim" style="font-size:11.5px;line-height:1.6">Reading pasted customer emails into draft orders, drafting replies, and the website receptionist are the features this turns on.</p>
          <div class="grid2">
            <div class="field"><label>Provider</label>
              <select class="input" name="ai_provider" id="ai-prov">
                <option value="">Off — no AI model</option>
                ${providers.map((p) => `<option value="${p.id}" ${cur.provider === p.id ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}
              </select></div>
            <div class="field"><label>Model</label>
              <select class="input" name="ai_model" id="ai-model">${modelOpts(cur.provider, cur.model)}</select></div>
          </div>
          <div class="field"><label>API key${keySet ? ' <span class="pill green" style="font-size:9.5px;padding:1px 6px">saved</span>' : ''}</label>
            <input class="input" name="ai_api_key" id="ai-key" type="password" autocomplete="off" placeholder="${keySet ? '•••••••• saved — leave blank to keep' : 'sk-ant-… or sk-…'}" value="">
            <div class="dim" style="font-size:11px;margin-top:4px">Stored on your server, never shown again. Get one at console.anthropic.com (Anthropic) or platform.openai.com (OpenAI).</div>
          </div>
        </div></details>
    </div></div>`
}


/**
 * Slack — built to be set up by the shop owner, alone, in a few minutes.
 *
 * The manifest is what makes that possible: Slack can build an app from a pasted manifest, so the
 * owner never has to find the right scopes or paste two request URLs into the right boxes. We
 * generate it with their URLs already in it. Copy → paste → install → copy two values back.
 */
function slackCard(esc) {
  return `<div class="card">
    <div class="card-h"><h3>Slack</h3><span class="pill" id="slack-pill">checking…</span>
      <div class="spacer"></div><span class="dim" style="font-size:11px">your workspace, your bot</span></div>
    <div class="card-b" id="slack">
      <p class="dim" style="font-size:12.5px;margin-bottom:16px;line-height:1.6">Paste a customer's message in Slack — get a priced draft estimate back in the thread. Type <code>/quote</code> and paste what the customer sent, or @-mention the bot in any channel. Runs on <strong style="color:var(--txt-2)">your</strong> Slack app in <strong style="color:var(--txt-2)">your</strong> workspace; nothing is ever sent to the customer.</p>

      <ol class="steps">
        <li>
          <div class="step-t">Create the app in Slack</div>
          <div class="step-d">Copy the setup file, then in Slack click <em>Create New App → From a manifest</em>. Choose the <strong style="color:var(--txt-2)">JSON</strong> tab, paste, pick your workspace, then <em>Next → Create</em>. Everything else is already filled in.</div>
          <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:8px">
            <button class="btn sm" id="slack-copy" type="button">Copy setup file</button>
            <a class="btn ghost sm" href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer">Open Slack →</a>
          </div>
        </li>
        <li>
          <div class="step-t">Install it, then paste two values back</div>
          <div class="step-d">In your new app, open <strong style="color:var(--txt-2)">OAuth &amp; Permissions</strong> → <em>Install to Workspace</em> → <em>Allow</em>. Copy the <strong style="color:var(--txt-2)">Bot User OAuth Token</strong> (starts <code>xoxb-</code>) from that same page. Then open <strong style="color:var(--txt-2)">Basic Information → App Credentials</strong> and click <em>Show</em> next to <strong style="color:var(--txt-2)">Signing Secret</strong>. Paste both below and save.</div>
          <div class="grid2" style="margin-top:10px">
            <div class="field"><label>Bot User OAuth Token</label>
              <input class="input" name="slack_bot_token" id="slack-token" type="password" autocomplete="off" placeholder="xoxb-…" value=""></div>
            <div class="field"><label>Signing Secret</label>
              <input class="input" name="slack_signing_secret" id="slack-secret" type="password" autocomplete="off" placeholder="" value="">
              <div class="dim" style="font-size:11px;margin-top:4px">Find it under <strong style="color:var(--txt-2)">Basic Information → App Credentials → Signing Secret</strong>, then click <em>Show</em>. It is not the Client Secret.</div></div>
          </div>
          <div class="row" style="gap:10px;align-items:center">
            <button class="btn ghost sm" id="slack-test" type="button">Test connection</button>
            ${disconnectBtn('slack', 'Slack')}
            <span class="dim" id="slack-note" role="status" aria-live="polite" aria-atomic="true" style="font-size:11.5px">Checks both values and sends a test ping to your Slack app.</span>
          </div>
        </li>
      </ol>

      <details class="disc">
        <summary>For your IT person — URLs, scopes and the raw manifest</summary>
        <div class="disc-b">
          <p class="dim" style="font-size:11.5px;line-height:1.6">If you'd rather configure the app yourself, these are the two URLs Slack needs and the permissions the bot uses. The setup file above sets exactly this and nothing more.</p>
          <div class="kv"><label style="font-size:11px">Event Subscriptions → Request URL</label><code id="slack-url-events">…</code></div>
          <div class="kv"><label style="font-size:11px">Slash Commands → /quote → Request URL</label><code id="slack-url-cmd">…</code></div>
          <div class="kv"><label style="font-size:11px">Bot token scopes</label><code>app_mentions:read · chat:write · commands · im:history · im:read · im:write</code></div>
          <div class="kv"><label style="font-size:11px">Subscribe to bot events</label><code>app_mention · message.im</code></div>
          <div class="kv"><label style="font-size:11px">App manifest (JSON)</label>
            <textarea class="input" id="slack-manifest" rows="8" readonly style="font-family:var(--mono);font-size:11px;line-height:1.45">loading…</textarea></div>
        </div>
      </details>
    </div></div>`
}

export async function settingsView() {
  setPage('Settings')
  const d = await api.get('/api/settings')
  const s = d.settings
  const me = await api.get('/api/auth/me').catch(() => ({}))
  const notif = await api.get('/api/notify/status').catch(() => ({ email: false, sms: false }))
  const aiInfo = await api.get('/api/ai/providers').catch(() => null)

  const f = (name, label, hint = '', type = 'text') => `<div class="field"><label for="fs-${name}">${label}</label>
    <input class="input" id="fs-${name}" name="${name}" type="${type}" value="${esc(s[name] || '')}">${hint ? `<div class="dim" style="font-size:11px;margin-top:4px">${hint}</div>` : ''}</div>`
  // Secret field: never prefills the stored value (it's redacted server-side). Shows a "saved"
  // affordance when one is on file; blank on save means "keep what's stored".
  const sf = (name, label, hint = '') => { const set = !!s[`${name}_set`]; return `<div class="field"><label for="fs-${name}">${label}${set ? ' <span class="pill green" style="font-size:9.5px;padding:1px 6px">saved</span>' : ''}</label>
    <input class="input" id="fs-${name}" name="${name}" type="password" autocomplete="off" placeholder="${set ? '•••••••• saved — leave blank to keep' : ''}" value="">${hint ? `<div class="dim" style="font-size:11px;margin-top:4px">${hint}</div>` : ''}</div>` }
  const ta = (name, label, hint) => `<div class="field"><label for="fs-${name}">${label}</label>
    <textarea class="input" id="fs-${name}" name="${name}" style="min-height:100px">${esc(s[name] || '')}</textarea>
    ${hint ? `<div class="dim" style="font-size:11px;margin-top:4px">${hint}</div>` : ''}</div>`
  const mode = (name, label, hint) => { const v = s[name] || 'ai'; return `<div class="row" style="align-items:center;gap:12px;padding:9px 0;border-bottom:1px solid var(--line)">
    <div style="flex:1;min-width:0"><div style="font-weight:600;font-size:12.5px">${label}</div><div class="dim" style="font-size:11px">${hint}</div></div>
    <select class="input" name="${name}" aria-label="${esc(label)}" style="width:118px;flex:none">
      <option value="ai" ${v === 'ai' ? 'selected' : ''}>Automatic</option>
      <option value="manual" ${v === 'manual' ? 'selected' : ''}>Ask me first</option>
    </select></div>` }

  // Current value of a costing input, for the collapsed summary line. A shop should be able to read
  // what the advanced numbers are set to without opening the drawer — otherwise "folded away" reads
  // as "unknown", and the first thing an owner does is open every drawer to check.
  const cv = (name, dflt) => { const v = s[name]; return v === 0 || (v && String(v).trim() !== '') ? String(v) : dflt }
  // The per-size upcharge table bills real money on every document, and until now no screen in the
  // product could set it — README and docs/API.md both advertise it as configurable. Parsed with
  // the same fallback getUpcharges() uses server-side, so a malformed value shows the shipped table
  // rather than blanking the card.
  const upNow = (() => {
    try { const v = JSON.parse(s.size_upcharges); return v && typeof v === 'object' && !Array.isArray(v) ? v : DEFAULT_UPCHARGES }
    catch { return DEFAULT_UPCHARGES }
  })()

  $('#view').innerHTML = `<div style="max-width:820px" class="stack">
    <div class="card"><div class="card-h"><h3>Shop</h3></div><div class="card-b" id="shop">
      <div class="field">
        <label>Your logo</label>
        <div class="logo-row">
          <div class="logo-prev" id="logo-prev">${s.shop_logo ? `<img src="/uploads/${esc(s.shop_logo)}" alt="">` : '<span class="dim" style="font-size:11.5px">no logo yet</span>'}</div>
          <div>
            <input type="file" id="logo-file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" hidden>
            <button class="btn ghost sm" id="logo-pick" type="button">${s.shop_logo ? 'Replace logo' : 'Upload logo'}</button>
            ${s.shop_logo ? '<button class="btn ghost sm" id="logo-clear" type="button" style="margin-left:6px">Remove</button>' : ''}
            <div class="dim" style="font-size:11px;margin-top:6px">PNG, JPG, WEBP, GIF or SVG. Shows on every estimate, invoice and receipt you send.</div>
          </div>
        </div>
      </div>
      <div class="grid2">${f('shop_name', 'Shop name')}${f('shop_tagline', 'Tagline')}</div>
      <div class="grid2">${f('shop_email', 'Email', '', 'email')}${f('shop_phone', 'Phone')}</div>
      ${f('shop_address', 'Address', 'Appears on estimate and invoice PDFs')}
      <div class="grid2">${f('tax_rate', 'Default tax rate (%)', '', 'number')}${window.__EDITION === 'lite' ? '' : f('brand_name', 'Product name', 'What the sidebar says')}</div>
    </div></div>

    <div class="card">
      <div class="card-h"><h3>Costing</h3><span class="pill green">drives margin warnings</span></div>
      <div class="card-b" id="costing">
        <p class="dim" style="font-size:12px;margin-bottom:13px;line-height:1.6">Your shop rate and screen fee are the two numbers you actually revisit — a raise, a rent hike, a new screen price. The three behind <strong style="color:var(--txt-2)">Advanced costing</strong> already hold working defaults; they're what lets the calculator tell you a job loses money.</p>
        <div class="grid2">
          ${f('shop_hourly_rate', 'Shop rate ($/hr)', 'Wages + rent + equipment ÷ productive hours', 'number')}
          ${f('screen_fee', 'Screen fee charged ($)', 'What you bill per screen', 'number')}
        </div>
        <div class="field">
          <div class="lbl" id="up-lbl">Extended-size upcharges ($ per piece)</div>
          <div class="dim" style="font-size:11px;margin-bottom:6px">Added on top of the base rate for big garments. Every estimate, invoice, PDF and export bills these.</div>
          <div class="grid4" role="group" aria-labelledby="up-lbl">
            ${UPCHARGE_SIZES(upNow).map((sz) => `<div class="field" style="margin:0">
              <label for="fs-up-${sz}">${sz}</label>
              <input class="input" id="fs-up-${sz}" data-up="${sz}" type="number" step="0.25" min="0" value="${esc(String(upNow[sz] ?? 0))}">
            </div>`).join('')}
          </div>
        </div>
        <div class="field"><label>Default press</label><select class="input" name="press_type">
          <option value="auto" ${s.press_type === 'auto' ? 'selected' : ''}>Automatic</option>
          <option value="manual" ${s.press_type === 'manual' ? 'selected' : ''}>Manual</option>
        </select><div class="dim" style="font-size:11px;margin-top:4px">Manual setup runs 12–72 min by color count</div></div>

        <details class="disc"><summary>Advanced costing — ${esc(cv('utilization_pct', '30'))}% utilization · ${esc(cv('spoilage_pct', '2'))}% spoilage · ${esc(cv('target_margin_pct', '45'))}% target margin</summary>
          <div class="disc-b">
            <p class="dim" style="font-size:12px;line-height:1.6">These are set to what the industry actually measures, so you can leave them alone.
              <strong style="color:var(--txt-2)">Utilization</strong> is the one shops get wrong: presses only actually print 24–33% of the clock —
              the rest is setup, breaks, approvals and packing. Costing at your raw hourly rate understates labor by about 3×.</p>
            <div class="grid2">
              ${f('utilization_pct', 'Press utilization (%)', 'Industry measured range: 24–33%', 'number')}
              ${f('spoilage_pct', 'Spoilage (%)', 'Industry standard is 1–3%', 'number')}
            </div>
            ${f('target_margin_pct', 'Target margin (%)', 'Below 25% gets flagged as too thin', 'number')}
          </div></details>
      </div>
    </div>

    <div class="card"><div class="card-h"><h3>Wording</h3>
        <div class="spacer"></div><span class="dim" style="font-size:11px">sensible defaults already set</span></div>
      <div class="card-b">
        <p class="dim" style="font-size:12.5px;line-height:1.6;margin-bottom:2px">The terms printed on your estimates and invoices, and the wording of the emails that send them. Everything here already works — open a section only if you want to change the words.</p>
        <details class="disc"><summary>Estimate &amp; invoice terms</summary>
          <div class="disc-b" id="terms">
            ${ta('estimate_terms', 'Estimate terms', 'Printed at the bottom of every estimate')}
            ${ta('invoice_terms', 'Invoice terms')}
          </div></details>
        <details class="disc"><summary>Email wording — 3 templates</summary>
          <div class="disc-b" id="tpl">
            <p class="dim" style="font-size:12px">Variables: <code>{{first_name}} {{contact_name}} {{shop_name}} {{estimate_number}} {{invoice_number}} {{total}} {{due_date}} {{job_title}} {{version}}</code></p>
            ${ta('email_template_estimate', 'Estimate email')}
            ${ta('email_template_art', 'Art proof email')}
            ${ta('email_template_invoice', 'Invoice email')}
          </div></details>
      </div></div>

    <div class="card">
      <div class="card-h"><h3>Automation Modes</h3><span class="pill green">AI-first, manual-always</span></div>
      <div class="card-b" id="modes">
        <p class="dim" style="font-size:12.5px;margin-bottom:14px;line-height:1.6">Every workflow runs one of two ways. <strong style="color:var(--txt-2)">AI mode</strong> acts for you; <strong style="color:var(--txt-2)">Manual mode</strong> drafts and waits for a person. You can flip any of them anytime — nothing is ever taken out of your hands.</p>
        <!-- Only switches that are actually wired belong on this card. "Inbox → order intake" and
             "Art & proofs" were read nowhere in the codebase: intake already hands you a draft to
             confirm, and no proof has ever auto-advanced, so both switches promised a choice the
             app does not have. Their defaults stay in SETTING_DEFAULTS so no saved row breaks. -->
        ${mode('mode_estimates', 'Estimate drafting', 'Let the assistant and receptionist draft estimates')}
        ${mode('mode_followups', 'Follow-ups', 'Send nudges on quiet quotes / overdue invoices automatically')}
        ${mode('mode_agent', 'Website receptionist', 'The chatbot replies on its own vs. assist-only')}
      </div>
    </div>

    ${window.__EDITION === 'lite' ? emailCard(s, notif, esc) : `
    <div class="card">
      <div class="card-h"><h3>Message Delivery</h3>
        <span class="deliv ${notif.shop_email ? 'ok' : ''}" title="Email to customers"><span class="dot"></span>Email ${notif.shop_email ? 'on' : 'off'}</span>
        <span class="deliv ${notif.sms ? 'ok' : ''}" title="Text messages" style="margin-left:10px"><span class="dot"></span>SMS ${notif.sms ? 'on' : 'off'}</span></div>
      <div class="card-b" id="delivery">
        <p class="dim" style="font-size:12.5px;margin-bottom:2px;line-height:1.6">Wire your own email + text and estimates, proofs, and reminders actually go out. Left blank, messages still record to the Outbox (nothing vanishes) — they just aren't delivered. Your credentials stay on your server.</p>

        <details class="disc"><summary>Email settings — ${notif.shop_email ? `sending as ${esc(notif.shop_email_from || 'your address')}` : 'not connected, add your SMTP details'}</summary>
          <div class="disc-b">
            <div class="grid2">${f('smtp_host', 'SMTP host', 'e.g. smtp.postmarkapp.com, email-smtp.us-east-1.amazonaws.com')}${f('smtp_port', 'Port', '587 (TLS) or 465 (SSL)', 'number')}</div>
            <div class="grid2">${f('smtp_user', 'SMTP username')}${sf('smtp_pass', 'SMTP password / API token')}</div>
            ${f('smtp_from', 'From address', 'The address customers see. Defaults to your shop email.')}
            <div class="row" style="gap:8px"><button class="btn ghost sm" id="verify-email">Verify SMTP</button><button class="btn ghost sm" id="test-email">Send test email</button>${disconnectBtn('smtp', 'email sending')}<span class="dim" id="email-test-note" role="status" aria-live="polite" aria-atomic="true" style="font-size:11.5px"></span></div>
          </div></details>

        <details class="disc"><summary>Text-message settings — ${notif.sms ? `texting from ${esc(notif.sms_from || 'your number')}` : 'not connected, add your Twilio details'}</summary>
          <div class="disc-b">
            <div class="grid2">${f('twilio_sid', 'Twilio Account SID', 'ACxxxxxxxx')}${sf('twilio_token', 'Twilio Auth Token')}</div>
            ${f('twilio_from', 'From number or Messaging Service SID', '+1XXXXXXXXXX or MGxxxxxxxx')}
            <div class="row" style="gap:8px"><button class="btn ghost sm" id="test-sms">Send test SMS</button>${disconnectBtn('twilio', 'text messaging')}<span class="dim" id="sms-test-note" role="status" aria-live="polite" aria-atomic="true" style="font-size:11.5px"></span></div>
          </div></details>
      </div>
    </div>`}

    ${window.__EDITION === 'lite' ? `
    <div class="card">
      <div class="card-h"><h3>Take Payments</h3><span class="pill ${s.stripe_charges_enabled ? 'green' : ''}" id="pay-pill">${s.stripe_charges_enabled ? 'Stripe connected' : (s.stripe_account_id ? 'finish setup' : 'not connected')}</span></div>
      <div class="card-b" id="online">
        <p class="dim" style="font-size:12.5px;margin-bottom:14px;line-height:1.6">Connect Stripe to accept card payments on your invoices — customers pay online and payouts go straight to your bank. A flat <strong style="color:var(--txt-2)">4% fee</strong> on collected payments covers card processing and the platform, so there's nothing else to set up or pay.</p>
        <button class="btn" id="connect-stripe">${s.stripe_charges_enabled ? 'Manage Stripe' : (s.stripe_account_id ? 'Finish Stripe setup' : 'Connect Stripe')}</button>
      </div>
    </div>` : `
    <div class="card">
      <div class="card-h"><h3>Online Gang-Sheet Ordering</h3><span class="pill ${s.stripe_secret_set ? 'green' : ''}">${s.stripe_secret_set ? 'Stripe connected' : 'add your Stripe key'}</span></div>
      <div class="card-b" id="online">
        <p class="dim" style="font-size:12.5px;margin-bottom:14px;line-height:1.6">Let your customers build their own DTF gang sheets on <strong style="color:var(--txt-2)">your</strong> website and pay through <strong style="color:var(--txt-2)">your</strong> Stripe — the money lands in your account, we never touch it. No Stripe key? Orders still come in as quotes you follow up on.</p>
        <div class="grid2">
          ${f('dtf_price_per_inch', 'DTF price per linear inch ($)', 'What you charge per inch of roll used', 'number')}
          ${f('dtf_min_charge', 'Minimum charge ($)', 'Floor price for any sheet', 'number')}
        </div>
        ${f('dtf_sheet_width', 'Roll width (in)', 'Your DTF printer roll width — usually 22"', 'number')}

        <details class="disc"><summary>Stripe keys — ${s.stripe_secret_set ? 'connected, replace the key' : 'take card payment on the builder'}</summary>
          <div class="disc-b">
            <div class="grid2">
              ${sf('stripe_secret', 'Your Stripe secret key', 'In Stripe: Developers → API keys → Secret key → Reveal. Starts <code>sk_live_</code> or <code>sk_test_</code> — not the publishable <code>pk_</code> one. Stays on your server.')}
              ${f('stripe_publishable', 'Your Stripe publishable key (optional)', 'Same page, starts <code>pk_live_</code> — not required for checkout')}
            </div>
            <div class="row" style="gap:8px;margin-top:8px">${disconnectBtn('stripe', 'Stripe')}</div>
            <div id="stripe-err" style="font-size:11.5px;line-height:1.6;color:var(--red)"></div>
          </div></details>

        <details class="disc"><summary>Put the builder on your website</summary>
          <div class="disc-b">
            <div class="field">
              <label>Embed snippet — paste into any page</label>
              <textarea class="input" id="embed-snippet" readonly style="min-height:74px;font-family:ui-monospace,Menlo,monospace;font-size:12px" onclick="this.select()"></textarea>
              <div class="row" style="margin-top:8px;gap:8px">
                <button class="btn ghost sm" id="copy-embed">Copy snippet</button>
                <a class="btn ghost sm" href="/embed/gangsheet${me.embed_key ? `?shop=${me.embed_key}` : ''}" target="_blank">Preview the builder ↗</a>
              </div>
            </div>
          </div></details>
      </div>
    </div>`}

    <div class="card">
      <div class="card-h"><h3>Google Drive (art storage)</h3><span class="pill ${s.gdrive_connected ? 'green' : ''}">${s.gdrive_connected ? 'connected' : 'optional'}</span></div>
      <div class="card-b" id="gdrive">
        <p class="dim" style="font-size:12.5px;margin-bottom:2px;line-height:1.6">Store artwork in <strong style="color:var(--txt-2)">your own Google Drive</strong> on your own Google account, so there's no storage cap and you keep every file. You bring your own Google app, the same way you bring your own email and Stripe.</p>
        <details class="disc"><summary>Your Google Client ID &amp; Secret + setup steps</summary>
          <div class="disc-b">
            <p class="dim" style="font-size:11.5px;line-height:1.7">In <strong>console.cloud.google.com</strong>: enable the <strong>Google Drive API</strong>, create an <strong>OAuth client ID</strong> (Web application), and add this Authorized redirect URI:<br><code style="user-select:all;font-size:11px">${esc(location.origin)}/api/gdrive/callback</code></p>
            <div class="grid2">
              ${f('gdrive_client_id', 'Google Client ID')}
              ${sf('gdrive_client_secret', 'Google Client secret')}
            </div>
          </div></details>
        <div class="row" style="gap:10px;align-items:center;margin-top:10px">
          <button class="btn sm" type="button" id="gdrive-connect" ${s.gdrive_client_id && s.gdrive_client_secret_set ? '' : 'disabled title="Save your Client ID and secret first"'}>${s.gdrive_connected ? 'Reconnect Drive' : 'Connect Drive'}</button>
          ${s.gdrive_connected ? '<button class="btn ghost sm" type="button" id="gdrive-disconnect">Disconnect</button>' : ''}
          <span class="dim" id="gdrive-note" role="status" aria-live="polite" aria-atomic="true" style="font-size:11.5px">${s.gdrive_connected ? '<span style="color:var(--accent)">✓ Art saves to your Drive</span>' : ''}</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-h"><h3>Wholesale Suppliers</h3><span class="pill ${(s.ss_account && s.ss_api_key_set) || (s.sanmar_user && s.sanmar_pass_set) || (s.alpha_account && s.alpha_pass_set) ? 'green' : ''}">${(s.ss_account && s.ss_api_key_set) || (s.sanmar_user && s.sanmar_pass_set) || (s.alpha_account && s.alpha_pass_set) ? 'connected' : 'optional'}</span></div>
      <div class="card-b" id="suppliers">
        <p class="dim" style="font-size:12.5px;margin-bottom:2px;line-height:1.6">Connect a distributor to pull <strong style="color:var(--txt-2)">live blank costs + inventory</strong> into job ROI, the Products lookup, and consolidated purchase orders. Left blank, the built-in catalog answers instantly — nothing breaks.</p>
        <details class="disc"><summary>Distributor logins — S&amp;S Activewear, SanMar</summary>
          <div class="disc-b">
            <p class="dim" style="font-size:11.5px;line-height:1.6">Since S&amp;S acquired AlphaBroder, one S&amp;S key now covers both catalogs.</p>
            <div class="grid2">
              ${f('ss_account', 'S&S Activewear account #')}
              ${sf('ss_api_key', 'S&S API key', 'ssactivewear.com → My Account → API, or api@ssactivewear.com')}
            </div>
            <div class="grid2">
              ${f('sanmar_user', 'SanMar username')}
              ${sf('sanmar_pass', 'SanMar password')}
            </div>
            ${f('sanmar_cust', 'SanMar customer #', 'Required for SanMar customer-specific pricing')}
            <div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap">
              ${disconnectBtn('ss', 'S&amp;S Activewear')}${disconnectBtn('sanmar', 'SanMar')}${disconnectBtn('alpha', 'AlphaBroder')}
            </div>
          </div></details>
        <div class="row" style="gap:10px;align-items:center;margin-top:10px">
          <button class="btn sm ghost" type="button" id="sup-test">Test with a real style</button>
          <input class="input" id="sup-style" placeholder="Gildan 5000" style="max-width:180px">
          <span class="dim" id="sup-test-note" role="status" aria-live="polite" aria-atomic="true" style="font-size:11.5px"></span>
        </div>
      </div>
    </div>

    ${aiCard(aiInfo, esc)}
    ${slackCard(esc)}

    ${staffCard(d, me, esc)}

    <div class="card">
      <div class="card-h"><h3>Your Data</h3><span class="pill green">no lock-in</span></div>
      <div class="card-b">
        <p class="dim" style="font-size:12.5px;margin-bottom:12px;line-height:1.6">Everything is yours, complete, right now — <strong style="color:var(--txt-2)">including line items and size breakdowns</strong>.
          No support ticket, no fee, no waiting. The database is a single file you can copy.</p>
        <a class="btn ghost sm" href="/api/export/all.json" download>Download everything (JSON)</a>
        <details class="disc"><summary>One table at a time (CSV)</summary>
          <div class="disc-b"><div class="wrap-row">
            ${['contacts', 'estimates', 'line_items', 'invoices', 'payments', 'jobs', 'activities']
              .map((t) => `<a class="btn ghost sm" href="/api/export/${t}.csv" download>${t.replace('_', ' ')}.csv</a>`).join('')}
          </div></div></details>
      </div>
    </div>

    ${me.can_manage === false
      ? '<div class="card"><div class="card-b dim" style="font-size:12.5px">You have <strong>staff</strong> access — settings are read-only. Ask an owner or manager to change shop settings, keys, or integrations.</div></div>'
      : '<div class="row" style="justify-content:flex-end"><button class="btn" id="save">Save Settings</button></div>'}
  </div>`

  /* Settings is ONE long form — eleven cards and a single Save Settings button at the bottom — and
   * five controls on that same page used to throw the whole thing away without asking: a logo
   * upload, a logo removal, returning from Stripe Connect, and both Disconnect buttons, two of
   * which called location.reload(). Each re-rendered from the STORED values, so an owner who
   * pasted their SMTP password, their Stripe keys and their costing numbers and then uploaded
   * their logo got "Logo saved" and an empty form. There was no dirty tracking anywhere; the only
   * beforeunload guard in the app is the price-matrix editor's, which is the pattern copied here.
   *
   * location.reload() was worse than a repaint: it also drops the hash route. */
  let settingsDirty = false
  for (const el of $$('#view [name]')) el.addEventListener('input', () => { settingsDirty = true })
  const repaint = () => {
    if (!settingsDirty) return settingsView()
    confirmModal('Reload settings?',
      'You have changes on this page that have not been saved. Reloading discards them.',
      () => { settingsDirty = false; settingsView() }, 'Discard and reload')
  }
  const repaintChrome = () => { repaint(); window.dispatchEvent(new Event('psc:settings')) }

  /* The paths the app DOES control: the sidebar, the tabbar, the `g` keyboard shortcuts and the
   * browser's Back button. Every one of them is a hash change, and a hash change fires no
   * beforeunload — so the listener below never saw any of them. This is the choke point that does.
   * Refusing owns re-issuing the navigation once the shop has answered. */
  guardLeave((to) => {
    if (!settingsDirty) return true
    confirmModal('Leave without saving?',
      'The settings you changed are only in this browser. Leaving now discards them.',
      () => { settingsDirty = false; go(to) }, 'Discard changes')
    return false
  })
  // The paths the app does not control: tab close, reload, navigating off the origin entirely. NOT
  // the browser's Back button — that is a hash change and fires no beforeunload; the guardLeave
  // above catches it. Bound once, and it only speaks while the settings form is on screen.
  if (!window.__pscSettingsGuard) {
    window.__pscSettingsGuard = true
    window.addEventListener('beforeunload', (e) => {
      if (!settingsDirty || !document.getElementById('save')) return
      e.preventDefault(); e.returnValue = ''
    })
  }

  // Embed snippet — an iframe the shop drops onto their own site. Carries the shop's embed key
  // so orders route to this shop's account and Stripe.
  const snippet = `<iframe src="${location.origin}/embed/gangsheet${me.embed_key ? `?shop=${me.embed_key}` : ''}" title="Gang Sheet Builder"
  style="width:100%;max-width:960px;height:760px;border:0" loading="lazy"></iframe>`
  // The gang-sheet embed card only exists in the pro edition — guard so lite's settings don't crash.
  if ($('#embed-snippet')) {
    $('#embed-snippet').value = snippet
    $('#copy-embed').onclick = () => copyText(snippet, 'Embed snippet copied')
  }

  // Lite (Print Shop Control): Stripe Connect onboarding. The button kicks off (or resumes) Express
  // onboarding; returning from Stripe (?stripe=connected) refreshes and caches the charge state.
  const connectBtn = $('#connect-stripe')
  if (connectBtn) connectBtn.onclick = async () => {
    connectBtn.disabled = true; connectBtn.textContent = 'Opening Stripe…'
    try { const r = await api.post('/api/stripe/connect', {}); if (r.url) { location.href = r.url; return } }
    catch (e) { toast(e.message, true) }
    connectBtn.disabled = false
  }
  if (connectBtn && new URLSearchParams(location.hash.split('?')[1] || location.search).get('stripe') === 'connected') {
    try {
      const st = await api.get('/api/stripe/connect/status')
      toast(st.charges_enabled ? 'Stripe connected — you can take payments' : 'Stripe setup started — finish the remaining steps to go live')
      if (st.charges_enabled) repaint()
    } catch { /* non-fatal */ }
  }

  // Logo upload. Multipart, so it goes on its own endpoint rather than through the settings patch;
  // re-renders on success so the preview and the Replace/Remove buttons stay truthful.
  const pick = $('#logo-pick')
  if (pick) {
    pick.onclick = () => $('#logo-file').click()
    $('#logo-file').onchange = async () => {
      const file = $('#logo-file').files[0]
      if (!file) return
      pick.disabled = true; pick.textContent = 'Uploading…'
      try {
        const fd = new FormData(); fd.append('file', file)
        const r = await fetch('/api/settings/logo', { method: 'POST', body: fd })
        const d = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(d.error || 'Upload failed')
        toast('Logo saved')
        repaintChrome()
      } catch (e) { toast(e.message, true); pick.disabled = false; pick.textContent = 'Upload logo' }
    }
  }
  const logoClear = $('#logo-clear')
  // The mildest of the three raw deletes — a logo can be uploaded again — but it comes off every
  // document the shop sends from the moment it is clicked, and it was still one click.
  if (logoClear) logoClear.onclick = () => confirmModal('Remove your logo?',
    'It comes off every estimate, invoice, proof and receipt you send from now on. You can upload it again at any time.',
    async () => {
      try { await api.del('/api/settings/logo'); toast('Logo removed'); repaintChrome() }
      catch (e) { toast(e.message, true) }
    }, 'Remove')

  // Lite "Sending Email": provider preset fills the technical fields, so the shop only supplies its
  // own address and an app password — and mail then goes out from the shop's own domain.
  const mailProv = $('#mail-prov')
  if (mailProv) {
    const syncProv = () => {
      const p = MAIL_PRESETS[mailProv.value]
      $('#mail-hint').innerHTML = p?.appPw || ''
      $('#mail-manual').style.display = mailProv.value === 'other' ? '' : 'none'
    }
    mailProv.onchange = syncProv

    $('#mail-save').onclick = async () => {
      const prov = mailProv.value
      const preset = MAIL_PRESETS[prov]
      const user = $('#mail-user').value.trim()
      const pass = $('#mail-pass').value
      if (!prov) { toast('Pick who hosts your email', true); return }
      if (!user) { toast('Add the email address you send from', true); return }
      if (!pass && !s.smtp_pass_set) { toast('Add your email password', true); return }
      const host = prov === 'other' ? $('#mail-host').value.trim() : preset.host
      const port = prov === 'other' ? ($('#mail-port').value || '587') : preset.port
      if (!host) { toast('Add your mail server', true); return }
      const btn = $('#mail-save'); btn.disabled = true; btn.textContent = 'Saving…'
      try {
        // An empty smtp_pass means "keep the stored one" (applySettingsPatch preserves secrets),
        // so sending it blank on a details-only edit is safe.
        await api.put('/api/settings', {
          smtp_host: host, smtp_port: String(port), smtp_secure: prov === 'other' ? '' : (preset.secure || ''),
          smtp_user: user, smtp_from: user, smtp_pass: pass,
        })
        toast('Email connected — send yourself a test to be sure')
        repaint()
      } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = 'Connect email' }
    }

    $('#mail-test').onclick = async () => {
      const note = $('#mail-note')
      // The test endpoint only delivers to the shop's own address or the signed-in member's, so
      // this can never be used to mail a stranger.
      const to = s.shop_email || me.member?.email || ''
      if (!to) { note.textContent = 'Add your shop email first.'; return }
      note.textContent = `Sending to ${to}…`
      try {
        const r = await api.post('/api/notify/test', { channel: 'email', to })
        note.innerHTML = r.delivered
          ? `✓ Sent to ${esc(to)} — check your inbox.`
          : `Couldn't send: ${esc(r.error || 'check the address and password')}`
        announce(r.delivered ? `Test email sent to ${to}.` : `Could not send. ${r.error || 'check the address and password'}`, !r.delivered)
      } catch (e) { note.textContent = e.message; announce(e.message, true) }
    }
  }

  /**
   * Stripe hands you two keys on the same page and they differ by two characters. Pasting the
   * publishable one into the secret box used to save cleanly and light a green "Stripe connected"
   * pill — the shop then believed it could take money, and every checkout failed. Catch it here,
   * before the save, and say which key and where it lives rather than "invalid key".
   */
  const stripeKeyProblem = (payload) => {
    const sec = String(payload.stripe_secret || '').trim()
    const pub = String(payload.stripe_publishable || '').trim()
    if (sec && !/^(sk|rk)_/.test(sec)) {
      return { name: 'stripe_secret', msg: /^pk_/.test(sec)
        ? 'That’s your publishable key (pk_…), not your secret key. In Stripe open Developers → API keys → Standard keys, find the row named Secret key, click Reveal, and paste that — it starts with sk_live_ or sk_test_.'
        : 'That doesn’t look like a Stripe secret key. In Stripe open Developers → API keys → Standard keys → Secret key → Reveal. It starts with sk_live_ or sk_test_.' }
    }
    if (pub && !/^pk_/.test(pub)) {
      return { name: 'stripe_publishable', msg: /^(sk|rk)_/.test(pub)
        ? 'That’s your secret key — it belongs in the field above. The publishable key is on the same Stripe page and starts with pk_live_ or pk_test_.'
        : 'A Stripe publishable key starts with pk_live_ or pk_test_ (Developers → API keys). Leave it blank if you don’t have one.' }
    }
    return null
  }

  const saveBtn = $('#save')
  if (saveBtn) saveBtn.onclick = async () => {
    // Every settings card that holds a [name] field. #gdrive was missing from this list, and the
    // only other writer of its two keys is the Connect Drive button — which is rendered disabled
    // until they are already saved. A shop pasted its Google Client ID and secret, was told
    // "Settings saved", and came back to two blank fields and a greyed-out button, with no error
    // anywhere and no second path in the product. Some cards only exist in one edition, so a
    // missing container is skipped rather than throwing.
    const CARDS = ['#shop', '#costing', '#ai', '#slack', '#online', '#suppliers', '#gdrive', '#modes', '#delivery', '#terms', '#tpl']
    const payload = Object.assign({}, ...CARDS.map((sel) => ($(sel) ? formData($(sel)) : {})))
    // The upcharge inputs deliberately carry no `name`, so formData ignores them: they are one
    // setting, not four. applySettingsPatch serialises a JSON-shaped setting given as an object.
    const upBoxes = $$('[data-up]')
    if (upBoxes.length) {
      // MERGE over what is stored, never replace it. This was a whole-map replace built from
      // whatever boxes happened to be on screen, and it is sent by the single Save button that
      // covers all eleven settings cards — so changing the shop's PHONE NUMBER deleted every rate
      // whose box the card did not render. Measured: a 180-piece order with tall sizes re-quoted
      // from $1,792.00 to $1,732.00, with no screen able to put the rates back.
      const keep = (() => {
        try { const v = JSON.parse(s.size_upcharges); return v && typeof v === 'object' && !Array.isArray(v) ? v : {} }
        catch { return {} }
      })()
      payload.size_upcharges = { ...keep, ...Object.fromEntries(upBoxes.map((el) => [el.dataset.up, Math.max(0, Number(el.value) || 0)])) }
    }
    const err = $('#stripe-err')
    if (err) err.textContent = ''
    const bad = stripeKeyProblem(payload)
    if (bad) {
      // The field is inside a closed disclosure, so an inline message alone would be invisible.
      // Open its drawer, put the cursor in the offending box, and say it out loud too.
      const el = $(`[name="${bad.name}"]`)
      if (el) { el.closest('details')?.setAttribute('open', ''); el.focus(); el.select?.() }
      if (err) err.textContent = bad.msg
      toast(bad.msg, true)
      return
    }
    try { await api.put('/api/settings', payload); toast('Settings saved'); settingsDirty = false; settingsView(); window.dispatchEvent(new Event('psc:settings')) }
    catch (e) { toast(e.message, true) }
  }

  // AI card: swap the model list when the provider changes; test the key without saving.
  const aiProviders = aiInfo?.providers || []
  $('#ai-prov').onchange = () => {
    const p = aiProviders.find((x) => x.id === $('#ai-prov').value)
    const models = p?.models || []
    $('#ai-model').innerHTML = models.length ? models.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('') : '<option value="">— pick a provider first —</option>'
    if (p) $('#ai-key').placeholder = p.keyHint || 'API key'
  }
  $('#ai-test').onclick = async () => {
    const provider = $('#ai-prov').value
    const note = $('#ai-note')
    if (!provider) { note.innerHTML = '<span class="dim">Pick a provider to test.</span>'; return }
    const key = $('#ai-key').value.trim()
    note.innerHTML = '<span class="dim">Testing…</span>'
    try {
      const r = await api.post('/api/ai/test', { provider, model: $('#ai-model').value, api_key: key, use_saved: !key })
      note.innerHTML = r.available
        ? `<span style="color:var(--accent)">✓ Connected — ${esc(r.via || '')} · ${esc(r.model || '')}</span>`
        : `<span style="color:var(--red)">✕ ${esc(r.reason || 'Failed')}</span>`
      announce(r.available ? `AI connected — ${r.via || ''} ${r.model || ''}` : `AI test failed. ${r.reason || 'Failed'}`, !r.available)
    } catch (e) { note.innerHTML = `<span style="color:var(--red)">✕ ${esc(e.message)}</span>`; announce(e.message, true) }
  }

  // Slack card: fetch the ready-to-paste manifest, and let the owner verify the token themselves.
  ;(async () => {
    const pill = $('#slack-pill'), note = $('#slack-note'), box = $('#slack-manifest')
    if (!pill) return
    try {
      const d = await api.get('/api/slack-setup')
      if (d.unavailable) { pill.textContent = 'unavailable'; note.textContent = d.reason; return }
      box.value = d.manifest
      const ev = $('#slack-url-events'), cm = $('#slack-url-cmd')
      if (ev) ev.textContent = d.events_url
      if (cm) cm.textContent = d.command_url
      pill.textContent = d.connected ? 'connected' : (d.has_token || d.has_secret) ? 'finish setup' : 'not connected'
      pill.className = `pill ${d.connected ? 'green' : (d.has_token || d.has_secret) ? 'amber' : ''}`
      if (d.has_token) $('#slack-token').placeholder = '•••••••• saved — leave blank to keep'
      if (d.has_secret) $('#slack-secret').placeholder = '•••••••• saved — leave blank to keep'
    } catch (e) { pill.textContent = 'unavailable'; note.textContent = e.message }
  })()
  if ($('#slack-copy')) $('#slack-copy').onclick = () => copyText($('#slack-manifest').value, 'Manifest copied — paste it into Slack')
  if ($('#slack-test')) $('#slack-test').onclick = async () => {
    const note = $('#slack-note')
    note.innerHTML = '<span class="dim">Testing…</span>'
    try {
      // Save first so a token typed just now is the one we test, matching the delivery card.
      await api.put('/api/settings', { ...formData($('#slack')) })
      const r = await api.post('/api/slack-test', {})
      note.innerHTML = r.ok
        ? `<span style="color:var(--accent)">✓ Connected to ${esc(r.team || 'your workspace')} as ${esc(r.bot || 'the bot')}</span>`
        : `<span style="color:var(--red)">✕ ${esc(r.error || 'Failed')}</span>`
      announce(r.ok ? `Slack connected to ${r.team || 'your workspace'}.` : `Slack test failed. ${r.error || 'Failed'}`, !r.ok)
    } catch (e) { note.innerHTML = `<span style="color:var(--red)">✕ ${esc(e.message)}</span>`; announce(e.message, true) }
  }

  if ($('#gdrive-connect')) $('#gdrive-connect').onclick = async () => {
    const note = $('#gdrive-note')
    try {
      // save any freshly-typed keys first, then start OAuth
      await api.put('/api/settings', { ...formData($('#gdrive')) })
      const r = await api.get('/api/gdrive/connect')
      if (r?.url) { window.open(r.url, '_blank', 'noopener'); note.innerHTML = 'Finish on the Google tab, then reload this page.'; announce('Finish on the Google tab, then reload this page.') }
    } catch (e) { note.innerHTML = `<span style="color:var(--red)">${esc(e.message)}</span>`; announce(e.message, true) }
  }
  if ($('#gdrive-disconnect')) $('#gdrive-disconnect').onclick = async () => {
    try { await api.post('/api/gdrive/disconnect', {}); toast('Google Drive disconnected'); repaintChrome() } catch (e) { toast(e.message, true) }
  }
  // Every other integration's way out. Confirmed, because removing a credential is not undoable
  // from here — the shop has to paste it again — but it must be REACHABLE, which it was not.
  for (const btn of document.querySelectorAll('[data-disconnect]')) {
    btn.onclick = () => {
      const { disconnect: group, label } = btn.dataset
      confirmModal(`Disconnect ${label}?`,
        'Its saved credentials are removed from this shop. Nothing else is deleted, and you can connect it again by pasting the keys back in.',
        async () => {
          try { await api.post(`/api/settings/disconnect/${group}`, {}); toast(`${label} disconnected`); repaintChrome() }
          catch (e) { toast(e.message, true) }
        }, 'Disconnect')
    }
  }
  if ($('#sup-test')) $('#sup-test').onclick = async () => {
    const note = $('#sup-test-note')
    note.innerHTML = '<span class="dim">Looking up a real price…</span>'
    try {
      // Save first, so the key typed a second ago is the one being proved.
      await api.put('/api/settings', { ...formData($('#suppliers')) })
      const r = await api.post('/api/suppliers/test', { style: $('#sup-style').value.trim() || 'Gildan 5000' })
      note.innerHTML = r.ok
        ? `<span style="color:var(--accent)">✓ ${esc(r.label)}</span>`
        : `<span style="color:var(--red)">✕ ${esc(r.reason || 'No live price came back')}</span>`
      announce(r.ok ? `Distributor connected. ${r.label}` : `Distributor check failed. ${r.reason || 'No live price came back'}`, !r.ok)
    } catch (e) { note.innerHTML = `<span style="color:var(--red)">✕ ${esc(e.message)}</span>`; announce(e.message, true) }
  }

  // Delivery: verify + test buttons. These save first so the just-typed credentials are used.
  // Only present in pro — the lite edition swaps this card for the guided "Sending Email" one above,
  // so every binding here has to be optional or the whole Settings view dies on a null element.
  const saveDelivery = () => api.put('/api/settings', { ...formData($('#delivery')) })
  if ($('#verify-email')) $('#verify-email').onclick = async () => {
    $('#email-test-note').textContent = 'Checking…'; await saveDelivery()
    const r = await api.post('/api/notify/verify-email').catch((e) => ({ ok: false, error: e.message }))
    $('#email-test-note').textContent = r.ok ? 'SMTP connection OK ✓' : `Failed: ${r.error || 'check credentials'}`
    // Spoken as well as shown. These spans sit beside the button they answer for, deliberately —
    // the fix is to make them audible, not to move them into a toast. A refusal interrupts,
    // because "will my customer actually receive this estimate?" has no other answer in the app.
    announce(r.ok ? 'SMTP connection OK.' : `SMTP check failed. ${r.error || 'check credentials'}`, !r.ok)
  }
  if ($('#test-email')) $('#test-email').onclick = async () => {
    const to = prompt('Send a test email to:', s.shop_email || me.owner_email || ''); if (!to) return
    $('#email-test-note').textContent = 'Sending…'; await saveDelivery()
    const r = await api.post('/api/notify/test', { to, channel: 'email' }).catch((e) => ({ delivered: false, error: e.message }))
    $('#email-test-note').textContent = r.delivered ? 'Sent ✓ check the inbox' : `Not sent: ${r.error || 'add SMTP credentials'}`
    announce(r.delivered ? 'Test email sent — check the inbox.' : `Test email not sent. ${r.error || 'add SMTP credentials'}`, !r.delivered)
  }
  if ($('#test-sms')) $('#test-sms').onclick = async () => {
    const to = prompt('Send a test SMS to (E.164, e.g. +17145551234):', s.shop_phone || ''); if (!to) return
    $('#sms-test-note').textContent = 'Sending…'; await saveDelivery()
    const r = await api.post('/api/notify/test', { to, channel: 'sms' }).catch((e) => ({ delivered: false, error: e.message }))
    $('#sms-test-note').textContent = r.delivered ? 'Sent ✓' : `Not sent: ${r.error || 'add Twilio credentials'}`
    announce(r.delivered ? 'Test text sent.' : `Test text not sent. ${r.error || 'add Twilio credentials'}`, !r.delivered)
  }

  // Change your own password.
  //
  // POST /api/auth/password has existed, complete and correct, since logins shipped — it verifies
  // the current password, enforces the minimum length, clears the owner's legacy tenant hash, and
  // re-mints a session for THIS device while dropping every other one. It had zero callers. The
  // only way to change a password was to sign out, claim you had forgotten it, and wait for an
  // email — which needs SMTP configured, so on a shop that has not set up mail yet there was no
  // way at all.
  const passBtn = $('#chg-pass')
  if (passBtn) passBtn.onclick = () => modal({
    title: 'Change my password',
    body: `<div class="field"><label for="cp-cur">Current password</label>
        <input class="input" id="cp-cur" name="current_password" type="password" autocomplete="current-password"></div>
      <div class="field"><label for="cp-new">New password</label>
        <input class="input" id="cp-new" name="new_password" type="password" minlength="8" autocomplete="new-password" placeholder="at least 8 characters"></div>
      <div class="field"><label for="cp-again">New password again</label>
        <input class="input" id="cp-again" name="confirm" type="password" autocomplete="new-password"></div>
      <p class="dim" style="font-size:11.5px;margin-top:6px">You stay signed in on this device. Every other session — including one you are worried about — is signed out immediately.</p>`,
    footer: `<button class="btn ghost" data-close>Cancel</button><button class="btn" id="cpgo">Change password</button>`,
    onMount: (bg) => {
      $('#cpgo', bg).onclick = async () => {
        const body = formData(bg)
        if (!body.current_password || !body.new_password) { toast('Enter your current password and a new one', true); return }
        if (String(body.new_password).length < 8) { toast('The new password needs at least 8 characters', true); return }
        if (body.new_password !== body.confirm) { toast('The two new passwords do not match', true); return }
        const btn = $('#cpgo', bg); btn.disabled = true; btn.textContent = 'Changing…'
        try {
          await api.post('/api/auth/password', { current_password: body.current_password, new_password: body.new_password })
          closeModal(); toast('Password changed — other sessions signed out')
        } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = 'Change password' }
      }
    },
  })

  const addBtn = $('#add-user')
  if (addBtn) addBtn.onclick = () => modal({
    title: 'Invite a team member',
    body: `<div class="grid2">
        <div class="field"><label>Name</label><input class="input" name="name" placeholder="Marco Diaz"></div>
        <div class="field"><label>Email</label><input class="input" name="email" type="email" placeholder="marco@example.com"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Role</label><select class="input" name="role">
          <option value="staff">Staff — day-to-day work</option>
          <option value="manager">Manager — settings, keys, staff</option>
          ${me.is_owner ? '<option value="owner">Owner — everything incl. billing</option>' : ''}
        </select></div>
        <div class="field"><label>Temporary password</label><input class="input" name="password" minlength="8" placeholder="at least 8 characters"></div>
      </div>
      <p class="dim" style="font-size:11.5px;margin-top:6px">They sign in at your login page with this email and temporary password.</p>`,
    footer: `<button class="btn ghost" data-close>Cancel</button><button class="btn" id="go">Send invite</button>`,
    onMount: (bg) => $('#go', bg).onclick = async () => {
      const body = formData(bg)
      if (!body.email || !body.password) { toast('Email and a temporary password are required', true); return }
      if (String(body.password).length < 8) { toast('The temporary password needs at least 8 characters', true); return }
      try {
        await api.post('/api/members', body)
        closeModal(); toast('Team member added'); settingsView()
      } catch (e) { toast(e.message, true) }
    },
  })

  // Inline role change.
  onOnce($('#view'), '.role-sel', async (_e, t) => {
    try { await api.patch(`/api/members/${t.dataset.mid}`, { role: t.value }); toast('Role updated'); window.dispatchEvent(new Event('psc:settings')) }
    catch (e) { toast(e.message, true); settingsView() }
  }, 'change')

  onOnce($('#view'), '[data-du]', (_e, t) => confirmModal('Remove this login?', 'They lose access immediately and are signed out everywhere.', async () => {
    try { await api.del(`/api/members/${t.dataset.du}`); toast('Removed'); settingsView() }
    catch (e) { toast(e.message, true) }
  }, 'Remove'))
}

/* ---------- shop email (lite) ---------- */

/**
 * Presets for the mail hosts small print shops actually use, so a shop owner never has to know what
 * an SMTP host is. Picking a provider fills host/port/TLS; all they type is their own address and an
 * app password. The point is that mail then leaves from THEIR domain — a customer sees
 * orders@yourshop.com, not a relay of ours, which is the whole reason to do it this way.
 *
 * `appPw` is the help line: Google and Microsoft both reject a normal account password over SMTP,
 * and that single fact is where most self-setups fail.
 */
export const MAIL_PRESETS = {
  google: {
    label: 'Google Workspace / Gmail', host: 'smtp.gmail.com', port: '587', secure: '',
    appPw: 'Google needs an <strong>App Password</strong>, not your normal password. Turn on 2-step verification, then create one at myaccount.google.com/apppasswords and paste the 16 characters here.',
  },
  microsoft: {
    label: 'Microsoft 365 / Outlook', host: 'smtp.office365.com', port: '587', secure: '',
    appPw: 'Microsoft needs an <strong>App Password</strong> if you have 2-step verification on — create one under Security info in your Microsoft account.',
  },
  godaddy: {
    label: 'GoDaddy email', host: 'smtpout.secureserver.net', port: '465', secure: 'true',
    appPw: 'Use your normal GoDaddy mailbox password. If GoDaddy hosts your email on Microsoft 365, pick that option instead.',
  },
  zoho: {
    label: 'Zoho Mail', host: 'smtp.zoho.com', port: '587', secure: '',
    appPw: 'Zoho needs an <strong>App Password</strong> from Zoho Account → Security → App Passwords.',
  },
  privateemail: {
    label: 'Namecheap Private Email', host: 'mail.privateemail.com', port: '587', secure: '',
    appPw: 'Use your normal mailbox password.',
  },
  other: { label: 'Something else (enter manually)', host: '', port: '587', secure: '', appPw: '' },
}

/** Guess which preset a shop is already on, so revisiting Settings shows the right provider. */
export function presetFor(host) {
  const h = String(host || '').toLowerCase()
  if (!h) return ''
  for (const [k, v] of Object.entries(MAIL_PRESETS)) if (v.host && v.host.toLowerCase() === h) return k
  return 'other'
}

/**
 * The lite edition's email setup: two fields and a test button, instead of the pro card's raw
 * SMTP/Twilio grid. Sending from the shop's own domain is the good look, and this is what makes it
 * reachable for someone who has never heard the word SMTP.
 */
function emailCard(s, notif, esc) {
  const live = !!notif.shop_email
  const cur = presetFor(s.smtp_host)
  const from = notif.shop_email_from || s.smtp_from || s.shop_email || ''
  return `<div class="card">
    <div class="card-h"><h3>Sending Email</h3>
      <span class="pill ${live ? 'green' : ''}">${live ? 'sending as ' + esc(from) : 'not set up'}</span></div>
    <div class="card-b" id="delivery">
      <p class="dim" style="font-size:12.5px;margin-bottom:15px;line-height:1.6">Connect your shop's email and estimates, invoices and reminders go out <strong style="color:var(--txt-2)">from your own address</strong> — your customers see ${esc(from || 'you@yourshop.com')}, reply straight to you, and it lands in their inbox like any other email from you.
        ${live ? '' : '<br><span style="color:var(--txt-3)">Until this is connected, what you send is saved to your Outbox with a shareable link, but not emailed.</span>'}</p>

      <div class="field"><label>Who hosts your email?</label>
        <select class="input" id="mail-prov">
          <option value="">— choose your provider —</option>
          ${Object.entries(MAIL_PRESETS).map(([k, v]) => `<option value="${k}"${cur === k ? ' selected' : ''}>${esc(v.label)}</option>`).join('')}
        </select>
      </div>

      <div class="grid2" style="margin-top:10px">
        <div class="field"><label>Your email address</label>
          <input class="input" id="mail-user" type="email" value="${esc(s.smtp_user || s.shop_email || '')}" placeholder="orders@yourshop.com"></div>
        <div class="field"><label>Password${s.smtp_pass_set ? ' <span class="pill green" style="font-size:9.5px;padding:1px 6px">saved</span>' : ''}</label>
          <input class="input" id="mail-pass" type="password" autocomplete="off" placeholder="${s.smtp_pass_set ? '•••••••• saved — leave blank to keep' : 'app password'}"></div>
      </div>

      <div class="dim" id="mail-hint" style="font-size:11.5px;line-height:1.6;margin-top:2px">${cur && MAIL_PRESETS[cur]?.appPw ? MAIL_PRESETS[cur].appPw : ''}</div>

      <div id="mail-manual" class="grid2" style="margin-top:10px;${cur === 'other' ? '' : 'display:none'}">
        <div class="field"><label>Mail server (SMTP host)</label><input class="input" id="mail-host" value="${esc(s.smtp_host || '')}" placeholder="mail.yourhost.com"></div>
        <div class="field"><label>Port</label><input class="input" id="mail-port" type="number" value="${esc(s.smtp_port || '587')}"></div>
      </div>

      <div class="row" style="gap:8px;margin-top:16px;align-items:center">
        <button class="btn" id="mail-save">${live ? 'Save changes' : 'Connect email'}</button>
        <button class="btn ghost sm" id="mail-test">Send myself a test</button>
        <span class="dim" id="mail-note" role="status" aria-live="polite" aria-atomic="true" style="font-size:11.5px"></span>
      </div>
    </div>
  </div>`
}
