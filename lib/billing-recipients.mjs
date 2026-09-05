import { oneRecipient } from './notify.mjs'
import { get, run, tx, now, logActivity } from './db.mjs'
import { invalidateEstimateApproval } from './estimate-approvals.mjs'
import { syncFromEstimate } from './pipeline.mjs'

const fail = (message, status=400, code='invalid_recipient') => { throw Object.assign(new Error(message), {status,code,expose:true}) }
const field = (value, label, email=false) => {
  if (typeof value !== 'string' || value.length > (email ? 254 : 200) || /[\u0000-\u001f\u007f]/.test(value)) fail(`${label} must be plain text${email ? ', containing one email address' : ''}.`)
  const out=value.trim()
  if(email && out && !oneRecipient(out)) fail(`${label} must contain one email address, without a list or header.`)
  return out
}
export function billingDefaults(body={},current={}) {
  const mode=body.billing_mode === undefined ? current.billing_mode || 'buyer' : body.billing_mode
  if(!['buyer','custom','none'].includes(mode)) fail('Choose same as buyer, separate accounts payable, or no billing email.')
  return {billing_mode:mode,billing_name:field(body.billing_name === undefined ? current.billing_name || '' : body.billing_name,'Billing name'),
    billing_email:field(body.billing_email === undefined ? current.billing_email || '' : body.billing_email,'Billing email',true)}
}
export function recipientSnapshot(document) {
  let value
  try {value=JSON.parse(document.recipient_snapshot)} catch { fail('This document has no saved recipient. Review its delivery contacts before sending.',409,'recipient_review') }
  if(!value || typeof value!=='object' || Array.isArray(value)) fail('Review the saved document recipients.',409,'recipient_review')
  return value
}
export function snapshotRecipients(buyer,patch={}) {
  const b=billingDefaults(patch,buyer)
  const buyer_name=field(patch.buyer_name === undefined ? buyer.buyer_name ?? buyer.name ?? '' : patch.buyer_name,'Buyer name')
  const buyer_email=field(patch.buyer_email === undefined ? buyer.buyer_email ?? buyer.email ?? '' : patch.buyer_email,'Buyer email',true)
  return {buyer_name,buyer_email,...b,billing_name:b.billing_mode==='buyer'?buyer_name:b.billing_mode==='none'?'':b.billing_name,
    billing_email:b.billing_mode==='buyer'?buyer_email:b.billing_mode==='none'?'':b.billing_email}
}
export function documentRecipient(document,type='invoice') {
  const s=recipientSnapshot(document),billing=type==='invoice'
  const name=billing?s.billing_name:s.buyer_name,email=billing?s.billing_email:s.buyer_email
  return {name:String(name || ''),email:String(email || ''),role:billing?'billing':'buyer',revision:document.recipient_revision || 0,
    blocked:billing && s.billing_mode==='none'?'Billing email is disabled for this invoice.':!oneRecipient(email)?'This document has no valid saved email recipient. Review its delivery contacts.':null}
}
export function documentForRecipient(type,id) {
  if(!['estimate','invoice'].includes(type)) fail('Unknown document type.')
  const row=get(`SELECT * FROM ${type==='invoice'?'invoices':'estimates'} WHERE id=?`,id)
  if(!row) fail('Document not found.',404,'not_found')
  return row
}
export function recipientForContext(ctx) {
  const type=ctx.invoice?.id?'invoice':ctx.estimate?.id?'estimate':null
  if(!type)return null
  const saved=type==='invoice'?ctx.invoice:ctx.estimate,current=documentForRecipient(type,saved.id)
  if((saved.recipient_revision || 0)!==(current.recipient_revision || 0)) fail('Document recipients changed. Review this message and create a fresh one.',409,'recipient_changed')
  const recipient=documentRecipient(current,type)
  if(!Object.hasOwn(saved,'recipient_revision') &&
    (current.recipient_revision!==0 || ctx.contact?.name!==recipient.name || ctx.contact?.email!==recipient.email)) {
    fail('This older sequence has no verified document recipient. Review the delivery contacts and create a fresh message.',409,'recipient_review')
  }
  return recipient
}
export function recipientMessageIssue(row) {
  if(row.kind==='sms')return null
  if(row.recipient_stale)return 'Document recipients changed. Create a fresh message after reviewing its delivery contacts.'
  const type=row.invoice_id?'invoice':row.estimate_id?'estimate':null
  if(!type)return null
  const doc=get(`SELECT * FROM ${type==='invoice'?'invoices':'estimates'} WHERE id=?`,row.invoice_id || row.estimate_id)
  if(!doc)return 'The document for this message no longer exists.'
  if(row.recipient_revision != null && row.recipient_revision!==(doc.recipient_revision || 0))return 'Document recipients changed. Create a fresh message.'
  if(!row.to_email)return 'This document message has no saved recipient. Create a fresh message after reviewing its delivery contacts.'
  return null
}
export function updateDocumentRecipients(type,id,body,actor='') {
  return tx(()=>{
    const doc=documentForRecipient(type,id)
    if(!Number.isSafeInteger(body?.recipient_revision) || body.recipient_revision!==doc.recipient_revision) fail('Document recipients changed. Reload before editing.',409,'recipient_changed')
    if(type==='estimate' && get("SELECT 1 FROM invoices WHERE estimate_id=? AND status!='void'",id)) fail('This quote is invoiced. Edit the invoice delivery contacts.',409,'already_invoiced')
    const before=recipientSnapshot(doc)
    const base=body.use_customer_defaults===true?get('SELECT * FROM contacts WHERE id=?',doc.contact_id):before
    if(!base) fail('Customer no longer exists.',409)
    const next=snapshotRecipients(base,body)
    if(JSON.stringify(before)===JSON.stringify(next))return doc
    const column=type==='invoice'?'invoice_id':'estimate_id'
    if(get(`SELECT 1 FROM email_log WHERE ${column}=? AND sending_at>=datetime('now','-5 minutes') LIMIT 1`,id)) fail('A message for this document is being sent. Wait for its delivery result before changing recipients.',409,'recipient_sending')
    const quoteRevised=type==='estimate' && (before.buyer_name!==next.buyer_name || before.buyer_email!==next.buyer_email)
    if(quoteRevised) invalidateEstimateApproval(doc,doc,{actor,force:true})
    run(`UPDATE ${type==='invoice'?'invoices':'estimates'} SET recipient_snapshot=?,recipient_revision=recipient_revision+1,recipient_source='edited' WHERE id=?`,JSON.stringify(next),id)
    if(quoteRevised) syncFromEstimate(documentForRecipient(type,id),'revised')
    run('INSERT INTO document_recipient_history(document_type,document_id,revision,before_snapshot,after_snapshot,actor,changed_at) VALUES(?,?,?,?,?,?,?)',type,id,doc.recipient_revision,JSON.stringify(before),JSON.stringify(next),String(actor).slice(0,200),now())
    logActivity(type,`Delivery contacts updated for ${doc.invoice_number || doc.estimate_number}; previous unsent messages need review.`,{contact_id:doc.contact_id})
    return documentForRecipient(type,id)
  })
}
