import crypto from 'node:crypto'
import { all, get, run, tx, now, getSettings } from './db.mjs'
import { initPaymentAttempts, newPaymentAttempt, paymentAttempt, readyAttempt } from './payment-attempts.mjs'

const LEASE_MS=60000, RETRY_MS=2000, REPLAY_MS=23*60*60*1000
const json=value=>JSON.stringify(value)
const digest=value=>crypto.createHash('sha256').update(typeof value==='string'?value:json(value)).digest('hex')
const safeErrors={
  collection_busy:'Payment status is being checked. Wait a moment before trying again.',
  collection_pending:'Another checkout is still open or needs verification. Resume that checkout or ask the shop to check it before paying again.',
  collection_changed:'The invoice or payment connection changed. The shop must check the existing checkout before a new payment request can be opened.',
  collection_account:'Reconnect the original payment account and environment before checking this checkout.',
  collection_review:'This checkout needs payment review. Do not pay again until the shop verifies its outcome.',
  collection_unavailable:'The payment provider could not be verified. The checkout is retained; check its status before trying again.',
  collection_stale:'Payment details changed. Refresh the invoice and confirm the current amount before paying.',
  collection_not_found:'Checkout not found.',
}
export function collectionError(code='collection_review',status=409) { const e=new Error(safeErrors[code] || safeErrors.collection_review);e.code=code;e.status=status;e.expose=true;e.collectionSafe=true;return e }

export function initPaymentCollections() { initPaymentAttempts() }

export function collectionSnapshot({invoiceId,estimateId,currency}) {
  initPaymentCollections()
  const invoice=invoiceId?get('SELECT id,estimate_id,contact_id,amount_due,amount_paid,status,payment_review,recipient_revision,created_at FROM invoices WHERE id=?',invoiceId):null
  if(invoiceId && !invoice) throw collectionError('collection_not_found',404)
  const eid=invoice?.estimate_id || estimateId
  const estimate=eid?get('SELECT id,contact_id,total,commercial_revision,created_at FROM estimates WHERE id=?',eid):null
  if(!invoice && !estimate) throw collectionError('collection_not_found',404)
  const key=invoice?'i:'+invoice.id:'e:'+estimate.id
  return {key,currency,invoice,estimate,revision:get('SELECT revision FROM payment_collection_versions WHERE resource_key=?',key)?.revision || 0}
}
export const collectionSnapshotHash=snapshot=>digest(snapshot)
export function paymentCollection(ref) { initPaymentCollections();return get('SELECT * FROM payment_collections WHERE reference=?',ref) }
const snapshotSame=(a,currency)=>{
  const c=paymentCollection(a.reference)
  return currency===String(getSettings().currency||'USD').toUpperCase() && c && c.snapshot===json(collectionSnapshot({invoiceId:a.invoice_id,estimateId:a.estimate_id,currency}))
}
function relatedPending(invoiceId,estimateId) {
  const eid=estimateId || (invoiceId?get('SELECT estimate_id FROM invoices WHERE id=?',invoiceId)?.estimate_id:null)
  return get(`SELECT a.*,c.state AS collection_state,c.closed_at FROM payment_attempts a LEFT JOIN payment_collections c ON c.reference=a.reference
    WHERE ((? IS NOT NULL AND a.invoice_id=?) OR (? IS NOT NULL AND a.estimate_id=?) OR (? IS NOT NULL AND a.invoice_id IN(SELECT id FROM invoices WHERE estimate_id=?)))
    AND ((c.reference IS NOT NULL AND c.closed_at IS NULL) OR (c.reference IS NULL AND a.status='pending')) ORDER BY a.created_at,a.reference LIMIT 1`,
    invoiceId||null,invoiceId||null,eid||null,eid||null,eid||null,eid||null)
}
export function invoiceCollectionHold(invoiceId) {
  initPaymentCollections()
  return !!relatedPending(invoiceId,null) || !!get("SELECT id FROM payment_collection_receipts WHERE invoice_id=? AND state='review' LIMIT 1",invoiceId)
}

