import { api, $, esc, setPage, toast, copyText } from '../core.js'
import { importContacts, importOrders } from './contacts.js'

// A map of the existing working setup paths, not another copy of their forms.
export async function setupView() {
  setPage('Setup & connections', '<a class="btn ghost" href="#/">Go to Today</a>')
  if (window.__me?.can_manage === false) {
    $('#view').innerHTML = '<p class="dim">An owner or manager connects services. Your daily work is available from Today.</p>'
    return
  }
  const [{ settings: s }, status, dev, sms] = await Promise.all([
    api.get('/api/settings'), api.get('/api/notify/status'), api.get('/api/developers').catch(e => { if(e.status===403) return null; throw e }), api.get('/api/sms-setup').catch(e => { if(e.status===403) return null; throw e }),
  ])
  if (!dev || !sms) {
    $('#view').innerHTML = '<p class="dim">Your access changed. An owner or manager connects services. Reload after your role is updated.</p>'
    return
  }
  const row = (n, title, text, href, action, state='') => `<div class="setup-row"><span class="setup-number" aria-hidden="true">${n}</span><div><h3>${title}</h3><p>${text}</p>${state ? `<span class="setup-status">${esc(state)}</span>` : ''}</div><a class="btn ghost" href="${href}">${action}</a></div>`
  const aiOn = !!s.ai_provider
  $('#view').innerHTML = `<div class="setup-workspace">
    <header class="setup-intro"><h1>Your shop. Your way of working.</h1><p>Start with the essentials and connect services as you need them. Quotes, invoices, pricing, production, and customer records work without AI.</p></header>
    <section class="setup-section"><h2>1. Make it yours</h2>
      ${row('01','Shop details & pricing','Put your name on documents. Review your currency, tax rate and costing before your first quote.','#/welcome?step=basics','Review basics',s.shop_name || '')}
      ${row('02','Bring your history','Import customer lists and order history from CSV exports. Preview the records before anything is written.','#/welcome?step=import','Import data')}
      <details><summary>Migration formats & checks</summary><p>Export customers and orders separately from Printavo, another CRM, or a spreadsheet. Keep the original files. Standard headers are recognized automatically; rename unfamiliar columns using the examples below.</p><pre>Customers: name,email,phone,company,notes,tags
Orders: customer,email,invoice #,date,status,product,qty,unit price,total</pre><p>Use YYYY-MM-DD dates. Review names, order numbers, totals, and payment states in a small sample first. Customer duplicates match by email; records without email need manual review. PDF invoices, artwork files, mailbox archives, and custom fields are not imported by this CSV tool.</p><div class="setup-actions"><button class="btn ghost" id="setup-customers">Import customers</button><button class="btn ghost" id="setup-orders">Import order history</button><a class="btn ghost" href="/api/export/all.json" download>Export shop backup</a></div></details>
    </section>
    <section class="setup-section"><h2>2. Connect your communications</h2><p>Your team can send and reply manually. Connecting email or SMS does not require an AI account.</p>
      ${row('03','Email from your domain','Connect your existing mailbox or email service. Send yourself a test before emailing customers.','#/welcome?step=email','Connect email',status.shop_email ? 'Email credentials saved — verify delivery with a test' : 'Not connected')}
      <details><summary>Domain & incoming email</summary><p>Use a mailbox on your domain, such as quotes@yourshop.com. Your mail provider supplies the server and authentication settings. Follow its SPF, DKIM and DMARC instructions; DNS records are provider-specific.</p><p>SMTP connects outgoing mail. Replies currently arrive in your existing mailbox; automatic mailbox sync into Conversations is not included yet.</p><a href="https://support.google.com/a/answer/176600" target="_blank" rel="noopener noreferrer">Google Workspace email setup</a></details>
      ${row('04','Text from your Twilio number','Save your Account SID, Auth Token and SMS-capable number. Test outgoing delivery, then connect incoming texts below.','#/welcome?step=sms','Connect Twilio',status.sms ? 'SMS credentials saved — test sending and receiving' : 'Not connected')}
      <details><summary>Receive texts in Conversations</summary><p>In Twilio, open Phone Numbers → Manage → Active numbers → your number. Under Messaging, set “A message comes in” to Webhook, paste this URL, and choose HTTP POST. Save, then text your Twilio number from your own phone.</p>
      ${sms.url ? `<label for="sms-receive-url">Incoming SMS URL</label><input class="input" id="sms-receive-url" readonly value="${esc(sms.url)}"><div class="setup-actions"><button class="btn ghost" id="copy-sms-url">Copy URL</button><a class="btn ghost" href="#/conversations">Open Conversations</a></div><p class="setup-status">${esc(sms.public_https ? 'Public HTTPS address configured. Incoming requests must have a valid Twilio signature.' : 'This local preview cannot receive Twilio webhooks. Use a public HTTPS address when deployed.')}</p>` : `<p>${esc(sms.reason)}</p>`}
      <p class="setup-status">Text content is supported. MMS attachments are identified but not downloaded. No automatic reply is sent. Complete any number or messaging registration Twilio requires for your destination countries.</p><a href="https://www.twilio.com/docs/messaging/guides/webhook-request" target="_blank" rel="noopener noreferrer">Twilio webhook guide</a></details>
    </section>
    <section class="setup-section"><h2>3. Set up payments</h2>${row('05','Collect deposits & balances','Connect Stripe or Authorize.net to your own merchant account. Other payment methods can always be recorded manually.','#/payments','Set up payments')}</section>
    <section class="setup-section"><h2>4. Choose how much help you want</h2><p>AI is an optional assistant. You keep all of the normal screens and controls.</p>
      <div class="setup-row"><span class="setup-number">06</span><div><h3>Work manually</h3><p>Turn off the model and set assisted workflows to ask you first. Independently configured automation rules can be reviewed under More tools → Automations.</p><span class="setup-status">${aiOn ? 'An AI provider is selected' : 'AI is off'}</span></div><button class="btn ghost" id="setup-manual">Use manual controls</button></div>
      ${row('07','Add an AI model','Optional parsing and reply drafts using your own provider account. Test the connection in settings.','#/settings?section=ai','AI settings',aiOn ? 'Provider selected — test to verify' : 'Optional — off')}
      ${row('08','Connect Slack','Create your Slack app from a ready-made setup file. The built-in /quote command creates draft estimates for review.','#/settings?section=slack','Connect Slack',s.slack_bot_token_set && s.slack_signing_secret_set ? 'Credentials saved — test in Slack settings' : 'Optional — not connected')}
      <details><summary>Connect your own agent to the shop API</summary><p>Already use an agent in Slack? Give that agent your shop API endpoint and a PrintShopCRM key. Your agent keeps its existing Slack and model connection. This is different from the optional model key above.</p>
      <pre id="agent-connection">API base: ${esc(location.origin)}/api/v1
Authentication: Authorization: Bearer YOUR_PRINTSHOPCRM_KEY
Connection test: GET /me
Read: GET /customers, /estimates, /invoices, /jobs, /payments
Pagination: limit and offset; follow has_more
Writes: POST /customers, /estimates, /jobs/:id/stage</pre>
      <p>Start with read-only access. The key belongs to this shop and is shared by its existing integrations. Changing access affects all users of this key. Rotating it disconnects those integrations.</p>
      <label for="agent-access">API key access</label><select class="input" id="agent-access"><option value="read" ${dev.api_access === 'read' ? 'selected' : ''}>Read only</option><option value="full" ${dev.api_access !== 'read' ? 'selected' : ''}>Read and write</option></select>
      <div class="setup-actions"><button class="btn ghost" id="agent-access-save">Save API access</button>${!dev.api_key_set ? '<button class="btn" id="agent-create">Create read-only key</button>' : '<a class="btn ghost" href="#/developers">Manage existing key</a>'}<button class="btn ghost" id="agent-copy">Copy connection guide</button><a class="btn ghost" href="/docs-api.html" target="_blank" rel="noopener noreferrer">API documentation</a></div><div id="agent-new-key" role="status"></div>
      <p class="setup-status">Read-and-write keys can create customers and draft estimates and move jobs. Your external agent must implement its own Slack permissions and approval policy. This does not install an agent or connect it automatically.</p></details>
    </section>
    <section class="setup-section"><h2>Ready for your first job</h2><p>Add a customer, make an estimate, review the price, and move the approved work into production.</p><div class="setup-actions"><a class="btn" href="#/estimates/new">New estimate</a><a class="btn ghost" href="#/settings">All settings</a><a class="btn ghost" href="#/board">Job board</a></div></section>
  </div>`
  $('#setup-customers').onclick = () => importContacts()
  $('#setup-orders').onclick = () => importOrders()
  if ($('#copy-sms-url')) $('#copy-sms-url').onclick = () => copyText(sms.url, 'Incoming SMS URL copied')
  $('#agent-copy').onclick = () => copyText($('#agent-connection').textContent, 'Connection guide copied')
  $('#setup-manual').onclick = async () => {
    try { await api.put('/api/settings', { ai_provider:'', mode_intake:'manual', mode_estimates:'manual', mode_followups:'manual', mode_agent:'manual', mode_art:'manual' }); toast('AI off. Assisted workflows now ask you first.'); setupView() } catch(e) { toast(e.message,true) }
  }
  $('#agent-access-save').onclick = async () => {
    try { await api.put('/api/settings', { api_access:$('#agent-access').value }); toast('API access saved') } catch(e) { toast(e.message,true) }
  }
  if ($('#agent-create')) $('#agent-create').onclick = async () => {
    const b=$('#agent-create'); b.disabled=true
    try {
      const d=await api.post('/api/developers/key/create-readonly', {})
      $('#agent-access').value='read'
      $('#agent-new-key').innerHTML=`<p>Copy this key into your agent’s secret storage. It is shown once.</p><pre>${esc(d.api_key)}</pre>`
      b.textContent='Key created'
    } catch(e) { b.disabled=false; toast(e.message,true) }
  }
}
