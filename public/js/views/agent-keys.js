import {api,$,$$,esc,setPage,toast,confirmModal,copyText} from '../core.js'

export async function agentKeysView(){
  setPage('Agent connections','<a class="btn ghost" href="#/setup">Setup & connections</a>')
  const d=await api.get('/api/developers/agents')
  const defaults=['pricing:read','customers:read','estimates:read','invoices:read','payments:read','jobs:read','production:read']
  $('#view').innerHTML=`<div class="stack production-page">
    <section class="card card-b"><h2>Give each agent its own access</h2><p>Connect the agent you already use in Slack or another app. It keeps its existing model and messaging setup. Create a named PrintShopCRM key, choose what it can do, then paste the key into your agent’s secret storage.</p><p>Keys belong to the manager who creates them. Disabling or demoting that account stops its agent access. Revoking one key leaves other integrations working. No AI is required to use the CRM.</p></section>
    <form class="card card-b" id="agent-key-form"><h3>New connection</h3><div class="prod-fields"><label class="field">Agent name<input class="input" name="name" required maxlength="80" placeholder="Shop assistant"></label><label class="field">Expires in days<input class="input" name="expires_days" type="number" min="1" max="365" value="90" required></label></div><p>Start with read access. Add only the changes you want this agent to perform. Expiry starts when you create the key.</p><fieldset class="agent-permissions"><legend>Permissions</legend>${Object.entries(d.scopes).map(([scope,label])=>`<p><label><input type="checkbox" name="scope" value="${esc(scope)}" ${defaults.includes(scope)?'checked':''}> ${esc(label)}</label></p>`).join('')}</fieldset><p class="dim">Write permissions perform changes immediately through the API. Your agent must provide its own approval flow. Customer creation and stage changes can trigger your configured automations. Production completion still follows task order and receiving, artwork and payment holds.</p><button class="btn" id="agent-key-create">Create connection key</button><p role="status" id="agent-key-status"></p></form>
    <section id="agent-key-secret" class="card card-b" hidden></section>
    <section class="card card-b"><h3>Your connections</h3><p>Keys are shown only once when created. To replace a key, create a new connection, update the agent, test it, then revoke the old key.</p><div id="agent-key-list">${d.keys.length?d.keys.map(k=>{
      const expired=new Date(k.expires_at).getTime()<=Date.now(),inactive=!!k.revoked_at || expired
      return `<article class="card card-b"><h4>${esc(k.name)}</h4><p>${esc(k.prefix)}… · ${k.revoked_at?'Revoked':expired?'Expired':k.member_active===false?'Stopped — creator access changed':'Active'} · Expires ${esc(k.expires_at.slice(0,10))}</p><p>${k.scopes.map(s=>esc(d.scopes[s] || s)).join(' · ')}</p><p class="dim">Created by ${esc(k.member_name || 'Shop manager')} · Last request: ${esc(k.last_used_at || 'Not used yet')}</p><button class="btn ghost" data-agent-audit="${k.id}">Recent requests</button> ${inactive?'':`<button class="btn ghost" data-agent-revoke="${k.id}" data-name="${esc(k.name)}">Revoke access</button>`}<div id="agent-audit-${k.id}"></div></article>`
    }).join(''):'<p>No agent connections yet.</p>'}</div></section>
    <section class="card card-b"><h3>Connection guide</h3><pre id="agent-key-guide">API base: ${esc(location.origin)}/api/v1
Authentication: Authorization: Bearer YOUR_AGENT_KEY
Test: GET /me (returns granted permissions and expiry)
Create customers/estimates: persist a unique Idempotency-Key header before sending.
After a timeout, retry the same body with the same key and credential.
Read pricing: GET /pricing
Custom matrix: GET /matrices/MATRIX_ID
Read job tasks: GET /jobs/JOB_ID/workflow
Department queue: GET /production/queue?department=QC
Complete task: POST /jobs/JOB_ID/tasks/TASK_ID/action
Body: {"revision": CURRENT_REVISION, "action": "complete"}
On a conflict, reload the workflow before proposing another change.</pre><button class="btn ghost" id="agent-guide-copy">Copy guide</button><p>Use numeric record IDs returned by the API. The agent key cannot manage credentials, webhooks or settings. <a href="/docs-api.html" target="_blank" rel="noopener noreferrer">API documentation</a> includes the supported customer, estimate and job operations.</p></section>
  </div>`
  $('#agent-guide-copy').onclick=()=>copyText($('#agent-key-guide').textContent,'Connection guide copied')
  $('#agent-key-form').onsubmit=async e=>{
    e.preventDefault();const b=$('#agent-key-create');b.disabled=true
    try{
      const form=e.currentTarget,created=await api.post('/api/developers/agents',{name:form.elements.name.value,expires_days:Number(form.elements.expires_days.value),scopes:$$('[name=scope]:checked').map(el=>el.value)})
      const box=$('#agent-key-secret');box.hidden=false
      box.innerHTML=`<h3>Copy this key now</h3><p>Store it only in your agent’s secret storage. It will not be shown again. Expires ${esc(created.key.expires_at.slice(0,10))}.</p><pre>${esc(created.token)}</pre><button class="btn" id="agent-secret-copy">Copy key</button> <button class="btn ghost" id="agent-secret-done">Done — hide key</button>`
      $('#agent-secret-copy').onclick=()=>copyText(created.token,'Agent key copied')
      $('#agent-secret-done').onclick=()=>agentKeysView()
      $('#agent-key-status').textContent='Connection created. Copy the key before leaving this screen.'
      box.scrollIntoView({behavior:'smooth',block:'center'})
    }catch(err){$('#agent-key-status').textContent=err.message;b.disabled=false}
  }
  $$('[data-agent-revoke]').forEach(b=>b.onclick=()=>confirmModal('Revoke '+b.dataset.name+'?','This agent loses access immediately. Other connections remain active.',async()=>{try{await api.del('/api/developers/agents/'+b.dataset.agentRevoke);toast('Agent access revoked');agentKeysView()}catch(e){toast(e.message,true)}},'Revoke access'))
  $$('[data-agent-audit]').forEach(b=>b.onclick=async()=>{
    try{const data=await api.get('/api/developers/agents/'+b.dataset.agentAudit+'/audit');$('#agent-audit-'+b.dataset.agentAudit).innerHTML=data.requests.length?data.requests.map(r=>`<p>${esc(r.created_at)} · ${esc(r.method)} ${esc(r.path)} · ${r.status}</p>`).join(''):'<p>No requests recorded.</p>'}catch(e){toast(e.message,true)}
  })
}