function claim(ref,revision) {
  return tx(()=>{
    const c=paymentCollection(ref)
    if(!c) throw collectionError('collection_not_found',404)
    if(revision!==undefined && (!Number.isSafeInteger(revision) || revision!==c.revision)) throw collectionError('collection_stale')
    if(c.claim_until>Date.now() || c.next_retry_at>Date.now()) throw collectionError('collection_busy')
    if(c.closed_at) throw collectionError('collection_review')
    const token=crypto.randomBytes(24).toString('base64url')
    run('UPDATE payment_collections SET claim_token=?,claim_until=?,revision=revision+1,updated_at=? WHERE reference=?',token,Date.now()+LEASE_MS,now(),ref)
    return {...paymentCollection(ref),claim_token:token}
  })
}
function owns(c) { if(paymentCollection(c.reference)?.claim_token!==c.claim_token) throw collectionError('collection_busy');return true }
function release(c,{state,error=null,closed=false}={}) {
  run(`UPDATE payment_collections SET state=COALESCE(?,state),error_code=?,claim_token=NULL,claim_until=0,next_retry_at=?,
    revision=revision+1,updated_at=?,closed_at=CASE WHEN ? THEN ? ELSE closed_at END WHERE reference=? AND claim_token=?`,
    state||null,error,error?Date.now()+RETRY_MS:0,now(),closed?1:0,now(),c.reference,c.claim_token)
}
async function bindAccount(c,client) {
  const account=await client.account()
  if(!account?.account_id || typeof account.is_test!=='boolean' || account.is_test!==!!c.is_test) throw collectionError('collection_account')
  owns(c)
  if(c.account_id && (c.account_id!==account.account_id || (c.destination||null)!==(account.destination||null))) throw collectionError('collection_account')
  if(!c.account_id) {
    run('UPDATE payment_collections SET account_id=?,destination=? WHERE reference=? AND claim_token=?',account.account_id,account.destination||null,c.reference,c.claim_token)
    c.account_id=account.account_id;c.destination=account.destination||null
  }
  return account
}
function verifySession(a,c,session,{money=true}={}) {
  if(!session || !!session.test!==!!a.is_test) throw collectionError('collection_account')
  if(a.provider!=='authorize_net') {
    if(session.mode!=='payment' || session.metadata?.checkout_ref!==a.reference || session.metadata?.collection_version!=='1'
      || (a.session_id && session.id!==a.session_id)) throw collectionError('collection_review')
    const expected=new URLSearchParams(c.request_body)
    for(const key of ['slug','invoice','estimate','kind','currency']) {
      const value=expected.get(`metadata[${key}]`)
      if(value!==null && session.metadata?.[key]!==value) throw collectionError('collection_review')
    }
    if(a.provider==='stripe_connect' && session.paid && (session.destination!==c.destination || session.onBehalfOf!==c.destination)) throw collectionError('collection_account')
  }
  if(money && (session.currency!==a.currency || session.amountCents!==a.amount_cents)) throw collectionError('collection_review')
}

/** Reserve synchronously before any provider I/O. A retry must keep the exact original body. */
export function reserveCollection({client,invoiceId,estimateId,amountCents,currency,kind,returnUrl,buildRequest}) {
  initPaymentCollections()
  return tx(()=>{
    const snapshot=collectionSnapshot({invoiceId,estimateId,currency})
    if(snapshot.invoice && (snapshot.invoice.status==='void' || snapshot.invoice.payment_review || snapshot.invoice.amount_due<=snapshot.invoice.amount_paid)) throw collectionError('collection_changed')
    const pending=relatedPending(invoiceId,estimateId)
    if(pending) {
      const c=paymentCollection(pending.reference)
      if(!c || pending.provider!==client.provider || !!pending.is_test!==client.isTest || pending.amount_cents!==amountCents || pending.kind!==kind || pending.currency!==currency || c.snapshot!==json(snapshot)) throw collectionError('collection_pending')
      return pending
    }
    const a=newPaymentAttempt({provider:client.provider,invoiceId,estimateId,amountCents,currency,kind,returnUrl,isTest:client.isTest})
    const body=buildRequest(a)
    if(typeof body!=='string' || Buffer.byteLength(body)>64*1024) throw collectionError('collection_review')
    run('INSERT INTO payment_collections(reference,resource_key,snapshot,request_body,is_test,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',a.reference,snapshot.key,json(snapshot),body,client.isTest?1:0,now(),now())
    return a
  })
}

