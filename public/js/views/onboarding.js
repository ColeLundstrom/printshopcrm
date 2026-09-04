import { api, $, $$, esc, money, setPage, on, go, toast, announce, empty, confirmModal, guardLeave, onOnce } from '../core.js'
import { importContacts, importOrders } from './contacts.js'

/**
 * Guided setup wizard. Walks a new shop through everything that makes the app theirs — costing
 * numbers, pricing rules and blank markup, their own Stripe, their own AI key, distributor
 * accounts for accurate POs, and importing their customers. Every step is optional and saves as
 * you go, so it can be done in five minutes now or finished later from the dashboard. Opinionated
 * setup, unlimited overrides: nothing here is a one-way door.
 */

const SAMPLE_REQUEST = `Hi - we're the Riverside High booster club. We need 48 navy Gildan 18500 hoodies for the fall season, 2 color front with our logo.

Sizes roughly 8 S, 14 M, 14 L, 8 XL, 4 2XL. We need them by 2026-09-08 for the first home game.

Can you send a quote? Thanks - Jamie (jamie@example.edu)`

const FLOW = ['welcome', 'basics', 'import', 'quote', 'pricing', 'email', 'sms', 'payments', 'drive', 'distributors', 'ai', 'done']
const state = { i: 0, data: null, ai: null }

export async function onboardingView() {
  setPage('Welcome')
  // The lite edition sells "sign in and invoice" — no distributor/AI/Stripe steps to wade through.
  // One screen, two numbers (already sensible), then straight into the app. Pricing is pre-built.
  if (window.__EDITION === 'lite') return liteOnboarding()
  /* app.js sends every shop whose onboarding is unfinished here on boot, so this is the first
   * screen a brand-new shop ever sees — and `.catch(() => null)` swallowed the Error, so
   * httpMessage()'s "The server is restarting — try that again in a moment" never reached it and
   * the router's own catch never ran either. What was left was the grey words "Could not load
   * setup." with an empty header, no reason, no retry and no link. Two escapes, because the two
   * failures are different: a 502 during a deploy wants Try again, and a persistent 500 wants a
   * way into the product regardless — the app works fine without the wizard. */
  let bootErr = null
  state.data = await api.get('/api/onboarding').catch((e) => { bootErr = e; return null })
  if (!state.data) {
    setPage('Welcome', '<button class="btn" id="ob-retry" type="button">Try again</button>')
    $('#view').innerHTML = empty('⚠', 'Setup could not load', bootErr?.message || 'The server did not answer.',
      '<a class="btn ghost" href="#/">Skip setup and go to the dashboard</a>')
    const again = $('#ob-retry')
    if (again) again.onclick = () => { again.disabled = true; again.textContent = 'Trying…'; onboardingView() }
    return
  }
  state.ai = await api.get('/api/ai/providers').catch(() => null)
  // A brand-new shop starts at the welcome/describe hero. A shop that's already made some progress
  // resumes at its first unfinished step, so "finish later" drops them exactly where they left off.
  const steps = [...state.data.onboarding.steps].sort((a,b) => FLOW.indexOf(a.key) - FLOW.indexOf(b.key))
  if (state.i === 0) {
    const anyDone = steps.some((s) => s.done)
    const firstUndone = steps.findIndex((s) => !s.done)
    if (anyDone) state.i = firstUndone === -1 ? FLOW.indexOf('done') : FLOW.indexOf(steps[firstUndone].key)
    // else: leave at 0 (welcome)
  }
  const requested = new URLSearchParams(location.hash.split('?')[1] || '').get('step')
  if (FLOW.includes(requested)) state.i = FLOW.indexOf(requested)
  render()
}

/** The lite edition's whole onboarding: a friendly, pre-filled one-screen setup. */
async function liteOnboarding() {
  const s = (await api.get('/api/settings').catch(() => ({ settings: {} }))).settings || {}
  const brand = document.getElementById('brand-name')?.textContent || 'InkVoice'
  $('#view').innerHTML = `<div class="card" style="max-width:520px;margin:40px auto">
    <div class="card-b">
      <h2 style="margin:0 0 6px">Welcome to ${esc(brand)}</h2>
      <p class="dim" style="margin:0 0 20px;line-height:1.5">Let's put your shop on your invoices. Add your logo and a couple of numbers so your quotes price themselves — or skip and do it anytime under Settings. Your pricing is already built in.</p>
      <div class="field">
        <label>Your logo <span class="dim" style="font-weight:400">— appears on everything you send</span></label>
        <div class="logo-row">
          <div class="logo-prev" id="lo-prev">${s.shop_logo ? `<img src="/uploads/${esc(s.shop_logo)}" alt="">` : '<span class="dim" style="font-size:11.5px">optional</span>'}</div>
          <div>
            <input type="file" id="lo-file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" hidden>
            <button class="btn ghost sm" id="lo-pick" type="button">${s.shop_logo ? 'Replace logo' : 'Upload logo'}</button>
            <div class="dim" style="font-size:11px;margin-top:6px">PNG, JPG, WEBP, GIF or SVG.</div>
          </div>
        </div>
      </div>
      <div class="field" style="margin-top:14px"><label>Shop name</label><input class="input" id="lo-shop" value="${esc(s.shop_name || '')}" placeholder="Your Print Shop"></div>
      <div class="grid2" style="margin-top:12px">
        <div class="field"><label>Your hourly rate ($/hr)</label><input class="input" id="lo-rate" type="number" min="0" value="${esc(s.shop_hourly_rate ?? 75)}"></div>
        <div class="field"><label>Sales tax (%)</label><input class="input" id="lo-tax" type="number" step="0.001" min="0" value="${esc(s.tax_rate ?? 0)}"></div>
      </div>
      <div class="wrap-row" style="margin-top:22px;justify-content:flex-end;gap:10px">
        <button class="btn ghost" id="lo-skip">Skip for now</button>
        <button class="btn" id="lo-go">Start invoicing →</button>
      </div>
    </div></div>`
  const finish = async () => { try { await api.post('/api/auth/onboarding', { done: true }) } catch { /* land them in anyway */ } go('/') }
  $('#lo-skip').onclick = finish

  // Logo upload right here in setup — the first thing a shop wants on an invoice is its own mark.
  $('#lo-pick').onclick = () => $('#lo-file').click()
  $('#lo-file').onchange = async () => {
    const file = $('#lo-file').files[0]
    if (!file) return
    const btn = $('#lo-pick'); btn.disabled = true; btn.textContent = 'Uploading…'
    try {
      const fd = new FormData(); fd.append('file', file)
      const r = await fetch('/api/settings/logo', { method: 'POST', body: fd })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || 'Upload failed')
      $('#lo-prev').innerHTML = `<img src="/uploads/${esc(d.shop_logo)}" alt="">`
      btn.textContent = 'Replace logo'; btn.disabled = false
      toast('Logo saved')
    } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = 'Upload logo' }
  }
  $('#lo-go').onclick = async () => {
    const btn = $('#lo-go'); btn.disabled = true; btn.textContent = 'Saving…'
    try {
      await api.put('/api/settings', {
        shop_name: $('#lo-shop').value.trim() || s.shop_name || 'My Shop',
        shop_hourly_rate: Number($('#lo-rate').value) || 75,
        tax_rate: Number($('#lo-tax').value) || 0,
      })
      toast('You\'re all set — let\'s make an invoice')
    } catch (e) { toast(e.message, true) }
    await finish()
  }
}

