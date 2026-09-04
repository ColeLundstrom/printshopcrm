import crypto from 'node:crypto'
import { all, get, run, tx, now } from './db.mjs'

// Twilio form signature: exact configured URL + all sorted POST fields.
// Unknown fields participate, so additions by Twilio do not weaken verification.
export function verifyTwilio({ token, url, params, signature }) {
  if (!token || !url || !signature || !params || Object.values(params).some(v => typeof v !== 'string')) return false
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join('')
  const expected = crypto.createHmac('sha1',token).update(data).digest('base64')
  const a=Buffer.from(expected), b=Buffer.from(String(signature))
  return a.length === b.length && crypto.timingSafeEqual(a,b)
}
export const phoneKey = v => {
  const n=String(v || '').replace(/\D/g,'')
  return n.length === 10 ? '1'+n : n
}

// Receipt and inbox write commit together. Twilio retries and process restarts cannot duplicate it.
// Never invoke an AI engine, send a response, or start a marketing automation from an inbound text.
export function ingestSms(p) {
  if (!/^SM[a-f0-9]{32}$/i.test(p.MessageSid || '') || !/^\+[1-9]\d{6,14}$/.test(p.From || '')) {
    const e=new Error('Invalid message identity or sender'); e.status=400; throw e
  }
  const body=String(p.Body || '').slice(0,16000)
  const media=Math.min(10, Math.max(0, Number(p.NumMedia) || 0))
  if (!body.trim() && !media) { const e=new Error('Empty message');e.status=400;throw e }
  // Additive table, initialized on first webhook only; old database records are untouched.
  run('CREATE TABLE IF NOT EXISTS inbound_sms_receipts (sid TEXT PRIMARY KEY, contact_id INTEGER NOT NULL, received_at TEXT NOT NULL)')
  return tx(() => {
    const old=get('SELECT contact_id FROM inbound_sms_receipts WHERE sid=?',p.MessageSid)
    if(old) return { contact_id:old.contact_id, duplicate:true }
    const matches=all("SELECT id, phone FROM contacts WHERE phone != ''").filter(c=>phoneKey(c.phone)===phoneKey(p.From))
    // Ambiguous legacy phone matches must not put a private message on an arbitrary customer.
    let contact_id=matches.length === 1 ? matches[0].id : null
    if(!contact_id) contact_id=Number(run('INSERT INTO contacts (name,phone,notes,created_at,updated_at) VALUES (?,?,?,?,?)',p.From,p.From,matches.length ? 'Incoming SMS: multiple existing contacts share this phone. Review before merging.' : 'Created from an incoming SMS.',now(),now()).lastInsertRowid)
    const content=body+(media ? `\n[${media} MMS attachment(s) received. Attachments are available in Twilio; not downloaded here.]` : '')
    run('INSERT INTO messages (contact_id,direction,channel,subject,body,kind,read,created_at) VALUES (?,?,?,?,?,?,?,?)',contact_id,'in','sms','',content,'inbound',0,now())
    run('INSERT INTO inbound_sms_receipts (sid,contact_id,received_at) VALUES (?,?,?)',p.MessageSid,contact_id,now())
    return {contact_id,duplicate:false}
  })
}