export async function resumeCollection({reference,revision,client}) {
  const c=claim(reference,revision),a=paymentAttempt(reference)
  try {
    if(a.provider!==client.provider) throw collectionError('collection_account')
    const account=await bindAccount(c,client)
    if(!client.matchesSettings(getSettings()) || !snapshotSame(a,a.currency)) throw collectionError('collection_changed')
    let session
    if(a.provider==='authorize_net') {
      if(a.checkout_token) {
        if(Date.now()-Date.parse(a.created_at+'Z')>=14*60000) throw collectionError('collection_review')
        session={id:a.reference,url:a.checkout_url,token:a.checkout_token,paid:false,test:!!a.is_test,currency:a.currency}
      } else {
        if(c.submitted_at) throw collectionError('collection_review')
        run('UPDATE payment_collections SET submitted_at=? WHERE reference=? AND claim_token=?',Date.now(),reference,c.claim_token)
        session=await client.create({requestBody:c.request_body,idempotencyKey:a.reference})
      }
    } else if(a.session_id) session=await client.retrieve(a.session_id)
    else {
      if(c.submitted_at && Date.now()-c.submitted_at>=REPLAY_MS) throw collectionError('collection_review')
      if(!c.submitted_at) run('UPDATE payment_collections SET submitted_at=? WHERE reference=? AND claim_token=?',Date.now(),reference,c.claim_token)
      session=await client.create({requestBody:c.request_body,idempotencyKey:a.reference})
    }
    owns(c)
    // Preserve a compact observation without allowing foreign/malformed provider identities to
    // replace the canonical checkout. Never store a token, raw body or customer data here.
    run('UPDATE payment_collections SET response_evidence=? WHERE reference=? AND claim_token=?',json({id:session.id,status:session.status,currency:session.currency,amount_cents:session.amountCents,reference:session.metadata?.checkout_ref}),reference,c.claim_token)
    if(a.provider!=='authorize_net') verifySession(a,c,session,{money:!session.paid})
    if(!client.matchesSettings(getSettings())) throw collectionError('collection_account')
    if(a.provider==='authorize_net') readyAttempt(reference,{token:session.token,url:session.url})
    else if(session.currency===a.currency && session.amountCents===a.amount_cents) readyAttempt(reference,{id:session.id,url:session.url})
    // Paid provider evidence must reach the receipt recorder even after a concurrent invoice edit.
    if(session.paid) {release(c,{state:'verifying'});return {session,account}}
    if(!snapshotSame(a,a.currency)) throw collectionError('collection_changed')
    if(session.status==='expired') { release(c,{state:'expired',closed:true});run("UPDATE payment_attempts SET status='expired' WHERE reference=?",reference);return {session,account,expired:true} }
    release(c,{state:session.paid?'verifying':'open'})
    return {session,account,url:a.provider==='authorize_net'?null:session.url}
  } catch(e) {
    release(c,{state:'review',error:e.collectionSafe?e.code:'collection_unavailable'})
    throw e.collectionSafe?e:collectionError('collection_unavailable',503)
  }
}