function render() {
  const key = FLOW[state.i]
  const d = state.data
  const steps = [...d.onboarding.steps].sort((a, b) => FLOW.indexOf(a.key) - FLOW.indexOf(b.key))
  const rail = steps.map((s) => {
    const active = s.key === key
    // aria-current="step", NOT aria-pressed: these navigate to a step in a linear flow, they are
    // not a set of toggles. The ✓ was the only signal that a step is done and it is a bare glyph a
    // screen reader reads as "check mark", so it is hidden and given words instead.
    return `<button type="button" class="ob-rail-item ${s.done ? 'done' : ''} ${active ? 'on' : ''}" data-goto="${s.key}"${active ? ' aria-current="step"' : ''}>
      <span class="ob-rail-ic" aria-hidden="true">${s.done ? '✓' : `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><use href="#i-${s.icon}"></use></svg>`}</span>
      <span class="ob-rail-t">${esc(s.title)}${s.required ? '' : ' <span class="ob-opt">optional</span>'}${s.done ? ' <span class="sr-only">— done</span>' : ''}</span></button>`
  }).join('')

  $('#view').innerHTML = `<div class="obx">
    <aside class="ob-rail">
      <div class="ob-rail-h">
        <div class="ob-rail-kicker">Setting up</div>
        <div class="ob-rail-shop">${esc(d.shop_name || 'your shop')}</div>
        <div class="ob-progress"><div class="ob-progress-fill" style="width:${d.onboarding.pct}%"></div></div>
        <div class="ob-progress-t">${d.onboarding.done} of ${d.onboarding.total} done</div>
      </div>
      <div class="ob-rail-list" aria-label="Setup steps">${rail}</div>
      <button class="ob-skip-all" id="ob-later">Finish later — take me in →</button>
    </aside>
    <section class="ob-panel" id="ob-panel">${panel(key)}</section>
  </div>`

  wire(key)
  // A fresh panel is clean. Delegated on #view through onOnce because #view is repainted and
  // never replaced, so one binding covers every step the wizard will ever draw.
  stepDirty = false
  onOnce($('#view'), '#ob-form input, #ob-form select, #ob-form textarea', markStepDirty, 'input')
  onOnce($('#view'), '#ob-form input, #ob-form select, #ob-form textarea', markStepDirty, 'change')
  // Bound to the rail this render just wrote, not to the persistent #view — a #view binding would
  // double the live listeners on every rail click and freeze the wizard after a dozen of them.
  on($('.ob-rail-list'), '[data-goto]', (_e, t) => { const idx = FLOW.indexOf(t.dataset.goto); if (idx >= 0) leaveStep(() => { state.i = idx; render() }) })
  $('#ob-later').onclick = () => leaveStep(finishLater)
  // And the paths this screen does not own: the sidebar, the tabbar, the `g` shortcuts, Back.
  guardLeave((to) => { if (!stepDirty) return true; leaveStep(() => go(to)); return false })
}

/* -------------------------------------------------------------------------------------------------
 * A step's form exists only in the browser until "Save & continue" — saveSettings() is wired to
 * that button and to nothing else. The nine-item rail beside the form, "Back", and
 * "Finish later — take me in →" all repainted straight over it. A shop copying a Twilio SID, auth
 * token and number across from another tab, who then clicks a rail item — which is what a rail is
 * for — lost all three, and Twilio only shows an auth token once, so that is a real second trip.
 * The newest possible user, on the first screen of the product, being taught that this app loses
 * work.
 *
 * The offer is to SAVE rather than to discard, because that is this wizard's own promise: every
 * step is optional and saves as you go. saveSettings() here is the exact write the Next button
 * performs.
 * ---------------------------------------------------------------------------------------------- */
let stepDirty = false
const markStepDirty = () => { stepDirty = true }

