import { createHash } from 'node:crypto'
import { all, get, run, tx, now } from './db.mjs'
import { STAGE_KEYS } from './pipeline.mjs'
import { oneRecipient, oneDestination } from './notify.mjs'
import { fail, validDay, history, setHold, communicationHold } from './shop-crm.mjs'
const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v==='object' ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])) : v
export const digest = v => createHash('sha256').update(JSON.stringify(stable(v))).digest('hex')
const field = (v,label,max=500) => { if(v==null)return ''; if(typeof v!=='string' || v.length>max)fail(`${label} must be text of at most ${max} characters.`); return v.trim() }
const external = (v,label) => { const s=field(v,label,160); if(!s || /[\x00-\x1f]/.test(s))fail(`${label} is required.`); return s }
const arr = (v,label) => { if(v==null)return []; if(!Array.isArray(v))fail(`${label} must be an array.`); return v }
const table = {contact:'contacts',opportunity:'opportunities',task:'crm_tasks'}
const insertedId = result => { if(Number(result.changes)!==1 || !Number.isSafeInteger(Number(result.lastInsertRowid)) || Number(result.lastInsertRowid)<1) fail('An import write was not saved. The entire batch was rolled back.',409); return Number(result.lastInsertRowid) }

// The adapter consumes an explicit shop-owned export; it never logs in to or mutates GHL.
// All imports are silent: no contact-created hooks, workflows, messages or payments.
export function previewCrmImport(bundle) {
  if(!bundle || bundle.version!==1 || bundle.provider!=='ghl') fail('Choose a version 1 GHL migration bundle.')
  const source='ghl:'+external(bundle.locationId,'Location ID')
  const contacts=arr(bundle.contacts,'Contacts'), opportunities=arr(bundle.opportunities,'Opportunities'), tasks=arr(bundle.tasks,'Tasks')
  if(contacts.length+opportunities.length+tasks.length>250) fail('Import at most 250 records per bundle. Split larger exports into numbered batches.')
  if(!contacts.length && !opportunities.length && !tasks.length) fail('The bundle is empty.')
  for(const r of [...contacts,...opportunities,...tasks]) if(!r || typeof r!=='object' || Array.isArray(r))fail('Each imported record must be an object.')
  for(const r of [...contacts,...opportunities,...tasks]) if(r.locationId && r.locationId!==bundle.locationId)fail('A record belongs to a different GHL location. Split exports by shop.')
  const rows=[], seen=new Set(), emails=new Map(), contactIds=new Set(contacts.map(c=>external(c.id,'Contact ID')))
  const contactRef=id => {
    id=external(id,'Linked contact ID')
    if(!contactIds.has(id)) {
      const ref=get('SELECT * FROM crm_import_refs WHERE source=? AND kind=? AND external_id=?',source,'contact',id)
      if(!ref || !get('SELECT id FROM contacts WHERE id=?',ref.local_id))fail(`Contact ${id} must be imported before its related records.`)
    }
    return id
  }
  const add=(kind,id,data,link=null)=>{
    id=external(id,`${kind} ID`)
    const key=kind+':'+id
    if(seen.has(key))fail(`Duplicate ${kind} ID ${id} in this bundle.`)
    seen.add(key)
    const hash=digest(data), ref=get('SELECT * FROM crm_import_refs WHERE source=? AND kind=? AND external_id=?',source,kind,id)
    if(ref && (ref.content_hash!==hash || !get(`SELECT id FROM ${table[kind]} WHERE id=?`,ref.local_id)))fail(`${kind} ${id} changed or its imported record was removed. Reconcile it manually; existing work will not be overwritten.`,409)
    rows.push({kind,id,data,hash,action:ref?'skip':link?'link':'create',local_id:ref?.local_id || link,linked_identity:!ref && link ? get('SELECT name,email,phone FROM contacts WHERE id=?',link) : null})
  }
  for(const c of contacts) {
    const id=external(c.id,'Contact ID'), email=field(c.email,'Email',254), phone=field(c.phone,'Phone',32)
    if(email && !oneRecipient(email))fail(`Contact ${id} has an invalid email.`)
    if(phone && !oneDestination(phone))fail(`Contact ${id} has an invalid phone.`)
    const name=field(c.name || [c.firstName,c.lastName].filter(Boolean).join(' '),'Name',240) || email || phone
    if(!name)fail(`Contact ${id} needs a name, email or phone.`)
    const tags=arr(c.tags,'Tags').map(t=>field(t,'Tag',100))
    if(tags.length>50)fail('At most 50 tags per contact.')
    // Holds always start enabled, even if an export omitted opt-out fields. Never infer consent.
    const data={name,email,phone,company:field(c.companyName,'Company',240),notes:field(c.notes,'Notes',10000),tags:tags.join(','),email_dnd:c.dnd===true || c.dndSettings?.Email?.status==='active',sms_dnd:c.dnd===true || c.dndSettings?.SMS?.status==='active'}
    let link=bundle.contactMap?.[id]
    if(link!==undefined && (!Number.isSafeInteger(link) || link<1 || !get('SELECT id FROM contacts WHERE id=?',link)))fail(`Contact mapping for ${id} is invalid.`)
    const ref=get('SELECT * FROM crm_import_refs WHERE source=? AND kind=? AND external_id=?',source,'contact',id)
    if(ref && link!==undefined && link!==ref.local_id)fail(`Contact ${id} already has a different mapping.`,409)
    if(!ref && email) {
      const matches=all('SELECT id FROM contacts WHERE lower(trim(email))=lower(?)',email)
      if(matches.some(m=>m.id!==link))fail(`Contact ${id} matches an existing email. Supply its reviewed contactMap ID; ambiguous matches require manual cleanup.`,409)
      const prior=emails.get(email.toLowerCase())
      if(prior && (!link || prior!==link))fail(`Multiple exported contacts share ${email}. Review their identities before importing.`,409)
      emails.set(email.toLowerCase(),link || id)
    }
    add('contact',id,data,link || null)
  }
  for(const o of opportunities) {
    const id=external(o.id,'Opportunity ID'), status=o.status || 'open'
    if(!['open','won','lost','abandoned'].includes(status))fail(`Opportunity ${id} has an unsupported status.`)
    const stage=status==='won'?'won':['lost','abandoned'].includes(status)?'lost':bundle.stageMap?.[o.pipelineStageId]
    if(!STAGE_KEYS.includes(stage))fail(`Map pipeline stage ${o.pipelineStageId || '(missing)'} to lead, quoted, sent, negotiation, won or lost.`)
    const value=o.monetaryValue==null?0:o.monetaryValue
    if(typeof value!=='number' || !Number.isFinite(value) || value<0 || !Number.isSafeInteger(Math.round(value*100)))fail(`Opportunity ${id} has an invalid value.`)
    add('opportunity',id,{contact:contactRef(o.contactId || o.contact?.id),title:field(o.name,'Opportunity name',240)||'Imported opportunity',stage,value:Math.round(value*100)/100,notes:field(o.notes,'Opportunity notes',10000),pipeline:field(o.pipelineId,'Pipeline ID',160),source_stage:field(o.pipelineStageId,'Stage ID',160),source_status:status})
  }
  for(const t of tasks) {
    const id=external(t.id,'Task ID'), title=field(t.title,'Task title',240), due_date=field(t.dueDate,'Task date',10)
    if(!title || (due_date && !validDay(due_date)))fail(`Task ${id} needs a title and a valid YYYY-MM-DD date (or blank).`)
    if(t.completed!==undefined && typeof t.completed!=='boolean')fail(`Task ${id} completed must be true or false.`)
    add('task',id,{contact:contactRef(t.contactId),title,notes:field(t.body,'Task notes',10000),due_date,status:t.completed?'done':'open'})
  }
  const summary={contacts:0,opportunities:0,tasks:0,linked:0,skipped:0,held_contacts:0}
  for(const r of rows) {
    if(r.action==='skip'){summary.skipped++;continue}
    if(r.action==='link')summary.linked++
    else summary[{contact:'contacts',opportunity:'opportunities',task:'tasks'}[r.kind]]++
    if(r.kind==='contact')summary.held_contacts++
  }
  const plan={source,rows,summary}
  return {...plan,token:digest(plan),warnings:['Imported contacts are held from email and SMS until reviewed. Linking an existing customer also holds that customer.', 'Tasks are unassigned for manager review. Existing logins, invoices, payments, job state, files and automations are not imported or changed.', 'Messages, notes not supplied in this bundle, custom fields, phone service, workflows, appointments and subscriptions require separate migration.']}
}
export function commitCrmImport(bundle,token,actor) {
  return tx(()=>{
    // Retry receipts bind the exact submitted bytes semantically, not a stale mutable preview.
    const requestDigest=digest({bundle,token})
    const prior=get('SELECT summary FROM crm_import_receipts WHERE digest=?',requestDigest)
    if(prior)return {...JSON.parse(prior.summary),replayed:true}
    const p=previewCrmImport(bundle)
    if(p.token!==token)fail('The import preview changed. Preview again before importing.',409)
    const contactId=id=>get('SELECT local_id FROM crm_import_refs WHERE source=? AND kind=? AND external_id=?',p.source,'contact',id)?.local_id
    for(const r of p.rows) {
      if(r.action==='skip')continue
      const d=r.data, stamp=now(); let id=r.local_id
      if(r.kind==='contact') {
        if(!id) id=insertedId(run('INSERT INTO contacts(name,email,phone,company,notes,tags,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',d.name,d.email,d.phone,d.company,d.notes,d.tags,stamp,stamp))
        for(const channel of ['email','sms']) {
          const existing=communicationHold(id,channel)
          const reason=d[channel+'_dnd'] ? 'GHL do-not-contact preference. Review customer permission before releasing.' : 'Imported contact: communication permission and existing follow-ups need review.'
          setHold(id,channel,existing ? (d[channel+'_dnd'] && !existing.reason.includes('do-not-contact') ? reason+' Existing hold: '+existing.reason : existing.reason) : reason,actor)
        }
      } else if(r.kind==='opportunity') {
        id=insertedId(run('INSERT INTO opportunities(contact_id,title,stage,value,source,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',contactId(d.contact),d.title,d.stage,d.value,p.source,d.notes,stamp,stamp))
      } else {
        id=insertedId(run('INSERT INTO crm_tasks(contact_id,title,notes,due_date,status,created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?)',contactId(d.contact),d.title,d.notes,d.due_date,d.status,stamp,stamp,null))
      }
      run('INSERT INTO crm_import_refs(source,kind,external_id,local_id,content_hash,created_at) VALUES(?,?,?,?,?,?)',p.source,r.kind,r.id,id,r.hash,stamp)
      history(r.kind,id,actor,`Imported ${p.source} ${r.id}; ${r.action}`)
    }
    run('INSERT INTO crm_import_receipts(digest,summary,created_at) VALUES(?,?,?)',requestDigest,JSON.stringify(p.summary),now())
    return {...p.summary,replayed:false}
  })
}
