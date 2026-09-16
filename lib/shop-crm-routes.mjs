import { all, get } from './db.mjs'
import { saveTask, taskList, setHold, releaseHold, fail } from './shop-crm.mjs'
import { previewCrmImport, commitCrmImport } from './crm-import.mjs'
export function registerShopCrmRoutes(app,{requireRole,hasRole,listMembers}) {
  const safe=fn=>(req,res,next)=>{try{fn(req,res)}catch(e){if(e.status)res.status(e.status).json({error:e.message});else next(e)}}
  const actor=req=>({id:req.member?.id ?? 0,name:req.member?.name || 'Shop operator',manager:hasRole(req,'manager')})
  const team=req=>req.tenant?listMembers(req.tenant.id).map(({id,name,status})=>({id,name,status})):[{id:0,name:'Shop operator',status:'active'}]
  app.get('/api/crm/customers',safe((req,res)=>res.json({contacts:all('SELECT id,name,email FROM contacts WHERE name LIKE ? OR email LIKE ? ORDER BY name LIMIT 25','%'+String(req.query.q || '').slice(0,100)+'%','%'+String(req.query.q || '').slice(0,100)+'%')})))
  app.get('/api/crm/tasks',safe((req,res)=>res.json({...taskList({status:req.query.status || 'open',mine:req.query.mine==='1',offset:Number(req.query.offset || 0),actor:actor(req)}),team:team(req),can_manage:actor(req).manager,member_id:actor(req).id})))
  app.post('/api/crm/tasks',safe((req,res)=>res.status(201).json(saveTask(null,req.body || {},actor(req),team(req)))))
  app.put('/api/crm/tasks/:id',safe((req,res)=>res.json(saveTask(Number(req.params.id),req.body || {},actor(req),team(req)))))
  app.post('/api/crm/import/preview',requireRole('manager'),safe((req,res)=>res.json(previewCrmImport(req.body?.bundle))))
  app.post('/api/crm/import/commit',requireRole('manager'),safe((req,res)=>res.json(commitCrmImport(req.body?.bundle,req.body?.token,actor(req).name))))
  app.get('/api/crm/holds',requireRole('manager'),safe((req,res)=>{
    const offset=Number(req.query.offset || 0)
    if(!Number.isSafeInteger(offset)||offset<0)fail('Invalid offset.')
    const total=get('SELECT count(*) n FROM crm_contact_holds WHERE active=1').n
    const holds=all('SELECT h.*,c.name,c.email,c.phone FROM crm_contact_holds h JOIN contacts c ON c.id=h.contact_id WHERE h.active=1 ORDER BY h.contact_id,h.channel LIMIT 100 OFFSET ?',offset)
    res.json({holds,total,offset,has_more:offset+holds.length<total})
  }))
  app.post('/api/crm/holds/:id/:channel',requireRole('manager'),safe((req,res)=>{setHold(Number(req.params.id),req.params.channel,req.body?.reason,actor(req).name);res.json({ok:true})}))
  app.post('/api/crm/holds/:id/:channel/release',requireRole('manager'),safe((req,res)=>res.json(releaseHold(Number(req.params.id),req.params.channel,req.body || {},actor(req).name))))
}
