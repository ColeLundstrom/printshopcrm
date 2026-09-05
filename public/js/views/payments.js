import { api, $, $$, esc, setPage, toast, copyText, confirmModal } from '../core.js'
import { mountCollections } from '../shared/payment-collections.js'

let viewSequence = 0

export async function paymentsView() {
  const generation=++viewSequence, hash=location.hash, who=window.__me
  const current=()=>generation===viewSequence && location.hash===hash && window.__me===who
  setPage('Payment connections','<a class="btn ghost" href="#/setup">Back to setup</a>')
  let s, setup
  try { [{settings:s},setup]=await Promise.all([api.get('/api/settings'),api.get('/api/payments/setup').catch(e=>{if(e.status===403)return null;throw e})]) }
  catch(e) { if(!current())return; if(e.status===403) { $('#view').innerHTML='<p>An owner or manager connects payment accounts.</p>';return } throw e }
  if(!current())return
  if(!setup) { $('#view').innerHTML='<p>An owner or manager connects payment accounts.</p>';return }
  if(window.__EDITION==='lite') { $('#view').innerHTML='<p>This installation uses Stripe Connect. <a href="#/settings?section=online">Manage its payment account in Settings.</a></p><div id="payment-collections"></div>';await mountCollections($('#payment-collections'));return }
  const secret=(key,label,hint)=>`<div class="field"><label for="pay-${key}">${label}</label><input class="input" type="password" autocomplete="new-password" name="${key}" id="pay-${key}" placeholder="${s[key+'_set'] ? 'Saved — leave blank to keep' : 'Paste credential'}"><small class="dim">${hint}</small></div>`
  const text=(key,label)=>`<div class="field"><label for="pay-${key}">${label}</label><input class="input" name="${key}" id="pay-${key}" value="${esc(s[key] || '')}"></div>`
  const callback=(id,url)=>url ? `<label for="${id}">Callback URL</label><input class="input" readonly id="${id}" value="${esc(url)}"><button class="btn ghost" type="button" data-copy="${id}">Copy URL</button>${!url.startsWith('https://') ? '<p class="setup-status">Local preview only. Payment callbacks need the public HTTPS address of your installation.</p>' : ''}` : '<p>Set your public HTTPS address before enabling payment callbacks.</p>'
  $('#view').innerHTML=`<div class="setup-workspace">
    <header class="setup-intro"><h1>Get paid into your account.</h1><p>Choose a provider for invoice deposits, balances and gang-sheet checkout. You can always record cash, checks, bank transfers or payments taken elsewhere on an invoice. AI is never required.</p></header>
    <form id="payment-form">
    <section class="setup-section"><h2>1. Choose your payment provider</h2><div class="field"><label for="pay-provider">Online checkout</label><select class="input" name="payment_provider" id="pay-provider"><option value="off">Off — record payments manually</option><option value="stripe">Stripe</option><option value="authorize_net">Authorize.net</option></select></div><p class="setup-status">${setup.ready ? 'Credentials saved. Complete the callback setup and verify a test checkout before accepting real payments.' : 'Online payment setup is incomplete or switched off.'}</p></section>
    <section class="setup-section" id="stripe-fields"><h2>2. Connect Stripe</h2><p>In your Stripe Dashboard, open Developers / Workbench → API keys. Use test mode while checking your setup.</p>${secret('stripe_secret','Secret key','Starts with sk_test_ or sk_live_. The publishable key is not needed for hosted checkout.')}
      <h3>Record payments when customers close the checkout tab</h3><p>In Workbench → Webhooks, add an event destination for your account using this callback. Select <code>checkout.session.completed</code>, <code>checkout.session.async_payment_succeeded</code>, <code>refund.created</code>, <code>refund.updated</code> and <code>refund.failed</code>. Copy that destination’s signing secret below.</p>${callback('stripe-callback',setup.stripe_webhook_url)}${secret('stripe_webhook_secret','Webhook signing secret','Starts with whsec_. Use the destination from the same Stripe account and mode.')}<a href="https://docs.stripe.com/checkout/fulfillment" target="_blank" rel="noopener noreferrer">Stripe callback instructions</a></section>
    <section class="setup-section" id="anet-fields"><h2>2. Connect Authorize.net</h2><p>In your merchant account, open Account → Settings → API Credentials & Keys. Card entry happens on Authorize.net’s hosted payment page.</p><div class="field"><label for="anet-mode">Account environment</label><select class="input" id="anet-mode" name="anet_environment"><option value="sandbox">Sandbox — no real money</option><option value="live">Live merchant account</option></select></div>${text('anet_login_id','API Login ID')}${secret('anet_transaction_key','Transaction Key','Use credentials for the selected environment.')}${secret('anet_signature_key','Signature Key','128 hexadecimal characters. Required to verify incoming payment callbacks.')}${text('anet_currency','Merchant account currency')}<p class="setup-status">Your shop currency is ${esc(setup.currency)}. The merchant account must use the same currency.</p>
      <h3>Receive payment confirmation</h3><p>In Account → Webhooks, add this endpoint and set it Active. Select the payment events for Auth Capture, Capture, Prior Auth Capture, Fraud Approved, Refund and Void.</p>${callback('anet-callback',setup.authorize_webhook_url)}<div class="setup-actions"><button type="button" class="btn ghost" id="test-anet">Save & test credentials</button><a href="https://developer.authorize.net/api/reference/features/webhooks.html" target="_blank" rel="noopener noreferrer">Authorize.net callback instructions</a></div><p id="anet-result" role="status"></p></section>
    <section class="setup-section"><div class="setup-actions"><button class="btn" type="submit">Save payment settings</button><a class="btn ghost" href="#/invoices">Open invoices</a></div><p id="pay-result" role="status"></p><p class="dim">Keys stay on this server and are never displayed again. Test checkouts appear below without changing invoice balances or production. Processor fees are charged by your payment provider.</p></section></form>
    <div id="payment-collections"></div>
    <section class="setup-section"><h2>Refunds & voids</h2><p>These entries reflect provider records. Recheck reads the latest state without moving money.</p>${setup.reversals.length ? setup.reversals.map(r=>`<div class="payment-attempt"><div><strong>${esc(r.provider==='stripe'?'Stripe':'Authorize.net')} · ${esc(r.kind)} ${(r.amount_cents/100).toFixed(2)}</strong><p><span data-reversal-state>${esc(r.status)}</span>${r.is_test?' · Test — balance unchanged':''}<br><small>${esc(r.provider_id)}</small>${r.invoice_id?` · <a href="#/invoices/${r.invoice_id}">Review invoice #${r.invoice_id}</a>`:''}</p></div><button class="btn ghost" data-reversal-provider="${esc(r.provider)}" data-reversal-id="${esc(r.provider_id)}">Recheck refund / void</button></div>`).join('') : '<p class="dim">No refunds or voids received yet.</p>'}
    <details><summary>Refunds, voids & other providers</summary><p>Issue refunds and transaction voids in your processor’s dashboard. Signed callbacks import Stripe refunds and Authorize.net refunds/voids for checkouts recorded here. The invoice pauses for staff review. Recheck pending refunds below. Chargebacks and payments taken outside this app still require manual reconciliation. QuickBooks credit and refund documents must be recorded separately.</p><p>Stripe and Authorize.net are the supported online checkout adapters. Other processors can be used outside the app and recorded manually. New adapters must verify the merchant, reference, currency, amount and payment state before posting to the invoice.</p><button class="btn ghost" id="remove-payment-keys">Remove saved payment credentials</button></details></section>
  </div>`
  const paymentForm=$('#payment-form')
  mountCollections($('#payment-collections'))
  $('#pay-provider').value=s.payment_provider || 'stripe';$('#anet-mode').value=s.anet_environment || 'sandbox'
  const toggle=()=>{ $('#stripe-fields').hidden=$('#pay-provider').value!=='stripe';$('#anet-fields').hidden=$('#pay-provider').value!=='authorize_net' }
  $('#pay-provider').onchange=toggle;toggle()
  $$('[data-copy]').forEach(b=>b.onclick=()=>copyText($('#'+b.dataset.copy).value))
  const formCurrent=()=>current() && paymentForm.isConnected
  const saveButton=$('button[type=submit]',paymentForm),testButton=$('#test-anet',paymentForm)
  const saveResult=$('#pay-result',paymentForm),testResult=$('#anet-result',paymentForm)
  let saving=false
  const readValues=()=>{
    const values=Object.fromEntries(new FormData(paymentForm))
    Object.keys(values).forEach(k=>values[k]=String(values[k]).trim())
    if(values.stripe_secret && !/^sk_(test|live)_/.test(values.stripe_secret)) throw new Error('Use a Stripe secret key beginning sk_test_ or sk_live_.')
    if(values.stripe_webhook_secret && !values.stripe_webhook_secret.startsWith('whsec_')) throw new Error('Use the Stripe webhook signing secret beginning whsec_.')
    if(values.anet_signature_key && !/^[a-f0-9]{128}$/i.test(values.anet_signature_key)) throw new Error('The Authorize.net Signature Key must contain 128 hexadecimal characters.')
    values.anet_currency=values.anet_currency.toUpperCase()
    return values
  }
  const save=async(testCredentials=false)=>{
    if(saving || !formCurrent())return
    let values
    try {values=readValues()}catch(e){if(formCurrent())toast(e.message,true);return}
    const fields=[...paymentForm.querySelectorAll('input,select,button')].map(field=>[field,field.disabled])
    saving=true;fields.forEach(([field])=>{field.disabled=true})
    try {
      await api.put('/api/settings',values)
      if(!formCurrent())return
      $$('input[type=password]',paymentForm).forEach(i=>{if(i.value)i.placeholder='Saved — leave blank to keep';i.value=''})
      saveResult.textContent='Saved. Verify payment callbacks in your provider dashboard.'
      if(testCredentials) {
        const result=await api.post('/api/payments/test-authorize',{})
        if(formCurrent())testResult.textContent=`Credentials accepted by ${result.environment}. No charge was made. Next, test a checkout and its callback.`
      }
    } catch(error) {
      if(formCurrent()){if(testCredentials)testResult.textContent=error.message;else toast(error.message,true)}
    } finally {saving=false;if(formCurrent())fields.forEach(([field,disabled])=>{field.disabled=disabled})}
  }
  paymentForm.onsubmit=event=>{event.preventDefault();return save()}
  testButton.onclick=()=>save(true)
  $('#remove-payment-keys').onclick=async()=>{
    if(saving || !formCurrent())return
    if(!await confirmModal('Remove payment credentials?','This disconnects both providers and clears their saved keys. Resolve pending checkouts first: without the keys, their callbacks cannot be verified. Existing payment records stay in place.'))return
    if(saving || !formCurrent())return
    saving=true
    try {await api.post('/api/settings/disconnect/payments',{});if(formCurrent())await paymentsView()}
    catch(e){if(formCurrent())toast(e.message,true)}finally{saving=false}
  }
  $$('[data-reversal-id]').forEach(button=>button.onclick=async()=>{
    if(button.disabled || !formCurrent())return
    button.disabled=true
    try {
      const result=await api.post(`/api/payments/reversals/${button.dataset.reversalProvider}/${encodeURIComponent(button.dataset.reversalId)}/recheck`,{})
      if(!formCurrent() || !button.isConnected)return
      const latest=await api.get('/api/payments/setup')
      if(!formCurrent() || !button.isConnected)return
      const row=latest.reversals.find(r=>r.provider===button.dataset.reversalProvider && r.provider_id===button.dataset.reversalId)
      const status=button.closest('.payment-attempt')?.querySelector('[data-reversal-state]')
      if(row && status)status.textContent=row.status
      toast(result.ignored?'No matching checkout found':result.test?'Test entry verified; balance unchanged':'Provider state checked')
    } catch(e){if(formCurrent())toast(e.message,true)}finally{if(formCurrent() && button.isConnected)button.disabled=false}
  })
}
