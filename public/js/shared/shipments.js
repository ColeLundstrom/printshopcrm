/* Hallmark · pre-emit critique: P4 H4 E4 S5 R5 V4 · component: shipment ledger · design-system: design.md */
import { api, esc } from '../core.js'

const kinds = { parcel:'Parcel',pickup:'Customer pickup',local_delivery:'Local delivery',legacy_unspecified:'Legacy record — method unconfirmed' }
let owner, states = new Map(), sequence = 0
const emptyDraft = () => ({kind:'parcel',carrier:'',tracking_number:'',note:'',dispatched_on:'',reason:''})
const field = (label,name,value='',extra='') => `<label class="field">${esc(label)}<input class="input" name="${name}" value="${esc(value)}" ${extra}></label>`
const summary = r => `${kinds[r.kind] || 'Shipment'} · ${r.carrier || 'Method not recorded'} · ${r.tracking_number || 'No reference'}`
function requestId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const bytes=globalThis.crypto.getRandomValues(new Uint8Array(24))
    return 'shipment-'+Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('')
  }
  throw new Error('This browser cannot create a secure save reference. Use a current browser over HTTPS or localhost; your draft is kept.')
}

export function shipmentRows(data) {
  return data.records.length ? `<div class="shipment-list">${data.records.map(r => `<article class="shipment-row">
    <div class="shipment-heading"><strong>${esc(summary(r))}</strong><span class="tag ${r.status === 'void' ? '' : r.dispatched_on ? 'green' : ''}">${r.status === 'void' ? 'Voided' : r.dispatched_on ? 'Dispatch recorded' : 'Reference recorded'}</span></div>
    <p class="dim">${r.job_id ? `Job #${r.job_id}` : 'Order-level record · no job assigned'}${r.created_at ? ` · recorded ${esc(r.created_at)}` : ' · original date unknown'}${r.created_by ? ` by ${esc(r.created_by)}` : ''}${r.dispatched_on ? ` · dispatched / collected ${esc(r.dispatched_on)}` : ''}</p>
    ${r.note ? `<p>${esc(r.note)}</p>` : ''}${r.kind === 'legacy_unspecified' ? '<p class="dim">Imported from the previous tracking records. Matching entries may describe the same parcel; review them before counting shipments.</p>' : ''}
    ${r.shipping_address ? `<details><summary>Dispatch address</summary><p class="shipment-address">${esc(r.shipping_address)}</p></details>` : ''}
    ${r.history?.length ? `<details><summary>Record history (${r.history.length})</summary>${r.history.map(h => `<p>${esc(h.created_at)} · ${esc(h.actor)} · ${esc(h.action)}${h.reason ? ' · '+esc(h.reason) : ''}${h.before ? `<br>Before: ${esc(summary(h.before))}` : ''}<br>After: ${esc(summary(h.after))}${h.after.status === 'void' ? ' · voided' : ''}</p>`).join('')}</details>` : ''}
    ${r.can_correct && r.status !== 'void' ? `<button class="btn ghost" type="button" data-correct-shipment="${r.id}">Correct record</button>` : ''}
  </article>`).join('')}</div>` : '<p class="dim">No shipment recorded. Add each parcel, pickup or local delivery below.</p>'
}

