import {all,get,run,now,round2,syncInvoiceStatus,logActivity} from './db.mjs'

// Called inside the caller's synchronous financial transaction, after verifying the provider.
// Keep original payments and append compensating entries; never erase a processor's history.
export function recordReversal({provider,id,kind,attempt,amountCents,status,appliedCents}) {
  if(!['stripe','authorize_net'].includes(provider) || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid reversal identity')
  if(!['refund','void'].includes(kind) || !Number.isSafeInteger(amountCents) || amountCents<=0 || !Number.isSafeInteger(appliedCents) || appliedCents<0 || appliedCents>amountCents) throw new Error('Invalid reversal amount')
  if(amountCents>attempt.amount_cents) throw new Error('Reversal exceeds the original payment')
  const test=!!attempt.is_test, target=test?0:appliedCents
  const old=get('SELECT * FROM payment_reversals WHERE provider=? AND provider_id=?',provider,id)
  if(old && (old.attempt_ref!==attempt.reference || old.kind!==kind || old.amount_cents!==amountCents || !!old.is_test!==test)) throw new Error('Reversal details changed; manual reconciliation required')
  if(old?.status===status && old.applied_cents===target) return {duplicate:true,test,invoice_id:attempt.invoice_id}
  const others=get('SELECT COALESCE(SUM(applied_cents),0) AS n FROM payment_reversals WHERE attempt_ref=? AND NOT (provider=? AND provider_id=?)',attempt.reference,provider,id).n
  if(others+target>attempt.amount_cents) throw new Error('Combined reversals exceed the original payment')
  const revision=(old?.revision || 0)+1, delta=(old?.applied_cents || 0)-target
  const label=provider==='stripe'?'Stripe':'Authorize.net'
  run(`INSERT INTO payment_reversals(provider,provider_id,kind,attempt_ref,invoice_id,amount_cents,status,applied_cents,is_test,revision,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider,provider_id) DO UPDATE SET status=excluded.status,applied_cents=excluded.applied_cents,revision=excluded.revision,updated_at=excluded.updated_at`,
    provider,id,kind,attempt.reference,attempt.invoice_id || null,amountCents,status,target,test?1:0,revision,now(),now())
  if(!test) {
    if(!attempt.invoice_id || !get('SELECT id FROM invoices WHERE id=?',attempt.invoice_id)) throw new Error('Invoice unavailable for reversal')
    if(delta) run('INSERT INTO payments(invoice_id,amount,method,note,stripe_session,created_at) VALUES (?,?,?,?,?,?)',attempt.invoice_id,round2(delta/100),'card',`${label} ${kind} ${id}: ${status}${delta>0?' — returned funds restored':''}`,`reversal:${provider}:${id}:${revision}`,now())
    run('UPDATE invoices SET payment_review=? WHERE id=?',`${label} ${kind} ${id} is ${status}. Review the invoice before requesting another payment.`,attempt.invoice_id)
  run('UPDATE email_log SET payment_stale=1 WHERE invoice_id=? AND delivered=0',attempt.invoice_id)
    syncInvoiceStatus(attempt.invoice_id)
    const inv=get('SELECT * FROM invoices WHERE id=?',attempt.invoice_id)
    logActivity('payment',`${label} ${kind} ${id}: ${status}; ${round2(target/100)} ${attempt.currency} returned. Collections paused on ${inv.invoice_number}.`,{contact_id:inv.contact_id})
  }
  return {changed:true,test,invoice_id:attempt.invoice_id,delta_cents:delta}
}
export function recentReversals() {
  return all('SELECT provider,provider_id,kind,invoice_id,amount_cents,status,applied_cents,is_test,updated_at FROM payment_reversals ORDER BY updated_at DESC,provider_id LIMIT 50')
}
