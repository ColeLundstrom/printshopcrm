import { api, $, esc, modal, closeModal, toast, go } from '../core.js'

let owner, states = new Map(), sequence = 0
const customerLabel = c => `${c.name || 'Unnamed customer'}${c.company ? ' · ' + c.company : ''}${c.email ? ' · ' + c.email : ''}`
function requestId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  if (typeof globalThis.crypto?.getRandomValues === 'function')
    return 'duplicate-' + Array.from(globalThis.crypto.getRandomValues(new Uint8Array(24)), n => n.toString(16).padStart(2, '0')).join('')
  throw new Error('This browser cannot create a secure retry reference. Use a current browser over HTTPS or localhost.')
}

// Keep an unresolved action across Close / Back / reopening in this signed-in app session.
// Nothing is written to browser storage: a full reload loses an unresolved reference.
export function duplicateEstimateModal(estimate, opener) {
  if (owner !== window.__me) { owner = window.__me; states = new Map() }
  const who = owner, hash = location.hash, mount = ++sequence
  const stateKey = `${estimate.id}:${estimate.source_identity}`
  let state = states.get(stateKey)
  if (!state) {
    state = { selected: String(estimate.contact_id), contacts: null, pending: null, busy: false, result: null, message: '', error: false }
    states.set(stateKey, state)
  }
  state.mount = mount
  modal({ title: `Duplicate ${estimate.estimate_number}`, body: `
    <p>Reuse these line items and sizes for the same customer or another existing customer.</p>
    <div class="field"><label for="duplicate-customer">Customer for the new quote</label>
      <select class="input" id="duplicate-customer" aria-describedby="duplicate-review" disabled></select>
    </div>
    <p class="dim" id="duplicate-review">Saved prices, decoration details, rush tier and notes are copied. Review prior prices and customer-specific notes in the new draft. The chosen customer's current addresses and delivery contacts and the shop's current terms apply. Tax is recalculated for a different customer. Nothing is sent.</p>
    <p id="duplicate-feedback" role="status" aria-live="polite"></p>
    <button class="btn ghost sm" type="button" id="duplicate-reload" hidden>Retry loading customers</button>`,
    footer: '<button class="btn ghost" data-close>Close</button><button class="btn" type="button" id="duplicate-create" disabled>Create draft &amp; edit</button>',
    onMount: root => {
      const select = $('#duplicate-customer', root), submit = $('#duplicate-create', root)
      const feedback = $('#duplicate-feedback', root), reload = $('#duplicate-reload', root)
      const current = () => root.isConnected && opener.isConnected && $('#dup') === opener && location.hash === hash && owner === who && window.__me === who && state.mount === mount
      const render = () => {
        if (!current()) return
        const selected = state.pending ? String(state.pending.body.contact_id) : state.selected
        const choices = state.contacts || [{ id: selected, name: state.pending?.customer || estimate.contact_name || 'Current customer' }]
        select.innerHTML = choices.map(c => `<option value="${c.id}" ${String(c.id) === selected ? 'selected' : ''}>${esc(customerLabel(c))}</option>`).join('')
        select.value = selected
        select.disabled = state.busy || !!state.pending || !!state.result || !state.contacts
        submit.disabled = state.busy || (!state.result && !state.pending && (!state.contacts || !select.value))
        submit.textContent = state.busy ? 'Creating…' : state.result ? `Open ${state.result.estimate_number}` : state.pending ? 'Retry same copy' : 'Create draft & edit'
        feedback.textContent = state.message || (state.contacts ? 'This creates a new draft with its own estimate number.' : 'Loading customers…')
        feedback.setAttribute('role', state.error ? 'alert' : 'status')
        feedback.style.color = state.error ? 'var(--red)' : ''
        reload.hidden = !!state.contacts || state.busy || !!state.pending || !!state.result
      }
      state.notify = render
      const load = async () => {
        reload.hidden = true
        try {
          const data = await api.get('/api/contacts')
          if (!current()) return
          state.contacts = data.contacts
          if (!state.pending && !state.result) { state.message = ''; state.error = false }
          render()
        } catch (error) {
          if (!current()) return
          state.message = error.message; state.error = true; render()
        }
      }
      select.onchange = () => {
        if (state.busy || state.pending || state.result || !current()) return
        state.selected = select.value; state.message = ''; state.error = false; render()
      }
      const openResult = () => {
        if (!current() || !state.result) return
        const result = state.result
        states.delete(stateKey); closeModal(); toast(`Created ${result.estimate_number}`); go(`/estimates/${result.id}/edit`)
      }
      submit.onclick = async () => {
        if (state.busy || !current()) return
        if (!state.pending) {
          const customer = state.contacts?.find(c => String(c.id) === select.value)
          if (!customer) return
          try {
            if (!/^[a-f0-9]{32}$/.test(estimate.source_identity || '')) throw new Error('Reload this quote before creating a copy so its source can be verified.')
            state.pending = { body: { contact_id: customer.id, commercial_revision: estimate.commercial_revision, source_identity: estimate.source_identity, request_id: requestId() }, customer: customerLabel(customer) }
          } catch (error) { state.message = error.message; state.error = true; render(); return }
        }
        state.result = null
        state.busy = true; state.error = false; state.message = 'Creating or checking this draft… You can close this dialog and reopen Duplicate to check this copy.'; render()
        try {
          state.result = await api.post(`/api/estimates/${estimate.id}/duplicate`, state.pending.body)
          // Preserve the request for an offscreen completion. Reopening must check the durable
          // receipt again, because the saved draft could have been deleted while we were away.
          state.busy = false; state.message = `Created ${state.result.estimate_number}. Open the draft to review it.`
          if (current()) openResult()
          else state.notify?.()
        } catch (error) {
          state.busy = false; state.error = true
          if (error.status >= 400 && error.status < 500 && ![408,429].includes(error.status)) {
            state.pending = null; state.result = null; state.message = error.message
          } else {
            state.message = 'The result is uncertain. Retry the same copy to recover its saved result. Reopen Duplicate if you leave this page; before a full reload, check Estimates for the draft. ' + error.message
          }
          state.notify?.()
        }
      }
      reload.onclick = load
      render()
      // core.modal subsequently tries its first select. When that select is loading or
      // retry-locked it cannot take focus, so establish a focusable in-dialog fallback first.
      root.querySelector('[data-close]')?.focus()
      if (!state.contacts && !state.pending && !state.result) load()
    },
  })
}
