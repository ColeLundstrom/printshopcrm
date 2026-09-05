/* Hallmark · component: checkout recovery · uses the existing payment/settings design system. */
import { api, esc, modal, closeModal } from '../core.js'

let owner, states = new Map(), sequence = 0
const providerName = p => p === 'authorize_net' ? 'Authorize.net' : p === 'stripe_connect' ? 'Stripe Connect' : 'Stripe'
const amount = row => `${esc(row.currency || '')} ${Number.isSafeInteger(row.amount_cents) ? (row.amount_cents / 100).toFixed(2) : 'Amount needs review'}`
const invoiceLink = row => Number.isSafeInteger(row.invoice_id) && row.invoice_id > 0 ? `<a href="#/invoices/${row.invoice_id}">Invoice #${row.invoice_id}</a>` : 'Online order'
export function safeCollectionUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\x00-\x20\x7f]/.test(value)) return ''
  try {
    const u = new URL(value, location.origin)
    return !u.username && !u.password && (u.origin === location.origin || (u.protocol === 'https:' && u.hostname === 'checkout.stripe.com' && !u.port)) ? u.href : ''
  } catch { return '' }
}

export function collectionRows(data, state = {}) {
  const busy = !!state.busy
  return `${data.collections.length ? data.collections.map(c => `<article class="collection-row">
    <div class="collection-heading"><strong>${providerName(c.provider)} · ${amount(c)}</strong><span class="tag">${esc(String(c.state || 'Review').replaceAll('_', ' '))}${c.is_test ? ' · Test' : ''}</span></div>
    <p>${invoiceLink(c)} · ${esc(c.kind || 'payment')}<br><small>${esc(c.created_at || '')} · ${esc(c.reference)}</small></p>
    ${c.message ? `<p class="setup-status">${esc(c.message)}</p>` : ''}
    ${c.requires_transaction_id && c.actions?.recheck ? `<label class="field">Authorize.net transaction ID<input class="input" data-collection-transaction="${esc(c.reference)}" inputmode="numeric" autocomplete="off" maxlength="40" value="${esc(state.drafts?.get(c.reference) || '')}" placeholder="From your merchant account" ${busy ? 'disabled' : ''}></label>` : ''}
    ${c.requires_session_id && c.actions?.recheck ? `<label class="field">Stripe checkout session ID<input class="input" data-collection-session="${esc(c.reference)}" autocomplete="off" maxlength="220" value="${esc(state.sessions?.get(c.reference) || '')}" placeholder="cs_… from your Stripe account" ${busy ? 'disabled' : ''}></label>` : ''}
    <div class="collection-actions">${[['resume','Resume saved checkout'],['recheck','Check provider'],['expire','Close unpaid checkout']].filter(([action]) => c.actions?.[action] === true).map(([action,label]) => `<button class="btn ghost" type="button" data-collection-action="${action}" data-collection-reference="${esc(c.reference)}" ${busy ? 'disabled' : ''}>${label}</button>`).join('')}</div>
    ${state.links?.get(c.reference) ? `<p><a class="btn ghost" href="${esc(state.links.get(c.reference))}" target="_blank" rel="noopener noreferrer">Open saved checkout</a></p>` : ''}
  </article>`).join('') : '<p class="dim">No online checkout records yet.</p>'}
  ${data.receipts.length ? `<h3>Payments needing review</h3><p>Review this provider activity before requesting more money. Recorded evidence stays available even when it cannot yet be applied to an invoice.</p>${data.receipts.map(r => `<article class="collection-row"><strong>${providerName(r.provider)} · ${amount(r)}${r.is_test ? ' · Test' : ''}</strong><p>${invoiceLink(r)}<br><small>${esc(r.transaction_id || r.reference || '')} · ${esc(r.created_at || '')}</small></p><p class="setup-status">${esc(r.reason || r.message || r.state || 'Needs a manager review')}</p></article>`).join('')}` : ''}`
}

