import crypto from 'node:crypto'
import { all, get, run, now } from './db.mjs'

export function initPaymentAttempts() {
  run(`CREATE TABLE IF NOT EXISTS payment_attempts (
    reference TEXT PRIMARY KEY, provider TEXT NOT NULL, invoice_id INTEGER, estimate_id INTEGER,
    amount_cents INTEGER NOT NULL, currency TEXT NOT NULL, kind TEXT NOT NULL,
    session_id TEXT, checkout_token TEXT, checkout_url TEXT, return_url TEXT,
    is_test INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', error TEXT, created_at TEXT NOT NULL,
    paid_at TEXT, transaction_id TEXT
  )`)
  run('CREATE UNIQUE INDEX IF NOT EXISTS idx_attempt_session ON payment_attempts(provider,session_id) WHERE session_id IS NOT NULL')
}
export function newPaymentAttempt({provider,invoiceId,estimateId,amountCents,currency,kind,returnUrl,isTest=false}) {
  initPaymentAttempts()
  if(!invoiceId && !estimateId) throw new Error('A checkout must belong to an invoice or estimate')
  if(!Number.isSafeInteger(amountCents) || amountCents<=0) throw new Error('Invalid checkout total')
  const reference=crypto.randomBytes(15).toString('base64url')
  run('INSERT INTO payment_attempts (reference,provider,invoice_id,estimate_id,amount_cents,currency,kind,return_url,created_at,is_test) VALUES (?,?,?,?,?,?,?,?,?,?)',reference,provider,invoiceId || null,estimateId || null,amountCents,currency,kind || 'balance',returnUrl,now(),isTest ? 1 : 0)
  return paymentAttempt(reference)
}
export function paymentAttempt(reference) { initPaymentAttempts(); return get('SELECT * FROM payment_attempts WHERE reference=?',String(reference || '')) }
export function attemptBySession(provider,id) { initPaymentAttempts(); return get('SELECT * FROM payment_attempts WHERE provider=? AND session_id=?',provider,String(id || '')) }
export function readyAttempt(ref,{id=null,url=null,token=null}) { run('UPDATE payment_attempts SET session_id=?,checkout_url=?,checkout_token=? WHERE reference=?',id,url,token,ref) }
export function failAttempt(ref,error) { run('UPDATE payment_attempts SET error=? WHERE reference=?',String(error).slice(0,200),ref) }
export function completeAttempt(ref,transactionId,invoiceId,isTest=false) {
  run("UPDATE payment_attempts SET status=?,paid_at=?,transaction_id=?,invoice_id=?,checkout_token=NULL,error=NULL WHERE reference=?",isTest ? 'test_paid' : 'paid',now(),transactionId,invoiceId,ref)
}
export function recentAttempts() { initPaymentAttempts();return all('SELECT reference,provider,invoice_id,estimate_id,amount_cents,currency,kind,is_test,status,error,created_at,paid_at,transaction_id FROM payment_attempts ORDER BY created_at DESC LIMIT 30') }
