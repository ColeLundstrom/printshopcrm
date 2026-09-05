import { api, $, esc, modal, closeModal, formData, toast } from '../core.js'

export function billingFields(value={}) {
  return `<fieldset><legend>Accounts payable</legend><div class="field"><label for="billing-mode">Invoice emails</label><select class="input" id="billing-mode" name="billing_mode">
    ${[['buyer','Same as buyer'],['custom','Separate accounts payable'],['none','No billing email']].map(([key,label])=>`<option value="${key}" ${value.billing_mode===key || (!value.billing_mode && key==='buyer')?'selected':''}>${label}</option>`).join('')}</select></div>
    <div data-ap-fields><div class="field"><label for="billing-name">AP name</label><input class="input" id="billing-name" name="billing_name" maxlength="200" value="${esc(value.billing_name || '')}"></div>
    <div class="field"><label for="billing-email">AP email</label><input class="input" id="billing-email" name="billing_email" type="email" maxlength="254" value="${esc(value.billing_email || '')}"></div></div></fieldset>`
}
export function bindBillingFields(root) {
  const mode=$('#billing-mode',root),fields=$('[data-ap-fields]',root)
  if(!mode)return
  const paint=()=>{fields.hidden=mode.value!=='custom'}
  mode.onchange=paint;paint()
}
export function recipientsPanel(doc,type,canEdit) {
  let s;try{s=JSON.parse(doc.recipient_snapshot)}catch{s={}}
  return `<section class="card card-b" id="document-recipients"><div class="row"><h3>Delivery contacts</h3>${canEdit?'<button class="btn ghost sm" id="edit-recipients">Edit recipients</button>':''}</div>
    <p><strong>Buyer / quote approval:</strong> ${esc(s?.buyer_name || '—')} · ${esc(s?.buyer_email || 'No email saved')}</p>
    <p><strong>Invoice emails:</strong> ${s?.billing_mode==='none'?'Disabled':`${esc(s?.billing_name || '—')} · ${esc(s?.billing_email || 'No email saved')}`}</p>
    <p class="dim">${type==='invoice'?'Invoice, payment-link and reminder emails use the saved billing contact.':'Quote emails use the saved buyer. An invoice inherits these delivery contacts.'} Customer default changes apply to new documents.</p>
    ${doc.recipient_source==='legacy_migration'?'<p class="dim">Saved from the customer details known at upgrade; earlier exact recipients are unknown.</p>':''}</section>`
}
export function bindRecipientEditor(doc,type,after) {
  const button=$('#edit-recipients');if(!button)return
  button.onclick=()=>{
    const hash=location.hash
    let s;try{s=JSON.parse(doc.recipient_snapshot)}catch{s={}}
    modal({title:'Delivery contacts',body:`${type==='estimate'?`<p class="dim">Changing the buyer name or email saves a new draft and expires its old approval link.</p><div class="field"><label for="buyer-name">Buyer name</label><input class="input" id="buyer-name" name="buyer_name" maxlength="200" value="${esc(s.buyer_name || '')}"></div><div class="field"><label for="buyer-email">Buyer email</label><input class="input" id="buyer-email" name="buyer_email" type="email" maxlength="254" value="${esc(s.buyer_email || '')}"></div>`:''}${billingFields(s)}<p class="dim">This edits only this document. Previous unsent messages will need to be recreated. A blank AP email does not fall back to the buyer.</p>`,
      footer:'<button class="btn ghost" data-close>Cancel</button><button class="btn ghost" id="recipient-defaults">Use customer defaults</button><button class="btn" id="recipient-save">Save recipients</button>',onMount:root=>{
        bindBillingFields(root)
        let saving=false
        const buttons=[$('#recipient-save',root),$('#recipient-defaults',root)]
        const current=()=>root.isConnected && button.isConnected && $('#edit-recipients')===button && location.hash===hash
        const save=async(useDefaults=false)=>{
          if(saving || !current())return
          const payload={...(useDefaults?{use_customer_defaults:true}:formData(root)),recipient_revision:doc.recipient_revision}
          const fields=[...root.querySelectorAll('input,select,textarea')].map(field=>[field,field.disabled])
          saving=true;buttons.forEach(b=>{b.disabled=true})
          fields.forEach(([field])=>{field.disabled=true})
          try {
            await api.put(`/api/${type==='invoice'?'invoices':'estimates'}/${doc.id}/recipients`,payload)
            if(!current())return
            closeModal();toast('Delivery contacts saved. Create fresh messages for any unsent drafts.');await after()
          } catch(e) {if(current())toast(e.message,true)}
          finally {saving=false;if(current()){buttons.forEach(b=>{b.disabled=false});fields.forEach(([field,disabled])=>{field.disabled=disabled})}}
        }
        buttons[0].onclick=()=>save();buttons[1].onclick=()=>save(true)
      }})
  }
}