export async function checkCollection({reference,revision,client,transactionId,sessionId,expire=false}) {
  const c=claim(reference,revision),a=paymentAttempt(reference)
  try {
    if(a.provider!==client.provider) throw collectionError('collection_account')
    const account=await bindAccount(c,client)
    const session=a.provider==='authorize_net'?await client.retrieveTransaction(transactionId):await client.retrieve(a.session_id || sessionId)
    owns(c)
    if(a.provider==='authorize_net') { if(session.reference!==a.reference || !!session.test!==!!a.is_test) throw collectionError('collection_account') }
    else verifySession(a,c,session,{money:!session.paid})
    if(!client.matchesSettings(getSettings())) throw collectionError('collection_account')
    let final=session
    if(expire) {
      if(a.provider==='authorize_net') throw collectionError('collection_review')
      if(!session.paid && session.status==='open') final=await client.expire({sessionId:a.session_id,idempotencyKey:a.reference+'_expire'})
      owns(c);verifySession(a,c,final,{money:!final.paid})
      if(!client.matchesSettings(getSettings())) throw collectionError('collection_account')
    }
    if(a.provider!=='authorize_net' && !a.session_id && final.currency===a.currency && final.amountCents===a.amount_cents) readyAttempt(reference,{id:final.id,url:final.url})
    if(final.status==='expired' && !final.paid) { release(c,{state:'expired',closed:true});run("UPDATE payment_attempts SET status='expired' WHERE reference=?",reference) }
    else release(c,{state:final.paid?'verifying':'open'})
    return {session:final,account}
  } catch(e) {
    release(c,{state:'review',error:e.collectionSafe?e.code:'collection_unavailable'})
    throw e.collectionSafe?e:collectionError('collection_unavailable',503)
  }
}

export function finishCollection(reference,state='paid') {
  initPaymentCollections()
  run('UPDATE payment_collections SET state=?,closed_at=?,claim_token=NULL,claim_until=0,next_retry_at=0,error_code=NULL,revision=revision+1,updated_at=? WHERE reference=?',state,now(),now(),reference)
}
export function verifyCollectionPayment(a,session,account) {
  const c=paymentCollection(a.reference)
  if(!c) return // Historical attempts retain their historical verification path.
  if(account?.account_id!==c.account_id || !!account?.is_test!==!!c.is_test || (account?.destination||null)!==(c.destination||null)) throw collectionError('collection_account')
  verifySession(a,c,session)
}

/** Persist provider evidence independently of applying it; rollback must not erase real money. */
export function receiveCollectionPayment({attempt,provider,account,session,transactionId,reference}) {
  initPaymentCollections()
  if(!session.paid || !account?.account_id || typeof account.is_test!=='boolean' || typeof session.test!=='boolean' || account.is_test!==session.test
    || !Number.isSafeInteger(session.amountCents) || session.amountCents<=0 || !/^[A-Za-z0-9_-]{1,150}$/.test(String(transactionId))
    || !/^[A-Z]{3}$/.test(session.currency)) throw collectionError('collection_review')
  const id=digest([provider,account.account_id,account.is_test,transactionId])
  const old=get('SELECT * FROM payment_collection_receipts WHERE id=?',id)
  if(old) {
    if(old.amount_cents!==session.amountCents || old.currency!==session.currency || old.reference!==(attempt?.reference || reference || null)) throw collectionError('collection_review')
    return old
  }
  run(`INSERT INTO payment_collection_receipts(id,reference,provider,account_id,is_test,transaction_id,invoice_id,estimate_id,amount_cents,currency,state,reason,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,'review',?,?,?)`,id,attempt?.reference||reference||null,provider,account.account_id,session.test?1:0,transactionId,attempt?.invoice_id||null,attempt?.estimate_id||null,session.amountCents,session.currency,'Verified payment is awaiting invoice reconciliation.',now(),now())
  return get('SELECT * FROM payment_collection_receipts WHERE id=?',id)
}
export function markCollectionReceipt(id,{invoiceId,state='applied',reason=null}) {
  run('UPDATE payment_collection_receipts SET invoice_id=COALESCE(?,invoice_id),state=?,reason=?,updated_at=? WHERE id=?',invoiceId||null,state,reason,now(),id)
}
export function holdCollectionReceipt(receipt,message='A verified payment needs review. Collections are paused until the shop checks it.') {
  if(!receipt) return
  run("UPDATE payment_collection_receipts SET state='review',reason=?,updated_at=? WHERE id=?",message,now(),receipt.id)
  if(receipt.invoice_id && !receipt.is_test) {
    run('UPDATE invoices SET payment_review=? WHERE id=?',message,receipt.invoice_id)
    run('UPDATE email_log SET payment_stale=1 WHERE invoice_id=? AND delivered=0',receipt.invoice_id)
  }
}

