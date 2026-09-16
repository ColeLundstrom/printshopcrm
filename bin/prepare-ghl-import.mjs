#!/usr/bin/env node
// Offline conversion only: no credentials, database handles, API calls or customer messages.
import {readFileSync,mkdirSync,writeFileSync,statSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
export function prepareBundles(input,{timezone}={}) {
  if(!input || typeof input.locationId!=='string' || !input.locationId.trim())throw Error('Supply locationId in the export.')
  const pick=(record,keys)=>Object.fromEntries(keys.filter(k=>record[k]!==undefined).map(k=>[k,record[k]]))
  const records=(key)=>{const rows=input[key] ?? [];if(!Array.isArray(rows) || rows.some(r=>!r || typeof r!=='object' || Array.isArray(r)))throw Error(key+' must be an array of records.');return rows}
  const contacts=records('contacts').map(c=>pick(c,['id','locationId','name','firstName','lastName','email','phone','companyName','notes','tags','dnd','dndSettings']))
  const opportunities=records('opportunities').map(o=>({...pick(o,['id','locationId','contactId','name','monetaryValue','status','pipelineId','pipelineStageId','notes']),contactId:o.contactId || o.contact?.id}))
  const tasks=records('tasks').map(t=>{
    let dueDate=t.dueDate || ''
    if(dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      if(!timezone || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(dueDate) || !Number.isFinite(Date.parse(dueDate)))throw Error('Timestamp task dates need an explicit timezone argument and an ISO timestamp with timezone offset.')
      const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(dueDate)).map(p=>[p.type,p.value]))
      dueDate=`${parts.year}-${parts.month}-${parts.day}`
    }
    return {...pick(t,['id','locationId','contactId','title','body','completed']),dueDate}
  })
  const base={version:1,provider:'ghl',locationId:input.locationId.trim(),stageMap:input.stageMap || {},contactMap:input.contactMap || {}}
  const bundles=[];let current={...base,contacts:[],opportunities:[],tasks:[]},count=0
  const flush=()=>{if(count)bundles.push(current);current={...base,contacts:[],opportunities:[],tasks:[]};count=0}
  // Contacts must be imported first. Source IDs resolve related records in later batches.
  for(const [key,rows] of Object.entries({contacts,opportunities,tasks}))for(const row of rows){
    const bytes=()=>Buffer.byteLength(JSON.stringify(current))
    current[key].push(row)
    if(count>=250 || bytes()>700000){current[key].pop();flush();current[key].push(row)}
    if(bytes()>700000)throw Error('One record or mapping is too large. Review the source export before importing.')
    count++
  }
  flush()
  if(!bundles.length)throw Error('The export has no records.')
  return bundles
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try {
    const [source,directory,timezone]=process.argv.slice(2)
    if(!source || !directory)throw Error('Usage: node bin/prepare-ghl-import.mjs export.json NEW_OUTPUT_DIRECTORY [IANA_TIMEZONE]')
    if(statSync(source).size>100*1024*1024)throw Error('Split exports larger than 100 MB before preparation.')
    const bundles=prepareBundles(JSON.parse(readFileSync(source,'utf8')),{timezone})
    mkdirSync(directory,{mode:0o700}) // Refuse an existing directory rather than replace prior evidence.
    bundles.forEach((b,i)=>writeFileSync(join(directory,`ghl-${String(i+1).padStart(4,'0')}.json`),JSON.stringify(b)+'\n',{flag:'wx',mode:0o600}))
    console.log(`Prepared ${bundles.length} private bundles. Import in filename order using Setup → Move your CRM. The original export is unchanged. No network calls made.`)
  }catch(e){console.error(e.message);process.exitCode=1}
}
