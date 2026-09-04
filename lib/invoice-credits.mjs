import {all,get,run,tx,now,round2,syncInvoiceStatus,logActivity,getSettings} from './db.mjs'
import {currencyCode} from './payment-currency.mjs'

const cents=n=>Math.round(Number(n)*100)
export function invoiceCreditSummary(inv) {
  const credits=all('SELECT * FROM invoice_credits WHERE invoice_id=? ORDER BY created_at,reference',inv.id)
  const base=inv.credit_base?JSON.parse(inv.credit_base):null
  return {credits,credit_base:base,credit_total:round2(credits.filter(c=>!c.cancelled_at).reduce((n,c)=>n+c.subtotal_cents+c.tax_cents,0)/100)}
}
function validAmount(value) {
  if(typeof value!=='number' && !(typeof value==='string' && /^\d+(\.\d{1,2})?$/.test(value))) throw new Error('Credit amounts must be non-negative numbers with at most two decimals')
  const n=Number(value),c=cents(n)
  if(!Number.isSafeInteger(c) || n<0 || Math.abs(n*100-c)>0.000001) throw new Error('Credit amounts must be non-negative numbers with at most two decimals')
  return c
}
export function addInvoiceCredit(invoiceId,{reference,subtotal,tax=0,reason}) {
  if(typeof reference!=='string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(reference))throw new Error('A unique credit reference is required')
  if(typeof reason!=='string' || !reason.trim() || reason.trim().length>500)throw new Error('Explain this credit in 1–500 characters')
  reason=reason.trim()
  const sub=validAmount(subtotal),taxCents=validAmount(tax)
  if(sub+taxCents<=0)throw new Error('Credit must be greater than zero')
  return tx(()=>{
    const inv=get('SELECT * FROM invoices WHERE id=?',invoiceId)
    if(!inv || inv.status==='void')throw new Error('Select an active invoice')
    const old=get('SELECT * FROM invoice_credits WHERE reference=?',reference)
    if(old) {
      if(old.invoice_id!==invoiceId || old.subtotal_cents!==sub || old.tax_cents!==taxCents || old.reason!==reason)throw new Error('Credit reference was already used for different details')
      return {ok:true,duplicate:true,invoice:inv}
    }
    const {credit_base,credits}=invoiceCreditSummary(inv),currency=currencyCode(getSettings().currency)
    const est=inv.estimate_id?get('SELECT subtotal,tax,total FROM estimates WHERE id=?',inv.estimate_id):null
    // Unknown historical tax is not guessed. Imported documents without a reconciled breakdown
    // accept a total allowance; tax-specific bookkeeping must be handled outside this ledger.
    const known=est && cents(est.subtotal)+cents(est.tax)===cents(inv.amount_due)
    const base=credit_base || {amount_due:inv.amount_due,subtotal:known?est.subtotal:inv.amount_due,tax:known?est.tax:0,tax_known:!!known,currency}
    if(base.currency!==currency)throw new Error('Invoice currency changed; reconcile this credit before continuing')
    if(!base.tax_known && taxCents)throw new Error('Original tax breakdown is unavailable; do not guess a tax adjustment')
    const active=credits.filter(c=>!c.cancelled_at)
    if(sub+active.reduce((n,c)=>n+c.subtotal_cents,0)>cents(base.subtotal) || taxCents+active.reduce((n,c)=>n+c.tax_cents,0)>cents(base.tax))throw new Error('Credits exceed the original subtotal or tax')
    run('INSERT INTO invoice_credits(reference,invoice_id,subtotal_cents,tax_cents,reason,currency,created_at) VALUES (?,?,?,?,?,?,?)',reference,invoiceId,sub,taxCents,reason,currency,now())
    run('UPDATE invoices SET credit_base=? WHERE id=?',JSON.stringify(base),invoiceId)
    return recalculate(invoiceId,`Credit ${reference}: ${round2((sub+taxCents)/100)} ${currency} — ${reason}`)
  })
}
export function cancelInvoiceCredit(invoiceId,reference,reason) {
  if(typeof reason!=='string' || !reason.trim() || reason.length>500)throw new Error('Explain why the credit is being canceled (1–500 characters)')
  return tx(()=>{
    const inv=get('SELECT * FROM invoices WHERE id=?',invoiceId),c=get('SELECT * FROM invoice_credits WHERE reference=? AND invoice_id=?',reference,invoiceId)
    if(!inv || !c || inv.status==='void')throw new Error('Active invoice credit not found')
    if(c.cancelled_at)return {ok:true,duplicate:true,invoice:inv}
    run('UPDATE invoice_credits SET cancelled_at=?,cancel_reason=? WHERE reference=?',now(),reason.trim(),reference)
    return recalculate(invoiceId,`Credit ${reference} canceled — ${reason.trim()}`)
  })
}
function recalculate(id,message) {
  const inv=get('SELECT * FROM invoices WHERE id=?',id),{credit_base,credit_total}=invoiceCreditSummary(inv)
  run('UPDATE invoices SET amount_due=?,payment_review=? WHERE id=?',round2(credit_base.amount_due-credit_total),'Invoice credit changed. Verify the remaining balance before resuming collections.',id)
  run('UPDATE email_log SET payment_stale=1 WHERE invoice_id=? AND delivered=0',id)
  const updated=syncInvoiceStatus(id)
  logActivity('invoice',`${inv.invoice_number}: ${message}. No money moved; collections paused.`,{contact_id:inv.contact_id})
  return {ok:true,invoice:updated}
}