export function publicCollection(reference) {
  const a=paymentAttempt(reference);if(!a)return null
  const c=paymentCollection(reference),busy=c?.claim_until>Date.now() || c?.next_retry_at>Date.now()
  const state=c?.state || (a.status==='pending'?'legacy_review':a.status)
  const unresolved=c?!c.closed_at:a.status==='pending'
  const stripe=['stripe','stripe_connect'].includes(a.provider)
  const replay=!!c && stripe && (!c.submitted_at || Date.now()-c.submitted_at<REPLAY_MS)
  return {reference:a.reference,invoice_id:a.invoice_id,estimate_id:a.estimate_id,provider:a.provider,kind:a.kind,amount_cents:a.amount_cents,currency:a.currency,
    is_test:!!a.is_test,state,revision:c?.revision||0,created_at:a.created_at,updated_at:c?.updated_at||a.created_at,
    message:c?.error_code?safeErrors[c.error_code]||safeErrors.collection_review:state==='legacy_review'?'This older checkout must be verified before a new payment request can be opened.':unresolved?'This checkout reserves the payment request until its outcome is verified.':'Checkout closed.',
    actions:{resume:unresolved && !busy && !!c && (stripe?(!!a.session_id||replay):!!a.checkout_token && Date.now()-Date.parse(a.created_at+'Z')<14*60000),
      recheck:unresolved && !busy,expire:unresolved && !busy && stripe && !!a.session_id},
    requires_transaction_id:a.provider==='authorize_net',requires_session_id:stripe && !a.session_id}
}
export function collectionStatus(invoiceId) {
  initPaymentCollections()
  const filter=invoiceId?'a.invoice_id=?':'1=1',args=invoiceId?[invoiceId]:[]
  const where=`${filter} AND (a.status='pending' OR (c.reference IS NOT NULL AND c.closed_at IS NULL) OR a.reference IN(SELECT reference FROM payment_attempts ORDER BY created_at DESC LIMIT 30))`
  const count=get(`SELECT COUNT(*) AS n FROM payment_attempts a LEFT JOIN payment_collections c ON c.reference=a.reference WHERE ${where}`,...args).n
  const rows=all(`SELECT a.reference FROM payment_attempts a LEFT JOIN payment_collections c ON c.reference=a.reference WHERE ${where} ORDER BY a.created_at DESC LIMIT 300`,...args)
  const receiptWhere="state IN ('review','applied_review')"+(invoiceId?' AND invoice_id=?':'')
  const receiptCount=get(`SELECT COUNT(*) AS n FROM payment_collection_receipts WHERE ${receiptWhere}`,...args).n
  const receipts=all(`SELECT id,reference,invoice_id,estimate_id,provider,transaction_id,amount_cents,currency,is_test,state,reason,created_at FROM payment_collection_receipts WHERE ${receiptWhere} ORDER BY created_at DESC LIMIT 300`,...args)
  return {collections:rows.map(r=>publicCollection(r.reference)),receipts:receipts.map(r=>({...r,is_test:!!r.is_test})),count,has_more:count>rows.length,receipt_count:receiptCount,receipts_have_more:receiptCount>receipts.length}
}
