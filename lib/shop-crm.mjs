import { all, get, run, tx, now, inTransaction } from './db.mjs'
export const fail = (message, status=400) => { throw Object.assign(new Error(message), {status, expose:true}) }
export const text = (v, max=500) => typeof v === 'string' ? v.trim().slice(0,max) : ''
export const validDay = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v+'T12:00:00Z')) && new Date(v+'T12:00:00Z').toISOString().slice(0,10) === v
export function history(kind, id, actor, detail) { run('INSERT INTO crm_history(kind,record_id,actor,detail,created_at) VALUES(?,?,?,?,?)',kind,id,text(actor,200)||'Shop operator',detail,now()) }
export function saveTask(id, body, actor, members) {
  if(id!==null && (!Number.isSafeInteger(id) || id<1)) fail('Invalid task ID.')
  return tx(() => {
    const old = id ? get('SELECT * FROM crm_tasks WHERE id=?',id) : null
    if(id && !old) fail('Task not found',404)
    if(old && body.revision !== old.revision) fail('This task changed. Reload before saving.',409)
    if(old && !actor.manager && old.assigned_id !== actor.id) fail('Only the assigned employee or a manager can change this task.',403)
    const b={...old,...body}, title=text(b.title,240), notes=text(b.notes,10000), due_date=text(b.due_date,10)
    if(!title) fail('A task needs a title.')
    if(due_date && !validDay(b.due_date)) fail('Choose a valid due date.')
    const status=b.status || 'open'
    if(!['open','done','cancelled'].includes(status)) fail('Choose open, done or cancelled.')
    const assigned_id=b.assigned_id==null || b.assigned_id==='' ? null : Number(b.assigned_id)
    if(assigned_id!==null && (!Number.isSafeInteger(assigned_id) || !members.some(m=>m.id===assigned_id && m.status==='active'))) fail('Choose an active team member.')
    if(!actor.manager && assigned_id!==actor.id) fail('Only a manager can assign work to another employee.',403)
    const contact_id=b.contact_id==null || b.contact_id==='' ? null : Number(b.contact_id)
    if(contact_id!==null && (!Number.isSafeInteger(contact_id) || !get('SELECT id FROM contacts WHERE id=?',contact_id))) fail('Customer not found in this shop.',404)
    const stamp=now(), completed=status==='done'?(old?.completed_at||stamp):null
    if(old) run('UPDATE crm_tasks SET title=?,notes=?,due_date=?,assigned_id=?,contact_id=?,status=?,completed_at=?,revision=revision+1,updated_at=? WHERE id=?',title,notes,due_date,assigned_id,contact_id,status,completed,stamp,id)
    else id=Number(run('INSERT INTO crm_tasks(title,notes,due_date,assigned_id,contact_id,status,completed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',title,notes,due_date,assigned_id,contact_id,status,completed,stamp,stamp).lastInsertRowid)
    history('task',id,actor.name,old ? `Updated task (${status})` : `Created task (${status})`)
    return get('SELECT * FROM crm_tasks WHERE id=?',id)
  })
}
export function taskList({status='open',mine=false,actor,offset=0}={}) {
  if(!['open','done','cancelled','all'].includes(status)) fail('Unknown task filter.')
  if(!Number.isSafeInteger(offset) || offset<0) fail('Invalid offset.')
  const where=[], args=[]
  if(status!=='all'){where.push('t.status=?');args.push(status)}
  // Staff see their own tasks; managers may choose the shop-wide queue.
  if(mine || !actor.manager){where.push('t.assigned_id=?');args.push(actor.id)}
  const clause=where.length?'WHERE '+where.join(' AND '):''
  const total=get(`SELECT count(*) n FROM crm_tasks t ${clause}`,...args).n
  const tasks=all(`SELECT t.*,c.name customer_name FROM crm_tasks t LEFT JOIN contacts c ON c.id=t.contact_id ${clause} ORDER BY CASE WHEN due_date='' THEN 1 ELSE 0 END,due_date,t.id LIMIT 100 OFFSET ?`,...args,offset)
  return {tasks,total,has_more:offset+tasks.length<total,offset}
}
export function communicationHold(contactId,channel) {
  return contactId ? get('SELECT * FROM crm_contact_holds WHERE contact_id=? AND channel=? AND active=1',contactId,channel) : null
}
export function setHold(contactId,channel,reason,actor) {
  if(!inTransaction())return tx(()=>setHold(contactId,channel,reason,actor))
  if(!['email','sms'].includes(channel)) fail('Unknown channel.')
  if(!get('SELECT id FROM contacts WHERE id=?',contactId)) fail('Customer not found.',404)
  reason=text(reason,1000)
  if(!reason) fail('Record a reason for the hold.')
  run('INSERT INTO crm_contact_holds(contact_id,channel,reason,updated_at) VALUES(?,?,?,?) ON CONFLICT(contact_id,channel) DO UPDATE SET reason=excluded.reason,active=1,revision=crm_contact_holds.revision+1,updated_at=excluded.updated_at',contactId,channel,reason,now())
  history('contact',contactId,actor,`${channel} held: ${reason}`)
}
export function releaseHold(contactId,channel,body,actor) {
  return tx(()=>{
    const h=communicationHold(contactId,channel)
    if(!h) fail('Hold not found.',404)
    if(body.revision!==h.revision) fail('Communication hold changed. Reload first.',409)
    const reason=text(body.reason,1000)
    if(!reason) fail('Record the permission or correction supporting this release.')
    run('UPDATE crm_contact_holds SET active=0,revision=revision+1,updated_at=? WHERE contact_id=? AND channel=?',now(),contactId,channel)
    history('contact',contactId,actor,`${channel} hold released: ${reason}`)
    return {ok:true}
  })
}