// A provider recheck never replaces the adjacent settings form or its unsaved credentials.
export async function mountCollections(element, options = {}) {
  if (!element) return
  if (owner !== window.__me) { owner = window.__me; states = new Map() }
  const who = owner, hash = location.hash, mount = ++sequence, key = options.invoiceId ? `invoice:${options.invoiceId}` : 'all'
  let state = states.get(key)
  if (!state) { state = {data:null,busy:false,message:'',error:false,drafts:new Map(),sessions:new Map(),links:new Map()}; states.set(key,state) }
  state.mount = mount
  const current = () => element.isConnected && owner === who && window.__me === who && state.mount === mount && location.hash === hash
  const capture = () => {
    if (!state.busy) for (const input of element.querySelectorAll('[data-collection-transaction]')) state.drafts.set(input.dataset.collectionTransaction,input.value)
    if (!state.busy) for (const input of element.querySelectorAll('[data-collection-session]')) state.sessions.set(input.dataset.collectionSession,input.value)
  }
  async function refresh() {
    capture()
    const request = state.loadSeq = (state.loadSeq || 0) + 1
    try {
      const result = await api.get('/api/payments/collections'+(options.invoiceId ? `?invoice_id=${encodeURIComponent(options.invoiceId)}` : ''))
      if (!current() || state.loadSeq !== request) return
      capture()
      const belongs = row => !options.invoiceId || row.invoice_id === Number(options.invoiceId)
      state.data = {collections:(result.collections || []).filter(belongs),receipts:(result.receipts || []).filter(belongs),has_more:!!result.has_more,receipts_have_more:!!result.receipts_have_more}
      // A completed or changed checkout must not retain a previously offered browser link.
      for (const ref of state.links.keys()) if (!state.data.collections.some(c => c.reference === ref && c.actions?.resume)) state.links.delete(ref)
      render()
    } catch(e) {
      if (!current() || state.loadSeq !== request) return
      state.error = true; state.message = `Could not refresh checkout status. ${e.message}`; render()
    }
  }
  state.notify = async changed => {
    if (!current()) return
    await refresh()
    if (changed && current()) options.onChange?.()
  }
  function render() {
    if (!current()) return
    if (options.hideEmpty && state.data && !state.data.collections.length && !state.data.receipts.length && !state.message) { element.innerHTML = ''; return }
    element.innerHTML = `<section class="setup-section collection-panel"><div class="collection-heading"><h2>Online checkout activity</h2><button class="btn ghost" type="button" data-collection-refresh ${state.busy ? 'disabled' : ''}>Refresh status</button></div>
      <p>Resume an existing checkout or ask the provider for its result. Checking a payment does not charge or refund it. An uncertain checkout stays on hold.</p>
      ${state.data ? collectionRows(state.data,state) : '<p role="status">Loading checkout records…</p>'}
      ${state.data?.has_more || state.data?.receipts_have_more ? '<p class="setup-status">More records are available. Open the relevant invoice for its checkout history; older unmatched receipts need review in the payment account.</p>' : ''}
      <p class="collection-feedback ${state.error ? 'collection-error' : ''}" role="${state.error ? 'alert' : 'status'}">${esc(state.message)}</p></section>`
    element.querySelector('[data-collection-refresh]')?.addEventListener('click',refresh)
    for (const input of element.querySelectorAll('[data-collection-transaction]')) input.oninput = capture
    for (const input of element.querySelectorAll('[data-collection-session]')) input.oninput = capture
    for (const button of element.querySelectorAll('[data-collection-action]')) button.onclick = () => {
      if (!current() || state.busy) return
      capture()
      const ref = button.dataset.collectionReference, action = button.dataset.collectionAction
      const row = state.data.collections.find(c => c.reference === ref)
      if (!row || row.actions?.[action] !== true) return
      if (action !== 'expire') return act(row,action)
      modal({title:'Close this unpaid checkout?',body:`<p>${providerName(row.provider)} · <strong>${amount(row)}</strong></p><p>The provider will be checked first. A completed payment is recorded. An unpaid open checkout is closed so the old link can no longer be used. No charge or refund is issued.</p>`,footer:'<button class="btn ghost" data-close>Back</button><button class="btn" data-close-checkout>Check and close checkout</button>',onMount:root=>{
        const go = root.querySelector('[data-close-checkout]')
        go.onclick = () => { if(!root.isConnected || !current() || state.busy)return; closeModal(); return act(row,action) }
      }})
    }
  }
  async function act(row, action) {
    if (!current() || state.busy) return
    const body = {revision:row.revision}
    if (action === 'recheck' && row.requires_transaction_id) {
      body.transaction_id = (state.drafts.get(row.reference) || '').trim()
      if (!/^\d{1,40}$/.test(body.transaction_id)) { state.error=true;state.message='Enter the transaction ID from your Authorize.net account.';render();return }
    }
    if (action === 'recheck' && row.requires_session_id) {
      body.session_id = state.sessions.get(row.reference) || ''
      if (!/^cs_[A-Za-z0-9_]+$/.test(body.session_id) || body.session_id.length > 220) { state.error=true;state.message='Enter the checkout session ID from your Stripe account, beginning cs_.';render();return }
    }
    state.busy=true;state.error=false;state.message=action==='expire'?'Checking the provider before closing…':action==='resume'?'Checking the saved checkout…':'Checking the provider…';render()
    try {
      const ref = encodeURIComponent(row.reference)
      const result = await api.post(action === 'recheck' ? `/api/payments/reconcile/${ref}` : `/api/payments/collections/${ref}/${action}`,body)
      state.busy=false
      const link = result.url ? safeCollectionUrl(result.url) : ''
      if (result.url && !link) { state.error=true;state.message='The checkout address could not be verified. Refresh status before continuing.' }
      else {
        if(link) state.links.set(row.reference,link)
        state.message=link?'The existing checkout is ready. Open it below.':result.pending?'Payment is not confirmed yet. The checkout remains on hold.':'Provider checked. Review the current status below.'
      }
      await state.notify?.(true)
    } catch(e) {
      state.busy=false;state.error=true;state.message=`The result could not be confirmed. Refresh status before retrying. ${e.message}`
      if(current())render();else state.notify?.(false)
    }
  }
  element.innerHTML='<p role="status">Loading checkout records…</p>'
  if(state.data)render()
  await refresh()
}