/** Run `then` — but not over a step the shop has typed into and not saved. */
async function leaveStep(then) {
  const form = $('#ob-form')
  if (!stepDirty || !form || !$$('[name]', form).length) { stepDirty = false; return then() }
  confirmModal('Save this step first?',
    'What you typed on this screen has not been saved yet.',
    async () => {
      try { await saveSettings(form); await markStep(FLOW[state.i], 'done') } catch (e) { toast(e.message, true) }
      stepDirty = false
      then()
    }, 'Save and continue')
}

/* ---------- field helpers ---------- */
const f = (name, label, val, { type = 'text', hint = '', ph = '' } = {}) => `<div class="field"><label for="ob-${name}">${label}</label>
  <input class="input" id="ob-${name}" name="${name}" type="${type}" value="${esc(val ?? '')}" placeholder="${esc(ph)}">${hint ? `<div class="ob-hint">${esc(hint)}</div>` : ''}</div>`
const sf = (name, label, isSet, { hint = '', ph = '' } = {}) => `<div class="field"><label for="ob-${name}">${label}${isSet ? ' <span class="pill green" style="font-size:9px;padding:1px 6px">saved</span>' : ''}</label>
  <input class="input" id="ob-${name}" name="${name}" type="password" autocomplete="off" value="" placeholder="${isSet ? '•••••••• saved — leave blank to keep' : esc(ph)}">${hint ? `<div class="ob-hint">${esc(hint)}</div>` : ''}</div>`