// Drafts and ambiguous retries stay with their order/job for this signed-in browser session.
// A reload can lose unsent drafts; committed records and request receipts stay on the server.
export async function mountShipments(element, options) {
  if (!element) return
  if (owner !== window.__me) { owner=window.__me; states=new Map() }
  const who=owner, mount=++sequence
  let state=states.get(options.key)
  if (!state) { state={drafts:new Map(),mode:'new',pending:null,busy:false,message:'',error:false,data:null}; states.set(options.key,state) }
  state.mount=mount
  const current=()=>element.isConnected && owner===who && state.mount===mount
  const draft=()=>({...emptyDraft(),...state.drafts.get(state.mode)})
  const capture=()=>{
    const form=element.querySelector('[data-shipment-form]')
    if (!form || state.pending) return
    state.drafts.set(state.mode,Object.fromEntries(new FormData(form)))
  }
  const refresh=async()=>{
    capture()
    const request=state.loadSeq=(state.loadSeq || 0)+1
    try {
      const data=await options.load()
      if (!current() || request!==state.loadSeq) return
      capture()
      state.data=data; render()
    } catch(e) {
      if (!current() || request!==state.loadSeq) return
      state.message=e.message;state.error=true
      if (state.data) render()
      else element.innerHTML='<p role="alert">'+esc(e.message)+'</p><button class="btn ghost" type="button" data-retry-load>Retry loading</button>'
      const retry=element.querySelector('[data-retry-load]'); if (retry) retry.onclick=refresh
    }
  }
  state.notify=(reset=false)=>{ if (current()) { if(reset) render(); return refresh() } }
  function render() {
    if (!current()) return
    const data=state.data, d=draft(), editing=state.mode==='new' ? null : data.records.find(r=>String(r.id)===state.mode)
    const scopes=data.scopes || [], editable=scopes.filter(s=>s.can_record)
    const selected=scopes.find(s=>s.scope===d.scope) || (editable.length===1 ? editable[0] : null)
    const showForm=!!editing || editable.length>0 || !!state.pending
    const disabled=state.busy || !!state.pending
    element.innerHTML=`<div class="shipment-panel">${shipmentRows(data)}
      <p class="dim">Recording tracking does not move the order, complete tasks or confirm delivery. Use the carrier’s service for delivery updates.</p>
      ${showForm ? `<form data-shipment-form>
        <h3>${editing ? 'Correct shipment record' : 'Add shipment or pickup'}</h3>
        <fieldset ${disabled?'disabled':''}><div class="shipment-fields">
        ${!editing ? `<label class="field">Production job<select class="input" name="scope" required ${editable.length===1?'aria-label="Production job"':''}><option value="">Choose a job</option>${scopes.map(s=>`<option value="${esc(s.scope)}" ${selected?.scope===s.scope?'selected':''} ${s.can_record?'':'disabled'}>${esc(s.title)}${s.can_record?'':' — '+esc(s.blocked)}</option>`).join('')}</select></label>` : ''}
        <label class="field">Delivery method<select class="input" name="kind">${Object.entries(kinds).filter(([k])=>k!=='legacy_unspecified'||d.kind===k).map(([k,v])=>`<option value="${k}" ${d.kind===k?'selected':''}>${esc(v)}</option>`).join('')}</select></label>
        ${field('Carrier / pickup method','carrier',d.carrier,'maxlength="60"')}${field('Tracking / collection reference','tracking_number',d.tracking_number,`maxlength="100" ${d.void?'':'required'}`)}
        ${field('Dispatch / collection date (optional)','dispatched_on',d.dispatched_on,'type="date"')}${field('Note (optional)','note',d.note,'maxlength="1000"')}
        ${editing ? field('Reason for correction','reason',d.reason,'maxlength="500" required')+`<label class="shipment-void"><input type="checkbox" name="void" ${d.void?'checked':''}> Void this record; retain its history</label>` : ''}
        </div></fieldset>
        <p class="shipment-feedback ${state.error?'shipment-error':''}" role="${state.error?'alert':'status'}">${esc(state.message)}</p>
        <div class="shipment-actions"><button class="btn" type="submit" ${state.busy?'disabled':''}>${state.busy?'Saving…':state.pending?'Retry same save':editing?'Save correction':'Record shipment'}</button>
        ${!state.pending ? '<button class="btn ghost" type="button" data-refresh-shipping>Refresh records</button>' : ''}
        ${editing&&!state.pending?'<button class="btn ghost" type="button" data-new-shipment>Back to new shipment</button>':''}</div>
      </form>` : `<p role="status">${esc(scopes.map(s=>s.blocked).filter(Boolean).join(' ') || 'No shipping task is available to you.')}</p><button class="btn ghost" type="button" data-refresh-shipping>Refresh records</button>`}
    </div>`
    const form=element.querySelector('[data-shipment-form]')
    if (form) {
      form.oninput=capture
      form.onchange=event=>{capture();if(event.target?.name==='void') {render();element.querySelector('[name="void"]')?.focus()}}
      form.onsubmit=submit
    }
    element.querySelector('[data-refresh-shipping]')?.addEventListener('click',refresh)
    element.querySelector('[data-new-shipment]')?.addEventListener('click',()=>{capture();state.mode='new';state.message='';render()})
    for (const button of element.querySelectorAll('[data-correct-shipment]')) {
      button.disabled=disabled
      button.onclick=()=>{
        capture(); const r=data.records.find(r=>String(r.id)===button.dataset.correctShipment)
        state.mode=String(r.id)
        if (!state.drafts.has(state.mode)) state.drafts.set(state.mode,{...emptyDraft(),...r,reason:''})
        state.message='The previous entry stays in history.';state.error=false;render()
        element.querySelector('[name="reason"]')?.focus()
      }
    }
  }
  async function submit(event) {
    event.preventDefault()
    if (state.busy || !current()) return
    capture()
    if (!state.pending) {
      const d=draft(), record=state.mode==='new'?null:state.data.records.find(r=>String(r.id)===state.mode)
      const scope=state.data.scopes.find(s=>s.scope===(record?.scope || d.scope))
      // A legacy order-level record may have no editable job scope. Managers correct it in place.
      if (!record && !scope?.can_record) { state.message='Choose an available production job.';state.error=true;render();return }
      let token
      try { token=requestId() } catch(e) {state.message=e.message;state.error=true;render();return}
      const body={kind:d.kind,carrier:d.carrier||'',tracking_number:d.tracking_number||'',note:d.note||'',dispatched_on:d.dispatched_on||'',
        request_id:token,shipping_revision:record?.shipping_revision ?? scope.shipping_revision,
        production_revision:scope?.production_revision ?? null,job_id:scope?.job_id ?? null }
      if (record) { body.record_revision=record.revision;body.reason=d.reason||'' }
      state.pending={url:record?`/api/shipping/${record.id}/${d.void?'void':'correct'}`:options.endpoint,body,mode:state.mode}
    }
    state.busy=true;state.message='Saving shipment record…';state.error=false;render()
    try {
      await api.post(state.pending.url,state.pending.body)
      const completed=state.pending.mode
      state.pending=null;state.busy=false;state.drafts.delete(completed);state.mode='new';state.message='Shipment record saved.';state.error=false
      await state.notify?.(true)
      if (current()) options.onChange?.()
    } catch(e) {
      state.busy=false;state.error=true
      if (e.status>=400 && e.status<500) { state.pending=null;state.message=e.message+' Your draft is kept. Refresh records before retrying.' }
      else state.message='Save outcome unknown. Retry the same save to check its recorded result. '+e.message
      if (current()) render()
      else state.notify?.()
    }
  }
  element.innerHTML='<p role="status">Loading shipment records…</p>'
  if (options.initial) { state.data=options.initial;render() }
  else await refresh()
}