/* ---------- panels ---------- */
function panel(key) {
  const s = state.data.settings
  const foot = (next = 'Save & continue', skip = true) => `<div class="ob-foot">
    ${state.i > 1 ? '<button class="btn ghost" id="ob-back">Back</button>' : '<span></span>'}
    <div class="row" style="gap:8px">
      ${skip ? '<button class="btn ghost" id="ob-skip">Skip for now</button>' : ''}
      <button class="btn" id="ob-next">${esc(next)}</button>
    </div></div>`

  if (key === 'welcome') return `<div class="ob-head"><h1>Let's set up your shop</h1>
      <p>Takes about five minutes — or skip any part and finish it later from your dashboard. Start by telling us about your shop in a sentence and we'll configure your pricing automatically, or step through it yourself.</p></div>
    <div class="ob-describe">
      <textarea id="ob-desc" placeholder="e.g. 4-person screen print and embroidery shop, one auto press and one manual, we charge about $65/hr, DTF on a 22 inch roll at a dollar an inch, tax is 8.25%."></textarea>
      <div class="row" style="gap:10px;margin-top:10px;align-items:center">
        <button class="btn" id="ob-configure">Configure from this</button>
        <button class="btn ghost" id="ob-step">Step through it instead →</button>
      </div>
      <div id="ob-desc-out" class="ob-describe-out" hidden></div>
    </div>`

  if (key === 'quote') return `<div class="ob-head"><h2>Price a real request</h2>
      <p>This is the whole product in one move: paste what a customer actually sent you — email, text, whatever — and get a priced estimate back. Here's a sample to try. Change it or use your own.</p></div>
    <div class="ob-describe">
      <textarea id="ob-req" spellcheck="false">${esc(SAMPLE_REQUEST)}</textarea>
      <div class="row" style="gap:10px;margin-top:10px;align-items:center">
        <button class="btn" id="ob-price">Price it →</button>
        <span class="dim" id="ob-price-note" style="font-size:12px">No setup needed. Nothing is sent to anyone.</span>
      </div>
      <div id="ob-quote-out" class="ob-describe-out" hidden></div>
    </div>${foot('Skip for now', true)}`

  if (key === 'basics') return `<div class="ob-head"><h2>◱ Shop & costing basics</h2>
      <p>Just the things you know off the top of your head. Everything else already has a working default.</p></div>
    <div id="ob-form" class="ob-form">
      <div class="grid2">${f('shop_name', 'Shop name', s.shop_name)}${f('shop_email', 'Email', s.shop_email, { type: 'email' })}</div>
      <div class="grid2">${f('shop_phone', 'Phone', s.shop_phone)}${f('tax_rate', 'Sales tax (%)', s.tax_rate, { type: 'number' })}</div>
      ${f('shop_address', 'Address', s.shop_address, { hint: 'Shown on estimate & invoice PDFs.' })}
      ${f('shop_hourly_rate', 'Shop rate ($/hr)', s.shop_hourly_rate, { type: 'number', hint: 'Wages + rent + equipment ÷ productive hours.' })}
      <details class="disc"><summary>Fine-tune costing — utilization ${esc(String(s.utilization_pct ?? 30))}% · spoilage ${esc(String(s.spoilage_pct ?? 2))}% · target margin ${esc(String(s.target_margin_pct ?? 45))}%</summary>
        <div class="disc-b">
          <p class="ob-hint" style="margin:0 0 4px">These already work at the shown defaults. They sharpen what the quote tool calls a job's real margin — <strong>utilization</strong> is the one shops get wrong: presses only actually print 24–33% of the clock.</p>
          <div class="grid2">${f('utilization_pct', 'Press utilization (%)', s.utilization_pct, { type: 'number', hint: 'Measured range: 24–33%.' })}${f('spoilage_pct', 'Spoilage (%)', s.spoilage_pct, { type: 'number', hint: '1–3% typical.' })}</div>
          ${f('target_margin_pct', 'Target margin (%)', s.target_margin_pct, { type: 'number', hint: 'Below this gets flagged.' })}
        </div></details>
      <div class="field"><label>Default press</label><select class="input" name="press_type">
        <option value="auto" ${s.press_type === 'auto' ? 'selected' : ''}>Automatic</option>
        <option value="manual" ${s.press_type === 'manual' ? 'selected' : ''}>Manual</option></select></div>
    </div>${foot('Save & continue', false)}`

  if (key === 'pricing') {
    const svc = state.data.service_pricing || {}
    const defs = state.data.service_defaults || {}
    const rows = Object.keys(defs).map((name) => `<div class="ob-svc-row">
      <span>${esc(name)}</span>
      <input class="input" data-svc="${esc(name)}" type="number" step="0.05" min="0.5" aria-label="${esc(name)} multiplier" value="${esc(svc[name] ?? defs[name])}" style="width:80px">
      <span class="dim" style="font-size:11px">× base</span></div>`).join('')
    return `<div class="ob-head"><h2>⊞ Pricing rules & blank markup</h2>
        <p>Your rules. <strong>Blank markup</strong> is what you multiply garment cost by; the <strong>per-service multipliers</strong> set what embroidery, DTF, vinyl, etc. cost relative to a screen-print base. Everything's tunable later, and the price is always an editable field on a quote.</p></div>
      <div id="ob-form" class="ob-form">
        <div class="grid2">${f('default_markup', 'Blank markup (×)', s.default_markup, { type: 'number', hint: 'e.g. 2.0 doubles garment cost.' })}${f('screen_fee', 'Screen fee ($)', s.screen_fee, { type: 'number', hint: 'Charged per screen/color.' })}</div>
        <div class="ob-svc"><div class="ob-svc-h">Per-service pricing (multiplier vs. screen print)</div>${rows}</div>
        <div class="grid2">${f('dtf_price_per_inch', 'DTF price / inch ($)', s.dtf_price_per_inch, { type: 'number' })}${f('dtf_min_charge', 'DTF minimum ($)', s.dtf_min_charge, { type: 'number' })}</div>
      </div>${foot()}`
  }

  if (key === 'drive') {
    const connected = !!s.gdrive_connected
    const haveCreds = !!s.gdrive_client_id && !!s.gdrive_client_secret_set
    const redirect = `${location.origin}/api/gdrive/callback`
    return `<div class="ob-head"><h2>◆ Connect Google Drive</h2>
        <p>Your artwork lives in <strong>your own</strong> Google Drive, on your own Google account, so you keep control and there's no storage cap. You connect it with your own Google app, exactly like you would your own email or Stripe.</p></div>
      <div id="ob-form" class="ob-form" style="align-items:flex-start">
        <details class="disc" ${haveCreds ? '' : 'open'}><summary>How to get your Google Client ID &amp; Secret (one time, ~5 min)</summary>
          <div class="disc-b">
            <ol style="font-size:12.5px;line-height:1.7;padding-left:18px;margin:6px 0">
              <li>Go to <strong>console.cloud.google.com</strong> and create a project (or pick one).</li>
              <li>APIs &amp; Services → <strong>Enable APIs</strong> → enable the <strong>Google Drive API</strong>.</li>
              <li>APIs &amp; Services → <strong>Credentials</strong> → Create Credentials → <strong>OAuth client ID</strong> → type <strong>Web application</strong>.</li>
              <li>Under <strong>Authorized redirect URIs</strong>, add exactly:<br><code style="user-select:all;font-size:11.5px">${esc(redirect)}</code></li>
              <li>Create it, then copy the <strong>Client ID</strong> and <strong>Client secret</strong> into the boxes below.</li>
            </ol>
          </div>
        </details>
        ${f('gdrive_client_id', 'Google Client ID', s.gdrive_client_id, { ph: '…apps.googleusercontent.com' })}
        ${sf('gdrive_client_secret', 'Google Client secret', s.gdrive_client_secret_set, { hint: 'From the same OAuth client. Stored encrypted; never shown to your customers.' })}
        <div class="row" style="gap:10px;align-items:center;margin-top:6px">
          <button class="btn ghost sm" id="ob-drive-save" type="button">Save Google keys</button>
          <button class="btn" id="ob-drive-connect" type="button" ${haveCreds ? '' : 'disabled title="Save your Client ID and secret first"'}>${connected ? 'Reconnect Google Drive' : 'Connect Google Drive'}</button>
          <span class="ob-hint" id="ob-drive-note" role="status" aria-live="polite" aria-atomic="true">${connected ? '<span style="color:var(--accent)">✓ Connected — art saves to your Drive</span>' : ''}</span>
        </div>
        ${connected ? '' : '<div class="ob-note">Until you connect, art uploads fall back to limited local storage on our server. Add your Google keys above and connect so nothing gets capped.</div>'}
      </div>${foot()}`
  }

  if (key === 'email') {
    const connected = !!s.smtp_host
    return `<div class="ob-head"><h2>✉ Connect email so you can send</h2>
        <p>Estimates, proofs, and replies are emailed from <strong>your own address</strong>. Connect it, or your messages only save to the Outbox and <strong>never reach the customer</strong>. If a platform relay is enabled you can skip this, but connecting your own is best.</p></div>
      <div id="ob-form" class="ob-form">
        <div class="field"><label for="ob-mail-provider">Who hosts your email?</label><select class="input" id="ob-mail-provider"><option value="">Choose a provider or enter details below</option><option value="google">Google Workspace / Gmail</option><option value="custom">Other mailbox / custom SMTP</option></select><p class="ob-hint">Use your provider’s app password or supported SMTP credentials. Your ordinary account password may not work.</p></div>
        ${f('smtp_user', 'Mailbox address / username', s.smtp_user, { ph: 'quotes@yourshop.com' })}
        ${sf('smtp_pass', 'App password / SMTP password', s.smtp_pass_set, { hint: 'Google: enable 2-step verification, then create an app password if your administrator permits it.' })}
        ${f('smtp_from', 'Send from', s.smtp_from || s.shop_email, { ph: 'quotes@yourshop.com', hint: 'Use an address your provider has authorized.' })}
        <details class="disc" id="ob-mail-advanced" ${s.smtp_host && s.smtp_host !== 'smtp.gmail.com' ? 'open' : ''}><summary>Mail server &amp; encryption</summary>
          ${f('smtp_host', 'SMTP host', s.smtp_host, { ph: 'mail.yourprovider.com', hint: 'Selecting Google fills this automatically.' })}
          ${f('smtp_port', 'Port', s.smtp_port ?? 587, { type: 'number', ph: '587' })}
          <div class="field"><label for="ob-smtp-secure">Encryption</label><select class="input" name="smtp_secure" id="ob-smtp-secure"><option value="true" ${String(s.smtp_secure) === 'true' ? 'selected' : ''}>SSL/TLS (port 465)</option><option value="false" ${String(s.smtp_secure) !== 'true' ? 'selected' : ''}>STARTTLS (port 587)</option></select></div>
        </details>
        <p class="ob-hint">SMTP sends mail from your domain. Replies go to your existing mailbox. Follow your email provider’s SPF, DKIM and DMARC setup; no universal DNS record works for every provider.</p>
        <div class="row" style="gap:10px;align-items:center"><button class="btn ghost sm" id="email-test" type="button">Send test email</button><span class="ob-hint" id="email-note" role="status" aria-live="polite" aria-atomic="true">${connected ? '<span style="color:var(--accent)">Email server saved — send a test to verify delivery</span>' : ''}</span></div>
      </div>${foot()}`
  }

  if (key === 'sms') {
    const connected = !!s.twilio_sid
    return `<div class="ob-head"><h2>◌ Connect SMS for text conversations</h2>
        <p>Connect your <strong>own Twilio number</strong> for outgoing texts. After saving, <a href="#/setup">open Setup &amp; connections</a> to copy the incoming SMS webhook. No AI is required.</p></div>
      <div id="ob-form" class="ob-form">
        ${f('twilio_sid', 'Twilio Account SID', s.twilio_sid, { ph: 'AC…' })}
        ${sf('twilio_token', 'Auth token', s.twilio_token_set, { hint: 'From your Twilio console.' })}
        ${f('twilio_from', 'Your Twilio number', s.twilio_from, { ph: '+15551234567', hint: 'The number texts are sent from.' })}
        <div class="row" style="gap:10px;align-items:center"><button class="btn ghost sm" id="sms-test" type="button">Send test text</button><span class="ob-hint" id="sms-note" role="status" aria-live="polite" aria-atomic="true">${connected ? '<span style="color:var(--accent)">Credentials saved — send a test, then connect incoming messages</span>' : ''}</span></div>
      </div>${foot()}`
  }

  if (key === 'payments') return `<div class="ob-head"><h2>◈ Collect payments (Stripe)</h2>
      <p>Paste your <strong>own</strong> Stripe secret key and you can email customers a link to pay a 50% deposit or the balance — the money lands in <strong>your</strong> account, we never touch it. Skip it and you'll still track payments manually.</p></div>
    <div id="ob-form" class="ob-form">
      ${sf('stripe_secret', 'Stripe secret key', s.stripe_secret_set, { hint: 'sk_live_… or sk_test_… — from dashboard.stripe.com → Developers → API keys.' })}
      ${f('stripe_publishable', 'Publishable key (optional)', s.stripe_publishable, { ph: 'pk_live_…' })}
      <div class="ob-note">Your key is stored on your server and never shown back.</div>
    </div>${foot()}`

  if (key === 'ai') {
    const providers = state.ai?.providers || []
    const cur = state.ai?.current || {}
    const modelOpts = (pid, sel) => { const p = providers.find((x) => x.id === pid); const list = p?.models || []; return (list.length ? list : ['']).map((m) => `<option value="${esc(m)}" ${m === sel ? 'selected' : ''}>${esc(m || '— pick a provider —')}</option>`).join('') }
    const superOn = !!s.ai_api_key_set || !!cur.key_set
    return `<div class="ob-head"><h2>◍ Turn on AI (your own key) ${superOn ? '<span class="pill green" style="font-size:10px;padding:2px 8px;vertical-align:middle">Supercharged ✓</span>' : ''}</h2>
        <p>Add your Anthropic or OpenAI key to supercharge the receptionist and quoting. Without it everything still works; with it, the front-desk bot answers freeform questions and drafts replies. It runs on <strong>your</strong> account and bills to you.</p></div>
      <div id="ob-form" class="ob-form">
        <div class="grid2">
          <div class="field"><label>Provider</label><select class="input" name="ai_provider" id="ai-prov">
            <option value="">Off — no AI model</option>
            ${providers.map((p) => `<option value="${p.id}" ${cur.provider === p.id ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select></div>
          <div class="field"><label>Model</label><select class="input" name="ai_model" id="ai-model">${modelOpts(cur.provider, cur.model)}</select></div>
        </div>
        ${sf('ai_api_key', 'API key', cur.key_set, { hint: 'console.anthropic.com or platform.openai.com' })}
        <div class="row" style="gap:10px;align-items:center"><button class="btn ghost sm" id="ai-test" type="button">Test connection</button><span class="ob-hint" id="ai-note" role="status" aria-live="polite" aria-atomic="true"></span></div>
      </div>${foot()}`
  }

  if (key === 'distributors') return `<div class="ob-head"><h2>◫ Distributor accounts</h2>
      <p>Connect S&S Activewear, SanMar, or AlphaBroder and the app pulls <strong>live blank costs</strong> into your quotes and margins, and can submit <strong>purchase orders</strong> straight to the distributor — consolidated so they never split-ship. Optional; the built-in catalog answers without it.</p></div>
    <div id="ob-form" class="ob-form">
      <div class="ob-svc-h">S&amp;S Activewear <span class="dim" style="font-weight:400">(one key also covers AlphaBroder)</span></div>
      <div class="grid2">${f('ss_account', 'Account #', s.ss_account)}${sf('ss_api_key', 'API key', s.ss_api_key_set)}</div>
      <div class="ob-svc-h" style="margin-top:14px">SanMar</div>
      <div class="grid2">${f('sanmar_user', 'Username', s.sanmar_user)}${sf('sanmar_pass', 'Password', s.sanmar_pass_set)}</div>
      ${f('sanmar_cust', 'Customer #', s.sanmar_cust, { hint: 'For customer-specific pricing.' })}
      <div class="row" style="gap:10px;align-items:center"><button class="btn ghost sm" id="dist-check" type="button">Check connection</button><span class="ob-hint" id="dist-note" role="status" aria-live="polite" aria-atomic="true"></span></div>
    </div>${foot()}`

  if (key === 'import') return `<div class="ob-head"><h2>◉ Bring your customers over</h2>
      <p>Don't start from scratch. Export your customer list from Printavo, shopVOX, DecoNetwork, QuickBooks, or a spreadsheet, and import it here — we match the columns and skip anyone already in. Review a small sample before importing your full customer list.</p></div>
    <div id="ob-form" class="ob-form" style="align-items:flex-start">
      <div class="wrap-row"><button class="btn" id="ob-import">Import customers</button><button class="btn ghost" id="ob-import-orders">Import order history</button></div><p class="ob-hint">CSV exports only. Review the preview before importing. PDFs, artwork, and mailbox archives need a separate migration.</p>
      <div class="ob-hint" style="margin-top:10px">Or <a href="#/contacts?new=1">add your first customer by hand</a>. You can always import later.</div>
    </div>${foot('Continue')}`

  // done
  const p = state.data.onboarding
  const ess = [
    ['Google Drive', !!s.gdrive_connected, 'Artwork stored in your own Drive'],
    ['AI', !!s.ai_api_key_set, 'Receptionist and quoting supercharged'],
    ['Email', !!s.smtp_host, 'Messages actually send to customers'],
    ['SMS', !!s.twilio_sid, 'Two-way texting with customers'],
    ['Payments', !!s.stripe_secret_set, 'Deposits and balances into your account'],
  ]
  const essRows = ess.map(([name, ok, why]) => `<div class="ob-ess-row" style="display:flex;align-items:center;gap:10px;padding:7px 0">
    <span style="font-weight:600;color:${ok ? 'var(--accent)' : 'var(--muted, #999)'}">${ok ? '✓' : '○'}</span>
    <span style="min-width:110px;font-weight:600">${esc(name)}</span>
    <span class="dim" style="font-size:12px">${ok ? esc(why) : 'Not connected yet'}</span></div>`).join('')
  return `<div class="ob-done">
    <div class="ob-done-ic">${p.pct === 100 ? '✓' : '◔'}</div>
    <h1>${p.pct === 100 ? "You're fully set up" : "You're ready to go"}</h1>
    <p>${p.done} of ${p.total} setup steps done. Here's what's connected:</p>
    <div class="ob-ess" style="text-align:left;max-width:420px;margin:12px auto 20px">${essRows}</div>
    <p class="dim" style="font-size:12.5px">Finish the rest anytime from the <a href="#/settings">setup checklist in Settings</a> — nothing is locked in.</p>
    <button class="btn" id="ob-finish">Go to my dashboard →</button>
  </div>`
}

/* ---------- wiring ---------- */
// A checklist tick that did not stick is not worth blocking setup over, but it is worth saying:
// silently swallowed, a step marked done on screen and not on the server is indistinguishable
// from one that saved, and the shop finds out when the checklist reappears.
function markStep(key, status) {
  return api.post('/api/onboarding/step', { key, status })
    .catch((e) => { console.warn('setup step not recorded', e); toast('Saved — but the setup checklist could not be updated', true) })
}
function saveSettings(root) {
  const out = {}
  for (const el of $$('[name]', root)) out[el.name] = el.type === 'number' && el.value === '' ? '' : el.value
  return api.put('/api/settings', out)
}
async function advance() { state.i = Math.min(state.i + 1, FLOW.length - 1); state.data = await api.get('/api/onboarding').catch(() => state.data); render() }

function wire(key) {
  $('#ob-back') && ($('#ob-back').onclick = () => leaveStep(() => { state.i = Math.max(0, state.i - 1); render() }))
  $('#ob-skip') && ($('#ob-skip').onclick = async () => { await markStep(key, 'skipped'); advance() })

  if (key === 'welcome') {
    $('#ob-step').onclick = () => { state.i = FLOW.indexOf('quote'); render() }
    $('#ob-configure').onclick = async () => {
      const description = $('#ob-desc').value.trim()
      if (!description) return toast('Tell us a little about your shop first')
      const btn = $('#ob-configure'); btn.disabled = true; btn.textContent = 'Reading…'
      try {
        const r = await api.post('/api/onboarding/configure', { description })
        const out = $('#ob-desc-out'); out.hidden = false
        out.innerHTML = r.changed
          ? `<strong style="color:var(--accent)">✓ Configured ${r.changed} setting${r.changed === 1 ? '' : 's'}${r.methods.length ? ` · ${esc(r.methods.join(', '))}` : ''}</strong><ul>${r.applied.map((a) => `<li>${esc(a)}</li>`).join('')}</ul><div class="ob-hint">Review them in the next step — nothing's locked.</div>`
          : `<span class="dim">Didn't catch specific numbers — no problem, set them in the next step.</span>`
        state.data = await api.get('/api/onboarding').catch(() => state.data)
        setTimeout(() => { state.i = FLOW.indexOf('quote'); render() }, 1400)
      } catch (e) { toast(e.message, true) }
      btn.disabled = false; btn.textContent = 'Configure from this'
    }
    return
  }

  if (key === 'quote') {
    $('#ob-price').onclick = async () => {
      const text = $('#ob-req').value.trim()
      if (!text) return toast('Paste a customer request first')
      const btn = $('#ob-price'), out = $('#ob-quote-out'), note = $('#ob-price-note')
      btn.disabled = true; btn.textContent = 'Reading it…'; note.textContent = ''
      const t0 = performance.now()
      try {
        // Review mode by default: this drafts an estimate and queues a job. Nothing reaches the customer.
        const r = await api.post('/api/autopilot', { text })
        const el = performance.now() - t0
        const secs = el < 950 ? `${Math.max(1, Math.round(el))}ms` : `${(el / 1000).toFixed(1)}s`
        const e = r.estimate || {}, o = r.order || {}
        out.hidden = false
        out.innerHTML = `<strong style="color:var(--accent)">✓ Quoted in ${secs}</strong>
          <ul>
            <li><strong>${esc(e.estimate_number || '')}</strong> — ${money(e.total)} for ${r.pieces || o.total_pieces || ''} × ${esc(o.garment || 'garments')}</li>
            <li>Read by ${o.source === 'model' ? 'your AI model' : 'the built-in reader'}: ${esc(o.decoration || '')}${o.garment_color ? ` · ${esc(o.garment_color)}` : ''}${o.due_hint ? ` · due <strong>${esc(o.due_hint)}</strong>` : ''}</li>
            <li>Customer ${r.isNew ? 'created' : 'matched'}: ${esc((r.contact || {}).name || '')}</li>
            <li>A production job was queued, and your automation rules are live on it.</li>
          </ul>
          <div class="row" style="gap:10px;margin-top:8px">
            <a class="btn sm" href="#/estimates/${e.id}">Open the estimate</a>
            <button class="btn ghost sm" id="ob-quote-next" type="button">Finish setting up →</button>
          </div>`
        $('#ob-quote-next').onclick = async () => { await markStep(key, 'done'); advance() }
        await markStep(key, 'done')
      } catch (err) {
        out.hidden = false
        out.innerHTML = `<span style="color:var(--red)">Couldn't price that: ${esc(err.message)}</span>
          <div class="ob-hint">Make sure the request says how many pieces — that's the one thing a price can't be guessed from.</div>`
      }
      btn.disabled = false; btn.textContent = 'Price it →'
    }
    return
  }

  if (key === 'drive') {
    const btn = $('#ob-drive-connect'), note = $('#ob-drive-note')
    const saveBtn = $('#ob-drive-save')
    saveBtn && (saveBtn.onclick = async () => {
      const cid = $('#ob-gdrive_client_id')?.value.trim() || ''
      const csec = $('#ob-gdrive_client_secret')?.value.trim() || ''
      const patch = { gdrive_client_id: cid }
      if (csec) patch.gdrive_client_secret = csec   // blank = keep the stored secret
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…'
      try { await api.put('/api/settings', patch); toast('Google keys saved'); state.data = await api.get('/api/onboarding').catch(() => state.data); render() }
      catch (e) { toast(e.message, true); saveBtn.disabled = false; saveBtn.textContent = 'Save Google keys' }
    })
    btn && (btn.onclick = async () => {
      btn.disabled = true; const old = btn.textContent; btn.textContent = 'Opening Google…'
      try {
        const r = await api.get('/api/gdrive/connect')
        if (r && r.url) { window.open(r.url, '_blank', 'noopener'); note.innerHTML = 'Finish signing in on the Google tab, then come back — we\'ll mark it connected.' }
        else throw new Error('No connect URL returned')
      } catch (e) {
        toast('Google Drive isn\'t available yet — you can connect it later from Settings', true)
        note.innerHTML = '<span style="color:var(--amber)">Couldn\'t start Google sign-in. Art uses local storage until you connect.</span>'
      }
      btn.disabled = false; btn.textContent = old
    })
    // Falls through to the shared Save & continue handler below, which marks drive done and advances.
  }

  if (key === 'email') $('#ob-mail-provider').onchange = () => {
    if ($('#ob-mail-provider').value === 'google') {
      $('[name=smtp_host]').value='smtp.gmail.com'; $('[name=smtp_port]').value='587'; $('[name=smtp_secure]').value='false'; $('#ob-mail-advanced').open=false; stepDirty=true
    } else { $('#ob-mail-advanced').open=true }
  }
  if (key === 'email' || key === 'sms') {
    const channel = key
    const testBtn = $(`#${channel}-test`), note = $(`#${channel}-note`)
    testBtn && (testBtn.onclick = async () => {
      // Save the freshly-typed creds first so the test uses them. The server only sends a test to the
      // shop's own address/number, so ask where it should land (prefilled with a sensible guess).
      try {
        const form = $('#ob-form')
        if (form && $$('[name]', form).length) await saveSettings(form)
      } catch (e) { note.textContent = `Could not save: ${e.message}`; return }
      const guess = channel === 'email'
        ? (($('[name=smtp_from]') || {}).value || ($('[name=smtp_user]') || {}).value || '').trim()
        : (($('[name=twilio_from]') || {}).value || '').trim()
      const to = window.prompt(channel === 'email'
        ? 'Send a test email to (must be your shop address or your sign-in email):'
        : 'Send a test text to your shop phone number:', guess)
      if (to === null || !to.trim()) { note.textContent = ''; return }
      note.textContent = 'Sending…'
      try {
        const r = await api.post('/api/notify/test', { channel, to: to.trim() })
        const failed = !r || r.error || r.delivered === false
        note.innerHTML = !r || r.error
          ? `<span style="color:var(--red)">✕ ${esc((r && r.error) || 'Send failed')}</span>`
          : r.delivered === false
            ? `<span style="color:var(--amber)">Saved, but not delivered yet (${esc(r.via || 'no mail transport')}). Finish your ${channel === 'email' ? 'SMTP' : 'Twilio'} details to actually send.</span>`
            : `<span style="color:var(--accent)">✓ Test ${channel === 'email' ? 'email' : 'text'} sent — check it arrived</span>`
        // This is the first screen a new shop ever sees, and this span is the only answer it gives
        // to "will my customers actually receive anything". Say it, and interrupt on a refusal.
        announce(failed
          ? `Test ${channel === 'email' ? 'email' : 'text'} not sent. ${(r && r.error) || `finish your ${channel === 'email' ? 'SMTP' : 'Twilio'} details`}`
          : `Test ${channel === 'email' ? 'email' : 'text'} sent — check it arrived.`, failed)
      } catch (e) {
        note.innerHTML = `<span style="color:var(--amber)">Couldn't send a test (${esc(e.message)}). Your settings saved — try again once ${channel === 'email' ? 'SMTP' : 'Twilio'} is set.</span>`
        announce(`Could not send a test. ${e.message}`, true)
      }
    })
    // The main Save & continue button still persists the form and advances (handled below).
  }

  if (key === 'ai') {
    const providers = state.ai?.providers || []
    $('#ai-prov').onchange = () => {
      const p = providers.find((x) => x.id === $('#ai-prov').value)
      $('#ai-model').innerHTML = (p?.models || ['']).map((m) => `<option value="${esc(m)}">${esc(m || '— pick a provider —')}</option>`).join('')
    }
    $('#ai-test').onclick = async () => {
      const provider = $('#ai-prov').value; const note = $('#ai-note')
      if (!provider) return note.textContent = 'Pick a provider to test.'
      note.textContent = 'Testing…'
      try {
        const r = await api.post('/api/ai/test', { provider, model: $('#ai-model').value, api_key: $('#ai-key,[name=ai_api_key]', $('#ob-form')).value?.trim?.() || $('[name=ai_api_key]').value.trim(), use_saved: !$('[name=ai_api_key]').value.trim() })
        note.innerHTML = r.available ? `<span style="color:var(--accent)">✓ Connected — ${esc(r.model || '')}</span>` : `<span style="color:var(--red)">✕ ${esc(r.reason || 'Failed')}</span>`
        announce(r.available ? `AI connected — ${r.model || ''}` : `AI test failed. ${r.reason || 'Failed'}`, !r.available)
      } catch (e) { note.innerHTML = `<span style="color:var(--red)">✕ ${esc(e.message)}</span>`; announce(e.message, true) }
    }
  }

  if (key === 'distributors') {
    $('#dist-check').onclick = async () => {
      const note = $('#dist-note'); note.textContent = 'Saving & checking…'
      try { await saveSettings($('#ob-form')); const st = await api.get('/api/suppliers/status')
        note.innerHTML = st.connected ? `<span style="color:var(--accent)">✓ Connected: ${[st.ss && 'S&S', st.sanmar && 'SanMar', st.alpha && 'AlphaBroder'].filter(Boolean).join(', ')}</span>` : '<span style="color:var(--amber)">No distributor connected yet — check the credentials.</span>'
        announce(st.connected
          ? `Distributor connected: ${[st.ss && 'S&S', st.sanmar && 'SanMar', st.alpha && 'AlphaBroder'].filter(Boolean).join(', ')}`
          : 'No distributor connected yet — check the credentials.', !st.connected)
      } catch (e) { note.innerHTML = `<span style="color:var(--red)">${esc(e.message)}</span>`; announce(e.message, true) }
    }
  }

  if (key === 'import') $('#ob-import-orders').onclick = () => importOrders(() => toast('Order history imported'))
  if (key === 'import') $('#ob-import').onclick = () => importContacts(async () => { await markStep('import', 'done'); state.data = await api.get('/api/onboarding').catch(() => state.data); toast('Customers imported') })

  if (key === 'done') $('#ob-finish').onclick = finishLater

  // The main Save & continue button — persists this step's form, marks it done, advances.
  const next = $('#ob-next')
  if (next) next.onclick = async () => {
    next.disabled = true; next.textContent = 'Saving…'
    try {
      const form = $('#ob-form')
      if (form && $$('[name]', form).length) await saveSettings(form)
      if (key === 'pricing') {
        const svc = {}; $$('[data-svc]').forEach((el) => { svc[el.dataset.svc] = el.value })
        // No .catch here. This is the shop's per-service pricing — the numbers every quote it
        // ever writes is built from — and swallowing the failure meant a 400, a 403 from
        // requireRole, a 500 or the 502/503 restart window all ended with markStep('done'),
        // advance(), and a wizard that slid to the next screen as if the prices had saved. The
        // outer catch already toasts the message and re-enables the button.
        await api.put('/api/onboarding/service-pricing', svc)
      }
      await markStep(key, 'done')
      await advance()
    } catch (e) { toast(e.message, true); next.disabled = false; next.textContent = 'Save & continue' }
  }
}

async function finishLater() {
  try { await api.post('/api/auth/onboarding', { done: true }) } catch {}
  toast("You're all set — welcome aboard")
  state.i = 0
  go('/')
}
